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
  if (!settings || typeof settings.queueServiceUrl !== 'string' || settings.queueServiceUrl.length === 0) {
    throw new Error('APDM external delivery requires SEMAPPS_QUEUE_SERVICE_URL for durable handoff');
  }
  if (typeof settings.deliveryHandoffUrl !== 'string' || settings.deliveryHandoffUrl.length === 0) {
    throw new Error('APDM external delivery requires a sidecar Delivery Plan handoff URL');
  }
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

  const headers = {
    'Content-Type': 'application/json',
    'X-APDM-Intent-Id': intentId
  };
  if (service.settings.deliveryHandoffToken) {
    headers.Authorization = `Bearer ${service.settings.deliveryHandoffToken}`;
  }

  const response = await fetchImpl(service.settings.deliveryHandoffUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deliveryPlan }),
    signal: AbortSignal.timeout(service.settings.deliveryHandoffTimeoutMs || 5000)
  });

  if (!response.ok) {
    throw new Error(`Sidecar Delivery Plan handoff returned ${response.status}`);
  }

  let acknowledgement;
  try {
    acknowledgement = await response.json();
  } catch {
    throw new Error('Sidecar Delivery Plan handoff returned an invalid acknowledgement body');
  }

  if (
    !acknowledgement ||
    acknowledgement.intentId !== intentId ||
    (acknowledgement.status !== 'accepted' && acknowledgement.status !== 'duplicate')
  ) {
    throw new Error('Sidecar Delivery Plan handoff acknowledgement did not confirm durable acceptance');
  }

  if (typeof job.progress === 'function') job.progress(100);
  return acknowledgement;
}

module.exports = {
  DELIVERY_HANDOFF_QUEUE,
  DELIVERY_HANDOFF_QUEUE_OPTIONS,
  assertDurableHandoffConfigured,
  enqueueDeliveryHandoff,
  processDeliveryHandoffJob
};
