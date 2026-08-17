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

function normalizeEntityId(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.id || value['@id'] || null;
  return null;
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
  let timer = null;
  let armed = false;
  let settled = false;
  const promise = new Promise((resolve, rejectPromise) => {
    settle = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    reject = error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rejectPromise(error);
    };
  });

  broker.createService({
    name: `adsp-p0-remote-origin-evidence-${crypto.randomBytes(6).toString('hex')}`,
    events: {
      [REMOTE_DELIVERY_PLANNED_EVENT]: {
        handler(ctx) {
          const activity = ctx?.params?.activity;
          const actorUri = normalizeEntityId(activity?.actor);
          const object = activity?.object && typeof activity.object === 'object' && !Array.isArray(activity.object)
            ? activity.object
            : null;
          if (!armed || !senderWebIdRef.value || actorUri !== senderWebIdRef.value || object?.content !== marker) return;
          settle(ctx.params);
        }
      }
    }
  });

  return {
    promise,
    arm() {
      if (armed) throw new Error('Remote-origin evidence latch is already armed');
      if (settled) throw new Error('Remote-origin evidence latch is already settled');
      armed = true;
      timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${REMOTE_DELIVERY_PLANNED_EVENT}`));
      }, timeoutMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    }
  };
}

function assertExactStringArray(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    throw new Error(`${label} does not match the measured Activity authority`);
  }
}

function buildFixtureEvidence({ postResult, plannedEvent, remoteActorUri, senderWebId }) {
  if (!postResult || typeof postResult !== 'object' || typeof postResult.id !== 'string' || postResult.id.length === 0) {
    throw new Error('ActivityPods outbox post did not return a persisted Activity with an id');
  }
  if (typeof senderWebId !== 'string' || senderWebId.length === 0) {
    throw new Error('ActivityPods remote-origin evidence requires the genuine sender WebID');
  }

  const deliveryPlan = plannedEvent?.deliveryPlan;
  if (!validateDeliveryPlanV1(deliveryPlan)) {
    throw new Error('ActivityPods did not emit a valid authoritative ap.delivery-plan.v1');
  }

  const postActorUri = normalizeEntityId(postResult.actor);
  const eventActivityId = normalizeEntityId(plannedEvent?.activity?.id || plannedEvent?.activity?.['@id']);
  const eventActorUri = normalizeEntityId(plannedEvent?.activity?.actor);
  if (
    deliveryPlan.activityId !== postResult.id ||
    deliveryPlan.activity?.id !== postResult.id ||
    eventActivityId !== postResult.id
  ) {
    throw new Error('ActivityPods Delivery Plan event does not match the persisted outbox Activity');
  }
  if (
    deliveryPlan.actorUri !== senderWebId ||
    normalizeEntityId(deliveryPlan.activity?.actor) !== senderWebId ||
    postActorUri !== senderWebId ||
    eventActorUri !== senderWebId
  ) {
    throw new Error('ActivityPods Delivery Plan event does not match the genuine sender authority');
  }

  if (plannedEvent.deliveryMode !== 'external' || plannedEvent.durableHandoffQueued !== true) {
    throw new Error('ActivityPods did not prove external durable-handoff authority for the persisted Activity');
  }
  if (plannedEvent.suppressedNativeRemotePostCount !== 1) {
    throw new Error('Expected exactly one suppressed native remotePost job for the single controlled recipient');
  }
  if (!Array.isArray(deliveryPlan.localRecipients) || deliveryPlan.localRecipients.length !== 0) {
    throw new Error('Remote-origin fixture unexpectedly produced authoritative local recipients');
  }
  assertExactStringArray(plannedEvent.localRecipients, [], 'Emitted local recipient evidence');

  if (!Array.isArray(deliveryPlan.remoteRecipients) || deliveryPlan.remoteRecipients.length !== 1) {
    throw new Error(`Expected exactly one authoritative remote recipient, found ${deliveryPlan.remoteRecipients?.length ?? 0}`);
  }
  const target = deliveryPlan.remoteRecipients[0];
  if (target.actorUri !== remoteActorUri) {
    throw new Error(`Authoritative remote actor ${target.actorUri} does not match requested actor ${remoteActorUri}`);
  }
  assertExactStringArray(plannedEvent.remoteRecipients, [remoteActorUri], 'Emitted remote recipient evidence');

  return {
    schema: 'adsp.p0.activitypods-remote-origin.v1',
    activityId: postResult.id,
    actorUri: deliveryPlan.actorUri,
    // This is the already-sanitized Activity embedded in the authoritative
    // Delivery Plan (blind addressing has been removed by the production path).
    // Fixture B needs the exact delivered body to reconcile immutable retry SHA.
    activity: deliveryPlan.activity,
    deliveryPlanSchema: deliveryPlan.schema,
    deliveryPlanIntentId: deliveryPlan.intentId,
    remoteActorUri: target.actorUri,
    inboxUrl: target.inboxUrl,
    ...(target.sharedInboxUrl ? { sharedInboxUrl: target.sharedInboxUrl } : {}),
    targetDomain: target.targetDomain,
    suppressedNativeRemotePostCount: 1,
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
    const password = process.env.ADSP_P0_SIGNUP_PASSWORD || `${crypto.randomBytes(24).toString('base64url')}A1!`;
    const sender = await signupWithCandidateRetries({
      baseUrl,
      password,
      runId,
      role: 'sender'
    });
    await awaitActorBootstrap(broker, sender, 'outbox', readyTimeoutMs);
    senderWebIdRef.value = sender.webId;

    // Only bound the actual evidence window. Account provisioning/bootstrap is
    // intentionally outside this deadline because it may legitimately take
    // longer and must not make a healthy federation path look failed.
    latch.arm();
    const [postResult, plannedEvent] = await Promise.all([
      broker.call(
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
      ),
      // Attach the rejection handler at the same boundary as the outbox call;
      // a slow call cannot leave a timed-out evidence promise temporarily
      // unobserved and trigger an unhandled-rejection failure.
      latch.promise
    ]);

    const evidence = buildFixtureEvidence({
      postResult,
      plannedEvent,
      remoteActorUri: normalizedRemoteActorUri,
      senderWebId: sender.webId
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
  assertExactStringArray,
  buildFixtureEvidence,
  createEvidenceLatch,
  createRunnerBroker,
  runRemoteOriginFixture,
  validateRemoteActorUri
};
