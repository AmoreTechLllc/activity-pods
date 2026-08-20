# APDM Phase 11 — triplestore query attribution

## Status

**Phase 11: IN PROGRESS — attribution only. No persistence optimization is approved yet.**

Phase 10 is closed. The authoritative paired run is GitHub Actions `31989314315` at exact source head `473cf27b7af20c658d6241cc251b7c822c2172cc`. Runs `31980969664` and `31988013688` are superseded and are not promotion evidence.

The Phase 10 production-default decision is closed as NO-GO: the dataset-existence memo remains disabled unless `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED=true` is set exactly. Phase 11 must not silently change that default.

## Measured reason for Phase 11

On the post-Phase-10 ON arm at N=1000, the residual nested work is dominated by `triplestore.query`; the Phase 10 summary reported approximately `15,999` invocations across its measured samples and roughly `7.1 s` cumulative median action duration. `triplestore.dataset.exist` is no longer the dominant mechanism.

That aggregate count is not sufficient to justify batching or caching. The first Phase 11 slice is therefore **query attribution before optimization**.

## Review status and superseded evidence

A fresh Codex review was requested for the first implementation head `ff8005ab290f25a3dc483c783b8f8c19acddf081`, but the Codex code-review quota was exhausted. No Codex review was therefore treated as an approval. A manual adversarial review at the same standard is required before evidence can be accepted.

That manual review found evidence defects in the first implementation/harness and therefore supersedes GitHub Actions run `32016446351` regardless of its eventual conclusion:

- the first structural fingerprint scanner could mistake the SPARQL less-than comparison operator `<` for an IRI reference and collapse materially different `FILTER` shapes;
- the first overhead experiment always ran CONTROL before ATTRIBUTED, allowing second-arm host/page-cache drift to hide or mimic instrumentation cost;
- the first summarizer reconciled Phase 11 counts only internally and did not prove that every independently observed Phase 8 `triplestore.query` was captured;
- the first overhead gate used means and rejected only positive slowdown, so an implausible profiler-side speedup could pass as if it were harmless.

### Strict completeness attempt `32020071844`

The first run after those review fixes, GitHub Actions `32020071844` at head `59211322d756f48fcb62cd63fcd567246dc228c8`, **failed the completeness gate and is superseded**. The failure was substantive and the gate was not weakened.

At N=1000, each measured sample contained approximately 6,060 `triplestore.query` calls. Two repeatable attribution gaps remained:

- roughly 2,029 calls per sample were owned by `triplestore.tripleExist` but had operation `unknown` because SemApps passes a SPARQL.js-style object AST rather than a string query;
- 1,001 `CONSTRUCT` calls per sample had caller `unknown`, showing that parent context IDs were being discarded too early for detached/settled-parent lineage.

The exact SemApps 1.1.4 release commit is `b8e1061c9d94cbaa42ef5c5bca87f38f0da9fb1` (`middleware-v1.1.4`). Its `triplestore/actions/tripleExist.js` confirms that `triplestore.tripleExist` calls `triplestore.query` with an object AST containing `type: 'query'` and `queryType: 'ASK'`. Its `triplestore/actions/query.js` explicitly accepts string or object input and only converts object ASTs to SPARQL inside the query handler. Therefore the unknown operation was an attribution-harness defect, not an ambiguous application query.

The replacement instrumentation now:

- accepts the SemApps object-query contract and derives the operation from the allowlisted `queryType`;
- fingerprints object ASTs only after recursively replacing RDF/string/scalar values and unapproved field names while retaining approved structural keys, query enums and RDF term types;
- retains Moleculer context-ID to action-name lineage for the bounded lifetime of one measured root rather than deleting parent IDs when their promises settle;
- caps retained lineage at exactly 65,536 contexts per measured root and marks any overflow/dropped context as evidence-invalid;
- continues to cap attribution keys at 4,096 and fail on overflow/dropped query calls.

The failed attempt also showed that `ldp.resource.getContainers` was already the largest known N=1000 cumulative query-duration bucket by a wide margin, but no optimization is authorized from that provisional ranking until the callerless `CONSTRUCT` work is correctly attributed and opposite-order evidence closes.

## Pre-merge Phase 8 and Phase 9 hardening

Before PR #78 may merge, the Phase 8 measurement authority and Phase 9 bounded-concurrency layer are themselves subject to a fresh Codex-level adversarial review. The hosted Codex review quota remains exhausted, so the absence of a bot review is not approval; the review is being performed manually against the exact branch implementation and tests.

This review found and fixed concrete hardening gaps. **Every Phase 11 evidence run from before this hardening record is superseded**, including the previous replacement candidate and any run that was still executing when these changes landed. Phase 11 attribution must be remeasured from the final post-hardening head.

### Phase 8 hardening

Phase 8 remains observational only, but its evidence boundary is now stricter:

- pre-existing local-delivery completion/result observers are chained rather than overwritten, and their exceptions cannot replace the real delivery result;
- observer installation is restored on disposal when ownership still matches;
- partial local-delivery artifacts retain only failure counts, never success/failure recipient identifiers;
- arbitrary exception messages are not serialized into JSON evidence; only controlled source/action metadata and a sanitized error class name are retained;
- duplicate Fuseki HTTP-probe ownership fails closed rather than silently producing partial HTTP evidence;
- HTTP response/request terminal accounting is one-shot across `end`, `aborted`, response `error` and request `error` paths;
- dynamic Fuseki dataset identifiers are removed from request-path evidence while mechanism shape is preserved, e.g. `/$/datasets/<dataset>` becomes `/$/datasets/:dataset` and dataset query routes become `/:dataset/query`;
- an unmatched local-delivery `finish` or unknown observer phase invalidates the sample instead of being silently ignored;
- the Phase 8 summarizer now requires at least three **valid successful** samples for every canonical N=1/10/100/200/1000 before `complete=true`;
- a successful record must contain an explicit empty `errors` array plus finite/nonnegative core elapsed/CPU/action/Fuseki metrics; missing or malformed schema can no longer count as success;
- failed or malformed samples remain reported but cannot influence the fitted action/Fuseki models.

The route redaction deliberately preserves the Phase 10 mechanism distinction between `GET` dataset-registry existence probes and lifecycle writes. Phase 10's comparator is covered against the redacted `GET /$/datasets/:dataset` representation.

### Phase 9 hardening

The promoted Phase 9 scheduling semantics remain unchanged: default concurrency 4, fail-safe serial fallback 1 for invalid explicit values, cap 32, bounded workers, per-recipient error isolation and deterministic recipient-order result arrays.

Hardening now makes those semantics fail closed against patch drift:

- the pinned SemApps predecessor/Phase 8/Phase 9 markers must occur exactly once;
- an already-promoted artifact must contain the exact reviewed c4 concurrency configuration block;
- it must contain the exact bounded worker block and indexed success/failure aggregation shape;
- legacy unordered `push` aggregation is rejected;
- marker-preserving changes to default, fallback, cap, worker count or result ordering are rejected rather than trusted as “already patched”.

The Phase 9 evidence comparator also now rejects non-finite derived decision metrics explicitly. A zero/corrupt denominator can no longer turn `speedup`, CPU drift, nested-action drift or Fuseki drift into `undefined` and accidentally bypass JavaScript threshold comparisons. The historical Phase 9 policy still uses its original mean-based selection metrics; this hardening does not silently redefine the already-closed Phase 9 statistical policy. Any change from means to a different estimator would be an explicit Phase 9 evidence-policy reopening, not a maintenance hardening.

### Cross-phase invariants reviewed

The pre-merge review continues to require all of the following:

- Phase 9 bounded concurrency executes inside the same Phase 8 local-delivery observation lineage;
- the local-post completion observer does not finish until the bounded worker pool has settled;
- Phase 7 dataset context reuse and Phase 10 delivery-scope seams remain present and exact;
- Phase 9 does not batch across Pod datasets or weaken per-recipient authority checks;
- Phase 11 can still observe concurrent child-action lineage without changing Phase 9 scheduling;
- Phase 8 route redaction changes only artifact representation, not actual Fuseki requests;
- measurement instrumentation failures remain unable to alter production delivery semantics;
- Phase 10 memo production default remains OFF.

The first hardening CI pass intentionally failed two stale tests that still expected raw dataset names and one-sample Phase 8 completion; 104 of 106 suites passed. Those tests were corrected to assert the hardened privacy/sample-floor contract rather than weakening the implementation. A fresh exact-head backend run is required after this record.

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
- Retain context lineage only for one measured root; never use a cross-request/global caller map.
- Cap retained context lineage and make overflow evidence-invalid rather than silently evicting parents.
- Record a stable call-site/category and a normalized query-shape fingerprint.
- Accept SemApps string and object-query contracts, but retain only allowlisted AST structure/enums/term types from object queries.
- Do not emit full SPARQL bodies, RDF payloads, arbitrary URIs, user content, credentials, access tokens, WebIDs, datasets, graph names, RDF term values or WebACL-controlled resource data into CI artifacts.
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
- `APDM_P11_MAX_KEYS=4096`;
- `APDM_P11_MAX_CONTEXTS=65536`;
- fresh benchmark state with explicit bind-mounted Fuseki/Redis deletion and recreation for every arm;
- one backend image built once and reused byte-for-byte inside each paired attempt;
- exact source/runtime/image/profiler-bound provenance captured;
- zero failed measured samples;
- delivery success/failure ordering unchanged.

For every measured request, the Phase 11 record must reconcile exactly with the independently observed Phase 8 `actionCounts['triplestore.query']`. `unattributedQueryCalls` must be zero. Fingerprint overflow, lineage overflow, dropped calls and dropped lineage contexts must all be zero. Warmups are excluded by joining Phase 11 records only to the exact measured Phase 8 request IDs.

For each canonical N, emit:

- total `triplestore.query` count;
- count by immediate logical caller;
- count by normalized query-shape fingerprint;
- cumulative and per-sample median duration by caller/fingerprint;
- retained lineage-context cardinality;
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

Root records additionally expose only numeric lineage-cardinality/overflow metadata. Context IDs themselves are never serialized.

The artifact does not have fields for dataset, WebID, query text, AST contents, arbitrary URI or literal values. The raw serialized artifact is additionally rejected if URL/IRI material appears. Request IDs are benchmark-generated opaque IDs and case labels must match the canonical `real-local-N` form.

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
