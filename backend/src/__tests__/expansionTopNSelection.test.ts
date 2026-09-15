// Zent.md Phase 3d: "Top-N selection: a scheduled job (scheduler.ts)
// that, on a cadence, marks the top-scoring open opportunity as
// status = 'scored' ... and hands it to Research — nothing below N
// (default top 4) proceeds."
//
// Inlined mirror of expansion.ts's selectTopOpenOpportunities() — same
// "no live better-sqlite3 in this environment" reason every prior
// backend/src test file in this repo already carries (see
// expansionDedup.test.ts's own header for the identical note on the
// Phase 3c logic it mirrors). scheduler.ts's own lease mechanism
// (acquire/run/release) is not re-tested here — that's
// scheduler.test.ts's job (Phase 5d); this file covers only the
// selection decision logic selectTopOpenOpportunities() wraps,
// independent of whether a lease was held to call it.
//
// What this covers:
//   3d — among an agent's 'open', scored opportunities, the single
//         highest roi_score one is selected each call.
//   3d — ties in roi_score are broken deterministically (earliest
//         created_at first, then id) — not left to query-plan-dependent
//         ordering.
//   3d — capacity gating: an agent already at `topN` selected
//         opportunities gets nothing new selected; an agent below
//         capacity gets exactly one promoted per call, not a
//         fill-to-N batch.
//   3d — scoping: an unscored ('open' with roi_score null) opportunity
//         is never selected; an opportunity under an archived report
//         is never selected; one agent's opportunities never affect
//         another agent's selection.
//   3d — idempotency across repeated calls: calling repeatedly with a
//         backlog fills capacity one at a time, never selecting the
//         same opportunity twice or exceeding `topN`.
//   3d — no eligible opportunities anywhere returns an empty array,
//         not an error.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's opportunity_reports / opportunities rows ─

type OpportunityStatus = "open" | "selected" | "rejected";

interface FakeReport {
  id: string;
  agent_address: string;
  status: "draft" | "scored" | "archived";
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  created_at: number;
  title: string;
  roi_score: number | null;
  status: OpportunityStatus;
  selected_at: number | null;
}

let reports: Map<string, FakeReport>;
let opportunities: FakeOpportunity[];
let nextId: number;

function resetState() {
  reports = new Map();
  opportunities = [];
  nextId = 1;
}

function createReport(agentAddress: string, status: FakeReport["status"] = "draft"): FakeReport {
  const report: FakeReport = { id: `oppr_${nextId++}`, agent_address: agentAddress, status };
  reports.set(report.id, report);
  return report;
}

function seedOpportunity(
  report: FakeReport,
  title: string,
  roiScore: number | null,
  opts: { createdAt?: number; status?: OpportunityStatus } = {},
): FakeOpportunity {
  const opp: FakeOpportunity = {
    id: `opp_${nextId++}`,
    report_id: report.id,
    created_at: opts.createdAt ?? Date.now(),
    title,
    roi_score: roiScore,
    status: opts.status ?? "open",
    selected_at: null,
  };
  opportunities.push(opp);
  return opp;
}

// ─── Mirror of expansion.ts's Phase 3d selectTopOpenOpportunities() ───

interface TopNSelection {
  agentAddress: string;
  opportunityId: string;
  title: string;
  roiScore: number;
}

const DEFAULT_TOP_N = 4;

function selectTopOpenOpportunities(topN: number = DEFAULT_TOP_N): TopNSelection[] {
  const now = Date.now();

  const agentAddresses = new Set<string>();
  for (const o of opportunities) {
    if (o.status !== "open" || o.roi_score === null) continue;
    const report = reports.get(o.report_id)!;
    if (report.status === "archived") continue;
    agentAddresses.add(report.agent_address);
  }

  const selections: TopNSelection[] = [];

  for (const agentAddress of agentAddresses) {
    const selectedCount = opportunities.filter((o) => {
      const report = reports.get(o.report_id)!;
      return report.agent_address === agentAddress && o.status === "selected";
    }).length;
    if (selectedCount >= topN) continue;

    const eligible = opportunities.filter((o) => {
      if (o.status !== "open" || o.roi_score === null) return false;
      const report = reports.get(o.report_id)!;
      return report.agent_address === agentAddress && report.status !== "archived";
    });
    if (eligible.length === 0) continue;

    eligible.sort((a, b) => {
      if (b.roi_score! !== a.roi_score!) return b.roi_score! - a.roi_score!;
      if (a.created_at !== b.created_at) return a.created_at - b.created_at;
      return a.id.localeCompare(b.id);
    });
    const top = eligible[0];

    top.status = "selected";
    top.selected_at = now;
    selections.push({
      agentAddress,
      opportunityId: top.id,
      title: top.title,
      roiScore: top.roi_score as number,
    });
  }

  return selections;
}

// ─── 3d: selectTopOpenOpportunities ────────────────────────────────────

describe("selectTopOpenOpportunities", () => {
  test("selects the single highest-scoring open opportunity for an agent", () => {
    resetState();
    const report = createReport("agent-1");
    seedOpportunity(report, "Low", 40);
    const high = seedOpportunity(report, "High", 90);
    seedOpportunity(report, "Mid", 65);

    const selections = selectTopOpenOpportunities();
    assert.equal(selections.length, 1);
    assert.equal(selections[0].opportunityId, high.id);
    assert.equal(selections[0].roiScore, 90);
  });

  test("breaks a roi_score tie by earliest created_at", () => {
    resetState();
    const report = createReport("agent-1");
    const older = seedOpportunity(report, "Older tie", 75, { createdAt: 1000 });
    seedOpportunity(report, "Newer tie", 75, { createdAt: 2000 });

    const selections = selectTopOpenOpportunities();
    assert.equal(selections.length, 1);
    assert.equal(selections[0].opportunityId, older.id);
  });

  test("promotes exactly one opportunity per call, not a fill-to-N batch", () => {
    resetState();
    const report = createReport("agent-1");
    seedOpportunity(report, "A", 90);
    seedOpportunity(report, "B", 85);
    seedOpportunity(report, "C", 80);
    seedOpportunity(report, "D", 75);
    seedOpportunity(report, "E", 70);

    const first = selectTopOpenOpportunities(4);
    assert.equal(first.length, 1);
    assert.equal(
      opportunities.filter((o) => o.status === "selected").length,
      1,
      "only one opportunity should be selected after one call",
    );
  });

  test("repeated calls fill capacity one at a time up to topN, then stop", () => {
    resetState();
    const report = createReport("agent-1");
    for (let i = 0; i < 6; i++) {
      seedOpportunity(report, `Idea ${i}`, 50 + i, { createdAt: 1000 + i });
    }

    const topN = 4;
    const allSelections: TopNSelection[] = [];
    for (let i = 0; i < 6; i++) {
      allSelections.push(...selectTopOpenOpportunities(topN));
    }

    assert.equal(allSelections.length, topN, "no more than topN opportunities ever get selected");
    assert.equal(opportunities.filter((o) => o.status === "selected").length, topN);
    // The 4 selected should be the 4 highest-scored ones (scores 55,54,53,52).
    const selectedTitles = opportunities.filter((o) => o.status === "selected").map((o) => o.title);
    assert.deepEqual(new Set(selectedTitles), new Set(["Idea 5", "Idea 4", "Idea 3", "Idea 2"]));
    // Never selects the same opportunity twice.
    const ids = allSelections.map((s) => s.opportunityId);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("an agent already at capacity gets nothing new selected", () => {
    resetState();
    const report = createReport("agent-1");
    for (let i = 0; i < 4; i++) {
      seedOpportunity(report, `Selected ${i}`, 90, { status: "selected" });
    }
    seedOpportunity(report, "Waiting", 99); // higher score, but agent is already at capacity

    const selections = selectTopOpenOpportunities(4);
    assert.equal(selections.length, 0);
  });

  test("an unscored opportunity (roi_score null) is never selected", () => {
    resetState();
    const report = createReport("agent-1");
    seedOpportunity(report, "Unscored", null);

    const selections = selectTopOpenOpportunities();
    assert.equal(selections.length, 0);
  });

  test("an opportunity under an archived report is never selected", () => {
    resetState();
    const report = createReport("agent-1", "archived");
    seedOpportunity(report, "Archived idea", 95);

    const selections = selectTopOpenOpportunities();
    assert.equal(selections.length, 0);
  });

  test("one agent's opportunities never affect another agent's selection", () => {
    resetState();
    const reportA = createReport("agent-1");
    const reportB = createReport("agent-2");
    seedOpportunity(reportA, "A's idea", 60);
    const bIdea = seedOpportunity(reportB, "B's idea", 99);

    const selections = selectTopOpenOpportunities();
    assert.equal(selections.length, 2);
    const byAgent = new Map(selections.map((s) => [s.agentAddress, s]));
    assert.equal(byAgent.get("agent-2")!.opportunityId, bIdea.id);
    assert.equal(byAgent.get("agent-1")!.roiScore, 60);
  });

  test("no eligible opportunities anywhere returns an empty array, not an error", () => {
    resetState();
    assert.doesNotThrow(() => {
      const selections = selectTopOpenOpportunities();
      assert.deepEqual(selections, []);
    });
  });

  test("sets selected_at on the promoted row", () => {
    resetState();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80);
    assert.equal(opp.selected_at, null);

    selectTopOpenOpportunities();
    assert.notEqual(opp.selected_at, null);
    assert.equal(opp.status, "selected");
  });
});
