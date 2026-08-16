# ActivityPods Scalability Architecture

This document describes the provider-wide scalability work in this fork. It is broader than the ActivityPub Delivery Migration (APDM) program: APDM is the delivery/fan-out workstream inside a larger effort to make ActivityPods scale without abandoning core ActivityPods/SemApps authority, Pod isolation, WebACL/LDP semantics, or protocol compatibility.

## Core objective

The scalability program systematically removes work whose cost grows unnecessarily with provider size, follower count, recipient count, history size, or repeated access to the same authoritative state.

The target is not "make everything cached" or "move everything to the sidecar." The target is:

- eliminate duplicate work;
- replace provider/population scans with selective indexed access or bounded pages;
- replace OFFSET and application-side slicing where it creates growing datastore work;
- batch independent same-authority reads when semantics permit;
- reuse already-authoritative values within a deliberately bounded scope;
- keep request, response, queue, memory, and concurrency fan-out bounded;
- push filtering/selectivity into Fuseki when that reduces transferred/materialized state without weakening authority;
- add projections/indexes only as acceleration structures whose source of truth remains the owning Pod or settings dataset;
- preserve per-Pod dataset isolation, WebACL/LDP behavior, ActivityPub semantics, signing/key custody, and upstream SemApps compatibility;
- measure before changing production defaults.

A scalability change is not accepted merely because it is faster in a unit test. It must also preserve the relevant correctness, authorization, persistence, event, retry, and protocol contracts.

## Core scaling problems being resolved

### 1. Local ActivityPub fan-out amplifies nested Pod/Fuseki work

The original SemApps local delivery path looked modest if only top-level calls were counted, but real Phase 8 measurements showed that nested work dominates. At 1,000 local recipients the canonical baseline averaged about 57,911 nested Moleculer actions and 29,303 Fuseki HTTP requests per sample, with roughly 333.5 seconds wall-clock time.

The measured slope was approximately 57 nested actions and 29 Fuseki requests per additional local recipient. This is why local fan-out is treated as a first-class provider scalability problem rather than only a scheduling problem.

Workstreams:

- APDM P7 removes a duplicate local account lookup while keeping the same Pod dataset authority;
- P8 measures real nested Moleculer/Fuseki/LDP/WebACL cost;
- P9 replaces strict serial scheduling with a bounded worker pool and empirically selects concurrency 4;
- P10 targets repeated metadata authority checks, beginning with delivery-scoped positive dataset-existence reuse;
- P11 is reserved for persistence-path optimization only after the post-P10 baseline is measured;
- P12 adds durable per-recipient recovery/idempotency so transient failures do not require replaying successful recipients.

The Fedify sidecar does not replace local Pod delivery. Local fan-out remains inside ActivityPods/SemApps because that is where Pod, dataset, WebACL, LDP, collection, and activity-attachment authority lives.

## 2. Remote ActivityPub delivery previously duplicated routing and execution work

Before APDM cutover, SemApps could create native `remotePost` jobs while the custom downstream emitter separately reconstructed remote targets for the sidecar. This created two routing/execution paths, duplicate actor/inbox resolution, and the risk of duplicate federation.

APDM resolves the architecture before optimizing it:

- ActivityPods remains recipient-expansion, local/remote classification, persistence, and signing authority;
- `ap.delivery-plan.v1` carries the authoritative resolved remote intent;
- the handoff is durable and idempotent;
- in production external mode Fedify/sidecar is the sole internet-facing ActivityPub HTTP executor;
- native SemApps delivery remains a deterministic rollback mode;
- the raw `outbox.posted` emitter no longer acts as a second routing authority.

This reduces duplicate work and makes later remote scaling—shared-inbox collapse, per-domain concurrency, retry/DLQ, FEP support, and queue batching—safe because there is one execution authority.

## 3. Provider-wide scans make work scale with every account even when only a page or one account is needed

Several paths historically materialized broad provider state in Node or asked Fuseki for more state than the caller needed.

Examples already addressed:

- PR #49 replaces reconciliation account population materialization with a bounded settings-dataset keyset query;
- PR #41 keyset-pages the identity change feed and performs authoritative LDP reads only for the selected page;
- PRs #42/#43 turn blocked/muted legacy collection bootstrap into one-time provider migrations, so normal warm startup becomes O(1) with respect to account count after migration completion;
- PR #32/37 replace exact DID/handle population scans with selective predicate/object lookups plus authoritative LDP verification.

General rule: a request for one item or one page must not silently materialize the entire provider population in application memory.

## 4. OFFSET and post-query filtering make later pages increasingly expensive

OFFSET can force Fuseki/TDB2 to walk and discard prior rows. Application-side filtering can also transfer a large superset and then throw most of it away.

Examples:

- PR #50 replaces reconciliation outbox LIMIT/OFFSET paging with a deterministic `(published, activityUri)` keyset cursor;
- PR #51 pushes the reconciliation lookback cutoff into the SPARQL candidate set instead of scanning stale history and stopping in JavaScript;
- PR #46 pages DM conversation nodes before participant expansion and pushes participant autocomplete filtering into SPARQL before `LIMIT`.

The preferred pagination contract is stable keyset/range paging over authoritative indexed fields, with deterministic tie breakers and bounded result sizes.

## 5. Full collection materialization is especially costly for large follower sets

ActivityPub follower collections can become some of the largest structures owned by a Pod. Materializing every follower to answer a domain-specific or reconciliation question creates cost proportional to total followers even when only a small subset is relevant.

Examples:

- PR #44 introduces a domain-addressable follower projection for FEP-8fcf requests while keeping the Pod collection authoritative;
- PR #45 makes projection validation and rebuild bounded: keyset pages, bounded `VALUES` membership queries, bounded update batches, and no full follower population in Node;
- PR #64 refines the acceleration structure to exact server base URI (scheme + authority + explicit port), avoiding hostname-level overfetch;
- PR #58 selectively reads the reconciled sender's follower membership rather than materializing the full SemApps collection object repeatedly;
- PR #52 reuses one sender-follower expansion within a single reconciliation account scan;
- PR #38 makes reverse-follow SPARQL begin from the selective bound membership pattern rather than the broad actor population.

Projections are never treated as membership authority. They narrow the candidate set; authoritative Pod membership validates the result.

## 6. Per-item authority checks can create N datastore round trips where bounded batches are safe

Some semantics require separate Pod datasets, so not every N can become one query. But operations sharing the same authoritative dataset can often be checked in bounded groups.

Examples:

- PR #54 batches provider-local account classification with bounded `VALUES ?webId` queries;
- PR #45 batches follower membership validation instead of one `activitypub.collection.includes` / Fuseki query per candidate;
- PR #48 batches private-poll audience membership checks by exact SemApps dataset, preserving cross-dataset separation;
- follower projection inserts, validation, stale cleanup, and rebuilds use count and rendered-payload ceilings rather than monolithic queries.

General rule: batching must follow authority boundaries. We do not collapse data across Pod datasets merely to reduce query count.

## 7. Heavy actor/LDP materialization was being used to read a single persisted property

Several hot paths invoked full actor/resource materialization just to retrieve `ldp:inbox`, `as:outbox`, or another persisted relation. That can traverse remote checks, existence checks, RDF CONSTRUCT, JSON-LD framing, and caches for one scalar value.

Examples:

- PR #56 selectively resolves local inboxes from the already-authoritative Pod dataset;
- PR #57 uses the same bounded allowlisted predicate-read model for reconciler outboxes;
- PRs #60/#61 keep bounded per-scan snapshots of already-validated remote/local delivery targets;
- PR #62 selectively resolves follower-addressed reconciliation recipients and reuses the sender snapshot.

The optimization reads the authoritative persisted predicate; it does not derive collection URLs from string conventions or introduce a second source of truth.

## 8. Reconciliation can multiply normal delivery costs across accounts × history × recipients

Durable external delivery reconciliation is necessary for crash recovery, but an unbounded reconciler can become a provider-wide background load generator.

The current direction bounds every dimension:

- provider accounts: keyset paging (#49);
- account history: keyset paging and query-side lookback (#50/#51);
- sender followers: per-run reuse and selective membership (#52/#58/#62);
- local account classification: bounded batches (#53/#54);
- local/remote delivery targets: bounded per-account snapshots (#60/#61);
- replay lifetime: maximum automatic producer lookback (#25);
- invalid/missing authority: fail closed rather than silently widening scans or inventing state.

The goal is that reconciliation cost scales with the bounded recovery window and selected pages, not with all accounts × all history × all followers.

## 9. Startup migrations must not remain permanent O(total accounts) startup work

Compatibility migrations are sometimes population-wide once. They should not become an unconditional cost of every restart.

PRs #42 and #43 use durable provider-level completion markers for blocked/muted legacy collection bootstraps. The marker is committed only after all existing actors succeed; a partial failure leaves migration incomplete so the next restart retries. Once complete, normal warm startup skips the provider population loop.

This pattern should be reused for future one-time provider migrations.

## 10. Identity and ATProto integration must not add provider-population scans

The parallel ATProto/SemApps integration adds identity bindings and change feeds that can become provider-wide hot paths if implemented as full scans.

Current safeguards include:

- exact DID/handle lookup through selective indexed predicate/object queries (#32/#37);
- authoritative LDP revalidation so derived indexes do not become identity authority;
- removal of duplicate projection index lookups (#40);
- keyset-paged identity change feed with authoritative reads bounded to the selected page (#41).

The same design rule applies to future ATProto repository/provisioning features: incremental consumers should read bounded changes, not repeatedly enumerate the provider population.

## 11. Fuseki/TDB2 resource usage must be improved by query shape before simply allocating more memory

PR #35 exposes deployment-specific `FUSEKI_JVM_ARGS` and low-cost health visibility, but deliberately does not treat heap growth as the primary scalability strategy.

Priority order:

1. remove population scans and repeated round trips;
2. improve selectivity and bounded query/update shapes;
3. observe JVM heap, host page cache, disk I/O, TDB2 growth, latency and compaction needs;
4. tune heap from measured deployment behavior;
5. treat Jena/WebACL major upgrades as explicit compatibility/data-migration work.

A larger heap cannot repair an O(N) query or an application path that transfers the full provider population unnecessarily.

## 12. Memory, concurrency, queue and response fan-out must stay bounded

Performance work must not replace database amplification with memory or scheduler amplification.

Examples of the common rules used across the fork and sidecar:

- fixed worker pools instead of one promise per recipient;
- hard concurrency ceilings and safe invalid configuration fallbacks;
- bounded keyset pages;
- bounded `VALUES` item counts and rendered byte sizes;
- bounded projection/update batches;
- bounded per-scan caches with fresh scope per account/run;
- response body/item ceilings where remote or internal APIs could return large collections;
- bounded queue claim/read batches and retry/backoff behavior;
- oversized authoritative collections fail closed rather than being silently truncated when truncation could create false state.

## Local versus remote scalability ownership

### ActivityPods / Tier 1

Owns and must scale:

- local Pod fan-out;
- recipient expansion and local/remote classification;
- per-Pod LDP/WebACL/Fuseki operations;
- provider account/index lookups;
- follower collection authority and projections;
- blocked/muted/DM/poll/reply policy data paths;
- identity bindings and ATProto-facing provider indexes;
- durable handoff production and reconciliation;
- signing/key custody.

### Federation/Fedify sidecar / Tier 2

Owns and must scale:

- remote HTTP execution;
- shared-inbox deduplication/collapse;
- per-domain concurrency and rate controls;
- retry/backoff and DLQ execution state;
- durable outbound/inbound stream consumption;
- remote actor/key fetch boundaries;
- FEP synchronization transport and remote reconciliation;
- queue batching and bounded cleanup/fan-out.

A feature should not cross this boundary merely because one process appears faster. Authority and failure semantics determine ownership; optimization happens inside the correct owner.

## Evidence-driven scalability rules

A scalability PR should answer:

1. What dimension currently grows: recipients, accounts, followers, history, collections, queue entries, or bytes?
2. What is the present complexity/round-trip shape?
3. Which authority boundary prevents an unsafe shortcut?
4. Does the change make work selective, paged, batched, reused, or bounded?
5. What remains O(N) after the change, and is that inherent or still an optimization target?
6. What resource could become the new bottleneck: Fuseki CPU/I/O, Node CPU/heap, Redis, network, disk, or remote domains?
7. What correctness/failure behavior must remain unchanged?
8. What measurement or source-contract test proves the claimed improvement?

We prefer truthful partial improvements over claims that an operation is O(1) when Fuseki, another Pod dataset, or a downstream layer still performs population work.

## Current state and remaining major work

Completed work has removed many obvious provider-wide scans, duplicate reads, full follower materializations, and unbounded/broad query shapes. APDM P0-P9 is complete and P10 is measuring the next local-delivery metadata reduction.

Major remaining areas include:

- finish APDM P10 and remeasure the local baseline;
- investigate/optimize the dominant P11 persistence operations without bypassing LDP/WebACL/Pod isolation;
- durable per-recipient local recovery/idempotency (P12);
- converge bridge/local-notification paths on the optimized local primitive (P13);
- later shared-inbox and end-to-end fault/load work (P14-P15);
- production measurements that include concurrent users/accounts, not only one large fan-out;
- sustained Fuseki/TDB2 dataset growth, compaction, disk/page-cache and long-running provider behavior;
- startup, background reconciliation, identity change-feed, follower-sync, ATProto provisioning/repository, and queue throughput under realistic multi-account load;
- resource budgets and operator guidance for small, medium, and large providers.

The goal is not to claim ActivityPods is "fully scalable" at an arbitrary provider size. The goal is to make scaling limits measurable, remove avoidable amplification systematically, preserve core ActivityPods compatibility, and move each remaining bottleneck behind a bounded and observable contract.