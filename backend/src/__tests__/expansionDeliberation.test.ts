// Zent.md Phase 14a: "Optional deliberation pass: a lightweight
// cross-department exchange (each department gets to see the others'
// reports once and append a short rebuttal/concur) before the packet
// locks — off by default, enabled per-agent config."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this is an
// inlined mirror of isDeliberationEnabled()/setDeliberationEnabled()/
// recordDeliberationResponse()/getDeliberationExchange() from
// expansion.ts, exercised against plain in-memory maps standing in for
// expansion_pipeline_config and deliberation_responses. Recommend
// re-running against the real expansion.ts once a networked environment
// is available.

import { test } from "node:test";
import assert from "node:assert/strict";

type Department = "research" | "finance" | "strategy";
type Position = "concur" | "rebuttal";
const DEPARTMENTS: readonly Department[] = ["research", "finance", "strategy"];

interface Response {
  id: string;
  opportunityId: string;
  department: Department;
  position: Position;
  responseText: string;
  respondingTo: readonly Department[];
  createdAt: number;
}

let config: Map<string, boolean>;
let responses: Map<string, Response>; // key: `${opportunityId}:${department}`
let seq: number;

function reset() {
  config = new Map();
  responses = new Map();
  seq = 0;
}

// ─── Mirrors of expansion.ts's Phase 14a exports ───────────────────────

function isDeliberationEnabled(agentAddress: string): boolean {
  return config.get(agentAddress) ?? false;
}

function setDeliberationEnabled(agentAddress: string, enabled: boolean): void {
  if (!agentAddress) throw new Error("agentAddress is required");
  config.set(agentAddress, enabled);
}

function recordDeliberationResponse(
  opportunityId: string,
  department: Department,
  position: Position,
  responseText: string,
  respondingTo: readonly Department[] = DEPARTMENTS.filter((d) => d !== department),
): Response {
  if (!DEPARTMENTS.includes(department)) throw new Error(`invalid department: ${department}`);
  if (position !== "concur" && position !== "rebuttal") throw new Error(`invalid position: ${position}`);
  if (!responseText || !responseText.trim()) throw new Error("responseText is required");
  const key = `${opportunityId}:${department}`;
  const row: Response = {
    id: `delib_${++seq}`,
    opportunityId,
    department,
    position,
    responseText: responseText.trim(),
    respondingTo,
    createdAt: Date.now(),
  };
  responses.set(key, row); // upsert — same "once, but a resubmit updates" contract as the real table
  return row;
}

function listDeliberationResponses(opportunityId: string): Response[] {
  return [...responses.values()]
    .filter((r) => r.opportunityId === opportunityId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

interface Exchange {
  enabled: boolean;
  responses: Response[];
  respondedDepartments: readonly Department[];
  missingDepartments: readonly Department[];
  locked: boolean;
}

function getDeliberationExchange(opportunityId: string, agentAddress: string): Exchange {
  const enabled = isDeliberationEnabled(agentAddress);
  const resp = listDeliberationResponses(opportunityId);
  const respondedDepartments = resp.map((r) => r.department);
  const missingDepartments = enabled
    ? DEPARTMENTS.filter((d) => !respondedDepartments.includes(d))
    : [];
  return {
    enabled,
    responses: resp,
    respondedDepartments,
    missingDepartments,
    locked: !enabled || missingDepartments.length === 0,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("14a: deliberation is off by default for an agent with no config row", () => {
  reset();
  assert.equal(isDeliberationEnabled("agent_a"), false);
});

test("14a: setDeliberationEnabled flips the per-agent switch", () => {
  reset();
  setDeliberationEnabled("agent_a", true);
  assert.equal(isDeliberationEnabled("agent_a"), true);
  assert.equal(isDeliberationEnabled("agent_b"), false, "other agents are unaffected");
  setDeliberationEnabled("agent_a", false);
  assert.equal(isDeliberationEnabled("agent_a"), false);
});

test("14a: a disabled exchange is always locked, regardless of responses", () => {
  reset();
  const exchange = getDeliberationExchange("opp_1", "agent_a");
  assert.equal(exchange.enabled, false);
  assert.equal(exchange.locked, true);
  assert.deepEqual(exchange.missingDepartments, []);
});

test("14a: happy path — all three departments respond, packet locks", () => {
  reset();
  setDeliberationEnabled("agent_a", true);
  recordDeliberationResponse("opp_1", "research", "concur", "Market size checks out.");
  recordDeliberationResponse("opp_1", "finance", "concur", "Sizing is conservative, agreed.");
  recordDeliberationResponse("opp_1", "strategy", "rebuttal", "Fit score seems high given the overlap.");

  const exchange = getDeliberationExchange("opp_1", "agent_a");
  assert.equal(exchange.enabled, true);
  assert.equal(exchange.responses.length, 3);
  assert.deepEqual(exchange.missingDepartments, []);
  assert.equal(exchange.locked, true);
});

test("14a: disagreement path — enabled, one department outstanding, packet does not lock", () => {
  reset();
  setDeliberationEnabled("agent_a", true);
  recordDeliberationResponse("opp_1", "research", "concur", "Looks right.");
  recordDeliberationResponse("opp_1", "finance", "rebuttal", "Sizing looks too aggressive given the market data.");
  // strategy never responds

  const exchange = getDeliberationExchange("opp_1", "agent_a");
  assert.equal(exchange.enabled, true);
  assert.deepEqual(exchange.missingDepartments, ["strategy"]);
  assert.equal(exchange.locked, false);
});

test("14a: a resubmit from the same department updates its response, not a second row", () => {
  reset();
  setDeliberationEnabled("agent_a", true);
  recordDeliberationResponse("opp_1", "research", "rebuttal", "Initial concern about market size.");
  recordDeliberationResponse("opp_1", "research", "concur", "Revised after seeing Finance's numbers.");

  const resp = listDeliberationResponses("opp_1");
  assert.equal(resp.length, 1);
  assert.equal(resp[0].position, "concur");
  assert.equal(resp[0].responseText, "Revised after seeing Finance's numbers.");
});

test("14a: rejects an invalid department or position", () => {
  reset();
  assert.throws(() => recordDeliberationResponse("opp_1", "sales" as Department, "concur", "text"));
  assert.throws(() => recordDeliberationResponse("opp_1", "research", "veto" as Position, "text"));
  assert.throws(() => recordDeliberationResponse("opp_1", "research", "concur", "   "));
});

// ─── Phase 14b/14c/14d: votes, conditions, and timeout ─────────────────
//
// Zent.md 14e: "Test: full four-department happy-path + one
// disagreement-path fixture." Mirrors recordDepartmentVote()/
// listDepartmentVotes()/getVotingRecord() from expansion.ts, same
// in-memory-map convention as the 14a mirrors above.

type VoteDept = "opportunity_intelligence" | "research" | "finance" | "strategy";
type Vote = "recommend" | "recommend-with-conditions" | "do-not-recommend";
const VOTE_DEPTS: readonly VoteDept[] = ["opportunity_intelligence", "research", "finance", "strategy"];
const VOTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

interface DepartmentVote {
  id: string;
  opportunityId: string;
  department: VoteDept;
  vote: Vote;
  conditions: string | null;
  createdAt: number;
}

let votes: Map<string, DepartmentVote>; // key: `${opportunityId}:${department}`
let voteSeq: number;

function resetVotes() {
  votes = new Map();
  voteSeq = 0;
}

function recordDepartmentVote(
  opportunityId: string,
  department: VoteDept,
  vote: Vote,
  conditions?: string | null,
): DepartmentVote {
  if (!VOTE_DEPTS.includes(department)) throw new Error(`invalid department: ${department}`);
  const trimmed = typeof conditions === "string" ? conditions.trim() : null;
  if (vote === "recommend-with-conditions" && !trimmed) {
    throw new Error("conditions is required for a recommend-with-conditions vote");
  }
  if (vote !== "recommend-with-conditions" && trimmed) {
    throw new Error("conditions is only valid for a recommend-with-conditions vote");
  }
  const row: DepartmentVote = {
    id: `vote_${++voteSeq}`,
    opportunityId,
    department,
    vote,
    conditions: vote === "recommend-with-conditions" ? trimmed : null,
    createdAt: Date.now(),
  };
  votes.set(`${opportunityId}:${department}`, row);
  return row;
}

function listDepartmentVotes(opportunityId: string): DepartmentVote[] {
  return [...votes.values()]
    .filter((v) => v.opportunityId === opportunityId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function getVotingRecord(opportunityId: string, selectedAt: number | null, now: number = Date.now()) {
  const list = listDepartmentVotes(opportunityId);
  const byDept = new Map(list.map((v) => [v.department, v]));
  const deadlineAt = selectedAt === null ? null : selectedAt + VOTE_TIMEOUT_MS;
  const timedOut = deadlineAt !== null && now > deadlineAt;
  const statuses = VOTE_DEPTS.map((department) => {
    const vote = byDept.get(department) ?? null;
    const status = vote ? "voted" : timedOut ? "no-response" : "pending";
    return { department, status, vote };
  });
  return { deadlineAt, statuses, readyForDecision: statuses.every((s) => s.status !== "pending") };
}

test("14b/14e: four-department happy path — all recommend, packet is ready for decision", () => {
  resetVotes();
  recordDepartmentVote("opp_1", "opportunity_intelligence", "recommend");
  recordDepartmentVote("opp_1", "research", "recommend");
  recordDepartmentVote("opp_1", "finance", "recommend-with-conditions", "cap initial funding at $5,000");
  recordDepartmentVote("opp_1", "strategy", "recommend");

  const record = getVotingRecord("opp_1", Date.now() - 1000);
  assert.equal(record.readyForDecision, true);
  assert.equal(record.statuses.every((s) => s.status === "voted"), true);
  const finance = record.statuses.find((s) => s.department === "finance")!;
  assert.equal(finance.vote?.conditions, "cap initial funding at $5,000");
});

test("14b/14e: disagreement path — one do-not-recommend among three recommends, still ready", () => {
  resetVotes();
  recordDepartmentVote("opp_1", "opportunity_intelligence", "recommend");
  recordDepartmentVote("opp_1", "research", "do-not-recommend");
  recordDepartmentVote("opp_1", "finance", "recommend");
  recordDepartmentVote("opp_1", "strategy", "recommend");

  const record = getVotingRecord("opp_1", Date.now() - 1000);
  assert.equal(record.readyForDecision, true);
  const research = record.statuses.find((s) => s.department === "research")!;
  assert.equal(research.vote?.vote, "do-not-recommend");
  // The disagreement is visible per-department, not averaged away —
  // same "surface it explicitly" posture Phase 13c already takes.
  const positions = record.statuses.map((s) => s.vote?.vote);
  assert.ok(positions.includes("do-not-recommend"));
  assert.ok(positions.includes("recommend"));
});

test("14c: conditions is required for recommend-with-conditions, forbidden otherwise", () => {
  resetVotes();
  assert.throws(() => recordDepartmentVote("opp_1", "finance", "recommend-with-conditions"));
  assert.throws(() => recordDepartmentVote("opp_1", "finance", "recommend-with-conditions", "   "));
  assert.throws(() => recordDepartmentVote("opp_1", "finance", "recommend", "cap at $5,000"));
  // Valid cases don't throw:
  recordDepartmentVote("opp_1", "finance", "recommend-with-conditions", "cap at $5,000");
  recordDepartmentVote("opp_1", "strategy", "do-not-recommend");
});

test("14d: a department that hasn't voted is 'pending' before the deadline, 'no-response' after", () => {
  resetVotes();
  recordDepartmentVote("opp_1", "opportunity_intelligence", "recommend");
  recordDepartmentVote("opp_1", "research", "recommend");
  recordDepartmentVote("opp_1", "finance", "recommend");
  // strategy never votes

  const selectedAt = Date.now() - 1000; // just selected, well within budget
  const beforeDeadline = getVotingRecord("opp_1", selectedAt, selectedAt + 1000);
  const strategyBefore = beforeDeadline.statuses.find((s) => s.department === "strategy")!;
  assert.equal(strategyBefore.status, "pending");
  assert.equal(beforeDeadline.readyForDecision, false, "one department still pending blocks readiness");

  const afterDeadline = getVotingRecord("opp_1", selectedAt, selectedAt + VOTE_TIMEOUT_MS + 1000);
  const strategyAfter = afterDeadline.statuses.find((s) => s.department === "strategy")!;
  assert.equal(strategyAfter.status, "no-response");
  assert.equal(afterDeadline.readyForDecision, true, "no-response does not block the packet forever");
});

test("14d: a late vote after timeout still reads back as 'voted', not stuck at 'no-response'", () => {
  resetVotes();
  const selectedAt = Date.now() - VOTE_TIMEOUT_MS - 1000; // already past deadline
  const timedOutFirst = getVotingRecord("opp_1", selectedAt);
  assert.equal(
    timedOutFirst.statuses.find((s) => s.department === "strategy")!.status,
    "no-response",
  );

  recordDepartmentVote("opp_1", "strategy", "recommend");
  const afterLateVote = getVotingRecord("opp_1", selectedAt);
  assert.equal(afterLateVote.statuses.find((s) => s.department === "strategy")!.status, "voted");
});
