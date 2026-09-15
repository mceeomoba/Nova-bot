# Zent.md Phase 19c — Guardrails, Limits & Kill-Switches: Circuit Breaker

Deliverable per Zent.md:

> 19c. Circuit breaker: if any pipeline-spawned Agent B fails its
> first-tick smoke test (17e-ii–iv) or violates its constitution within
> its first N ticks, the pipeline auto-halts new genesis events for
> that root agent and logs the failure; the root agent's own next
> Opportunity Intelligence cycle can re-evaluate and resume once the
> cause is addressed.

## What was already there

- `expansionCircuitBreaker.ts`'s halt/resume mechanics
  (`haltExpansionPipeline()`, `resumeExpansionPipeline()`,
  `getHaltedState()`, the `expansion_circuit_breaker` table) — pulled
  forward ahead of Phase 19 itself, per that file's own header, and
  covered by `expansionCircuitBreaker.test.ts` since 19a.
- `checkGenesisSpawnCapacity()` (19a) already reads the halted state
  and blocks `genesisCompany()` outright for a halted root — the
  "auto-halts new genesis events" half of 19c's contract.
- The **constitution** half of 19c's two triggers: `genesis.ts`'s
  `genesisExecutorAdapter()` already called `haltExpansionPipeline()`
  on a `ConstitutionComplianceFailure`, landed alongside 17e-iii
  (`PHASE-17E-III-NOTES.md`).

## What this session added

The other documented 19c trigger — **"fails its first-tick smoke
test"** — was not wired. `genesisExecutorAdapter()`'s
`TickSmokeTestFailure` branch called `markGenesisActivationFailed()`
only; it never called `haltExpansionPipeline()`. Flagged as open in
`PHASE-19A-NOTES.md` ("19c's smoke-test-triggered halt calls ... worth
wiring `haltExpansionPipeline()` into their failure paths next").

**`backend/src/genesis.ts`** — `genesisExecutorAdapter()`'s
`TickSmokeTestFailure` catch branch now calls `haltExpansionPipeline()`
for the root agent (`ctx.agentAddress`, not `result.agentAddress` —
same root/child distinction the constitution branch already observed),
symmetric with that branch, before `markGenesisActivationFailed()`.
Both branches now:

1. Halt the root agent's pipeline (`haltExpansionPipeline`).
2. Mark Agent B's own activation as failed with the matching reason
   (`smoke_test_failed` / `constitution_violated`).
3. Leave the genesis trigger itself `'completed'` — Agent B is a real,
   already-provisioned company either way, per this function's own
   header (unchanged).

Doc comments updated in both `genesis.ts` (the function header) and
`expansionCircuitBreaker.ts` (the file header and
`haltExpansionPipeline()`'s own docstring) to describe both triggers
as wired, rather than the constitution-only state those comments
previously described.

**`backend/src/__tests__/genesisExecutorAdapter_test.ts`** (new file)
— nothing in this directory exercised `genesisExecutorAdapter()`
directly (confirmed by grep before writing this file). Inlined mirror
of its control flow, same "no live better-sqlite3" convention every
other `genesis*_test.ts` file here already uses. 6 cases, run via
`node --experimental-strip-types --test`:

```
# tests 6
# suites 1
# pass 6
# fail 0
```

Covers: `TickSmokeTestFailure` halts the root and marks
`smoke_test_failed`, without reaching the constitution check or
activation; `ConstitutionComplianceFailure` halts the root and marks
`constitution_violated`, without reaching activation; the happy path
never halts and does activate/register; an error that is neither
documented failure type rethrows without halting; and both halt calls
key off the *root* address even when it's textually distinct from
Agent B's own address (catches a root/child argument swap).

Re-ran `expansionCircuitBreaker.test.ts` (34 cases, unchanged) after
this session's doc-comment edits to that file — still 34/34.

Scratch `tsc --noEmit --skipLibCheck` against `genesis.ts` +
`expansionCircuitBreaker.ts` together: zero errors attributable to
either file (the one line of output is `tsconfig.json` present/
commandline-files warning, unrelated to this session's edits). Same
"not a real project-wide build, no `node_modules` here" caveat every
prior session's notes give.

## No human override

Same posture as every other phase in this pipeline. Both of 19c's
triggers are read and acted on entirely inside `genesisExecutorAdapter()`
— no operator decides which tick failures count, no route or config
flag lets a human clear a halt for a specific root (`resumeExpansionPipeline()`
is still not exposed as an HTTP route, unchanged this session); the
only way past a halt is the root agent's own next Opportunity
Intelligence cycle, per Zent.md's own wording.

## Phase 19 status

19a, 19b, and 19c are now all built, wired, and tested. Still open:
19d (kill/recall path + funding-failure orphan cleanup + transaction
lock, flagged in `PHASE-18E-NOTES.md`) and 19e (dry-run mode).
