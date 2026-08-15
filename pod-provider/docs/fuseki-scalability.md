# Fuseki / TDB2 scalability operations

ActivityPods stores Pod and provider RDF through Fuseki. The provider bootstrap script creates persistent datasets as TDB2. Keep TDB2 as the default unless a separately tested storage migration says otherwise.

This guide does not change ActivityPub delivery semantics, APDM recipient planning, or local-delivery concurrency. It covers the storage runtime only.

## Heap tuning

The SemApps Fuseki image accepts `JVM_ARGS` and documents a 1200 MiB default heap. ActivityPods preserves that default and exposes it through `FUSEKI_JVM_ARGS` in Compose.

Example:

```sh
FUSEKI_JVM_ARGS='-Xmx2g' docker compose up -d fuseki
```

Do not automatically allocate all host memory to the Java heap. TDB2 depends heavily on operating-system file cache for its indexes, so excessive heap can compete with storage cache. Tune from observed JVM, request-latency, disk, and host-memory data.

## Health and observability

Use Fuseki's low-cost `/$/ping` administrative endpoint for health rather than an application SPARQL query. Current Apache Fuseki also exposes request statistics at `/$/stats` and, in versions that support it, metrics at `/$/metrics`.

Track query/update latency, HTTP failures, JVM heap and GC pressure, container RSS, host memory pressure, disk latency/free space, `/fuseki` growth, and application-side counts of triplestore and Fuseki requests.

A high request count caused by an application full scan should be fixed at the query/call site before adding hardware.

## Query shape

TDB2 has multiple triple/quad indexes. Exact lookups should lead with the most selective bound predicate/object pattern rather than a broad class pattern on fresh datasets without statistics.

Do not mistake `LIMIT` for bounded execution. A query that must sort or materialize the full matching population before applying `LIMIT` remains population-scale inside Fuseki.

## Compaction

TDB2 databases can accumulate old generations as updates occur. Apache Jena supports live TDB2 compaction. Reads can continue, but writes are held while compaction finishes, so compaction must be an explicit operator action in a quiet window and with an appropriate backup policy.

## Query and update timeouts

Apache Fuseki supports `arq:queryTimeout` and `arq:updateTimeout` in server, dataset, or endpoint configuration. ActivityPods does not inject those settings blindly here because datasets are dynamically created and the SemApps image carries custom WebACL behavior. A timeout rollout must prove dynamic TDB2 creation, WebACL enforcement, normal Pod writes, and long-but-valid maintenance operations first.

## Version migrations

Do not opportunistically jump Jena major versions while measuring APDM. The SemApps image is a customized Fuseki distribution, and Apache Jena major releases can include Java/runtime, module, and store migration considerations. Treat a Fuseki/Jena upgrade as a dedicated compatibility and data-migration PR with backup/restore and authorization tests.

## Scaling priority

1. Remove population-wide application scans and unnecessary repeated Fuseki calls.
2. Verify selective query plans and bounded result production.
3. Observe request, JVM, disk, and host-memory pressure.
4. Tune `FUSEKI_JVM_ARGS` for the actual host while retaining OS file cache.
5. Compact TDB2 when storage growth warrants it and a write-pause window is acceptable.
6. Only then consider a separately tested Fuseki/Jena image migration or larger deployment topology.
