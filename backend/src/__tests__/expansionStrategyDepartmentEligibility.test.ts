// Zent.md Phase 11a: "Department type `strategy`, spawned once both
// Research and Finance have filed non-rejecting reports."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of departments.ts's POST / route's Phase 11a guard
// block against plain in-memory stand-ins for opportunities/
// opportunity_reports/research_findings/finance_findings, rather than
// importing departments.ts (which pulls in express + db.js ->
// better-sqlite3 at module load, same reason
// expansionFinanceDepartmentEligibility.test.ts's own header gives for
// not importing departments.ts either). Recommend re-running against
// the real route once a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

type OpportunityStatus = "open" | "selected" | "rejected";

interface FakeOpportunity {
  id: string;
  report_id: string;
  status: OpportunityStatus;
}

interface FakeReport {
  id: string;
  agent_address: string;
}

interface FakeFinding {
  opportunity_id: string;
  superseded: boolean;
}

let opportunities: Map<string, FakeOpportunity>;
let reports: Map<string, FakeReport>;
let researchFindings: FakeFinding[];
let financeFindings: FakeFinding[];

function reset() {
  opportunities = new Map();
  reports = new Map();
  researchFindings = [];
  financeFindings = [];
}

function seedReport(id: string, agentAddress: string): FakeReport {
  const r: FakeReport = { id, agent_address: agentAddress };
  reports.set(id, r);
  return r;
}

function seedOpportunity(
  id: string,
  reportId: string,
  status: OpportunityStatus = "open",
): FakeOpportunity {
  const o: FakeOpportunity = { id, report_id: reportId, status };
  opportunities.set(id, o);
  return o;
}

function seedResearchFinding(opportunityId: string): void {
  for (const f of researchFindings) {
    if (f.opportunity_id === opportunityId) f.superseded = true;
  }
  researchFindings.push({ opportunity_id: opportunityId, superseded: false });
}

function seedFinanceFinding(opportunityId: string): void {
  for (const f of financeFindings) {
    if (f.opportunity_id === opportunityId) f.superseded = true;
  }
  financeFindings.push({ opportunity_id: opportunityId, superseded: false });
}

// ─── Inlined mirrors of expansion.ts's own reads ───────────────────────

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function getOpportunityReport(reportId: string): FakeReport | undefined {
  return reports.get(reportId);
}

function getCurrentResearchFinding(opportunityId: string): FakeFinding | undefined {
  return researchFindings.find((f) => f.opportunity_id === opportunityId && !f.superseded);
}

function getCurrentFinanceFinding(opportunityId: string): FakeFinding | undefined {
  return financeFindings.find((f) => f.opportunity_id === opportunityId && !f.superseded);
}

// ─── Inlined mirror of departments.ts's POST / Phase 11a guard block ───
// Mirrors the real route's early-return shape (an error object in place
// of res.status(...).json(...)), and `null` for "no gate applies,
// proceed as an ordinary department creation."

type GuardResult =
  | null
  | { status: 400; error: "opportunityId_required" }
  | { status: 404; error: string }
  | { status: 403; error: "strategy_department_requires_owning_agent" }
  | { status: 409; error: "strategy_requires_non_rejected_opportunity" }
  | { status: 409; error: "strategy_requires_completed_research_report" }
  | { status: 409; error: "strategy_requires_completed_finance_report" };

function checkStrategyEligibility(
  role: string,
  agentAddress: string,
  opportunityId: string | undefined,
): GuardResult {
  if (role !== "strategy") {
    return null;
  }
  if (typeof opportunityId !== "string" || opportunityId.trim().length === 0) {
    return { status: 400, error: "opportunityId_required" };
  }
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    return { status: 404, error: `opportunity not found: ${opportunityId}` };
  }
  const report = getOpportunityReport(opportunity.report_id);
  if (!report || report.agent_address !== agentAddress) {
    return { status: 403, error: "strategy_department_requires_owning_agent" };
  }
  if (opportunity.status === "rejected") {
    return { status: 409, error: "strategy_requires_non_rejected_opportunity" };
  }
  if (!getCurrentResearchFinding(opportunityId)) {
    return { status: 409, error: "strategy_requires_completed_research_report" };
  }
  if (!getCurrentFinanceFinding(opportunityId)) {
    return { status: 409, error: "strategy_requires_completed_finance_report" };
  }
  return null;
}

// ─── Tests ──────────────────────────────────────────────────────────

test("a non-strategy role is never gated by this check, even with an opportunityId attached", () => {
  reset();
  seedOpportunity("opp_1", "rep_1", "open");
  assert.equal(checkStrategyEligibility("software", "agentA", "opp_1"), null);
  assert.equal(checkStrategyEligibility("finance", "agentA", "opp_1"), null);
  assert.equal(checkStrategyEligibility("research", "agentA", "opp_1"), null);
});

// ─── Unlike finance's own opportunity-scoped guard, strategy has no
// "bare, general-purpose" reading — every strategy department in this
// pipeline is created to work an opportunity, so opportunityId is
// mandatory, not optional-and-ungated the way finance's is. ───────────

test("strategy without an opportunityId is rejected outright", () => {
  reset();
  assert.deepEqual(checkStrategyEligibility("strategy", "agentA", undefined), {
    status: 400,
    error: "opportunityId_required",
  });
  assert.deepEqual(checkStrategyEligibility("strategy", "agentA", ""), {
    status: 400,
    error: "opportunityId_required",
  });
  assert.deepEqual(checkStrategyEligibility("strategy", "agentA", "   "), {
    status: 400,
    error: "opportunityId_required",
  });
});

test("strategy against an unknown opportunityId is rejected", () => {
  reset();
  const result = checkStrategyEligibility("strategy", "agentA", "opp_missing");
  assert.deepEqual(result, { status: 404, error: "opportunity not found: opp_missing" });
});

test("strategy can only be spawned against an opportunity by the agent that owns its report", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedResearchFinding("opp_1");
  seedFinanceFinding("opp_1");

  const asOwner = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.equal(asOwner, null);

  const asStranger = checkStrategyEligibility("strategy", "agentB", "opp_1");
  assert.deepEqual(asStranger, {
    status: 403,
    error: "strategy_department_requires_owning_agent",
  });
});

test("a rejected opportunity is refused — this is the 'non-rejecting reports' gate", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "rejected");
  seedResearchFinding("opp_1");
  seedFinanceFinding("opp_1");

  const result = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.deepEqual(result, { status: 409, error: "strategy_requires_non_rejected_opportunity" });
});

test("an opportunity with neither report yet is refused for the research report first", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  // no research or finance finding seeded

  const result = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.deepEqual(result, {
    status: 409,
    error: "strategy_requires_completed_research_report",
  });
});

test("an opportunity with only a research report is refused for the finance report", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedResearchFinding("opp_1");
  // no finance finding

  const result = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.deepEqual(result, {
    status: 409,
    error: "strategy_requires_completed_finance_report",
  });
});

test("an opportunity with only a finance report (Research still pending) is refused for the research report", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedFinanceFinding("opp_1");
  // no research finding

  const result = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.deepEqual(result, {
    status: 409,
    error: "strategy_requires_completed_research_report",
  });
});

test("an opportunity with both reports filed and status 'selected' is eligible — the happy path", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedResearchFinding("opp_1");
  seedFinanceFinding("opp_1");

  const result = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.equal(result, null);
});

test("an 'open' (demoted) opportunity with both reports filed is still eligible — only 'rejected' is excluded", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "open");
  seedResearchFinding("opp_1");
  seedFinanceFinding("opp_1");

  const result = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.equal(result, null);
});

test("a superseded (re-run) research or finance finding does not count as completed", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedResearchFinding("opp_1");
  seedFinanceFinding("opp_1");
  // Manually mark both current findings superseded, as a live re-run
  // (5e/8-9's own versioning) would mid-flight, with no new version
  // filed yet.
  researchFindings[0].superseded = true;
  financeFindings[0].superseded = true;

  const result = checkStrategyEligibility("strategy", "agentA", "opp_1");
  assert.deepEqual(result, {
    status: 409,
    error: "strategy_requires_completed_research_report",
  });
});
