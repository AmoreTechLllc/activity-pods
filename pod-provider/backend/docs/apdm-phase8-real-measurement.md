# APDM Phase 8 — real local fan-out measurement

This runbook executes the canonical Phase 8 matrix against the real ActivityPods backend, real SemApps 1.1.4 ActivityPub services, real Fuseki, real Redis transport and real Pod-backed local actors.

It is deliberately separate from unit/contract tests. Synthetic results do not satisfy the Phase 8 exit gate.

## Measurement invariants

- Required local-recipient counts are exactly `1`, `10`, `100`, `200`, and `1000`.
- All counts are measured on the same runner and the same Fuseki/Redis state.
- Actors are provisioned once before measurement.
- Actor provisioning uses normal `/auth/signup` and normal ActivityPods Pod/ActivityPub bootstrap.
- `APODS_AUTO_PROVISION_ATPROTO_ON_SIGNUP=false` is used only to remove unrelated ATProto signup cost from this ActivityPub local-fan-out benchmark.
- Measured posts enter through the running backend's `activitypub.outbox.post` action over the real Redis Moleculer transporter.
- Each measured post is persisted normally; the benchmark does not call `localPost()` directly and does not use `transient=true`.
- The runner starts one measured root at a time and waits until detached local delivery has completed and its JSONL record has been written before starting the next root.
- Any thrown delivery error, Fuseki error, instrumentation error, or non-empty SemApps `localPost().failures` list makes that trace unusable.
- Warmups use the same path but are deleted before canonical samples are collected.

## Dedicated compose overlay

`pod-provider/docker-compose-phase8.yml` overlays the existing test stack. It:

- keeps the real `fuseki_test`, Redis and backend services;
- mounts `pod-provider/measurements` at `/app/backend/measurements` so artifacts survive backend recreation;
- disables ATProto auto-provisioning for benchmark actor creation;
- keeps remote delivery in native mode with no remote recipients and disables the transitional sidecar observer;
- supplies the static Phase 8 recipient-count metadata for each backend recreation.

Normal development and test compose behavior is not changed.

## Runner commands

Provision one sender plus 1,000 local recipients while instrumentation is disabled:

```sh
node scripts/apdm-phase8-real-measure.js provision ./measurements/apdm-p8-actors.json 1000
```

Then, after recreating the backend with instrumentation enabled and `SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT=N`, collect warmup plus canonical samples:

```sh
node scripts/apdm-phase8-real-measure.js measure ./measurements/apdm-p8-actors.json N
```

The runner independently verifies that the configured instrumentation count equals `N`, uses exactly the first `N` actors from the manifest, waits for the detached trace record, and rejects any record containing errors.

## GitHub Actions

`.github/workflows/apdm-phase8-real-measurement.yml` automates the full sequence on one Ubuntu runner:

1. start Fuseki, Redis and mailcatcher;
2. bootstrap the Fuseki `settings` dataset;
3. build the current backend image, including the pinned SemApps compatibility patch;
4. start the backend with instrumentation disabled;
5. provision the benchmark actor population once;
6. recreate only the backend for each required recipient count;
7. run warmup plus measured samples serially;
8. concatenate the five raw JSONL files;
9. run `apdm-phase8-summarize.js`;
10. upload the actor manifest, raw records, combined JSONL and summary as workflow artifacts.

The workflow is manually dispatchable. On the dedicated Phase 8 runner branch it also runs once when the workflow file itself is introduced, so the measurement implementation can be proven before merge.

## Exit-gate interpretation

A green workflow is necessary but not by itself the architectural conclusion. Review the raw exact-action/category counts and summary, then explicitly decide whether the historical `6N + O(1)` and roughly 8,000-operation estimates are validated, corrected or retired.

Only after that reconciliation is recorded may APDM Phase 8 be marked PASS and Phase 9 bounded concurrency begin.
