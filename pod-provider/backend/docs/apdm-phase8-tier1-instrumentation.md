# APDM Phase 8 — Tier 1 instrumentation

Phase 8 is measurement-only. It must not change ActivityPub delivery ordering, persistence, ACL semantics, recipient expansion, retry behavior, or remote-delivery authority.

The instrumentation added by `APDM-P8-A` observes the real `activitypub.outbox.post` execution tree when explicitly enabled. With instrumentation disabled, no Phase 8 middleware is installed and Node HTTP is not patched.

## What is captured

For each root `activitypub.outbox.post` trace, one JSONL record captures:

- all observed local Moleculer action executions and per-action elapsed time;
- aggregate action-family counts for ActivityPub, WebACL, LDP, triplestore/SPARQL, auth and other actions;
- HTTP requests whose origin/path match the configured Fuseki/SPARQL endpoint, including method, path, status and elapsed time;
- root wall-clock elapsed time;
- process CPU usage;
- heap and RSS snapshots/deltas;
- action and HTTP failures attributable to the trace;
- the operator-supplied recipient-count case label.

The observer uses `AsyncLocalStorage` so nested local action work and Fuseki HTTP requests remain attributable to the root outbox operation without adding fields to ActivityPub payloads or Moleculer params.

CPU and heap/RSS are intentionally process-level observations, not per-request isolation primitives. They are meaningful only when benchmark traffic is controlled so unrelated work does not materially overlap the measured root action.

## Required measurement matrix

Run the real local-delivery path at these exact local-recipient counts:

- 1
- 10
- 100
- 200
- 1,000

Do not call `localPost()` directly. Each sample must enter through the normal `activitypub.outbox.post` action so recipient validation, local delivery, middleware, WebACL, LDP and triplestore work remain in the measured path.

Use distinct local actors whose Pod datasets already exist and are valid delivery targets. Keep the Activity payload semantically equivalent across sizes except for the recipient set.

Run warm-up traffic before collecting samples. For comparable latency percentiles, collect multiple measured samples for each size under the same machine/container limits and the same Fuseki/Redis configuration.

Collect the canonical Phase 8 matrix under isolated benchmark traffic: run one measured root outbox operation at a time and suppress unrelated application/background traffic where operationally possible. If background work cannot be suppressed, record that fact with the measurement artifact and do not interpret process CPU/heap deltas as request-exclusive cost. Separate concurrency/load characterization belongs to later phases; Phase 8 establishes the serial Tier 1 work model.

## Enable one measurement case

Set the following variables before starting the backend process:

```sh
SEMAPPS_APDM_PHASE8_INSTRUMENTATION_ENABLED=true
SEMAPPS_APDM_PHASE8_INSTRUMENTATION_OUTPUT=./measurements/apdm-p8.jsonl
SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT=100
SEMAPPS_APDM_PHASE8_CASE_LABEL=local-100
```

`SEMAPPS_APDM_PHASE8_RECIPIENT_COUNT` is measurement metadata only. It does not alter or generate recipients. The operator must ensure the actual outbox activity for that process/sample addresses exactly that number of local recipients.

The existing `SEMAPPS_FUSEKI_BASE` and `SEMAPPS_SPARQL_ENDPOINT` values define the HTTP targets counted as Fuseki work.

## Safety invariants

- Instrumentation is disabled by default.
- Disabled mode installs no middleware and patches no HTTP function.
- The root action remains `activitypub.outbox.post`.
- No ActivityPub object is mutated for measurement.
- No request parameter or recipient metadata is added for measurement.
- No delivery action is skipped, reordered, retried or parallelized by Phase 8.
- The observer records errors but never converts failure into success.
- Phase 8 data must not be interpreted as an optimization result; it exists to decide what later phases should optimize.

## Summarize and reconcile

After measurements for all five required recipient sizes are present in one JSONL file, run:

```sh
yarn measure:apdm:p8:summary ./measurements/apdm-p8.jsonl ./measurements/apdm-p8-summary.json
```

The summarizer:

- refuses to mark the measurement set complete if any required size is missing;
- reports mean/p50/p95/p99 elapsed time where applicable;
- reports CPU, heap delta, nested Moleculer action counts and Fuseki request counts;
- aggregates exact action/category counts;
- fits simple measured `slope * N + intercept` models for nested Moleculer actions and Fuseki HTTP requests;
- marks the historical `6N + O(1)` top-level model as ready for reconciliation only after all required sizes exist.

The linear fit is descriptive evidence, not a claim that all costs are perfectly linear. Inspect exact action counts and errors alongside the fitted slope.

## Phase 8 exit gate

Phase 8 is complete only when real measurements from 1, 10, 100, 200 and 1,000 local recipients have been collected and reviewed, and the historical `6N + O(1)` / roughly 8,000-operation estimate has been validated, corrected, or explicitly retired.

Do not begin APDM Phase 9 bounded concurrency based only on source inspection or synthetic unit tests. The Phase 8 measurement artifacts are the gate.
