'use strict';

module.exports = {
  name: 'adsp.p1.localityProbe',

  actions: {
    inner: {
      handler(ctx) {
        return {
          servedBy: this.broker.nodeID,
          marker: ctx.params.marker
        };
      }
    },

    outer: {
      async handler(ctx) {
        const inner = await ctx.call('adsp.p1.localityProbe.inner', {
          marker: ctx.params.marker
        });

        return {
          outerServedBy: this.broker.nodeID,
          inner
        };
      }
    }
  }
};
