# ADSP P2 matched horizontal Redis comparator

This slice measures the first performance/correctness portion of ADSP Phase 2 after the production `1 → 2 → 4` Redis-transporter topology foundation merged in PR #91.

It is intentionally **not** a Phase-2 completion claim. The whole-stack mixed/federation workload and node-loss-under-load gates remain separate required evidence.

## Matched root-entry model

The existing APDM Phase-8 real measurement runner already established a useful property for horizontal testing: the benchmark process is a separate Moleculer broker, not one of the production Pod/SemApps cells.

The P2 load driver keeps that model and joins the explicit P2 namespace through the incumbent Redis transporter. It has no local `activitypub.outbox.post` endpoint. Therefore:

- with one Pod/SemApps replica, the root has one eligible remote endpoint;
- with two replicas, the same root action has two eligible remote endpoints;
- with four replicas, it has four eligible remote endpoints;
- once a root lands on a Pod/SemApps cell, Phase-1 `registry.preferLocal` keeps the tightly coupled nested Tier-1 work local by default.

This exercises horizontal application capacity without introducing an HTTP load balancer or changing the production service grouping merely for the benchmark.

## Per-replica authoritative trace correlation

The Phase-8 overlay historically wrote one process's instrumentation to one JSONL file. Horizontal evidence cannot share one output file across processes because it must prove which replica executed each measured root and reject duplicate completion records.

The P2 compose overlay therefore gives each replica its own mounted trace file:

- `trace-N-r1.jsonl`
- `trace-N-r2.jsonl`
- `trace-N-r3.jsonl`
- `trace-N-r4.jsonl`

For every offered request, `adsp-p2-horizontal-load.js`:

1. supplies a unique Moleculer request ID;
2. requires `activitypub.outbox.post` to return a persisted Activity ID;
3. waits for detached local delivery to finish and for exactly one APDM-P8-A trace carrying that request ID;
4. fails if the request appears in more than one replica trace;
5. fails on instrumentation/delivery errors or recipient-count mismatch;
6. requires unique request IDs and unique persisted Activity IDs for the completed window;
7. records the executor replica from the trace-file authority.

Decision evidence additionally requires every configured replica to have executed measured work in each accepted window. Merely advertising endpoints is not horizontal performance evidence.

## Window metrics

A measured window is the unit of P2 performance sampling. Worker slots are held until the corresponding detached local-delivery trace completes, so `concurrency` represents concurrently outstanding **completed application outcomes**, not just rapidly submitted roots.

Per-request trace evidence records:

- completed/action-return latency;
- APDM trace elapsed latency;
- action and Fuseki request attribution;
- semantic/delivery errors.

The existing trace CPU fields are deliberately **not summed** for horizontal CPU-per-outcome evidence because overlapping traces use process-wide `process.cpuUsage()` and would double-count shared CPU time.

Instead, the workflow records raw cgroup CPU/memory snapshots for every active backend, Fuseki and Redis before and after each measured window, plus Redis `INFO commandstats` and `INFO memory`. Whole-system resource normalization is derived from those non-overlapping window boundaries.

## Identical starting state per arm

Sequentially running `1 → 2 → 4` against one live dataset would bias later arms with Activities and cache/state created by earlier arms.

The comparator therefore:

1. provisions one canonical actor fixture once;
2. gracefully stops the provisioning backend so its Moleculer endpoint is withdrawn;
3. persists Redis and stops Redis/Fuseki;
4. snapshots the post-provisioning Fuseki and Redis bind-mounted state;
5. restores that exact seed before every `(replicaCount, recipientCount)` case.

All replica arms therefore begin from the same application/data state on the same runner.

## Evidence profiles

Pull-request runs are **smoke only**:

- N=10;
- one measured window per 1/2/4 topology;
- two completed outcomes at concurrency two;
- never interpreted as promotion evidence.

Manual `workflow_dispatch` is the decision-evidence profile and defaults to:

- recipient counts N=10 and N=100;
- replicas 1, 2 and 4;
- one excluded warmup window per case;
- five measured windows per case (the locked minimum);
- eight completed outcomes per window;
- concurrency eight, matched across all replica arms.

The workflow rejects an evidence-mode sample count below five.

## Scale interpretation

`adsp-p2-horizontal-summarize.js` reports median throughput and completed p95/p99 distributions for every required arm and computes `1 → 2` and `2 → 4` ratios.

The locked scale rule is preserved exactly:

- `≥1.50x` successful throughput closes the numeric scale gate directly;
- `≥20%` p95 reduction is reported as an observation only and **does not** close the gate unless independent evidence demonstrates that the smaller arm was saturated.

The summarizer does not infer saturation from a favorable latency number.

## Frozen settings

Across replica-count arms:

- application source/image is identical;
- Redis remains the Moleculer transporter;
- `RdfJSONSerializer` is unchanged;
- Pod/SemApps service grouping is unchanged;
- APDM local delivery concurrency remains c4;
- Phase-10 dataset-existence memo remains off;
- ActivityPub remote delivery remains native for this Tier-1-only fixture;
- federation sidecar is excluded from this W1 slice;
- Redis Stream Brotli writer remains explicitly off;
- Redis/Fuseki topology remains shared and identical.

The later W3 mixed ActivityPods+federation comparator must include the sidecar and pin the same federation settings across its replica arms.

## Remaining Phase-2 gates after this slice

Even a successful W1 scale result does not complete P2. Remaining required work includes:

- whole-system resource normalization from the captured cgroup/Redis evidence;
- W3 mixed ActivityPods + accepted remote delivery intents + Fedify sidecar measurement;
- node loss under real accepted load;
- bounded recovery and stale-registry convergence;
- zero lost/duplicate accepted ActivityPub delivery intent or authoritative Pod mutation under failure;
- final cross-repository Phase-2 evidence reconciliation before Phase 3 is authorized.
