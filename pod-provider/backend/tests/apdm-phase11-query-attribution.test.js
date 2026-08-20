'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  classifyQueryOperation,
  createPhase11QueryAttribution,
  fingerprintQueryShape,
  iriRefEnd,
  normalizeQueryObjectShape,
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

  test('normalizes the exact SemApps tripleExist ASK AST without retaining RDF values', () => {
    const buildAsk = ({ subject, object, graphName } = {}) => ({
      type: 'query',
      queryType: 'ASK',
      where: [
        graphName
          ? {
              type: 'graph',
              name: { termType: 'NamedNode', value: graphName },
              patterns: [{
                type: 'bgp',
                triples: [{
                  subject: { termType: 'NamedNode', value: subject },
                  predicate: { termType: 'NamedNode', value: 'https://schema.example/knows' },
                  object: { termType: 'NamedNode', value: object }
                }]
              }]
            }
          : {
              type: 'bgp',
              triples: [{
                subject: { termType: 'NamedNode', value: subject },
                predicate: { termType: 'NamedNode', value: 'https://schema.example/knows' },
                object: { termType: 'NamedNode', value: object }
              }]
            }
      ]
    });
    const first = buildAsk({ subject: 'https://private.example/alice', object: 'https://private.example/bob' });
    const second = buildAsk({ subject: 'https://private.example/carol', object: 'https://private.example/dave' });
    const graph = buildAsk({
      subject: 'https://private.example/alice',
      object: 'https://private.example/bob',
      graphName: 'https://private.example/acl'
    });

    expect(classifyQueryOperation(first)).toBe('ask');
    expect(fingerprintQueryShape(first)).toBe(fingerprintQueryShape(second));
    expect(fingerprintQueryShape(first)).not.toBe(fingerprintQueryShape(graph));
    const shape = normalizeQueryObjectShape(first);
    expect(shape).toContain('queryType:ASK');
    expect(shape).toContain('termType:NamedNode');
    expect(shape).not.toContain('private.example');
    expect(shape).not.toContain('schema.example');
    expect(shape).not.toContain('alice');
  });

  test('extracts supported string and object SPARQL query inputs only', () => {
    const askAst = { type: 'query', queryType: 'ASK', where: [] };
    expect(queryFromContext({ params: { query: 'ASK {}' } })).toBe('ASK {}');
    expect(queryFromContext({ params: { query: askAst } })).toBe(askAst);
    expect(queryFromContext({ params: { sparql: 'SELECT * {}' } })).toBe('SELECT * {}');
    expect(queryFromContext({ params: { query: ['ASK {}'] } })).toBeUndefined();
  });

  test('resolves immediate logical caller from retained Moleculer parent context first', () => {
    const contexts = new Map([
      ['root', 'activitypub.outbox.post'],
      ['parent', 'webacl.resource.hasRights']
    ]);
    expect(safeCallerName({ parentID: 'parent', caller: 'fallback.service' }, contexts)).toBe('webacl.resource.hasRights');
    expect(safeCallerName({ parentID: 'missing', caller: 'safe.service' }, contexts)).toBe('safe.service');
    expect(safeCallerName({ parentID: 'missing', caller: 'https://private.example/alice' }, contexts)).toBe('unknown');
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
    expect(record.lineageOverflowed).toBe(false);
    expect(record.lineageContextCount).toBeGreaterThanOrEqual(3);
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

  test('retains bounded parent lineage after the parent action settles', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-lineage-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({ enabled: true, outputPath, maxContexts: 16 });
    const queryWrapped = attribution.middleware.localAction(async () => true, { name: 'triplestore.query' });
    const parentWrapped = attribution.middleware.localAction(async () => 'settled', { name: 'ldp.resource.getContainers' });
    const rootWrapped = attribution.middleware.localAction(async () => {
      await parentWrapped({ id: 'parent', parentID: 'root', params: {} });
      return queryWrapped({
        id: 'query-after-parent',
        parentID: 'parent',
        params: { query: 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }' }
      });
    }, { name: 'activitypub.outbox.post' });

    await rootWrapped({ id: 'root', params: {} });
    attribution.dispose();
    const record = JSON.parse(fs.readFileSync(outputPath, 'utf8').trim());
    expect(record.unattributedQueryCalls).toBe(0);
    expect(record.queries[0]).toMatchObject({ caller: 'ldp.resource.getContainers', operation: 'construct', count: 1 });
    expect(record.lineageOverflowed).toBe(false);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('records SemApps object-AST queries as ASK without leaking values', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-ast-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({ enabled: true, outputPath });
    const ast = {
      type: 'query',
      queryType: 'ASK',
      where: [{
        type: 'bgp',
        triples: [{
          subject: { termType: 'NamedNode', value: 'https://private.example/alice' },
          predicate: { termType: 'NamedNode', value: 'https://schema.example/knows' },
          object: { termType: 'NamedNode', value: 'https://private.example/bob' }
        }]
      }]
    };
    const queryWrapped = attribution.middleware.localAction(async () => true, { name: 'triplestore.query' });
    const tripleExistWrapped = attribution.middleware.localAction(
      async () => queryWrapped({ id: 'query', parentID: 'triple-exist', params: { query: ast, dataset: 'private-alice' } }),
      { name: 'triplestore.tripleExist' }
    );
    const rootWrapped = attribution.middleware.localAction(
      async () => tripleExistWrapped({ id: 'triple-exist', parentID: 'root', params: {} }),
      { name: 'activitypub.outbox.post' }
    );

    await rootWrapped({ id: 'root', params: {} });
    attribution.dispose();
    const artifactText = fs.readFileSync(outputPath, 'utf8');
    const record = JSON.parse(artifactText.trim());
    expect(record.queries[0]).toMatchObject({ caller: 'triplestore.tripleExist', operation: 'ask', count: 1 });
    expect(artifactText).not.toContain('private.example');
    expect(artifactText).not.toContain('schema.example');
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

  test('bounds retained context lineage and marks overflow fail-closed', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p11-lineage-cap-'));
    const outputPath = path.join(directory, 'attribution.jsonl');
    const attribution = createPhase11QueryAttribution({ enabled: true, outputPath, maxContexts: 2 });
    const queryWrapped = attribution.middleware.localAction(async () => true, { name: 'triplestore.query' });
    const callerWrapped = attribution.middleware.localAction(
      async () => queryWrapped({ id: 'query', parentID: 'caller', params: { query: 'ASK {}' } }),
      { name: 'activitypub.actor.get' }
    );
    const rootWrapped = attribution.middleware.localAction(
      async () => callerWrapped({ id: 'caller', parentID: 'root', params: {} }),
      { name: 'activitypub.outbox.post' }
    );

    await rootWrapped({ id: 'root', params: {} });
    attribution.dispose();
    const record = JSON.parse(fs.readFileSync(outputPath, 'utf8').trim());
    expect(record.lineageContextCount).toBe(2);
    expect(record.lineageOverflowed).toBe(true);
    expect(record.droppedLineageContexts).toBe(1);
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
