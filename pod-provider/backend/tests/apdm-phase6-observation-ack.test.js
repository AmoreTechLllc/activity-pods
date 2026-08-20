'use strict';

const emitterSchema = require('../services/outbox-emitter.service');

function service(overrides = {}) {
  return {
    settings: {
      ...emitterSchema.settings,
      remoteDeliveryMode: 'native',
      sidecarObservationWebhookUrl: 'http://fedify-sidecar:8080/webhook/outbox-observation',
      sidecarToken: 'secret',
      observationWebhookRetries: 1,
      observationWebhookTimeoutMs: 1000,
      ...overrides
    },
    logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    deliverObservationToSidecar: emitterSchema.methods.deliverObservationToSidecar
  };
}

function event() {
  return {
    schema: 'ap.outbox.committed.v1',
    eventId: '01JOBSERVATION00000000000001',
    actorUri: 'https://pods.example/alice',
    activityId: 'https://pods.example/alice/activities/1',
    activity: {
      id: 'https://pods.example/alice/activities/1',
      type: 'Create',
      actor: 'https://pods.example/alice'
    },
    meta: { isPublicActivity: true, isPublicIndexable: false }
  };
}

describe('APDM Phase 6 native durable observation acknowledgement', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('accepts only the exact durable zero-target observation identity', async () => {
    const current = event();
    global.fetch = jest.fn(async () => ({
      status: 202,
      async json() {
        return {
          accepted: true,
          intentId: `apdm-observation:${current.eventId}`,
          jobCount: 0,
          observationOnly: true
        };
      }
    }));
    const instance = service();

    await instance.deliverObservationToSidecar.call(instance, current);

    expect(instance.logger.error).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, request] = global.fetch.mock.calls[0];
    expect(request.headers.Authorization).toBe('Bearer secret');
    expect(request.headers['X-Event-Id']).toBe(current.eventId);
    expect(request.headers['X-Event-Schema']).toBe(current.schema);
    const payload = JSON.parse(request.body);
    expect(payload).not.toHaveProperty('remoteTargets');
    expect(payload).not.toHaveProperty('deliveryTargets');
  });

  test.each([
    {
      name: 'generic 200',
      response: { status: 200, body: { accepted: true, intentId: 'ignored', jobCount: 0, observationOnly: true } }
    },
    {
      name: 'wrong intent',
      response: { status: 202, body: { accepted: true, intentId: 'apdm-observation:wrong', jobCount: 0, observationOnly: true } }
    },
    {
      name: 'nonzero fanout',
      response: { status: 202, body: { accepted: true, intentId: 'expected', jobCount: 1, observationOnly: true } }
    },
    {
      name: 'not observation-only',
      response: { status: 202, body: { accepted: true, intentId: 'expected', jobCount: 0, observationOnly: false } }
    }
  ])('does not treat $name as durable observation success', async ({ response }) => {
    const current = event();
    const expected = `apdm-observation:${current.eventId}`;
    const body = {
      ...response.body,
      ...(response.body.intentId === 'expected' ? { intentId: expected } : {})
    };
    global.fetch = jest.fn(async () => ({
      status: response.status,
      async json() {
        return body;
      }
    }));
    const instance = service();

    await instance.deliverObservationToSidecar.call(instance, current);

    expect(instance.logger.error).toHaveBeenCalledTimes(1);
    expect(instance.logger.error.mock.calls[0][0]).toMatch(/Failed to deliver native observation/u);
  });

  test('invalid acknowledgement JSON is not accepted as durable observation success', async () => {
    global.fetch = jest.fn(async () => ({
      status: 202,
      async json() {
        throw new SyntaxError('bad json');
      }
    }));
    const instance = service();

    await instance.deliverObservationToSidecar.call(instance, event());

    expect(instance.logger.error).toHaveBeenCalledTimes(1);
    expect(instance.logger.error.mock.calls[0][1].error).toMatch(/invalid acknowledgement body/u);
  });
});
