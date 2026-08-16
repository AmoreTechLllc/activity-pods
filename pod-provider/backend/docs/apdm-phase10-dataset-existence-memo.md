# APDM Phase 10 — delivery-scoped dataset existence memo

Phase 8 measured a large metadata-check amplification in the real local ActivityPub fan-out path. At 1,000 local recipients, each canonical sample executed about 16,167 `triplestore.dataset.exist` actions. Across the 1/10/100/200/1000 matrix, the fitted slope is approximately 16 dataset-existence checks per additional recipient.

The recipient dataset is already known before local persistence starts. SemApps nevertheless re-validates the same dataset from nested query, insert, update, LDP, WebACL, and ActivityPub operations. Phase 10 removes only that redundant positive metadata round trip; it does not bypass the first authoritative existence check or any persistence/ACL operation.

## Runtime contract

`APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED` controls this optimization.

- default before the Phase 10 evidence gate closes: **disabled**;
- set exactly `true` to opt in for the Phase 10 enabled measurement arm;
- the production default must not be promoted by merely merging the implementation; a later evidence-backed closure commit is responsible for any default change;
- scope: exactly one patched SemApps `localPost()` invocation and its async descendants;
- the surrounding `activitypub.outbox.post` action is **not** memo-scoped, so unrelated events/jobs/detached work spawned by an outbox post cannot inherit the memo;
- nested or later `localPost()` invocations receive fresh scopes;
- no values are shared between separate local deliveries, requests, users, or processes.

The pinned SemApps outbox patch contains an optional Phase 10 scope-runner seam immediately around `this.localPost(localRecipients, activity)`. If no runner is installed, it executes the reviewed legacy `localPost()` fallback unchanged. This keeps the Phase 10 experiment behaviorally inert when disabled.

## Safety properties

For each concrete dataset reached during a scoped local delivery:

1. the first `triplestore.dataset.exist` call still executes the pinned SemApps action and therefore still reaches the configured triplestore;
2. only a strict `true` result is memoized;
3. `false` results are not memoized;
4. thrown errors are not memoized or transformed;
5. wildcard/unspecified dataset checks bypass the memo;
6. dataset-management actions invalidate the scoped entry before and after they run;
7. a mutation epoch prevents an older in-flight existence request from restoring a stale positive after a concurrent dataset mutation in the same local-delivery lineage;
8. unrelated outbox descendants and direct calls outside the `localPost()` runner see no memo state;
9. later and nested local deliveries must verify each dataset again in their own scopes.

The middleware deliberately treats future/unknown `triplestore.dataset.*` actions conservatively: everything except `exist` and `list` invalidates the scoped positive memo. This may sacrifice a small amount of reuse for non-mutating dataset administration calls, but it fails toward re-verification if SemApps adds new dataset lifecycle operations later.

The memo is not a cross-process transaction or dataset lock. A dataset can still be changed or deleted by unrelated work after an authoritative positive check. In that case the downstream LDP/WebACL/triplestore operation must still fail normally rather than redirecting work or creating a different dataset. The optimization therefore never turns a stale positive into cross-dataset authority; its acceptable failure mode is a recipient-local delivery failure that remains visible to the existing partial-failure path. The real measurement and hardening gate must retain that failure isolation.

A compatibility sentinel also pins `@semapps/triplestore` to the reviewed 1.1.4 `dataset.exist` contract: the installed action must remain an observational Fuseki `GET /$/datasets/{dataset}` returning the strict boolean `response.status === 200`. A SemApps upgrade or semantic change must therefore trigger a fresh review before Phase 10 can be enabled.

The middleware does not alter collection membership, `ldp.remote.store`, Activity attachment, WebACL rights, Pod dataset selection, ActivityPub events, partial-failure isolation, or remote federation authority.

## Why this is Phase 10 rather than Phase 11

This is metadata/authority-check reuse. It does not combine writes across Pods and does not replace SemApps persistence actions with direct SPARQL. Each recipient still executes its own collection, LDP, WebACL, and Activity persistence semantics.

Phase 11 remains the separate batch-safe persistence investigation after Phase 10 evidence establishes what work is still dominant.

## Measurement gate

After Phase 9 chooses a bounded local-delivery concurrency, rerun the same canonical real local-fanout matrix with this middleware disabled and enabled at that exact concurrency. Both sides must use the same fixture construction, recipient counts, warmups, sample count, backend recreation policy, instrumentation, exact code commit, and resolved container images.

The Phase 8 instrumentation counts Moleculer action invocations before downstream middleware completes. A memo hit can therefore still appear as an attempted `triplestore.dataset.exist` action even though the underlying SemApps handler and Fuseki request never execute. For Phase 10, action counts are diagnostic only.

The HTTP probe records correlated method-plus-path counts in addition to aggregate path, method, and status counts. Method extraction covers Node request overloads instead of assuming the first object argument is the options object. The hard metadata signal is therefore the exact real Fuseki request shape `GET /$/datasets/{dataset}`. A lifecycle `DELETE` to the same path cannot be mistaken for an existence probe.

`backend/scripts/apdm-phase10-compare.js` consumes the two Phase 8-format summaries and fails closed when:

- the disabled and enabled arms do not have matched sample counts;
- either arm has fewer than three measured samples at any canonical recipient count;
- any measured sample fails;
- any canonical recipient count is missing;
- at N=100, 200, or 1000, mean real Fuseki `GET /$/datasets/{dataset}` requests do not fall by at least 50%; or
- at N=100, 200, or 1000, mean total Fuseki HTTP requests do not decrease.

The automated result is explicitly a **mechanism/delivery correctness gate**, not production-promotion approval. CPU, heap, elapsed time, total datastore pressure, and any unexpected work-count changes must still be reviewed before the optimization can become the default.

The 50% floor is intentionally conservative relative to the observed ~16 attempted existence checks per recipient. It proves that the intended metadata round-trip amplification was materially removed without requiring an unrealistically exact one-check-per-dataset shape.

Expected invariant if the optimization is working as designed:

- real Fuseki dataset-registry GETs approach one authoritative check per distinct recipient dataset plus bounded sender/setup overhead instead of repeated checks throughout nested persistence operations;
- recipient success/failure results remain identical;
- total Fuseki HTTP request count decreases materially;
- no increase in partial failures, WebACL errors, or cross-dataset leakage.

The comparator also records elapsed time, CPU, heap delta, total nested action count, total Fuseki request count, real dataset-registry GET count, and attempted dataset-existence action count for every canonical case. Reduced action count alone is not sufficient: the Phase 10 decision must review the full resource profile before the optimization is promoted to the default path.
