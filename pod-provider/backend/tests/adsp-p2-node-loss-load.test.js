'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_POD_CELL_NODES,
  EXPECTED_VICTIM_BOUNDARY,
  assertExecutorSet,
  assertTargetedVictimRejected,
  assertUnique,
  faultBurstNodeAssignments,
  findRootEntries,
  readBarrierTimestamp,
  requestPayload,
  waitForExactVictimRootEntry
} = require('../scripts/adsp-p2-node-loss-load');

function writeJsonLine(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

describe('ADSP P2 node-loss load driver', () => {
  test('requires every expected executor to carry accepted work', () => {
    expect(() => assertExecutorSet({ r1: 3, r2: 3, r3: 2 }, ['r1', 'r2', 'r3'], 8)).not.toThrow();
    expect(() => assertExecutorSet({ r1: 4, r2: 4 }, ['r1', 'r2', 'r3'], 8)).toThrow(/r3 carried no accepted work/u);
    expect(() => assertExecutorSet({ r1: 2, r2: 2, r3: 2, r4: 2 }, ['r1', 'r2', 'r3'], 8)).toThrow(/Unexpected executor/u);
  });

  test('isolates the selected ambiguous request on r4 while retaining concurrent load across every cell', () => {
    const assignments = faultBurstNodeAssignments(8, 'adsp-p2-pod-cell-4');
    expect(assignments).toEqual([
      'adsp-p2-pod-cell-4',
      'adsp-p2-pod-cell-1',
      'adsp-p2-pod-cell-2',
      'adsp-p2-pod-cell-3',
      'adsp-p2-pod-cell-1',
      'adsp-p2-pod-cell-2',
      'adsp-p2-pod-cell-3',
      'adsp-p2-pod-cell-1'
    ]);
    expect(assignments.slice(1)).not.toContain('adsp-p2-pod-cell-4');
    expect(new Set(assignments)).toEqual(new Set(DEFAULT_POD_CELL_NODES));
  });

  test('fault-burst assignment fails closed when unique four-cell coverage cannot be proven', () => {
    expect(() => faultBurstNodeAssignments(3, 'adsp-p2-pod-cell-4')).toThrow(/at least 4 requests/u);
    expect(() => faultBurstNodeAssignments(8, 'unknown-node')).toThrow(/not one of the configured Pod cells/u);
    expect(() => faultBurstNodeAssignments(8, 'r4', ['r1', 'r2', 'r2', 'r4'])).toThrow(/exactly four unique/u);
  });

  test('rejects duplicate authoritative identities', () => {
    expect(() => assertUnique(['a', 'b', 'c'], 'id')).not.toThrow();
    expect(() => assertUnique(['a', 'b', 'a'], 'id')).toThrow(/Duplicate id: a/u);
  });

  test('requires the targeted victim call to be caller-rejected exactly once', () => {
    const rejected = { requestId: 'victim-request', error: { message: 'node disconnected' } };
    expect(assertTargetedVictimRejected({ accepted: [], rejected: [rejected] }, 'victim-request')).toBe(rejected);
    expect(() => assertTargetedVictimRejected({
      accepted: [{ requestId: 'victim-request' }],
      rejected: []
    }, 'victim-request')).toThrow(/caller-rejected exactly once/u);
    expect(() => assertTargetedVictimRejected({ accepted: [], rejected: [] }, 'victim-request')).toThrow(/caller-rejected exactly once/u);
  });

  test('binds fault payload content to the request identity for persistence audit', () => {
    const payload = requestPayload(
      { sender: { outbox: 'https://pod.example/alice/outbox', webId: 'https://pod.example/alice' } },
      ['https://pod.example/bob'],
      'request-123'
    );
    expect(payload.collectionUri).toBe('https://pod.example/alice/outbox');
    expect(payload.object.content).toBe('ADSP P2 node-loss request-123');
    expect(payload.to).toEqual(['https://pod.example/bob']);
  });

  test('proves the targeted request reached the exact held-response boundary on the selected victim', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-loss-root-'));
    const files = [1, 2, 3, 4].map(index => path.join(directory, `r${index}.jsonl`));
    try {
      writeJsonLine(files[3], {
        phase: 'ADSP-P2-ROOT-ENTRY',
        requestId: 'victim-request',
        nodeID: 'adsp-p2-pod-cell-4',
        boundary: EXPECTED_VICTIM_BOUNDARY,
        enteredAtEpochMs: Date.now()
      });
      const match = await waitForExactVictimRootEntry(files, 'victim-request', 'adsp-p2-pod-cell-4', 200);
      expect(match.filePath).toBe(files[3]);
      expect(match.record.boundary).toBe(EXPECTED_VICTIM_BOUNDARY);
      expect(findRootEntries(files, 'victim-request')).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed if the victim marker is only ordinary root entry', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-loss-wrong-boundary-'));
    const files = [1, 2, 3, 4].map(index => path.join(directory, `r${index}.jsonl`));
    try {
      writeJsonLine(files[3], {
        phase: 'ADSP-P2-ROOT-ENTRY',
        requestId: 'victim-request',
        nodeID: 'adsp-p2-pod-cell-4',
        boundary: 'root-action-entry',
        enteredAtEpochMs: Date.now()
      });
      await expect(waitForExactVictimRootEntry(files, 'victim-request', 'adsp-p2-pod-cell-4', 200)).rejects.toThrow(/expected "root-action-complete-response-held"/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('fails closed if the same targeted request appears on multiple root executors', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-loss-duplicate-root-'));
    const files = [1, 2, 3, 4].map(index => path.join(directory, `r${index}.jsonl`));
    const record = {
      phase: 'ADSP-P2-ROOT-ENTRY',
      requestId: 'victim-request',
      nodeID: 'adsp-p2-pod-cell-4',
      boundary: EXPECTED_VICTIM_BOUNDARY,
      enteredAtEpochMs: Date.now()
    };
    try {
      writeJsonLine(files[2], { ...record, nodeID: 'adsp-p2-pod-cell-3' });
      writeJsonLine(files[3], record);
      await expect(waitForExactVictimRootEntry(files, 'victim-request', 'adsp-p2-pod-cell-4', 200)).rejects.toThrow(/multiple root executors/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('requires timestamp-bearing kill/restart barriers', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-loss-barrier-'));
    try {
      fs.writeFileSync(path.join(directory, 'victim-killed'), '12345\n', 'utf8');
      expect(readBarrierTimestamp(directory, 'victim-killed')).toBe(12345);
      fs.writeFileSync(path.join(directory, 'victim-killed'), 'not-a-time\n', 'utf8');
      expect(() => readBarrierTimestamp(directory, 'victim-killed')).toThrow(/epoch timestamp/u);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
