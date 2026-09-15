# Zent.md Phase 11e-ii-b — Fit Score: Computation Guard

Deliverable per Zent.md:

> 11e-ii-b. Guard: `score_strategy_fit` can only run once 11c and 11d
> have both produced a non-superseded finding for the opportunity —
> mirrors the `strategy_requires_completed_research_report` /
> `..._finance_report` guards already in `departments.ts`.

## The problem with reading this literally

`checkMissionOverlap()` (11c) and `checkTechnologyReuse()` (11d) are
pure functions with no persisted row of their own — 11e-ii-a's own
notes already flagged this. Unlike `research_findings`/
`finance_findings`, which genuinely can be absent until some tool
writes to them, there was no "has 11c/11d run yet" state anywhere to
check. Building the guard the mirrored `departments.ts` way — a
presence check on a persisted finding — required giving 11c and 11d
something to check the presence *of* first.

## What shipped

- **`backend/src/expansion.ts`**, new Phase 11e-ii-b section:
  - `MissionOverlapCheckRecord` / `TechnologyReuseCheckRecord` — the
    `{ entries, checkedAt }` shape each persisted check is filed under.
  - `recordMissionOverlapCheck(opportunityId)` /
    `recordTechnologyReuseCheck(opportunityId)` — new, additive
    persisting wrappers. Each calls the corresponding pure 11c/11d
    function and files the result onto the opportunity's current
    strategy finding via `mergeIntoCurrentStrategyFinding()`, under
    `mission_overlap` / `technology_reuse`. An empty `entries` array is
    still a valid, filed check — "no overlap detected" is a completed
    result, not a missing one, same posture 3e's kill condition already
    takes for "no good ideas this month."
  - `checkMissionOverlap()`/`checkTechnologyReuse()` themselves are
    **unchanged** — same signature, same pure behavior, same existing
    tests (`expansionMissionOverlap.test.ts`/
    `expansionTechnologyReuse.test.ts`). These are new callers, not a
    rewrite.
  - `MissingStrategyFitPrerequisitesError` — thrown by
    `scoreStrategyFit()` (status 409) naming whichever of
    `check_mission_overlap`/`check_technology_reuse` hasn't been filed
    yet. Same shape as `MissingFinancePrerequisitesError` (9b).
  - `scoreStrategyFit()` updated: now reads `mission_overlap`/
    `technology_reuse` off the opportunity's *current strategy finding*
    (not a live `checkMissionOverlap()`/`checkTechnologyReuse()` call),
    throwing the new error if either key is absent. This also makes
    `fit_score` traceable to the exact snapshot that was reviewed,
    rather than whatever siblings happen to exist at score-time — the
    same auditability posture Finance's `finance_audit_log` already
    commits to.
- **`backend/src/expansionRoutes.ts`** — two new routes:
  - `POST /expansion/opportunities/:id/strategy/check-mission-overlap`
  - `POST /expansion/opportunities/:id/strategy/check-technology-reuse`

  Same ownership chain every Phase 5/8/9 write route enforces. The
  existing `GET .../mission-overlap` / `GET .../technology-reuse` routes
  (11c/11d's own plain reads) are untouched.

  Also fixed the `score-fit` route's inner error handler, which
  previously hardcoded `res.status(400)` for any `scoreStrategyFit()`
  error — that would have wrongly reported the new 409 prerequisite
  error as a 400. Now `res.status(err.status || 400)`, matching the
  `err.status || 500` pattern this file's outer catches already use.
- **`backend/src/toolRegistrySeedData.ts`** — `"strategy fit scoring"`
  now grants all three tools in the guarded sequence:
  `check_mission_overlap`, `check_technology_reuse`,
  `score_strategy_fit` (previously just the last one).

## What's deliberately NOT here yet

- **No `strategy-fit-score.test.ts`.** Still 11e-ii-c's own deliverable
  — formula arithmetic plus this guard's two missing/present branches.
- **11b's `list_existing_companies` remains unwired** in
  `toolRegistrySeedData.ts`. Only 11c/11d gained tool-registry entries
  this session, and only in their new persisting form — the plain GET
  reads stay exactly as they were, ungranted.
- **No retroactive backfill.** An opportunity whose Strategy department
  already called the OLD (pre-this-session) `score_strategy_fit` has no
  `mission_overlap`/`technology_reuse` keys on its finding and will now
  hit `MissingStrategyFitPrerequisitesError` on the next call — correct
  per the guard, but worth knowing if replaying against fixtures from
  before this change.
