'use strict';

const fs = require('fs');
const path = require('path');
const {
  EXPECTED_VERSION,
  PATCH_MARKER,
  findPackageRoot,
  locateControlledContainerSource,
  patchControlledContainerSource
} = require('../scripts/patch-semapps-ldp-local-registry-bootstrap');

describe('ADSP P2 SemApps LDP local bootstrap patch', () => {
  test('targets only the bootstrap ldp.registry.register call to the local broker and is idempotent', () => {
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
    expect(first.source).toContain(
      `}, { nodeID: this.broker.nodeID } /* ${PATCH_MARKER} */);`
    );
    expect(first.source.match(/ldp\.registry\.register/gu)).toHaveLength(1);

    const second = patchControlledContainerSource(first.source);
    expect(second.changed).toBe(false);
    expect(second.source).toBe(first.source);
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

  test('the installed pinned SemApps artifact is actually patched after postinstall', () => {
    const packageRoot = findPackageRoot();
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    expect(packageJson.version).toBe(EXPECTED_VERSION);

    const controlledContainerFile = locateControlledContainerSource(packageRoot);
    const source = fs.readFileSync(controlledContainerFile, 'utf8');
    expect(source).toContain(PATCH_MARKER);
    expect(source).toMatch(/nodeID\s*:\s*this\.broker\.nodeID/u);
  });
});
