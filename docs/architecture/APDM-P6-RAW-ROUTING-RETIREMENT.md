# APDM Phase 6 — ActivityPods raw-routing retirement

## Scope

This document covers `APDM-P6-A`, the ActivityPods slice of Phase 6 in the cross-repository ActivityPub Delivery Migration program.

Phase 5 established the production authority split:

- ActivityPods/SemApps remains authoritative for Activity persistence, recipient expansion, local/remote classification, local Pod delivery, signing authority, and production of `ap.delivery-plan.v1`;
- the durable Delivery Plan handoff is the only external-mode input to the federation sidecar;
- the sidecar/Fedify executor is the sole external ActivityPub HTTP executor in external mode;
- `native` remains the tested SemApps rollback executor.

Phase 6 removes the transitional second recipient-routing implementation that existed in `outbox-emitter.service.js` before that authority split was proven.

## Removed authority

The legacy emitter previously re-parsed a committed raw Activity after `activitypub.outbox.posted` and independently attempted to reconstruct remote delivery targets by:

1. scanning raw `to`, `cc`, `bto`, and `bcc` values;
2. special-casing Follow delivery;
3. calling `activitypub.actor.isLocal` again;
4. resolving remote actors again with `activitypub.actor.get`;
5. deriving inbox/sharedInbox values again;
6. deduplicating again by shared inbox;
7. POSTing the reconstructed target list through the legacy sidecar webhook.

That path can no longer be a routing authority after Phase 5 because it is downstream of the authoritative SemApps expansion and cannot reproduce follower expansion, blind-recipient recovery, authoritative local/remote partitioning, or the durable Delivery Plan identity safely.

`APDM-P6-A` therefore removes:

- `outbox-emitter.resolveDeliveryTargets`;
- raw recipient extraction helpers;
- Follow-specific target reconstruction in the emitter;
- shared-inbox dedupe in the emitter;
- the legacy emitter-to-sidecar federation submission helper and its retry configuration;
- the manual legacy emitter action that could construct an independent federation submission.

## Remaining behavior

### External mode

`activitypub.outbox.posted` remains ignored for routing. The emitter observes only `activitypub.outbox.remote-delivery.handoff-queued`, which exists after the authoritative Delivery Plan has already been durably queued.

The post-handoff handler may expose Delivery Plan target metadata in `outbox.event.ready`, but it does not submit remote federation work.

### Native rollback mode

SemApps native `remotePost` remains the remote executor. The raw `activitypub.outbox.posted` event is observation-only and produces `outbox.event.ready` with an empty `deliveryTargets` list.

This preserves deterministic rollback without reintroducing a second recipient parser or a second sidecar federation route.

## Invariants

`APDM-P6-A` must preserve all of the following:

1. external mode creates no legacy emitter-side federation submission;
2. external target metadata comes only from validated `ap.delivery-plan.v1`;
3. native mode does not reconstruct remote targets in the emitter;
4. native SemApps rollback remains untouched;
5. local Pod delivery remains untouched;
6. no `SIDECAR_WEBHOOK_URL` dependency remains in `outbox-emitter.service.js`;
7. no raw-Activity recipient parser remains in that service;
8. Phase 5 durable handoff, reconciliation, search-consent metadata, and Delivery Plan identity remain unchanged.

## Cross-repository gate

Phase 6 is not complete cross-repository until `APDM-P6-F` also retires acceptance of the obsolete raw-routing submission as a federation authority while preserving the durable `X-APDM-Intent-Id` Delivery Plan handoff.

Phase 7 local fan-out work must not begin until both Phase 6 slices are merged and the cross-repository gate is marked PASS.
