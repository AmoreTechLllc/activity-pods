'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY,
  LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY,
  createPhase8Tier1Instrumentation
} = require('../lib/apdm-phase8-tier1-instrumentation');
const {
  PHASE8_RESULT_MARKER,
  findPackageRoot,
  locateOutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery');

function readRecord(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').trim());
}

describe('APDM Phase 8 partial local delivery accounting', () => {
  test('installed pinned SemApps outbox exposes the result observation seam', () => {
    const packageRoot = findPackageRoot();
    const outboxFile = locateOutboxSource(packageRoot);
    const source = fs.readFileSync(outboxFile, 'utf8');

    expect(source).toContain(PHASE8_RESULT_MARKER);
    expect(source).toContain(LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY);
    expect(source).toContain('phase8LocalDeliveryResultObserver(activityToPost, phase8LocalDeliveryResult)');
    expect(source).toContain("phase8LocalDeliveryObserver('finish', activityToPost, phase8LocalDeliveryError)");
  });

  test('a caught per-recipient localPost failure makes the trace unusable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apdm-p8-partial-'));
    const outputPath = path.join(directory, 'measurement.jsonl');
    const instrumentation = createPhase8Tier1Instrumentation({
      enabled: true,
      outputPath,
      recipientCount: 10,
      caseLabel: 'partial-local-delivery'
    });

    try {
      const completionObserver = globalThis[Symbol.for(LOCAL_DELIVERY_OBSERVER_SYMBOL_KEY)];
      const resultObserver = globalThis[Symbol.for(LOCAL_DELIVERY_RESULT_OBSERVER_SYMBOL_KEY)];
      const root = instrumentation.middleware.localAction(async () => {
        const activity = { id: 'https://pod.example/activities/partial' };
        completionObserver('start', activity);
        resultObserver(activity, {
          success: ['https://pod.example/ok'],
          failures: ['https://pod.example/failed']
        });
        completionObserver('finish', activity);
        return 'root-returned';
      }, { name: 'activitypub.outbox.post' });

      await expect(root({ id: 'root-partial', requestID: 'request-partial' })).resolves.toBe('root-returned');
      const record = readRecord(outputPath);
      expect(record.errors).toContainEqual({
        source: 'detached-local-delivery-partial',
        failureCount: 1,
        failures: ['https://pod.example/failed']
      });
    } finally {
      instrumentation.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
