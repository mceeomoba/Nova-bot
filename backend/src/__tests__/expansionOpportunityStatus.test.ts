// Zent.md Phase 4c: "Promote/demote/reject remains an agent-only
// action: Opportunity Intelligence (or the top-level agent acting on
// its own report) can re-rank or drop an opportunity before Research
// picks it up — no external operator step in this path."
//
// Inlined mirror of expansion.ts's setOpportunityStatus()/
// OPPORTUNITY_TRANSITIONS and of expansionRoutes.ts's
// POST /opportunities/:id/status (id-shape check, action-name check,
// ownership check, then the transition itself) — same "no live
// better-sqlite3 / no live express server in this environment" reason
// every prior backend/src test file in this repo already carries (see
// expansionOpportunityDetail.test.ts's own header for the identical
// note on the Phase 4b logic it mirrors).
//
// What this covers:
//   4c — promote: open -> selected, sets selected_at.
//   4c — promote is idempotent when already selected.
//   4c — promote fails against an archived report.
//   4c — promote fails once the agent is at its topN selected cap.
//   4c — demote: selected -> open, clears selected_at.
//   4c — demote is idempotent when already open.
//   4c — reject: open or selected -> rejected, from either state.
//   4c — reject is idempotent when already rejected.
//   4c — rejected is terminal: promote/demote after reject both fail.
//   4c — an unknown opportunity id fails (not found).
//   4c — the route: unknown action name 400s before any lookup.
//   4c — the route: non-opp_ id 400s.
//   4c — the route: unknown opportunity id 404s.
//   4c — the route: agentAddress that doesn't own the opportunity 403s.
//   4c — the route: a valid owner promoting their own opportunity 200s.
//   4c — the route: an invalid transition (e.g. promoting a rejected
//        opportunity) 409s rather than 500ing.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's opportunity_reports / opportunities rows ─

type OpportunityReportStatus = "draft" | "scored" | "archived";
type OpportunityStatus = "open" | "selected" | "rejected";
type OpportunityAction = "promote" | "demote" | "reject";

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
  selected_at: number | null;
}

let reports: Map<string, FakeReport>;
let opportunities: Map<string, FakeOpportunity>;
let seq: number;

// Same default config.ts actually ships (EXPANSION_TOP_N_OPEN_OPPORTUNITIES).
const TOP_N = 4;

function reset() {
  reports = new Map();
  opportunities = new Map();
  seq = 0;
}

function createReport(
  agentAddress: string,
  opts: { status?: OpportunityReportStatus } = {},
): FakeReport {
  const row: FakeReport = {
    id: `oppr_${++seq}`,
    agent_address: agentAddress,
    status: opts.status ?? "draft",
  };
  reports.set(row.id, row);
  return row;
}

function seedOpportunity(
  report: FakeReport,
  title: string,
  roiScore: number | null,
  opts: { status?: OpportunityStatus } = {},
): FakeOpportunity {
  const opp: FakeOpportunity = {
    id: `opp_${++seq}`,
    report_id: report.id,
    created_at: Date.now(),
    title,
    thesis: "thesis",
    roi_score: roiScore,
    status: opts.status ?? "open",
    selected_at: opts.status === "selected" ? Date.now() : null,
  };
  opportunities.set(opp.id, opp);
  return opp;
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function getOpportunityReport(id: string): FakeReport | undefined {
  return reports.get(id);
}

// ─── Mirror of expansion.ts's Phase 4c setOpportunityStatus() ──────────

const ACTION_TARGET_STATUS: Record<OpportunityAction, OpportunityStatus> = {
  promote: "selected",
  demote: "open",
  reject: "rejected",
};

const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  open: ["selected", "rejected"],
  selected: ["open", "rejected"],
  rejected: [],
};

function setOpportunityStatus(
  id: string,
  action: OpportunityAction,
  options: { topN?: number } = {},
): FakeOpportunity {
  const existing = getOpportunity(id);
  if (!existing) {
    throw new Error(`opportunity ${id} not found`);
  }

  const target = ACTION_TARGET_STATUS[action];
  if (existing.status === target) {
    return existing;
  }
  if (!OPPORTUNITY_TRANSITIONS[existing.status].includes(target)) {
    throw new Error(`cannot ${action} opportunity ${id} from status '${existing.status}'`);
  }

  if (action === "promote") {
    const report = getOpportunityReport(existing.report_id)!;
    if (report.status === "archived") {
      throw new Error(
        `opportunity_report ${existing.report_id} is archived — cannot promote an opportunity out of an archived report`,
      );
    }
    const topN = options.topN ?? TOP_N;
    const selectedCount = [...opportunities.values()].filter((o) => {
      const r = reports.get(o.report_id)!;
      return r.agent_address === report.agent_address && o.status === "selected";
    }).length;
    if (selectedCount >= topN) {
      throw new Error(
        `agent ${report.agent_address} already has ${selectedCount} selected opportunities (cap ${topN}) — demote or reject one first`,
      );
    }
  }

  existing.status = target;
  existing.selected_at = target === "selected" ? Date.now() : null;
  return existing;
}

// ─── Mirror of expansionRoutes.ts's POST /opportunities/:id/status ─────

function looksLikeOpportunityId(value: string): boolean {
  return value.startsWith("opp_");
}

const VALID_OPPORTUNITY_ACTIONS: OpportunityAction[] = ["promote", "demote", "reject"];

function handleStatusRoute(
  id: string | undefined,
  agentAddress: unknown,
  action: unknown,
): { httpStatus: number; body: any } {
  try {
    if (!id || !looksLikeOpportunityId(id)) {
      return { httpStatus: 400, body: { error: `${id ?? ""} is not a valid opportunity id` } };
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return { httpStatus: 400, body: { error: "agentAddress is required" } };
    }
    if (typeof action !== "string" || !VALID_OPPORTUNITY_ACTIONS.includes(action as OpportunityAction)) {
      return {
        httpStatus: 400,
        body: { error: `action must be one of: ${VALID_OPPORTUNITY_ACTIONS.join(", ")}` },
      };
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return { httpStatus: 404, body: { error: `opportunity ${id} not found` } };
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return {
        httpStatus: 500,
        body: { error: `opportunity_report ${opportunity.report_id} not found` },
      };
    }
    if (report.agent_address !== agentAddress) {
      return { httpStatus: 403, body: { error: "agentAddress does not own this opportunity" } };
    }

    let updated: FakeOpportunity;
    try {
      updated = setOpportunityStatus(id, action as OpportunityAction);
    } catch (err: any) {
      return { httpStatus: 409, body: { error: err.message || "invalid status transition" } };
    }

    return { httpStatus: 200, body: { opportunity: updated } };
  } catch (err: any) {
    return { httpStatus: 500, body: { error: err.message || "internal_error" } };
  }
}

// ─── 4c: setOpportunityStatus (data layer) ─────────────────────────────

describe("setOpportunityStatus", () => {
  test("promote: open -> selected, sets selected_at", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80);

    const updated = setOpportunityStatus(opp.id, "promote");
    assert.equal(updated.status, "selected");
    assert.ok(updated.selected_at !== null);
  });

  test("promote is idempotent when already selected", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80, { status: "selected" });
    const before = opp.selected_at;

    const updated = setOpportunityStatus(opp.id, "promote");
    assert.equal(updated.status, "selected");
    assert.equal(updated.selected_at, before);
  });

  test("promote fails against an archived report", () => {
    reset();
    const report = createReport("agent-1", { status: "archived" });
    const opp = seedOpportunity(report, "Idea", 80);

    assert.throws(() => setOpportunityStatus(opp.id, "promote"), /archived/);
  });

  test("promote fails once the agent is at its topN selected cap", () => {
    reset();
    const report = createReport("agent-1");
    for (let i = 0; i < TOP_N; i++) {
      seedOpportunity(report, `Selected ${i}`, 80, { status: "selected" });
    }
    const candidate = seedOpportunity(report, "One too many", 90);

    assert.throws(() => setOpportunityStatus(candidate.id, "promote"), /cap/);
  });

  test("promote respects a custom topN override", () => {
    reset();
    const report = createReport("agent-1");
    seedOpportunity(report, "Selected 0", 80, { status: "selected" });
    const candidate = seedOpportunity(report, "Second", 90);

    assert.throws(() => setOpportunityStatus(candidate.id, "promote", { topN: 1 }), /cap/);
  });

  test("demote: selected -> open, clears selected_at", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80, { status: "selected" });

    const updated = setOpportunityStatus(opp.id, "demote");
    assert.equal(updated.status, "open");
    assert.equal(updated.selected_at, null);
  });

  test("demote is idempotent when already open", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80);

    const updated = setOpportunityStatus(opp.id, "demote");
    assert.equal(updated.status, "open");
  });

  test("demote succeeds even under an archived report", () => {
    reset();
    const report = createReport("agent-1", { status: "archived" });
    const opp = seedOpportunity(report, "Idea", 80, { status: "selected" });

    const updated = setOpportunityStatus(opp.id, "demote");
    assert.equal(updated.status, "open");
  });

  test("reject: from open", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80);

    const updated = setOpportunityStatus(opp.id, "reject");
    assert.equal(updated.status, "rejected");
  });

  test("reject: from selected", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80, { status: "selected" });

    const updated = setOpportunityStatus(opp.id, "reject");
    assert.equal(updated.status, "rejected");
    assert.equal(updated.selected_at, null);
  });

  test("reject is idempotent when already rejected", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80, { status: "rejected" });

    const updated = setOpportunityStatus(opp.id, "reject");
    assert.equal(updated.status, "rejected");
  });

  test("rejected is terminal: promote after reject fails", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80, { status: "rejected" });

    assert.throws(() => setOpportunityStatus(opp.id, "promote"), /cannot promote/);
  });

  test("rejected is terminal: demote after reject fails", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80, { status: "rejected" });

    assert.throws(() => setOpportunityStatus(opp.id, "demote"), /cannot demote/);
  });

  test("an unknown opportunity id fails", () => {
    reset();
    assert.throws(() => setOpportunityStatus("opp_does_not_exist", "promote"), /not found/);
  });
});

// ─── 4c: POST /expansion/opportunities/:id/status (route layer) ───────

describe("POST /expansion/opportunities/:id/status", () => {
  test("unknown action name 400s before any lookup", () => {
    reset();
    const result = handleStatusRoute("opp_whatever", "agent-1", "delete");
    assert.equal(result.httpStatus, 400);
  });

  test("non-opp_ id 400s", () => {
    reset();
    const result = handleStatusRoute("0xAbC1230000000000000000000000000000dEaD", "agent-1", "promote");
    assert.equal(result.httpStatus, 400);
  });

  test("missing agentAddress 400s", () => {
    reset();
    const result = handleStatusRoute("opp_whatever", undefined, "promote");
    assert.equal(result.httpStatus, 400);
  });

  test("unknown opportunity id 404s", () => {
    reset();
    const result = handleStatusRoute("opp_nonexistent", "agent-1", "promote");
    assert.equal(result.httpStatus, 404);
  });

  test("agentAddress that doesn't own the opportunity 403s", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80);

    const result = handleStatusRoute(opp.id, "agent-2", "promote");
    assert.equal(result.httpStatus, 403);
  });

  test("a valid owner promoting their own opportunity 200s", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80);

    const result = handleStatusRoute(opp.id, "agent-1", "promote");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.opportunity.status, "selected");
  });

  test("an invalid transition 409s rather than 500ing", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80, { status: "rejected" });

    const result = handleStatusRoute(opp.id, "agent-1", "promote");
    assert.equal(result.httpStatus, 409);
  });

  test("promoting past the topN cap 409s via the route too", () => {
    reset();
    const report = createReport("agent-1");
    for (let i = 0; i < TOP_N; i++) {
      seedOpportunity(report, `Selected ${i}`, 80, { status: "selected" });
    }
    const candidate = seedOpportunity(report, "One too many", 90);

    const result = handleStatusRoute(candidate.id, "agent-1", "promote");
    assert.equal(result.httpStatus, 409);
  });
});
