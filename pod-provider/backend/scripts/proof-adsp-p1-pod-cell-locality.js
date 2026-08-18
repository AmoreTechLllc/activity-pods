'use strict';

const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const AdspActionLocalityMiddleware = require('../middlewares/adsp-action-locality');

const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://127.0.0.1:6379';
const namespace = process.env.ADSP_P1_NAMESPACE || `adsp-p1-locality-${process.pid}-${Date.now()}`;
const SERVICE = 'adsp.p1.localityCell';

function makeTelemetry() {
  return AdspActionLocalityMiddleware({ enabled: true, maxActions: 50 });
}

function brokerOptions(nodeID) {
  return {
    nodeID,
    namespace,
    transporter: redisUrl,
    serializer: new RdfJSONSerializer(),
    logger: false,
    registry: {
      strategy: 'RoundRobin',
      preferLocal: true
    },
    middlewares: [makeTelemetry()]
  };
}

function createCellService() {
  return {
    name: SERVICE,
    actions: {
      inner(ctx) {
        return {
          servedBy: ctx.broker.nodeID,
          marker: ctx.params.marker
        };
      },
      async outer(ctx) {
        const inner = await ctx.call(`${SERVICE}.inner`, { marker: ctx.params.marker });
        return {
          outerServedBy: ctx.broker.nodeID,
          innerServedBy: inner.servedBy,
          marker: inner.marker
        };
      }
    }
  };
}

async function main() {
  const cellA = new ServiceBroker(brokerOptions('p1-cell-a'));
  const cellB = new ServiceBroker(brokerOptions('p1-cell-b'));
  const caller = new ServiceBroker(brokerOptions('p1-external-caller'));
  cellA.createService(createCellService());
  cellB.createService(createCellService());

  const brokers = [cellA, cellB, caller];
  try {
    await Promise.all(brokers.map(broker => broker.start()));
    await caller.waitForServices(SERVICE, 10000);

    const results = [];
    for (let i = 0; i < 20; i += 1) {
      const result = await caller.call(`${SERVICE}.outer`, { marker: `call-${i}` }, { timeout: 5000 });
      if (result.outerServedBy !== result.innerServedBy) {
        throw new Error(
          `preferLocal violation: outer ran on ${result.outerServedBy} but nested inner ran on ${result.innerServedBy}`
        );
      }
      if (result.marker !== `call-${i}`) throw new Error('Nested-call payload changed');
      results.push(result);
    }

    const snapshots = {
      caller: caller.adspActionLocality.snapshot(),
      cellA: cellA.adspActionLocality.snapshot(),
      cellB: cellB.adspActionLocality.snapshot()
    };

    if (snapshots.caller.remoteCalls !== 20) {
      throw new Error(`Expected 20 external remote calls, observed ${snapshots.caller.remoteCalls}`);
    }
    if (snapshots.cellA.remoteCalls !== 0 || snapshots.cellB.remoteCalls !== 0) {
      throw new Error(
        `Cell-internal action escaped locality: A=${snapshots.cellA.remoteCalls}, B=${snapshots.cellB.remoteCalls}`
      );
    }

    const servedNodes = [...new Set(results.map(result => result.outerServedBy))].sort();
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          namespace,
          calls: results.length,
          servedNodes,
          nestedCallsStayedOnOuterNode: true,
          snapshots
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled(brokers.map(broker => broker.stop()));
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
