'use strict';

const {
  PATCH_MARKER,
  PATCHED_CACHE_DECLARATION,
  ACTION_CONTRACTS,
  matchesActionContract,
  patchContextActionSource
} = require('../scripts/patch-semapps-jsonld-distributed-context-cache');

function fixture(contractName) {
  if (contractName === 'jsonld.context.get') {
    return `
const Schema = {
  visibility: 'public',
  cache: true,
  async handler(ctx) {
    const ontologies = await ctx.call('ontologies.list');
    const localContext = await this.actions.getLocal({}, { parentCtx: ctx });
    return [ontologies, localContext];
  }
};
`;
  }

  return `
const Schema = {
  visibility: 'public',
  cache: true,
  async handler(ctx) {
    let ontologies = await ctx.call('ontologies.list');
    ontologies = ontologies.filter(ont => ont.preserveContextUri !== true);
    return ontologies;
  }
};
`;
}

describe('ADSP P2 distributed JSON-LD context cache patch', () => {
  test.each(ACTION_CONTRACTS)('recognizes the pinned $name artifact', contract => {
    expect(matchesActionContract(fixture(contract.name), contract)).toBe(true);
  });

  test.each(ACTION_CONTRACTS)('disables $name caching only in distributed mode', contract => {
    const patched = patchContextActionSource(fixture(contract.name), contract);
    expect(patched.changed).toBe(true);
    expect(patched.source).toContain(PATCHED_CACHE_DECLARATION);
    expect(patched.source).toContain(PATCH_MARKER);
    expect(patched.source).not.toContain('cache: true');
    expect(patched.source).toContain("process.env.SEMAPPS_MOLECULER_MODE === 'distributed' ? false : true");
  });

  test.each(ACTION_CONTRACTS)('is idempotent for $name', contract => {
    const first = patchContextActionSource(fixture(contract.name), contract);
    const second = patchContextActionSource(first.source, contract);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  test('fails closed when an action no longer matches the pinned structure', () => {
    expect(() => patchContextActionSource('const Schema = { cache: true };', ACTION_CONTRACTS[0])).toThrow(
      /no longer matches the pinned SemApps context-action contract/u
    );
  });

  test('fails closed when the pinned action exposes multiple cache declarations', () => {
    const source = `${fixture('jsonld.context.get')}\nconst other = { cache: true };`;
    expect(() => patchContextActionSource(source, ACTION_CONTRACTS[0])).toThrow(
      /Expected exactly one cache: true declaration/u
    );
  });
});
