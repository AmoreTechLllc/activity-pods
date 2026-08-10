# ActivityPub Delivery Migration — ActivityPods Companion

Program ID: `APDM`

This document is the ActivityPods-specific companion to the authoritative cross-repository ActivityPub Delivery Migration roadmap in `outlaw-dame/mastopod-federation-architecture/docs/activitypub-delivery-migration/`.

ActivityPods does not maintain an independent phase numbering scheme. ActivityPods slices use `APDM-P<n>-A` and must satisfy the corresponding cross-repo exit gate before dependent work proceeds.

## Why this repo is involved

The current ActivityPods backend pins `@semapps/activitypub` 1.1.4 and configures ActivityPub with `podProvider: true`. Ordinary ActivityPub recipient expansion, local fan-out and SemApps native remote dispatch therefore execute inside Tier 1 before the custom Fedify-facing `outbox-emitter` observes `activitypub.outbox.posted`.

The migration must change this repo at the delivery-planning boundary. A sidecar-only change cannot safely suppress native SemApps delivery because native jobs are created first.

## Exact SemApps 1.1.4 baseline

The verified SemApps `middleware-v1.1.4` implementation has the following behavior.

### Recipient expansion

`activitypub.activity.getRecipients`:

1. resolves the sending actor;
2. scans `to`, `bto`, `cc`, and `bcc`;
3. skips ActivityStreams Public addresses;
4. when the address equals the sender's local followers collection, loads that collection and appends its individual items;
5. de-duplicates the expanded recipient list.

This means ordinary follower-addressed posts are expanded inside SemApps before local/remote classification.

### Outbox partition and native remote dispatch

`activitypub.outbox.post`:

1. persists/processes the activity;
2. calls `activitypub.activity.getRecipients`;
3. iterates the expanded recipients;
4. for each local recipient, calls `auth.account.findByWebId` and stores the URI in `localRecipients`;
5. stores non-local recipients in `remoteRecipients`;
6. creates a Bull `remotePost` job for every remote recipient;
7. only after those jobs are created emits `activitypub.outbox.posted` with `{ activity }`;
8. calls `localPost(localRecipients, activity)` without awaiting it.

The emitted event does not contain the already-expanded recipient list.

### Native `remotePost`

Each native job:

1. resolves the recipient inbox with `activitypub.actor.getCollectionUri`;
2. serializes the Activity;
3. obtains HTTP signature headers from `signature.generateSignatureHeaders`;
4. performs the external HTTP POST;
5. uses the SemApps queue retry/backoff configuration.

Therefore SemApps is a complete remote federation executor, not merely a planning layer.

### Local fan-out

`localPost` first runs inbox side effects once for the recipient set, then strictly iterates local recipients. In pod-provider mode, each recipient causes these visible calls:

- partition loop: `auth.account.findByWebId`;
- localPost: `auth.account.findByWebId` again;
- `activitypub.actor.getCollectionUri`;
- `activitypub.collection.add`;
- `ldp.remote.store`;
- `activitypub.activity.attach`.

That is six visible recipient-specific top-level service calls before nested LDP/WebACL/triplestore work.

For 200 local recipients, the source-counted visible model is approximately `2 + 6*200 = 1,202` calls including the fixed actor/followers resolution terms used in the earlier baseline model. For 1,000 it is approximately `6,002`.

These are source-counted orchestration calls, not a claim that total nested operations equal those numbers. The historical ~8,000-operation estimate for ~200 recipients remains a measurement question scheduled for APDM-P8.

## Fork-specific state before cutover

The custom `pod-provider/backend/services/outbox-emitter.service.js` runs downstream of `activitypub.outbox.posted`. It:

- resolves direct remote delivery targets;
- filters local actors;
- supplies known inbox/sharedInbox information to the sidecar;
- de-duplicates known targets by shared inbox;
- does not expand the actor's followers collection itself.

Consequences:

- direct remote actors can currently traverse both native SemApps delivery and the sidecar path;
- ordinary `/followers` addressing still depends on SemApps expansion and cannot safely lose native delivery until the expanded target list is handed to the sidecar;
- cancelling native Bull jobs after `outbox.posted` is not an accepted migration strategy because the jobs already exist and may race with cancellation.

## ActivityPods authority during APDM

This repo owns:

- Activity persistence and ActivityPub side effects;
- WebID/local actor ownership;
- recipient expansion;
- local/remote classification;
- local Pod account/dataset/inbox metadata;
- WebACL/LDP/Fuseki semantics;
- local delivery implementation and optimization;
- signing/key custody authority;
- production of the versioned remote Delivery Plan/intent.

This repo does not own after durable remote handoff:

- internet-facing HTTP federation execution;
- remote domain concurrency/rate limits;
- shared-inbox discovery/dedupe as an execution optimization;
- external retry/DLQ execution state.

Those belong to `outlaw-dame/mastopod-federation-architecture` / Fedify sidecar.

## ActivityPods phase slices

- `APDM-P0-A` — baseline and ownership documentation only. **Complete.**
- `APDM-P1-A` — Delivery Plan v1 producer contract and fixtures. **Complete.**
- `APDM-P2-A` — pre-`remotePost` native/external strategy seam. **In progress.**
- `APDM-P3-A` — authoritative expanded local/remote target planning.
- `APDM-P4-A` — durable/idempotent handoff producer.
- `APDM-P5-A` — guarded external-authority cutover and rollback proof.
- `APDM-P6-A` — remove transitional duplicate target inference.
- `APDM-P7-A` — remove duplicate local account lookup.
- `APDM-P8-A` — nested Tier 1 instrumentation and measured cost model.
- `APDM-P9-A` — bounded local concurrency.
- `APDM-P10-A` — batch/coarse-grained local metadata resolution.
- `APDM-P11-A` — batch-safe persistence optimization with semantic parity.
- `APDM-P12-A` — durable local recipient state/idempotency and partial-failure recovery.
- `APDM-P13-A` — route canonical bridge local notifications through the common local-delivery primitive.
- `APDM-P15-A` — end-to-end load/fault/interoperability proof.
- `APDM-P16-A` — migration cleanup, compatibility docs and rollback stabilization.

## Phase 2 implementation — pre-`remotePost` strategy seam

Phase 2 introduces an ActivityPods-owned adapter at `pod-provider/backend/lib/activitypub-service-with-delivery-strategy.js`.

### Why an adapter is required

SemApps 1.1.4 does not expose a configuration flag or public delivery-strategy extension point before `remotePost` job creation. Its top-level ActivityPub service dynamically registers the outbox subservice and mixes the queue implementation directly into it.

ActivityPods therefore recreates only that top-level service-registration layer using the exact SemApps 1.1.4 subservices, while leaving the upstream `OutboxService.actions.post` algorithm itself intact. The ActivityPods adapter replaces only the root `post` action with a strategy wrapper.

This is intentionally narrower than copying or forking the entire SemApps outbox algorithm.

### Exact-version guard

The adapter is pinned to `@semapps/activitypub` 1.1.4. Backend startup/tests fail if a different version is installed.

This protects against a silent SemApps upgrade changing:

- service-registration internals;
- the outbox action;
- queue names or payloads;
- recipient ordering/classification;
- local delivery semantics.

A SemApps upgrade therefore requires explicit review of this adapter rather than silently inheriting an incompatible deep import.

### Delivery modes

`SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE` accepts:

- `native` — default. Exact SemApps remote job creation continues unchanged.
- `external` — Phase 2 preview only.

`external` is rejected unless `SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true` is also set. That second flag is deliberately awkward: it prevents an operator from interpreting Phase 2 as the production cutover.

### How external preview suppresses native jobs

The wrapper invokes the exact SemApps outbox `post` handler with an isolated execution context created per request.

Only that request-local context overrides `createJob`:

- `remotePost` jobs are captured instead of enqueued;
- any non-`remotePost` job is delegated to the real queue implementation;
- the shared Moleculer service instance is never mutated.

This matters for concurrency: simultaneous posts cannot accidentally borrow one another's temporary queue interception.

After the SemApps handler returns, the adapter emits `activitypub.outbox.remote-delivery.planned` containing:

- the resulting Activity;
- the de-duplicated remote actor URIs captured from the would-have-been native jobs;
- `suppressedNativeRemotePostCount`;
- `deliveryMode: external`.

This event is a **Phase 2 proof surface only**. It is not the final durable cross-repo handoff and it must not be treated as acknowledgement that remote federation has been durably accepted.

### What Phase 2 deliberately does not change

Phase 2 does not:

- make Fedify authoritative in production;
- disable native delivery by default;
- make `activitypub.outbox.posted` authoritative for routing;
- solve the raw `/followers` gap in the current `outbox-emitter`;
- create the durable `OutboxIntent` handoff;
- optimize local delivery;
- remove the existing sidecar emitter.

Those changes belong to later gated phases.

### Phase 2 rollback

Rollback is configuration-level while the adapter remains installed:

```text
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=native
```

Native is also the default when the variable is absent.

If the adapter itself must be removed, `services/core/activitypub.js` can return to the stock `ActivityPubService` mixin because Phase 2 has not changed persisted Activity data or queue schemas.

### Phase 2 exit criteria

`APDM-P2-A` is complete only when all of the following are verified:

1. native mode delegates to SemApps and creates native `remotePost` work as before;
2. external preview mode creates **zero** native `remotePost` jobs;
3. unrelated queue work still delegates normally;
4. local delivery remains the exact SemApps local path;
5. simultaneous external-preview requests do not mutate/share queue interception state;
6. external mode fails closed without the explicit preview guard;
7. SemApps package drift from 1.1.4 fails fast;
8. backend CI and relevant tests pass;
9. no substantive review comments remain.

Phase 3 must not begin before this gate is closed.

## Non-negotiable local-delivery rule

The Fedify sidecar is not a replacement for local Pod delivery. Optimizing local fan-out must preserve local trust, dataset, WebACL/LDP and ActivityPods ownership semantics inside Tier 1.

The preferred sequence is:

1. remove obvious duplicate resolution;
2. instrument nested work;
3. introduce bounded concurrency;
4. batch metadata reads where safe;
5. batch persistence only after proving semantic equivalence;
6. add durable per-recipient recovery/idempotency;
7. converge internal bridge workflows on the same local delivery primitive.
