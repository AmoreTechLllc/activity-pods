'use strict';

const {
  REQUIRED_MIGRATION_MARKERS,
  markerQuery,
  markerValues,
  missingMarkers,
  waitForWarmRestartReady
} = require('../scripts/apdm-phase8-warm-restart-ready');

function createBroker({ rowsByCall = [], queryError = null } = {}) {
  let queryCalls = 0;
  return {
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    waitForServices: jest.fn(async services => {
      expect(services).toEqual(['triplestore', 'activitypub.outbox', 'activitypub.actor']);
    }),
    call: jest.fn(async (action, params) => {
      expect(action).toBe('triplestore.query');
      expect(params).toEqual(
        expect.objectContaining({
          dataset: 'settings',
          webId: 'system',
          accept: 'application/json'
        })
      );
      if (queryError) throw queryError;
      const value = rowsByCall[Math.min(queryCalls, Math.max(0, rowsByCall.length - 1))] || [];
      queryCalls += 1;
      return value;
    })
  };
}

describe('APDM Phase 8 warm restart readiness gate', () => {
  test('queries exactly the durable blocked and muted migration markers', () => {
    const query = markerQuery();
    for (const marker of REQUIRED_MIGRATION_MARKERS) expect(query).toContain(`<${marker}>`);
    expect(query).toContain('VALUES ?marker');
    expect(query).toContain('http://activitypods.org/ns/core#completed');
    expect(query).toContain('true');
  });

  test('normalizes Fuseki binding rows and identifies missing markers', () => {
    const [blocked, muted] = REQUIRED_MIGRATION_MARKERS;
    expect(markerValues([{ marker: { value: blocked } }, { marker: muted }, {}, null])).toEqual([blocked, muted]);
    expect(missingMarkers([{ marker: { value: blocked } }])).toEqual([muted]);
    expect(missingMarkers([{ marker: { value: blocked } }, { marker: { value: muted } }])).toEqual([]);
  });

  test('waits until both markers are observable before reporting ready', async () => {
    const [blocked, muted] = REQUIRED_MIGRATION_MARKERS;
    const broker = createBroker({
      rowsByCall: [
        [{ marker: { value: blocked } }],
        [{ marker: { value: blocked } }, { marker: { value: muted } }]
      ]
    });

    const result = await waitForWarmRestartReady({
      transporterUrl: 'redis://example.invalid/12',
      timeoutMs: 1000,
      pollMs: 1,
      brokerFactory: () => broker
    });

    expect(result).toEqual({ ready: true, markers: [...REQUIRED_MIGRATION_MARKERS] });
    expect(broker.call).toHaveBeenCalledTimes(2);
    expect(broker.stop).toHaveBeenCalledTimes(1);
  });

  test('fails closed and stops the remote broker when marker checks never converge', async () => {
    const broker = createBroker({ rowsByCall: [[]] });

    await expect(
      waitForWarmRestartReady({
        timeoutMs: 5,
        pollMs: 1,
        brokerFactory: () => broker
      })
    ).rejects.toThrow(/Timed out waiting for APDM Phase 8 warm-restart readiness/u);

    expect(broker.stop).toHaveBeenCalledTimes(1);
  });

  test('does not turn repeated query failures into readiness', async () => {
    const broker = createBroker({ queryError: new Error('Fuseki unavailable') });

    await expect(
      waitForWarmRestartReady({
        timeoutMs: 5,
        pollMs: 1,
        brokerFactory: () => broker
      })
    ).rejects.toThrow(/Fuseki unavailable/u);

    expect(broker.stop).toHaveBeenCalledTimes(1);
  });
});