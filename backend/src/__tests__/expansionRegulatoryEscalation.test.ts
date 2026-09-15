// Zent.md Phase 6e: escalation path — a 6b high-regulatory-risk verdict
// tags the opportunity `high_regulatory_risk` and is weighted into 5e's
// confidence field, without blocking the pipeline.
//
// Same "no live better-sqlite3 in this environment" reason every other
// file in this directory gives (see expansionRegulatoryRisk.test.ts's/
// expansionRiskScoring.test.ts's own headers) — this is an inlined
// mirror of expansion.ts's addOpportunityTag()/applyRegulatoryRiskEscalation()
// (6e) and weighResearchConfidenceForRegulatoryRisk()/recordResearchConfidence()
// (5e+6e), against plain in-memory data standing in for `opportunities`
// and `research_findings`.
//
// Recommend re-running against the real expansion.ts/db.ts once a
// networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

type RegulatoryRiskLevel = "none" | "high";
type ResearchConfidence = "low" | "med" | "high";

// ─── Copied verbatim from expansion.ts's own weighResearchConfidenceForRegulatoryRisk() (6e) ──

function weighResearchConfidenceForRegulatoryRisk(
  confidence: ResearchConfidence,
  regulatoryRiskLevel: RegulatoryRiskLevel | null | undefined,
): { effectiveConfidence: ResearchConfidence; selfReportedConfidence: ResearchConfidence | null } {
  const capped = regulatoryRiskLevel === "high" && confidence === "high";
  return {
    effectiveConfidence: capped ? "med" : confidence,
    selfReportedConfidence: capped ? confidence : null,
  };
}

// ─── weighResearchConfidenceForRegulatoryRisk(): pure rule ──────────────

test("weighing: high confidence + high regulatory risk gets capped to med, self-report preserved", () => {
  const r = weighResearchConfidenceForRegulatoryRisk("high", "high");
  assert.equal(r.effectiveConfidence, "med");
  assert.equal(r.selfReportedConfidence, "high");
});

test("weighing: high confidence + none/unassessed regulatory risk passes through", () => {
  assert.deepEqual(weighResearchConfidenceForRegulatoryRisk("high", "none"), {
    effectiveConfidence: "high",
    selfReportedConfidence: null,
  });
  assert.deepEqual(weighResearchConfidenceForRegulatoryRisk("high", null), {
    effectiveConfidence: "high",
    selfReportedConfidence: null,
  });
  assert.deepEqual(weighResearchConfidenceForRegulatoryRisk("high", undefined), {
    effectiveConfidence: "high",
    selfReportedConfidence: null,
  });
});

test("weighing: med/low confidence is never capped, even under high regulatory risk", () => {
  assert.deepEqual(weighResearchConfidenceForRegulatoryRisk("med", "high"), {
    effectiveConfidence: "med",
    selfReportedConfidence: null,
  });
  assert.deepEqual(weighResearchConfidenceForRegulatoryRisk("low", "high"), {
    effectiveConfidence: "low",
    selfReportedConfidence: null,
  });
});

// ─── addOpportunityTag() + applyRegulatoryRiskEscalation(): merge/versioning ──

interface FakeOpportunity {
  id: string;
  tags: string[];
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

function seedOpportunity(tags: string[] = []): FakeOpportunity {
  const o: FakeOpportunity = { id: `opp_${++oppSeq}`, tags };
  opportunities.set(o.id, o);
  return o;
}

// mirrors expansion.ts's addOpportunityTag() (6e)
function addOpportunityTag(id: string, tag: string): FakeOpportunity {
  const existing = opportunities.get(id);
  if (!existing) {
    throw new Error(`opportunity ${id} not found`);
  }
  if (existing.tags.includes(tag)) {
    return existing;
  }
  const updated = { ...existing, tags: [...existing.tags, tag] };
  opportunities.set(id, updated);
  return updated;
}

// mirrors expansion.ts's createFinding()/createResearchFinding() (1c)
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

const HIGH_REGULATORY_RISK_TAG = "high_regulatory_risk";

// mirrors expansion.ts's applyRegulatoryRiskEscalation() (6e)
function applyRegulatoryRiskEscalation(
  opportunityId: string,
): { escalated: boolean; opportunity: FakeOpportunity } {
  const opportunity = opportunities.get(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentResearchFinding(opportunityId);
  const riskLevel = (
    current?.findings as { regulatory_risk?: { riskLevel: RegulatoryRiskLevel } } | undefined
  )?.regulatory_risk?.riskLevel;
  if (riskLevel !== "high") {
    return { escalated: false, opportunity };
  }
  const tagged = addOpportunityTag(opportunityId, HIGH_REGULATORY_RISK_TAG);
  return { escalated: true, opportunity: tagged };
}

// mirrors expansion.ts's recordResearchConfidence() (5e+6e)
function recordResearchConfidence(
  opportunityId: string,
  confidence: ResearchConfidence,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const regulatoryRiskLevel = (
    current?.findings as { regulatory_risk?: { riskLevel: RegulatoryRiskLevel } } | undefined
  )?.regulatory_risk?.riskLevel;
  const { effectiveConfidence, selfReportedConfidence } = weighResearchConfidenceForRegulatoryRisk(
    confidence,
    regulatoryRiskLevel,
  );
  // Always written explicitly (null when not capped) — merge is
  // additive-only, so omitting the key on an uncapped pass would leak
  // a stale value forward from an earlier capped version.
  return mergeIntoCurrentResearchFinding(opportunityId, {
    confidence: effectiveConfidence,
    sources: [],
    selfReportedConfidence,
  });
}

test("addOpportunityTag is idempotent — tagging twice doesn't duplicate", () => {
  reset();
  const o = seedOpportunity();
  addOpportunityTag(o.id, HIGH_REGULATORY_RISK_TAG);
  const twice = addOpportunityTag(o.id, HIGH_REGULATORY_RISK_TAG);
  assert.deepEqual(twice.tags, [HIGH_REGULATORY_RISK_TAG]);
});

test("addOpportunityTag preserves pre-existing tags", () => {
  reset();
  const o = seedOpportunity(["saas"]);
  const tagged = addOpportunityTag(o.id, HIGH_REGULATORY_RISK_TAG);
  assert.deepEqual(tagged.tags, ["saas", HIGH_REGULATORY_RISK_TAG]);
});

test("applyRegulatoryRiskEscalation is a no-op when 6b hasn't run yet", () => {
  reset();
  const o = seedOpportunity();
  const { escalated, opportunity } = applyRegulatoryRiskEscalation(o.id);
  assert.equal(escalated, false);
  assert.deepEqual(opportunity.tags, []);
});

test("applyRegulatoryRiskEscalation is a no-op when 6b came back clean", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "none" } });
  const { escalated, opportunity } = applyRegulatoryRiskEscalation(o.id);
  assert.equal(escalated, false);
  assert.deepEqual(opportunity.tags, []);
});

test("applyRegulatoryRiskEscalation tags the opportunity when 6b flags high risk", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "high" } });
  const { escalated, opportunity } = applyRegulatoryRiskEscalation(o.id);
  assert.equal(escalated, true);
  assert.deepEqual(opportunity.tags, [HIGH_REGULATORY_RISK_TAG]);
});

test("applyRegulatoryRiskEscalation re-run after risk clears reports escalated:false without untagging", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "high" } });
  applyRegulatoryRiskEscalation(o.id);
  // 6b re-runs later and comes back clean
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "none" } });
  const { escalated, opportunity } = applyRegulatoryRiskEscalation(o.id);
  assert.equal(escalated, false);
  // the historical tag stays — this call doesn't retract it
  assert.deepEqual(opportunity.tags, [HIGH_REGULATORY_RISK_TAG]);
});

test("applyRegulatoryRiskEscalation on an unknown opportunity throws", () => {
  reset();
  assert.throws(() => applyRegulatoryRiskEscalation("opp_missing"));
});

test("recordResearchConfidence caps a high self-report under high regulatory risk, preserves sibling fields", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "high" } });
  const f = recordResearchConfidence(o.id, "high");
  assert.equal(f.findings.confidence, "med");
  assert.equal(f.findings.selfReportedConfidence, "high");
  assert.deepEqual(f.findings.regulatory_risk, { riskLevel: "high" });
});

test("recordResearchConfidence leaves confidence untouched with no regulatory risk on file", () => {
  reset();
  const o = seedOpportunity();
  const f = recordResearchConfidence(o.id, "high");
  assert.equal(f.findings.confidence, "high");
  assert.equal(f.findings.selfReportedConfidence, null);
});

test("recordResearchConfidence versions normally and clears a stale selfReportedConfidence on the next pass", () => {
  reset();
  const o = seedOpportunity();
  mergeIntoCurrentResearchFinding(o.id, { regulatory_risk: { riskLevel: "high" } });
  const v1 = recordResearchConfidence(o.id, "high");
  assert.equal(v1.findings.confidence, "med");
  assert.equal(v1.findings.selfReportedConfidence, "high");

  // A later pass reports "low" — nothing to cap, and the earlier
  // capped version's selfReportedConfidence must NOT leak forward.
  const v2 = recordResearchConfidence(o.id, "low");
  assert.equal(v2.findings.confidence, "low");
  assert.equal(v2.findings.selfReportedConfidence, null);
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
});
