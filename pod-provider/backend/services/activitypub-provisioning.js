const { MoleculerError } = require('moleculer').Errors;

module.exports = {
  name: 'activitypub-provisioning',
  dependencies: ['activitypub', 'auth.account'],
  actions: {
    provisionForAccount: {
      params: {
        canonicalAccountId: 'string|min:1',
        webId: 'string|min:1',
        username: 'string|min:1',
        profile: { type: 'object', optional: true }
      },
      async handler(ctx) {
        const { canonicalAccountId, webId, username } = ctx.params;

        if (canonicalAccountId !== webId) {
          throw new MoleculerError(
            'Current provisioning path requires canonicalAccountId to equal webId',
            400,
            'CANONICAL_ACCOUNT_ID_WEBID_MISMATCH'
          );
        }

        // In SemApps pod-provider mode, activitypub.actor.get treats an actor as
        // remote whenever ctx.meta.dataset is absent. That is unsafe as a
        // provisioning barrier in a horizontal Pod cell: the actor is local and
        // its authoritative dataset belongs to the local account. Resolve that
        // binding from auth.account rather than trusting caller-supplied routing
        // metadata, then make the local dataset explicit for the whole wait.
        const account = await ctx.call('auth.account.findByWebId', { webId });
        const dataset = account?.username;
        if (typeof dataset !== 'string' || dataset.length === 0) {
          throw new MoleculerError(
            `Unable to resolve the local dataset for ActivityPub actor ${webId}`,
            500,
            'ACTIVITYPUB_PROVISIONING_DATASET_UNAVAILABLE'
          );
        }
        if (dataset !== username) {
          throw new MoleculerError(
            `ActivityPub provisioning account/dataset mismatch for ${webId}`,
            409,
            'ACTIVITYPUB_PROVISIONING_DATASET_MISMATCH'
          );
        }

        const actor = await ctx.call(
          'activitypub.actor.awaitCreateComplete',
          {
            actorUri: webId,
            additionalKeys: ['preferredUsername', 'inbox', 'outbox', 'followers', 'following']
          },
          { meta: { dataset } }
        );

        if (!actor?.id || !actor?.inbox || !actor?.outbox) {
          throw new MoleculerError('ActivityPub actor provisioning is incomplete', 500, 'ACTIVITYPUB_PROVISIONING_FAILED');
        }

        const preferredUsername = actor.preferredUsername || username;
        const hostname = new URL(actor.id).hostname;

        return {
          actorId: actor.id,
          handle: `@${preferredUsername}@${hostname}`,
          inbox: actor.inbox,
          outbox: actor.outbox,
          followers: actor.followers || null,
          following: actor.following || null
        };
      }
    }
  }
};
