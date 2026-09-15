# Zent.md Phase 11e-ii-a — Fit Score: Computation Tool

Deliverable per Zent.md:

> 11e-ii-a. Tool: `score_strategy_fit(opportunity_id)` — reads the
> opportunity's current 11c mission-overlap finding and 11d
> technology-reuse finding, applies 11e-i's formula, and writes
> `fit_score` into that opportunity's current `strategy_findings` row
> (superseding on re-run, same versioning research/finance findings
> already use).

## What shipped

- **`backend/src/expansion.ts`** — new Phase 11e-ii-a section, inserted
  right after 11e-i's `FitScoreFinding`:
  - `mergeIntoCurrentStrategyFinding()` — the first read-merge-write
    helper for `strategy_findings`, same shape as Phase 5/8's
    `mergeIntoCurrentResearchFinding()`/`mergeIntoCurrentFinanceFinding()`.
    First real caller of `createStrategyFinding()` (3816) in this file.
  - `deriveMissionComplementarityFactor()` — turns 11c's
    `checkMissionOverlap()` entries into the 0-100
    `missionComplementarity` factor, keyed off the *worst* relationship
    present (duplicates → 0, competes → 25, complements-only → 75-100
    scaled by tag overlap, no entries at all → 50 "genuinely unknown").
  - `deriveTechnologyReuseDepthFactor()` — turns 11d's
    `checkTechnologyReuse()` entries into the 0-100
    `technologyReuseDepth` factor: the top entry's own `reuseScore`
    (already documented as the headline number for exactly this),
    scaled from 0-1 to 0-100; 0 if no siblings have anything reusable.
  - `ScoreStrategyFitOptions` — the caller-supplied escape hatch for
    `ecosystemDiversificationValue`/`marketIndependence`, the two
    Phase-12 factors nothing in this codebase can derive yet. Optional,
    additive to `score_strategy_fit(opportunity_id)`'s single required
    argument; each defaults to 0 (11e-i's own "no signal yet" floor).
  - `scoreStrategyFit(opportunityId, options?)` — the tool itself: reads
    11c/11d live, derives the two factors above, runs
    `validateFitScoreFactors()`/`computeFitScore()` (11e-i), and writes
    `{ fit_score: FitScoreFinding }` onto the opportunity's current
    strategy finding via `mergeIntoCurrentStrategyFinding()`.
- **`backend/src/expansionRoutes.ts`** — `POST
  /expansion/opportunities/:id/strategy/score-fit`, the tool surface.
  Same ownership chain (agentAddress must match the opportunity's
  report owner) every Phase 5/8/9 write route already enforces; body
  validation for the two optional Phase-12 factors; 400 on invalid
  factors, 404/403 on a missing/not-owned opportunity.
- **`backend/src/toolRegistrySeedData.ts`** — new `"strategy fit
  scoring"` capability, granting `score_strategy_fit`, added to
  `strategy`'s row in `DEPARTMENT_TOOL_PROFILES` (previously `[]`).

## What's deliberately NOT here yet

- **No guard against 11c/11d "not having run."** `checkMissionOverlap()`/
  `checkTechnologyReuse()` are pure functions with no persisted
  run-state of their own — there's nothing to gate on beyond
  `opportunityId` resolving to a real opportunity. Zent.md's own
  11e-ii-b ("can only run once 11c and 11d have both produced a
  non-superseded finding") is a separate, later sub-phase.

  **Superseded by 11e-ii-b** — see `PHASE-11E-II-B-NOTES.md`.
  `scoreStrategyFit()` now requires `recordMissionOverlapCheck()`/
  `recordTechnologyReuseCheck()` to have filed their results first, and
  reads factors from those persisted records rather than recomputing
  11c/11d live.
- **No `strategy-fit-score.test.ts`.** Zent.md assigns formula
  arithmetic + guard tests to 11e-ii-c.
- **No tick-capacity limiter** on the new route, unlike Finance's
  `hasFinanceTickCapacity`. No equivalent per-strategy-tick quota
  exists anywhere in `resourceQuotas.ts`/`config.ts` yet; inventing one
  here would be scope creep beyond this tool. The department's own
  `spend_cap_daily_usdc` (set at spawn time) is what currently governs
  this.
- **11b-11d's own tools (`list_existing_companies`, `check_mission_
  overlap`, `check_technology_reuse`) are still not wired as their own
  `toolRegistrySeedData.ts` capabilities.** `strategy`'s row was `[]`
  before this session despite Zent.md 11e's claim that 11a-11d
  "already shipped" — that gap predates this change and is called out
  in-line rather than left to look resolved by this session's edit.

  **Partially closed by 11e-ii-b** — `check_mission_overlap`/
  `check_technology_reuse` are now wired, but as their new PERSISTING
  wrappers (11e-ii-b's `recordMissionOverlapCheck()`/
  `recordTechnologyReuseCheck()`), not the original plain-read tools
  named here. `list_existing_companies` (11b) remains unwired.
