'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_CONCURRENCIES = [1, 2, 4, 8];
const REQUIRED_RECIPIENT_COUNTS = [1, 10, 100, 200, 1000];
const LARGE_CASES = [100, 200, 1000];
const MIN_MEASURED_SAMPLES = 3;
const MIN_LARGE_CASE_SPEEDUP = 1.1;
const MAX_WORK_DRIFT_PCT = 5;
const MAX_CPU_INCREASE_PCT = 10;

function readSummary(file) {
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!summary.complete) throw new Error(`Incomplete measurement summary: ${file}`);
  return summary;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

function percentDelta(value, baseline) {
  const r = ratio(value, baseline);
  return r === undefined ? undefined : (r - 1) * 100;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Missing finite ${label}`);
  return number;
}

function validateCasePair(current, baseline, concurrency, count) {
  const currentSamples = finite(current.samples, `concurrency ${concurrency} N=${count} samples`);
  const baselineSamples = finite(baseline.samples, `baseline N=${count} samples`);
  const currentSuccessful = finite(current.successfulSamples, `concurrency ${concurrency} N=${count} successfulSamples`);
  const baselineSuccessful = finite(baseline.successfulSamples, `baseline N=${count} successfulSamples`);
  const currentFailed = finite(current.failedSamples, `concurrency ${concurrency} N=${count} failedSamples`);
  const baselineFailed = finite(baseline.failedSamples, `baseline N=${count} failedSamples`);

  if (currentSamples < MIN_MEASURED_SAMPLES || baselineSamples < MIN_MEASURED_SAMPLES) {
    throw new Error(`N=${count} requires at least ${MIN_MEASURED_SAMPLES} measured samples per concurrency`);
  }
  if (currentSamples !== baselineSamples) {
    throw new Error(`Concurrency ${concurrency} N=${count} sample count ${currentSamples} does not match baseline ${baselineSamples}`);
  }
  if (currentFailed !== 0 || baselineFailed !== 0 || currentSuccessful !== currentSamples || baselineSuccessful !== baselineSamples) {
    throw new Error(`Concurrency ${concurrency} N=${count} contains failed or incomplete samples`);
  }
}

function candidateGate(cases) {
  const failures = [];
  for (const count of LARGE_CASES) {
    const current = cases[count];
    for (const [metric, value] of Object.entries({
      speedupVsC1: current.speedupVsC1,
      actionDeltaPctVsC1: current.actionDeltaPctVsC1,
      fusekiRequestDeltaPctVsC1: current.fusekiRequestDeltaPctVsC1,
      cpuDeltaPctVsC1: current.cpuDeltaPctVsC1
    })) {
      if (!Number.isFinite(value)) failures.push(`N=${count} ${metric} is not finite`);
    }
    if (!Number.isFinite(current.speedupVsC1) || !Number.isFinite(current.actionDeltaPctVsC1) ||
        !Number.isFinite(current.fusekiRequestDeltaPctVsC1) || !Number.isFinite(current.cpuDeltaPctVsC1)) continue;
    if (current.speedupVsC1 < MIN_LARGE_CASE_SPEEDUP) {
      failures.push(`N=${count} speedup ${current.speedupVsC1.toFixed(3)}x is below ${MIN_LARGE_CASE_SPEEDUP}x`);
    }
    if (Math.abs(current.actionDeltaPctVsC1) > MAX_WORK_DRIFT_PCT) {
      failures.push(`N=${count} nested action drift ${current.actionDeltaPctVsC1.toFixed(2)}% exceeds ${MAX_WORK_DRIFT_PCT}%`);
    }
    if (Math.abs(current.fusekiRequestDeltaPctVsC1) > MAX_WORK_DRIFT_PCT) {
      failures.push(`N=${count} Fuseki request drift ${current.fusekiRequestDeltaPctVsC1.toFixed(2)}% exceeds ${MAX_WORK_DRIFT_PCT}%`);
    }
    if (current.cpuDeltaPctVsC1 > MAX_CPU_INCREASE_PCT) {
      failures.push(`N=${count} CPU increase ${current.cpuDeltaPctVsC1.toFixed(2)}% exceeds ${MAX_CPU_INCREASE_PCT}%`);
    }
  }
  return { eligible: failures.length === 0, failures };
}

function compare(summaries) {
  const baseline = summaries['1'];
  if (!baseline) throw new Error('Concurrency 1 baseline is required');

  const result = {
    phase: 'APDM-P9-A',
    generatedAt: new Date().toISOString(),
    concurrencies: {},
    baselineConcurrency: 1,
    requiredRecipientCounts: REQUIRED_RECIPIENT_COUNTS,
    selectionPolicy: {
      minimumMeasuredSamples: MIN_MEASURED_SAMPLES,
      largeCases: LARGE_CASES,
      minimumLargeCaseSpeedup: MIN_LARGE_CASE_SPEEDUP,
      maximumAbsoluteWorkDriftPct: MAX_WORK_DRIFT_PCT,
      maximumCpuIncreasePct: MAX_CPU_INCREASE_PCT,
      rule: 'Choose the smallest concurrency above 1 that passes every large-case gate; heap remains manual review.'
    },
    recommendedCandidate: null,
    recommendationRequiresHumanResourceReview: true
  };

  for (const concurrency of REQUIRED_CONCURRENCIES) {
    const summary = summaries[String(concurrency)];
    if (!summary) throw new Error(`Missing concurrency ${concurrency} summary`);
    const cases = {};

    for (const count of REQUIRED_RECIPIENT_COUNTS) {
      const current = summary.cases?.[String(count)];
      const base = baseline.cases?.[String(count)];
      if (!current || !base) throw new Error(`Missing N=${count} case for concurrency ${concurrency}`);
      validateCasePair(current, base, concurrency, count);

      const speedupVsC1 = ratio(
        finite(base.elapsedMs?.mean, `baseline N=${count} elapsed mean`),
        finite(current.elapsedMs?.mean, `concurrency ${concurrency} N=${count} elapsed mean`)
      );
      const cpuDeltaPctVsC1 = percentDelta(
        finite(current.cpuMs?.mean, `concurrency ${concurrency} N=${count} CPU mean`),
        finite(base.cpuMs?.mean, `baseline N=${count} CPU mean`)
      );
      const actionDeltaPctVsC1 = percentDelta(
        finite(current.actionCount?.mean, `concurrency ${concurrency} N=${count} action mean`),
        finite(base.actionCount?.mean, `baseline N=${count} action mean`)
      );
      const fusekiRequestDeltaPctVsC1 = percentDelta(
        finite(current.fusekiRequestCount?.mean, `concurrency ${concurrency} N=${count} Fuseki mean`),
        finite(base.fusekiRequestCount?.mean, `baseline N=${count} Fuseki mean`)
      );

      cases[count] = {
        samples: current.samples,
        elapsedMs: current.elapsedMs,
        cpuMs: current.cpuMs,
        heapUsedDeltaBytes: current.heapUsedDeltaBytes,
        actionCount: current.actionCount,
        fusekiRequestCount: current.fusekiRequestCount,
        speedupVsC1,
        cpuDeltaPctVsC1,
        actionDeltaPctVsC1,
        fusekiRequestDeltaPctVsC1
      };
    }

    const gate = concurrency === 1 ? { eligible: false, failures: ['baseline candidate'] } : candidateGate(cases);
    result.concurrencies[concurrency] = { cases, measuredModels: summary.measuredModels, selectionGate: gate };
  }

  result.recommendedCandidate = REQUIRED_CONCURRENCIES.filter(concurrency => concurrency > 1).find(
    concurrency => result.concurrencies[concurrency].selectionGate.eligible
  ) || null;
  return result;
}

function renderMarkdown(comparison) {
  const lines = [
    '# APDM Phase 9 bounded-concurrency comparison', '',
    '| concurrency | N=100 mean | speedup | N=200 mean | speedup | N=1000 mean | speedup | selection |',
    '|---:|---:|---:|---:|---:|---:|---:|:---|'
  ];
  for (const concurrency of REQUIRED_CONCURRENCIES) {
    const entry = comparison.concurrencies[concurrency];
    const cases = entry.cases;
    const cell = count => `${(cases[count].elapsedMs.mean / 1000).toFixed(2)}s`;
    const speed = count => Number.isFinite(cases[count].speedupVsC1) ? `${cases[count].speedupVsC1.toFixed(2)}x` : 'invalid';
    const selection = concurrency === 1 ? 'baseline' : entry.selectionGate.eligible ? 'eligible' : 'rejected';
    lines.push(`| ${concurrency} | ${cell(100)} | ${speed(100)} | ${cell(200)} | ${speed(200)} | ${cell(1000)} | ${speed(1000)} | ${selection} |`);
  }
  lines.push('', `Automated candidate: **${comparison.recommendedCandidate === null ? 'none' : comparison.recommendedCandidate}**.`, '',
    'This is decision support, not automatic production promotion. CPU, heap, elapsed-time distribution, datastore pressure, and semantic invariants still require explicit human review.', '',
    'Concurrency is a scheduling optimization; material action/Fuseki work-count drift is treated as an invariant warning rather than an optimization.');
  for (const concurrency of REQUIRED_CONCURRENCIES.filter(value => value > 1)) {
    const failures = comparison.concurrencies[concurrency].selectionGate.failures;
    if (failures.length > 0) {
      lines.push('', `### c${concurrency} rejection reasons`, '');
      for (const failure of failures) lines.push(`- ${failure}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length < 6) throw new Error('Usage: node apdm-phase9-compare.js c1.json c2.json c4.json c8.json output.json output.md');
  const summaries = {};
  REQUIRED_CONCURRENCIES.forEach((concurrency, index) => { summaries[String(concurrency)] = readSummary(path.resolve(argv[index])); });
  const comparison = compare(summaries);
  const jsonPath = path.resolve(argv[4]);
  const markdownPath = path.resolve(argv[5]);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(comparison), 'utf8');
  process.stdout.write(renderMarkdown(comparison));
}

if (require.main === module) main();

module.exports = {
  LARGE_CASES,
  MAX_CPU_INCREASE_PCT,
  MAX_WORK_DRIFT_PCT,
  MIN_LARGE_CASE_SPEEDUP,
  MIN_MEASURED_SAMPLES,
  REQUIRED_CONCURRENCIES,
  REQUIRED_RECIPIENT_COUNTS,
  candidateGate,
  compare,
  percentDelta,
  ratio,
  renderMarkdown,
  validateCasePair
};
