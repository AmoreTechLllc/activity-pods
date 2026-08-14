'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_RECIPIENT_COUNTS = [1, 10, 100, 200, 1000];

function parseJsonLines(source) {
  return source
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL record at line ${index + 1}: ${error.message}`);
      }
    });
}

function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function mean(values) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregateCounts(records, field) {
  const result = Object.create(null);
  for (const record of records) {
    const values = record[field] || {};
    for (const [key, value] of Object.entries(values)) {
      result[key] = (result[key] || 0) + Number(value || 0);
    }
  }
  return result;
}

function isSuccessfulRecord(record) {
  return !Array.isArray(record.errors) || record.errors.length === 0;
}

function summarizeRecipientCase(records) {
  const successfulRecords = records.filter(isSuccessfulRecord);
  const elapsed = successfulRecords.map(record => Number(record.elapsedMs)).filter(Number.isFinite);
  const cpu = successfulRecords
    .map(record => Number(record.cpuUserMs || 0) + Number(record.cpuSystemMs || 0))
    .filter(Number.isFinite);
  const heapDelta = successfulRecords.map(record => Number(record.heapUsedDelta)).filter(Number.isFinite);
  const actionCounts = successfulRecords.map(record => Number(record.actionCount)).filter(Number.isFinite);
  const fusekiCounts = successfulRecords
    .map(record => Number(record.fuseki && record.fuseki.requestCount))
    .filter(Number.isFinite);

  return {
    samples: records.length,
    successfulSamples: successfulRecords.length,
    failedSamples: records.length - successfulRecords.length,
    elapsedMs: {
      mean: mean(elapsed),
      p50: percentile(elapsed, 0.5),
      p95: percentile(elapsed, 0.95),
      p99: percentile(elapsed, 0.99)
    },
    cpuMs: {
      mean: mean(cpu),
      p50: percentile(cpu, 0.5),
      p95: percentile(cpu, 0.95)
    },
    heapUsedDeltaBytes: {
      mean: mean(heapDelta),
      p50: percentile(heapDelta, 0.5),
      p95: percentile(heapDelta, 0.95)
    },
    actionCount: {
      mean: mean(actionCounts),
      p50: percentile(actionCounts, 0.5),
      p95: percentile(actionCounts, 0.95)
    },
    fusekiRequestCount: {
      mean: mean(fusekiCounts),
      p50: percentile(fusekiCounts, 0.5),
      p95: percentile(fusekiCounts, 0.95)
    },
    actionCounts: aggregateCounts(successfulRecords, 'actionCounts'),
    categoryCounts: aggregateCounts(successfulRecords, 'categoryCounts'),
    errorSamples: records.length - successfulRecords.length
  };
}

function linearFit(points) {
  if (points.length < 2) return undefined;
  const n = points.length;
  const sumX = points.reduce((sum, point) => sum + point.x, 0);
  const sumY = points.reduce((sum, point) => sum + point.y, 0);
  const sumXY = points.reduce((sum, point) => sum + point.x * point.y, 0);
  const sumXX = points.reduce((sum, point) => sum + point.x * point.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return undefined;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function summarize(records, requiredRecipientCounts = REQUIRED_RECIPIENT_COUNTS) {
  const phaseRecords = records.filter(record => record && record.phase === 'APDM-P8-A');
  const byCount = new Map();
  for (const record of phaseRecords) {
    const count = Number(record.recipientCount);
    if (!Number.isInteger(count) || count <= 0) continue;
    if (!byCount.has(count)) byCount.set(count, []);
    byCount.get(count).push(record);
  }

  const cases = {};
  for (const count of [...byCount.keys()].sort((a, b) => a - b)) {
    cases[count] = summarizeRecipientCase(byCount.get(count));
  }

  const missingRecipientCounts = requiredRecipientCounts.filter(count => {
    const caseRecords = byCount.get(count) || [];
    return !caseRecords.some(isSuccessfulRecord);
  });

  const usableEntries = [...byCount.entries()]
    .map(([count, caseRecords]) => [count, caseRecords.filter(isSuccessfulRecord)])
    .filter(([, caseRecords]) => caseRecords.length > 0);

  const actionFitPoints = usableEntries
    .map(([count, caseRecords]) => ({
      x: count,
      y: mean(caseRecords.map(record => Number(record.actionCount)).filter(Number.isFinite))
    }))
    .filter(point => Number.isFinite(point.y));

  const fusekiFitPoints = usableEntries
    .map(([count, caseRecords]) => ({
      x: count,
      y: mean(
        caseRecords
          .map(record => Number(record.fuseki && record.fuseki.requestCount))
          .filter(Number.isFinite)
      )
    }))
    .filter(point => Number.isFinite(point.y));

  return {
    phase: 'APDM-P8-A',
    generatedAt: new Date().toISOString(),
    requiredRecipientCounts,
    missingRecipientCounts,
    complete: missingRecipientCounts.length === 0,
    cases,
    measuredModels: {
      nestedMoleculerActions: linearFit(actionFitPoints),
      fusekiHttpRequests: linearFit(fusekiFitPoints)
    },
    historicalTopLevelModel: {
      expression: '6N + O(1)',
      status: missingRecipientCounts.length === 0 ? 'ready-for-reconciliation' : 'insufficient-measurements'
    }
  };
}

function main(argv = process.argv.slice(2)) {
  const inputPath = path.resolve(argv[0] || 'apdm-phase8-tier1.jsonl');
  const outputPath = argv[1] ? path.resolve(argv[1]) : undefined;
  const source = fs.readFileSync(inputPath, 'utf8');
  const summary = summarize(parseJsonLines(source));
  const rendered = `${JSON.stringify(summary, null, 2)}\n`;

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rendered, 'utf8');
  } else {
    process.stdout.write(rendered);
  }

  if (!summary.complete) {
    process.stderr.write(
      `[APDM-P8] Missing successful recipient measurements: ${summary.missingRecipientCounts.join(', ')}\n`
    );
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  REQUIRED_RECIPIENT_COUNTS,
  aggregateCounts,
  isSuccessfulRecord,
  linearFit,
  mean,
  parseJsonLines,
  percentile,
  summarize,
  summarizeRecipientCase
};
