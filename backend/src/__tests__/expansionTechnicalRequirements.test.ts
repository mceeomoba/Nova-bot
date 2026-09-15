// Zent.md Phase 6a: assess_technical_requirements(opportunity_id).
//
// Same "no live better-sqlite3 in this environment" reason
// expansionMarketSizeEstimate.test.ts's own header gives — this is an
// inlined mirror of createFinding()/getCurrentFinding() (1c),
// mergeIntoCurrentResearchFinding()/recordTechnicalRequirements() (6a),
// and the updated collectCurrentResearchSources()/recordResearchConfidence()
// (5e, extended for 6a's new field) against plain in-memory data,
// standing in for research_findings. Recommend re-running against the
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

// mirrors expansion.ts's mergeIntoCurrentResearchFinding()
function mergeIntoCurrentResearchFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createResearchFinding<Record<string, unknown>>(opportunityId, merged);
}

// mirrors expansion.ts's recordMarketSizeEstimate() (Phase 5b) — used
// here only to prove 6a accumulates alongside an existing field.
function recordMarketSizeEstimate(
  opportunityId: string,
  estimate: { query: string; results: unknown[]; estimatedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { market_size: estimate });
}

// mirrors expansion.ts's recordTechnicalRequirements() (Phase 6a)
function recordTechnicalRequirements(
  opportunityId: string,
  assessment: { query: string; results: unknown[]; assessedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { technical_requirements: assessment });
}

// mirrors expansion.ts's collectCurrentResearchSources(), extended for
// the technical_requirements field 6a adds (Phase 5e, updated)
function collectCurrentResearchSources(opportunityId: string): string[] {
  const current = getCurrentResearchFinding(opportunityId);
  if (!current) return [];
  const findings = current.findings as {
    market_size?: { results: { url?: string }[] };
    competition?: { results: { url?: string }[] };
    customer_segments?: { results: { url?: string }[] };
    technical_requirements?: { results: { url?: string }[] };
  };
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const section of [
    findings.market_size,
    findings.competition,
    findings.customer_segments,
    findings.technical_requirements,
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

test("assess_technical_requirements on a fresh opportunity starts research_findings at version 1", () => {
  reset();
  const o = seedOpportunity();
  const f = recordTechnicalRequirements(o.id, {
    query: '"Foo" tech stack build requirements engineering',
    results: [{ title: "t", url: "u", snippet: "s" }],
    assessedAt: 1000,
  });
  assert.equal(f.version, 1);
  assert.equal(f.superseded, false);
  assert.deepEqual(Object.keys(f.findings), ["technical_requirements"]);
});

test("re-running assess_technical_requirements supersedes the prior version, matching 1c", () => {
  reset();
  const o = seedOpportunity();
  const v1 = recordTechnicalRequirements(o.id, { query: "q1", results: [], assessedAt: 1 });
  const v2 = recordTechnicalRequirements(o.id, { query: "q2", results: [], assessedAt: 2 });

  assert.equal(v2.version, 2);
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
  assert.equal((current?.findings.technical_requirements as any).query, "q2");
  assert.equal(table.get(v1.id)?.superseded, true);
});

test("assess_technical_requirements preserves a sibling field already on the current finding", () => {
  reset();
  const o = seedOpportunity();
  const withMarketSize = recordMarketSizeEstimate(o.id, {
    query: "q-market",
    results: [],
    estimatedAt: 1,
  });
  assert.equal(withMarketSize.version, 1);

  const withTechReqs = recordTechnicalRequirements(o.id, {
    query: "q-tech",
    results: [],
    assessedAt: 2,
  });

  assert.equal(withTechReqs.version, 2);
  assert.deepEqual(withTechReqs.findings.market_size, {
    query: "q-market",
    results: [],
    estimatedAt: 1,
  });
  assert.ok("technical_requirements" in withTechReqs.findings);
});

test("assess_technical_requirements on an unknown opportunity throws, matching createFinding's own guard", () => {
  reset();
  assert.throws(() =>
    recordTechnicalRequirements("opp_missing", { query: "q", results: [], assessedAt: 1 }),
  );
});

test("report_research_confidence includes technical_requirements sources alongside market_size/competition/customer_segments", () => {
  reset();
  const o = seedOpportunity();

  recordMarketSizeEstimate(o.id, {
    query: "q-market",
    results: [{ title: "A", url: "https://a.example", snippet: "" }],
    estimatedAt: 1,
  });
  recordTechnicalRequirements(o.id, {
    query: "q-tech",
    // duplicate URL with market_size's own "A" result, plus one new one
    results: [
      { title: "A again", url: "https://a.example", snippet: "" },
      { title: "Stack overview", url: "https://tech.example", snippet: "" },
    ],
    assessedAt: 2,
  });

  const f = recordResearchConfidence(o.id, "high");
  assert.equal(f.version, 3);
  assert.equal(f.findings.confidence, "high");
  assert.deepEqual(f.findings.sources, ["https://a.example", "https://tech.example"]);
  assert.ok("market_size" in f.findings);
  assert.ok("technical_requirements" in f.findings);
});

test("report_research_confidence with only a technical_requirements pass still yields its sources", () => {
  reset();
  const o = seedOpportunity();
  recordTechnicalRequirements(o.id, {
    query: "q-tech",
    results: [{ title: "Docs", url: "https://docs.example", snippet: "" }],
    assessedAt: 1,
  });

  const f = recordResearchConfidence(o.id, "med");
  assert.deepEqual(f.findings.sources, ["https://docs.example"]);
});
