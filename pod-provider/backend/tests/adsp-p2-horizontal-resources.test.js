'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
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
});
