# Zent.md Phase 11e-ii-c — Fit Score: Computation Test

Deliverable per Zent.md:

> 11e-ii-c. Test: `strategy-fit-score.test.ts` covering the formula's
> arithmetic and the guard.

This closes the one item `PHASE-11E-II-B-NOTES.md` explicitly flagged
as not yet done. Phase 11e is now fully shipped: formula (11e-i),
computation tool + guard (11e-ii-a/b), and this test (11e-ii-c).

## What shipped

- **`backend/src/__tests__/expansionFitScore.test.ts`** (new). Filed
  under this directory's own `expansion<Thing>.test.ts` naming
  convention rather than Zent.md's literal `strategy-fit-score.test.ts`
  — same departure `expansionRoiFormula.test.ts` and
  `expansionResearchReportShape.test.ts` already take from their own
  Zent.md filenames.

  Same "no live better-sqlite3 in this environment" posture every
  other `expansion*.test.ts` file here already carries: inlines a
  mirror of `expansion.ts`'s `FitScoreFactors`/
  `validateFitScoreFactors`/`FIT_SCORE_WEIGHTS`/`computeFitScore`
  (11e-i), `deriveMissionComplementarityFactor`/
  `deriveTechnologyReuseDepthFactor` (11e-ii-a), and
  `recordMissionOverlapCheck`/`recordTechnologyReuseCheck`/
  `scoreStrategyFit`/`MissingStrategyFitPrerequisitesError` (11e-ii-b)
  against plain in-memory maps standing in for `strategy_findings` —
  same shape `expansionMissionOverlap.test.ts`/
  `expansionTechnologyReuse.test.ts` already use for 11c/11d
  themselves. `checkMissionOverlap()`/`checkTechnologyReuse()` are
  stood in as two fixed lookup maps (`missionOverlapByOpportunity`/
  `technologyReuseByOpportunity`) rather than re-derived from TF-IDF —
  this file's concern is 11e-i/11e-ii, not re-testing 11c/11d's own
  already-covered similarity logic.

  27 tests, 6 suites, run with
  `node --experimental-strip-types --test src/__tests__/expansionFitScore.test.ts`
  (no `tsx`/`ts-node` present in this checkout's `node_modules`; the
  built-in stripping is sufficient since this file uses no TS features
  beyond types). All passing.

  Coverage:
  - `computeFitScore` — weights sum to 1.0, all-0 → 0, all-100 → 100,
    the documented weighted average on distinct inputs, 2-decimal
    rounding, missionComplementarity outweighing marketIndependence.
  - `validateFitScoreFactors` — accepts in-range factors, rejects a
    single out-of-range factor by name, names every problem at once.
  - `deriveMissionComplementarityFactor` — no-entries → 50,
    duplicates → 0, competes → 25, complements-only → 75-100 scaled by
    the strongest `tagOverlap` across all entries, and confirms it
    keys off `entries[0]` (the worst relationship) rather than an
    average.
  - `deriveTechnologyReuseDepthFactor` — no-entries → 0, scales the top
    entry's `reuseScore` (0-1) to 0-100, ignores lower-ranked entries.
  - `scoreStrategyFit` guard — throws `MissingStrategyFitPrerequisitesError`
    naming both tools when neither has run, naming only the one still
    missing when just one has, succeeds once both have filed (even
    across an intervening re-run of one check), and still throws a
    plain `opportunity not found` error for an unknown id.
  - `scoreStrategyFit` writes — merges `fit_score` onto the same row
    as `mission_overlap`/`technology_reuse` without clobbering them,
    is superseding on re-run (exactly one current row, `version`
    increases, `getCurrentStrategyFinding` returns the latest), computes
    `fit_score` end-to-end from derived + caller-supplied factors via
    the documented formula, defaults omitted
    `ecosystemDiversificationValue`/`marketIndependence` to 0, and
    rejects an out-of-range caller-supplied factor before writing
    anything.

## What's deliberately NOT here

- **No changes to `expansion.ts`/`expansionRoutes.ts`/
  `toolRegistrySeedData.ts`.** 11e-ii-a/b already wired the tool, its
  guard, both routes, and the tool-registry grant in prior sessions —
  this phase is test-only, per its own Zent.md line.
- **11b's `list_existing_companies` remains unwired** in
  `toolRegistrySeedData.ts` — unrelated to this phase, still an open
  gap from before 11e-ii-b, not touched here.
- **Phase 11e-iii (divergence & reporting)** — `fit_roi_divergence`
  tagging and wiring `fit_score` into `compile_strategy_report`/the
  `:id/strategy` endpoint — is next; nothing in this session anticipates
  it beyond what 11e-i/11e-ii already expose.
