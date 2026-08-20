'use strict';

const { preloadBullScripts } = require('../scripts/adsp-p2-preload-bull-scripts');

module.exports = {
  name: 'adspP2RedisScriptPreload',

  async started() {
    if (process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS !== 'true') return;

    const redisUrl = process.env.SEMAPPS_QUEUE_SERVICE_URL;
    if (!redisUrl) {
      throw new Error('SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS requires SEMAPPS_QUEUE_SERVICE_URL');
    }

    const result = await preloadBullScripts({ redisUrl });
    if (!Number.isInteger(result.scriptCount) || result.scriptCount <= 0) {
      throw new Error('ADSP P2 Bull Redis script preload completed without loading any scripts');
    }

    this.logger.info(`ADSP P2 preloaded ${result.scriptCount} Bull Redis scripts before service advertisement`);
  }
};