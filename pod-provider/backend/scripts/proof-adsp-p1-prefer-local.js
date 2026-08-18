'use strict';

const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const AdspActionLocalityMiddleware = require('../middlewares/adsp-action-locality');
const localityProbeService = require('../p1-fixtures/services/locality-probe.service');

const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://127.0.0.1:6379';
const namespace = process.env.ADSP_P1_NAMESPACE || `adsp-p1-local-${process.pid}-${Date.now()}`;
const OUTER = 'adsp.p1.localityProbe.outer';
const INNER = 'adsp.p1.localityProbe.inner';
const CALLS_PER_CELL = 50;

function makeBroker(nodeID) {
  const broker = new ServiceBroker({
    nodeID,
    namespace,
    transporter: redisUrl,
    serializer: new RdfJSONSerializer(),
    registry: { preferLocal: true },
    middlewares: [AdspActionLocalityMiddleware({ enabled: true, maxActions: 20 })],
    logger: false,
    heartbeatInterval: 1,
    heartbeatTimeout: 3
  });
  broker.createService(localityProbeService);
  return broker;
}

async function waitForTwoEndpoints(broker, action, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const endpoints = broker.registry.getActionEndpoints(action);
    if ((endpoints?.count?.() ?? 0) === 2) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for two ${action} endpoints`);
}

function snapshot(broker) {
  return broker.adspActionLocality.snapshot();
}

async function exerciseCell(broker, expectedNode) {
  const results = [];
  for (let index = 0; index < CALLS_PER_CELL; index += 1) {
    results.push(
      await broker.call(OUTER, { marker: `${expectedNode}-${index}` }, { timeout: 5000 })
    );
  }

  for (const result of results) {
    if (result.outerServedBy !== expectedNode) {
      throw new Error(`Outer action escaped ${expectedNode}: ${result.outerServedBy}`);
    }
    if (result.inner?.servedBy !== expectedNode) {
      throw new Error(`Nested ctx.call escaped ${expectedNode}: ${result.inner?.servedBy}`);
    }
  }
}

async function main() {
  const a = makeBroker('pod-cell-a');
  const b = makeBroker('pod-cell-b');

  try {
    await Promise.all([a.start(), b.start()]);
    await Promise.all([
      a.waitForServices('adsp.p1.localityProbe', 10000),
      b.waitForServices('adsp.p1.localityProbe', 10000)
    ]);
    await Promise.all([
      waitForTwoEndpoints(a, OUTER),
      waitForTwoEndpoints(a, INNER),
      waitForTwoEndpoints(b, OUTER),
      waitForTwoEndpoints(b, INNER)
    ]);

    await exerciseCell(a, 'pod-cell-a');
    await exerciseCell(b, 'pod-cell-b');

    const aTelemetry = snapshot(a);
    const bTelemetry = snapshot(b);

    for (const [node, telemetry] of [
      ['pod-cell-a', aTelemetry],
      ['pod-cell-b', bTelemetry]
    ]) {
      if (telemetry.remoteCalls !== 0) {
        throw new Error(`${node} recorded ${telemetry.remoteCalls} remote calls despite local endpoints`);
      }
      if ((telemetry.localByAction[OUTER] || 0) !== CALLS_PER_CELL) {
        throw new Error(`${node} outer local execution count mismatch`);
      }
      if ((telemetry.localByAction[INNER] || 0) !== CALLS_PER_CELL) {
        throw new Error(`${node} inner local execution count mismatch`);
      }
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          namespace,
          callsPerCell: CALLS_PER_CELL,
          endpointsPerAction: 2,
          preferLocal: true,
          nestedCtxCallStayedLocal: true,
          telemetry: { a: aTelemetry, b: bTelemetry }
        },
        null,
        2
      )}\n`
    );
  } finally {
    await Promise.allSettled([a.stop(), b.stop()]);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
