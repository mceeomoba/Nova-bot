# Zent.md Phase 11e-iii — Fit Score: Divergence & Reporting

Deliverable per Zent.md:

> 11e-iii-a. Divergence field: when `fit_score` and the opportunity's
> `roi_score` (Phase 3) disagree by more than a configured threshold,
> tag the finding `fit_roi_divergence` — the concrete signal Phase 13c's
> "disagreement surfacing" will read.
>
> 11e-iii-b. `compile_strategy_report` (12d) picks up `fit_score` and
> any `fit_roi_divergence` tag as first-class fields, not buried
> prose — keeps parity with how 7a/9e structure their reports.
>
> 11e-iii-c. `GET /expansion/opportunities/:id/strategy` (12e) response
> includes `fit_score` and divergence status; its shape test is
> extended to assert both are present.

This closes Phase 11e entirely: formula (11e-i), computation tool +
guard (11e-ii-a/b/c), and now divergence + reporting (11e-iii-a/b/c),
all in one session — 11e-iii's own Zent.md entry doesn't carry 11e-ii's
"split into three build sessions" note, so a/b/c land together here.

## A note on build order vs. phase numbering

11e-iii-b/c read literally as Phase 12 deliverables (`compile_strategy_
report` is parenthetically tagged `12d`, the GET route `12e`) — Strategy's
ecosystem-health tools (12a `assess_ecosystem_strengthening`, 12b the
cannibalization check, 12c the relationship-type recommendation) haven't
shipped yet, so a *complete* Phase 12 report can't be assembled here.
Rather than block on that, this session ships the same compile-report /
GET-route *shape* every other department already has (7a/7c for
Research, 9e/10a for Finance), scoped honestly to what Strategy has
actually produced so far: 11c's mission-overlap check, 11d's
technology-reuse check, and 11e's `fit_score` + `fit_roi_divergence`.
`STRATEGY_REPORT_SCHEMA_VERSION` is stamped `"11e-iii-v1"` — the actual
phase that built it — not `"12d-v1"`; when Phase 12 ships its own three
tools it adds their fields to `StrategyReport` and bumps this to
whatever version name that session picks, the same way any schema
change anywhere else in this file already works. Nothing here
pre-guesses Phase 12's own shape.

## What shipped

- **`backend/src/config.ts`** — added `fitRoiDivergenceThreshold`
  (env: `FIT_ROI_DIVERGENCE_THRESHOLD`, default `30`), next to
  `fitScoreWeights`, same "tunable without touching department logic"
  posture every other threshold in this file already takes. Documented
  reasoning for the default: half of either formula's largest
  single-factor swing (a full 0-100 move on a 0.35-weighted top
  factor) — wide enough that two independently-evidenced formulas
  disagreeing a little isn't noise, narrow enough that a real
  "Opportunity Intelligence loves this, Strategy doesn't" split still
  trips it.

- **`backend/src/expansion.ts`**:
  - `FitRoiDivergence` interface + `computeFitRoiDivergence(fitScore,
    roiScore)` — pure function, no DB access, same split every other
    scoring/classification function in this file keeps from its own
    persisting caller. `roiScore === null` always yields
    `diverges: false` with a `null` delta (an unscored opportunity
    isn't "divergent," it's missing one of the two numbers), never a
    thrown error or a fabricated number.
  - `scoreStrategyFit()` updated to compute the divergence verdict
    against the opportunity's current `roi_score` and merge it onto
    the *same* `strategy_findings` write as `fit_score` — one call,
    one version, both fields always paired. `StrategyFitScoreResult`
    gained a `divergence` field alongside the existing `fitScore`/
    `missionOverlap`/`technologyReuse`.
  - `StrategyReport` interface, `compileStrategyReport(opportunityId)`,
    `STRATEGY_REPORT_SCHEMA_VERSION`, `STRATEGY_REPORT_FIELDS`, and
    `validateStrategyReportShape()` — the 7b/9e-style locked contract,
    scoped to `missionOverlap`/`technologyReuse`/`fitScore`/
    `fitRoiDivergence`, each nullable (Strategy's own tools can run in
    any order, any subset, same posture `compileResearchReport()`
    already takes toward 5b/5c/5d/6a/6b/6c). Self-checks its own output
    before returning, same as its Research/Finance counterparts.

- **`backend/src/expansionRoutes.ts`**:
  - `POST /opportunities/:id/strategy/compile-report` — tool-call
    surface, same ownership chain (`agentAddress` must match the
    opportunity's owning report) every Phase 5/8/11 write route here
    already enforces. Always 200 for a known opportunity; the one real
    error is an unknown `opportunity_id`.
  - `GET /opportunities/:id/strategy` — plain read, no ownership check
    beyond the shared `BACKEND_API_KEY` middleware, same posture 7c's
    `GET /research` already takes (Finance/the CEO gate/the eventual
    committee packet all need to read this without "owning" it).
  - Both share `sendCompiledStrategyReport()` — compiles, re-verifies
    against the locked shape at the HTTP boundary, sends
    `{opportunityId, schemaVersion, strategyReport}` — so the two
    surfaces can never quietly drift from each other.

- **`backend/src/__tests__/expansionFitRoiDivergence.test.ts`** (new).
  10 tests, run with
  `node --experimental-strip-types --test src/__tests__/expansionFitRoiDivergence.test.ts`.
  All passing. Same "no live better-sqlite3" mirrored-fixture posture
  every other file in this directory takes. Coverage:
  - `computeFitRoiDivergence` — flags divergence above threshold, not
    at or under it (strictly greater-than); symmetric regardless of
    which score is higher; `null` `roiScore` always yields
    `diverges: false` with no fabricated delta; the verdict records
    the threshold actually applied; delta rounds to 2 decimals.
  - Pairing contract — `fit_score`/`fit_roi_divergence` land on the
    same finding version in one merge; a re-run supersedes the prior
    version but keeps both fields paired on the new one, and earlier
    unrelated keys (`mission_overlap`) survive the merge forward.

- **`backend/src/__tests__/expansionStrategyReportShape.test.ts`**
  (new). Mirrors `expansionFinanceReportShape.test.ts`'s structure
  exactly: locked-field-set checks (missing/extra/renamed field),
  scalar type checks, `schemaVersion` exact-match checks, nullable-
  object-section checks — plus two tests specific to 11e-iii-c's own
  requirement that `fitScore` and `fitRoiDivergence` are present as
  first-class top-level fields (not nested in prose), and one test
  documenting that the shape check does not itself enforce the
  fit-score/divergence *pairing* invariant (that's `scoreStrategyFit()`'s
  job, not the report-shape check's — same "guard the report's own
  contract, don't duplicate each section's internal shape" posture
  `validateResearchReportShape()` already takes).

## No human override, by design

Nothing in this session adds an operator gate. `score_strategy_fit`
and the two new report routes are authorized the same way every other
department tool in this file already is — the calling `agentAddress`
must match the opportunity's owning report — never a human-approval
step. This matches Zent.md's own closing note verbatim: "There is no
human-in-the-loop step anywhere in this pipeline... an `approved`
decision fires genesis directly."

## Verification

No `node_modules` present in this checkout and network egress is
disabled in this environment, so a full `tsc --noEmit` / `npm test`
pass could not be run here. Verified instead:
- `node --experimental-strip-types --check` on all three edited files
  (`expansion.ts`, `expansionRoutes.ts`, `config.ts`) — clean, no
  syntax errors.
- Both new test files run directly via
  `node --experimental-strip-types --test` — 10/10 and the full
  `expansionStrategyReportShape.test.ts` suite pass.
- Grepped for duplicate `export` declarations of every new symbol
  (`FitRoiDivergence`, `computeFitRoiDivergence`, `StrategyReport`,
  `compileStrategyReport`, `STRATEGY_REPORT_SCHEMA_VERSION`,
  `validateStrategyReportShape`) — each declared exactly once.

**Recommend re-running `tsc --noEmit` and the full test suite in a
networked environment** before merging, to catch anything the syntax
check can't (in particular, confirming the type imports this session
reused from 11e-ii — `MissionOverlapCheckRecord`, `TechnologyReuseCheckRecord`,
`FitScoreFinding` — still line up exactly, and that `compileStrategyReport()`'s
actual runtime output against a real DB still passes
`validateStrategyReportShape()`, the same "recommend re-running against
the real file" caveat every other `expansion*.test.ts` file here
already carries).

## What's deliberately NOT here

- **Phase 12's own three tools** (`assess_ecosystem_strengthening`,
  the cannibalization check, the relationship-type recommendation) and
  their fields on `StrategyReport` — next phase, not this one.
- **No `toolRegistrySeedData.ts` changes.** Confirmed the existing
  `compile_research_report`/`compile_finance_report` tools were never
  added as capability-grant entries there either (they're reached via
  their HTTP routes' own `agentAddress` ownership check, not a
  department-type tool grant) — `compile_strategy_report` follows the
  same precedent, unchanged.
- **Phase 13's committee packet** (`GET .../committee-packet`,
  disagreement surfacing) — this session produces the
  `fit_roi_divergence` signal Phase 13c is explicitly written to
  consume, but doesn't build the packet itself.
