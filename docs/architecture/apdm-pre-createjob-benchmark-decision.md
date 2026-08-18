# APDM pre-`createJob` planning seam decision

Status: **measured; deeper production hook not promoted**.

This record closes the benchmark question tracked by the pre-`createJob` planning-seam investigation. It does not change ActivityPub delivery authority or production routing.

## What the benchmark isolates

SemApps 1.1.4 has already completed authoritative recipient expansion and local/remote classification before this seam. The benchmark therefore compares only the remaining planning tail:

1. current behavior: construct the `remotePost` semantic call shape per already-classified remote actor, then let ActivityPods capture and validate it before Bull;
2. prototype shape: accept the already-classified `remoteRecipients` vector directly before per-recipient semantic job construction.

Neither arm removes follower expansion, local-account classification, local delivery, blind-recipient handling, inbox/sharedInbox resolution, APDM durable handoff, sidecar fanout, signing, retries, or remote HTTP delivery.

## Repeated v2 evidence

Exact code/evidence head: `c54f27cc28d7cc437282d1ad7b28a62d4c8093e2`.

Workflow run: `32125498842`.

Matched artifacts:

- attempt 1: `sha256:fb55c9c6ba5e2f2fdf083e839218ba16f0e8ed1455b703d84f16f08100afcd37`;
- attempt 2: `sha256:45d7ec0c836b08b509cb834cef7fc38e8838d2e1d8fd1671e9afc0429d1018c8`.

Each attempt used paired samples, alternating arm order, explicit GC where available, 10 warmups and 40 measured iterations for fanout 10/100/1000/5000/10000.

### Stable finding: temporary representation is smaller

Across both runs, the direct recipient vector requires roughly 8x fewer serialized construction bytes than the current captured semantic-call representation:

- N=10: ~8.86x reduction;
- N=100: ~8.58x;
- N=1000: ~8.28x;
- N=5000: ~8.04x;
- N=10000: ~8.01x.

This is a real allocation/GC advantage.

### Unstable finding: latency benefit is small and not reproducible

Attempt 1 p95 wall speedup (current / prototype):

- N=10: 1.020x;
- N=100: 1.144x;
- N=1000: 1.028x;
- N=5000: 1.130x;
- N=10000: 0.999x.

Attempt 2:

- N=10: 1.006x;
- N=100: 1.070x;
- N=1000: 0.946x;
- N=5000: 1.055x;
- N=10000: 1.050x.

At N=1000 the second run is slower, and at N=10000 the first run is effectively flat. Paired median absolute wall-time savings remain sub-millisecond at the high-fanout points and change sign in some runs.

CPU results are likewise mixed rather than a reproduced whole-system improvement.

## Decision

Do **not** add a private SemApps hook or upstream dependency solely to bypass per-recipient `createJob` semantic construction.

The measured benefit is an allocation reduction, not a demonstrated dominant scalability bottleneck. Production already avoids the materially more expensive failure mode that motivated the investigation: APDM intercepts before Bull persistence, so remote fanout does not create one durable Bull write per remote actor. Downstream sharedInbox collapse further reduces actual HTTP fanout where endpoints are shared.

The maintenance and compatibility cost of a deeper SemApps seam is therefore not justified by the current repeated evidence.

## Production architecture retained

Keep the existing request-local pre-Bull interception/capture path. No ActivityPub semantics are weakened and no new private upstream hook is introduced.

## Revisit condition

Re-open this decision only if production profiling shows allocation/GC pressure in this exact post-classification tail as a material contributor under realistic concurrent fanout. At that point, prefer an upstreamable SemApps extension point over a private monkey-patched seam, and require a new matched whole-system evidence set before promotion.
