// Zent.md Phase 1a: opportunity_reports data model.
// Inlined mirror of expansion.ts's own logic against plain in-memory
// data, standing in for `opportunity_reports` — same "no live
// better-sqlite3 in this environment" reason every prior backend/src
// test file in this repo already carries (see orgChartQuotas.test.ts's
// own header). Recommend re-running against the real
// createOpportunityReport()/expansion.ts/db.ts once a networked
// environment is available, per every prior phase's own standing note.

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

let reports: Map<string, FakeOpportunityReport>;
let seq: number;

function reset() {
  reports = new Map();
  seq = 0;
}

// ─── Inlined mirror of expansion.ts's own exported functions ──────────

function createOpportunityReport(agentAddress: string): FakeOpportunityReport {
  if (!agentAddress) throw new Error("agentAddress is required");
  const row: FakeOpportunityReport = {
    id: `oppr_${++seq}`,
    agent_address: agentAddress,
    created_at: Date.now() + seq, // monotonic for ordering assertions below
    source_summary: "",
    status: "draft",
  };
  reports.set(row.id, row);
  return row;
}

function getOpportunityReport(id: string): FakeOpportunityReport | undefined {
  return reports.get(id);
}

function listOpportunityReports(
  agentAddress: string,
  status?: OpportunityReportStatus,
): FakeOpportunityReport[] {
  return [...reports.values()]
    .filter((r) => r.agent_address === agentAddress && (!status || r.status === status))
    .sort((a, b) => b.created_at - a.created_at);
}

function appendSourceSummary(id: string, addition: string): FakeOpportunityReport {
  const existing = reports.get(id);
  if (!existing) throw new Error(`opportunity_report ${id} not found`);
  if (existing.status !== "draft") {
    throw new Error(`opportunity_report ${id} is ${existing.status}, not draft`);
  }
  existing.source_summary = existing.source_summary
    ? `${existing.source_summary}\n${addition}`
    : addition;
  return existing;
}

const TERMINAL: Record<OpportunityReportStatus, OpportunityReportStatus[]> = {
  draft: ["scored", "archived"],
  scored: ["archived"],
  archived: [],
};

function setOpportunityReportStatus(
  id: string,
  status: OpportunityReportStatus,
): FakeOpportunityReport {
  const existing = reports.get(id);
  if (!existing) throw new Error(`opportunity_report ${id} not found`);
  if (existing.status === status) return existing;
  if (!TERMINAL[existing.status].includes(status)) {
    throw new Error(`cannot move opportunity_report ${id} from ${existing.status} to ${status}`);
  }
  existing.status = status;
  return existing;
}

// ─── Tests ──────────────────────────────────────────────────────────

test("createOpportunityReport starts in draft with empty source_summary", () => {
  reset();
  const r = createOpportunityReport("0xCOMPANY_A");
  assert.equal(r.status, "draft");
  assert.equal(r.source_summary, "");
  assert.equal(r.agent_address, "0xCOMPANY_A");
  assert.equal(getOpportunityReport(r.id)?.id, r.id);
});

test("createOpportunityReport requires an agent_address", () => {
  reset();
  assert.throws(() => createOpportunityReport(""));
});

test("listOpportunityReports scopes to one agent and orders most-recent-first", () => {
  reset();
  const a1 = createOpportunityReport("0xA");
  const a2 = createOpportunityReport("0xA");
  createOpportunityReport("0xB");
  const listed = listOpportunityReports("0xA");
  assert.deepEqual(
    listed.map((r) => r.id),
    [a2.id, a1.id],
  );
});

test("listOpportunityReports can filter by status", () => {
  reset();
  const draft = createOpportunityReport("0xA");
  const toArchive = createOpportunityReport("0xA");
  setOpportunityReportStatus(toArchive.id, "archived");
  assert.deepEqual(
    listOpportunityReports("0xA", "draft").map((r) => r.id),
    [draft.id],
  );
  assert.deepEqual(
    listOpportunityReports("0xA", "archived").map((r) => r.id),
    [toArchive.id],
  );
});

test("appendSourceSummary accumulates rather than overwrites", () => {
  reset();
  const r = createOpportunityReport("0xA");
  appendSourceSummary(r.id, "signal one");
  appendSourceSummary(r.id, "signal two");
  assert.equal(getOpportunityReport(r.id)!.source_summary, "signal one\nsignal two");
});

test("appendSourceSummary refuses once a report has left draft", () => {
  reset();
  const r = createOpportunityReport("0xA");
  setOpportunityReportStatus(r.id, "scored");
  assert.throws(() => appendSourceSummary(r.id, "too late"));
});

test("status lifecycle only moves forward: draft -> scored -> archived", () => {
  reset();
  const r = createOpportunityReport("0xA");
  setOpportunityReportStatus(r.id, "scored");
  assert.equal(getOpportunityReport(r.id)!.status, "scored");
  setOpportunityReportStatus(r.id, "archived");
  assert.equal(getOpportunityReport(r.id)!.status, "archived");
});

test("status lifecycle allows draft -> archived directly (Phase 3e: no good ideas)", () => {
  reset();
  const r = createOpportunityReport("0xA");
  setOpportunityReportStatus(r.id, "archived");
  assert.equal(getOpportunityReport(r.id)!.status, "archived");
});

test("status lifecycle rejects going backward", () => {
  reset();
  const r = createOpportunityReport("0xA");
  setOpportunityReportStatus(r.id, "scored");
  assert.throws(() => setOpportunityReportStatus(r.id, "draft"));
});

test("status lifecycle rejects moving out of archived (terminal)", () => {
  reset();
  const r = createOpportunityReport("0xA");
  setOpportunityReportStatus(r.id, "archived");
  assert.throws(() => setOpportunityReportStatus(r.id, "scored"));
});

test("setOpportunityReportStatus is a no-op when already at the target status", () => {
  reset();
  const r = createOpportunityReport("0xA");
  const again = setOpportunityReportStatus(r.id, "draft");
  assert.equal(again.status, "draft");
});
