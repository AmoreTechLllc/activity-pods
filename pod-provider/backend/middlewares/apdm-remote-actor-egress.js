'use strict';

const { fetchRemoteActivityPubActor } = require('../utils/activitypub-remote-actor-fetch');

function ApdmRemoteActorEgressMiddleware({ enabled = false, fetchRemoteActor = fetchRemoteActivityPubActor } = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('APDM remote actor egress middleware enabled flag must be boolean');
  if (typeof fetchRemoteActor !== 'function') throw new TypeError('APDM remote actor fetcher must be a function');

  return {
    name: 'ApdmRemoteActorEgressMiddleware',

    localAction(next, action) {
      if (!enabled || action?.name !== 'activitypub.actor.get') return next;

      return async function apdmSecureRemoteActorGet(ctx) {
        const actorUri = ctx?.params?.actorUri;
        if (typeof actorUri !== 'string' || actorUri.length === 0 || actorUri !== actorUri.trim()) {
          throw new Error('APDM remote actor discovery requires an exact actor URI');
        }

        // Preserve SemApps local-actor semantics exactly. In SemApps 1.1.4 an
        // actor is treated as local only when a dataset is present and
        // ldp.remote.isRemote says the resource is not remote. Everything else
        // enters the remote node-fetch branch; APDM replaces only that branch.
        if (ctx.meta?.dataset) {
          const isRemote = await ctx.call('ldp.remote.isRemote', { resourceUri: actorUri });
          if (!isRemote) return next(ctx);
        }

        return fetchRemoteActor(actorUri);
      };
    }
  };
}

module.exports = ApdmRemoteActorEgressMiddleware;
