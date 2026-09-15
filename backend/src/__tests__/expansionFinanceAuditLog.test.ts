// Zent.md Phase 10d: "Audit log: every number Finance produces is
// traceable to the wallet/spend query that generated it — no
// hand-waved figures."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's own finance_audit_log helpers
// (recordFinanceAuditEntry / getFinanceAuditLog / getLatestFinanceAuditEntry)
// against a plain in-memory array standing in for the finance_audit_log
// table, plus a mirror of how each Phase 8/9 record*() function calls
// them. Recommend re-running against the real expansion.ts/db.ts once a
// networked environment is available.
//
// What this file is actually checking: the split expansion.ts's own
// Phase 10d header draws between query-backed metrics (build_cost,
// time_to_revenue, available_capital — raw evidence is the literal
// rows a real read returned) and arithmetic-only metrics (runway_check
// through sensitivity_note, plus 10b's hard_reject — raw evidence is
// the finding(s) they were computed from, cited by `refIds` rather
// than duplicated).

import { test } from "node:test";
import assert from "node:assert/strict";

type FinanceAuditMetric =
  | "build_cost"
  | "time_to_revenue"
  | "available_capital"
  | "runway_check"
  | "worst_case_loss"
  | "sizing_recommendation"
  | "staged_funding_option"
  | "sensitivity_note"
  | "hard_reject";

interface FinanceAuditEntry {
  id: string;
  opportunityId: string;
  agentAddress: string;
  metric: FinanceAuditMetric;
  value: number | null;
  sourceQuery: string;
  rowCount: number;
  rawEvidence: unknown;
  refIds: string[];
  recordedAt: number;
}

let auditLog: FinanceAuditEntry[];
let seq: number;

function reset() {
  auditLog = [];
  seq = 0;
}

// ─── Inlined mirror of expansion.ts's own Phase 10d helpers ────────────

function recordFinanceAuditEntry(entry: {
  opportunityId: string;
  agentAddress: string;
  metric: FinanceAuditMetric;
  value: number | null;
  sourceQuery: string;
  rowCount: number;
  rawEvidence: unknown;
  refIds?: string[];
}): FinanceAuditEntry {
  const row: FinanceAuditEntry = {
    id: `finaud_${++seq}`,
    opportunityId: entry.opportunityId,
    agentAddress: entry.agentAddress,
    metric: entry.metric,
    value: entry.value,
    sourceQuery: entry.sourceQuery,
    rowCount: entry.rowCount,
    rawEvidence: entry.rawEvidence,
    refIds: entry.refIds ?? [],
    recordedAt: Date.now() + seq,
  };
  auditLog.push(row);
  return row;
}

function getFinanceAuditLog(opportunityId: string): FinanceAuditEntry[] {
  return auditLog
    .filter((r) => r.opportunityId === opportunityId)
    .sort((a, b) => a.recordedAt - b.recordedAt);
}

function getLatestFinanceAuditEntry(
  opportunityId: string,
  metric: FinanceAuditMetric,
): FinanceAuditEntry | undefined {
  const rows = auditLog
    .filter((r) => r.opportunityId === opportunityId && r.metric === metric)
    .sort((a, b) => b.recordedAt - a.recordedAt);
  return rows[0];
}

// ─── Inlined mirrors of the record*() wiring, one per Finance tool ─────
// Each mirrors expansion.ts's own record*() function just enough to
// exercise the audit-entry shape/refIds logic — not the full 8b-9d
// compute math itself, which is already covered by that phase's own
// test file (e.g. expansionFinanceReport.test.ts).

function mirrorRecordBuildCost(
  opportunityId: string,
  agentAddress: string,
  basis: "historical_department_spend" | "fallback_default_cap",
  estimatedBuildCostUsdc: number,
  sampleCount: number,
): FinanceAuditEntry {
  return recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "build_cost",
    value: estimatedBuildCostUsdc,
    sourceQuery:
      basis === "historical_department_spend"
        ? `SUM(amount_usdc) GROUP BY department_id FROM department_spend_log WHERE owner_address = '${agentAddress}'`
        : "fallback: config.defaultDepartmentSpendCapDailyUsdc x FALLBACK_DAYS_PER_DEPARTMENT (no department_spend_log rows for this agent yet)",
    rowCount: sampleCount,
    rawEvidence: { basis, estimatedBuildCostUsdc },
  });
}

function mirrorRecordAvailableCapital(
  opportunityId: string,
  agentAddress: string,
  availableExpansionCapitalUsdc: number,
  spendRowCount: number,
): FinanceAuditEntry {
  return recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "available_capital",
    value: availableExpansionCapitalUsdc,
    sourceQuery: `getUsdcBalance('${agentAddress}') on-chain; SUM(cost_usdc) GROUP BY service FROM usage_log WHERE agent_address = '${agentAddress}' AND created_at >= now-30d`,
    rowCount: spendRowCount,
    rawEvidence: { availableExpansionCapitalUsdc },
  });
}

function mirrorRecordRunwayCheck(
  opportunityId: string,
  agentAddress: string,
  runwayMonthsAfterFunding: number,
): FinanceAuditEntry {
  const capitalAudit = getLatestFinanceAuditEntry(opportunityId, "available_capital");
  return recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "runway_check",
    value: runwayMonthsAfterFunding,
    sourceQuery:
      "derived: (walletBalanceUsdc - proposedFundingUsdc) / (dailySpendRateUsdc x 30), inputs from available_capital (8d)",
    rowCount: 0,
    rawEvidence: { runwayMonthsAfterFunding },
    refIds: capitalAudit ? [capitalAudit.id] : [],
  });
}

function mirrorRecordWorstCaseLoss(
  opportunityId: string,
  agentAddress: string,
  worstCaseLossUsdc: number,
): FinanceAuditEntry {
  const buildCostAudit = getLatestFinanceAuditEntry(opportunityId, "build_cost");
  return recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "worst_case_loss",
    value: worstCaseLossUsdc,
    sourceQuery: "derived: build_cost (8b) x WORST_CASE_LOSS_OVERRUN_MULTIPLIER",
    rowCount: 0,
    rawEvidence: { worstCaseLossUsdc },
    refIds: buildCostAudit ? [buildCostAudit.id] : [],
  });
}

function mirrorRecordSizingRecommendation(
  opportunityId: string,
  agentAddress: string,
  recommendedFundingUsdc: number,
): FinanceAuditEntry {
  const buildCostAudit = getLatestFinanceAuditEntry(opportunityId, "build_cost");
  const capitalAudit = getLatestFinanceAuditEntry(opportunityId, "available_capital");
  return recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "sizing_recommendation",
    value: recommendedFundingUsdc,
    sourceQuery:
      "derived: min(build_cost (8b), available_capital (8d), config.maxCloneFundingUsdcPerCall, per-day cap net of alreadyCommittedTodayUsdc)",
    rowCount: 0,
    rawEvidence: { recommendedFundingUsdc },
    refIds: [buildCostAudit?.id, capitalAudit?.id].filter((x): x is string => !!x),
  });
}

function mirrorRecordSensitivityNote(opportunityId: string, agentAddress: string): FinanceAuditEntry {
  const refIds = (
    [
      getLatestFinanceAuditEntry(opportunityId, "build_cost"),
      getLatestFinanceAuditEntry(opportunityId, "time_to_revenue"),
      getLatestFinanceAuditEntry(opportunityId, "available_capital"),
      getLatestFinanceAuditEntry(opportunityId, "sizing_recommendation"),
    ] as (FinanceAuditEntry | undefined)[]
  )
    .filter((x): x is FinanceAuditEntry => !!x)
    .map((x) => x.id);
  return recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "sensitivity_note",
    value: null,
    sourceQuery:
      "derived: stress-test of build_cost (8b), time_to_revenue (8c), available_capital (8d) against sizing_recommendation (9b)",
    rowCount: 0,
    rawEvidence: { note: "placeholder" },
    refIds,
  });
}

function mirrorRecordHardReject(opportunityId: string, agentAddress: string): FinanceAuditEntry {
  const runwayAudit = getLatestFinanceAuditEntry(opportunityId, "runway_check");
  return recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "hard_reject",
    value: null,
    sourceQuery: "derived: runway_check (8e) came back passes=false",
    rowCount: 0,
    rawEvidence: { reason: "runway_floor_failed" },
    refIds: runwayAudit ? [runwayAudit.id] : [],
  });
}

// ─── recordFinanceAuditEntry / getFinanceAuditLog basics ───────────────

test("recordFinanceAuditEntry writes a retrievable row", () => {
  reset();
  const row = mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  const log = getFinanceAuditLog("opp_1");
  assert.equal(log.length, 1);
  assert.equal(log[0].id, row.id);
  assert.equal(log[0].metric, "build_cost");
  assert.equal(log[0].value, 300);
});

test("getFinanceAuditLog only returns rows for the requested opportunity", () => {
  reset();
  mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  mirrorRecordBuildCost("opp_2", "agentA", "historical_department_spend", 999, 5);
  assert.equal(getFinanceAuditLog("opp_1").length, 1);
  assert.equal(getFinanceAuditLog("opp_2").length, 1);
  assert.equal(getFinanceAuditLog("opp_1")[0].value, 300);
});

test("getFinanceAuditLog returns rows oldest-first, across every metric and every re-run", () => {
  reset();
  mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  mirrorRecordAvailableCapital("opp_1", "agentA", 400, 2);
  mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 350, 4); // a re-run, superseding the first

  const log = getFinanceAuditLog("opp_1");
  assert.equal(log.length, 3); // NOT deduplicated down to "current", unlike finance_findings
  assert.deepEqual(
    log.map((r) => r.metric),
    ["build_cost", "available_capital", "build_cost"],
  );
  assert.equal(log[0].value, 300);
  assert.equal(log[2].value, 350);
});

// ─── Query-backed metrics: raw evidence is the real read, not just the aggregate ──

test("build_cost's sourceQuery names department_spend_log when grounded in real history", () => {
  reset();
  const row = mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  assert.match(row.sourceQuery, /department_spend_log/);
  assert.equal(row.rowCount, 3);
});

test("build_cost's sourceQuery names the fallback path when there's no history yet, distinctly from a real read", () => {
  reset();
  const row = mirrorRecordBuildCost("opp_1", "agentA", "fallback_default_cap", 210, 0);
  assert.match(row.sourceQuery, /^fallback:/);
  assert.doesNotMatch(row.sourceQuery, /^SUM\(/);
  assert.equal(row.rowCount, 0);
});

test("available_capital's sourceQuery names both real reads it's grounded in: the on-chain balance and the usage_log window", () => {
  reset();
  const row = mirrorRecordAvailableCapital("opp_1", "agentA", 400, 5);
  assert.match(row.sourceQuery, /getUsdcBalance/);
  assert.match(row.sourceQuery, /usage_log/);
  assert.equal(row.rowCount, 5);
});

// ─── Arithmetic-only metrics: refIds point back rather than duplicate ──

test("runway_check cites the latest available_capital row by id, rather than re-recording its evidence", () => {
  reset();
  const capitalRow = mirrorRecordAvailableCapital("opp_1", "agentA", 400, 5);
  const runwayRow = mirrorRecordRunwayCheck("opp_1", "agentA", 12);
  assert.deepEqual(runwayRow.refIds, [capitalRow.id]);
  assert.equal(runwayRow.rowCount, 0); // no new query of its own
});

test("worst_case_loss cites the latest build_cost row by id", () => {
  reset();
  const buildCostRow = mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  const worstCaseRow = mirrorRecordWorstCaseLoss("opp_1", "agentA", 450);
  assert.deepEqual(worstCaseRow.refIds, [buildCostRow.id]);
});

test("sizing_recommendation cites both build_cost and available_capital by id", () => {
  reset();
  const buildCostRow = mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  const capitalRow = mirrorRecordAvailableCapital("opp_1", "agentA", 400, 5);
  const sizingRow = mirrorRecordSizingRecommendation("opp_1", "agentA", 300);
  assert.deepEqual(new Set(sizingRow.refIds), new Set([buildCostRow.id, capitalRow.id]));
});

test("sensitivity_note cites every one of its four upstream findings, and its own value is null (not a single headline number)", () => {
  reset();
  const buildCostRow = mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  const capitalRow = mirrorRecordAvailableCapital("opp_1", "agentA", 400, 5);
  const sizingRow = mirrorRecordSizingRecommendation("opp_1", "agentA", 300);
  // time_to_revenue not recorded in this fixture — refIds should only
  // include what's actually on file, same "graceful with partial
  // signal" posture the rest of this pipeline already takes.
  const noteRow = mirrorRecordSensitivityNote("opp_1", "agentA");
  assert.equal(noteRow.value, null);
  assert.deepEqual(
    new Set(noteRow.refIds),
    new Set([buildCostRow.id, capitalRow.id, sizingRow.id]),
  );
});

test("hard_reject cites the runway_check row whose failure triggered it, and carries no numeric value", () => {
  reset();
  mirrorRecordAvailableCapital("opp_1", "agentA", 400, 5);
  const runwayRow = mirrorRecordRunwayCheck("opp_1", "agentA", 1.2); // below floor
  const rejectRow = mirrorRecordHardReject("opp_1", "agentA");
  assert.equal(rejectRow.value, null);
  assert.deepEqual(rejectRow.refIds, [runwayRow.id]);
});

// ─── A derived metric with no upstream row yet gets an empty refIds, not a crash ──

test("a derived metric recorded before its prerequisite has ever run gets an empty refIds array, not an error", () => {
  reset();
  // No build_cost has ever been recorded for this opportunity.
  const worstCaseRow = mirrorRecordWorstCaseLoss("opp_1", "agentA", 450);
  assert.deepEqual(worstCaseRow.refIds, []);
});

// ─── refIds always resolve to the LATEST row for that metric, not a stale one ──

test("a re-run of the upstream tool changes which id a later derived row cites", () => {
  reset();
  mirrorRecordBuildCost("opp_1", "agentA", "historical_department_spend", 300, 3);
  const rerunBuildCostRow = mirrorRecordBuildCost(
    "opp_1",
    "agentA",
    "historical_department_spend",
    450,
    4,
  );
  const worstCaseRow = mirrorRecordWorstCaseLoss("opp_1", "agentA", 675);
  assert.deepEqual(worstCaseRow.refIds, [rerunBuildCostRow.id]);
});
