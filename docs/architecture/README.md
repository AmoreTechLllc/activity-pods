# ActivityPods Architecture Records

## Provider-wide scalability

- [`scalability.md`](./scalability.md) — provider-wide scalability problem statement and architecture: local Pod fan-out, remote federation, provider/account scans, follower collections, reconciliation, identity/ATProto indexes, Fuseki/TDB2, startup migrations, batching, bounded concurrency, queue/response limits, evidence rules, and remaining bottlenecks.

This is the umbrella scalability document. APDM is one major workstream inside it rather than the complete scalability program.

## ActivityPub Delivery Migration (APDM)

- [`activitypub-delivery-migration.md`](./activitypub-delivery-migration.md) — current ActivityPods APDM phase ledger, evidence summary, current post-Phase-9 authority model, and the open Phase 10 gate.
- [`activitypub-delivery-remote-authority.md`](./activitypub-delivery-remote-authority.md) — detailed Phase 2/5 ActivityPods remote-authority operational contract: exact SemApps version guard, preview/production authorization, durable handoff configuration, request-local `remotePost` suppression, rollback, and verified exit criteria.
- [`APDM-P1-HARDENING.md`](./APDM-P1-HARDENING.md) — Delivery Plan v1 producer-contract hardening.
- [`APDM-P6-RAW-ROUTING-RETIREMENT.md`](./APDM-P6-RAW-ROUTING-RETIREMENT.md) — Phase 6 duplicate raw-routing retirement details.

The authoritative cross-repository APDM roadmap/status lives in `outlaw-dame/mastopod-federation-architecture/docs/activitypub-delivery-migration/`.

A checked APDM phase means its exit gate is closed; supporting scalability/security work or an implementation PR alone is not sufficient to mark a phase complete.
