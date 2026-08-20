'use strict';

const EXPECTED_MAX_KEYS = 4096;
const EXPECTED_MAX_CONTEXTS = 65536;
const EXPECTED_CONCURRENCY = 4;

function exactBooleanString(value, label) {
  if (value !== 'true' && value !== 'false') throw new Error(`${label} must be exactly true or false; received ${value}`);
  return value === 'true';
}

function positiveIntegerString(value, label) {
  if (!/^[1-9][0-9]*$/u.test(String(value || ''))) throw new Error(`${label} must be a positive integer string; received ${value}`);
  return Number(value);
}

function validatePhase11Runtime(env, expectedAttributionEnabled, expectedRecipientCount) {
  const failures = [];
  const expectedEnabled = exactBooleanString(String(expectedAttributionEnabled), 'expected attribution flag');
  const expectedCount = positiveIntegerString(expectedRecipientCount, 'expected recipient count');

  if (env.SEMAPPS_APDM_PHASE8_INSTRUMENTATION_ENABLED !== 'true') {
    failures.push(`Phase 8 instrumentation must be true; received ${env.SEMAPPS_APDM_PHASE8_INSTRUMENTATION_ENABLED}`);
  }
  if (positiveIntegerString(env.SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT, 'runtime recipient count') !== expectedCount) {
    failures.push(`runtime recipient count must be ${expectedCount}; received ${env.SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT}`);
  }
  if (env.SEMAPPS_APDM_PHASE8_CASE_LABEL !== `real-local-${expectedCount}`) {
    failures.push(`case label must be real-local-${expectedCount}; received ${env.SEMAPPS_APDM_PHASE8_CASE_LABEL}`);
  }

  let runtimeEnabled;
  try {
    runtimeEnabled = exactBooleanString(
      env.SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_ENABLED,
      'runtime attribution flag'
    );
  } catch (error) {
    failures.push(error.message);
  }
  if (runtimeEnabled !== undefined && runtimeEnabled !== expectedEnabled) {
    failures.push(`runtime attribution flag must be ${expectedEnabled}; received ${runtimeEnabled}`);
  }

  if (positiveIntegerString(env.SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_KEYS, 'runtime max attribution keys') !== EXPECTED_MAX_KEYS) {
    failures.push(`runtime max attribution keys must be ${EXPECTED_MAX_KEYS}; received ${env.SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_KEYS}`);
  }
  if (positiveIntegerString(env.SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_CONTEXTS, 'runtime max lineage contexts') !== EXPECTED_MAX_CONTEXTS) {
    failures.push(`runtime max lineage contexts must be ${EXPECTED_MAX_CONTEXTS}; received ${env.SEMAPPS_APDM_PHASE11_QUERY_ATTRIBUTION_MAX_CONTEXTS}`);
  }
  if (env.APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED !== 'true') {
    failures.push(`Phase 10 memo must be true in Phase 11 measurement; received ${env.APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED}`);
  }
  if (positiveIntegerString(env.APDM_LOCAL_DELIVERY_CONCURRENCY, 'runtime local delivery concurrency') !== EXPECTED_CONCURRENCY) {
    failures.push(`runtime local delivery concurrency must be ${EXPECTED_CONCURRENCY}; received ${env.APDM_LOCAL_DELIVERY_CONCURRENCY}`);
  }
  if (env.APDM_P10_MEASUREMENT_ARM !== 'on') {
    failures.push(`Phase 10 measurement arm must be on; received ${env.APDM_P10_MEASUREMENT_ARM}`);
  }

  if (failures.length) throw new Error(failures.join('; '));
  return {
    checked: true,
    attributionEnabled: expectedEnabled,
    recipientCount: expectedCount,
    maxAttributionKeys: EXPECTED_MAX_KEYS,
    maxLineageContexts: EXPECTED_MAX_CONTEXTS,
    localDeliveryConcurrency: EXPECTED_CONCURRENCY,
    phase10MemoEnabled: true,
    phase10Arm: 'on'
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2) {
    throw new Error('Usage: node apdm-phase11-runtime-validate.js ATTRIBUTION_ENABLED RECIPIENT_COUNT');
  }
  const result = validatePhase11Runtime(process.env, argv[0], argv[1]);
  process.stdout.write(`${JSON.stringify({ ok: true, phase: 'APDM-P11-A', runtime: result })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[APDM-P11] ${error.stack || error.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = {
  EXPECTED_CONCURRENCY,
  EXPECTED_MAX_CONTEXTS,
  EXPECTED_MAX_KEYS,
  exactBooleanString,
  positiveIntegerString,
  validatePhase11Runtime
};
