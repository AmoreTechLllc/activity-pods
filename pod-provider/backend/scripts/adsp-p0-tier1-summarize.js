'use strict';

const fs = require('fs');
const path = require('path');
const {
  REQUIRED_RECIPIENT_COUNTS,
  isSuccessfulRecord,
  mean,
  parseJsonLines,
  percentile
} = require('./apdm-phase8-summarize');

const DEFAULT_MIN_SAMPLES = 5;

function finiteValues(records, selector) {
  return records.map(selector).map(Number).filter(Number.isFinite);
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return undefined;
  const average = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function coefficientOfVariation(values) {
  const average = mean(values);
  const stddev = sampleStandardDeviation(values);
  if (!Number.isFinite(average) || average === 0 || !Number.isFinite(stddev)) return undefined;
  return stddev / Math.abs(average);
}

function metricVariance(values) {
  if (values.length === 0) {
    return {
      samples: 0,
      mean: undefined,
      stddev: undefined,
      coefficientOfVariation: undefined,
      min: undefined,
      p50: undefined,
      p95: undefined,
      p99: undefined,
      max: undefined
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    mean: mean(values),
    stddev: sampleStandardDeviation(values),
    coefficientOfVariation: coefficientOfVariation(values),
    min: sorted[0],
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: sorted[sorted.length - 1]
  };
}

function normalizePerRecipient(values, recipientCount) {
  if (!Number.isInteger(recipientCount) || recipientCount <= 0) return [];
  return values.map(value => value / recipientCount);
}

function summarizeCase(records, recipientCount) {
  const successful = records.filter(isSuccessfulRecord);
  const elapsedMs = finiteValues(successful, record => record.elapsedMs);
  const cpuMs = finiteValues(successful, record => Number(record.cpuUserMs || 0) + Number(record.cpuSystemMs || 0));
  const rssEndBytes = finiteValues(successful, record => record.rssEnd);
  const actionCount = finiteValues(successful, record => record.actionCount);
  const fusekiRequestCount = finiteValues(successful, record => record.fuseki?.requestCount);

  return {
    recipientCount,
    samples: records.length,
    successfulSamples: successful.length,
    failedSamples: records.length - successful.length,
    variance: {
      elapsedMs: metricVariance(elapsedMs),
      cpuMs: metricVariance(cpuMs),
      rssEndBytes: metricVariance(rssEndBytes),
      actionCount: metricVariance(actionCount),
      fusekiRequestCount: metricVariance(fusekiRequestCount)
    },
    normalizedPerRecipient: {
      elapsedMs: metricVariance(normalizePerRecipient(elapsedMs, recipientCount)),
      cpuMs: metricVariance(normalizePerRecipient(cpuMs, recipientCount)),
      actionCount: metricVariance(normalizePerRecipient(actionCount, recipientCount)),
      fusekiRequestCount: metricVariance(normalizePerRecipient(fusekiRequestCount, recipientCount))
    }
  };
}

function summarizeAdspTier1(records, { minSamples = DEFAULT_MIN_SAMPLES, provenance } = {}) {
  if (!Number.isInteger(minSamples) || minSamples < 2) throw new Error('minSamples must be an integer >= 2');

  const phaseRecords = records.filter(record => record?.phase === 'APDM-P8-A');
  const byCount = new Map(REQUIRED_RECIPIENT_COUNTS.map(count => [count, []]));

  for (const record of phaseRecords) {
    const count = Number(record.recipientCount);
    if (byCount.has(count)) byCount.get(count).push(record);
  }

  const cases = {};
  const incompleteCases = [];
  let totalFailedSamples = 0;

  for (const count of REQUIRED_RECIPIENT_COUNTS) {
    const caseSummary = summarizeCase(byCount.get(count), count);
    cases[count] = caseSummary;
    totalFailedSamples += caseSummary.failedSamples;
    if (caseSummary.successfulSamples < minSamples) {
      incompleteCases.push({
        recipientCount: count,
        successfulSamples: caseSummary.successfulSamples,
        requiredSuccessfulSamples: minSamples
      });
    }
  }

  return {
    version: 1,
    phase: 'ADSP-P0-A',
    fixture: 'tier1-local-fanout',
    sourceInstrumentationPhase: 'APDM-P8-A',
    generatedAt: new Date().toISOString(),
    scope: {
      activityPodsTier1: true,
      federationSidecar: false,
      note: 'Local-fanout baseline only. Sidecar/remote-delivery cost requires the separate ADSP mixed/remote fixture.'
    },
    minSuccessfulSamplesPerCase: minSamples,
    requiredRecipientCounts: REQUIRED_RECIPIENT_COUNTS,
    totalRecords: phaseRecords.length,
    totalFailedSamples,
    incompleteCases,
    complete: incompleteCases.length === 0 && totalFailedSamples === 0,
    provenance: provenance || null,
    cases
  };
}

function main(argv = process.argv.slice(2)) {
  const inputPath = path.resolve(argv[0] || 'measurements/adsp-p0-tier1-all.jsonl');
  const outputPath = path.resolve(argv[1] || 'measurements/adsp-p0-tier1-summary.json');
  const provenancePath = argv[2] ? path.resolve(argv[2]) : undefined;
  const minSamples = Number(process.env.ADSP_P0_MIN_SAMPLES || DEFAULT_MIN_SAMPLES);

  const records = parseJsonLines(fs.readFileSync(inputPath, 'utf8'));
  const provenance = provenancePath ? JSON.parse(fs.readFileSync(provenancePath, 'utf8')) : undefined;
  const summary = summarizeAdspTier1(records, { minSamples, provenance });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  if (!summary.complete) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = {
  DEFAULT_MIN_SAMPLES,
  coefficientOfVariation,
  metricVariance,
  sampleStandardDeviation,
  summarizeAdspTier1,
  summarizeCase
};
