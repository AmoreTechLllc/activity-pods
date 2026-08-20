'use strict';

const DELIVERY_HANDOFF_QUEUE = 'deliveryHandoff';
const DELIVERY_HANDOFF_JOB_NAME = 'apdm-delivery-handoff-v1';

const DELIVERY_HANDOFF_QUEUE_OPTIONS =
  process.env.NODE_ENV === 'test'
    ? {}
    : {
        removeOnComplete: { age: 259200 },
        attempts: 12,
        backoff: { type: 'exponential', delay: 30000 }
      };

function parseConfiguredHandoffUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('#')) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

function assertExternalHandoffAuthority(settings) {
  const mode = String(settings?.remoteDeliveryMode || 'native').trim().toLowerCase();
  if (mode !== 'external') {
    throw new Error('APDM durable sidecar handoff requires external remote delivery authority');
  }
}

function assertDurableHandoffConfigured(settings) {
  assertExternalHandoffAuthority(settings);
  if (!settings || typeof settings.queueServiceUrl !== 'string' || settings.queueServiceUrl.trim().length === 0) {
    throw new Error('APDM external delivery requires SEMAPPS_QUEUE_SERVICE_URL for durable handoff');
  }
  if (!parseConfiguredHandoffUrl(settings.deliveryHandoffUrl)) {
    throw new Error(
      'APDM sidecar durable outbox handoff URL must be an exact credential-free HTTP(S) URL without fragments or whitespace padding'
    );
  }
  if (
    typeof settings.deliveryHandoffToken !== 'string' ||
    settings.deliveryHandoffToken.length === 0 ||
    settings.deliveryHandoffToken !== settings.deliveryHandoffToken.trim()
  ) {
    throw new Error('APDM external delivery requires a nonblank unpadded SIDECAR_TOKEN for authenticated durable handoff');
  }
  if (
    !Number.isInteger(settings.deliveryHandoffTimeoutMs) ||
    settings.deliveryHandoffTimeoutMs < 100 ||
    settings.deliveryHandoffTimeoutMs > 60000
  ) {
    throw new Error('APDM durable handoff timeout must be an integer between 100 and 60000 milliseconds');
  }
}

function toSidecarOutboxPayload(deliveryPlan) {
  const apdmAuthority = {
    schema: deliveryPlan.schema,
    intentId: deliveryPlan.intentId
  };

  return {
    actorUri: deliveryPlan.actorUri,
    activityId: deliveryPlan.activityId,
    activity: deliveryPlan.activity,
    remoteTargets: deliveryPlan.remoteRecipients.map(target => ({
      inboxUrl: target.inboxUrl,
      ...(target.sharedInboxUrl ? { sharedInboxUrl: target.sharedInboxUrl } : {}),
      targetDomain: target.targetDomain,
      // Phase 6 wire proof: the sidecar target normalizer rejects legacy raw
      // routing submissions that do not carry one consistent Delivery Plan
      // authority marker across every target. This is transport metadata only;
      // it is not added to ap.delivery-plan.v1 itself.
      apdmAuthority
    })),
    meta: {
      ...deliveryPlan.meta,
      deliveryPlanIntentId: deliveryPlan.intentId,
      deliveryPlanSchema: deliveryPlan.schema
    }
  };
}

async function enqueueDeliveryHandoff(service, deliveryPlan) {
  assertDurableHandoffConfigured(service.settings);
  if (!deliveryPlan || typeof deliveryPlan.intentId !== 'string' || deliveryPlan.intentId.length === 0) {
    throw new Error('Durable ActivityPub handoff requires a Delivery Plan intentId');
  }

  // moleculer-bull createJob(queue, name, data, opts) passes the second
  // argument to Bull as the job *name*. Dedupe/uniqueness is controlled by
  // opts.jobId, so the deterministic Delivery Plan ID must live there.
  const options = {
    ...DELIVERY_HANDOFF_QUEUE_OPTIONS,
    jobId: deliveryPlan.intentId
  };
  const result = service.createJob(
    DELIVERY_HANDOFF_QUEUE,
    DELIVERY_HANDOFF_JOB_NAME,
    { deliveryPlan },
    options
  );
  await Promise.resolve(result);
  return deliveryPlan.intentId;
}

async function processDeliveryHandoffJob(service, job, fetchImpl = fetch) {
  // Recheck the authority on every execution, not only when the job was
  // created. A one-switch rollback to native must stop stale external queue
  // entries from producing sidecar federation while SemApps native delivery is
  // authoritative.
  assertDurableHandoffConfigured(service.settings);
  const deliveryPlan = job?.data?.deliveryPlan;
  const intentId = deliveryPlan?.intentId;
  if (typeof intentId !== 'string' || intentId.length === 0) {
    throw new Error('Delivery handoff job is missing deliveryPlan.intentId');
  }

  const response = await fetchImpl(service.settings.deliveryHandoffUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${service.settings.deliveryHandoffToken}`,
      'X-APDM-Intent-Id': intentId
    },
    body: JSON.stringify(toSidecarOutboxPayload(deliveryPlan)),
    signal: AbortSignal.timeout(service.settings.deliveryHandoffTimeoutMs)
  });

  if (response.status !== 202) {
    throw new Error(`Sidecar durable outbox handoff returned ${response.status}; expected durable 202 acceptance`);
  }

  let acknowledgement;
  try {
    acknowledgement = await response.json();
  } catch {
    throw new Error('Sidecar durable outbox handoff returned an invalid acknowledgement body');
  }

  if (!acknowledgement || acknowledgement.accepted !== true || typeof acknowledgement.intentId !== 'string') {
    throw new Error('Sidecar durable outbox handoff acknowledgement did not confirm Redis acceptance');
  }
  if (acknowledgement.intentId !== intentId) {
    throw new Error('Sidecar durable outbox handoff acknowledgement intentId does not match the Delivery Plan intentId');
  }

  if (typeof job.progress === 'function') job.progress(100);
  return {
    status: 'accepted',
    deliveryPlanIntentId: intentId,
    sidecarIntentId: acknowledgement.intentId,
    jobCount: acknowledgement.jobCount
  };
}

module.exports = {
  DELIVERY_HANDOFF_JOB_NAME,
  DELIVERY_HANDOFF_QUEUE,
  DELIVERY_HANDOFF_QUEUE_OPTIONS,
  assertDurableHandoffConfigured,
  assertExternalHandoffAuthority,
  enqueueDeliveryHandoff,
  parseConfiguredHandoffUrl,
  processDeliveryHandoffJob,
  toSidecarOutboxPayload
};
