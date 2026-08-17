'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_RECIPIENT_COUNTS = [1, 10, 100, 200, 1000];
const DATASET_EXIST_ACTION = 'triplestore.dataset.exist';
const LARGE_CASES = [100, 200, 1000];
const MIN_DATASET_REGISTRY_REDUCTION = 0.5;
const MIN_MEASURED_SAMPLES = 3;
const DATASET_REGISTRY_GET = /^GET \/\$\/datasets\/[^/?#]+\/?$/u;

function readSummary(file) {
  const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!summary.complete) throw new Error(`Incomplete measurement summary: ${file}`);
  return summary;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Missing finite ${label}`);
  return number;
}

function meanAggregatedCount(caseSummary, counts, label) {
  const successfulSamples = finite(caseSummary.successfulSamples, 'successfulSamples');
  if (successfulSamples <= 0) throw new Error('successfulSamples must be positive');
  return finite(counts, label) / successfulSamples;
}

function meanActionCount(caseSummary, actionName) {
  return meanAggregatedCount(caseSummary, caseSummary.actionCounts?.[actionName] || 0, `${actionName} count`);
}

function meanDatasetRegistryRequests(caseSummary) {
  const total = Object.entries(caseSummary.fusekiRequestKeyCounts || {}).reduce((sum, [requestKey, count]) => {
    return DATASET_REGISTRY_GET.test(requestKey) ? sum + Number(count || 0) : sum;
  }, 0);
  return meanAggregatedCount(caseSummary, total, 'Fuseki dataset registry GET count');
}

function percentDelta(value, baseline) {
  if (baseline === 0) return value === 0 ? 0 : undefined;
  return ((value / baseline) - 1) * 100;
}

function validateMatchedSamples(off, on, count, failures) {
  const offSamples = finite(off.samples, `control N=${count} samples`);
  const onSamples = finite(on.samples, `enabled N=${count} samples`);
  const offSuccessful = finite(off.successfulSamples, `control N=${count} successfulSamples`);
  const onSuccessful = finite(on.successfulSamples, `enabled N=${count} successfulSamples`);
  const offFailed = finite(off.failedSamples, `control N=${count} failedSamples`);
  const onFailed = finite(on.failedSamples, `enabled N=${count} failedSamples`);

  if (offSamples !== onSamples) failures.push(`N=${count} has unmatched sample counts (${offSamples} control vs ${onSamples} enabled)`);
  if (offSamples < MIN_MEASURED_SAMPLES || onSamples < MIN_MEASURED_SAMPLES) {
    failures.push(`N=${count} requires at least ${MIN_MEASURED_SAMPLES} measured samples per arm`);
  }
  if (offFailed !== 0 || onFailed !== 0 || offSuccessful !== offSamples || onSuccessful !== onSamples) {
    failures.push(`N=${count} requires all measured samples to succeed`);
  }
}

function compare(control, enabled) {
  const result = {
    phase: 'APDM-P10-A',
    generatedAt: new Date().toISOString(),
    requiredRecipientCounts: REQUIRED_RECIPIENT_COUNTS,
    minimumMeasuredSamplesPerArm: MIN_MEASURED_SAMPLES,
    datasetExistAction: DATASET_EXIST_ACTION,
    datasetRegistryGetPattern: DATASET_REGISTRY_GET.source,
    minimumLargeCaseDatasetRegistryReduction: MIN_DATASET_REGISTRY_REDUCTION,
    cases: {},
    gate: {
      scope: 'mechanism-and-delivery-correctness',
      passed: true,
      requiresManualResourceReview: true,
      failures: []
    }
  };

  for (const count of REQUIRED_RECIPIENT_COUNTS) {
    const off = control.cases?.[String(count)];
    const on = enabled.cases?.[String(count)];
    if (!off || !on) throw new Error(`Missing N=${count} case`);

    validateMatchedSamples(off, on, count, result.gate.failures);

    // Action counts are diagnostic only. Moleculer middleware can observe the
    // attempted dataset.exist invocation even when the APDM memo short-circuits
    // before the underlying SemApps handler reaches Fuseki. Correlated real
    // GET /$/datasets/{dataset} HTTP requests are the authoritative signal.
    const offDatasetExistAction = meanActionCount(off, DATASET_EXIST_ACTION);
    const onDatasetExistAction = meanActionCount(on, DATASET_EXIST_ACTION);
    const offDatasetRegistry = meanDatasetRegistryRequests(off);
    const onDatasetRegistry = meanDatasetRegistryRequests(on);
    const datasetRegistryReduction = offDatasetRegistry === 0 ? 0 : 1 - onDatasetRegistry / offDatasetRegistry;

    const offFuseki = finite(off.fusekiRequestCount?.mean, `control N=${count} Fuseki mean`);
    const onFuseki = finite(on.fusekiRequestCount?.mean, `enabled N=${count} Fuseki mean`);

    result.cases[count] = {
      sampleCounts: {
        control: finite(off.samples, `control N=${count} samples`),
        enabled: finite(on.samples, `enabled N=${count} samples`)
      },
      control: {
        elapsedMs: finite(off.elapsedMs?.mean, `control N=${count} elapsed mean`),
        cpuMs: finite(off.cpuMs?.mean, `control N=${count} CPU mean`),
        heapUsedDeltaBytes: finite(off.heapUsedDeltaBytes?.mean, `control N=${count} heap mean`),
        actionCount: finite(off.actionCount?.mean, `control N=${count} action mean`),
        fusekiRequestCount: offFuseki,
        datasetRegistryRequestCount: offDatasetRegistry,
        datasetExistActionCount: offDatasetExistAction
      },
      enabled: {
        elapsedMs: finite(on.elapsedMs?.mean, `enabled N=${count} elapsed mean`),
        cpuMs: finite(on.cpuMs?.mean, `enabled N=${count} CPU mean`),
        heapUsedDeltaBytes: finite(on.heapUsedDeltaBytes?.mean, `enabled N=${count} heap mean`),
        actionCount: finite(on.actionCount?.mean, `enabled N=${count} action mean`),
        fusekiRequestCount: onFuseki,
        datasetRegistryRequestCount: onDatasetRegistry,
        datasetExistActionCount: onDatasetExistAction
      },
      deltas: {
        elapsedPercent: percentDelta(on.elapsedMs.mean, off.elapsedMs.mean),
        cpuPercent: percentDelta(on.cpuMs.mean, off.cpuMs.mean),
        heapUsedDeltaPercent: percentDelta(on.heapUsedDeltaBytes.mean, off.heapUsedDeltaBytes.mean),
        actionCountPercent: percentDelta(on.actionCount.mean, off.actionCount.mean),
        fusekiRequestCountPercent: percentDelta(onFuseki, offFuseki),
        datasetRegistryRequestCountPercent: percentDelta(onDatasetRegistry, offDatasetRegistry),
        datasetRegistryReduction,
        datasetExistActionCountPercent: percentDelta(onDatasetExistAction, offDatasetExistAction)
      }
    };

    if (LARGE_CASES.includes(count)) {
      if (offDatasetRegistry <= 0) {
        result.gate.failures.push(`N=${count} control has no Fuseki GET /$/datasets/{dataset} requests`);
      } else if (datasetRegistryReduction < MIN_DATASET_REGISTRY_REDUCTION) {
        result.gate.failures.push(
          `N=${count} reduced Fuseki dataset-registry GETs by only ${(datasetRegistryReduction * 100).toFixed(1)}%`
        );
      }

      if (!(onFuseki < offFuseki)) {
        result.gate.failures.push(`N=${count} did not reduce total Fuseki HTTP requests`);
      }
    }
  }

  result.gate.passed = result.gate.failures.length === 0;
  return result;
}

function renderMarkdown(result) {
  const lines = [
    '# APDM Phase 10 dataset-existence memo comparison',
    '',
    `Mechanism/delivery gate: **${result.gate.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '> This automated gate is not production promotion approval. CPU, heap, latency, and overall resource pressure still require explicit review.',
    '',
    '| N | samples off/on | registry GET off | registry GET on | reduction | dataset.exist actions off/on | Fuseki off | Fuseki on | elapsed Δ |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];

  for (const count of REQUIRED_RECIPIENT_COUNTS) {
    const current = result.cases[count];
    lines.push(
      `| ${count} | ${current.sampleCounts.control}/${current.sampleCounts.enabled} | ${current.control.datasetRegistryRequestCount.toFixed(1)} | ${current.enabled.datasetRegistryRequestCount.toFixed(1)} | ${(current.deltas.datasetRegistryReduction * 100).toFixed(1)}% | ${current.control.datasetExistActionCount.toFixed(1)}/${current.enabled.datasetExistActionCount.toFixed(1)} | ${current.control.fusekiRequestCount.toFixed(1)} | ${current.enabled.fusekiRequestCount.toFixed(1)} | ${current.deltas.elapsedPercent.toFixed(1)}% |`
    );
  }

  if (result.gate.failures.length > 0) {
    lines.push('', '## Gate failures', '');
    for (const failure of result.gate.failures) lines.push(`- ${failure}`);
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  if (argv.length < 4) {
    throw new Error('Usage: apdm-phase10-compare.js <control-summary> <enabled-summary> <output.json> <output.md>');
  }

  const [controlPath, enabledPath, jsonPath, markdownPath] = argv.map(value => path.resolve(value));
  const result = compare(readSummary(controlPath), readSummary(enabledPath));

  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, renderMarkdown(result), 'utf8');

  if (!result.gate.passed) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = {
  DATASET_EXIST_ACTION,
  DATASET_REGISTRY_GET,
  LARGE_CASES,
  MIN_DATASET_REGISTRY_REDUCTION,
  MIN_MEASURED_SAMPLES,
  REQUIRED_RECIPIENT_COUNTS,
  compare,
  meanActionCount,
  meanDatasetRegistryRequests,
  percentDelta,
  readSummary,
  renderMarkdown,
  validateMatchedSamples
};
