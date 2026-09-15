// Zent.md Phase 1b: opportunities data model.
// Inlined mirror of expansion.ts's own logic against plain in-memory
// data, standing in for `opportunities` and its parent `opportunity_reports`
// — same "no live better-sqlite3 in this environment" reason
// expansionPipeline.test.ts's own header already documents. Recommend
// re-running against the real createOpportunity()/expansion.ts/db.ts
// once a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

type OpportunityReportStatus = "draft" | "scored" | "archived";

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

let reports: Map<string, FakeOpportunityReport>;
let opportunities: Map<string, FakeOpportunity>;
let reportSeq: number;
let oppSeq: number;

function reset() {
  reports = new Map();
  opportunities = new Map();
  reportSeq = 0;
  oppSeq = 0;
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

function getOpportunityReport(id: string): FakeOpportunityReport | undefined {
  return reports.get(id);
}

function createOpportunity(
  reportId: string,
  title: string,
  thesis: string,
  options: { roiScore?: number; tags?: string[] } = {},
): FakeOpportunity {
  if (!reportId) throw new Error("reportId is required");
  if (!title) throw new Error("title is required");
  if (!thesis) throw new Error("thesis is required");
  const report = getOpportunityReport(reportId);
  if (!report) throw new Error(`opportunity_report ${reportId} not found`);
  const roiScore = options.roiScore ?? null;
  if (roiScore !== null && !Number.isFinite(roiScore)) {
    throw new Error("roiScore must be a finite number");
  }
  const row: FakeOpportunity = {
    id: `opp_${++oppSeq}`,
    report_id: reportId,
    created_at: Date.now() + oppSeq,
    title,
    thesis,
    roi_score: roiScore,
    tags: options.tags ?? [],
  };
  opportunities.set(row.id, row);
  return row;
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function listOpportunitiesForReport(reportId: string): FakeOpportunity[] {
  return [...opportunities.values()]
    .filter((o) => o.report_id === reportId)
    .sort((a, b) => b.created_at - a.created_at);
}

function setOpportunityRoiScore(id: string, roiScore: number): FakeOpportunity {
  if (!Number.isFinite(roiScore)) throw new Error("roiScore must be a finite number");
  const existing = opportunities.get(id);
  if (!existing) throw new Error(`opportunity ${id} not found`);
  existing.roi_score = roiScore;
  return existing;
}

// ─── Tests ──────────────────────────────────────────────────────────

test("createOpportunity requires an existing report", () => {
  reset();
  assert.throws(() => createOpportunity("oppr_missing", "Title", "Thesis"));
});

test("createOpportunity requires title and thesis", () => {
  reset();
  const r = createOpportunityReport("0xA");
  assert.throws(() => createOpportunity(r.id, "", "Thesis"));
  assert.throws(() => createOpportunity(r.id, "Title", ""));
});

test("createOpportunity defaults roi_score to null and tags to an empty array", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  assert.equal(o.roi_score, null);
  assert.deepEqual(o.tags, []);
  assert.equal(o.report_id, r.id);
  assert.equal(getOpportunity(o.id)?.id, o.id);
});

test("createOpportunity accepts an explicit roiScore and tags", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis", {
    roiScore: 72.5,
    tags: ["b2b", "infra"],
  });
  assert.equal(o.roi_score, 72.5);
  assert.deepEqual(o.tags, ["b2b", "infra"]);
});

test("createOpportunity rejects a non-finite roiScore", () => {
  reset();
  const r = createOpportunityReport("0xA");
  assert.throws(() => createOpportunity(r.id, "Title", "Thesis", { roiScore: NaN }));
  assert.throws(() => createOpportunity(r.id, "Title", "Thesis", { roiScore: Infinity }));
});

test("listOpportunitiesForReport scopes to one report and orders most-recent-first", () => {
  reset();
  const r1 = createOpportunityReport("0xA");
  const r2 = createOpportunityReport("0xA");
  const o1 = createOpportunity(r1.id, "First", "Thesis one");
  const o2 = createOpportunity(r1.id, "Second", "Thesis two");
  createOpportunity(r2.id, "Other report's idea", "Thesis three");
  assert.deepEqual(
    listOpportunitiesForReport(r1.id).map((o) => o.id),
    [o2.id, o1.id],
  );
});

test("listOpportunitiesForReport returns an empty array for a report with none scored yet", () => {
  reset();
  const r = createOpportunityReport("0xA");
  assert.deepEqual(listOpportunitiesForReport(r.id), []);
});

test("setOpportunityRoiScore updates an existing opportunity", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  const updated = setOpportunityRoiScore(o.id, 88);
  assert.equal(updated.roi_score, 88);
  assert.equal(getOpportunity(o.id)!.roi_score, 88);
});

test("setOpportunityRoiScore throws for a missing opportunity", () => {
  reset();
  assert.throws(() => setOpportunityRoiScore("opp_missing", 50));
});

test("setOpportunityRoiScore rejects a non-finite score", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const o = createOpportunity(r.id, "Title", "Thesis");
  assert.throws(() => setOpportunityRoiScore(o.id, NaN));
});

test("a report can exist with zero scored opportunities (draft still collecting signal)", () => {
  reset();
  const r = createOpportunityReport("0xA");
  assert.equal(listOpportunitiesForReport(r.id).length, 0);
  assert.equal(getOpportunityReport(r.id)!.status, "draft");
});
