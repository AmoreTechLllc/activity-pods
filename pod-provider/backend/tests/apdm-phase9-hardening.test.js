'use strict';

const fs = require('fs');
const { findPackageRoot, locateOutboxSource } = require('../scripts/patch-semapps-activitypub-local-delivery');
const {
  PROMOTED_PHASE9_CONCURRENCY_BLOCK,
  PHASE9_WORKER_BLOCK,
  patchPhase9OutboxSource
} = require('../scripts/patch-semapps-activitypub-local-delivery-phase9');

function installedSource() {
  return fs.readFileSync(locateOutboxSource(findPackageRoot()), 'utf8');
}

describe('APDM Phase 9 patch hardening', () => {
  test('installed artifact matches exact promoted configuration and worker blocks', () => {
    const source = installedSource();
    expect(source).toContain(PROMOTED_PHASE9_CONCURRENCY_BLOCK);
    expect(source).toContain(PHASE9_WORKER_BLOCK);
    expect(patchPhase9OutboxSource(source)).toEqual({ source, changed: false });
  });

  test('marker-preserving concurrency-policy drift fails closed', () => {
    const source = installedSource();
    expect(() => patchPhase9OutboxSource(source.replace('? 4', '? 8'))).toThrow(/drifted promoted concurrency/u);
    expect(() => patchPhase9OutboxSource(source.replace(': 1;', ': 2;'))).toThrow(/drifted promoted concurrency/u);
  });

  test('marker-preserving worker and ordering drift fails closed', () => {
    const source = installedSource();
    expect(() => patchPhase9OutboxSource(source.replace(
      'const workerCount = Math.min(localDeliveryConcurrency, recipients.length);',
      'const workerCount = recipients.length;'
    ))).toThrow(/worker shape/u);
    expect(() => patchPhase9OutboxSource(source.replace(
      'const success = successResults.filter(recipientUri => recipientUri !== undefined);',
      'const success = successResults.reverse().filter(recipientUri => recipientUri !== undefined);'
    ))).toThrow(/worker shape/u);
  });
});
