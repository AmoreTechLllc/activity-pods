# ADSP P2 horizontal Redis foundation

Phase 2 establishes the first real horizontally distributed ActivityPods comparator using the incumbent Redis Moleculer transporter. This foundation slice proves the production Pod/SemApps cell can actually be instantiated at the replica counts required by the later benchmark before any performance evidence is accepted.

## Production startup correction

The backend Docker image previously started PM2 with a direct hard-coded `moleculer-runner services/*.js services/**/*.js` command even though Phase 1 moved the supported package startup path to `scripts/run-moleculer-fabric.js`.

That Docker path bypassed validated service-group selection and the launcher's fail-closed fabric contract. The PM2 configuration now starts the same validated launcher used by `yarn start`, `yarn dev`, and `yarn test`. A regression test rejects a future return to hard-coded production service globs or direct runner startup.

## SemApps local bootstrap locality and semantic readiness

The first real two-cell run exposed a startup race in the pinned `@semapps/ldp@1.1.4` `ControlledContainerMixin`.

Its `started()` lifecycle hook calls `this.broker.call('ldp.registry.register', ...)` after declaring a generic `dependencies: ['ldp']`. Moleculer dependencies may be satisfied by either local or remote services. When replica 1 is already healthy, replica 2 can therefore enter a controlled-container `started()` hook before its own local LDP/JSON-LD ontology stack is semantically ready and route bootstrap work to replica 1.

The first observed failure was a remote `ldp.registry.register` execution on `adsp-p2-pod-cell-1` that could not expand local compact types. Forcing that call to the local node removed the cross-node escape but revealed the deeper lifecycle issue: local action registration can exist before service-specific ontologies have been registered. SemApps' parent ActivityPub service, for example, registers the `as` and `sec` ontologies in its own `started()` hook while controlled-container child services created earlier may start concurrently.

This is bootstrap-state locality/readiness work, not intended distributed traffic. Every Pod/SemApps cell needs its own in-memory LDP registry populated from its own semantic context. ActivityPods therefore applies a narrow, version-pinned postinstall patch to `@semapps/ldp@1.1.4` that replaces only the `ControlledContainerMixin.started()` bootstrap registration path.

The patched path:

- refuses any SemApps LDP version other than exactly 1.1.4;
- locates exactly one semantic ControlledContainer artifact and exactly one `ldp.registry.register` call;
- invokes the local `ldp.registry` service directly so bootstrap cannot escape to another replica;
- treats the registration itself as the readiness probe;
- retries only SemApps' explicit missing-ontology expansion condition (`Could not expand all types` / `Could not expand predicate`);
- bounds that retry window to 30 seconds with 25 ms polling;
- fails immediately for every other error;
- requires a real registration object before continuing;
- is idempotent and marker-protected;
- leaves normal runtime LDP calls on the standard local-first/distributed routing path.

The retry is side-effect safe for the observed readiness condition because `ldp.registry.register` performs accepted-type expansion before mutating `registeredContainers` or performing container creation. A failed ontology expansion therefore does not partially register the controlled container.

This patch is intentionally upstreamable: SemApps controlled-container bootstrap registration is node-local initialization and should wait for the semantic context required by its accepted types rather than being satisfied by a remote replica merely because that replica is already discoverable.

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
