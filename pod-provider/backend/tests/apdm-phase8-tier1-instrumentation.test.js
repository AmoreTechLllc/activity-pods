'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY,
  LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY,
  classifyAction,
  createPhase8Tier1Instrumentation,
  normalizeUrl,
  targetMatchesFuseki
} = require('../lib/apdm-phase8-tier1-instrumentation');

function readRecords(file) {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('APDM Phase 8 Tier 1 instrumentation', () => {
  test('classifies the required nested Tier 1 action families', () => {
    expect(classifyAction('activitypub.collection.add')).toBe('activitypub');
    expect(classifyAction('webacl.resource.hasRights')).toBe('webacl');
    expect(classifyAction('ldp.remote.store')).toBe('ldp');
    expect(classifyAction('triplestore.query')).toBe('triplestore');
    expect(classifyAction('sparqlEndpoint.query')).toBe('triplestore');
    expect(classifyAction('auth.account.findByWebId')).toBe('auth');
  });

  test('matches Fuseki by exact origin and path-segment prefix', () => {
    const base = normalizeUrl('http://127.0.0.1:3030/ds');
    expect(targetMatchesFuseki(normalizeUrl('http://127.0.0.1:3030/ds/query'), [base])).toBe(true);
    expect(targetMatchesFuseki(normalizeUrl('http://127.0.0.1:3030/ds'), [base])).toBe(true);
    expect(targetMatchesFuseki(normalizeUrl('http://127.0.0.1:3030/ds2/query'), [base])).toBe(false);
    expect(targetMatchesFuseki(normalizeUrl('http://127.0.0.1:3030/other/query'), [base])).toBe(false);
    expect(targetMatchesFuseki(normalizeUrl('http://127.0.0.1:4040/ds/query'), [base])).toBe(false);
  });

  test('disabled mode does not patch Node HTTP or expose a middleware', () => {
    const originalRequest = http.request;
    const observerKey = Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY);
    const previousObserver = globalThis[observerKey];
    const instrumentation = createPhase8Tier1Instrumentation({
      enabled: false,
      fusekiBase: 'http://127.0.0.1:3030/'
    });

    expect(instrumentation.middleware).toBeNull();
    expect(http.request).toBe(originalRequest);
    expect(globalThis[observerKey]).toBe(previousObserver);
    instrumentation.dispose();
    expect(http.request).toBe(originalRequest);
    expect(globalThis[observerKey]).toBe(previousObserver);
  });

  test('captures nested actions, Fuseki HTTP, CPU/heap and the configured recipient case in one root trace', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-'));
    const outputPath = path.join(outputDirectory, 'measurement.jsonl');
    const server = http.createServer((incoming, response) => {
      response.writeHead(204);
      response.end();
    });
    const address = await listen(server);
    const fusekiBase = `http://${address.address}:${address.port}/ds`;

    const instrumentation = createPhase8Tier1Instrumentation({
      enabled: true,
      outputPath,
      fusekiBase,
      recipientCount: 10,
      caseLabel: 'ten-local-recipients'
    });

    try {
      const child = instrumentation.middleware.localAction(
        async () => {
          const status = await request(`${fusekiBase}/query`);
          expect(status).toBe(204);
          return 'child-result';
        },
        { name: 'ldp.remote.store' }
      );

      const webAcl = instrumentation.middleware.localAction(async () => child({ id: 'child-1' }), {
        name: 'webacl.resource.hasRights'
      });
      const root = instrumentation.middleware.localAction(async () => webAcl({ id: 'acl-1' }), {
        name: 'activitypub.outbox.post'
      });

      await expect(root({ id: 'root-1', requestID: 'request-1' })).resolves.toBe('child-result');
      const [record] = readRecords(outputPath);
      expect(record.phase).toBe('APDM-P8-A');
      expect(record.requestId).toBe('request-1');
      expect(record.recipientCount).toBe(10);
      expect(record.caseLabel).toBe('ten-local-recipients');
      expect(record.actionCount).toBe(3);
      expect(record.actionCounts['activitypub.outbox.post']).toBe(1);
      expect(record.actionCounts['webacl.resource.hasRights']).toBe(1);
      expect(record.actionCounts['ldp.remote.store']).toBe(1);
      expect(record.categoryCounts.activitypub).toBe(1);
      expect(record.categoryCounts.webacl).toBe(1);
      expect(record.categoryCounts.ldp).toBe(1);
      expect(record.fuseki.requestCount).toBe(1);
      expect(record.fuseki.methodCounts.GET).toBe(1);
      expect(record.fuseki.pathCounts['/ds/query']).toBe(1);
      expect(record.fuseki.statusCounts['204']).toBe(1);
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(record.cpuUserMs).toBeGreaterThanOrEqual(0);
      expect(record.cpuSystemMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(record.heapUsedDelta)).toBe(true);
      expect(record.errors).toEqual([]);
    } finally {
      instrumentation.dispose();
      await close(server);
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  test('waits for detached local delivery before writing the root trace', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-detached-'));
    const outputPath = path.join(outputDirectory, 'measurement.jsonl');
    const instrumentation = createPhase8Tier1Instrumentation({ enabled: true, outputPath, recipientCount: 1 });
    const observer = globalThis[Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY)];

    try {
      const detachedChild = instrumentation.middleware.localAction(async () => {
        await delay(20);
        return 'detached-complete';
      }, { name: 'ldp.remote.store' });
      const root = instrumentation.middleware.localAction(async () => {
        observer('start', { id: 'activity-1' });
        void detachedChild({ id: 'detached-child' }).then(
          () => observer('finish', { id: 'activity-1' }),
          error => observer('finish', { id: 'activity-1' }, error)
        );
        return 'outbox-returned';
      }, { name: 'activitypub.outbox.post' });

      await expect(root({ id: 'root-detached', requestID: 'request-detached' })).resolves.toBe('outbox-returned');
      expect(fs.existsSync(outputPath)).toBe(false);
      await delay(35);
      const [record] = readRecords(outputPath);
      expect(record.requestId).toBe('request-detached');
      expect(record.actionCounts['ldp.remote.store']).toBe(1);
      expect(record.actionDurationsMs['ldp.remote.store']).toBeGreaterThan(0);
    } finally {
      instrumentation.dispose();
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  test('marks a short successful local fan-out unusable even when SemApps reports no failures', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-short-fanout-'));
    const outputPath = path.join(outputDirectory, 'measurement.jsonl');
    const instrumentation = createPhase8Tier1Instrumentation({ enabled: true, outputPath, recipientCount: 3 });
    const observer = globalThis[Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY)];
    const resultObserver = globalThis[Symbol.for(LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY)];

    try {
      const root = instrumentation.middleware.localAction(async () => {
        const activity = { id: 'activity-short' };
        observer('start', activity);
        resultObserver(activity, { success: ['actor-a', 'actor-b'], failures: [] });
        observer('finish', activity);
        return 'outbox-returned';
      }, { name: 'activitypub.outbox.post' });

      await expect(root({ id: 'root-short', requestID: 'request-short' })).resolves.toBe('outbox-returned');
      const [record] = readRecords(outputPath);
      expect(record.errors).toContainEqual({
        source: 'detached-local-delivery-count-mismatch',
        expectedRecipientCount: 3,
        successfulRecipientCount: 2,
        failureCount: 0
      });
    } finally {
      instrumentation.dispose();
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  test('keeps concurrent root traces isolated', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-concurrency-'));
    const outputPath = path.join(outputDirectory, 'measurement.jsonl');
    const instrumentation = createPhase8Tier1Instrumentation({ enabled: true, outputPath, recipientCount: 2 });

    try {
      const child = instrumentation.middleware.localAction(async ctx => {
        await delay(ctx.delayMs);
        return ctx.value;
      }, { name: 'ldp.remote.store' });
      const root = instrumentation.middleware.localAction(async ctx => child(ctx), {
        name: 'activitypub.outbox.post'
      });

      await expect(Promise.all([
        root({ id: 'root-a', requestID: 'request-a', delayMs: 20, value: 'a' }),
        root({ id: 'root-b', requestID: 'request-b', delayMs: 1, value: 'b' })
      ])).resolves.toEqual(['a', 'b']);

      const records = readRecords(outputPath).sort((a, b) => a.requestId.localeCompare(b.requestId));
      expect(records.map(record => record.requestId)).toEqual(['request-a', 'request-b']);
      for (const record of records) {
        expect(record.actionCount).toBe(2);
        expect(record.actionCounts['activitypub.outbox.post']).toBe(1);
        expect(record.actionCounts['ldp.remote.store']).toBe(1);
      }
    } finally {
      instrumentation.dispose();
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  test('measurement output failure cannot turn a successful delivery into failure', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-write-failure-'));
    const outputPath = path.join(outputDirectory, 'not-a-file');
    fs.mkdirSync(outputPath);
    const instrumentationErrors = [];
    const instrumentation = createPhase8Tier1Instrumentation({
      enabled: true,
      outputPath,
      onInstrumentationError: error => instrumentationErrors.push(error.message)
    });

    try {
      const root = instrumentation.middleware.localAction(async () => 'delivery-succeeded', {
        name: 'activitypub.outbox.post'
      });
      await expect(root({ id: 'root-write-failure' })).resolves.toBe('delivery-succeeded');
      expect(instrumentationErrors.length).toBeGreaterThan(0);
    } finally {
      instrumentation.dispose();
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  test('records failed nested actions while preserving the root failure', async () => {
    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-error-'));
    const outputPath = path.join(outputDirectory, 'measurement.jsonl');
    const instrumentation = createPhase8Tier1Instrumentation({ enabled: true, outputPath });

    try {
      const child = instrumentation.middleware.localAction(async () => {
        throw new Error('expected child failure');
      }, { name: 'activitypub.collection.add' });
      const root = instrumentation.middleware.localAction(async () => child({ id: 'child-error' }), {
        name: 'activitypub.outbox.post'
      });

      await expect(root({ id: 'root-error' })).rejects.toThrow('expected child failure');
      const [record] = readRecords(outputPath);
      expect(record.errors.some(error => error.source === 'moleculer-action')).toBe(true);
      expect(record.errors.some(error => error.source === 'root-action')).toBe(true);
    } finally {
      instrumentation.dispose();
      fs.rmSync(outputDirectory, { recursive: true, force: true });
    }
  });
});
