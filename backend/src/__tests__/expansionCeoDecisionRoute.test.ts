// Zent.md Phase 15b: "POST /expansion/opportunities/:id/decide — writes
// expansion_decisions, requires the calling agent_address to match the
// top-level agent that owns the whole pipeline (no other agent can
// approve another's expansion)."
//
// This file is the route-level counterpart to expansionCeoDecision.test.ts
// (15a): exercising POST .../opportunities/:id/decide itself (bad-id /
// missing-field / invalid-decision / ownership / not-found / gate
// failures / happy path), the same way expansionVoteRoutes.test.ts
// (14b/14c/14d) is the route-level counterpart to
// expansionDeliberation.test.ts's own function-level mirror.
//
// Same "no live better-sqlite3/express in this environment" reason
// every other expansion*.test.ts file in this directory gives — this is
// an inlined mirror of the real POST .../decide handler's own logic
// (expansionRoutes.ts) plus the minimum of 13e/14a/14d/15a it composes,
// exercised against plain in-memory data and a fake Express response
// object. Recommend re-running against the real expansionRoutes.ts/
// expansion.ts (e.g. supertest against the mounted router) once a
// networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Minimal in-memory stand-ins, same shape this directory's other
//     route-level test files already use ───────────────────────────────

interface FakeOpportunity {
  id: string;
  report_id: string;
  selected_at: number | null;
  status: "open" | "selected" | "rejected";
}

interface FakeReport {
  id: string;
  agent_address: string;
}

let opportunities: Map<string, FakeOpportunity>;
let reports: Map<string, FakeReport>;
let filedReports: { research: Set<string>; finance: Set<string>; strategy: Set<string> };
let deliberationEnabled: Set<string>;
let deliberationResponses: Map<string, Set<Dept>>;
let votes: Map<string, Map<VoteDept, Vote>>;
let decisions: Map<string, DecisionRow[]>;
let oppSeq: number;
let decisionSeq: number;

type Dept = "research" | "finance" | "strategy";
const DEPTS: readonly Dept[] = ["research", "finance", "strategy"];
type VoteDept = "opportunity_intelligence" | "research" | "finance" | "strategy";
type Vote = "recommend" | "recommend-with-conditions" | "do-not-recommend";
const VOTE_DEPTS: readonly VoteDept[] = ["opportunity_intelligence", "research", "finance", "strategy"];
const VOTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type CeoDecision = "approved" | "rejected" | "deferred";
const CEO_DECISIONS: readonly CeoDecision[] = ["approved", "rejected", "deferred"];
function isValidCeoDecision(value: unknown): value is CeoDecision {
  return typeof value === "string" && (CEO_DECISIONS as readonly string[]).includes(value);
}

interface DecisionRow {
  id: string;
  opportunityId: string;
  ceoDecision: CeoDecision;
  decidedBy: string;
  notes: string | null;
}

function reset() {
  opportunities = new Map();
  reports = new Map();
  filedReports = { research: new Set(), finance: new Set(), strategy: new Set() };
  deliberationEnabled = new Set();
  deliberationResponses = new Map();
  votes = new Map();
  decisions = new Map();
  oppSeq = 0;
  decisionSeq = 0;
}

/** Seeds an opportunity with a "fully decidable" packet by default
 *  (all three reports filed, deliberation off, all four departments
 *  voted) — individual tests knock out exactly the piece they're
 *  testing, same "start from the happy path, subtract one thing"
 *  convention expansionVoteRoutes.test.ts's own seedOpportunity() uses. */
function seedDecidableOpportunity(
  overrides: Partial<{ agentAddress: string; selectedAt: number | null }> = {},
): FakeOpportunity {
  const reportId = `rep_${++oppSeq}`;
  reports.set(reportId, { id: reportId, agent_address: overrides.agentAddress ?? "agent_a" });
  const o: FakeOpportunity = {
    id: `opp_${oppSeq}`,
    report_id: reportId,
    selected_at: overrides.selectedAt === undefined ? Date.now() - 1000 : overrides.selectedAt,
    status: "selected",
  };
  opportunities.set(o.id, o);
  filedReports.research.add(o.id);
  filedReports.finance.add(o.id);
  filedReports.strategy.add(o.id);
  for (const d of VOTE_DEPTS) castVote(o.id, d, "recommend");
  return o;
}

function castVote(id: string, dept: VoteDept, vote: Vote) {
  if (!votes.has(id)) votes.set(id, new Map());
  votes.get(id)!.set(dept, vote);
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function getOpportunityReport(reportId: string): FakeReport | undefined {
  return reports.get(reportId);
}

function looksLikeOpportunityId(value: string): boolean {
  return value.startsWith("opp_");
}

// ─── Mirrors of expansion.ts's requireDecidableCommitteePacket()/
//     decideExpansion() (15a) — same mirror expansionCeoDecision.test.ts
//     already uses, kept here so this file's route mirror has something
//     real underneath it ────────────────────────────────────────────────

function requireDecidableCommitteePacket(id: string) {
  const o = opportunities.get(id);
  if (!o) throw new Error(`opportunity ${id} not found`);
  const missing = DEPTS.filter((d) => !filedReports[d].has(id));
  if (missing.length > 0) {
    throw new Error(
      `committee packet for opportunity ${id} is not ready for a decision — missing report(s): ${missing.join(", ")}`,
    );
  }
  if (deliberationEnabled.has(id)) {
    const responded = deliberationResponses.get(id) ?? new Set<Dept>();
    const missingDelib = DEPTS.filter((d) => !responded.has(d));
    if (missingDelib.length > 0) {
      throw new Error(
        `committee packet for opportunity ${id} has not locked — awaiting deliberation from: ${missingDelib.join(", ")}`,
      );
    }
  }
  const cast = votes.get(id) ?? new Map<VoteDept, Vote>();
  const deadlineAt = o.selected_at === null ? null : o.selected_at + VOTE_TIMEOUT_MS;
  const timedOut = deadlineAt !== null && Date.now() > deadlineAt;
  const pending = VOTE_DEPTS.filter((d) => !cast.has(d) && !timedOut);
  if (pending.length > 0) {
    throw new Error(
      `committee packet for opportunity ${id} is not ready for a decision — still awaiting a vote (or timeout) from: ${pending.join(", ")}`,
    );
  }
  return o;
}

// Phase 15c mirror: same two terminal values expansion.ts's own
// CEO_TERMINAL_DECISIONS/isTerminalCeoDecision() pairing exports.
const CEO_TERMINAL_DECISIONS: CeoDecision[] = ["approved", "rejected"];
function isTerminalCeoDecision(d: CeoDecision): boolean {
  return CEO_TERMINAL_DECISIONS.includes(d);
}

function decideExpansion(
  opportunityId: string,
  decision: CeoDecision,
  decidedBy: string,
  notes: string | null = null,
): DecisionRow {
  // Phase 15c finality gate, checked before the packet-readiness gate —
  // same order the real decideExpansion() uses.
  const priorHistory = decisions.get(opportunityId);
  const prior = priorHistory && priorHistory.length > 0 ? priorHistory[priorHistory.length - 1] : undefined;
  if (prior && isTerminalCeoDecision(prior.ceoDecision)) {
    throw new Error(
      `opportunity ${opportunityId} already has a final CEO ruling (${prior.ceoDecision}) — decide_expansion cannot rule on it again`,
    );
  }
  requireDecidableCommitteePacket(opportunityId);
  const trimmed = typeof notes === "string" ? notes.trim() : "";
  const row: DecisionRow = {
    id: `xdec_${++decisionSeq}`,
    opportunityId,
    ceoDecision: decision,
    decidedBy,
    notes: trimmed ? trimmed : null,
  };
  if (!decisions.has(opportunityId)) decisions.set(opportunityId, []);
  decisions.get(opportunityId)!.push(row);
  if (decision === "rejected") {
    const o = opportunities.get(opportunityId);
    if (o) o.status = "rejected";
  }
  return row;
}

// ─── Mirror of a fake Express response, same shape every other
//     route-level test file in this directory already uses ─────────────

interface FakeResponse {
  statusCode: number;
  body: unknown;
  status(code: number): FakeResponse;
  json(body: unknown): void;
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
    },
  };
  return res;
}

// ─── Mirror of expansionRoutes.ts's POST /opportunities/:id/decide (15b) ─
//
// Matches the real handler field-for-field: pre-validates decision/notes
// into named 400s, enforces the report.agent_address === agentAddress
// ownership chain into a 403 (Zent.md 15b's own "no other agent can
// approve another's expansion"), and maps a gate failure from
// decideExpansion() (13e/14a/14d, composed by 15a) into a 409 rather
// than letting it surface as an opaque 500.

function handlePostDecide(id: string, body: any, res: FakeResponse) {
  try {
    const { agentAddress, decision, notes } = body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (!isValidCeoDecision(decision)) {
      return res.status(400).json({ error: `decision must be one of: ${CEO_DECISIONS.join(", ")}` });
    }
    if (notes !== undefined && notes !== null && typeof notes !== "string") {
      return res.status(400).json({ error: "notes must be a string when provided" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res
        .status(403)
        .json({ error: "agentAddress does not own this opportunity's expansion pipeline" });
    }

    let result: DecisionRow;
    try {
      result = decideExpansion(id, decision, agentAddress, notes ?? null);
    } catch (err: any) {
      return res.status(409).json({ error: err.message || "committee packet is not ready for a decision" });
    }

    res.json({ opportunityId: id, decision: result });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "internal_error" });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("15b: rejects a malformed opportunity id before touching any data", () => {
  reset();
  const res = fakeRes();
  handlePostDecide("not-an-id", { agentAddress: "agent_a", decision: "approved" }, res);
  assert.equal(res.statusCode, 400);
});

test("15b: requires agentAddress", () => {
  reset();
  const o = seedDecidableOpportunity();
  const res = fakeRes();
  handlePostDecide(o.id, { decision: "approved" }, res);
  assert.equal(res.statusCode, 400);
  assert.match((res.body as any).error, /agentAddress is required/);
});

test("15b: rejects an invalid decision value with a named 400, not a 500", () => {
  reset();
  const o = seedDecidableOpportunity();
  const res = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "maybe" }, res);
  assert.equal(res.statusCode, 400);
  assert.match((res.body as any).error, /decision must be one of/);
});

test("15b: rejects a non-string notes with a named 400", () => {
  reset();
  const o = seedDecidableOpportunity();
  const res = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "approved", notes: 12345 }, res);
  assert.equal(res.statusCode, 400);
  assert.match((res.body as any).error, /notes must be a string/);
});

test("15b: 404s for an unknown (but well-formed) opportunity id", () => {
  reset();
  const res = fakeRes();
  handlePostDecide("opp_999", { agentAddress: "agent_a", decision: "approved" }, res);
  assert.equal(res.statusCode, 404);
});

test("15b: 403s when the calling agent does not own this opportunity's pipeline — no other agent can approve another's expansion", () => {
  reset();
  const o = seedDecidableOpportunity({ agentAddress: "agent_a" });
  const res = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_b", decision: "approved" }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(decisions.get(o.id), undefined, "no decision was recorded for the rejected caller");
});

test("15b: 409s (not 500) when the committee packet isn't ready — named gate failure surfaces cleanly", () => {
  reset();
  const o = seedDecidableOpportunity();
  filedReports.strategy.delete(o.id); // knock out one report
  const res = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "approved" }, res);
  assert.equal(res.statusCode, 409);
  assert.match((res.body as any).error, /missing report\(s\): strategy/);
});

test("15b: happy path — the owning agent's approved ruling is recorded and returned", () => {
  reset();
  const o = seedDecidableOpportunity({ agentAddress: "agent_a" });
  const res = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "approved", notes: "clears the bar" }, res);
  assert.equal(res.statusCode, 200);
  const body = res.body as any;
  assert.equal(body.decision.ceoDecision, "approved");
  assert.equal(body.decision.decidedBy, "agent_a");
  assert.equal(body.decision.notes, "clears the bar");
  assert.equal(decisions.get(o.id)!.length, 1);
});

test("15b: a deferred ruling by the owning agent is recorded just like approved/rejected", () => {
  reset();
  const o = seedDecidableOpportunity({ agentAddress: "agent_a" });
  const res = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "deferred" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal((res.body as any).decision.ceoDecision, "deferred");
});

// ─── Phase 15c: approved / rejected / deferred handling, at the route ───

test("15c: 409s (not 500) when the owning agent tries to re-decide an already-approved opportunity", () => {
  reset();
  const o = seedDecidableOpportunity({ agentAddress: "agent_a" });
  const first = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "approved" }, first);
  assert.equal(first.statusCode, 200);

  const second = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "rejected" }, second);
  assert.equal(second.statusCode, 409);
  assert.match((second.body as any).error, /already has a final CEO ruling \(approved/);
  assert.equal(decisions.get(o.id)!.length, 1, "the refused second ruling was never recorded");
});

test("15c: a rejected ruling flips the opportunity to status 'rejected'", () => {
  reset();
  const o = seedDecidableOpportunity({ agentAddress: "agent_a" });
  assert.equal(o.status, "selected");
  const res = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "rejected" }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(o.status, "rejected");
});

test("15c: deferred keeps the opportunity re-decidable through the route across multiple ticks", () => {
  reset();
  const o = seedDecidableOpportunity({ agentAddress: "agent_a" });
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "deferred" }, fakeRes());
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "deferred" }, fakeRes());
  const final = fakeRes();
  handlePostDecide(o.id, { agentAddress: "agent_a", decision: "approved" }, final);
  assert.equal(final.statusCode, 200);
  assert.equal(decisions.get(o.id)!.length, 3);
  assert.equal(o.status, "selected", "approved doesn't touch status — that's Phase 16's job");
});
