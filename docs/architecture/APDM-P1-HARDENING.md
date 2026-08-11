# APDM Phase 1 post-merge hardening

This document records the Phase 1 contract hardening performed before APDM Phase 5 makes the Fedify sidecar authoritative for remote ActivityPub delivery.

## Delivery Plan contract hardening

The `ap.delivery-plan.v1` wire shape and version are unchanged. The producer now fails closed on contract and execution ambiguities that were accepted by the original Phase 1 implementation:

- `searchConsent` must be an object or null, matching the mirrored JSON Schema and Fedify consumer;
- delivery endpoints reject credentials, fragments, whitespace, and ASCII control characters;
- `targetDomain` is the lowercase effective delivery hostname with DNS trailing-dot aliases removed;
- dataset/domain authority tokens reject whitespace/control-character ambiguity;
- fingerprint canonicalization rejects non-JSON runtime values;
- only the sender's own followers collection is treated as followers addressing;
- every explicitly addressed concrete actor must survive into the authoritative recipient plan;
- concrete `audience` actors fail closed if SemApps did not include them in the authoritative partition;
- sender-followers expressed through `audience` fail closed until authoritative audience expansion exists.

## Blind-address privacy blocker

Exact SemApps 1.1.4 `activitypub.activity.getRecipients` uses `to`, `bto`, `cc`, and `bcc` for recipient discovery. The native outbox implementation then continues with the same Activity object for persistence/local/native-remote delivery. That means `bto`/`bcc` cannot be assumed absent from delivered or stored Activity bytes.

APDM external delivery now treats those fields as routing-only inputs:

1. recipient planning uses the original Activity and therefore still includes blind recipients;
2. before constructing the Delivery Plan, ActivityPods recursively strips `bto` and `bcc` from the outbound Activity payload;
3. the Delivery Plan validator rejects any hand-crafted plan that still contains `bto` or `bcc` anywhere in the outbound Activity;
4. the federation consumer independently enforces the same rule.

This closes the future ActivityPods -> Fedify disclosure boundary, but it does **not** repair SemApps native/local persistence and delivery by itself.

### Pre-Phase-5 gate

Phase 5 MUST NOT be considered ready until the ActivityPods/SemApps path has an explicit solution or proof for blind-address privacy across:

- persisted Activity representation;
- local Pod delivery;
- native rollback delivery while native mode remains supported;
- any observer/event payload that could expose `bto`/`bcc`.

The fix must preserve recipient planning before sanitization. Simply deleting `bto`/`bcc` before `getRecipients` would drop intended recipients and is not acceptable.

## Audience compatibility blocker

ActivityPub delivery semantics include `audience`, but exact SemApps 1.1.4 `getRecipients` scans only `to`, `bto`, `cc`, and `bcc`. Until authoritative audience expansion is implemented, APDM fails closed when a concrete `audience` actor is missing from the captured recipient partition and rejects the sender's followers collection when expressed only through `audience`.

## Remaining execution-boundary security

The Delivery Plan contract is not a complete SSRF defense. DNS resolution, private/link-local/loopback IP rejection, redirect revalidation, and DNS-rebinding defenses remain sidecar execution-layer requirements before production external authority.
