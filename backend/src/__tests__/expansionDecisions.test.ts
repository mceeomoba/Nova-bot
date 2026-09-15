// Zent.md Phase 1d: expansion_decisions data model.
// Inlined mirror of expansion.ts's own logic against plain in-memory
// data, standing in for `expansion_decisions` and its parent
// `opportunities`/`opportunity_reports` — same "no live better-sqlite3
// in this environment" reason every prior backend/src test file in this
// repo already carries (see orgChartQuotas.test.ts's own header).
// Recommend re-running against the real
// recordExpansionDecision()/expansion.ts/db.ts once a networked
// environment is available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

type OpportunityReportStatus = "draft" | "scored" | "archived";
type CeoDecision = "approved" | "rejected" | "deferred";

interface FakeOpportunityReport {
  id: string;
  agent_address: string;
  created_at: number;
  source_summary: string;
  status: OpportunityReportStatus;
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  created_at: number;
  title: string;
  thesis: string;
  roi_score: number | null;
  tags: string[];
}

interface FakeExpansionDecision<V = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  committee_votes: V;
  ceo_decision: CeoDecision;
  decided_at: number;
  decided_by: string;
}

let reports: Map<string, FakeOpportunityReport>;
let opportunities: Map<string, FakeOpportunity>;
let decisions: Map<string, FakeExpansionDecision>;
let reportSeq: number;
let oppSeq: number;
let decisionSeq: number;

function reset() {
  reports = new Map();
  opportunities = new Map();
  decisions = new Map();
  reportSeq = 0;
  oppSeq = 0;
  decisionSeq = 0;
}

// ─── Inlined mirror of expansion.ts's own exported functions ──────────

function createOpportunityReport(agentAddress: string): FakeOpportunityReport {
  if (!agentAddress) throw new Error("agentAddress is required");
  const row: FakeOpportunityReport = {
    id: `oppr_${++reportSeq}`,
    agent_address: agentAddress,
    created_at: Date.now() + reportSeq,
    source_summary: "",
    status: "draft",
  };
  reports.set(row.id, row);
  return row;
}

function createOpportunity(reportId: string, title: string, thesis: string): FakeOpportunity {
  if (!reportId) throw new Error("reportId is required");
  const report = reports.get(reportId);
  if (!report) throw new Error(`opportunity_report ${reportId} not found`);
  const row: FakeOpportunity = {
    id: `opp_${++oppSeq}`,
    report_id: reportId,
    created_at: Date.now() + oppSeq,
    title,
    thesis,
    roi_score: null,
    tags: [],
  };
  opportunities.set(row.id, row);
  return row;
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

const VALID_DECISIONS: CeoDecision[] = ["approved", "rejected", "deferred"];

function recordExpansionDecision<V = Record<string, unknown>>(
  opportunityId: string,
  ceoDecision: CeoDecision,
  decidedBy: string,
  committeeVotes: V = {} as V,
): FakeExpansionDecision<V> {
  if (!opportunityId) throw new Error("opportunityId is required");
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) throw new Error(`opportunity ${opportunityId} not found`);
  if (!VALID_DECISIONS.includes(ceoDecision)) {
    throw new Error(`ceoDecision must be one of ${VALID_DECISIONS.join(", ")}, got "${ceoDecision}"`);
  }
  if (!decidedBy) throw new Error("decidedBy is required");
  const row: FakeExpansionDecision<V> = {
    id: `xdec_${++decisionSeq}`,
    opportunity_id: opportunityId,
    committee_votes: committeeVotes ?? ({} as V),
    ceo_decision: ceoDecision,
    decided_at: Date.now() + decisionSeq,
    decided_by: decidedBy,
  };
  decisions.set(row.id, row as FakeExpansionDecision);
  return row;
}

function getExpansionDecision(id: string): FakeExpansionDecision | undefined {
  return decisions.get(id);
}

function listExpansionDecisions(opportunityId: string): FakeExpansionDecision[] {
  return [...decisions.values()]
    .filter((d) => d.opportunity_id === opportunityId)
    .sort((a, b) => b.decided_at - a.decided_at);
}

function getLatestExpansionDecision(opportunityId: string): FakeExpansionDecision | undefined {
  return listExpansionDecisions(opportunityId)[0];
}

// ─── Tests ──────────────────────────────────────────────────────────

test("recordExpansionDecision requires an existing opportunity", () => {
  reset();
  assert.throws(() => recordExpansionDecision("opp_missing", "approved", "0xCEO"));
});

test("recordExpansionDecision requires decidedBy", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  assert.throws(() => recordExpansionDecision(o.id, "approved", ""));
});

test("recordExpansionDecision rejects a decision outside approved/rejected/deferred", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  assert.throws(() => recordExpansionDecision(o.id, "maybe" as CeoDecision, "0xCEO"));
});

test("recordExpansionDecision defaults committee_votes to an empty object", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  const d = recordExpansionDecision(o.id, "approved", "0xCEO");
  assert.deepEqual(d.committee_votes, {});
  assert.equal(d.opportunity_id, o.id);
  assert.equal(d.decided_by, "0xCEO");
  assert.equal(getExpansionDecision(d.id)?.id, d.id);
});

test("recordExpansionDecision stores an arbitrary committee_votes payload", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  const votes = { research: "recommend", finance: "recommend-with-conditions", strategy: "recommend" };
  const d = recordExpansionDecision(o.id, "approved", "0xCEO", votes);
  assert.deepEqual(d.committee_votes, votes);
});

test("a deferred decision does not overwrite or invalidate anything — it's just a row", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  const first = recordExpansionDecision(o.id, "deferred", "0xCEO");
  assert.equal(getExpansionDecision(first.id)?.ceo_decision, "deferred");
  // A later tick re-rules on the same opportunity without anything upstream re-running.
  const second = recordExpansionDecision(o.id, "approved", "0xCEO");
  assert.equal(getExpansionDecision(first.id)?.ceo_decision, "deferred", "history is untouched");
  assert.equal(getExpansionDecision(second.id)?.ceo_decision, "approved");
});

test("listExpansionDecisions scopes to one opportunity and orders most-recent-first", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o1 = createOpportunity(r.id, "First", "Thesis one");
  const o2 = createOpportunity(r.id, "Second", "Thesis two");
  const d1 = recordExpansionDecision(o1.id, "deferred", "0xCEO");
  const d2 = recordExpansionDecision(o1.id, "approved", "0xCEO");
  recordExpansionDecision(o2.id, "rejected", "0xCEO");
  assert.deepEqual(
    listExpansionDecisions(o1.id).map((d) => d.id),
    [d2.id, d1.id],
  );
});

test("listExpansionDecisions returns an empty array for an opportunity the CEO hasn't ruled on", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  assert.deepEqual(listExpansionDecisions(o.id), []);
});

test("getLatestExpansionDecision returns the most recent ruling, including a current deferred", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  recordExpansionDecision(o.id, "deferred", "0xCEO");
  const latest = recordExpansionDecision(o.id, "deferred", "0xCEO");
  assert.equal(getLatestExpansionDecision(o.id)?.id, latest.id);
  assert.equal(getLatestExpansionDecision(o.id)?.ceo_decision, "deferred");
});

test("getLatestExpansionDecision returns undefined when no ruling exists yet", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  assert.equal(getLatestExpansionDecision(o.id), undefined);
});

test("a rejected decision is still queryable history, same as approved/deferred", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  const d = recordExpansionDecision(o.id, "rejected", "0xCEO", { finance: "do-not-recommend" });
  assert.equal(getLatestExpansionDecision(o.id)?.ceo_decision, "rejected");
  assert.deepEqual(getLatestExpansionDecision(o.id)?.committee_votes, { finance: "do-not-recommend" });
});
