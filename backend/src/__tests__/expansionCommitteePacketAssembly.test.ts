// Zent.md Phase 13a: "expansion_committee construct: not a new
// department type at the data layer — a scheduled read that pulls
// Research + Finance + Strategy reports for one opportunity_id into a
// single packet." This file exercises assembleCommitteePacket() itself:
// that it bundles all four sections (Opportunity Intelligence's own
// report plus Research/Finance/Strategy's compiled ones), that it
// tolerates any subset of those three departments not having run yet
// (13e's completeness gate is a later, separate phase — this function
// itself never blocks), that it throws on an unknown opportunity_id,
// and that it reflects whatever the latest findings currently are
// rather than a stale snapshot.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives —
// assembleCommitteePacket() itself is a pure read over four other pure
// reads (getOpportunity() + the three compile*Report() functions), so
// this is an inlined mirror of that composition, exercised against
// plain in-memory data standing in for opportunities/research_findings/
// finance_findings/strategy_findings. The individual report shapes
// (every field, every type) are already fully covered by
// expansionResearchReportShape.test.ts / expansionFinanceReportShape.test.ts /
// expansionStrategyReportShape.test.ts — this file only needs each
// mirrored compile*Report() to be "close enough" (findingId/one or two
// representative fields) to prove assembly composes them correctly, not
// to re-prove any one report's own full contract. Recommend re-running
// against the real expansion.ts once a networked environment is
// available.
//
// Updated for Phase 13b: assembleCommitteePacket()'s own mirror below
// now also stamps schemaVersion: "13b-v1" on every packet, matching the
// real function's own locked contract — full field-set exactness for
// that contract is covered by expansionCommitteePacketShape.test.ts
// (13b), not re-proven here; this file only needs the mirror to match
// what the real assembly composes.
//
// Updated for Phase 13c: the mirror now also computes and attaches
// financeStrategyDisagreement (reading the same financeReport/
// strategyReport it already assembles) and stamps schemaVersion:
// "13c-v1". Arithmetic coverage for computeFinanceStrategyDisagreement()
// itself lives in expansionFinanceStrategyDisagreement.test.ts — this
// file only needs to prove the field shows up correctly once real
// department findings flow through actual assembly.
//
// Updated for Phase 13e: the mirror now also computes and attaches
// completeness (reading the same three reports' findingId fields plus
// the opportunity's own tags) and stamps schemaVersion: "13e-v1".
// Logic coverage for computeCommitteePacketCompleteness()/
// requireCompleteCommitteePacket() itself lives in
// expansionCommitteePacketCompleteness.test.ts — this file only needs
// to prove the field shows up correctly once real department findings
// (and a real regulatory-risk tag) flow through actual assembly.
//
// Updated for Phase 14a: the mirror now also attaches deliberation (a
// fixed "disabled, nothing filed" stand-in — 14a's own enable/respond
// logic is expansionDeliberation.test.ts's job) and stamps
// schemaVersion: "14a-v1".
//
// Updated for Phase 14b/14c/14d: the mirror now also attaches
// votingRecord (a fixed "nothing voted yet" stand-in — 14b/14c/14d's
// own vote/conditions/timeout logic is expansionDeliberation.test.ts's
// 14b/14c/14d/14e section's job) and stamps schemaVersion: "14d-v1".

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeOpportunity {
  id: string;
  title: string;
  thesis: string;
  roi_score: number | null;
  tags: string[];
}

// Mirrors expansion.ts's own HIGH_REGULATORY_RISK_TAG (6e) — needed
// here only so this file's completeness mirror (13e) has something
// real to read off `tags`, not to re-test 6e's own escalation logic
// (already covered elsewhere).
const HIGH_REGULATORY_RISK_TAG = "high_regulatory_risk";

interface FakeFinding<T = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  created_at: number;
  version: number;
  superseded: boolean;
  findings: T;
}

const opportunities: Map<string, FakeOpportunity> = new Map();
const researchTable: Map<string, FakeFinding> = new Map();
const financeTable: Map<string, FakeFinding> = new Map();
const strategyTable: Map<string, FakeFinding> = new Map();
let oppSeq = 0;
let findingSeq = 0;

function seedOpportunity(overrides: Partial<FakeOpportunity> = {}): FakeOpportunity {
  const o: FakeOpportunity = {
    id: `opp_${++oppSeq}`,
    title: "Untitled",
    thesis: "",
    roi_score: null,
    tags: [],
    ...overrides,
  };
  opportunities.set(o.id, o);
  return o;
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

// ─── Generic finding-table helpers, one instance per department table,
//     same shape createFinding()/getCurrentFinding()/mergeIntoCurrent()
//     already generalize across research/finance/strategy in the real
//     expansion.ts ─────────────────────────────────────────────────────

function makeFindingHelpers(table: Map<string, FakeFinding>, prefix: string) {
  function create<T = Record<string, unknown>>(opportunityId: string, findings: T): FakeFinding<T> {
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
      id: `${prefix}_${++findingSeq}`,
      opportunity_id: opportunityId,
      created_at: Date.now() + findingSeq,
      version: priorVersion + 1,
      superseded: false,
      findings: findings ?? ({} as T),
    };
    table.set(row.id, row as FakeFinding<Record<string, unknown>>);
    return row;
  }
  function getCurrent<T = Record<string, unknown>>(opportunityId: string): FakeFinding<T> | undefined {
    for (const row of table.values()) {
      if (row.opportunity_id === opportunityId && !row.superseded) return row as FakeFinding<T>;
    }
    return undefined;
  }
  function mergeIntoCurrent(opportunityId: string, patch: Record<string, unknown>): FakeFinding {
    const current = getCurrent(opportunityId);
    return create(opportunityId, { ...(current?.findings ?? {}), ...patch });
  }
  return { create, getCurrent, mergeIntoCurrent };
}

const research = makeFindingHelpers(researchTable, "resf");
const finance = makeFindingHelpers(financeTable, "finf");
const strategy = makeFindingHelpers(strategyTable, "stgf");

// Maps are declared `const` above and only ever `.clear()`-ed between
// tests (never reassigned), so the closures each helper set captured at
// module-load time stay valid for the lifetime of this file.
function resetAll() {
  opportunities.clear();
  researchTable.clear();
  financeTable.clear();
  strategyTable.clear();
  oppSeq = 0;
  findingSeq = 0;
}

// ─── Trimmed mirrors of compile*Report() — enough fields to prove
//     assembly composes correctly, not a full shape re-proof ──────────

function compileResearchReport(opportunityId: string) {
  if (!opportunities.has(opportunityId)) throw new Error(`opportunity ${opportunityId} not found`);
  const current = research.getCurrent<{ market_size?: unknown; confidence?: string }>(opportunityId);
  const findings = current?.findings ?? {};
  return {
    opportunityId,
    findingId: current?.id ?? null,
    marketSize: findings.market_size ?? null,
    confidence: findings.confidence ?? null,
  };
}

function compileFinanceReport(opportunityId: string) {
  if (!opportunities.has(opportunityId)) throw new Error(`opportunity ${opportunityId} not found`);
  const current = finance.getCurrent<{ sizing_recommendation?: { recommendedFundingUsdc: number } }>(opportunityId);
  const findings = current?.findings ?? {};
  return {
    opportunityId,
    findingId: current?.id ?? null,
    sizingRecommendation: findings.sizing_recommendation ?? null,
  };
}

function compileStrategyReport(opportunityId: string) {
  if (!opportunities.has(opportunityId)) throw new Error(`opportunity ${opportunityId} not found`);
  const current = strategy.getCurrent<{ fit_score?: { fit_score: number } }>(opportunityId);
  const findings = current?.findings ?? {};
  return {
    opportunityId,
    findingId: current?.id ?? null,
    fitScore: findings.fit_score ?? null,
  };
}

// ─── Mirror of expansion.ts's own computeFinanceStrategyDisagreement() ──
// (13c) — arithmetic itself already fully covered by
// expansionFinanceStrategyDisagreement.test.ts; kept here only so this
// file's assembly mirror can attach a real value to the field.

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

// ─── Mirror of expansion.ts's own computeCommitteePacketCompleteness()
//     (13e) — logic itself already fully covered by
//     expansionCommitteePacketCompleteness.test.ts; kept here only so
//     this file's assembly mirror can attach a real value to the field.

function computeCommitteePacketCompleteness(
  opportunity: FakeOpportunity,
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

// ─── Fixed stand-ins for Phase 14a's deliberation and Phase 14b/14c/14d's
//     votingRecord — this file's own job is proving the four report
//     sections compose correctly through real assembly (13a/13c/13e);
//     the deliberation/voting fields' own logic is
//     expansionDeliberation.test.ts's job (both its 14a section and its
//     14b/14c/14d/14e section), so a fixed "nothing filed yet" value is
//     enough here to keep the mirror's shape honest ─────────────────────

function fixedDeliberation() {
  return { enabled: false, responses: [], respondedDepartments: [], missingDepartments: [], locked: true };
}

function fixedVotingRecord() {
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

// ─── Mirror of expansion.ts's own assembleCommitteePacket() ────────────

function assembleCommitteePacket(opportunityId: string) {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const researchReport = compileResearchReport(opportunityId);
  const financeReport = compileFinanceReport(opportunityId);
  const strategyReport = compileStrategyReport(opportunityId);
  return {
    opportunityId,
    assembledAt: Date.now(),
    // Phase 14b/14c/14d: locked schema tag, copied verbatim as a
    // literal here since this file's own job is assembly composition,
    // not schema-version drift — that's
    // expansionCommitteePacketShape.test.ts's job now.
    schemaVersion: "14d-v1",
    opportunityIntelligence: opportunity,
    researchReport,
    financeReport,
    strategyReport,
    financeStrategyDisagreement: computeFinanceStrategyDisagreement(financeReport, strategyReport),
    completeness: computeCommitteePacketCompleteness(opportunity, researchReport, financeReport, strategyReport),
    deliberation: fixedDeliberation(),
    votingRecord: fixedVotingRecord(),
  };
}

// mirrors expansion.ts's own requireCompleteCommitteePacket() (13e)
function requireCompleteCommitteePacket(opportunityId: string) {
  const packet = assembleCommitteePacket(opportunityId);
  if (!packet.completeness.complete) {
    throw new Error(
      `committee packet for opportunity ${opportunityId} is not ready for a decision — missing report(s): ${packet.completeness.missingReports.join(", ")}`,
    );
  }
  return packet;
}

// ─── Unknown opportunity_id ─────────────────────────────────────────────

test("assembleCommitteePacket throws a clear error for an unknown opportunity_id", () => {
  resetAll();
  assert.throws(() => assembleCommitteePacket("opp_missing"), /opportunity opp_missing not found/);
});

// ─── All four sections present, even before any department has run ────

test("a packet for a freshly-scored opportunity with no department reports yet still has all four sections", () => {
  resetAll();
  const o = seedOpportunity({ title: "Widget Co", thesis: "Widgets for everyone", roi_score: 72 });

  const packet = assembleCommitteePacket(o.id);

  assert.equal(packet.opportunityId, o.id);
  assert.ok(packet.opportunityIntelligence);
  assert.equal(packet.opportunityIntelligence.title, "Widget Co");
  assert.equal(packet.opportunityIntelligence.roi_score, 72);
  assert.ok(packet.researchReport);
  assert.equal(packet.researchReport.findingId, null);
  assert.ok(packet.financeReport);
  assert.equal(packet.financeReport.findingId, null);
  assert.ok(packet.strategyReport);
  assert.equal(packet.strategyReport.findingId, null);
});

// ─── No completeness gate: a partial pass (only some departments have
//     filed) is still assembled, not rejected ─────────────────────────

test("assembleCommitteePacket does not gate on completeness — a packet with only Research filed still assembles", () => {
  resetAll();
  const o = seedOpportunity();
  research.mergeIntoCurrent(o.id, { market_size: { estimate: 100 }, confidence: "med" });

  const packet = assembleCommitteePacket(o.id);

  assert.ok(packet.researchReport.marketSize);
  assert.equal(packet.researchReport.confidence, "med");
  assert.equal(packet.financeReport.findingId, null);
  assert.equal(packet.strategyReport.findingId, null);
});

// ─── Reflects the latest finding from every department at once ─────────

test("a fully-worked opportunity's packet reflects all three departments' latest findings together", () => {
  resetAll();
  const o = seedOpportunity({ title: "Gadget Co", roi_score: 88 });

  research.mergeIntoCurrent(o.id, { market_size: { estimate: 500 } });
  research.mergeIntoCurrent(o.id, { confidence: "high" });
  finance.mergeIntoCurrent(o.id, { sizing_recommendation: { recommendedFundingUsdc: 5000 } });
  strategy.mergeIntoCurrent(o.id, { fit_score: { fit_score: 81 } });

  const packet = assembleCommitteePacket(o.id);

  assert.equal(packet.opportunityIntelligence.title, "Gadget Co");
  assert.ok(packet.researchReport.marketSize);
  assert.equal(packet.researchReport.confidence, "high");
  assert.ok(packet.financeReport.sizingRecommendation);
  assert.ok(packet.strategyReport.fitScore);
  // Finance recommends real funding and Strategy scored it well above
  // the midpoint — both point the same direction, so 13c's own field
  // should read back as agreeing, not flagged.
  assert.equal(packet.financeStrategyDisagreement.diverges, false);
  assert.equal(packet.financeStrategyDisagreement.financeDirection, "fund");
  assert.equal(packet.financeStrategyDisagreement.strategyDirection, "favorable");
});

// ─── Phase 13c: disagreement surfaces through real assembly ────────────

test("assembleCommitteePacket surfaces a real Finance-vs-Strategy disagreement end to end", () => {
  resetAll();
  const o = seedOpportunity({ title: "Risky Co", roi_score: 60 });

  // Finance recommends funding it, but Strategy thinks it's a poor
  // portfolio fit — exactly the "opposite directions" case 13c exists
  // to surface rather than average away.
  finance.mergeIntoCurrent(o.id, { sizing_recommendation: { recommendedFundingUsdc: 2000 } });
  strategy.mergeIntoCurrent(o.id, { fit_score: { fit_score: 15 } });

  const packet = assembleCommitteePacket(o.id);

  assert.equal(packet.financeStrategyDisagreement.diverges, true);
  assert.equal(packet.financeStrategyDisagreement.financeDirection, "fund");
  assert.equal(packet.financeStrategyDisagreement.strategyDirection, "unfavorable");
  assert.equal(packet.financeStrategyDisagreement.recommendedFundingUsdc, 2000);
  assert.equal(packet.financeStrategyDisagreement.fitScore, 15);
});

test("assembleCommitteePacket's financeStrategyDisagreement is present but non-diverging before either department has filed", () => {
  resetAll();
  const o = seedOpportunity();

  const packet = assembleCommitteePacket(o.id);

  assert.ok(packet.financeStrategyDisagreement);
  assert.equal(packet.financeStrategyDisagreement.diverges, false);
  assert.equal(packet.financeStrategyDisagreement.financeDirection, null);
  assert.equal(packet.financeStrategyDisagreement.strategyDirection, null);
});

// ─── Pure read: no side effects, no persistence ─────────────────────────

test("assembling a packet twice in a row writes nothing and produces identical content apart from assembledAt", () => {
  resetAll();
  const o = seedOpportunity({ title: "Idempotent Co" });
  research.mergeIntoCurrent(o.id, { confidence: "low" });

  const before = researchTable.size + financeTable.size + strategyTable.size;
  const first = assembleCommitteePacket(o.id);
  const second = assembleCommitteePacket(o.id);
  const after = researchTable.size + financeTable.size + strategyTable.size;

  assert.equal(before, after, "assembling a packet must not write any new finding rows");
  const strip = (p: ReturnType<typeof assembleCommitteePacket>) => {
    const { assembledAt, ...rest } = p;
    return rest;
  };
  assert.deepEqual(strip(first), strip(second));
});

// ─── Each section is independently sourced — one department's absence
//     doesn't null out another's ────────────────────────────────────────

test("Finance being unfiled doesn't blank out Research's or Strategy's already-filed sections", () => {
  resetAll();
  const o = seedOpportunity();
  research.mergeIntoCurrent(o.id, { confidence: "high" });
  strategy.mergeIntoCurrent(o.id, { fit_score: { fit_score: 50 } });

  const packet = assembleCommitteePacket(o.id);

  assert.equal(packet.researchReport.confidence, "high");
  assert.equal(packet.financeReport.findingId, null);
  assert.ok(packet.strategyReport.fitScore);
});

// ─── Phase 13e: completeness surfaces through real assembly ────────────

test("a freshly-scored opportunity with nothing filed is incomplete, missing all three departments", () => {
  resetAll();
  const o = seedOpportunity();

  const packet = assembleCommitteePacket(o.id);

  assert.equal(packet.completeness.complete, false);
  assert.deepEqual(packet.completeness.missingReports, ["research", "finance", "strategy"]);
  assert.equal(packet.completeness.highRegulatoryRisk, false);
});

test("an opportunity with only Research filed is still incomplete, naming only finance and strategy as missing", () => {
  resetAll();
  const o = seedOpportunity();
  research.mergeIntoCurrent(o.id, { confidence: "med" });

  const packet = assembleCommitteePacket(o.id);

  assert.equal(packet.completeness.complete, false);
  assert.deepEqual(packet.completeness.missingReports, ["finance", "strategy"]);
});

test("an opportunity with all three departments filed is complete, with no missing reports", () => {
  resetAll();
  const o = seedOpportunity();
  research.mergeIntoCurrent(o.id, { confidence: "high" });
  finance.mergeIntoCurrent(o.id, { sizing_recommendation: { recommendedFundingUsdc: 3000 } });
  strategy.mergeIntoCurrent(o.id, { fit_score: { fit_score: 60 } });

  const packet = assembleCommitteePacket(o.id);

  assert.equal(packet.completeness.complete, true);
  assert.deepEqual(packet.completeness.missingReports, []);
});

test("a high_regulatory_risk tag is surfaced on completeness without affecting complete or missingReports either way", () => {
  resetAll();
  const complete = seedOpportunity({ tags: [HIGH_REGULATORY_RISK_TAG] });
  research.mergeIntoCurrent(complete.id, { confidence: "high" });
  finance.mergeIntoCurrent(complete.id, { sizing_recommendation: { recommendedFundingUsdc: 3000 } });
  strategy.mergeIntoCurrent(complete.id, { fit_score: { fit_score: 60 } });

  const completePacket = assembleCommitteePacket(complete.id);
  assert.equal(completePacket.completeness.highRegulatoryRisk, true);
  assert.equal(completePacket.completeness.complete, true);

  const incomplete = seedOpportunity({ tags: [HIGH_REGULATORY_RISK_TAG] });
  const incompletePacket = assembleCommitteePacket(incomplete.id);
  assert.equal(incompletePacket.completeness.highRegulatoryRisk, true);
  assert.equal(incompletePacket.completeness.complete, false);
  assert.deepEqual(incompletePacket.completeness.missingReports, ["research", "finance", "strategy"]);
});

// ─── Phase 13e: requireCompleteCommitteePacket() actually gates ────────

test("requireCompleteCommitteePacket throws, naming the missing department(s), for an incomplete packet", () => {
  resetAll();
  const o = seedOpportunity();
  research.mergeIntoCurrent(o.id, { confidence: "high" });

  assert.throws(
    () => requireCompleteCommitteePacket(o.id),
    /is not ready for a decision — missing report\(s\): finance, strategy/,
  );
});

test("requireCompleteCommitteePacket returns the packet once all three departments have filed", () => {
  resetAll();
  const o = seedOpportunity();
  research.mergeIntoCurrent(o.id, { confidence: "high" });
  finance.mergeIntoCurrent(o.id, { sizing_recommendation: { recommendedFundingUsdc: 3000 } });
  strategy.mergeIntoCurrent(o.id, { fit_score: { fit_score: 60 } });

  const packet = requireCompleteCommitteePacket(o.id);
  assert.equal(packet.completeness.complete, true);
});

test("requireCompleteCommitteePacket does not throw for a complete-but-high-regulatory-risk opportunity", () => {
  resetAll();
  const o = seedOpportunity({ tags: [HIGH_REGULATORY_RISK_TAG] });
  research.mergeIntoCurrent(o.id, { confidence: "high" });
  finance.mergeIntoCurrent(o.id, { sizing_recommendation: { recommendedFundingUsdc: 3000 } });
  strategy.mergeIntoCurrent(o.id, { fit_score: { fit_score: 60 } });

  const packet = requireCompleteCommitteePacket(o.id);
  assert.equal(packet.completeness.highRegulatoryRisk, true);
});

test("requireCompleteCommitteePacket still throws for an incomplete opportunity even when it also has a high_regulatory_risk tag", () => {
  resetAll();
  const o = seedOpportunity({ tags: [HIGH_REGULATORY_RISK_TAG] });
  research.mergeIntoCurrent(o.id, { confidence: "high" });

  // A high-risk tag never substitutes for a missing report and never
  // waives the gate either — the two are unrelated, per this phase's
  // own header in expansion.ts.
  assert.throws(() => requireCompleteCommitteePacket(o.id), /missing report\(s\): finance, strategy/);
});

test("requireCompleteCommitteePacket propagates the unknown-opportunity error from assembleCommitteePacket", () => {
  resetAll();
  assert.throws(() => requireCompleteCommitteePacket("opp_missing"), /opportunity opp_missing not found/);
});
