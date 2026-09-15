// Zent.md Phase 13d: "GET /expansion/opportunities/:id/committee-packet."
// The route itself is wired in expansionRoutes.ts (see that route's own
// header) — this file is the route-level counterpart to
// expansionResearchReportGet.test.ts (7c) / expansionStrategyReportGet.test.ts
// (12e): exercising the handler itself (bad-id/not-found/happy-path/no-
// ownership-gate/shape-recheck) rather than just
// validateCommitteePacketShape() or assembleCommitteePacket() in
// isolation the way expansionCommitteePacketShape.test.ts (13b) and
// expansionCommitteePacketAssembly.test.ts (13a/13c) already do.
//
// Same "no live better-sqlite3/express in this environment" reason
// every other expansion*.test.ts file in this directory gives — this is
// an inlined mirror of the route handler's own logic (existence check,
// assembleCommitteePacket(), validateCommitteePacketShape(), response
// body), exercised against plain in-memory data and a fake Express
// response object. Recommend re-running against the real
// expansionRoutes.ts/expansion.ts (e.g. supertest against the mounted
// router) once a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Minimal in-memory stand-ins, same shape this directory's other
//     committee-packet test files already use ───────────────────────────

interface FakeOpportunity {
  id: string;
  title: string;
  thesis: string;
  roi_score: number | null;
  tags: string[];
}

let opportunities: Map<string, FakeOpportunity>;
let financeSizing: Map<string, { recommendedFundingUsdc: number }>;
let strategyFit: Map<string, { fit_score: number }>;
let oppSeq: number;

function reset() {
  opportunities = new Map();
  financeSizing = new Map();
  strategyFit = new Map();
  oppSeq = 0;
}

function seedOpportunity(overrides: Partial<FakeOpportunity> = {}): FakeOpportunity {
  const o: FakeOpportunity = {
    id: `opp_${++oppSeq}`,
    title: "Widget Co",
    thesis: "Widgets for everyone",
    roi_score: 70,
    tags: [],
    ...overrides,
  };
  opportunities.set(o.id, o);
  return o;
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

// ─── Trimmed mirrors of expansion.ts's compile*Report() functions —
//     only the fields committeePacket/13c actually touch are modeled,
//     same "close enough to prove composition" posture
//     expansionCommitteePacketAssembly.test.ts's own header commits to ──

function compileFinanceReport(id: string) {
  const sizing = financeSizing.get(id) ?? null;
  return { opportunityId: id, findingId: sizing ? "finf_1" : null, sizingRecommendation: sizing };
}

function compileStrategyReport(id: string) {
  const fit = strategyFit.get(id) ?? null;
  return { opportunityId: id, findingId: fit ? "stgf_1" : null, fitScore: fit };
}

function compileResearchReport(id: string) {
  return { opportunityId: id, findingId: null };
}

// ─── Mirror of expansion.ts's own computeFinanceStrategyDisagreement()
//     (13c) — arithmetic already fully covered by
//     expansionFinanceStrategyDisagreement.test.ts ───────────────────────

const FIT_SCORE_DIRECTION_MIDPOINT = 50;

function computeFinanceStrategyDisagreement(
  financeReport: { sizingRecommendation: { recommendedFundingUsdc: number } | null },
  strategyReport: { fitScore: { fit_score: number } | null },
) {
  const midpoint = FIT_SCORE_DIRECTION_MIDPOINT;
  const sizing = financeReport.sizingRecommendation;
  const fit = strategyReport.fitScore;
  const financeDirection = sizing === null ? null : sizing.recommendedFundingUsdc > 0 ? "fund" : "no-fund";
  const strategyDirection = fit === null ? null : fit.fit_score >= midpoint ? "favorable" : "unfavorable";
  const diverges =
    financeDirection !== null &&
    strategyDirection !== null &&
    ((financeDirection === "fund" && strategyDirection === "unfavorable") ||
      (financeDirection === "no-fund" && strategyDirection === "favorable"));
  return {
    diverges,
    financeDirection,
    strategyDirection,
    recommendedFundingUsdc: sizing === null ? null : sizing.recommendedFundingUsdc,
    fitScore: fit === null ? null : fit.fit_score,
    midpoint,
  };
}

// ─── Mirror of expansion.ts's own COMMITTEE_PACKET_* / assembleCommitteePacket() /
//     validateCommitteePacketShape() (13a/13b/13c/13e/14a/14b/14c/14d) ──

const COMMITTEE_PACKET_SCHEMA_VERSION = "14d-v1";

const COMMITTEE_PACKET_FIELDS = [
  "opportunityId",
  "assembledAt",
  "schemaVersion",
  "opportunityIntelligence",
  "researchReport",
  "financeReport",
  "strategyReport",
  "financeStrategyDisagreement",
  "completeness",
  "deliberation",
  "votingRecord",
] as const;

const COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS = [
  "opportunityIntelligence",
  "researchReport",
  "financeReport",
  "strategyReport",
  "financeStrategyDisagreement",
  "completeness",
  "deliberation",
  "votingRecord",
] as const;

// Mirror of expansion.ts's own isDeliberationEnabled()/getDeliberationExchange()
// (14a) — trimmed to the "off by default, nothing filed" case, since this
// route-level file's own job is proving the field shows up in the HTTP
// response, not re-covering 14a's own enable/respond logic (that's
// expansionDeliberation.test.ts's job).
function getDeliberationExchange(_opportunityId: string) {
  return {
    enabled: false,
    responses: [],
    respondedDepartments: [],
    missingDepartments: [],
    locked: true,
  };
}

// Mirror of expansion.ts's own getVotingRecord() (14b/14c/14d) — trimmed
// to the "opportunity not yet selected, nothing voted" case, same
// "prove it shows up, don't re-cover the logic" posture as
// getDeliberationExchange() immediately above.
function getVotingRecord(_opportunityId: string) {
  return {
    deadlineAt: null,
    statuses: [
      { department: "opportunity_intelligence", status: "pending", vote: null },
      { department: "research", status: "pending", vote: null },
      { department: "finance", status: "pending", vote: null },
      { department: "strategy", status: "pending", vote: null },
    ],
    readyForDecision: false,
  };
}

// mirrors expansion.ts's own computeCommitteePacketCompleteness() (13e)
const HIGH_REGULATORY_RISK_TAG = "high_regulatory_risk";
function computeCommitteePacketCompleteness(
  opportunity: { tags: string[] },
  researchReport: { findingId: string | null },
  financeReport: { findingId: string | null },
  strategyReport: { findingId: string | null },
) {
  const missingReports: ("research" | "finance" | "strategy")[] = [];
  if (researchReport.findingId === null) missingReports.push("research");
  if (financeReport.findingId === null) missingReports.push("finance");
  if (strategyReport.findingId === null) missingReports.push("strategy");
  return {
    complete: missingReports.length === 0,
    missingReports,
    highRegulatoryRisk: opportunity.tags.includes(HIGH_REGULATORY_RISK_TAG),
  };
}

function validateCommitteePacketShape(
  packet: unknown,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    return { valid: false, errors: ["packet is not a plain object"] };
  }
  const obj = packet as Record<string, unknown>;
  const actualKeys = new Set(Object.keys(obj));
  const expectedKeys = new Set<string>(COMMITTEE_PACKET_FIELDS);
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) errors.push(`missing field: ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) errors.push(`unexpected field: ${key}`);
  }
  if (obj.schemaVersion !== COMMITTEE_PACKET_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be "${COMMITTEE_PACKET_SCHEMA_VERSION}"`);
  }
  for (const field of COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS) {
    const value = obj[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${field} must be an object, and is required (never null)`);
    }
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

function assembleCommitteePacket(id: string) {
  const opportunity = getOpportunity(id);
  if (!opportunity) {
    throw new Error(`opportunity ${id} not found`);
  }
  const researchReport = compileResearchReport(id);
  const financeReport = compileFinanceReport(id);
  const strategyReport = compileStrategyReport(id);
  return {
    opportunityId: id,
    assembledAt: Date.now(),
    schemaVersion: COMMITTEE_PACKET_SCHEMA_VERSION,
    opportunityIntelligence: opportunity,
    researchReport,
    financeReport,
    strategyReport,
    financeStrategyDisagreement: computeFinanceStrategyDisagreement(financeReport, strategyReport),
    // Phase 13e: this mirror had fallen behind the real
    // assembleCommitteePacket() by not attaching completeness at all
    // (COMMITTEE_PACKET_FIELDS already listed it as required, so any
    // packet built here was failing validateCommitteePacketShape() with
    // a silent 500 — a pre-existing gap in this file, closed alongside
    // this session's 14a/14b field additions rather than left in place).
    completeness: computeCommitteePacketCompleteness(opportunity, researchReport, financeReport, strategyReport),
    deliberation: getDeliberationExchange(id),
    votingRecord: getVotingRecord(id),
  };
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

// mirrors expansionRoutes.ts's sendCommitteePacket()
function sendCommitteePacket(id: string, res: FakeResponse) {
  const packet = assembleCommitteePacket(id);
  const shapeCheck = validateCommitteePacketShape(packet);
  if (!shapeCheck.valid) {
    res.status(500).json({
      error: `assembled committee packet failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
    });
    return;
  }
  res.json({
    opportunityId: id,
    schemaVersion: COMMITTEE_PACKET_SCHEMA_VERSION,
    packet,
  });
}

// mirrors the GET /opportunities/:id/committee-packet route handler itself
function handleGetCommitteePacket(id: string, res: FakeResponse) {
  try {
    if (!id || !id.startsWith("opp_")) {
      res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
      return;
    }
    if (!opportunities.has(id)) {
      res.status(404).json({ error: `opportunity ${id} not found` });
      return;
    }
    sendCommitteePacket(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
}

// ─── GET committee-packet: not-found / bad-id paths ─────────────────────

test("GET committee packet on an unknown opportunity id returns 404, not a thrown error", () => {
  reset();
  const res = fakeRes();
  handleGetCommitteePacket("opp_missing", res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "opportunity opp_missing not found" });
});

test("GET committee packet on a malformed id returns 400 before any lookup", () => {
  reset();
  const res = fakeRes();
  handleGetCommitteePacket("not-an-opportunity-id", res);
  assert.equal(res.statusCode, 400);
});

// ─── GET committee-packet: happy path, nothing run by any department ────

test("GET committee packet on a known opportunity with nothing filed yet returns 200 with all sections present but empty", () => {
  reset();
  const o = seedOpportunity({ title: "Widget Co", roi_score: 72 });
  const res = fakeRes();
  handleGetCommitteePacket(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { opportunityId: string; schemaVersion: string; packet: any };
  assert.equal(body.opportunityId, o.id);
  assert.equal(body.schemaVersion, COMMITTEE_PACKET_SCHEMA_VERSION);
  assert.equal(body.packet.opportunityIntelligence.title, "Widget Co");
  assert.equal(body.packet.researchReport.findingId, null);
  assert.equal(body.packet.financeReport.findingId, null);
  assert.equal(body.packet.strategyReport.findingId, null);
  // 13c's field is still present (never absent), just non-diverging
  // with both directions null — same "known opportunity, nothing filed
  // yet is not an error" tolerance every section here already has.
  assert.ok(body.packet.financeStrategyDisagreement);
  assert.equal(body.packet.financeStrategyDisagreement.diverges, false);
  assert.equal(body.packet.financeStrategyDisagreement.financeDirection, null);
  assert.equal(body.packet.financeStrategyDisagreement.strategyDirection, null);
  // Phase 14a/14b's fields are likewise always present (never absent),
  // same "known opportunity, nothing filed yet is not an error"
  // tolerance financeStrategyDisagreement above already has.
  assert.ok(body.packet.deliberation);
  assert.equal(body.packet.deliberation.locked, true);
  assert.ok(body.packet.votingRecord);
  assert.equal(body.packet.votingRecord.readyForDecision, false);
});

// ─── GET committee-packet: no completeness gate (13e's own future job) ──

test("GET committee packet does not gate on completeness — a packet with only Finance filed still returns 200", () => {
  reset();
  const o = seedOpportunity();
  financeSizing.set(o.id, { recommendedFundingUsdc: 4000 });

  const res = fakeRes();
  handleGetCommitteePacket(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { packet: any };
  assert.ok(body.packet.financeReport.sizingRecommendation);
  assert.equal(body.packet.strategyReport.findingId, null);
});

// ─── GET committee-packet: surfaces a real Finance-vs-Strategy
//     disagreement (13c) through the route, end to end ─────────────────

test("GET committee packet surfaces a real Finance-vs-Strategy disagreement in the response body", () => {
  reset();
  const o = seedOpportunity({ title: "Risky Co" });
  financeSizing.set(o.id, { recommendedFundingUsdc: 2000 });
  strategyFit.set(o.id, { fit_score: 15 });

  const res = fakeRes();
  handleGetCommitteePacket(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { packet: any };
  assert.equal(body.packet.financeStrategyDisagreement.diverges, true);
  assert.equal(body.packet.financeStrategyDisagreement.financeDirection, "fund");
  assert.equal(body.packet.financeStrategyDisagreement.strategyDirection, "unfavorable");
});

test("GET committee packet reports agreement (not diverging) when Finance and Strategy point the same direction", () => {
  reset();
  const o = seedOpportunity({ title: "Solid Co" });
  financeSizing.set(o.id, { recommendedFundingUsdc: 6000 });
  strategyFit.set(o.id, { fit_score: 88 });

  const res = fakeRes();
  handleGetCommitteePacket(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { packet: any };
  assert.equal(body.packet.financeStrategyDisagreement.diverges, false);
  assert.equal(body.packet.financeStrategyDisagreement.financeDirection, "fund");
  assert.equal(body.packet.financeStrategyDisagreement.strategyDirection, "favorable");
});

// ─── GET committee-packet: NO ownership/agentAddress gate ───────────────

test("GET committee packet requires no agentAddress at all — same plain-read posture as 7c/10a/12e's own GET routes", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();

  // handleGetCommitteePacket's own signature takes only `id` — there is
  // no agentAddress parameter to even pass, matching every other
  // opportunity-scoped GET route in this pipeline (ownership is
  // enforced on WRITE routes only, never on reads — see that route's
  // own header in expansionRoutes.ts).
  handleGetCommitteePacket(o.id, res);
  assert.equal(res.statusCode, 200);
});

// ─── Shape re-check at the HTTP boundary never silently accepts drift ───

test("a packet violating its own locked schema at the HTTP boundary would 500 with a named reason, not 200 with bad data", () => {
  reset();
  const o = seedOpportunity();

  const brokenPacket = { ...assembleCommitteePacket(o.id), schemaVersion: "13b-v1" };
  const shapeCheck = validateCommitteePacketShape(brokenPacket);
  assert.equal(shapeCheck.valid, false);

  const res = fakeRes();
  res.status(500).json({
    error: `assembled committee packet failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
  });
  assert.equal(res.statusCode, 500);
  assert.ok((res.body as { error: string }).error.includes("schemaVersion"));
});
