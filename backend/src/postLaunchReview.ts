import { ulid } from "ulid";
import { db } from "./db.js";
import { config } from "./config.js";
import { runOnScheduleWithLease } from "./scheduler.js";
import {
  isEligibleForExpansion,
  getOpportunity,
  getCurrentFinding,
  getGenesisTrigger,
  type FitScoreFinding,
} from "./expansion.js";

/**
 * Zent.md Phase 20e: "Post-launch review checkpoint: after the first
 * real Agent B is spawned, a scheduled review of whether the ROI/fit
 * scores it was approved on actually held up — feeds back into tuning
 * 3b's formula."
 *
 * Same "new layer, not a rewrite" posture the rest of this pipeline
 * takes: this module reads opportunities/strategy_findings/genesis_triggers
 * (all owned by expansion.ts) and isEligibleForExpansion() (2e, applied
 * here to Agent B's OWN address rather than a root's) rather than
 * inventing a second notion of "profitable." The one new thing this
 * phase actually adds is the comparison itself — a documented,
 * deterministic "actual outcome score" (same "not left to the model to
 * invent per-call" posture 3b's ROI_WEIGHTS and 11e-i's FIT_SCORE_WEIGHTS
 * already take) measured against the roi_score/fit_score Agent B was
 * approved on, plus the scheduling/sweep mechanics to run that
 * comparison automatically once there's been enough runway to judge.
 *
 * Scope, read literally against Zent.md's own one-line spec:
 *   - "a scheduled review" -> schedulePostLaunchReview() (called once,
 *     at activation) + runDuePostLaunchReviews() (the sweep, registered
 *     below via scheduler.ts, same lease-based primitive
 *     expansion.ts's own Phase 3d Top-N job and departments.ts's TTL
 *     reaper already use).
 *   - "whether the ROI/fit scores it was approved on actually held up"
 *     -> computeActualOutcomeScore() + the roi_calibration_delta /
 *     fit_calibration_delta columns this phase adds to
 *     post_launch_reviews (db.ts).
 *   - "feeds back into tuning 3b's formula" -> summarizeRoiCalibration()
 *     below, which aggregates completed reviews into a plain-language
 *     signal. Deliberately informational, not an auto-mutation of
 *     ROI_WEIGHTS/FIT_SCORE_WEIGHTS themselves: a handful of reviews is
 *     a genuinely small, noisy sample to redefine a formula every other
 *     opportunity in the pipeline gets scored against, and 3b's own
 *     header already treats those weights as a considered, documented
 *     constant, not a value any single caller path should be able to
 *     drift silently. "Feeds back into" is read as "produces the signal
 *     that a deliberate formula-tuning pass would consume," not as this
 *     phase quietly rewriting the formula out from under the rest of
 *     the pipeline. Nothing about the actual pipeline gates on this —
 *     decide_expansion/genesis fire exactly as before; this module only
 *     ever reads them, never blocks them.
 *
 * No human override, same posture as every other file in this
 * pipeline: schedulePostLaunchReview() and runDuePostLaunchReviews()
 * are both called automatically (the former from
 * genesisExecutorAdapter() right after activateGenesisAgent(), the
 * latter from this file's own runOnScheduleWithLease() registration
 * below) with no operator step anywhere in between "review comes due"
 * and "review is completed and written."
 */

const ACTUAL_OUTCOME_FORMULA_VERSION = "20e-v1";

/**
 * Same "0.35/0.30/0.20/0.15-shaped, most-evidenced-first" posture
 * ROI_WEIGHTS (3b) and FIT_SCORE_WEIGHTS (11e-i) already establish,
 * adapted to three factors instead of four since there are only three
 * real signals available post-launch without a human-graded outcome:
 *
 *   - profitable (50%): the single strongest, least-gameable signal
 *     available — Agent B's own revenue actually exceeding its own
 *     spend, via the exact 2e formula every root agent's own expansion
 *     eligibility is judged by. Weighted highest for the same reason
 *     2e itself gates real genesis: nothing else in this pipeline
 *     stands in for "does this business actually work."
 *   - stillActive (30%): Agent B was never frozen/killed
 *     (expansionKillSwitch.ts) and never fell into
 *     genesis_activation_status = 'failed' after birth. A distinct
 *     signal from profitability — a company can be unprofitable but
 *     alive (still finding its footing) or profitable right up until
 *     a kill switch fires for an unrelated reason — so this is not
 *     folded into the profitability weight above.
 *   - revenueRatio (20%): actual revenue since birth as a fraction of
 *     what Finance recommended funding it with (Phase 9), capped at
 *     1.0 — a coarse "did this come anywhere close to earning back its
 *     own stake" signal, capped rather than unbounded so one runaway
 *     outlier agent can't single-handedly dominate a later aggregate
 *     summary.
 */
const ACTUAL_OUTCOME_WEIGHTS = {
  profitable: 50,
  stillActive: 30,
  revenueRatio: 20,
} as const;

export interface ActualOutcomeMetrics {
  revenueUsdc: number;
  spendUsdc: number;
  surplusUsdc: number;
  profitable: boolean;
  stillActive: boolean;
  revenueRatio: number; // 0..1, revenue / recommendedFundingUsdc, capped
  actualOutcomeScore: number; // 0..100
}

/**
 * Deterministic, documented composite — see ACTUAL_OUTCOME_WEIGHTS'
 * own header for why these three factors and this split. `stillActive`
 * reads agents.frozen (expansionKillSwitch.ts's own flag) and
 * genesis_activation_status directly rather than through a helper,
 * since neither expansionKillSwitch.ts nor genesisActivation.ts
 * exports a single "is this pipeline-spawned agent still a going
 * concern" boolean today — this is the one new read this module adds,
 * not a duplicate of an existing one.
 */
export function computeActualOutcomeMetrics(
  agentAddress: string,
  recommendedFundingUsdc: number | null,
): ActualOutcomeMetrics {
  const { revenueUsdc, spendUsdc, surplusUsdc, eligible: profitable } =
    isEligibleForExpansion(agentAddress);

  const agentRow = db
    .prepare(`SELECT frozen, genesis_activation_status AS status FROM agents WHERE address = ?`)
    .get(agentAddress) as { frozen: number; status: string | null } | undefined;
  const stillActive = Boolean(agentRow) && agentRow!.frozen === 0 && agentRow!.status !== "failed";

  const revenueRatio =
    recommendedFundingUsdc && recommendedFundingUsdc > 0
      ? Math.min(1, revenueUsdc / recommendedFundingUsdc)
      : 0;

  const actualOutcomeScore =
    (profitable ? ACTUAL_OUTCOME_WEIGHTS.profitable : 0) +
    (stillActive ? ACTUAL_OUTCOME_WEIGHTS.stillActive : 0) +
    revenueRatio * ACTUAL_OUTCOME_WEIGHTS.revenueRatio;

  return {
    revenueUsdc,
    spendUsdc,
    surplusUsdc,
    profitable,
    stillActive,
    revenueRatio: Math.round(revenueRatio * 100) / 100,
    actualOutcomeScore: Math.round(actualOutcomeScore * 100) / 100,
  };
}

/** Same threshold-banding shape 11e-iii-a's fit/roi divergence tagging
 *  already uses for the committee packet, applied here to predicted-
 *  vs-actual instead of roi-vs-fit. A delta at or beyond ±15 points (on
 *  the shared 0-100 scale both scores and the actual-outcome composite
 *  use) is read as the formula having meaningfully missed, not merely
 *  "not exactly right" — 0-100 scores are never going to land on an
 *  exact match against a real business outcome, so the band exists to
 *  keep normal noise from being reported as a miscalibration. */
const CALIBRATION_THRESHOLD = 15;

export type CalibrationVerdict = "formula_overestimated" | "formula_underestimated" | "formula_calibrated";

function bandCalibrationDelta(delta: number): CalibrationVerdict {
  if (delta <= -CALIBRATION_THRESHOLD) return "formula_overestimated";
  if (delta >= CALIBRATION_THRESHOLD) return "formula_underestimated";
  return "formula_calibrated";
}

export interface PostLaunchReview {
  id: string;
  opportunityId: string;
  agentAddress: string;
  rootAgentAddress: string;
  predictedRoiScore: number;
  predictedFitScore: number | null;
  recommendedFundingUsdc: number | null;
  reviewDueAt: number;
  status: "pending" | "completed";
  actual: ActualOutcomeMetrics | null;
  roiCalibrationDelta: number | null;
  fitCalibrationDelta: number | null;
  calibrationVerdict: CalibrationVerdict | null;
  createdAt: number;
  completedAt: number | null;
}

interface PostLaunchReviewRow {
  id: string;
  opportunity_id: string;
  agent_address: string;
  root_agent_address: string;
  predicted_roi_score: number;
  predicted_fit_score: number | null;
  recommended_funding_usdc: number | null;
  review_due_at: number;
  status: "pending" | "completed";
  actual_revenue_usdc: number | null;
  actual_spend_usdc: number | null;
  actual_surplus_usdc: number | null;
  actual_profitable: number | null;
  still_active: number | null;
  actual_outcome_score: number | null;
  roi_calibration_delta: number | null;
  fit_calibration_delta: number | null;
  calibration_verdict: CalibrationVerdict | null;
  created_at: number;
  completed_at: number | null;
}

function hydrate(row: PostLaunchReviewRow): PostLaunchReview {
  const actual: ActualOutcomeMetrics | null =
    row.status === "completed"
      ? {
          revenueUsdc: row.actual_revenue_usdc ?? 0,
          spendUsdc: row.actual_spend_usdc ?? 0,
          surplusUsdc: row.actual_surplus_usdc ?? 0,
          profitable: row.actual_profitable === 1,
          stillActive: row.still_active === 1,
          revenueRatio:
            row.recommended_funding_usdc && row.recommended_funding_usdc > 0
              ? Math.min(1, (row.actual_revenue_usdc ?? 0) / row.recommended_funding_usdc)
              : 0,
          actualOutcomeScore: row.actual_outcome_score ?? 0,
        }
      : null;
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    agentAddress: row.agent_address,
    rootAgentAddress: row.root_agent_address,
    predictedRoiScore: row.predicted_roi_score,
    predictedFitScore: row.predicted_fit_score,
    recommendedFundingUsdc: row.recommended_funding_usdc,
    reviewDueAt: row.review_due_at,
    status: row.status,
    actual,
    roiCalibrationDelta: row.roi_calibration_delta,
    fitCalibrationDelta: row.fit_calibration_delta,
    calibrationVerdict: row.calibration_verdict,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

/**
 * Called exactly once per pipeline-spawned agent, from
 * genesisExecutorAdapter() (genesis.ts) immediately after
 * activateGenesisAgent() actually flips the row to 'active' — an agent
 * that fails 17e-ii/17e-iii and never activates has nothing to review
 * (there's no operating history to grade), matching this table's own
 * UNIQUE(agent_address) constraint, which makes a second call for the
 * same agent a silent no-op rather than a second competing schedule.
 *
 * Snapshots predictedRoiScore/predictedFitScore/recommendedFundingUsdc
 * at this moment — see db.ts's own table comment for why a live re-read
 * at completion time would be the wrong choice.
 */
export function schedulePostLaunchReview(opportunityId: string, agentAddress: string): void {
  const existing = db
    .prepare(`SELECT 1 FROM post_launch_reviews WHERE agent_address = ?`)
    .get(agentAddress);
  if (existing) return;

  const opportunity = getOpportunity(opportunityId);
  if (!opportunity || opportunity.roi_score === null) {
    throw new Error(
      `cannot schedule a post-launch review for opportunity ${opportunityId}: no roi_score recorded`,
    );
  }
  const strategyFinding = getCurrentFinding<FitScoreFinding>("strategy", opportunityId);
  const trigger = getGenesisTrigger(opportunityId);

  db.prepare(
    `INSERT INTO post_launch_reviews
       (id, opportunity_id, agent_address, root_agent_address, predicted_roi_score,
        predicted_fit_score, recommended_funding_usdc, review_due_at, status, created_at)
     VALUES
       (@id, @opportunity_id, @agent_address, @root_agent_address, @predicted_roi_score,
        @predicted_fit_score, @recommended_funding_usdc, @review_due_at, 'pending', @created_at)`,
  ).run({
    id: `plr_${ulid()}`,
    opportunity_id: opportunityId,
    agent_address: agentAddress,
    root_agent_address: trigger?.agentAddress ?? "",
    predicted_roi_score: opportunity.roi_score,
    predicted_fit_score: strategyFinding?.findings?.fit_score ?? null,
    recommended_funding_usdc: trigger?.recommendedFundingUsdc ?? null,
    review_due_at: Date.now() + config.postLaunchReviewWindowDays * 24 * 60 * 60 * 1000,
    created_at: Date.now(),
  });
}

/** Completes exactly one due review: computes actual outcome metrics,
 *  bands the calibration deltas, writes them, flips status to
 *  'completed'. Idempotent by construction — the caller (runDuePostLaunchReviews()
 *  below) only ever selects 'pending' rows past their due date, and this
 *  function's own UPDATE is scoped to `status = 'pending'`, so a review
 *  is graded exactly once no matter how many sweep ticks find it. */
function completeReview(row: PostLaunchReviewRow): void {
  const actual = computeActualOutcomeMetrics(row.agent_address, row.recommended_funding_usdc);
  const roiCalibrationDelta =
    Math.round((actual.actualOutcomeScore - row.predicted_roi_score) * 100) / 100;
  const fitCalibrationDelta =
    row.predicted_fit_score === null
      ? null
      : Math.round((actual.actualOutcomeScore - row.predicted_fit_score) * 100) / 100;
  const calibrationVerdict = bandCalibrationDelta(roiCalibrationDelta);

  db.prepare(
    `UPDATE post_launch_reviews SET
       status = 'completed',
       actual_revenue_usdc = @actual_revenue_usdc,
       actual_spend_usdc = @actual_spend_usdc,
       actual_surplus_usdc = @actual_surplus_usdc,
       actual_profitable = @actual_profitable,
       still_active = @still_active,
       actual_outcome_score = @actual_outcome_score,
       roi_calibration_delta = @roi_calibration_delta,
       fit_calibration_delta = @fit_calibration_delta,
       calibration_verdict = @calibration_verdict,
       completed_at = @completed_at
     WHERE id = @id AND status = 'pending'`,
  ).run({
    id: row.id,
    actual_revenue_usdc: actual.revenueUsdc,
    actual_spend_usdc: actual.spendUsdc,
    actual_surplus_usdc: actual.surplusUsdc,
    actual_profitable: actual.profitable ? 1 : 0,
    still_active: actual.stillActive ? 1 : 0,
    actual_outcome_score: actual.actualOutcomeScore,
    roi_calibration_delta: roiCalibrationDelta,
    fit_calibration_delta: fitCalibrationDelta,
    calibration_verdict: calibrationVerdict,
    completed_at: Date.now(),
  });
}

/** The sweep: every pending review whose due date has passed gets
 *  completed in this tick. Returns how many were completed, mainly for
 *  the test mirror / manual-trigger route to report back. */
export function runDuePostLaunchReviews(): number {
  const due = db
    .prepare(`SELECT * FROM post_launch_reviews WHERE status = 'pending' AND review_due_at <= ?`)
    .all(Date.now()) as PostLaunchReviewRow[];
  for (const row of due) {
    completeReview(row);
  }
  return due.length;
}

export function getPostLaunchReview(agentAddress: string): PostLaunchReview | undefined {
  const row = db
    .prepare(`SELECT * FROM post_launch_reviews WHERE agent_address = ?`)
    .get(agentAddress) as PostLaunchReviewRow | undefined;
  return row ? hydrate(row) : undefined;
}

export function listPostLaunchReviewsForRoot(rootAgentAddress: string): PostLaunchReview[] {
  const rows = db
    .prepare(`SELECT * FROM post_launch_reviews WHERE root_agent_address = ? ORDER BY created_at DESC`)
    .all(rootAgentAddress) as PostLaunchReviewRow[];
  return rows.map(hydrate);
}

export interface RoiCalibrationSummary {
  completedReviewCount: number;
  averageRoiCalibrationDelta: number | null;
  overestimatedCount: number;
  underestimatedCount: number;
  calibratedCount: number;
  suggestion: string;
}

/** Zent.md 20e's own "feeds back into tuning 3b's formula" line, made
 *  concrete: a plain-language, code-computed suggestion aggregated
 *  across every completed review for one root (or, with no argument,
 *  globally across every root's pipeline). Requires at least
 *  MIN_REVIEWS_FOR_SUGGESTION completed reviews before offering a
 *  directional suggestion at all — same "don't overfit a formula to a
 *  handful of noisy outcomes" reasoning this file's own header already
 *  gives for not auto-mutating ROI_WEIGHTS directly. Below that count,
 *  the suggestion is always "insufficient data," regardless of what the
 *  available deltas look like. */
const MIN_REVIEWS_FOR_SUGGESTION = 5;

export function summarizeRoiCalibration(rootAgentAddress?: string): RoiCalibrationSummary {
  const rows = (
    rootAgentAddress
      ? db
          .prepare(
            `SELECT roi_calibration_delta, calibration_verdict FROM post_launch_reviews
             WHERE status = 'completed' AND root_agent_address = ?`,
          )
          .all(rootAgentAddress)
      : db
          .prepare(
            `SELECT roi_calibration_delta, calibration_verdict FROM post_launch_reviews
             WHERE status = 'completed'`,
          )
          .all()
  ) as { roi_calibration_delta: number; calibration_verdict: CalibrationVerdict }[];

  const completedReviewCount = rows.length;
  const overestimatedCount = rows.filter((r) => r.calibration_verdict === "formula_overestimated").length;
  const underestimatedCount = rows.filter((r) => r.calibration_verdict === "formula_underestimated").length;
  const calibratedCount = rows.filter((r) => r.calibration_verdict === "formula_calibrated").length;
  const averageRoiCalibrationDelta =
    completedReviewCount === 0
      ? null
      : Math.round(
          (rows.reduce((sum, r) => sum + r.roi_calibration_delta, 0) / completedReviewCount) * 100,
        ) / 100;

  let suggestion: string;
  if (completedReviewCount < MIN_REVIEWS_FOR_SUGGESTION) {
    suggestion = `insufficient data: ${completedReviewCount} completed review(s), need at least ${MIN_REVIEWS_FOR_SUGGESTION} before suggesting a formula change`;
  } else if (overestimatedCount > completedReviewCount / 2) {
    suggestion =
      `${overestimatedCount}/${completedReviewCount} reviews show 3b's roi_score formula overestimating actual outcomes ` +
      `(average delta ${averageRoiCalibrationDelta}) — consider re-weighting ROI_WEIGHTS toward factors that correlate ` +
      `more strongly with actual profitability before the next tuning pass`;
  } else if (underestimatedCount > completedReviewCount / 2) {
    suggestion =
      `${underestimatedCount}/${completedReviewCount} reviews show 3b's roi_score formula underestimating actual outcomes ` +
      `(average delta ${averageRoiCalibrationDelta}) — opportunities may be getting filtered out by the 3e ROI floor ` +
      `that would have performed well; consider reviewing ROI_WEIGHTS`;
  } else {
    suggestion = `${calibratedCount}/${completedReviewCount} reviews are within the ±${CALIBRATION_THRESHOLD}-point calibration band — no formula change indicated`;
  }

  return {
    completedReviewCount,
    averageRoiCalibrationDelta,
    overestimatedCount,
    underestimatedCount,
    calibratedCount,
    suggestion,
  };
}

// Registered here (module-load side effect), not in scheduler.ts itself
// — same split expansion.ts's own Phase 3d Top-N job and
// departments.ts's TTL reaper registrations already establish. This
// module is loaded at boot because genesis.ts imports
// schedulePostLaunchReview() from it and index.ts imports genesis.ts —
// no separate wiring needed for this registration to actually run.
//
// 6-hour cadence: review windows are days-scale (30 days by default),
// so there's no need for expansion_top_n_selection's 2-minute
// tightness — this just needs to notice a due review well within the
// same day it comes due. leaseMs generously above intervalMs for the
// same "a merely-slow run must never be mistaken for a crashed one"
// reason every other registration in this codebase gives.
runOnScheduleWithLease({
  name: "post_launch_review_sweep",
  intervalMs: 6 * 60 * 60_000,
  leaseMs: 30 * 60_000,
  fn: async () => {
    runDuePostLaunchReviews();
  },
});
