# APDM Phase 9 — bounded local delivery concurrency

Phase 9 changes only the scheduling of the existing SemApps local-recipient delivery primitive. It does not change Pod dataset authority, inbox resolution, WebACL/LDP semantics, Activity attachment, ActivityPub events, remote delivery, or APDM external-delivery authority.

## Runtime contract

`APDM_LOCAL_DELIVERY_CONCURRENCY` controls the maximum number of local recipients processed concurrently by the pinned `@semapps/activitypub@1.1.4` `localPost()` implementation.

- default: `1` (existing serial behavior)
- accepted values: positive base-10 integers
- hard maximum: `32`
- malformed, zero, negative, or unsafe integer values fail safe to `1`

The initial production default remains serial deliberately. Phase 8 established the measurement harness; a higher default should be selected from measured Fuseki, CPU, heap, latency, and partial-failure behavior rather than guessed in this compatibility slice.

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

## Phase gate

This PR establishes the bounded-concurrency primitive and focused regression coverage. Before changing the default above `1`, rerun the Phase 8 real local-fanout matrix at 1, 10, 100, 200, and 1,000 recipients with representative concurrency values and compare:

- wall-clock latency;
- CPU and heap;
- nested Moleculer calls;
- Fuseki/SPARQL traffic and latency;
- WebACL/LDP work;
- partial-failure determinism and recipient correctness.

A higher production default should be adopted only when it materially improves wall-clock delivery without unacceptable Fuseki/heap pressure or semantic regressions.
