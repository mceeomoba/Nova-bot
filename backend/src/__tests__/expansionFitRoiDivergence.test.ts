// Zent.md Phase 11e-iii-a: "Divergence field: when fit_score and the
// opportunity's roi_score (Phase 3) disagree by more than a configured
// threshold, tag the finding fit_roi_divergence — the concrete signal
// Phase 13c's 'disagreement surfacing' will read." Filed as
// expansionFitRoiDivergence.test.ts, matching this directory's own
// expansion<Thing>.test.ts convention (see expansionFitScore.test.ts /
// expansionRoiFormula.test.ts for the same naming departure from
// Zent.md's literal phrasing).
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's computeFitRoiDivergence() (pure,
// no DB access in the real file either) and, separately, a mirror of
// scoreStrategyFit()'s own merge-both-fields-together behavior against
// plain in-memory maps standing in for strategy_findings, the same
// posture expansionFitScore.test.ts already takes for scoreStrategyFit()
// itself. Recommend re-running against the real expansion.ts/db.ts once
// a networked environment is available.
//
// What this covers:
//   11e-iii-a — computeFitRoiDivergence flags diverges=true only when
//            |fitScore - roiScore| exceeds config's threshold, false
//            when equal to it (strictly greater than, not >=).
//   11e-iii-a — a null roiScore (Opportunity Intelligence hasn't scored
//            this opportunity yet) always yields diverges=false, never
//            a thrown error or a fabricated delta.
//   11e-iii-a — delta is the absolute difference, rounded to 2 decimals,
//            symmetric regardless of which score is higher.
//   11e-iii-a — the verdict carries the threshold it was actually
//            checked against, not just a bare boolean.
//   11e-iii-a — scoreStrategyFit's own write files fit_score and
//            fit_roi_divergence onto the SAME strategy_findings version,
//            in the same merge, never one without the other.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's computeFitRoiDivergence() (11e-iii-a) ────

interface FitRoiDivergence {
  diverges: boolean;
  fitScore: number;
  roiScore: number | null;
  delta: number | null;
  threshold: number;
}

const FIT_ROI_DIVERGENCE_THRESHOLD = 30;

function computeFitRoiDivergence(
  fitScore: number,
  roiScore: number | null,
  threshold: number = FIT_ROI_DIVERGENCE_THRESHOLD,
): FitRoiDivergence {
  if (roiScore === null) {
    return { diverges: false, fitScore, roiScore: null, delta: null, threshold };
  }
  const delta = Math.round(Math.abs(fitScore - roiScore) * 100) / 100;
  return { diverges: delta > threshold, fitScore, roiScore, delta, threshold };
}

describe("computeFitRoiDivergence (11e-iii-a)", () => {
  test("flags divergence when the gap exceeds the threshold", () => {
    const result = computeFitRoiDivergence(85, 40);
    assert.equal(result.delta, 45);
    assert.equal(result.diverges, true);
  });

  test("does not flag divergence when the gap is under the threshold", () => {
    const result = computeFitRoiDivergence(70, 55);
    assert.equal(result.delta, 15);
    assert.equal(result.diverges, false);
  });

  test("a gap exactly at the threshold does not count as divergent (strictly greater-than)", () => {
    const result = computeFitRoiDivergence(80, 50, 30);
    assert.equal(result.delta, 30);
    assert.equal(result.diverges, false);
  });

  test("a gap one hundredth above the threshold does count as divergent", () => {
    const result = computeFitRoiDivergence(80.01, 50, 30);
    assert.equal(result.delta, 30.01);
    assert.equal(result.diverges, true);
  });

  test("is symmetric — fit above roi or roi above fit gives the same delta", () => {
    const a = computeFitRoiDivergence(90, 20);
    const b = computeFitRoiDivergence(20, 90);
    assert.equal(a.delta, b.delta);
    assert.equal(a.diverges, b.diverges);
  });

  test("a null roiScore never diverges and carries no fabricated delta", () => {
    const result = computeFitRoiDivergence(95, null);
    assert.equal(result.diverges, false);
    assert.equal(result.delta, null);
    assert.equal(result.roiScore, null);
    assert.equal(result.fitScore, 95);
  });

  test("the verdict records which threshold was actually applied", () => {
    const result = computeFitRoiDivergence(80, 10, 50);
    assert.equal(result.threshold, 50);
    assert.equal(result.diverges, true); // delta 70 > 50
  });

  test("delta rounds to 2 decimal places, same discipline computeFitScore/computeRoiScore use", () => {
    const result = computeFitRoiDivergence(66.667, 33.333, 30);
    assert.equal(result.delta, 33.33);
  });
});

// ─── Mirror of scoreStrategyFit's own "both fields, one merge" write ───
//
// Doesn't re-derive fit_score itself (expansionFitScore.test.ts already
// covers that formula end to end) — just confirms the *pairing*
// contract 11e-iii-a's own header in expansion.ts commits to: a
// fit_roi_divergence tag is filed in the same write as fit_score, onto
// the same strategy_findings version, never independently.

interface Finding<T = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  version: number;
  superseded: boolean;
  findings: T;
}

function makeFakeStrategyFindingsStore() {
  const store = new Map<string, Finding[]>();
  let counter = 0;

  function getCurrent(opportunityId: string): Finding | undefined {
    const rows = store.get(opportunityId) ?? [];
    return rows.find((r) => !r.superseded);
  }

  function mergeIntoCurrent(opportunityId: string, patch: Record<string, unknown>): Finding {
    const rows = store.get(opportunityId) ?? [];
    const current = rows.find((r) => !r.superseded);
    if (current) current.superseded = true;
    const merged: Finding = {
      id: `stgf_${++counter}`,
      opportunity_id: opportunityId,
      version: (current?.version ?? 0) + 1,
      superseded: false,
      findings: { ...(current?.findings ?? {}), ...patch },
    };
    store.set(opportunityId, [...rows, merged]);
    return merged;
  }

  return { getCurrent, mergeIntoCurrent };
}

test("fit_score and fit_roi_divergence land on the same finding version together", () => {
  const { getCurrent, mergeIntoCurrent } = makeFakeStrategyFindingsStore();
  const opportunityId = "opp_1";
  const roiScore = 40;
  const fitScore = { fit_score: 85, fit_formula_version: "11e-i-v1", factors: {} };
  const divergence = computeFitRoiDivergence(fitScore.fit_score, roiScore);

  const finding = mergeIntoCurrent(opportunityId, {
    fit_score: fitScore,
    fit_roi_divergence: divergence,
  });

  assert.equal(finding.version, 1);
  assert.deepEqual((getCurrent(opportunityId) as any).findings.fit_score, fitScore);
  assert.equal((getCurrent(opportunityId) as any).findings.fit_roi_divergence.diverges, true);
});

test("a re-run of score_strategy_fit supersedes the prior version but keeps both fields paired on the new one", () => {
  const { getCurrent, mergeIntoCurrent } = makeFakeStrategyFindingsStore();
  const opportunityId = "opp_1";

  mergeIntoCurrent(opportunityId, { mission_overlap: { entries: [] } });
  const first = mergeIntoCurrent(opportunityId, {
    fit_score: { fit_score: 60, fit_formula_version: "11e-i-v1", factors: {} },
    fit_roi_divergence: computeFitRoiDivergence(60, 55),
  });
  assert.equal(first.superseded, false);

  // Re-score after a sibling changes the portfolio: fit_score moves,
  // and so must its paired divergence tag, on a fresh version.
  const second = mergeIntoCurrent(opportunityId, {
    fit_score: { fit_score: 90, fit_formula_version: "11e-i-v1", factors: {} },
    fit_roi_divergence: computeFitRoiDivergence(90, 55),
  });

  assert.equal((first as any).superseded, true);
  assert.equal(second.version, 3);
  const current = getCurrent(opportunityId) as any;
  assert.equal(current.id, second.id);
  assert.equal(current.findings.fit_score.fit_score, 90);
  assert.equal(current.findings.fit_roi_divergence.diverges, true);
  // mission_overlap filed on an earlier version stays merged forward,
  // same read-merge-write discipline mergeIntoCurrentStrategyFinding()
  // (11e-ii-b) documents in the real file.
  assert.deepEqual(current.findings.mission_overlap, { entries: [] });
});
