// Zent.md Phase 3e: "Kill condition: if no opportunity clears a
// minimum ROI floor, the department produces a report saying so and
// the pipeline stops for this cycle — 'no good ideas this month' is a
// valid, expected output."
//
// Inlined mirror of expansion.ts's evaluateKillCondition()/
// sweepKillCondition() against plain in-memory data — same "no live
// better-sqlite3 in this environment" reason every prior backend/src
// test file in this repo already carries (see expansionTopNSelection
// .test.ts's own header for the identical note on the Phase 3d logic
// it mirrors). Recommend re-running against the real expansion.ts/db.ts
// once a networked environment is available, per every prior phase's
// own standing note.
//
// What this covers:
//   3e — a 'draft' report whose scored opportunities are ALL below the
//        floor gets archived, with a note appended to source_summary
//        before the archive (appendSourceSummary requires 'draft').
//   3e — a report with at least one opportunity AT OR ABOVE the floor
//        is left alone, in any of that opportunity's own Phase 3d
//        statuses (open, selected) — the floor check doesn't care
//        whether 3d has already promoted the winning opportunity.
//   3e — a report with zero scored opportunities yet (still mid-scan)
//        is left alone — "no good ideas" is a verdict on what got
//        scored, not an excuse to close out an empty-so-far report.
//   3e — a report that isn't 'draft' (already 'scored' or 'archived')
//        is left untouched, not thrown on, so a sweep never needs to
//        pre-filter by status itself.
//   3e — exactly-at-the-floor counts as clearing it (>=, not >).
//   3e — sweepKillCondition() only ever touches 'draft' reports with at
//        least one scored opportunity, and returns only the ones it
//        actually archived this pass.
//   3e — a nonexistent report id throws (matches every other expansion
//        .ts lookup's "not found is a bug, not a valid empty-ish
//        input" convention).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's opportunity_reports / opportunities rows ─

type OpportunityReportStatus = "draft" | "scored" | "archived";
type OpportunityStatus = "open" | "selected" | "rejected";

interface FakeReport {
  id: string;
  agent_address: string;
  source_summary: string;
  status: OpportunityReportStatus;
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  roi_score: number | null;
  status: OpportunityStatus;
}

let reports: Map<string, FakeReport>;
let opportunities: FakeOpportunity[];
let seq: number;

const DEFAULT_ROI_FLOOR = 50;

function reset() {
  reports = new Map();
  opportunities = [];
  seq = 0;
}

function createReport(agentAddress: string, status: OpportunityReportStatus = "draft"): FakeReport {
  const row: FakeReport = {
    id: `oppr_${++seq}`,
    agent_address: agentAddress,
    source_summary: "",
    status,
  };
  reports.set(row.id, row);
  return row;
}

function seedOpportunity(
  report: FakeReport,
  roiScore: number | null,
  opts: { status?: OpportunityStatus } = {},
): FakeOpportunity {
  const opp: FakeOpportunity = {
    id: `opp_${++seq}`,
    report_id: report.id,
    roi_score: roiScore,
    status: opts.status ?? "open",
  };
  opportunities.push(opp);
  return opp;
}

// ─── Inlined mirror of expansion.ts's Phase 1a helpers, reused as-is ──

function getOpportunityReport(id: string): FakeReport | undefined {
  return reports.get(id);
}

function appendSourceSummary(id: string, addition: string): FakeReport {
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

function setOpportunityReportStatus(id: string, status: OpportunityReportStatus): FakeReport {
  const existing = reports.get(id);
  if (!existing) throw new Error(`opportunity_report ${id} not found`);
  if (existing.status === status) return existing;
  if (!TERMINAL[existing.status].includes(status)) {
    throw new Error(`cannot move opportunity_report ${id} from ${existing.status} to ${status}`);
  }
  existing.status = status;
  return existing;
}

// ─── Mirror of expansion.ts's Phase 3e functions ───────────────────────

interface KillConditionResult {
  reportId: string;
  agentAddress: string;
  archived: boolean;
  scoredCount: number;
  bestRoiScore: number | null;
}

function evaluateKillCondition(
  reportId: string,
  roiFloor: number = DEFAULT_ROI_FLOOR,
): KillConditionResult {
  const report = getOpportunityReport(reportId);
  if (!report) throw new Error(`opportunity_report ${reportId} not found`);

  const scoredRows = opportunities.filter(
    (o) => o.report_id === reportId && o.roi_score !== null,
  );
  const scoredCount = scoredRows.length;
  const bestRoiScore =
    scoredCount > 0 ? Math.max(...scoredRows.map((o) => o.roi_score as number)) : null;

  const clearsFloor = bestRoiScore !== null && bestRoiScore >= roiFloor;
  if (report.status !== "draft" || scoredCount === 0 || clearsFloor) {
    return { reportId, agentAddress: report.agent_address, archived: false, scoredCount, bestRoiScore };
  }

  const opportunityWord = scoredCount === 1 ? "opportunity" : "opportunities";
  const note =
    `[ts] kill_condition: ${scoredCount} ${opportunityWord} scored, ` +
    `best roi_score ${bestRoiScore} did not clear the floor of ${roiFloor} — no good ideas this cycle.`;
  appendSourceSummary(reportId, note);
  setOpportunityReportStatus(reportId, "archived");

  return { reportId, agentAddress: report.agent_address, archived: true, scoredCount, bestRoiScore };
}

function sweepKillCondition(roiFloor: number = DEFAULT_ROI_FLOOR): KillConditionResult[] {
  const draftReportIds = new Set(
    opportunities
      .filter((o) => o.roi_score !== null)
      .map((o) => o.report_id)
      .filter((id) => reports.get(id)!.status === "draft"),
  );
  return [...draftReportIds]
    .map((id) => evaluateKillCondition(id, roiFloor))
    .filter((r) => r.archived);
}

// ─── 3e: evaluateKillCondition ──────────────────────────────────────────

describe("evaluateKillCondition", () => {
  test("archives a draft report whose only scored opportunity is below the floor", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, 30);

    const result = evaluateKillCondition(report.id);
    assert.equal(result.archived, true);
    assert.equal(result.scoredCount, 1);
    assert.equal(result.bestRoiScore, 30);
    assert.equal(getOpportunityReport(report.id)!.status, "archived");
  });

  test("appends a 'no good ideas' note to source_summary before archiving", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, 10);
    seedOpportunity(report, 25);

    evaluateKillCondition(report.id);
    const finalReport = getOpportunityReport(report.id)!;
    assert.match(finalReport.source_summary, /kill_condition/);
    assert.match(finalReport.source_summary, /no good ideas this cycle/);
    assert.match(finalReport.source_summary, /best roi_score 25/);
  });

  test("archives when ALL scored opportunities are below the floor, using the best of them", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, 10);
    seedOpportunity(report, 20);
    seedOpportunity(report, 49);

    const result = evaluateKillCondition(report.id, 50);
    assert.equal(result.archived, true);
    assert.equal(result.bestRoiScore, 49);
  });

  test("does NOT archive when at least one opportunity clears the floor", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, 10);
    seedOpportunity(report, 75);

    const result = evaluateKillCondition(report.id, 50);
    assert.equal(result.archived, false);
    assert.equal(result.bestRoiScore, 75);
    assert.equal(getOpportunityReport(report.id)!.status, "draft");
  });

  test("exactly-at-the-floor counts as clearing it", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, 50);

    const result = evaluateKillCondition(report.id, 50);
    assert.equal(result.archived, false);
  });

  test("a floor-clearing opportunity that's already 'selected' still protects the report", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, 90, { status: "selected" });
    seedOpportunity(report, 10); // added later, still open, below floor

    const result = evaluateKillCondition(report.id, 50);
    assert.equal(result.archived, false);
    assert.equal(result.bestRoiScore, 90);
  });

  test("a report with zero scored opportunities yet is left alone, not killed", () => {
    reset();
    const report = createReport("agent-1");
    // No score_opportunity calls at all — still mid-scan.

    const result = evaluateKillCondition(report.id);
    assert.equal(result.archived, false);
    assert.equal(result.scoredCount, 0);
    assert.equal(result.bestRoiScore, null);
    assert.equal(getOpportunityReport(report.id)!.status, "draft");
  });

  test("an unscored opportunity (roi_score null) doesn't count toward scoredCount", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, null);

    const result = evaluateKillCondition(report.id);
    assert.equal(result.scoredCount, 0);
    assert.equal(result.archived, false);
  });

  test("a report already 'scored' is left untouched, not thrown on", () => {
    reset();
    const report = createReport("agent-1", "scored");
    seedOpportunity(report, 10);

    assert.doesNotThrow(() => {
      const result = evaluateKillCondition(report.id, 50);
      assert.equal(result.archived, false);
    });
    assert.equal(getOpportunityReport(report.id)!.status, "scored");
  });

  test("a report already 'archived' is left untouched, not thrown on", () => {
    reset();
    const report = createReport("agent-1", "archived");
    seedOpportunity(report, 10);

    assert.doesNotThrow(() => {
      const result = evaluateKillCondition(report.id, 50);
      assert.equal(result.archived, false);
    });
  });

  test("a nonexistent report id throws", () => {
    reset();
    assert.throws(() => evaluateKillCondition("oppr_missing"));
  });

  test("one agent's report is never affected by another agent's low scores", () => {
    reset();
    const reportA = createReport("agent-1");
    const reportB = createReport("agent-2");
    seedOpportunity(reportA, 90);
    seedOpportunity(reportB, 10);

    evaluateKillCondition(reportA.id, 50);
    evaluateKillCondition(reportB.id, 50);

    assert.equal(getOpportunityReport(reportA.id)!.status, "draft");
    assert.equal(getOpportunityReport(reportB.id)!.status, "archived");
  });
});

// ─── 3e: sweepKillCondition ─────────────────────────────────────────────

describe("sweepKillCondition", () => {
  test("archives every eligible draft report in one pass and returns only those", () => {
    reset();
    const dead1 = createReport("agent-1");
    seedOpportunity(dead1, 15);
    const dead2 = createReport("agent-2");
    seedOpportunity(dead2, 5);
    seedOpportunity(dead2, 20);
    const alive = createReport("agent-3");
    seedOpportunity(alive, 80);

    const results = sweepKillCondition(50);
    assert.equal(results.length, 2);
    const archivedIds = new Set(results.map((r) => r.reportId));
    assert.ok(archivedIds.has(dead1.id));
    assert.ok(archivedIds.has(dead2.id));
    assert.equal(getOpportunityReport(dead1.id)!.status, "archived");
    assert.equal(getOpportunityReport(dead2.id)!.status, "archived");
    assert.equal(getOpportunityReport(alive.id)!.status, "draft");
  });

  test("skips reports with no scored opportunities and reports that aren't 'draft'", () => {
    reset();
    const stillScanning = createReport("agent-1");
    // no opportunities at all yet

    const alreadyScored = createReport("agent-2", "scored");
    seedOpportunity(alreadyScored, 5);

    const alreadyArchived = createReport("agent-3", "archived");
    seedOpportunity(alreadyArchived, 5);

    const results = sweepKillCondition(50);
    assert.equal(results.length, 0);
    assert.equal(getOpportunityReport(stillScanning.id)!.status, "draft");
    assert.equal(getOpportunityReport(alreadyScored.id)!.status, "scored");
    assert.equal(getOpportunityReport(alreadyArchived.id)!.status, "archived");
  });

  test("no eligible reports anywhere returns an empty array, not an error", () => {
    reset();
    assert.doesNotThrow(() => {
      const results = sweepKillCondition();
      assert.deepEqual(results, []);
    });
  });

  test("idempotent: running the sweep twice never double-archives or throws", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, 10);

    const first = sweepKillCondition(50);
    assert.equal(first.length, 1);

    assert.doesNotThrow(() => {
      const second = sweepKillCondition(50);
      assert.equal(second.length, 0); // no longer 'draft', so no longer eligible
    });
  });
});
