// Zent.md Phase 7a: compile_research_report(opportunity_id) — "assembles
// 5b–6d into the single structured report the committee will read."
//
// Same "no live better-sqlite3 in this environment" reason
// expansionRiskScoring.test.ts's/expansionMarketSizeEstimate.test.ts's
// own headers give: this is an inlined mirror of expansion.ts's
// getCurrentResearchFinding() (1c) plus compileResearchReport() (7a)
// itself against plain in-memory data, standing in for
// opportunities/research_findings. Recommend re-running against the
// real expansion.ts/db.ts once a networked environment is available.

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

// ─── Mirrors expansion.ts's ResearchReport shape + compileResearchReport() (7a) ──

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

// mirrors expansion.ts's RESEARCH_REPORT_SCHEMA_VERSION (7b)
const RESEARCH_REPORT_SCHEMA_VERSION = "7b-v1";

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

// ─── compileResearchReport(): unknown opportunity throws ───────────────

test("compile_research_report on an unknown opportunity throws, matching every other Phase 5/6 tool", () => {
  reset();
  assert.throws(() => compileResearchReport("opp_missing"));
});

// ─── compileResearchReport(): known opportunity, nothing run yet ───────

test("compile_research_report on a known opportunity with no research pass yet is all-null, not an error", () => {
  reset();
  const o = seedOpportunity();
  const r = compileResearchReport(o.id);

  assert.equal(r.opportunityId, o.id);
  assert.equal(r.findingId, null);
  assert.equal(r.findingVersion, null);
  assert.equal(r.marketSize, null);
  assert.equal(r.competition, null);
  assert.equal(r.customerSegments, null);
  assert.equal(r.technicalRequirements, null);
  assert.equal(r.regulatoryRisk, null);
  assert.equal(r.buildability, null);
  assert.equal(r.riskScoring, null);
  assert.equal(r.confidence, null);
  assert.equal(r.selfReportedConfidence, null);
  assert.deepEqual(r.sources, []);
});

// ─── compileResearchReport(): full pass, every section populated ───────

test("compile_research_report assembles every 5b-6d section from the current finding", () => {
  reset();
  const o = seedOpportunity();

  mergeIntoCurrentResearchFinding(o.id, {
    market_size: { query: "q-market", results: [], estimatedAt: 1 },
  });
  mergeIntoCurrentResearchFinding(o.id, {
    competition: { query: "q-competition", results: [], surveyedAt: 2 },
  });
  mergeIntoCurrentResearchFinding(o.id, {
    customer_segments: { query: "q-segments", results: [], identifiedAt: 3 },
  });
  mergeIntoCurrentResearchFinding(o.id, {
    technical_requirements: { query: "q-tech", results: [], assessedAt: 4 },
  });
  mergeIntoCurrentResearchFinding(o.id, {
    regulatory_risk: { domains: [], riskLevel: "none", assessedAt: 5 },
  });
  mergeIntoCurrentResearchFinding(o.id, {
    buildability: { matches: [], flagged: true, threshold: 0.2, assessedAt: 6 },
  });
  const afterRiskScoring = mergeIntoCurrentResearchFinding(o.id, {
    risk_scoring: {
      regulatoryRiskLevel: "none",
      buildabilityFlagged: true,
      overallRiskLevel: "medium",
      score: 30,
      scoredAt: 7,
    },
  });
  const afterConfidence = mergeIntoCurrentResearchFinding(o.id, {
    confidence: "med",
    sources: ["https://a.example", "https://b.example"],
    selfReportedConfidence: null,
  });

  const r = compileResearchReport(o.id);

  // Compiled from the single current finding, at its latest version —
  // same "the current finding carries everything" invariant
  // expansionMarketSizeEstimate.test.ts's own "compile-report-style
  // read" comment (7a's eventual job, written ahead of this file)
  // already predicted.
  assert.equal(r.findingId, afterConfidence.id);
  assert.equal(r.findingVersion, afterConfidence.version);
  assert.ok(r.findingVersion! > afterRiskScoring.version - 1);

  assert.deepEqual(r.marketSize, { query: "q-market", results: [], estimatedAt: 1 });
  assert.deepEqual(r.competition, { query: "q-competition", results: [], surveyedAt: 2 });
  assert.deepEqual(r.customerSegments, { query: "q-segments", results: [], identifiedAt: 3 });
  assert.deepEqual(r.technicalRequirements, { query: "q-tech", results: [], assessedAt: 4 });
  assert.deepEqual(r.regulatoryRisk, { domains: [], riskLevel: "none", assessedAt: 5 });
  assert.deepEqual(r.buildability, { matches: [], flagged: true, threshold: 0.2, assessedAt: 6 });
  assert.deepEqual(r.riskScoring, {
    regulatoryRiskLevel: "none",
    buildabilityFlagged: true,
    overallRiskLevel: "medium",
    score: 30,
    scoredAt: 7,
  });
  assert.equal(r.confidence, "med");
  assert.equal(r.selfReportedConfidence, null);
  assert.deepEqual(r.sources, ["https://a.example", "https://b.example"]);
});

// ─── compileResearchReport(): partial pass, only some sections run ─────

test("compile_research_report leaves un-run sections null rather than defaulting them", () => {
  reset();
  const o = seedOpportunity();

  // Only 5b and 6b have run — 5c/5d/6a/6c/6d/5e never did.
  mergeIntoCurrentResearchFinding(o.id, {
    market_size: { query: "q-market", results: [], estimatedAt: 1 },
  });
  mergeIntoCurrentResearchFinding(o.id, {
    regulatory_risk: { domains: [{ domain: "healthcare", matchedKeywords: ["clinic"] }], riskLevel: "high", assessedAt: 2 },
  });

  const r = compileResearchReport(o.id);

  assert.ok(r.marketSize);
  assert.ok(r.regulatoryRisk);
  assert.equal(r.competition, null);
  assert.equal(r.customerSegments, null);
  assert.equal(r.technicalRequirements, null);
  assert.equal(r.buildability, null);
  assert.equal(r.riskScoring, null);
  assert.equal(r.confidence, null);
  assert.deepEqual(r.sources, []);
});

// ─── compileResearchReport(): read-only, never writes a new version ────

test("compile_research_report never creates a new research_findings version, even called repeatedly", () => {
  reset();
  const o = seedOpportunity();
  const v1 = mergeIntoCurrentResearchFinding(o.id, {
    market_size: { query: "q", results: [], estimatedAt: 1 },
  });

  compileResearchReport(o.id);
  compileResearchReport(o.id);
  compileResearchReport(o.id);

  const rowsForOpp = [...table.values()].filter((r) => r.opportunity_id === o.id);
  assert.equal(rowsForOpp.length, 1);
  assert.equal(rowsForOpp[0].id, v1.id);
  assert.equal(rowsForOpp[0].version, 1);
});

// ─── compileResearchReport(): reflects the CURRENT (post-supersede) version ──

test("compile_research_report always reflects the latest version, not a stale earlier one", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, {
    market_size: { query: "q1", results: [], estimatedAt: 1 },
  });
  const v2 = mergeIntoCurrentResearchFinding(o.id, {
    market_size: { query: "q2", results: [], estimatedAt: 2 },
  });

  const r = compileResearchReport(o.id);
  assert.equal(r.findingId, v2.id);
  assert.equal((r.marketSize as { query: string }).query, "q2");
});
