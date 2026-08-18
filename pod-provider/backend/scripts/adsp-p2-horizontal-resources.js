'use strict';

const fs = require('fs');
const path = require('path');

const CASE_PATTERN = /^(1|2|4)r-(10|100|200|1000)n-s([1-9][0-9]*)$/u;

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

function parseContainerSnapshot(text, label = 'container snapshot') {
  const service = text.match(/^service=(.+)$/mu)?.[1];
  const usageUsec = text.match(/^usage_usec\s+(\d+)$/mu)?.[1];
  const memoryCurrent = text.match(/^--- memory\.current ---\n(\d+)$/mu)?.[1];
  const memoryPeak = text.match(/^--- memory\.peak ---\n(\d+)$/mu)?.[1];
  if (!service || usageUsec === undefined || memoryCurrent === undefined || memoryPeak === undefined) {
    throw new Error(`${label} is missing service/cpu/memory cgroup fields`);
  }
  return {
    service,
    usageUsec: finiteNonNegative(usageUsec, `${label} usage_usec`),
    memoryCurrentBytes: finiteNonNegative(memoryCurrent, `${label} memory.current`),
    memoryPeakBytes: finiteNonNegative(memoryPeak, `${label} memory.peak`)
  };
}

function parseRedisCommandstats(text) {
  const commands = Object.create(null);
  for (const line of String(text).split(/\r?\n/u)) {
    const match = line.match(/^cmdstat_([^:]+):calls=(\d+),usec=(\d+),usec_per_call=[^,]+,rejected_calls=(\d+),failed_calls=(\d+)$/u);
    if (!match) continue;
    commands[match[1]] = {
      calls: Number(match[2]),
      usec: Number(match[3]),
      rejectedCalls: Number(match[4]),
      failedCalls: Number(match[5])
    };
  }
  return commands;
}

function deltaRedisCommandstats(before, after) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const commands = Object.create(null);
  const totals = { calls: 0, usec: 0, rejectedCalls: 0, failedCalls: 0 };
  for (const name of names) {
    const first = before[name] || { calls: 0, usec: 0, rejectedCalls: 0, failedCalls: 0 };
    const last = after[name] || { calls: 0, usec: 0, rejectedCalls: 0, failedCalls: 0 };
    const delta = {
      calls: last.calls - first.calls,
      usec: last.usec - first.usec,
      rejectedCalls: last.rejectedCalls - first.rejectedCalls,
      failedCalls: last.failedCalls - first.failedCalls
    };
    for (const [field, value] of Object.entries(delta)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`Redis ${name} ${field} counter moved backwards`);
      totals[field] += value;
    }
    if (delta.calls || delta.usec || delta.rejectedCalls || delta.failedCalls) commands[name] = delta;
  }
  return { commands, totals };
}

function parseRedisMemory(text) {
  const values = Object.create(null);
  for (const key of ['used_memory', 'used_memory_rss', 'used_memory_peak']) {
    const raw = String(text).match(new RegExp(`^${key}:(\\d+)$`, 'mu'))?.[1];
    if (raw === undefined) throw new Error(`Redis memory snapshot missing ${key}`);
    values[key] = finiteNonNegative(raw, key);
  }
  return values;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function summarizeWindow(runtimeDir, resultsDir, directoryName) {
  const match = directoryName.match(CASE_PATTERN);
  if (!match) throw new Error(`Invalid P2 runtime case directory ${directoryName}`);
  const replicaCount = Number(match[1]);
  const recipientCount = Number(match[2]);
  const sample = Number(match[3]);
  const sampleDir = path.join(runtimeDir, directoryName);
  const resultFile = path.join(resultsDir, `${replicaCount}r-${recipientCount}n-s${sample}.json`);
  if (!fs.existsSync(resultFile)) throw new Error(`Missing result file for ${directoryName}`);
  const result = readJson(resultFile);
  if (Number(result.successfulOutcomes) !== Number(result.requestCount) || Number(result.failedOutcomes) !== 0) {
    throw new Error(`Resource window ${directoryName} is not a successful application-work sample`);
  }

  const beforeFiles = fs.readdirSync(sampleDir).filter(name => name.endsWith('-before.txt') && !name.startsWith('redis-commandstats') && !name.startsWith('redis-memory'));
  const serviceDeltas = Object.create(null);
  for (const beforeName of beforeFiles) {
    const service = beforeName.slice(0, -'-before.txt'.length);
    const afterName = `${service}-after.txt`;
    const afterPath = path.join(sampleDir, afterName);
    if (!fs.existsSync(afterPath)) throw new Error(`Missing ${afterName} for ${directoryName}`);
    const before = parseContainerSnapshot(fs.readFileSync(path.join(sampleDir, beforeName), 'utf8'), `${directoryName}/${beforeName}`);
    const after = parseContainerSnapshot(fs.readFileSync(afterPath, 'utf8'), `${directoryName}/${afterName}`);
    if (before.service !== service || after.service !== service) throw new Error(`Service identity drift in ${directoryName}/${service}`);
    const cpuUsec = after.usageUsec - before.usageUsec;
    if (cpuUsec < 0) throw new Error(`CPU counter moved backwards for ${directoryName}/${service}`);
    serviceDeltas[service] = {
      cpuMs: cpuUsec / 1000,
      memoryCurrentBeforeBytes: before.memoryCurrentBytes,
      memoryCurrentAfterBytes: after.memoryCurrentBytes,
      memoryCurrentDeltaBytes: after.memoryCurrentBytes - before.memoryCurrentBytes,
      memoryPeakSinceContainerStartBytes: after.memoryPeakBytes
    };
  }

  const expectedBackends = Array.from({ length: replicaCount }, (_, index) => (index === 0 ? 'backend' : `backend_p2_${index + 1}`));
  for (const service of [...expectedBackends, 'fuseki_test', 'redis']) {
    if (!serviceDeltas[service]) throw new Error(`Missing resource snapshot for ${directoryName}/${service}`);
  }
  const unexpectedBackends = Object.keys(serviceDeltas).filter(name => name.startsWith('backend') && !expectedBackends.includes(name));
  if (unexpectedBackends.length > 0) throw new Error(`Unexpected backend resource snapshots in ${directoryName}: ${unexpectedBackends.join(', ')}`);

  const backendCpuMs = expectedBackends.reduce((sum, name) => sum + serviceDeltas[name].cpuMs, 0);
  const fusekiCpuMs = serviceDeltas.fuseki_test.cpuMs;
  const redisCpuMs = serviceDeltas.redis.cpuMs;
  const wholeSystemCpuMs = backendCpuMs + fusekiCpuMs + redisCpuMs;
  const backendMemoryCurrentAfterBytes = expectedBackends.reduce((sum, name) => sum + serviceDeltas[name].memoryCurrentAfterBytes, 0);
  const wholeSystemMemoryCurrentAfterBytes = backendMemoryCurrentAfterBytes + serviceDeltas.fuseki_test.memoryCurrentAfterBytes + serviceDeltas.redis.memoryCurrentAfterBytes;

  const redisCommands = deltaRedisCommandstats(
    parseRedisCommandstats(fs.readFileSync(path.join(sampleDir, 'redis-commandstats-before.txt'), 'utf8')),
    parseRedisCommandstats(fs.readFileSync(path.join(sampleDir, 'redis-commandstats-after.txt'), 'utf8'))
  );
  const redisMemoryBefore = parseRedisMemory(fs.readFileSync(path.join(sampleDir, 'redis-memory-before.txt'), 'utf8'));
  const redisMemoryAfter = parseRedisMemory(fs.readFileSync(path.join(sampleDir, 'redis-memory-after.txt'), 'utf8'));
  const outcomes = Number(result.successfulOutcomes);

  return {
    replicaCount,
    recipientCount,
    sample,
    successfulOutcomes: outcomes,
    throughputPerSecond: Number(result.throughputPerSecond),
    completedP95Ms: Number(result.completedMs?.p95),
    completedP99Ms: Number(result.completedMs?.p99),
    backendCpuMs,
    fusekiCpuMs,
    redisCpuMs,
    wholeSystemCpuMs,
    wholeSystemCpuMsPerOutcome: wholeSystemCpuMs / outcomes,
    backendMemoryCurrentAfterBytes,
    wholeSystemMemoryCurrentAfterBytes,
    redisCommandCalls: redisCommands.totals.calls,
    redisCommandUsec: redisCommands.totals.usec,
    redisRejectedCalls: redisCommands.totals.rejectedCalls,
    redisFailedCalls: redisCommands.totals.failedCalls,
    redisUsedMemoryBeforeBytes: redisMemoryBefore.used_memory,
    redisUsedMemoryAfterBytes: redisMemoryAfter.used_memory,
    redisUsedMemoryDeltaBytes: redisMemoryAfter.used_memory - redisMemoryBefore.used_memory,
    serviceDeltas,
    redisCommandDeltas: redisCommands.commands
  };
}

function summarizeCases(windows) {
  const grouped = new Map();
  for (const window of windows) {
    const key = `${window.replicaCount}r-${window.recipientCount}n`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(window);
  }
  const cases = Object.create(null);
  for (const [key, values] of grouped) {
    const metric = name => values.map(value => finiteNonNegative(value[name], `${key} ${name}`));
    cases[key] = {
      replicaCount: values[0].replicaCount,
      recipientCount: values[0].recipientCount,
      samples: values.length,
      wholeSystemCpuMsPerOutcomeP50: percentile(metric('wholeSystemCpuMsPerOutcome'), 0.5),
      backendCpuMsP50: percentile(metric('backendCpuMs'), 0.5),
      fusekiCpuMsP50: percentile(metric('fusekiCpuMs'), 0.5),
      redisCpuMsP50: percentile(metric('redisCpuMs'), 0.5),
      backendMemoryCurrentAfterBytesP50: percentile(metric('backendMemoryCurrentAfterBytes'), 0.5),
      wholeSystemMemoryCurrentAfterBytesP50: percentile(metric('wholeSystemMemoryCurrentAfterBytes'), 0.5),
      redisCommandCallsP50: percentile(metric('redisCommandCalls'), 0.5),
      redisCommandUsecP50: percentile(metric('redisCommandUsec'), 0.5),
      redisFailedCallsTotal: metric('redisFailedCalls').reduce((sum, value) => sum + value, 0),
      redisRejectedCallsTotal: metric('redisRejectedCalls').reduce((sum, value) => sum + value, 0)
    };
  }
  return cases;
}

function buildResourceSummary(runtimeDir, resultsDir) {
  const directories = fs
    .readdirSync(runtimeDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && CASE_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const windows = directories.map(name => summarizeWindow(runtimeDir, resultsDir, name));
  return {
    version: 1,
    phase: 'ADSP-P2-A',
    fixture: 'tier1-horizontal-local-fanout-resources',
    windows,
    cases: summarizeCases(windows)
  };
}

function main(argv = process.argv.slice(2)) {
  const runtimeDir = path.resolve(argv[0] || '');
  const resultsDir = path.resolve(argv[1] || '');
  const outputPath = path.resolve(argv[2] || '');
  if (!argv[0] || !argv[1] || !argv[2]) {
    throw new Error('Usage: adsp-p2-horizontal-resources.js <runtime-dir> <results-dir> <output.json>');
  }
  const summary = buildResourceSummary(runtimeDir, resultsDir);
  if (summary.windows.length === 0) throw new Error('No measured P2 resource windows found');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
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
  CASE_PATTERN,
  buildResourceSummary,
  deltaRedisCommandstats,
  parseContainerSnapshot,
  parseRedisCommandstats,
  parseRedisMemory,
  summarizeCases,
  summarizeWindow
};
