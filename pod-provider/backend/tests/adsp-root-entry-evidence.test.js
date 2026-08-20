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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
        nodeID: 'adsp-p2-pod-cell-4',
        boundary: 'root-action-entry'
      });
      expect(Number.isInteger(observed[0].enteredAtEpochMs)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('holds only the selected request after the real root action completes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-root-hold-'));
    const outputPath = path.join(directory, 'root.jsonl');
    let actionCompleted = false;
    let callerSettled = false;
    const middleware = AdspRootEntryEvidenceMiddleware({
      enabled: true,
      outputPath,
      nodeID: 'adsp-p2-pod-cell-4',
      holdAfterAction: true,
      holdRequestPrefix: 'fault-target-'
    });

    try {
      const wrapped = middleware.localAction(async () => {
        actionCompleted = true;
        return 'committed-result';
      }, { name: 'activitypub.outbox.post' });
      void wrapped({ id: 'ctx-hold', requestID: 'fault-target-123' }).then(
        () => { callerSettled = true; },
        () => { callerSettled = true; }
      );

      for (let attempt = 0; attempt < 20 && !fs.existsSync(outputPath); attempt += 1) await delay(5);
      expect(actionCompleted).toBe(true);
      expect(callerSettled).toBe(false);
      const records = readRecords(outputPath);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        requestId: 'fault-target-123',
        nodeID: 'adsp-p2-pod-cell-4',
        boundary: 'root-action-complete-response-held'
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('does not hold a request outside the selected prefix', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsp-root-hold-nonmatch-'));
    const outputPath = path.join(directory, 'root.jsonl');
    const middleware = AdspRootEntryEvidenceMiddleware({
      enabled: true,
      outputPath,
      holdAfterAction: true,
      holdRequestPrefix: 'fault-target-'
    });

    try {
      const wrapped = middleware.localAction(async () => 'ordinary-result', { name: 'activitypub.outbox.post' });
      await expect(wrapped({ id: 'ctx-normal', requestID: 'ordinary-request' })).resolves.toBe('ordinary-result');
      expect(readRecords(outputPath)[0].boundary).toBe('root-action-entry');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('requires an explicit prefix when hold mode is enabled', () => {
    expect(() => AdspRootEntryEvidenceMiddleware({
      enabled: true,
      outputPath: '/tmp/adsp-root.jsonl',
      holdAfterAction: true
    })).toThrow(/holdRequestPrefix/u);
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
