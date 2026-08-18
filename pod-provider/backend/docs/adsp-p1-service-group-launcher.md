# ADSP P1 Service-Group Launcher Isolation

Status: **evidence slice**

Phase 1 requires service groups to start independently rather than loading every ActivityPods/SemApps schema into every broker process. This proof exercises the production startup entrypoint, `scripts/run-moleculer-fabric.js`, rather than only the service-pattern resolver.

## Contract

- `pod-cell` remains the production-preserving default and continues to resolve the existing `services/*.js services/**/*.js` globs.
- `p1-probe` resolves only `p1-fixtures/services/*.service.js`.
- unknown groups fail closed in the fabric configuration.
- selecting a non-default group changes only which service schemas the launcher passes to `moleculer-runner`; it does not change serializer, namespace, node identity or transporter semantics.

## Real launcher proof

The CI proof starts `run-moleculer-fabric.js` as a child process in distributed mode with:

- a unique node ID;
- an isolated namespace;
- the incumbent Redis transporter;
- `SEMAPPS_MOLECULER_SERVICE_GROUP=p1-probe`.

A second broker joins the same namespace and calls `adsp.p1.rdfProbe.inventory` over the real transporter. The launched node must report both P1 fixture services while reporting no production service whose name starts with `api`, `ldp`, `activitypub`, `auth`, `triplestore`, `webacl`, `webid`, or `solid`.

The proof also validates the launcher's emitted start metadata and exact selected service pattern.

## Non-goals

This slice does not move any production service out of `pod-cell`. It proves that the deployment mechanism can start an independently selected group safely, which is the prerequisite for later evidence-driven decomposition. Phase 2 remains blocked until all Phase-1 exit gates are reconciled.
