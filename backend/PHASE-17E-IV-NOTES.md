# Zent.md Phase 17e-iv — Genesis Engine: Active-Status Transition

Deliverable per Zent.md:

> 17e-iv. Active-status transition: only after 17e-ii and 17e-iii both
> pass is Agent B marked `active`; a failing smoke test leaves it in a
> distinguishable pre-active state instead of silently retrying.

## What landed

**`backend/src/genesisActivation.ts`** (new file) — a small, one-shot
state machine: `pending -> active | failed`, and nothing else.

- `markGenesisPending(agentAddress)` — written once, at birth, from
  `genesis.ts`'s `tagCompanyLineage()` (the same call that already
  writes `spawn_reason = 'expansion_pipeline'` / `opportunity_id`,
  Phase 16e). This is the "distinguishable pre-active state," present
  from the instant Agent B exists, before its first tick has run.
- `activateGenesisAgent(opportunityId, agentAddress)` — flips
  `pending -> active` and logs one event. Only actually writes if the
  row is currently `pending`; a second call, or a call against an
  agent that was never pipeline-spawned, is a silent no-op.
- `markGenesisActivationFailed(opportunityId, agentAddress, reason, detail)`
  — flips `pending -> failed`, same one-shot guard. `reason` is
  `'smoke_test_failed'` or `'constitution_violated'`, matching which of
  17e-ii/17e-iii actually threw.
- `getGenesisActivationStatus(agentAddress)` /
  `getGenesisActivationEvent(agentAddress)` — read-only, for whatever
  status UI eventually wants them (Phase 18/20 territory, not built
  here).

**`backend/src/db.ts`**: new `agents.genesis_activation_status` column
(`NULL` for every non-pipeline agent — this is *not* a repurposing of
the existing `agents.status` liveness column, which
`socialGroups.ts`'s death-eviction logic already owns; see the
migration's own comment for why conflating the two would be wrong) plus
a new `genesis_activation_events` table — complete-history log of the
terminal transition, same "own table, not a bolted-on column"
convention `genesis_tick_smoke_tests` (17e-ii) and
`genesis_constitution_checks` (17e-iii) already established.

**`backend/src/genesis.ts`**:
- `tagCompanyLineage()` now also calls `markGenesisPending()`.
- `genesisExecutorAdapter()` now closes the loop 17e-ii/17e-iii each
  left open on their own "not this phase's job" note:
  - 17e-ii (`TickSmokeTestFailure`) → `markGenesisActivationFailed(...,
    'smoke_test_failed', ...)`.
  - 17e-ii passes, 17e-iii (`ConstitutionComplianceFailure`) → in
    addition to the existing `haltExpansionPipeline()` call,
    `markGenesisActivationFailed(..., 'constitution_violated', ...)`.
  - Both pass → `activateGenesisAgent(...)`.

**`backend/src/wallet.ts`**: `GET /:address/lineage`'s `children` list
now selects `genesis_activation_status` explicitly (the `self` object
already gets it for free via `SELECT *`), same parity fix Phase 1e's
migration made for `spawn_reason`/`opportunity_id`.

**`backend/src/__tests__/genesisActivation_test.ts`** (new file):
mirrors the state machine against in-memory fakes (no live
`better-sqlite3`, same constraint every other `genesis*_test.ts` file
in this directory documents). Covers: a `null`-status (self-spawned)
agent is untouched by activate/fail; `markGenesisPending` sets
`pending` without logging an event; `pending -> active`;
`pending -> failed` for both failure reasons, with `detail` carried
through; one-shot idempotency in both directions (activating twice,
and activating after already-failed does not overwrite `failed`); and
`getGenesisActivationStatus` distinguishing "agent doesn't exist"
(`undefined`) from "exists, never pipeline-spawned" (`null`).

## What did *not* land (explicitly out of scope)

- No new HTTP endpoint. `getGenesisActivationStatus()` /
  `getGenesisActivationEvent()` are exported as the same kind of
  read-only seam `getLatestTickSmokeTest()` / `getLatestConstitutionCheck()`
  already are for "any future status UI" — Phase 18/20's job, not this
  one's. The lineage endpoint already surfaces the column for free.
- No retry path. A `failed` agent stays `failed` — there is no code
  anywhere in this pipeline that re-attempts a first tick for an agent
  that has already been born (that would mean a second genesis for the
  same opportunity, which is 20a/scope-of-a-different-phase territory,
  not this one).
- No operator/approval step of any kind, anywhere in this chain, same
  as every other phase in this pipeline: `markGenesisPending`,
  `activateGenesisAgent`, and `markGenesisActivationFailed` are all
  called automatically by `genesisExecutorAdapter()`, with no person
  between a check's verdict and the status write. This closes Zent.md's
  entire 17e sub-phase (i–iv) without a human-in-the-loop step at any
  point from birth to active/failed — consistent with Zent.md's own
  closing note on the whole pipeline.
