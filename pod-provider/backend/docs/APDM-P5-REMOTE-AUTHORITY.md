# APDM Phase 5 — Remote Delivery Authority

## Why this exists

ActivityPods supports two mutually exclusive ActivityPub remote-delivery executors during the APDM migration:

- **SemApps native authority** — SemApps queues and processes `remotePost` jobs. The federation sidecar may observe committed activity, but it must not independently fan out the same activity.
- **Sidecar external authority** — ActivityPods intercepts SemApps `remotePost` creation inside the outbox `post` action before Bull receives those jobs, builds one authoritative `ap.delivery-plan.v1`, and durably hands that plan to the sidecar. The sidecar is then the only remote-delivery executor for that activity.

The presence of a running sidecar does **not** by itself mean the sidecar is federation authority.

## Current interception boundary

External mode does not rely on `activitypub.outbox.posted` to cancel already-created Bull work. The ActivityPods adapter wraps the SemApps outbox `post` action and supplies a request-local execution receiver whose `createJob` implementation captures `remotePost` attempts instead of forwarding them to Bull.

This matters because SemApps 1.1.4 creates the native `remotePost` jobs before it emits `activitypub.outbox.posted`. An event listener downstream of that emit would be too late to suppress native delivery safely.

The adapter also asserts the exact supported SemApps version and expected outbox source ordering before enabling interception. Upstream changes therefore fail closed instead of silently moving the interception point.

## Authority profiles

| Profile | Effective executor | Production canonical? | Sidecar delivery? |
| --- | --- | --- | --- |
| `native-rollback` | `semapps-native` | no | no; observation only |
| `external-preview` | `sidecar-external` | no | yes, only in explicit test/development preview |
| `external-production-authority` | `sidecar-external` | yes | yes |

ActivityPods logs the resolved profile at ActivityPub service startup and stores the safe, non-secret authority descriptor in the service settings.

## Production sidecar authority

A production-like deployment that intends the sidecar to be the canonical remote federation executor must explicitly set:

```env
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external
SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=true
SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=false
SEMAPPS_QUEUE_SERVICE_URL=redis://...
SIDECAR_DELIVERY_HANDOFF_URL=http://fedify-sidecar:8080/webhook/outbox
SIDECAR_TOKEN=...
```

`SIDECAR_DELIVERY_HANDOFF_URL` must point to the exact durable APDM acceptance endpoint. The older observation/webhook surfaces are not remote-delivery authorities.

External mode also requires a real durable queue. `FakeQueueMixin` is forbidden.

## Development preview

Explicit test/development environments may exercise the sidecar executor without claiming production cutover:

```env
NODE_ENV=development
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=external
SEMAPPS_ACTIVITYPUB_ALLOW_EXTERNAL_DELIVERY_PREVIEW=true
SEMAPPS_ACTIVITYPUB_EXTERNAL_AUTHORITY_CUTOVER=false
```

Preview and production authority flags are mutually exclusive.

## Emergency rollback

Rollback intentionally remains one switch:

```env
SEMAPPS_ACTIVITYPUB_REMOTE_DELIVERY_MODE=native
```

`native` wins even if stale external flags remain present. In this mode:

- SemApps is the sole remote-delivery executor;
- the sidecar must remain observation-only for ActivityPods outbox events;
- ActivityPods startup logs warn that the sidecar is not remote-delivery authority.

## No automatic failover between authorities

External delivery failure must **not** cause ActivityPods to enqueue the suppressed native `remotePost` jobs automatically.

That kind of fallback would be unsafe:

1. the durable sidecar handoff may have succeeded while the response was lost;
2. the sidecar may already be processing or retrying the Delivery Plan;
3. recreating native `remotePost` jobs would establish two concurrent delivery authorities and could duplicate federation traffic.

External-mode failures therefore stay on the durable APDM retry/reconciliation path. Switching back to native authority is an explicit operator cutover, not a per-activity fallback.

## Observation paths are not delivery paths

In native rollback mode, `activitypub.outbox.posted` may feed the sidecar observation-only endpoint so Stream1/firehose can observe committed local public activity. That path must not create remote delivery jobs.

In external authority mode, raw `activitypub.outbox.posted` observation is suppressed in favor of the authoritative Delivery Plan/handoff path so the same local activity is not observed twice.

## Operational check

At startup, inspect the ActivityPub authority log. A provider intended to use canonical sidecar federation should report:

```text
executor=sidecar-external
profile=external-production-authority
productionCanonical=true
sidecarDeliveryAuthority=true
externalAuthorityCutover=true
externalDeliveryPreview=false
```

If the service reports `executor=semapps-native` / `profile=native-rollback`, SemApps remains federation delivery authority regardless of whether the sidecar process is running.
