'use strict';

module.exports = {
  name: 'adsp.p1.rdfProbe',
  actions: {
    echo: {
      handler(ctx) {
        return {
          servedBy: this.broker.nodeID,
          payload: ctx.params.payload
        };
      }
    },
    fail: {
      handler() {
        const error = new Error('ADSP P1 remote probe failure');
        error.code = 'ADSP_P1_PROBE_FAILURE';
        throw error;
      }
    }
  }
};
