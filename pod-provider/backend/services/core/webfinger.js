const { WebfingerService } = require('@semapps/webfinger');
const CONFIG = require('../../config/config');

module.exports = {
  mixins: [WebfingerService],
  created() {
    this.localWebfingerAccounts = new Map();
  },
  settings: {
    baseUrl: CONFIG.BASE_URL
  },
  actions: {
    async get(ctx) {
      const { resource } = ctx.params;
      const suffix = `@${this.settings.domainName}`;
      const username = typeof resource === 'string' && resource.startsWith('acct:') && resource.endsWith(suffix)
        ? resource.slice('acct:'.length, -suffix.length)
        : null;

      if (username && /^[\w._-]+$/u.test(username)) {
        // WebFinger is a public local-directory lookup. Do not propagate a
        // remote request principal into the settings-dataset query: signed
        // remote implementations may otherwise couple their key-discovery
        // request context to this local account lookup.
        let webId = this.localWebfingerAccounts.get(username);
        if (!webId) {
          const account = await this.broker.call('auth.account.findByUsername', { username }, { timeout: 2000 })
            .catch(() => null);
          webId = account?.webId;
          if (webId) this.localWebfingerAccounts.set(username, webId);
        }
        if (webId) {
          return {
            subject: resource,
            aliases: [webId],
            links: [{ rel: 'self', type: 'application/activity+json', href: webId }]
          };
        }
      }

      ctx.meta.$statusCode = 404;
    }
  },
  events: {
    'auth.registered'(ctx) {
      const { accountData, webId } = ctx.params || {};
      if (typeof accountData?.username === 'string' && typeof webId === 'string') {
        this.localWebfingerAccounts.set(accountData.username, webId);
      }
    }
  },
  // FEP-3B86 §3 — append Activity Intent link templates to every WebFinger
  // response without forking the upstream @semapps/webfinger action.
  hooks: {
    after: {
      async get(ctx, res) {
        if (!res || !Array.isArray(res.links)) return res;
        try {
          const intentLinks = await ctx.call('fep-3b86-activity-intents.getLinks', {});
          if (Array.isArray(intentLinks) && intentLinks.length > 0) {
            res.links.push(...intentLinks);
          }
        } catch (e) {
          // Activity Intents are advisory; WebFinger remains available if the
          // companion intent service is unavailable.
          this.logger.debug(`FEP-3B86 intent links unavailable: ${e.message}`);
        }
        return res;
      }
    }
  }
};
