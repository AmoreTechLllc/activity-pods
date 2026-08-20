'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FUSEKI_BASE = 'http://fuseki_test:3030/';

function sparqlString(value) {
  return JSON.stringify(String(value));
}

function buildMarkerQuery(requestId) {
  const marker = `ADSP P2 node-loss ${requestId}`;
  return `SELECT (COUNT(DISTINCT ?subject) AS ?count) WHERE {\n  { ?subject ?predicate ?value . }\n  UNION\n  { GRAPH ?graph { ?subject ?predicate ?value . } }\n  FILTER(STR(?value) = ${sparqlString(marker)})\n}`;
}

function collectOutcomeExpectations(result) {
  const accepted = [
    ...(result?.faultBurst?.accepted || []),
    ...(result?.recovery?.results || []),
    ...(result?.rejoin?.results || [])
  ];
  const rejected = result?.faultBurst?.rejected || [];
  const seen = new Set();

  const expectations = [];
  for (const entry of accepted) {
    if (!entry?.requestId) throw new Error('Accepted node-loss outcome is missing requestId');
    if (seen.has(entry.requestId)) throw new Error(`Duplicate node-loss requestId in persistence audit: ${entry.requestId}`);
    seen.add(entry.requestId);
    expectations.push({ requestId: entry.requestId, callerOutcome: 'accepted', minCount: 1, maxCount: 1 });
  }
  for (const entry of rejected) {
    if (!entry?.requestId) throw new Error('Rejected node-loss outcome is missing requestId');
    if (seen.has(entry.requestId)) throw new Error(`Duplicate node-loss requestId in persistence audit: ${entry.requestId}`);
    seen.add(entry.requestId);
    expectations.push({ requestId: entry.requestId, callerOutcome: 'rejected', minCount: 0, maxCount: 1 });
  }

  if (expectations.length === 0) throw new Error('Node-loss persistence audit has no request outcomes');
  return expectations;
}

function datasetQueryUrl(fusekiBase, dataset) {
  const base = new URL(fusekiBase);
  if (!dataset || /[/\\?#]/u.test(dataset)) throw new Error(`Unsafe Fuseki dataset identifier: ${dataset}`);
  base.pathname = `${base.pathname.replace(/\/*$/u, '/')}${encodeURIComponent(dataset)}/query`;
  base.search = '';
  base.hash = '';
  return base.toString();
}

async function queryMarkerCount({ fetchImpl, fusekiBase, dataset, requestId }) {
  const response = await fetchImpl(datasetQueryUrl(fusekiBase, dataset), {
    method: 'POST',
    headers: {
      accept: 'application/sparql-results+json',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
    },
    body: new URLSearchParams({ query: buildMarkerQuery(requestId) }).toString(),
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Fuseki persistence audit failed for ${requestId}: HTTP ${response.status}; ${text.slice(0, 300)}`);
  }
  const payload = await response.json();
  const raw = payload?.results?.bindings?.[0]?.count?.value;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`Fuseki persistence audit returned invalid count for ${requestId}: ${JSON.stringify(raw)}`);
  }
  return count;
}

async function auditPersistence({ result, dataset, fusekiBase = DEFAULT_FUSEKI_BASE, fetchImpl = fetch }) {
  const expectations = collectOutcomeExpectations(result);
  const records = [];

  for (const expectation of expectations) {
    const count = await queryMarkerCount({ fetchImpl, fusekiBase, dataset, requestId: expectation.requestId });
    const ok = count >= expectation.minCount && count <= expectation.maxCount;
    records.push({
      ...expectation,
      persistedMarkerSubjectCount: count,
      ambiguousPersistedMutationObserved: expectation.callerOutcome === 'rejected' && count === 1,
      ok
    });
  }

  const failures = records.filter(record => !record.ok);
  return {
    version: 1,
    phase: 'ADSP-P2-A',
    fixture: 'horizontal-redis-node-loss-persistence-audit',
    dataset,
    fusekiBase,
    requestCount: records.length,
    acceptedCount: records.filter(record => record.callerOutcome === 'accepted').length,
    rejectedCount: records.filter(record => record.callerOutcome === 'rejected').length,
    ambiguousPersistedRejectedCount: records.filter(record => record.ambiguousPersistedMutationObserved).length,
    duplicatePersistedMutationCount: records.filter(record => record.persistedMarkerSubjectCount > 1).length,
    failures,
    records,
    complete: true,
    passed: failures.length === 0
  };
}

async function main(argv = process.argv.slice(2)) {
  const manifestPath = path.resolve(argv[0] || '');
  const resultPath = path.resolve(argv[1] || '');
  const outputPath = path.resolve(argv[2] || '');
  if (!argv[0] || !argv[1] || !argv[2]) {
    throw new Error('Usage: adsp-p2-node-loss-persistence-audit.js <manifest.json> <node-loss-result.json> <output.json>');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const dataset = manifest?.sender?.username;
  if (!dataset) throw new Error('Actor manifest is missing sender.username dataset authority');

  const audit = await auditPersistence({
    result,
    dataset,
    fusekiBase: process.env.ADSP_P2_FUSEKI_BASE || DEFAULT_FUSEKI_BASE
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: audit.passed,
    requestCount: audit.requestCount,
    ambiguousPersistedRejectedCount: audit.ambiguousPersistedRejectedCount,
    duplicatePersistedMutationCount: audit.duplicatePersistedMutationCount,
    outputPath
  })}\n`);
  if (!audit.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2-LOSS-PERSISTENCE] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  auditPersistence,
  buildMarkerQuery,
  collectOutcomeExpectations,
  datasetQueryUrl,
  queryMarkerCount,
  sparqlString
};
