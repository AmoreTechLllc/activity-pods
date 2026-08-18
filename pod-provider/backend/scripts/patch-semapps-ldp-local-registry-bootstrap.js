'use strict';

const fs = require('fs');
const path = require('path');

const EXPECTED_PACKAGE = '@semapps/ldp';
const EXPECTED_VERSION = '1.1.4';
const ACTION_NAME = 'ldp.registry.register';
const PATCH_MARKER = 'ADSP-P2_LOCAL_LDP_REGISTRY_BOOTSTRAP';
const LOCAL_READY_ACTIONS = [ACTION_NAME, 'jsonld.parser.expandTypes', 'jsonld.context.get'];
const LOCAL_READY_TIMEOUT_MS = 30000;
const LOCAL_READY_POLL_MS = 25;

function findPackageRoot() {
  let current = path.dirname(require.resolve(EXPECTED_PACKAGE));

  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === EXPECTED_PACKAGE) return current;
    }
    current = path.dirname(current);
  }

  throw new Error(`[ADSP-P2] Could not locate ${EXPECTED_PACKAGE} package root`);
}

function walkJavaScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkJavaScriptFiles(entryPath));
    } else if (/\.(?:c?js|mjs)$/u.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function isControlledContainerCandidate(source) {
  return (
    source.includes(ACTION_NAME) &&
    source.includes('controlledActions') &&
    source.includes('waitForContainerCreation') &&
    source.includes('dependencies') &&
    source.includes('ldp')
  );
}

function locateControlledContainerSource(packageRoot) {
  const candidates = walkJavaScriptFiles(packageRoot).filter(file => {
    const source = fs.readFileSync(file, 'utf8');
    return source.includes(PATCH_MARKER) || isControlledContainerCandidate(source);
  });

  if (candidates.length !== 1) {
    throw new Error(
      `[ADSP-P2] Expected exactly one ${EXPECTED_PACKAGE} ControlledContainer artifact, found ${candidates.length}: ${candidates.join(', ')}`
    );
  }

  return candidates[0];
}

function countOccurrences(source, needle) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function findMatchingCallParen(source, openParen) {
  let depth = 1;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openParen + 1; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error('[ADSP-P2] Could not find the end of the pinned ldp.registry.register call');
}

function patchControlledContainerSource(source) {
  if (source.includes(PATCH_MARKER)) return { source, changed: false };
  if (!isControlledContainerCandidate(source)) {
    throw new Error('[ADSP-P2] SemApps ControlledContainer artifact no longer matches the expected v1.1.4 contract');
  }
  if (countOccurrences(source, ACTION_NAME) !== 1) {
    throw new Error(`[ADSP-P2] Expected exactly one ${ACTION_NAME} occurrence in ControlledContainer artifact`);
  }

  const actionIndex = source.indexOf(ACTION_NAME);
  const callIndex = source.lastIndexOf('this.broker.call(', actionIndex);
  if (callIndex === -1) {
    throw new Error(`[ADSP-P2] ${ACTION_NAME} is no longer invoked through this.broker.call`);
  }

  const statementIndex = source.lastIndexOf('const registration', callIndex);
  if (statementIndex === -1 || statementIndex > callIndex) {
    throw new Error(`[ADSP-P2] Could not locate the pinned registration assignment before ${ACTION_NAME}`);
  }

  const openParen = source.indexOf('(', callIndex);
  const closeParen = findMatchingCallParen(source, openParen);
  const callSource = source.slice(callIndex, closeParen + 1);
  if (!callSource.includes(ACTION_NAME)) {
    throw new Error(`[ADSP-P2] Located broker.call does not contain ${ACTION_NAME}`);
  }
  if (/nodeID\s*:\s*this\.broker\.nodeID/u.test(callSource)) {
    throw new Error(`[ADSP-P2] ${ACTION_NAME} already has local node targeting without the expected patch marker`);
  }

  const semicolonIndex = source.indexOf(';', closeParen);
  if (semicolonIndex === -1 || semicolonIndex - closeParen > 8) {
    throw new Error(`[ADSP-P2] Could not locate the end of the pinned ${ACTION_NAME} assignment`);
  }

  const readyActionsJson = JSON.stringify(LOCAL_READY_ACTIONS);
  const barrier = `const adspP2LocalBootstrapActions = ${readyActionsJson}; // ${PATCH_MARKER}\n    const adspP2LocalBootstrapDeadline = Date.now() + ${LOCAL_READY_TIMEOUT_MS};\n    while (\n      !adspP2LocalBootstrapActions.every(actionName =>\n        this.broker.registry.getActionEndpointByNodeId(actionName, this.broker.nodeID)\n      )\n    ) {\n      if (Date.now() >= adspP2LocalBootstrapDeadline) {\n        const missingLocalActions = adspP2LocalBootstrapActions.filter(\n          actionName => !this.broker.registry.getActionEndpointByNodeId(actionName, this.broker.nodeID)\n        );\n        throw new Error(\n          \`Timed out waiting for local SemApps bootstrap actions on \${this.broker.nodeID}: \${missingLocalActions.join(', ')}\`\n        );\n      }\n      await new Promise(resolve => setTimeout(resolve, ${LOCAL_READY_POLL_MS}));\n    }\n    `;

  const targetedCall = `${source.slice(statementIndex, closeParen)}, { nodeID: this.broker.nodeID }${source.slice(
    closeParen,
    semicolonIndex + 1
  )}`;
  const registrationGuard = `\n    if (!registration || typeof registration !== 'object') {\n      throw new Error('Local ldp.registry.register returned no registration object');\n    }`;

  return {
    source: `${source.slice(0, statementIndex)}${barrier}${targetedCall}${registrationGuard}${source.slice(
      semicolonIndex + 1
    )}`,
    changed: true
  };
}

function applyPatch() {
  const packageRoot = findPackageRoot();
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `[ADSP-P2] Refusing to patch ${EXPECTED_PACKAGE}@${packageJson.version}; expected exactly ${EXPECTED_VERSION}`
    );
  }

  const controlledContainerFile = locateControlledContainerSource(packageRoot);
  const originalSource = fs.readFileSync(controlledContainerFile, 'utf8');
  const result = patchControlledContainerSource(originalSource);

  if (result.changed) {
    fs.writeFileSync(controlledContainerFile, result.source, 'utf8');
    process.stdout.write(
      `[ADSP-P2] Patched ${path.relative(packageRoot, controlledContainerFile)} so LDP registry bootstrap waits for and stays on the local broker\n`
    );
  } else {
    process.stdout.write(`[ADSP-P2] ${path.relative(packageRoot, controlledContainerFile)} already patched\n`);
  }

  return { packageRoot, controlledContainerFile, changed: result.changed };
}

if (require.main === module) applyPatch();

module.exports = {
  EXPECTED_PACKAGE,
  EXPECTED_VERSION,
  ACTION_NAME,
  PATCH_MARKER,
  LOCAL_READY_ACTIONS,
  LOCAL_READY_TIMEOUT_MS,
  LOCAL_READY_POLL_MS,
  findPackageRoot,
  locateControlledContainerSource,
  findMatchingCallParen,
  patchControlledContainerSource,
  applyPatch
};
