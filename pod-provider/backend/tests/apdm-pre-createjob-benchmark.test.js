'use strict';

const {
  currentCreateJobCaptureTail,
  preCreateJobPlanningTail,
  estimateSemanticConstructionBytes,
  runBenchmark,
} = require('../scripts/apdm-pre-createjob-benchmark');

describe('APDM pre-createJob benchmark contract', () => {
  const activity = Object.freeze({
    id: 'https://local.example/activities/1',
    actor: 'https://local.example/users/alice',
    type: 'Create',
  });

  test('prototype preserves current concrete recipient dedupe semantics', () => {
    const recipients = [
      'https://one.example/users/a',
      'https://two.example/users/b',
      'https://one.example/users/a',
    ];

    expect(preCreateJobPlanningTail(recipients, activity)).toEqual(
      currentCreateJobCaptureTail(recipients, activity),
    );
  });

  test.each([
    ['current', currentCreateJobCaptureTail],
    ['pre-createJob', preCreateJobPlanningTail],
  ])('%s path fails closed on unsafe or malformed recipient URIs', (_label, fn) => {
    expect(() => fn(['not-a-url'], activity)).toThrow(/unsafe recipient URI/u);
    expect(() => fn(['https://user:password@remote.example/inbox'], activity)).toThrow(/unsafe recipient URI/u);
  });

  test('pre-createJob path requires the same concrete Activity identity boundary', () => {
    expect(() => preCreateJobPlanningTail(['https://remote.example/users/a'], {})).toThrow(
      /concrete Activity id and actor/u,
    );
  });

  test('benchmark reports only the post-classification tail and includes high-collapse cases', () => {
    const result = runBenchmark({ fanouts: [10], iterations: 2, warmups: 1 });
    expect(result.scope).toMatch(/post-SemApps-recipient-classification/u);
    expect(result.invariant).toMatch(/no recipient addressing\/classification\/local-delivery work is removed/u);
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].modeledSharedInboxScenarios).toEqual(
      expect.arrayContaining([expect.objectContaining({ uniqueDeliveryEndpoints: 10, collapseRatio: 1 })]),
    );
  });

  test('captured remotePost representation constructs more semantic bytes than direct vector', () => {
    const recipients = Array.from({ length: 100 }, (_, i) => `https://remote.example/users/${i}`);
    const bytes = estimateSemanticConstructionBytes(recipients, activity);
    expect(bytes.currentCapturedJobJsonBytes).toBeGreaterThan(bytes.directRecipientVectorJsonBytes);
  });
});
