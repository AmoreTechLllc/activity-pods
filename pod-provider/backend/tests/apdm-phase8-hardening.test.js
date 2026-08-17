'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY,
  LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY,
  createPhase8Tier1Instrumentation
} = require('../lib/apdm-phase8-tier1-instrumentation');

describe('APDM Phase 8 hardening', () => {
  test('chains and restores pre-existing local delivery observers', async () => {
    const completionKey = Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY);
    const resultKey = Symbol.for(LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY);
    const previousCompletion = jest.fn();
    const previousResult = jest.fn();
    globalThis[completionKey] = previousCompletion;
    globalThis[resultKey] = previousResult;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-chain-'));
    const instrumentation = createPhase8Tier1Instrumentation({
      enabled: true,
      outputPath: path.join(directory, 'measurement.jsonl'),
      recipientCount: 1
    });

    try {
      const completion = globalThis[completionKey];
      const result = globalThis[resultKey];
      const root = instrumentation.middleware.localAction(async () => {
        completion('start', {});
        result({}, { success: ['synthetic-recipient'], failures: [] });
        completion('finish', {});
        return true;
      }, { name: 'activitypub.outbox.post' });
      await expect(root({ id: 'root', requestID: 'request-chain' })).resolves.toBe(true);
      expect(previousCompletion).toHaveBeenCalledTimes(2);
      expect(previousResult).toHaveBeenCalledTimes(1);
    } finally {
      instrumentation.dispose();
      expect(globalThis[completionKey]).toBe(previousCompletion);
      expect(globalThis[resultKey]).toBe(previousResult);
      delete globalThis[completionKey];
      delete globalThis[resultKey];
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('observer failures never replace delivery results', async () => {
    const completionKey = Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY);
    const previousCompletion = () => { throw new Error('observer-private-value'); };
    globalThis[completionKey] = previousCompletion;
    const reported = [];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-observer-error-'));
    const instrumentation = createPhase8Tier1Instrumentation({
      enabled: true,
      outputPath: path.join(directory, 'measurement.jsonl'),
      onInstrumentationError: error => reported.push(error.name)
    });
    try {
      const observer = globalThis[completionKey];
      const root = instrumentation.middleware.localAction(async () => {
        observer('start', {});
        observer('finish', {});
        return 'delivered';
      }, { name: 'activitypub.outbox.post' });
      await expect(root({ id: 'root-observer' })).resolves.toBe('delivered');
      expect(reported).toEqual(['Error', 'Error']);
    } finally {
      instrumentation.dispose();
      delete globalThis[completionKey];
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('artifact errors never serialize arbitrary exception messages', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-private-error-'));
    const outputPath = path.join(directory, 'measurement.jsonl');
    const instrumentation = createPhase8Tier1Instrumentation({ enabled: true, outputPath });
    try {
      const child = instrumentation.middleware.localAction(async () => {
        throw new Error('PRIVATE_RESOURCE_MARKER');
      }, { name: 'ldp.resource.get' });
      const root = instrumentation.middleware.localAction(async () => child({ id: 'child' }), {
        name: 'activitypub.outbox.post'
      });
      await expect(root({ id: 'root-private', requestID: 'request-private' })).rejects.toThrow('PRIVATE_RESOURCE_MARKER');
      const artifact = fs.readFileSync(outputPath, 'utf8');
      expect(artifact).not.toContain('PRIVATE_RESOURCE_MARKER');
      const record = JSON.parse(artifact.trim());
      expect(record.errors.some(error => Object.prototype.hasOwnProperty.call(error, 'message'))).toBe(false);
    } finally {
      instrumentation.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rejects ambiguous duplicate Fuseki HTTP probe ownership and restores cleanly', () => {
    const first = createPhase8Tier1Instrumentation({ enabled: true, fusekiBase: 'http://127.0.0.1:3030/' });
    try {
      expect(() => createPhase8Tier1Instrumentation({ enabled: true, fusekiBase: 'http://127.0.0.1:3030/' }))
        .toThrow(/already installed/u);
    } finally {
      first.dispose();
    }
    const second = createPhase8Tier1Instrumentation({ enabled: true, fusekiBase: 'http://127.0.0.1:3030/' });
    expect(() => second.dispose()).not.toThrow();
  });
});
