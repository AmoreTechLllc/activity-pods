'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { performance } = require('perf_hooks');

const DEFAULT_ROOT_ACTION = 'activitypub.outbox.post';
const DEFAULT_QUERY_ACTION = 'triplestore.query';
const DEFAULT_OUTPUT = path.resolve(process.cwd(), 'apdm-phase11-query-attribution.jsonl');
const DEFAULT_MAX_KEYS = 4096;
const DEFAULT_MAX_CONTEXTS = 65536;
const LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY = 'semapps-atproto.apdm-p8.local-delivery-observer';
const SAFE_QUERY_OPERATIONS = new Set([
  'select', 'ask', 'construct', 'describe', 'insert', 'delete',
  'load', 'clear', 'create', 'drop', 'copy', 'move', 'add', 'with'
]);
const SAFE_AST_TYPE_VALUES = new Set([
  'query', 'update', 'bgp', 'graph', 'group', 'filter', 'bind', 'service',
  'optional', 'union', 'minus', 'values', 'path', 'operation', 'expression'
]);
const SAFE_TERM_TYPES = new Set([
  'NamedNode', 'BlankNode', 'Literal', 'Variable', 'DefaultGraph', 'Quad'
]);
const SAFE_AST_OPERATORS = new Set([
  '=', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '&&', '||', '!',
  'in', 'notin', 'exists', 'notexists', 'bound', 'regex', 'sameTerm', 'isIRI',
  'isURI', 'isBlank', 'isLiteral', 'isNumeric', 'lang', 'datatype', 'str'
]);
const SAFE_AST_KEYS = new Set([
  'type', 'queryType', 'where', 'patterns', 'triples', 'subject', 'predicate', 'object',
  'name', 'termType', 'value', 'datatype', 'language', 'variables', 'template',
  'expression', 'operator', 'args', 'values', 'group', 'having', 'order', 'limit',
  'offset', 'distinct', 'reduced', 'silent', 'from', 'prefixes', 'updates',
  'insert', 'delete', 'using', 'graph', 'source', 'destination'
]);
const TERM_SLOT_PREFIX = Object.freeze({
  NamedNode: 'IRI',
  BlankNode: 'BNODE',
  Literal: 'LITERAL',
  Variable: 'VAR',
  DefaultGraph: 'DEFAULT_GRAPH',
  Quad: 'QUAD'
});

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function iriRefEnd(query, startIndex) {
  for (let index = startIndex + 1; index < query.length; index += 1) {
    const char = query[index];
    if (char === '>') return index + 1;
    if (/\s/u.test(char) || char === '<' || char === '"' || char === '{' || char === '}' || char === '|' || char === '^' || char === '`') {
      return undefined;
    }
    if (char === '\\') {
      const marker = query[index + 1];
      const digits = marker === 'u' ? 4 : marker === 'U' ? 8 : 0;
      if (!digits) return undefined;
      const escaped = query.slice(index + 2, index + 2 + digits);
      if (escaped.length !== digits || !/^[0-9A-Fa-f]+$/u.test(escaped)) return undefined;
      index += digits + 1;
    }
  }
  return undefined;
}

function normalizeStringQueryShape(query) {
  let output = '';
  let index = 0;

  while (index < query.length) {
    const char = query[index];

    if (char === '#') {
      while (index < query.length && query[index] !== '\n' && query[index] !== '\r') index += 1;
      output += ' ';
      continue;
    }

    if (char === '<') {
      const end = iriRefEnd(query, index);
      if (end !== undefined) {
        index = end;
        output += '<IRI>';
        continue;
      }
    }

    if (char === '"' || char === "'") {
      const quote = char;
      const triple = query.slice(index, index + 3) === quote.repeat(3);
      const delimiterLength = triple ? 3 : 1;
      index += delimiterLength;
      while (index < query.length) {
        if (query[index] === '\\') {
          index += 2;
          continue;
        }
        if (triple) {
          if (query.slice(index, index + 3) === quote.repeat(3)) {
            index += 3;
            break;
          }
        } else if (query[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      output += 'LITERAL';
      continue;
    }

    output += char;
    index += 1;
  }

  return normalizeWhitespace(output)
    .replace(/_:[A-Za-z][A-Za-z0-9._-]*/gu, '_:BNODE')
    .replace(/(^|[^?\w.-])[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?(?=$|[^\w.-])/gu, '$1NUMBER')
    .replace(/\b(?:true|false)\b/giu, 'BOOLEAN');
}

function createObjectShapeState() {
  return { termSlots: new Map(), nextByPrefix: new Map() };
}

function opaqueTermSlot(termType, rawValue, state) {
  const prefix = TERM_SLOT_PREFIX[termType] || 'TERM';
  const key = `${termType}\u0000${typeof rawValue}\u0000${String(rawValue)}`;
  const existing = state.termSlots.get(key);
  if (existing) return existing;
  const next = (state.nextByPrefix.get(prefix) || 0) + 1;
  state.nextByPrefix.set(prefix, next);
  const token = `${prefix}${next}`;
  state.termSlots.set(key, token);
  return token;
}

function normalizeQueryObjectShape(value, key = undefined, depth = 0, state = undefined) {
  const currentState = state || createObjectShapeState();
  if (depth > 32) return 'DEPTH_LIMIT';
  if (value === null) return 'NULL';
  if (Array.isArray(value)) {
    return `[${value.map(item => normalizeQueryObjectShape(item, undefined, depth + 1, currentState)).join(',')}]`;
  }

  const valueType = typeof value;
  if (valueType === 'string') {
    if (key === 'queryType') {
      const operation = value.toLowerCase();
      return SAFE_QUERY_OPERATIONS.has(operation) ? operation.toUpperCase() : 'OPERATION';
    }
    if (key === 'type') {
      const type = value.toLowerCase();
      return SAFE_AST_TYPE_VALUES.has(type) ? type : 'TYPE';
    }
    if (key === 'termType') return SAFE_TERM_TYPES.has(value) ? value : 'TERM';
    if (key === 'operator') return SAFE_AST_OPERATORS.has(value) ? value : 'OPERATOR';
    return 'STRING';
  }
  if (valueType === 'number' || valueType === 'bigint') return 'NUMBER';
  if (valueType === 'boolean') return 'BOOLEAN';
  if (valueType === 'undefined') return 'UNDEFINED';
  if (valueType !== 'object') return 'SCALAR';

  const termType = typeof value.termType === 'string' && SAFE_TERM_TYPES.has(value.termType)
    ? value.termType
    : undefined;
  const entries = Object.entries(value)
    .map(([rawKey, child]) => {
      const safeKey = SAFE_AST_KEYS.has(rawKey) ? rawKey : 'FIELD';
      if (safeKey === 'value' && termType && (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean')) {
        return [safeKey, opaqueTermSlot(termType, child, currentState)];
      }
      return [
        safeKey,
        normalizeQueryObjectShape(child, safeKey === 'FIELD' ? undefined : rawKey, depth + 1, currentState)
      ];
    })
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    );
  return `{${entries.map(([entryKey, entryValue]) => `${entryKey}:${entryValue}`).join(',')}}`;
}

function normalizeQueryShape(query) {
  if (typeof query === 'string') return normalizeStringQueryShape(query);
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    return `OBJECT:${normalizeQueryObjectShape(query)}`;
  }
  return `UNSUPPORTED:${query === null ? 'null' : typeof query}`;
}

function fingerprintQueryShape(query) {
  return crypto.createHash('sha256').update(normalizeQueryShape(query), 'utf8').digest('hex');
}

function classifyQueryOperation(query) {
  if (query && typeof query === 'object' && !Array.isArray(query)) {
    const queryType = typeof query.queryType === 'string' ? query.queryType.toLowerCase() : undefined;
    return queryType && SAFE_QUERY_OPERATIONS.has(queryType) ? queryType : 'unknown';
  }
  if (typeof query !== 'string') return 'unknown';
  const sanitized = normalizeStringQueryShape(query);
  const match = sanitized.match(
    /\b(SELECT|ASK|CONSTRUCT|DESCRIBE|INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b/iu
  );
  return match ? match[1].toLowerCase() : 'unknown';
}

function queryFromContext(ctx) {
  if (!ctx || !ctx.params || typeof ctx.params !== 'object') return undefined;
  if (typeof ctx.params.query === 'string') return ctx.params.query;
  if (ctx.params.query && typeof ctx.params.query === 'object' && !Array.isArray(ctx.params.query)) return ctx.params.query;
  if (typeof ctx.params.sparql === 'string') return ctx.params.sparql;
  return undefined;
}

function safeCallerName(ctx, contextActions) {
  if (ctx && ctx.parentID != null) {
    const parent = contextActions.get(String(ctx.parentID));
    if (parent) return parent;
  }
  if (ctx && typeof ctx.caller === 'string' && /^[A-Za-z0-9_.-]+$/u.test(ctx.caller)) return ctx.caller;
  return 'unknown';
}

function writeJsonLine(outputPath, record) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.appendFileSync(outputPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function createPhase11QueryAttribution(options = {}) {
  if (options.enabled !== true) {
    return { middleware: null, dispose() {} };
  }

  const storage = new AsyncLocalStorage();
  const rootAction = options.rootAction || DEFAULT_ROOT_ACTION;
  const queryAction = options.queryAction || DEFAULT_QUERY_ACTION;
  const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT);
  const maxKeys = Number.isInteger(options.maxKeys) && options.maxKeys > 0 ? options.maxKeys : DEFAULT_MAX_KEYS;
  const maxContexts = Number.isInteger(options.maxContexts) && options.maxContexts > 0 ? options.maxContexts : DEFAULT_MAX_CONTEXTS;
  const defaultRecipientCount = Number(options.recipientCount);
  const caseLabel = options.caseLabel || undefined;
  const onInstrumentationError = typeof options.onInstrumentationError === 'function' ? options.onInstrumentationError : () => {};

  function reportInstrumentationError(error) {
    try { onInstrumentationError(error); } catch (_ignored) {}
  }

  function newTrace(ctx) {
    return {
      version: 1,
      phase: 'APDM-P11-A',
      requestId: (ctx && (ctx.requestID || ctx.id)) || `apdm-p11-${Date.now()}`,
      caseLabel,
      recipientCount: Number.isFinite(defaultRecipientCount) ? defaultRecipientCount : undefined,
      startedAt: new Date().toISOString(),
      contextActions: new Map(),
      lineageOverflowed: false,
      droppedLineageContexts: 0,
      aggregates: new Map(),
      totalQueryCalls: 0,
      attributedQueryCalls: 0,
      unattributedQueryCalls: 0,
      overflowed: false,
      droppedCalls: 0,
      pendingDetachedLocalDeliveries: 0,
      rootSettled: false,
      finalized: false
    };
  }

  function rememberContext(trace, contextId, actionName) {
    if (!contextId || trace.contextActions.has(contextId)) return;
    if (trace.contextActions.size >= maxContexts) {
      trace.lineageOverflowed = true;
      trace.droppedLineageContexts += 1;
      return;
    }
    trace.contextActions.set(contextId, actionName || 'unknown');
  }

  function recordQuery(trace, ctx, query, durationMs, failed) {
    trace.totalQueryCalls += 1;
    const caller = safeCallerName(ctx, trace.contextActions);
    if (caller === 'unknown') trace.unattributedQueryCalls += 1;
    else trace.attributedQueryCalls += 1;

    const shapeHash = fingerprintQueryShape(query);
    const operation = classifyQueryOperation(query);
    const key = `${caller}\u0000${operation}\u0000${shapeHash}`;
    let aggregate = trace.aggregates.get(key);
    if (!aggregate) {
      if (trace.aggregates.size >= maxKeys) {
        trace.overflowed = true;
        trace.droppedCalls += 1;
        return;
      }
      aggregate = { caller, operation, shapeHash, count: 0, errorCount: 0, totalDurationMs: 0, maxDurationMs: 0 };
      trace.aggregates.set(key, aggregate);
    }
    aggregate.count += 1;
    if (failed) aggregate.errorCount += 1;
    aggregate.totalDurationMs += durationMs;
    aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, durationMs);
  }

  function finalize(trace) {
    if (!trace || trace.finalized || !trace.rootSettled || trace.pendingDetachedLocalDeliveries > 0) return false;
    trace.finalized = true;
    const queries = [...trace.aggregates.values()].sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      if (b.totalDurationMs !== a.totalDurationMs) return b.totalDurationMs - a.totalDurationMs;
      return `${a.caller}:${a.shapeHash}`.localeCompare(`${b.caller}:${b.shapeHash}`);
    });
    const record = {
      version: trace.version,
      phase: trace.phase,
      requestId: trace.requestId,
      caseLabel: trace.caseLabel,
      recipientCount: trace.recipientCount,
      startedAt: trace.startedAt,
      finishedAt: new Date().toISOString(),
      totalQueryCalls: trace.totalQueryCalls,
      attributedQueryCalls: trace.attributedQueryCalls,
      unattributedQueryCalls: trace.unattributedQueryCalls,
      distinctAttributionKeys: queries.length,
      overflowed: trace.overflowed,
      droppedCalls: trace.droppedCalls,
      lineageContextCount: trace.contextActions.size,
      lineageOverflowed: trace.lineageOverflowed,
      droppedLineageContexts: trace.droppedLineageContexts,
      queries
    };
    try { writeJsonLine(outputPath, record); } catch (error) { reportInstrumentationError(error); }
    return true;
  }

  const observerKey = Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY);
  const previousLocalDeliveryObserver = globalThis[observerKey];
  const localDeliveryObserver = (phase, activity, error) => {
    if (typeof previousLocalDeliveryObserver === 'function') {
      try { previousLocalDeliveryObserver(phase, activity, error); } catch (observerError) { reportInstrumentationError(observerError); }
    }
    const trace = storage.getStore();
    if (!trace) return;
    if (phase === 'start') {
      trace.pendingDetachedLocalDeliveries += 1;
      return;
    }
    if (phase === 'finish') {
      trace.pendingDetachedLocalDeliveries = Math.max(0, trace.pendingDetachedLocalDeliveries - 1);
      finalize(trace);
    }
  };
  globalThis[observerKey] = localDeliveryObserver;

  const middleware = {
    name: 'APDMPhase11QueryAttribution',
    localAction(next, action) {
      const actionName = action && action.name;
      return async function apdmPhase11AttributedAction(ctx) {
        const currentTrace = storage.getStore();
        const isRoot = actionName === rootAction && !currentTrace;
        const trace = currentTrace || (isRoot ? newTrace(ctx) : undefined);
        if (!trace) return next(ctx);
        const contextId = ctx && ctx.id != null ? String(ctx.id) : undefined;
        rememberContext(trace, contextId, actionName);
        const invoke = async () => {
          if (actionName !== queryAction) return next(ctx);
          const query = queryFromContext(ctx);
          const started = performance.now();
          let failed = false;
          try { return await next(ctx); }
          catch (error) { failed = true; throw error; }
          finally {
            try { recordQuery(trace, ctx, query, performance.now() - started, failed); }
            catch (error) { reportInstrumentationError(error); }
          }
        };
        try {
          if (isRoot) return await storage.run(trace, invoke);
          return await invoke();
        } finally {
          if (isRoot) {
            trace.rootSettled = true;
            finalize(trace);
          }
        }
      };
    }
  };

  return {
    middleware,
    outputPath,
    dispose() {
      if (globalThis[observerKey] === localDeliveryObserver) {
        if (previousLocalDeliveryObserver === undefined) delete globalThis[observerKey];
        else globalThis[observerKey] = previousLocalDeliveryObserver;
      }
      storage.disable();
    }
  };
}

module.exports = {
  DEFAULT_MAX_CONTEXTS,
  DEFAULT_MAX_KEYS,
  DEFAULT_OUTPUT,
  DEFAULT_QUERY_ACTION,
  DEFAULT_ROOT_ACTION,
  classifyQueryOperation,
  createObjectShapeState,
  createPhase11QueryAttribution,
  fingerprintQueryShape,
  iriRefEnd,
  normalizeQueryObjectShape,
  normalizeQueryShape,
  opaqueTermSlot,
  queryFromContext,
  safeCallerName
};
