// Zent.md Phase 20e: "Post-launch review checkpoint: after the first
// real Agent B is spawned, a scheduled review of whether the ROI/fit
// scores it was approved on actually held up — feeds back into tuning
// 3b's formula."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory gives. Mirrors the real
// functions added to postLaunchReview.ts (computeActualOutcomeMetrics,
// schedulePostLaunchReview, runDuePostLaunchReviews,
// summarizeRoiCalibration) — not expansion.ts's already-covered 2e
// isEligibleForExpansion() formula itself (expansionEndToEnd_test.ts
// and others already exercise it), and not genesis.ts's activation
// flow (genesisActivation_test.ts) — this file only needs "the review
// gets scheduled at activation, and graded correctly once due" to
// hold, using a trivial stand-in for isEligibleForExpansion().
//
// Recommend re-running against the real postLaunchReview.ts / db.ts
// once a networked environment with a live better-sqlite3 connection
// is available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of the ACTUAL_OUTCOME_WEIGHTS formula ───────────────────

const ACTUAL_OUTCOME_WEIGHTS = { profitable: 50, stillActive: 30, revenueRatio: 20 };
const CALIBRATION_THRESHOLD = 15;
const MIN_REVIEWS_FOR_SUGGESTION = 5;

interface Eligibility {
  revenueUsdc: number;
  spendUsdc: number;
  surplusUsdc: number;
  eligible: boolean;
}

function computeActualOutcomeMetrics(
  eligibility: Eligibility,
  stillActive: boolean,
  recommendedFundingUsdc: number | null,
) {
  const revenueRatio =
    recommendedFundingUsdc && recommendedFundingUsdc > 0
      ? Math.min(1, eligibility.revenueUsdc / recommendedFundingUsdc)
      : 0;
  const actualOutcomeScore =
    (eligibility.eligible ? ACTUAL_OUTCOME_WEIGHTS.profitable : 0) +
    (stillActive ? ACTUAL_OUTCOME_WEIGHTS.stillActive : 0) +
    revenueRatio * ACTUAL_OUTCOME_WEIGHTS.revenueRatio;
  return {
    profitable: eligibility.eligible,
    stillActive,
    revenueRatio: Math.round(revenueRatio * 100) / 100,
    actualOutcomeScore: Math.round(actualOutcomeScore * 100) / 100,
  };
}

type CalibrationVerdict = "formula_overestimated" | "formula_underestimated" | "formula_calibrated";

function bandCalibrationDelta(delta: number): CalibrationVerdict {
  if (delta <= -CALIBRATION_THRESHOLD) return "formula_overestimated";
  if (delta >= CALIBRATION_THRESHOLD) return "formula_underestimated";
  return "formula_calibrated";
}

// ─── Mirror of the post_launch_reviews table + scheduling/sweep ────

interface ReviewRow {
  id: string;
  opportunityId: string;
  agentAddress: string;
  rootAgentAddress: string;
  predictedRoiScore: number;
  predictedFitScore: number | null;
  recommendedFundingUsdc: number | null;
  reviewDueAt: number;
  status: "pending" | "completed";
  actualOutcomeScore?: number;
  roiCalibrationDelta?: number;
  fitCalibrationDelta?: number | null;
  calibrationVerdict?: CalibrationVerdict;
}

let reviews: Map<string, ReviewRow>; // keyed by agentAddress
let eligibilityByAgent: Map<string, Eligibility>;
let stillActiveByAgent: Map<string, boolean>;
let seq: number;
const REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function reset(): void {
  reviews = new Map();
  eligibilityByAgent = new Map();
  stillActiveByAgent = new Map();
  seq = 0;
}

function schedulePostLaunchReview(
  opportunityId: string,
  agentAddress: string,
  rootAgentAddress: string,
  predictedRoiScore: number,
  predictedFitScore: number | null,
  recommendedFundingUsdc: number | null,
  now: number,
): void {
  if (reviews.has(agentAddress)) return; // idempotent, mirrors UNIQUE(agent_address)
  reviews.set(agentAddress, {
    id: `plr_${++seq}`,
    opportunityId,
    agentAddress,
    rootAgentAddress,
    predictedRoiScore,
    predictedFitScore,
    recommendedFundingUsdc,
    reviewDueAt: now + REVIEW_WINDOW_MS,
    status: "pending",
  });
}

function completeReview(row: ReviewRow): void {
  const eligibility = eligibilityByAgent.get(row.agentAddress) ?? {
    revenueUsdc: 0,
    spendUsdc: 0,
    surplusUsdc: 0,
    eligible: false,
  };
  const stillActive = stillActiveByAgent.get(row.agentAddress) ?? true;
  const actual = computeActualOutcomeMetrics(eligibility, stillActive, row.recommendedFundingUsdc);
  const roiCalibrationDelta = Math.round((actual.actualOutcomeScore - row.predictedRoiScore) * 100) / 100;
  const fitCalibrationDelta =
    row.predictedFitScore === null
      ? null
      : Math.round((actual.actualOutcomeScore - row.predictedFitScore) * 100) / 100;
  row.status = "completed";
  row.actualOutcomeScore = actual.actualOutcomeScore;
  row.roiCalibrationDelta = roiCalibrationDelta;
  row.fitCalibrationDelta = fitCalibrationDelta;
  row.calibrationVerdict = bandCalibrationDelta(roiCalibrationDelta);
}

function runDuePostLaunchReviews(now: number): number {
  let completed = 0;
  for (const row of reviews.values()) {
    if (row.status === "pending" && row.reviewDueAt <= now) {
      completeReview(row);
      completed++;
    }
  }
  return completed;
}

function summarizeRoiCalibration(rootAgentAddress?: string) {
  const rows = [...reviews.values()].filter(
    (r) => r.status === "completed" && (!rootAgentAddress || r.rootAgentAddress === rootAgentAddress),
  );
  const completedReviewCount = rows.length;
  const overestimatedCount = rows.filter((r) => r.calibrationVerdict === "formula_overestimated").length;
  const underestimatedCount = rows.filter((r) => r.calibrationVerdict === "formula_underestimated").length;
  const calibratedCount = rows.filter((r) => r.calibrationVerdict === "formula_calibrated").length;
  const averageRoiCalibrationDelta =
    completedReviewCount === 0
      ? null
      : Math.round((rows.reduce((s, r) => s + (r.roiCalibrationDelta ?? 0), 0) / completedReviewCount) * 100) / 100;

  let suggestion: string;
  if (completedReviewCount < MIN_REVIEWS_FOR_SUGGESTION) {
    suggestion = "insufficient data";
  } else if (overestimatedCount > completedReviewCount / 2) {
    suggestion = "overestimating";
  } else if (underestimatedCount > completedReviewCount / 2) {
    suggestion = "underestimating";
  } else {
    suggestion = "no formula change indicated";
  }

  return { completedReviewCount, averageRoiCalibrationDelta, overestimatedCount, underestimatedCount, calibratedCount, suggestion };
}

// ═════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════

test("20e: scheduling is idempotent — a second call for the same agent doesn't overwrite the snapshot", () => {
  reset();
  const t0 = 1_000_000;
  schedulePostLaunchReview("opp_1", "0xAGENT_B", "0xROOT", 72, 65, 10_000, t0);
  schedulePostLaunchReview("opp_1", "0xAGENT_B", "0xROOT", 999, 999, 999_999, t0 + 500); // attempted overwrite

  const review = reviews.get("0xAGENT_B")!;
  assert.equal(review.predictedRoiScore, 72, "first scheduling call wins; snapshot is not overwritten");
  assert.equal(review.predictedFitScore, 65);
  assert.equal(reviews.size, 1);
});

test("20e: a review isn't graded before its due date, even if the sweep runs", () => {
  reset();
  const t0 = 1_000_000;
  schedulePostLaunchReview("opp_1", "0xAGENT_B", "0xROOT", 72, 65, 10_000, t0);

  const completedTooEarly = runDuePostLaunchReviews(t0 + REVIEW_WINDOW_MS - 1);
  assert.equal(completedTooEarly, 0);
  assert.equal(reviews.get("0xAGENT_B")!.status, "pending");
});

test("20e: a profitable, still-active, fully-revenue-recovered agent scores 100 and reads as calibrated against an accurate prediction", () => {
  reset();
  const t0 = 1_000_000;
  eligibilityByAgent.set("0xAGENT_B", { revenueUsdc: 10_000, spendUsdc: 4_000, surplusUsdc: 6_000, eligible: true });
  stillActiveByAgent.set("0xAGENT_B", true);
  schedulePostLaunchReview("opp_1", "0xAGENT_B", "0xROOT", 78, 74, 10_000, t0);

  const completed = runDuePostLaunchReviews(t0 + REVIEW_WINDOW_MS);
  assert.equal(completed, 1);

  const review = reviews.get("0xAGENT_B")!;
  assert.equal(review.status, "completed");
  assert.equal(review.actualOutcomeScore, 100); // 50 + 30 + 20*1.0
  assert.equal(review.roiCalibrationDelta, 22); // 100 - 78
  assert.equal(review.calibrationVerdict, "formula_underestimated"); // delta >= 15
});

test("20e: an unprofitable, killed agent with no revenue scores 0 and a high predicted score bands as overestimated", () => {
  reset();
  const t0 = 1_000_000;
  eligibilityByAgent.set("0xAGENT_B", { revenueUsdc: 0, spendUsdc: 3_000, surplusUsdc: -3_000, eligible: false });
  stillActiveByAgent.set("0xAGENT_B", false); // frozen/killed
  schedulePostLaunchReview("opp_1", "0xAGENT_B", "0xROOT", 85, 80, 10_000, t0);

  runDuePostLaunchReviews(t0 + REVIEW_WINDOW_MS);

  const review = reviews.get("0xAGENT_B")!;
  assert.equal(review.actualOutcomeScore, 0);
  assert.equal(review.roiCalibrationDelta, -85);
  assert.equal(review.calibrationVerdict, "formula_overestimated");
});

test("20e: a delta inside the ±15 band is reported as calibrated, not a miss", () => {
  reset();
  const t0 = 1_000_000;
  // actual outcome: profitable (50) + still active (30) + 0 revenue ratio (funding unknown) = 80
  eligibilityByAgent.set("0xAGENT_B", { revenueUsdc: 2_000, spendUsdc: 500, surplusUsdc: 1_500, eligible: true });
  stillActiveByAgent.set("0xAGENT_B", true);
  schedulePostLaunchReview("opp_1", "0xAGENT_B", "0xROOT", 90, null, null, t0); // no funding recorded -> revenueRatio 0

  runDuePostLaunchReviews(t0 + REVIEW_WINDOW_MS);
  const review = reviews.get("0xAGENT_B")!;
  assert.equal(review.actualOutcomeScore, 80); // 50 + 30 + 0
  assert.equal(review.roiCalibrationDelta, -10); // within band
  assert.equal(review.calibrationVerdict, "formula_calibrated");
  assert.equal(review.fitCalibrationDelta, null, "no predicted fit score recorded -> no fit delta computed");
});

test("20e: the sweep only grades reviews that are actually due, leaving others pending", () => {
  reset();
  const t0 = 1_000_000;
  eligibilityByAgent.set("0xEARLY", { revenueUsdc: 5_000, spendUsdc: 1_000, surplusUsdc: 4_000, eligible: true });
  stillActiveByAgent.set("0xEARLY", true);
  eligibilityByAgent.set("0xLATE", { revenueUsdc: 5_000, spendUsdc: 1_000, surplusUsdc: 4_000, eligible: true });
  stillActiveByAgent.set("0xLATE", true);

  schedulePostLaunchReview("opp_1", "0xEARLY", "0xROOT", 70, 60, 5_000, t0 - REVIEW_WINDOW_MS); // already due
  schedulePostLaunchReview("opp_2", "0xLATE", "0xROOT", 70, 60, 5_000, t0); // not due yet

  const completed = runDuePostLaunchReviews(t0);
  assert.equal(completed, 1);
  assert.equal(reviews.get("0xEARLY")!.status, "completed");
  assert.equal(reviews.get("0xLATE")!.status, "pending");
});

test("20e: calibration summary reports insufficient data below the minimum review threshold", () => {
  reset();
  const t0 = 1_000_000;
  for (let i = 0; i < MIN_REVIEWS_FOR_SUGGESTION - 1; i++) {
    const agent = `0xAGENT_${i}`;
    eligibilityByAgent.set(agent, { revenueUsdc: 0, spendUsdc: 100, surplusUsdc: -100, eligible: false });
    stillActiveByAgent.set(agent, false);
    schedulePostLaunchReview(`opp_${i}`, agent, "0xROOT", 90, null, null, t0);
  }
  runDuePostLaunchReviews(t0 + REVIEW_WINDOW_MS);

  const summary = summarizeRoiCalibration("0xROOT");
  assert.equal(summary.completedReviewCount, MIN_REVIEWS_FOR_SUGGESTION - 1);
  assert.equal(summary.suggestion, "insufficient data");
});

test("20e: calibration summary flags systematic overestimation once enough reviews agree", () => {
  reset();
  const t0 = 1_000_000;
  for (let i = 0; i < MIN_REVIEWS_FOR_SUGGESTION + 2; i++) {
    const agent = `0xAGENT_${i}`;
    // consistently overestimated: predicted 90, actual always 0
    eligibilityByAgent.set(agent, { revenueUsdc: 0, spendUsdc: 500, surplusUsdc: -500, eligible: false });
    stillActiveByAgent.set(agent, false);
    schedulePostLaunchReview(`opp_${i}`, agent, "0xROOT", 90, null, null, t0);
  }
  runDuePostLaunchReviews(t0 + REVIEW_WINDOW_MS);

  const summary = summarizeRoiCalibration("0xROOT");
  assert.equal(summary.completedReviewCount, MIN_REVIEWS_FOR_SUGGESTION + 2);
  assert.equal(summary.overestimatedCount, MIN_REVIEWS_FOR_SUGGESTION + 2);
  assert.equal(summary.suggestion, "overestimating");
});

test("20e: calibration summary is scoped per-root — one root's bad calibration doesn't pollute another's summary", () => {
  reset();
  const t0 = 1_000_000;
  // Root A: 5 badly-overestimated reviews.
  for (let i = 0; i < 5; i++) {
    const agent = `0xA_AGENT_${i}`;
    eligibilityByAgent.set(agent, { revenueUsdc: 0, spendUsdc: 100, surplusUsdc: -100, eligible: false });
    stillActiveByAgent.set(agent, false);
    schedulePostLaunchReview(`opp_a_${i}`, agent, "0xROOT_A", 95, null, null, t0);
  }
  // Root B: 1 well-calibrated review.
  eligibilityByAgent.set("0xB_AGENT", { revenueUsdc: 8_000, spendUsdc: 2_000, surplusUsdc: 6_000, eligible: true });
  stillActiveByAgent.set("0xB_AGENT", true);
  schedulePostLaunchReview("opp_b", "0xB_AGENT", "0xROOT_B", 82, null, 8_000, t0);

  runDuePostLaunchReviews(t0 + REVIEW_WINDOW_MS);

  const summaryA = summarizeRoiCalibration("0xROOT_A");
  const summaryB = summarizeRoiCalibration("0xROOT_B");
  assert.equal(summaryA.completedReviewCount, 5);
  assert.equal(summaryA.suggestion, "overestimating");
  assert.equal(summaryB.completedReviewCount, 1);
  assert.equal(summaryB.suggestion, "insufficient data", "root B alone doesn't have enough reviews yet");
});
