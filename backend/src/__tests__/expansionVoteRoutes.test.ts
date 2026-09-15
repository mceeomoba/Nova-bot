// Zent.md Phase 14b: "Vote/recommendation field per department:
// recommend / recommend-with-conditions / do-not-recommend, distinct
// from their numeric scores — forces a clear position." Phase 14c:
// "Conditions capture: 'recommend, but cap initial funding at $X' is a
// first-class field the CEO gate can read, not free text to parse."
// Phase 14d: "Timeout handling: a department that doesn't respond
// within its budgeted ticks doesn't block the packet forever — it's
// marked no-response and the packet proceeds with that noted."
//
// This file is the route-level counterpart to
// expansionCommitteePacketGet.test.ts (13d): exercising POST
// .../opportunities/:id/vote and GET .../opportunities/:id/votes
// themselves (bad-id / missing-field / ownership / not-found / happy
// path), rather than just recordDepartmentVote()/getVotingRecord() in
// isolation the way expansionDeliberation.test.ts's own 14b/14c/14d/14e
// section already does. Nothing in this directory previously exercised
// these two routes directly — the underlying functions were fully
// covered, but a caller sending the routes themselves a malformed
// request (in particular, an invalid vote/conditions pairing) was
// unverified.
//
// Same "no live better-sqlite3/express in this environment" reason
// every other expansion*.test.ts file in this directory gives — this
// is an inlined mirror of both route handlers' own logic, exercised
// against plain in-memory data and a fake Express response object.
// Recommend re-running against the real expansionRoutes.ts/expansion.ts
// (e.g. supertest against the mounted router) once a networked
// environment is available.
//
// Written alongside a real fix to expansionRoutes.ts's own POST
// .../vote handler: it previously validated only that `conditions` was
// a string when present, then let recordDepartmentVote() throw (an
// opaque 500) on an invalid vote/conditions *pairing* — inconsistent
// with the 14a deliberation route's own "pre-validate everything a
// bad request could trip, so it's a named 400" convention. The route
// now pre-validates that pairing itself, same as 14a's route does for
// its own required fields; this file's failing-pairing tests below are
// what would have caught that gap.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Minimal in-memory stand-ins, same shape this directory's other
//     route-level test files already use ───────────────────────────────

interface FakeOpportunity {
  id: string;
  report_id: string;
  selected_at: number | null;
}

interface FakeReport {
  id: string;
  agent_address: string;
}

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

let opportunities: Map<string, FakeOpportunity>;
let reports: Map<string, FakeReport>;
let votes: Map<string, DepartmentVote>; // key: `${opportunityId}:${department}`
let oppSeq: number;
let voteSeq: number;

function reset() {
  opportunities = new Map();
  reports = new Map();
  votes = new Map();
  oppSeq = 0;
  voteSeq = 0;
}

function seedOpportunity(overrides: Partial<FakeOpportunity & { agentAddress: string }> = {}): FakeOpportunity {
  const reportId = `rep_${++oppSeq}`;
  reports.set(reportId, { id: reportId, agent_address: overrides.agentAddress ?? "agent_a" });
  const o: FakeOpportunity = {
    id: `opp_${oppSeq}`,
    report_id: reportId,
    selected_at: overrides.selected_at ?? Date.now(),
  };
  opportunities.set(o.id, o);
  return o;
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

function isValidVoteDepartment(value: unknown): value is VoteDept {
  return typeof value === "string" && (VOTE_DEPTS as readonly string[]).includes(value);
}

const VOTE_VALUES: readonly Vote[] = ["recommend", "recommend-with-conditions", "do-not-recommend"];
function isValidVoteValue(value: unknown): value is Vote {
  return typeof value === "string" && (VOTE_VALUES as readonly string[]).includes(value);
}

// ─── Mirrors of expansion.ts's own recordDepartmentVote()/
//     listDepartmentVotes()/getVotingRecord() (14b/14c/14d) — same
//     mirror expansionDeliberation.test.ts's own 14b/14c/14d/14e
//     section already uses, kept here so this file's route mirrors have
//     something real underneath them ─────────────────────────────────

function recordDepartmentVote(
  opportunityId: string,
  department: VoteDept,
  vote: Vote,
  conditions?: string | null,
): DepartmentVote {
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

function getVotingRecord(opportunityId: string) {
  const opportunity = getOpportunity(opportunityId);
  const list = listDepartmentVotes(opportunityId);
  const byDept = new Map(list.map((v) => [v.department, v]));
  const deadlineAt =
    !opportunity || opportunity.selected_at === null ? null : opportunity.selected_at + VOTE_TIMEOUT_MS;
  const timedOut = deadlineAt !== null && Date.now() > deadlineAt;
  const statuses = VOTE_DEPTS.map((department) => {
    const vote = byDept.get(department) ?? null;
    const status = vote ? "voted" : timedOut ? "no-response" : "pending";
    return { department, status, vote };
  });
  return { deadlineAt, statuses, readyForDecision: statuses.every((s) => s.status !== "pending") };
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

// ─── Mirror of expansionRoutes.ts's POST /opportunities/:id/vote (14b/14c) ─
//
// Matches the real handler field-for-field, including the 14c fix this
// file was written alongside: the vote/conditions pairing is
// pre-validated as a named 400 before recordDepartmentVote() is ever
// called, not left to that function's own throw to surface as a 500.

function handlePostVote(id: string, body: any, res: FakeResponse) {
  try {
    const { agentAddress, department, vote, conditions } = body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (!isValidVoteDepartment(department)) {
      return res.status(400).json({ error: `department must be one of: ${VOTE_DEPTS.join(", ")}` });
    }
    if (!isValidVoteValue(vote)) {
      return res.status(400).json({
        error: "vote must be one of: recommend, recommend-with-conditions, do-not-recommend",
      });
    }
    if (conditions !== undefined && conditions !== null && typeof conditions !== "string") {
      return res.status(400).json({ error: "conditions must be a string when provided" });
    }
    const trimmedConditions = typeof conditions === "string" ? conditions.trim() : "";
    if (vote === "recommend-with-conditions" && !trimmedConditions) {
      return res.status(400).json({ error: "conditions is required for a recommend-with-conditions vote" });
    }
    if (vote !== "recommend-with-conditions" && trimmedConditions) {
      return res.status(400).json({ error: "conditions is only valid for a recommend-with-conditions vote" });
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
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const record = recordDepartmentVote(id, department, vote, conditions);
    res.json({ opportunityId: id, vote: record, votingRecord: getVotingRecord(id) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
}

// ─── Mirror of expansionRoutes.ts's GET /opportunities/:id/votes (14b/14d) ─

function handleGetVotes(id: string, res: FakeResponse) {
  try {
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    res.json({ opportunityId: id, votingRecord: getVotingRecord(id), votes: listDepartmentVotes(id) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
}

// ─── POST vote: bad-id / missing-field / not-found / ownership paths ───

test("POST vote on a malformed id returns 400 before any lookup", () => {
  reset();
  const res = fakeRes();
  handlePostVote("not-an-opportunity-id", { agentAddress: "agent_a", department: "finance", vote: "recommend" }, res);
  assert.equal(res.statusCode, 400);
});

test("POST vote without agentAddress returns 400", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handlePostVote(o.id, { department: "finance", vote: "recommend" }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "agentAddress is required" });
});

test("POST vote with an invalid department returns 400, naming the valid set", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handlePostVote(o.id, { agentAddress: "agent_a", department: "sales", vote: "recommend" }, res);
  assert.equal(res.statusCode, 400);
  assert.ok((res.body as { error: string }).error.includes("opportunity_intelligence"));
});

test("POST vote with an invalid vote value returns 400", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handlePostVote(o.id, { agentAddress: "agent_a", department: "finance", vote: "maybe" }, res);
  assert.equal(res.statusCode, 400);
});

test("POST vote on an unknown opportunity id returns 404, not a thrown error", () => {
  reset();
  const res = fakeRes();
  handlePostVote("opp_missing", { agentAddress: "agent_a", department: "finance", vote: "recommend" }, res);
  assert.equal(res.statusCode, 404);
});

test("POST vote from an agentAddress that doesn't own the opportunity returns 403", () => {
  reset();
  const o = seedOpportunity({ agentAddress: "agent_owner" });
  const res = fakeRes();
  handlePostVote(o.id, { agentAddress: "agent_intruder", department: "finance", vote: "recommend" }, res);
  assert.equal(res.statusCode, 403);
});

// ─── Phase 14c: conditions/vote pairing is a clean 400, not a 500 ──────
//
// The concrete gap this file's own header describes: before the fix,
// each of these three cases reached recordDepartmentVote()'s own throw
// and came back as an opaque 500 rather than a named 400 like every
// other malformed-request case above.

test("POST vote: recommend-with-conditions without conditions returns 400, not 500", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handlePostVote(o.id, { agentAddress: "agent_a", department: "finance", vote: "recommend-with-conditions" }, res);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "conditions is required for a recommend-with-conditions vote" });
});

test("POST vote: recommend-with-conditions with only whitespace conditions returns 400, not 500", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handlePostVote(
    o.id,
    { agentAddress: "agent_a", department: "finance", vote: "recommend-with-conditions", conditions: "   " },
    res,
  );
  assert.equal(res.statusCode, 400);
});

test("POST vote: a plain recommend with a conditions string attached returns 400, not 500", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handlePostVote(
    o.id,
    { agentAddress: "agent_a", department: "finance", vote: "recommend", conditions: "cap at $5,000" },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "conditions is only valid for a recommend-with-conditions vote" });
});

test("POST vote: a non-string conditions value returns 400", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handlePostVote(
    o.id,
    { agentAddress: "agent_a", department: "finance", vote: "recommend-with-conditions", conditions: 5000 },
    res,
  );
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, { error: "conditions must be a string when provided" });
});

// ─── POST vote: happy path, conditions comes back as a structured field ─

test("POST vote: recommend-with-conditions succeeds and echoes conditions as a first-class field", () => {
  reset();
  const o = seedOpportunity({ agentAddress: "agent_a" });
  const res = fakeRes();
  handlePostVote(
    o.id,
    {
      agentAddress: "agent_a",
      department: "finance",
      vote: "recommend-with-conditions",
      conditions: "cap initial funding at $5,000",
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  const body = res.body as { vote: DepartmentVote; votingRecord: ReturnType<typeof getVotingRecord> };
  assert.equal(body.vote.vote, "recommend-with-conditions");
  assert.equal(body.vote.conditions, "cap initial funding at $5,000");
  const financeStatus = body.votingRecord.statuses.find((s) => s.department === "finance")!;
  assert.equal(financeStatus.status, "voted");
  assert.equal(financeStatus.vote?.conditions, "cap initial funding at $5,000");
});

test("POST vote: a plain recommend succeeds with conditions read back as null", () => {
  reset();
  const o = seedOpportunity({ agentAddress: "agent_a" });
  const res = fakeRes();
  handlePostVote(o.id, { agentAddress: "agent_a", department: "research", vote: "recommend" }, res);
  assert.equal(res.statusCode, 200);
  const body = res.body as { vote: DepartmentVote };
  assert.equal(body.vote.conditions, null);
});

test("POST vote: a resubmit from the same department updates the vote, not a second row", () => {
  reset();
  const o = seedOpportunity({ agentAddress: "agent_a" });
  handlePostVote(o.id, { agentAddress: "agent_a", department: "strategy", vote: "do-not-recommend" }, fakeRes());
  const res = fakeRes();
  handlePostVote(
    o.id,
    { agentAddress: "agent_a", department: "strategy", vote: "recommend-with-conditions", conditions: "revisit in Q2" },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(listDepartmentVotes(o.id).length, 1);
  assert.equal(listDepartmentVotes(o.id)[0].vote, "recommend-with-conditions");
});

// ─── GET votes: bad-id / not-found / happy path ─────────────────────────

test("GET votes on a malformed id returns 400 before any lookup", () => {
  reset();
  const res = fakeRes();
  handleGetVotes("not-an-opportunity-id", res);
  assert.equal(res.statusCode, 400);
});

test("GET votes on an unknown opportunity id returns 404", () => {
  reset();
  const res = fakeRes();
  handleGetVotes("opp_missing", res);
  assert.equal(res.statusCode, 404);
});

test("GET votes on a known opportunity with nothing voted yet returns 200, all pending", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handleGetVotes(o.id, res);
  assert.equal(res.statusCode, 200);
  const body = res.body as { votingRecord: ReturnType<typeof getVotingRecord>; votes: DepartmentVote[] };
  assert.deepEqual(body.votes, []);
  assert.equal(body.votingRecord.statuses.every((s) => s.status === "pending"), true);
  assert.equal(body.votingRecord.readyForDecision, false);
});

test("GET votes: full four-department happy path is ready for decision, conditions included verbatim", () => {
  reset();
  const o = seedOpportunity({ agentAddress: "agent_a" });
  handlePostVote(o.id, { agentAddress: "agent_a", department: "opportunity_intelligence", vote: "recommend" }, fakeRes());
  handlePostVote(o.id, { agentAddress: "agent_a", department: "research", vote: "recommend" }, fakeRes());
  handlePostVote(
    o.id,
    { agentAddress: "agent_a", department: "finance", vote: "recommend-with-conditions", conditions: "cap at $5,000" },
    fakeRes(),
  );
  handlePostVote(o.id, { agentAddress: "agent_a", department: "strategy", vote: "recommend" }, fakeRes());

  const res = fakeRes();
  handleGetVotes(o.id, res);
  assert.equal(res.statusCode, 200);
  const body = res.body as { votingRecord: ReturnType<typeof getVotingRecord>; votes: DepartmentVote[] };
  assert.equal(body.votingRecord.readyForDecision, true);
  assert.equal(body.votes.length, 4);
  const finance = body.votes.find((v) => v.department === "finance")!;
  assert.equal(finance.conditions, "cap at $5,000");
});

test("GET votes: disagreement path — one do-not-recommend among three recommends, still surfaced per-department", () => {
  reset();
  const o = seedOpportunity({ agentAddress: "agent_a" });
  handlePostVote(o.id, { agentAddress: "agent_a", department: "opportunity_intelligence", vote: "recommend" }, fakeRes());
  handlePostVote(o.id, { agentAddress: "agent_a", department: "research", vote: "do-not-recommend" }, fakeRes());
  handlePostVote(o.id, { agentAddress: "agent_a", department: "finance", vote: "recommend" }, fakeRes());
  handlePostVote(o.id, { agentAddress: "agent_a", department: "strategy", vote: "recommend" }, fakeRes());

  const res = fakeRes();
  handleGetVotes(o.id, res);
  const body = res.body as { votes: DepartmentVote[] };
  const positions = body.votes.map((v) => v.vote);
  assert.ok(positions.includes("do-not-recommend"));
  assert.ok(positions.includes("recommend"));
});

test("GET votes requires no agentAddress at all — same plain-read posture as the deliberation/committee-packet GET routes", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handleGetVotes(o.id, res);
  assert.equal(res.statusCode, 200);
});
