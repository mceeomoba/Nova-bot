// Zent.md Phase 9e: compile_finance_report(opportunity_id) — "one
// structured report, same discipline as 7a."
//
// Same "no live better-sqlite3 in this environment" reason
// expansionResearchReport.test.ts's own header gives: this is an
// inlined mirror of expansion.ts's getCurrentFinanceFinding() (1c) plus
// compileFinanceReport() (9e) itself against plain in-memory data,
// standing in for opportunities/finance_findings. Recommend re-running
// against the real expansion.ts/db.ts once a networked environment is
// available.

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeOpportunity {
  id: string;
}

interface FakeFinding<T = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  created_at: number;
  version: number;
  superseded: boolean;
  findings: T;
}

let opportunities: Map<string, FakeOpportunity>;
let table: Map<string, FakeFinding>;
let oppSeq: number;
let findingSeq: number;

function reset() {
  opportunities = new Map();
  table = new Map();
  oppSeq = 0;
  findingSeq = 0;
}

function seedOpportunity(): FakeOpportunity {
  const o: FakeOpportunity = { id: `opp_${++oppSeq}` };
  opportunities.set(o.id, o);
  return o;
}

// ─── Inlined mirror of expansion.ts's own exported functions ──────────

function createFinanceFinding<T = Record<string, unknown>>(
  opportunityId: string,
  findings: T,
): FakeFinding<T> {
  if (!opportunities.has(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  let priorVersion = 0;
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId) {
      priorVersion = Math.max(priorVersion, row.version);
      if (!row.superseded) row.superseded = true;
    }
  }
  const row: FakeFinding<T> = {
    id: `finf_${++findingSeq}`,
    opportunity_id: opportunityId,
    created_at: Date.now() + findingSeq,
    version: priorVersion + 1,
    superseded: false,
    findings: findings ?? ({} as T),
  };
  table.set(row.id, row as FakeFinding<Record<string, unknown>>);
  return row;
}

function getCurrentFinanceFinding<T = Record<string, unknown>>(
  opportunityId: string,
): FakeFinding<T> | undefined {
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId && !row.superseded) {
      return row as FakeFinding<T>;
    }
  }
  return undefined;
}

function mergeIntoCurrentFinanceFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentFinanceFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createFinanceFinding<Record<string, unknown>>(opportunityId, merged);
}

// ─── Mirrors expansion.ts's FinanceReport shape + compileFinanceReport() (9e) ──

interface FinanceReport {
  opportunityId: string;
  findingId: string | null;
  findingVersion: number | null;
  compiledAt: number;
  schemaVersion: string;
  buildCost: unknown | null;
  timeToRevenue: unknown | null;
  availableCapital: unknown | null;
  runwayCheck: unknown | null;
  worstCaseLoss: unknown | null;
  sizingRecommendation: unknown | null;
  stagedFundingOption: unknown | null;
  sensitivityNote: unknown | null;
}

interface RawFinanceFindings {
  build_cost?: unknown;
  time_to_revenue?: unknown;
  available_capital?: unknown;
  runway_check?: unknown;
  worst_case_loss?: unknown;
  sizing_recommendation?: unknown;
  staged_funding_option?: unknown;
  sensitivity_note?: unknown;
}

// mirrors expansion.ts's FINANCE_REPORT_SCHEMA_VERSION (9e)
const FINANCE_REPORT_SCHEMA_VERSION = "9e-v1";

function compileFinanceReport(opportunityId: string): FinanceReport {
  if (!opportunities.has(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentFinanceFinding<RawFinanceFindings>(opportunityId);
  const findings = current?.findings ?? {};
  return {
    opportunityId,
    findingId: current?.id ?? null,
    findingVersion: current?.version ?? null,
    compiledAt: Date.now(),
    schemaVersion: FINANCE_REPORT_SCHEMA_VERSION,
    buildCost: findings.build_cost ?? null,
    timeToRevenue: findings.time_to_revenue ?? null,
    availableCapital: findings.available_capital ?? null,
    runwayCheck: findings.runway_check ?? null,
    worstCaseLoss: findings.worst_case_loss ?? null,
    sizingRecommendation: findings.sizing_recommendation ?? null,
    stagedFundingOption: findings.staged_funding_option ?? null,
    sensitivityNote: findings.sensitivity_note ?? null,
  };
}

// ─── compileFinanceReport(): unknown opportunity throws ────────────────

test("compile_finance_report on an unknown opportunity throws, matching every other Phase 8/9 tool", () => {
  reset();
  assert.throws(() => compileFinanceReport("opp_missing"));
});

// ─── compileFinanceReport(): known opportunity, nothing run yet ────────

test("compile_finance_report on a known opportunity with no finance pass yet is all-null, not an error", () => {
  reset();
  const o = seedOpportunity();
  const r = compileFinanceReport(o.id);

  assert.equal(r.opportunityId, o.id);
  assert.equal(r.findingId, null);
  assert.equal(r.findingVersion, null);
  assert.equal(r.buildCost, null);
  assert.equal(r.timeToRevenue, null);
  assert.equal(r.availableCapital, null);
  assert.equal(r.runwayCheck, null);
  assert.equal(r.worstCaseLoss, null);
  assert.equal(r.sizingRecommendation, null);
  assert.equal(r.stagedFundingOption, null);
  assert.equal(r.sensitivityNote, null);
});

// ─── compileFinanceReport(): full pass, every section populated ────────

test("compile_finance_report assembles every 8b-9d section from the current finding", () => {
  reset();
  const o = seedOpportunity();

  mergeIntoCurrentFinanceFinding(o.id, {
    build_cost: { basis: "historical_department_spend", estimatedBuildCostUsdc: 300 },
  });
  mergeIntoCurrentFinanceFinding(o.id, {
    time_to_revenue: { basis: "historical_department_duration", estimatedMonthsToRevenue: 6 },
  });
  mergeIntoCurrentFinanceFinding(o.id, {
    available_capital: { availableExpansionCapitalUsdc: 400, dailySpendRateUsdc: 10 },
  });
  mergeIntoCurrentFinanceFinding(o.id, {
    runway_check: { runwayMonthsAfterFunding: 12, passes: true },
  });
  mergeIntoCurrentFinanceFinding(o.id, {
    worst_case_loss: { worstCaseLossUsdc: 450 },
  });
  mergeIntoCurrentFinanceFinding(o.id, {
    sizing_recommendation: { recommendedFundingUsdc: 300, fullyFunded: true },
  });
  mergeIntoCurrentFinanceFinding(o.id, {
    staged_funding_option: { initialGrantUsdc: 150, followOnUsdc: 150 },
  });
  const afterSensitivity = mergeIntoCurrentFinanceFinding(o.id, {
    sensitivity_note: { mostSensitiveFactor: "build_cost" },
  });

  const r = compileFinanceReport(o.id);

  // Compiled from the single current finding, at its latest version —
  // same "the current finding carries everything" invariant 7a's own
  // test already established for research.
  assert.equal(r.findingId, afterSensitivity.id);
  assert.equal(r.findingVersion, afterSensitivity.version);

  assert.deepEqual(r.buildCost, { basis: "historical_department_spend", estimatedBuildCostUsdc: 300 });
  assert.deepEqual(r.timeToRevenue, {
    basis: "historical_department_duration",
    estimatedMonthsToRevenue: 6,
  });
  assert.deepEqual(r.availableCapital, { availableExpansionCapitalUsdc: 400, dailySpendRateUsdc: 10 });
  assert.deepEqual(r.runwayCheck, { runwayMonthsAfterFunding: 12, passes: true });
  assert.deepEqual(r.worstCaseLoss, { worstCaseLossUsdc: 450 });
  assert.deepEqual(r.sizingRecommendation, { recommendedFundingUsdc: 300, fullyFunded: true });
  assert.deepEqual(r.stagedFundingOption, { initialGrantUsdc: 150, followOnUsdc: 150 });
  assert.deepEqual(r.sensitivityNote, { mostSensitiveFactor: "build_cost" });
});

// ─── compileFinanceReport(): partial pass, only some sections run ──────

test("compile_finance_report leaves un-run sections null rather than defaulting them", () => {
  reset();
  const o = seedOpportunity();

  // Only 8b and 8d have run — 8c/8e/9a/9b/9c/9d never did.
  mergeIntoCurrentFinanceFinding(o.id, {
    build_cost: { basis: "fallback_default_cap", estimatedBuildCostUsdc: 210 },
  });
  mergeIntoCurrentFinanceFinding(o.id, {
    available_capital: { availableExpansionCapitalUsdc: 400 },
  });

  const r = compileFinanceReport(o.id);

  assert.ok(r.buildCost);
  assert.ok(r.availableCapital);
  assert.equal(r.timeToRevenue, null);
  assert.equal(r.runwayCheck, null);
  assert.equal(r.worstCaseLoss, null);
  assert.equal(r.sizingRecommendation, null);
  assert.equal(r.stagedFundingOption, null);
  assert.equal(r.sensitivityNote, null);
});

// ─── compileFinanceReport(): read-only, never writes a new version ─────

test("compile_finance_report never creates a new finance_findings version, even called repeatedly", () => {
  reset();
  const o = seedOpportunity();
  const v1 = mergeIntoCurrentFinanceFinding(o.id, {
    build_cost: { basis: "historical_department_spend", estimatedBuildCostUsdc: 300 },
  });

  compileFinanceReport(o.id);
  compileFinanceReport(o.id);
  compileFinanceReport(o.id);

  const rowsForOpp = [...table.values()].filter((r) => r.opportunity_id === o.id);
  assert.equal(rowsForOpp.length, 1);
  assert.equal(rowsForOpp[0].id, v1.id);
  assert.equal(rowsForOpp[0].version, 1);
});

// ─── compileFinanceReport(): reflects the CURRENT (post-supersede) version ──

test("compile_finance_report always reflects the latest version, not a stale earlier one", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentFinanceFinding(o.id, {
    build_cost: { basis: "historical_department_spend", estimatedBuildCostUsdc: 300 },
  });
  const v2 = mergeIntoCurrentFinanceFinding(o.id, {
    build_cost: { basis: "historical_department_spend", estimatedBuildCostUsdc: 450 },
  });

  const r = compileFinanceReport(o.id);
  assert.equal(r.findingId, v2.id);
  assert.equal((r.buildCost as { estimatedBuildCostUsdc: number }).estimatedBuildCostUsdc, 450);
});
