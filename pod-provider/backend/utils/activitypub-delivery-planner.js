'use strict';

const {
  DELIVERY_PLAN_SCHEMA,
  computeDeliveryPlanIntentId,
  validateDeliveryPlanV1
} = require('./activitypub-delivery-plan');

const DEFAULT_TARGET_RESOLUTION_CONCURRENCY = 10;

function normalizeActorUri(value) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') return value.id || value['@id'] || null;
  return null;
}

function normalizeAddress(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) return value.id || value['@id'] || null;
  return null;
}

function addressValues(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.map(normalizeAddress).filter(item => typeof item === 'string');
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
  const publicAddresses = new Set([
    'https://www.w3.org/ns/activitystreams#Public',
    'as:Public',
    'Public'
  ]);
  const to = addressValues(activity?.to);
  const cc = addressValues(activity?.cc);

  if (to.some(value => publicAddresses.has(value))) return 'public';
  if (cc.some(value => publicAddresses.has(value))) return 'unlisted';
  if (to.some(isFollowersCollectionUri)) return 'followers';
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
  return computeDeliveryPlanIntentId({ activityId, actorUri, localRecipientUris, remoteRecipientUris });
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

function parseRemoteDeliveryUrl(value, actorUri, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Unable to resolve remote ${label} for ${actorUri}`);
  }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('unsafe protocol or credentials');
    }
    return parsed;
  } catch {
    throw new Error(`Resolved invalid remote ${label} URL for ${actorUri}`);
  }
}

async function resolveRemoteDeliveryTarget(ctx, actorUri) {
  const actor = await ctx.call('activitypub.actor.get', { actorUri, webId: 'system' });
  const inboxUrl = actor && actor.inbox;
  const inbox = parseRemoteDeliveryUrl(inboxUrl, actorUri, 'inbox');

  const rawSharedInboxUrl = actor?.endpoints?.sharedInbox;
  let sharedInboxUrl;
  let deliveryUrl = inbox;
  if (rawSharedInboxUrl !== undefined && rawSharedInboxUrl !== null && rawSharedInboxUrl !== '') {
    const sharedInbox = parseRemoteDeliveryUrl(rawSharedInboxUrl, actorUri, 'shared inbox');
    sharedInboxUrl = sharedInbox.toString();
    deliveryUrl = sharedInbox;
  }

  return {
    actorUri,
    inboxUrl: inbox.toString(),
    ...(sharedInboxUrl ? { sharedInboxUrl } : {}),
    targetDomain: deliveryUrl.hostname.toLowerCase()
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

  const localSet = new Set(uniqueLocalUris);
  const overlappingRecipient = uniqueRemoteUris.find(uri => localSet.has(uri));
  if (overlappingRecipient) {
    throw new Error(`ActivityPub Delivery Plan recipient cannot be both local and remote: ${overlappingRecipient}`);
  }

  const taggedTargets = [
    ...uniqueLocalUris.map(actor => ({ classification: 'local', actor })),
    ...uniqueRemoteUris.map(actor => ({ classification: 'remote', actor }))
  ];
  const resolvedTargets = await mapWithConcurrency(taggedTargets, concurrency, async target => ({
    classification: target.classification,
    value: target.classification === 'local'
      ? await resolveLocalDeliveryTarget(ctx, target.actor, podProvider)
      : await resolveRemoteDeliveryTarget(ctx, target.actor)
  }));
  const localRecipients = resolvedTargets
    .filter(target => target.classification === 'local')
    .map(target => target.value);
  const remoteRecipients = resolvedTargets
    .filter(target => target.classification === 'remote')
    .map(target => target.value);

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
  addressValues,
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
