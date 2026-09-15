# Zent.md Phase 19a — Guardrails, Limits & Kill-Switches: Global Expansion Rate Limit

Deliverable per Zent.md:

> 19a. Global expansion rate limit per root agent: max N companies
> spawned per time window, independent of how many opportunities clear
> the ROI floor — prevents runaway compounding.

## What was already there

The rate-limit logic itself was pulled forward during the 19c
circuit-breaker work (see `expansionCircuitBreaker.ts`'s own header) and
has been live since then:

- `checkGenesisSpawnCapacity(rootAgentAddress)` — counts `agents` rows
  where `parent_address = rootAgentAddress AND spawn_reason =
  'expansion_pipeline'` created within the last `GENESIS_WINDOW_MS`
  (24h), and blocks once that count reaches `MAX_GENESIS_SPAWNS_PER_WINDOW`
  (3).
- Wired at the top of `genesisCompany()` in `genesis.ts:1447`, before
  `createCloneShell()` does anything real — same "fail before anything
  is provisioned" posture as the trigger/decision/opportunity guards
  already in that function.
- `ensureExpansionCircuitBreakerSchema()` called from `index.ts:41` on
  every startup, so the backing table exists without a separate
  migration step.

## What this session added

Nothing in `genesisCompany_test.ts` or elsewhere in `src/__tests__`
exercised this logic directly — the window math, the halt/resume
interaction, and the lineage-scoping rules had no dedicated coverage.
Added `expansionCircuitBreaker.test.ts`, an inlined mirror of
`expansionCircuitBreaker.ts` (same "no live better-sqlite3 in this
environment" convention as every other `*_test.ts`/`.test.ts` file in
this directory). 14 cases, run via `node --experimental-strip-types
--test`:

```
# tests 14
# suites 2
# pass 14
# fail 0
```

Covers:

- Under-cap and zero-prior-spawn cases are allowed.
- At-cap and over-cap cases are blocked, with a reason string naming
  the count, the cap, and the window.
- Window rolls correctly: spawns older than 24h stop counting, including
  a mixed stale/recent case.
- Scoping: `spawn_reason = 'self'` (ordinary `spawn_clone` children)
  never counts against the cap; another root agent's spawns never
  affect this root's capacity.
- A halted root is blocked regardless of spawn count, and the halt
  reason/timestamp surface in the block reason.
- Halting an already-halted root is an upsert (updates reason/timestamp,
  does not duplicate).
- `resumeExpansionPipeline` clears the halt and restores normal
  cap-based evaluation — including the case where the root is still at
  its spawn cap after resuming, so it's correctly blocked again on the
  cap check rather than the halt check.

## No human override

Per Zent.md's own closing notes and `expansionCircuitBreaker.ts`'s file
header: this is an internal control read by `genesis.ts` itself, before
it acts, the same way it already reads trigger/decision state. There is
no operator-facing approval step anywhere in this path — resumption
(`resumeExpansionPipeline`) is deliberately not exposed as an HTTP
route; per 19c it fires from "the root agent's own next Opportunity
Intelligence cycle," not from a human-facing endpoint. This session adds
test coverage only; it does not add, and was not asked to add, any
approval surface.

## Phase 19 status

19a (this file) and 19c's halt-half are complete and now covered by
tests. Still open: 19b (total-portfolio spend cap — needs
`distribution.ts`'s own lifetime-revenue accounting, explicitly deferred
in `expansionCircuitBreaker.ts`'s header), 19c's smoke-test-triggered
halt calls (wait on 17e-ii/17e-iii, which the header notes are already
landed — worth wiring `haltExpansionPipeline()` into their failure
paths next), 19d (kill/recall path + funding-failure orphan cleanup +
transaction lock, flagged in PHASE-18E-NOTES.md), and 19e (dry-run
mode).
