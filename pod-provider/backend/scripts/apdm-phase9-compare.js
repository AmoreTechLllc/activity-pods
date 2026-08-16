'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_CONCURRENCIES = [1, 2, 4, 8];
const REQUIRED_RECIPIENT_COUNTS = [1, 10, 100, 200, 1000];

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

function compare(summaries) {
  const baseline = summaries['1'];
  if (!baseline) throw new Error('Concurrency 1 baseline is required');

  const result = {
    phase: 'APDM-P9-A',
    generatedAt: new Date().toISOString(),
    concurrencies: {},
    baselineConcurrency: 1,
    requiredRecipientCounts: REQUIRED_RECIPIENT_COUNTS
  };

  for (const concurrency of REQUIRED_CONCURRENCIES) {
    const summary = summaries[String(concurrency)];
    if (!summary) throw new Error(`Missing concurrency ${concurrency} summary`);
    const cases = {};

    for (const count of REQUIRED_RECIPIENT_COUNTS) {
      const current = summary.cases?.[String(count)];
      const base = baseline.cases?.[String(count)];
      if (!current || !base) throw new Error(`Missing N=${count} case for concurrency ${concurrency}`);
      if (current.failedSamples !== 0) throw new Error(`Concurrency ${concurrency} N=${count} has failed samples`);

      cases[count] = {
        elapsedMs: current.elapsedMs,
        cpuMs: current.cpuMs,
        heapUsedDeltaBytes: current.heapUsedDeltaBytes,
        actionCount: current.actionCount,
        fusekiRequestCount: current.fusekiRequestCount,
        speedupVsC1: ratio(base.elapsedMs.mean, current.elapsedMs.mean),
        cpuDeltaPctVsC1: percentDelta(current.cpuMs.mean, base.cpuMs.mean),
        actionDeltaPctVsC1: percentDelta(current.actionCount.mean, base.actionCount.mean),
        fusekiRequestDeltaPctVsC1: percentDelta(current.fusekiRequestCount.mean, base.fusekiRequestCount.mean)
      };
    }

    result.concurrencies[concurrency] = {
      cases,
      measuredModels: summary.measuredModels
    };
  }

  return result;
}

function renderMarkdown(comparison) {
  const lines = [
    '# APDM Phase 9 bounded-concurrency comparison',
    '',
    '| concurrency | N=100 mean | speedup | N=200 mean | speedup | N=1000 mean | speedup |',
    '|---:|---:|---:|---:|---:|---:|---:|'
  ];

  for (const concurrency of REQUIRED_CONCURRENCIES) {
    const cases = comparison.concurrencies[concurrency].cases;
    const cell = count => `${(cases[count].elapsedMs.mean / 1000).toFixed(2)}s`;
    const speed = count => `${cases[count].speedupVsC1.toFixed(2)}x`;
    lines.push(`| ${concurrency} | ${cell(100)} | ${speed(100)} | ${cell(200)} | ${speed(200)} | ${cell(1000)} | ${speed(1000)} |`);
  }

  lines.push('', 'Resource-work invariants are reported in the JSON output; concurrency should reduce wall-clock latency without materially increasing nested action or Fuseki request counts.');
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length < 6) {
    throw new Error('Usage: node apdm-phase9-compare.js c1.json c2.json c4.json c8.json output.json output.md');
  }

  const summaries = {};
  REQUIRED_CONCURRENCIES.forEach((concurrency, index) => {
    summaries[String(concurrency)] = readSummary(path.resolve(argv[index]));
  });

  const comparison = compare(summaries);
  const jsonPath = path.resolve(argv[4]);
  const markdownPath = path.resolve(argv[5]);
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdown(comparison), 'utf8');
  process.stdout.write(renderMarkdown(comparison));
}

if (require.main === module) main();

module.exports = { REQUIRED_CONCURRENCIES, REQUIRED_RECIPIENT_COUNTS, compare, percentDelta, ratio, renderMarkdown };
