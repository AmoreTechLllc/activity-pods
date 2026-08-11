# APDM Phase 3 — post-merge hardening

This follow-up audits the authoritative ActivityPub Delivery Plan producer after Phase 4 completion and tightens invariants without changing remote-authority ownership.

## Producer hardening

- deterministic Delivery Plan IDs are validated, not merely generated;
- embedded Activity ID/actor must match the plan envelope;
- visibility is derived from normalized `to`/`cc` addressing, including object-valued JSON-LD references;
- public metadata must agree with visibility;
- local and remote recipient identities are unique and mutually exclusive;
- remote delivery URLs reject non-HTTP(S) schemes and embedded credentials;
- `targetDomain` is derived from and validated against the effective shared inbox/inbox hostname;
- local and remote resolution share one global concurrency budget;
- shared contract fixtures now use real deterministic intent IDs rather than placeholders.

## Scope

This hardening does not change the Phase 4 durability ownership or enable Phase 5 cutover. Native SemApps remains the production rollback mode until the explicit Phase 5 authority transition.
