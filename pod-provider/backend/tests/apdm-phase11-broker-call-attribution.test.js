'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createPhase11QueryAttribution,
  safeCallerName
} = require('../lib/apdm-phase11-query-attribution');

describe('APDM Phase 11 broker.call attribution fallback', () => {
  test('uses async call-site lineage only when Moleculer parent and caller metadata are absent', () => {
    const contexts = new Map([['parent', 'webacl.resource.hasRights']]);

    expect(safeCallerName({ parentID: 'parent', caller: 'fallback.service' }, contexts, 'async.service')).toBe(
      'webacl.resource.hasRights'
    );
    expect(safeCallerName({ parentID: 'missing', caller: 'safe.service' }, contexts, 'async.service')).toBe(
      'safe.service'
    );
    expect(safeCallerName({ parentID: 'missing' }, contexts, 'auth.account.findByWebId')).toBe(
      'auth.account.findByWebId'
    );
    expect(safeCallerName({ parentID: 'missing' }, contexts, 'https://private.example/alice')).toBe('unknown');
  });

  test('attributes SemApps-style broker.call queries to the active action without changing query metadata', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-broker-call-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({ enabled: true, outputPath });

    const observedContexts = [];
    const queryWrapped = attribution.middleware.localAction(async ctx => {
      observedContexts.push({ parentID: ctx.parentID, caller: ctx.caller });
      return true;
    }, { name: 'triplestore.query' });
    const accountWrapped = attribution.middleware.localAction(
      async () => queryWrapped({
        id: 'query-without-moleculer-lineage',
        params: { query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }', dataset: 'private-alice' }
      }),
      { name: 'auth.account.findByWebId' }
    );
    const rootWrapped = attribution.middleware.localAction(
      async () => accountWrapped({ id: 'account', parentID: 'root', params: {} }),
      { name: 'activitypub.outbox.post' }
    );

    await rootWrapped({ id: 'root', requestID: 'opaque-broker-call-test', params: {} });
    attribution.dispose();

    expect(observedContexts).toEqual([{ parentID: undefined, caller: undefined }]);
    const artifactText = fs.readFileSync(outputPath, 'utf8');
    const record = JSON.parse(artifactText.trim());
    expect(record.totalQueryCalls).toBe(1);
    expect(record.attributedQueryCalls).toBe(1);
    expect(record.unattributedQueryCalls).toBe(0);
    expect(record.queries).toHaveLength(1);
    expect(record.queries[0]).toMatchObject({
      caller: 'auth.account.findByWebId',
      operation: 'construct',
      count: 1,
      errorCount: 0
    });
    expect(artifactText).not.toContain('private-alice');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('keeps concurrent broker.call fallbacks isolated across c4-style action branches', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-broker-call-c4-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({ enabled: true, outputPath });

    const queryWrapped = attribution.middleware.localAction(
      async () => new Promise(resolve => setImmediate(() => resolve(true))),
      { name: 'triplestore.query' }
    );
    const callerA = attribution.middleware.localAction(
      async () => {
        await new Promise(resolve => setImmediate(resolve));
        return queryWrapped({ id: 'query-a', params: { query: 'ASK { ?s ?p ?o }' } });
      },
      { name: 'activitypub.actor.get' }
    );
    const callerB = attribution.middleware.localAction(
      async () => {
        await Promise.resolve();
        return queryWrapped({ id: 'query-b', params: { query: 'SELECT * WHERE { ?s ?p ?o }' } });
      },
      { name: 'auth.account.findByWebId' }
    );
    const rootWrapped = attribution.middleware.localAction(
      async () => Promise.all([
        callerA({ id: 'caller-a', parentID: 'root', params: {} }),
        callerB({ id: 'caller-b', parentID: 'root', params: {} })
      ]),
      { name: 'activitypub.outbox.post' }
    );

    await rootWrapped({ id: 'root', requestID: 'opaque-c4-test', params: {} });
    attribution.dispose();

    const record = JSON.parse(fs.readFileSync(outputPath, 'utf8').trim());
    expect(record.totalQueryCalls).toBe(2);
    expect(record.attributedQueryCalls).toBe(2);
    expect(record.unattributedQueryCalls).toBe(0);
    expect(record.queries).toEqual(expect.arrayContaining([
      expect.objectContaining({ caller: 'activitypub.actor.get', operation: 'ask', count: 1 }),
      expect.objectContaining({ caller: 'auth.account.findByWebId', operation: 'select', count: 1 })
    ]));
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
