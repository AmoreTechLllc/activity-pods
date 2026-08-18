# ADSP P2 horizontal Redis foundation

Phase 2 establishes the first real horizontally distributed ActivityPods comparator using the incumbent Redis Moleculer transporter. This foundation slice proves the production Pod/SemApps cell can actually be instantiated at the replica counts required by the later benchmark before any performance evidence is accepted.

## Production startup correction

The backend Docker image previously started PM2 with a direct hard-coded `moleculer-runner services/*.js services/**/*.js` command even though Phase 1 moved the supported package startup path to `scripts/run-moleculer-fabric.js`.

That Docker path bypassed validated service-group selection and the launcher's fail-closed fabric contract. The PM2 configuration now starts the same validated launcher used by `yarn start`, `yarn dev`, and `yarn test`. A regression test rejects a future return to hard-coded production service globs or direct runner startup.

## Horizontal topology smoke

`docker-compose-adsp-p2-horizontal.yml` defines four explicit production `pod-cell` identities:

- `adsp-p2-pod-cell-1`
- `adsp-p2-pod-cell-2`
- `adsp-p2-pod-cell-3`
- `adsp-p2-pod-cell-4`

All replicas share:

- one explicit benchmark namespace;
- the incumbent Redis transporter logical DB;
- the same Redis queue/cache/OIDC dependencies;
- the same Fuseki instance;
- the same production service group and local-first routing policy;
- the same built backend image.

Replica 1 retains the canonical HTTP ingress on port 3000 so existing ActivityPods provisioning/measurement tooling can continue to use one stable entry point. Replicas 2–4 expose separate host ports for readiness and diagnostics only.

The dedicated workflow grows the topology `1 → 2 → 4`, then contracts `4 → 2`. At every accepted size, `proof-adsp-p2-horizontal-pod-cells.js` requires the expected number of endpoints for representative production actions (`activitypub.outbox.post`, `activitypub.actor.getCollectionUri`, and `auth.awaitBootstrapComplete`) and verifies targeted `$node.health` reachability for every expected node ID.

The final contraction must remove replicas 3 and 4 from the registry and return the representative action endpoint counts to two.

## What this does not prove

This foundation is **not Phase-2 performance evidence**. It does not claim scale-out benefit, throughput improvement, latency improvement, or recovery-under-load correctness.

Phase 2 remains open until matched 1/2/4 workloads record the frozen telemetry set and pass the Phase-0 numerical gates. It must additionally inject node loss during real accepted ActivityPub/Pod work and prove bounded recovery with zero unexplained loss or duplication.

NATS Core remains blocked until that Redis horizontal comparator is complete. JetStream remains unauthorized.
