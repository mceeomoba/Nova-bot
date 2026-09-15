// Zent.md Phase 9d: "Sensitivity note: what changes the recommendation
// most (time-to-revenue vs build cost vs capital available) — cheap to
// compute, valuable for the CEO gate."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's pure
// computeSensitivityNote() (no DB access) directly, plus a standalone
// check on the MissingSensitivityPrerequisitesError guard's condition.
// Recommend re-running against the real expansion.ts once a networked
// environment (DB) is available.

import { test } from "node:test";
import assert from "node:assert/strict";

const SENSITIVITY_STRESS_FRACTION = 0.2;
const DAYS_PER_MONTH = 30;

type SizingCapReason = "available_capital" | "per_call_cap" | "per_day_cap";
type SensitivityFactor = "build_cost" | "time_to_revenue" | "available_capital";

const SENSITIVITY_FACTOR_LABELS: Record<SensitivityFactor, string> = {
  build_cost: "build cost",
  time_to_revenue: "time to revenue",
  available_capital: "available capital",
};

interface BuildCostEstimate {
  basis: "historical_department_spend" | "fallback_default_cap";
  sampleDepartments: number;
  avgCostPerDepartmentUsdc: number;
  assumedDepartmentsForMvp: number;
  estimatedBuildCostUsdc: number;
  estimatedAt: number;
}

interface TimeToRevenueEstimate {
  basis: "historical_department_duration" | "fallback_default_months";
  sampleDepartments: number;
  avgDepartmentBuildTimeMonths: number;
  assumedDepartmentsForMvp: number;
  estimatedMonthsToRevenue: number;
  estimatedAt: number;
}

interface AvailableCapitalCheck {
  walletBalanceUsdc: number;
  spendRateWindowDays: number;
  totalSpendInWindowUsdc: number;
  dailySpendRateUsdc: number;
  expansionCapitalFractionApplied: number;
  availableExpansionCapitalUsdc: number;
  checkedAt: number;
}

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

interface SensitivityNote {
  stressFractionApplied: number;
  buildCostImpactUsdc: number;
  timeToRevenueImpactUsdc: number;
  availableCapitalImpactUsdc: number;
  mostSensitiveFactor: SensitivityFactor;
  rankedFactors: SensitivityFactor[];
  note: string;
  computedAt: number;
}

// ─── Inlined mirror of expansion.ts's computeSizingRecommendation() ───
// (9b) — needed so this file can re-run it under stress the same way
// the real computeSensitivityNote() does.

function computeSizingRecommendation(
  buildCostEstimate: BuildCostEstimate,
  availableCapitalCheck: AvailableCapitalCheck,
  alreadyCommittedTodayUsdc: number,
  perCallCapUsdc: number,
  perDayCapUsdc: number,
): SizingRecommendation {
  const buildCostEstimateUsdc = buildCostEstimate.estimatedBuildCostUsdc;
  const availableExpansionCapitalUsdc = availableCapitalCheck.availableExpansionCapitalUsdc;
  const perDayRemainingUsdc = Math.max(0, perDayCapUsdc - alreadyCommittedTodayUsdc);

  const limits: { key: SizingCapReason; value: number }[] = [
    { key: "available_capital", value: availableExpansionCapitalUsdc },
    { key: "per_call_cap", value: perCallCapUsdc },
    { key: "per_day_cap", value: perDayRemainingUsdc },
  ];

  const tightestLimitUsdc = Math.min(buildCostEstimateUsdc, ...limits.map((l) => l.value));
  const recommendedFundingUsdc = Math.max(0, tightestLimitUsdc);
  const cappedBy = limits
    .filter((l) => l.value <= buildCostEstimateUsdc && l.value === tightestLimitUsdc)
    .map((l) => l.key);

  return {
    buildCostEstimateUsdc,
    availableExpansionCapitalUsdc,
    perCallCapUsdc,
    perDayCapUsdc,
    alreadyCommittedTodayUsdc,
    perDayRemainingUsdc,
    recommendedFundingUsdc,
    fullyFunded: recommendedFundingUsdc >= buildCostEstimateUsdc,
    cappedBy,
    recommendedAt: Date.now(),
  };
}

// ─── Inlined mirror of expansion.ts's computeSensitivityNote() ────────

function computeSensitivityNote(
  buildCostEstimate: BuildCostEstimate,
  timeToRevenueEstimate: TimeToRevenueEstimate,
  availableCapitalCheck: AvailableCapitalCheck,
  recommendation: SizingRecommendation,
  stressFraction: number = SENSITIVITY_STRESS_FRACTION,
): SensitivityNote {
  const stressedBuildCostEstimate: BuildCostEstimate = {
    ...buildCostEstimate,
    estimatedBuildCostUsdc: buildCostEstimate.estimatedBuildCostUsdc * (1 + stressFraction),
  };
  const stressedAvailableCapitalCheck: AvailableCapitalCheck = {
    ...availableCapitalCheck,
    availableExpansionCapitalUsdc:
      availableCapitalCheck.availableExpansionCapitalUsdc * (1 - stressFraction),
  };

  const withStressedBuildCost = computeSizingRecommendation(
    stressedBuildCostEstimate,
    availableCapitalCheck,
    recommendation.alreadyCommittedTodayUsdc,
    recommendation.perCallCapUsdc,
    recommendation.perDayCapUsdc,
  );
  const withStressedAvailableCapital = computeSizingRecommendation(
    buildCostEstimate,
    stressedAvailableCapitalCheck,
    recommendation.alreadyCommittedTodayUsdc,
    recommendation.perCallCapUsdc,
    recommendation.perDayCapUsdc,
  );

  const buildCostImpactUsdc = Math.abs(
    withStressedBuildCost.recommendedFundingUsdc - recommendation.recommendedFundingUsdc,
  );
  const availableCapitalImpactUsdc = Math.abs(
    withStressedAvailableCapital.recommendedFundingUsdc - recommendation.recommendedFundingUsdc,
  );
  const extraMonthsToRevenue = timeToRevenueEstimate.estimatedMonthsToRevenue * stressFraction;
  const timeToRevenueImpactUsdc =
    extraMonthsToRevenue * DAYS_PER_MONTH * availableCapitalCheck.dailySpendRateUsdc;

  const impacts: { key: SensitivityFactor; value: number }[] = [
    { key: "build_cost", value: buildCostImpactUsdc },
    { key: "time_to_revenue", value: timeToRevenueImpactUsdc },
    { key: "available_capital", value: availableCapitalImpactUsdc },
  ];
  const rankedFactors = [...impacts].sort((a, b) => b.value - a.value).map((i) => i.key);
  const mostSensitiveFactor = rankedFactors[0];
  const topImpactUsdc = impacts.find((i) => i.key === mostSensitiveFactor)!.value;

  const note =
    `A ${(stressFraction * 100).toFixed(0)}% adverse move in ` +
    `${SENSITIVITY_FACTOR_LABELS[mostSensitiveFactor]} changes this recommendation the most ` +
    `(~${topImpactUsdc.toFixed(2)} USDC), ahead of ${SENSITIVITY_FACTOR_LABELS[rankedFactors[1]]} ` +
    `and ${SENSITIVITY_FACTOR_LABELS[rankedFactors[2]]}.`;

  return {
    stressFractionApplied: stressFraction,
    buildCostImpactUsdc,
    timeToRevenueImpactUsdc,
    availableCapitalImpactUsdc,
    mostSensitiveFactor,
    rankedFactors,
    note,
    computedAt: Date.now(),
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────

function fakeBuildCostEstimate(overrides: Partial<BuildCostEstimate> = {}): BuildCostEstimate {
  return {
    basis: "historical_department_spend",
    sampleDepartments: 3,
    avgCostPerDepartmentUsdc: 100,
    assumedDepartmentsForMvp: 3,
    estimatedBuildCostUsdc: 300,
    estimatedAt: Date.now(),
    ...overrides,
  };
}

function fakeTimeToRevenueEstimate(
  overrides: Partial<TimeToRevenueEstimate> = {},
): TimeToRevenueEstimate {
  return {
    basis: "historical_department_duration",
    sampleDepartments: 3,
    avgDepartmentBuildTimeMonths: 2,
    assumedDepartmentsForMvp: 3,
    estimatedMonthsToRevenue: 6,
    estimatedAt: Date.now(),
    ...overrides,
  };
}

function fakeAvailableCapitalCheck(
  overrides: Partial<AvailableCapitalCheck> = {},
): AvailableCapitalCheck {
  return {
    walletBalanceUsdc: 4000,
    spendRateWindowDays: 30,
    totalSpendInWindowUsdc: 300,
    dailySpendRateUsdc: 10,
    expansionCapitalFractionApplied: 0.1,
    availableExpansionCapitalUsdc: 400,
    checkedAt: Date.now(),
    ...overrides,
  };
}

function fakeSizingRecommendation(
  overrides: Partial<SizingRecommendation> = {},
): SizingRecommendation {
  return {
    buildCostEstimateUsdc: 300,
    availableExpansionCapitalUsdc: 400,
    perCallCapUsdc: 500,
    perDayCapUsdc: 1000,
    alreadyCommittedTodayUsdc: 0,
    perDayRemainingUsdc: 1000,
    recommendedFundingUsdc: 300,
    fullyFunded: true,
    cappedBy: [],
    recommendedAt: Date.now(),
    ...overrides,
  };
}

test("note_sensitivity ranks all three factors and picks the largest impact as most sensitive", () => {
  const note = computeSensitivityNote(
    fakeBuildCostEstimate({ estimatedBuildCostUsdc: 300 }),
    fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 6 }),
    fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 400, dailySpendRateUsdc: 10 }),
    fakeSizingRecommendation({ recommendedFundingUsdc: 300 }),
  );
  assert.equal(note.rankedFactors.length, 3);
  assert.equal(new Set(note.rankedFactors).size, 3);
  assert.equal(note.mostSensitiveFactor, note.rankedFactors[0]);
  const maxImpact = Math.max(
    note.buildCostImpactUsdc,
    note.timeToRevenueImpactUsdc,
    note.availableCapitalImpactUsdc,
  );
  const impactByFactor: Record<SensitivityFactor, number> = {
    build_cost: note.buildCostImpactUsdc,
    time_to_revenue: note.timeToRevenueImpactUsdc,
    available_capital: note.availableCapitalImpactUsdc,
  };
  assert.equal(impactByFactor[note.mostSensitiveFactor], maxImpact);
});

test("note_sensitivity: build cost is the binding constraint, so stressing it moves the recommendation directly", () => {
  // recommendedFundingUsdc = 300 is bound by build cost (300 < 400
  // available capital) — a 20% build-cost increase should shift the
  // recommendation by exactly that stressed delta.
  const note = computeSensitivityNote(
    fakeBuildCostEstimate({ estimatedBuildCostUsdc: 300 }),
    fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 1 }), // small, to keep it out of the lead
    fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 400, dailySpendRateUsdc: 1 }),
    fakeSizingRecommendation({ recommendedFundingUsdc: 300 }),
  );
  // stressed build cost = 360, still under the 400 capital ceiling, so
  // recommendedFundingUsdc moves from 300 -> 360: an impact of 60.
  assert.ok(Math.abs(note.buildCostImpactUsdc - 60) < 1e-9);
  assert.equal(note.mostSensitiveFactor, "build_cost");
});

test("note_sensitivity: available capital is the binding constraint, so stressing it moves the recommendation directly", () => {
  // recommendedFundingUsdc = 200 is bound by available capital (200 <
  // 500 build cost) — a 20% capital cut should shift the recommendation
  // by exactly that stressed delta.
  const note = computeSensitivityNote(
    fakeBuildCostEstimate({ estimatedBuildCostUsdc: 500 }),
    fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 1 }),
    fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 200, dailySpendRateUsdc: 1 }),
    fakeSizingRecommendation({ recommendedFundingUsdc: 200 }),
  );
  // stressed available capital = 160, still under the 500 build-cost
  // ceiling, so recommendedFundingUsdc moves from 200 -> 160: an impact
  // of 40.
  assert.ok(Math.abs(note.availableCapitalImpactUsdc - 40) < 1e-9);
  assert.equal(note.mostSensitiveFactor, "available_capital");
});

test("note_sensitivity: time-to-revenue impact is grounded in the agent's own recorded daily spend rate", () => {
  const note = computeSensitivityNote(
    fakeBuildCostEstimate(),
    fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 10 }),
    fakeAvailableCapitalCheck({ dailySpendRateUsdc: 5 }),
    fakeSizingRecommendation(),
  );
  // extraMonths = 10 x 0.2 = 2; impact = 2 x 30 x 5 = 300.
  assert.ok(Math.abs(note.timeToRevenueImpactUsdc - 300) < 1e-9);
});

test("note_sensitivity: a zero daily spend rate means a schedule slip costs nothing extra, by construction", () => {
  const note = computeSensitivityNote(
    fakeBuildCostEstimate(),
    fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 24 }),
    fakeAvailableCapitalCheck({ dailySpendRateUsdc: 0 }),
    fakeSizingRecommendation(),
  );
  assert.equal(note.timeToRevenueImpactUsdc, 0);
  assert.notEqual(note.mostSensitiveFactor, "time_to_revenue");
});

test("note_sensitivity respects a non-default stress fraction consistently across all three factors", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 300 });
  const timeToRevenue = fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 6 });
  const capital = fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 1000, dailySpendRateUsdc: 10 });
  const rec = fakeSizingRecommendation({ recommendedFundingUsdc: 300 });

  const mild = computeSensitivityNote(buildCost, timeToRevenue, capital, rec, 0.1);
  const severe = computeSensitivityNote(buildCost, timeToRevenue, capital, rec, 0.4);

  assert.equal(mild.stressFractionApplied, 0.1);
  assert.equal(severe.stressFractionApplied, 0.4);
  assert.ok(severe.buildCostImpactUsdc >= mild.buildCostImpactUsdc);
  assert.ok(severe.timeToRevenueImpactUsdc >= mild.timeToRevenueImpactUsdc);
});

test("note_sensitivity's human-readable note names the leading factor and both runners-up", () => {
  const note = computeSensitivityNote(
    fakeBuildCostEstimate({ estimatedBuildCostUsdc: 300 }),
    fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 1 }),
    fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 400, dailySpendRateUsdc: 1 }),
    fakeSizingRecommendation({ recommendedFundingUsdc: 300 }),
  );
  assert.ok(note.note.includes(SENSITIVITY_FACTOR_LABELS[note.mostSensitiveFactor]));
  assert.ok(note.note.includes(SENSITIVITY_FACTOR_LABELS[note.rankedFactors[1]]));
  assert.ok(note.note.includes(SENSITIVITY_FACTOR_LABELS[note.rankedFactors[2]]));
});

// ─── The prerequisite guard: recordSensitivityNote() requires 8b's ────
// ─── build_cost, 8c's time_to_revenue, 8d's available_capital, and ────
// ─── 9b's sizing_recommendation to already exist ───────────────────────

interface FakeFinanceFinding {
  findings: Record<string, unknown>;
}

class MissingSensitivityPrerequisitesError extends Error {
  status = 409;
  constructor(opportunityId: string, missingTools: string[]) {
    super(
      `${missingTools.join(" and ")} must run for opportunity ${opportunityId} before the sensitivity note`,
    );
    this.name = "MissingSensitivityPrerequisitesError";
  }
}

function recordSensitivityNote(
  opportunityId: string,
  current: FakeFinanceFinding | undefined,
): SensitivityNote {
  const buildCostEstimate = current?.findings?.build_cost as BuildCostEstimate | undefined;
  const timeToRevenueEstimate = current?.findings?.time_to_revenue as
    | TimeToRevenueEstimate
    | undefined;
  const availableCapitalCheck = current?.findings?.available_capital as
    | AvailableCapitalCheck
    | undefined;
  const recommendation = current?.findings?.sizing_recommendation as
    | SizingRecommendation
    | undefined;

  const missingTools: string[] = [];
  if (!buildCostEstimate) missingTools.push("estimate_build_cost");
  if (!timeToRevenueEstimate) missingTools.push("estimate_time_to_revenue");
  if (!availableCapitalCheck) missingTools.push("check_available_capital");
  if (!recommendation) missingTools.push("recommend_sizing");
  if (missingTools.length > 0) {
    throw new MissingSensitivityPrerequisitesError(opportunityId, missingTools);
  }

  return computeSensitivityNote(
    buildCostEstimate!,
    timeToRevenueEstimate!,
    availableCapitalCheck!,
    recommendation!,
  );
}

test("note_sensitivity refuses to invent a note when any prerequisite finding is missing", () => {
  assert.throws(
    () => recordSensitivityNote("opp_1", undefined),
    MissingSensitivityPrerequisitesError,
  );
  assert.throws(
    () => recordSensitivityNote("opp_1", { findings: {} }),
    MissingSensitivityPrerequisitesError,
  );
  assert.throws(
    () =>
      recordSensitivityNote("opp_1", {
        findings: {
          build_cost: fakeBuildCostEstimate(),
          time_to_revenue: fakeTimeToRevenueEstimate(),
          // available_capital and sizing_recommendation still missing
        },
      }),
    MissingSensitivityPrerequisitesError,
  );
});

test("note_sensitivity's guard error lists every missing tool and carries a 409 status", () => {
  try {
    recordSensitivityNote("opp_1", { findings: { build_cost: fakeBuildCostEstimate() } });
    assert.fail("expected MissingSensitivityPrerequisitesError to throw");
  } catch (err) {
    assert.ok(err instanceof MissingSensitivityPrerequisitesError);
    assert.equal((err as MissingSensitivityPrerequisitesError).status, 409);
    assert.ok((err as Error).message.includes("estimate_time_to_revenue"));
    assert.ok((err as Error).message.includes("check_available_capital"));
    assert.ok((err as Error).message.includes("recommend_sizing"));
  }
});

test("note_sensitivity succeeds once all four prerequisite findings are present", () => {
  const note = recordSensitivityNote("opp_1", {
    findings: {
      build_cost: fakeBuildCostEstimate({ estimatedBuildCostUsdc: 300 }),
      time_to_revenue: fakeTimeToRevenueEstimate({ estimatedMonthsToRevenue: 6 }),
      available_capital: fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 400 }),
      sizing_recommendation: fakeSizingRecommendation({ recommendedFundingUsdc: 300 }),
    },
  });
  assert.equal(note.stressFractionApplied, SENSITIVITY_STRESS_FRACTION);
  assert.ok(note.rankedFactors.length === 3);
});
