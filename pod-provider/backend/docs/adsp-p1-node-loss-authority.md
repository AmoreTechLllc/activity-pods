# ADSP P1 node-loss authority gate

This proof closes the Phase-1 requirement that broker node loss/rejoin must not corrupt an in-flight request or silently duplicate authoritative work.

## Failure window exercised

`proof-adsp-p1-node-loss-authority.js` runs against the real Redis Moleculer transporter and deliberately creates the ambiguous failure window that matters for at-most-once authority semantics:

1. a remote `adsp.p1.authorityProbe.commitThenBlock` request is routed to one worker;
2. that worker appends the request token to a shared mutation journal, calls `fsync`, and then deliberately withholds the response;
3. a second worker advertising the same action joins the same namespace;
4. the original serving process is terminated with `SIGKILL` before it can answer;
5. the caller must observe failure/uncertainty rather than a false success;
6. after registry convergence, the original token must still appear exactly once for a replay-observation horizon longer than the full original request timeout;
7. the killed node ID then rejoins and successfully serves a new, distinct mutation exactly once.

The mutation journal is a test authority boundary. It is intentionally external to the killed worker and each record is synchronously written and `fsync`'d before the worker blocks, so process loss after that point cannot erase whether the mutation occurred.

The replay horizon is intentionally tied to the request contract rather than a short fixed sleep. The proof currently uses a 7-second request timeout and then requires the authoritative mutation count to remain exactly one for an additional 8 seconds after the caller has observed failure. Any duplicate that appears during that bounded horizon fails the proof immediately.

## Acceptance criteria

The proof fails unless all of the following are true:

- the first mutation is committed exactly once on the original serving node before failure injection;
- a second eligible service endpoint is present before the original node is killed;
- the original caller does not receive a successful response after the serving process is killed;
- the original mutation token remains exactly once after registry convergence and throughout the full replay-observation horizon;
- the surviving endpoint never receives a silent replay of that token;
- the killed node ID can rejoin after stale-registry convergence;
- a fresh post-rejoin mutation succeeds exactly once on the rejoined node.

## Scope and non-goals

This is a Phase-1 **Moleculer fabric correctness** proof. It establishes that an already-committed authoritative operation is not automatically replayed by the Redis-transporter fabric when the serving process disappears before its response reaches the caller.

It does **not** claim that an ambiguous failed request is safe for an application to retry without an application-level idempotency contract. The caller correctly sees failure/uncertainty and must resolve that ambiguity at the authoritative workload layer.

It also does not replace the Phase-2 whole-system failure gate. Phase 2 must still test real horizontally replicated ActivityPods workloads under node loss and prove that no accepted ActivityPub delivery intent or authoritative Pod mutation is lost or duplicated. This Phase-1 fixture only closes the transporter/fabric replay question before horizontal scale testing begins.
