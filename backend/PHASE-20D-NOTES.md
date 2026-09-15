# Zent.md Phase 20d — Hardening, Testing & Rollout: Staged Rollout

Deliverable per Zent.md:

> 20d. Staged rollout: dry-run mode (19e) only, for the first real
> profitable agent in production, before enabling real genesis.

## What this session built

Unlike 20a/20b (pure test files, no source changes) and 20c (docs
only), 20d is a real feature — a rollout gate needed real code, not
just a mirror test proving one. Five files changed:

**`backend/src/db.ts`** — one new column, one new table, same
guarded-ALTER migration convention 19e's own `dry_run_mode` column
uses:

- `expansion_pipeline_config.rollout_stage` (`'dry_run_only'` |
  `'live_enabled'`), **defaulting to `'dry_run_only'`** — the one place
  in the 14a/19e/20d config family where a missing row means
  *most*-restrictive rather than least-restrictive, because this
  column guards a rollout safety property, not a feature toggle.
- `rollout_graduation_events` — an audit trail (one row per
  graduate/demote transition), mirroring `genesis_activation_events`'
  own shape rather than overwriting `rollout_stage` silently.

**`backend/src/config.ts`** — `rolloutGraduationMinDryRunPackets`
(default 3, env-overridable), the threshold `checkRolloutGraduationEligibility()`
checks against.

**`backend/src/expansion.ts`** — the actual gate, six new exports:

- `getRolloutStage(agentAddress)` — reads the column, defaults to
  `'dry_run_only'`.
- `isDryRunModeEffective(agentAddress)` — `true` if EITHER the agent's
  own 19e toggle is on, OR the root hasn't graduated yet. This is now
  what `decideExpansion()` reads at ruling time instead of the raw 19e
  `isDryRunModeEnabled()` — a one-line change at the actual Phase 15d
  fork point, so an un-graduated root cannot escape dry-run by simply
  flipping its own toggle.
- `checkRolloutGraduationEligibility(agentAddress)` — the deterministic
  formula, three independent required conditions: (1) at least
  `rolloutGraduationMinDryRunPackets` completed dry-run genesis packets
  recorded for this root, (2) no active 19c circuit-breaker halt, (3)
  `isEligibleForExpansion()` (2e) still holds. Same "documented, not
  left to the model to invent" posture 3b/11e-i's formulas already
  take.
- `graduateToLiveGenesis(agentAddress)` — re-verifies eligibility
  itself before writing (doesn't trust a caller's stale read), flips
  the column, writes one audit event. Idempotent: an already-graduated
  root fails its own eligibility check with that exact reason, so a
  second call throws before writing anything.
- `demoteToDryRunOnly(agentAddress, reason)` — the regression path, not
  in Zent.md's own 20d text, added as defense-in-depth alongside 19c.
- `listRolloutGraduationEvents(agentAddress)` — read-back for the audit
  trail.

**`backend/src/expansionCircuitBreaker.ts`** — one line added to
`haltExpansionPipeline()` (19c): every halt now also calls
`demoteToDryRunOnly()`. A circuit-breaker trip after graduation
doesn't just pause new spawns anymore — it also revokes the
live-genesis privilege until the root re-earns it. A root that was
never graduated: harmless no-op, confirmed by its own test.

**`backend/src/expansionRoutes.ts`** — two new routes, same
self-only-agent-in-the-URL shape the 19e dry-run-config routes already
use:

- `GET /agents/:agentAddress/rollout-status` — current stage, full
  eligibility snapshot, and history. Read, no ownership check, same
  posture the dry-run-packets GET route already takes.
- `POST /agents/:agentAddress/graduate` — the only place `rollout_stage`
  ever moves to `'live_enabled'`. Thin wrapper around
  `graduateToLiveGenesis()`, which does the actual re-verification.

## On "no human override"

This phase's entire point is a safety gate, which makes it worth being
precise about what kind of gate it is. `POST /agents/:agentAddress/graduate`
is callable only by the agent whose own address is in the URL — there
is still no operator-facing settings surface anywhere in this
pipeline, and `graduateToLiveGenesis()` re-checks the same
deterministic, code-owned formula regardless of what the calling agent
claims. The gate isn't a human in the loop; it's the pipeline requiring
itself to have already produced real evidence (a minimum number of
full, honest dry runs, with the circuit breaker clear and 2e's
profitability check still passing) before it's allowed to spend real
funding on its own account. That's the same shape every other
guardrail in this system takes (2e, 8e/10b, 19a/19b/19c) — internal,
deterministic, and enforced at the one function every caller already
has to go through, not a queue waiting on a person.

## Verified

`npx tsx --test src/__tests__/expansionStagedRollout.test.ts` — 11/11
pass. Full suite (`src/__tests__/*.test.ts src/__tests__/*_test.ts`,
53 files): 1266 tests, 1259 pass, 7 fail — confirmed via a side-by-side
run against the untouched pristine zip that those same 7 failures
(`cloning-config.test.ts`, `cloning-lineage.test.ts`,
`expansionUiListView.test.ts`, `resourceQuotas.test.ts`,
`toolGrantsLiveRoundTrip.test.ts`, a `toolRegistrySeedData` subtest,
`vaultOverride.test.ts`) pre-date this session's changes and are
unrelated to the expansion pipeline. All 28 new tests across this
session's three files (20a's 7, 20b's 10, 20d's 11) pass.

`npx tsc --noEmit` shows the same 45 pre-existing errors on both the
modified tree and a freshly-unzipped pristine copy — same file
(`expansion.ts`), same relative position in the file, none referencing
any new symbol this phase added (`rollout`, `graduat`, `getRolloutStage`,
`isDryRunModeEffective` all grep clean in the error output). Full `tsc`
against real dependency types isn't available in this environment (no
`node_modules`, no network to install one) — recommend re-running once
that's available, same standing note every other phase gives.

Not done (explicitly out of scope for 20d, belongs to 20e): the
post-launch review checkpoint — what happens after a root graduates
and runs real genesis for the first time. This phase only builds the
gate that makes that moment deliberate and evidenced, not what comes
after it.
