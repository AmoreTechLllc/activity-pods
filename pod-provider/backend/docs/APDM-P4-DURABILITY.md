# APDM Phase 4 — ActivityPub durable handoff

This document describes the ActivityPods side of the Phase 4 durability boundary.

## Invariants

1. `native` remains the default and rollback mode.
2. `external` may not start unless a real Bull/Redis queue, authenticated HTTP(S) sidecar handoff URL, and the explicit migration guard are configured.
3. SemApps native `remotePost` jobs are suppressed before creation only in guarded external mode.
4. The already-expanded SemApps recipient partition is converted to `ap.delivery-plan.v1` exactly once.
5. `deliveryPlan.intentId` is deterministic and independent of recipient ordering/duplicates.
6. The live path waits for durable Bull insertion before declaring the handoff queued.
7. The Bull worker accepts the sidecar handoff only when `/webhook/outbox` returns HTTP 202 with `accepted: true`, which is emitted after Redis Streams enqueue.
8. P4's `activitypub.outbox.remote-delivery.handoff-queued` event is observability-only; it is not a second HTTP delivery path.
9. Because Fuseki and Redis are separate stores, `activitypub-delivery-reconciler` scans recent persisted outbox Activities and recreates the same deterministic Bull job after a crash between RDF persistence and queue insertion.
10. Reconciliation is bounded, read-only against Fuseki, skips local-only Activities, and prevents overlapping runs.

## Recovery model

```text
Fuseki Activity persistence
        |
        +--> live Delivery Plan --> Bull deliveryHandoff --> sidecar Redis Stream --> outbound worker
        |
        +--> periodic reconciler --^   (same deterministic intentId)
```

A sidecar response-loss retry may create more than one sidecar intent record while the legacy webhook still generates its own record ID. This does not create duplicate remote HTTP delivery because each accepted intent derives the same outbound `jobId = activityId::deliveryUrl`, and `OutboundWorker` checks that deterministic ID for idempotency before sending.

## Operational counters

`activitypub-delivery-reconciler.getStats` exposes cumulative:

- `runs`
- `accountsScanned`
- `activitiesScanned`
- `handoffsRequeued`
- `failures`
- `lastRunStartedAt`
- `lastRunCompletedAt`
- `lastError`
- `running`

The sidecar also exposes its existing duplicate-delivery suppression metric through the outbound worker metrics.

## Cutover

Phase 4 does **not** enable production remote authority. Phase 5 is responsible for the actual cutover after this durability path, sidecar acceptance, interoperability, and rollback tests are green.
