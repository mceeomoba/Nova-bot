# Zent.md Phase 17e-ii — Genesis Engine: Full-Tick Completion Assertion

Deliverable per Zent.md:

> 17e-ii. Full-tick completion assertion: run one tick to completion and
> assert no unhandled error, timeout, or crashed sandbox — the "done
> when" for whether the loop itself runs at all.

## What landed

**`backend/src/genesisSmokeTest.ts`** (new file):

- `runFirstTickSmokeTest(opportunityId, agentAddress, sandboxId)` — runs
  `automaton --tick-once` (17e-i, `agent/src/index.ts`) inside Agent B's
  own sandbox via `execInNamedSandbox()` (`docker.ts`), and classifies
  the result into exactly the three categories Zent.md names, no more:
  - `timeout` — `execInNamedSandbox`'s own `timedOut` flag fired
    (`config.genesisTickSmokeTestTimeoutMs` elapsed).
  - `unhandled_error` — the process exited, but non-zero (17e-i's own
    `--tick-once` branch in `index.ts` catches a thrown tick and calls
    `process.exit(1)`).
  - `crashed_sandbox` — the `execInNamedSandbox()` call itself threw
    (dockerode throws when the target container isn't running —
    stopped, OOM-killed, removed — a different failure than the command
    inside it exiting badly).
  - `passed` — exited 0, no timeout.
- Writes one row to a new `genesis_tick_smoke_tests` table
  unconditionally (pass or fail — a complete history, not just a
  failure log), then throws `TickSmokeTestFailure` (carrying the full
  `TickSmokeTestResult`) for any non-`passed` outcome.
- `getLatestTickSmokeTest(agentAddress)` — read-only convenience for
  17e-iii/iv and any future status UI; not used by the write path
  itself.

**`backend/src/db.ts`**: new `genesis_tick_smoke_tests` table (own
table, not a column on `genesis_triggers` — a trigger's status means
"did the approved decision get provisioned," already true by the time
this ever runs; a failed first tick doesn't retroactively un-happen the
birth, and more than one smoke-test row per agent is an expected
history, not exceptional, so no UNIQUE constraint). Created inline in
`db.ts`'s existing unconditional `db.exec()` sequence, right after
`genesis_triggers`, same as every other table in that file — no
separate `ensure*Schema()`/index.ts wiring needed for the table itself
(unlike `expansionCircuitBreaker.ts`'s pulled-forward table, which
predates this file's normal db.ts-owns-its-own-tables convention).

**`backend/src/config.ts`**: `genesisTickSmokeTestTimeoutMs` (default 3
minutes) and `genesisTickSmokeTestMaxOutputBytes` (default 2MB) — their
own constants, not reused from `execTimeoutMs`/`execMaxOutputBytes`
(30s / 1MB), because a real agent-loop tick (bootstrap + inference +
tool execution) legitimately runs far longer and can log more than an
ordinary `/vm/exec` shell command, and every non-genesis caller of
those two still needs them to stay short.

**`backend/src/genesis.ts`**: `genesisExecutorAdapter()` — the function
`fireGenesisTrigger()` (expansion.ts) actually calls — now runs
`runFirstTickSmokeTest()` immediately after `genesisCompany()` resolves,
before returning. This is the "wiring": Agent B's first tick now runs
automatically, with no operator step between birth and that tick,
exactly as 17e-i's own header anticipated ("genesis.ts (backend) ...
invokes this by shelling out to `automaton --tick-once`") and as
19c's circuit-breaker comment assumed would eventually exist ("the
smoke-test result these key off of doesn't exist until 17e-ii/17e-iii
land").

A thrown `TickSmokeTestFailure` is caught and swallowed inside the
adapter, not re-thrown. `fireGenesisTrigger()`'s own catch treats any
rejection from this adapter as a *provisioning* failure and marks the
genesis trigger `'failed'` — correct for a thrown wallet/funding/DB
error during `genesisCompany()` itself, wrong for a bad first tick on a
company that was, in fact, successfully provisioned, funded, and
tagged. Agent B is a real company either way; the failing outcome is
already on record in `genesis_tick_smoke_tests` (written by
`runFirstTickSmokeTest()` before it throws) by the time this catch
runs. Any *other* error out of `runFirstTickSmokeTest()` (not a
`TickSmokeTestFailure` — i.e. a bug in the harness itself, not one of
its three documented outcome categories) is not swallowed; it
propagates the same way a `genesisCompany()` failure would.

## What this deliberately does NOT do

- **Does not call `haltExpansionPipeline()`.** That function
  (`expansionCircuitBreaker.ts`) is explicitly reserved, in its own
  header, for 17e-iii/17e-iv — deciding whether a failed *loop*
  (this phase's whole concern) should halt the pipeline for a root
  agent is a judgment those later phases still need to make. This
  phase's job ends at "ran / didn't run to completion, here's why."
- **Does not evaluate what the tick did.** Tool calls made, turns
  completed, constitution/guard compliance — all 17e-iii, untouched
  here. A tick that completes cleanly but violates its constitution is,
  by this file's own classification, `passed` — 17e-iii is where that
  gets caught.
- **Does not transition any active-status field.** No `agents` table
  status is read or written here. 17e-iv reads whatever 17e-ii/17e-iii
  land (this table, plus whatever 17e-iii adds) to decide that; this
  phase doesn't anticipate that shape.

## No human override, by design — same posture as every prior phase

`runFirstTickSmokeTest()` is called unconditionally from
`genesisExecutorAdapter()`, which is itself called unconditionally by
`fireGenesisTrigger()` the instant the CEO's `approved` decision fires
genesis (Phase 15d) — there is no approval, review, or confirmation
step anywhere between "Agent B was just born" and "Agent B's first real
tick has now run." Same caveat as every other Zent.md phase's notes in
this codebase: this is true *of this pipeline specifically*; it does
not touch, weaken, or route around the separate, already-built,
operator-only `constitution-guard.ts` mechanism Agent B still inherits
unmodified via 17b, nor any other genuinely operator-gated control
elsewhere in this codebase.

## Sanity checks

No `node_modules`/live Docker daemon in this environment, so no real
`tsc`/live smoke test — same caveat every genesis-family change in this
repo already carries. Checked instead:

- Brace/paren/bracket balance on every edited/new file:
  - `genesisSmokeTest.ts` (new): 21/21 braces, 49/49 parens, 1/1 brackets.
  - `genesis.ts`: 168/168 braces, 570/570 parens, 17/17 brackets.
  - `config.ts`: 19/19 braces, 276/276 parens, 10/10 brackets.
  - `db.ts`: 79/79 braces, 26/26 brackets — balanced. Parens read
    1023/1022 (one short), but that mismatch is pre-existing in the
    original upload (1011/1010, confirmed by diffing against the
    untouched zip before this session's edit) — almost certainly an
    apostrophe inside a comment elsewhere in this 2,600+ line file, not
    anything in the block this session added (checked in isolation:
    13/13 parens, 0/0 braces).
- Manual read-through of `execInNamedSandbox()`'s real signature and
  return shape (`docker.ts`) against every field this file reads off
  it (`stdout`, `stderr`, `exitCode`, `timedOut`) — matches exactly,
  same shape `vmService.ts`'s own `/vm/exec` route already consumes.
- Manual read-through of `GenesisCompanyResult` (`genesis.ts`) to
  confirm `result.agentAddress` / `result.sandboxId` are both real,
  already-populated fields by the time `genesisExecutorAdapter()` reads
  them (they are — set from `wallet.address` / `wallet.sandboxId`
  earlier in `genesisCompany()`).
- Confirmed `crypto.randomUUID()` id-generation convention matches
  `knowledgeStore.ts`'s own `addKnowledge()`, rather than introducing a
  different id scheme for this table.
- Added `backend/src/__tests__/genesisTickSmokeTest_test.ts`, same
  in-memory-mirror style as `genesisCompany_test.ts` (no live Docker
  daemon here): mirrors `runFirstTickSmokeTest()`'s classification
  logic against a fake `execInNamedSandbox` with each of the four
  outcomes (including the exec call throwing, for `crashed_sandbox`),
  and asserts the row shape / thrown-vs-returned behavior for each.
  Ran standalone: `npx tsx --test
  src/__tests__/genesisTickSmokeTest_test.ts` — all cases pass.

Next real step, same as every other genesis-family file here: re-run
against the real `docker.ts`/`genesis.ts` (not the mirror) once there's
a networked environment with a live Docker daemon, including at least
one real end-to-end pass where the sandboxed `automaton --tick-once`
process is deliberately killed mid-run to confirm `crashed_sandbox`
fires the way the mirror predicts.

This closes 17e-ii. 17e-iii (constitution/guard compliance check on the
tick) and 17e-iv (active-status transition gated on both ii and iii)
remain unbuilt, per Zent.md's own phase split.
