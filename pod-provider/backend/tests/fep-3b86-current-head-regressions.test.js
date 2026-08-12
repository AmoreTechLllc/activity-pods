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
  test('keeps public intent aliases relative and follow resolution on a separate authenticated route', async () => {
    const svc = createInstance();

    await serviceDefinition.started.call(svc);

    expect(svc.broker.call).toHaveBeenCalledTimes(2);
    const [, publicPayload] = svc.broker.call.mock.calls[0];
    expect(publicPayload.route.path).toBe('/intents');
    expect(publicPayload.route.authentication).toBeUndefined();
    expect(publicPayload.route.aliases).toEqual({
      'GET /follow': 'fep-3b86-activity-intents.handleFollow',
      'GET /announce': 'fep-3b86-activity-intents.handleAnnounce',
      'GET /create': 'fep-3b86-activity-intents.handleCreate',
      'GET /object': 'fep-3b86-activity-intents.handleObject'
    });
    expect(Object.keys(publicPayload.route.aliases).some(alias => alias.startsWith('GET /intents/'))).toBe(false);
    expect(publicPayload.route.aliases['GET /like']).toBeUndefined();
    expect(publicPayload.route.aliases['GET /flag']).toBeUndefined();
    expect(publicPayload.route.aliases['GET /block']).toBeUndefined();

    const [, resolverPayload] = svc.broker.call.mock.calls[1];
    expect(resolverPayload.route).toMatchObject({
      path: '/api/intents',
      authentication: true,
      authorization: true,
      aliases: {
        'GET /follow/resolve': 'fep-3b86-activity-intents.resolveFollowTarget'
      }
    });
  });

  test('resolves a followable object to its delivery actor without posting an Activity', async () => {
    const svc = createInstance();
    svc.broker.call.mockResolvedValue({
      success: true,
      objectId: 'https://remote.example/notes/1',
      recipientUri: 'https://remote.example/users/bob',
      inboxUri: 'https://remote.example/users/bob/inbox'
    });
    const ctx = {
      params: { object: 'https://remote.example/notes/1' },
      meta: { webId: 'https://pod.example/alice' },
      call: svc.broker.call
    };

    await expect(serviceDefinition.actions.resolveFollowTarget.handler.call(svc, ctx)).resolves.toEqual({
      object: 'https://remote.example/notes/1',
      recipient: 'https://remote.example/users/bob'
    });
    expect(svc.broker.call).toHaveBeenCalledTimes(1);
    expect(svc.broker.call).toHaveBeenCalledWith('followable.resolveTarget', {
      objectUri: 'https://remote.example/notes/1',
      webId: 'https://pod.example/alice',
      requireFollowersCollection: false
    });
    expect(svc.broker.call).not.toHaveBeenCalledWith('followable.followObject', expect.anything());
    expect(svc.broker.call).not.toHaveBeenCalledWith('activitypub.outbox.post', expect.anything());
  });

  test('fails closed when followable resolution does not produce an actor URI', async () => {
    const svc = createInstance();
    svc.broker.call.mockResolvedValue({ success: true, recipientUri: null });
    const ctx = {
      params: { object: 'https://remote.example/notes/1' },
      meta: { webId: 'https://pod.example/alice' },
      call: svc.broker.call
    };

    await expect(serviceDefinition.actions.resolveFollowTarget.handler.call(svc, ctx)).resolves.toEqual({
      error: 'Follow target could not be resolved to a deliverable actor'
    });
    expect(ctx.meta.$statusCode).toBe(422);
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

  test('treats empty expanded optional Create URL values as absent and drops unsupported thread fields', () => {
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
