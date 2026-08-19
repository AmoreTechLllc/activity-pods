'use strict';

const {
  PROOF_SCHEMA,
  positiveInteger,
  runHorizontalProvisioningProof
} = require('../scripts/adsp-p2-w3-horizontal-provisioning-proof');

describe('ADSP P2 W3 horizontal provisioning proof', () => {
  test('validates positive timing values', () => {
    expect(positiveInteger('120000', 1, 'ready timeout')).toBe(120000);
    expect(positiveInteger(undefined, 42, 'ready timeout')).toBe(42);
    for (const value of [0, -1, 1.5, 'bad']) {
      expect(() => positiveInteger(value, 1, 'ready timeout')).toThrow(/positive integer/u);
    }
  });

  test('binds signup and actor bootstrap to the exact horizontal namespace and replica count', async () => {
    const calls = [];
    const broker = {
      start: jest.fn(async () => calls.push('start')),
      stop: jest.fn(async () => calls.push('stop')),
      waitForServices: jest.fn(async (services, timeout) => calls.push(['services', services, timeout]))
    };
    const brokerFactory = jest.fn((transporterUrl, runId, namespace) => {
      calls.push(['broker', transporterUrl, runId, namespace]);
      return broker;
    });
    const waitForEndpointsFn = jest.fn(async (receivedBroker, replicas, timeout) => {
      expect(receivedBroker).toBe(broker);
      calls.push(['endpoints', replicas, timeout]);
      return replicas;
    });
    const signupFn = jest.fn(async args => {
      calls.push(['signup', args.baseUrl, args.role]);
      return {
        username: 'proofuser',
        webId: 'http://localhost:3000/proofuser'
      };
    });
    const bootstrapFn = jest.fn(async (receivedBroker, actor, predicate, timeout) => {
      expect(receivedBroker).toBe(broker);
      calls.push(['bootstrap', actor.username, predicate, timeout]);
      actor.outbox = `${actor.webId}/outbox`;
      return actor;
    });

    const result = await runHorizontalProvisioningProof({
      namespace: 'adsp-p2-w3-proof-2r',
      expectedReplicas: 2,
      baseUrl: 'http://localhost:3000',
      transporterUrl: 'redis://127.0.0.1:6379/12',
      readyTimeoutMs: 1234,
      runId: 'proof-run',
      brokerFactory,
      waitForEndpointsFn,
      signupFn,
      bootstrapFn
    });

    expect(result).toEqual({
      schema: PROOF_SCHEMA,
      ok: true,
      namespace: 'adsp-p2-w3-proof-2r',
      expectedReplicas: 2,
      observedReplicas: 2,
      username: 'proofuser',
      webId: 'http://localhost:3000/proofuser',
      outbox: 'http://localhost:3000/proofuser/outbox'
    });
    expect(broker.stop).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      ['broker', 'redis://127.0.0.1:6379/12', 'p8proofrun-provision', 'adsp-p2-w3-proof-2r'],
      'start',
      ['services', ['auth', 'activitypub.outbox', 'activitypub.actor'], 1234],
      ['endpoints', 2, 1234],
      ['signup', 'http://localhost:3000', 'sender'],
      ['bootstrap', 'proofuser', 'outbox', 1234],
      'stop'
    ]);
  });

  test('always stops the runner broker when signup fails', async () => {
    const broker = {
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
      waitForServices: jest.fn(async () => undefined)
    };

    await expect(
      runHorizontalProvisioningProof({
        namespace: 'adsp-p2-w3-proof-4r',
        expectedReplicas: 4,
        readyTimeoutMs: 100,
        runId: 'failure-run',
        brokerFactory: () => broker,
        waitForEndpointsFn: async () => 4,
        signupFn: async () => {
          throw new Error('signup failed');
        },
        bootstrapFn: async () => undefined
      })
    ).rejects.toThrow('signup failed');

    expect(broker.stop).toHaveBeenCalledTimes(1);
  });
});
