'use strict';

const AdspLocalOntologyRegistrationMiddleware = require('../middlewares/adsp-local-ontology-registration');
const {
  baselinePrefixes,
  isLocalOntologyBaselineReady
} = require('../middlewares/adsp-local-ontology-registration');

function createService({ configured = ['rdfs', 'semapps'], present = ['rdfs', 'semapps'], register } = {}) {
  return {
    settings: { ontologies: configured.map(prefix => ({ prefix })) },
    ontologies: Object.fromEntries(present.map(prefix => [prefix, { prefix }])),
    actions: { register: register || jest.fn(async params => params) }
  };
}

function wireMiddleware(options, broker, next = jest.fn()) {
  const middleware = AdspLocalOntologyRegistrationMiddleware(options);
  middleware.created(broker);
  return { middleware, wrapped: middleware.call(next), next };
}

describe('ADSP distributed local ontology registration middleware', () => {
  test('is absent when disabled', () => {
    expect(AdspLocalOntologyRegistrationMiddleware({ enabled: false })).toBeNull();
  });

  test('recognizes readiness only after every configured baseline ontology exists', () => {
    const incomplete = createService({ present: ['rdfs'] });
    const ready = createService();
    expect(baselinePrefixes(ready)).toEqual(['rdfs', 'semapps']);
    expect(isLocalOntologyBaselineReady(incomplete)).toBe(false);
    expect(isLocalOntologyBaselineReady(ready)).toBe(true);
  });

  test('captures the broker through the documented middleware lifecycle', async () => {
    const next = jest.fn(async (...args) => args);
    const broker = { getLocalService: jest.fn() };
    const { wrapped } = wireMiddleware({ enabled: true }, broker, next);

    await expect(wrapped('activitypub.outbox.post', { value: 1 }, { timeout: 50 })).resolves.toEqual([
      'activitypub.outbox.post',
      { value: 1 },
      { timeout: 50 }
    ]);
    expect(broker.getLocalService).not.toHaveBeenCalled();
  });

  test('fails closed if an ontology mutation somehow runs before broker creation', async () => {
    const middleware = AdspLocalOntologyRegistrationMiddleware({ enabled: true });
    const wrapped = middleware.call(jest.fn());
    await expect(wrapped('ontologies.register', { prefix: 'as' })).rejects.toThrow(
      /middleware broker is not initialized/u
    );
  });

  test('rejects an invalid broker at middleware creation', () => {
    const middleware = AdspLocalOntologyRegistrationMiddleware({ enabled: true });
    expect(() => middleware.created({})).toThrow(/requires a Moleculer broker/u);
  });

  test('routes ontology registration directly to the ready local service', async () => {
    const register = jest.fn(async (params, opts) => ({ params, opts }));
    const service = createService({ register });
    const next = jest.fn();
    const broker = { getLocalService: jest.fn(() => service) };
    const { wrapped } = wireMiddleware({ enabled: true }, broker, next);

    const result = await wrapped(
      'ontologies.register',
      { prefix: 'as', namespace: 'https://www.w3.org/ns/activitystreams#' },
      { nodeID: 'remote-cell', timeout: 1000, meta: { source: 'startup' } }
    );

    expect(next).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0][1]).toEqual({ timeout: 1000, meta: { source: 'startup' } });
    expect(result.params.prefix).toBe('as');
  });

  test('waits for the local baseline instead of registering into a pre-start registry', async () => {
    const register = jest.fn(async params => params);
    const service = createService({ present: [], register });
    const broker = { getLocalService: jest.fn(() => service) };
    const { wrapped } = wireMiddleware({ enabled: true, timeoutMs: 200, pollMs: 1 }, broker);

    setTimeout(() => {
      service.ontologies.rdfs = { prefix: 'rdfs' };
      service.ontologies.semapps = { prefix: 'semapps' };
    }, 5);

    await expect(wrapped('ontologies.register', { prefix: 'as' })).resolves.toEqual({ prefix: 'as' });
    expect(register).toHaveBeenCalledTimes(1);
  });

  test('fails closed when the local baseline never becomes ready', async () => {
    const service = createService({ present: [] });
    const broker = { getLocalService: jest.fn(() => service) };
    const { wrapped } = wireMiddleware({ enabled: true, timeoutMs: 5, pollMs: 1 }, broker);

    await expect(wrapped('ontologies.register', { prefix: 'as' })).rejects.toThrow(
      /Local ontologies baseline did not become ready/u
    );
  });
});
