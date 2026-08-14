'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../services/outbox-emitter.service.js'), 'utf8');

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('APDM Phase 5/6 committed outbox authority contract', () => {
  test('external mode retains raw pre-handoff suppression', () => {
    const rawHandler = between("'activitypub.outbox.posted':", "'activitypub.outbox.remote-delivery.handoff-queued':");
    expect(rawHandler).toContain("remoteDeliveryMode === 'external'");
    expect(rawHandler).toContain('return;');
  });

  test('committed indexing event is sourced only from post-durable handoff in external mode', () => {
    expect(source).toContain("'activitypub.outbox.remote-delivery.handoff-queued':");
    expect(source).not.toContain("'activitypub.outbox.remote-delivery.planned':");
  });

  test('post-durable handler emits readiness without a second sidecar delivery', () => {
    const durableHandler = between("'activitypub.outbox.remote-delivery.handoff-queued':", '\n  },\n  methods:');
    expect(durableHandler).toContain("ctx.emit('outbox.event.ready', event)");
    expect(durableHandler).not.toContain('deliverObservationToSidecar');
    expect(durableHandler).not.toContain('remoteTargets');
  });

  test('Phase 6 removes the legacy raw recipient-routing surface', () => {
    expect(source).not.toContain('resolveDeliveryTargets');
    expect(source).not.toContain('extractRecipients');
    expect(source).not.toContain('deduplicateBySharedInbox');
    expect(source).not.toContain('followable.resolveFollowActivityDelivery');
    expect(source).not.toContain('deliverToSidecar');
    expect(source).not.toContain('SIDECAR_WEBHOOK_URL');
  });

  test('native rollback uses only the dedicated targetless observation transport', () => {
    const rawHandler = between("'activitypub.outbox.posted':", "'activitypub.outbox.remote-delivery.handoff-queued':");
    const observationMethod = between('async deliverObservationToSidecar(event)', '\n    extractObjectId(activity)');
    expect(rawHandler).toContain('deliveryTargets: []');
    expect(rawHandler).toContain("ctx.emit('outbox.event.ready', event)");
    expect(rawHandler).toContain('deliverObservationToSidecar(event)');
    expect(source).toContain('SIDECAR_OBSERVATION_WEBHOOK_URL');
    expect(source).toContain('/webhook/outbox-observation');
    expect(observationMethod).toContain('sidecarObservationWebhookUrl');
    expect(observationMethod).not.toContain('remoteTargets');
    expect(observationMethod).not.toContain('deliveryTargets');
  });
});
