'use strict';

const crypto = require('crypto');
const { ServiceBroker } = require('moleculer');
const {
  awaitActorBootstrap,
  normalizeRunId,
  signupWithCandidateRetries
} = require('./apdm-phase8-real-measure');
const { validateDeliveryPlanV1 } = require('../utils/activitypub-delivery-plan');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const DEFAULT_TRANSPORTER_URL = 'redis://127.0.0.1:6379/12';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_EVIDENCE_TIMEOUT_MS = 120_000;
const REMOTE_DELIVERY_PLANNED_EVENT = 'activitypub.outbox.remote-delivery.handoff-queued';

function positiveInteger(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function validateRemoteActorUri(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('remote actor URI must be a non-empty, whitespace-free HTTP(S) URL');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('remote actor URI must be a valid HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error('remote actor URI must be a credential-free HTTP(S) URL without a fragment');
  }
  return parsed.toString();
}

function createRunnerBroker(transporterUrl, runId) {
  return new ServiceBroker({
    nodeID: `adsp-p0-remote-origin-${normalizeRunId(runId)}-${process.pid}`,
    logger: false,
    transporter: transporterUrl,
    requestTimeout: DEFAULT_READY_TIMEOUT_MS,
    retryPolicy: { enabled: false }
  });
}

function createEvidenceLatch(broker, { senderWebIdRef, marker, timeoutMs }) {
  let settle;
  let reject;
  let timer;
  const promise = new Promise((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });

  broker.createService({
    name: `adsp-p0-remote-origin-evidence-${crypto.randomBytes(6).toString('hex')}`,
    events: {
      [REMOTE_DELIVERY_PLANNED_EVENT]: {
        handler(ctx) {
          const activity = ctx?.params?.activity;
          const actorUri = typeof activity?.actor === 'string' ? activity.actor : activity?.actor?.id || activity?.actor?.['@id'];
          const object = activity?.object && typeof activity.object === 'object' ? activity.object : null;
          if (!senderWebIdRef.value || actorUri !== senderWebIdRef.value || object?.content !== marker) return;
          clearTimeout(timer);
          settle(ctx.params);
        }
      }
    }
  });

  timer = setTimeout(() => {
    reject(new Error(`Timed out waiting for ${REMOTE_DELIVERY_PLANNED_EVENT}`));
  }, timeoutMs);

  return {
    promise,
    cancel() {
      clearTimeout(timer);
    }
  };
}

function buildFixtureEvidence({ postResult, plannedEvent, remoteActorUri }) {
  if (!postResult || typeof postResult !== 'object' || typeof postResult.id !== 'string' || postResult.id.length === 0) {
    throw new Error('ActivityPods outbox post did not return a persisted Activity with an id');
  }
  const deliveryPlan = plannedEvent?.deliveryPlan;
  if (!validateDeliveryPlanV1(deliveryPlan)) {
    throw new Error('ActivityPods did not emit a valid authoritative ap.delivery-plan.v1');
  }
  if (deliveryPlan.activityId !== postResult.id || deliveryPlan.activity?.id !== postResult.id) {
    throw new Error('ActivityPods Delivery Plan does not match the persisted outbox Activity');
  }
  if (plannedEvent.deliveryMode !== 'external' || plannedEvent.durableHandoffQueued !== true) {
    throw new Error('ActivityPods did not prove external durable-handoff authority for the persisted Activity');
  }
  if (!Array.isArray(deliveryPlan.remoteRecipients) || deliveryPlan.remoteRecipients.length !== 1) {
    throw new Error(`Expected exactly one authoritative remote recipient, found ${deliveryPlan.remoteRecipients?.length ?? 0}`);
  }
  const target = deliveryPlan.remoteRecipients[0];
  if (target.actorUri !== remoteActorUri) {
    throw new Error(`Authoritative remote actor ${target.actorUri} does not match requested actor ${remoteActorUri}`);
  }

  return {
    schema: 'adsp.p0.activitypods-remote-origin.v1',
    activityId: postResult.id,
    actorUri: deliveryPlan.actorUri,
    activity: deliveryPlan.activity,
    deliveryPlanSchema: deliveryPlan.schema,
    deliveryPlanIntentId: deliveryPlan.intentId,
    remoteActorUri: target.actorUri,
    inboxUrl: target.inboxUrl,
    ...(target.sharedInboxUrl ? { sharedInboxUrl: target.sharedInboxUrl } : {}),
    targetDomain: target.targetDomain,
    suppressedNativeRemotePostCount: plannedEvent.suppressedNativeRemotePostCount,
    durableHandoffQueued: true
  };
}

async function runRemoteOriginFixture({
  remoteActorUri,
  baseUrl = process.env.ADSP_P0_BACKEND_BASE_URL || DEFAULT_BASE_URL,
  transporterUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL,
  readyTimeoutMs = positiveInteger(process.env.ADSP_P0_READY_TIMEOUT_MS, DEFAULT_READY_TIMEOUT_MS, 'ready timeout'),
  evidenceTimeoutMs = positiveInteger(
    process.env.ADSP_P0_EVIDENCE_TIMEOUT_MS,
    DEFAULT_EVIDENCE_TIMEOUT_MS,
    'evidence timeout'
  ),
  runId = process.env.ADSP_P0_RUN_ID || `${Date.now()}`
}) {
  const normalizedRemoteActorUri = validateRemoteActorUri(remoteActorUri);
  const broker = createRunnerBroker(transporterUrl, runId);
  const senderWebIdRef = { value: null };
  const marker = `ADSP P0 remote-origin ${normalizeRunId(runId)} ${crypto.randomBytes(12).toString('hex')}`;
  const latch = createEvidenceLatch(broker, { senderWebIdRef, marker, timeoutMs: evidenceTimeoutMs });

  await broker.start();
  try {
    await broker.waitForServices(['auth', 'activitypub.outbox', 'activitypub.actor'], readyTimeoutMs);
    const password = process.env.ADSP_P0_SIGNUP_PASSWORD || 'AdspP0RemoteOriginPass123!';
    const sender = await signupWithCandidateRetries({
      baseUrl,
      password,
      runId,
      role: 'sender'
    });
    await awaitActorBootstrap(broker, sender, 'outbox', readyTimeoutMs);
    senderWebIdRef.value = sender.webId;

    const postResult = await broker.call(
      'activitypub.outbox.post',
      {
        collectionUri: sender.outbox,
        type: 'Create',
        actor: sender.webId,
        to: [normalizedRemoteActorUri],
        object: { type: 'Note', content: marker }
      },
      {
        meta: { webId: sender.webId, dataset: sender.username },
        requestID: `adsp-p0-origin-${crypto.randomBytes(12).toString('hex')}`
      }
    );

    const plannedEvent = await latch.promise;
    const evidence = buildFixtureEvidence({
      postResult,
      plannedEvent,
      remoteActorUri: normalizedRemoteActorUri
    });
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
    throw new Error('Usage: node scripts/adsp-p0-remote-origin-fixture.js <remoteActorUri>');
  }
  const result = await runRemoteOriginFixture({ remoteActorUri: argv[0] });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P0] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  REMOTE_DELIVERY_PLANNED_EVENT,
  buildFixtureEvidence,
  createEvidenceLatch,
  createRunnerBroker,
  runRemoteOriginFixture,
  validateRemoteActorUri
};
