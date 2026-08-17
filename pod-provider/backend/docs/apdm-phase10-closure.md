# APDM Phase 10 closure and Phase 11 scope

## Status

**Phase 10: PASS — implementation accepted; production-default promotion declined.**

The authoritative paired evidence is GitHub Actions run `31989314315` at exact source head `473cf27b7af20c658d6241cc251b7c822c2172cc`. Runs `31980969664` and `31988013688` are superseded and are not production-promotion evidence.

PR #67 was adversarially reviewed at that exact head and merged. The local-delivery dataset-existence memo remains fail-closed: `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED` is disabled unless set exactly to `true`.

## Evidence decision

The paired OFF/ON run used one runner, one backend image, concurrency 4, canonical N=1/10/100/200/1000 workloads, and fresh independently provisioned bind-mounted Fuseki and Redis state for each arm. The prior host-bind contamination failure did not recur. Provenance, environment comparability, delivery correctness, canonical sample counts, and failure checks passed.

At N=1000, median OFF -> ON results were:

- elapsed: 60,904.6 ms -> 32,777.0 ms (~46.2% lower);
- CPU user+system: 51,516.8 ms -> 26,236.9 ms (~49.1% lower);
- total Fuseki requests: 50,472 -> 4,364 (~91.35% lower);
- total nested action count: 53,842 -> 31,370 (~41.7% lower);
- attempted `triplestore.dataset.exist`: 10,001 -> 2;
- measured failures: 0 -> 0.

Heap is not promoted as a general improvement because it is noisy across recipient counts.

The mechanism therefore passes: the redundant dataset-existence amplification is materially removed without changing delivery outcomes. However, the fixed arm order was OFF then ON, and the ON N=1 elapsed samples included severe outliers (about 7.18 s and 17.44 s versus OFF samples around 1.24-1.55 s). That prevents a defensible claim that enabling the memo by default improves or at least preserves small-workload/tail behavior independently of second-arm host drift.

## Production-default and rollback decision

Production default: **NO-GO** for this closure. No promotion PR is warranted from the authoritative evidence.

Rollback/default behavior is explicit and already safe: leave `APDM_LOCAL_DELIVERY_DATASET_EXIST_MEMO_ENABLED` unset or set it to anything other than exact `true`. The middleware and SemApps local-delivery seam then remain behaviorally inert. A future default-on proposal requires new evidence that specifically addresses arm-order/tail sensitivity while retaining all Phase 10 correctness and provenance gates.

This NO-GO is a closed production decision, not a Phase 10 failure: Phase 10 established and merged a safe opt-in optimization, proved its large-fanout mechanism and resource effect, and deliberately declined default promotion where the evidence was insufficient.

## Phase 11 measured scope

Phase 11 begins from the post-Phase-10 ON arm, not from the pre-optimization profile. At N=1000 the residual nested work is dominated by `triplestore.query` (~15,999 invocations; roughly 7.1 s cumulative median action duration), followed by per-recipient dataset creation, insert, and update work. `triplestore.dataset.exist` is no longer material.

The first Phase 11 task is therefore **query attribution before batching**:

1. map the repeated `triplestore.query` calls in the real local-delivery lineage to SemApps/LDP/WebACL/ActivityPub call sites and query shapes;
2. distinguish authority/correctness-critical reads from redundant repeated reads;
3. measure per-call-site/query-shape counts and cumulative duration at the canonical workload and concurrency 4;
4. only then evaluate bounded reuse, selective-query reduction, or batch-safe persistence, preserving Pod/dataset, LDP, WebACL, ActivityPub, signing, partial-failure, and rollback semantics;
5. reject any change that merely moves datastore work, weakens authority checks, or improves averages while materially worsening tail latency.

No Phase 11 persistence batching should be implemented before that attribution evidence identifies which repeated queries can be removed safely.
