# Worked Example: One Post to 200 Local Followers

This example explains the ActivityPods/SemApps local fan-out scalability problem concretely. It is intentionally local: Alice and all recipients are on the same ActivityPods provider, so no remote HTTP delivery and no Fedify-sidecar execution are involved.

The core defect is not that Moleculer itself is inherently slow. The historical path used **recipient-oriented orchestration**: for each recipient, resolve and perform several independent operations before moving to the next recipient. The architectural direction is **fan-out-oriented orchestration**: resolve shared state once, reuse already-authoritative context, batch same-authority operations where semantics permit, and otherwise process recipients with bounded concurrency.

## Scenario

Alice has 200 followers on the same ActivityPods provider. She creates a public Activity addressed to ActivityStreams Public and `alice/followers`.

## Historical visible orchestration model

The historical SemApps local path first resolved the sender/followers collection, then performed local-recipient classification and a sequential `localPost()` loop.

At the visible service-call layer, the useful approximation was:

```text
2 fixed calls + 6 calls per local recipient
```

The two fixed calls were approximately:

1. resolve Alice's actor;
2. expand Alice's followers collection.

For each local recipient, the historical path then visibly performed:

1. `auth.account.findByWebId(recipient)` during local/remote partitioning;
2. `auth.account.findByWebId(recipient)` again inside `localPost()` to recover the dataset;
3. `activitypub.actor.getCollectionUri(recipient, 'inbox')`;
4. `activitypub.collection.add(inbox, activity)`;
5. `ldp.remote.store(activity, { webId: recipient })`;
6. `activitypub.activity.attach(activity, { webId: recipient })`.

That produces the historical top-level model:

| Local recipients | Historical visible calls |
|---:|---:|
| 10 | 62 |
| 200 | 1,202 |
| 1,000 | 6,002 |
| 10,000 | 60,002 |

This model was useful for identifying obvious duplicate work, but it was never a complete operation count. `collection.add`, `ldp.remote.store`, `activity.attach`, actor/collection resolution, WebACL, and triplestore operations fan into additional Moleculer actions and Fuseki HTTP requests underneath.

## Why the original loop shape was pathological

Historically, `localPost()` effectively behaved like:

```js
for (const recipientUri of recipients) {
  const account = await findAccount(recipientUri);
  const inbox = await resolveInbox(recipientUri);
  await addToInbox(inbox, activity);
  await storeForRecipient(activity, recipientUri);
  await attachForRecipient(activity, recipientUri);
}
```

The recipient operations are largely independent, yet the next recipient could not begin until the previous recipient's chain completed. This made wall-clock time grow approximately linearly with recipient count while also repeating authority/discovery work.

The architectural problem is therefore **recipient-oriented orchestration with repeated nested work**, not an inter-process/network-hop problem and not a claim that Moleculer is intrinsically unsuitable.

## Current fork: what has already changed

The historical `2 + 6N` model must not be presented as current master behavior.

### Phase 7 removed the duplicate account lookup

APDM Phase 7 preserves the first authoritative `auth.account.findByWebId` used to classify the recipient as local, carries the resolved dataset forward in request-local non-serialized context, and lets `localPost()` reuse it.

At the same visible orchestration layer, the post-P7 shape is therefore closer to:

```text
2 fixed calls + 5 calls per local recipient
```

The remaining visible per-recipient work still includes local classification plus inbox resolution, collection insertion, LDP storage, and Activity attachment. Phase 7 removes one known duplicate; it does not make local delivery O(1).

### Phase 9 removed strict serial recipient scheduling

APDM Phase 9 replaced the one-recipient-at-a-time loop with a fixed-size bounded worker pool. The measured normal production default is concurrency `4`, with deterministic result ordering and a hard configured ceiling.

That means current master no longer requires Bob's entire delivery chain to finish before Carol's starts. It also deliberately does **not** use unbounded `Promise.all(recipients)` fan-out, because trading sequential latency for uncontrolled Node/Fuseki memory and I/O pressure would be another scalability defect.

Phase 9 is a scheduling improvement, not a claim that the underlying per-recipient persistence work disappeared.

## Measured nested reality is much larger than `5N` or `6N`

APDM Phase 8 instrumented the real running ActivityPods path, including nested Moleculer actions and correlated Fuseki HTTP requests. The canonical pre-Phase-9 measurements were:

| N | elapsed | nested Moleculer actions | Fuseki HTTP requests |
|---:|---:|---:|---:|
| 1 | 1.354 s | 938 | 318 |
| 10 | 2.900 s | 1,465.7 | 586.3 |
| 100 | 25.171 s | 6,611.7 | 3,202.3 |
| 200 | 50.537 s | 12,286.3 | 6,093.7 |
| 1,000 | 333.538 s | 57,911.3 | 29,303 |

The fitted large-scale signal was roughly **57 additional nested Moleculer actions and 29 additional Fuseki HTTP requests per added local recipient**.

For the 200-local-follower example, the measured system is therefore not merely doing roughly 1,000 visible service calls. It averaged about **12,286 nested Moleculer actions and 6,094 Fuseki requests** for the complete traced root. That empirically replaces the earlier illustrative assumption that each visible call probably fans into several hidden operations.

## Why bounded concurrency alone is insufficient

Phase 9 demonstrated that bounded concurrency improves wall-clock time, but action/Fuseki work stayed nearly invariant. With concurrency 4, large cases became materially faster while still performing approximately the same underlying datastore work.

That is expected: concurrency overlaps independent waits; it does not remove them.

The remaining objective is to reduce **work per successfully delivered recipient** while preserving Pod authority and LDP/WebACL semantics.

## Fan-out-oriented target design

The conceptual target is:

```js
const recipients = await resolveRecipients(activity);
const localAccounts = await resolveLocalAccountsBounded(recipients);

await processRecipientsWithBoundedConcurrency(localAccounts, async recipient => {
  // Reuse already-authoritative context.
  // Batch/selectively read metadata where safe.
  // Preserve per-Pod persistence and ACL authority.
  await deliverLocally(recipient, activity);
});
```

Where semantics and dataset authority permit, deeper operations may become bounded bulk/selective operations. But a single cross-dataset SPARQL write covering all local Pods is **not automatically valid**: ActivityPods intentionally has per-Pod dataset isolation and WebACL/LDP semantics. Optimization must respect those boundaries rather than flattening every recipient into one global datastore authority.

The preferred sequence is therefore:

1. resolve shared/authoritative state once;
2. remove duplicate lookups;
3. make metadata reads selective and scoped;
4. batch only within valid authority boundaries;
5. use bounded concurrency for independent per-Pod work that cannot safely be bulked;
6. measure the new dominant nested work;
7. optimize persistence without skipping LDP/WebACL/collection/activity semantics;
8. make per-recipient completion durable so recovery does not replay already-successful recipients.

## Current phase mapping

- **P7:** removed the duplicate local account/dataset lookup.
- **P8:** replaced the old `6N + O(1)` intuition with real nested measurements.
- **P9:** replaced strict serial delivery with an evidence-selected bounded c4 worker pool.
- **P10:** targets repeated dataset-existence metadata round trips while keeping the optimization disabled until real OFF/ON evidence closes.
- **P11:** reserved for the remaining dominant persistence-path amplification after the P10 baseline is known.
- **P12:** durable per-recipient completion/recovery so partial failure does not require replaying completed local recipients.

## Local versus remote terminology

This worked example is **local Tier 1** scalability. It never reaches remote federation execution.

Remote ActivityPub has a related but different historical problem: duplicate routing/execution authority and repeated recipient/inbox work across SemApps and the sidecar. APDM P1-P6 resolves that ownership problem so ActivityPods plans/signs and the Fedify sidecar is the sole external HTTP executor in production external mode.

Both local and remote work share the same design principle—do not repeatedly rediscover or re-execute already-known work—but their authority boundaries and optimization mechanisms are different.
