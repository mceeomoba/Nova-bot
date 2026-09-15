# Zent.md Phase 11e-i — Fit Score: Formula & Factors

Deliverable per Zent.md:

> 11e-i-a. Document the deterministic fit-score formula (mirroring 3b's
> ROI formula): factors — mission-complementarity (from 11c's overlap
> check), technology-reuse depth (11d), ecosystem-diversification
> value, market-independence — each 0–100, combined into one
> `fit_score`.
>
> 11e-i-b. Store the factor inputs alongside `fit_score` in
> `strategy_findings.findings` (the existing JSON blob column) so the
> score is auditable like 3b's `roi_score`, not just a bare number.
>
> 11e-i-c. Factor-weighting constants live in `config.ts`, next to the
> existing 11c/11d thresholds (`config.ts:670`, `config.ts:712`), not
> hardcoded inline — tunable without touching department logic.

## What shipped

- **`backend/src/expansion.ts`** — new Phase 11e-i section, inserted
  right after 11d's `checkTechnologyReuse()`:
  - `FitScoreFactors` — the four 0–100 inputs (`missionComplementarity`,
    `technologyReuseDepth`, `ecosystemDiversificationValue`,
    `marketIndependence`), mirroring 3a's `ScoringFactors`.
  - `validateFitScoreFactors()` — range/finiteness check, same
    all-problems-at-once posture as `validateScoringFactors()`.
  - `FIT_FORMULA_VERSION` (`"11e-i-v1"`) and `FIT_SCORE_WEIGHTS`
    (0.35 / 0.30 / 0.20 / 0.15 — same shape as `ROI_WEIGHTS`, weighted
    toward the two factors 11c/11d can already back with real sibling
    data today).
  - `computeFitScore()` — the fixed weighted average, rounded to 2
    decimals, mirroring `computeRoiScore()` exactly.
  - `FitScoreFinding` — the `{ fit_score, fit_formula_version, factors }`
    shape 11e-ii's `score_strategy_fit` tool will write into
    `strategy_findings.findings`.
- **`backend/src/config.ts`** — `fitScoreWeights` block added next to
  the existing `missionOverlap*`/`technologyReuseMatchThreshold`
  constants, each weight overridable via its own `FIT_SCORE_WEIGHT_*`
  env var.

## What's deliberately NOT here yet

This sub-phase is formula-and-shape only — same "the table exists vs.
something principled computes the number" split 1b/3b's own docstrings
draw for `roi_score`. Not shipped in this pass, on purpose:

- **No `score_strategy_fit(opportunity_id)` tool.** Nothing in this
  pass reads a live `checkMissionOverlap()`/`checkTechnologyReuse()`
  result, derives `missionComplementarity`/`technologyReuseDepth` from
  it, or calls `createStrategyFinding()` to persist a row. That's
  11e-ii, guarded on 11c/11d both having filed a non-superseded finding
  for the opportunity (mirrors `strategy_requires_completed_research_report`
  / `..._finance_report` in `departments.ts`).
- **No divergence tagging against `roi_score`.** That's 11e-iii
  (`fit_roi_divergence`), which also wires `fit_score` into
  `compile_strategy_report` (12d) and the `GET
  /expansion/opportunities/:id/strategy` response (12e).
- **`ecosystemDiversificationValue` / `marketIndependence` have no
  computation to reuse.** Both are Phase 12 territory
  (`assess_ecosystem_strengthening`, 12a). Until 12a ships,
  `computeFitScore()` accepts them as caller-supplied numbers — a
  caller with nothing to put there scores that axis 0, which is an
  honest "no signal yet," not an error.
- **No `strategy-fit-score.test.ts`.** Zent.md assigns that to 11e-ii
  (formula arithmetic + the 11c/11d completion guard) — there's no
  guard or live wiring in this pass yet to test.

## No human-in-the-loop, by design

Per Zent.md's own closing note, this whole pipeline — Opportunity
Intelligence through the CEO's `decide_expansion` call — is agent-
executed end to end; there's no external operator gate anywhere in it,
and `fit_score` is one more internally-computed, internally-audited
number feeding that same chain. The checks against the pipeline's own
self-scoring incentive are internal to the agent hierarchy (Research's
confidence weighting, Finance's hard-reject runway floor, Phase 19's
rate/spend caps and circuit breakers) — this phase adds one more
auditable, version-tagged, config-tunable formula to that same internal
chain, not an approval step.
