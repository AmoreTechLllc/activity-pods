'use strict';

const crypto = require('crypto');
const {
  awaitActorBootstrap,
  normalizeRunId,
  signupWithCandidateRetries
} = require('./apdm-phase8-real-measure');
const {
  createW3RunnerBroker,
  validateNamespace,
  validateReplicaCount,
  waitForExactRootEndpoints
} = require('./adsp-p2-w3-remote-origin-fixture');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_TRANSPORTER_URL = 'redis://127.0.0.1:6379/12';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const PROOF_SCHEMA = 'adsp.p2.w3.horizontal-provisioning.v1';

function positiveInteger(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

async function runHorizontalProvisioningProof({
  namespace = process.env.ADSP_P2_NAMESPACE,
  expectedReplicas = process.env.ADSP_P2_W3_EXPECTED_REPLICAS,
  baseUrl = process.env.ADSP_P2_W3_BACKEND_BASE_URL || DEFAULT_BASE_URL,
  transporterUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL,
  readyTimeoutMs = positiveInteger(process.env.ADSP_P2_W3_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, 'ready timeout'),
  runId = process.env.ADSP_P2_W3_RUN_ID || `${Date.now()}`,
  brokerFactory = createW3RunnerBroker,
  waitForEndpointsFn = waitForExactRootEndpoints,
  signupFn = signupWithCandidateRetries,
  bootstrapFn = awaitActorBootstrap
} = {}) {
  const normalizedNamespace = validateNamespace(namespace);
  const normalizedExpectedReplicas = validateReplicaCount(expectedReplicas);
  const normalizedRunId = normalizeRunId(runId);
  const broker = brokerFactory(transporterUrl, `${normalizedRunId}-provision`, normalizedNamespace);

  await broker.start();
  try {
    await broker.waitForServices(['auth', 'activitypub.outbox', 'activitypub.actor'], readyTimeoutMs);
    const observedReplicas = await waitForEndpointsFn(broker, normalizedExpectedReplicas, readyTimeoutMs);
    const password = process.env.ADSP_P2_W3_SIGNUP_PASSWORD || `${crypto.randomBytes(24).toString('base64url')}A1!`;
    const actor = await signupFn({
      baseUrl,
      password,
      runId: `${normalizedRunId}-provision`,
      role: 'sender'
    });
    await bootstrapFn(broker, actor, 'outbox', readyTimeoutMs);

    if (!actor.webId || !actor.username || !actor.outbox) {
      throw new Error('Horizontal provisioning proof completed without a fully bootstrapped ActivityPub actor');
    }

    return {
      schema: PROOF_SCHEMA,
      ok: true,
      namespace: normalizedNamespace,
      expectedReplicas: normalizedExpectedReplicas,
      observedReplicas,
      username: actor.username,
      webId: actor.webId,
      outbox: actor.outbox
    };
  } finally {
    await broker.stop();
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 0) {
    throw new Error('Usage: node scripts/adsp-p2-w3-horizontal-provisioning-proof.js');
  }
  const result = await runHorizontalProvisioningProof();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2-W3-PROVISIONING] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  PROOF_SCHEMA,
  positiveInteger,
  runHorizontalProvisioningProof
};
