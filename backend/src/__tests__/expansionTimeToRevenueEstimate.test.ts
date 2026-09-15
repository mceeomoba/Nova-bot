// Zent.md Phase 8c: "Tool: estimate_time_to_revenue(opportunity_id) —
// rough month count, based on comparable department/agent build times
// already logged in this system's own history if any exist."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's
// computeTimeToRevenueEstimate() (pure, no DB access) plus a mirror of
// the sub_agents WHERE kind='department' AND status='killed' read
// getHistoricalDepartmentDurations() runs, rather than importing
// expansion.ts (which pulls in db.js -> better-sqlite3 at module
// load). Recommend re-running against the real expansion.ts/db.ts once
// a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

const ASSUMED_DEPARTMENTS_FOR_MVP = 3;
const FALLBACK_DAYS_PER_DEPARTMENT = 14;
const MS_PER_DAY = 24 * 3_600_000;
const MS_PER_MONTH = MS_PER_DAY * 30;

interface DepartmentDurationSample {
  departmentId: string;
  durationMs: number;
  createdAt: number;
  endedAt: number;
}

interface TimeToRevenueEstimate {
  basis: "historical_department_duration" | "fallback_default_months";
  sampleDepartments: number;
  avgDepartmentBuildTimeMonths: number;
  assumedDepartmentsForMvp: number;
  estimatedMonthsToRevenue: number;
  estimatedAt: number;
}

// ─── Inlined mirror of expansion.ts's computeTimeToRevenueEstimate() ──

function computeTimeToRevenueEstimate(samples: DepartmentDurationSample[]): TimeToRevenueEstimate {
  const estimatedAt = Date.now();
  if (samples.length > 0) {
    const avgDurationMs = samples.reduce((sum, s) => sum + s.durationMs, 0) / samples.length;
    const avgDepartmentBuildTimeMonths = avgDurationMs / MS_PER_MONTH;
    return {
      basis: "historical_department_duration",
      sampleDepartments: samples.length,
      avgDepartmentBuildTimeMonths,
      assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedMonthsToRevenue: avgDepartmentBuildTimeMonths * ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedAt,
    };
  }
  const avgDepartmentBuildTimeMonths = FALLBACK_DAYS_PER_DEPARTMENT / 30;
  return {
    basis: "fallback_default_months",
    sampleDepartments: 0,
    avgDepartmentBuildTimeMonths,
    assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedMonthsToRevenue: avgDepartmentBuildTimeMonths * ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedAt,
  };
}

// ─── Inlined mirror of the sub_agents completed-department read ───────

interface FakeSubAgentRow {
  id: string;
  owner_address: string;
  kind: "department" | "worker";
  status: "running" | "killed" | "completed" | "failed";
  created_at: number;
  ended_at: number | null;
}

function getHistoricalDepartmentDurations(
  rows: FakeSubAgentRow[],
  agentAddress: string,
): DepartmentDurationSample[] {
  return rows
    .filter(
      (r) =>
        r.owner_address === agentAddress &&
        r.kind === "department" &&
        r.status === "killed" &&
        r.ended_at !== null,
    )
    .sort((a, b) => a.created_at - b.created_at)
    .map((r) => ({
      departmentId: r.id,
      durationMs: (r.ended_at as number) - r.created_at,
      createdAt: r.created_at,
      endedAt: r.ended_at as number,
    }));
}

test("estimate_time_to_revenue falls back to the default month count with zero build-time history", () => {
  const estimate = computeTimeToRevenueEstimate([]);
  assert.equal(estimate.basis, "fallback_default_months");
  assert.equal(estimate.sampleDepartments, 0);
  assert.ok(Math.abs(estimate.avgDepartmentBuildTimeMonths - 14 / 30) < 1e-9);
  assert.ok(Math.abs(estimate.estimatedMonthsToRevenue - (14 / 30) * 3) < 1e-9);
});

test("estimate_time_to_revenue averages this agent's own real completed department durations", () => {
  const day = MS_PER_DAY;
  const rows: FakeSubAgentRow[] = [
    { id: "dept_1", owner_address: "0xA", kind: "department", status: "killed", created_at: 0, ended_at: 30 * day },
    { id: "dept_2", owner_address: "0xA", kind: "department", status: "killed", created_at: 0, ended_at: 60 * day },
    // Still running — must never count as a completed build.
    { id: "dept_3", owner_address: "0xA", kind: "department", status: "running", created_at: 0, ended_at: null },
    // A worker, not a department — must never be mixed in.
    { id: "wkr_1", owner_address: "0xA", kind: "worker", status: "killed", created_at: 0, ended_at: 5 * day },
  ];
  const samples = getHistoricalDepartmentDurations(rows, "0xA");
  assert.equal(samples.length, 2);

  const estimate = computeTimeToRevenueEstimate(samples);
  assert.equal(estimate.basis, "historical_department_duration");
  assert.equal(estimate.sampleDepartments, 2);
  // avg(30, 60) days = 45 days = 1.5 months
  assert.ok(Math.abs(estimate.avgDepartmentBuildTimeMonths - 1.5) < 1e-9);
  assert.ok(Math.abs(estimate.estimatedMonthsToRevenue - 4.5) < 1e-9); // x 3 assumed departments
});

test("estimate_time_to_revenue never mixes another agent's department history into the average", () => {
  const rows: FakeSubAgentRow[] = [
    {
      id: "dept_9",
      owner_address: "0xOther",
      kind: "department",
      status: "killed",
      created_at: 0,
      ended_at: 365 * MS_PER_DAY,
    },
  ];
  const samples = getHistoricalDepartmentDurations(rows, "0xA");
  assert.equal(samples.length, 0);

  const estimate = computeTimeToRevenueEstimate(samples);
  assert.equal(estimate.basis, "fallback_default_months");
});
