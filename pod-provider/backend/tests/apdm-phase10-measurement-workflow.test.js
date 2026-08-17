'use strict';

const fs = require('fs');
const path = require('path');

const workflowPath = path.resolve(
  __dirname,
  '../../../.github/workflows/apdm-phase10-dataset-existence-measurement.yml'
);
const composePath = path.resolve(__dirname, '../../docker-compose-phase8.yml');
const baseComposePath = path.resolve(__dirname, '../../docker-compose-test.yml');

describe('APDM Phase 10 real measurement workflow contract', () => {
  test('runs paired OFF and ON arms on one runner at the selected c4 concurrency', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');

    expect(source).toContain('measure-paired:');
    expect(source).toContain('run_arm off false');
    expect(source).toContain('run_arm on true');
    expect(source).toContain("APDM_P9_CONCURRENCY: '4'");
    expect(source).toContain('Build benchmark backend image once');
    expect(source).toContain('backend image itself is built');
    expect(source).toContain('agent/apdm-phase10-measurement');
    expect(source).not.toContain('matrix.arm');
    expect(source).not.toContain('matrix.memo_enabled');
    expect(source).not.toContain('agent/apdm-phase10-dataset-existence-memo\n');
  });

  test('isolates each arm with fresh bind-mounted state and fresh recipient provisioning', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    const baseCompose = fs.readFileSync(baseComposePath, 'utf8');

    expect(baseCompose).toContain('./data/fuseki_test:/fuseki:z');
    expect(baseCompose).toContain('./data/redis_test:/data:z');

    const reset = source.indexOf('reset_arm_storage()');
    const runArm = source.indexOf('run_arm()');
    const off = source.indexOf('run_arm off false');
    expect(reset).toBeGreaterThan(-1);
    expect(runArm).toBeGreaterThan(reset);
    expect(off).toBeGreaterThan(runArm);

    const resetBlock = source.slice(reset, runArm);
    expect(resetBlock).toContain('down -v || true');
    expect(resetBlock).toContain('sudo rm -rf data/fuseki_test data/redis_test');
    expect(resetBlock).toContain('mkdir -p data/fuseki_test data/redis_test');

    const armBlock = source.slice(runArm, off);
    expect(armBlock).toContain('reset_arm_storage');
    expect(armBlock).toContain('up -d fuseki_test redis mailcatcher');
    expect(armBlock).toContain('apdm-phase8-real-measure.js provision');
    expect(armBlock).toContain('1000');
    expect(armBlock).toContain('APDM_P10_DATASET_EXIST_MEMO_ENABLED=false');
  });

  test('measures the complete canonical matrix with the reviewed sample defaults', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    expect(source).toContain('for count in 1 10 100 200 1000; do');
    expect(source).toContain("APDM_P8_SAMPLES: \"${{ github.event.inputs.samples || '3' }}\"");
    expect(source).toContain("APDM_P8_WARMUPS: \"${{ github.event.inputs.warmups || '1' }}\"");
    expect(source).toContain('node scripts/apdm-phase8-warm-restart-ready.js');
    expect(source).toContain('node scripts/apdm-phase8-real-measure.js measure');
  });

  test('records matched host and exact image provenance for both arms', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    expect(source).toContain('hostCpuModel:');
    expect(source).toContain('hostCpuCount:');
    expect(source).toContain('hostTotalMemoryBytes:');
    expect(source).toContain('backendImageId:');
    expect(source).toContain('fusekiImageId:');
    expect(source).toContain("docker image inspect apdm-phase8-backend:local");
    expect(source).toContain('record_provenance "${arm}" "${memo}"');
  });

  test('requires provenance validation before the mechanism comparator', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    const validateStep = source.indexOf('- name: Validate evidence provenance');
    const compareStep = source.indexOf('- name: Produce Phase 10 comparison');

    expect(validateStep).toBeGreaterThan(-1);
    expect(compareStep).toBeGreaterThan(validateStep);

    const validationBlock = source.slice(validateStep, compareStep);
    expect(validationBlock).toContain('apdm-phase10-validate-environment.js');
    expect(validationBlock).toContain('apdm-p10-environment-validation.json');

    const comparisonBlock = source.slice(compareStep);
    expect(comparisonBlock).toContain('apdm-phase10-compare.js');
    expect(source).toContain('if-no-files-found: error');
  });

  test('shared compose overlay keeps Phase 10 off and exposes the arm only when explicitly supplied', () => {
    const compose = fs.readFileSync(composePath, 'utf8');
    expect(compose).toContain(
      "APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED: '${APDM_P10_DATASET_EXIST_MEMO_ENABLED:-false}'"
    );
    expect(compose).toContain("APDM_P10_MEASUREMENT_ARM: '${APDM_P10_ARM:-}'");
    expect(compose).toContain("APDM_LOCAL_DELIVERY_CONCURRENCY: '${APDM_P9_CONCURRENCY:-1}'");
  });
});
