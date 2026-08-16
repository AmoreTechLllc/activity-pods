'use strict';

const fs = require('fs');
const path = require('path');

const workflowPath = path.resolve(
  __dirname,
  '../../../.github/workflows/apdm-phase10-dataset-existence-measurement.yml'
);
const composePath = path.resolve(__dirname, '../../docker-compose-phase8.yml');

describe('APDM Phase 10 real measurement workflow contract', () => {
  test('runs only the isolated OFF and ON arms at the selected c4 concurrency', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');

    expect(source).toContain('- arm: off');
    expect(source).toContain("memo_enabled: 'false'");
    expect(source).toContain('- arm: on');
    expect(source).toContain("memo_enabled: 'true'");
    expect(source).toContain("APDM_P9_CONCURRENCY: '4'");
    expect(source).toContain("APDM_P10_DATASET_EXIST_MEMO_ENABLED: '${{ matrix.memo_enabled }}'");
    expect(source).toContain("APDM_P10_DATASET_EXIST_MEMO_ENABLED: 'false'");
    expect(source).toContain('agent/apdm-phase10-measurement');
    expect(source).not.toContain('agent/apdm-phase10-dataset-existence-memo\n');
  });

  test('measures the complete canonical matrix with the reviewed sample defaults', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    expect(source).toContain('for count in 1 10 100 200 1000; do');
    expect(source).toContain("APDM_P8_SAMPLES: \"${{ github.event.inputs.samples || '3' }}\"");
    expect(source).toContain("APDM_P8_WARMUPS: \"${{ github.event.inputs.warmups || '1' }}\"");
    expect(source).toContain('node scripts/apdm-phase8-warm-restart-ready.js');
    expect(source).toContain('node scripts/apdm-phase8-real-measure.js measure');
  });

  test('records matched host and image provenance before comparison', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    expect(source).toContain('hostCpuModel:');
    expect(source).toContain('hostCpuCount:');
    expect(source).toContain('hostTotalMemoryBytes:');
    expect(source).toContain('backendImageId:');
    expect(source).toContain('fusekiImageId:');
  });

  test('requires provenance validation before the mechanism comparator', () => {
    const source = fs.readFileSync(workflowPath, 'utf8');
    const validate = source.indexOf('apdm-phase10-validate-environment.js');
    const compare = source.indexOf('apdm-phase10-compare.js');
    expect(validate).toBeGreaterThan(-1);
    expect(compare).toBeGreaterThan(validate);
    expect(source).toContain('apdm-p10-environment-validation.json');
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
