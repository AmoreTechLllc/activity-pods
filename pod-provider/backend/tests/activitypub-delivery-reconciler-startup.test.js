'use strict';

const service = require('../services/activitypub-delivery-reconciler.service');

test('APDM P4 reconciler fails startup when enabled without provider base URI', async () => {
  const context = {
    settings: { enabled: true, baseUri: '', intervalMs: 60000, initialDelayMs: 15000 },
    broker: { call: jest.fn() },
    logger: { error: jest.fn() }
  };

  await expect(service.started.call(context)).rejects.toThrow(/provider base URI/u);
});
