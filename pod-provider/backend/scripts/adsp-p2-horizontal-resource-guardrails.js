'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_REPLICAS = [1, 2, 4];
const MIN_SAMPLES = 5;
const CPU_RATIO_MAX = 1.15;
const MEMORY_RATIO_MAX = 1.20;
const REDIS_WORK_RATIO_MAX = 1.15;

function finiteNonNegative(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be finite and >= 0`);
  return parsed;
}

function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))];
}

function median(values) {
  return percentile(values, 0.5);
}

function normalizedCase(resourceSummary, replicaCount, recipientCount) {
  const key = `${replicaCount}r-${recipientCount}n`;
  const base = resourceSummary?.cases?.[key];
  if (!base) throw new Error(`Missing resource case ${key}`);
  const windows = (resourceSummary.windows || []).filter(
    window => Number(window.replicaCount) === replicaCount && Number(window.recipientCount) === recipientCount
  );
  if (windows.length !== Number(base.samples)) {
    throw new Error(`Resource sample accounting mismatch for ${key}`);
  }
  const perOutcome = (field, label) =>
    windows.map(window => {
      const outcomes = finiteNonNegative(window.successfulOutcomes, `${key} successfulOutcomes`);
      if (!Number.isInteger(outcomes) || outcomes <= 0) throw new Error(`${key} successfulOutcomes must be a positive integer`);
      return finiteNonNegative(window[field], `${key} ${label}`) / outcomes;
    });

  return {
    key,
    replicaCount,
    recipientCount,
    samples: windows.length,
    complete: windows.length >= MIN_SAMPLES,
    wholeSystemCpuMsPerOutcomeP50: finiteNonNegative(
      base.wholeSystemCpuMsPerOutcomeP50,
      `${key} wholeSystemCpuMsPerOutcomeP50`
    ),
    backendMemoryCurrentAfterBytesP50: finiteNonNegative(
      base.backendMemoryCurrentAfterBytesP50,
      `${key} backendMemoryCurrentAfterBytesP50`
    ),
    wholeSystemMemoryCurrentAfterBytesP50: finiteNonNegative(
      base.wholeSystemMemoryCurrentAfterBytesP50,
      `${key} wholeSystemMemoryCurrentAfterBytesP50`
    ),
    redisCommandCallsPerOutcomeP50: median(perOutcome('redisCommandCalls', 'redisCommandCalls')),
    redisCommandUsecPerOutcomeP50: median(perOutcome('redisCommandUsec', 'redisCommandUsec')),
    redisFailedCallsTotal: finiteNonNegative(base.redisFailedCallsTotal, `${key} redisFailedCallsTotal`),
    redisRejectedCallsTotal: finiteNonNegative(base.redisRejectedCallsTotal, `${key} redisRejectedCallsTotal`)
  };
}

function ratio(larger, smaller, label) {
  const denominator = finiteNonNegative(smaller, `${label} smaller`);
  const numerator = finiteNonNegative(larger, `${label} larger`);
  if (denominator === 0) {
    if (numerator === 0) return 1;
    throw new Error(`${label} cannot normalize against zero baseline`);
  }
  return numerator / denominator;
}

function compareResourceStep(smaller, larger) {
  const wholeSystemCpuRatio = ratio(
    larger.wholeSystemCpuMsPerOutcomeP50,
    smaller.wholeSystemCpuMsPerOutcomeP50,
    'whole-system CPU per outcome'
  );
  const backendMemoryRatio = ratio(
    larger.backendMemoryCurrentAfterBytesP50,
    smaller.backendMemoryCurrentAfterBytesP50,
    'ActivityPods memory'
  );
  const wholeSystemMemoryRatio = ratio(
    larger.wholeSystemMemoryCurrentAfterBytesP50,
    smaller.wholeSystemMemoryCurrentAfterBytesP50,
    'whole-system memory'
  );
  const redisCommandCallsRatio = ratio(
    larger.redisCommandCallsPerOutcomeP50,
    smaller.redisCommandCallsPerOutcomeP50,
    'Redis command calls per outcome'
  );
  const redisCommandUsecRatio = ratio(
    larger.redisCommandUsecPerOutcomeP50,
    smaller.redisCommandUsecPerOutcomeP50,
    'Redis command usec per outcome'
  );
  const redisErrorsZero =
    smaller.redisFailedCallsTotal === 0 &&
    smaller.redisRejectedCallsTotal === 0 &&
    larger.redisFailedCallsTotal === 0 &&
    larger.redisRejectedCallsTotal === 0;

  // The frozen +15%/+20% regression limits are candidate guardrails for a
  // matched workload where replica count is held constant. Phase 2's 1→2→4
  // comparison intentionally changes replica count, so these ratios are
  // retained as diagnostics but are not promotion gates for the scale step.
  const matchedCandidateIndicators = {
    wholeSystemCpu: wholeSystemCpuRatio <= CPU_RATIO_MAX,
    backendMemory: backendMemoryRatio <= MEMORY_RATIO_MAX,
    wholeSystemMemory: wholeSystemMemoryRatio <= MEMORY_RATIO_MAX,
    redisCommandCalls: redisCommandCallsRatio <= REDIS_WORK_RATIO_MAX,
    redisCommandUsec: redisCommandUsecRatio <= REDIS_WORK_RATIO_MAX
  };
  const scaleSafety = { redisErrorsZero };

  return {
    fromReplicas: smaller.replicaCount,
    toReplicas: larger.replicaCount,
    wholeSystemCpuRatio,
    backendMemoryRatio,
    wholeSystemMemoryRatio,
    redisCommandCallsRatio,
    redisCommandUsecRatio,
    matchedCandidateThresholdsApplicable: false,
    matchedCandidateIndicators,
    scaleSafety,
    passed: Object.values(scaleSafety).every(Boolean)
  };
}

function buildResourceGuardrails(resourceSummary, recipientCounts) {
  if (!resourceSummary || resourceSummary.phase !== 'ADSP-P2-A') throw new Error('Invalid ADSP P2 resource summary');
  const counts = recipientCounts || [...new Set((resourceSummary.windows || []).map(window => Number(window.recipientCount)))].sort((a, b) => a - b);
  if (counts.length === 0 || counts.some(count => !Number.isInteger(count) || count <= 0)) {
    throw new Error('Resource guardrails require positive integer recipient counts');
  }

  const cases = {};
  const incompleteCases = [];
  const scale = {};
  for (const recipientCount of counts) {
    const entries = REQUIRED_REPLICAS.map(replicaCount => normalizedCase(resourceSummary, replicaCount, recipientCount));
    for (const entry of entries) {
      cases[entry.key] = entry;
      if (!entry.complete) incompleteCases.push({ key: entry.key, successfulSamples: entry.samples, required: MIN_SAMPLES });
    }
    scale[`${recipientCount}n`] = {
      oneToTwo: compareResourceStep(entries[0], entries[1]),
      twoToFour: compareResourceStep(entries[1], entries[2])
    };
  }

  const complete = incompleteCases.length === 0;
  const allStepsSafe = Object.values(scale).every(group => Object.values(group).every(step => step.passed));
  return {
    version: 2,
    phase: 'ADSP-P2-A',
    fixture: 'tier1-horizontal-local-fanout-resource-guardrails',
    matchedCandidateRegressionThresholds: {
      applicableAcrossReplicaScaleSteps: false,
      wholeSystemCpuRatioMax: CPU_RATIO_MAX,
      backendMemoryRatioMax: MEMORY_RATIO_MAX,
      wholeSystemMemoryRatioMax: MEMORY_RATIO_MAX,
      redisCommandWorkRatioMax: REDIS_WORK_RATIO_MAX
    },
    phase2ScaleResourceRequirements: {
      completeMeasuredWindowsPerCase: MIN_SAMPLES,
      redisFailedAndRejectedCalls: 0
    },
    interpretationRule:
      'The frozen +15%/+20% regression thresholds are retained as diagnostics but are not applied across 1→2→4 because replica count is the Phase-2 dimension under test. They become hard gates for matched same-replica candidate comparisons such as Phase 3 Redis versus NATS Core.',
    recipientCounts: counts,
    minimumSamplesPerCase: MIN_SAMPLES,
    cases,
    incompleteCases,
    complete,
    scale,
    passed: complete && allStepsSafe
  };
}

function main(argv = process.argv.slice(2)) {
  if (!argv[0] || !argv[1]) throw new Error('Usage: adsp-p2-horizontal-resource-guardrails.js <resource-summary.json> <output.json>');
  const inputPath = path.resolve(argv[0]);
  const outputPath = path.resolve(argv[1]);
  const summary = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const result = buildResourceGuardrails(summary);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (process.env.ADSP_P2_EVIDENCE_MODE === 'true' && !result.passed) process.exitCode = 2;
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
  CPU_RATIO_MAX,
  MEMORY_RATIO_MAX,
  MIN_SAMPLES,
  REDIS_WORK_RATIO_MAX,
  REQUIRED_REPLICAS,
  buildResourceGuardrails,
  compareResourceStep,
  normalizedCase,
  ratio
};
