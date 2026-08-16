'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/triplestore';
const EXPECTED_VERSION = '1.1.4';

function findPackageRoot() {
  let current = path.dirname(require.resolve(EXPECTED_PACKAGE));
  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === EXPECTED_PACKAGE) return { root: current, packageJson };
    }
    current = path.dirname(current);
  }
  throw new Error(`Could not locate ${EXPECTED_PACKAGE}`);
}

function walkJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScriptFiles(entryPath));
    else if (/\.(?:c?js|mjs)$/u.test(entry.name)) files.push(entryPath);
  }
  return files;
}

function extractDatasetExistBlock(source) {
  const start = source.indexOf('async exist(ctx) {');
  if (start === -1) throw new Error('Pinned SemApps dataset service no longer exposes async exist(ctx)');

  // The compiled 1.1.4 service places list immediately after exist, but build
  // formatting/indentation is not part of the semantic contract. Find the next
  // action token rather than pinning whitespace so only meaningful drift fails.
  const searchFrom = start + 'async exist(ctx) {'.length;
  const endMarkers = ['async list()', 'list: {', 'async list(ctx)'];
  const end = endMarkers
    .map(marker => source.indexOf(marker, searchFrom))
    .filter(index => index !== -1)
    .sort((a, b) => a - b)[0];
  if (end === undefined) throw new Error('Could not isolate pinned SemApps dataset.exist action boundary');

  return source.slice(start, end);
}

function isReviewedDatasetExistArtifact(source) {
  if (!source.includes("name: 'triplestore.dataset'")) return false;
  try {
    const block = extractDatasetExistBlock(source);
    return block.includes("'$/datasets/'") && block.includes('response.status === 200');
  } catch (_error) {
    return false;
  }
}

describe('APDM Phase 10 pinned SemApps dataset.exist contract', () => {
  test('fails closed if the reviewed pure GET-to-boolean contract drifts', () => {
    const { root, packageJson } = findPackageRoot();
    expect(packageJson.version).toBe(EXPECTED_VERSION);

    const candidates = walkJavaScriptFiles(root).filter(file =>
      isReviewedDatasetExistArtifact(fs.readFileSync(file, 'utf8'))
    );

    expect(candidates).toHaveLength(1);
    const source = fs.readFileSync(candidates[0], 'utf8');
    const existBlock = extractDatasetExistBlock(source);

    expect(existBlock).toContain('const { dataset } = ctx.params;');
    expect(existBlock).toContain("urlJoin(this.settings.url, '$/datasets/', dataset)");
    expect(existBlock).toContain('headers: this.headers');
    expect(existBlock).toContain('return response.status === 200;');
    expect(existBlock).not.toMatch(/method\s*:/u);
  });

  test('extractor ignores formatting and excludes neighboring mutating actions', () => {
    const source = [
      "name: 'triplestore.dataset',",
      'async exist(ctx) {',
      '  const { dataset } = ctx.params;',
      "  const response = await fetch(urlJoin(this.settings.url, '$/datasets/', dataset), { headers: this.headers });",
      '  return response.status === 200;',
      '},',
      '        async list() {',
      "  return fetch('/datasets', { method: 'POST' });",
      '}'
    ].join('\n');

    const block = extractDatasetExistBlock(source);
    expect(block).toContain('response.status === 200');
    expect(block).not.toContain("method: 'POST'");
  });
});

module.exports = { extractDatasetExistBlock, isReviewedDatasetExistArtifact };
