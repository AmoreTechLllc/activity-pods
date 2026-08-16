# ActivityPub Delivery Migration — ActivityPods Companion

Program ID: `APDM`

This is the ActivityPods-specific companion to the authoritative cross-repository roadmap in `outlaw-dame/mastopod-federation-architecture/docs/activitypub-delivery-migration/`.

ActivityPods does not maintain an independent phase numbering scheme. ActivityPods slices use `APDM-P<n>-A`; a checked ActivityPods slice does not override a still-open cross-repo exit gate.

## Completion rule

A checked phase below means the APDM **phase exit gate is closed**, not simply that an ActivityPods implementation PR was merged. Empirical phases remain unchecked until their measurement and promotion/rollback decisions are complete.

## Current program state

- [x] `APDM-P0` — baseline and ownership
- [x] `APDM-P1` — Delivery Plan v1 contract
- [x] `APDM-P2` — pre-`remotePost` delivery strategy seam
- [x] `APDM-P3` — authoritative expanded recipient planning
- [x] `APDM-P4` — durable/idempotent sidecar handoff
- [x] `APDM-P5` — production Fedify remote-authority cutover
- [x] `APDM-P6` — transitional duplicate routing retired
- [x] `APDM-P7` — duplicate local account lookup removed
- [x] `APDM-P8` — real nested Tier 1 measurement complete
- [x] `APDM-P9` — bounded local concurrency measured; c4 promoted
- [ ] `APDM-P10` — measured local metadata round-trip reduction — **IN PROGRESS**
- [ ] `APDM-P11` — batch-safe local persistence — **BLOCKED by P10**
- [ ] `APDM-P12` — durable local fan-out/partial-failure recovery
- [ ] `APDM-P13` — canonical bridge convergence
- [ ] `APDM-P14` — federation-primary shared-inbox hardening
- [ ] `APDM-P15` — end-to-end load/fault/interoperability proof
- [ ] `APDM-P16` — stabilization/migration cleanup

The authoritative cross-repo `STATUS.md` contains the paired PR/commit/evidence ledger.

## Why this repo owns the Tier 1 half

ActivityPods pins `@semapps/activitypub` 1.1.4 and configures ActivityPub with `podProvider: true`. Tier 1 owns:

- Activity persistence and ActivityPub side effects;
- WebID/local actor ownership;
- recipient expansion and local/remote classification;
- local Pod account/dataset/inbox authority;
- WebACL/LDP/Fuseki semantics;
- local delivery implementation and optimization;
- signing/key custody authority;
- production of `ap.delivery-plan.v1` for external delivery.

After durable external handoff, ActivityPods does **not** own internet-facing federation execution, per-domain rate/concurrency controls, external retry/DLQ execution state, or shared-inbox execution optimization. Those belong to the federation/Fedify sidecar.

## Current architecture after Phase 9

### External remote delivery

In production `external` mode:

1. SemApps persists/processes the Activity and still owns local Pod delivery.
2. ActivityPods intercepts the would-have-been native `remotePost` work before native job creation.
3. ActivityPods uses authoritative expanded recipient state to build `ap.delivery-plan.v1`.
4. durable handoff retries until the sidecar accepts the intent.
5. Fedify/sidecar is the sole external ActivityPub HTTP executor for that request.
6. user key custody/signing authority remains in ActivityPods.

`native` remains the tested rollback executor:

```text
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=native
```

### Local Pod delivery

Local fan-out remains the pinned SemApps `localPost()` path. APDM has optimized around that path rather than replacing it:

- Phase 7 carries pre-resolved dataset context to remove the second local account lookup;
- Phase 8 observes real nested Moleculer/Fuseki/LDP/WebACL work and correlates detached completion/failures;
- Phase 9 layers a bounded worker pool and uses empirically selected default concurrency `4`;
- Phase 10 is testing scoped reuse of positive dataset-existence authority checks before any deeper persistence changes.

The sidecar is not a replacement for local Pod delivery.

## Historical Phase 0 SemApps baseline

The verified unoptimized SemApps 1.1.4 baseline remains important as an upstream compatibility reference, but it is **historical APDM baseline**, not a description of current fork behavior after P5–P9.

### Recipient expansion

`activitypub.activity.getRecipients`:

1. resolves the sender;
2. scans `to`, `bto`, `cc`, and `bcc`;
3. skips ActivityStreams Public;
4. expands the sender's local followers collection to concrete followers;
5. de-duplicates the result.

### Historical outbox partition/remote execution

Before APDM interception, `activitypub.outbox.post` partitioned expanded recipients, created one native Bull `remotePost` job for every remote recipient, emitted `activitypub.outbox.posted` only afterward, and launched `localPost()` detached. Native `remotePost` resolved the inbox, signed, and performed the external POST.

That ordering is why a downstream-only `outbox.posted` listener could never safely become remote authority.

### Historical local fan-out

The original pod-provider local path visibly performed, per local recipient:

- partition-time `auth.account.findByWebId`;
- a second `auth.account.findByWebId` inside `localPost`;
- `activitypub.actor.getCollectionUri`;
- `activitypub.collection.add`;
- `ldp.remote.store`;
- `activitypub.activity.attach`.

Those six source-visible calls were never a reliable total-work estimate because nested LDP/WebACL/triplestore calls were not counted. Phase 8 replaced that approximation with real measurements.

## Phase evidence in ActivityPods

| Phase | ActivityPods evidence | State |
|---|---|---|
| P0 | PR #13 | PASS |
| P1 | PR #14; hardening #23 | PASS |
| P2 | PR #15; hardening #22 | PASS |
| P3 | PR #16; hardening #21 | PASS |
| P4 | PR #17; replay-horizon hardening PR #25, merge `1e110861256f419fef9d55af1bcca36627814b88` | PASS |
| P5 | PR #26, merge `427d3d3258382f91355ff08c33cfd40360087d84` | PASS |
| P6 | PR #27, merge `8f6a1bd244015c58698d92a9b9fd939a602d6b96` | PASS |
| P7 | PR #28, merge `6d65b2375b9860229dda3d081446f890bfa8699e` | PASS |
| P8 | PRs #29/#30; #30 merge `e51e5cacd0696e558d7860920025279c9cad22ed` | PASS |
| P9 | #65 primitive `8684c58ad1d494e60ffcfa15ab19ef1c67cce16c`; #66 evidence `154b40873fec0886c4e2a25e67d6e644fe69ec4c`; #68 c4 promotion `5d7f2ff0631402e143000af68c174f8c615a755a` | PASS |
| P10 | PR #67 open; real OFF/ON run `31965449687` launched from `1f512cfb192ab469b9684cb17a7e3af2756a3cdb` | IN PROGRESS |
| P11–P16 | no phase implementation started | BLOCKED / NOT STARTED |

## Phase 4 replay/idempotency hardening

Phase 4's durable handoff contract was later hardened without changing its authority split. ActivityPods PR #25 (`1e110861256f419fef9d55af1bcca36627814b88`) caps automatic producer reconciliation lookback at 48 hours, leaving a 24-hour safety margin inside the existing 72-hour blind-recipient recovery-snapshot lifetime. The paired federation retention hardening keeps completed-delivery proof longer than that producer replay horizon. This prevents an automatically reconstructed deterministic intent from outliving the sidecar evidence used to suppress duplicate remote execution.

## Phase 5 remote-authority contract

`SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE` supports:

- `native` — SemApps remote executor and rollback mode;
- `external` — suppress native `remotePost` jobs and use the durable Delivery Plan handoff, only when the explicit authorization contract succeeds.

Production external authority requires the Phase 5 cutover state; preview-only external behavior is restricted to controlled non-production runtimes. Missing/ambiguous authority configuration fails closed rather than silently creating a second executor.

The production authority invariant is:

```text
ActivityPods recipient/signing authority
        ↓
ap.delivery-plan.v1 durable handoff
        ↓
Fedify sidecar sole external HTTP executor
```

There is no supported parallel raw-routing authority in external mode after Phase 6.

## Phase 7 closure — request-local dataset reuse

The Phase 7 pinned SemApps patch:

- validates a local account during outbox partition as before;
- stores the already-resolved dataset in a non-enumerable Symbol-bound Map on the exact in-memory Activity;
- extracts and deletes that context synchronously at the start of `localPost()`;
- uses it instead of the duplicate account lookup;
- preserves the old lookup as fallback for direct/legacy callers;
- does not serialize the private context or share it across requests;
- is pinned to `@semapps/activitypub@1.1.4` and fails closed on source/version drift.

Inbox, LDP, WebACL, collection and activity-attachment semantics remain unchanged.

## Phase 8 closure — measured Tier 1 cost

The real-runtime benchmark provisions Pod-backed actors through normal signup/bootstrap and invokes the normal running `activitypub.outbox.post` root. Required cases are N=1/10/100/200/1000.

Representative means from the canonical Phase 8 baseline:

| N | elapsed | nested Moleculer actions | Fuseki HTTP requests | CPU |
|---:|---:|---:|---:|---:|
| 1 | 1.354 s | 938 | 318 | 1.559 s |
| 10 | 2.900 s | 1,465.7 | 586.3 | 2.974 s |
| 100 | 25.171 s | 6,611.7 | 3,202.3 | 25.084 s |
| 200 | 50.537 s | 12,286.3 | 6,093.7 | 49.970 s |
| 1000 | 333.538 s | 57,911.3 | 29,303 | 315.461 s |

Measured slope was roughly `57.02` nested actions and `29.01` Fuseki HTTP requests per additional local recipient. This is the evidence baseline for later local-delivery phases.

Detailed docs:

- `pod-provider/backend/docs/apdm-phase8-tier1-instrumentation.md`
- `pod-provider/backend/docs/apdm-phase8-real-measurement.md`

## Phase 9 closure — bounded c4 scheduling

Phase 9 uses a fixed-size worker pool over the existing local-recipient body. It never creates one promise per recipient. Physical completion may be concurrent, but `{ success, failures }` is reconstructed in original recipient order.

Canonical run `31956939507` measured c1/c2/c4/c8 with three successful samples at every canonical N and zero failed samples. The original compare step failed only in artifact handling; PR #66 hardened replay/selection and replay `31964215322` selected the smallest qualifying candidate, c4.

At N=100/200/1000, c4 delivered roughly `1.19x`, `1.21x`, and `1.34x` speedups versus c1, with lower measured CPU and near-invariant underlying action/Fuseki work. PR #68 therefore promoted normal unset concurrency to `4`.

Runtime rules:

- unset/normal default: `4`;
- explicit `1`: serial rollback;
- valid positive configured values: accepted up to hard ceiling `32`;
- malformed/zero/negative/whitespace-padded/unsafe explicit values: fail safe to `1`.

Detailed doc: `pod-provider/backend/docs/apdm-phase9-bounded-local-concurrency.md`.

## Phase 10 current gate — metadata round-trip reduction

Phase 8 showed repeated dataset-existence authority checking as a large, safe-looking metadata amplifier. Phase 10 therefore begins with measured metadata round-trip reduction rather than assuming account/inbox batching is the first correct optimization.

ActivityPods PR #67 currently implements a fail-closed positive memo with these boundaries:

- scope is exactly one SemApps `localPost()` async lineage;
- only strict positive `triplestore.dataset.exist` results are reused;
- false/error results are never reused;
- dataset management invalidates before and after mutations;
- a mutation epoch prevents stale in-flight positives from repopulating the memo;
- `@semapps/triplestore@1.1.4` existence behavior is compatibility-pinned;
- real correlated Fuseki `GET /$/datasets/{dataset}` requests are the mechanism signal;
- configuration remains disabled unless explicitly set to `true`.

Already closed P10 launch gates:

- [x] implementation and adversarial race/scope hardening;
- [x] rebase on Phase 9 c4 master;
- [x] frozen exact-head Backend Checks `31965391790` pass at `1f512cfb192ab469b9684cb17a7e3af2756a3cdb`;
- [x] dedicated OFF/ON c4 measurement run `31965449687` launched from that exact source.

Still required before P10 PASS:

- [ ] both OFF/ON arms complete N=1/10/100/200/1000 with at least three matched successful samples and zero failed samples;
- [ ] provenance validation passes;
- [ ] every large case reduces real dataset-registry GETs by at least 50% and lowers total Fuseki HTTP work;
- [ ] delivery outcomes and Pod/LDP/WebACL semantics remain equivalent;
- [ ] CPU/heap/latency/resource-comparability evidence is reviewed;
- [ ] an evidence-backed production-default decision is merged.

Phase 11 must not begin before these boxes close.

## Supporting hardening is not phase completion

This repo includes additional reconciliation, follower-index, selective-resolution, identity, Fuseki, FEP and scalability work outside the direct P0–P10 slices. Those changes can reduce cost or protect APDM invariants, but they are supporting/adjacent work unless a cross-repo phase exit gate explicitly depends on them. They must not be used to check a later phase complete early.

## Non-negotiable local-delivery rule

Optimizing local fan-out must preserve local trust, Pod dataset isolation, WebACL/LDP semantics, collection/activity behavior and ActivityPods ownership inside Tier 1. The remaining sequence is evidence-driven:

1. finish measured safe metadata round-trip reduction (P10);
2. measure the new baseline;
3. optimize persistence only with semantic parity (P11);
4. add durable recipient recovery/idempotency (P12);
5. converge internal bridge workflows (P13);
6. complete later federation/load/stabilization gates.
