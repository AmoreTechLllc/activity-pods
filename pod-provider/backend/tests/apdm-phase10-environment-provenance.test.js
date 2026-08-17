'use strict';

const {
  REQUIRED_CONCURRENCY,
  validateEnvironment
} = require('../scripts/apdm-phase10-validate-environment');

function manifest(overrides = {}) {
  return {
    phase: 'APDM-P10-A',
    arm: 'off',
    armOrder: 'off-first',
    memoEnabled: false,
    commitSha: 'abc123',
    workflowRunId: '42',
    runAttempt: '1',
    concurrency: REQUIRED_CONCURRENCY,
    runnerOs: 'Linux',
    runnerArch: 'X64',
    imageOs: 'ubuntu24',
    imageVersion: '20260810.271.1',
    hostNode: 'v22.23.2',
    hostCpuModel: 'AMD EPYC',
    hostCpuCount: 4,
    hostTotalMemoryBytes: 17179869184,
    backendImageId: 'sha256:backend',
    fusekiImageId: 'sha256:fuseki',
    redisImageId: 'sha256:redis',
    mailcatcherImageId: 'sha256:mailcatcher',
    ...overrides
  };
}

describe('APDM Phase 10 environment provenance', () => {
  test('accepts matched c4 environments with opposite proven memo arms', () => {
    const result = validateEnvironment(manifest(), manifest({ arm: 'on', memoEnabled: true }));
    expect(result.passed).toBe(true);
    expect(result.resourceComparable).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.resourceDifferences).toEqual([]);
  });

  test('accepts on-first provenance only on an even run attempt', () => {
    const result = validateEnvironment(
      manifest({ armOrder: 'on-first', runAttempt: '2' }),
      manifest({ arm: 'on', armOrder: 'on-first', memoEnabled: true, runAttempt: '2' })
    );
    expect(result.passed).toBe(true);
  });

  test('rejects arm order that does not match run-attempt parity', () => {
    const result = validateEnvironment(
      manifest({ armOrder: 'on-first' }),
      manifest({ arm: 'on', armOrder: 'on-first', memoEnabled: true })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('does not match run attempt');
  });

  test('rejects malformed run-attempt provenance instead of skipping parity validation', () => {
    const result = validateEnvironment(
      manifest({ runAttempt: 'not-an-attempt' }),
      manifest({ arm: 'on', memoEnabled: true, runAttempt: 'not-an-attempt' })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('runAttempt');
  });

  test('rejects zero run-attempt provenance', () => {
    const result = validateEnvironment(
      manifest({ runAttempt: '0' }),
      manifest({ arm: 'on', memoEnabled: true, runAttempt: '0' })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('positive integer string');
  });

  test('rejects mismatched arm-order provenance between arms', () => {
    const result = validateEnvironment(
      manifest(),
      manifest({ arm: 'on', armOrder: 'on-first', memoEnabled: true })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('armOrder');
  });

  test('rejects mislabeled control and enabled arms', () => {
    const result = validateEnvironment(
      manifest({ memoEnabled: true }),
      manifest({ arm: 'on', memoEnabled: true })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('Control manifest must prove arm=off');
  });

  test('rejects evidence that is not exact numeric concurrency four', () => {
    const numericMismatch = validateEnvironment(
      manifest({ concurrency: 2 }),
      manifest({ arm: 'on', memoEnabled: true, concurrency: 2 })
    );
    expect(numericMismatch.passed).toBe(false);
    expect(numericMismatch.failures.join('\n')).toContain('concurrency 4');

    const stringFour = validateEnvironment(
      manifest({ concurrency: '4' }),
      manifest({ arm: 'on', memoEnabled: true, concurrency: '4' })
    );
    expect(stringFour.passed).toBe(false);
    expect(stringFour.failures.join('\n')).toContain('concurrency 4');
  });

  test('rejects cross-commit or cross-image mechanism evidence', () => {
    const result = validateEnvironment(
      manifest(),
      manifest({ arm: 'on', memoEnabled: true, commitSha: 'different', fusekiImageId: 'sha256:other' })
    );
    expect(result.passed).toBe(false);
    expect(result.resourceComparable).toBe(false);
    expect(result.failures.join('\n')).toContain('commitSha');
    expect(result.failures.join('\n')).toContain('fusekiImageId');
  });

  test('rejects timing and CPU evidence across different host hardware', () => {
    const result = validateEnvironment(
      manifest(),
      manifest({
        arm: 'on',
        memoEnabled: true,
        hostCpuModel: 'Intel Xeon',
        hostCpuCount: 8,
        hostTotalMemoryBytes: 34359738368
      })
    );
    expect(result.passed).toBe(false);
    expect(result.resourceComparable).toBe(false);
    expect(result.resourceDifferences.join('\n')).toContain('hostCpuModel');
    expect(result.resourceDifferences.join('\n')).toContain('hostCpuCount');
    expect(result.resourceDifferences.join('\n')).toContain('hostTotalMemoryBytes');
  });

  test('rejects incomplete provenance instead of treating missing values as equal', () => {
    const result = validateEnvironment(
      manifest({ backendImageId: '' }),
      manifest({ arm: 'on', memoEnabled: true, backendImageId: '' })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('backendImageId');
  });

  test('rejects equal but impossible host resource values and reports each invalid field', () => {
    const result = validateEnvironment(
      manifest({ hostCpuCount: 0, hostTotalMemoryBytes: -1 }),
      manifest({ arm: 'on', memoEnabled: true, hostCpuCount: 0, hostTotalMemoryBytes: -1 })
    );
    expect(result.passed).toBe(false);
    expect(result.resourceComparable).toBe(false);
    expect(result.failures.join('\n')).toContain('hostCpuCount');
    expect(result.failures.join('\n')).toContain('hostTotalMemoryBytes');
  });
});
