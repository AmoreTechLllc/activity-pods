# APDM Phase 11 — triplestore query attribution

## Status

**Phase 11: IN PROGRESS — attribution only. No persistence optimization is approved yet.**

Phase 10 is closed. The authoritative paired run is GitHub Actions `31989314315` at exact source head `473cf27b7af20c658d6241cc251b7c822c2172cc`. Runs `31980969664` and `31988013688` are superseded and are not promotion evidence.

The Phase 10 production-default decision is closed as NO-GO: the dataset-existence memo remains disabled unless `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED=true` is set exactly. Phase 11 must not silently change that default.

## Measured reason for Phase 11

On the post-Phase-10 ON arm at N=1000, the residual nested work is dominated by approximately `15,999` `triplestore.query` invocations, with roughly `7.1 s` cumulative median action duration. `triplestore.dataset.exist` is no longer the dominant mechanism.

That aggregate count is not sufficient to justify batching or caching. The first Phase 11 slice is therefore **query attribution before optimization**.

## Review status and superseded evidence

A fresh Codex review was requested for the first implementation head `ff8005ab290f25a3dc483c783b8f8c19acddf081`, but the Codex code-review quota was exhausted. No Codex review was therefore treated as an approval. A manual adversarial review at the same standard is required before evidence can be accepted.

That manual review found evidence defects in the first implementation/harness and therefore supersedes GitHub Actions run `32016446351` regardless of its eventual conclusion:

- the first structural fingerprint scanner could mistake the SPARQL less-than comparison operator `<` for an IRI reference and collapse materially different `FILTER` shapes;
- the first overhead experiment always ran CONTROL before ATTRIBUTED, allowing second-arm host/page-cache drift to hide or mimic instrumentation cost;
- the first summarizer reconciled Phase 11 counts only internally and did not prove that every independently observed Phase 8 `triplestore.query` was captured;
- the first overhead gate used means and rejected only positive slowdown, so an implausible profiler-side speedup could pass as if it were harmless.

The replacement gate fixes those defects and must be rerun at one exact final SHA before any optimization target is chosen.

## First-slice objective

Attribute each `triplestore.query` in the real local-delivery lineage to the owning SemApps/ActivityPods call site and a privacy-safe normalized query shape, then measure which repeated reads dominate count and cumulative time.

The attribution evidence must distinguish at least:

- ActivityPub collection/inbox/activity work;
- LDP persistence reads;
- WebACL authorization/metadata reads;
- actor or collection resolution;
- any other SemApps path actually observed in the measured root.

Do not infer categories from query text alone when the calling action lineage can provide stronger attribution.

## Instrumentation requirements

Instrumentation must be observational and bounded.

- Correlate only queries that belong to the measured local-delivery root/async lineage.
- Attribute the immediate logical caller through Moleculer context IDs/parent IDs; fail the evidence if a measured query remains unattributed.
- Record a stable call-site/category and a normalized query-shape fingerprint.
- Do not emit full SPARQL bodies, RDF payloads, arbitrary URIs, user content, credentials, access tokens, or WebACL-controlled resource data into CI artifacts.
- Normalize volatile values before fingerprinting so equivalent query templates aggregate together.
- Preserve operators and other material query structure while removing IRIs, literals, blank-node labels and scalar values before hashing.
- Record invocation count and duration per category/fingerprint.
- Bound fingerprint cardinality; any overflow or dropped call invalidates the evidence rather than silently truncating it.
- Keep overhead small enough that it does not materially change ordering, concurrency, action counts or Fuseki traffic.
- Measurement reporting failures must never alter the underlying delivery result/error.

## Measurement contract

The attribution run uses the same canonical local-fanout workload and concurrency baseline used for Phase 10:

- N=1, 10, 100, 200, 1000;
- at least 3 measured samples per N plus warmup roots;
- `APDM_LOCAL_DELIVERY_CONCURRENCY=4`;
- Phase 10 memo explicitly ON to establish the post-Phase-10 baseline;
- fresh benchmark state with explicit bind-mounted Fuseki/Redis deletion and recreation for every arm;
- one backend image built once and reused byte-for-byte inside each paired attempt;
- exact source/runtime/image provenance captured;
- zero failed measured samples;
- delivery success/failure ordering unchanged.

For every measured request, the Phase 11 record must reconcile exactly with the independently observed Phase 8 `actionCounts['triplestore.query']`. `unattributedQueryCalls` must be zero. Warmups are excluded by joining Phase 11 records only to the exact measured Phase 8 request IDs.

For each canonical N, emit:

- total `triplestore.query` count;
- count by immediate logical caller;
- count by normalized query-shape fingerprint;
- cumulative and per-sample median duration by caller/fingerprint;
- total nested action count and total Fuseki HTTP traffic for context;
- delivery failures and correctness invariants.

## Arm-order and profiler-overhead gate

One fixed arm order is not sufficient for Phase 11 overhead acceptance. The workflow alternates order using the run-attempt number while retaining the same source SHA:

- odd attempt: CONTROL then ATTRIBUTED;
- even attempt: ATTRIBUTED then CONTROL.

Authoritative overhead acceptance requires one successful attempt in each order at the same exact source head. Both attempts must preserve action and Fuseki mechanism counts. At N=1000, elapsed and CPU comparisons use p50 and reject excessive drift in **either** direction: a large apparent speedup is treated as contamination just like a slowdown because observational instrumentation cannot legitimately make the underlying delivery path materially faster.

Current per-attempt bounds are:

- absolute N=1000 elapsed p50 drift <= 10%;
- absolute N=1000 CPU p50 drift <= 15%;
- no material N=1000 nested-action-count or Fuseki-request-count change.

Heap remains contextual/noisy and is reported rather than used as a generalized improvement claim.

## Privacy and evidence integrity

The emitted Phase 11 artifact has an exact allowlisted schema. Query entries contain only:

- safe Moleculer caller identifier;
- allowlisted operation class;
- SHA-256 structural shape hash;
- count/error count;
- cumulative and maximum measured duration.

The artifact does not have fields for dataset, WebID, query text, arbitrary URI or literal values. The raw serialized artifact is additionally rejected if URL/IRI material appears. Request IDs are benchmark-generated opaque IDs and case labels must match the canonical `real-local-N` form.

## Authority and correctness gates

No Phase 11 optimization may be proposed from this attribution evidence unless its authority boundary is explicit.

A candidate repeated read must be classified as one of:

1. safe bounded reuse within one already-authoritative delivery scope;
2. selective-query reduction where the same authoritative data is read more narrowly;
3. same-authority batching where all affected data belongs to one valid dataset/authority boundary;
4. correctness-critical work that must remain per recipient/per dataset and is not safely batchable.

Cross-Pod batching is not assumed safe. Per-Pod dataset isolation, WebACL/LDP semantics, ActivityPub collection/activity side effects, signing/key custody, partial-failure behavior, and deterministic rollback remain non-negotiable.

## Rejection rules

Reject a proposed Phase 11 change if it:

- weakens or bypasses WebACL/LDP/Pod authority;
- treats a derived cache/projection as authority without validation;
- combines distinct Pod datasets merely to reduce query count;
- moves equivalent work into Fuseki, Redis, the federation sidecar, or another process without reducing whole-system work;
- improves average latency while materially worsening tail latency, failures, memory pressure, or recovery behavior;
- depends on full-population materialization or unbounded concurrency;
- cannot be rolled back independently.

## Exit from attribution slice

The attribution slice is complete only when:

1. backend CI passes at the exact final attribution head;
2. one CONTROL-first and one ATTRIBUTED-first evidence attempt pass at that same head;
3. provenance, storage isolation, privacy schema, query-count reconciliation, zero-unattributed, zero-overflow and delivery correctness gates all pass;
4. the dominant N=1000 caller/shape rankings are stable enough across opposite arm orders to support a target decision;
5. the owning SemApps/ActivityPods source is inspected and the candidate is assigned an explicit authority classification;
6. a final adversarial review finds no unresolved correctness/security/evidence defect.

Only then should Phase 11 move from measurement to implementation.