# APDM Phase 1 post-merge hardening

This document records the Phase 1 contract hardening performed before APDM Phase 5 makes the Fedify sidecar authoritative for remote ActivityPub delivery.

## Delivery Plan contract hardening

The `ap.delivery-plan.v1` wire shape and version are unchanged. The producer now fails closed on contract and execution ambiguities that were accepted by the original Phase 1 implementation:

- `searchConsent` must be an object or null, matching the mirrored JSON Schema and Fedify consumer;
- delivery endpoints reject credentials, fragments (including a bare trailing `#`), whitespace, and ASCII control characters;
- `targetDomain` is the lowercase effective delivery hostname with DNS trailing-dot aliases removed;
- dataset/domain authority tokens reject whitespace/control-character ambiguity;
- fingerprint canonicalization rejects non-JSON runtime values and sparse arrays;
- only the sender's own followers collection is treated as followers addressing;
- every explicitly addressed concrete actor must survive into the authoritative recipient plan;
- `bto`/`bcc` are routing-only inputs and are absent recursively from outbound Activity bytes;
- unsupported `audience` addressing is rejected before SemApps persistence;
- the internal Fedify handoff URL rejects credentials, fragments (including empty fragments), and whitespace-normalized aliases.

## Blind-address privacy fix

Exact SemApps 1.1.4 `activitypub.activity.getRecipients` uses `to`, `bto`, `cc`, and `bcc` for recipient discovery, while its native outbox path otherwise continues with the same Activity object for persistence, events, local delivery, and native remote delivery.

The strategy adapter now closes that leak without dropping blind recipients:

1. it captures the original top-level `bto`/`bcc` routing values in a request-local context;
2. it recursively strips `bto` and `bcc` from the request payload **before** invoking the SemApps outbox handler, so persistence, side effects, events, local delivery, native rollback jobs, and external planning receive sanitized Activity bytes;
3. only when SemApps calls `activitypub.activity.getRecipients`, the request-local wrapper performs the normal recipient lookup on the sanitized Activity and a second lookup containing only the original actor plus blind routing fields;
4. those recipient results are unioned and deduplicated, preserving intended blind recipients without reintroducing blind fields into the Activity;
5. the Delivery Plan validator rejects any hand-crafted plan that still contains `bto` or `bcc` anywhere in its outbound Activity;
6. the federation consumer independently enforces the same no-blind-address rule.

Focused regression tests prove that the original request is not mutated, blind recipients remain routable, duplicate visible/blind recipients converge, and native rollback receives only sanitized Activity bytes. The full backend suite is the final compatibility gate for P2 interception, P3 planning, and P4 durability behavior.

### Scope note for bare Object posts

SemApps 1.1.4 `activitypub.object.wrap` lifts only `to` and `cc` from a bare Object into its generated Create activity. Nested `bto`/`bcc` therefore were not authoritative routing inputs in the upstream implementation. APDM strips nested blind-address fields for privacy but does not invent recipient semantics that SemApps 1.1.4 never supported.

## Audience interoperability policy

ActivityPub delivery semantics include `audience`, but exact SemApps 1.1.4 `getRecipients` scans only `to`, `bto`, `cc`, and `bcc`.

APDM therefore uses an explicit pre-persistence compatibility policy:

- Public aliases in `audience` are accepted;
- a concrete audience actor is accepted only when the same actor is already present in `to`, `bto`, `cc`, or `bcc`, so SemApps recipient discovery cannot silently omit it;
- sender-followers expressed through `audience` are rejected before persistence, even if duplicated elsewhere, until authoritative audience-collection semantics are deliberately implemented;
- an audience-only concrete recipient is rejected before the native SemApps outbox handler runs.

The Delivery Plan producer and consumer retain defense-in-depth checks so legacy/replayed data cannot silently omit an audience recipient downstream.

## Codex findings addressed

The final hardening also incorporates review findings that were easy to miss with ordinary URL/JSON helpers:

- WHATWG `URL.hash` is empty for a bare trailing `#`, so fragment rejection checks the original endpoint string rather than hash truthiness;
- sparse JavaScript arrays are not valid JSON values for the contract canonicalizer and are rejected before hashing/sanitization.

## Remaining execution-boundary security

The Delivery Plan contract is not a complete SSRF defense. DNS resolution, private/link-local/loopback IP rejection, redirect revalidation, and DNS-rebinding defenses remain sidecar execution-layer responsibilities. Those controls must remain effective at the actual external HTTP execution boundary; the P1 contract must not be mistaken for an IP-level authorization mechanism.
