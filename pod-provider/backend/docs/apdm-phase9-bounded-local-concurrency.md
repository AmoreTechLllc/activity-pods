# APDM Phase 9 — bounded local delivery concurrency

Phase 9 changes only the scheduling of the existing SemApps local-recipient delivery primitive. It does not change Pod dataset authority, inbox resolution, WebACL/LDP semantics, Activity attachment, ActivityPub events, remote delivery, or APDM external-delivery authority.

## Runtime contract

`APDM_LOCAL_DELIVERY_CONCURRENCY` controls the maximum number of local recipients processed concurrently by the pinned `@semapps/activitypub@1.1.4` `localPost()` implementation.

- normal unset/default value: `4`;
- explicit `1` preserves serial delivery;
- accepted configured values: positive base-10 integers;
- hard maximum: `32`;
- malformed, zero, negative, whitespace-padded, or unsafe integer values fail safe to serial `1` rather than inheriting the parallel default.

The distinction between **unset** and **invalid** is intentional. An ordinary deployment gets the empirically selected c4 scheduling default, while a configuration typo cannot silently opt that deployment into concurrent local delivery.

## Phase 9 empirical closure

Canonical real local-fanout evidence came from GitHub Actions run `31956939507` on ActivityPods head `8fc3735a2f1f3d000ccfe169babf270a24d82bd8`. Each concurrency candidate (`1`, `2`, `4`, `8`) ran in an isolated runner with a fresh Fuseki/Redis/backend stack and separately provisioned 1,000-recipient Pod fixture. Every canonical case (`N=1,10,100,200,1000`) contained three successful measured samples and zero failed samples.

The original comparison job failed only in artifact handling after all measurements had completed. PR #66 repaired that path and hardened evidence replay. Replay run `31964215322` rebuilt summaries directly from the immutable raw JSONL artifacts and passed. Exact-head Backend Checks `31964218099` also passed. PR #66 merged as `154b40873fec0886c4e2a25e67d6e644fe69ec4c`.

The hardened selection gate requires, for every large case (`N=100,200,1000`):

- at least `1.10x` wall-clock speedup versus c1;
- absolute nested-action drift no greater than `5%`;
- absolute Fuseki-request drift no greater than `5%`;
- no CPU increase greater than `10%`;
- matched sample cardinality with at least three successful samples and no failures.

It chooses the **smallest** candidate satisfying every large-case gate. Heap remains a manual review signal because signed heap deltas are strongly influenced by GC timing.

### Measured large-fanout comparison

| concurrency | N=100 mean | speedup | N=200 mean | speedup | N=1000 mean | speedup | selection |
|---:|---:|---:|---:|---:|---:|---:|:---|
| 1 | 21.49 s | 1.00x | 44.01 s | 1.00x | 297.07 s | 1.00x | baseline |
| 2 | 20.88 s | 1.03x | 41.20 s | 1.07x | 264.44 s | 1.12x | rejected |
| 4 | 18.10 s | 1.19x | 36.40 s | 1.21x | 221.24 s | 1.34x | **selected** |
| 8 | 19.96 s | 1.08x | 41.79 s | 1.05x | 242.32 s | 1.23x | rejected |

For c4 versus c1:

- CPU delta was approximately `-15.8%`, `-16.8%`, and `-25.1%` at N=100/200/1000;
- nested-action drift was approximately `-2.15%`, `-1.29%`, and `-0.19%`;
- Fuseki-request drift was approximately `-2.18%`, `-1.24%`, and `-0.19%`.

The near-invariant underlying work counts are important: c4 improved scheduling/wall-clock behavior without evidence that it skipped recipient persistence work. Phase 9 therefore does **not** claim to solve the still-linear LDP/WebACL/Fuseki amplification measured in Phase 8; that remains the subject of the later metadata/persistence phases.

Candidate c2 failed the sustained-speedup floor at N=100 and N=200. Candidate c8 also failed at N=100 and N=200 and was slower than c4 across all three large cases. The selected default is therefore c4 rather than the highest tested concurrency.

## Semantics preserved

The Phase 9 patch is layered after the reviewed Phase 7 and Phase 8 SemApps patches and refuses to apply without their markers. It retains:

- one `activitypub.side-effects.processInbox` call before recipient persistence;
- the Phase 7 request-local pre-resolved dataset context and legacy account-lookup fallback;
- the same recipient-specific inbox lookup, collection add, `ldp.remote.store`, and `activitypub.activity.attach` calls;
- per-recipient error isolation;
- one final `activitypub.inbox.received` event after all local-recipient work settles;
- the Phase 8 start/finish and result observers;
- `{ success, failures }` as the localPost result contract.

Workers are bounded by `min(configuredConcurrency, recipients.length)`. The implementation uses `Promise.all()` only for that bounded worker set, never once per recipient.

## Deterministic partial failures

Concurrent physical completion order is intentionally not exposed through the result. Each recipient retains its original input index. Successful and failed recipient lists are reconstructed in original recipient order after all workers finish.

This preserves deterministic tests and avoids making scheduler timing part of the observable result contract.

## Rollback and operational override

No code rollback is needed to return a deployment to serial local delivery. Set:

```text
APDM_LOCAL_DELIVERY_CONCURRENCY=1
```

Malformed values also fail safe to `1`, but operators should use an explicit valid `1` when intentionally disabling concurrency.

The hard ceiling remains `32`; higher configured integers clamp to `32`. A future default increase requires a new evidence gate rather than changing this constant opportunistically.

## Phase boundary

Phase 9 is complete once the c4 default promotion passes exact-head CI and is merged. Phase 10 may then measure its dataset-existence memo with both OFF and ON arms at this same selected concurrency. Phase 10 remains fail-closed until its own real evidence gate passes. Phase 11 must not begin before that gate closes.
