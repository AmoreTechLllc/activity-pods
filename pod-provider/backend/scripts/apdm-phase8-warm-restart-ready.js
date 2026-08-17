'use strict';

const { ServiceBroker } = require('moleculer');

const DEFAULT_TRANSPORTER_URL = 'redis://redis:6379/12';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_MS = 500;
const COMPLETED_PREDICATE = 'http://activitypods.org/ns/core#completed';
const REQUIRED_RESTART_SERVICES = Object.freeze([
  'triplestore',
  'activitypub.outbox',
  'activitypub.actor',
  'activitypub.blocked',
  'activitypub.muted'
]);
const REQUIRED_MIGRATION_MARKERS = Object.freeze([
  'urn:activitypods:migration:blocked-collections-v1',
  'urn:activitypods:migration:muted-collections-v1'
]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function positiveInteger(value, fallback, label) {
  const parsed = Number(value === undefined ? fallback : value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function assertPhase10MeasurementRuntime({
  arm = process.env.APDM_P10_MEASUREMENT_ARM,
  concurrency = process.env.APDM_LOCAL_DELIVERY_CONCURRENCY,
  memoEnabled = process.env.APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED
} = {}) {
  if (arm === undefined || arm === null || arm === '') return { checked: false };
  if (arm !== 'off' && arm !== 'on') throw new Error(`Unsupported APDM Phase 10 measurement arm: ${arm}`);
  if (String(concurrency) !== '4') {
    throw new Error(`APDM Phase 10 measurement requires local delivery concurrency 4; received ${concurrency}`);
  }
  const expectedMemo = arm === 'on' ? 'true' : 'false';
  if (String(memoEnabled) !== expectedMemo) {
    throw new Error(`APDM Phase 10 arm ${arm} requires memo flag ${expectedMemo}; received ${memoEnabled}`);
  }
  return { checked: true, arm, concurrency: 4, memoEnabled: arm === 'on' };
}

function createRemoteBroker(transporterUrl) {
  return new ServiceBroker({
    nodeID: `apdm-p8-restart-ready-${process.pid}-${Date.now()}`,
    logger: false,
    transporter: transporterUrl,
    requestTimeout: 120_000,
    retryPolicy: { enabled: false }
  });
}

function markerValues(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map(row => row?.marker?.value || row?.marker)
    .filter(value => typeof value === 'string' && value.length > 0);
}

function missingMarkers(rows, requiredMarkers = REQUIRED_MIGRATION_MARKERS) {
  const present = new Set(markerValues(rows));
  return requiredMarkers.filter(marker => !present.has(marker));
}

function markerQuery(requiredMarkers = REQUIRED_MIGRATION_MARKERS) {
  const values = requiredMarkers.map(marker => `<${marker}>`).join(' ');
  return `
    SELECT ?marker
    WHERE {
      VALUES ?marker { ${values} }
      ?marker <${COMPLETED_PREDICATE}> true .
    }
  `;
}

async function waitForWarmRestartReady({
  transporterUrl = DEFAULT_TRANSPORTER_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_MS,
  brokerFactory = createRemoteBroker
} = {}) {
  const broker = brokerFactory(transporterUrl);
  await broker.start();
  try {
    await broker.waitForServices([...REQUIRED_RESTART_SERVICES], timeoutMs);

    const deadline = Date.now() + timeoutMs;
    let lastError;
    let lastMissing = [...REQUIRED_MIGRATION_MARKERS];

    while (Date.now() < deadline) {
      try {
        const rows = await broker.call('triplestore.query', {
          query: markerQuery(),
          accept: 'application/json',
          dataset: 'settings',
          webId: 'system'
        });
        lastMissing = missingMarkers(rows);
        if (lastMissing.length === 0) {
          return {
            ready: true,
            services: [...REQUIRED_RESTART_SERVICES],
            markers: [...REQUIRED_MIGRATION_MARKERS]
          };
        }
      } catch (error) {
        lastError = error;
      }
      await sleep(pollMs);
    }

    const detail = lastError
      ? ` lastError=${lastError.message || String(lastError)}`
      : ` missingMarkers=${lastMissing.join(',')}`;
    throw new Error(`Timed out waiting for APDM Phase 8 warm-restart readiness.${detail}`);
  } finally {
    await broker.stop();
  }
}

async function main() {
  const runtime = assertPhase10MeasurementRuntime();
  const transporterUrl = process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL;
  const timeoutMs = positiveInteger(
    process.env.APDM_P8_RESTART_READY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    'restart ready timeout'
  );
  const pollMs = positiveInteger(
    process.env.APDM_P8_RESTART_READY_POLL_MS,
    DEFAULT_POLL_MS,
    'restart ready poll interval'
  );
  const result = await waitForWarmRestartReady({ transporterUrl, timeoutMs, pollMs });
  process.stdout.write(`${JSON.stringify({ ok: true, phase: 'APDM-P8-A', phase10Runtime: runtime, ...result })}\n`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[APDM-P8] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  COMPLETED_PREDICATE,
  REQUIRED_MIGRATION_MARKERS,
  REQUIRED_RESTART_SERVICES,
  assertPhase10MeasurementRuntime,
  markerQuery,
  markerValues,
  missingMarkers,
  positiveInteger,
  waitForWarmRestartReady
};
