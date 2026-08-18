# ADSP P1 Pod/SemApps Cell Locality

Status: **evidence slice**

This slice closes the Phase-1 requirement that tightly coupled Pod/SemApps services remain colocated by default even when a distributed transporter is available.

## Contract

- `registry.preferLocal` is explicitly `true` in the ActivityPods Moleculer fabric configuration.
- The native single-process profile remains one `pod-cell` with the existing full `services/*.js services/**/*.js` service set.
- No production service is split into a new deployment group by this slice.
- Locality telemetry is opt-in and bounded. It records local action executions and remote calls without changing routing.

## Evidence

Two independent proofs are required.

### Duplicate-cell routing proof

Two Redis-connected brokers advertise the same probe service in the same namespace. Each broker repeatedly calls an outer action that performs a nested `ctx.call` to another action on the same service.

Gate:

- both action endpoints are visible on both brokers;
- the outer action executes locally on the calling cell;
- every nested action executes on the same node as its outer action;
- both cells record zero remote calls.

This proves explicit `preferLocal` behavior when an equivalent remote endpoint exists.

### Real ActivityPods Tier-1 proof

A full ActivityPods backend, Fuseki and Redis stack provisions ten fully bootstrapped local actors and performs representative ActivityPub Tier-1 local delivery with the normal Pod/SemApps service cell and Redis transporter configured.

Gate:

- real local Moleculer action executions are observed;
- at least three action names are exercised;
- remote action count is exactly zero;
- remote action map is empty.

The locality middleware flushes its snapshot atomically during graceful broker shutdown into the dedicated evidence directory.

## Non-goals

This is not a Phase-2 scale-out benchmark. It does not claim that duplicating the entire Pod/SemApps cell is the final horizontal topology. It only proves that the default locality invariant is explicit and enforceable before Phase 2 begins.
