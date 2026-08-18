'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertExecutorCoverage,
  executorName,
  expectedExecutors,
  findTraceMatches,
  percentile,
  signalBarrier,
  summarize,
  waitForBarrier,
  waitForUniqueTrace
} = require('../scripts/adsp-p2-horizontal-load');

describe('ADSP P2 horizontal Redis load evidence helpers', () => {
  test('percentiles use deterministic nearest-rank semantics', () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
    expect(percentile([5, 1, 4, 2, 3], 0.95)).toBe(5);
    expect(percentile([5, 1, 4, 2, 3], 0.99)).toBe(5);
    expect(percentile([], 0.5)).toBeUndefined();
    expect(summarize([5, 1, 4, 2, 3])).toEqual({ count: 5, p50: 3, p95: 5, p99: 5, min: 1, max: 5 });
  });

  test('executor identity is derived only from the per-replica trace filename', () => {
    expect(executorName('/tmp/trace-100-r1.jsonl')).toBe('r1');
    expect(executorName('/tmp/trace-100-r4.jsonl')).toBe('r4');
    expect(executorName('/tmp/custom.jsonl')).toBe('custom.jsonl');
    expect(expectedExecutors(4)).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  test('executor coverage requires every configured replica and exact accounting', () => {
    expect(() => assertExecutorCoverage({ r1: 2 }, 1, 2)).not.toThrow();
    expect(() => assertExecutorCoverage({ r1: 1, r2: 1 }, 2, 2)).not.toThrow();
    expect(() => assertExecutorCoverage({ r1: 2, r4: 2 }, 4, 4)).toThrow(/Replica r2 executed no measured work/u);
    expect(() => assertExecutorCoverage({ r1: 1, r2: 1, r3: 1, r4: 1, r5: 1 }, 4, 5)).toThrow(/Unexpected executor identity/u);
    expect(() => assertExecutorCoverage({ r1: 1, r2: 1 }, 2, 3)).toThrow(/Executor accounting mismatch/u);
  });

  test('barrier signaling is atomic and waitable', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-barrier-'));
    try {
      const wait = waitForBarrier(dir, 'go', 500);
      setTimeout(() => signalBarrier(dir, 'go'), 10);
      await expect(wait).resolves.toBeUndefined();
      expect(fs.existsSync(path.join(dir, 'go'))).toBe(true);
      expect(fs.readdirSync(dir).filter(name => name.endsWith('.tmp'))).toHaveLength(0);
      await expect(waitForBarrier(dir, 'missing', 25)).rejects.toThrow(/barrier missing/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('findTraceMatches detects a request duplicated across replica files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-traces-'));
    try {
      const r1 = path.join(dir, 'trace-10-r1.jsonl');
      const r2 = path.join(dir, 'trace-10-r2.jsonl');
      fs.writeFileSync(r1, `${JSON.stringify({ requestId: 'req-1', phase: 'APDM-P8-A' })}\n`);
      fs.writeFileSync(r2, `${JSON.stringify({ requestId: 'req-1', phase: 'APDM-P8-A' })}\n`);
      expect(findTraceMatches([r1, r2], 'req-1')).toHaveLength(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('waitForUniqueTrace requires exactly one correct successful completion record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-traces-'));
    try {
      const r1 = path.join(dir, 'trace-10-r1.jsonl');
      const r2 = path.join(dir, 'trace-10-r2.jsonl');
      fs.writeFileSync(
        r2,
        `${JSON.stringify({ requestId: 'req-ok', phase: 'APDM-P8-A', recipientCount: 10, errors: [], elapsedMs: 25 })}\n`
      );
      const match = await waitForUniqueTrace([r1, r2], 'req-ok', 10, 100);
      expect(match.traceFile).toBe(r2);
      expect(match.record.elapsedMs).toBe(25);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('waitForUniqueTrace fails closed on duplicate or errored authoritative outcomes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-p2-traces-'));
    try {
      const r1 = path.join(dir, 'trace-10-r1.jsonl');
      const r2 = path.join(dir, 'trace-10-r2.jsonl');
      const record = { requestId: 'req-dup', phase: 'APDM-P8-A', recipientCount: 10, errors: [] };
      fs.writeFileSync(r1, `${JSON.stringify(record)}\n`);
      fs.writeFileSync(r2, `${JSON.stringify(record)}\n`);
      await expect(waitForUniqueTrace([r1, r2], 'req-dup', 10, 100)).rejects.toThrow(/duplicate measurement traces/u);

      fs.writeFileSync(
        r1,
        `${JSON.stringify({ requestId: 'req-error', phase: 'APDM-P8-A', recipientCount: 10, errors: [{ source: 'x' }] })}\n`
      );
      fs.rmSync(r2, { force: true });
      await expect(waitForUniqueTrace([r1, r2], 'req-error', 10, 100)).rejects.toThrow(/trace contains errors/u);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
