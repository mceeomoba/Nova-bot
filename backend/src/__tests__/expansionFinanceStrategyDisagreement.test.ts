// Zent.md Phase 13c: "Disagreement surfacing: if Finance's sizing and
// Strategy's fit score point opposite directions, the packet says so
// explicitly rather than averaging it away." Filed as
// expansionFinanceStrategyDisagreement.test.ts, matching this
// directory's own expansion<Thing>.test.ts convention (see
// expansionFitRoiDivergence.test.ts for 11e-iii-a's own version of the
// same naming departure from Zent.md's literal phrasing).
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's computeFinanceStrategyDisagreement()
// (pure, no DB access in the real file either), exercised against
// hand-built FinanceReport/StrategyReport fixtures. Recommend re-running
// against the real expansion.ts once a networked environment is
// available.
//
// What this covers:
//   13c — diverges=true only when Finance recommends nonzero funding
//         while Strategy's fit score is below the midpoint, or Finance
//         recommends zero funding while Strategy's fit score is at/above
//         it — the two genuinely opposite-direction cases.
//   13c — diverges=false when both sides agree (fund+favorable,
//         no-fund+unfavorable).
//   13c — either input missing (sizingRecommendation or fitScore not
//         yet filed) always yields diverges=false, never a fabricated
//         verdict — mirrors computeFitRoiDivergence's own null-roiScore
//         handling (11e-iii-a).
//   13c — a fit_score exactly at the midpoint counts as "favorable"
//         (at-or-above, not strictly-above).
//   13c — the verdict carries the raw inputs and the midpoint it was
//         actually checked against, same transparency
//         FitRoiDivergence's own fields give.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Minimal stand-ins for the two report shapes this reads ────────────
//
// Only the two fields computeFinanceStrategyDisagreement() actually
// reads (sizingRecommendation.recommendedFundingUsdc,
// fitScore.fit_score) are modeled — everything else on FinanceReport/
// StrategyReport is irrelevant to this function and already covered by
// 9e's/12d's own shape tests.

interface FinanceReportStub {
  sizingRecommendation: { recommendedFundingUsdc: number } | null;
}
interface StrategyReportStub {
  fitScore: { fit_score: number } | null;
}

interface FinanceStrategyDisagreement {
  diverges: boolean;
  financeDirection: "fund" | "no-fund" | null;
  strategyDirection: "favorable" | "unfavorable" | null;
  recommendedFundingUsdc: number | null;
  fitScore: number | null;
  midpoint: number;
}

const FIT_SCORE_DIRECTION_MIDPOINT = 50;

function computeFinanceStrategyDisagreement(
  financeReport: FinanceReportStub,
  strategyReport: StrategyReportStub,
  midpoint: number = FIT_SCORE_DIRECTION_MIDPOINT,
): FinanceStrategyDisagreement {
  const sizing = financeReport.sizingRecommendation;
  const fit = strategyReport.fitScore;

  const financeDirection: "fund" | "no-fund" | null =
    sizing === null ? null : sizing.recommendedFundingUsdc > 0 ? "fund" : "no-fund";
  const strategyDirection: "favorable" | "unfavorable" | null =
    fit === null ? null : fit.fit_score >= midpoint ? "favorable" : "unfavorable";

  const diverges =
    financeDirection !== null &&
    strategyDirection !== null &&
    ((financeDirection === "fund" && strategyDirection === "unfavorable") ||
      (financeDirection === "no-fund" && strategyDirection === "favorable"));

  return {
    diverges,
    financeDirection,
    strategyDirection,
    recommendedFundingUsdc: sizing === null ? null : sizing.recommendedFundingUsdc,
    fitScore: fit === null ? null : fit.fit_score,
    midpoint,
  };
}

describe("computeFinanceStrategyDisagreement (13c)", () => {
  test("flags divergence: Finance recommends funding, Strategy calls it a poor fit", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: { recommendedFundingUsdc: 5000 } },
      { fitScore: { fit_score: 20 } },
    );
    assert.equal(result.financeDirection, "fund");
    assert.equal(result.strategyDirection, "unfavorable");
    assert.equal(result.diverges, true);
  });

  test("flags divergence: Finance recommends zero funding, Strategy calls it a great fit", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: { recommendedFundingUsdc: 0 } },
      { fitScore: { fit_score: 95 } },
    );
    assert.equal(result.financeDirection, "no-fund");
    assert.equal(result.strategyDirection, "favorable");
    assert.equal(result.diverges, true);
  });

  test("does not flag divergence when both sides agree: fund + favorable", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: { recommendedFundingUsdc: 3000 } },
      { fitScore: { fit_score: 80 } },
    );
    assert.equal(result.diverges, false);
  });

  test("does not flag divergence when both sides agree: no-fund + unfavorable", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: { recommendedFundingUsdc: 0 } },
      { fitScore: { fit_score: 10 } },
    );
    assert.equal(result.diverges, false);
  });

  test("a fit_score exactly at the midpoint counts as favorable (at-or-above)", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: { recommendedFundingUsdc: 0 } },
      { fitScore: { fit_score: 50 } },
      50,
    );
    assert.equal(result.strategyDirection, "favorable");
    assert.equal(result.diverges, true); // no-fund + favorable
  });

  test("a missing sizingRecommendation never diverges and reports a null finance direction", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: null },
      { fitScore: { fit_score: 90 } },
    );
    assert.equal(result.diverges, false);
    assert.equal(result.financeDirection, null);
    assert.equal(result.recommendedFundingUsdc, null);
    assert.equal(result.strategyDirection, "favorable");
  });

  test("a missing fitScore never diverges and reports a null strategy direction", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: { recommendedFundingUsdc: 4000 } },
      { fitScore: null },
    );
    assert.equal(result.diverges, false);
    assert.equal(result.strategyDirection, null);
    assert.equal(result.fitScore, null);
    assert.equal(result.financeDirection, "fund");
  });

  test("both inputs missing never diverges and both directions are null", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: null },
      { fitScore: null },
    );
    assert.equal(result.diverges, false);
    assert.equal(result.financeDirection, null);
    assert.equal(result.strategyDirection, null);
  });

  test("the verdict records which midpoint was actually applied", () => {
    const result = computeFinanceStrategyDisagreement(
      { sizingRecommendation: { recommendedFundingUsdc: 1000 } },
      { fitScore: { fit_score: 65 } },
      70,
    );
    assert.equal(result.midpoint, 70);
    assert.equal(result.strategyDirection, "unfavorable"); // 65 < 70
    assert.equal(result.diverges, true); // fund + unfavorable
  });
});
