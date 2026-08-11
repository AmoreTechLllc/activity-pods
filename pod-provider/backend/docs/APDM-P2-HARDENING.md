# APDM Phase 2 — post-merge hardening

This follow-up audits the pre-`remotePost` interception seam introduced in APDM Phase 2 after Phases 3 and 4 were completed. It does not change remote-authority ownership and does not start Phase 5.

## Exact upstream dependency

The adapter remains pinned to `@semapps/activitypub` 1.1.4. The authoritative upstream release source has this ordering inside `activitypub.outbox.post`:

1. `activitypub.activity.getRecipients`;
2. partition local and remote recipients;
3. `this.createJob('remotePost', recipientUri, { recipientUri, activity }, queueOptions)`;
4. `activitypub.outbox.posted`;
5. `this.localPost(localRecipients, activity)`.

The adapter now checks the installed outbox service for this critical shape in addition to checking the package version and deep-import paths. If the post/localPost/remotePost structure or ordering changes, startup fails instead of silently intercepting an incompatible implementation.

## Suppressed remote-job safety

External mode suppresses native `remotePost` queue insertion before creation. Because suppression occurs before durable handoff planning, every captured job is now validated before its recipient can enter a Delivery Plan:

- `recipientUri` must be a concrete credential-free HTTP(S) URI;
- the intercepted job ID must match the SemApps 1.1.4 recipient identity;
- the queued Activity ID must match the Activity returned by the outbox handler;
- actor identity must match when present.

Malformed or drifted intercepted jobs fail the outbox action before Delivery Plan construction or handoff enqueue. They are never silently filtered out.

## Local observation safety

The request-local wrapper now records every `localPost` invocation instead of overwriting a prior observation. Each local call must carry the same Activity identity as the outbox result, each recipient must be a concrete credential-free HTTP(S) URI, and duplicate recipients are collapsed only after all calls are observed.

The original SemApps `localPost` method remains untouched and is still invoked immediately. The wrapper only observes the arguments so the authoritative Delivery Plan can retain the local/remote partition without rerunning recipient expansion.

## Configuration hardening at the seam

Guarded external mode additionally rejects:

- a non-boolean preview guard;
- missing durable queue configuration;
- malformed, credential-bearing, non-HTTP(S), or fragment-bearing sidecar handoff URLs;
- blank sidecar tokens;
- non-finite or unreasonable handoff timeouts outside 100–60000 ms.

Native mode remains unaffected by these external-only checks.

## Regression coverage

The hardening tests cover:

- expected SemApps interception ordering and rejection of incompatible ordering;
- malformed/credential-bearing remote recipients;
- Activity identity mismatch in suppressed remote jobs;
- multiple localPost observations and deduplication;
- no planner/handoff execution after an invalid suppressed job;
- request-local interception without shared-service mutation;
- external configuration failure cases;
- continued native-mode parity.

Phase 5 remains the explicit production remote-authority cutover.
