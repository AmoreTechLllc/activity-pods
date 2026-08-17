'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_COUNTS = Object.freeze([1, 10, 100, 200, 1000]);
const ALLOWED_RECORD_KEYS = new Set([
  'version',
  'phase',
  'requestId',
  'caseLabel',
  'recipientCount',
  'startedAt',
  'finishedAt',
  'totalQueryCalls',
  'attributedQueryCalls',
  'unattributedQueryCalls',
  'distinctAttributionKeys',
  'overflowed',
  'droppedCalls',
  'queries'
]);
const ALLOWED_QUERY_KEYS = new Set([
  'caller',
  'operation',
  'shapeHash',
  'count',
  'errorCount',
  'totalDurationMs',
  'maxDurationMs'
]);

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing attribution input: ${filePath}`);
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function assertExactKeys(object, allowed, label) {
  for (const key of Object.keys(object || {})) {
    if (!allowed.has(key)) throw new Error(`${label} contains unexpected key ${key}; refuse potentially sensitive artifact drift`);
  }
}

function assertPrivacySafeRawArtifact(raw, filePath) {
  const forbidden = [
    /https?:\/\//iu,
    /\b(?:SELECT|ASK|CONSTRUCT|DESCRIBE|INSERT|DELETE|PREFIX|BASE)\b/iu,
    /<[^>]+>/u,
    /"[^"\r\n]{3,}"/u
  ];
  for (const pattern of forbidden) {
    if (pattern.test(raw)) {
      throw new Error(`Privacy scan rejected ${filePath}: attribution artifact appears to contain raw query/IRI/literal material`);
    }
  }
}

function validateQueryEntry(entry, label) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label} must be an object`);
  assertExactKeys(entry, ALLOWED_QUERY_KEYS, label);
  if (!/^[A-Za-z0-9_.-]+$/u.test(entry.caller || '')) throw new Error(`${label}.caller is not a safe action identifier`);
  if (!/^[a-z]+$/u.test(entry.operation || '')) throw new Error(`${label}.operation is invalid`);
  if (!/^[a-f0-9]{64}$/u.test(entry.shapeHash || '')) throw new Error(`${label}.shapeHash is not SHA-256 hex`);
  for (const key of ['count', 'errorCount']) {
    if (!Number.isInteger(entry[key]) || entry[key] < 0) throw new Error(`${label}.${key} must be a non-negative integer`);
  }
  for (const key of ['totalDurationMs', 'maxDurationMs']) {
    if (!Number.isFinite(entry[key]) || entry[key] < 0) throw new Error(`${label}.${key} must be a non-negative number`);
  }
  if (entry.errorCount > entry.count) throw new Error(`${label}.errorCount exceeds count`);
  if (entry.maxDurationMs > entry.totalDurationMs + Number.EPSILON) {
    throw new Error(`${label}.maxDurationMs exceeds totalDurationMs`);
  }
}

function validateRecord(record, recipientCount, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error(`${label} must be an object`);
  assertExactKeys(record, ALLOWED_RECORD_KEYS, label);
  if (record.phase !== 'APDM-P11-A' || record.version !== 1) throw new Error(`${label} has unsupported phase/version`);
  if (Number(record.recipientCount) !== recipientCount) {
    throw new Error(`${label} recipientCount=${record.recipientCount} expected=${recipientCount}`);
  }
  if (typeof record.requestId !== 'string' || !/^apdm-p8-[a-z0-9-]+$/u.test(record.requestId)) {
    throw new Error(`${label} requestId is missing or malformed`);
  }
  if (record.overflowed !== false || record.droppedCalls !== 0) {
    throw new Error(`${label} attribution cardinality overflowed; evidence is incomplete`);
  }
  for (const key of ['totalQueryCalls', 'attributedQueryCalls', 'unattributedQueryCalls', 'distinctAttributionKeys']) {
    if (!Number.isInteger(record[key]) || record[key] < 0) throw new Error(`${label}.${key} must be a non-negative integer`);
  }
  if (record.attributedQueryCalls + record.unattributedQueryCalls !== record.totalQueryCalls) {
    throw new Error(`${label} attributed/unattributed counts do not sum to totalQueryCalls`);
  }
  if (!Array.isArray(record.queries)) throw new Error(`${label}.queries must be an array`);
  record.queries.forEach((entry, index) => validateQueryEntry(entry, `${label}.queries[${index}]`));
  if (record.queries.length !== record.distinctAttributionKeys) {
    throw new Error(`${label} distinctAttributionKeys does not match queries length`);
  }
  const summedCount = record.queries.reduce((sum, entry) => sum + entry.count, 0);
  if (summedCount !== record.totalQueryCalls) {
    throw new Error(`${label} aggregate counts=${summedCount} do not match totalQueryCalls=${record.totalQueryCalls}`);
  }
}

function selectMeasuredRecords(p8Records, p11Records, recipientCount) {
  const p11ByRequestId = new Map();
  for (const record of p11Records) {
    if (p11ByRequestId.has(record.requestId)) throw new Error(`Duplicate Phase 11 requestId ${record.requestId} at N=${recipientCount}`);
    p11ByRequestId.set(record.requestId, record);
  }

  return p8Records.map((p8, index) => {
    if (!p8 || p8.phase !== 'APDM-P8-A') throw new Error(`Invalid Phase 8 sample ${index + 1} at N=${recipientCount}`);
    if (Number(p8.recipientCount) !== recipientCount) throw new Error(`Phase 8 sample count mismatch at N=${recipientCount}`);
    const p11 = p11ByRequestId.get(p8.requestId);
    if (!p11) throw new Error(`No Phase 11 attribution record for measured requestId=${p8.requestId}`);
    validateRecord(p11, recipientCount, `N=${recipientCount} requestId=${p8.requestId}`);
    return p11;
  });
}

function summarizeCount(recipientCount, measuredRecords) {
  const byKey = new Map();
  for (const record of measuredRecords) {
    for (const query of record.queries) {
      const key = `${query.caller}\u0000${query.operation}\u0000${query.shapeHash}`;
      let aggregate = byKey.get(key);
      if (!aggregate) {
        aggregate = {
          caller: query.caller,
          operation: query.operation,
          shapeHash: query.shapeHash,
          count: 0,
          errorCount: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          sampleCounts: [],
          sampleDurationsMs: []
        };
        byKey.set(key, aggregate);
      }
      aggregate.count += query.count;
      aggregate.errorCount += query.errorCount;
      aggregate.totalDurationMs += query.totalDurationMs;
      aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, query.maxDurationMs);
    }
  }

  for (const aggregate of byKey.values()) {
    for (const record of measuredRecords) {
      const match = record.queries.find(
        query =>
          query.caller === aggregate.caller &&
          query.operation === aggregate.operation &&
          query.shapeHash === aggregate.shapeHash
      );
      aggregate.sampleCounts.push(match ? match.count : 0);
      aggregate.sampleDurationsMs.push(match ? match.totalDurationMs : 0);
    }
    aggregate.medianCountPerSample = median(aggregate.sampleCounts);
    aggregate.medianDurationMsPerSample = median(aggregate.sampleDurationsMs);
  }

  const queries = [...byKey.values()].sort((a, b) => {
    if (b.medianDurationMsPerSample !== a.medianDurationMsPerSample) {
      return b.medianDurationMsPerSample - a.medianDurationMsPerSample;
    }
    if (b.medianCountPerSample !== a.medianCountPerSample) return b.medianCountPerSample - a.medianCountPerSample;
    return `${a.caller}:${a.shapeHash}`.localeCompare(`${b.caller}:${b.shapeHash}`);
  });

  return {
    recipientCount,
    samples: measuredRecords.length,
    totalQueryCallsMedian: median(measuredRecords.map(record => record.totalQueryCalls)),
    attributedQueryCallsMedian: median(measuredRecords.map(record => record.attributedQueryCalls)),
    unattributedQueryCallsMedian: median(measuredRecords.map(record => record.unattributedQueryCalls)),
    distinctAttributionKeysMedian: median(measuredRecords.map(record => record.distinctAttributionKeys)),
    queryErrorCount: queries.reduce((sum, query) => sum + query.errorCount, 0),
    queries
  };
}

function buildSummary(pairs) {
  const counts = pairs.map(({ recipientCount, p8Path, p11Path }) => {
    const rawP11 = fs.readFileSync(p11Path, 'utf8');
    assertPrivacySafeRawArtifact(rawP11, p11Path);
    const p8Records = readJsonLines(p8Path);
    const p11Records = readJsonLines(p11Path);
    if (p8Records.length === 0) throw new Error(`No measured Phase 8 records at N=${recipientCount}`);
    const measuredRecords = selectMeasuredRecords(p8Records, p11Records, recipientCount);
    return summarizeCount(recipientCount, measuredRecords);
  });

  const n1000 = counts.find(entry => entry.recipientCount === 1000);
  return {
    version: 1,
    phase: 'APDM-P11-A',
    generatedAt: new Date().toISOString(),
    counts,
    n1000TopByDuration: n1000 ? n1000.queries.slice(0, 25) : []
  };
}

function parseArgs(argv) {
  if (argv.length !== 1 + REQUIRED_COUNTS.length * 2) {
    throw new Error(
      `Usage: node apdm-phase11-summarize.js OUTPUT ${REQUIRED_COUNTS.map(count => `P8_N${count} P11_N${count}`).join(' ')}`
    );
  }
  const outputPath = path.resolve(argv[0]);
  const pairs = REQUIRED_COUNTS.map((recipientCount, index) => ({
    recipientCount,
    p8Path: path.resolve(argv[1 + index * 2]),
    p11Path: path.resolve(argv[2 + index * 2])
  }));
  return { outputPath, pairs };
}

function main(argv = process.argv.slice(2)) {
  const { outputPath, pairs } = parseArgs(argv);
  const summary = buildSummary(pairs);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ok: true, outputPath, n1000TotalQueryCallsMedian: summary.counts.at(-1).totalQueryCallsMedian })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[APDM-P11] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  ALLOWED_QUERY_KEYS,
  ALLOWED_RECORD_KEYS,
  REQUIRED_COUNTS,
  assertPrivacySafeRawArtifact,
  buildSummary,
  median,
  selectMeasuredRecords,
  summarizeCount,
  validateQueryEntry,
  validateRecord
};
