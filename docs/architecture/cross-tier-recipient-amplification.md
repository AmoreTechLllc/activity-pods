# Cross-tier recipient-oriented federation amplification

> Status: architecture clarification. This document does not change the Phase 10 measured runtime or its evidence branch.

## Why this exists

ActivityPods historically paid repeated Moleculer and datastore work per ActivityPub recipient on both sides of federation. The exact work differed between local Pod delivery and remote HTTP delivery, but the scaling shape was related: recipient-oriented orchestration repeated resolution, routing, serialization, persistence, and delivery preparation that could instead be shared, bounded, or moved into a runtime designed for federation fan-out.

The important distinction is therefore not that recipient amplification was only a Tier 1 problem. It was a cross-cutting federation scalability problem with two different architectural answers.

- **Local delivery stays in Tier 1 / ActivityPods** because Pod-local LDP persistence, WebACL authorization, per-Pod datasets, local collections, and ActivityPods/SemApps events remain authoritative there.
- **Remote delivery moved to Tier 2 / Fedify** because high-volume remote HTTP execution, shared-inbox collapse, bounded per-domain concurrency, connection reuse, retries, and durable delivery execution do not need to remain inside recipient-oriented Moleculer execution.

Tier 2 was therefore introduced partly as a scalability escape from the historical remote Moleculer execution model, not merely as a cleaner separation of responsibilities.

## Historical cross-cutting shape

A public post addressed to an actor's followers can create two classes of recipients:

1. local actors whose inboxes and resources are stored on the same ActivityPods provider;
2. remote actors whose inboxes must be reached over ActivityPub HTTP.

Historically, both classes could accumulate repeated per-recipient service calls and resolution work. The local path then continued into per-Pod persistence and collection updates, while the remote path continued into actor/inbox resolution, signing preparation, and HTTP delivery.

That means the same high-level smell existed on both sides:

```text
resolve shared post/sender state
for each recipient:
    repeat recipient-specific Moleculer orchestration
    repeat lookups/resolution that may already be known
    perform recipient-specific delivery work
```

The remediation must preserve different authorities, so the implementation is intentionally asymmetric.

## Tier 1 answer: make local fan-out cheaper without moving Pod authority

For local recipients, ActivityPods must still perform the semantics that make the delivery real inside each recipient Pod. The optimization target is therefore **less orchestration and fewer datastore round trips per correct local delivery**, not replacing local delivery with Fedify.

Current and planned APDM work includes:

- classify local recipients once and reuse authoritative account context;
- remove duplicate account and actor resolution;
- scope safe positive metadata reuse to a single local delivery operation;
- use bounded concurrency instead of strict serial recipient processing;
- batch/select within one authority boundary when semantics permit it;
- avoid full actor/LDP materialization when a persisted scalar property is sufficient;
- reduce repeated Fuseki dataset and metadata round trips;
- preserve per-Pod LDP/WebACL/dataset isolation where cross-Pod batching would be unsafe;
- add durable per-recipient recovery state so retries do not replay already-completed work.

Phase 8 measured the real local cost and showed that the simple visible `2 + kN` service-call model understates nested work substantially. Phase 7 and Phase 9 already removed important duplicate/serial amplification, while Phase 10 is measuring a narrow dataset-existence reuse mechanism. None of those changes alter the fact that correct per-Pod persistence remains Tier 1 work.

## Tier 2 answer: remove remote HTTP execution from recipient-oriented Moleculer fan-out

For remote recipients, the architectural answer is different. ActivityPods remains the source of authoritative outbound intent and signing authority, but it does not need to execute every remote network delivery through the historical Moleculer path.

In external APDM mode the intended flow is:

```text
ActivityPods / SemApps
    authoritative post + recipient classification
    delivery planning
    signing/key authority
    durable delivery-plan handoff
            |
            v
Fedify sidecar / Tier 2
    remote recipient/inbox execution
    shared-inbox collapse where valid
    bounded concurrency and per-domain controls
    connection reuse
    retry/backoff/DLQ behavior
    remote HTTP delivery
```

The sidecar is not an alternative Pod store and does not become local LDP/WebACL authority. Its purpose is to provide a federation execution runtime whose scaling model is better suited to remote fan-out than fine-grained recipient-by-recipient Moleculer orchestration.

This is why APDM's remote-authority work must be read as both:

1. an ownership/correctness cleanup that prevents duplicate remote delivery routes; and
2. a performance/scalability redesign that moves remote high-volume execution into Tier 2.

## Shared optimization principles across tiers

Even though the execution boundaries differ, both tiers follow the same resource-efficiency rules:

- resolve shared state once where authority permits;
- do not repeat a lookup merely because there is another recipient;
- avoid materializing large objects when one persisted scalar is sufficient;
- batch only within an authority boundary that preserves semantics;
- bound concurrency, memory, queue claims, retries, and response fan-out;
- preserve deterministic/idempotent behavior under partial failure;
- measure work per successful delivery rather than only wall-clock latency;
- do not move waste from ActivityPods to Fuseki, Redis, RedPanda, or the sidecar and call that an optimization.

## What this clarification does not claim

It does not claim that local and remote delivery are now identical, or that both should use Fedify.

It also does not claim that all recipient amplification is solved. Remaining work includes reducing local per-recipient persistence overhead safely, proving durable local partial-failure recovery, measuring sustained multi-account load, validating sidecar queue/backpressure behavior under remote bursts, and establishing end-to-end provider resource budgets.

The correct architectural statement is:

> Recipient-oriented Moleculer amplification was a cross-cutting local and remote federation scalability problem. Tier 2/Fedify is the remote execution solution to that class of problem; Tier 1 must solve the local equivalent while retaining Pod-local authority and SemApps compatibility.
