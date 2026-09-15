// Zent.md Phase 15a: "CEO role clarified in code as the top-level agent
// itself (not a new department) acting on a specific tool call,
// decide_expansion(opportunity_id, decision, notes) — the CEO does not
// invent opportunities, only rules on packets, matching the chat spec
// exactly."
//
// Also covers Phase 15c: "approved / rejected / deferred handling:
// deferred re-queues for a later CEO tick without re-running the
// departments (cheap re-review, not a full re-run)." — see the finality
// gate in decideExpansion() below and the "Phase 15c" tests at the end
// of this file.
//
// Also covers Phase 15d: "approved fires genesis (Phase 16) directly —
// no operator gate between decision and provisioning; the CEO agent's
// call is final." — see the genesisTriggers mirror + fireGenesisTrigger()
// below and the "Phase 15d" tests at the end of this file.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this is an
// inlined mirror of requireDecidableCommitteePacket()/decideExpansion()
// from expansion.ts (plus the minimum of 13e/14a/14d's own gates they
// compose) exercised against plain in-memory maps standing in for
// research_findings/finance_findings/strategy_findings,
// expansion_pipeline_config, deliberation_responses, department_votes,
// and expansion_decisions. Recommend re-running against the real
// expansion.ts once a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Minimal opportunity + three-report completeness (13e) ─────────────

type OpportunityStatus = "open" | "selected" | "rejected";

interface Opportunity {
  id: string;
  status: OpportunityStatus;
  selectedAt: number | null;
}

let opportunities: Map<string, Opportunity>;
let reports: { research: Set<string>; finance: Set<string>; strategy: Set<string> };
let deliberationEnabled: Set<string>; // opportunityId, standing in for per-agent config
let deliberationResponses: Map<string, Set<Dept>>; // opportunityId -> departments that responded
let votes: Map<string, Map<VoteDept, Vote>>; // opportunityId -> department -> vote
let decisions: Map<string, Decision[]>; // opportunityId -> history, most-recent-last
let decisionSeq: number;

const VOTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function reset() {
  opportunities = new Map();
  reports = { research: new Set(), finance: new Set(), strategy: new Set() };
  deliberationEnabled = new Set();
  deliberationResponses = new Map();
  votes = new Map();
  decisions = new Map();
  decisionSeq = 0;
  resetGenesis();
}

function makeOpportunity(id: string, selectedAt: number | null = Date.now() - 1000): Opportunity {
  const o: Opportunity = { id, status: "selected", selectedAt };
  opportunities.set(id, o);
  return o;
}

function fileAllThreeReports(id: string) {
  reports.research.add(id);
  reports.finance.add(id);
  reports.strategy.add(id);
}

// ─── 14a mirror: deliberation lock ──────────────────────────────────────

type Dept = "research" | "finance" | "strategy";
const DEPTS: readonly Dept[] = ["research", "finance", "strategy"];

function respondToDeliberation(id: string, dept: Dept) {
  if (!deliberationResponses.has(id)) deliberationResponses.set(id, new Set());
  deliberationResponses.get(id)!.add(dept);
}

function isDeliberationLocked(id: string): { locked: boolean; missing: Dept[] } {
  const enabled = deliberationEnabled.has(id);
  if (!enabled) return { locked: true, missing: [] };
  const responded = deliberationResponses.get(id) ?? new Set<Dept>();
  const missing = DEPTS.filter((d) => !responded.has(d));
  return { locked: missing.length === 0, missing };
}

// ─── 14b/14c/14d mirror: votes + timeout ────────────────────────────────

type VoteDept = "opportunity_intelligence" | "research" | "finance" | "strategy";
type Vote = "recommend" | "recommend-with-conditions" | "do-not-recommend";
const VOTE_DEPTS: readonly VoteDept[] = ["opportunity_intelligence", "research", "finance", "strategy"];

function castVote(id: string, dept: VoteDept, vote: Vote) {
  if (!votes.has(id)) votes.set(id, new Map());
  votes.get(id)!.set(dept, vote);
}

interface VotingRecord {
  readyForDecision: boolean;
  pendingDepartments: VoteDept[];
}

function getVotingRecord(o: Opportunity, now: number = Date.now()): VotingRecord {
  const cast = votes.get(o.id) ?? new Map<VoteDept, Vote>();
  const deadlineAt = o.selectedAt === null ? null : o.selectedAt + VOTE_TIMEOUT_MS;
  const timedOut = deadlineAt !== null && now > deadlineAt;
  const pendingDepartments = VOTE_DEPTS.filter((d) => !cast.has(d) && !timedOut);
  return { readyForDecision: pendingDepartments.length === 0, pendingDepartments };
}

// ─── 1d mirror: expansion_decisions ─────────────────────────────────────

type CeoDecision = "approved" | "rejected" | "deferred";
const VALID_DECISIONS: CeoDecision[] = ["approved", "rejected", "deferred"];
// Phase 15c mirror: the two rulings that close an opportunity's decision
// layer for good — same CEO_TERMINAL_DECISIONS/isTerminalCeoDecision()
// pairing expansion.ts itself exports alongside CEO_DECISIONS.
const CEO_TERMINAL_DECISIONS: CeoDecision[] = ["approved", "rejected"];
function isTerminalCeoDecision(d: CeoDecision): boolean {
  return CEO_TERMINAL_DECISIONS.includes(d);
}

interface Decision {
  id: string;
  opportunityId: string;
  ceoDecision: CeoDecision;
  decidedBy: string;
  decidedAt: number;
  snapshot: {
    notes: string | null;
    complete: boolean;
    locked: boolean;
    votingRecord: VotingRecord;
  };
  // Phase 15d: non-null only for an `approved` ruling.
  genesisTrigger: GenesisTrigger | null;
}

function recordExpansionDecision(
  opportunityId: string,
  ceoDecision: CeoDecision,
  decidedBy: string,
  snapshot: Decision["snapshot"],
): Decision {
  const row: Decision = {
    id: `xdec_${++decisionSeq}`,
    opportunityId,
    ceoDecision,
    decidedBy,
    decidedAt: Date.now(),
    snapshot,
    genesisTrigger: null,
  };
  if (!decisions.has(opportunityId)) decisions.set(opportunityId, []);
  decisions.get(opportunityId)!.push(row);
  return row;
}

// ─── Phase 15a mirror: requireDecidableCommitteePacket + decideExpansion ─

function requireDecidableCommitteePacket(id: string, now: number = Date.now()) {
  const o = opportunities.get(id);
  if (!o) throw new Error(`opportunity ${id} not found`);
  const missingReports = (["research", "finance", "strategy"] as const).filter(
    (d) => !reports[d].has(id),
  );
  if (missingReports.length > 0) {
    throw new Error(
      `committee packet for opportunity ${id} is not ready for a decision — missing report(s): ${missingReports.join(", ")}`,
    );
  }
  const { locked, missing } = isDeliberationLocked(id);
  if (!locked) {
    throw new Error(
      `committee packet for opportunity ${id} has not locked — awaiting deliberation from: ${missing.join(", ")}`,
    );
  }
  const votingRecord = getVotingRecord(o, now);
  if (!votingRecord.readyForDecision) {
    throw new Error(
      `committee packet for opportunity ${id} is not ready for a decision — still awaiting a vote (or timeout) from: ${votingRecord.pendingDepartments.join(", ")}`,
    );
  }
  return { opportunity: o, votingRecord };
}

function getLatestDecision(opportunityId: string): Decision | undefined {
  const history = decisions.get(opportunityId);
  return history && history.length > 0 ? history[history.length - 1] : undefined;
}

// Phase 4c mirror: reject is a one-way move, valid from any status —
// just enough of setOpportunityStatus()'s own ACTION_TARGET_STATUS/
// OPPORTUNITY_TRANSITIONS to exercise 15c's "rejected also closes out
// the opportunity's own status" wiring.
function rejectOpportunityStatus(opportunityId: string) {
  const o = opportunities.get(opportunityId);
  if (o) o.status = "rejected";
}

// ─── Phase 15d mirror: genesis_triggers + fireGenesisTrigger ────────────

type GenesisTriggerStatus = "pending" | "completed" | "failed";

interface GenesisTrigger {
  id: string;
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
  recommendedFundingUsdc: number | null;
  status: GenesisTriggerStatus;
  error: string | null;
}

let genesisTriggers: Map<string, GenesisTrigger>; // opportunityId -> row
let genesisTriggerSeq: number;
let genesisExecutor: (ctx: { opportunityId: string }) => void = () => {};

function resetGenesis() {
  genesisTriggers = new Map();
  genesisTriggerSeq = 0;
  genesisExecutor = () => {};
}

function fireGenesisTrigger(opportunityId: string, decision: Decision): GenesisTrigger {
  let trigger = genesisTriggers.get(opportunityId);
  if (!trigger) {
    trigger = {
      id: `gentrig_${++genesisTriggerSeq}`,
      opportunityId,
      decisionId: decision.id,
      agentAddress: "agent_a",
      recommendedFundingUsdc: null,
      status: "pending",
      error: null,
    };
    genesisTriggers.set(opportunityId, trigger);
  }
  try {
    genesisExecutor({ opportunityId });
    return trigger;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    trigger.status = "failed";
    trigger.error = message;
    return trigger;
  }
}

function decideExpansion(
  opportunityId: string,
  decision: CeoDecision,
  decidedBy: string,
  notes: string | null = null,
  now: number = Date.now(),
): Decision {
  if (!VALID_DECISIONS.includes(decision)) {
    throw new Error(`decision must be one of ${VALID_DECISIONS.join(", ")}, got "${decision}"`);
  }
  if (!decidedBy) {
    throw new Error("decidedBy is required");
  }
  // Phase 15c finality gate — checked before the packet-readiness gate,
  // same order the real decideExpansion() uses.
  const prior = getLatestDecision(opportunityId);
  if (prior && isTerminalCeoDecision(prior.ceoDecision)) {
    throw new Error(
      `opportunity ${opportunityId} already has a final CEO ruling (${prior.ceoDecision}, decided ${new Date(prior.decidedAt).toISOString()}) — decide_expansion cannot rule on it again`,
    );
  }
  const { votingRecord } = requireDecidableCommitteePacket(opportunityId, now);
  const trimmed = typeof notes === "string" ? notes.trim() : "";
  const recorded = recordExpansionDecision(opportunityId, decision, decidedBy, {
    notes: trimmed ? trimmed : null,
    complete: true,
    locked: true,
    votingRecord,
  });
  if (decision === "rejected") {
    rejectOpportunityStatus(opportunityId);
  } else if (decision === "approved") {
    // Phase 15d — fired unconditionally, synchronously, right here, no
    // operator gate in between.
    recorded.genesisTrigger = fireGenesisTrigger(opportunityId, recorded);
  }
  return recorded;
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("15a: throws for an unknown opportunity — never invents one", () => {
  reset();
  assert.throws(() => decideExpansion("opp_missing", "approved", "agent_ceo"), /not found/);
});

test("15a: throws (named missing departments) when 13e's completeness gate hasn't cleared", () => {
  reset();
  makeOpportunity("opp_1");
  reports.research.add("opp_1"); // finance + strategy still outstanding
  assert.throws(() => decideExpansion("opp_1", "approved", "agent_ceo"), /finance, strategy/);
});

test("15a: throws when 14a's deliberation pass is enabled but not locked", () => {
  reset();
  makeOpportunity("opp_1");
  fileAllThreeReports("opp_1");
  deliberationEnabled.add("opp_1");
  respondToDeliberation("opp_1", "research");
  // finance/strategy haven't responded — not locked yet
  assert.throws(() => decideExpansion("opp_1", "approved", "agent_ceo"), /has not locked/);
});

test("15a: throws when a department vote is still pending (before timeout)", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  castVote("opp_1", "opportunity_intelligence", "recommend");
  castVote("opp_1", "research", "recommend");
  castVote("opp_1", "finance", "recommend");
  // strategy hasn't voted, and we're well within the timeout window
  assert.throws(
    () => decideExpansion("opp_1", "approved", "agent_ceo", null, now + 1000),
    /still awaiting a vote \(or timeout\) from: strategy/,
  );
});

test("15a: a timed-out vote does NOT block the packet forever (14d composes cleanly)", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - VOTE_TIMEOUT_MS - 1000); // selected well before the deadline
  fileAllThreeReports("opp_1");
  castVote("opp_1", "opportunity_intelligence", "recommend");
  castVote("opp_1", "research", "recommend");
  castVote("opp_1", "finance", "recommend");
  // strategy still never voted — but the deadline has passed
  const recorded = decideExpansion("opp_1", "approved", "agent_ceo", null, now);
  assert.equal(recorded.ceoDecision, "approved");
});

test("15a: happy path — complete, locked, fully voted packet records an approved ruling", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  const recorded = decideExpansion("opp_1", "approved", "agent_ceo", "  looks solid  ", now + 500);
  assert.equal(recorded.ceoDecision, "approved");
  assert.equal(recorded.decidedBy, "agent_ceo");
  assert.equal(recorded.snapshot.notes, "looks solid", "notes is trimmed");
  assert.equal(recorded.snapshot.votingRecord.readyForDecision, true);
});

test("15a: notes is optional — omitted or blank both read back as null", () => {
  reset();
  const now = Date.now();
  // Two separate opportunities: 'rejected' is terminal as of 15c, so
  // this can no longer exercise both cases against the same opp_1
  // (see the 15c finality tests below for that behavior instead).
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  const withoutNotes = decideExpansion("opp_1", "rejected", "agent_ceo", undefined, now + 500);
  assert.equal(withoutNotes.snapshot.notes, null);

  makeOpportunity("opp_2", now - 1000);
  fileAllThreeReports("opp_2");
  for (const d of VOTE_DEPTS) castVote("opp_2", d, "recommend");
  const blankNotes = decideExpansion("opp_2", "rejected", "agent_ceo", "   ", now + 600);
  assert.equal(blankNotes.snapshot.notes, null);
});

test("15a: deferred is a valid ruling and simply records as this opportunity's newest decision (15c's own re-queue job, not this function's)", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  decideExpansion("opp_1", "deferred", "agent_ceo", null, now + 500);
  decideExpansion("opp_1", "approved", "agent_ceo", null, now + 600);
  const history = decisions.get("opp_1")!;
  assert.equal(history.length, 2);
  assert.equal(history[0].ceoDecision, "deferred");
  assert.equal(history[1].ceoDecision, "approved");
});

test("15a: rejects an invalid decision value", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  assert.throws(
    () => decideExpansion("opp_1", "maybe" as CeoDecision, "agent_ceo", null, now + 500),
    /decision must be one of/,
  );
});

test("15a: requires a decidedBy — the CEO is a calling agent, not an anonymous ruling", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  assert.throws(() => decideExpansion("opp_1", "approved", "", null, now + 500), /decidedBy is required/);
});

test("15a: disagreement path still decides cleanly — a do-not-recommend vote doesn't block readiness", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  castVote("opp_1", "opportunity_intelligence", "recommend");
  castVote("opp_1", "research", "do-not-recommend");
  castVote("opp_1", "finance", "recommend");
  castVote("opp_1", "strategy", "recommend");
  const recorded = decideExpansion("opp_1", "rejected", "agent_ceo", "research flagged risk", now + 500);
  assert.equal(recorded.ceoDecision, "rejected");
  assert.equal(recorded.snapshot.votingRecord.readyForDecision, true);
});

// ─── Phase 15c: approved / rejected / deferred handling ─────────────────

test("15c: approved is terminal — a second decide_expansion call on the same opportunity throws", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  decideExpansion("opp_1", "approved", "agent_ceo", null, now + 500);
  assert.throws(
    () => decideExpansion("opp_1", "approved", "agent_ceo", null, now + 600),
    /already has a final CEO ruling \(approved/,
  );
  assert.equal(decisions.get("opp_1")!.length, 1, "the second attempt never recorded a row");
});

test("15c: rejected is terminal — a later approved attempt is refused, not overwritten", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  decideExpansion("opp_1", "rejected", "agent_ceo", null, now + 500);
  assert.throws(
    () => decideExpansion("opp_1", "approved", "agent_ceo", null, now + 600),
    /already has a final CEO ruling \(rejected/,
  );
  assert.equal(decisions.get("opp_1")!.length, 1);
});

test("15c: rejected also closes out the opportunity's own status (same terminal state 4c's manual reject writes)", () => {
  reset();
  const now = Date.now();
  const o = makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  assert.equal(o.status, "selected");
  decideExpansion("opp_1", "rejected", "agent_ceo", null, now + 500);
  assert.equal(o.status, "rejected");
});

test("15c: approved does NOT touch the opportunity's status — that's Phase 16's genesis path, not this function's", () => {
  reset();
  const now = Date.now();
  const o = makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  decideExpansion("opp_1", "approved", "agent_ceo", null, now + 500);
  assert.equal(o.status, "selected", "unchanged — approved records the ruling only");
});

test("15c: deferred stays open for as many re-review ticks as needed, each one cheap (no department re-run)", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  decideExpansion("opp_1", "deferred", "agent_ceo", "revisit next tick", now + 500);
  decideExpansion("opp_1", "deferred", "agent_ceo", "still not sure", now + 600);
  const recorded = decideExpansion("opp_1", "rejected", "agent_ceo", "no longer viable", now + 700);
  const history = decisions.get("opp_1")!;
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((h) => h.ceoDecision),
    ["deferred", "deferred", "rejected"],
  );
  assert.equal(recorded.ceoDecision, "rejected");
  // and now that the newest ruling is terminal, a further call is refused
  assert.throws(() => decideExpansion("opp_1", "approved", "agent_ceo", null, now + 800));
});

// ─── Phase 15d: approved fires genesis directly, no operator gate ───────

test("15d: approved records a genesis trigger inline, in the same call — no separate step required", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  const recorded = decideExpansion("opp_1", "approved", "agent_ceo", null, now + 500);
  assert.ok(recorded.genesisTrigger, "genesis trigger fired as part of decideExpansion() itself");
  assert.equal(recorded.genesisTrigger!.opportunityId, "opp_1");
  assert.equal(recorded.genesisTrigger!.decisionId, recorded.id);
  assert.equal(recorded.genesisTrigger!.status, "pending");
});

test("15d: rejected never fires a genesis trigger", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  const recorded = decideExpansion("opp_1", "rejected", "agent_ceo", null, now + 500);
  assert.equal(recorded.genesisTrigger, null);
  assert.equal(genesisTriggers.size, 0);
});

test("15d: deferred never fires a genesis trigger", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  const recorded = decideExpansion("opp_1", "deferred", "agent_ceo", null, now + 500);
  assert.equal(recorded.genesisTrigger, null);
  assert.equal(genesisTriggers.size, 0);
});

test("15d: a deferred-then-approved sequence fires genesis only once, on the terminal approval", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  decideExpansion("opp_1", "deferred", "agent_ceo", "not yet", now + 500);
  assert.equal(genesisTriggers.size, 0, "no trigger while still deferred");
  const approved = decideExpansion("opp_1", "approved", "agent_ceo", null, now + 600);
  assert.ok(approved.genesisTrigger);
  assert.equal(genesisTriggers.size, 1);
});

test("15d: the trigger carries the opportunity's agent and decision id, for Phase 16 to consume later", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  const recorded = decideExpansion("opp_1", "approved", "agent_ceo", "go", now + 500);
  const trigger = recorded.genesisTrigger!;
  assert.equal(trigger.decisionId, recorded.id);
  assert.equal(typeof trigger.agentAddress, "string");
  assert.ok(trigger.agentAddress.length > 0);
});

test("15d: an executor failure marks the trigger 'failed' with the error, but the approved ruling itself still stands", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  genesisExecutor = () => {
    throw new Error("provisioning backend unreachable");
  };
  const recorded = decideExpansion("opp_1", "approved", "agent_ceo", null, now + 500);
  assert.equal(recorded.ceoDecision, "approved", "the CEO's ruling is unaffected by a provisioning failure");
  assert.equal(recorded.genesisTrigger!.status, "failed");
  assert.match(recorded.genesisTrigger!.error!, /provisioning backend unreachable/);
  // and the ruling is still terminal — a retry is not "rule again"
  assert.throws(() => decideExpansion("opp_1", "approved", "agent_ceo", null, now + 600));
});

test("15d: a working executor leaves the trigger 'pending' — only Phase 16a marks it 'completed'", () => {
  reset();
  const now = Date.now();
  makeOpportunity("opp_1", now - 1000);
  fileAllThreeReports("opp_1");
  for (const d of VOTE_DEPTS) castVote("opp_1", d, "recommend");
  let called = false;
  genesisExecutor = () => {
    called = true;
  };
  const recorded = decideExpansion("opp_1", "approved", "agent_ceo", null, now + 500);
  assert.ok(called, "the executor was actually invoked, synchronously, inline");
  assert.equal(recorded.genesisTrigger!.status, "pending");
});
