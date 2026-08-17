'use strict';

const fs = require('fs');
const path = require('path');

const COUNTS = [1, 10, 100, 200, 1000];
const MAX_N1000_ELAPSED_OVERHEAD_PERCENT = 10;
const MAX_N1000_CPU_OVERHEAD_PERCENT = 15;

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

function compare(control, attributed) {
  const failures = [];
  const cases = {};
  for (const count of COUNTS) {
    const off = control.cases?.[String(count)];
    const on = attributed.cases?.[String(count)];
    if (!off || !on) throw new Error(`Missing N=${count}`);
    if (off.samples !== on.samples || off.samples < 3) failures.push(`N=${count} requires matched >=3 samples`);
    if (off.failedSamples !== 0 || on.failedSamples !== 0) failures.push(`N=${count} contains failed delivery samples`);

    const metrics = {
      elapsedMs: [finite(off.elapsedMs?.mean, 'control elapsed'), finite(on.elapsedMs?.mean, 'attributed elapsed')],
      cpuMs: [finite(off.cpuMs?.mean, 'control CPU'), finite(on.cpuMs?.mean, 'attributed CPU')],
      heapUsedDeltaBytes: [finite(off.heapUsedDeltaBytes?.mean, 'control heap'), finite(on.heapUsedDeltaBytes?.mean, 'attributed heap')],
      actionCount: [finite(off.actionCount?.mean, 'control actions'), finite(on.actionCount?.mean, 'attributed actions')],
      fusekiRequestCount: [finite(off.fusekiRequestCount?.mean, 'control Fuseki'), finite(on.fusekiRequestCount?.mean, 'attributed Fuseki')]
    };
    cases[count] = Object.fromEntries(Object.entries(metrics).map(([name, [baseline, enabled]]) => [name, {
      control: baseline,
      attributed: enabled,
      deltaPercent: deltaPercent(enabled, baseline)
    }]));
  }

  const n1000 = cases[1000];
  if (n1000.elapsedMs.deltaPercent > MAX_N1000_ELAPSED_OVERHEAD_PERCENT) {
    failures.push(`N=1000 attribution elapsed overhead ${n1000.elapsedMs.deltaPercent.toFixed(1)}% exceeds ${MAX_N1000_ELAPSED_OVERHEAD_PERCENT}%`);
  }
  if (n1000.cpuMs.deltaPercent > MAX_N1000_CPU_OVERHEAD_PERCENT) {
    failures.push(`N=1000 attribution CPU overhead ${n1000.cpuMs.deltaPercent.toFixed(1)}% exceeds ${MAX_N1000_CPU_OVERHEAD_PERCENT}%`);
  }
  if (Math.abs(n1000.actionCount.deltaPercent) > 0.01 || Math.abs(n1000.fusekiRequestCount.deltaPercent) > 0.01) {
    failures.push('N=1000 attribution changed action/Fuseki request counts; instrumentation is not observational');
  }

  return {
    version: 1,
    phase: 'APDM-P11-A',
    generatedAt: new Date().toISOString(),
    limits: { maxN1000ElapsedOverheadPercent: MAX_N1000_ELAPSED_OVERHEAD_PERCENT, maxN1000CpuOverheadPercent: MAX_N1000_CPU_OVERHEAD_PERCENT },
    cases,
    gate: { passed: failures.length === 0, failures }
  };
}

function render(result) {
  const lines = [
    '# APDM Phase 11 attribution overhead', '',
    `Observational-overhead gate: **${result.gate.passed ? 'PASS' : 'FAIL'}**`, '',
    '| N | elapsed Δ | CPU Δ | actions Δ | Fuseki Δ |',
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
module.exports = { COUNTS, MAX_N1000_CPU_OVERHEAD_PERCENT, MAX_N1000_ELAPSED_OVERHEAD_PERCENT, compare, deltaPercent, render };
