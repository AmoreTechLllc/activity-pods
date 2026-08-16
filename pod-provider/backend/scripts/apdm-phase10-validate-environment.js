'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_PHASE = 'APDM-P10-A';
const REQUIRED_CONCURRENCY = 4;
const MATCHED_FIELDS = [
  'phase',
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

function readManifest(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function assertNonEmpty(value, label) {
  if (value === undefined || value === null || value === '') throw new Error(`Missing Phase 10 provenance field: ${label}`);
}

function validateEnvironment(control, enabled) {
  const failures = [];

  for (const [label, manifest] of [['control', control], ['enabled', enabled]]) {
    for (const field of MATCHED_FIELDS) {
      try {
        assertNonEmpty(manifest[field], `${label}.${field}`);
      } catch (error) {
        failures.push(error.message);
      }
    }
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
  if (Number(control.concurrency) !== REQUIRED_CONCURRENCY || Number(enabled.concurrency) !== REQUIRED_CONCURRENCY) {
    failures.push(`Both manifests must prove APDM local-delivery concurrency ${REQUIRED_CONCURRENCY}`);
  }

  for (const field of MATCHED_FIELDS) {
    if (control[field] !== enabled[field]) {
      failures.push(`Evidence arms differ at ${field}: ${JSON.stringify(control[field])} vs ${JSON.stringify(enabled[field])}`);
    }
  }

  return {
    phase: REQUIRED_PHASE,
    passed: failures.length === 0,
    requiredConcurrency: REQUIRED_CONCURRENCY,
    matchedFields: MATCHED_FIELDS,
    control: { arm: control.arm, memoEnabled: control.memoEnabled },
    enabled: { arm: enabled.arm, memoEnabled: enabled.memoEnabled },
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
  MATCHED_FIELDS,
  REQUIRED_CONCURRENCY,
  REQUIRED_PHASE,
  validateEnvironment
};
