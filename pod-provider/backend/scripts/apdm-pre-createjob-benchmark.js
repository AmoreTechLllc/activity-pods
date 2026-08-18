'use strict';

const { performance } = require('node:perf_hooks');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FANOUTS = [10, 100, 1000, 5000, 10000];
const DEFAULT_ITERATIONS = 40;
const DEFAULT_WARMUPS = 10;
const QUEUE_OPTIONS = Object.freeze({ attempts: 10, backoff: { type: 'exponential', delay: '180000' } });

function parseSafeHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Models the current SemApps 1.1.4 tail after its authoritative recipient
 * classification. SemApps constructs one remotePost call per remote actor;
 * ActivityPods intercepts the call, materializes the job semantic snapshot,
 * then validates/extracts recipientUri again before Delivery Plan building.
 *
 * This benchmark deliberately starts *after* getRecipients + local/remote
 * classification so it does not pretend an earlier seam can remove addressing,
 * local-account, blind-recipient, or local-delivery work that both paths need.
 */
function currentCreateJobCaptureTail(remoteRecipients, activity) {
  const capturedRemotePosts = [];
  for (const recipientUri of remoteRecipients) {
    capturedRemotePosts.push({
      jobId: recipientUri,
      recipientUri,
      activity,
      options: QUEUE_OPTIONS,
    });
  }

  const recipients = [];
  for (const job of capturedRemotePosts) {
    if (!parseSafeHttpUrl(job.recipientUri)) {
      throw new Error('Current capture received an unsafe recipient URI');
    }
    if (job.jobId !== job.recipientUri) {
      throw new Error('Current capture received incompatible remotePost identity');
    }
    if (!job.activity || job.activity.id !== activity.id || job.activity.actor !== activity.actor) {
      throw new Error('Current capture received mismatched Activity identity');
    }
    recipients.push(job.recipientUri);
  }
  return [...new Set(recipients)];
}

/**
 * Prototype shape for an upstreamable hook immediately after SemApps has
 * produced remoteRecipients and before it constructs remotePost jobs.
 * It preserves the same fail-closed URI and Activity identity checks but
 * receives the resolved recipient vector directly.
 */
function preCreateJobPlanningTail(remoteRecipients, activity) {
  if (!activity || typeof activity.id !== 'string' || typeof activity.actor !== 'string') {
    throw new Error('Pre-createJob planning requires concrete Activity id and actor');
  }
  const recipients = [];
  for (const recipientUri of remoteRecipients) {
    if (!parseSafeHttpUrl(recipientUri)) {
      throw new Error('Pre-createJob planning received an unsafe recipient URI');
    }
    recipients.push(recipientUri);
  }
  return [...new Set(recipients)];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    min: sorted[0] ?? 0,
    mean: sorted.length > 0 ? sum / sorted.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function measureOne(fn, remoteRecipients, activity, expectedRecipientCount) {
  if (typeof global.gc === 'function') global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const result = fn(remoteRecipients, activity);
  const wallMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const cpuMicros = cpu.user + cpu.system;
  const heapDeltaBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);
  if (result.length !== expectedRecipientCount) {
    throw new Error('Benchmark path changed recipient semantics');
  }
  return { wallMs, cpuMicros, heapDeltaBytes };
}

/**
 * Measure the two arms as matched pairs and alternate which arm goes first on
 * every iteration. That prevents a millisecond-scale conclusion from being an
 * artifact of JIT warmup, thermal/runner drift, or always running one arm after
 * the other. GC is requested before each arm when --expose-gc is available.
 */
function measurePaired(remoteRecipients, activity, iterations, warmups) {
  const expectedRecipientCount = new Set(remoteRecipients).size;
  for (let i = 0; i < warmups; i += 1) {
    const first = i % 2 === 0 ? currentCreateJobCaptureTail : preCreateJobPlanningTail;
    const second = i % 2 === 0 ? preCreateJobPlanningTail : currentCreateJobCaptureTail;
    first(remoteRecipients, activity);
    second(remoteRecipients, activity);
  }

  const current = { wallMs: [], cpuMicros: [], heapDeltaBytes: [] };
  const direct = { wallMs: [], cpuMicros: [], heapDeltaBytes: [] };
  const pairedSaved = { wallMs: [], cpuMicros: [], heapDeltaBytes: [] };

  for (let i = 0; i < iterations; i += 1) {
    let currentSample;
    let directSample;
    if (i % 2 === 0) {
      currentSample = measureOne(currentCreateJobCaptureTail, remoteRecipients, activity, expectedRecipientCount);
      directSample = measureOne(preCreateJobPlanningTail, remoteRecipients, activity, expectedRecipientCount);
    } else {
      directSample = measureOne(preCreateJobPlanningTail, remoteRecipients, activity, expectedRecipientCount);
      currentSample = measureOne(currentCreateJobCaptureTail, remoteRecipients, activity, expectedRecipientCount);
    }

    current.wallMs.push(currentSample.wallMs);
    current.cpuMicros.push(currentSample.cpuMicros);
    current.heapDeltaBytes.push(currentSample.heapDeltaBytes);
    direct.wallMs.push(directSample.wallMs);
    direct.cpuMicros.push(directSample.cpuMicros);
    direct.heapDeltaBytes.push(directSample.heapDeltaBytes);
    pairedSaved.wallMs.push(currentSample.wallMs - directSample.wallMs);
    pairedSaved.cpuMicros.push(currentSample.cpuMicros - directSample.cpuMicros);
    pairedSaved.heapDeltaBytes.push(currentSample.heapDeltaBytes - directSample.heapDeltaBytes);
  }

  return {
    current: {
      wallMs: summarize(current.wallMs),
      cpuMicros: summarize(current.cpuMicros),
      heapDeltaBytes: summarize(current.heapDeltaBytes),
    },
    preCreateJob: {
      wallMs: summarize(direct.wallMs),
      cpuMicros: summarize(direct.cpuMicros),
      heapDeltaBytes: summarize(direct.heapDeltaBytes),
    },
    pairedSaved: {
      wallMs: summarize(pairedSaved.wallMs),
      cpuMicros: summarize(pairedSaved.cpuMicros),
      heapDeltaBytes: summarize(pairedSaved.heapDeltaBytes),
    },
  };
}

function createRemoteRecipients(fanout) {
  return Array.from({ length: fanout }, (_, index) => `https://remote-${index}.example/users/user-${index}`);
}

function estimateSemanticConstructionBytes(remoteRecipients, activity) {
  const current = remoteRecipients.map(recipientUri => ({
    jobId: recipientUri,
    recipientUri,
    activity,
    options: QUEUE_OPTIONS,
  }));
  const direct = [...new Set(remoteRecipients)];
  return {
    currentCapturedJobJsonBytes: Buffer.byteLength(JSON.stringify(current)),
    directRecipientVectorJsonBytes: Buffer.byteLength(JSON.stringify(direct)),
  };
}

function runBenchmark({ fanouts = DEFAULT_FANOUTS, iterations = DEFAULT_ITERATIONS, warmups = DEFAULT_WARMUPS } = {}) {
  const activity = Object.freeze({
    id: 'https://local.example/activities/benchmark',
    actor: 'https://local.example/users/alice',
    type: 'Create',
    object: 'https://local.example/objects/benchmark',
  });

  const cases = fanouts.map(fanout => {
    const remoteRecipients = createRemoteRecipients(fanout);
    const measured = measurePaired(remoteRecipients, activity, iterations, warmups);
    const constructionBytes = estimateSemanticConstructionBytes(remoteRecipients, activity);
    return {
      fanout,
      iterations,
      warmups,
      ordering: 'paired-alternating',
      modeledSharedInboxScenarios: [
        { uniqueDeliveryEndpoints: fanout, collapseRatio: 1 },
        { uniqueDeliveryEndpoints: Math.min(100, fanout), collapseRatio: fanout / Math.min(100, fanout) },
        { uniqueDeliveryEndpoints: Math.min(10, fanout), collapseRatio: fanout / Math.min(10, fanout) },
      ],
      ...measured,
      constructionBytes,
      p95WallSpeedup: measured.current.wallMs.p95 / Math.max(measured.preCreateJob.wallMs.p95, Number.EPSILON),
      p95CpuSpeedup: measured.current.cpuMicros.p95 / Math.max(measured.preCreateJob.cpuMicros.p95, Number.EPSILON),
      constructionByteReductionRatio:
        constructionBytes.currentCapturedJobJsonBytes / Math.max(constructionBytes.directRecipientVectorJsonBytes, 1),
    };
  });

  return {
    schema: 'apdm-pre-createjob-benchmark.v2',
    measuredAt: new Date().toISOString(),
    node: process.version,
    scope: 'post-SemApps-recipient-classification planning tail only',
    invariant: 'no recipient addressing/classification/local-delivery work is removed by this benchmark',
    methodology: 'paired samples; alternating arm order; explicit GC before each arm when available',
    cases,
  };
}

if (require.main === module) {
  const result = runBenchmark();
  const output = process.env.APDM_PRE_CREATEJOB_BENCHMARK_OUTPUT;
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    const resolved = path.resolve(output);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, rendered, { encoding: 'utf8', mode: 0o600 });
  }
  process.stdout.write(rendered);
}

module.exports = {
  currentCreateJobCaptureTail,
  preCreateJobPlanningTail,
  estimateSemanticConstructionBytes,
  measurePaired,
  runBenchmark,
};
