'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildResourceGuardrails,
  compareResourceStep
} = require('../scripts/adsp-p2-horizontal-resource-guardrails');

function makeCase(replicaCount, recipientCount, {
  samples = 5,
  cpuPerOutcome = 10,
  backendMemory = 1000,
  wholeMemory = 2000,
  redisCallsPerOutcome = 20,
  redisUsecPerOutcome = 30,
  failed = 0,
  rejected = 0
} = {}) {
  const key = `${replicaCount}r-${recipientCount}n`;
  const outcomes = 8;
  const windows = Array.from({ length: samples }, (_, index) => ({
    replicaCount,
    recipientCount,
    sample: index + 1,
    successfulOutcomes: outcomes,
    redisCommandCalls: redisCallsPerOutcome * outcomes,
    redisCommandUsec: redisUsecPerOutcome * outcomes
  }));
  const summaryCase = {
    replicaCount,
    recipientCount,
    samples,
    wholeSystemCpuMsPerOutcomeP50: cpuPerOutcome,
    backendMemoryCurrentAfterBytesP50: backendMemory,
    wholeSystemMemoryCurrentAfterBytesP50: wholeMemory,
    redisCommandCallsP50: redisCallsPerOutcome * outcomes,
    redisCommandUsecP50: redisUsecPerOutcome * outcomes,
    redisFailedCallsTotal: failed,
    redisRejectedCallsTotal: rejected
  };
  return { key, windows, summaryCase };
}

function resourceSummary(overrides = {}) {
  const cases = {};
  const windows = [];
  for (const replicas of [1, 2, 4]) {
    const config = overrides[replicas] || {};
    const built = makeCase(replicas, 10, config);
    cases[built.key] = built.summaryCase;
    windows.push(...built.windows);
  }
  return {
    version: 1,
    phase: 'ADSP-P2-A',
    fixture: 'tier1-horizontal-local-fanout-resources',
    windows,
    cases
  };
}

describe('ADSP P2 normalized resource guardrails', () => {
  test('keeps matched-candidate thresholds diagnostic across replica-count scale steps', () => {
    const summary = resourceSummary({
      1: { cpuPerOutcome: 10, backendMemory: 1000, wholeMemory: 2000, redisCallsPerOutcome: 20, redisUsecPerOutcome: 30 },
      2: { cpuPerOutcome: 11.6, backendMemory: 2100, wholeMemory: 3100, redisCallsPerOutcome: 24, redisUsecPerOutcome: 36 },
      4: { cpuPerOutcome: 13, backendMemory: 4200, wholeMemory: 5200, redisCallsPerOutcome: 28, redisUsecPerOutcome: 42 }
    });
    const result = buildResourceGuardrails(summary, [10]);
    expect(result.complete).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.matchedCandidateRegressionThresholds.applicableAcrossReplicaScaleSteps).toBe(false);
    expect(result.scale['10n'].oneToTwo.matchedCandidateIndicators.wholeSystemCpu).toBe(false);
    expect(result.scale['10n'].oneToTwo.matchedCandidateIndicators.backendMemory).toBe(false);
    expect(result.scale['10n'].oneToTwo.scaleSafety.redisErrorsZero).toBe(true);
  });

  test('records normalized cross-replica resource ratios without treating them as same-topology promotion gates', () => {
    const result = buildResourceGuardrails(resourceSummary({
      1: { cpuPerOutcome: 10, backendMemory: 1000, wholeMemory: 2000 },
      2: { cpuPerOutcome: 12, backendMemory: 2400, wholeMemory: 2800 },
      4: { cpuPerOutcome: 14, backendMemory: 4800, wholeMemory: 3600 }
    }), [10]);
    expect(result.complete).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.scale['10n'].oneToTwo.wholeSystemCpuRatio).toBeCloseTo(1.2);
    expect(result.scale['10n'].oneToTwo.backendMemoryRatio).toBeCloseTo(2.4);
    expect(result.scale['10n'].oneToTwo.matchedCandidateIndicators.wholeSystemCpu).toBe(false);
    expect(result.scale['10n'].oneToTwo.matchedCandidateIndicators.backendMemory).toBe(false);
  });

  test('treats Redis failed or rejected calls as a hard Phase-2 resource failure', () => {
    const result = buildResourceGuardrails(resourceSummary({ 2: { failed: 1 } }), [10]);
    expect(result.passed).toBe(false);
    expect(result.scale['10n'].oneToTwo.scaleSafety.redisErrorsZero).toBe(false);
    expect(result.scale['10n'].twoToFour.scaleSafety.redisErrorsZero).toBe(false);
  });

  test('reports incomplete evidence below five measured windows', () => {
    const result = buildResourceGuardrails(resourceSummary({ 4: { samples: 4 } }), [10]);
    expect(result.complete).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.incompleteCases).toEqual([{ key: '4r-10n', successfulSamples: 4, required: 5 }]);
  });

  test('normalizes Redis work per completed outcome before comparing replica arms', () => {
    const smaller = {
      replicaCount: 1,
      wholeSystemCpuMsPerOutcomeP50: 10,
      backendMemoryCurrentAfterBytesP50: 100,
      wholeSystemMemoryCurrentAfterBytesP50: 200,
      redisCommandCallsPerOutcomeP50: 10,
      redisCommandUsecPerOutcomeP50: 20,
      redisFailedCallsTotal: 0,
      redisRejectedCallsTotal: 0
    };
    const larger = {
      replicaCount: 2,
      wholeSystemCpuMsPerOutcomeP50: 10,
      backendMemoryCurrentAfterBytesP50: 250,
      wholeSystemMemoryCurrentAfterBytesP50: 350,
      redisCommandCallsPerOutcomeP50: 11,
      redisCommandUsecPerOutcomeP50: 22,
      redisFailedCallsTotal: 0,
      redisRejectedCallsTotal: 0
    };
    const step = compareResourceStep(smaller, larger);
    expect(step.redisCommandCallsRatio).toBeCloseTo(1.1);
    expect(step.redisCommandUsecRatio).toBeCloseTo(1.1);
    expect(step.matchedCandidateIndicators.backendMemory).toBe(false);
    expect(step.passed).toBe(true);
  });

  test('rejects ambiguous zero baselines instead of manufacturing a favorable ratio', () => {
    const smaller = {
      replicaCount: 1,
      wholeSystemCpuMsPerOutcomeP50: 0,
      backendMemoryCurrentAfterBytesP50: 100,
      wholeSystemMemoryCurrentAfterBytesP50: 200,
      redisCommandCallsPerOutcomeP50: 10,
      redisCommandUsecPerOutcomeP50: 20,
      redisFailedCallsTotal: 0,
      redisRejectedCallsTotal: 0
    };
    const larger = { ...smaller, replicaCount: 2, wholeSystemCpuMsPerOutcomeP50: 1 };
    expect(() => compareResourceStep(smaller, larger)).toThrow(/cannot normalize against zero baseline/u);
  });

  test('CLI fails closed in evidence mode on a hard Phase-2 resource failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-resource-guardrails-'));
    try {
      const input = path.join(root, 'resource-summary.json');
      const output = path.join(root, 'guardrails.json');
      fs.writeFileSync(input, JSON.stringify(resourceSummary({ 2: { rejected: 1 } })));
      const script = path.resolve(__dirname, '../scripts/adsp-p2-horizontal-resource-guardrails.js');
      const evidence = spawnSync(process.execPath, [script, input, output], {
        env: { ...process.env, ADSP_P2_EVIDENCE_MODE: 'true' },
        encoding: 'utf8'
      });
      expect(evidence.status).toBe(2);
      expect(JSON.parse(fs.readFileSync(output, 'utf8')).passed).toBe(false);

      const smoke = spawnSync(process.execPath, [script, input, output], {
        env: { ...process.env, ADSP_P2_EVIDENCE_MODE: 'false' },
        encoding: 'utf8'
      });
      expect(smoke.status).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
