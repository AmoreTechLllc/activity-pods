'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const {
  DEFAULT_DISTRIBUTED_HEARTBEAT_INTERVAL,
  DEFAULT_DISTRIBUTED_HEARTBEAT_TIMEOUT
} = require('../config/moleculer-fabric');
const { signalBarrier, waitForBarrier } = require('./adsp-p2-horizontal-load');

const ROOT_ACTION = 'activitypub.outbox.post';
const DEFAULT_TRANSPORTER_URL = 'redis://redis:6379/12';
const DEFAULT_READY_TIMEOUT_MS = 120000;
const DEFAULT_RECOVERY_BOUND_MS = 30000;
const DEFAULT_POLL_MS = 25;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function endpointCount(broker) {
  return broker.registry.getActionEndpoints(ROOT_ACTION)?.count?.() ?? 0;
}

function readEpochMarker(barrierDir, name) {
  const raw = fs.readFileSync(path.join(barrierDir, name), 'utf8').trim();
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Barrier ${name} did not contain a positive integer epoch timestamp`);
  }
  return parsed;
}

async function waitForEndpointCountUntil(broker, expected, deadlineEpochMs, pollMs = DEFAULT_POLL_MS) {
  for (;;) {
    const observedAtEpochMs = Date.now();
    const observedCount = endpointCount(broker);
    if (observedCount === expected) return observedAtEpochMs;
    if (observedAtEpochMs >= deadlineEpochMs) {
      throw new Error(
        `Timed out waiting for ${expected} ${ROOT_ACTION} endpoints by absolute deadline; observed ${observedCount}`
      );
    }
    await sleep(Math.min(pollMs, Math.max(1, deadlineEpochMs - observedAtEpochMs)));
  }
}

async function runRemovalClock({ broker, barrierDir, outputPath, recoveryBoundMs, readyTimeoutMs }) {
  const baselineDeadline = Date.now() + readyTimeoutMs;
  await waitForEndpointCountUntil(broker, 4, baselineDeadline);
  signalBarrier(barrierDir, 'removal-clock-ready');

  await waitForBarrier(barrierDir, 'fault-start', readyTimeoutMs);
  const faultStartEpochMs = readEpochMarker(barrierDir, 'fault-start');
  const observedMarkerAtEpochMs = Date.now();
  if (faultStartEpochMs > observedMarkerAtEpochMs) {
    throw new Error('fault-start epoch is in the future');
  }

  const recoveryDeadlineEpochMs = faultStartEpochMs + recoveryBoundMs;
  if (observedMarkerAtEpochMs >= recoveryDeadlineEpochMs) {
    throw new Error('Recovery budget was exhausted before the recovery clock observed fault-start');
  }

  const endpointRemovalObservedAtEpochMs = await waitForEndpointCountUntil(
    broker,
    3,
    recoveryDeadlineEpochMs
  );
  const endpointRemovalMs = endpointRemovalObservedAtEpochMs - faultStartEpochMs;
  if (endpointRemovalMs < 0 || endpointRemovalMs > recoveryBoundMs) {
    throw new Error(`Endpoint removal exceeded recovery bound: ${endpointRemovalMs}ms > ${recoveryBoundMs}ms`);
  }

  const result = {
    version: 1,
    phase: 'ADSP-P2-A',
    fixture: 'horizontal-redis-node-loss-removal-clock',
    rootAction: ROOT_ACTION,
    baselineEndpointCount: 4,
    convergedEndpointCount: 3,
    faultStartEpochMs,
    endpointRemovalObservedAtEpochMs,
    endpointRemovalMs,
    recoveryBoundMs,
    clockScope: 'pre-sigkill-fault-start-to-moleculer-endpoint-removal',
    complete: true,
    passed: true
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

async function main(argv = process.argv.slice(2)) {
  const outputPath = path.resolve(argv[0] || '');
  if (!argv[0]) throw new Error('Usage: adsp-p2-node-loss-removal-clock.js <output.json>');

  const barrierDir = process.env.ADSP_P2_BARRIER_DIR
    ? path.resolve(process.env.ADSP_P2_BARRIER_DIR)
    : undefined;
  if (!barrierDir) throw new Error('Recovery clock requires ADSP_P2_BARRIER_DIR');
  fs.mkdirSync(barrierDir, { recursive: true });
  for (const marker of ['removal-clock-ready', 'fault-start']) {
    fs.rmSync(path.join(barrierDir, marker), { force: true });
  }

  const namespace = process.env.SEMAPPS_MOLECULER_NAMESPACE || process.env.ADSP_P2_NAMESPACE;
  if (!namespace) throw new Error('Recovery clock requires an explicit Moleculer namespace');
  const readyTimeoutMs = positiveInteger(
    process.env.ADSP_P2_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS,
    'ready timeout'
  );
  const recoveryBoundMs = positiveInteger(
    process.env.ADSP_P2_RECOVERY_BOUND_MS || DEFAULT_RECOVERY_BOUND_MS,
    'recovery bound'
  );

  const broker = new ServiceBroker({
    nodeID: `adsp-p2-loss-removal-clock-${process.pid}-${Date.now()}`,
    namespace,
    transporter: process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL,
    serializer: new RdfJSONSerializer(),
    logger: false,
    retryPolicy: { enabled: false },
    heartbeatInterval: DEFAULT_DISTRIBUTED_HEARTBEAT_INTERVAL,
    heartbeatTimeout: DEFAULT_DISTRIBUTED_HEARTBEAT_TIMEOUT,
    registry: { preferLocal: true }
  });

  await broker.start();
  try {
    const result = await runRemovalClock({
      broker,
      barrierDir,
      outputPath,
      recoveryBoundMs,
      readyTimeoutMs
    });
    process.stdout.write(`${JSON.stringify({ ok: true, outputPath, endpointRemovalMs: result.endpointRemovalMs })}\n`);
  } finally {
    await broker.stop().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2-REMOVAL-CLOCK] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  ROOT_ACTION,
  endpointCount,
  positiveInteger,
  readEpochMarker,
  runRemovalClock,
  waitForEndpointCountUntil
};
