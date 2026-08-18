'use strict';

const crypto = require('crypto');
const { ServiceBroker } = require('moleculer');
const {
  awaitActorBootstrap,
  normalizeRunId,
  signupWithCandidateRetries
} = require('./apdm-phase8-real-measure');
const {
  AS_PUBLIC,
  buildFixtureEvidence,
  createEvidenceLatch
} = require('./adsp-p0-remote-origin-fixture');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_TRANSPORTER_URL = 'redis://127.0.0.1:6379/12';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_EVIDENCE_TIMEOUT_MS = 120_000;

function positiveInteger(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
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

async function runW3RemoteOriginFixture({
  remoteActorUri,
  namespace = process.env.ADSP_P2_NAMESPACE,
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
  if (typeof remoteActorUri !== 'string' || remoteActorUri.length === 0) {
    throw new Error('ADSP P2 W3 remote actor URI is required');
  }

  const broker = createW3RunnerBroker(transporterUrl, runId, namespace);
  const senderWebIdRef = { value: null };
  const marker = `ADSP P2 W3 remote-origin ${normalizeRunId(runId)} ${crypto.randomBytes(12).toString('hex')}`;
  const latch = createEvidenceLatch(broker, { senderWebIdRef, marker, timeoutMs: evidenceTimeoutMs });

  await broker.start();
  try {
    await broker.waitForServices(['auth', 'activitypub.outbox', 'activitypub.actor'], readyTimeoutMs);
    const password = process.env.ADSP_P2_W3_SIGNUP_PASSWORD || `${crypto.randomBytes(24).toString('base64url')}A1!`;
    const sender = await signupWithCandidateRetries({
      baseUrl,
      password,
      runId,
      role: 'sender'
    });
    await awaitActorBootstrap(broker, sender, 'outbox', readyTimeoutMs);
    senderWebIdRef.value = sender.webId;

    latch.arm();
    const [postResult, plannedEvent] = await Promise.all([
      broker.call(
        'activitypub.outbox.post',
        {
          collectionUri: sender.outbox,
          type: 'Create',
          actor: sender.webId,
          to: [remoteActorUri],
          cc: [AS_PUBLIC],
          object: { type: 'Note', content: marker }
        },
        {
          meta: { webId: sender.webId, dataset: sender.username },
          requestID: `adsp-p2-w3-origin-${crypto.randomBytes(12).toString('hex')}`
        }
      ),
      latch.promise
    ]);

    const evidence = buildFixtureEvidence({
      postResult,
      plannedEvent,
      remoteActorUri,
      senderWebId: sender.webId
    });

    return {
      ...evidence,
      adspPhase: 'ADSP-P2-W3',
      moleculerNamespace: validateNamespace(namespace),
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
  createW3RunnerBroker,
  runW3RemoteOriginFixture,
  validateNamespace
};
