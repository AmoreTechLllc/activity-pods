'use strict';

const { enqueueDeliveryHandoff } = require('../utils/activitypub-delivery-handoff');
const { resolvePublicSearchConsent } = require('../utils/search-consent');

function activityObject(deliveryPlan) {
  const activity = deliveryPlan?.activity;
  return activity?.object && typeof activity.object === 'object' && !Array.isArray(activity.object)
    ? activity.object
    : activity;
}

async function enrichDeliveryPlanObservation(service, deliveryPlan) {
  if (!deliveryPlan?.meta || typeof deliveryPlan.meta !== 'object' || Array.isArray(deliveryPlan.meta)) {
    throw new Error('Phase 5 durable observation requires Delivery Plan metadata');
  }

  let attributedToActor = null;
  if (typeof service?.broker?.call === 'function') {
    try {
      attributedToActor = await service.broker.call('activitypub.actor.get', {
        actorUri: deliveryPlan.actorUri,
        webId: 'system'
      });
    } catch (error) {
      service.logger?.warn?.('Failed to resolve actor search consent for durable ActivityPub handoff', {
        actorUri: deliveryPlan.actorUri,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const searchConsent = resolvePublicSearchConsent(activityObject(deliveryPlan), { attributedToActor });
  deliveryPlan.meta = {
    ...deliveryPlan.meta,
    isPublicIndexable: deliveryPlan.meta.isPublicActivity === true && searchConsent.isPublic,
    searchConsent
  };
  return deliveryPlan;
}

async function enqueueDeliveryHandoffWithObservation(service, deliveryPlan) {
  await enrichDeliveryPlanObservation(service, deliveryPlan);
  return enqueueDeliveryHandoff(service, deliveryPlan);
}

module.exports = {
  activityObject,
  enrichDeliveryPlanObservation,
  enqueueDeliveryHandoffWithObservation
};
