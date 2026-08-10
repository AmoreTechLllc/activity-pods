'use strict';

const DELIVERY_HANDOFF_QUEUE = 'deliveryHandoff';

const DELIVERY_HANDOFF_QUEUE_OPTIONS =
  process.env.NODE_ENV === 'test'
    ? {}
    : {
        removeOnComplete: { age: 259200 },
        attempts: 12,
        backoff: { type: 'exponential', delay: 30000 }
      };

function assertDurableHandoffConfigured(settings) {
  if (!settings || typeof settings.queueServiceUrl !== 'string' || settings.queueServiceUrl.trim().length === 0) {
    throw new Error('APDM external delivery requires SEMAPPS_QUEUE_SERVICE_URL for durable handoff');
  }
  if (typeof settings.deliveryHandoffUrl !== 'string' || settings.deliveryHandoffUrl.trim().length === 0) {
    throw new Error('APDM external delivery requires a sidecar durable outbox handoff URL');
  }
  let url;
  try {
    url = new URL(settings.deliveryHandoffUrl);
  } catch {
    throw new Error('APDM sidecar durable outbox handoff URL must be valid HTTP(S)');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('APDM sidecar durable outbox handoff URL must be valid HTTP(S)');
  }
  if (typeof settings.deliveryHandoffToken !== 'string' || settings.deliveryHandoffToken.length === 0) {
    throw new Error('APDM external delivery requires SIDECAR_TOKEN for authenticated durable handoff');
  }
}

function toSidecarOutboxPayload(deliveryPlan) {
  return {
    actorUri: deliveryPlan.actorUri,
    activityId: deliveryPlan.activityId,
    activity: deliveryPlan.activity,
    remoteTargets: deliveryPlan.remoteRecipients.map(target => ({
      inboxUrl: target.inboxUrl,
      ...(target.sharedInboxUrl ? { sharedInboxUrl: target.sharedInboxUrl } : {}),
      targetDomain: target.targetDomain
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

  const result = service.createJob(
    DELIVERY_HANDOFF_QUEUE,
    deliveryPlan.intentId,
    { deliveryPlan },
    DELIVERY_HANDOFF_QUEUE_OPTIONS
  );
  await Promise.resolve(result);
  return deliveryPlan.intentId;
}

async function processDeliveryHandoffJob(service, job, fetchImpl = fetch) {
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
    signal: AbortSignal.timeout(service.settings.deliveryHandoffTimeoutMs || 5000)
  });

  // /webhook/outbox uses 202 specifically after its Redis Streams XADD succeeds.
  // Any other status is not proof that the durable sidecar acceptance boundary was crossed.
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

  if (typeof job.progress === 'function') job.progress(100);
  return {
    status: 'accepted',
    deliveryPlanIntentId: intentId,
    sidecarIntentId: acknowledgement.intentId,
    jobCount: acknowledgement.jobCount
  };
}

module.exports = {
  DELIVERY_HANDOFF_QUEUE,
  DELIVERY_HANDOFF_QUEUE_OPTIONS,
  assertDurableHandoffConfigured,
  enqueueDeliveryHandoff,
  processDeliveryHandoffJob,
  toSidecarOutboxPayload
};