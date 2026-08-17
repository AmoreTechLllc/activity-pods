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
const LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY = 'semapps-atproto.apdm-p8.local-delivery-observer';

function normalizeWhitespace(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

/**
 * Produces a structural representation used only as SHA-256 input.
 * The returned value must never be written to benchmark artifacts or logs.
 * IRIs, quoted literals, blank-node labels and scalar constants are removed so
 * the fingerprint groups equivalent query shapes without retaining Pod/user data.
 */
function normalizeQueryShape(query) {
  if (typeof query !== 'string') return `NON_STRING:${query === null ? 'null' : typeof query}`;

  let output = '';
  let index = 0;

  while (index < query.length) {
    const char = query[index];

    // SPARQL comments run to the end of the line. This branch is reached only
    // outside strings/IRIs because those constructs are consumed atomically.
    if (char === '#') {
      while (index < query.length && query[index] !== '\n' && query[index] !== '\r') index += 1;
      output += ' ';
      continue;
    }

    // IRI reference. Preserve only the fact that an IRI occupies this position.
    if (char === '<') {
      index += 1;
      while (index < query.length) {
        if (query[index] === '\\') {
          index += 2;
          continue;
        }
        if (query[index] === '>') {
          index += 1;
          break;
        }
        index += 1;
      }
      output += '<IRI>';
      continue;
    }

    // Single-, double-, or triple-quoted SPARQL string literal. Literal content
    // is never retained. Language/datatype suffixes are processed normally so
    // query structure remains distinguishable without revealing the value.
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

function fingerprintQueryShape(query) {
  return crypto.createHash('sha256').update(normalizeQueryShape(query), 'utf8').digest('hex');
}

function classifyQueryOperation(query) {
  if (typeof query !== 'string') return 'unknown';
  const match = query.match(
    /\b(SELECT|ASK|CONSTRUCT|DESCRIBE|INSERT|DELETE|LOAD|CLEAR|CREATE|DROP|COPY|MOVE|ADD|WITH)\b/iu
  );
  return match ? match[1].toLowerCase() : 'unknown';
}

function queryFromContext(ctx) {
  if (!ctx || !ctx.params || typeof ctx.params !== 'object') return undefined;
  if (typeof ctx.params.query === 'string') return ctx.params.query;
  if (typeof ctx.params.sparql === 'string') return ctx.params.sparql;
  return undefined;
}

function safeCallerName(ctx, activeActions) {
  if (ctx && ctx.parentID != null) {
    const parent = activeActions.get(String(ctx.parentID));
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
    return {
      middleware: null,
      dispose() {}
    };
  }

  const storage = new AsyncLocalStorage();
  const rootAction = options.rootAction || DEFAULT_ROOT_ACTION;
  const queryAction = options.queryAction || DEFAULT_QUERY_ACTION;
  const outputPath = path.resolve(options.outputPath || DEFAULT_OUTPUT);
  const maxKeys = Number.isInteger(options.maxKeys) && options.maxKeys > 0 ? options.maxKeys : DEFAULT_MAX_KEYS;
  const defaultRecipientCount = Number(options.recipientCount);
  const caseLabel = options.caseLabel || undefined;
  const onInstrumentationError =
    typeof options.onInstrumentationError === 'function' ? options.onInstrumentationError : () => {};

  function reportInstrumentationError(error) {
    try {
      onInstrumentationError(error);
    } catch (_ignored) {
      // Attribution must never affect delivery semantics.
    }
  }

  function newTrace(ctx) {
    return {
      version: 1,
      phase: 'APDM-P11-A',
      requestId: (ctx && (ctx.requestID || ctx.id)) || `apdm-p11-${Date.now()}`,
      caseLabel,
      recipientCount: Number.isFinite(defaultRecipientCount) ? defaultRecipientCount : undefined,
      startedAt: new Date().toISOString(),
      activeActions: new Map(),
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

  function recordQuery(trace, ctx, query, durationMs, failed) {
    trace.totalQueryCalls += 1;
    const caller = safeCallerName(ctx, trace.activeActions);
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
      aggregate = {
        caller,
        operation,
        shapeHash,
        count: 0,
        errorCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0
      };
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
      queries
    };

    try {
      writeJsonLine(outputPath, record);
    } catch (error) {
      reportInstrumentationError(error);
    }
    return true;
  }

  const observerKey = Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY);
  const previousLocalDeliveryObserver = globalThis[observerKey];

  const localDeliveryObserver = (phase, activity, error) => {
    // Preserve the previously installed Phase 8 observer. Its exceptions are
    // isolated so an observation failure can never alter real delivery.
    if (typeof previousLocalDeliveryObserver === 'function') {
      try {
        previousLocalDeliveryObserver(phase, activity, error);
      } catch (observerError) {
        reportInstrumentationError(observerError);
      }
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
        if (contextId) trace.activeActions.set(contextId, actionName || 'unknown');

        const invoke = async () => {
          if (actionName !== queryAction) return next(ctx);

          const query = queryFromContext(ctx);
          const started = performance.now();
          let failed = false;
          try {
            return await next(ctx);
          } catch (error) {
            failed = true;
            throw error;
          } finally {
            try {
              recordQuery(trace, ctx, query, performance.now() - started, failed);
            } catch (error) {
              reportInstrumentationError(error);
            }
          }
        };

        try {
          if (isRoot) return await storage.run(trace, invoke);
          return await invoke();
        } finally {
          if (contextId) trace.activeActions.delete(contextId);
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
  DEFAULT_MAX_KEYS,
  DEFAULT_OUTPUT,
  DEFAULT_QUERY_ACTION,
  DEFAULT_ROOT_ACTION,
  classifyQueryOperation,
  createPhase11QueryAttribution,
  fingerprintQueryShape,
  normalizeQueryShape,
  queryFromContext,
  safeCallerName
};
