'use strict';

const {
  REQUIRED_CONCURRENCY,
  validateEnvironment
} = require('../scripts/apdm-phase10-validate-environment');

function manifest(overrides = {}) {
  return {
    phase: 'APDM-P10-A',
    arm: 'off',
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
    expect(result.failures).toEqual([]);
  });

  test('rejects mislabeled control and enabled arms', () => {
    const result = validateEnvironment(
      manifest({ memoEnabled: true }),
      manifest({ arm: 'on', memoEnabled: true })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('Control manifest must prove arm=off');
  });

  test('rejects evidence that is not concurrency four', () => {
    const result = validateEnvironment(
      manifest({ concurrency: 2 }),
      manifest({ arm: 'on', memoEnabled: true, concurrency: 2 })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('concurrency 4');
  });

  test('rejects cross-commit runtime or host-hardware evidence', () => {
    const result = validateEnvironment(
      manifest(),
      manifest({
        arm: 'on',
        memoEnabled: true,
        commitSha: 'different',
        fusekiImageId: 'sha256:other',
        hostCpuModel: 'Intel Xeon'
      })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('commitSha');
    expect(result.failures.join('\n')).toContain('fusekiImageId');
    expect(result.failures.join('\n')).toContain('hostCpuModel');
  });

  test('rejects incomplete provenance instead of treating missing values as equal', () => {
    const result = validateEnvironment(
      manifest({ backendImageId: '' }),
      manifest({ arm: 'on', memoEnabled: true, backendImageId: '' })
    );
    expect(result.passed).toBe(false);
    expect(result.failures.join('\n')).toContain('backendImageId');
  });
});
