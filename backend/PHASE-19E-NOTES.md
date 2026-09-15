# Zent.md Phase 19e — Guardrails, Limits & Kill-Switches: Full-Pipeline Dry-Run Mode

Deliverable per Zent.md:

> 19e. Full-pipeline dry-run mode: run Phases 2–15 to completion, produce
> a genesis-ready packet, but stop short of 16 — for testing the whole
> reasoning chain without actually spending funding.

## What this session built

**No new department, no new pipeline path.** The entire point of 19e is
that Phases 2–15 run *exactly* as they always do — every department,
every scoring/finding/report function, committee assembly, and
`requireDecidableCommitteePacket()`'s own completeness/lock/vote gates
are completely untouched by this phase. The only fork this session adds
is inside `decideExpansion()`, at the single moment an `approved` ruling
would otherwise call `fireGenesisTrigger()`.

**`backend/src/db.ts`**
- `expansion_pipeline_config.dry_run_mode` — one more column on the
  existing Phase 14a config table, guarded `PRAGMA table_info` +
  `ALTER TABLE` (same convention Phase 19d's `agents.frozen` migration
  uses), rather than a new table — it's the same shape of per-agent
  on/off switch `deliberation_enabled` already is on that table. Off by
  default; a missing row or a row that predates this column both read
  back `false`.
- `dry_run_genesis_packets` (new table) — one row per opportunity that
  reached an `approved` ruling while dry-run mode was on for its agent.
  Stores the same `GenesisTriggerContext`-shaped fields the real fire
  path builds (`recommended_funding_usdc`, `notes`) plus the full
  `CommitteePacket` as JSON, frozen at decision time. `UNIQUE(opportunity_id)`
  mirrors `genesis_triggers`' own one-fire-per-opportunity index —
  belt-and-braces alongside 15c's finality gate, which already stops a
  second `approved` ruling on the same opportunity from reaching either
  path twice.
- Deliberately its own table, not a `status='dry_run'` value bolted onto
  `genesis_triggers`: a dry-run packet never represents even an
  *attempted* provisioning call (no `genesisExecutor` is ever invoked —
  that's the entire point of this phase), whereas every
  `genesis_triggers` row means "firing it was attempted," per that
  table's own header. Keeping them separate keeps "was genesis actually
  fired for this opportunity" a single well-defined question.

**`backend/src/expansion.ts`**
- `isDryRunModeEnabled(agentAddress)` / `setDryRunModeEnabled(agentAddress, enabled)`
  — same shape as 14a's `isDeliberationEnabled()`/`setDeliberationEnabled()`,
  read fresh every time (never cached onto the opportunity, packet, or
  decision), so flipping the switch mid-cycle governs whatever
  `approved` ruling happens next, not whatever was true when the
  opportunity was first scored.
- `recordDryRunGenesisPacket()` / `getDryRunGenesisPacket()` /
  `listDryRunGenesisPackets()` — the write and the two read shapes.
  `listDryRunGenesisPackets()` exists specifically for Zent.md 20d's
  staged-rollout case ("dry-run mode only... before enabling real
  genesis") — reviewing every packet a root agent's dry-run cycles have
  produced so far, before an operator or the agent itself decides to
  flip the switch off.
- `decideExpansion()` — the actual fork. At the `approved` branch, reads
  `isDryRunModeEnabled()` for the opportunity's agent (via the same
  `resolveOpportunityAgentAddress()` the real fire path already uses):
  dry-run on → `recordDryRunGenesisPacket()`, dry-run off → the
  unchanged Phase 15d `fireGenesisTrigger()` path. `DecideExpansionResult`
  now carries both `genesisTrigger` and `dryRunPacket`, mutually
  exclusive on every result — exactly one of the two is non-null for an
  `approved` ruling, and both are null for `rejected`/`deferred`, same
  as before this phase.

**`backend/src/expansionRoutes.ts`**
- `POST /expansion/agents/:agentAddress/dry-run-config`,
  `GET /expansion/agents/:agentAddress/dry-run-config` — same shape as
  the existing 14a deliberation-config pair; the agent's own way of
  flipping its switch, no operator surface.
- `GET /expansion/opportunities/:id/dry-run-packet` — the single packet
  for one opportunity, 404 if none was ever produced.
- `GET /expansion/agents/:agentAddress/dry-run-packets` — every packet
  an agent has ever produced, most-recent-first (the 20d review list).
- `POST /opportunities/:id/decide`'s response now includes `dryRunPacket`
  alongside the existing `genesisTrigger` field.

## Why this doesn't add a human-in-the-loop step

Same posture every other Phase 19 sub-phase's notes are explicit about:
dry-run mode is an **agent-toggled config flag**, not an operator gate.
The top-level agent turns it on or off itself, the same way it already
turns deliberation on or off (14a). Nothing about this phase pauses a
ruling for review, requires a person to look at anything, or holds a
decision open waiting on confirmation — `decideExpansion()` still
returns synchronously, still records the CEO's ruling as final, and
still does exactly one of two things unconditionally in the same call:
fire genesis for real, or produce the dry-run packet. The only thing
"dry run" changes is which of those two happens — never *whether*
something happens, and never who (or what) decides that.

## Test coverage

`backend/src/__tests__/expansionDryRun.test.ts` (new) — inlined mirror,
same `node --experimental-strip-types --test` convention every other
`expansion*.test.ts` file in this directory already uses (this
environment has no live `better-sqlite3` build). Built directly on top
of the same minimal opportunity/decision/genesis-trigger scaffolding
`expansionCeoDecision.test.ts` already established, extended with the
dry-run config switch and its fork. Covers:
- default-off / per-agent isolation / required-agentAddress validation
  for `isDryRunModeEnabled()`/`setDryRunModeEnabled()`.
- dry-run ON: `approved` produces a packet, `genesisTrigger` stays null,
  no `genesis_triggers` row is ever written, and the stand-in
  `genesisExecutor` is never called (0 invocations) — the actual "no
  spend" assertion.
- dry-run OFF (the default): `approved` fires genesis exactly as before
  this phase, `dryRunPacket` stays null.
- `rejected`/`deferred` never produce a packet, even with dry-run mode
  on.
- toggling the switch off after a packet was already produced doesn't
  retroactively erase that packet — history stays intact.
- the switch is read fresh at ruling time, not cached from when the
  opportunity was created (flipped on *after* creation, *before* the
  ruling, still governs).
- the underlying write primitive refuses a duplicate packet for the
  same opportunity (mirrors the real table's `UNIQUE(opportunity_id)`),
  even though `decideExpansion()`'s own 15c finality gate already makes
  a second `approved` ruling on the same opportunity unreachable in
  practice.
- `genesisTrigger`/`dryRunPacket` are mutually exclusive on every
  result, checked across both a dry-run and a live agent in the same
  test.

Ran standalone: `node --experimental-strip-types --test
src/__tests__/expansionDryRun.test.ts` — 10/10 pass, 0 failures.

Also ran a scratch `tsc --noEmit --skipLibCheck` pass (stubbed
third-party module types, same posture every prior session's "Sanity
check" section in this repo takes) against `expansion.ts`,
`expansionRoutes.ts`, and `db.ts` together. The only errors reported are
inside `expansion.ts`'s Phase 15e section, at the same line offset
relative to file length as the *original, unmodified* upload — diffed
directly against a fresh copy pulled from this session's own starting
zip to confirm byte-for-byte it's the same pre-existing parse quirk
`cont.md`'s own notes already flagged ("a pre-existing unrelated parse
error... confirmed byte-identical to the original upload, not touched
this pass"), not something introduced by this session's edits. Brace/
paren/bracket balance is clean on both edited files
(`expansion.ts`: 932/932 braces, 2721/2721 parens, 321/321 brackets;
`expansionRoutes.ts`: 1190/1190 braces, 1859/1859 parens, 32/32
brackets).

## Phase 19 status

19a, 19b, 19c, 19d, and now 19e are built and wired. Phase 19 is
complete. Still open from 19d's own notes: `expansionKillSwitch.test.ts`
(flagged there, not built this session either — out of scope for 19e).

Next real step per Zent.md's own Phase 20: 20a's end-to-end integration
test, and 20d's staged rollout ("dry-run mode (19e) only, for the first
real profitable agent in production, before enabling real genesis") —
which this phase's `listDryRunGenesisPackets()` exists specifically to
support.
