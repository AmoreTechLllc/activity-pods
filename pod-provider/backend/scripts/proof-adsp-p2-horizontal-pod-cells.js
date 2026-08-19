'use strict';

const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');

const redisUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || 'redis://redis:6379/12';
const namespace = process.env.SEMAPPS_MOLECULER_NAMESPACE || process.env.ADSP_P2_NAMESPACE;
const expectedCount = Number(process.argv[2]);
const expectedNodeIds = process.argv.slice(3);
const representativeActions = [
  'activitypub.outbox.post',
  'activitypub.actor.getCollectionUri',
  'auth.awaitBootstrapComplete'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateInputs() {
  if (!namespace) throw new Error('P2 topology proof requires SEMAPPS_MOLECULER_NAMESPACE or ADSP_P2_NAMESPACE');
  if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 16) {
    throw new Error('Usage: proof-adsp-p2-horizontal-pod-cells.js <expectedCount> <nodeId...>');
  }
  if (expectedNodeIds.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} node IDs, got ${expectedNodeIds.length}`);
  }
  if (new Set(expectedNodeIds).size !== expectedNodeIds.length) {
    throw new Error(`Expected unique node IDs, got ${JSON.stringify(expectedNodeIds)}`);
  }
}

function endpointCount(broker, actionName) {
  const endpoints = broker.registry.getActionEndpoints(actionName);
  return endpoints?.count?.() ?? 0;
}

async function waitForActionEndpointCount(broker, actionName, expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = endpointCount(broker, actionName);
    if (observed === expected) return observed;
    await sleep(100);
  }
  throw new Error(
    `Timed out waiting for ${expected} endpoints for ${actionName}; observed ${endpointCount(broker, actionName)}`
  );
}

async function waitForNodeHealth(broker, nodeID, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await broker.call('$node.health', {}, { nodeID, timeout: 3000 });
      return health;
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(`Timed out reaching $node.health on ${nodeID}: ${lastError?.message || 'unknown error'}`);
}

async function main() {
  validateInputs();

  const broker = new ServiceBroker({
    nodeID: `adsp-p2-topology-proof-${process.pid}-${Date.now()}`,
    namespace,
    transporter: redisUrl,
    serializer: new RdfJSONSerializer(),
    logger: false,
    requestTimeout: 10000,
    retryPolicy: { enabled: false },
    registry: { preferLocal: true }
  });

  try {
    await broker.start();

    const actionEndpointCounts = {};
    for (const actionName of representativeActions) {
      actionEndpointCounts[actionName] = await waitForActionEndpointCount(broker, actionName, expectedCount);
    }

    const reachableNodes = [];
    for (const nodeID of expectedNodeIds) {
      await waitForNodeHealth(broker, nodeID);
      reachableNodes.push(nodeID);
    }

    // Re-read after node-targeted health checks so a transient discovery state
    // cannot pass only because one action converged earlier than the others.
    for (const actionName of representativeActions) {
      const observed = endpointCount(broker, actionName);
      if (observed !== expectedCount) {
        throw new Error(`Endpoint count drifted for ${actionName}: expected ${expectedCount}, observed ${observed}`);
      }
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          namespace,
          expectedReplicaCount: expectedCount,
          expectedNodeIds,
          reachableNodes,
          actionEndpointCounts,
          transporter: 'redis',
          productionServiceGroup: 'pod-cell',
          performanceClaim: false
        },
        null,
        2
      )}\n`
    );
  } finally {
    await broker.stop().catch(() => undefined);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
