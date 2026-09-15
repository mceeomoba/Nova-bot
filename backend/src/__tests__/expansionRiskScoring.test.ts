// Zent.md Phase 6d: risk scoring merged into research_findings alongside
// the market data — Research produces one report per opportunity, not two.
//
// Same "no live better-sqlite3 in this environment" reason
// expansionBuildability.test.ts's/expansionRegulatoryRisk.test.ts's own
// headers give: the merge/versioning/invariant half of this file is an
// inlined mirror of expansion.ts's createFinding()/
// mergeIntoCurrentResearchFinding()/countCurrentResearchFindings(), and
// scoreResearchRisk() itself is copied verbatim (it's pure — no db.js
// import) rather than re-derived, so the actual scoring rule under test
// is the real one.
//
// Recommend re-running the merge/versioning/invariant half against the
// real expansion.ts/db.ts once a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Copied verbatim from expansion.ts's own scoreResearchRisk() (6d) ──

type RegulatoryRiskLevel = "none" | "high";
type ResearchOverallRiskLevel = "unknown" | "low" | "medium" | "high";

const RESEARCH_RISK_WEIGHTS = {
  regulatoryHigh: 70,
  buildabilityFlagged: 30,
} as const;

function scoreResearchRisk(
  regulatoryRiskLevel: RegulatoryRiskLevel | null,
  buildabilityFlagged: boolean | null,
): { overallRiskLevel: ResearchOverallRiskLevel; score: number } {
  if (regulatoryRiskLevel === null && buildabilityFlagged === null) {
    return { overallRiskLevel: "unknown", score: 0 };
  }
  const score =
    (regulatoryRiskLevel === "high" ? RESEARCH_RISK_WEIGHTS.regulatoryHigh : 0) +
    (buildabilityFlagged === true ? RESEARCH_RISK_WEIGHTS.buildabilityFlagged : 0);
  const overallRiskLevel: ResearchOverallRiskLevel =
    score >= RESEARCH_RISK_WEIGHTS.regulatoryHigh
      ? "high"
      : score >= RESEARCH_RISK_WEIGHTS.buildabilityFlagged
        ? "medium"
        : "low";
  return { overallRiskLevel, score };
}

// ─── scoreResearchRisk(): pure rule, every combination ─────────────────

test("scoreResearchRisk: neither 6b nor 6c has run yet -> unknown, not low", () => {
  const { overallRiskLevel, score } = scoreResearchRisk(null, null);
  assert.equal(overallRiskLevel, "unknown");
  assert.equal(score, 0);
});

test("scoreResearchRisk: regulatory none, buildability not yet assessed -> low", () => {
  const { overallRiskLevel, score } = scoreResearchRisk("none", null);
  assert.equal(overallRiskLevel, "low");
  assert.equal(score, 0);
});

test("scoreResearchRisk: regulatory not yet assessed, buildability clean -> low", () => {
  const { overallRiskLevel, score } = scoreResearchRisk(null, false);
  assert.equal(overallRiskLevel, "low");
  assert.equal(score, 0);
});

test("scoreResearchRisk: buildability flagged alone -> medium, not high", () => {
  const { overallRiskLevel, score } = scoreResearchRisk("none", true);
  assert.equal(score, 30);
  assert.equal(overallRiskLevel, "medium");
});

test("scoreResearchRisk: high regulatory risk alone -> high, regardless of buildability", () => {
  const { overallRiskLevel, score } = scoreResearchRisk("high", false);
  assert.equal(score, 70);
  assert.equal(overallRiskLevel, "high");
});

test("scoreResearchRisk: high regulatory risk + flagged buildability -> high, capped sensibly", () => {
  const { overallRiskLevel, score } = scoreResearchRisk("high", true);
  assert.equal(score, 100);
  assert.equal(overallRiskLevel, "high");
});

test("scoreResearchRisk: both clean -> low", () => {
  const { overallRiskLevel, score } = scoreResearchRisk("none", false);
  assert.equal(overallRiskLevel, "low");
  assert.equal(score, 0);
});

// ─── computeAndRecordResearchRiskScoring() + the single-report invariant ─
// Inlined mirror of expansion.ts's createFinding() (1c, with its
// supersede-then-insert transaction) and mergeIntoCurrentResearchFinding()
// (5b), plus countCurrentResearchFindings() (6d).

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

// mirrors expansion.ts's createFinding()/createResearchFinding() (1c) —
// the same supersede-then-insert transaction that makes "one report,
// not two" true by construction.
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

// mirrors expansion.ts's mergeIntoCurrentResearchFinding()
function mergeIntoCurrentResearchFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createResearchFinding<Record<string, unknown>>(opportunityId, merged);
}

// mirrors expansion.ts's countCurrentResearchFindings() (6d)
function countCurrentResearchFindings(opportunityId: string): number {
  let count = 0;
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId && !row.superseded) count += 1;
  }
  return count;
}

// mirrors expansion.ts's computeAndRecordResearchRiskScoring() (6d)
function computeAndRecordResearchRiskScoring(
  opportunityId: string,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const findings = current?.findings as
    | { regulatory_risk?: { riskLevel: RegulatoryRiskLevel }; buildability?: { flagged: boolean } }
    | undefined;
  const regulatoryRiskLevel = findings?.regulatory_risk?.riskLevel ?? null;
  const buildabilityFlagged = findings?.buildability?.flagged ?? null;
  const { overallRiskLevel, score } = scoreResearchRisk(regulatoryRiskLevel, buildabilityFlagged);
  return mergeIntoCurrentResearchFinding(opportunityId, {
    risk_scoring: { regulatoryRiskLevel, buildabilityFlagged, overallRiskLevel, score, scoredAt: 1 },
  });
}

test("score-risk on a fresh opportunity (6b/6c haven't run) records unknown, version 1", () => {
  reset();
  const o = seedOpportunity();
  const f = computeAndRecordResearchRiskScoring(o.id);
  assert.equal(f.version, 1);
  const scoring = f.findings.risk_scoring as any;
  assert.equal(scoring.overallRiskLevel, "unknown");
  assert.equal(scoring.regulatoryRiskLevel, null);
  assert.equal(scoring.buildabilityFlagged, null);
});

test("score-risk after 6b and 6c have both run reads their real verdicts", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "high" } });
  mergeIntoCurrentResearchFinding(o.id, { buildability: { flagged: true } });
  const f = computeAndRecordResearchRiskScoring(o.id);
  const scoring = f.findings.risk_scoring as any;
  assert.equal(scoring.regulatoryRiskLevel, "high");
  assert.equal(scoring.buildabilityFlagged, true);
  assert.equal(scoring.overallRiskLevel, "high");
  assert.equal(scoring.score, 100);
  // sibling fields (5b/6b/6c) survive the merge — never clobbered
  assert.deepEqual(f.findings.regulatory_risk, { riskLevel: "high" });
  assert.deepEqual(f.findings.buildability, { flagged: true });
});

test("re-scoring after 6c lands later reflects the new signal, superseding the earlier pass", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "none" } });
  const v1 = computeAndRecordResearchRiskScoring(o.id);
  assert.equal((v1.findings.risk_scoring as any).overallRiskLevel, "low");

  // 6c runs afterwards, flagging a gap
  mergeIntoCurrentResearchFinding(o.id, { buildability: { flagged: true } });
  const v2 = computeAndRecordResearchRiskScoring(o.id);
  assert.equal((v2.findings.risk_scoring as any).overallRiskLevel, "medium");
  assert.ok(v2.version > v1.version);

  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
});

test("6d's core invariant: any number of 5b/6a/6b/6c/6d passes leave exactly one current report", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { market_size: { query: "q", results: [] } });
  mergeIntoCurrentResearchFinding(o.id, { technical_requirements: { query: "q", results: [] } });
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "high" } });
  mergeIntoCurrentResearchFinding(o.id, { buildability: { flagged: false } });
  computeAndRecordResearchRiskScoring(o.id);
  computeAndRecordResearchRiskScoring(o.id); // re-scored again, still just one report

  assert.equal(countCurrentResearchFindings(o.id), 1);

  const current = getCurrentResearchFinding(o.id)!;
  // every prior tool's field is still present on the ONE current report
  assert.ok("market_size" in current.findings);
  assert.ok("technical_requirements" in current.findings);
  assert.ok("regulatory_risk" in current.findings);
  assert.ok("buildability" in current.findings);
  assert.ok("risk_scoring" in current.findings);
  assert.equal((current.findings.risk_scoring as any).overallRiskLevel, "high");
});

test("score-risk on an unknown opportunity throws, matching createFinding's own guard", () => {
  reset();
  assert.throws(() => computeAndRecordResearchRiskScoring("opp_missing"));
});
