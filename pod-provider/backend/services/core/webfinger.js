const { WebfingerService } = require('@semapps/webfinger');
const CONFIG = require('../../config/config');

module.exports = {
  mixins: [WebfingerService],
  settings: {
    baseUrl: CONFIG.BASE_URL
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
