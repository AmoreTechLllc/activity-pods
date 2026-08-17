'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyQueryOperation,
  createPhase11QueryAttribution,
  fingerprintQueryShape,
  iriRefEnd,
  normalizeQueryShape,
  queryFromContext,
  safeCallerName
} = require('../lib/apdm-phase11-query-attribution');

describe('APDM Phase 11 query attribution', () => {
  test('normalizes values away while preserving structural distinctions', () => {
    const first = `
      # benchmark user A
      SELECT ?resource WHERE {
        <https://pod.example/alice> <https://schema.example/name> "Alice" .
        ?resource <https://schema.example/count> 42 .
      }
    `;
    const second = `SELECT ?resource WHERE {
      <https://pod.example/bob> <https://schema.example/name> "Bob" .
      ?resource <https://schema.example/count> 999 .
    }`;
    const different = `ASK { <https://pod.example/bob> <https://schema.example/name> "Bob" . }`;

    expect(fingerprintQueryShape(first)).toBe(fingerprintQueryShape(second));
    expect(fingerprintQueryShape(first)).not.toBe(fingerprintQueryShape(different));
    expect(normalizeQueryShape(first)).not.toContain('Alice');
    expect(normalizeQueryShape(first)).not.toContain('pod.example');
    expect(normalizeQueryShape(first)).not.toContain('42');
  });

  test('distinguishes IRI references from less-than comparison operators', () => {
    const iri = '<https://example.test/resource>';
    expect(iriRefEnd(iri, 0)).toBe(iri.length);
    expect(iriRefEnd('?n < 10', 3)).toBeUndefined();

    const lessThan = 'SELECT * WHERE { ?s ?p ?n . FILTER(?n < 10) }';
    const greaterThan = 'SELECT * WHERE { ?s ?p ?n . FILTER(?n > 10) }';
    const lessThanOtherConstant = 'SELECT * WHERE { ?s ?p ?n . FILTER(?n < 999) }';

    expect(normalizeQueryShape(lessThan)).toContain('?n < NUMBER');
    expect(fingerprintQueryShape(lessThan)).toBe(fingerprintQueryShape(lessThanOtherConstant));
    expect(fingerprintQueryShape(lessThan)).not.toBe(fingerprintQueryShape(greaterThan));
  });

  test('classifies operations after stripping comments, literals and IRIs', () => {
    expect(classifyQueryOperation('PREFIX ex: <https://example.test/> SELECT * WHERE { ?s ?p ?o }')).toBe('select');
    expect(classifyQueryOperation('WITH <https://example.test/g> DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }')).toBe('with');
    expect(classifyQueryOperation('# SELECT is only a comment\nASK { ?s ?p "DELETE" }')).toBe('ask');
    expect(classifyQueryOperation(undefined)).toBe('unknown');
  });

  test('extracts only supported SPARQL parameter strings', () => {
    expect(queryFromContext({ params: { query: 'ASK {}' } })).toBe('ASK {}');
    expect(queryFromContext({ params: { sparql: 'SELECT * {}' } })).toBe('SELECT * {}');
    expect(queryFromContext({ params: { query: { text: 'ASK {}' } } })).toBeUndefined();
  });

  test('resolves immediate logical caller from Moleculer parent context first', () => {
    const active = new Map([
      ['root', 'activitypub.outbox.post'],
      ['parent', 'webacl.resource.hasRights']
    ]);
    expect(safeCallerName({ parentID: 'parent', caller: 'fallback.service' }, active)).toBe('webacl.resource.hasRights');
    expect(safeCallerName({ parentID: 'missing', caller: 'safe.service' }, active)).toBe('safe.service');
    expect(safeCallerName({ parentID: 'missing', caller: 'https://private.example/alice' }, active)).toBe('unknown');
  });

  test('disabled attribution is inert', () => {
    const attribution = createPhase11QueryAttribution({ enabled: false });
    expect(attribution.middleware).toBeNull();
    expect(() => attribution.dispose()).not.toThrow();
  });

  test('attributes a query to its parent action and writes only privacy-safe aggregates', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({
      enabled: true,
      outputPath,
      recipientCount: 10,
      caseLabel: 'unit-10'
    });

    const queryText = 'SELECT ?o WHERE { <https://private.example/alice> <https://schema.example/name> "Secret Alice" . }';
    const queryWrapped = attribution.middleware.localAction(async () => ({ ok: true }), { name: 'triplestore.query' });
    const callerWrapped = attribution.middleware.localAction(
      async () =>
        queryWrapped({
          id: 'query',
          parentID: 'caller',
          caller: 'triplestore',
          params: { query: queryText, dataset: 'private-alice' }
        }),
      { name: 'webacl.resource.hasRights' }
    );
    const rootWrapped = attribution.middleware.localAction(
      async () => callerWrapped({ id: 'caller', parentID: 'root', params: {} }),
      { name: 'activitypub.outbox.post' }
    );

    await expect(rootWrapped({ id: 'root', requestID: 'opaque-test-request', params: {} })).resolves.toEqual({ ok: true });
    attribution.dispose();

    const artifactText = fs.readFileSync(outputPath, 'utf8');
    const record = JSON.parse(artifactText.trim());
    expect(record.phase).toBe('APDM-P11-A');
    expect(record.totalQueryCalls).toBe(1);
    expect(record.attributedQueryCalls).toBe(1);
    expect(record.unattributedQueryCalls).toBe(0);
    expect(record.overflowed).toBe(false);
    expect(record.queries).toHaveLength(1);
    expect(record.queries[0]).toMatchObject({
      caller: 'webacl.resource.hasRights',
      operation: 'select',
      count: 1,
      errorCount: 0
    });
    expect(record.queries[0].shapeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifactText).not.toContain('private.example');
    expect(artifactText).not.toContain('Secret Alice');
    expect(artifactText).not.toContain('private-alice');
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('records failed queries without changing the thrown error', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-error-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({ enabled: true, outputPath });
    const expected = new Error('query failure');

    const queryWrapped = attribution.middleware.localAction(async () => {
      throw expected;
    }, { name: 'triplestore.query' });
    const callerWrapped = attribution.middleware.localAction(
      async () => queryWrapped({ id: 'query', parentID: 'caller', params: { query: 'ASK {}' } }),
      { name: 'ldp.resource.get' }
    );
    const rootWrapped = attribution.middleware.localAction(
      async () => callerWrapped({ id: 'caller', parentID: 'root', params: {} }),
      { name: 'activitypub.outbox.post' }
    );

    await expect(rootWrapped({ id: 'root', params: {} })).rejects.toBe(expected);
    attribution.dispose();
    const record = JSON.parse(fs.readFileSync(outputPath, 'utf8').trim());
    expect(record.queries[0].errorCount).toBe(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('bounds attribution cardinality and marks overflow instead of growing without limit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-cap-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({ enabled: true, outputPath, maxKeys: 1 });

    const queryWrapped = attribution.middleware.localAction(async () => true, { name: 'triplestore.query' });
    const callerWrapped = attribution.middleware.localAction(async () => {
      await queryWrapped({ id: 'q1', parentID: 'caller', params: { query: 'ASK {}' } });
      await queryWrapped({ id: 'q2', parentID: 'caller', params: { query: 'SELECT * WHERE { ?s ?p ?o }' } });
      return true;
    }, { name: 'activitypub.actor.get' });
    const rootWrapped = attribution.middleware.localAction(
      async () => callerWrapped({ id: 'caller', parentID: 'root', params: {} }),
      { name: 'activitypub.outbox.post' }
    );

    await rootWrapped({ id: 'root', params: {} });
    attribution.dispose();
    const record = JSON.parse(fs.readFileSync(outputPath, 'utf8').trim());
    expect(record.totalQueryCalls).toBe(2);
    expect(record.distinctAttributionKeys).toBe(1);
    expect(record.overflowed).toBe(true);
    expect(record.droppedCalls).toBe(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
