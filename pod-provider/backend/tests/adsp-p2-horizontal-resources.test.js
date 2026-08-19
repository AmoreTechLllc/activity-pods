'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildResourceSummary,
  deltaRedisCommandstats,
  parseContainerSnapshot,
  parseRedisCommandstats,
  parseRedisMemory,
  summarizeWindow
} = require('../scripts/adsp-p2-horizontal-resources');

function snapshot(service, usageUsec, memoryCurrent, memoryPeak = memoryCurrent) {
  return [
    `service=${service}`,
    'container=abc',
    '{"CPUPerc":"1.00%"}',
    '--- cpu.stat ---',
    `usage_usec ${usageUsec}`,
    'user_usec 1',
    'system_usec 1',
    '--- memory.current ---',
    String(memoryCurrent),
    '--- memory.peak ---',
    String(memoryPeak),
    ''
  ].join('\n');
}

function commandstats(calls, usec, failed = 0) {
  return `# Commandstats\ncmdstat_get:calls=${calls},usec=${usec},usec_per_call=1.00,rejected_calls=0,failed_calls=${failed}\n`;
}

function redisMemory(used) {
  return `used_memory:${used}\nused_memory_rss:${used + 100}\nused_memory_peak:${used + 200}\n`;
}

function writeMeasuredWindow(runtimeDir, resultsDir, { replicas, sample, cpuScale = 1 }) {
  const caseName = `${replicas}r-10n-s${sample}`;
  const sampleDir = path.join(runtimeDir, caseName);
  fs.mkdirSync(sampleDir, { recursive: true });
  const services = ['backend'];
  if (replicas >= 2) services.push('backend_p2_2');
  if (replicas >= 4) services.push('backend_p2_3', 'backend_p2_4');
  services.push('fuseki_test', 'redis');
  for (const [index, service] of services.entries()) {
    const beforeCpu = 1000 * (index + 1);
    const cpuDelta = Math.round(1000 * cpuScale / replicas);
    const isBackend = service === 'backend' || service.startsWith('backend_p2_');
    const memoryCurrent = isBackend ? Math.round(1000 / replicas) : 1000;
    fs.writeFileSync(path.join(sampleDir, `${service}-before.txt`), snapshot(service, beforeCpu, memoryCurrent));
    fs.writeFileSync(path.join(sampleDir, `${service}-after.txt`), snapshot(service, beforeCpu + cpuDelta, memoryCurrent));
  }
  fs.writeFileSync(path.join(sampleDir, 'redis-commandstats-before.txt'), commandstats(10, 20));
  fs.writeFileSync(path.join(sampleDir, 'redis-commandstats-after.txt'), commandstats(18, 35));
  fs.writeFileSync(path.join(sampleDir, 'redis-memory-before.txt'), redisMemory(1000));
  fs.writeFileSync(path.join(sampleDir, 'redis-memory-after.txt'), redisMemory(1200));
  fs.writeFileSync(path.join(resultsDir, `${caseName}.json`), JSON.stringify({
    successfulOutcomes: 8,
    requestCount: 8,
    failedOutcomes: 0,
    throughputPerSecond: replicas,
    completedMs: { p95: 100 / replicas, p99: 120 / replicas }
  }));
}

describe('ADSP P2 horizontal resource evidence', () => {
  test('parses cgroup and Redis snapshots and rejects backwards counters', () => {
    expect(parseContainerSnapshot(snapshot('backend', 1000, 2000))).toMatchObject({
      service: 'backend',
      usageUsec: 1000,
      memoryCurrentBytes: 2000
    });
    expect(parseRedisMemory(redisMemory(1000)).used_memory).toBe(1000);
    const before = parseRedisCommandstats(commandstats(10, 20));
    const after = parseRedisCommandstats(commandstats(15, 30));
    expect(deltaRedisCommandstats(before, after).totals).toEqual({ calls: 5, usec: 10, rejectedCalls: 0, failedCalls: 0 });
    expect(() => deltaRedisCommandstats(after, before)).toThrow(/counter moved backwards/u);
  });

  test('accepts Redis command names and trailing metrics added by newer Redis versions', () => {
    const parsed = parseRedisCommandstats([
      '# Commandstats',
      'cmdstat_client|setname:calls=72,usec=104,usec_per_call=1.44,rejected_calls=0,failed_calls=0',
      'cmdstat_scan:calls=8780,usec=252321,usec_per_call=28.74,rejected_calls=0,failed_calls=0,slowlog_count=1,slowlog_time_ms_sum=10.20,slowlog_time_ms_max=10.20',
      ''
    ].join('\n'));
    expect(parsed['client|setname']).toEqual({ calls: 72, usec: 104, rejectedCalls: 0, failedCalls: 0 });
    expect(parsed.scan).toEqual({ calls: 8780, usec: 252321, rejectedCalls: 0, failedCalls: 0 });
  });

  test('fails closed on malformed or incomplete Redis commandstats evidence', () => {
    expect(() => parseRedisCommandstats('cmdstat_get:calls=1,usec=2,rejected_calls=0,failed_calls=0\n')).toThrow(/missing # Commandstats header/u);
    expect(() => parseRedisCommandstats('# Commandstats\n')).toThrow(/contains no command counters/u);
    expect(() => parseRedisCommandstats('# Commandstats\ncmdstat_get:calls=1,usec=2,rejected_calls=0\n')).toThrow(/missing failed_calls/u);
    expect(() => parseRedisCommandstats('# Commandstats\ncmdstat_get:calls=x,usec=2,rejected_calls=0,failed_calls=0\n')).toThrow(/calls must be a non-negative integer/u);
    expect(() => parseRedisCommandstats('# Commandstats\ncmdstat_get:calls=1,usec=2,rejected_calls=0,failed_calls=0,calls=2\n')).toThrow(/Duplicate Redis commandstats field calls/u);
  });

  test('derives non-overlapping whole-system CPU and memory for a measured window', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-resource-'));
    try {
      const runtimeDir = path.join(root, 'runtime');
      const resultsDir = path.join(root, 'results');
      const sampleDir = path.join(runtimeDir, '2r-10n-s1');
      fs.mkdirSync(sampleDir, { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });

      const services = {
        backend: [1000, 3000, 100, 120],
        backend_p2_2: [2000, 5000, 200, 220],
        fuseki_test: [3000, 3500, 300, 310],
        redis: [4000, 4250, 400, 405]
      };
      for (const [service, [beforeCpu, afterCpu, beforeMem, afterMem]] of Object.entries(services)) {
        fs.writeFileSync(path.join(sampleDir, `${service}-before.txt`), snapshot(service, beforeCpu, beforeMem));
        fs.writeFileSync(path.join(sampleDir, `${service}-after.txt`), snapshot(service, afterCpu, afterMem));
      }
      fs.writeFileSync(path.join(sampleDir, 'redis-commandstats-before.txt'), commandstats(10, 20));
      fs.writeFileSync(path.join(sampleDir, 'redis-commandstats-after.txt'), commandstats(18, 35));
      fs.writeFileSync(path.join(sampleDir, 'redis-memory-before.txt'), redisMemory(1000));
      fs.writeFileSync(path.join(sampleDir, 'redis-memory-after.txt'), redisMemory(1200));
      fs.writeFileSync(
        path.join(resultsDir, '2r-10n-s1.json'),
        JSON.stringify({
          successfulOutcomes: 2,
          requestCount: 2,
          failedOutcomes: 0,
          throughputPerSecond: 1,
          completedMs: { p95: 100, p99: 120 }
        })
      );

      const result = summarizeWindow(runtimeDir, resultsDir, '2r-10n-s1');
      expect(result.backendCpuMs).toBe(5);
      expect(result.fusekiCpuMs).toBe(0.5);
      expect(result.redisCpuMs).toBe(0.25);
      expect(result.wholeSystemCpuMs).toBe(5.75);
      expect(result.wholeSystemCpuMsPerOutcome).toBe(2.875);
      expect(result.backendMemoryCurrentAfterBytes).toBe(340);
      expect(result.wholeSystemMemoryCurrentAfterBytes).toBe(1055);
      expect(result.redisCommandCalls).toBe(8);
      expect(result.redisCommandUsec).toBe(15);
      expect(result.redisUsedMemoryDeltaBytes).toBe(200);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('embeds a complete normalized guardrail decision in the existing resource summary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-resource-summary-'));
    try {
      const runtimeDir = path.join(root, 'runtime');
      const resultsDir = path.join(root, 'results');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(resultsDir, { recursive: true });
      for (const replicas of [1, 2, 4]) {
        for (let sample = 1; sample <= 5; sample += 1) writeMeasuredWindow(runtimeDir, resultsDir, { replicas, sample });
      }
      const summary = buildResourceSummary(runtimeDir, resultsDir);
      expect(summary.guardrails.complete).toBe(true);
      expect(summary.guardrails.passed).toBe(true);
      expect(summary.guardrails.cases['4r-10n'].samples).toBe(5);
      expect(summary.guardrails.scale['10n'].oneToTwo.guards.redisErrorsZero).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
