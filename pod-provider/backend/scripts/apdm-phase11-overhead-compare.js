'use strict';

const fs = require('fs');
const path = require('path');

const COUNTS = [1, 10, 100, 200, 1000];
const MAX_N1000_ELAPSED_DRIFT_PERCENT = 10;
const MAX_N1000_CPU_DRIFT_PERCENT = 15;

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Missing finite ${label}`);
  return number;
}

function deltaPercent(enabled, control) {
  if (control === 0) return enabled === 0 ? 0 : null;
  return ((enabled / control) - 1) * 100;
}

function load(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value.complete) throw new Error(`Incomplete APDM summary ${filePath}`);
  return value;
}

function metricPair(off, on, field, statistic, label) {
  return [
    finite(off[field]?.[statistic], `control ${label} ${statistic}`),
    finite(on[field]?.[statistic], `attributed ${label} ${statistic}`)
  ];
}

function compare(control, attributed) {
  const failures = [];
  const cases = {};
  for (const count of COUNTS) {
    const off = control.cases?.[String(count)];
    const on = attributed.cases?.[String(count)];
    if (!off || !on) throw new Error(`Missing N=${count}`);
    if (off.samples !== on.samples || off.samples < 3) failures.push(`N=${count} requires matched >=3 samples`);
    if (off.failedSamples !== 0 || on.failedSamples !== 0) failures.push(`N=${count} contains failed delivery samples`);
    if (off.successfulSamples !== off.samples || on.successfulSamples !== on.samples) {
      failures.push(`N=${count} requires every measured sample to succeed`);
    }

    const metrics = {
      elapsedMs: metricPair(off, on, 'elapsedMs', 'p50', 'elapsed'),
      cpuMs: metricPair(off, on, 'cpuMs', 'p50', 'CPU'),
      heapUsedDeltaBytes: metricPair(off, on, 'heapUsedDeltaBytes', 'p50', 'heap'),
      actionCount: metricPair(off, on, 'actionCount', 'mean', 'actions'),
      fusekiRequestCount: metricPair(off, on, 'fusekiRequestCount', 'mean', 'Fuseki')
    };
    cases[count] = Object.fromEntries(Object.entries(metrics).map(([name, [baseline, enabled]]) => [name, {
      control: baseline,
      attributed: enabled,
      deltaPercent: deltaPercent(enabled, baseline)
    }]));
  }

  const n1000 = cases[1000];
  if (Math.abs(n1000.elapsedMs.deltaPercent) > MAX_N1000_ELAPSED_DRIFT_PERCENT) {
    failures.push(
      `N=1000 attribution elapsed p50 drift ${n1000.elapsedMs.deltaPercent.toFixed(1)}% exceeds ±${MAX_N1000_ELAPSED_DRIFT_PERCENT}%`
    );
  }
  if (Math.abs(n1000.cpuMs.deltaPercent) > MAX_N1000_CPU_DRIFT_PERCENT) {
    failures.push(
      `N=1000 attribution CPU p50 drift ${n1000.cpuMs.deltaPercent.toFixed(1)}% exceeds ±${MAX_N1000_CPU_DRIFT_PERCENT}%`
    );
  }
  if (Math.abs(n1000.actionCount.deltaPercent) > 0.01 || Math.abs(n1000.fusekiRequestCount.deltaPercent) > 0.01) {
    failures.push('N=1000 attribution changed action/Fuseki request counts; instrumentation is not observational');
  }

  return {
    version: 1,
    phase: 'APDM-P11-A',
    generatedAt: new Date().toISOString(),
    statistics: {
      elapsedMs: 'p50',
      cpuMs: 'p50',
      heapUsedDeltaBytes: 'p50',
      actionCount: 'mean',
      fusekiRequestCount: 'mean'
    },
    limits: {
      maxAbsN1000ElapsedDriftPercent: MAX_N1000_ELAPSED_DRIFT_PERCENT,
      maxAbsN1000CpuDriftPercent: MAX_N1000_CPU_DRIFT_PERCENT
    },
    cases,
    gate: { passed: failures.length === 0, failures }
  };
}

function render(result) {
  const lines = [
    '# APDM Phase 11 attribution overhead', '',
    `Observational-overhead gate: **${result.gate.passed ? 'PASS' : 'FAIL'}**`, '',
    '> Elapsed and CPU use p50. Large apparent speedups are rejected as drift just like slowdowns; instrumentation cannot legitimately make the measured delivery path materially faster.',
    '',
    '| N | elapsed p50 Δ | CPU p50 Δ | actions mean Δ | Fuseki mean Δ |',
    '|---:|---:|---:|---:|---:|'
  ];
  for (const count of COUNTS) {
    const item = result.cases[count];
    lines.push(`| ${count} | ${item.elapsedMs.deltaPercent.toFixed(1)}% | ${item.cpuMs.deltaPercent.toFixed(1)}% | ${item.actionCount.deltaPercent.toFixed(2)}% | ${item.fusekiRequestCount.deltaPercent.toFixed(2)}% |`);
  }
  if (result.gate.failures.length) lines.push('', '## Failures', '', ...result.gate.failures.map(value => `- ${value}`));
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 4) throw new Error('Usage: apdm-phase11-overhead-compare.js CONTROL ATTRIBUTED OUTPUT_JSON OUTPUT_MD');
  const [controlPath, attributedPath, outputJson, outputMd] = argv.map(value => path.resolve(value));
  const result = compare(load(controlPath), load(attributedPath));
  fs.writeFileSync(outputJson, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(outputMd, render(result), 'utf8');
  if (!result.gate.passed) process.exitCode = 2;
}

if (require.main === module) main();
module.exports = {
  COUNTS,
  MAX_N1000_CPU_DRIFT_PERCENT,
  MAX_N1000_ELAPSED_DRIFT_PERCENT,
  compare,
  deltaPercent,
  metricPair,
  render
};
