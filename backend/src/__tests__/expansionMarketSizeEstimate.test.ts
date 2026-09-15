// Zent.md Phase 5b/5c/5d/5e: estimate_market_size(opportunity_id),
// survey_competition(opportunity_id),
// identify_customer_segments(opportunity_id), and
// report_research_confidence(opportunity_id, confidence).
//
// Same "no live better-sqlite3 in this environment" reason
// expansionFindings.test.ts's own header gives — this is an inlined
// mirror of createFinding()/getCurrentFinding() (1c) plus
// mergeIntoCurrentResearchFinding()/recordMarketSizeEstimate() (5b)
// against plain in-memory data, standing in for research_findings.
// Recommend re-running against the real expansion.ts/db.ts once a
// networked environment is available.

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

// mirrors expansion.ts's mergeIntoCurrentResearchFinding()
function mergeIntoCurrentResearchFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createResearchFinding<Record<string, unknown>>(opportunityId, merged);
}

// mirrors expansion.ts's recordMarketSizeEstimate()
function recordMarketSizeEstimate(
  opportunityId: string,
  estimate: { query: string; results: unknown[]; estimatedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { market_size: estimate });
}

// mirrors expansion.ts's recordCompetitionSurvey() (Phase 5c)
function recordCompetitionSurvey(
  opportunityId: string,
  survey: { query: string; results: unknown[]; surveyedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { competition: survey });
}

// mirrors expansion.ts's recordCustomerSegments() (Phase 5d)
function recordCustomerSegments(
  opportunityId: string,
  segments: { query: string; results: unknown[]; identifiedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { customer_segments: segments });
}

// mirrors expansion.ts's collectCurrentResearchSources() (Phase 5e)
function collectCurrentResearchSources(opportunityId: string): string[] {
  const current = getCurrentResearchFinding(opportunityId);
  if (!current) return [];
  const findings = current.findings as {
    market_size?: { results: { url?: string }[] };
    competition?: { results: { url?: string }[] };
    customer_segments?: { results: { url?: string }[] };
  };
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const section of [
    findings.market_size,
    findings.competition,
    findings.customer_segments,
  ]) {
    for (const result of section?.results ?? []) {
      if (result?.url && !seen.has(result.url)) {
        seen.add(result.url);
        urls.push(result.url);
      }
    }
  }
  return urls;
}

// mirrors expansion.ts's recordResearchConfidence() (Phase 5e)
function recordResearchConfidence(
  opportunityId: string,
  confidence: "low" | "med" | "high",
): FakeFinding<Record<string, unknown>> {
  const sources = collectCurrentResearchSources(opportunityId);
  return mergeIntoCurrentResearchFinding(opportunityId, { confidence, sources });
}

// ─── Tests ──────────────────────────────────────────────────────────

test("estimate_market_size on a fresh opportunity starts research_findings at version 1", () => {
  reset();
  const o = seedOpportunity();
  const f = recordMarketSizeEstimate(o.id, {
    query: '"Foo" market size total addressable market',
    results: [{ title: "t", url: "u", snippet: "s" }],
    estimatedAt: 1000,
  });
  assert.equal(f.version, 1);
  assert.equal(f.superseded, false);
  assert.deepEqual(Object.keys(f.findings), ["market_size"]);
});

test("re-running estimate_market_size supersedes the prior version, matching 1c", () => {
  reset();
  const o = seedOpportunity();
  const v1 = recordMarketSizeEstimate(o.id, {
    query: "q1",
    results: [],
    estimatedAt: 1,
  });
  const v2 = recordMarketSizeEstimate(o.id, {
    query: "q2",
    results: [],
    estimatedAt: 2,
  });

  assert.equal(v2.version, 2);
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
  assert.equal((current?.findings.market_size as any).query, "q2");

  // v1 is retained in history, just marked superseded — never destroyed
  assert.equal(table.get(v1.id)?.superseded, true);
});

test("estimate_market_size preserves a sibling field already on the current finding", () => {
  reset();
  const o = seedOpportunity();
  // Stand-in for a Phase 5c/5d tool (e.g. survey_competition) having
  // already written its own key onto the current research finding.
  const withCompetition = mergeIntoCurrentResearchFinding(o.id, {
    competition: { incumbents: ["Acme"] },
  });
  assert.equal(withCompetition.version, 1);

  const withMarketSize = recordMarketSizeEstimate(o.id, {
    query: "q",
    results: [],
    estimatedAt: 5,
  });

  assert.equal(withMarketSize.version, 2);
  assert.deepEqual(withMarketSize.findings.competition, { incumbents: ["Acme"] });
  assert.ok("market_size" in withMarketSize.findings);
});

test("estimate_market_size on an unknown opportunity throws, matching createFinding's own guard", () => {
  reset();
  assert.throws(() =>
    recordMarketSizeEstimate("opp_missing", { query: "q", results: [], estimatedAt: 1 }),
  );
});

test("survey_competition on a fresh opportunity starts research_findings at version 1", () => {
  reset();
  const o = seedOpportunity();
  const f = recordCompetitionSurvey(o.id, {
    query: '"Foo" competitors pricing alternatives',
    results: [{ title: "Acme", url: "u", snippet: "s" }],
    surveyedAt: 1000,
  });
  assert.equal(f.version, 1);
  assert.equal(f.superseded, false);
  assert.deepEqual(Object.keys(f.findings), ["competition"]);
});

test("re-running survey_competition supersedes the prior version, matching 1c", () => {
  reset();
  const o = seedOpportunity();
  const v1 = recordCompetitionSurvey(o.id, { query: "q1", results: [], surveyedAt: 1 });
  const v2 = recordCompetitionSurvey(o.id, { query: "q2", results: [], surveyedAt: 2 });

  assert.equal(v2.version, 2);
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
  assert.equal((current?.findings.competition as any).query, "q2");
  assert.equal(table.get(v1.id)?.superseded, true);
});

test("estimate_market_size and survey_competition accumulate onto the same finding without clobbering each other", () => {
  reset();
  const o = seedOpportunity();

  const afterMarketSize = recordMarketSizeEstimate(o.id, {
    query: "q-market",
    results: [],
    estimatedAt: 1,
  });
  assert.equal(afterMarketSize.version, 1);
  assert.deepEqual(Object.keys(afterMarketSize.findings), ["market_size"]);

  const afterCompetition = recordCompetitionSurvey(o.id, {
    query: "q-competition",
    results: [],
    surveyedAt: 2,
  });
  assert.equal(afterCompetition.version, 2);
  assert.ok("market_size" in afterCompetition.findings);
  assert.ok("competition" in afterCompetition.findings);

  // running estimate_market_size again supersedes v2 but keeps competition
  const afterSecondMarketSize = recordMarketSizeEstimate(o.id, {
    query: "q-market-2",
    results: [],
    estimatedAt: 3,
  });
  assert.equal(afterSecondMarketSize.version, 3);
  assert.equal((afterSecondMarketSize.findings.market_size as any).query, "q-market-2");
  assert.deepEqual(afterSecondMarketSize.findings.competition, {
    query: "q-competition",
    results: [],
    surveyedAt: 2,
  });
});

test("survey_competition on an unknown opportunity throws, matching createFinding's own guard", () => {
  reset();
  assert.throws(() =>
    recordCompetitionSurvey("opp_missing", { query: "q", results: [], surveyedAt: 1 }),
  );
});

test("identify_customer_segments on a fresh opportunity starts research_findings at version 1", () => {
  reset();
  const o = seedOpportunity();
  const f = recordCustomerSegments(o.id, {
    query: 'who buys "Foo" how do they solve it today',
    results: [{ title: "Buyer forum", url: "u", snippet: "s" }],
    identifiedAt: 1000,
  });
  assert.equal(f.version, 1);
  assert.equal(f.superseded, false);
  assert.deepEqual(Object.keys(f.findings), ["customer_segments"]);
});

test("re-running identify_customer_segments supersedes the prior version, matching 1c", () => {
  reset();
  const o = seedOpportunity();
  const v1 = recordCustomerSegments(o.id, { query: "q1", results: [], identifiedAt: 1 });
  const v2 = recordCustomerSegments(o.id, { query: "q2", results: [], identifiedAt: 2 });

  assert.equal(v2.version, 2);
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
  assert.equal((current?.findings.customer_segments as any).query, "q2");
  assert.equal(table.get(v1.id)?.superseded, true);
});

test("identify_customer_segments on an unknown opportunity throws, matching createFinding's own guard", () => {
  reset();
  assert.throws(() =>
    recordCustomerSegments("opp_missing", { query: "q", results: [], identifiedAt: 1 }),
  );
});

test("all three research tools (5b/5c/5d) accumulate onto one finding without clobbering each other", () => {
  reset();
  const o = seedOpportunity();

  recordMarketSizeEstimate(o.id, { query: "q-market", results: [], estimatedAt: 1 });
  recordCompetitionSurvey(o.id, { query: "q-competition", results: [], surveyedAt: 2 });
  const afterAllThree = recordCustomerSegments(o.id, {
    query: "q-segments",
    results: [],
    identifiedAt: 3,
  });

  assert.equal(afterAllThree.version, 3);
  assert.deepEqual(
    new Set(Object.keys(afterAllThree.findings)),
    new Set(["market_size", "competition", "customer_segments"]),
  );

  // Compile-report-style read (7a's eventual job): the single current
  // finding carries all three departments' worth of raw evidence.
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.version, 3);
  assert.equal((current?.findings.market_size as any).query, "q-market");
  assert.equal((current?.findings.competition as any).query, "q-competition");
  assert.equal((current?.findings.customer_segments as any).query, "q-segments");

  // and history is fully retained, three superseded rows plus the current one
  const allVersions = [...table.values()].filter((r) => r.opportunity_id === o.id);
  assert.equal(allVersions.length, 3);
  assert.equal(allVersions.filter((r) => r.superseded).length, 2);
});

test("report_research_confidence with no prior research passes yields zero sources, a valid state", () => {
  reset();
  const o = seedOpportunity();
  const f = recordResearchConfidence(o.id, "low");
  assert.equal(f.version, 1);
  assert.equal(f.findings.confidence, "low");
  assert.deepEqual(f.findings.sources, []);
});

test("report_research_confidence computes sources from prior 5b/5c/5d results, deduped", () => {
  reset();
  const o = seedOpportunity();

  recordMarketSizeEstimate(o.id, {
    query: "q-market",
    results: [
      { title: "A", url: "https://a.example", snippet: "" },
      { title: "B", url: "https://b.example", snippet: "" },
    ],
    estimatedAt: 1,
  });
  recordCompetitionSurvey(o.id, {
    query: "q-competition",
    // duplicate URL with market_size's own "A" result, plus one new one
    results: [
      { title: "A again", url: "https://a.example", snippet: "" },
      { title: "C", url: "https://c.example", snippet: "" },
    ],
    surveyedAt: 2,
  });

  const f = recordResearchConfidence(o.id, "high");
  assert.equal(f.version, 3);
  assert.equal(f.findings.confidence, "high");
  assert.deepEqual(f.findings.sources, [
    "https://a.example",
    "https://b.example",
    "https://c.example",
  ]);
  // confidence-reporting itself never invents or drops the underlying
  // evidence sections — they ride along on the merged finding too.
  assert.ok("market_size" in f.findings);
  assert.ok("competition" in f.findings);
});

test("report_research_confidence ignores any caller-supplied sources — sources is always recomputed, never trusted input", () => {
  reset();
  const o = seedOpportunity();
  recordMarketSizeEstimate(o.id, {
    query: "q",
    results: [{ title: "Real", url: "https://real.example", snippet: "" }],
    estimatedAt: 1,
  });

  // recordResearchConfidence()'s own signature takes no `sources`
  // argument at all — this test documents that as a deliberate design
  // choice (see expansion.ts's own 5e header comment), not just an
  // omission: a caller cannot smuggle in a fabricated source list even
  // if they tried, because the function has nowhere to put one.
  const f = recordResearchConfidence(o.id, "med");
  assert.deepEqual(f.findings.sources, ["https://real.example"]);
});

test("re-reporting confidence supersedes the prior version and can change level as new passes land", () => {
  reset();
  const o = seedOpportunity();
  const v1 = recordResearchConfidence(o.id, "low");
  assert.equal(v1.findings.confidence, "low");

  recordCompetitionSurvey(o.id, {
    query: "q",
    results: [{ title: "New", url: "https://new.example", snippet: "" }],
    surveyedAt: 2,
  });
  const v3 = recordResearchConfidence(o.id, "high");

  assert.equal(v3.version, 3);
  assert.equal(v3.findings.confidence, "high");
  assert.deepEqual(v3.findings.sources, ["https://new.example"]);
  assert.equal(table.get(v1.id)?.superseded, true);
});
