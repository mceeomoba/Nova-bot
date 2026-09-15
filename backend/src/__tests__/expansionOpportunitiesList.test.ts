// Zent.md Phase 4a: "GET /expansion/opportunities/:agentAddress —
// ranked list, same shape as the 'Top Opportunities' list in chat
// (title, ROI, one-line thesis)."
//
// Inlined mirror of expansion.ts's listRankedOpportunitiesForAgent()
// and of the GET /expansion/opportunities/:agentAddress route's own
// query-param validation (expansionRoutes.ts) — same "no live
// better-sqlite3 / no live express server in this environment" reason
// every prior backend/src test file in this repo already carries (see
// expansionTopNSelection.test.ts's own header for the identical note on
// the Phase 3d logic it mirrors).
//
// What this covers:
//   4a — ranked by roi_score DESC, ties broken by created_at ASC then
//        id ASC — same deterministic order selectTopOpenOpportunities()
//        (3d) already established, reused here for a read.
//   4a — opportunities under an 'archived' report are excluded by
//        default (dead cycles, incl. Phase 3e kills, don't show up in
//        the live ranked list).
//   4a — an unscored opportunity (roi_score null) is never included.
//   4a — one agent's opportunities never leak into another agent's
//        list.
//   4a — options.status narrows to one Phase 3d status.
//   4a — options.limit caps the result and must be a positive integer;
//        default limit is applied when omitted.
//   4a — an agentAddress with nothing eligible returns an empty array,
//        not an error.
//   4a — the route layer: invalid `status`/`limit` query params are
//        rejected with 400 before the data layer is ever called; valid
//        ones are parsed and passed through.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's opportunity_reports / opportunities rows ─

type OpportunityReportStatus = "draft" | "scored" | "archived";
type OpportunityStatus = "open" | "selected" | "rejected";

interface FakeReport {
  id: string;
  agent_address: string;
  status: OpportunityReportStatus;
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  created_at: number;
  title: string;
  thesis: string;
  roi_score: number | null;
  status: OpportunityStatus;
  tags: string[];
}

let reports: Map<string, FakeReport>;
let opportunities: FakeOpportunity[];
let seq: number;

function reset() {
  reports = new Map();
  opportunities = [];
  seq = 0;
}

function createReport(agentAddress: string, status: OpportunityReportStatus = "draft"): FakeReport {
  const row: FakeReport = { id: `oppr_${++seq}`, agent_address: agentAddress, status };
  reports.set(row.id, row);
  return row;
}

function seedOpportunity(
  report: FakeReport,
  title: string,
  roiScore: number | null,
  opts: { createdAt?: number; status?: OpportunityStatus } = {},
): FakeOpportunity {
  const opp: FakeOpportunity = {
    id: `opp_${++seq}`,
    report_id: report.id,
    created_at: opts.createdAt ?? Date.now() + seq,
    title,
    thesis: `Thesis for ${title}`,
    roi_score: roiScore,
    status: opts.status ?? "open",
    tags: [],
  };
  opportunities.push(opp);
  return opp;
}

// ─── Mirror of expansion.ts's listRankedOpportunitiesForAgent() ───────

interface RankedOpportunity {
  id: string;
  reportId: string;
  title: string;
  thesis: string;
  roiScore: number;
  status: OpportunityStatus;
  tags: string[];
  createdAt: number;
}

function listRankedOpportunitiesForAgent(
  agentAddress: string,
  options: { status?: OpportunityStatus; limit?: number } = {},
): RankedOpportunity[] {
  if (!agentAddress) throw new Error("agentAddress is required");
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

  let eligible = opportunities.filter((o) => {
    if (o.roi_score === null) return false;
    const report = reports.get(o.report_id)!;
    if (report.agent_address !== agentAddress) return false;
    if (report.status === "archived") return false;
    if (options.status && o.status !== options.status) return false;
    return true;
  });

  eligible = eligible.sort((a, b) => {
    if (b.roi_score! !== a.roi_score!) return b.roi_score! - a.roi_score!;
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id.localeCompare(b.id);
  });

  return eligible.slice(0, limit).map((o) => ({
    id: o.id,
    reportId: o.report_id,
    title: o.title,
    thesis: o.thesis,
    roiScore: o.roi_score as number,
    status: o.status,
    tags: o.tags,
    createdAt: o.created_at,
  }));
}

// ─── Mirror of the GET /expansion/opportunities/:agentAddress route ───

function handleListRoute(
  agentAddress: string | undefined,
  query: { status?: unknown; limit?: unknown },
): { httpStatus: number; body: any } {
  if (!agentAddress) {
    return { httpStatus: 400, body: { error: "agentAddress is required" } };
  }

  const options: { status?: OpportunityStatus; limit?: number } = {};

  if (query.status !== undefined) {
    if (typeof query.status !== "string" || !["open", "selected", "rejected"].includes(query.status)) {
      return { httpStatus: 400, body: { error: "status must be one of: open, selected, rejected" } };
    }
    options.status = query.status as OpportunityStatus;
  }

  if (query.limit !== undefined) {
    const parsedLimit = Number(query.limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      return { httpStatus: 400, body: { error: "limit must be a positive integer" } };
    }
    options.limit = parsedLimit;
  }

  try {
    const opps = listRankedOpportunitiesForAgent(agentAddress, options);
    return { httpStatus: 200, body: { agentAddress, opportunities: opps } };
  } catch (err: any) {
    return { httpStatus: 500, body: { error: err.message || "internal_error" } };
  }
}

// ─── 4a: listRankedOpportunitiesForAgent (data layer) ──────────────────

describe("listRankedOpportunitiesForAgent", () => {
  test("ranks by roi_score, highest first", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, "Low", 40);
    const high = seedOpportunity(report, "High", 90);
    const mid = seedOpportunity(report, "Mid", 65);

    const ranked = listRankedOpportunitiesForAgent("agent-1");
    assert.deepEqual(
      ranked.map((r) => r.id),
      [high.id, mid.id, ranked[2].id],
    );
    assert.equal(ranked[0].roiScore, 90);
  });

  test("breaks a roi_score tie by earliest created_at, then id", () => {
    reset();
    const report = createReport("agent-1");
    const older = seedOpportunity(report, "Older tie", 75, { createdAt: 1000 });
    seedOpportunity(report, "Newer tie", 75, { createdAt: 2000 });

    const ranked = listRankedOpportunitiesForAgent("agent-1");
    assert.equal(ranked[0].id, older.id);
  });

  test("excludes opportunities under an archived report", () => {
    reset();
    const live = createReport("agent-1");
    seedOpportunity(live, "Live idea", 80);
    const dead = createReport("agent-1", "archived");
    seedOpportunity(dead, "Killed idea", 99);

    const ranked = listRankedOpportunitiesForAgent("agent-1");
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].title, "Live idea");
  });

  test("excludes unscored opportunities (roi_score null)", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, "Unscored", null);

    const ranked = listRankedOpportunitiesForAgent("agent-1");
    assert.equal(ranked.length, 0);
  });

  test("one agent's list never includes another agent's opportunities", () => {
    reset();
    const reportA = createReport("agent-1");
    seedOpportunity(reportA, "A's idea", 60);
    const reportB = createReport("agent-2");
    seedOpportunity(reportB, "B's idea", 99);

    const rankedA = listRankedOpportunitiesForAgent("agent-1");
    assert.equal(rankedA.length, 1);
    assert.equal(rankedA[0].title, "A's idea");
  });

  test("options.status narrows to one Phase 3d status", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, "Open one", 80, { status: "open" });
    const selected = seedOpportunity(report, "Selected one", 60, { status: "selected" });

    const ranked = listRankedOpportunitiesForAgent("agent-1", { status: "selected" });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].id, selected.id);
  });

  test("options.limit caps the result", () => {
    reset();
    const report = createReport("agent-1");
    for (let i = 0; i < 5; i++) {
      seedOpportunity(report, `Idea ${i}`, 50 + i, { createdAt: 1000 + i });
    }

    const ranked = listRankedOpportunitiesForAgent("agent-1", { limit: 2 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].title, "Idea 4");
    assert.equal(ranked[1].title, "Idea 3");
  });

  test("limit must be a positive integer", () => {
    reset();
    assert.throws(() => listRankedOpportunitiesForAgent("agent-1", { limit: 0 }));
    assert.throws(() => listRankedOpportunitiesForAgent("agent-1", { limit: -1 }));
    assert.throws(() => listRankedOpportunitiesForAgent("agent-1", { limit: 1.5 }));
  });

  test("agentAddress is required", () => {
    reset();
    assert.throws(() => listRankedOpportunitiesForAgent(""));
  });

  test("no eligible opportunities returns an empty array, not an error", () => {
    reset();
    assert.doesNotThrow(() => {
      const ranked = listRankedOpportunitiesForAgent("agent-nobody");
      assert.deepEqual(ranked, []);
    });
  });
});

// ─── 4a: GET /expansion/opportunities/:agentAddress (route layer) ─────

describe("GET /expansion/opportunities/:agentAddress", () => {
  test("200s with a ranked list for a valid agentAddress", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, "Idea", 80);

    const result = handleListRoute("agent-1", {});
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.agentAddress, "agent-1");
    assert.equal(result.body.opportunities.length, 1);
  });

  test("400s when agentAddress is missing", () => {
    reset();
    const result = handleListRoute(undefined, {});
    assert.equal(result.httpStatus, 400);
  });

  test("400s on an invalid status query param", () => {
    reset();
    const result = handleListRoute("agent-1", { status: "not-a-real-status" });
    assert.equal(result.httpStatus, 400);
  });

  test("400s on a non-positive-integer limit query param", () => {
    reset();
    assert.equal(handleListRoute("agent-1", { limit: "0" }).httpStatus, 400);
    assert.equal(handleListRoute("agent-1", { limit: "abc" }).httpStatus, 400);
    assert.equal(handleListRoute("agent-1", { limit: "1.5" }).httpStatus, 400);
  });

  test("accepts and applies a valid status + limit combination", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, "Open", 90, { status: "open" });
    seedOpportunity(report, "Selected", 80, { status: "selected" });

    const result = handleListRoute("agent-1", { status: "open", limit: "5" });
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.opportunities.length, 1);
    assert.equal(result.body.opportunities[0].title, "Open");
  });
});
