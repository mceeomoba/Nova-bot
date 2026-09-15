# Zent.md Phase 16b — Genesis Engine: Funding Wire-Up

Deliverable per Zent.md:

> 16b. Funding wire-up: Finance's Phase 9 sizing recommendation becomes
> the actual `spawn_clone` funding argument, clamped to the existing
> per-call/per-day caps — Finance proposes, the cap still governs.

## What landed

Agent B used to come out of Phase 16a's `genesisCompany()` at zero
balance — real wallet, real sandbox, real constitution, no money.
Finance's `recommendedFundingUsdc` was sitting on the `genesis_triggers`
row (written at Phase 15d) but nothing spent it. This phase spends it.

Two pieces:

1. **`wallet.ts`: `signPaymentAuthorization()`.** The `/:address/pay`
   route's signing logic (self-custody check, capability check, payment-
   channel check, EIP-3009 `signTypedData`, department-spend logging)
   is now an exported function the route itself calls. Same move
   `facilitator.ts`'s `settleAuthorization()` already made ahead of this
   phase — an in-process caller (this phase's `genesis.ts`) gets a
   signed authorization without a self-HTTP round trip. The route's own
   observable behavior — status codes, error bodies, response shape —
   is unchanged; every check that used to live inline now lives in the
   exported function, in the same order, surfaced via `.status` on a
   thrown `Error` that the route's own `try/catch` turns back into the
   same `res.status(...).json({ error })` it always sent.

2. **`genesis.ts`: `fundGenesisCompany()`**, called from `genesisCompany()`
   right after the shell/wallet exist, before the trigger is marked
   `completed`. Clamps twice — both hard ceilings, not suggestions:

   - Never more than `config.maxCloneFundingUsdcPerCall` for one
     opportunity, whatever Finance recommended.
   - Never lets the parent's own same-UTC-day clone-funding total exceed
     `config.maxCloneFundingUsdcPerAgentPerDay`. Read straight off the
     `payments` table (`purpose = 'clone-funding'`, `status IN
     ('pending','settled')`, today's UTC window) rather than a new
     counter table — `db.ts`'s own comment already names
     `'clone-funding'` as this purpose string's documented example.

   Then signs (`signPaymentAuthorization`) and settles
   (`facilitator.ts`'s `settleAuthorization`) — the same two-call
   sequence every other USDC transfer in this backend goes through.
   `paymentChannelRequired()`'s existing Day-1 clone-funding carve-out
   (`channelService.ts`) is what lets this sign without a payment
   channel: Agent B's `parent_address` is the funder, and this is
   necessarily Agent B's first-ever payment.

## No human override, by design

Same posture as 16a's own header, made explicit for the part of this
pipeline that actually moves money: nothing between the CEO's
`approved` ruling and a real on-chain USDC transfer requires a person to
click, confirm, or sign anything. `decideExpansion()` → `fireGenesisTrigger()`
→ `genesisCompany()` → `fundGenesisCompany()` → `signPaymentAuthorization()`
→ `settleAuthorization()` is one synchronous call chain (with one
async boundary `fireGenesisTrigger()` already handles — see its own
comment on `genesisExecutor`'s `Promise` case). The only two things that
can stop a real disbursement are:

- **Finance's own $0 recommendation** (`fundingSkippedReason:
  "no-recommendation"`) — an internal department decision, not an
  external gate.
- **The day-cap already being spent** (`fundingSkippedReason:
  "day-cap-exhausted"`) — a fixed, pre-configured ceiling, not a
  per-event judgment call by anyone.

Both are "Agent B still gets born, just at $0 today" outcomes, not
failures — `genesisCompany()` still marks the trigger `completed` and
returns a normal result either way. A genuine failure (the facilitator
rejects the transfer — bad signature, insufficient balance, RPC error)
*does* propagate, same as a `createCloneShell()`/`createClonedAgentWallet()`
failure already did: the trigger is left `pending`/marked `failed` by
`fireGenesisTrigger()`'s own catch, and the CEO's ruling itself is left
alone.

## What this doesn't do

- **No retry.** A `failed` trigger from a funding error doesn't
  auto-retry — same as 16a's own note on this, Phase 19d's kill/recall
  path is the nearest fit in Zent.md's own plan, not something this
  session adds.
- **No partial-provisioning cleanup.** If `fundGenesisCompany()` throws,
  Agent B's shell and wallet already exist — a real, zero-funded company
  is left behind. Flagged, not fixed, in `genesis.ts`'s own comment;
  same category of known gap as 16a's retry note.
- **Staged funding (Zent.md 9c)** isn't wired to disbursement here —
  Finance's own initial/follow-on split is still just modeled, per 9c's
  own text ("modeled, not yet wired to disbursement — that's Phase 16").
  This phase disburses one lump sum (the clamped recommendation), not a
  staged tranche.
- **16d (tool grant scoping) and 16e (`company_lineage` tagging)** are
  still untouched, exactly as 16a's own header already flagged.

## Tests

`src/__tests__/genesisCompany_test.ts` extended with an in-memory mirror
of `fundGenesisCompany()` (no live better-sqlite3/Docker/chain RPC in
this environment, same reason every other `expansion*.test.ts` file
already gives) — 7 new cases alongside the existing 10:

- happy path: signs + settles for the clamped amount, purpose
  `clone-funding`, no operator step
- a recommendation under the per-call cap is funded exactly, not topped
  up to the cap
- `null` / `<= 0` recommendation → `$0`, `"no-recommendation"`, no sign
  call, trigger still `completed`
- same-day cap: a second same-day genesis from the same parent is
  clamped to what's left; a third gets `$0` /
  `"day-cap-exhausted"` once the day's cap is spent — genesis itself
  still completes
- the day cap is tracked per parent, not globally
- a facilitator settlement failure throws and leaves the trigger
  `pending`, not `completed`

`node --test src/__tests__/genesisCompany_test.ts`: 17/17 passing.
`node --experimental-strip-types --check` clean on `wallet.ts`,
`genesis.ts`, and the test file (no live `npm install`/`tsc` in this
environment — recommend a full `tsc --noEmit` pass once one is
available).
