'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_REPLICAS = [1, 2, 4];
const DEFAULT_RECIPIENT_COUNTS = [10, 100];
const MIN_SAMPLES = 5;

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function median(values) {
  return percentile(values, 0.5);
}

function finitePositive(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be finite and > 0`);
  return parsed;
}

function expectedExecutors(replicaCount) {
  return Array.from({ length: replicaCount }, (_, index) => `r${index + 1}`);
}

function validateWindow(window, expected) {
  if (!window || window.phase !== 'ADSP-P2-A') throw new Error(`Invalid P2 window for ${expected.label}`);
  if (Number(window.replicaCount) !== expected.replicaCount) throw new Error(`Replica mismatch for ${expected.label}`);
  if (Number(window.recipientCount) !== expected.recipientCount) throw new Error(`Recipient mismatch for ${expected.label}`);
  if (Number(window.successfulOutcomes) !== Number(window.requestCount) || Number(window.failedOutcomes) !== 0) {
    throw new Error(`Correctness failure in ${expected.label}`);
  }
  if (Number(window.duplicateRequestIds) !== 0 || Number(window.duplicateActivityIds) !== 0) {
    throw new Error(`Duplicate authoritative outcome in ${expected.label}`);
  }
  finitePositive(window.throughputPerSecond, `${expected.label} throughput`);
  finitePositive(window.completedMs?.p95, `${expected.label} completed p95`);
  finitePositive(window.completedMs?.p99, `${expected.label} completed p99`);

  const counts = window.executorCounts || {};
  const executorTotal = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  if (executorTotal !== Number(window.requestCount)) throw new Error(`Executor accounting mismatch in ${expected.label}`);
  const expectedNames = expectedExecutors(expected.replicaCount);
  const actualNames = Object.keys(counts).sort();
  if (actualNames.some(name => !expectedNames.includes(name))) {
    throw new Error(`Unexpected executor identity in ${expected.label}: ${actualNames.join(', ')}`);
  }
  for (const executor of expectedNames) {
    if (!Number.isInteger(Number(counts[executor])) || Number(counts[executor]) <= 0) {
      throw new Error(`Replica ${executor} executed no measured work in ${expected.label}`);
    }
  }

  if (!Array.isArray(window.results) || window.results.length !== Number(window.requestCount)) {
    throw new Error(`Per-request result accounting mismatch in ${expected.label}`);
  }
  for (const result of window.results) {
    if (typeof result?.requestId !== 'string' || result.requestId.length === 0) {
      throw new Error(`Missing request identity in ${expected.label}`);
    }
    if (typeof result?.activityId !== 'string' || result.activityId.length === 0) {
      throw new Error(`Missing persisted Activity identity in ${expected.label}`);
    }
    if (!expectedNames.includes(result.executor)) {
      throw new Error(`Per-request executor drift in ${expected.label}: ${result.executor}`);
    }
  }
  return window;
}

function collectResults(directory, recipientCounts = DEFAULT_RECIPIENT_COUNTS) {
  const cases = {};
  for (const replicaCount of REQUIRED_REPLICAS) {
    for (const recipientCount of recipientCounts) {
      const key = `${replicaCount}r-${recipientCount}n`;
      const files = fs
        .readdirSync(directory)
        .filter(name => name.startsWith(`${key}-s`) && name.endsWith('.json'))
        .sort();
      const windows = files.map(name =>
        validateWindow(JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')), {
          label: name,
          replicaCount,
          recipientCount
        })
      );
      cases[key] = { replicaCount, recipientCount, files, windows };
    }
  }
  return cases;
}

function assertCaseIdentityUniqueness(entry) {
  const requestIds = new Set();
  const activityIds = new Set();
  let resultCount = 0;
  for (const window of entry.windows) {
    for (const result of window.results || []) {
      resultCount += 1;
      if (requestIds.has(result.requestId)) {
        throw new Error(`Request ID reused across measured windows in ${entry.replicaCount}r-${entry.recipientCount}n: ${result.requestId}`);
      }
      if (activityIds.has(result.activityId)) {
        throw new Error(`Activity ID reused across measured windows in ${entry.replicaCount}r-${entry.recipientCount}n: ${result.activityId}`);
      }
      requestIds.add(result.requestId);
      activityIds.add(result.activityId);
    }
  }
  const expectedResults = entry.windows.reduce((sum, window) => sum + Number(window.requestCount), 0);
  if (resultCount !== expectedResults) {
    throw new Error(`Cross-window result accounting mismatch in ${entry.replicaCount}r-${entry.recipientCount}n`);
  }
  return { requestIds: requestIds.size, activityIds: activityIds.size };
}

function summarizeCase(entry) {
  const windows = entry.windows;
  const identityCounts = assertCaseIdentityUniqueness(entry);
  const executorTotals = Object.create(null);
  for (const window of windows) {
    for (const [executor, count] of Object.entries(window.executorCounts || {})) {
      executorTotals[executor] = (executorTotals[executor] || 0) + Number(count);
    }
  }
  return {
    replicaCount: entry.replicaCount,
    recipientCount: entry.recipientCount,
    successfulSamples: windows.length,
    complete: windows.length >= MIN_SAMPLES,
    uniqueRequestIds: identityCounts.requestIds,
    uniqueActivityIds: identityCounts.activityIds,
    throughputPerSecond: {
      p50: median(windows.map(window => Number(window.throughputPerSecond))),
      p95: percentile(windows.map(window => Number(window.throughputPerSecond)), 0.95)
    },
    completedP95Ms: {
      p50: median(windows.map(window => Number(window.completedMs.p95))),
      p95: percentile(windows.map(window => Number(window.completedMs.p95)), 0.95)
    },
    completedP99Ms: {
      p50: median(windows.map(window => Number(window.completedMs.p99))),
      p95: percentile(windows.map(window => Number(window.completedMs.p99)), 0.95)
    },
    executorTotals
  };
}

function compareScale(smaller, larger) {
  const throughputRatio = larger.throughputPerSecond.p50 / smaller.throughputPerSecond.p50;
  const p95LatencyRatio = larger.completedP95Ms.p50 / smaller.completedP95Ms.p50;
  const p95Reduction = 1 - p95LatencyRatio;
  return {
    fromReplicas: smaller.replicaCount,
    toReplicas: larger.replicaCount,
    throughputRatio,
    p95LatencyRatio,
    p95Reduction,
    throughputGatePassed: throughputRatio >= 1.5,
    latencyThresholdObserved: p95Reduction >= 0.2,
    latencyGateRequiresIndependentSaturationProof: p95Reduction >= 0.2,
    scaleGateClosed: throughputRatio >= 1.5
  };
}

function buildSummary(cases, recipientCounts = DEFAULT_RECIPIENT_COUNTS) {
  const summarized = Object.fromEntries(Object.entries(cases).map(([key, entry]) => [key, summarizeCase(entry)]));
  const incompleteCases = Object.entries(summarized)
    .filter(([, entry]) => !entry.complete)
    .map(([key, entry]) => ({ key, successfulSamples: entry.successfulSamples, required: MIN_SAMPLES }));

  const scale = {};
  for (const recipientCount of recipientCounts) {
    const one = summarized[`1r-${recipientCount}n`];
    const two = summarized[`2r-${recipientCount}n`];
    const four = summarized[`4r-${recipientCount}n`];
    scale[`${recipientCount}n`] = {
      oneToTwo: compareScale(one, two),
      twoToFour: compareScale(two, four)
    };
  }

  return {
    version: 1,
    phase: 'ADSP-P2-A',
    fixture: 'tier1-horizontal-local-fanout',
    minimumSamplesPerCase: MIN_SAMPLES,
    recipientCounts,
    cases: summarized,
    incompleteCases,
    complete: incompleteCases.length === 0,
    scale,
    interpretationRule:
      'throughputGatePassed closes the numeric scale gate directly; latencyThresholdObserved does not close it without separate proof that the smaller arm was saturated'
  };
}

function main(argv = process.argv.slice(2)) {
  const resultsDir = path.resolve(argv[0] || '');
  const outputPath = path.resolve(argv[1] || '');
  if (!argv[0] || !argv[1]) throw new Error('Usage: adsp-p2-horizontal-summarize.js <results-dir> <output.json>');
  const recipientCounts = String(process.env.ADSP_P2_RECIPIENT_COUNTS || '10,100')
    .split(',')
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
  if (recipientCounts.length === 0) throw new Error('ADSP_P2_RECIPIENT_COUNTS must contain at least one number');
  const summary = buildSummary(collectResults(resultsDir, recipientCounts), recipientCounts);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.complete) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[ADSP-P2] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  MIN_SAMPLES,
  REQUIRED_REPLICAS,
  assertCaseIdentityUniqueness,
  buildSummary,
  collectResults,
  compareScale,
  expectedExecutors,
  summarizeCase,
  validateWindow
};
