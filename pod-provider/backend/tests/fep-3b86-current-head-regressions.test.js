'use strict';

jest.mock('../config/config', () => ({
  BASE_URL: 'https://pod.example',
  FRONTEND_URL: 'https://app.example'
}));

const serviceDefinition = require('../services/core/fep-3b86-activity-intents');

function createInstance() {
  return {
    settings: {
      baseUrl: 'https://pod.example',
      frontendUrl: 'https://app.example',
      intents: serviceDefinition.INTENT_DEFINITIONS
    },
    broker: { call: jest.fn().mockResolvedValue(undefined) },
    ...serviceDefinition.methods
  };
}

describe('FEP-3B86 current-head review regressions', () => {
  test('registers aliases relative to the /intents route prefix', async () => {
    const svc = createInstance();

    await serviceDefinition.started.call(svc);

    expect(svc.broker.call).toHaveBeenCalledTimes(1);
    const [, payload] = svc.broker.call.mock.calls[0];
    expect(payload.route.path).toBe('/intents');
    expect(payload.route.aliases).toEqual(
      expect.objectContaining({
        'GET /follow': 'fep-3b86-activity-intents.handleFollow',
        'GET /like': 'fep-3b86-activity-intents.handleLike',
        'GET /create': 'fep-3b86-activity-intents.handleCreate'
      })
    );
    expect(Object.keys(payload.route.aliases).some(alias => alias.startsWith('GET /intents/'))).toBe(false);
  });

  test('treats empty expanded optional workflow values as absent', () => {
    const svc = createInstance();
    const intent = serviceDefinition.INTENT_DEFINITIONS.find(definition => definition.type === 'Follow');
    const sanitized = svc.sanitizeParams(
      {
        object: 'https://remote.example/users/bob',
        'on-success': '',
        'on-cancel': ''
      },
      intent
    );

    expect(sanitized).toEqual({ object: 'https://remote.example/users/bob' });
    expect(svc.validateParams(sanitized, intent)).toEqual({ ok: true });
  });

  test('treats empty expanded optional Create URL values as absent', () => {
    const svc = createInstance();
    const intent = serviceDefinition.INTENT_DEFINITIONS.find(definition => definition.type === 'Create');
    const sanitized = svc.sanitizeParams(
      {
        content: 'hello',
        inReplyTo: '',
        attachment: '',
        describes: '',
        audience: '',
        context: ''
      },
      intent
    );

    expect(sanitized).toEqual({ content: 'hello' });
    expect(svc.validateParams(sanitized, intent)).toEqual({ ok: true });
  });

  test('still rejects an empty required object after sanitization', () => {
    const svc = createInstance();
    const intent = serviceDefinition.INTENT_DEFINITIONS.find(definition => definition.type === 'Follow');
    const sanitized = svc.sanitizeParams({ object: '', 'on-success': '' }, intent);

    expect(sanitized).toEqual({});
    expect(svc.validateParams(sanitized, intent)).toMatchObject({
      ok: false,
      error: 'Missing required parameter "object"'
    });
  });
});
