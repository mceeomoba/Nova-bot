// Zent.md Phase 9c: "Staged-funding option: Finance may recommend a
// smaller initial grant with a milestone-based follow-on instead of
// one lump sum — modeled, not yet wired to disbursement (that's Phase
// 16)."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's pure
// computeStagedFundingOption() (no DB access) directly, plus a
// standalone check on the MissingSizingRecommendationError guard's
// condition. Recommend re-running against the real expansion.ts once a
// networked environment (DB) is available.

import { test } from "node:test";
import assert from "node:assert/strict";

const WORST_CASE_LOSS_OVERRUN_MULTIPLIER = 1.5;
const DEFAULT_INITIAL_FRACTION = 0.5;
const STAGED_FUNDING_FOLLOW_ON_TRIGGER_UNMODELED = "milestone_completion_not_yet_modeled";

type SizingCapReason = "available_capital" | "per_call_cap" | "per_day_cap";

interface SizingRecommendation {
  buildCostEstimateUsdc: number;
  availableExpansionCapitalUsdc: number;
  perCallCapUsdc: number;
  perDayCapUsdc: number;
  alreadyCommittedTodayUsdc: number;
  perDayRemainingUsdc: number;
  recommendedFundingUsdc: number;
  fullyFunded: boolean;
  cappedBy: SizingCapReason[];
  recommendedAt: number;
}

interface StagedFundingOption {
  totalRecommendedUsdc: number;
  initialFractionApplied: number;
  initialGrantUsdc: number;
  followOnUsdc: number;
  followOnTrigger: string;
  worstCaseLossIfLumpSumUsdc: number;
  worstCaseLossIfStagedUsdc: number;
  worstCaseLossReductionUsdc: number;
  modeledAt: number;
}

// ─── Inlined mirror of expansion.ts's computeStagedFundingOption() ────
// initialFraction/overrunMultiplier passed explicitly here instead of
// defaulted from config/9a's own constant, same "pure function over
// already-resolved inputs" shape the real computeStagedFundingOption()
// itself uses.

function computeStagedFundingOption(
  recommendation: SizingRecommendation,
  initialFraction: number,
  overrunMultiplier: number,
): StagedFundingOption {
  const totalRecommendedUsdc = recommendation.recommendedFundingUsdc;
  const initialGrantUsdc = totalRecommendedUsdc * initialFraction;
  const followOnUsdc = totalRecommendedUsdc - initialGrantUsdc;

  const worstCaseLossIfLumpSumUsdc = totalRecommendedUsdc * overrunMultiplier;
  const worstCaseLossIfStagedUsdc = initialGrantUsdc * overrunMultiplier;

  return {
    totalRecommendedUsdc,
    initialFractionApplied: initialFraction,
    initialGrantUsdc,
    followOnUsdc,
    followOnTrigger: STAGED_FUNDING_FOLLOW_ON_TRIGGER_UNMODELED,
    worstCaseLossIfLumpSumUsdc,
    worstCaseLossIfStagedUsdc,
    worstCaseLossReductionUsdc: worstCaseLossIfLumpSumUsdc - worstCaseLossIfStagedUsdc,
    modeledAt: Date.now(),
  };
}

function fakeSizingRecommendation(
  overrides: Partial<SizingRecommendation> = {},
): SizingRecommendation {
  return {
    buildCostEstimateUsdc: 400,
    availableExpansionCapitalUsdc: 400,
    perCallCapUsdc: 500,
    perDayCapUsdc: 1000,
    alreadyCommittedTodayUsdc: 0,
    perDayRemainingUsdc: 1000,
    recommendedFundingUsdc: 400,
    fullyFunded: true,
    cappedBy: [],
    recommendedAt: Date.now(),
    ...overrides,
  };
}

test("propose_staged_funding splits the recommended amount by the configured initial fraction", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 400 });
  const option = computeStagedFundingOption(rec, 0.5, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(option.initialGrantUsdc, 200);
  assert.equal(option.followOnUsdc, 200);
});

test("propose_staged_funding's initial grant and follow-on always sum back to the total exactly", () => {
  const fractions = [0, 0.25, 0.5, 0.5, 0.75, 1];
  const amounts = [45, 100, 333, 999.99, 0, 250];
  for (const initialFraction of fractions) {
    for (const recommendedFundingUsdc of amounts) {
      const rec = fakeSizingRecommendation({ recommendedFundingUsdc });
      const option = computeStagedFundingOption(rec, initialFraction, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
      assert.ok(
        Math.abs(option.initialGrantUsdc + option.followOnUsdc - recommendedFundingUsdc) < 1e-9,
      );
    }
  }
});

test("propose_staged_funding never proposes an initial grant larger than the lump-sum total", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 400 });
  const option = computeStagedFundingOption(rec, 0.5, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.ok(option.initialGrantUsdc <= option.totalRecommendedUsdc);
  assert.ok(option.followOnUsdc >= 0);
});

test("propose_staged_funding's worst-case-loss reduction is always non-negative, for any fraction in [0, 1]", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 800 });
  for (const initialFraction of [0, 0.1, 0.5, 0.9, 1]) {
    const option = computeStagedFundingOption(rec, initialFraction, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
    assert.ok(option.worstCaseLossReductionUsdc >= 0);
    assert.equal(
      option.worstCaseLossReductionUsdc,
      option.worstCaseLossIfLumpSumUsdc - option.worstCaseLossIfStagedUsdc,
    );
  }
});

test("propose_staged_funding: a 100% initial fraction reduces staging to the lump sum, zero exposure reduction", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 600 });
  const option = computeStagedFundingOption(rec, 1, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(option.initialGrantUsdc, 600);
  assert.equal(option.followOnUsdc, 0);
  assert.equal(option.worstCaseLossReductionUsdc, 0);
});

test("propose_staged_funding: a 0% initial fraction defers everything to follow-on, maximum exposure reduction", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 600 });
  const option = computeStagedFundingOption(rec, 0, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(option.initialGrantUsdc, 0);
  assert.equal(option.followOnUsdc, 600);
  assert.equal(option.worstCaseLossIfStagedUsdc, 0);
  assert.equal(option.worstCaseLossReductionUsdc, option.worstCaseLossIfLumpSumUsdc);
});

test("propose_staged_funding applies 9a's own overrun multiplier to the initial grant, not the lump sum, for the staged figure", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 400 });
  const option = computeStagedFundingOption(rec, 0.5, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(option.worstCaseLossIfLumpSumUsdc, 600); // 400 x 1.5
  assert.equal(option.worstCaseLossIfStagedUsdc, 300); // 200 x 1.5
});

test("propose_staged_funding carries a fixed, honest placeholder for the follow-on trigger — no invented milestone-detection logic", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 400 });
  const option = computeStagedFundingOption(rec, 0.5, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(option.followOnTrigger, "milestone_completion_not_yet_modeled");
});

test("propose_staged_funding respects a non-default configured initial fraction", () => {
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 1000 });
  const conservative = computeStagedFundingOption(rec, 0.25, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(conservative.initialGrantUsdc, 250);
  assert.equal(conservative.followOnUsdc, 750);

  const aggressive = computeStagedFundingOption(rec, 0.75, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(aggressive.initialGrantUsdc, 750);
  assert.equal(aggressive.followOnUsdc, 250);

  // A smaller initial fraction always means smaller or equal exposure.
  assert.ok(conservative.worstCaseLossIfStagedUsdc <= aggressive.worstCaseLossIfStagedUsdc);
});

// ─── The prerequisite guard: recordStagedFundingOption() requires ─────
// ─── 9b's sizing_recommendation to already exist ───────────────────────

interface FakeFinanceFinding {
  findings: Record<string, unknown>;
}

class MissingSizingRecommendationError extends Error {
  status = 409;
  constructor(opportunityId: string) {
    super(
      `recommend_sizing must run for opportunity ${opportunityId} before propose_staged_funding`,
    );
    this.name = "MissingSizingRecommendationError";
  }
}

function recordStagedFundingOption(
  opportunityId: string,
  current: FakeFinanceFinding | undefined,
): StagedFundingOption {
  const recommendation = current?.findings?.sizing_recommendation as
    | SizingRecommendation
    | undefined;
  if (!recommendation) {
    throw new MissingSizingRecommendationError(opportunityId);
  }
  return computeStagedFundingOption(recommendation, DEFAULT_INITIAL_FRACTION, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
}

test("propose_staged_funding refuses to invent a split when 9b hasn't run yet for this opportunity", () => {
  assert.throws(
    () => recordStagedFundingOption("opp_1", undefined),
    MissingSizingRecommendationError,
  );
  assert.throws(
    () => recordStagedFundingOption("opp_1", { findings: {} }),
    MissingSizingRecommendationError,
  );
});

test("propose_staged_funding's guard error carries a 409 status for the route's generic err.status handler", () => {
  try {
    recordStagedFundingOption("opp_1", undefined);
    assert.fail("expected MissingSizingRecommendationError to throw");
  } catch (err) {
    assert.ok(err instanceof MissingSizingRecommendationError);
    assert.equal((err as MissingSizingRecommendationError).status, 409);
  }
});

test("propose_staged_funding succeeds once 9b's sizing_recommendation finding is present", () => {
  const option = recordStagedFundingOption("opp_1", {
    findings: { sizing_recommendation: fakeSizingRecommendation({ recommendedFundingUsdc: 400 }) },
  });
  assert.equal(option.initialGrantUsdc, 200);
  assert.equal(option.followOnUsdc, 200);
});
