'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FUSEKI_BASE = 'http://fuseki_test:3030/';
const ACTIVITYSTREAMS_NOTE_IRI = 'https://www.w3.org/ns/activitystreams#Note';

function sparqlString(value) {
  return JSON.stringify(String(value));
}

function buildMarkerQuery(requestId) {
  const marker = `ADSP P2 node-loss ${requestId}`;
  return `SELECT (COUNT(DISTINCT ?subject) AS ?count) WHERE {\n  {\n    ?subject a <${ACTIVITYSTREAMS_NOTE_IRI}> ; ?predicate ?value .\n  }\n  UNION\n  {\n    GRAPH ?graph { ?subject a <${ACTIVITYSTREAMS_NOTE_IRI}> ; ?predicate ?value . }\n  }\n  FILTER(isIRI(?subject))\n  FILTER(STR(?value) = ${sparqlString(marker)})\n}`;
}

function collectOutcomeExpectations(result) {
  const accepted = [
    ...(result?.faultBurst?.accepted || []),
    ...(result?.recovery?.results || []),
    ...(result?.rejoin?.results || [])
  ];
  const rejected = result?.faultBurst?.rejected || [];
  const targetedAmbiguousRequestId = result?.victimRootEntry?.requestId;
  if (!targetedAmbiguousRequestId) throw new Error('Node-loss result is missing victimRootEntry.requestId');
  const seen = new Set();

  const expectations = [];
  for (const entry of accepted) {
    if (!entry?.requestId) throw new Error('Accepted node-loss outcome is missing requestId');
    if (seen.has(entry.requestId)) throw new Error(`Duplicate node-loss requestId in persistence audit: ${entry.requestId}`);
    seen.add(entry.requestId);
    expectations.push({
      requestId: entry.requestId,
      callerOutcome: 'accepted',
      targetedAmbiguousCommit: entry.requestId === targetedAmbiguousRequestId,
      minCount: 1,
      maxCount: 1
    });
  }
  for (const entry of rejected) {
    if (!entry?.requestId) throw new Error('Rejected node-loss outcome is missing requestId');
    if (seen.has(entry.requestId)) throw new Error(`Duplicate node-loss requestId in persistence audit: ${entry.requestId}`);
    seen.add(entry.requestId);
    const targetedAmbiguousCommit = entry.requestId === targetedAmbiguousRequestId;
    expectations.push({
      requestId: entry.requestId,
      callerOutcome: 'rejected',
      targetedAmbiguousCommit,
      minCount: targetedAmbiguousCommit ? 1 : 0,
      maxCount: 1
    });
  }

  if (expectations.length === 0) throw new Error('Node-loss persistence audit has no request outcomes');
  const targeted = expectations.filter(expectation => expectation.targetedAmbiguousCommit);
  if (targeted.length !== 1) {
    throw new Error(`Expected exactly one targeted ambiguous request outcome, observed ${targeted.length}`);
  }
  if (targeted[0].callerOutcome !== 'rejected') {
    throw new Error(`Targeted ambiguous request ${targetedAmbiguousRequestId} must be caller-rejected, observed ${targeted[0].callerOutcome}`);
  }
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

function buildFusekiAuthorization(fusekiUser, fusekiPassword) {
  const hasUser = typeof fusekiUser === 'string' && fusekiUser.length > 0;
  const hasPassword = typeof fusekiPassword === 'string' && fusekiPassword.length > 0;
  if (hasUser !== hasPassword) {
    throw new Error('Fuseki persistence audit requires both username and password when authentication is configured');
  }
  if (!hasUser) return null;
  if (/[:\r\n]/u.test(fusekiUser)) throw new Error('Unsafe Fuseki audit username');
  if (/[\r\n]/u.test(fusekiPassword)) throw new Error('Unsafe Fuseki audit password');
  return `Basic ${Buffer.from(`${fusekiUser}:${fusekiPassword}`, 'utf8').toString('base64')}`;
}

async function queryMarkerCount({ fetchImpl, fusekiBase, dataset, requestId, authorization = null }) {
  const headers = {
    accept: 'application/sparql-results+json',
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
  };
  if (authorization) headers.authorization = authorization;

  const response = await fetchImpl(datasetQueryUrl(fusekiBase, dataset), {
    method: 'POST',
    headers,
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

async function auditPersistence({
  result,
  dataset,
  fusekiBase = DEFAULT_FUSEKI_BASE,
  fusekiUser,
  fusekiPassword,
  fetchImpl = fetch
}) {
  const expectations = collectOutcomeExpectations(result);
  const authorization = buildFusekiAuthorization(fusekiUser, fusekiPassword);
  const records = [];

  for (const expectation of expectations) {
    const count = await queryMarkerCount({
      fetchImpl,
      fusekiBase,
      dataset,
      requestId: expectation.requestId,
      authorization
    });
    const ok = count >= expectation.minCount && count <= expectation.maxCount;
    records.push({
      ...expectation,
      persistedNoteResourceCount: count,
      ambiguousPersistedMutationObserved: expectation.callerOutcome === 'rejected' && count === 1,
      ok
    });
  }

  const failures = records.filter(record => !record.ok);
  const targetedAmbiguousRecord = records.find(record => record.targetedAmbiguousCommit);
  return {
    version: 2,
    phase: 'ADSP-P2-A',
    fixture: 'horizontal-redis-node-loss-persistence-audit',
    authoritativeResourceType: ACTIVITYSTREAMS_NOTE_IRI,
    resourceIdentityRequirement: 'iri',
    dataset,
    fusekiBase,
    authenticatedQuery: authorization !== null,
    requestCount: records.length,
    acceptedCount: records.filter(record => record.callerOutcome === 'accepted').length,
    rejectedCount: records.filter(record => record.callerOutcome === 'rejected').length,
    targetedAmbiguousRequestId: targetedAmbiguousRecord.requestId,
    targetedAmbiguousCallerOutcome: targetedAmbiguousRecord.callerOutcome,
    targetedAmbiguousCommitPersistedExactlyOnce: targetedAmbiguousRecord.persistedNoteResourceCount === 1,
    ambiguousPersistedRejectedCount: records.filter(record => record.ambiguousPersistedMutationObserved).length,
    duplicatePersistedMutationCount: records.filter(record => record.persistedNoteResourceCount > 1).length,
    failures,
    records,
    complete: true,
    passed: failures.length === 0 && targetedAmbiguousRecord.persistedNoteResourceCount === 1
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
    fusekiBase: process.env.ADSP_P2_FUSEKI_BASE || DEFAULT_FUSEKI_BASE,
    fusekiUser: process.env.ADSP_P2_FUSEKI_USER,
    fusekiPassword: process.env.ADSP_P2_FUSEKI_PASSWORD
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    ok: audit.passed,
    authenticatedQuery: audit.authenticatedQuery,
    requestCount: audit.requestCount,
    targetedAmbiguousCommitPersistedExactlyOnce: audit.targetedAmbiguousCommitPersistedExactlyOnce,
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
  ACTIVITYSTREAMS_NOTE_IRI,
  auditPersistence,
  buildFusekiAuthorization,
  buildMarkerQuery,
  collectOutcomeExpectations,
  datasetQueryUrl,
  queryMarkerCount,
  sparqlString
};
