// Zent.md Phase 10e: "Test: finance-report-shape.test.ts + a hard-reject
// unit test for the runway floor."
//
// expansionFinanceReportShape.test.ts already covers the first half.
// This file is the second: expansionFinanceAuditLog.test.ts exercises
// the *audit-row* shape a hard_reject produces (mirrorRecordHardReject),
// but nothing in this directory exercises rejectForFailedRunway() —
// Phase 10b's actual gate function — itself: its two refusal branches,
// its one success branch, and its side effects (status transition,
// finding merge, audit citation). That gap is what this file closes.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of rejectForFailedRunway() and just enough of its
// dependencies (getCurrentFinanceFinding/mergeIntoCurrentFinanceFinding,
// setOpportunityStatus, resolveOpportunityAgentAddress,
// recordFinanceAuditEntry/getLatestFinanceAuditEntry) against plain
// in-memory maps standing in for opportunities/opportunity_reports/
// finance_findings/finance_audit_log. Recommend re-running against the
// real expansion.ts/db.ts once a networked environment is available, to
// confirm rejectForFailedRunway()'s own actual behavior still matches
// this mirror.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Types mirrored from expansion.ts (8e / 10b / 10d / 4c) ────────────

type OpportunityStatus = "open" | "selected" | "rejected";

interface RunwayCheck {
  walletBalanceUsdc: number;
  dailySpendRateUsdc: number;
  proposedFundingUsdc: number;
  remainingBalanceAfterFundingUsdc: number;
  runwayMonthsAfterFunding: number;
  minRunwayMonthsRequired: number;
  passes: boolean;
  checkedAt: number;
}

interface HardReject {
  reason: "runway_floor_failed";
  runwayCheck: RunwayCheck;
  rejectedAt: number;
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  status: OpportunityStatus;
}

interface FakeOpportunityReport {
  id: string;
  agent_address: string;
}

interface FakeFinding {
  id: string;
  opportunity_id: string;
  version: number;
  superseded: boolean;
  findings: Record<string, unknown>;
}

interface FakeAuditEntry {
  id: string;
  opportunityId: string;
  agentAddress: string;
  metric: string;
  value: number | null;
  sourceQuery: string;
  rowCount: number;
  rawEvidence: unknown;
  refIds: string[];
  recordedAt: number;
}

// ─── In-memory tables ───────────────────────────────────────────────────

let opportunities: Map<string, FakeOpportunity>;
let reports: Map<string, FakeOpportunityReport>;
let financeFindings: FakeFinding[];
let auditLog: FakeAuditEntry[];
let seq: number;

function reset() {
  opportunities = new Map();
  reports = new Map();
  financeFindings = [];
  auditLog = [];
  seq = 0;
}

function seedOpportunity(overrides: Partial<FakeOpportunity & { agentAddress: string }> = {}) {
  const reportId = `oppr_${++seq}`;
  reports.set(reportId, {
    id: reportId,
    agent_address: overrides.agentAddress ?? "agentA",
  });
  const id = overrides.id ?? `opp_${++seq}`;
  const opportunity: FakeOpportunity = {
    id,
    report_id: reportId,
    status: overrides.status ?? "open",
  };
  opportunities.set(id, opportunity);
  return opportunity;
}

// ─── Mirrors of expansion.ts's own building blocks ──────────────────────

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function getOpportunityReport(id: string): FakeOpportunityReport | undefined {
  return reports.get(id);
}

// Mirrors createFinding("finance", ...): supersedes the current row,
// inserts a new one with version = priorVersion + 1.
function createFinanceFinding(
  opportunityId: string,
  findings: Record<string, unknown>,
): FakeFinding {
  if (!getOpportunity(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  let priorVersion = 0;
  for (const f of financeFindings) {
    if (f.opportunity_id === opportunityId) {
      f.superseded = true;
      priorVersion = Math.max(priorVersion, f.version);
    }
  }
  const row: FakeFinding = {
    id: `finf_${++seq}`,
    opportunity_id: opportunityId,
    version: priorVersion + 1,
    superseded: false,
    findings: { ...findings },
  };
  financeFindings.push(row);
  return row;
}

function getCurrentFinanceFinding(opportunityId: string): FakeFinding | undefined {
  return financeFindings.find((f) => f.opportunity_id === opportunityId && !f.superseded);
}

function mergeIntoCurrentFinanceFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding {
  const current = getCurrentFinanceFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createFinanceFinding(opportunityId, merged);
}

// Mirrors resolveOpportunityAgentAddress (Phase 10d's header).
function resolveOpportunityAgentAddress(opportunityId: string): string {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const report = getOpportunityReport(opportunity.report_id);
  if (!report) {
    throw new Error(`opportunity_report ${opportunity.report_id} not found`);
  }
  return report.agent_address;
}

function getLatestFinanceAuditEntry(
  opportunityId: string,
  metric: string,
): FakeAuditEntry | undefined {
  let latest: FakeAuditEntry | undefined;
  for (const entry of auditLog) {
    if (entry.opportunityId === opportunityId && entry.metric === metric) {
      if (!latest || entry.recordedAt >= latest.recordedAt) latest = entry;
    }
  }
  return latest;
}

function recordFinanceAuditEntry(entry: {
  opportunityId: string;
  agentAddress: string;
  metric: string;
  value: number | null;
  sourceQuery: string;
  rowCount: number;
  rawEvidence: unknown;
  refIds?: string[];
}): FakeAuditEntry {
  const row: FakeAuditEntry = {
    id: `finaud_${++seq}`,
    opportunityId: entry.opportunityId,
    agentAddress: entry.agentAddress,
    metric: entry.metric,
    value: entry.value,
    sourceQuery: entry.sourceQuery,
    rowCount: entry.rowCount,
    rawEvidence: entry.rawEvidence,
    refIds: entry.refIds ?? [],
    recordedAt: Date.now() + seq, // monotonic within a test run
  };
  auditLog.push(row);
  return row;
}

// Mirrors the OPPORTUNITY_TRANSITIONS table + setOpportunityStatus('reject').
// Only the 'reject' action matters for this file.
const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  open: ["selected", "rejected"],
  selected: ["open", "rejected"],
  rejected: [],
};

function setOpportunityStatus(id: string, action: "reject"): FakeOpportunity {
  const existing = getOpportunity(id);
  if (!existing) {
    throw new Error(`opportunity ${id} not found`);
  }
  const target: OpportunityStatus = "rejected";
  if (existing.status === target) {
    return existing;
  }
  if (!OPPORTUNITY_TRANSITIONS[existing.status].includes(target)) {
    throw new Error(`cannot ${action} opportunity ${id} from status '${existing.status}'`);
  }
  existing.status = target;
  return existing;
}

function makeRunwayCheck(overrides: Partial<RunwayCheck> = {}): RunwayCheck {
  return {
    walletBalanceUsdc: 500,
    dailySpendRateUsdc: 10,
    proposedFundingUsdc: 480,
    remainingBalanceAfterFundingUsdc: 20,
    runwayMonthsAfterFunding: 0.067,
    minRunwayMonthsRequired: 3,
    passes: false,
    checkedAt: Date.now(),
    ...overrides,
  };
}

// ─── Mirror of rejectForFailedRunway() itself (Phase 10b) ───────────────
//
// Same three-branch shape as the real function: no runway_check on file
// -> throw; runway_check.passes -> throw; otherwise reject + merge +
// audit, citing the runway_check audit row that triggered it (10d).
function rejectForFailedRunway(opportunityId: string): {
  opportunity: FakeOpportunity;
  finding: FakeFinding;
} {
  const current = getCurrentFinanceFinding(opportunityId);
  const runwayCheck = current?.findings.runway_check as RunwayCheck | undefined;
  if (!runwayCheck) {
    throw new Error(
      `opportunity ${opportunityId} has no runway check on file — run check_runway (8e) before attempting a hard reject`,
    );
  }
  if (runwayCheck.passes) {
    throw new Error(
      `opportunity ${opportunityId}'s runway check currently passes — hard-reject only applies when 8e's floor fails`,
    );
  }

  const opportunity = setOpportunityStatus(opportunityId, "reject");
  const hardReject: HardReject = {
    reason: "runway_floor_failed",
    runwayCheck,
    rejectedAt: Date.now(),
  };
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { hard_reject: hardReject });

  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const runwayAudit = getLatestFinanceAuditEntry(opportunityId, "runway_check");
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "hard_reject",
    value: null,
    sourceQuery: "derived: runway_check (8e) came back passes=false",
    rowCount: 0,
    rawEvidence: { hardReject },
    refIds: runwayAudit ? [runwayAudit.id] : [],
  });
  return { opportunity, finding };
}

// ─── No runway_check on file yet ─────────────────────────────────────────

test("throws when no finance finding exists at all", () => {
  reset();
  const opp = seedOpportunity();
  assert.throws(
    () => rejectForFailedRunway(opp.id),
    /has no runway check on file/,
  );
  // Nothing should have moved or been recorded on the refused attempt.
  assert.equal(getOpportunity(opp.id)!.status, "open");
  assert.equal(auditLog.length, 0);
});

test("throws when a finance finding exists but has no runway_check key yet", () => {
  reset();
  const opp = seedOpportunity();
  createFinanceFinding(opp.id, { build_cost: { estimatedBuildCostUsdc: 100 } });
  assert.throws(
    () => rejectForFailedRunway(opp.id),
    /has no runway check on file/,
  );
  assert.equal(getOpportunity(opp.id)!.status, "open");
});

// ─── Runway check currently passes ───────────────────────────────────────

test("throws (and does not reject) when the runway check currently passes", () => {
  reset();
  const opp = seedOpportunity();
  createFinanceFinding(opp.id, {
    runway_check: makeRunwayCheck({ passes: true, runwayMonthsAfterFunding: 12 }),
  });
  assert.throws(
    () => rejectForFailedRunway(opp.id),
    /runway check currently passes/,
  );
  assert.equal(getOpportunity(opp.id)!.status, "open");
  assert.equal(auditLog.length, 0);
});

// ─── Happy path: runway check fails -> hard reject fires ───────────────

test("rejects the opportunity when the runway check has failed", () => {
  reset();
  const opp = seedOpportunity();
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });

  const { opportunity } = rejectForFailedRunway(opp.id);

  assert.equal(opportunity.status, "rejected");
  assert.equal(getOpportunity(opp.id)!.status, "rejected");
});

test("merges hard_reject onto the finance finding without dropping runway_check", () => {
  reset();
  const opp = seedOpportunity();
  const runwayCheck = makeRunwayCheck({ passes: false });
  createFinanceFinding(opp.id, {
    build_cost: { estimatedBuildCostUsdc: 300 },
    runway_check: runwayCheck,
  });

  const { finding } = rejectForFailedRunway(opp.id);

  // 10b's header: "not a replacement for it" — runway_check (and prior
  // sections) survive the merge alongside the new hard_reject.
  assert.deepEqual(finding.findings.runway_check, runwayCheck);
  assert.deepEqual(finding.findings.build_cost, { estimatedBuildCostUsdc: 300 });
  const hardReject = finding.findings.hard_reject as HardReject;
  assert.equal(hardReject.reason, "runway_floor_failed");
  assert.deepEqual(hardReject.runwayCheck, runwayCheck);
  assert.equal(typeof hardReject.rejectedAt, "number");
});

test("hard_reject is filed as a new finding version, current finding reflects it", () => {
  reset();
  const opp = seedOpportunity();
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });
  const versionBefore = getCurrentFinanceFinding(opp.id)!.version;

  rejectForFailedRunway(opp.id);

  const current = getCurrentFinanceFinding(opp.id)!;
  assert.equal(current.version, versionBefore + 1);
  assert.ok("hard_reject" in current.findings);
  // Exactly one non-superseded row remains.
  assert.equal(
    financeFindings.filter((f) => f.opportunity_id === opp.id && !f.superseded).length,
    1,
  );
});

// ─── Audit trail (10d): hard_reject cites the failing runway_check row ──

test("records a hard_reject audit entry with a null numeric value", () => {
  reset();
  const opp = seedOpportunity({ agentAddress: "agentX" });
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });

  rejectForFailedRunway(opp.id);

  const entries = auditLog.filter((e) => e.opportunityId === opp.id && e.metric === "hard_reject");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, null);
  assert.equal(entries[0].agentAddress, "agentX");
  assert.match(entries[0].sourceQuery, /runway_check.*passes=false/);
});

test("cites the prior runway_check audit row's id in refIds when one exists", () => {
  reset();
  const opp = seedOpportunity();
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });
  const agentAddress = resolveOpportunityAgentAddress(opp.id);
  const runwayAuditRow = recordFinanceAuditEntry({
    opportunityId: opp.id,
    agentAddress,
    metric: "runway_check",
    value: 0.067,
    sourceQuery: "derived: (walletBalanceUsdc - proposedFundingUsdc) / (dailySpendRateUsdc x 30)",
    rowCount: 0,
    rawEvidence: {},
  });

  rejectForFailedRunway(opp.id);

  const hardRejectEntry = auditLog.find((e) => e.metric === "hard_reject")!;
  assert.deepEqual(hardRejectEntry.refIds, [runwayAuditRow.id]);
});

test("refIds is empty (not a throw) when no prior runway_check audit row was recorded", () => {
  reset();
  const opp = seedOpportunity();
  // Finding has runway_check data, but no audit row was ever separately
  // recorded for it (e.g. a test/fixture that skipped 8e's own audit
  // call) — hard-reject must still succeed, just with nothing to cite.
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });

  rejectForFailedRunway(opp.id);

  const hardRejectEntry = auditLog.find((e) => e.metric === "hard_reject")!;
  assert.deepEqual(hardRejectEntry.refIds, []);
});

// ─── Idempotency / already-terminal state ────────────────────────────────

test("is a no-op re-reject (idempotent) when the opportunity is already rejected", () => {
  reset();
  const opp = seedOpportunity({ status: "rejected" });
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });

  const { opportunity } = rejectForFailedRunway(opp.id);

  assert.equal(opportunity.status, "rejected");
  // setOpportunityStatus's own same-status no-op still lets the rest of
  // rejectForFailedRunway proceed (merge + audit) — mirrors 10b's header
  // pointing at setOpportunityStatus()'s documented idempotent behavior.
  assert.ok("hard_reject" in getCurrentFinanceFinding(opp.id)!.findings);
});

test("a selected opportunity can still be hard-rejected (selected -> rejected is a valid transition)", () => {
  reset();
  const opp = seedOpportunity({ status: "selected" });
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });

  const { opportunity } = rejectForFailedRunway(opp.id);

  assert.equal(opportunity.status, "rejected");
});

// ─── This is Finance's own gate, independent of Strategy/CEO (10b) ──────

test("fires without any committee packet, deliberation, or CEO decision present", () => {
  // Zent.md 10b: reject-able "without needing Strategy or the CEO" —
  // this opportunity has no strategy finding and no expansion_decisions
  // row at all, and the hard reject still succeeds on runway_check alone.
  reset();
  const opp = seedOpportunity();
  createFinanceFinding(opp.id, { runway_check: makeRunwayCheck({ passes: false }) });

  const { opportunity } = rejectForFailedRunway(opp.id);

  assert.equal(opportunity.status, "rejected");
});
