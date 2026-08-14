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

describe('APDM Phase 5 committed outbox authority contract', () => {
  test('external mode retains raw pre-handoff suppression', () => {
    const rawHandler = between("'activitypub.outbox.posted':", "'activitypub.outbox.remote-delivery.handoff-queued':");
    expect(rawHandler).toContain("remoteDeliveryMode === 'external'");
    expect(rawHandler).toContain('return;');
  });

  test('committed indexing event is sourced only from post-durable handoff', () => {
    expect(source).toContain("'activitypub.outbox.remote-delivery.handoff-queued':");
    expect(source).not.toContain("'activitypub.outbox.remote-delivery.planned':");
  });

  test('post-durable handler emits local readiness without a second sidecar delivery', () => {
    const durableHandler = between("'activitypub.outbox.remote-delivery.handoff-queued':", '\n  },\n\n  actions:');
    expect(durableHandler).toContain("ctx.emit('outbox.event.ready', event)");
    expect(durableHandler).not.toContain('deliverToSidecar');
  });

  test('legacy manual emitter cannot create a second sidecar submission in external mode', () => {
    const emitAction = between('emitEvent: {', '\n\n    /**\n     * Resolve delivery targets');
    const guardIndex = emitAction.indexOf("remoteDeliveryMode === 'external'");
    const deliveryIndex = emitAction.indexOf('deliverToSidecar');

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(emitAction).toContain('authoritative Delivery Plan handoff');
    expect(deliveryIndex).toBeGreaterThan(guardIndex);
  });
});
