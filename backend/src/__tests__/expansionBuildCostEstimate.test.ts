// Zent.md Phase 8b: "Tool: estimate_build_cost(opportunity_id) —
// compute/inference spend to reach MVP, using this stack's real
// metered USDC costs as the unit, not an abstract number."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's computeBuildCostEstimate()
// (pure, no DB access) plus a mirror of the department_spend_log
// GROUP BY query getHistoricalDepartmentCosts() runs, rather than
// importing expansion.ts (which pulls in db.js -> better-sqlite3 at
// module load). Recommend re-running against the real
// expansion.ts/db.ts once a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

const ASSUMED_DEPARTMENTS_FOR_MVP = 3;
const FALLBACK_DAYS_PER_DEPARTMENT = 14;
const DEFAULT_DEPARTMENT_SPEND_CAP_DAILY_USDC = 1;

interface DepartmentCostSample {
  departmentId: string;
  totalUsdc: number;
  firstSpendAt: number;
  lastSpendAt: number;
}

interface BuildCostEstimate {
  basis: "historical_department_spend" | "fallback_default_cap";
  sampleDepartments: number;
  avgCostPerDepartmentUsdc: number;
  assumedDepartmentsForMvp: number;
  estimatedBuildCostUsdc: number;
  estimatedAt: number;
}

// ─── Inlined mirror of expansion.ts's computeBuildCostEstimate() ──────

function computeBuildCostEstimate(samples: DepartmentCostSample[]): BuildCostEstimate {
  const estimatedAt = Date.now();
  if (samples.length > 0) {
    const avgCostPerDepartmentUsdc =
      samples.reduce((sum, s) => sum + s.totalUsdc, 0) / samples.length;
    return {
      basis: "historical_department_spend",
      sampleDepartments: samples.length,
      avgCostPerDepartmentUsdc,
      assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedBuildCostUsdc: avgCostPerDepartmentUsdc * ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedAt,
    };
  }
  const avgCostPerDepartmentUsdc =
    DEFAULT_DEPARTMENT_SPEND_CAP_DAILY_USDC * FALLBACK_DAYS_PER_DEPARTMENT;
  return {
    basis: "fallback_default_cap",
    sampleDepartments: 0,
    avgCostPerDepartmentUsdc,
    assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedBuildCostUsdc: avgCostPerDepartmentUsdc * ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedAt,
  };
}

// ─── Inlined mirror of the department_spend_log GROUP BY read ─────────

interface FakeSpendRow {
  department_id: string;
  owner_address: string;
  amount_usdc: number;
  created_at: number;
}

function getHistoricalDepartmentCosts(
  rows: FakeSpendRow[],
  agentAddress: string,
): DepartmentCostSample[] {
  const byDept = new Map<string, DepartmentCostSample>();
  for (const row of rows) {
    if (row.owner_address !== agentAddress) continue;
    const existing = byDept.get(row.department_id);
    if (!existing) {
      byDept.set(row.department_id, {
        departmentId: row.department_id,
        totalUsdc: row.amount_usdc,
        firstSpendAt: row.created_at,
        lastSpendAt: row.created_at,
      });
    } else {
      existing.totalUsdc += row.amount_usdc;
      existing.firstSpendAt = Math.min(existing.firstSpendAt, row.created_at);
      existing.lastSpendAt = Math.max(existing.lastSpendAt, row.created_at);
    }
  }
  return [...byDept.values()];
}

test("estimate_build_cost falls back to the default cap with zero spend history", () => {
  const estimate = computeBuildCostEstimate([]);
  assert.equal(estimate.basis, "fallback_default_cap");
  assert.equal(estimate.sampleDepartments, 0);
  assert.equal(estimate.avgCostPerDepartmentUsdc, 14); // $1/day x 14 days
  assert.equal(estimate.estimatedBuildCostUsdc, 42); // x 3 assumed departments
});

test("estimate_build_cost averages this agent's own real department spend when history exists", () => {
  const rows: FakeSpendRow[] = [
    { department_id: "dept_1", owner_address: "0xA", amount_usdc: 10, created_at: 1000 },
    { department_id: "dept_1", owner_address: "0xA", amount_usdc: 5, created_at: 2000 },
    { department_id: "dept_2", owner_address: "0xA", amount_usdc: 15, created_at: 1500 },
    // Different owner — must never leak into 0xA's own average.
    { department_id: "dept_3", owner_address: "0xB", amount_usdc: 1000, created_at: 1200 },
  ];
  const samples = getHistoricalDepartmentCosts(rows, "0xA");
  assert.equal(samples.length, 2);

  const estimate = computeBuildCostEstimate(samples);
  assert.equal(estimate.basis, "historical_department_spend");
  assert.equal(estimate.sampleDepartments, 2);
  // dept_1 totals 15, dept_2 totals 15 -> avg 15
  assert.equal(estimate.avgCostPerDepartmentUsdc, 15);
  assert.equal(estimate.estimatedBuildCostUsdc, 45); // x 3 assumed departments
});

test("estimate_build_cost never mixes another agent's department spend into the average", () => {
  const rows: FakeSpendRow[] = [
    { department_id: "dept_9", owner_address: "0xOther", amount_usdc: 9999, created_at: 1000 },
  ];
  const samples = getHistoricalDepartmentCosts(rows, "0xA");
  assert.equal(samples.length, 0);

  const estimate = computeBuildCostEstimate(samples);
  assert.equal(estimate.basis, "fallback_default_cap");
});
