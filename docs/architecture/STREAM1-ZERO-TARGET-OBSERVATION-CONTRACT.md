# Stream1 Zero-Target Observation Contract

ActivityPods is the authority for the committed local ActivityPub activity and the authoritative expanded recipient snapshot used by APDM.

In external delivery mode, a committed activity must still produce one durable `ap.delivery-plan.v1` handoff when the authoritative remote-recipient set is empty. An empty remote-recipient set is a valid result, not an error condition and not a reason to invent a federation target.

The downstream federation sidecar is responsible for deciding whether the committed activity belongs to the provider-wide Stream1 public event log and for creating remote delivery work only when remote targets actually exist.

This preserves the authority split:

```text
ActivityPods
  committed activity
      + authoritative recipient expansion
      + durable Delivery Plan identity
                 |
                 v
federation sidecar
  Stream1 observation (when federation-public)
      + remote fan-out (only when targets exist)
```

The ActivityPods side must not add a second Stream1 aggregator or reconstruct recipients in `outbox-emitter`. The durable Delivery Plan remains the one external-mode handoff authority.
