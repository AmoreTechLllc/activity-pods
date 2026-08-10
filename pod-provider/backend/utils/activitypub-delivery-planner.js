'use strict';

const crypto = require('crypto');
const { DELIVERY_PLAN_SCHEMA, canonicalize, validateDeliveryPlanV1 } = require('./activitypub-delivery-plan');

const DEFAULT_TARGET_RESOLUTION_CONCURRENCY = 10;

function normalizeActorUri(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') return value.id || value['@id'] || null;
  return null;
}

function isFollowersCollectionUri(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return new URL(value).pathname.replace(/\/+$/u, '').endsWith('/followers');
  } catch {
    return false;
  }
}

function determineVisibility(activity) {
  const publicAddress = 'https://www.w3.org/ns/activitystreams#Public';
  const to = Array.isArray(activity?.to) ? activity.to : [activity?.to];
  const cc = Array.isArray(activity?.cc) ? activity.cc : [activity?.cc];

  if (to.includes(publicAddress) || to.includes('as:Public') || to.includes('Public')) return 'public';
  if (cc.includes(publicAddress) || cc.includes('as:Public') || cc.includes('Public')) return 'unlisted';
  if (to.some(value => typeof value === 'string' && value.endsWith('/followers'))) return 'followers';
  return 'direct';
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const normalizedConcurrency = Math.max(1, Math.floor(concurrency || 1));
  const output = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(normalizedConcurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

function createDeliveryIntentId({ activityId, actorUri, localRecipientUris, remoteRecipientUris }) {
  const material = canonicalize({
    schema: DELIVERY_PLAN_SCHEMA,
    activityId,
    actorUri,
    localRecipientUris: [...new Set(localRecipientUris)].sort(),
    remoteRecipientUris: [...new Set(remoteRecipientUris)].sort()
  });
  return `apdm-v1-${crypto.createHash('sha256').update(material).digest('hex')}`;
}

async function resolveLocalDeliveryTarget(ctx, actorUri, podProvider) {
  const account = await ctx.call('auth.account.findByWebId', { webId: actorUri });
  if (!account) throw new Error(`Unable to resolve local ActivityPub account for ${actorUri}`);

  const dataset = podProvider ? account.username : account.username || account.dataset;
  if (typeof dataset !== 'string' || dataset.length === 0) {
    throw new Error(`Unable to resolve local dataset for ${actorUri}`);
  }

  const inboxUri = await ctx.call(
    'activitypub.actor.getCollectionUri',
    { actorUri, predicate: 'inbox', webId: 'system' },
    { meta: { dataset } }
  );
  if (typeof inboxUri !== 'string' || inboxUri.length === 0) {
    throw new Error(`Unable to resolve local inbox for ${actorUri}`);
  }

  return { actorUri, dataset, inboxUri };
}

async function resolveRemoteDeliveryTarget(ctx, actorUri) {
  const actor = await ctx.call('activitypub.actor.get', { actorUri, webId: 'system' });
  const inboxUrl = actor && actor.inbox;
  if (typeof inboxUrl !== 'string' || inboxUrl.length === 0) {
    throw new Error(`Unable to resolve remote inbox for ${actorUri}`);
  }

  const sharedInboxUrl = actor?.endpoints?.sharedInbox;
  const deliveryUrl = typeof sharedInboxUrl === 'string' && sharedInboxUrl.length > 0 ? sharedInboxUrl : inboxUrl;
  let targetDomain;
  try {
    targetDomain = new URL(deliveryUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`Resolved invalid remote delivery URL for ${actorUri}`);
  }

  return {
    actorUri,
    inboxUrl,
    ...(typeof sharedInboxUrl === 'string' && sharedInboxUrl.length > 0 ? { sharedInboxUrl } : {}),
    targetDomain
  };
}

function assertConcreteRecipientUris(recipientUris, classification) {
  const followersCollection = recipientUris.find(isFollowersCollectionUri);
  if (followersCollection) {
    throw new Error(
      `ActivityPub Delivery Plan received unresolved ${classification} followers collection ${followersCollection}`
    );
  }
}

async function buildDeliveryPlanV1(
  ctx,
  {
    activity,
    localRecipientUris = [],
    remoteRecipientUris = [],
    podProvider = true,
    concurrency = DEFAULT_TARGET_RESOLUTION_CONCURRENCY
  }
) {
  const actorUri = normalizeActorUri(activity?.actor);
  const activityId = activity?.id || activity?.['@id'];
  if (!actorUri || typeof activityId !== 'string' || activityId.length === 0) {
    throw new Error('ActivityPub Delivery Plan requires concrete actorUri and activityId');
  }

  const uniqueLocalUris = [...new Set(localRecipientUris.filter(value => typeof value === 'string'))];
  const uniqueRemoteUris = [...new Set(remoteRecipientUris.filter(value => typeof value === 'string'))];
  assertConcreteRecipientUris(uniqueLocalUris, 'local');
  assertConcreteRecipientUris(uniqueRemoteUris, 'remote');

  const [localRecipients, remoteRecipients] = await Promise.all([
    mapWithConcurrency(uniqueLocalUris, concurrency, actor => resolveLocalDeliveryTarget(ctx, actor, podProvider)),
    mapWithConcurrency(uniqueRemoteUris, concurrency, actor => resolveRemoteDeliveryTarget(ctx, actor))
  ]);

  const visibility = determineVisibility(activity);
  const plan = {
    schema: DELIVERY_PLAN_SCHEMA,
    intentId: createDeliveryIntentId({
      activityId,
      actorUri,
      localRecipientUris: uniqueLocalUris,
      remoteRecipientUris: uniqueRemoteUris
    }),
    activityId,
    actorUri,
    activity,
    localRecipients,
    remoteRecipients,
    meta: {
      visibility,
      isPublicActivity: visibility === 'public' || visibility === 'unlisted'
    }
  };

  if (!validateDeliveryPlanV1(plan)) {
    throw new Error(`Generated invalid ${DELIVERY_PLAN_SCHEMA} payload for ${activityId}`);
  }

  return plan;
}

module.exports = {
  DEFAULT_TARGET_RESOLUTION_CONCURRENCY,
  assertConcreteRecipientUris,
  buildDeliveryPlanV1,
  createDeliveryIntentId,
  determineVisibility,
  isFollowersCollectionUri,
  mapWithConcurrency,
  normalizeActorUri,
  resolveLocalDeliveryTarget,
  resolveRemoteDeliveryTarget
};
