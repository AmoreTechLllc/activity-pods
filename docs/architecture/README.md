# ActivityPods Architecture Records

## Provider-wide scalability and resource efficiency

- [`scalability.md`](./scalability.md) — provider-wide scalability problem statement and architecture: local Pod fan-out, remote federation, provider/account scans, follower collections, reconciliation, identity/ATProto indexes, Fuseki/TDB2, startup migrations, batching, bounded concurrency, queue/response limits, evidence rules, and remaining bottlenecks.
- [`local-fanout-worked-example.md`](./local-fanout-worked-example.md) — concrete one-post/200-local-followers trace showing the historical recipient-oriented `2 + 6N` orchestration model, the current post-P7/P9 shape, and the measured nested Moleculer/Fuseki amplification that drives P10-P12.
- [`resource-efficiency.md`](./resource-efficiency.md) — cross-cutting performance/resource objective: reduce CPU, memory, datastore I/O, network traffic, queue churn, background work, and deployment footprint per useful outcome without sacrificing latency, throughput, correctness, durability, interoperability, or ActivityPods/SemApps compatibility.

`scalability.md` asks whether the system remains healthy as load and data grow. `resource-efficiency.md` asks whether the same correct useful work can be done with less compute and infrastructure. Both are required. APDM is one major workstream inside this broader program rather than the complete scalability/performance effort.

## ActivityPub Delivery Migration (APDM)

- [`activitypub-delivery-migration.md`](./activitypub-delivery-migration.md) — current ActivityPods APDM phase ledger, evidence summary, current post-Phase-9 authority model, and the open Phase 10 gate.
- [`activitypub-delivery-remote-authority.md`](./activitypub-delivery-remote-authority.md) — detailed Phase 2/5 ActivityPods remote-authority operational contract: exact SemApps version guard, preview/production authorization, durable handoff configuration, request-local `remotePost` suppression, rollback, and verified exit criteria.
- [`APDM-P1-HARDENING.md`](./APDM-P1-HARDENING.md) — Delivery Plan v1 producer-contract hardening.
- [`APDM-P6-RAW-ROUTING-RETIREMENT.md`](./APDM-P6-RAW-ROUTING-RETIREMENT.md) — Phase 6 duplicate raw-routing retirement details.

The authoritative cross-repository APDM roadmap/status lives in `outlaw-dame/mastopod-federation-architecture/docs/activitypub-delivery-migration/`.

A checked APDM phase means its exit gate is closed; supporting scalability/security work or an implementation PR alone is not sufficient to mark a phase complete.
