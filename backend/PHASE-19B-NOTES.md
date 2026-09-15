# Zent.md Phase 19b — Guardrails, Limits & Kill-Switches: Total-Portfolio Spend Cap

Deliverable per Zent.md:

> 19b. Total-portfolio spend cap: sum of all pipeline-spawned siblings'
> funding cannot exceed a configured fraction of the root's lifetime
> revenue.

## What this session built

`expansionCircuitBreaker.ts`'s own header previously said this needed
"distribution.ts's own accounting" — that was wrong. `distribution.ts`
is Economy 2 (publishing a finished listing to a human-facing channel);
it has no payment data. The real lifetime-revenue figure already
existed: `isEligibleForExpansion()` in `expansion.ts` (Phase 2e) already
computes `revenueUsdc` as the sum of settled `payments` rows where
`to_address = agentAddress`, all-time. 19b reuses that rather than
duplicating it.

Three new pieces in `expansionCircuitBreaker.ts`:

- `getTotalPipelineFundingDisbursedUsdc(rootAgentAddress)` — sums
  `payments.value_usdc` where `from_address = rootAgentAddress AND
  purpose = 'clone-funding' AND status IN ('pending', 'settled')`,
  all-time (not window-scoped, unlike 19a — 19b's own wording is
  "total-portfolio"). `clone-funding` is only ever written by
  `fundGenesisCompany()` in `genesis.ts` (16b), so this is exactly the
  sum of what this root has ever sent to pipeline-spawned siblings.
- `checkPortfolioSpendCapacity(rootAgentAddress)` — computes `capUsdc =
  revenueUsdc * config.portfolioSpendCapFraction` and blocks once
  `disbursedUsdc >= capUsdc`. A root with $0 lifetime revenue has a $0
  cap — correct, not a bug (2e's own profitability gate should already
  keep an unprofitable root out of the pipeline well before this point).
- `checkPortfolioFundingRoom(rootAgentAddress)` — `capUsdc - disbursedUsdc`,
  clamped to never go below 0.

New config: `config.portfolioSpendCapFraction` (env
`PORTFOLIO_SPEND_CAP_FRACTION`, default `0.5`) — deliberately more
permissive than 8d's `expansionCapitalFraction` (0.2), since that one
caps a single report against *current wallet balance* while this one
caps *cumulative lifetime spend* against *lifetime revenue*, a much
larger number for any agent that's been reinvesting. This is the outer
backstop, not the everyday gate.

## Wiring — two checkpoints, same shape as 9b/16b's existing per-call/per-day pair

1. **`genesisCompany()` (genesis.ts), early reject.** Right after 19a's
   `checkGenesisSpawnCapacity()` call and before `createCloneShell()`
   does anything real: `checkPortfolioSpendCapacity(trigger.agentAddress)`
   throws if the root is already at/over its portfolio cap. Same "fail
   before anything is provisioned" posture as every other guard in that
   function.
2. **`fundGenesisCompany()` (genesis.ts), disbursement-time clamp.** The
   existing two-way clamp (`perCallClamped`, `roomLeftToday`) became a
   three-way `Math.min(perCallClamped, roomLeftToday,
   checkPortfolioFundingRoom(fromAddress))`. If the portfolio ceiling is
   what actually zeroed out the amount, `fundingSkippedReason` is now
   `"portfolio-cap-exhausted"` — a new member added to
   `GenesisCompanyResult["fundingSkippedReason"]` alongside the existing
   `"no-recommendation"` / `"day-cap-exhausted"`. Same "clamp to what's
   left, don't error" posture the day-cap clamp already used: a
   recommendation bigger than remaining portfolio room gets clamped
   down to that room, not rejected outright, when some room is left.

Checkpoint 1 catches the common case cheaply (no shell/wallet spun up
for a company that can't be funded at all); checkpoint 2 is what
actually enforces the number once a specific recommendation is on the
table — the same two-chokepoint reasoning 9b/16b's own comments already
give for the per-call/per-day pair.

## Test coverage

Extended `expansionCircuitBreaker.test.ts` (the file added for 19a)
rather than starting a new file, since it already mirrors this module.
34 cases total now (20 new), run via `node --experimental-strip-types
--test`:

```
# tests 34
# suites 6
# pass 34
# fail 0
```

19b-specific coverage: disbursement summing (pending+settled counted,
failed and other-purpose excluded, scoped to the right root, all-time
not windowed); the cap check at zero/below/at/above disbursement, and
the $0-revenue-$0-cap edge case; funding-room math including the
never-negative floor; and the three-way clamp correctly attributing
`"portfolio-cap-exhausted"` vs `"day-cap-exhausted"` to whichever
ceiling actually bound, plus the clamp-down-not-reject case when
partial room remains.

`genesisCompany_test.ts` (16a/16b's own test file) was not modified —
its mirror of `fundGenesisCompany()` predates 19a and doesn't reference
the circuit breaker at all, a gap that predates this session. Extending
that file's mirror to match current reality is worth doing but is a
larger, separate change; flagging it rather than folding it into this
session unannounced.

Ran `tsc --noEmit` against the three touched files (`config.ts`,
`genesis.ts`, `expansionCircuitBreaker.ts`) specifically — zero errors
attributable to any of them. (The repo-wide `tsc` run does surface
pre-existing parse errors in `erc8004.ts` and `expansion.ts`, unrelated
to this session's edits — those files weren't touched here beyond
importing an existing, unchanged export (`isEligibleForExpansion`) from
`expansion.ts`.)

## No human override

Same posture as every other phase in this pipeline, and explicit in
`expansionCircuitBreaker.ts`'s own file header: both 19b checks are read
by `genesis.ts` itself, before it acts — an internal control on the
agent hierarchy's own prior spending, not an operator-facing approval
step. There is no route, config flag, or code path in this change that
lets a human raise, bypass, or override the portfolio cap for a specific
genesis event; the only way past it is the root agent's own lifetime
revenue actually growing.

## Phase 19 status

19a and 19b are now both built, wired, and tested. Still open: 19c's
smoke-test-triggered halt calls (wait on 17e-ii/17e-iii's failure paths
actually calling `haltExpansionPipeline()` — noted as still-open in
PHASE-19A-NOTES.md), 19d (kill/recall path + funding-failure orphan
cleanup + transaction lock, flagged in PHASE-18E-NOTES.md), and 19e
(dry-run mode).
