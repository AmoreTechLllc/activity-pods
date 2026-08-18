'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ServiceBroker } = require('moleculer');
const {
  awaitActorBootstrap,
  normalizeRunId,
  signupWithCandidateRetries
} = require('./apdm-phase8-real-measure');
const {
  AS_PUBLIC,
  buildFixtureEvidence,
  createEvidenceLatch,
  validateRemoteActorUri
} = require('./adsp-p0-remote-origin-fixture');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_TRANSPORTER_URL = 'redis://127.0.0.1:6379/12';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_EVIDENCE_TIMEOUT_MS = 120_000;
const CORRELATION_SCHEMA = 'adsp.p2.w3.origin-correlation.v1';
const ROOT_ACTION = 'activitypub.outbox.post';
const W3_REPLICA_COUNTS = new Set([1, 2, 4]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInteger(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function validateReplicaCount(value) {
  const parsed = positiveInteger(value, undefined, 'ADSP P2 W3 expected replicas');
  if (!W3_REPLICA_COUNTS.has(parsed)) throw new Error('ADSP P2 W3 expected replicas must be one of 1, 2, or 4');
  return parsed;
}

function validateNamespace(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || /[\r\n\0]/u.test(value)) {
    throw new Error('ADSP P2 W3 Moleculer namespace must be a non-empty, whitespace-free string');
  }
  return value;
}

function createW3RunnerBroker(transporterUrl, runId, namespace) {
  const normalizedNamespace = validateNamespace(namespace);
  return new ServiceBroker({
    namespace: normalizedNamespace,
    nodeID: `adsp-p2-w3-remote-origin-${normalizeRunId(runId)}-${process.pid}`,
    logger: false,
    transporter: transporterUrl,
    requestTimeout: DEFAULT_READY_TIMEOUT_MS,
    retryPolicy: { enabled: false }
  });
}

function endpointCount(broker, actionName = ROOT_ACTION) {
  return broker.registry.getActionEndpoints(actionName)?.count?.() ?? 0;
}

async function waitForExactRootEndpoints(broker, expectedReplicas, timeoutMs) {
  const expected = validateReplicaCount(expectedReplicas);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (endpointCount(broker) === expected) return expected;
    await sleep(100);
  }
  throw new Error(`Expected exactly ${expected} ${ROOT_ACTION} endpoints, observed ${endpointCount(broker)}`);
}

function writeCorrelationEvidence(filePath, evidence) {
  if (!filePath) return;
  if (typeof filePath !== 'string' || filePath.trim() !== filePath || filePath.length === 0 || /[\r\n\0]/u.test(filePath)) {
    throw new Error('ADSP P2 W3 correlation output path must be an exact non-empty path');
  }
  const record = {
    schema: CORRELATION_SCHEMA,
    requestId: evidence.requestId,
    activityId: evidence.activityId,
    moleculerNamespace: validateNamespace(evidence.moleculerNamespace),
    expectedReplicas: validateReplicaCount(evidence.expectedReplicas)
  };
  for (const [name, value] of Object.entries(record)) {
    if (name === 'expectedReplicas') continue;
    if (typeof value !== 'string' || value.length === 0) throw new Error(`ADSP P2 W3 correlation ${name} is required`);
  }
  const outputPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, outputPath);
}

async function runW3RemoteOriginFixture({
  remoteActorUri,
  namespace = process.env.ADSP_P2_NAMESPACE,
  expectedReplicas = process.env.ADSP_P2_W3_EXPECTED_REPLICAS,
  correlationOutput = process.env.ADSP_P2_W3_CORRELATION_OUTPUT,
  baseUrl = process.env.ADSP_P2_W3_BACKEND_BASE_URL || DEFAULT_BASE_URL,
  transporterUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL,
  readyTimeoutMs = positiveInteger(process.env.ADSP_P2_W3_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, 'ready timeout'),
  evidenceTimeoutMs = positiveInteger(
    process.env.ADSP_P2_W3_EVIDENCE_TIMEOUT_MS,
    DEFAULT_EVIDENCE_TIMEOUT_MS,
    'evidence timeout'
  ),
  runId = process.env.ADSP_P2_W3_RUN_ID || `${Date.now()}`
}) {
  const normalizedRemoteActorUri = validateRemoteActorUri(remoteActorUri);
  const normalizedNamespace = validateNamespace(namespace);
  const normalizedExpectedReplicas = validateReplicaCount(expectedReplicas);
  const broker = createW3RunnerBroker(transporterUrl, runId, normalizedNamespace);
  const senderWebIdRef = { value: null };
  const marker = `ADSP P2 W3 remote-origin ${normalizeRunId(runId)} ${crypto.randomBytes(12).toString('hex')}`;
  const latch = createEvidenceLatch(broker, { senderWebIdRef, marker, timeoutMs: evidenceTimeoutMs });

  await broker.start();
  try {
    await broker.waitForServices(['auth', 'activitypub.outbox', 'activitypub.actor'], readyTimeoutMs);
    await waitForExactRootEndpoints(broker, normalizedExpectedReplicas, readyTimeoutMs);
    const password = process.env.ADSP_P2_W3_SIGNUP_PASSWORD || `${crypto.randomBytes(24).toString('base64url')}A1!`;
    const sender = await signupWithCandidateRetries({
      baseUrl,
      password,
      runId,
      role: 'sender'
    });
    await awaitActorBootstrap(broker, sender, 'outbox', readyTimeoutMs);
    senderWebIdRef.value = sender.webId;

    const requestId = `adsp-p2-w3-origin-${crypto.randomBytes(12).toString('hex')}`;
    latch.arm();
    const [postResult, plannedEvent] = await Promise.all([
      broker.call(
        ROOT_ACTION,
        {
          collectionUri: sender.outbox,
          type: 'Create',
          actor: sender.webId,
          to: [normalizedRemoteActorUri],
          cc: [AS_PUBLIC],
          object: { type: 'Note', content: marker }
        },
        {
          meta: { webId: sender.webId, dataset: sender.username },
          requestID: requestId
        }
      ),
      latch.promise
    ]);

    const evidence = buildFixtureEvidence({
      postResult,
      plannedEvent,
      remoteActorUri: normalizedRemoteActorUri,
      senderWebId: sender.webId
    });
    writeCorrelationEvidence(correlationOutput, {
      requestId,
      activityId: evidence.activityId,
      moleculerNamespace: normalizedNamespace,
      expectedReplicas: normalizedExpectedReplicas
    });

    // Keep stdout/parser compatibility with the strict P0 origin schema. W3
    // correlation metadata is intentionally written to a separate artifact.
    return {
      ...evidence,
      senderUsername: sender.username
    };
  } finally {
    latch.cancel();
    await broker.stop();
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) {
    throw new Error('Usage: node scripts/adsp-p2-w3-remote-origin-fixture.js <remoteActorUri>');
  }
  const result = await runW3RemoteOriginFixture({ remoteActorUri: argv[0] });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2-W3] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  CORRELATION_SCHEMA,
  ROOT_ACTION,
  createW3RunnerBroker,
  endpointCount,
  runW3RemoteOriginFixture,
  validateNamespace,
  validateReplicaCount,
  waitForExactRootEndpoints,
  writeCorrelationEvidence
};
