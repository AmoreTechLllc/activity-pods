'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdspRootEntryEvidenceMiddleware = require('../middlewares/adsp-root-entry-evidence');

function readRecords(filePath) {
  return fs
    .readFileSync(filePath, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('ADSP root-entry evidence middleware', () => {
  test('is absent unless explicitly enabled', () => {
    expect(AdspRootEntryEvidenceMiddleware({ enabled: false })).toBeNull();
  });

  test('records root entry before invoking the real action', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-root-entry-'));
    const outputPath = path.join(directory, 'root.jsonl');
    const observed = [];
    const middleware = AdspRootEntryEvidenceMiddleware({
      enabled: true,
      outputPath,
      nodeID: 'adsp-p2-pod-cell-4'
    });

    try {
      const wrapped = middleware.localAction(async () => {
        observed.push(readRecords(outputPath)[0]);
        return 'ok';
      }, { name: 'activitypub.outbox.post' });

      await expect(wrapped({ id: 'ctx-1', requestID: 'request-1' })).resolves.toBe('ok');
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({
        version: 1,
        phase: 'ADSP-P2-ROOT-ENTRY',
        action: 'activitypub.outbox.post',
        requestId: 'request-1',
        nodeID: 'adsp-p2-pod-cell-4'
      });
      expect(Number.isInteger(observed[0].enteredAtEpochMs)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('does not record unrelated actions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-root-entry-other-'));
    const outputPath = path.join(directory, 'root.jsonl');
    const middleware = AdspRootEntryEvidenceMiddleware({ enabled: true, outputPath });

    try {
      const wrapped = middleware.localAction(async () => 'child-ok', { name: 'ldp.resource.get' });
      await expect(wrapped({ id: 'ctx-2', requestID: 'request-2' })).resolves.toBe('child-ok');
      expect(fs.existsSync(outputPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('evidence write failure cannot change request success', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-root-entry-failure-'));
    const outputPath = path.join(directory, 'not-a-file');
    const failures = [];
    fs.mkdirSync(outputPath);
    const middleware = AdspRootEntryEvidenceMiddleware({
      enabled: true,
      outputPath,
      onEvidenceError: error => failures.push(error.message)
    });

    try {
      const wrapped = middleware.localAction(async () => 'application-success', { name: 'activitypub.outbox.post' });
      await expect(wrapped({ id: 'ctx-3', requestID: 'request-3' })).resolves.toBe('application-success');
      expect(failures).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
