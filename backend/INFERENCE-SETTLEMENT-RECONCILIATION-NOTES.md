# Inference Settlement Reconciliation Notes

## The gap this closes

`/inference/chat`'s flow is: verify payment → claim nonce → run
inference (local, falling back to OpenRouter) → settle payment → write
usage_log. Settlement failing after inference already succeeded was
already handled *correctly* from a security standpoint — the nonce
reservation stays claimed on purpose, so the same signed authorization
can never be replayed for a second free completion (see
`inferenceGateway.ts`'s own comment on that, and `db.ts`'s comment on
`inference_nonce_reservations`).

But "correct" and "complete" weren't the same thing here. Once
settlement failed, that was the end of the story for the caller: a 402,
a discarded completion the platform had already paid a provider for
(or spent local compute on), and no path back to it except a brand-new
signed authorization — even in the common case where the original
authorization was still perfectly valid (not expired, balance still
there) and the settlement failure was just a transient on-chain/RPC
hiccup that would succeed on a second attempt.

## What changed

**`db.ts`** — new `orphaned_inference_settlements` table. One row per
settlement failure, keyed by the same `nonce` already reserved in
`inference_nonce_reservations`. Stores the full `authorization` +
`signature` (so a retry never needs a new inference call) and the full
`completion` (so a resolved retry can still hand back the actual
result), plus `served_by`/`model_used`/`used_tokens`/`cost_usdc` from
the original call so usage_log gets the figures the agent's budget
actually consumed, not a re-estimate. `status` is one of `unresolved` /
`resolved` / `expired_writeoff`.

**`inferenceGateway.ts`**
- On settlement failure, `recordOrphanedSettlement()` now persists all
  of the above before responding. The 402 response body gains
  `orphanedNonce` and a `reconciliationHint` pointing at the new GET
  route below — callers no longer have to treat `settlement_failed` as
  a dead end.
- `reconcileOrphanedSettlements()` is a background sweep over every
  `unresolved` row:
  - If the authorization's `validBefore` has passed, it's written off
    (`expired_writeoff`) and — only now — its nonce reservation is
    released. Safe specifically because `verifyAuthorization()`'s own
    expiry check means this exact authorization can never pass
    verification again; the reservation was never doing replay
    prevention after that point, just sitting there.
  - Otherwise it retries `settleAuthorization()` against the *exact
    same* authorization + signature — no new inference call, no new
    payment request. On success, this is the point `usage_log` finally
    gets its entry (closing the accounting gap the original request
    left open) and the row moves to `resolved` with its `tx_hash`. On
    failure it just records the attempt and stays `unresolved` for the
    next tick.
  - Registered via `scheduler.ts`'s `runOnScheduleWithLease()` (90s
    cadence, 5min lease) — the same lease-guarded pattern
    `departments.ts`'s `ttl_reaper` uses, not a bare `setInterval`, so
    it's restart-resilient and safe if this backend ever runs as more
    than one process.
- Two new routes:
  - `GET /inference/orphaned/:nonce?agentAddress=0x...` — lets a caller
    that got a `settlement_failed` 402 come back later and either
    retrieve the completion it already paid for (once reconciliation
    resolves it) or learn its authorization was written off and it's
    safe to sign a new one. `agentAddress` is required and checked
    against the row's own owner — this route can return a full
    completion body, so it must not be fetchable by nonce alone.
  - `GET /inference/orphaned?agentAddress=0x...&status=unresolved` —
    operational visibility into an agent's own reconciliation queue,
    same ownership check.

## What didn't change

The settlement-failure security posture itself is untouched: the nonce
still isn't released on first failure, a fresh `/chat` call still can't
replay a settlement-failed authorization, and nothing here weakens the
"never write usage_log until settlement actually succeeds" invariant —
reconciliation just gives that invariant a second chance to be
satisfied by the *same* authorization instead of forcing a new one.
