# ActivityPods Resource Efficiency Architecture

This document complements [`scalability.md`](./scalability.md). Scalability asks whether the system continues to behave well as accounts, recipients, followers, history, queues, and datasets grow. Resource efficiency asks a different question:

> How much compute, memory, datastore I/O, disk/network traffic, and background work does ActivityPods consume to produce the same correct useful outcome?

The goal is to make ActivityPods **less resource intensive without sacrificing performance, efficiency, correctness, durability, interoperability, Pod isolation, WebACL/LDP semantics, or upstream ActivityPods/SemApps compatibility**.

## Core objective

A successful optimization should reduce one or more of:

- Node CPU time / CPU-seconds per useful operation;
- heap/RSS and peak temporary allocation;
- Fuseki/TDB2 queries, updates, bytes transferred, disk I/O, and unnecessary materialization;
- Redis commands, queue entries, retries, claims, and cleanup work;
- network requests and bytes between ActivityPods, sidecars, datastores, and remote servers;
- repeated JSON-LD/RDF framing, serialization, parsing, actor materialization, or cache re-reading;
- background reconciliation, polling, startup migration, and idle-period work;
- persistent storage amplification caused by duplicate or redundant representations;
- container/process footprint required for a representative provider workload.

But the optimization must preserve or improve:

- end-to-end latency;
- sustained throughput;
- successful-delivery and persistence semantics;
- partial-failure behavior and recovery;
- authorization/security boundaries;
- protocol compatibility;
- observability and operability.

Using less CPU only because work is delayed, skipped, serialized excessively, or pushed into a hidden downstream bottleneck is **not** a resource-efficiency improvement.

## Efficiency is not the same as throttling

Resource reduction must be normalized against useful work. Examples:

- fewer CPU-seconds **per successfully delivered recipient** is useful;
- lower memory **while preserving the same throughput and failure behavior** is useful;
- fewer Fuseki requests because duplicate authority checks were safely reused is useful;
- lower CPU because concurrency was reduced until latency doubled is not automatically useful;
- fewer database requests because required persistence or ACL work was skipped is invalid;
- moving CPU from ActivityPods to the sidecar without reducing total system work is not automatically an improvement.

We therefore optimize the whole architecture, not just one process's local metrics.

## Work-per-outcome measurements

Where practical, performance evidence should report both absolute resource use and normalized efficiency metrics such as:

- CPU-seconds / request;
- CPU-seconds / local recipient delivered;
- Fuseki HTTP requests / local recipient;
- Moleculer actions / useful operation;
- Redis operations / remote delivery intent;
- remote HTTP attempts / successful delivery;
- bytes read/written / follower synchronized;
- bytes read/written / identity change consumed;
- peak RSS / concurrent active operation;
- queue depth and retry work / completed intent;
- startup work / provider account after completed migrations;
- background reconciliation work / recovered missing delivery.

P50/P95/P99 latency and sustained throughput should be considered alongside those resource metrics. A lower resource number is not sufficient if tail latency, backlog growth, or throughput materially worsens.

## ActivityPods resource-efficiency priorities

### Local Pod delivery

Local ActivityPub delivery is expensive because one logical recipient can trigger nested ActivityPub, LDP, WebACL, and Fuseki work. The current APDM program therefore does more than reduce wall-clock latency:

- remove duplicate account/dataset resolution;
- reuse authoritative metadata within narrow safe scopes;
- reduce repeated datastore existence checks;
- avoid heavyweight actor/resource materialization for scalar persisted properties;
- keep concurrency bounded so latency gains do not become heap/Fuseki overload;
- optimize persistence only after measuring the post-metadata baseline;
- avoid replaying recipients that have already succeeded once durable local recipient state exists.

The target is fewer CPU cycles and datastore round trips **per correct local recipient delivery**, not merely a faster timer.

### Fuseki/TDB2

The preferred order is:

1. remove unnecessary queries and updates;
2. make queries selective;
3. replace population materialization with bounded pages/indexed lookups;
4. batch same-authority operations where semantics permit;
5. reduce response/update byte volume;
6. measure heap, page cache, disk I/O, compaction, and long-running dataset growth;
7. only then tune JVM resources from evidence.

Giving Fuseki more memory is a capacity adjustment, not a substitute for eliminating waste.

### Startup and idle/background cost

A provider should not need substantial compute merely to remain online.

Targets include:

- one-time migrations remain one-time through durable completion markers;
- warm startup avoids O(total accounts) work where possible;
- reconciliation and change feeds use bounded/keyset work instead of full scans;
- polling intervals and retry loops use bounded exponential backoff where appropriate;
- caches/projections rebuild lazily or incrementally when that preserves authority;
- idle processes should avoid unnecessary periodic full-dataset activity.

### Identity and ATProto integration

Parallel ATProto support must not double provider resource consumption merely because another protocol is present.

Shared authoritative data should be reused through explicit interfaces where safe; derived ATProto indexes/change feeds should remain selective and incremental; repository/provisioning work should be measured for CPU, memory, storage, queue, and Fuseki impact independently of ActivityPub.

Protocol compatibility does not require duplicating the same expensive discovery or materialization in two independent paths.

## Cross-service efficiency

ActivityPods and the federation sidecar are one deployment architecture even though they have separate authority domains. Efficiency must therefore be evaluated across the boundary.

Examples:

- ActivityPods should hand off one authoritative resolved remote intent rather than making the sidecar repeat recipient planning;
- the sidecar should collapse shared-inbox work when semantically safe instead of issuing redundant remote HTTP requests;
- retry/DLQ systems should avoid redoing already-completed work;
- queue payloads should carry enough authoritative metadata to avoid repeated remote/local discovery, without becoming oversized snapshots;
- batching should reduce command/syscall/network overhead without creating unbounded latency or memory queues.

The rule is **minimize total useful-system work**, not optimize one component by transferring waste to another.

## Resource budgets

The project should evolve toward explicit evidence-backed resource budgets for representative provider sizes. Those budgets should eventually cover at least:

- baseline idle CPU/RSS;
- warm startup CPU/time/I/O;
- N concurrent active accounts;
- local fan-out at representative recipient counts;
- remote fan-out and shared-inbox workloads;
- reconciliation backlog recovery;
- follower synchronization;
- ATProto identity/repository/provisioning activity;
- Fuseki heap/disk/page-cache behavior;
- Redis memory/queue depth;
- sidecar CPU/RSS and outbound socket concurrency.

Small providers matter. An architecture that only performs well after allocating large VM/container resources does not meet the goal if equivalent useful work can safely be done with less compute.

## Evidence gate for resource-efficiency changes

A resource-efficiency PR should state:

1. what useful outcome is held constant;
2. which resource is being reduced;
3. the before/after resource metric;
4. latency and throughput before/after;
5. whether work was removed, batched, reused, deferred, or moved;
6. what correctness/authority/failure semantics are unchanged;
7. what new bottleneck could appear;
8. rollback behavior;
9. whether the improvement holds under sustained/concurrent load rather than one isolated request.

For important production-default changes, measurements should compare matched environments and representative workloads. We should prefer improvements that reduce both latency and resource consumption; when there is a tradeoff, it must be explicit and evidence-backed.

## Anti-goals

We do not consider these valid efficiency strategies by themselves:

- disabling required protocol behavior;
- weakening WebACL/LDP/Pod isolation;
- silently truncating authoritative state;
- replacing bounded latency with an ever-growing queue;
- making retries infinite or aggressively tight;
- increasing cache lifetime until mutable authority becomes stale;
- using unbounded concurrency to hide slow per-item work;
- moving all work to a larger sidecar or datastore and calling ActivityPods lighter;
- increasing hardware as the first response to an avoidable O(N) or duplicate-work path.

## Relationship to scalability and APDM

[`scalability.md`](./scalability.md) is the umbrella record of provider-wide scaling pathologies and subsystem work. APDM is the ActivityPub delivery/fan-out workstream within that program.

Resource efficiency is a cross-cutting requirement across **all** of those workstreams. A phase can improve scalability without necessarily reducing total compute, and a micro-optimization can reduce compute without changing asymptotic scalability. The architecture needs both.

The desired end state is ActivityPods that handles larger workloads **and** does each unit of useful work with less CPU, memory, I/O, network traffic, and background amplification than the unoptimized baseline, while retaining the behavior that makes ActivityPods/SemApps correct and interoperable.
