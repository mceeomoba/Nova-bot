# Zent.md Phase 20b — Hardening, Testing & Rollout: Load/Adversarial Test

Deliverable per Zent.md:

> 20b. Load/adversarial test: opportunity flooding (can Opportunity
> Intelligence be spammed into burning spend on garbage signals?),
> addressed by 2d/2e's caps.

## What this session built

**`backend/src/__tests__/expansionLoadAdversarial.test.ts`** — one new
file, no changes to any existing module. This doesn't re-derive 2d's
tick-counter arithmetic or 3c's de-dup formula (already covered by
`expansionOpportunityIntelligenceTickCap.test.ts` and
`expansionDedup.test.ts`); it drives those same guards, plus 3d's
Top-N selection and 2e's profitability gate, at adversarial *volume* —
thousands of attempted calls against caps in the tens/hundreds — to
answer the phase's own question directly rather than by inference from
unit-level boundary tests alone.

Four scenarios, each a different shape of flood:

1. **Raw call-volume flooding (2d).** 10,000 rapid-fire
   `scan_market_signals` calls against a cap of 100: exactly 100
   succeed, the rest are rejected before any work happens, and
   cumulative spend is asserted to equal exactly `cap * cost_per_tick`
   — not "roughly bounded," the literal number. Also checked: one
   agent's flood never touches another agent's own allowance, and a
   flood spanning a day boundary doesn't carry exhaustion into the
   next day (both already implied by 2d's per-`(agent, day)` counter
   shape, but worth asserting explicitly under volume rather than
   trusting the shape alone).
2. **Near-duplicate flooding (3c).** 500 trivially-reworded copies of
   the same garbage signal ("Amazing Crypto Opportunity" / "AMAZING
   crypto opportunity!!!" / ...) collapse to exactly one scored
   opportunity, not 500 — an attacker who stays *under* the tick cap
   but tries to turn every allowed tick into its own opportunity gets
   caught by de-dup instead. Cross-checked in both directions: 20
   agents flooding the same garbage each still get their own one
   distinct row (de-dup doesn't leak across agents), and genuinely
   distinct signals are never wrongly collapsed (de-dup doesn't
   over-merge).
3. **Fan-out flooding (3d).** Even with 1,000 genuinely-distinct scored
   opportunities sitting open (i.e., an attacker who *did* get past
   both 2d and 3c), Top-N selection still only ever promotes `topN` of
   them to Research per cycle — bounding how many (Research, Finance,
   Strategy) department triples the rest of the pipeline could ever
   spin up from one flood to `topN * 3`, regardless of backlog size.
4. **Profitability revocation mid-flood (2e).** The tick cap isn't the
   only backstop. If the root agent stops being profitable partway
   through an attempted flood (whether via 19c's circuit breaker or
   any other cause), every call after that point is refused outright
   with `not_profitable` — even though the tick counter still had
   hundreds of calls of headroom left. A final test confirms 2d and 2e
   are independent backstops: either one alone still bounds
   cumulative spend, so losing one doesn't silently disable the other.

Same "no live better-sqlite3 in this environment" reason every other
`expansion*.test.ts` file in this directory already gives — this
proves the guards' documented contract holds at adversarial scale
against an in-memory mirror, not the real SQL under real concurrent
load.

## Verified

`npx tsx --test src/__tests__/expansionLoadAdversarial.test.ts` — 10/10
pass. Also re-ran alongside `expansionEndToEnd_test.ts` (20a) and the
three unit-level files this one builds on
(`expansionOpportunityIntelligenceTickCap.test.ts`,
`expansionDedup.test.ts`, `expansionTopNSelection.test.ts`) in one
process to confirm no shared-state interference — 49/49 pass across
all five files together.

Not done (explicitly out of scope for 20b, belongs to later
sub-phases): 20c's `EXPANSION_PIPELINE.md` reference doc, 20d's
staged-rollout dry-run-only gate, 20e's post-launch review checkpoint.
Also out of scope, flagged for whoever picks up a real-infra pass
later: this file doesn't exercise concurrent/racing calls against a
real counter row (two simultaneous requests both reading
count-under-cap before either writes) — that's a real-database
race-condition question the in-memory mirror can't meaningfully model,
and would need the live `better-sqlite3` + real concurrency every
prior phase's own standing note already asks for.
