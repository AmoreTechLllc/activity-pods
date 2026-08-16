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

The workflow is manually dispatchable. On the dedicated Phase 8 runner branch it also runs once when measurement-validity code changes, so the measurement implementation can be proven before merge.

## Canonical Phase 8 result

The canonical real-runtime matrix completed successfully on runtime head `268f417446dae99fda890e05b216ba8ccaf13f79` in GitHub Actions run `31919855390` (attempt 1).

The retained artifact is `apdm-phase8-real-measurements-31919855390-1` (artifact ID `9257252168`, SHA-256 `9922e90239cafda03559000a40be5a915959b534e0d4336da188a546141ca0ef`). It contains the actor manifest, provisioning log, all five raw JSONL case files, the combined JSONL file and the generated summary.

Fixture provisioning completed for one sender plus 1,000 recipients. The 1,000-recipient portion completed in 4,505.2 seconds at a reported 0.22 recipients/second with fixture-only concurrency 4. This is setup evidence only; it does not introduce or measure Phase 9 delivery concurrency.

Every required case produced exactly three successful canonical samples after one discarded warmup. There were no failed samples and no recorded delivery, Fuseki or instrumentation errors.

| Local recipients (N) | Successful samples | Mean elapsed ms | Mean nested Moleculer actions | Mean Fuseki HTTP requests |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 3 | 1,353.60 | 938.00 | 318.00 |
| 10 | 3 | 2,900.50 | 1,465.67 | 586.33 |
| 100 | 3 | 25,171.46 | 6,611.67 | 3,202.33 |
| 200 | 3 | 50,536.58 | 12,286.33 | 6,093.67 |
| 1,000 | 3 | 333,538.30 | 57,911.33 | 29,303.00 |

The descriptive linear fits across the five canonical cases are:

- nested Moleculer actions: approximately `57.0189N + 892.2351`;
- Fuseki HTTP requests: approximately `29.0085N + 294.6295`.

These fits describe the observed serial Tier 1 workload on this benchmark. They are not concurrency or throughput models and do not imply that every nested action category is independently linear.

The canonical job log also contains no recurrence of the Phase 8 defects discovered by earlier failed runs: there is no `activitypub.actor.get` parameter `ValidationError`, no `Parameters validation error`, and no RateLimiter/ioredis `ECONNREFUSED 127.0.0.1:6379` failure.

## Historical model reconciliation

The Phase 0 `6N + O(1)` expression was a source-counted model of six visible SemApps recipient-specific orchestration calls, not a nested-operation estimate. Phase 7 subsequently removed the duplicate local account lookup from the delivery path, so retaining `6N + O(1)` as the current visible-call model would be incorrect.

The Phase 8 exact-action counts validate the post-Phase-7 correction. For each canonical sample, the remaining recipient-dependent visible calls are:

- `auth.account.findByWebId`: `N + 1`;
- `activitypub.actor.getCollectionUri`: `N`;
- `activitypub.collection.add`: `N + 3`;
- `ldp.remote.store`: `N`;
- `activitypub.activity.attach`: `N`.

Together these are exactly `5N + 4` visible calls in the measured path. Therefore the historical `6N + O(1)` model is **corrected to `5N + 4` for the current Phase 8 implementation**, with the one-call-per-recipient reduction attributable to the already-completed Phase 7 duplicate-account-lookup removal.

The historical rough estimate of approximately 8,000 nested operations around N=200 is **retired as an insufficient estimate**. The real N=200 measurements observed a mean of 12,286.33 nested Moleculer action executions, plus a separately measured mean of 6,093.67 Fuseki HTTP requests. Those quantities must not be added together as though they were one non-overlapping operation counter; they are different observation layers. The canonical measured models above replace the old rough estimate for future Phase planning.

The N=1/10/100/200/1000 evidence also confirms why later optimization phases are warranted: local Pod delivery preserves the intended SemApps/LDP/WebACL/Fuseki semantics, but the nested work grows by roughly 57 Moleculer actions and 29 Fuseki requests per additional local recipient in this serial benchmark.

## Exit-gate interpretation

A green workflow is necessary but not by itself the architectural conclusion. Review the raw exact-action/category counts and summary, then explicitly decide whether the historical `6N + O(1)` and roughly 8,000-operation estimates are validated, corrected or retired.

For the canonical run above, that reconciliation is now recorded: the current visible-call model is `5N + 4`, and the historical ~8,000 nested-operation estimate is retired in favor of the measured nested-action and Fuseki models.

**The APDM Phase 8 technical measurement exit gate is PASS.** PR integration remains separately subject to exact-head repository CI and review policy. Phase 9 bounded concurrency must not begin until those integration gates are satisfied and the Phase 8 PR is merged.
