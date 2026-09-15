# Zent.md Phase 20e — Hardening, Testing & Rollout: Post-Launch Review Checkpoint

Deliverable per Zent.md:

> 20e. Post-launch review checkpoint: after the first real Agent B is
> spawned, a scheduled review of whether the ROI/fit scores it was
> approved on actually held up — feeds back into tuning 3b's formula.

This is the last sub-phase of Phase 20 and the last phase in `Zent.md`.

## What this session built

Six files changed — like 20d, this is a real feature (measurement +
scheduling), not just a test:

**`backend/src/db.ts`** — `post_launch_reviews`, one row per
pipeline-spawned agent (`UNIQUE(agent_address)`). `predicted_roi_score`
/ `predicted_fit_score` / `recommended_funding_usdc` are snapshotted at
scheduling time, not re-read live at completion — see the table's own
comment for why. Every `actual_*` column is nullable; a `'pending'` row
is a schedule, not a partial result.

**`backend/src/config.ts`** — `postLaunchReviewWindowDays` (default 30,
env-overridable): how long after Agent B goes active before there's
enough operating history to grade against.

**`backend/src/postLaunchReview.ts`** (new file) — the actual feature:

- `computeActualOutcomeMetrics(agentAddress, recommendedFundingUsdc)` —
  a documented, deterministic 0–100 composite: 50% whether Agent B is
  currently profitable (reusing 2e's own `isEligibleForExpansion()`
  formula, applied to Agent B's own address), 30% whether it's still
  active (never frozen/killed, never `genesis_activation_status =
  'failed'`), 20% revenue-since-birth as a fraction of what it was
  funded with, capped at 1.0. Same "documented, not left to the model
  to invent" posture 3b's `ROI_WEIGHTS` and 11e-i's
  `FIT_SCORE_WEIGHTS` already take.
- `schedulePostLaunchReview(opportunityId, agentAddress)` — called
  once, right when an agent activates (see the `genesis.ts` hook
  below). Idempotent via the table's own unique constraint.
- `runDuePostLaunchReviews()` — the sweep: grades every pending review
  whose due date has passed, writes the actual metrics plus a
  calibration delta (`actualOutcomeScore - predictedRoiScore`, banded
  into `formula_overestimated` / `formula_underestimated` /
  `formula_calibrated` at a ±15-point threshold, mirroring 11e-iii-a's
  own fit/roi divergence banding), marks the row `completed`.
- `summarizeRoiCalibration(rootAgentAddress?)` — Zent.md's own "feeds
  back into tuning 3b's formula" line, made concrete: an aggregated,
  plain-language suggestion across every completed review for one root
  (or globally). Requires at least 5 completed reviews before
  suggesting anything — below that, always "insufficient data,"
  regardless of what the available deltas look like.

**`backend/src/genesis.ts`** — one line added to
`genesisExecutorAdapter()`: `schedulePostLaunchReview()` is called
immediately after `activateGenesisAgent()` succeeds, in the same
"only for an agent that actually cleared 17e-ii/17e-iii" branch
`registerGenesisIdentity()` (18a) already sits in.

**`backend/src/expansionRoutes.ts`** — four new routes, all reads
except one manual-trigger POST for operational visibility:
`GET /agents/:agentAddress/post-launch-review`,
`GET /agents/:rootAgentAddress/post-launch-reviews` (list + per-root
calibration summary), `GET /calibration-summary` (global), and
`POST /post-launch-reviews/run-due` (forces a sweep without waiting for
the next scheduled tick — useful in a test/staging environment). None
of these gate or alter the pipeline itself; they only ever read what
the scheduled sweep already wrote.

## Why the calibration signal is advisory, not an auto-mutation

`summarizeRoiCalibration()` produces a suggestion string; nothing in
this phase writes back into `ROI_WEIGHTS` or `FIT_SCORE_WEIGHTS`
automatically. This is a deliberate scope decision, not a caution
gate on the pipeline itself (which remains exactly as agent-executed
and operator-free as every prior phase — `decideExpansion()`/genesis
fire exactly as before; this module only ever reads their outcomes,
never blocks them). The reason is closer to ordinary engineering
judgment than to a safety concern: a handful of post-launch reviews is
a genuinely small, noisy sample to redefine a formula every other
opportunity in the pipeline gets scored against, and 3b's own header
already treats those weights as a considered, documented constant —
that would be true regardless of who or what was asking for the
formula to auto-tune itself. "Feeds back into tuning" is read as
"produces the signal a deliberate tuning pass would consume," which is
exactly what `summarizeRoiCalibration()` and its `MIN_REVIEWS_FOR_SUGGESTION`
floor deliver.

## Verified

`npx tsx --test src/__tests__/expansionPostLaunchReview.test.ts` — 9/9
pass: idempotent scheduling (a second call doesn't overwrite the
snapshot), a review isn't graded before its due date even if the sweep
runs, both ends of the outcome-score formula (a fully profitable/active/
revenue-recovered agent scores 100; an unprofitable/killed agent with
no revenue scores 0), a delta inside the ±15 band reads as calibrated
rather than a miss, the sweep only grades reviews actually due, the
insufficient-data floor, systematic-overestimation detection once
enough reviews agree, and per-root scoping (one root's bad calibration
doesn't pollute another's summary).

Full suite (`src/__tests__/*.test.ts src/__tests__/*_test.ts`, 53
files): 1275 tests, 1268 pass, 7 fail — the same 7 pre-existing
failures flagged in `PHASE-20D-NOTES.md`, reconfirmed via a side-by-side
run against the untouched pristine zip. All 9 new tests pass.

`npx tsc --noEmit`: identical error count and file list to the pristine
zip (same two files, `erc8004.ts` and `expansion.ts`, same relative
position — a pre-existing environmental artifact, not something this
session's changes affect). None of the five changed/new files
(`db.ts`, `config.ts`, `postLaunchReview.ts`, `genesis.ts`,
`expansionRoutes.ts`) appear anywhere in the error output. Full `tsc`
against real dependency types isn't available in this environment (no
`node_modules`, no network to install one) — recommend re-running once
that's available, same standing note every other phase gives.

## Zent.md Phase 20 — complete

With 20e done, every sub-phase of Phase 20 (20a–20e) — the last phase
in `Zent.md` — is built. See the status note at the top of `Zent.md`
itself and `backend/EXPANSION_PIPELINE.md`'s own Testing section for
the full cross-reference.
