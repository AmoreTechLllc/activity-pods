'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ServiceBroker } = require('moleculer');
const AdspActionLocalityMiddleware = require('../middlewares/adsp-action-locality');

describe('ADSP action locality middleware', () => {
  test('records local actions and flushes an atomic snapshot on broker stop', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-locality-'));
    const outputPath = path.join(dir, 'snapshot.json');
    const broker = new ServiceBroker({
      nodeID: 'locality-test',
      logger: false,
      middlewares: [AdspActionLocalityMiddleware({ enabled: true, outputPath, maxActions: 10 })]
    });
    broker.createService({
      name: 'locality.test',
      actions: {
        ping() {
          return 'pong';
        }
      }
    });

    try {
      await broker.start();
      await expect(broker.call('locality.test.ping')).resolves.toBe('pong');
      const live = broker.adspActionLocality.snapshot();
      expect(live.localExecutions).toBe(1);
      expect(live.remoteCalls).toBe(0);
      expect(live.localByAction['locality.test.ping']).toBe(1);
    } finally {
      await broker.stop();
    }

    const persisted = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    expect(persisted.nodeID).toBe('locality-test');
    expect(persisted.localExecutions).toBe(1);
    expect(persisted.remoteCalls).toBe(0);
    expect(fs.readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('keeps action maps bounded while totals continue counting', async () => {
    const broker = new ServiceBroker({
      nodeID: 'locality-bounded-test',
      logger: false,
      middlewares: [AdspActionLocalityMiddleware({ enabled: true, maxActions: 1 })]
    });
    broker.createService({
      name: 'locality.bounded',
      actions: {
        one() {},
        two() {}
      }
    });

    try {
      await broker.start();
      await broker.call('locality.bounded.one');
      await broker.call('locality.bounded.two');
      const snapshot = broker.adspActionLocality.snapshot();
      expect(snapshot.localExecutions).toBe(2);
      expect(Object.keys(snapshot.localByAction)).toHaveLength(1);
    } finally {
      await broker.stop();
    }
  });
});
