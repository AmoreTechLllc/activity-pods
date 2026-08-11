# APDM Phase 4 — ActivityPub durable handoff

This document describes the ActivityPods side of the Phase 4 durability boundary.

## Invariants

1. `native` remains the default and rollback mode.
2. `external` may not start unless a real Bull/Redis queue, authenticated HTTP(S) sidecar handoff URL, and the explicit migration guard are configured.
3. SemApps native `remotePost` jobs are suppressed before creation only in guarded external mode.
4. The live SemApps recipient partition is converted to `ap.delivery-plan.v1` once and handed to the durable queue path.
5. `deliveryPlan.intentId` is deterministic and independent of recipient ordering/duplicates.
6. The live path waits for durable Bull insertion before declaring the handoff queued.
7. Bull uniqueness is keyed by `deliveryPlan.intentId` through Bull's `opts.jobId`, not the job name.
8. The Bull worker accepts the sidecar handoff only when `/webhook/outbox` returns HTTP 202 with `accepted: true`, which is emitted after Redis Streams enqueue.
9. P4's `activitypub.outbox.remote-delivery.handoff-queued` event is observability-only; it is not a second HTTP delivery path.
10. Because Fuseki and Redis are separate stores, `activitypub-delivery-reconciler` scans recent persisted outbox Activities and recreates the deterministic Bull job after a crash between RDF persistence and queue insertion.
11. Reconciliation is read-only against Fuseki, skips local-only Activities, pages through the configured activity lookback, rotates through provider accounts with a Redis-persisted cursor, and uses a token-safe distributed Redis lease to prevent concurrent cursor advancement by multiple provider processes.

## Recovery model

```text
Fuseki Activity persistence
        |
        +--> live Delivery Plan --> Bull deliveryHandoff --> sidecar Redis Stream --> outbound worker
        |
        +--> periodic reconciler --^   (same deterministic intentId for the same reconstructed recipients)
```

The reconciler refetches the persisted Activity through SemApps, expands any unresolved local followers collection, classifies concrete local/remote recipients, rebuilds `ap.delivery-plan.v1`, and calls the same internal `activitypub.outbox.enqueueDeliveryHandoff` action used by the live path.

### Followers-addressed recovery semantics

A persisted Activity normally retains the followers collection URI rather than a historical concrete-recipient snapshot. If a process dies before the live Delivery Plan reaches Bull, reconciliation expands that followers collection from ActivityPods' authoritative collection state at recovery time. This closes the permanent handoff-loss window, but it is not a distributed transaction or a historical audience snapshot across Fuseki and Redis. A future hardening phase may persist an internal recipient snapshot if exact historical follower membership is required across that crash boundary.

Direct-addressed recipients are explicit in the Activity and therefore reconstruct deterministically. Reconciliation refuses unresolved remote followers collections rather than guessing their membership.

## Sidecar duplicate-delivery safety

A sidecar response-loss retry may create more than one sidecar intent record while the legacy webhook still generates its own record ID. Each accepted intent derives the same outbound `jobId = activityId::deliveryUrl`.

The sidecar no longer treats a pre-send Redis NX claim as proof of completed delivery. It uses two states:

```text
Redis Stream message
      |
      v
temporary in-flight claim
      |
      v
remote HTTP delivery
      |
      v
durable completed marker
      |
      v
Redis Stream ACK
```

A worker crash after claiming but before HTTP therefore leaves only an expiring in-flight claim. A reclaimed message is deferred while that claim is live and can be delivered after it expires. Only the completed marker is duplicate-delivery proof.

## Operational counters

`activitypub-delivery-reconciler.getStats` exposes cumulative:

- `runs`
- `accountsScanned`
- `activitiesScanned`
- `handoffsRequeued`
- `failures`
- `accountOffset`
- `distributedLockSkips`
- `lastRunStartedAt`
- `lastRunCompletedAt`
- `lastError`
- `running`

The sidecar also exposes duplicate-delivery suppression through the outbound worker metrics.

## Cutover

Phase 4 does **not** enable production remote authority. Phase 5 is responsible for the actual cutover after this durability path, sidecar acceptance, interoperability, and rollback tests are green.
