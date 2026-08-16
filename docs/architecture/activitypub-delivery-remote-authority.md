# APDM Remote Authority — ActivityPods Operational Contract

This document preserves the detailed ActivityPods Phase 2/5 delivery-strategy, cutover, and rollback contract. The program-level phase state lives in `docs/architecture/activitypub-delivery-migration.md`; this file is the operational reference for the remote-authority seam.

## Phase 2 implementation — pre-`remotePost` strategy seam

Phase 2 introduced an ActivityPods-owned adapter at `pod-provider/backend/lib/activitypub-service-with-delivery-strategy.js`.

### Why an adapter is required

SemApps 1.1.4 does not expose a configuration flag or public delivery-strategy extension point before `remotePost` job creation. Its top-level ActivityPub service dynamically registers the outbox subservice and mixes the queue implementation directly into it.

ActivityPods therefore recreates only that top-level service-registration layer using the exact SemApps 1.1.4 subservices, while leaving the upstream `OutboxService.actions.post` algorithm itself intact. The ActivityPods adapter replaces only the root `post` action with a strategy wrapper.

This is intentionally narrower than copying or forking the entire SemApps outbox algorithm.

### Exact-version guard

The adapter is pinned to `@semapps/activitypub` 1.1.4. Backend startup/tests fail if a different version is installed.

This protects against a silent SemApps upgrade changing:

- service-registration internals;
- the outbox action;
- queue names or payloads;
- recipient ordering/classification;
- local delivery semantics.

A SemApps upgrade therefore requires explicit review of this adapter rather than silently inheriting an incompatible deep import.

## Delivery modes and Phase 5 authority

`SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE` accepts:

- `native` — default and rollback mode. SemApps remote job creation continues unchanged.
- `external` — suppresses SemApps `remotePost` jobs and uses the hardened Delivery Plan + durable sidecar handoff path, but only after one of the explicit authorization states below succeeds.

There are two distinct external authorization states:

1. **Controlled preview** — valid only when `NODE_ENV` is explicitly `test` or `development` and `SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true`. This is not a production cutover mechanism.
2. **Phase 5 production authority** — requires `SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=true`. This requirement also applies when `NODE_ENV` is unset or has an unknown value such as `staging`; unknown environments fail closed rather than inheriting preview authority.

The preview and production-authority flags are mutually exclusive. A production/production-like cutover uses:

```text
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external
SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=false
SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=true
SEMAPPS_QUEUE_SERVICE_URL=redis://<redis-host>:6379/<queue-db>
SIDECAR_DELIVERY_HANDOFF_URL=http://fedify-sidecar:8080/webhook/outbox
SIDECAR_TOKEN=<shared-internal-token>
```

`SIDECAR_WEBHOOK_URL` is a legacy/transitional sidecar-origin setting and is deliberately not used as the APDM durable handoff fallback. `SIDECAR_DELIVERY_HANDOFF_URL` must name the exact durable acceptance endpoint. External mode also fails closed without the queue service, authenticated handoff token, valid handoff URL, and bounded handoff timeout.

A controlled local/test preview uses:

```text
NODE_ENV=test
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external
SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true
SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=false
```

Unset or unrecognized `NODE_ENV` values never make preview-only external delivery authoritative.

## How external mode suppresses native jobs

The wrapper invokes the exact SemApps outbox `post` handler with an isolated execution context created per request.

Only that request-local context overrides `createJob`:

- `remotePost` jobs are captured instead of enqueued;
- any non-`remotePost` job is delegated to the real queue implementation;
- the shared Moleculer service instance is never mutated.

This matters for concurrency: simultaneous posts cannot accidentally borrow one another's temporary queue interception.

After the SemApps handler returns, the adapter validates the captured local/remote recipients, builds the authoritative `ap.delivery-plan.v1`, and awaits the Phase 4 durable Bull handoff enqueuer. Only after that enqueue succeeds does it emit `activitypub.outbox.remote-delivery.handoff-queued` for observability.

The post-enqueue event contains `activity`, `deliveryPlan`, `remoteRecipients`, `localRecipients`, `suppressedNativeRemotePostCount`, `deliveryMode: external`, and `durableHandoffQueued: true`.

The event is not a second delivery path or the durable acceptance mechanism: the Bull handoff is already queued before the event exists.

## Phase 5 production cutover and authority split

When production authority is explicitly enabled, the same already-hardened Phase 2–4 execution seam is used rather than introducing a second delivery path:

1. SemApps still persists/processes the Activity and performs local Pod delivery.
2. The request-local queue interception captures and suppresses every would-have-been native `remotePost` job.
3. The authoritative expanded local/remote partition produces `ap.delivery-plan.v1`.
4. The durable Bull handoff retries until the sidecar durably accepts the intent.
5. The federation sidecar becomes the sole external ActivityPub HTTP executor for that external-mode request.
6. User signing/key custody remains in ActivityPods; the sidecar consumes the internal signing boundary rather than taking custody of private keys.

Phase 5 does not remove the native implementation. Native remains the tested rollback path through the later stabilization/cleanup program.

## Rollback

Rollback remains deliberately one switch:

```text
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=native
```

`native` is also the default when the variable is absent. In native mode, stale values of either external opt-in flag are ignored for authority selection; they cannot turn an emergency rollback into a startup outage. Operators should still clean stale flags after service restoration, but doing so is not a prerequisite to restoring SemApps native remote delivery.

If the adapter itself is eventually removed, that is a Phase 16 stabilization/cleanup decision after the later load/fault gates, not part of the Phase 5 cutover.

## Phase 2 verified exit criteria

`APDM-P2-A` established the underlying seam with all of the following verified:

1. native mode delegates to SemApps and creates native `remotePost` work as before;
2. external preview mode creates **zero** native `remotePost` jobs;
3. unrelated queue work still delegates normally;
4. local delivery remains the SemApps local path;
5. simultaneous external-preview requests do not mutate/share queue interception state;
6. external mode fails closed without an explicit authorization state;
7. SemApps package drift from 1.1.4 fails fast;
8. backend CI and relevant tests pass;
9. review findings were closed before the phase was marked PASS.

## Phase 5 verified ActivityPods exit criteria

`APDM-P5-A` closed with all of the following:

1. production external authority requires `SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=true`, including when `NODE_ENV` is unset or unknown;
2. preview-only external delivery is limited to explicit `test`/`development` runtimes;
3. production authority and preview cannot be enabled together;
4. external authority reuses the proven Phase 2–4 path and produces zero native `remotePost` jobs;
5. the durable Delivery Plan handoff remains the only external execution input;
6. changing only `SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=native` deterministically restores the native executor;
7. exact-head backend checks/review gates closed;
8. the paired federation Phase 5 executor/security/interoperability gate closed before cross-repo Phase 5 was declared PASS.

## Non-negotiable local-delivery boundary

The Fedify sidecar is not a replacement for local Pod delivery. Remote authority changes must not bypass ActivityPods-owned Pod dataset, WebACL/LDP, Activity side-effect, or local-delivery semantics.
