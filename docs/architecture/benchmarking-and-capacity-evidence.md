# Portable Benchmarking and Capacity Evidence

ActivityPods must be able to run efficiently across heterogeneous deployments: shared VPS plans, dedicated-vCPU cloud instances, rented bare metal, colocated hardware, home servers, and provider-specific infrastructure. The project therefore does **not** treat any one cloud vendor as the performance authority and does not require a permanent DigitalOcean/Hetzner/Infomaniak/etc. CI matrix.

The benchmarking strategy separates correctness, work efficiency, absolute performance, and operator capacity guidance so that results remain meaningful across different CPUs, storage systems, levels of host contention, and deployment sizes.

## Core rule

A scalability or resource-efficiency claim must be expressed at the level that the evidence can actually support.

Examples:

- "87% fewer Fuseki dataset-registry GETs" is a portable mechanism claim when the same useful work and semantics are preserved.
- "48% fewer total Fuseki HTTP requests" is a portable work-efficiency claim under the same measured workload.
- "N=1000 completes in 18 seconds" is an environment-specific performance claim and must carry exact hardware/runtime provenance.
- "4 vCPU / 8 GB is sufficient for X users" is a capacity recommendation and requires sustained representative workload evidence, not one isolated fan-out benchmark.

Absolute timings must never be promoted into universal hardware requirements without a representative capacity study.

## Three evidence tiers

### Tier A — hardware-independent invariant and work-efficiency evidence

Tier A is the default gate for mechanism/correctness changes.

It measures values that should remain meaningful across providers and CPU families:

- delivery success/failure equivalence;
- no duplicate federation or skipped required persistence;
- WebACL/LDP/Pod-authority invariants;
- Moleculer action counts per useful operation;
- Fuseki queries/updates/HTTP requests per useful operation;
- Redis operations per completed intent;
- remote HTTP attempts per successful delivery;
- queue/retry work per completed intent;
- bytes transferred/materialized where the workload is fixed;
- number of repeated authority/discovery operations removed;
- pagination/batch/concurrency ceilings;
- idempotent recovery behavior.

Tier A may compare runs from different hardware when the metric is inherently hardware-independent and provenance proves equivalent code/workload. CPU time, latency, heap and throughput from unmatched hosts must not be interpreted as comparable performance evidence.

### Tier B — controlled reference performance evidence

Tier B exists for latency, CPU, memory and throughput decisions.

OFF/ON or before/after comparisons should use, as far as practical:

- the same exact source commit or explicitly identified comparison commits;
- the same installed dependency/runtime artifact;
- the same CPU model/count and host-memory envelope;
- the same runner/OS/container images;
- the same workload, fixtures, warmups and sample counts;
- fresh state where accumulated history would contaminate comparison;
- the same local-delivery/federation concurrency settings except for the intentional experimental variable.

Matched evidence is especially important before changing production defaults.

GitHub-hosted runners are useful reference infrastructure but are not a universal hardware baseline. If separate hosted runners cannot guarantee comparable hardware, paired experiments should run sequentially on one runner when experiment duration permits.

### Tier C — portable operator/community benchmarks

The project should provide a reproducible benchmark command or harness that operators can run on their own infrastructure.

A future command such as:

```bash
yarn benchmark:provider
```

or an equivalent packaged command should emit a standardized machine-readable result containing at least:

- ActivityPods version/commit;
- SemApps/runtime versions;
- enabled protocol/features;
- CPU model/count/architecture;
- total memory;
- OS/kernel/container runtime;
- storage characteristics when reliably detectable or operator-supplied;
- whether compute is known to be shared or dedicated when operator-supplied;
- local fan-out measurements;
- remote federation measurements where safe and reproducible;
- reconciliation/background-work measurements;
- ATProto provisioning/change-feed/repository measurements when implemented;
- CPU time, RSS/heap, datastore work, network/queue work and elapsed time;
- success/failure counts and workload shape.

Submission of community/operator benchmark results must be optional. Raw results should be treated as observational evidence, not certification of a hosting provider.

## Deployment classes, not vendor lock-in

Capacity documentation should group infrastructure by resource/performance characteristics rather than by brand.

Initial planning classes:

| Deployment class | Representative shape | Primary questions |
|---|---|---|
| Small shared | ~2 shared vCPU / 4 GB RAM | idle footprint, modest providers, burst tolerance, neighbor contention |
| Small dedicated | ~2–4 dedicated vCPU / 8 GB RAM | sustained local/remote delivery and predictable latency |
| Medium dedicated | ~4–8 dedicated vCPU / 16 GB RAM | concurrent users, federation, reconciliation and background work |
| Large dedicated | 8+ dedicated vCPU / 32+ GB RAM | large fan-out, sustained concurrency, outage recovery and growth |
| Bare metal / operator hardware | operator-defined | upper-bound efficiency, storage behavior, hardware-specific tuning |

These are evidence categories, not minimum requirements. Actual resource guidance should be published only after representative measurements establish safe envelopes.

A DigitalOcean, Hetzner, Infomaniak, OVH, home server, colocated server or other host maps to the closest deployment class based on its actual resources and sharing model rather than receiving a separate code path.

## Normalize resource efficiency per useful outcome

The preferred engineering metrics are normalized quantities such as:

- CPU-seconds per successful local recipient;
- CPU-seconds per completed remote delivery intent;
- Fuseki HTTP requests per delivered local recipient;
- Fuseki bytes or queries per account lookup/reconciliation unit;
- Redis commands per completed durable handoff;
- HTTP attempts and bytes per successful remote inbox delivery;
- peak RSS per representative concurrency level;
- queue/retry operations per recovered delivery;
- startup work per account;
- background reconciliation work per recovered intent;
- ATProto provisioning/repository work per completed operation.

Normalized metrics make improvements portable across infrastructure. A faster CPU changes elapsed time; it does not change whether the system eliminated thousands of unnecessary datastore operations.

## Cost-normalized planning

The repository should not hard-code cloud prices into engineering decisions because prices, regions and product names change independently of software behavior.

Instead, the benchmark suite should expose stable resource units that operators can map to current hosting prices:

- CPU-seconds;
- peak/sustained RAM;
- datastore request and byte rates;
- storage growth;
- network bytes;
- queue/stream retention;
- sustained throughput and backlog-recovery rate.

This makes later cost guidance auditable without coupling ActivityPods to one vendor's pricing model.

## Capacity testing must be broader than one large fan-out

A single sender with 1,000 followers is useful for isolating local fan-out amplification but is not a complete provider-capacity test.

Representative capacity work must eventually include:

- concurrent posters/accounts;
- mixed local and remote recipients;
- shared-inbox and non-shared-inbox remote targets;
- simultaneous inbound federation;
- background delivery reconciliation;
- follower synchronization/projections;
- identity and ATProto change feeds;
- ATProto account provisioning/repository operations;
- DM/poll/reply workloads;
- steady-state and burst traffic;
- restart/warm-start behavior;
- Fuseki/TDB2 dataset growth and disk/page-cache effects;
- Redis/queue backlog growth and recovery;
- remote failure/retry storms;
- long-running memory and resource stability.

Capacity recommendations must distinguish burst tolerance from sustained throughput.

## Provider variability and noisy neighbors

Shared virtual machines may have variable wall-clock behavior due to host contention. Dedicated-vCPU instances and bare metal usually provide more stable CPU scheduling, but storage/network behavior can still vary.

Therefore:

- portable correctness/work-count gates should not fail because a hosted runner was temporarily slower;
- latency/CPU/RSS comparisons require matched or controlled evidence;
- reference benchmarks should record enough provenance to identify environment drift;
- community results should report distributions and repeated samples rather than one timing;
- operator guidance should prefer ranges and sustained behavior over a single headline number.

## Evidence format and provenance

Every significant benchmark artifact should carry:

- experiment/phase identifier;
- source commit;
- installed image/artifact identity where relevant;
- workload definition;
- sample count and warmups;
- concurrency settings;
- CPU model/count/architecture;
- total memory;
- OS/runner/container image versions;
- datastore and dependency image versions;
- protocol/config toggles relevant to the test;
- success/failure counts;
- raw measurements plus summarized statistics.

If a provenance difference invalidates only performance comparison but not a hardware-independent mechanism metric, the result should say exactly that instead of discarding all evidence or overstating what it proves.

## Relationship to APDM Phase 10

Phase 10 demonstrates this policy concretely.

The first real OFF/ON run proved hardware-independent mechanism value through large reductions in exact Fuseki dataset-registry GETs and total Fuseki request counts, while all measured deliveries succeeded. It could not support a production-default latency/resource decision because the arms ran on different CPU families and independently built backend images.

The hardened paired experiment therefore keeps the mechanism evidence while requiring one runner and one exact backend image for the performance/resource decision.

This is the intended model for future performance work: **preserve valid evidence, reject invalid interpretations, and strengthen the experiment rather than weakening the gate.**

## Desired long-term operator guidance

Once enough Tier B and Tier C evidence exists, the project should be able to publish evidence-backed statements such as:

- practical minimum/comfortable resources for a small provider;
- expected local/remote throughput ranges by deployment class;
- recommended Fuseki heap and storage considerations by measured workload;
- when dedicated CPU becomes preferable to shared CPU;
- expected idle footprint;
- sustainable account/follower/activity ranges under documented workloads;
- which subsystem becomes the limiting resource first;
- how capacity changes when optional ATProto/federation features are enabled.

Until then, documentation should explicitly distinguish measured facts from provisional planning assumptions.
