'use strict';

const service = require('../services/adsp-p2-redis-script-preload.service');

describe('ADSP P2 Redis script preload service', () => {
  const originalEnabled = process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS;
  const originalQueueUrl = process.env.SEMAPPS_QUEUE_SERVICE_URL;

  afterEach(() => {
    if (originalEnabled === undefined) delete process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS;
    else process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS = originalEnabled;
    if (originalQueueUrl === undefined) delete process.env.SEMAPPS_QUEUE_SERVICE_URL;
    else process.env.SEMAPPS_QUEUE_SERVICE_URL = originalQueueUrl;
  });

  test('has a stable internal service name', () => {
    expect(service.name).toBe('adspP2RedisScriptPreload');
  });

  test('is inert unless explicitly enabled', async () => {
    delete process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS;
    await expect(service.started.call({ logger: { info: jest.fn() } })).resolves.toBeUndefined();
  });

  test('fails closed when enabled without the authoritative queue Redis URL', async () => {
    process.env.SEMAPPS_ADSP_PRELOAD_BULL_REDIS_SCRIPTS = 'true';
    delete process.env.SEMAPPS_QUEUE_SERVICE_URL;
    await expect(service.started.call({ logger: { info: jest.fn() } })).rejects.toThrow(
      /requires SEMAPPS_QUEUE_SERVICE_URL/u
    );
  });
});
