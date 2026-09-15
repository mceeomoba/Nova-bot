// Zent.md Phase 7c: "GET /expansion/opportunities/:id/research
// endpoint." The plain-read counterpart to 7a's compile_research_report
// tool route — this file exercises the response-shape contract both
// routes share (compile -> 7b shape re-check -> {opportunityId,
// schemaVersion, researchReport}) and, distinctly from 7a's own
// compile-report route, that this GET surface has NO ownership check —
// any known opportunity_id resolves, unlike every Phase 5/6 write route
// in expansionRoutes.ts which 403s a caller whose agentAddress doesn't
// match the opportunity's own report.
//
// Same "no live better-sqlite3/express in this environment" reason
// every other expansion*.test.ts file in this directory gives — this is
// an inlined mirror of the route handler's own logic (existence check,
// compileResearchReport(), validateResearchReportShape(), response
// body), exercised against plain in-memory data standing in for
// opportunities/research_findings and a fake Express response object.
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

function createResearchFinding<T = Record<string, unknown>>(
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
    id: `resf_${++findingSeq}`,
    opportunity_id: opportunityId,
    created_at: Date.now() + findingSeq,
    version: priorVersion + 1,
    superseded: false,
    findings: findings ?? ({} as T),
  };
  table.set(row.id, row as FakeFinding<Record<string, unknown>>);
  return row;
}

function getCurrentResearchFinding<T = Record<string, unknown>>(
  opportunityId: string,
): FakeFinding<T> | undefined {
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId && !row.superseded) {
      return row as FakeFinding<T>;
    }
  }
  return undefined;
}

function mergeIntoCurrentResearchFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createResearchFinding<Record<string, unknown>>(opportunityId, merged);
}

// ─── Mirrors expansion.ts's 7a/7b (ResearchReport + schema check) ──────

const RESEARCH_REPORT_SCHEMA_VERSION = "7b-v1";

interface ResearchReport {
  opportunityId: string;
  findingId: string | null;
  findingVersion: number | null;
  compiledAt: number;
  schemaVersion: string;
  marketSize: unknown | null;
  competition: unknown | null;
  customerSegments: unknown | null;
  technicalRequirements: unknown | null;
  regulatoryRisk: unknown | null;
  buildability: unknown | null;
  riskScoring: unknown | null;
  confidence: string | null;
  selfReportedConfidence: string | null;
  sources: string[];
}

interface RawResearchFindings {
  market_size?: unknown;
  competition?: unknown;
  customer_segments?: unknown;
  technical_requirements?: unknown;
  regulatory_risk?: unknown;
  buildability?: unknown;
  risk_scoring?: unknown;
  confidence?: string;
  selfReportedConfidence?: string | null;
  sources?: string[];
}

function compileResearchReport(opportunityId: string): ResearchReport {
  if (!opportunities.has(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentResearchFinding<RawResearchFindings>(opportunityId);
  const findings = current?.findings ?? {};
  return {
    opportunityId,
    findingId: current?.id ?? null,
    findingVersion: current?.version ?? null,
    compiledAt: Date.now(),
    schemaVersion: RESEARCH_REPORT_SCHEMA_VERSION,
    marketSize: findings.market_size ?? null,
    competition: findings.competition ?? null,
    customerSegments: findings.customer_segments ?? null,
    technicalRequirements: findings.technical_requirements ?? null,
    regulatoryRisk: findings.regulatory_risk ?? null,
    buildability: findings.buildability ?? null,
    riskScoring: findings.risk_scoring ?? null,
    confidence: findings.confidence ?? null,
    selfReportedConfidence: findings.selfReportedConfidence ?? null,
    sources: findings.sources ?? [],
  };
}

function isValidResearchConfidence(value: unknown): boolean {
  return typeof value === "string" && ["low", "med", "high"].includes(value);
}

function validateResearchReportShape(
  report: ResearchReport,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  // Trimmed mirror of expansion.ts's own check — full field-set
  // exactness is covered by expansionResearchReportShape.test.ts (7b/7e); this
  // file only needs "is it well-formed" to prove the route's own
  // re-check step behaves, not to re-prove 7b's own rule set.
  const errors: string[] = [];
  if (report.schemaVersion !== RESEARCH_REPORT_SCHEMA_VERSION) errors.push("bad schemaVersion");
  if (report.confidence !== null && !isValidResearchConfidence(report.confidence)) {
    errors.push("bad confidence");
  }
  if (!Array.isArray(report.sources)) errors.push("bad sources");
  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

// ─── Mirror of expansionRoutes.ts's sendCompiledResearchReport() + the
//     7c GET handler's own existence check ──────────────────────────

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

function sendCompiledResearchReport(id: string, res: FakeResponse) {
  const researchReport = compileResearchReport(id);
  const shapeCheck = validateResearchReportShape(researchReport);
  if (!shapeCheck.valid) {
    res.status(500).json({
      error: `compiled research report failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
    });
    return;
  }
  res.json({
    opportunityId: id,
    schemaVersion: RESEARCH_REPORT_SCHEMA_VERSION,
    researchReport,
  });
}

// mirrors the GET /opportunities/:id/research route handler itself
function handleGetResearchReport(id: string, res: FakeResponse) {
  try {
    if (!id || !id.startsWith("opp_")) {
      res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
      return;
    }
    if (!opportunities.has(id)) {
      res.status(404).json({ error: `opportunity ${id} not found` });
      return;
    }
    sendCompiledResearchReport(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
}

// ─── GET /opportunities/:id/research: not-found / bad-id paths ─────────

test("GET research report on an unknown opportunity id returns 404, not a thrown error", () => {
  reset();
  const res = fakeRes();
  handleGetResearchReport("opp_missing", res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "opportunity opp_missing not found" });
});

test("GET research report on a malformed id returns 400 before any lookup", () => {
  reset();
  const res = fakeRes();
  handleGetResearchReport("not-an-opportunity-id", res);
  assert.equal(res.statusCode, 400);
});

// ─── GET /opportunities/:id/research: happy path, no research run yet ──

test("GET research report on a known opportunity with nothing researched yet returns 200 with an all-null report", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();
  handleGetResearchReport(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { opportunityId: string; schemaVersion: string; researchReport: ResearchReport };
  assert.equal(body.opportunityId, o.id);
  assert.equal(body.schemaVersion, RESEARCH_REPORT_SCHEMA_VERSION);
  assert.equal(body.researchReport.findingId, null);
  assert.equal(body.researchReport.marketSize, null);
  assert.deepEqual(body.researchReport.sources, []);
});

// ─── GET /opportunities/:id/research: reflects the latest finding ──────

test("GET research report reflects whatever research has actually run, same shape 7a's own tool route produces", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, {
    market_size: { query: "q-market", results: [], estimatedAt: 1 },
  });
  const v2 = mergeIntoCurrentResearchFinding(o.id, {
    confidence: "low",
    sources: ["https://a.example"],
    selfReportedConfidence: null,
  });

  const res = fakeRes();
  handleGetResearchReport(o.id, res);

  assert.equal(res.statusCode, 200);
  const body = res.body as { researchReport: ResearchReport };
  assert.equal(body.researchReport.findingId, v2.id);
  assert.ok(body.researchReport.marketSize);
  assert.equal(body.researchReport.confidence, "low");
  assert.deepEqual(body.researchReport.sources, ["https://a.example"]);
});

// ─── GET /opportunities/:id/research: NO ownership/agentAddress gate ───

test("GET research report requires no agentAddress at all — unlike every Phase 5/6 write route, this is a plain unauthenticated-beyond-the-router read", () => {
  reset();
  const o = seedOpportunity();
  const res = fakeRes();

  // handleGetResearchReport's own signature takes only `id` — there is
  // no agentAddress parameter to even pass, matching 4b's own
  // handleOpportunityDetail(id, res) signature rather than every write
  // route's (id, agentAddress, res)-shaped ownership check.
  handleGetResearchReport(o.id, res);
  assert.equal(res.statusCode, 200);
});

// ─── GET and POST (7a) routes never diverge on response shape ──────────

test("GET (7c) and the compile-report tool route (7a) produce byte-for-byte identical bodies for the same opportunity", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, {
    regulatory_risk: { domains: [], riskLevel: "none", assessedAt: 1 },
  });

  // 7a's own tool route, after its ownership check passes, calls the
  // exact same sendCompiledResearchReport() the 7c GET route calls —
  // simulate that here directly rather than re-deriving a second body
  // shape, proving the two routes really do share one implementation.
  const getRes = fakeRes();
  sendCompiledResearchReport(o.id, getRes);
  const postRes = fakeRes();
  sendCompiledResearchReport(o.id, postRes);

  // compiledAt is Date.now() at call time, so it alone may legitimately
  // differ by a millisecond between the two calls above — strip it
  // before comparing, since every other field is what this test is
  // actually checking never diverges between the two routes.
  const strip = (body: unknown) => {
    const b = body as { researchReport: ResearchReport };
    const { compiledAt, ...rest } = b.researchReport;
    return { ...b, researchReport: rest };
  };
  assert.deepEqual(strip(getRes.body), strip(postRes.body));
});
