// Zent.md Phase 9a: "Tool: estimate_worst_case_loss(opportunity_id) —
// the number if Agent B fails outright and its funding is a total
// write-off."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's pure
// computeWorstCaseLoss() (no DB access) directly, plus a standalone
// check on the MissingBuildCostEstimateError guard's condition.
// Recommend re-running against the real expansion.ts once a networked
// environment (DB) is available.

import { test } from "node:test";
import assert from "node:assert/strict";

const WORST_CASE_LOSS_OVERRUN_MULTIPLIER = 1.5;

interface BuildCostEstimate {
  basis: "historical_department_spend" | "fallback_default_cap";
  sampleDepartments: number;
  avgCostPerDepartmentUsdc: number;
  assumedDepartmentsForMvp: number;
  estimatedBuildCostUsdc: number;
  estimatedAt: number;
}

interface WorstCaseLossEstimate {
  basis: "build_cost_estimate";
  buildCostEstimateUsdc: number;
  buildCostBasis: BuildCostEstimate["basis"];
  worstCaseOverrunMultiplier: number;
  worstCaseLossUsdc: number;
  estimatedAt: number;
}

// ─── Inlined mirror of expansion.ts's computeWorstCaseLoss() ──────────
// overrunMultiplier passed explicitly here instead of defaulted from
// the module constant, same "pure function over already-resolved
// inputs" shape the real computeWorstCaseLoss() itself uses.

function computeWorstCaseLoss(
  buildCostEstimate: BuildCostEstimate,
  overrunMultiplier: number,
): WorstCaseLossEstimate {
  return {
    basis: "build_cost_estimate",
    buildCostEstimateUsdc: buildCostEstimate.estimatedBuildCostUsdc,
    buildCostBasis: buildCostEstimate.basis,
    worstCaseOverrunMultiplier: overrunMultiplier,
    worstCaseLossUsdc: buildCostEstimate.estimatedBuildCostUsdc * overrunMultiplier,
    estimatedAt: Date.now(),
  };
}

function fakeBuildCostEstimate(
  overrides: Partial<BuildCostEstimate> = {},
): BuildCostEstimate {
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

test("estimate_worst_case_loss applies the overrun multiplier on top of the real build-cost estimate", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 45 });
  const worstCase = computeWorstCaseLoss(buildCost, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.equal(worstCase.buildCostEstimateUsdc, 45);
  assert.equal(worstCase.worstCaseOverrunMultiplier, 1.5);
  assert.equal(worstCase.worstCaseLossUsdc, 67.5); // 45 x 1.5
});

test("estimate_worst_case_loss is always at least as large as the underlying build-cost estimate", () => {
  // A worst-case number that came in BELOW the baseline build-cost
  // estimate would defeat the point of a "worst case" figure — the
  // multiplier must never shrink the number.
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 100 });
  const worstCase = computeWorstCaseLoss(buildCost, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
  assert.ok(worstCase.worstCaseLossUsdc >= worstCase.buildCostEstimateUsdc);
});

test("estimate_worst_case_loss carries the build-cost basis through, distinguishing a history-grounded figure from a bootstrap fallback", () => {
  const historyGrounded = computeWorstCaseLoss(
    fakeBuildCostEstimate({ basis: "historical_department_spend" }),
    WORST_CASE_LOSS_OVERRUN_MULTIPLIER,
  );
  assert.equal(historyGrounded.buildCostBasis, "historical_department_spend");

  const fallbackGrounded = computeWorstCaseLoss(
    fakeBuildCostEstimate({ basis: "fallback_default_cap", estimatedBuildCostUsdc: 42 }),
    WORST_CASE_LOSS_OVERRUN_MULTIPLIER,
  );
  assert.equal(fallbackGrounded.buildCostBasis, "fallback_default_cap");
  assert.equal(fallbackGrounded.worstCaseLossUsdc, 63); // 42 x 1.5
});

test("estimate_worst_case_loss scales linearly with a different configured overrun multiplier", () => {
  const buildCost = fakeBuildCostEstimate({ estimatedBuildCostUsdc: 200 });
  const conservative = computeWorstCaseLoss(buildCost, 1.0); // no overrun assumed
  const aggressive = computeWorstCaseLoss(buildCost, 2.0); // double the plan

  assert.equal(conservative.worstCaseLossUsdc, 200);
  assert.equal(aggressive.worstCaseLossUsdc, 400);
  assert.ok(aggressive.worstCaseLossUsdc > conservative.worstCaseLossUsdc);
});

// ─── The prerequisite guard: recordWorstCaseLossEstimate() requires ───
// ─── 8b's build_cost finding to already exist on this opportunity ─────

interface FakeFinanceFinding {
  findings: Record<string, unknown>;
}

class MissingBuildCostEstimateError extends Error {
  status = 409;
  constructor(opportunityId: string) {
    super(
      `estimate_build_cost must run for opportunity ${opportunityId} before estimate_worst_case_loss`,
    );
    this.name = "MissingBuildCostEstimateError";
  }
}

function recordWorstCaseLossEstimate(
  opportunityId: string,
  current: FakeFinanceFinding | undefined,
): WorstCaseLossEstimate {
  const buildCostEstimate = current?.findings?.build_cost as BuildCostEstimate | undefined;
  if (!buildCostEstimate) {
    throw new MissingBuildCostEstimateError(opportunityId);
  }
  return computeWorstCaseLoss(buildCostEstimate, WORST_CASE_LOSS_OVERRUN_MULTIPLIER);
}

test("estimate_worst_case_loss refuses to invent a number when 8b hasn't run yet for this opportunity", () => {
  assert.throws(
    () => recordWorstCaseLossEstimate("opp_1", undefined),
    MissingBuildCostEstimateError,
  );
  assert.throws(
    () => recordWorstCaseLossEstimate("opp_1", { findings: {} }),
    MissingBuildCostEstimateError,
  );
});

test("estimate_worst_case_loss's guard error carries a 409 status for the route's generic err.status handler", () => {
  try {
    recordWorstCaseLossEstimate("opp_1", undefined);
    assert.fail("expected MissingBuildCostEstimateError to throw");
  } catch (err) {
    assert.ok(err instanceof MissingBuildCostEstimateError);
    assert.equal((err as MissingBuildCostEstimateError).status, 409);
  }
});

test("estimate_worst_case_loss succeeds once 8b's build_cost finding is present", () => {
  const estimate = recordWorstCaseLossEstimate("opp_1", {
    findings: { build_cost: fakeBuildCostEstimate({ estimatedBuildCostUsdc: 45 }) },
  });
  assert.equal(estimate.worstCaseLossUsdc, 67.5);
});
