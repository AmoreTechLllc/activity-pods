'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { ServiceBroker } = require('moleculer');
const RdfJSONSerializer = require('../RdfJSONSerializer');
const {
  DEFAULT_DISTRIBUTED_HEARTBEAT_INTERVAL,
  DEFAULT_DISTRIBUTED_HEARTBEAT_TIMEOUT
} = require('../config/moleculer-fabric');
const {
  executorName,
  findTraceMatches,
  readJsonLines,
  signalBarrier,
  waitForBarrier,
  waitForUniqueTrace
} = require('./adsp-p2-horizontal-load');

const DEFAULT_TRANSPORTER_URL = 'redis://redis:6379/12';
const DEFAULT_READY_TIMEOUT_MS = 120000;
const DEFAULT_TRACE_TIMEOUT_MS = 900000;
const DEFAULT_RECOVERY_BOUND_MS = 30000;
const DEFAULT_REPLAY_OBSERVATION_MS = 8000;
const ROOT_ACTION = 'activitypub.outbox.post';
const DEFAULT_VICTIM_NODE = 'adsp-p2-pod-cell-4';
const EXPECTED_VICTIM_BOUNDARY = 'root-action-complete-response-held';

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

async function waitForEndpointCount(broker, expected, timeoutMs) {
  const started = performance.now();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (endpointCount(broker) === expected) return performance.now() - started;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${expected} ${ROOT_ACTION} endpoints; observed ${endpointCount(broker)}`);
}

function createRequestId(runLabel, phase, index) {
  return `adsp-p2-loss-${runLabel}-${phase}-${index}-${crypto.randomBytes(6).toString('hex')}`;
}

function requestPayload(manifest, recipients, requestId) {
  return {
    collectionUri: manifest.sender.outbox,
    type: 'Create',
    actor: manifest.sender.webId,
    to: recipients,
    object: {
      type: 'Note',
      content: `ADSP P2 node-loss ${requestId}`
    }
  };
}

function submitRequest({ broker, manifest, recipients, requestId, timeoutMs, nodeID }) {
  const startedAtEpochMs = Date.now();
  const options = {
    meta: { webId: manifest.sender.webId, dataset: manifest.sender.username },
    requestID: requestId,
    timeout: timeoutMs
  };
  if (nodeID) options.nodeID = nodeID;

  const promise = broker
    .call(ROOT_ACTION, requestPayload(manifest, recipients, requestId), options)
    .then(value => ({ requestId, resolved: true, value, startedAtEpochMs, settledAtEpochMs: Date.now() }))
    .catch(error => ({
      requestId,
      resolved: false,
      startedAtEpochMs,
      settledAtEpochMs: Date.now(),
      error: {
        name: error?.name || null,
        type: error?.type || null,
        code: error?.code || null,
        message: error?.message || String(error)
      }
    }));
  return { requestId, promise };
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertExecutorSet(executorCounts, expectedExecutors, requestCount) {
  const total = Object.values(executorCounts).reduce((sum, count) => sum + Number(count || 0), 0);
  if (total !== requestCount) throw new Error(`Executor accounting mismatch: expected ${requestCount}, observed ${total}`);
  const actual = Object.keys(executorCounts).sort();
  const unexpected = actual.filter(name => !expectedExecutors.includes(name));
  if (unexpected.length) throw new Error(`Unexpected executor(s): ${unexpected.join(', ')}`);
  for (const executor of expectedExecutors) {
    if (!Number.isInteger(Number(executorCounts[executor])) || Number(executorCounts[executor]) <= 0) {
      throw new Error(`Expected executor ${executor} carried no accepted work`);
    }
  }
}

function rootEntryFilesFromEnv() {
  return String(process.env.ADSP_P2_ROOT_ENTRY_FILES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));
}

function findRootEntries(rootEntryFiles, requestId) {
  const matches = [];
  for (const filePath of rootEntryFiles) {
    for (const record of readJsonLines(filePath)) {
      if (record?.phase === 'ADSP-P2-ROOT-ENTRY' && record?.requestId === requestId) {
        matches.push({ filePath, record });
      }
    }
  }
  return matches;
}

async function waitForExactVictimRootEntry(
  rootEntryFiles,
  requestId,
  victimNode,
  timeoutMs,
  expectedBoundary = EXPECTED_VICTIM_BOUNDARY
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = findRootEntries(rootEntryFiles, requestId);
    if (matches.length > 1) {
      throw new Error(`Targeted request ${requestId} entered multiple root executors: ${matches.map(m => m.record?.nodeID).join(', ')}`);
    }
    if (matches.length === 1) {
      const [{ filePath, record }] = matches;
      if (record.nodeID !== victimNode) {
        throw new Error(`Targeted request ${requestId} entered ${record.nodeID}, expected victim ${victimNode}`);
      }
      if (record.boundary !== expectedBoundary) {
        throw new Error(
          `Targeted request ${requestId} reached boundary ${JSON.stringify(record.boundary)}, expected ${JSON.stringify(expectedBoundary)}`
        );
      }
      if (!Number.isInteger(Number(record.enteredAtEpochMs))) {
        throw new Error(`Victim root-entry record for ${requestId} lacks an integer enteredAtEpochMs`);
      }
      return { filePath, record };
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for targeted request ${requestId} to enter victim ${victimNode}`);
}

function readBarrierTimestamp(barrierDir, name) {
  const marker = path.join(barrierDir, name);
  const raw = fs.readFileSync(marker, 'utf8').trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Barrier ${name} did not contain an epoch timestamp`);
  return parsed;
}

async function runAcceptedWave({ broker, manifest, recipients, traceFiles, count, concurrency, timeoutMs, runLabel, phase, expectedExecutors }) {
  const results = new Array(count);
  let cursor = 0;
  const startedPerfMs = performance.now();

  async function worker(workerIndex) {
    for (;;) {
      const index = cursor++;
      if (index >= count) return;
      const requestId = createRequestId(runLabel, phase, index + 1);
      const outcome = await submitRequest({ broker, manifest, recipients, requestId, timeoutMs }).promise;
      if (!outcome.resolved || !outcome.value?.id) {
        throw new Error(`Accepted-wave request ${requestId} failed: ${JSON.stringify(outcome.error || outcome.value)}`);
      }
      const traced = await waitForUniqueTrace(traceFiles, requestId, recipients.length, timeoutMs);
      results[index] = {
        requestId,
        activityId: outcome.value.id,
        executor: executorName(traced.traceFile),
        workerIndex,
        startedAtEpochMs: outcome.startedAtEpochMs,
        settledAtEpochMs: outcome.settledAtEpochMs
      };
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, (_, index) => worker(index + 1)));
  const executorCounts = Object.create(null);
  for (const result of results) executorCounts[result.executor] = (executorCounts[result.executor] || 0) + 1;
  assertExecutorSet(executorCounts, expectedExecutors, count);
  assertUnique(results.map(result => result.requestId), `${phase} request ID`);
  assertUnique(results.map(result => result.activityId), `${phase} Activity ID`);

  return {
    phase,
    requestCount: count,
    successfulOutcomes: count,
    failedOutcomes: 0,
    wallMs: performance.now() - startedPerfMs,
    executorCounts,
    results
  };
}

async function observeRejectedTraceCardinality(traceFiles, requestId, observationMs) {
  const deadline = Date.now() + observationMs;
  while (Date.now() < deadline) {
    const matches = findTraceMatches(traceFiles, requestId);
    if (matches.length > 1) throw new Error(`Rejected request ${requestId} produced duplicate completed traces`);
    await sleep(100);
  }
  const finalMatches = findTraceMatches(traceFiles, requestId);
  if (finalMatches.length > 1) throw new Error(`Rejected request ${requestId} produced duplicate completed traces`);
  return {
    completedTraceCount: finalMatches.length,
    executor: finalMatches.length === 1 ? executorName(finalMatches[0].traceFile) : null,
    observationMs
  };
}

async function auditFaultBurst({ burst, traceFiles, recipientCount, timeoutMs, replayObservationMs }) {
  const settled = await Promise.all(burst.map(entry => entry.promise));
  const accepted = [];
  const rejected = [];

  for (const outcome of settled) {
    if (outcome.resolved) {
      if (!outcome.value?.id) throw new Error(`Resolved fault-burst request ${outcome.requestId} returned no Activity ID`);
      const traced = await waitForUniqueTrace(traceFiles, outcome.requestId, recipientCount, timeoutMs);
      accepted.push({
        requestId: outcome.requestId,
        activityId: outcome.value.id,
        executor: executorName(traced.traceFile),
        startedAtEpochMs: outcome.startedAtEpochMs,
        settledAtEpochMs: outcome.settledAtEpochMs
      });
    } else {
      const traceAudit = await observeRejectedTraceCardinality(traceFiles, outcome.requestId, replayObservationMs);
      rejected.push({
        requestId: outcome.requestId,
        error: outcome.error,
        startedAtEpochMs: outcome.startedAtEpochMs,
        settledAtEpochMs: outcome.settledAtEpochMs,
        ...traceAudit,
        ambiguousCommittedCompletionObserved: traceAudit.completedTraceCount === 1
      });
    }
  }

  assertUnique(settled.map(outcome => outcome.requestId), 'fault-burst request ID');
  assertUnique(accepted.map(outcome => outcome.activityId), 'fault-burst accepted Activity ID');
  return { accepted, rejected };
}

function assertTargetedVictimRejected(fault, victimRequestId) {
  const acceptedMatches = fault.accepted.filter(outcome => outcome.requestId === victimRequestId);
  const rejectedMatches = fault.rejected.filter(outcome => outcome.requestId === victimRequestId);
  if (acceptedMatches.length !== 0 || rejectedMatches.length !== 1) {
    throw new Error(
      `Targeted ambiguous request ${victimRequestId} must be caller-rejected exactly once; accepted=${acceptedMatches.length} rejected=${rejectedMatches.length}`
    );
  }
  return rejectedMatches[0];
}

async function main(argv = process.argv.slice(2)) {
  const manifestPath = path.resolve(argv[0] || '');
  const recipientCount = positiveInteger(argv[1], 'recipient count');
  const outputPath = path.resolve(argv[2] || '');
  if (!argv[0] || !argv[2]) {
    throw new Error('Usage: adsp-p2-node-loss-load.js <manifest> <recipientCount> <output.json>');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest?.sender?.outbox || !manifest?.sender?.webId || !manifest?.sender?.username) {
    throw new Error('Actor manifest is missing sender authority fields');
  }
  if (!Array.isArray(manifest.recipients) || manifest.recipients.length < recipientCount) {
    throw new Error(`Actor manifest contains fewer than ${recipientCount} recipients`);
  }

  const traceFiles = String(process.env.ADSP_P2_TRACE_FILES || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => path.resolve(value));
  if (traceFiles.length !== 4) throw new Error(`Node-loss evidence requires four trace files; observed ${traceFiles.length}`);
  for (const traceFile of traceFiles) fs.rmSync(traceFile, { force: true });

  const rootEntryFiles = rootEntryFilesFromEnv();
  if (rootEntryFiles.length !== 4) throw new Error(`Node-loss evidence requires four root-entry files; observed ${rootEntryFiles.length}`);
  for (const filePath of rootEntryFiles) fs.rmSync(filePath, { force: true });

  const namespace = process.env.SEMAPPS_MOLECULER_NAMESPACE || process.env.ADSP_P2_NAMESPACE;
  if (!namespace) throw new Error('Node-loss evidence requires an explicit Moleculer namespace');
  const barrierDir = process.env.ADSP_P2_BARRIER_DIR ? path.resolve(process.env.ADSP_P2_BARRIER_DIR) : undefined;
  if (!barrierDir) throw new Error('Node-loss evidence requires ADSP_P2_BARRIER_DIR');
  fs.mkdirSync(barrierDir, { recursive: true });
  for (const marker of ['ready', 'go', 'victim-inflight', 'victim-killed', 'restart-victim', 'victim-restarted']) {
    fs.rmSync(path.join(barrierDir, marker), { force: true });
  }

  const readyTimeoutMs = positiveInteger(process.env.ADSP_P2_READY_TIMEOUT_MS || DEFAULT_READY_TIMEOUT_MS, 'ready timeout');
  const traceTimeoutMs = positiveInteger(process.env.ADSP_P2_TRACE_TIMEOUT_MS || DEFAULT_TRACE_TIMEOUT_MS, 'trace timeout');
  const recoveryBoundMs = positiveInteger(process.env.ADSP_P2_RECOVERY_BOUND_MS || DEFAULT_RECOVERY_BOUND_MS, 'recovery bound');
  const replayObservationMs = positiveInteger(process.env.ADSP_P2_REPLAY_OBSERVATION_MS || DEFAULT_REPLAY_OBSERVATION_MS, 'replay observation');
  const runLabel = process.env.ADSP_P2_RUN_LABEL || `4r-${recipientCount}n`;
  const victimNode = process.env.ADSP_P2_VICTIM_NODE || DEFAULT_VICTIM_NODE;
  const faultBurstCount = positiveInteger(process.env.ADSP_P2_FAULT_BURST_REQUESTS || 8, 'fault burst requests');
  const recoveryRequests = positiveInteger(process.env.ADSP_P2_RECOVERY_REQUESTS || 8, 'recovery requests');
  const rejoinRequests = positiveInteger(process.env.ADSP_P2_REJOIN_REQUESTS || 8, 'rejoin requests');
  const concurrency = positiveInteger(process.env.ADSP_P2_CONCURRENCY || 8, 'concurrency');
  const recipients = manifest.recipients.slice(0, recipientCount).map(recipient => recipient.webId);

  const broker = new ServiceBroker({
    nodeID: `adsp-p2-loss-driver-${process.pid}-${Date.now()}`,
    namespace,
    transporter: process.env.SEMAPPS_REDIS_TRANSPORTER_URL || DEFAULT_TRANSPORTER_URL,
    serializer: new RdfJSONSerializer(),
    logger: false,
    requestTimeout: traceTimeoutMs,
    retryPolicy: { enabled: false },
    heartbeatInterval: DEFAULT_DISTRIBUTED_HEARTBEAT_INTERVAL,
    heartbeatTimeout: DEFAULT_DISTRIBUTED_HEARTBEAT_TIMEOUT,
    registry: { preferLocal: true }
  });

  await broker.start();
  try {
    await waitForEndpointCount(broker, 4, readyTimeoutMs);
    signalBarrier(barrierDir, 'ready');
    await waitForBarrier(barrierDir, 'go', readyTimeoutMs);

    const victimRequestId = createRequestId(runLabel, 'fault', 1);
    const burst = [submitRequest({
      broker,
      manifest,
      recipients,
      requestId: victimRequestId,
      timeoutMs: traceTimeoutMs,
      nodeID: victimNode
    })];
    for (let index = 2; index <= faultBurstCount; index += 1) {
      burst.push(submitRequest({
        broker,
        manifest,
        recipients,
        requestId: createRequestId(runLabel, 'fault', index),
        timeoutMs: traceTimeoutMs
      }));
    }

    const victimEntry = await waitForExactVictimRootEntry(
      rootEntryFiles,
      victimRequestId,
      victimNode,
      readyTimeoutMs,
      EXPECTED_VICTIM_BOUNDARY
    );
    signalBarrier(barrierDir, 'victim-inflight');
    await waitForBarrier(barrierDir, 'victim-killed', readyTimeoutMs);
    const killEpochMs = readBarrierTimestamp(barrierDir, 'victim-killed');
    if (killEpochMs < Number(victimEntry.record.enteredAtEpochMs)) {
      throw new Error(`Victim kill timestamp predates proven held-response boundary for ${victimRequestId}`);
    }

    const endpointRemovalMs = await waitForEndpointCount(broker, 3, recoveryBoundMs);
    const recovery = await runAcceptedWave({
      broker,
      manifest,
      recipients,
      traceFiles,
      count: recoveryRequests,
      concurrency,
      timeoutMs: traceTimeoutMs,
      runLabel,
      phase: 'post-loss-survivors',
      expectedExecutors: ['r1', 'r2', 'r3']
    });
    const applicationRecoveryMs = Math.min(...recovery.results.map(result => result.settledAtEpochMs)) - killEpochMs;
    if (applicationRecoveryMs < 0) {
      throw new Error(`First successful post-loss completion predates kill by ${Math.abs(applicationRecoveryMs)}ms`);
    }

    signalBarrier(barrierDir, 'restart-victim');
    await waitForBarrier(barrierDir, 'victim-restarted', readyTimeoutMs);
    const restartEpochMs = readBarrierTimestamp(barrierDir, 'victim-restarted');
    const endpointRejoinMs = await waitForEndpointCount(broker, 4, recoveryBoundMs);

    const rejoin = await runAcceptedWave({
      broker,
      manifest,
      recipients,
      traceFiles,
      count: rejoinRequests,
      concurrency,
      timeoutMs: traceTimeoutMs,
      runLabel,
      phase: 'post-rejoin',
      expectedExecutors: ['r1', 'r2', 'r3', 'r4']
    });
    const applicationRejoinMs = Math.min(...rejoin.results.map(result => result.settledAtEpochMs)) - restartEpochMs;
    if (applicationRejoinMs < 0) {
      throw new Error(`First successful post-rejoin completion predates restart by ${Math.abs(applicationRejoinMs)}ms`);
    }

    const fault = await auditFaultBurst({
      burst,
      traceFiles,
      recipientCount,
      timeoutMs: traceTimeoutMs,
      replayObservationMs
    });
    const targetedVictimOutcome = assertTargetedVictimRejected(fault, victimRequestId);

    const allAccepted = [...fault.accepted, ...recovery.results, ...rejoin.results];
    assertUnique(allAccepted.map(outcome => outcome.requestId), 'accepted request ID across node-loss scenario');
    assertUnique(allAccepted.map(outcome => outcome.activityId), 'accepted Activity ID across node-loss scenario');

    const result = {
      version: 1,
      phase: 'ADSP-P2-A',
      fixture: 'horizontal-redis-node-loss-under-load',
      runLabel,
      namespace,
      transporter: 'redis',
      replicaCountBeforeLoss: 4,
      replicaCountAfterLoss: 3,
      replicaCountAfterRejoin: 4,
      recipientCount,
      victimNode,
      victimRootEntry: {
        requestId: victimRequestId,
        nodeID: victimEntry.record.nodeID,
        boundary: victimEntry.record.boundary,
        enteredAt: victimEntry.record.enteredAt,
        enteredAtEpochMs: victimEntry.record.enteredAtEpochMs,
        sourceFile: path.basename(victimEntry.filePath),
        exactEntryCountBeforeKill: 1,
        callerOutcome: 'rejected',
        callerError: targetedVictimOutcome.error,
        completedTraceCount: targetedVictimOutcome.completedTraceCount
      },
      faultBurst: {
        requestCount: faultBurstCount,
        killEpochMs,
        acceptedCount: fault.accepted.length,
        rejectedCount: fault.rejected.length,
        accepted: fault.accepted,
        rejected: fault.rejected
      },
      recovery: {
        boundMs: recoveryBoundMs,
        endpointRemovalMs,
        applicationRecoveryMs,
        applicationLatencyIsDiagnosticOnly: true,
        ...recovery
      },
      rejoin: {
        boundMs: recoveryBoundMs,
        restartEpochMs,
        endpointRejoinMs,
        applicationRejoinMs,
        applicationLatencyIsDiagnosticOnly: true,
        ...rejoin
      },
      correctness: {
        targetedVictimBoundaryProvenBeforeKill: true,
        targetedVictimBoundary: EXPECTED_VICTIM_BOUNDARY,
        targetedVictimCallerRejectedExactlyOnce: true,
        acceptedActivityIdsUnique: true,
        acceptedRequestIdsUnique: true,
        duplicateCompletedTraceForRejectedRequest: false,
        rejectedRequestsWereNotRetriedByHarness: true,
        redisTransportRetryPolicyEnabled: false
      },
      complete: true,
      passed: true
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outputPath,
      endpointRemovalMs,
      applicationRecoveryMs,
      endpointRejoinMs,
      applicationRejoinMs,
      faultAccepted: fault.accepted.length,
      faultRejected: fault.rejected.length
    })}\n`);
  } finally {
    await broker.stop().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ADSP-P2-LOSS] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  EXPECTED_VICTIM_BOUNDARY,
  assertExecutorSet,
  assertTargetedVictimRejected,
  assertUnique,
  auditFaultBurst,
  createRequestId,
  endpointCount,
  findRootEntries,
  observeRejectedTraceCardinality,
  readBarrierTimestamp,
  requestPayload,
  rootEntryFilesFromEnv,
  runAcceptedWave,
  submitRequest,
  waitForEndpointCount,
  waitForExactVictimRootEntry
};
