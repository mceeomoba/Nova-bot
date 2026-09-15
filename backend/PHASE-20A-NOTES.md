# Zent.md Phase 20a — Hardening, Testing & Rollout: End-to-End Integration Test

Deliverable per Zent.md:

> 20a. End-to-end integration test: seeded market signal ->
> opportunity -> research -> finance -> strategy -> committee packet ->
> CEO approval -> genesis -> Agent B's first tick, all in one test.

## What this session built

**`backend/src/__tests__/expansionEndToEnd_test.ts`** — one new file, no
changes to any existing module. Every stage's own arithmetic, guard, or
response shape already has a dedicated test elsewhere in this directory
(ROI formula, fit score, runway floor, packet shape, decision finality,
genesis funding clamp, smoke-test classification, activation state
machine); this file doesn't re-derive any of that. What it adds is the
one thing nothing else in this directory does: a single run that pushes
one seeded signal through every stage **in order**, using the same
guard conditions the real pipeline enforces at each handoff, and checks
the chain lands on exactly one `active` Agent B correctly lineaged back
to the opportunity that produced it — Zent.md's own "done when" for
this phase, verbatim.

Same "no live better-sqlite3, no live Docker daemon, no live spawned
Node process, no live chain RPC" reason every other `expansion*.test.ts`
/ `genesis*_test.ts` file in this directory already gives. The first-tick
smoke test stage is a deterministic stand-in (`runFirstTickSmokeTest()`
always returns `passed`) rather than a real spawned-process wait —
`genesisTickSmokeTest_test.ts` already covers every failure branch of
that classifier on its own; re-deriving it here would just duplicate
that file without adding coverage.

### Seven cases, not one

A single "happy path only" test can pass by accident — it doesn't prove
the guards actually gate anything, only that the mirror doesn't throw
on a well-formed run. This file also exercises, in the same file so a
future edit to one guard is checked against the same fixtures as the
happy path:

- **2e** — an unprofitable root agent never gets an opportunity in the
  first place (throws before anything is written).
- **3e** — a below-ROI-floor signal is a *kill*, not a thrown error: no
  opportunity row, no exception, matching "no good ideas this cycle" as
  documented in Zent.md.
- **8e/10b** — Finance's runway floor hard-rejects on its own; Strategy
  refuses to run against a hard-rejected opportunity; the committee
  packet refuses to assemble; no decision, no trigger, no lineage row.
- **13e** — committee packet assembly refuses to run with any of the
  three reports missing, independent of the 8e/10b case above.
- **15b/15d** — a `rejected` CEO ruling stops the chain: no genesis
  trigger, no lineage row, opportunity marked `rejected`.
- **16b** — Finance's Phase 9 sizing number is traced byte-for-byte
  into the fired genesis trigger's `recommendedFundingUsdc`, so the
  wire-up itself (not just each side's own shape) is under test.
- **Happy path** — the full chain, asserting exactly one
  `spawn_reason = 'expansion_pipeline'` lineage row, pointing at the
  right opportunity and parent, and `genesisActivationStatus === 'active'`
  only after the smoke test stage runs (never before).

### On "no human-in-the-loop"

This test does not add, remove, or touch any approval gate. It exercises
the pipeline exactly as Zent.md's own closing note already specifies:
Opportunity Intelligence, Research, Finance, Strategy, the Committee
packet, and the CEO decision are all agent-executed end to end, and an
`approved` ruling fires genesis directly — there is no operator step
anywhere in this chain, by design, and this test's happy-path assertion
(`decideExpansion(packet, "approved", "0xCOMPANY_A")` -> active Agent B,
no further calls) is what proves that design actually holds together
across every handoff, not just within each stage in isolation. The
internal controls that *do* exist — 2e's profitability gate, 3e's ROI
floor, 8e/10b's runway hard-reject, 13e's completeness gate, and (per
19c, exercised via `genesisTickSmokeTest_test.ts` /
`expansionCircuitBreaker.test.ts`, not re-proven here) the smoke-test
circuit breaker — remain exactly as documented: agent-internal checks,
not human ones.

## Verified

`npx tsx --test src/__tests__/expansionEndToEnd_test.ts` — 7/7 pass, 0
failures, matching this directory's existing standalone-run convention
for `_test.ts`/`.test.ts` files (no vitest/jest config needed).

Not done (explicitly out of scope for 20a, belongs to later sub-phases):
20b's adversarial/flooding test, 20c's `EXPANSION_PIPELINE.md`
reference doc, 20d's staged-rollout dry-run-only gate, 20e's
post-launch review checkpoint.
