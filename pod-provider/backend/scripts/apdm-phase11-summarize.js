'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_COUNTS = Object.freeze([1, 10, 100, 200, 1000]);
const MIN_MEASURED_SAMPLES = 3;
const QUERY_ACTION = 'triplestore.query';
const ALLOWED_OPERATIONS = new Set([
  'select', 'ask', 'construct', 'describe', 'insert', 'delete',
  'load', 'clear', 'create', 'drop', 'copy', 'move', 'add', 'with'
]);
const RECORD_KEYS = Object.freeze([
  'version', 'phase', 'requestId', 'caseLabel', 'recipientCount', 'startedAt', 'finishedAt',
  'totalQueryCalls', 'attributedQueryCalls', 'unattributedQueryCalls', 'distinctAttributionKeys',
  'overflowed', 'droppedCalls', 'lineageContextCount', 'lineageOverflowed',
  'droppedLineageContexts', 'queries'
]);
const QUERY_KEYS = Object.freeze([
  'caller', 'operation', 'shapeHash', 'count', 'errorCount', 'totalDurationMs', 'maxDurationMs'
]);

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing input ${filePath}`);
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(JSON.parse);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function assertExactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unexpected key ${key}; refuse artifact schema drift`);
  }
}

function assertPrivacySafeRawArtifact(raw, filePath) {
  if (/https?:\/\//iu.test(raw) || /<[^>]+>/u.test(raw)) {
    throw new Error(`Privacy scan rejected ${filePath}: raw URL/IRI material found`);
  }
}

function validateQueryEntry(query, label) {
  assertExactKeys(query, QUERY_KEYS, label);
  if (!/^[A-Za-z0-9_.-]+$/u.test(query.caller || '')) throw new Error(`${label}.caller is unsafe`);
  if (!ALLOWED_OPERATIONS.has(query.operation)) {
    throw new Error(`${label}.operation is unsupported; opaque query shapes are not valid attribution evidence`);
  }
  if (!/^[a-f0-9]{64}$/u.test(query.shapeHash || '')) throw new Error(`${label}.shapeHash is invalid`);
  if (!Number.isInteger(query.count) || query.count < 1) throw new Error(`${label}.count must be positive`);
  if (!Number.isInteger(query.errorCount) || query.errorCount < 0 || query.errorCount > query.count) {
    throw new Error(`${label}.errorCount is invalid`);
  }
  for (const key of ['totalDurationMs', 'maxDurationMs']) {
    if (!Number.isFinite(query[key]) || query[key] < 0) throw new Error(`${label}.${key} is invalid`);
  }
  if (query.maxDurationMs > query.totalDurationMs + Number.EPSILON) throw new Error(`${label} duration accounting is invalid`);
}

function validateRecord(record, recipientCount, label) {
  assertExactKeys(record, RECORD_KEYS, label);
  if (record.version !== 1 || record.phase !== 'APDM-P11-A') throw new Error(`${label} has unsupported version/phase`);
  if (Number(record.recipientCount) !== recipientCount) throw new Error(`${label} recipient count mismatch`);
  if (record.caseLabel !== `real-local-${recipientCount}`) throw new Error(`${label} caseLabel is invalid`);
  if (typeof record.requestId !== 'string' || !/^apdm-p8-[a-z0-9-]+$/u.test(record.requestId)) {
    throw new Error(`${label} requestId is malformed`);
  }
  for (const key of ['startedAt', 'finishedAt']) {
    if (typeof record[key] !== 'string' || Number.isNaN(Date.parse(record[key]))) throw new Error(`${label}.${key} is invalid`);
  }
  if (record.overflowed !== false || record.droppedCalls !== 0) throw new Error(`${label} attribution overflowed`);
  if (record.lineageOverflowed !== false || record.droppedLineageContexts !== 0) {
    throw new Error(`${label} context-lineage attribution overflowed`);
  }
  if (!Number.isInteger(record.lineageContextCount) || record.lineageContextCount < 1) {
    throw new Error(`${label}.lineageContextCount is invalid`);
  }
  for (const key of ['totalQueryCalls', 'attributedQueryCalls', 'unattributedQueryCalls', 'distinctAttributionKeys']) {
    if (!Number.isInteger(record[key]) || record[key] < 0) throw new Error(`${label}.${key} is invalid`);
  }
  if (record.attributedQueryCalls + record.unattributedQueryCalls !== record.totalQueryCalls) {
    throw new Error(`${label} attribution totals do not reconcile`);
  }
  if (!Array.isArray(record.queries)) throw new Error(`${label}.queries must be an array`);
  record.queries.forEach((query, index) => validateQueryEntry(query, `${label}.queries[${index}]`));
  if (record.queries.length !== record.distinctAttributionKeys) throw new Error(`${label} distinct key count mismatch`);
  if (record.queries.reduce((sum, query) => sum + query.count, 0) !== record.totalQueryCalls) {
    throw new Error(`${label} query aggregate counts do not reconcile`);
  }
}

function expectedPhase8QueryCount(p8, label) {
  const value = p8?.actionCounts?.[QUERY_ACTION];
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} has no valid independent ${QUERY_ACTION} count`);
  return value;
}

function selectMeasuredRecords(p8Records, p11Records, recipientCount) {
  if (p8Records.length < MIN_MEASURED_SAMPLES) {
    throw new Error(`N=${recipientCount} requires at least ${MIN_MEASURED_SAMPLES} measured samples`);
  }
  const byRequest = new Map();
  for (const record of p11Records) {
    if (byRequest.has(record.requestId)) throw new Error(`Duplicate Phase 11 requestId ${record.requestId}`);
    byRequest.set(record.requestId, record);
  }
  return p8Records.map((p8, index) => {
    const label = `N=${recipientCount} measured sample ${index + 1}`;
    if (p8?.phase !== 'APDM-P8-A' || Number(p8.recipientCount) !== recipientCount || typeof p8.requestId !== 'string') {
      throw new Error(`Invalid Phase 8 ${label}`);
    }
    if (Array.isArray(p8.errors) && p8.errors.length > 0) throw new Error(`${label} contains Phase 8 delivery/instrumentation errors`);
    const record = byRequest.get(p8.requestId);
    if (!record) throw new Error(`Missing Phase 11 record for measured requestId=${p8.requestId}`);
    validateRecord(record, recipientCount, `N=${recipientCount} requestId=${p8.requestId}`);

    const independentCount = expectedPhase8QueryCount(p8, label);
    if (record.totalQueryCalls !== independentCount) {
      throw new Error(
        `N=${recipientCount} requestId=${p8.requestId} attribution total ${record.totalQueryCalls} does not match independent Phase 8 ${QUERY_ACTION} count ${independentCount}`
      );
    }
    if (record.unattributedQueryCalls !== 0) {
      throw new Error(`N=${recipientCount} requestId=${p8.requestId} has ${record.unattributedQueryCalls} unattributed ${QUERY_ACTION} calls`);
    }
    return record;
  });
}

function summarizeCount(recipientCount, records) {
  const keys = new Map();
  for (const record of records) {
    for (const query of record.queries) {
      const id = `${query.caller}\u0000${query.operation}\u0000${query.shapeHash}`;
      if (!keys.has(id)) keys.set(id, { caller: query.caller, operation: query.operation, shapeHash: query.shapeHash });
    }
  }
  const queries = [...keys.values()].map(identity => {
    const matches = records.map(record => record.queries.find(query =>
      query.caller === identity.caller && query.operation === identity.operation && query.shapeHash === identity.shapeHash
    ));
    const sampleCounts = matches.map(query => query?.count || 0);
    const sampleDurationsMs = matches.map(query => query?.totalDurationMs || 0);
    return {
      ...identity,
      count: sampleCounts.reduce((sum, value) => sum + value, 0),
      errorCount: matches.reduce((sum, query) => sum + (query?.errorCount || 0), 0),
      totalDurationMs: sampleDurationsMs.reduce((sum, value) => sum + value, 0),
      maxDurationMs: Math.max(0, ...matches.map(query => query?.maxDurationMs || 0)),
      sampleCounts,
      sampleDurationsMs,
      medianCountPerSample: median(sampleCounts),
      medianDurationMsPerSample: median(sampleDurationsMs)
    };
  }).sort((a, b) =>
    b.medianDurationMsPerSample - a.medianDurationMsPerSample ||
    b.medianCountPerSample - a.medianCountPerSample ||
    `${a.caller}:${a.shapeHash}`.localeCompare(`${b.caller}:${b.shapeHash}`)
  );

  return {
    recipientCount,
    samples: records.length,
    totalQueryCallsMedian: median(records.map(record => record.totalQueryCalls)),
    attributedQueryCallsMedian: median(records.map(record => record.attributedQueryCalls)),
    unattributedQueryCallsMedian: median(records.map(record => record.unattributedQueryCalls)),
    distinctAttributionKeysMedian: median(records.map(record => record.distinctAttributionKeys)),
    lineageContextCountMedian: median(records.map(record => record.lineageContextCount)),
    queryErrorCount: queries.reduce((sum, query) => sum + query.errorCount, 0),
    queries
  };
}

function buildSummary(pairs) {
  const counts = pairs.map(({ recipientCount, p8Path, p11Path }) => {
    const raw = fs.readFileSync(p11Path, 'utf8');
    assertPrivacySafeRawArtifact(raw, p11Path);
    const p8 = readJsonLines(p8Path);
    if (!p8.length) throw new Error(`No measured Phase 8 records at N=${recipientCount}`);
    return summarizeCount(recipientCount, selectMeasuredRecords(p8, readJsonLines(p11Path), recipientCount));
  });
  const n1000 = counts.find(entry => entry.recipientCount === 1000);
  return {
    version: 1,
    phase: 'APDM-P11-A',
    generatedAt: new Date().toISOString(),
    completenessGate: {
      passed: true,
      minimumMeasuredSamples: MIN_MEASURED_SAMPLES,
      independentActionCount: QUERY_ACTION,
      requiresZeroUnattributedCalls: true,
      requiresKnownOperation: true,
      requiresBoundedLineageWithoutOverflow: true
    },
    counts,
    n1000TopByDuration: n1000?.queries.slice(0, 25) || []
  };
}

function parseArgs(argv) {
  if (argv.length !== 11) throw new Error('Usage: node apdm-phase11-summarize.js OUTPUT P8_1 P11_1 P8_10 P11_10 P8_100 P11_100 P8_200 P11_200 P8_1000 P11_1000');
  return {
    outputPath: path.resolve(argv[0]),
    pairs: REQUIRED_COUNTS.map((recipientCount, index) => ({
      recipientCount,
      p8Path: path.resolve(argv[1 + index * 2]),
      p11Path: path.resolve(argv[2 + index * 2])
    }))
  };
}

function main(argv = process.argv.slice(2)) {
  const { outputPath, pairs } = parseArgs(argv);
  const summary = buildSummary(pairs);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, n1000TotalQueryCallsMedian: summary.counts.at(-1).totalQueryCallsMedian })}\n`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`[APDM-P11] ${error.stack || error.message || String(error)}`); process.exit(1); }
}

module.exports = {
  ALLOWED_OPERATIONS,
  MIN_MEASURED_SAMPLES,
  QUERY_ACTION,
  REQUIRED_COUNTS,
  assertPrivacySafeRawArtifact,
  buildSummary,
  expectedPhase8QueryCount,
  median,
  selectMeasuredRecords,
  summarizeCount,
  validateQueryEntry,
  validateRecord
};
