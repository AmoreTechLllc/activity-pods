'use strict';

describe('APDM Phase 5 durable handoff configuration', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    jest.resetModules();
  });

  test('legacy sidecar origin cannot override the durable acceptance endpoint', () => {
    process.env.SIDECAR_WEBHOOK_URL = 'http://legacy-sidecar:8080';
    delete process.env.SIDECAR_DELIVERY_HANDOFF_URL;
    jest.resetModules();

    const config = require('../config/config');
    expect(config.ACTIVITYPUB_DELIVERY_HANDOFF_URL).toBe('http://fedify-sidecar:8080/webhook/outbox');
  });

  test('explicit durable handoff URL overrides the APDM default and legacy origin', () => {
    process.env.SIDECAR_WEBHOOK_URL = 'http://legacy-sidecar:8080';
    process.env.SIDECAR_DELIVERY_HANDOFF_URL = 'http://handoff-sidecar:9080/custom/outbox';
    jest.resetModules();

    const config = require('../config/config');
    expect(config.ACTIVITYPUB_DELIVERY_HANDOFF_URL).toBe('http://handoff-sidecar:9080/custom/outbox');
  });
});
