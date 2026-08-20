'use strict';

const {
  PATCH_MARKER,
  PATCHED_CACHE_DECLARATION,
  ACTION_CONTRACTS,
  matchesActionContract,
  patchOntologyActionSource
} = require('../scripts/patch-semapps-ontologies-distributed-cache');

const fixtures = {
  'ontologies.list': `const Schema = { cache: true, handler() { return Object.values(this.ontologies); } };`,
  'ontologies.get': `const Schema = { cache: true, handler({ params: { prefix, uri } }) { return this.ontologies[prefix] || Object.values(this.ontologies).find(o => uri.startsWith(o.namespace)); } };`,
  'ontologies.getPrefixes': `const Schema = { cache: true, async handler(ctx) { const values = await this.actions.list({}, { parentCtx: ctx }); return Object.fromEntries(values.map(o => [o.prefix, o.namespace])); } };`,
  'ontologies.getRdfPrefixes': 'const Schema = { cache: true, async handler(ctx) { const values = await this.actions.list({}, { parentCtx: ctx }); return values.map(ontology => `PREFIX ${ontology.prefix}: <${ontology.namespace}>`).join("\\n"); } };',
  'ontologies.prefixToUri': 'const Schema = { cache: true, async handler() { const prefix = "as"; const ontology = await this.actions.get({ prefix }); if (!ontology) throw new Error(`No ontology found with prefix ${prefix}`); return ontology.namespace; } };'
};

describe('ADSP P2 distributed ontology cache patch', () => {
  test.each(ACTION_CONTRACTS)('recognizes the pinned $name artifact contract', contract => {
    expect(matchesActionContract(fixtures[contract.name], contract)).toBe(true);
  });

  test.each(ACTION_CONTRACTS)('disables $name cache only in distributed mode', contract => {
    const result = patchOntologyActionSource(fixtures[contract.name], contract);
    expect(result.changed).toBe(true);
    expect(result.source).toContain(PATCHED_CACHE_DECLARATION);
    expect(result.source).toContain(PATCH_MARKER);
    expect(result.source).not.toContain('cache: true');
  });

  test.each(ACTION_CONTRACTS)('is idempotent for $name', contract => {
    const first = patchOntologyActionSource(fixtures[contract.name], contract);
    const second = patchOntologyActionSource(first.source, contract);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  test('fails closed on structural drift', () => {
    expect(() => patchOntologyActionSource('const Schema = { cache: true };', ACTION_CONTRACTS[0])).toThrow(
      /no longer matches the pinned SemApps ontology-action contract/u
    );
  });
});
