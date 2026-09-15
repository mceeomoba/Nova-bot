# Zent.md Phase 13c — Expansion Committee: Disagreement Surfacing

Deliverable per Zent.md:

> 13c. Disagreement surfacing: if Finance's sizing and Strategy's fit
> score point opposite directions, the packet says so explicitly rather
> than averaging it away.

## Reading this against what already existed

11e-iii-a already built one divergence signal — `fit_roi_divergence`,
comparing Strategy's `fit_score` against Opportunity Intelligence's own
`roi_score`. That comparison works because both numbers live on the
same `[0, 100]` scale, so a plain absolute delta against a configured
threshold (`config.fitRoiDivergenceThreshold`) is a fair comparison.

13c's pair is different: Finance's `sizingRecommendation` isn't a score
at all, it's a USDC amount (`recommendedFundingUsdc`). There's no
shared unit with `fit_score` to take a delta in, so this phase doesn't
reuse 11e-iii-a's magnitude-threshold approach — it reduces both sides
to a **direction** instead:

- Finance: `"fund"` when `recommendedFundingUsdc > 0`, `"no-fund"` when
  it's clamped to exactly zero (no available capital, a failed runway
  floor, or day/call caps leaving no room — see `recommendSizing()`'s
  own clamping logic from Phase 9b).
- Strategy: `"favorable"` when `fit_score` is at or above a configured
  midpoint, `"unfavorable"` when it's below.

Disagreement is exactly the two "opposite" pairings: fund+unfavorable,
or no-fund+favorable. Agreeing pairings (fund+favorable,
no-fund+unfavorable) are not flagged.

## How it's built

- **`config.ts`** — new `fitScoreDirectionMidpoint` (default `50`,
  `FIT_SCORE_DIRECTION_MIDPOINT` env override), same "tunable without
  touching department logic" posture `fitRoiDivergenceThreshold` and
  `fitScoreWeights` already commit to.
- **`expansion.ts`**:
  - `FinanceStrategyDisagreement` — `{ diverges, financeDirection,
    strategyDirection, recommendedFundingUsdc, fitScore, midpoint }`.
    Same "flagged, structured record that a tension exists, not a
    resolution of it" posture `FitRoiDivergence` already takes — this
    file has no basis to decide whether Finance or Strategy is
    "right," only to make sure the CEO gate sees the tension instead
    of it silently washing out.
  - `computeFinanceStrategyDisagreement(financeReport, strategyReport)`
    — pure function, no DB access. Either input missing
    (`sizingRecommendation` or `fitScore` not yet filed) always yields
    `diverges: false` and a `null` direction for the missing side —
    same "no signal, not fabricated" posture `computeFitRoiDivergence()`
    already takes toward a null `roiScore`.
  - `CommitteePacket` gains an eighth field,
    `financeStrategyDisagreement` — always a required object, never
    null (the comparison itself handles missing inputs internally),
    same contract the other four report sections already have.
  - `COMMITTEE_PACKET_SCHEMA_VERSION` bumped `"13b-v1"` → `"13c-v1"`:
    a real bundle-shape change (new top-level key), the same trigger
    that justified 13b's own version tag.
  - `assembleCommitteePacket()` now computes
    `financeStrategyDisagreement` from the same `financeReport`/
    `strategyReport` it already assembles, fresh on every call — same
    "recomputed from current state, nothing persisted" posture the
    rest of the packet already has.
- **`backend/src/__tests__/expansionFinanceStrategyDisagreement.test.ts`**
  — new file, pure-function coverage for
  `computeFinanceStrategyDisagreement()`: both opposite-direction
  cases, both agreeing cases, the midpoint's at-or-above boundary,
  each input missing individually and together, and that the verdict
  records the midpoint it was actually checked against.
- **`expansionCommitteePacketShape.test.ts`** (13b's own file) —
  updated: schema version bumped to `"13c-v1"`, the new field added to
  both the locked field list and the required-object list, and the
  base fixture packet extended with a well-formed
  `financeStrategyDisagreement`.
- **`expansionCommitteePacketAssembly.test.ts`** (13a's own file) —
  updated: the `assembleCommitteePacket()` mirror now also computes and
  attaches `financeStrategyDisagreement`; two new tests exercise a real
  disagreement and a real agreement flowing through full assembly, plus
  the "present but non-diverging before either department has filed"
  case. (In passing: fixed a pre-existing fixture bug where this file's
  Finance fixtures used a made-up `amountUsdc` key instead of the real
  `SizingRecommendation` shape's `recommendedFundingUsdc` — didn't
  matter for the field's own shape test, which doesn't recurse into
  nested-report contents, but would have understated what real
  `sizingRecommendation` objects look like once this phase started
  reading `recommendedFundingUsdc` off them directly.)

## What's deliberately NOT here yet

- **No `GET /expansion/opportunities/:id/committee-packet` route.**
  13d's job — the packet (now including this field) still isn't
  reachable over HTTP.
- **No completeness gate.** 13e's job, unchanged by this phase — a
  packet with one or both of Finance/Strategy not yet filed still
  assembles, with `financeStrategyDisagreement.diverges: false` and
  the corresponding direction(s) `null`, exactly as if a caller had
  hit that department's own GET route directly.
- **No resolution mechanism.** This phase surfaces the tension; it
  doesn't adjudicate it. Whether the CEO (Phase 15) weighs a flagged
  disagreement, and how, is that phase's own decision — `decide_expansion`
  reads whatever packet it's handed, disagreement flag included, same
  as every other field.

No human-in-the-loop step anywhere in this path, same as every other
phase in this pipeline — 13c only changes what the CEO agent itself
gets to see in the packet before it rules on it, not who rules.
