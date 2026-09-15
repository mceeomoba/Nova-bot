# Zent.md Phase 17e-iii — Genesis Engine: Constitution/Guard Compliance Check

Deliverable per Zent.md:

> 17e-iii. Constitution/guard compliance check on that tick: verify the
> tick's actions passed the same three-law constitution checks (17b) as
> any ordinary tick — a tick that completes but also violates its
> constitution should not pass the smoke test.

## What landed

**`backend/src/genesisConstitutionCheck.ts`** (new file):

- `checkTickConstitutionCompliance(opportunityId, agentAddress)` — runs
  immediately after 17e-ii's `runFirstTickSmokeTest()` resolves without
  throwing (a tick that never completed has no actions to evaluate).
  Opens Agent B's own `state.db` (`config.agentIdentityDataDir/
  {agentAddress}/state.db` — the same path `genesis.ts`'s
  `provisionAgentRuntimeIdentity()` already wrote into Agent B's
  `automaton.json` before its first tick ran) **read-only**, and checks
  two things:
  1. **Policy compliance** — every row in `policy_decisions` for that
     tick was `'allow'`. `deny`/`quarantine` decisions are what
     `agent/src/agent/policy-engine.ts` and its `policy-rules/*.ts`
     files already write whenever a tool call is rejected — that
     machinery *is* the three-law constitution's runtime enforcement in
     this codebase, so a non-`allow` row here means Agent B's first
     tick already tried something its own immune system had to stop.
  2. **File integrity** — `agent/src/soul/constitution-guard.ts`'s own
     `constitution_compromised` KV flag. This is a distinct failure
     mode from (1): not "tried something forbidden" but "the law itself
     may have been tampered with" — checked first, since it disqualifies
     regardless of whether any tool call was denied.
  - Because this only ever runs once, immediately after Agent B's
    *first* tick, every `policy_decisions` row present at check time
    was necessarily produced by that tick — no timestamp windowing
    needed (and `policy_decisions.created_at` is a SQLite
    `datetime('now')` string, not an epoch, so windowing would need its
    own timezone-safe comparison for no benefit here).
  - Classifies into three outcomes, not two: `passed`, `violated`, or
    `unavailable` (state.db missing/unreadable/missing tables — a
    tick that crashed before the runtime ever initialized its own DB is
    not evidence of a constitution violation, so it gets its own
    category rather than being folded into either `passed` or
    `violated`).
  - Writes one row to a new `genesis_constitution_checks` table
    unconditionally (pass or fail — same complete-history convention
    `genesis_tick_smoke_tests` already uses), then throws
    `ConstitutionComplianceFailure` (carrying the full
    `ConstitutionCheckResult`, including the `violations` array and
    `constitutionFileCompromised` flag) for any non-`passed` outcome.
- `getLatestConstitutionCheck(agentAddress)` — read-only convenience
  for 17e-iv and any future status UI; not used by the write path
  itself.

**`backend/src/db.ts`**: new `genesis_constitution_checks` table (own
table, same reasoning `genesis_tick_smoke_tests` already documents —
this is a distinct, independently-retryable concern from "did the loop
run at all," so no UNIQUE constraint and no column bolted onto an
existing table).

**`backend/src/genesis.ts`**: `genesisExecutorAdapter()` now calls
`checkTickConstitutionCompliance()` right after a successful 17e-ii
smoke test (skipped entirely if the smoke test itself failed — see that
branch's own comment). A `ConstitutionComplianceFailure` is caught and
swallowed the same way `TickSmokeTestFailure` already is — the genesis
trigger stays `'completed'`, Agent B is a real, already-provisioned
company either way — but unlike a bad-loop failure, it also calls
`expansionCircuitBreaker.ts`'s `haltExpansionPipeline()` for the
**root** agent (`ctx.agentAddress`, not `result.agentAddress` — Agent
B is the child just born), fulfilling the 19c trigger
(`expansionCircuitBreaker.ts`'s own header) explicitly: *"violates its
constitution within its first N ticks"* now halts that root's
Opportunity Intelligence cycle from firing new genesis events until the
next cycle re-evaluates.

**`backend/src/__tests__/genesisConstitutionCheck_test.ts`** (new
file): mirrors `checkTickConstitutionCompliance()`'s classification
logic against in-memory fakes for Agent B's `policy_decisions`/`kv`
rows (no live `better-sqlite3` file in the test sandbox, same
constraint every other `genesis*_test.ts` file in this directory
already documents). Covers: clean pass; a single `deny`; a `quarantine`
(not just `deny`); constitution-file compromise alone; both failure
modes at once; an unreadable/missing state.db (`unavailable`, a third
category, not folded into `violated`); one row written per attempt
regardless of outcome; and `ConstitutionComplianceFailure.result`
matching the row written for that attempt.

## What did *not* land (explicitly out of scope)

- **17e-iv** (active-status transition) — nothing here changes Agent
  B's `status` column. `haltExpansionPipeline()` only stops the *root*
  agent's future genesis events; Agent B itself is not marked
  `active`/held back based on this check. `getLatestConstitutionCheck()`
  is exported specifically as the seam 17e-iv can read from once it
  exists — same pattern `getLatestTickSmokeTest()` already established
  for it.
- **19b** (total-portfolio spend cap) — untouched, same as
  `expansionCircuitBreaker.ts`'s own header already notes for 19a/19c.
- No operator/approval step of any kind was added anywhere in this
  chain. `checkTickConstitutionCompliance()` runs automatically,
  `genesisExecutorAdapter()` reads its verdict automatically, and
  `haltExpansionPipeline()` fires automatically — consistent with every
  other phase in this codebase and with Zent.md's own closing note that
  "there is no human-in-the-loop step anywhere in this pipeline." What
  *is* preserved is the constitution's own Law III clause ("Preserve
  legitimate human oversight requested by your creator") — this check
  is exactly that: oversight requested once, structurally, by the
  pipeline's design, not exercised ad hoc by an operator per event.
