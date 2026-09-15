// Zent.md Phase 9b: "Sizing recommendation: Finance proposes an initial
// funding amount for Agent B (feeds spawn_clone's existing per-call/
// per-day funding caps — Finance cannot recommend above those caps)."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's pure
// computeSizingRecommendation() (no DB access) directly, plus a
// standalone check on the MissingFinancePrerequisitesError guard's
// condition. Recommend re-running against the real expansion.ts once a
// networked environment (DB) is available.

import { test } from "node:test";
import assert from "node:assert/strict";

const DEFAULT_PER_CALL_CAP_USDC = 500;
const DEFAULT_PER_DAY_CAP_USDC = 1000;

interface BuildCostEstimate {
  basis: "historical_department_spend" | "fallback_default_cap";
  sampleDepartments: number;
  avgCostPerDepartmentUsdc: number;
  assumedDepartmentsForMvp: number;
  estimatedBuildCostUsdc: number;
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

// ─── Inlined mirror of expansion.ts's computeSizingRecommendation() ───
// perCallCapUsdc/perDayCapUsdc passed explicitly here instead of
// defaulted from config, same "pure function over already-resolved
// inputs" shape the real computeSizingRecommendation() itself uses.

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

function fakeBuildCostEstimate(overrides: Partial<BuildCostEstimate> = {}): BuildCostEstimate {
  return {
    basis: "historical_department_spend",
    sampleDepartments: 2,
    avgCostPerDepartmentUsdc: 15,
    assumedDepartmentsForMvp: 3,
    estimatedBuildCostUsdc: 45,
    estimatedAt: Date.now(),
    ...overrides,
  };
}

function fakeAvailableCapitalCheck(
  overrides: Partial<AvailableCapitalCheck> = {},
): AvailableCapitalCheck {
  return {
    walletBalanceUsdc: 1000,
    spendRateWindowDays: 30,
    totalSpendInWindowUsdc: 60,
    dailySpendRateUsdc: 2,
    expansionCapitalFractionApplied: 0.2,
    availableExpansionCapitalUsdc: 200,
    checkedAt: Date.now(),
    ...overrides,
  };
}

test("recommend_sizing proposes the full build-cost estimate when nothing binds tighter", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 45 });
  const capital = fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 200 });
  const rec = computeSizingRecommendation(
    buildCost,
    capital,
    0,
    DEFAULT_PER_CALL_CAP_USDC,
    DEFAULT_PER_DAY_CAP_USDC,
  );
  assert.equal(rec.recommendedFundingUsdc, 45);
  assert.equal(rec.fullyFunded, true);
  assert.deepEqual(rec.cappedBy, []);
});

test("recommend_sizing never recommends above 8d's available-capital slice", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 900 });
  const capital = fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 200 });
  const rec = computeSizingRecommendation(
    buildCost,
    capital,
    0,
    DEFAULT_PER_CALL_CAP_USDC,
    DEFAULT_PER_DAY_CAP_USDC,
  );
  assert.equal(rec.recommendedFundingUsdc, 200);
  assert.equal(rec.fullyFunded, false);
  assert.deepEqual(rec.cappedBy, ["available_capital"]);
});

test("recommend_sizing never recommends above the configured per-call cap, even with ample capital", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 5000 });
  const capital = fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 50000 });
  const rec = computeSizingRecommendation(
    buildCost,
    capital,
    0,
    DEFAULT_PER_CALL_CAP_USDC,
    DEFAULT_PER_DAY_CAP_USDC,
  );
  assert.equal(rec.recommendedFundingUsdc, DEFAULT_PER_CALL_CAP_USDC);
  assert.deepEqual(rec.cappedBy, ["per_call_cap"]);
});

test("recommend_sizing accounts for same-day commitments against the per-day cap", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 400 });
  const capital = fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 50000 });
  // $700 already committed today against a $1000/day cap leaves $300 remaining.
  const rec = computeSizingRecommendation(
    buildCost,
    capital,
    700,
    DEFAULT_PER_CALL_CAP_USDC,
    DEFAULT_PER_DAY_CAP_USDC,
  );
  assert.equal(rec.perDayRemainingUsdc, 300);
  assert.equal(rec.recommendedFundingUsdc, 300);
  assert.deepEqual(rec.cappedBy, ["per_day_cap"]);
});

test("recommend_sizing floors the per-day remaining budget at zero, never goes negative", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 400 });
  const capital = fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 50000 });
  // Already over the day's cap (e.g. a prior opportunity's own recommendation).
  const rec = computeSizingRecommendation(
    buildCost,
    capital,
    1500,
    DEFAULT_PER_CALL_CAP_USDC,
    DEFAULT_PER_DAY_CAP_USDC,
  );
  assert.equal(rec.perDayRemainingUsdc, 0);
  assert.equal(rec.recommendedFundingUsdc, 0);
  assert.equal(rec.fullyFunded, false);
  assert.deepEqual(rec.cappedBy, ["per_day_cap"]);
});

test("recommend_sizing surfaces every limit that ties for tightest, not just one", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 900 });
  const capital = fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: DEFAULT_PER_CALL_CAP_USDC });
  const rec = computeSizingRecommendation(
    buildCost,
    capital,
    0,
    DEFAULT_PER_CALL_CAP_USDC,
    DEFAULT_PER_DAY_CAP_USDC,
  );
  assert.equal(rec.recommendedFundingUsdc, DEFAULT_PER_CALL_CAP_USDC);
  assert.deepEqual(new Set(rec.cappedBy), new Set(["available_capital", "per_call_cap"]));
});

test("recommend_sizing's recommendation can never exceed either configured cap, across a spread of inputs", () => {
  // No human override anywhere in this pipeline (Zent.md's own closing
  // note) makes this invariant the load-bearing one: nothing downstream
  // re-checks that Finance stayed under the caps before Phase 16 wires
  // this number into an actual spawn_clone funding call, so the pure
  // function itself must never be able to produce a violation.
  const scenarios: [number, number, number][] = [
    [10, 5, 0],
    [1_000_000, 1_000_000, 0],
    [500, 500, 0],
    [500, 500, 499],
    [50, 1_000_000, 1_000_000],
  ];
  for (const [buildCostUsdc, availableCapitalUsdc, alreadyCommittedTodayUsdc] of scenarios) {
    const rec = computeSizingRecommendation(
      fakeBuildCostEstimate({ estimatedBuildCostUsdc: buildCostUsdc }),
      fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: availableCapitalUsdc }),
      alreadyCommittedTodayUsdc,
      DEFAULT_PER_CALL_CAP_USDC,
      DEFAULT_PER_DAY_CAP_USDC,
    );
    assert.ok(rec.recommendedFundingUsdc <= DEFAULT_PER_CALL_CAP_USDC);
    assert.ok(rec.recommendedFundingUsdc <= DEFAULT_PER_DAY_CAP_USDC);
    assert.ok(rec.recommendedFundingUsdc >= 0);
  }
});

// ─── The prerequisite guard: recordSizingRecommendation() requires ────
// ─── 8b's build_cost AND 8d's available_capital to already exist ──────

interface FakeFinanceFinding {
  findings: Record<string, unknown>;
}

class MissingFinancePrerequisitesError extends Error {
  status = 409;
  constructor(opportunityId: string, missingTools: string[]) {
    super(
      `${missingTools.join(" and ")} must run for opportunity ${opportunityId} before the sizing recommendation`,
    );
    this.name = "MissingFinancePrerequisitesError";
  }
}

function recordSizingRecommendation(
  opportunityId: string,
  current: FakeFinanceFinding | undefined,
): SizingRecommendation {
  const buildCostEstimate = current?.findings?.build_cost as BuildCostEstimate | undefined;
  const availableCapitalCheck = current?.findings?.available_capital as
    | AvailableCapitalCheck
    | undefined;
  const missingTools: string[] = [];
  if (!buildCostEstimate) missingTools.push("estimate_build_cost");
  if (!availableCapitalCheck) missingTools.push("check_available_capital");
  if (missingTools.length > 0) {
    throw new MissingFinancePrerequisitesError(opportunityId, missingTools);
  }
  return computeSizingRecommendation(
    buildCostEstimate!,
    availableCapitalCheck!,
    0,
    DEFAULT_PER_CALL_CAP_USDC,
    DEFAULT_PER_DAY_CAP_USDC,
  );
}

test("recommend_sizing refuses to invent a number when 8b and 8d haven't run yet for this opportunity", () => {
  assert.throws(
    () => recordSizingRecommendation("opp_1", undefined),
    MissingFinancePrerequisitesError,
  );
  assert.throws(
    () => recordSizingRecommendation("opp_1", { findings: {} }),
    MissingFinancePrerequisitesError,
  );
});

test("recommend_sizing refuses when only one of 8b/8d has run, naming the one still missing", () => {
  try {
    recordSizingRecommendation("opp_1", { findings: { build_cost: fakeBuildCostEstimate() } });
    assert.fail("expected MissingFinancePrerequisitesError to throw");
  } catch (err) {
    assert.ok(err instanceof MissingFinancePrerequisitesError);
    assert.match((err as Error).message, /check_available_capital/);
    assert.doesNotMatch((err as Error).message, /estimate_build_cost/);
  }

  try {
    recordSizingRecommendation("opp_1", {
      findings: { available_capital: fakeAvailableCapitalCheck() },
    });
    assert.fail("expected MissingFinancePrerequisitesError to throw");
  } catch (err) {
    assert.ok(err instanceof MissingFinancePrerequisitesError);
    assert.match((err as Error).message, /estimate_build_cost/);
    assert.doesNotMatch((err as Error).message, /check_available_capital/);
  }
});

test("recommend_sizing's guard error carries a 409 status for the route's generic err.status handler", () => {
  try {
    recordSizingRecommendation("opp_1", undefined);
    assert.fail("expected MissingFinancePrerequisitesError to throw");
  } catch (err) {
    assert.ok(err instanceof MissingFinancePrerequisitesError);
    assert.equal((err as MissingFinancePrerequisitesError).status, 409);
  }
});

test("recommend_sizing succeeds once both 8b's build_cost and 8d's available_capital findings are present", () => {
  const rec = recordSizingRecommendation("opp_1", {
    findings: {
      build_cost: fakeBuildCostEstimate({ estimatedBuildCostUsdc: 45 }),
      available_capital: fakeAvailableCapitalCheck({ availableExpansionCapitalUsdc: 200 }),
    },
  });
  assert.equal(rec.recommendedFundingUsdc, 45);
});
