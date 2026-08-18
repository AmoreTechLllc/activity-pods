'use strict';

const fs = require('fs');
const path = require('path');
const {
  EXPECTED_VERSION,
  PATCH_MARKER,
  ONTOLOGY_PENDING_PATTERN,
  findPackageRoot,
  locateControlledContainerSource,
  patchControlledContainerSource
} = require('../scripts/patch-semapps-ldp-local-registry-bootstrap');

describe('ADSP P2 SemApps LDP local bootstrap patch', () => {
  test('uses only the local registry, retries semantic bootstrap readiness, guards the result, and is idempotent', () => {
    const source = [
      "module.exports = {",
      "  dependencies: ['ldp'],",
      "  async started() {",
      "    const controlledActions = {};",
      "    const rest = {};",
      "    const registration = await this.broker.call('ldp.registry.register', {",
      "      path: '/profiles',",
      "      controlledActions: { post: `${this.name}.post` },",
      "      ...rest",
      "    });",
      "    return registration;",
      "  },",
      "  actions: { waitForContainerCreation() {} }",
      "};",
      ""
    ].join('\n');

    const first = patchControlledContainerSource(source);
    expect(first.changed).toBe(true);
    expect(first.source).toContain(PATCH_MARKER);
    expect(first.source).toContain("this.broker.getLocalService('ldp.registry')");
    expect(first.source).toContain('adspP2LocalRegistry.actions.register({');
    expect(first.source).not.toContain("this.broker.call('ldp.registry.register'");
    expect(first.source).toContain('Could not expand (?:all types|predicate)');
    expect(first.source).toContain('Local ldp.registry.register returned no registration object');
    expect(first.source).toContain('Date.now() + 30000');

    const second = patchControlledContainerSource(first.source);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
  });

  test('retries only the explicit SemApps missing-ontology expansion condition', () => {
    expect(ONTOLOGY_PENDING_PATTERN.test('Could not expand all types (as:Note).')).toBe(true);
    expect(ONTOLOGY_PENDING_PATTERN.test('Could not expand predicate (as:foo).')).toBe(true);
    expect(ONTOLOGY_PENDING_PATTERN.test('Fuseki refused the write')).toBe(false);
    expect(ONTOLOGY_PENDING_PATTERN.test('Validation failed')).toBe(false);
  });

  test('fails closed if the pinned ControlledContainer semantic shape drifts', () => {
    expect(() => patchControlledContainerSource("this.broker.call('ldp.registry.register', {})")).toThrow(
      /no longer matches the expected v1\.1\.4 contract/u
    );

    const duplicate = [
      "const controlledActions = {};",
      "function waitForContainerCreation() {}",
      "const dependencies = ['ldp'];",
      "this.broker.call('ldp.registry.register', {});",
      "this.broker.call('ldp.registry.register', {});"
    ].join('\n');
    expect(() => patchControlledContainerSource(duplicate)).toThrow(/exactly one ldp\.registry\.register occurrence/u);
  });

  test('the installed pinned SemApps artifact has local semantic bootstrap retry after postinstall', () => {
    const packageRoot = findPackageRoot();
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(packageJson.version).toBe(EXPECTED_VERSION);

    const controlledContainerFile = locateControlledContainerSource(packageRoot);
    const source = fs.readFileSync(controlledContainerFile, 'utf8');
    expect(source).toContain(PATCH_MARKER);
    expect(source).toContain("getLocalService('ldp.registry')");
    expect(source).toContain('actions.register');
    expect(source).toContain('Could not expand (?:all types|predicate)');
    expect(source).toContain('Local ldp.registry.register returned no registration object');
  });
});
