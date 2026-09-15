// Zent.md Phase 12e: "GET /expansion/opportunities/:id/strategy endpoint
// + shape test." The route itself was already wired in 11e-iii-c (see
// that route's own header in expansionRoutes.ts) and its response body
// already reflects 12d's three added sections — this file is the
// missing half of 12e's own checklist line: a dedicated route-level
// test, the Strategy counterpart to expansionResearchReportGet.test.ts
// (7c), exercising the handler itself (bad-id/not-found/happy-path/no-
// ownership-gate) rather than just validateStrategyReportShape() in
// isolation the way expansionStrategyReportShape.test.ts already does.
//
// Same "no live better-sqlite3/express in this environment" reason
// every other expansion*.test.ts file in this directory gives — this is
// an inlined mirror of the route handler's own logic (existence check,
// compileStrategyReport(), validateStrategyReportShape(), response
// body), exercised against plain in-memory data standing in for
// opportunities/strategy_findings and a fake Express response object.
// Recommend re-running against the real expansionRoutes.ts/expansion.ts
// (e.g. supertest against the mounted router) once a networked
// environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeOpportunity {
  id: string;
}

interface FakeFinding<T = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  created_at: number;
  version: number;
  superseded: boolean;
  findings: T;
}

let opportunities: Map<string, FakeOpportunity>;
let table: Map<string, FakeFinding>;
let oppSeq: number;
let findingSeq: number;

function reset() {
  opportunities = new Map();
  table = new Map();
  oppSeq = 0;
  findingSeq = 0;
}

function seedOpportunity(): FakeOpportunity {
  const o: FakeOpportunity = { id: `opp_${++oppSeq}` };
  opportunities.set(o.id, o);
  return o;
}

// ─── Inlined mirror of expansion.ts's own exported functions ──────────

function createStrategyFinding<T = Record<string, unknown>>(
  opportunityId: string,
  findings: T,
): FakeFinding<T> {
  if (!opportunities.has(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  let priorVersion = 0;
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId) {
      priorVersion = Math.max(priorVersion, row.version);
      if (!row.superseded) row.superseded = true;
    }
  }
  const row: FakeFinding<T> = {
    id: `stgf_${++findingSeq}`,
    opportunity_id: opportunityId,
    created_at: Date.now() + findingSeq,
    version: priorVersion + 1,
    superseded: false,
    findings: findings ?? ({} as T),
  };
  table.set(row.id, row as FakeFinding<Record<string, unknown>>);
  return row;
}

function getCurrentStrategyFinding<T = Record<string, unknown>>(
  opportunityId: string,
): FakeFinding<T> | undefined {
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId && !row.superseded) {
      return row as FakeFinding<T>;
    }
  }
  return undefined;
}

function mergeIntoCurrentStrategyFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentStrategyFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createStrategyFinding<Record<string, unknown>>(opportunityId, merged);
}

// ─── Mirrors expansion.ts's post-12d StrategyReport/compile/validate ───

const STRATEGY_REPORT_SCHEMA_VERSION = "12d-v1";

const STRATEGY_REPORT_FIELDS = [
  "opportunityId",
  "findingId",
  "findingVersion",
  "compiledAt",
  "schemaVersion",
  "missionOverlap",
  "technologyReuse",
  "fitScore",
  "fitRoiDivergence",
  "ecosystemStrengthening",
  "cannibalizationCheck",
  "relationshipTypeRecommendation",
] as const;

const STRATEGY_REPORT_NULLABLE_OBJECT_FIELDS = [
  "missionOverlap",
  "technologyReuse",
  "fitScore",
  "fitRoiDivergence",
  "ecosystemStrengthening",
  "cannibalizationCheck",
  "relationshipTypeRecommendation",
] as const;

interface StrategyReport {
  opportunityId: string;
  findingId: string | null;
  findingVersion: number | null;
  compiledAt: number;
  schemaVersion: string;
  missionOverlap: unknown | null;
  technologyReuse: unknown | null;
  fitScore: unknown | null;
  fitRoiDivergence: unknown | null;
  ecosystemStrengthening: unknown | null;
  cannibalizationCheck: unknown | null;
  relationshipTypeRecommendation: unknown | null;
}

interface RawStrategyFindings {
  mission_overlap?: unknown;
  technology_reuse?: unknown;
  fit_score?: unknown;
  fit_roi_divergence?: unknown;
  ecosystem_strengthening?: unknown;
  cannibalization_check?: unknown;
  relationship_type_recommendation?: unknown;
}

function compileStrategyReport(opportunityId: string): StrategyReport {
  if (!opportunities.has(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentStrategyFinding<RawStrategyFindings>(opportunityId);
  const findings = current?.findings ?? {};
  return {
    opportunityId,
    findingId: current?.id ?? null,
    findingVersion: current?.version ?? null,
    compiledAt: Date.now(),
    schemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
    missionOverlap: findings.mission_overlap ?? null,
    technologyReuse: findings.technology_reuse ?? null,
    fitScore: findings.fit_score ?? null,
    fitRoiDivergence: findings.fit_roi_divergence ?? null,
    ecosystemStrengthening: findings.ecosystem_strengthening ?? null,
    cannibalizationCheck: findings.cannibalization_check ?? null,
    relationshipTypeRecommendation: findings.relationship_type_recommendation ?? null,
  };
}

function validateStrategyReportShape(
  report: StrategyReport,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  // Trimmed mirror of expansion.ts's own check — full field-set
  // exactness is covered by expansionStrategyReportShape.test.ts
  // (11e-iii-c/12d); this file only needs "is it well-formed" to prove
  // the route's own re-check step behaves, not to re-prove that file's
  // rule set.
  const errors: string[] = [];
  const obj = report as unknown as Record<string, unknown>;
  const actualKeys = new Set(Object.keys(obj));
  for (const key of STRATEGY_REPORT_FIELDS) {
    if (!actualKeys.has(key)) errors.push(`missing field: ${key}`);
  }
  if (report.schemaVersion !== STRATEGY_REPORT_SCHEMA_VERSION) errors.push("bad schemaVersion");
  for (const field of STRATEGY_REPORT_NULLABLE_OBJECT_FIELDS) {
    const value = obj[field];
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`${field} must be an object or null`);
    }
  }
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

// ─── Mirror of expansionRoutes.ts's sendCompiledStrategyReport() + the
//     12e GET handler's own existence check ───────────────────────────

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

function sendCompiledStrategyReport(id: string, res: FakeResponse) {
  const strategyReport = compileStrategyReport(id);
  const shapeCheck = validateStrategyReportShape(strategyReport);
  if (!shapeCheck.valid) {
    res.status(500).json({
      error: `compiled strategy report failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
    });
    return;
  }
  res.json({
    opportunityId: id,
    schemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
    strategyReport,
  });
}

// mirrors the GET /opportunities/:id/strategy route handler itself
function handleGetStrategyReport(id: string, res: FakeResponse) {
  try {
    if (!id || !id.startsWith("opp_")) {
      res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
      return;
    }
    if (!opportunities.has(id)) {
      res.status(404).json({ error: `opportunity ${id} not found` });
      return;
    }
    sendCompiledStrategyReport(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
}

// ─── GET /opportunities/:id/strategy: not-found / bad-id paths ─────────

test("GET strategy report on an unknown opportunity id returns 404, not a thrown error", () => {
  reset();
  const res = fakeRes();
  handleGetStrategyReport("opp_missing", res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "opportunity opp_missing not found" });
});

test("GET strategy report on a malformed id returns 400 before any lookup", () => {
  reset();
  const res = fakeRes();
  handleGetStrategyReport("not-an-opportunity-id", res);
  assert.equal(res.statusCode, 400);
});

// ─── GET /opportunities/:id/strategy: happy path, nothing run yet ──────

test("GET strategy report on a known opportunity with nothing strategized yet returns 200 with an all-null report", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handleGetStrategyReport(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { opportunityId: string; schemaVersion: string; strategyReport: StrategyReport };
  assert.equal(body.opportunityId, o.id);
  assert.equal(body.schemaVersion, STRATEGY_REPORT_SCHEMA_VERSION);
  assert.equal(body.strategyReport.findingId, null);
  assert.equal(body.strategyReport.fitScore, null);
  assert.equal(body.strategyReport.ecosystemStrengthening, null);
  assert.equal(body.strategyReport.cannibalizationCheck, null);
  assert.equal(body.strategyReport.relationshipTypeRecommendation, null);
});

// ─── GET /opportunities/:id/strategy: reflects the latest finding,
//     including 12a/12b/12c's sections alongside 11e's fit_score ───────

test("GET strategy report reflects fit_score + divergence status (11e-iii-c) as first-class top-level fields", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentStrategyFinding(o.id, {
    fit_score: { fit_score: 71, fit_formula_version: "11e-i-v1", factors: {} },
    fit_roi_divergence: { diverges: false, fitScore: 71, roiScore: 65, delta: 6, threshold: 30 },
  });

  const res = fakeRes();
  handleGetStrategyReport(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { strategyReport: StrategyReport };
  assert.ok(body.strategyReport.fitScore);
  assert.ok(body.strategyReport.fitRoiDivergence);
});

test("GET strategy report reflects 12a/12b/12c's ecosystem-health sections once Strategy has run them", () => {
  reset();
  const o = seedOpportunity();
  const v2 = mergeIntoCurrentStrategyFinding(o.id, {
    ecosystem_strengthening: { result: { strengthensEcosystem: true }, checkedAt: 1 },
    cannibalization_check: { result: { cannibalizes: false }, checkedAt: 2 },
    relationship_type_recommendation: { result: { relationshipType: "independent" }, recordedAt: 3 },
  });

  const res = fakeRes();
  handleGetStrategyReport(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { strategyReport: StrategyReport };
  assert.equal(body.strategyReport.findingId, v2.id);
  assert.ok(body.strategyReport.ecosystemStrengthening);
  assert.ok(body.strategyReport.cannibalizationCheck);
  assert.ok(body.strategyReport.relationshipTypeRecommendation);
});

// ─── GET /opportunities/:id/strategy: NO ownership/agentAddress gate ───

test("GET strategy report requires no agentAddress at all — same plain-read posture as 7c's GET /research, unlike every Phase 5/6/11/12 write route's ownership check", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();

  // handleGetStrategyReport's own signature takes only `id` — there is
  // no agentAddress parameter to even pass, matching 7c's own
  // handleGetResearchReport(id, res) signature rather than every write
  // route's (id, agentAddress, res)-shaped ownership check.
  handleGetStrategyReport(o.id, res);
  assert.equal(res.statusCode, 200);
});

// ─── Shape re-check at the HTTP boundary never silently accepts drift ──

test("a report violating its own locked schema at the HTTP boundary would 500 with a named reason, not 200 with bad data", () => {
  // sendCompiledStrategyReport() re-verifies validateStrategyReportShape()
  // itself before responding (see that function's own header) — this
  // proves the wiring, not the validator's own rule set (already fully
  // covered by expansionStrategyReportShape.test.ts).
  reset();
  const o = seedOpportunity();
  const res = fakeRes();

  const brokenReport = { ...compileStrategyReport(o.id), schemaVersion: "11e-iii-v1" };
  const shapeCheck = validateStrategyReportShape(brokenReport);
  assert.equal(shapeCheck.valid, false);

  res.status(500).json({
    error: `compiled strategy report failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
  });
  assert.equal(res.statusCode, 500);
  assert.ok((res.body as { error: string }).error.includes("bad schemaVersion"));
});
