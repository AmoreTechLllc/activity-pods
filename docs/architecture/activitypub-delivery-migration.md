# ActivityPub Delivery Migration — ActivityPods Companion

Program ID: `APDM`

This document is the ActivityPods-specific companion to the authoritative cross-repository ActivityPub Delivery Migration roadmap in `outlaw-dame/mastopod-federation-architecture/docs/activitypub-delivery-migration/`.

ActivityPods does not maintain an independent phase numbering scheme. ActivityPods slices use `APDM-P<n>-A` and must satisfy the corresponding cross-repo exit gate before dependent work proceeds.

## Why this repo is involved

The current ActivityPods backend pins `@semapps/activitypub` 1.1.4 and configures `ActivityPubService` with `podProvider: true`. Ordinary ActivityPub recipient expansion, local fan-out and SemApps native remote dispatch therefore execute inside Tier 1 before the custom Fedify-facing `outbox-emitter` observes `activitypub.outbox.posted`.

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

## Fork-specific state

The ActivityPods wrapper in `pod-provider/backend/services/core/activitypub.js` mixes `ActivityPubService` and supplies `baseUri`, `podProvider: true`, and `queueServiceUrl`. It does not redefine the SemApps outbox/localPost/remotePost algorithms.

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

- `APDM-P0-A` — baseline and ownership documentation only.
- `APDM-P1-A` — Delivery Plan v1 producer contract and fixtures.
- `APDM-P2-A` — pre-`remotePost` native/external strategy seam.
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

## Phase 0 exit criteria for this repo

- this companion accurately records the exact 1.1.4 baseline;
- no runtime behavior is changed;
- the authoritative cross-repo program owns phase numbering and gates;
- Phase 1 does not begin until the paired Phase 0 documentation has been reviewed/merged in both repositories.
