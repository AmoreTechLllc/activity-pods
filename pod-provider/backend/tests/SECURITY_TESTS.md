# Signing security regression coverage

The backend Jest suite includes focused regression tests for the internal signing boundary and repository credential hygiene.

Covered invariants include:

- the signing API requires an explicitly configured `ACTIVITYPODS_TOKEN` and does not fall back to other service credentials;
- bearer parsing is bounded and rejects malformed credentials;
- secret comparison uses a fixed-size timing-safe comparison;
- caller-supplied HTTP dates must be canonical IMF-fixdate values within the configured skew window;
- ATProto provisioning cannot bind one canonical account to another account's WebID;
- backend runtime `.env` files and Redis RDB snapshots are not Git-tracked;
- committed environment examples keep secret-bearing placeholders blank.

These tests do not rotate secrets already deployed and do not remove historical Git blobs. Follow `../SECURITY-CREDENTIAL-ROTATION.md` for the operational response to credentials that were previously committed.
