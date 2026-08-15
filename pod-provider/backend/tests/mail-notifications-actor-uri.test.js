jest.mock('moleculer-mail', () => ({}));
jest.mock('moleculer-bull', () => jest.fn(() => ({})));
jest.mock('@semapps/activitypub', () => ({ ActivitiesHandlerMixin: {} }));
jest.mock('@semapps/ldp', () => ({
  arrayOf: value => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]),
  isObject: value => value !== null && typeof value === 'object' && !Array.isArray(value)
}));
jest.mock('../config/transport', () => ({}));

const service = require('../services/mail-notifications');

const RECIPIENT_URI = 'https://pod.example/alice';
const EMITTER_URI = 'https://pod.example/bob';

function bindService(overrides = {}) {
  const instance = {
    settings: service.settings,
    logger: { warn: jest.fn(), info: jest.fn() },
    ...service.methods,
    ...overrides
  };
  for (const [name, fn] of Object.entries(service.methods)) {
    if (!Object.prototype.hasOwnProperty.call(overrides, name)) instance[name] = fn.bind(instance);
  }
  return instance;
}

describe('mail notification ActivityPub actor normalization', () => {
  test.each([
    [EMITTER_URI, EMITTER_URI],
    [{ id: EMITTER_URI, type: 'Person' }, EMITTER_URI],
    [{ '@id': EMITTER_URI, '@type': 'Person' }, EMITTER_URI]
  ])('resolves actor representation %# to a URI', (actor, expected) => {
    expect(service.methods.resolveActorUri(actor)).toBe(expected);
  });

  test.each([undefined, null, '', {}, { id: {} }])('fails closed for invalid actor representation %#', actor => {
    expect(() => service.methods.resolveActorUri(actor)).toThrow(
      'Notification activity actor must resolve to an ActivityPub actor URI'
    );
  });

  test('notify never forwards a dereferenced actor object to SemApps actor actions', async () => {
    const calls = [];
    const ctx = {
      params: {
        template: { title: 'Message', content: 'Hello', actions: [] },
        recipientUri: RECIPIENT_URI,
        activity: {
          id: 'https://pod.example/activities/1',
          actor: { id: EMITTER_URI, type: 'Person', name: 'Bob' },
          object: { id: 'https://pod.example/notes/1', type: 'Note', content: 'Hello' }
        }
      },
      async call(action, params) {
        calls.push({ action, params });
        if (action === 'auth.account.findByWebId') return { email: 'alice@example.test' };
        if (action === 'activitypub.actor.get' && params.actorUri === RECIPIENT_URI) {
          return { id: RECIPIENT_URI, 'schema:knowsLanguage': 'en' };
        }
        if (action === 'activitypub.actor.get' && params.actorUri === EMITTER_URI) {
          return { id: EMITTER_URI, name: 'Bob', url: 'https://pod.example/bob/profile' };
        }
        if (action === 'activitypub.actor.getProfile') return { 'vcard:given-name': 'Bob' };
        throw new Error(`Unexpected call ${action}`);
      }
    };

    const instance = bindService({
      parseTemplate: jest.fn(() => ({ title: 'Message', content: 'Hello', actions: [] })),
      queueMail: jest.fn(async (_ctx, title, payload) => ({ title, payload }))
    });

    await service.actions.notify.call(instance, ctx);

    expect(calls).toContainEqual({
      action: 'activitypub.actor.get',
      params: { actorUri: EMITTER_URI, webId: RECIPIENT_URI }
    });
    expect(calls).toContainEqual({
      action: 'activitypub.actor.getProfile',
      params: { actorUri: EMITTER_URI, webId: RECIPIENT_URI }
    });
    expect(calls.some(call => call.params?.actorUri && typeof call.params.actorUri === 'object')).toBe(false);
  });
});
