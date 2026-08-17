# APDM Phase 11 — triplestore query attribution

## Status

**Phase 11: IN PROGRESS — attribution only. No persistence optimization is approved yet.**

Phase 10 is closed. The authoritative paired run is GitHub Actions `31989314315` at exact source head `473cf27b7af20c658d6241cc251b7c822c2172cc`. Runs `31980969664` and `31988013688` are superseded and are not promotion evidence.

The Phase 10 production-default decision is closed as NO-GO: the dataset-existence memo remains disabled unless `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED=true` is set exactly. Phase 11 must not silently change that default.

## Measured reason for Phase 11

On the post-Phase-10 ON arm at N=1000, the residual nested work is dominated by approximately `15,999` `triplestore.query` invocations, with roughly `7.1 s` cumulative median action duration. `triplestore.dataset.exist` is no longer the dominant mechanism.

That aggregate count is not sufficient to justify batching or caching. The first Phase 11 slice is therefore **query attribution before optimization**.

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
- Record a stable call-site/category and a normalized query-shape fingerprint.
- Do not emit full SPARQL bodies, RDF payloads, arbitrary URIs, user content, credentials, access tokens, or WebACL-controlled resource data into CI artifacts.
- Normalize volatile values before fingerprinting so equivalent query templates aggregate together.
- Preserve enough structure to distinguish materially different query forms without leaking payload data.
- Record invocation count and duration per category/fingerprint.
- Keep overhead small enough that it does not materially change the measured ordering or concurrency behavior; if overhead is non-trivial, report it and measure with attribution disabled for any performance decision.
- Fail closed if correlation metadata is missing rather than attributing an unrelated provider query to the local-delivery root.

## Measurement contract

The first attribution run should use the same canonical local-fanout workload and concurrency baseline used for Phase 10:

- N=1, 10, 100, 200, 1000;
- `APDM_LOCAL_DELIVERY_CONCURRENCY=4`;
- Phase 10 memo explicitly ON to establish the post-Phase-10 baseline;
- fresh benchmark state with the existing bind-mounted Fuseki/Redis isolation protections;
- exact source/runtime provenance captured;
- zero failed measured samples;
- delivery success/failure ordering unchanged.

For each canonical N, emit:

- total `triplestore.query` count;
- count by call-site/category;
- count by normalized query-shape fingerprint;
- cumulative and distributional action duration by category/fingerprint;
- total nested action count and total Fuseki HTTP traffic for context;
- delivery failures and correctness invariants.

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

The attribution slice is complete only when evidence identifies the dominant repeated query shapes and their owning call sites with enough confidence to choose the smallest safe optimization target.

Only then should Phase 11 move from measurement to implementation.