'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  executorName,
  findTraceMatches,
  percentile,
  summarize,
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
