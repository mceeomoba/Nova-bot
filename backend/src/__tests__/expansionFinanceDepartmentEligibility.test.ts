// Zent.md Phase 8a: "Department type `finance`, spawned against a
// `scored` opportunity that has a completed research report (a
// `high_regulatory_risk` tag does not block Finance from picking it
// up)."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of departments.ts's POST / route's Phase 8a guard
// block against plain in-memory stand-ins for opportunities/
// opportunity_reports/research_findings, rather than importing
// departments.ts (which pulls in express + db.js -> better-sqlite3 at
// module load, same reason expansionResearchDepartmentTeardown.test.ts's
// own header gives for not importing departments.ts either). Recommend
// re-running against the real route once a networked environment is
// available.

import { test } from "node:test";
import assert from "node:assert/strict";

type OpportunityStatus = "open" | "selected" | "rejected";

interface FakeOpportunity {
  id: string;
  report_id: string;
  status: OpportunityStatus;
  tags: string[];
}

interface FakeReport {
  id: string;
  agent_address: string;
}

interface FakeResearchFinding {
  opportunity_id: string;
  superseded: boolean;
}

let opportunities: Map<string, FakeOpportunity>;
let reports: Map<string, FakeReport>;
let researchFindings: FakeResearchFinding[];

function reset() {
  opportunities = new Map();
  reports = new Map();
  researchFindings = [];
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
  tags: string[] = [],
): FakeOpportunity {
  const o: FakeOpportunity = { id, report_id: reportId, status, tags };
  opportunities.set(id, o);
  return o;
}

function seedResearchFinding(opportunityId: string): void {
  for (const f of researchFindings) {
    if (f.opportunity_id === opportunityId) f.superseded = true;
  }
  researchFindings.push({ opportunity_id: opportunityId, superseded: false });
}

// ─── Inlined mirrors of expansion.ts's own reads ───────────────────────

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function getOpportunityReport(reportId: string): FakeReport | undefined {
  return reports.get(reportId);
}

function getCurrentResearchFinding(opportunityId: string): FakeResearchFinding | undefined {
  return researchFindings.find((f) => f.opportunity_id === opportunityId && !f.superseded);
}

// ─── Inlined mirror of departments.ts's POST / Phase 8a guard block ────
// Only the finance-with-opportunityId branch — mirrors the real route's
// early-return shape (an error object in place of res.status(...).json(...)),
// and `null` for "no gate applies, proceed as an ordinary department".

type GuardResult =
  | null
  | { status: 404; error: string }
  | { status: 403; error: "finance_department_requires_owning_agent" }
  | { status: 409; error: "finance_requires_selected_opportunity" }
  | { status: 409; error: "finance_requires_completed_research_report" };

function checkFinanceEligibility(
  role: string,
  agentAddress: string,
  opportunityId: string | undefined,
): GuardResult {
  if (role !== "finance" || typeof opportunityId !== "string" || opportunityId.trim().length === 0) {
    return null;
  }
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    return { status: 404, error: `opportunity not found: ${opportunityId}` };
  }
  const report = getOpportunityReport(opportunity.report_id);
  if (!report || report.agent_address !== agentAddress) {
    return { status: 403, error: "finance_department_requires_owning_agent" };
  }
  if (opportunity.status !== "selected") {
    return { status: 409, error: "finance_requires_selected_opportunity" };
  }
  if (!getCurrentResearchFinding(opportunityId)) {
    return { status: 409, error: "finance_requires_completed_research_report" };
  }
  // high_regulatory_risk tag deliberately never checked.
  return null;
}

// ─── Tests ──────────────────────────────────────────────────────────

test("a bare finance department (no opportunityId) is never gated — ordinary general-purpose use is unaffected", () => {
  reset();
  assert.equal(checkFinanceEligibility("finance", "agentA", undefined), null);
  assert.equal(checkFinanceEligibility("finance", "agentA", ""), null);
  assert.equal(checkFinanceEligibility("finance", "agentA", "   "), null);
});

test("a non-finance role is never gated by this check, even with an opportunityId attached", () => {
  reset();
  seedOpportunity("opp_1", "rep_1", "open");
  assert.equal(checkFinanceEligibility("software", "agentA", "opp_1"), null);
  assert.equal(checkFinanceEligibility("marketing", "agentA", "opp_1"), null);
});

test("finance against an unknown opportunityId is rejected", () => {
  reset();
  const result = checkFinanceEligibility("finance", "agentA", "opp_missing");
  assert.deepEqual(result, { status: 404, error: "opportunity not found: opp_missing" });
});

test("finance can only be spawned against an opportunity by the agent that owns its report", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedResearchFinding("opp_1");

  const asOwner = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.equal(asOwner, null);

  const asStranger = checkFinanceEligibility("finance", "agentB", "opp_1");
  assert.deepEqual(asStranger, { status: 403, error: "finance_department_requires_owning_agent" });
});

test("an open (not-yet-selected) opportunity is rejected — 'scored' means opportunities.status === 'selected'", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "open");
  seedResearchFinding("opp_1"); // even with a research report already filed

  const result = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.deepEqual(result, { status: 409, error: "finance_requires_selected_opportunity" });
});

test("a rejected opportunity is rejected too, same as an open one", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "rejected");
  seedResearchFinding("opp_1");

  const result = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.deepEqual(result, { status: 409, error: "finance_requires_selected_opportunity" });
});

test("a selected opportunity with no research finding yet is rejected — Finance can't pick up ahead of Research", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  // no seedResearchFinding call

  const result = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.deepEqual(result, { status: 409, error: "finance_requires_completed_research_report" });
});

test("a selected opportunity with a completed research finding is eligible — the happy path", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedResearchFinding("opp_1");

  const result = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.equal(result, null);
});

test("a high_regulatory_risk tag does NOT block Finance from picking up an otherwise-eligible opportunity", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected", ["high_regulatory_risk"]);
  seedResearchFinding("opp_1");

  const result = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.equal(result, null);
});

test("a superseded-only research finding (the current one was re-run and replaced) still counts as completed, as long as a CURRENT one exists", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedResearchFinding("opp_1"); // v1, now superseded
  seedResearchFinding("opp_1"); // v2, current

  const result = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.equal(result, null);
  assert.equal(getCurrentResearchFinding("opp_1")?.opportunity_id, "opp_1");
});

test("a research finding that exists only for a DIFFERENT opportunity doesn't satisfy this opportunity's gate", () => {
  reset();
  seedReport("rep_1", "agentA");
  seedOpportunity("opp_1", "rep_1", "selected");
  seedOpportunity("opp_2", "rep_1", "selected");
  seedResearchFinding("opp_2"); // wrong opportunity

  const result = checkFinanceEligibility("finance", "agentA", "opp_1");
  assert.deepEqual(result, { status: 409, error: "finance_requires_completed_research_report" });
});
