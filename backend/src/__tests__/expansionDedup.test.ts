// Zent.md Phase 3c: "De-dup pass: reject/merge an opportunity whose
// title+thesis is a near-match (embedding or TF-IDF, reusing
// tfidf.ts) to one already scored in the last N days for this agent."
//
// Inlined mirror of tfidf.ts's scoreCorpus() (Phase 3c extracted this
// from the existing rankByRelevance(), see that file's own header —
// including the Phase 3c smoothed-idf fix documented there: the naive
// ln(N/(1+df)) formula produces false duplicate matches at de-dup's
// realistically small corpus size, so this mirror uses the same
// smoothed ln((1+N)/(1+df)) + 1 formula tfidf.ts itself was fixed to
// use), of expansion.ts's dedupText()/findNearDuplicateOpportunity(), and of
// expansionRoutes.ts's score-opportunity route's Phase 3c update
// (de-dup check before resolveTargetReport(), 409 on a match) — same
// "no live better-sqlite3 in this environment" reason every prior
// backend/src test file in this repo already carries (see
// expansionRoiFormula.test.ts's own header for the identical note on
// the Phase 3b route it mirrors).
//
// What this covers:
//   3c — a near-identical title+thesis against an already-scored
//         opportunity for the same agent, within the window, is
//         flagged as a duplicate; a genuinely different one is not.
//   3c — "already scored" scoping: an unscored opportunity (no
//         roi_score) with similar text does not block a new one —
//         only rows that actually went through score_opportunity
//         count as "already scored" for de-dup purposes.
//   3c — "in the last N days" scoping: a similar opportunity older
//         than the window does not block a new one.
//   3c — "for this agent" scoping: a similar opportunity belonging to
//         a different agent does not block a new one.
//   3c — the score-opportunity route rejects (409-equivalent) on a
//         match, naming the existing duplicate, and never creates a
//         second row; a non-duplicate call proceeds exactly as the
//         Phase 3b route already did (factors + roi_score + version
//         all stored together).

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
  // Smoothed idf — mirrors tfidf.ts's Phase 3c fix; see that file's own
  // module doc for why the naive ln(N/(1+df)) formula produces false
  // duplicate matches at de-dup's realistic (small) corpus size.
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
  return corpus.map((item, i) => ({
    item,
    score: cosineSim(queryVec, vector(docs[i])),
  }));
}

// ─── Mirror of expansion.ts's opportunity_reports / opportunities rows ─

interface ScoringFactors {
  demand: number;
  expenseOfProblem: number;
  buildability: number;
  competitiveGap: number;
}

interface FakeReport {
  id: string;
  agent_address: string;
  status: "draft" | "scored" | "archived";
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  agent_address: string; // denormalized here for test setup convenience only
  created_at: number;
  title: string;
  thesis: string;
  roi_score: number | null;
  roi_formula_version: string | null;
  factors: ScoringFactors | null;
}

let reports: FakeReport[];
let opportunities: FakeOpportunity[];
let nextId: number;

function resetState() {
  reports = [];
  opportunities = [];
  nextId = 1;
}

function createReport(agentAddress: string): FakeReport {
  const report: FakeReport = { id: `oppr_${nextId++}`, agent_address: agentAddress, status: "draft" };
  reports.push(report);
  return report;
}

/** Test-only helper to seed an existing opportunity directly (bypasses
 *  the route) with a specific created_at, so window-boundary tests can
 *  control age precisely. */
function seedOpportunity(
  report: FakeReport,
  title: string,
  thesis: string,
  opts: { roiScore?: number | null; createdAt?: number } = {},
): FakeOpportunity {
  const opp: FakeOpportunity = {
    id: `opp_${nextId++}`,
    report_id: report.id,
    agent_address: report.agent_address,
    created_at: opts.createdAt ?? Date.now(),
    title,
    thesis,
    roi_score: opts.roiScore === undefined ? 50 : opts.roiScore,
    roi_formula_version: opts.roiScore === undefined || opts.roiScore !== null ? "3b-v1" : null,
    factors: null,
  };
  opportunities.push(opp);
  return opp;
}

// ─── Mirror of expansion.ts's Phase 3c de-dup pass ─────────────────────

const DEFAULT_WINDOW_DAYS = 30;
const DEFAULT_THRESHOLD = 0.82;

function dedupText(title: string, thesis: string): string {
  return `${title}\n${thesis}`;
}

interface DedupMatch {
  opportunity: FakeOpportunity;
  similarity: number;
}

function findNearDuplicateOpportunity(
  agentAddress: string,
  title: string,
  thesis: string,
  options: { windowDays?: number; threshold?: number } = {},
): DedupMatch | undefined {
  if (!agentAddress) throw new Error("agentAddress is required");
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const candidates = opportunities.filter(
    (o) => o.agent_address === agentAddress && o.roi_score !== null && o.created_at >= cutoff,
  );
  if (candidates.length === 0) return undefined;

  const scored = scoreCorpus(dedupText(title, thesis), candidates, (o) => dedupText(o.title, o.thesis));

  let best: DedupMatch | undefined;
  for (const { item, score } of scored) {
    if (score >= threshold && (!best || score > best.similarity)) {
      best = { opportunity: item, similarity: score };
    }
  }
  return best;
}

// ─── Mirror of the Phase 3c score-opportunity route update ────────────

function scoreOpportunityRoute(
  agentAddress: string,
  report: FakeReport,
  title: string,
  thesis: string,
): { status: number; body: any } {
  const duplicate = findNearDuplicateOpportunity(agentAddress, title, thesis);
  if (duplicate) {
    return {
      status: 409,
      body: {
        error: "near-duplicate of an already-scored opportunity for this agent",
        duplicate: {
          opportunityId: duplicate.opportunity.id,
          title: duplicate.opportunity.title,
          roiScore: duplicate.opportunity.roi_score,
          similarity: duplicate.similarity,
        },
      },
    };
  }
  const created = seedOpportunity(report, title, thesis, { roiScore: 61 });
  return { status: 201, body: { reportId: report.id, opportunity: created } };
}

// ─── 3c: findNearDuplicateOpportunity ──────────────────────────────────

describe("findNearDuplicateOpportunity", () => {
  test("flags a near-identical title+thesis as a duplicate", () => {
    resetState();
    const report = createReport("agent-1");
    seedOpportunity(
      report,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
    );
    const match = findNearDuplicateOpportunity(
      "agent-1",
      "AI powered invoice reconciliation tool for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every single month.",
    );
    assert.ok(match, "expected a near-duplicate match");
    assert.ok(match!.similarity >= DEFAULT_THRESHOLD);
  });

  test("does not flag a genuinely different opportunity", () => {
    resetState();
    const report = createReport("agent-1");
    seedOpportunity(
      report,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
    );
    const match = findNearDuplicateOpportunity(
      "agent-1",
      "Automated podcast show-notes generator",
      "Podcasters spend an hour per episode writing timestamps and summaries by hand.",
    );
    assert.equal(match, undefined);
  });

  test("an unscored opportunity (roi_score null) does not count as already-scored", () => {
    resetState();
    const report = createReport("agent-1");
    seedOpportunity(
      report,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
      { roiScore: null },
    );
    const match = findNearDuplicateOpportunity(
      "agent-1",
      "AI powered invoice reconciliation tool for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every single month.",
    );
    assert.equal(match, undefined);
  });

  test("an opportunity older than the window does not block a new one", () => {
    resetState();
    const report = createReport("agent-1");
    const windowDays = 30;
    const justOutsideWindow = Date.now() - (windowDays + 1) * 24 * 60 * 60 * 1000;
    seedOpportunity(
      report,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
      { createdAt: justOutsideWindow },
    );
    const match = findNearDuplicateOpportunity(
      "agent-1",
      "AI powered invoice reconciliation tool for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every single month.",
      { windowDays },
    );
    assert.equal(match, undefined);
  });

  test("an opportunity just inside the window still blocks", () => {
    resetState();
    const report = createReport("agent-1");
    const windowDays = 30;
    const justInsideWindow = Date.now() - (windowDays - 1) * 24 * 60 * 60 * 1000;
    seedOpportunity(
      report,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
      { createdAt: justInsideWindow },
    );
    const match = findNearDuplicateOpportunity(
      "agent-1",
      "AI powered invoice reconciliation tool for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every single month.",
      { windowDays },
    );
    assert.ok(match, "expected a near-duplicate match inside the window");
  });

  test("a similar opportunity belonging to a different agent does not block", () => {
    resetState();
    const reportA = createReport("agent-1");
    createReport("agent-2");
    seedOpportunity(
      reportA,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
    );
    const match = findNearDuplicateOpportunity(
      "agent-2",
      "AI powered invoice reconciliation tool for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every single month.",
    );
    assert.equal(match, undefined);
  });

  test("no scored opportunities at all for the agent returns undefined, not an error", () => {
    resetState();
    createReport("agent-1");
    assert.doesNotThrow(() => {
      const match = findNearDuplicateOpportunity("agent-1", "Anything", "At all");
      assert.equal(match, undefined);
    });
  });

  test("throws on an empty agentAddress", () => {
    resetState();
    assert.throws(() => findNearDuplicateOpportunity("", "Title", "Thesis"), /agentAddress is required/);
  });
});

// ─── 3c: score-opportunity route rejects on duplicate ──────────────────

describe("score-opportunity route — de-dup (Phase 3c)", () => {
  test("rejects with 409 and names the existing duplicate; creates no new row", () => {
    resetState();
    const report = createReport("agent-1");
    const first = scoreOpportunityRoute(
      "agent-1",
      report,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
    );
    assert.equal(first.status, 201);
    assert.equal(opportunities.length, 1);

    const second = scoreOpportunityRoute(
      "agent-1",
      report,
      "AI powered invoice reconciliation tool for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every single month.",
    );
    assert.equal(second.status, 409);
    assert.equal(second.body.duplicate.opportunityId, first.body.opportunity.id);
    // The duplicate attempt must not have created a second row.
    assert.equal(opportunities.length, 1);
  });

  test("a non-duplicate call proceeds and stores normally", () => {
    resetState();
    const report = createReport("agent-1");
    scoreOpportunityRoute(
      "agent-1",
      report,
      "AI-powered invoice reconciliation for freelancers",
      "Freelancers waste hours matching bank transactions to invoices by hand every month.",
    );
    const result = scoreOpportunityRoute(
      "agent-1",
      report,
      "Automated podcast show-notes generator",
      "Podcasters spend an hour per episode writing timestamps and summaries by hand.",
    );
    assert.equal(result.status, 201);
    assert.equal(opportunities.length, 2);
  });
});
