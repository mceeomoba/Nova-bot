// Zent.md Phase 4b: "GET /expansion/opportunities/:id — full detail:
// source summary, scoring factors, de-dup history."
//
// Inlined mirror of expansion.ts's getOpportunityDetail()/
// findDedupMatchesForOpportunity() (including the tfidf.ts scoreCorpus()
// smoothed-idf formula those reuse from Phase 3c's dedup gate) and of
// expansionRoutes.ts's GET /opportunities/:idOrAgentAddress dispatch
// (looksLikeOpportunityId() routing to the 4b detail handler vs. the 4a
// ranked-list handler) — same "no live better-sqlite3 / no live express
// server in this environment" reason every prior backend/src test file
// in this repo already carries (see expansionOpportunitiesList.test.ts's
// own header for the identical note on the Phase 4a logic it mirrors).
//
// What this covers:
//   4b — detail includes the owning report's source_summary and status.
//   4b — detail includes scoring factors and roi_formula_version
//        exactly as stored (null when the opportunity has none).
//   4b — de-dup history: another scored opportunity for the same agent,
//        within the window, above threshold, appears — sorted
//        highest-similarity first.
//   4b — de-dup history excludes the opportunity itself.
//   4b — de-dup history is agent-scoped: a similar opportunity
//        belonging to a different agent never appears.
//   4b — de-dup history includes matches under an archived report
//        (unlike Phase 4a's live list, the dedup window has never
//        filtered on report lifecycle).
//   4b — de-dup history excludes an unscored candidate and one outside
//        the window, matching Phase 3c's own create-time gate scoping.
//   4b — an unknown opportunity id returns undefined (not found is not
//        an error), matching getOpportunity()'s own convention.
//   4b — the route: an `opp_`-prefixed path param dispatches to the
//        detail handler and returns 200 with the full shape; an
//        unknown `opp_` id 404s; anything else dispatches to the
//        existing 4a ranked-list handler unchanged.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of tfidf.ts's tokenize/termFreq/scoreCorpus ────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "to", "of", "and",
  "in", "on", "for", "with", "this", "that", "it", "as", "at", "by", "from",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

function scoreCorpus<T>(
  query: string,
  corpus: T[],
  getText: (item: T) => string,
): { item: T; score: number }[] {
  if (corpus.length === 0) return [];
  const docs = corpus.map((item) => tokenize(getText(item)));
  const queryTokens = tokenize(query);
  const allDocs = [...docs, queryTokens];

  const df = new Map<string, number>();
  for (const doc of allDocs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const N = allDocs.length;
  const idf = (term: string) => Math.log((1 + N) / (1 + (df.get(term) ?? 0))) + 1;

  function vector(tokens: string[]): Map<string, number> {
    const tf = termFreq(tokens);
    const vec = new Map<string, number>();
    for (const [term, freq] of tf) vec.set(term, freq * idf(term));
    return vec;
  }

  function cosineSim(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    for (const [term, weight] of a) dot += weight * (b.get(term) ?? 0);
    const magA = Math.sqrt([...a.values()].reduce((s, w) => s + w * w, 0));
    const magB = Math.sqrt([...b.values()].reduce((s, w) => s + w * w, 0));
    if (magA === 0 || magB === 0) return 0;
    return dot / (magA * magB);
  }

  const queryVec = vector(queryTokens);
  return corpus.map((item, i) => ({ item, score: cosineSim(queryVec, vector(docs[i])) }));
}

// ─── Mirror of expansion.ts's opportunity_reports / opportunities rows ─

type OpportunityReportStatus = "draft" | "scored" | "archived";
type OpportunityStatus = "open" | "selected" | "rejected";

interface FakeReport {
  id: string;
  agent_address: string;
  status: OpportunityReportStatus;
  source_summary: string;
}

interface ScoringFactors {
  demand: number;
  expenseOfProblem: number;
  buildability: number;
  competitiveGap: number;
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  created_at: number;
  title: string;
  thesis: string;
  roi_score: number | null;
  roi_formula_version: string | null;
  factors: ScoringFactors | null;
  status: OpportunityStatus;
  selected_at: number | null;
  tags: string[];
}

let reports: Map<string, FakeReport>;
let opportunities: Map<string, FakeOpportunity>;
let seq: number;

// Same defaults config.ts actually ships (OPPORTUNITY_DEDUP_WINDOW_DAYS /
// OPPORTUNITY_DEDUP_SIMILARITY_THRESHOLD) — kept in sync with
// expansionDedup.test.ts's own DEFAULT_THRESHOLD so a near-duplicate
// pair that clears 3c's create-time gate also clears this file's
// de-dup-history read at the same threshold.
const DEDUP_WINDOW_DAYS = 30;
const DEDUP_THRESHOLD = 0.82;

function reset() {
  reports = new Map();
  opportunities = new Map();
  seq = 0;
}

function createReport(
  agentAddress: string,
  opts: { status?: OpportunityReportStatus; sourceSummary?: string } = {},
): FakeReport {
  const row: FakeReport = {
    id: `oppr_${++seq}`,
    agent_address: agentAddress,
    status: opts.status ?? "draft",
    source_summary: opts.sourceSummary ?? "",
  };
  reports.set(row.id, row);
  return row;
}

function seedOpportunity(
  report: FakeReport,
  title: string,
  thesis: string,
  roiScore: number | null,
  opts: {
    createdAt?: number;
    status?: OpportunityStatus;
    factors?: ScoringFactors;
    roiFormulaVersion?: string;
  } = {},
): FakeOpportunity {
  const opp: FakeOpportunity = {
    id: `opp_${++seq}`,
    report_id: report.id,
    created_at: opts.createdAt ?? Date.now(),
    title,
    thesis,
    roi_score: roiScore,
    roi_formula_version: opts.roiFormulaVersion ?? null,
    factors: opts.factors ?? null,
    status: opts.status ?? "open",
    selected_at: null,
    tags: [],
  };
  opportunities.set(opp.id, opp);
  return opp;
}

// ─── Mirror of expansion.ts's dedupText/findDedupMatchesForOpportunity ─

function dedupText(title: string, thesis: string): string {
  return `${title}\n${thesis}`;
}

interface DedupHistoryEntry {
  opportunityId: string;
  title: string;
  status: OpportunityStatus;
  roiScore: number | null;
  similarity: number;
}

function findDedupMatchesForOpportunity(
  opportunityId: string,
  options: { windowDays?: number; threshold?: number } = {},
): DedupHistoryEntry[] {
  const target = opportunities.get(opportunityId);
  if (!target) throw new Error(`opportunity ${opportunityId} not found`);
  const report = reports.get(target.report_id)!;

  const windowDays = options.windowDays ?? DEDUP_WINDOW_DAYS;
  const threshold = options.threshold ?? DEDUP_THRESHOLD;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const candidates = [...opportunities.values()].filter((o) => {
    if (o.id === opportunityId) return false;
    if (o.roi_score === null) return false;
    if (o.created_at < cutoff) return false;
    const r = reports.get(o.report_id)!;
    return r.agent_address === report.agent_address;
  });
  if (candidates.length === 0) return [];

  const scored = scoreCorpus(dedupText(target.title, target.thesis), candidates, (o) =>
    dedupText(o.title, o.thesis),
  );

  return scored
    .filter(({ score }) => score >= threshold)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.item.created_at !== b.item.created_at) return a.item.created_at - b.item.created_at;
      return a.item.id.localeCompare(b.item.id);
    })
    .map(({ item, score }) => ({
      opportunityId: item.id,
      title: item.title,
      status: item.status,
      roiScore: item.roi_score,
      similarity: score,
    }));
}

// ─── Mirror of expansion.ts's getOpportunityDetail ─────────────────────

interface OpportunityDetail {
  opportunity: FakeOpportunity;
  agentAddress: string;
  reportStatus: OpportunityReportStatus;
  sourceSummary: string;
  dedupHistory: DedupHistoryEntry[];
}

function getOpportunityDetail(id: string): OpportunityDetail | undefined {
  const opportunity = opportunities.get(id);
  if (!opportunity) return undefined;
  const report = reports.get(opportunity.report_id)!;
  return {
    opportunity,
    agentAddress: report.agent_address,
    reportStatus: report.status,
    sourceSummary: report.source_summary,
    dedupHistory: findDedupMatchesForOpportunity(id),
  };
}

// ─── Mirror of expansionRoutes.ts's dispatch + handlers ────────────────

function looksLikeOpportunityId(value: string): boolean {
  return value.startsWith("opp_");
}

function handleOpportunityDetail(id: string): { httpStatus: number; body: any } {
  try {
    const detail = getOpportunityDetail(id);
    if (!detail) {
      return { httpStatus: 404, body: { error: `opportunity ${id} not found` } };
    }
    return {
      httpStatus: 200,
      body: {
        id: detail.opportunity.id,
        reportId: detail.opportunity.report_id,
        agentAddress: detail.agentAddress,
        reportStatus: detail.reportStatus,
        title: detail.opportunity.title,
        thesis: detail.opportunity.thesis,
        roiScore: detail.opportunity.roi_score,
        roiFormulaVersion: detail.opportunity.roi_formula_version,
        factors: detail.opportunity.factors,
        status: detail.opportunity.status,
        sourceSummary: detail.sourceSummary,
        dedupHistory: detail.dedupHistory,
      },
    };
  } catch (err: any) {
    return { httpStatus: 500, body: { error: err.message || "internal_error" } };
  }
}

// Trimmed re-implementation of the 4a handler, just enough to prove the
// dispatch sends non-opp_ params here rather than to handleOpportunityDetail.
function handleListForAgent(agentAddress: string): { httpStatus: number; body: any } {
  return { httpStatus: 200, body: { agentAddress, opportunities: [] } };
}

function handleListRoute(idOrAgentAddress: string | undefined): { httpStatus: number; body: any } {
  if (!idOrAgentAddress) {
    return { httpStatus: 400, body: { error: "agentAddress is required" } };
  }
  if (looksLikeOpportunityId(idOrAgentAddress)) {
    return handleOpportunityDetail(idOrAgentAddress);
  }
  return handleListForAgent(idOrAgentAddress);
}

// ─── 4b: getOpportunityDetail (data layer) ─────────────────────────────

describe("getOpportunityDetail", () => {
  test("includes the owning report's source_summary and status", () => {
    reset();
    const report = createReport("agent-1", {
      status: "scored",
      sourceSummary: "raw signal log entries here",
    });
    const opp = seedOpportunity(report, "Idea", "Thesis text", 80);

    const detail = getOpportunityDetail(opp.id)!;
    assert.equal(detail.sourceSummary, "raw signal log entries here");
    assert.equal(detail.reportStatus, "scored");
    assert.equal(detail.agentAddress, "agent-1");
  });

  test("includes scoring factors and roi_formula_version as stored", () => {
    reset();
    const report = createReport("agent-1");
    const factors: ScoringFactors = {
      demand: 70,
      expenseOfProblem: 60,
      buildability: 50,
      competitiveGap: 40,
    };
    const opp = seedOpportunity(report, "Idea", "Thesis", 80, {
      factors,
      roiFormulaVersion: "3b-v1",
    });

    const detail = getOpportunityDetail(opp.id)!;
    assert.deepEqual(detail.opportunity.factors, factors);
    assert.equal(detail.opportunity.roi_formula_version, "3b-v1");
  });

  test("factors is null when the opportunity has none", () => {
    reset();
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", "Thesis", 80);

    const detail = getOpportunityDetail(opp.id)!;
    assert.equal(detail.opportunity.factors, null);
    assert.equal(detail.opportunity.roi_formula_version, null);
  });

  test("returns undefined for an unknown id", () => {
    reset();
    assert.equal(getOpportunityDetail("opp_does_not_exist"), undefined);
  });
});

// ─── 4b: findDedupMatchesForOpportunity (de-dup history) ───────────────

describe("findDedupMatchesForOpportunity", () => {
  // Same title/thesis pair expansionDedup.test.ts's own 3c "flags a
  // near-identical title+thesis as a duplicate" test uses, verified
  // there to clear DEFAULT_THRESHOLD (0.82) — reused here rather than a
  // fresh pair so this file isn't independently guessing at how much
  // shared text is "near-identical enough" under the real formula.
  const NEAR_DUP_TARGET = {
    title: "AI-powered invoice reconciliation for freelancers",
    thesis: "Freelancers waste hours matching bank transactions to invoices by hand every month.",
  };
  const NEAR_DUP_MATCH = {
    title: "AI powered invoice reconciliation tool for freelancers",
    thesis: "Freelancers waste hours matching bank transactions to invoices by hand every single month.",
  };
  const UNRELATED = {
    title: "Automated podcast show-notes generator",
    thesis: "Podcasters spend hours writing episode summaries and show notes by hand every week.",
  };

  test("a near-identical scored opportunity for the same agent appears", () => {
    reset();
    const report = createReport("agent-1");
    const target = seedOpportunity(report, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);
    const similar = seedOpportunity(report, NEAR_DUP_MATCH.title, NEAR_DUP_MATCH.thesis, 70);

    const history = findDedupMatchesForOpportunity(target.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].opportunityId, similar.id);
    assert.ok(history[0].similarity >= DEDUP_THRESHOLD);
  });

  test("a genuinely different opportunity does not appear", () => {
    reset();
    const report = createReport("agent-1");
    const target = seedOpportunity(report, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);
    seedOpportunity(report, UNRELATED.title, UNRELATED.thesis, 70);

    const history = findDedupMatchesForOpportunity(target.id);
    assert.equal(history.length, 0);
  });

  test("excludes the opportunity itself", () => {
    reset();
    const report = createReport("agent-1");
    const target = seedOpportunity(report, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);

    const history = findDedupMatchesForOpportunity(target.id);
    assert.equal(history.length, 0);
  });

  test("is agent-scoped: a similar opportunity for another agent never appears", () => {
    reset();
    const reportA = createReport("agent-1");
    const target = seedOpportunity(reportA, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);
    const reportB = createReport("agent-2");
    seedOpportunity(reportB, NEAR_DUP_MATCH.title, NEAR_DUP_MATCH.thesis, 90);

    const history = findDedupMatchesForOpportunity(target.id);
    assert.equal(history.length, 0);
  });

  test("includes a match under an archived report (unlike the live 4a list)", () => {
    reset();
    const liveReport = createReport("agent-1");
    const target = seedOpportunity(liveReport, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);
    const deadReport = createReport("agent-1", { status: "archived" });
    const dead = seedOpportunity(deadReport, NEAR_DUP_MATCH.title, NEAR_DUP_MATCH.thesis, 99);

    const history = findDedupMatchesForOpportunity(target.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].opportunityId, dead.id);
  });

  test("excludes an unscored candidate", () => {
    reset();
    const report = createReport("agent-1");
    const target = seedOpportunity(report, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);
    seedOpportunity(report, NEAR_DUP_MATCH.title, NEAR_DUP_MATCH.thesis, null);

    const history = findDedupMatchesForOpportunity(target.id);
    assert.equal(history.length, 0);
  });

  test("excludes a candidate outside the window", () => {
    reset();
    const report = createReport("agent-1");
    const target = seedOpportunity(report, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);
    seedOpportunity(report, NEAR_DUP_MATCH.title, NEAR_DUP_MATCH.thesis, 70, {
      createdAt: Date.now() - (DEDUP_WINDOW_DAYS + 5) * 24 * 60 * 60 * 1000,
    });

    const history = findDedupMatchesForOpportunity(target.id);
    assert.equal(history.length, 0);
  });

  test("sorted highest-similarity first", () => {
    reset();
    const report = createReport("agent-1");
    const target = seedOpportunity(report, NEAR_DUP_TARGET.title, NEAR_DUP_TARGET.thesis, 80);
    // A closer paraphrase of the target than UNRELATED, but not the
    // verified near-duplicate pair above — clears a lowered threshold
    // alongside the true near-duplicate, giving two ranked results.
    const partial = seedOpportunity(
      report,
      "Bank transaction matching for freelance invoices",
      "Freelancers spend hours matching bank transactions to invoices by hand.",
      65,
    );
    const trueDup = seedOpportunity(report, NEAR_DUP_MATCH.title, NEAR_DUP_MATCH.thesis, 70);

    const history = findDedupMatchesForOpportunity(target.id, { threshold: 0.3 });
    assert.ok(history.length >= 2);
    for (let i = 1; i < history.length; i++) {
      assert.ok(history[i - 1].similarity >= history[i].similarity);
    }
    // the verified near-duplicate should rank above the looser paraphrase
    const dupRank = history.findIndex((h) => h.opportunityId === trueDup.id);
    const partialRank = history.findIndex((h) => h.opportunityId === partial.id);
    assert.ok(dupRank !== -1 && partialRank !== -1);
    assert.ok(dupRank < partialRank);
  });

  test("throws for an unknown opportunity id", () => {
    reset();
    assert.throws(() => findDedupMatchesForOpportunity("opp_does_not_exist"));
  });
});

// ─── 4b: GET /expansion/opportunities/:idOrAgentAddress (route layer) ──

describe("GET /expansion/opportunities/:idOrAgentAddress dispatch", () => {
  test("an opp_-prefixed id dispatches to the detail handler and 200s", () => {
    reset();
    const report = createReport("agent-1", { sourceSummary: "signals" });
    const opp = seedOpportunity(report, "Idea", "Thesis", 80);

    const result = handleListRoute(opp.id);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.id, opp.id);
    assert.equal(result.body.sourceSummary, "signals");
    assert.ok("dedupHistory" in result.body);
  });

  test("an unknown opp_ id 404s", () => {
    reset();
    const result = handleListRoute("opp_nonexistent");
    assert.equal(result.httpStatus, 404);
  });

  test("a non-opp_ param dispatches to the existing 4a list handler", () => {
    reset();
    const result = handleListRoute("0xAbC1230000000000000000000000000000dEaD");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.body.agentAddress, "0xAbC1230000000000000000000000000000dEaD");
    assert.ok(Array.isArray(result.body.opportunities));
  });

  test("400s when the path param is missing", () => {
    reset();
    const result = handleListRoute(undefined);
    assert.equal(result.httpStatus, 400);
  });
});
