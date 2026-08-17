'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_PHASE = 'APDM-P10-A';
const REQUIRED_CONCURRENCY = 4;
const VALID_ARM_ORDERS = new Set(['off-first', 'on-first']);
const HARD_MATCHED_FIELDS = [
  'phase',
  'armOrder',
  'commitSha',
  'workflowRunId',
  'runAttempt',
  'concurrency',
  'runnerOs',
  'runnerArch',
  'imageOs',
  'imageVersion',
  'hostNode',
  'backendImageId',
  'fusekiImageId',
  'redisImageId',
  'mailcatcherImageId'
];
const RESOURCE_COMPARABILITY_FIELDS = ['hostCpuModel', 'hostCpuCount', 'hostTotalMemoryBytes'];
const REQUIRED_FIELDS = [...HARD_MATCHED_FIELDS, ...RESOURCE_COMPARABILITY_FIELDS];

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertNonEmpty(value, label) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`Missing Phase 10 provenance field: ${label}`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid Phase 10 provenance field ${label}: expected a positive safe integer`);
  }
}

function parsePositiveIntegerString(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`Invalid Phase 10 provenance field ${label}: expected a positive integer string`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid Phase 10 provenance field ${label}: exceeds safe integer range`);
  }
  return parsed;
}

function captureValidation(failures, validator) {
  try {
    validator();
  } catch (error) {
    failures.push(error.message);
  }
}

function validateEnvironment(control, enabled) {
  const failures = [];
  const resourceDifferences = [];
  let runAttempt;

  for (const [label, manifest] of [['control', control], ['enabled', enabled]]) {
    for (const field of REQUIRED_FIELDS) {
      captureValidation(failures, () => assertNonEmpty(manifest[field], `${label}.${field}`));
    }
    captureValidation(failures, () => assertPositiveInteger(manifest.hostCpuCount, `${label}.hostCpuCount`));
    captureValidation(failures, () => assertPositiveInteger(manifest.hostTotalMemoryBytes, `${label}.hostTotalMemoryBytes`));
    captureValidation(failures, () => parsePositiveIntegerString(manifest.runAttempt, `${label}.runAttempt`));
  }

  try {
    runAttempt = parsePositiveIntegerString(control.runAttempt, 'control.runAttempt');
  } catch (_error) {
    runAttempt = undefined;
  }

  if (control.phase !== REQUIRED_PHASE || enabled.phase !== REQUIRED_PHASE) {
    failures.push(`Both manifests must declare phase ${REQUIRED_PHASE}`);
  }
  if (control.arm !== 'off' || control.memoEnabled !== false) {
    failures.push('Control manifest must prove arm=off and memoEnabled=false');
  }
  if (enabled.arm !== 'on' || enabled.memoEnabled !== true) {
    failures.push('Enabled manifest must prove arm=on and memoEnabled=true');
  }
  if (control.concurrency !== REQUIRED_CONCURRENCY || enabled.concurrency !== REQUIRED_CONCURRENCY) {
    failures.push(`Both manifests must prove APDM local-delivery concurrency ${REQUIRED_CONCURRENCY}`);
  }

  const expectedArmOrder = runAttempt === undefined ? undefined : (runAttempt % 2 === 1 ? 'off-first' : 'on-first');
  if (!VALID_ARM_ORDERS.has(control.armOrder) || !VALID_ARM_ORDERS.has(enabled.armOrder)) {
    failures.push('Both manifests must declare a valid Phase 10 armOrder');
  } else if (expectedArmOrder && control.armOrder !== expectedArmOrder) {
    failures.push(`Phase 10 armOrder ${control.armOrder} does not match run attempt ${control.runAttempt}`);
  }

  for (const field of HARD_MATCHED_FIELDS) {
    if (control[field] !== enabled[field]) {
      failures.push(`Evidence arms differ at ${field}: ${JSON.stringify(control[field])} vs ${JSON.stringify(enabled[field])}`);
    }
  }
  for (const field of RESOURCE_COMPARABILITY_FIELDS) {
    if (control[field] !== enabled[field]) {
      resourceDifferences.push(
        `Resource environments differ at ${field}: ${JSON.stringify(control[field])} vs ${JSON.stringify(enabled[field])}`
      );
    }
  }

  // This validator is the workflow's authoritative pre-comparison gate. The
  // paired Phase 10 design promises one runner precisely so elapsed/CPU/heap
  // interpretation is not mixed across host classes. Resource mismatches are
  // therefore evidence-invalid, not merely advisory metadata.
  const passed = failures.length === 0 && resourceDifferences.length === 0;

  return {
    phase: REQUIRED_PHASE,
    passed,
    requiredConcurrency: REQUIRED_CONCURRENCY,
    hardMatchedFields: HARD_MATCHED_FIELDS,
    resourceComparabilityFields: RESOURCE_COMPARABILITY_FIELDS,
    resourceComparable: passed,
    resourceDifferences,
    control: { arm: control.arm, armOrder: control.armOrder, memoEnabled: control.memoEnabled },
    enabled: { arm: enabled.arm, armOrder: enabled.armOrder, memoEnabled: enabled.memoEnabled },
    failures
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length < 2) {
    throw new Error('Usage: apdm-phase10-validate-environment.js <off-manifest> <on-manifest> [output.json]');
  }
  const result = validateEnvironment(readManifest(path.resolve(argv[0])), readManifest(path.resolve(argv[1])));
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (argv[2]) {
    const output = path.resolve(argv[2]);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, rendered, 'utf8');
  } else {
    process.stdout.write(rendered);
  }
  if (!result.passed) process.exitCode = 2;
}

if (require.main === module) main();

module.exports = {
  HARD_MATCHED_FIELDS,
  RESOURCE_COMPARABILITY_FIELDS,
  REQUIRED_CONCURRENCY,
  REQUIRED_PHASE,
  VALID_ARM_ORDERS,
  assertPositiveInteger,
  parsePositiveIntegerString,
  validateEnvironment
};
