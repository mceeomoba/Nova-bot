/**
 * The Expansion Pipeline — see Zent.md for the full 20-phase plan.
 *
 * This file is the data-layer for Phase 1 ("Data Model for the
 * Pipeline"). Built so far:
 *   - Phase 1a: opportunity_reports, the root row Opportunity
 *     Intelligence writes to before any opportunity has been scored
 *     out of it.
 *   - Phase 1b: opportunities, the child row(s) scored out of a report
 *     — see this file's own createOpportunity() docstring for the
 *     split between "the table exists" (1b, here) and "something
 *     principled computes roi_score" (Phase 3b).
 *   - Phase 1c: research_findings / finance_findings / strategy_findings
 *     — one versioned row per department pass against an opportunity.
 *     See the createFinding() docstring below for how "a department can
 *     re-run and supersede its own prior finding" (Zent.md 1c) is
 *     implemented.
 *   - Phase 1d: expansion_decisions — an append-only log of CEO rulings
 *     against an opportunity (Zent.md 15c's `deferred` case means more
 *     than one ruling can land against the same opportunity_id over
 *     time). See recordExpansionDecision()'s docstring below.
 * Nothing here is mounted as a route yet — Phase 4 is where an HTTP
 * surface shows up (`GET /expansion/opportunities/:agentAddress`
 * etc.); until then this is plain data-access, exactly the way
 * proceduralMemory.ts and knowledgeStore.ts are pure data-access modules
 * with no router of their own.
 *
 * Phase 2b update: scan_market_signals(query) itself — the actual web
 * search + the HTTP route that turns its results into a source_summary
 * append — now lives in expansionRoutes.ts, not here, matching every
 * other route file's relationship to this repo's data-access modules
 * (departments.ts vs. environment.ts, skillsRoutes.ts vs. skills.ts).
 * What DOES live here is formatMarketSignalEntry() below: the pure,
 * DB-free formatting step (raw results -> the plain-text block
 * appendSourceSummary() accepts), kept alongside appendSourceSummary()
 * itself so the two stay easy to reason about together and so it's
 * unit-testable without a live sqlite connection, same reasoning
 * __tests__/expansionDecisions.test.ts's own header already gives for
 * inlining a mirror rather than hitting a real DB.
 *
 * Phase 2c update: list_customer_complaints(domain)/list_demand_signals
 * (industry) — the two named wrappers Zent.md 2c calls for — live in
 * expansionRoutes.ts as their own routes, same file/module split 2b's
 * update above already established (HTTP surface + query-building in
 * expansionRoutes.ts, pure formatting here). What's shared with 2b:
 * ensureDraftOpportunityReport()/appendSourceSummary() (both wrappers
 * write into the same opportunity_reports lifecycle 2b's route does)
 * and formatMarketSignalEntry() (extended with an optional `callLabel`
 * param rather than forked, so all three tools' entries stay
 * one-format-to-read in source_summary — see that function's own
 * docstring for why the label carries the department's own
 * domain/industry argument rather than the internal search string).
 *
 * Deliberately NOT here yet, because they belong to later phases:
 *   - the profitability gate, isEligibleForExpansion() (2e) — NOTE:
 *     already implemented further down this file, ahead of the rest of
 *     Phase 2; see that section's own header for why.
 *   - Phase 3b update: the deterministic ROI formula now lives here too
 *     — computeRoiScore()/ROI_WEIGHTS/ROI_FORMULA_VERSION, see that
 *     section's own header below for the weighting rationale and why a
 *     version tag is stored alongside every formula-computed roi_score.
 *     The POST /expansion/opportunities/score-opportunity route
 *     (expansionRoutes.ts) now calls computeRoiScore() on the factors it
 *     already validates and passes the result straight to
 *     createOpportunity() — score_opportunity is a single tool call
 *     from a department's point of view; there's no separate "now score
 *     it" step to invoke.
 *   - Phase 3c update: the de-dup pass now lives here too —
 *     findNearDuplicateOpportunity(), see that section's own header
 *     below for the window/threshold reasoning and why this repo
 *     chose reject over silent merge.
 *   - Phase 3d update: top-N selection now lives here too —
 *     selectTopOpenOpportunities(), a scheduled job (scheduler.ts,
 *     built for next-phase.md Phase 5d, reused as-is) that promotes at
 *     most one 'open' opportunity per agent per tick up to a per-agent
 *     capacity (default 4). This turned out to be per-OPPORTUNITY
 *     status (opportunities.status, a new column), not the
 *     opportunity_reports.status flip the Phase 3b/3c comments above
 *     used to guess it would be — seeing 3d's actual selection logic
 *     made clear a single report's several opportunities can sit at
 *     different selection states, which a report-level flag can't
 *     represent. See that section's own header below for the full
 *     reasoning, including why the earlier guess turned out wrong.
 *   - Phase 3e update: the kill condition now lives here too —
 *     evaluateKillCondition()/sweepKillCondition(), see that section's
 *     own header below for why this is a separate gate rather than a
 *     floor baked into 3d's selectTopOpenOpportunities(), and why it's
 *     wired to run immediately before 3d's own sweep in the same
 *     scheduled tick rather than as an independent registration. This
 *     is also the phase that actually starts moving a report out of
 *     'draft' — every earlier phase's comments guessing at this
 *     ("most likely Phase 3e's job", expansionRoutes.ts) turned out
 *     right.
 *   - Phase 4a update: listRankedOpportunitiesForAgent() now lives here
 *     too — the data-layer half of GET /expansion/opportunities/:agentAddress
 *     (expansionRoutes.ts owns the HTTP surface itself, same split as
 *     every other route in this file). See that section's own header
 *     below for why it reads across an agent's non-archived reports
 *     rather than one report at a time the way listOpportunitiesForReport()
 *     (Phase 1b) does.
 *   - estimate_market_size / survey_competition / everything else that
 *     actually populates a finding's `findings` payload (Phase 5, 6, 8,
 *     9, 11, 12) — 1c gives each department's pass a place to live, one
 *     row per version, the same way 1b left roi_score's computation to
 *     Phase 3b. compile_research_report / compile_finance_report /
 *     compile_strategy_report and their locked-down schemas (7a/7b, 9e,
 *     12d) are later-phase concerns too.
 *   - decide_expansion() as a tool, POST /expansion/opportunities/:id/decide,
 *     the committee-packet assembly it reads (13a-13d), and the
 *     "calling agent_address must be the pipeline's owning top-level
 *     agent" authorization check (15b) — 1d gives a CEO ruling a place
 *     to land, one row per ruling, the same way 1c left a finding's
 *     payload opaque and let a later phase decide what fills it.
 */

import { ulid } from "ulid";
import { db } from "./db.js";
import { config } from "./config.js";
import { scoreCorpus } from "./tfidf.js";
import { runOnScheduleWithLease } from "./scheduler.js";
import { SEED_ROWS } from "./toolRegistrySeedData.js";
import { listSkills } from "./skills.js";
import { emitEvent } from "./ecosystemEvents.js";

export type OpportunityReportStatus = "draft" | "scored" | "archived";

export interface OpportunityReport {
  id: string;
  agent_address: string;
  created_at: number;
  source_summary: string;
  status: OpportunityReportStatus;
}

/**
 * Opens a new Opportunity Intelligence pass for `agentAddress` (Company
 * A). Starts in 'draft' with an empty source_summary — Phase 2's
 * scan_market_signals()/list_customer_complaints()/list_demand_signals()
 * tools are what actually append findings to it. Callers in this phase
 * (tests, and later 2e's eligibility gate) should not assume
 * source_summary is populated at creation time.
 */
export function createOpportunityReport(agentAddress: string): OpportunityReport {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  const row: OpportunityReport = {
    id: `oppr_${ulid()}`,
    agent_address: agentAddress,
    created_at: Date.now(),
    source_summary: "",
    status: "draft",
  };
  db.prepare(
    `INSERT INTO opportunity_reports (id, agent_address, created_at, source_summary, status)
     VALUES (@id, @agent_address, @created_at, @source_summary, @status)`,
  ).run(row);
  return row;
}

export function getOpportunityReport(id: string): OpportunityReport | undefined {
  return db
    .prepare(`SELECT * FROM opportunity_reports WHERE id = ?`)
    .get(id) as OpportunityReport | undefined;
}

/** Most-recent-first, optionally narrowed to one lifecycle state. */
export function listOpportunityReports(
  agentAddress: string,
  status?: OpportunityReportStatus,
): OpportunityReport[] {
  if (status) {
    return db
      .prepare(
        `SELECT * FROM opportunity_reports
         WHERE agent_address = ? AND status = ?
         ORDER BY created_at DESC`,
      )
      .all(agentAddress, status) as OpportunityReport[];
  }
  return db
    .prepare(
      `SELECT * FROM opportunity_reports
       WHERE agent_address = ?
       ORDER BY created_at DESC`,
    )
    .all(agentAddress) as OpportunityReport[];
}

/**
 * Appends to source_summary rather than replacing it — a single report
 * is meant to accumulate findings across several 2b/2c tool calls before
 * Phase 3 scores anything out of it.
 */
export function appendSourceSummary(id: string, addition: string): OpportunityReport {
  const existing = getOpportunityReport(id);
  if (!existing) {
    throw new Error(`opportunity_report ${id} not found`);
  }
  if (existing.status !== "draft") {
    throw new Error(`opportunity_report ${id} is ${existing.status}, not draft`);
  }
  const merged = existing.source_summary ? `${existing.source_summary}\n${addition}` : addition;
  db.prepare(`UPDATE opportunity_reports SET source_summary = ? WHERE id = ?`).run(merged, id);
  return { ...existing, source_summary: merged };
}

/**
 * Phase 2b: the report-lifecycle half of "scan_market_signals(query)
 * writes to opportunity_reports.source_summary" — specifically, which
 * report it writes to when the caller doesn't already have one open.
 * Reuses the most recent 'draft' report for agentAddress if one exists
 * (so several scans in the same Opportunity Intelligence pass accumulate
 * into one report, per createOpportunityReport()'s own "appends rather
 * than replaces" docstring) or opens a new one otherwise. Never returns
 * a 'scored'/'archived' report — those are done collecting signal by
 * definition (setOpportunityReportStatus()'s own one-way lifecycle),
 * so a scan after that point belongs to a fresh pass, not a reopened
 * old one.
 */
export function ensureDraftOpportunityReport(agentAddress: string): OpportunityReport {
  const [mostRecentDraft] = listOpportunityReports(agentAddress, "draft");
  return mostRecentDraft ?? createOpportunityReport(agentAddress);
}

const TERMINAL: Record<OpportunityReportStatus, OpportunityReportStatus[]> = {
  draft: ["scored", "archived"],
  scored: ["archived"],
  archived: [],
};

/**
 * Enforces the one-way lifecycle draft -> scored -> archived (or
 * draft -> archived directly, e.g. Phase 3e's "no good ideas this
 * cycle"). Going backward is never valid, so this is a hard error, not
 * a silent no-op — a caller trying to un-archive a report has a bug.
 */
export function setOpportunityReportStatus(
  id: string,
  status: OpportunityReportStatus,
): OpportunityReport {
  const existing = getOpportunityReport(id);
  if (!existing) {
    throw new Error(`opportunity_report ${id} not found`);
  }
  if (existing.status === status) {
    return existing;
  }
  if (!TERMINAL[existing.status].includes(status)) {
    throw new Error(`cannot move opportunity_report ${id} from ${existing.status} to ${status}`);
  }
  db.prepare(`UPDATE opportunity_reports SET status = ? WHERE id = ?`).run(status, id);
  return { ...existing, status };
}

// ─── Phase 2b: scan_market_signals formatting ──────────────────────────
//
// One raw web result, as parsed off the search backend expansionRoutes.ts
// calls. Deliberately the same {title, url, snippet} shape
// agent/src/agent/tools.ts's own web_search tool already returns to the
// model for every OTHER department type's research — scan_market_signals
// is a wrapper around that same shape, not a different one, matching
// Zent.md 2b's own "wraps existing web/browser tool access" framing.

export interface MarketSignalResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Formats one scan_market_signals(query) call's results into the
 * plain-text block appendSourceSummary() appends to an
 * opportunity_reports row. Pure and DB-free on purpose: expansionRoutes.ts
 * calls this after the search itself resolves and before it calls
 * appendSourceSummary(), so this function's only job is "results in,
 * one legible block out" — it never touches opportunity_reports.status
 * or existence, the same separation appendSourceSummary() already draws
 * from createOpportunityReport().
 *
 * An empty `results` array is a valid, expected input (Zent.md 3e's "no
 * good ideas this cycle" starts as "no results this particular scan")
 * and gets its own explicit line rather than an empty block, so a
 * report's source_summary reads as a complete timeline of every scan
 * that ran, not just the ones that found something.
 *
 * `callLabel` is what appears in the header's `name("arg")` position —
 * it defaults to `scan_market_signals("<query>")`, but Phase 2c's
 * list_customer_complaints(domain)/list_demand_signals(industry)
 * wrappers pass their own tool name plus the caller-facing argument
 * (the raw domain/industry, not the expanded search string built from
 * it — see expansionRoutes.ts's buildComplaintsQuery()/
 * buildDemandSignalsQuery()) so the report's source_summary reads as
 * "the department called list_customer_complaints('acme.com')", not as
 * a generic scan whose actual query happens to be longer and stranger
 * than what the department believes it asked for. This is the literal
 * mechanism behind Zent.md 2c's "so the department's reasoning trace
 * stays legible in logs".
 */
export function formatMarketSignalEntry(
  query: string,
  results: MarketSignalResult[],
  timestampMs: number = Date.now(),
  callLabel: { toolName: string; arg: string } = { toolName: "scan_market_signals", arg: query },
): string {
  const timestamp = new Date(timestampMs).toISOString();
  const header = `[${timestamp}] ${callLabel.toolName}("${callLabel.arg}")`;
  if (results.length === 0) {
    return `${header}: no results`;
  }
  const lines = results.map(
    (r, i) => `  ${i + 1}. ${r.title} — ${r.url}\n     ${r.snippet}`,
  );
  return `${header}:\n${lines.join("\n")}`;
}

// ─── Phase 1b: opportunities ───────────────────────────────────────────

export type OpportunityStatus = "open" | "selected" | "rejected";

export interface Opportunity {
  id: string;
  report_id: string;
  created_at: number;
  title: string;
  thesis: string;
  roi_score: number | null;
  /** Which ROI formula produced roi_score, e.g. "3b-v1" — see
   *  ROI_FORMULA_VERSION below. Null for rows with no roi_score yet, or
   *  for a caller-supplied roiScore that didn't pass a version (a test
   *  fixture, a human override). */
  roi_formula_version: string | null;
  tags: string[];
  factors: ScoringFactors | null;
  /** Phase 3d: 'open' (default) until selectTopOpenOpportunities()
   *  promotes it to 'selected'. 'rejected' is reserved for Phase 4c's
   *  promote/demote/reject endpoint (agent-only — see that section's
   *  own header) — nothing in this phase writes it. */
  status: OpportunityStatus;
  /** Set only when status becomes 'selected' (Phase 3d); null otherwise. */
  selected_at: number | null;
}

/** Shape as it actually sits in SQLite: tags is JSON TEXT, not an array,
 *  and the four Phase 3a scoring factors are four flat nullable REAL
 *  columns rather than a nested object (see db.ts's Phase 3a migration
 *  comment) — hydrateOpportunity() below re-nests them for callers. */
interface OpportunityRow {
  id: string;
  report_id: string;
  created_at: number;
  title: string;
  thesis: string;
  roi_score: number | null;
  roi_formula_version: string | null;
  tags: string;
  factor_demand: number | null;
  factor_expense_of_problem: number | null;
  factor_buildability: number | null;
  factor_competitive_gap: number | null;
  status: OpportunityStatus;
  selected_at: number | null;
}

function hydrateOpportunity(row: OpportunityRow): Opportunity {
  const { factor_demand, factor_expense_of_problem, factor_buildability, factor_competitive_gap, ...rest } =
    row;
  // A row either has all four factors (score_opportunity always writes
  // all four together, see createOpportunity() below) or none (every
  // opportunity created before Phase 3a, or without options.factors) —
  // there's no partial state to represent, so null-out the nested
  // object as a whole rather than exposing four independently-nullable
  // fields to callers.
  const factors: ScoringFactors | null =
    factor_demand !== null &&
    factor_expense_of_problem !== null &&
    factor_buildability !== null &&
    factor_competitive_gap !== null
      ? {
          demand: factor_demand,
          expenseOfProblem: factor_expense_of_problem,
          buildability: factor_buildability,
          competitiveGap: factor_competitive_gap,
        }
      : null;
  return { ...rest, tags: JSON.parse(row.tags) as string[], factors };
}

// ─── Phase 3a: score_opportunity's four scoring factors ───────────────
//
// Zent.md: "score_opportunity(title, thesis, factors) tool that writes
// one row to opportunities, factors = demand, expense-of-problem,
// buildability-by-our-stack, competitive-gap — each 0-100."
//
// This is the data-layer half (the ScoringFactors shape + range
// validation + createOpportunity() accepting them); the actual
// score_opportunity HTTP tool — report resolution, request validation,
// calling createOpportunity() with these factors — lives in
// expansionRoutes.ts, the same split 2b/2c already established between
// "pure, DB-adjacent logic here" and "HTTP surface + argument wiring
// there."
//
// Deliberately NOT here yet: 3b's deterministic ROI formula that
// combines these four into roi_score. This phase gives roi_score's
// *inputs* a validated, auditable home; it does not decide how they
// combine — same "the table exists vs. something principled computes
// the number" split 1b's own docstring already drew for roi_score
// itself.
export interface ScoringFactors {
  demand: number;
  expenseOfProblem: number;
  buildability: number;
  competitiveGap: number;
}

/**
 * Validates that every one of the four factors is a finite number in
 * [0, 100] inclusive. Throws a single Error naming every out-of-range
 * or non-numeric factor at once (not just the first one hit) so a
 * caller — or the route's 400 response — can report the whole problem
 * in one round trip rather than requiring four failed retries.
 */
export function validateScoringFactors(factors: ScoringFactors): void {
  const problems: string[] = [];
  for (const key of ["demand", "expenseOfProblem", "buildability", "competitiveGap"] as const) {
    const value = factors[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      problems.push(`${key} must be a finite number between 0 and 100 (got ${JSON.stringify(value)})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid scoring factors: ${problems.join("; ")}`);
  }
}

// ─── Phase 3b: deterministic ROI formula ───────────────────────────────
//
// Zent.md: "Deterministic ROI formula (documented, not left to the
// model to invent per-call) combining 3a's factors into roi_score;
// stored alongside the inputs so it's auditable, not just a number."
//
// "Stored alongside the inputs" is already true structurally — 3a's
// migration put factor_demand/factor_expense_of_problem/
// factor_buildability/factor_competitive_gap on the same `opportunities`
// row as roi_score (db.ts's Phase 3a migration comment). What this
// phase adds is the *rule* that turns those four into that one number,
// plus a version tag recording which rule produced a given row's score
// (see ROI_FORMULA_VERSION below for why that tag exists).
//
// The formula is a fixed weighted average, not something a model
// invents per call:
//
//   roi_score = 0.35*demand + 0.30*expenseOfProblem
//             + 0.20*buildability + 0.15*competitiveGap
//
// Weights sum to 1.0, so with every factor already range-checked into
// [0, 100] (validateScoringFactors, 3a) the result is always in [0, 100]
// too — no separate clamp needed.
//
// Why these weights and not an equal 25/25/25/25 split: demand and
// expense-of-problem describe the opportunity itself — is there a
// market, and does the problem hurt enough that someone will pay to
// have it solved — and those are the two questions a single
// Opportunity Intelligence pass, working from public signal alone, is
// best positioned to judge. buildability and competitive-gap describe
// our fit and the field, and both get re-examined in real depth by
// Research (Phase 5-6) and Strategy (Phase 10-12) before anything
// reaches the CEO gate — this score only has to rank a shortlist for
// Research to go verify, not be the final word (3d hands the top-N
// onward; 3e treats "no good ideas this cycle" as a valid outcome of
// this same coarse pass). Weighting the two inputs this stage can
// least cheaply verify more lightly than the two inputs later phases
// exist specifically to re-check keeps this stage's incentive aligned
// with "surface the right shortlist," not "maximize its own score" —
// see this file's Notes-on-scope-equivalent in Zent.md itself for why
// that self-scoring incentive is called out as the pipeline's biggest
// non-technical risk.
//
// Rounded to 2 decimal places so the stored value is stable and
// human-auditable: a reviewer re-deriving the number by hand from the
// four stored factors gets exactly this figure back, not something
// that drifts in the low bits of a float.
//
// ROI_FORMULA_VERSION is stored on every opportunity this formula
// scores (createOpportunity()'s roiFormulaVersion option, the
// roi_formula_version column added in db.ts's Phase 3b migration)
// because Zent.md 20e expects these weights to get tuned later, after
// real post-launch review of whether approved opportunities panned
// out. An opportunity scored under a since-changed formula needs to
// stay distinguishable from one scored under the current one, so an
// audit — or a future re-scoring pass — knows which rule produced a
// given number rather than just the number itself.
export const ROI_FORMULA_VERSION = "3b-v1";

export const ROI_WEIGHTS = {
  demand: 0.35,
  expenseOfProblem: 0.3,
  buildability: 0.2,
  competitiveGap: 0.15,
} as const;

/**
 * Combines score_opportunity's four validated factors into a single
 * 0-100 roi_score via the fixed weighted average documented above.
 *
 * Does not itself validate factors — callers (the score-opportunity
 * route) are expected to have already run them through
 * validateScoringFactors(). Given already-in-range inputs the result is
 * always in [0, 100]; an out-of-range input produces a mathematically
 * well-defined but out-of-range result rather than throwing, since
 * range-checking is validateScoringFactors()'s job, not this pure
 * function's.
 */
export function computeRoiScore(factors: ScoringFactors): number {
  const raw =
    factors.demand * ROI_WEIGHTS.demand +
    factors.expenseOfProblem * ROI_WEIGHTS.expenseOfProblem +
    factors.buildability * ROI_WEIGHTS.buildability +
    factors.competitiveGap * ROI_WEIGHTS.competitiveGap;
  // Round-trip through the 2-decimal rounding documented above rather
  // than storing the raw float.
  return Math.round(raw * 100) / 100;
}

// ─── Phase 3c: de-dup pass ─────────────────────────────────────────────
//
// Zent.md: "De-dup pass: reject/merge an opportunity whose title+thesis
// is a near-match (embedding or TF-IDF, reusing tfidf.ts) to one
// already scored in the last N days for this agent."
//
// Reuses tfidf.ts's scoreCorpus() (extracted from its existing
// rankByRelevance() in this same phase, see that file's own header) —
// the "reusing tfidf.ts" the spec calls for by name, not a second
// from-scratch similarity metric. Similarity is computed over
// `${title}\n${thesis}` on both sides: title alone is too short to be
// a reliable TF-IDF signal on its own, and thesis alone would miss two
// opportunities with an identically-phrased title but a differently
// -worded thesis.
//
// Scope: "already scored" (Zent.md's own wording) means an opportunity
// that has actually been through score_opportunity — roi_score IS NOT
// NULL — not just created. A title+thesis captured by some future
// caller ahead of scoring (createOpportunity() without factors/
// roiScore) isn't "scored" yet and shouldn't block a genuinely new
// idea from being scored just because an unscored placeholder happens
// to read similarly.
//
// Scope: "for this agent" joins through to opportunity_reports, since
// opportunities itself has no agent_address column (Phase 1a/1b's own
// split: reports belong to the agent, opportunities belong to a
// report) — same join shape isEligibleForExpansion() above uses
// against payments/usage_log, applied here against
// opportunities/opportunity_reports instead.
//
// Reject, not merge: Zent.md lists "reject/merge" as the two options.
// This phase implements reject — the route this feeds
// (POST /expansion/opportunities/score-opportunity) returns 409 naming
// the existing near-duplicate rather than silently combining two
// opportunities' factors/thesis text into one row. Two reasons: (1)
// this repo's own stated goal for 2c's named tool wrappers — "the
// department's reasoning trace stays legible in logs" — cuts against
// a merge that would quietly discard or blend one pass's reasoning
// into another's without a record of what was dropped; (2) the calling
// department (or the top-level agent) already has a standing override
// surface for this exact judgment call (Phase 4c's promote/demote/
// reject endpoint, once built) — rejecting with the duplicate's id
// visible lets the caller, reading the 409, decide to explicitly merge
// the *thesis text* itself and re-submit, rather than this layer
// guessing how two theses should be combined. No human operator sits
// in this path — see Phase 4c's own header for why.
export interface DedupMatch {
  /** The existing opportunity this candidate near-matches. */
  opportunity: Opportunity;
  /** TF-IDF cosine similarity in [0, 1] between the two title+thesis texts. */
  similarity: number;
}

/** `${title}\n${thesis}`, the text scoreCorpus() compares — factored out
 *  so the candidate side and the corpus side of the comparison can
 *  never drift into two different concatenation shapes by accident. */
function dedupText(title: string, thesis: string): string {
  return `${title}\n${thesis}`;
}

/**
 * Checks whether (title, thesis) is a near-duplicate of an opportunity
 * already scored for agentAddress within the last `windowDays` days
 * (default: config.opportunityDedupWindowDays). Returns the
 * highest-similarity match at or above `threshold` (default:
 * config.opportunityDedupSimilarityThreshold), or undefined if none
 * clears it — including when agentAddress has no scored opportunities
 * in the window at all.
 *
 * Pure read: never writes anything, never throws for "no match" (that's
 * the expected, common case — see 3e's own "no good ideas" precedent
 * for why an empty/negative result is a normal outcome here, not an
 * error). Only agentAddress being falsy throws, matching every other
 * input guard in this file.
 */
export function findNearDuplicateOpportunity(
  agentAddress: string,
  title: string,
  thesis: string,
  options: { windowDays?: number; threshold?: number } = {},
): DedupMatch | undefined {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  const windowDays = options.windowDays ?? config.opportunityDedupWindowDays;
  const threshold = options.threshold ?? config.opportunityDedupSimilarityThreshold;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const rows = db
    .prepare(
      `SELECT o.* FROM opportunities o
       JOIN opportunity_reports r ON r.id = o.report_id
       WHERE r.agent_address = ?
         AND o.roi_score IS NOT NULL
         AND o.created_at >= ?`,
    )
    .all(agentAddress, cutoff) as OpportunityRow[];
  if (rows.length === 0) return undefined;

  const candidates = rows.map(hydrateOpportunity);
  const scored = scoreCorpus(dedupText(title, thesis), candidates, (o) =>
    dedupText(o.title, o.thesis),
  );

  let best: DedupMatch | undefined;
  for (const { item, score } of scored) {
    if (score >= threshold && (!best || score > best.similarity)) {
      best = { opportunity: item, similarity: score };
    }
  }
  return best;
}

/**
 * Records one scored idea against a report. This is the 1b data-access
 * primitive, extended by 3a to optionally carry the four scoring
 * factors score_opportunity() writes and by 3b to optionally tag which
 * formula version computed a caller-supplied roiScore. It still does
 * not compute roi_score itself (pass it if the caller already has
 * one — e.g. a test, or the score-opportunity route calling
 * computeRoiScore() above — or omit both roiScore and
 * roiFormulaVersion for a title+thesis captured before scoring
 * happens) and it does not de-dup itself or rank (3d) — the
 * score-opportunity route calls findNearDuplicateOpportunity() above
 * *before* calling this, so a rejected duplicate never reaches this
 * function at all.
 * report_id must name an existing opportunity_reports row; the FK
 * constraint would catch a dangling reference at the SQLite level too,
 * but failing fast here with a clear message matches how
 * appendSourceSummary() above treats a missing report.
 *
 * options.factors, when provided, is validated via
 * validateScoringFactors() before anything is written — a caller never
 * gets a half-written row from a partially-invalid factors object.
 *
 * options.roiFormulaVersion is stored as-is (no validation beyond
 * "string or undefined") — it's an audit tag, not a value this layer
 * has any basis to judge as right or wrong for a given roiScore. A
 * caller-supplied roiScore with no roiFormulaVersion is left
 * untagged (null) rather than defaulted to ROI_FORMULA_VERSION, so a
 * manually-set score (a test fixture, a human override) is never
 * mistaken later for one the current formula actually produced.
 */
export function createOpportunity(
  reportId: string,
  title: string,
  thesis: string,
  options: {
    roiScore?: number;
    roiFormulaVersion?: string;
    tags?: string[];
    factors?: ScoringFactors;
  } = {},
): Opportunity {
  if (!reportId) {
    throw new Error("reportId is required");
  }
  if (!title) {
    throw new Error("title is required");
  }
  if (!thesis) {
    throw new Error("thesis is required");
  }
  const report = getOpportunityReport(reportId);
  if (!report) {
    throw new Error(`opportunity_report ${reportId} not found`);
  }
  const roiScore = options.roiScore ?? null;
  if (roiScore !== null && !Number.isFinite(roiScore)) {
    throw new Error("roiScore must be a finite number");
  }
  // Only meaningful paired with a roiScore — a version tag with no score
  // to attach it to would just be a dangling label. Enforced here so a
  // caller mistake shows up as an immediate thrown error, not a
  // silently-null-scored row with a version string that means nothing.
  if (options.roiFormulaVersion !== undefined && roiScore === null) {
    throw new Error("roiFormulaVersion was provided without roiScore");
  }
  if (options.factors !== undefined) {
    validateScoringFactors(options.factors);
  }
  const tags = options.tags ?? [];
  const row: OpportunityRow = {
    id: `opp_${ulid()}`,
    report_id: reportId,
    created_at: Date.now(),
    title,
    thesis,
    roi_score: roiScore,
    roi_formula_version: options.roiFormulaVersion ?? null,
    tags: JSON.stringify(tags),
    factor_demand: options.factors?.demand ?? null,
    factor_expense_of_problem: options.factors?.expenseOfProblem ?? null,
    factor_buildability: options.factors?.buildability ?? null,
    factor_competitive_gap: options.factors?.competitiveGap ?? null,
    status: "open",
    selected_at: null,
  };
  db.prepare(
    `INSERT INTO opportunities (
       id, report_id, created_at, title, thesis, roi_score, roi_formula_version, tags,
       factor_demand, factor_expense_of_problem, factor_buildability, factor_competitive_gap,
       status, selected_at
     )
     VALUES (
       @id, @report_id, @created_at, @title, @thesis, @roi_score, @roi_formula_version, @tags,
       @factor_demand, @factor_expense_of_problem, @factor_buildability, @factor_competitive_gap,
       @status, @selected_at
     )`,
  ).run(row);
  emitEvent({
    agentAddress: report.agent_address,
    role: "Intelligence",
    subRole: "Opportunity Scouting",
    eventType: "opportunity_found",
    message: `New opportunity: "${title}"${roiScore !== null ? ` (ROI score ${roiScore})` : ""}`,
    metadata: { opportunityId: row.id, reportId },
  });
  return hydrateOpportunity(row);
}

export function getOpportunity(id: string): Opportunity | undefined {
  const row = db.prepare(`SELECT * FROM opportunities WHERE id = ?`).get(id) as
    | OpportunityRow
    | undefined;
  return row ? hydrateOpportunity(row) : undefined;
}

/** All opportunities scored out of one report, most-recent-first. */
export function listOpportunitiesForReport(reportId: string): Opportunity[] {
  const rows = db
    .prepare(`SELECT * FROM opportunities WHERE report_id = ? ORDER BY created_at DESC`)
    .all(reportId) as OpportunityRow[];
  return rows.map(hydrateOpportunity);
}

/**
 * Updates an existing opportunity's roi_score. Exists so a future
 * scoring pass (3a/3b) or a de-dup merge (3c) can attach or revise a
 * score without this phase needing to define what re-scoring policy
 * looks like — it's a plain field write, not a ranking decision.
 */
export function setOpportunityRoiScore(id: string, roiScore: number): Opportunity {
  if (!Number.isFinite(roiScore)) {
    throw new Error("roiScore must be a finite number");
  }
  const existing = getOpportunity(id);
  if (!existing) {
    throw new Error(`opportunity ${id} not found`);
  }
  db.prepare(`UPDATE opportunities SET roi_score = ? WHERE id = ?`).run(roiScore, id);
  return { ...existing, roi_score: roiScore };
}

/**
 * Adds `tag` to `id`'s tags if it isn't already there. Idempotent —
 * calling it twice with the same tag is a no-op the second time — so
 * Phase 6e's escalation path (below) can call this on every
 * assess_regulatory_risk pass without first checking whether the tag
 * already landed.
 */
export function addOpportunityTag(id: string, tag: string): Opportunity {
  const existing = getOpportunity(id);
  if (!existing) {
    throw new Error(`opportunity ${id} not found`);
  }
  if (existing.tags.includes(tag)) {
    return existing;
  }
  const tags = [...existing.tags, tag];
  db.prepare(`UPDATE opportunities SET tags = ? WHERE id = ?`).run(JSON.stringify(tags), id);
  return { ...existing, tags };
}

// ─── Phase 1c: research_findings / finance_findings / strategy_findings ─

/**
 * The three department-finding tables are identically shaped (see
 * db.ts's Phase 1c comment for why they're three physical tables
 * rather than one polymorphic one). `kind` picks which table a call
 * operates on; it's never interpolated from anything but this
 * literal union, so building the SQL string with it is safe.
 */
export type FindingKind = "research" | "finance" | "strategy";

const FINDING_TABLE: Record<FindingKind, string> = {
  research: "research_findings",
  finance: "finance_findings",
  strategy: "strategy_findings",
};

export interface Finding<T = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  created_at: number;
  version: number;
  superseded: boolean;
  findings: T;
}

/** Shape as it actually sits in SQLite: superseded is 0/1, findings is JSON TEXT. */
interface FindingRow {
  id: string;
  opportunity_id: string;
  created_at: number;
  version: number;
  superseded: number;
  findings: string;
}

function hydrateFinding<T>(row: FindingRow): Finding<T> {
  return {
    id: row.id,
    opportunity_id: row.opportunity_id,
    created_at: row.created_at,
    version: row.version,
    superseded: row.superseded !== 0,
    findings: JSON.parse(row.findings) as T,
  };
}

/**
 * Records one department pass against `opportunityId`. This is the 1c
 * data-access primitive, not any of Phase 5/6/8/9/11/12's tools: it
 * does not know what a market-size estimate or a fit score looks like
 * — `findings` is opaque JSON as far as this function is concerned,
 * the same way createOpportunity() (1b) doesn't compute roi_score.
 *
 * "Versioned, a department can re-run and supersede its own prior
 * finding" (Zent.md 1c) is implemented as: find this opportunity's
 * current (non-superseded) row for this table, if any; mark it
 * superseded; insert the new row at version+1 with superseded=0. Both
 * writes happen in one transaction so a crash between them can never
 * leave two "current" rows, or zero, for the same opportunity_id.
 *
 * opportunityId must name an existing `opportunities` row; the FK
 * constraint would catch a dangling reference at the SQLite level
 * too, but failing fast here with a clear message matches
 * createOpportunity()'s own check against its parent report.
 */
export function createFinding<T = Record<string, unknown>>(
  kind: FindingKind,
  opportunityId: string,
  findings: T,
): Finding<T> {
  if (!opportunityId) {
    throw new Error("opportunityId is required");
  }
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const table = FINDING_TABLE[kind];

  const insert = db.transaction((row: FindingRow) => {
    db.prepare(
      `UPDATE ${table} SET superseded = 1 WHERE opportunity_id = ? AND superseded = 0`,
    ).run(row.opportunity_id);
    db.prepare(
      `INSERT INTO ${table} (id, opportunity_id, created_at, version, superseded, findings)
       VALUES (@id, @opportunity_id, @created_at, @version, @superseded, @findings)`,
    ).run(row);
  });

  const priorVersion = db
    .prepare(`SELECT MAX(version) AS v FROM ${table} WHERE opportunity_id = ?`)
    .get(opportunityId) as { v: number | null };

  const row: FindingRow = {
    id: `${kind === "research" ? "resf" : kind === "finance" ? "finf" : "stgf"}_${ulid()}`,
    opportunity_id: opportunityId,
    created_at: Date.now(),
    version: (priorVersion.v ?? 0) + 1,
    superseded: 0,
    findings: JSON.stringify(findings ?? {}),
  };
  insert(row);

  // Zent.md Phase 5a: "torn down when its finding is filed." This is
  // the one chokepoint every research finding write passes through —
  // Phase 5b/5c/5d's individual tools and Phase 7a's
  // compile_research_report() alike all end up calling
  // createResearchFinding() (below), which is this function with
  // kind="research" — so it's the correct place to fire the teardown,
  // rather than duplicating the check in each future tool.
  //
  // departments.ts is imported dynamically, not at module top-level,
  // specifically to avoid a static circular import: departments.ts
  // already imports isEligibleForExpansion from this file (Phase 2e),
  // so a static top-of-file `import { retireResearchDepartmentForOpportunity }
  // from "./departments.js"` here would close that into a real cycle.
  // A dynamic import resolves lazily at call time instead, after both
  // modules have finished initializing, so the cycle never actually
  // matters. Fire-and-forget (not awaited) and best-effort (caught, not
  // rethrown) for the same reason every other post-write side effect in
  // this codebase is (archiveWorkerOutput's own callers, this file's
  // header comment on expansion_notifications.delivered): a department
  // failing to tear down cleanly must never make the finding itself
  // fail to save, and a caller of createResearchFinding() has no reason
  // to block on — or even know about — departments.ts's own cascade.
  if (kind === "research") {
    import("./departments.js")
      .then((departments) => departments.retireResearchDepartmentForOpportunity(opportunityId))
      .catch((err) => {
        console.error(
          `[expansion] failed to retire research department for opportunity ${opportunityId}:`,
          err?.message || err,
        );
      });
  }

  return hydrateFinding<T>(row);
}

/** The single current (non-superseded) finding for an opportunity, or undefined if none has run yet. */
export function getCurrentFinding<T = Record<string, unknown>>(
  kind: FindingKind,
  opportunityId: string,
): Finding<T> | undefined {
  const table = FINDING_TABLE[kind];
  const row = db
    .prepare(`SELECT * FROM ${table} WHERE opportunity_id = ? AND superseded = 0`)
    .get(opportunityId) as FindingRow | undefined;
  return row ? hydrateFinding<T>(row) : undefined;
}

/** Full version history for an opportunity, most-recent-first — includes superseded rows. */
export function listFindingVersions<T = Record<string, unknown>>(
  kind: FindingKind,
  opportunityId: string,
): Finding<T>[] {
  const table = FINDING_TABLE[kind];
  const rows = db
    .prepare(`SELECT * FROM ${table} WHERE opportunity_id = ? ORDER BY version DESC`)
    .all(opportunityId) as FindingRow[];
  return rows.map((row) => hydrateFinding<T>(row));
}

// Thin, named wrappers per department — same reasoning as Zent.md 2c's
// list_customer_complaints/list_demand_signals wrapping scan_market_signals:
// callers (and later, tool call logs) read "createResearchFinding" far
// more legibly than "createFinding('research', ...)" scattered through
// Phase 5/8/11's eventual tool implementations.

export const createResearchFinding = <T = Record<string, unknown>>(
  opportunityId: string,
  findings: T,
) => createFinding<T>("research", opportunityId, findings);
export const getCurrentResearchFinding = <T = Record<string, unknown>>(opportunityId: string) =>
  getCurrentFinding<T>("research", opportunityId);

// ─── Phase 5b: estimate_market_size(opportunity_id) ────────────────────
//
// research_findings.findings is one JSON blob per version (1c), and
// Phase 6d already commits Research to "one report per opportunity, not
// [a report per tool]" — so 5b/5c/5d don't each get their own row, they
// each read-merge-write the SAME logical object: fetch whatever the
// current (non-superseded) research finding already holds, overlay this
// tool's own key, and call createResearchFinding() with the merged
// object. That's a fresh version every call (matching 1c's "a
// department can re-run and supersede its own prior finding" for THIS
// tool specifically), while any market_size a prior estimate_market_size
// call recorded (or, once 5c/5d land, `competition`/`customer_segments`)
// stays intact under the other keys rather than being clobbered.
//
// mergeIntoCurrentResearchFinding() is the one place that read-merge-
// write happens, so 5c/5d can reuse it instead of re-deriving the same
// "fetch current, spread, overlay one key" logic three times.
export function mergeIntoCurrentResearchFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): Finding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createResearchFinding<Record<string, unknown>>(opportunityId, merged);
}

/**
 * One estimate_market_size(opportunity_id) call's payload, as it sits
 * under research_findings.findings.market_size. `results` is the same
 * {title, url, snippet} shape formatMarketSignalEntry() already uses
 * for Opportunity Intelligence's own web-search-backed tools (Zent.md
 * 5b: "web-search backed") — Research's market-size estimate is raw
 * search evidence, not a single fabricated number, so the department
 * (and later, Finance/Strategy/the CEO reading the compiled report,
 * Phase 7a) sees exactly what the estimate is grounded in rather than
 * a bare dollar figure with no source.
 */
export interface MarketSizeEstimate {
  query: string;
  results: MarketSignalResult[];
  estimatedAt: number;
}

/**
 * Records one estimate_market_size(opportunity_id) pass. Pure data
 * write — expansionRoutes.ts's own route does the actual search (via
 * the same DuckDuckGo path 2b's scanMarketSignals() uses) and query-
 * building from the opportunity's title/thesis, then calls this with
 * the results, the same "search happens in the route, this function
 * only persists the outcome" split createOpportunity()/appendSourceSummary()
 * already draw.
 */
export function recordMarketSizeEstimate(
  opportunityId: string,
  estimate: MarketSizeEstimate,
): Finding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { market_size: estimate });
}

// ─── Phase 5c: survey_competition(opportunity_id) ───────────────────────
//
// "Lists incumbents, pricing tiers, obvious gaps" (Zent.md 5c). Same
// shape as 5b in every structural way: web-search backed via
// expansionRoutes.ts's scanMarketSignals(), one opportunity-derived
// query (no caller-supplied argument to trust), and persisted through
// mergeIntoCurrentResearchFinding() so this call's `competition` key
// lands alongside whatever `market_size` (5b) or `customer_segments`
// (5d) already sit on the current research finding, rather than
// overwriting them. Structured `incumbents`/`pricingTiers`/`gaps`
// arrays are left for whichever tool call synthesizes this raw search
// evidence downstream (7a's compile_research_report) — this function's
// own job, matching recordMarketSizeEstimate()'s, is "raw search
// evidence in, evidence recorded" — it never asserts an incumbent name
// or price point wasn't in the model's training data to begin with.

/**
 * One survey_competition(opportunity_id) call's payload, as it sits
 * under research_findings.findings.competition. Same {title, url,
 * snippet} raw-evidence shape recordMarketSizeEstimate()'s own
 * docstring explains the reasoning for — a competitor survey is what
 * the search actually turned up, not a department's unsourced claim
 * about who the incumbents are.
 */
export interface CompetitionSurvey {
  query: string;
  results: MarketSignalResult[];
  surveyedAt: number;
}

/**
 * Records one survey_competition(opportunity_id) pass. Same
 * "expansionRoutes.ts does the search and query-building, this
 * function only persists the outcome" split recordMarketSizeEstimate()
 * already draws.
 */
export function recordCompetitionSurvey(
  opportunityId: string,
  survey: CompetitionSurvey,
): Finding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { competition: survey });
}

// ─── Phase 5d: identify_customer_segments(opportunity_id) ───────────────
//
// "Who actually buys this, and how they currently solve the problem"
// (Zent.md 5d) — the third and last of the three capabilities 5a's own
// comment predicted for `research`. Same structural shape as 5b/5c
// once more: web-search backed, one opportunity-derived query, no
// caller-supplied argument, persisted through
// mergeIntoCurrentResearchFinding() under its own `customer_segments`
// key so it sits alongside `market_size`/`competition` on the same
// finding rather than displacing either. This closes out the three
// tools Phase 5 predicted; 6a-6d layer risk/feasibility scoring onto
// this same finding next, still through the same merge helper.

/**
 * One identify_customer_segments(opportunity_id) call's payload, as it
 * sits under research_findings.findings.customer_segments. Same raw-
 * evidence shape recordMarketSizeEstimate()/recordCompetitionSurvey()
 * already use — who buys and how they solve it today, as the search
 * actually returned it, not a department's own unsourced claim about
 * the buyer.
 */
export interface CustomerSegmentsFinding {
  query: string;
  results: MarketSignalResult[];
  identifiedAt: number;
}

/**
 * Records one identify_customer_segments(opportunity_id) pass. Same
 * "expansionRoutes.ts does the search and query-building, this
 * function only persists the outcome" split 5b/5c's own record
 * functions already draw.
 */
export function recordCustomerSegments(
  opportunityId: string,
  segments: CustomerSegmentsFinding,
): Finding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { customer_segments: segments });
}

// ─── Phase 5e: confidence + sources on every research_findings row ──────
//
// "Every research_findings row carries a self-reported confidence
// (low/med/high) plus the sources it used — downstream departments and
// the CEO gate can weight on this" (Zent.md 5e). Like 5b/5c/5d, this
// isn't a new DB column (research_findings' shape was already locked
// in 1c as id/opportunity_id/created_at/version/superseded/findings) —
// `confidence` and `sources` are two more top-level keys inside the
// same `findings` JSON blob, written through the same
// mergeIntoCurrentResearchFinding() every other Phase 5 tool uses, so
// they ride along on whichever version is current the same way
// `market_size`/`competition`/`customer_segments` already do.
//
// "Self-reported" only covers the confidence *level* — the model's own
// read of how solid its pass was. `sources` is deliberately NOT a
// second self-reported field a department types out by hand: Research
// already ran 0-3 web-search-backed tools (5b/5c/5d) before calling
// this one, and every one of those searches already has real URLs
// sitting in market_size.results / competition.results /
// customer_segments.results on the current finding. Re-typing "the
// sources it used" as free text would let a low-effort pass claim
// sources it never actually queried — the same "the record is exactly
// what happened, not a self-report of what happened" reasoning
// isEligibleForExpansion()'s own header gives for reading real
// balance/spend history instead of trusting a claimed figure. So
// `sources` here is computed, not accepted as caller input: every
// distinct URL already on the current finding, deduped, in the order
// discovered — self-reporting a source list would be strictly less
// trustworthy than just reading back what was actually searched.
export type ResearchConfidence = "low" | "med" | "high";

const RESEARCH_CONFIDENCE_LEVELS: ResearchConfidence[] = ["low", "med", "high"];

export function isValidResearchConfidence(value: unknown): value is ResearchConfidence {
  return (
    typeof value === "string" &&
    (RESEARCH_CONFIDENCE_LEVELS as string[]).includes(value)
  );
}

/**
 * Every distinct URL already recorded on `opportunityId`'s current
 * research finding, pulled from whichever of market_size/competition/
 * customer_segments/technical_requirements have actually run so far
 * (any subset — 5e doesn't require all four, and 6a's own field wasn't
 * built yet when 5e first landed but slots into this same aggregation
 * rather than needing a second confidence mechanism), in first-seen
 * order. Returns [] if no Phase 5/6a tool has run yet; that's a
 * legitimate "confidence, but zero sources behind it" state, not an
 * error — the CEO gate (Phase 15) is exactly the kind of downstream
 * reader Zent.md 5e says should be able to weight on that.
 */
export function collectCurrentResearchSources(opportunityId: string): string[] {
  const current = getCurrentResearchFinding(opportunityId);
  if (!current) return [];
  const findings = current.findings as {
    market_size?: MarketSizeEstimate;
    competition?: CompetitionSurvey;
    customer_segments?: CustomerSegmentsFinding;
    technical_requirements?: TechnicalRequirementsAssessment;
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

/**
 * 6e's "weighted into Research's own confidence field" half: a
 * department can't self-report "high" confidence while sitting on an
 * unresolved 6b high-regulatory-risk flag it hasn't addressed — that
 * one combination gets capped down to "med" here, deterministically
 * (same "documented, not left to the model to invent per-call" posture
 * 6b's own keyword list and 6d's own scoreResearchRisk() already use).
 * "low"/"med" self-reports, and any confidence where 6b hasn't flagged
 * high risk (or hasn't run yet), pass through untouched. Pure function
 * — no DB access, no opportunity_id — same split classifyRegulatoryRisk()
 * (6b) and checkBuildability() (6c) already keep. Returns the original
 * self-report too, but only when it was actually capped, so the
 * record stays exactly what the department claimed even after being
 * downweighted, rather than the cap silently overwriting it.
 */
export function weighResearchConfidenceForRegulatoryRisk(
  confidence: ResearchConfidence,
  regulatoryRiskLevel: RegulatoryRiskLevel | null | undefined,
): { effectiveConfidence: ResearchConfidence; selfReportedConfidence: ResearchConfidence | null } {
  const capped = regulatoryRiskLevel === "high" && confidence === "high";
  return {
    effectiveConfidence: capped ? "med" : confidence,
    selfReportedConfidence: capped ? confidence : null,
  };
}

/**
 * Records one report_research_confidence(opportunity_id, confidence)
 * pass: merges the (possibly 6e-capped) `confidence`, `sources`
 * (computed via collectCurrentResearchSources(), never caller-supplied),
 * and — only when capping actually happened — `selfReportedConfidence`
 * onto the current research finding. Like 5b/5c/5d's own record
 * functions, this is a fresh version — a department can re-report its
 * confidence as later passes change what it found, and each report
 * stays in history rather than mutating a prior one, matching 1c's own
 * versioning rule.
 */
export function recordResearchConfidence(
  opportunityId: string,
  confidence: ResearchConfidence,
): Finding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const regulatoryRiskLevel = (
    current?.findings as { regulatory_risk?: RegulatoryRiskAssessment } | undefined
  )?.regulatory_risk?.riskLevel;
  const { effectiveConfidence, selfReportedConfidence } = weighResearchConfidenceForRegulatoryRisk(
    confidence,
    regulatoryRiskLevel,
  );
  const sources = collectCurrentResearchSources(opportunityId);
  // selfReportedConfidence is always written explicitly (as null when
  // this pass wasn't capped), never conditionally omitted — merge is
  // additive-only (mergeIntoCurrentResearchFinding() spreads the prior
  // findings under the new patch), so a key this function doesn't set
  // on an uncapped pass would otherwise leak a stale "high" forward
  // from an earlier capped version instead of correctly clearing.
  return mergeIntoCurrentResearchFinding(opportunityId, {
    confidence: effectiveConfidence,
    sources,
    selfReportedConfidence,
  });
}

export const listResearchFindingVersions = <T = Record<string, unknown>>(opportunityId: string) =>
  listFindingVersions<T>("research", opportunityId);

// ─── Phase 6a: assess_technical_requirements(opportunity_id) ────────────
//
// "What would Agent B actually need to build, in terms of this stack's
// existing tool/skill catalog" (Zent.md 6a). Same structural shape as
// 5b/5c/5d: single opportunity-derived query, no caller-supplied
// argument, web-search backed via expansionRoutes.ts's own
// scanMarketSignals() path, persisted through
// mergeIntoCurrentResearchFinding() under its own `technical_requirements`
// key so it lands alongside market_size/competition/customer_segments on
// the same finding rather than a second report (6d: "Research produces
// one report per opportunity, not two"). Same raw-evidence posture as
// 5b/5c/5d too — this records what the search turned up about what
// building the thing typically takes, not a verdict on whether today's
// tool catalog already covers it. That verdict is 6c's own job
// ("buildability check against toolRegistrySeedData.ts/skillsRoutes.ts"),
// which reads this field rather than re-deriving it.
export interface TechnicalRequirementsAssessment {
  query: string;
  results: MarketSignalResult[];
  assessedAt: number;
}

/**
 * Records one assess_technical_requirements(opportunity_id) pass.
 * Same "expansionRoutes.ts does the search and query-building, this
 * function only persists the outcome" split 5b/5c/5d's own record
 * functions already draw.
 */
export function recordTechnicalRequirements(
  opportunityId: string,
  assessment: TechnicalRequirementsAssessment,
): Finding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, {
    technical_requirements: assessment,
  });
}

// ─── Phase 6b: assess_regulatory_risk(opportunity_id) ───────────────────
//
// "Flags healthcare/finance/legal-style domains that need real
// compliance work a pure software agent can't discharge alone"
// (Zent.md 6b). Deliberately NOT web-search backed the way 5b/5c/5d/6a
// are — Zent.md's own wording for those four says "web-search backed"
// explicitly; 6b's doesn't. This is a deterministic classification
// over the opportunity's own title/thesis/tags against a fixed,
// documented keyword list, same "deterministic formula, documented not
// left to the model to invent per-call" posture 3b's own header uses
// for the ROI formula — a flag this consequential (6e: it gets tagged
// `high_regulatory_risk` and weighted into Research's confidence field)
// needs to be reproducible from the same opportunity every time, not a
// per-call judgment call with no fixed rule behind it.
//
// Persisted through mergeIntoCurrentResearchFinding() under its own
// `regulatory_risk` key, same accumulate-not-clobber shape 5b/5c/5d/6a
// already use. 6e's own escalation-path job (not built yet) is to read
// this field's `riskLevel` and act on it — this function only records
// the classification, it doesn't itself weight anything into 5e's
// confidence field.
export type RegulatoryDomain = "healthcare" | "finance" | "legal";
export type RegulatoryRiskLevel = "none" | "high";

// One fixed keyword list per regulated domain, matched
// case-insensitively as whole words against the opportunity's
// title + thesis + tags. Intentionally narrow and literal (no stemming,
// no synonym expansion) so a match is always auditable back to the
// exact word that triggered it — the same "the record is exactly what
// happened" reasoning 5e's own header gives for computing `sources`
// instead of trusting a self-report.
export const REGULATORY_DOMAIN_KEYWORDS: Record<RegulatoryDomain, string[]> = {
  healthcare: [
    "health",
    "healthcare",
    "medical",
    "medicine",
    "patient",
    "patients",
    "clinical",
    "clinic",
    "clinics",
    "hospital",
    "hospitals",
    "diagnosis",
    "diagnostic",
    "therapy",
    "therapist",
    "prescription",
    "pharma",
    "pharmacy",
    "hipaa",
    "telehealth",
    "ehr",
    "emr",
  ],
  finance: [
    "finance",
    "financial",
    "banking",
    "bank",
    "lending",
    "loan",
    "loans",
    "credit",
    "insurance",
    "insurer",
    "insurers",
    "securities",
    "investment",
    "investing",
    "brokerage",
    "trading",
    "payments",
    "payment",
    "custody",
    "aml",
    "kyc",
    "money transmitter",
    "money transmission",
  ],
  legal: [
    "legal",
    "law",
    "lawyer",
    "lawyers",
    "attorney",
    "litigation",
    "contract review",
    "compliance",
    "regulatory filing",
    "notary",
    "immigration",
    "custody dispute",
    "court filing",
  ],
};

/**
 * Matches `text` against one domain's fixed keyword list, whole-word,
 * case-insensitive. Multi-word keywords (e.g. "money transmitter")
 * match as a literal substring rather than a whole-word regex, since
 * `\b` boundaries around a phrase already do the right thing.
 */
function matchDomainKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(lower)) matched.push(keyword);
  }
  return matched;
}

export interface RegulatoryDomainMatch {
  domain: RegulatoryDomain;
  matchedKeywords: string[];
}

export interface RegulatoryRiskAssessment {
  domains: RegulatoryDomainMatch[];
  riskLevel: RegulatoryRiskLevel;
  assessedAt: number;
}

/**
 * Classifies an opportunity's title + thesis + tags against
 * REGULATORY_DOMAIN_KEYWORDS. Returns one RegulatoryDomainMatch per
 * domain that had at least one keyword hit (domains with zero matches
 * are omitted, not included with an empty array) plus an overall
 * `riskLevel`: "high" if any domain matched, "none" otherwise. This is
 * pure text-in, classification-out — no DB access, no opportunity_id —
 * so expansionRoutes.ts's route (which does own the opportunity_id and
 * persistence) can unit-test the classification separately from the
 * merge-and-record step, the same split scoring's computeRoiScore()
 * already keeps from score_opportunity's own route handler.
 */
export function classifyRegulatoryRisk(
  title: string,
  thesis: string,
  tags: string[],
): { domains: RegulatoryDomainMatch[]; riskLevel: RegulatoryRiskLevel } {
  const haystack = [title, thesis, ...(tags ?? [])].join(" ");
  const domains: RegulatoryDomainMatch[] = [];
  for (const domain of Object.keys(REGULATORY_DOMAIN_KEYWORDS) as RegulatoryDomain[]) {
    const matchedKeywords = matchDomainKeywords(haystack, REGULATORY_DOMAIN_KEYWORDS[domain]);
    if (matchedKeywords.length > 0) {
      domains.push({ domain, matchedKeywords });
    }
  }
  return { domains, riskLevel: domains.length > 0 ? "high" : "none" };
}

/**
 * Records one assess_regulatory_risk(opportunity_id) pass. Same
 * "expansionRoutes.ts calls the pure classifier, this function only
 * persists the outcome" split recordTechnicalRequirements() and its
 * 5b/5c/5d siblings already use — but here the route calls
 * classifyRegulatoryRisk() (above, same file) instead of a
 * network-backed scanMarketSignals(), since 6b is deterministic, not
 * web-search backed.
 */
export function recordRegulatoryRiskAssessment(
  opportunityId: string,
  assessment: RegulatoryRiskAssessment,
): Finding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, {
    regulatory_risk: assessment,
  });
}

// ─── Phase 6c: buildability check against the tool/skill catalog ────────
//
// "Buildability check against toolRegistrySeedData.ts/skillsRoutes.ts:
// can an agent with today's tool catalog actually execute on this, or
// does it need new tools first (flag, don't block)" (Zent.md 6c).
//
// Reuses tfidf.ts's scoreCorpus() — same "TF-IDF cosine similarity,
// reusing tfidf.ts" shape 3c's own dedup pass already established for
// this codebase's one deterministic similarity metric, rather than a
// second from-scratch one. The query side is the opportunity's own
// title/thesis/tags plus whatever raw search evidence 6a's
// assess_technical_requirements already collected (buildBuildabilityQueryText);
// the corpus side is every tool_registry seed row (toolRegistrySeedData.ts's
// SEED_ROWS — literally "today's tool catalog," company-wide across every
// tier/department type) plus the calling agent's own already-created
// skills (skills.ts's listSkills() — the runtime data skillsRoutes.ts's
// HTTP surface exposes, imported directly here the same "read the
// underlying module, not its HTTP wrapper" way 6a/6b read expansion.ts's
// own siblings rather than looping back through an HTTP call).
//
// "Flag, don't block" is structural, not a runtime check this code has
// to remember to honor: checkBuildability() only ever returns data
// (`matches`, `flagged`) for the route to persist — there's no
// rejection path here at all, unlike 3c's dedup (which does 409) or
// 3e's kill condition (which stops the cycle). A `flagged: true` result
// is exactly as valid an outcome as `flagged: false`; 6c's own header
// says as much, and Research's own report (7a, not built yet) is where
// a flagged buildability gap becomes visible to Finance/Strategy/the
// CEO — it never stops this tool call from succeeding.
export interface BuildabilityMatch {
  name: string;
  source: "tool_registry" | "skill";
  score: number;
}

export interface BuildabilityAssessment {
  matches: BuildabilityMatch[];
  /** True iff no catalog entry cleared `threshold` — "might need new
   *  tools first," per 6c's own wording. Never blocks anything. */
  flagged: boolean;
  threshold: number;
  assessedAt: number;
}

export interface BuildabilityCatalogEntry {
  name: string;
  description: string;
  source: "tool_registry" | "skill";
}

/**
 * Assembles the "today's tool catalog" corpus 6c checks against:
 * every tool_registry seed row (SEED_ROWS — every tier, every
 * department type; Agent B inherits the same unrestricted agent-tier
 * catalog per 17b's constitution-inheritance and 16d's "independent
 * gets the default grant set", and can itself spawn any department
 * type, so the *union* of the whole seed — not just one tier's slice —
 * is the honest answer to "does this stack support building this at
 * all") plus `agentAddress`'s own already-created skills (skills.ts's
 * listSkills() — a Company A skill Agent B could inherit or reuse per
 * 18d's sibling-discovery theme).
 */
export function buildBuildabilityCatalog(agentAddress: string): BuildabilityCatalogEntry[] {
  return [
    ...SEED_ROWS.map((row) => ({
      name: row.name,
      description: row.description,
      source: "tool_registry" as const,
    })),
    ...listSkills(agentAddress).map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: "skill" as const,
    })),
  ];
}

/**
 * Builds the query-side text checkBuildability() compares against the
 * catalog: title + thesis + tags (Phase 1b's own structured fields)
 * plus every title+snippet pair 6a's assess_technical_requirements
 * already collected as search evidence, if any has run yet.
 * `technicalRequirements` is optional — 6c can run before 6a has (the
 * TF-IDF signal is just weaker, exactly like 3c's dedup degrades
 * gracefully with a thin corpus rather than erroring).
 */
export function buildBuildabilityQueryText(
  opportunity: Pick<Opportunity, "title" | "thesis" | "tags">,
  technicalRequirements?: TechnicalRequirementsAssessment,
): string {
  const evidence = (technicalRequirements?.results ?? [])
    .map((r) => `${r.title} ${r.snippet}`)
    .join(" ");
  return [opportunity.title, opportunity.thesis, ...(opportunity.tags ?? []), evidence]
    .filter((part) => part && part.trim().length > 0)
    .join("\n");
}

/**
 * Pure scoring function: no DB access, no opportunity_id — same split
 * classifyRegulatoryRisk() (6b) already keeps, so the route (which owns
 * the opportunity_id/agentAddress lookups and persistence) can be
 * tested separately from the similarity metric itself. Returns every
 * catalog entry at or above `threshold` (default:
 * config.buildabilityMatchThreshold), sorted highest-similarity first,
 * plus `flagged: true` iff that set is empty.
 */
export function checkBuildability(
  queryText: string,
  catalog: BuildabilityCatalogEntry[],
  threshold: number = config.buildabilityMatchThreshold,
): { matches: BuildabilityMatch[]; flagged: boolean } {
  const scored = scoreCorpus(queryText, catalog, (item) => `${item.name} ${item.description}`);
  const matches = scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ name: s.item.name, source: s.item.source, score: s.score }));
  return { matches, flagged: matches.length === 0 };
}

/**
 * Records one buildability-check pass. Same "expansionRoutes.ts
 * assembles the inputs and calls the pure function, this function only
 * persists the outcome" split every Phase 6 sibling already uses.
 */
export function recordBuildabilityAssessment(
  opportunityId: string,
  assessment: BuildabilityAssessment,
): Finding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, {
    buildability: assessment,
  });
}

// ─── Phase 6d: risk scoring merged into research_findings ───────────────
//
// "Risk scoring merged into research_findings alongside the market
// data — Research produces one report per opportunity, not two"
// (Zent.md 6d). Two separate claims, both already true of everything
// 5b-6c built, and both closed out here rather than re-litigated:
//
// "One report, not two" is a structural guarantee, not a runtime
// check anyone has to remember to honor — createFinding() (1c) marks
// the prior row superseded and inserts the new one in a single
// transaction (see its own header), so there is, by construction,
// exactly one non-superseded research_findings row per opportunity at
// any time, no matter how many of 5b/5c/5d/5e/6a/6b/6c/6d have run
// against it. countCurrentResearchFindings() below exists to make that
// invariant checkable (by this file's own test, and by Phase 20a's
// eventual end-to-end test) rather than just asserted in a comment.
//
// "Risk scoring merged ... alongside the market data" is the one
// genuinely new piece: 6b (regulatory_risk) and 6c (buildability) each
// already merge their own raw verdict onto the same finding via
// mergeIntoCurrentResearchFinding() — but nothing yet reads those two
// verdicts together and produces the single consolidated risk picture
// Finance/Strategy/the CEO gate (Phases 10/12/15) actually want to
// read. scoreResearchRisk() is that consolidation: a deterministic,
// documented formula (same "documented, not left to the model to
// invent per-call" posture 3b's ROI formula and 6b's own keyword list
// already use) over whatever subset of 6b/6c has run so far, merged
// under its own `risk_scoring` key on the SAME finding — never a
// second report, per 6d's own wording.
export type ResearchOverallRiskLevel = "unknown" | "low" | "medium" | "high";

// Regulatory risk is weighted above buildability on purpose: a
// buildability gap ("flag, don't block", 6c) just means Agent B needs
// new tools before it can execute — cheap to address, doesn't touch
// whether the business itself is legal to run. A high regulatory flag
// (6b: "compliance work a pure software agent can't discharge alone")
// is a harder, structural problem, so it alone is enough to clear the
// "high" threshold below; buildability alone tops out at "medium."
export const RESEARCH_RISK_WEIGHTS = {
  regulatoryHigh: 70,
  buildabilityFlagged: 30,
} as const;

/**
 * Pure scoring function: takes whatever 6b/6c have already recorded
 * (either may be `null` if that tool hasn't run yet on this
 * opportunity — 6d doesn't require 6a-6c to have all landed first, the
 * same graceful-with-a-thin-signal posture 6c's own buildability check
 * takes toward 6a not having run yet) and returns one consolidated
 * verdict. No DB access, no opportunity_id — same split
 * classifyRegulatoryRisk() (6b) and checkBuildability() (6c) already
 * keep, so the scoring rule itself is unit-testable independent of the
 * merge/persistence step.
 *
 * `overallRiskLevel` is "unknown" only when NEITHER 6b nor 6c has run
 * yet — the honest "no signal at all" state, not defaulted to "low."
 * Once at least one has run, the score is computed from whatever
 * exists (an unassessed dimension contributes 0, exactly like 5e's own
 * confidence field reads back only the sources that actually ran
 * rather than assuming the rest are clean).
 */
export function scoreResearchRisk(
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

export interface ResearchRiskScoring {
  regulatoryRiskLevel: RegulatoryRiskLevel | null;
  buildabilityFlagged: boolean | null;
  overallRiskLevel: ResearchOverallRiskLevel;
  score: number;
  scoredAt: number;
}

/**
 * Reads whatever `regulatory_risk`/`buildability` already sit on
 * `opportunityId`'s current research finding (either, both, or
 * neither may exist yet), runs scoreResearchRisk() over them, and
 * merges the result onto that SAME finding under `risk_scoring` —
 * via mergeIntoCurrentResearchFinding(), the one merge point 5b
 * established and every Phase 5/6 tool since has reused, so this can
 * never produce a second report no matter when in the 6a-6c sequence
 * it's called. Safe to call more than once (e.g. after 6b runs, then
 * again after 6c runs) — each call is a fresh version, same as every
 * other Phase 5/6 record function, and simply reflects more signal
 * once it exists.
 */
export function computeAndRecordResearchRiskScoring(
  opportunityId: string,
): Finding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const findings = current?.findings as
    | { regulatory_risk?: RegulatoryRiskAssessment; buildability?: BuildabilityAssessment }
    | undefined;
  const regulatoryRiskLevel = findings?.regulatory_risk?.riskLevel ?? null;
  const buildabilityFlagged = findings?.buildability?.flagged ?? null;
  const { overallRiskLevel, score } = scoreResearchRisk(regulatoryRiskLevel, buildabilityFlagged);
  const risk_scoring: ResearchRiskScoring = {
    regulatoryRiskLevel,
    buildabilityFlagged,
    overallRiskLevel,
    score,
    scoredAt: Date.now(),
  };
  return mergeIntoCurrentResearchFinding(opportunityId, { risk_scoring });
}

/**
 * The "one report, not two" half of 6d, made checkable rather than
 * just true-by-construction: counts non-superseded research_findings
 * rows for `opportunityId`, which createFinding()'s own
 * supersede-then-insert transaction (1c) guarantees is always 0 or 1.
 * Exposed for this file's own test and for Phase 20a's eventual
 * end-to-end test to assert against directly, rather than trusting
 * the comment above createFinding().
 */
export function countCurrentResearchFindings(opportunityId: string): number {
  const table = FINDING_TABLE.research;
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE opportunity_id = ? AND superseded = 0`)
    .get(opportunityId) as { c: number };
  return row.c;
}

// ─── Phase 6e: escalation path for a high regulatory-risk flag ──────────
//
// "If 6b flags high regulatory risk, the finding is tagged
// `high_regulatory_risk` and weighted into Research's own confidence
// field (5e) — it flows to Finance and Strategy like any other signal,
// rather than blocking the pipeline" (Zent.md 6e). Two halves:
//
// The confidence-weighting half already lives on recordResearchConfidence()
// itself (5e, above) via weighResearchConfidenceForRegulatoryRisk() —
// keeping 6b's own classifyRegulatoryRisk()/recordRegulatoryRiskAssessment()
// exactly as their own header already promised ("this function only
// records the classification, it doesn't itself weight anything into
// 5e's confidence field") by putting the weighting where the
// confidence actually gets recorded, not inside 6b.
//
// The tagging half is applyRegulatoryRiskEscalation() below: reads
// whatever 6b already recorded and, only when riskLevel is "high",
// adds HIGH_REGULATORY_RISK_TAG to the opportunity's own tags (1b's
// `opportunities.tags[]`) via addOpportunityTag() — idempotent, so
// expansionRoutes.ts's regulatory-risk route can call this after every
// assess_regulatory_risk pass without tracking whether escalation
// already fired. Tagging the opportunity itself, not just the research
// finding, is deliberate: 3c's dedup pass, 4a/4b's listing endpoints,
// and Finance/Strategy's own eventual reads (Phase 8+) all already
// read opportunities.tags, so this is the one place a high regulatory
// flag becomes visible everywhere those already look — "flows ... like
// any other signal" — without teaching any of them a second,
// research-finding-specific field to check.
//
// Never blocks: like 6c's own checkBuildability(), this only ever
// returns data about what already happened (the tag write, if any,
// has already landed by the time this returns) — there is no
// reject/error path here. "Rather than blocking the pipeline" is
// structural, the same way it already was for 6c.
export const HIGH_REGULATORY_RISK_TAG = "high_regulatory_risk";

export function applyRegulatoryRiskEscalation(
  opportunityId: string,
): { escalated: boolean; opportunity: Opportunity } {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentResearchFinding(opportunityId);
  const riskLevel = (
    current?.findings as { regulatory_risk?: RegulatoryRiskAssessment } | undefined
  )?.regulatory_risk?.riskLevel;
  if (riskLevel !== "high") {
    return { escalated: false, opportunity };
  }
  const tagged = addOpportunityTag(opportunityId, HIGH_REGULATORY_RISK_TAG);
  return { escalated: true, opportunity: tagged };
}

// ─── Phase 7a: compile_research_report(opportunity_id) ──────────────────
//
// "Assembles 5b–6d into the single structured report the committee will
// read" (Zent.md 7a). Everything this needs is already sitting on the
// current (non-superseded) research finding — 5b/5c/5d's raw evidence,
// 6a's technical-requirements evidence, 6b/6c's regulatory/buildability
// verdicts, 6d's merged risk_scoring, and 5e/6e's confidence+sources —
// all accumulated onto that one row via mergeIntoCurrentResearchFinding()
// (5b's own header). So 7a is a *read*, not a new signal: it takes the
// same loosely-typed `findings` JSON blob every downstream consumer has
// so far been reading key-by-key (collectCurrentResearchSources(),
// applyRegulatoryRiskEscalation(), computeAndRecordResearchRiskScoring()
// all do this) and re-shapes it once into one fully-typed object, so
// Finance/Strategy/the CEO gate (Phase 7b: "so Finance/Strategy/CEO can
// parse it programmatically, not just read prose") get a locked field
// list instead of each having to know the same seven JSON keys by hand.
//
// Deliberately does NOT write anything back to research_findings: unlike
// 6d's risk_scoring (a genuinely new computed verdict, merged onto the
// finding so it persists), a compiled report has no information the
// finding didn't already have — it's a projection, not a new pass. That
// also means calling this twice in a row is always safe and always
// reflects whatever is current at call time, with no version of its own
// to go stale.
//
// Every section is nullable rather than defaulted to some placeholder:
// Research's own tools can run 5b/5c/5d/6a/6b/6c in any order, any
// subset, zero or more times (5a/6d) before this gets called, so "this
// department pass hasn't happened yet" has to be a real, distinguishable
// state here too — the same posture 6d's scoreResearchRisk() already
// takes toward 6b/6c not having run ("an unassessed dimension
// contributes 0" vs. `null` reads for "unknown").
export interface ResearchReport {
  opportunityId: string;
  /** Which research_findings row this was compiled from, and its
   *  version — null if Research hasn't run any tool for this
   *  opportunity yet, a legitimate "nothing to compile" state. */
  findingId: string | null;
  findingVersion: number | null;
  compiledAt: number;
  /** Phase 7b: which locked report contract produced this object —
   *  see RESEARCH_REPORT_SCHEMA_VERSION below. */
  schemaVersion: string;
  marketSize: MarketSizeEstimate | null;
  competition: CompetitionSurvey | null;
  customerSegments: CustomerSegmentsFinding | null;
  technicalRequirements: TechnicalRequirementsAssessment | null;
  regulatoryRisk: RegulatoryRiskAssessment | null;
  buildability: BuildabilityAssessment | null;
  riskScoring: ResearchRiskScoring | null;
  /** 5e/6e's effective (possibly regulatory-risk-capped) confidence. */
  confidence: ResearchConfidence | null;
  /** Only non-null when 6e actually capped a "high" self-report down to
   *  "med" — same distinction recordResearchConfidence() already keeps
   *  between `confidence` and this field. */
  selfReportedConfidence: ResearchConfidence | null;
  /** Every distinct source URL behind the above sections (5e's computed,
   *  not self-reported, source list). */
  sources: string[];
}

/** Shape of research_findings.findings as every Phase 5/6 tool above
 *  actually writes it — same loosely-typed read every existing
 *  cross-cutting reader (collectCurrentResearchSources(),
 *  applyRegulatoryRiskEscalation(), computeAndRecordResearchRiskScoring())
 *  already casts to; 7a is simply the first place ALL of those keys are
 *  read at once instead of one or two at a time. */
interface RawResearchFindings {
  market_size?: MarketSizeEstimate;
  competition?: CompetitionSurvey;
  customer_segments?: CustomerSegmentsFinding;
  technical_requirements?: TechnicalRequirementsAssessment;
  regulatory_risk?: RegulatoryRiskAssessment;
  buildability?: BuildabilityAssessment;
  risk_scoring?: ResearchRiskScoring;
  confidence?: ResearchConfidence;
  selfReportedConfidence?: ResearchConfidence | null;
  sources?: string[];
}

/**
 * Compiles `opportunityId`'s current research finding into the locked
 * ResearchReport shape above. Throws on an unknown opportunity_id, same
 * "fail fast with a clear message" posture createFinding() itself uses
 * — but a *known* opportunity with no research finding yet is not an
 * error (5a's department may simply not have run any tool yet): every
 * section reads back null/[] rather than throwing, so a caller can
 * compile a report at any point in Research's pass, not only after 6d.
 */
export function compileResearchReport(opportunityId: string): ResearchReport {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentResearchFinding<RawResearchFindings>(opportunityId);
  const findings = current?.findings ?? {};
  const report: ResearchReport = {
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
  // 7b's own enforcement half, not just its declaration: every report
  // this function ever hands out is checked against the locked shape
  // before it leaves this function, not just typed and trusted. This
  // can never fail today (the object literal above is built from the
  // locked field list by construction) — it exists so that if a later
  // change to this function (a renamed field, a dropped section, a
  // wrong type) ever drifts from RESEARCH_REPORT_FIELDS, it fails loud
  // and immediately at the one place every caller (7a's route, 7c's
  // eventual GET, Finance/Strategy/the CEO gate) already goes through,
  // rather than silently shipping a malformed report downstream for
  // 7e's test to catch later, or not at all.
  const shapeCheck = validateResearchReportShape(report);
  if (!shapeCheck.valid) {
    throw new Error(
      `compile_research_report produced a report that violates its own locked schema: ${shapeCheck.errors.join("; ")}`,
    );
  }
  return report;
}

// ─── Phase 7b: report schema locked down ─────────────────────────────
//
// "Report schema locked down (so Finance/Strategy/CEO can parse it
// programmatically, not just read prose)" (Zent.md 7b). 7a already gave
// the report a fully-typed TypeScript shape (ResearchReport); what 7b
// adds is the two things a compile-time type alone can't give a
// programmatic downstream reader: (1) a version tag so a consumer (or a
// future migration) can tell which contract a given report was compiled
// under — same reasoning ROI_FORMULA_VERSION (3b) already established
// for score_opportunity's formula, applied here to the report shape
// instead of a scoring rule — and (2) a runtime check that a given
// object actually satisfies that contract, since TypeScript's own types
// vanish at runtime and Finance/Strategy/the CEO gate (Phase 8+, not
// built yet) will be reading these reports well after this file's own
// compiler has stopped watching.
//
// "Locked down" means exactly what RESEARCH_REPORT_FIELDS says and
// nothing else: validateResearchReportShape() below rejects a report
// with an extra key just as readily as one missing a required key —
// Phase 7e's own stated purpose ("so a later department type can't
// silently drift the contract") is specifically about a *later* change
// quietly adding or renaming a field without updating every downstream
// reader at once, so this check has to be exact, not "at least these
// fields."
export const RESEARCH_REPORT_SCHEMA_VERSION = "7b-v1";

/** Every ResearchReport field, in the order compileResearchReport()
 *  emits them. This array IS the locked contract — 7e's eventual
 *  research-report-shape.test.ts asserts against it directly rather
 *  than re-deriving its own copy, the same "one canonical list, not a
 *  test-side guess at what the code does" posture RESEARCH_RISK_WEIGHTS
 *  (6d) already takes for its own scoring constants. */
export const RESEARCH_REPORT_FIELDS = [
  "opportunityId",
  "findingId",
  "findingVersion",
  "compiledAt",
  "schemaVersion",
  "marketSize",
  "competition",
  "customerSegments",
  "technicalRequirements",
  "regulatoryRisk",
  "buildability",
  "riskScoring",
  "confidence",
  "selfReportedConfidence",
  "sources",
] as const satisfies readonly (keyof ResearchReport)[];

const RESEARCH_REPORT_NULLABLE_OBJECT_FIELDS = [
  "marketSize",
  "competition",
  "customerSegments",
  "technicalRequirements",
  "regulatoryRisk",
  "buildability",
  "riskScoring",
] as const;

/**
 * Runtime conformance check for a compiled research report — the half a
 * TypeScript type alone can't provide once the object has crossed an
 * HTTP boundary (7c's eventual GET response, or any tool-call response)
 * and is just JSON again by the time Finance/Strategy/the CEO gate read
 * it back. Checks, in order: the object has exactly
 * RESEARCH_REPORT_FIELDS' keys (no more, no fewer — "locked," not "at
 * least"); every scalar field has its required type; every raw-evidence
 * section is either null or a plain object (this deliberately does NOT
 * recurse into validating e.g. marketSize's own internal shape —
 * that's each Phase 5/6 tool's own job to get right at write time, and
 * re-validating it here would duplicate that logic rather than guard
 * the one thing that's actually this function's to guard: the report's
 * own top-level contract); `confidence`/`selfReportedConfidence` are
 * either null or a real ResearchConfidence value; `sources` is an array
 * of strings; `schemaVersion` matches RESEARCH_REPORT_SCHEMA_VERSION
 * exactly, so a report compiled under a future 7b-v2 is never silently
 * accepted as if it still matched this version's contract.
 *
 * Pure function — no DB access — so 7e's test can exercise it directly
 * against hand-built fixtures, the same "pure rule, testable independent
 * of persistence" split every other Phase 6 scoring/classification
 * function in this file already keeps.
 */
export function validateResearchReportShape(
  report: unknown,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return { valid: false, errors: ["report is not a plain object"] };
  }
  const obj = report as Record<string, unknown>;

  const actualKeys = new Set(Object.keys(obj));
  const expectedKeys = new Set<string>(RESEARCH_REPORT_FIELDS);
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) errors.push(`missing field: ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) errors.push(`unexpected field: ${key}`);
  }

  if (typeof obj.opportunityId !== "string" || !obj.opportunityId) {
    errors.push("opportunityId must be a non-empty string");
  }
  if (typeof obj.findingId !== "string" && obj.findingId !== null) {
    errors.push("findingId must be a string or null");
  }
  if (typeof obj.findingVersion !== "number" && obj.findingVersion !== null) {
    errors.push("findingVersion must be a number or null");
  }
  if (typeof obj.compiledAt !== "number") {
    errors.push("compiledAt must be a number");
  }
  if (obj.schemaVersion !== RESEARCH_REPORT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be "${RESEARCH_REPORT_SCHEMA_VERSION}", got ${JSON.stringify(obj.schemaVersion)}`,
    );
  }
  for (const field of RESEARCH_REPORT_NULLABLE_OBJECT_FIELDS) {
    const value = obj[field];
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`${field} must be an object or null`);
    }
  }
  if (obj.confidence !== null && !isValidResearchConfidence(obj.confidence)) {
    errors.push("confidence must be a valid ResearchConfidence or null");
  }
  if (obj.selfReportedConfidence !== null && !isValidResearchConfidence(obj.selfReportedConfidence)) {
    errors.push("selfReportedConfidence must be a valid ResearchConfidence or null");
  }
  if (!Array.isArray(obj.sources) || obj.sources.some((s) => typeof s !== "string")) {
    errors.push("sources must be an array of strings");
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

export const createFinanceFinding = <T = Record<string, unknown>>(

  opportunityId: string,
  findings: T,
) => createFinding<T>("finance", opportunityId, findings);
export const getCurrentFinanceFinding = <T = Record<string, unknown>>(opportunityId: string) =>
  getCurrentFinding<T>("finance", opportunityId);
export const listFinanceFindingVersions = <T = Record<string, unknown>>(opportunityId: string) =>
  listFindingVersions<T>("finance", opportunityId);

// ─── Phase 8b: estimate_build_cost(opportunity_id) ──────────────────────
//
// Zent.md 8b: "compute/inference spend to reach MVP, using this stack's
// real metered USDC costs as the unit, not an abstract number." Same
// read-merge-write discipline Phase 5b/5c/5d established for Research
// (mergeIntoCurrentResearchFinding) — Finance is also committed (Phase
// 6d/8e's own header) to "one report per opportunity," so this doesn't
// get its own row either.
//
// "Real metered ... costs, not an abstract number" is read as: don't
// invent a per-call heuristic score. Ground the estimate in
// department_spend_log — the same table wallet.ts's checkDepartmentBudget
// already sums for real, per-department USDC spend (Phase 2f-iv) — by
// averaging what Company A has actually spent building the departments
// it already has, rather than fabricating a cost curve out of nothing.
// Deliberately NOT usage_log: that table meters inference/vm spend at
// the owning agent's own address (inferenceGateway.ts's 24h budget
// check reads it that way), never broken out per department, so it
// can't answer "what does one department cost" the way department_
// spend_log's own department_id column can.
export function mergeIntoCurrentFinanceFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): Finding<Record<string, unknown>> {
  const current = getCurrentFinanceFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createFinanceFinding<Record<string, unknown>>(opportunityId, merged);
}

/**
 * How many departments a genesis'd Agent B is assumed to need before it
 * reaches its first real MVP milestone. A documented assumption, not a
 * derived number — Zent.md 8b doesn't ask for a department-count model,
 * just a cost estimate grounded in real USDC units, so this constant is
 * the one place that assumption lives, easy to find and easy to revise
 * once real genesis history (Phase 20e's own post-launch review) exists
 * to check it against.
 */
export const ASSUMED_DEPARTMENTS_FOR_MVP = 3;

export interface DepartmentCostSample {
  departmentId: string;
  totalUsdc: number;
  firstSpendAt: number;
  lastSpendAt: number;
}

/**
 * Real per-department USDC cost history for `agentAddress`, one row per
 * department that has ever recorded spend in department_spend_log —
 * running or already retired, both count as real evidence of what a
 * department cost this agent to operate. Pure read, no opportunity_id
 * involved: this is Company A's own operating history, independent of
 * which opportunity Finance happens to be sizing right now.
 */
export function getHistoricalDepartmentCosts(agentAddress: string): DepartmentCostSample[] {
  const rows = db
    .prepare(
      `SELECT department_id AS departmentId,
              SUM(amount_usdc) AS totalUsdc,
              MIN(created_at) AS firstSpendAt,
              MAX(created_at) AS lastSpendAt
       FROM department_spend_log
       WHERE owner_address = ?
       GROUP BY department_id`,
    )
    .all(agentAddress) as DepartmentCostSample[];
  return rows;
}

/**
 * One estimate_build_cost(opportunity_id) call's payload, as it sits
 * under finance_findings.findings.build_cost. `basis` records which of
 * the two paths below produced the number, so a later reader (Finance's
 * own sensitivity note, 9d, or the CEO gate) can tell a figure grounded
 * in this agent's own spend history apart from the bootstrap fallback —
 * never silently blended into one unlabeled number.
 */
export interface BuildCostEstimate {
  basis: "historical_department_spend" | "fallback_default_cap";
  sampleDepartments: number;
  avgCostPerDepartmentUsdc: number;
  assumedDepartmentsForMvp: number;
  estimatedBuildCostUsdc: number;
  estimatedAt: number;
}

/**
 * estimate_build_cost(opportunity_id) itself. Pure function over
 * `samples` (this agent's own getHistoricalDepartmentCosts() result) so
 * 8b's own shape test can exercise the cost math directly against fixed
 * fixtures, the same "pure rule, testable independent of persistence"
 * split validateResearchReportShape()'s own docstring already commits
 * this file to for scoring/classification logic.
 *
 * With at least one historical department to average over: avgCostPer
 * DepartmentUsdc = mean(sample.totalUsdc), estimatedBuildCostUsdc =
 * that x ASSUMED_DEPARTMENTS_FOR_MVP, basis = "historical_department_
 * spend" — this is Zent.md 8b's "real metered ... costs" path.
 *
 * With zero history (Company A's first-ever expansion attempt, nothing
 * yet in department_spend_log) there is nothing to average — falls back
 * to config.defaultDepartmentSpendCapDailyUsdc x a documented default
 * day count as a floor-of-the-range placeholder, basis =
 * "fallback_default_cap", clearly distinguishable from a
 * history-grounded number rather than silently passed off as one.
 */
const FALLBACK_DAYS_PER_DEPARTMENT = 14;

export function computeBuildCostEstimate(
  samples: DepartmentCostSample[],
): BuildCostEstimate {
  const estimatedAt = Date.now();
  if (samples.length > 0) {
    const avgCostPerDepartmentUsdc =
      samples.reduce((sum, s) => sum + s.totalUsdc, 0) / samples.length;
    return {
      basis: "historical_department_spend",
      sampleDepartments: samples.length,
      avgCostPerDepartmentUsdc,
      assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedBuildCostUsdc: avgCostPerDepartmentUsdc * ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedAt,
    };
  }
  const avgCostPerDepartmentUsdc =
    config.defaultDepartmentSpendCapDailyUsdc * FALLBACK_DAYS_PER_DEPARTMENT;
  return {
    basis: "fallback_default_cap",
    sampleDepartments: 0,
    avgCostPerDepartmentUsdc,
    assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedBuildCostUsdc: avgCostPerDepartmentUsdc * ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedAt,
  };
}

/**
 * Records one estimate_build_cost(opportunity_id) pass — reads this
 * agent's real spend history, computes the estimate, and merges it onto
 * the current finance finding under `build_cost`, same "route resolves
 * the real-world input (here: agentAddress -> spend history), this
 * function turns it into a finding" split recordMarketSizeEstimate()
 * draws for Research's own tools.
 */
export function recordBuildCostEstimate(
  opportunityId: string,
  agentAddress: string,
): { finding: Finding<Record<string, unknown>>; estimate: BuildCostEstimate } {
  const samples = getHistoricalDepartmentCosts(agentAddress);
  const estimate = computeBuildCostEstimate(samples);
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { build_cost: estimate });
  // Phase 10d: the audit row's raw evidence is `samples` itself — the
  // literal per-department department_spend_log rows the estimate was
  // averaged over — not just the aggregate already sitting in `estimate`.
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "build_cost",
    value: estimate.estimatedBuildCostUsdc,
    sourceQuery:
      estimate.basis === "historical_department_spend"
        ? `SUM(amount_usdc) GROUP BY department_id FROM department_spend_log WHERE owner_address = '${agentAddress}'`
        : "fallback: config.defaultDepartmentSpendCapDailyUsdc x FALLBACK_DAYS_PER_DEPARTMENT (no department_spend_log rows for this agent yet)",
    rowCount: samples.length,
    rawEvidence: { samples, estimate },
  });
  return { finding, estimate };
}

// ─── Phase 8c: estimate_time_to_revenue(opportunity_id) ─────────────────
//
// Zent.md 8c: "rough month count, based on comparable department/agent
// build times already logged in this system's own history if any
// exist." Same "ground it in this stack's own real history, fall back
// to a documented default when there isn't any yet" shape 8b already
// establishes for cost — here the real unit is wall-clock build time
// instead of USDC, read off sub_agents rather than department_spend_log.
//
// "Comparable department/agent build times" resolves to: every
// `department`-kind sub_agents row this agent has ever fully retired
// (status = 'killed', the literal status every teardown path in
// departments.ts writes — see retireResearchDepartmentForOpportunity()
// and every hard-kill path this file's own comment above already
// points at — with ended_at set, so an abandoned-but-still-running row
// can never be read as a completed build). created_at -> ended_at is
// that department's own build time; there's no separate "time to
// revenue" log anywhere in this schema to read instead, so a
// department's full lifecycle duration is the best real proxy this
// system's own history can offer.
const MS_PER_DAY = 24 * 3_600_000;
const MS_PER_MONTH = MS_PER_DAY * 30;

export interface DepartmentDurationSample {
  departmentId: string;
  durationMs: number;
  createdAt: number;
  endedAt: number;
}

/**
 * Real department build-time history for `agentAddress`: every
 * `department`-kind sub_agents row that has fully completed its
 * lifecycle (status = 'killed', ended_at set), oldest first. Pure
 * read, no opportunity_id involved — same "this agent's own operating
 * history, independent of which opportunity Finance is sizing right
 * now" posture getHistoricalDepartmentCosts() (8b) already takes.
 */
export function getHistoricalDepartmentDurations(agentAddress: string): DepartmentDurationSample[] {
  const rows = db
    .prepare(
      `SELECT id AS departmentId, created_at AS createdAt, ended_at AS endedAt
       FROM sub_agents
       WHERE owner_address = ? AND kind = 'department' AND status = 'killed' AND ended_at IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all(agentAddress) as { departmentId: string; createdAt: number; endedAt: number }[];
  return rows.map((r) => ({
    departmentId: r.departmentId,
    durationMs: r.endedAt - r.createdAt,
    createdAt: r.createdAt,
    endedAt: r.endedAt,
  }));
}

/**
 * One estimate_time_to_revenue(opportunity_id) call's payload, as it
 * sits under finance_findings.findings.time_to_revenue. Same `basis`
 * labeling discipline BuildCostEstimate already uses (8b) — a reader
 * downstream (9d's sensitivity note, the CEO gate) can always tell a
 * history-grounded month count apart from the bootstrap fallback.
 */
export interface TimeToRevenueEstimate {
  basis: "historical_department_duration" | "fallback_default_months";
  sampleDepartments: number;
  avgDepartmentBuildTimeMonths: number;
  assumedDepartmentsForMvp: number;
  estimatedMonthsToRevenue: number;
  estimatedAt: number;
}

/**
 * estimate_time_to_revenue(opportunity_id) itself. Pure function over
 * `samples` (this agent's own getHistoricalDepartmentDurations()
 * result), same "pure rule, testable independent of persistence" split
 * computeBuildCostEstimate() (8b) already commits this file to.
 *
 * With at least one completed department to average over:
 * avgDepartmentBuildTimeMonths = mean(sample.durationMs) / MS_PER_MONTH,
 * estimatedMonthsToRevenue = that x ASSUMED_DEPARTMENTS_FOR_MVP (the
 * same "how many departments does an MVP take" assumption 8b's own
 * cost estimate uses — reused rather than re-invented so Finance's own
 * cost and timeline numbers are modeling the same MVP, not two
 * different ones), basis = "historical_department_duration".
 *
 * With zero history, falls back to FALLBACK_DAYS_PER_DEPARTMENT (the
 * same 14-day-per-department assumption 8b's own cost fallback already
 * uses, converted to months here instead of USDC) x
 * ASSUMED_DEPARTMENTS_FOR_MVP, basis = "fallback_default_months" —
 * clearly distinguishable from a history-grounded number, matching
 * 8b's own fallback labeling.
 */
export function computeTimeToRevenueEstimate(
  samples: DepartmentDurationSample[],
): TimeToRevenueEstimate {
  const estimatedAt = Date.now();
  if (samples.length > 0) {
    const avgDurationMs = samples.reduce((sum, s) => sum + s.durationMs, 0) / samples.length;
    const avgDepartmentBuildTimeMonths = avgDurationMs / MS_PER_MONTH;
    return {
      basis: "historical_department_duration",
      sampleDepartments: samples.length,
      avgDepartmentBuildTimeMonths,
      assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedMonthsToRevenue: avgDepartmentBuildTimeMonths * ASSUMED_DEPARTMENTS_FOR_MVP,
      estimatedAt,
    };
  }
  const avgDepartmentBuildTimeMonths = FALLBACK_DAYS_PER_DEPARTMENT / 30;
  return {
    basis: "fallback_default_months",
    sampleDepartments: 0,
    avgDepartmentBuildTimeMonths,
    assumedDepartmentsForMvp: ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedMonthsToRevenue: avgDepartmentBuildTimeMonths * ASSUMED_DEPARTMENTS_FOR_MVP,
    estimatedAt,
  };
}

/**
 * Records one estimate_time_to_revenue(opportunity_id) pass — reads
 * this agent's real department-duration history, computes the
 * estimate, and merges it onto the current finance finding under
 * `time_to_revenue`, same route/function split recordBuildCostEstimate()
 * (8b) already draws.
 */
export function recordTimeToRevenueEstimate(
  opportunityId: string,
  agentAddress: string,
): { finding: Finding<Record<string, unknown>>; estimate: TimeToRevenueEstimate } {
  const samples = getHistoricalDepartmentDurations(agentAddress);
  const estimate = computeTimeToRevenueEstimate(samples);
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { time_to_revenue: estimate });
  // Phase 10d: raw evidence is `samples` — every completed `department`-
  // kind sub_agents row this estimate averaged over, not just the mean.
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "time_to_revenue",
    value: estimate.estimatedMonthsToRevenue,
    sourceQuery:
      estimate.basis === "historical_department_duration"
        ? `SELECT id, created_at, ended_at FROM sub_agents WHERE owner_address = '${agentAddress}' AND kind = 'department' AND status = 'killed' AND ended_at IS NOT NULL`
        : "fallback: FALLBACK_DAYS_PER_DEPARTMENT (no completed departments for this agent yet)",
    rowCount: samples.length,
    rawEvidence: { samples, estimate },
  });
  return { finding, estimate };
}

// ─── Phase 8d: check_available_capital(agentAddress) ────────────────────
//
// Zent.md 8d: "reads Company A's actual wallet balance and current
// spend-rate; expansion capital is a slice of that, never all of it."
// Same real-number discipline 8b/8c already commit this phase to — no
// abstract score, grounded in this agent's own real USDC balance and
// real logged spend.
//
// "Company A's actual wallet balance" is deliberately an ON-CHAIN read
// (wallet.ts's getUsdcBalance(), the same readContract() call GET
// /wallet/:address/balance already exposes), not a backend-side ledger
// total the way 8b's cost history or 2e's isEligibleForExpansion()
// revenue/spend totals are — Phase 2e's own header comment already
// flags this exact split: "An on-chain balance query is the right
// enrichment for Phase 8d's check_available_capital tool, not here."
// So unlike every other Phase 8 tool, the real-world read for 8d is a
// chain call, not a SQLite query — expansionRoutes.ts's own route does
// that await (matching the "route resolves the real-world input, this
// function turns it into a finding" split every Phase 5/8 tool route
// already uses), and passes the resolved balance in here.
//
// "Current spend-rate" reuses usage_log — the same table 2e's own
// spendUsdc side already reads — but as a rolling window average
// instead of an all-time total, since a RATE is what 8e's eventual
// runway-months floor needs to divide the remaining balance by.
// Deliberately NOT department_spend_log here: that table records a
// department's own outbound payments (to contractors, marketplace
// sellers, etc.), a different kind of outflow from the metered
// inference/vm/marketplace service costs usage_log tracks, and 2e's
// own precedent already draws this same line for "what counts as this
// agent's spend."
export interface AvailableCapitalCheck {
  walletBalanceUsdc: number;
  spendRateWindowDays: number;
  totalSpendInWindowUsdc: number;
  dailySpendRateUsdc: number;
  expansionCapitalFractionApplied: number;
  availableExpansionCapitalUsdc: number;
  checkedAt: number;
}

const SPEND_RATE_WINDOW_DAYS = 30;

/**
 * Real trailing-window USDC spend for `agentAddress`, summed across
 * every usage_log service (inference/vm/marketplace) — same "spend" as
 * isEligibleForExpansion() (2e) reads, just windowed instead of
 * all-time, since 8d needs a RATE and 2e needs a lifetime total.
 */
export function getRecentSpendUsdc(agentAddress: string, windowDays: number): number {
  const since = Date.now() - windowDays * MS_PER_DAY;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) AS total
       FROM usage_log
       WHERE agent_address = ? AND created_at >= ?`,
    )
    .get(agentAddress, since) as { total: number };
  return row.total;
}

export interface UsageLogSpendRow {
  service: string;
  costUsdc: number;
  createdAt: number;
}

/**
 * Phase 10d: the individual usage_log rows getRecentSpendUsdc() sums,
 * summarized per service rather than returned one row per charge (a
 * busy agent's usage_log can run to thousands of rows in a 30-day
 * window — the audit log needs "traceable to the query," not a literal
 * row-for-row dump). Same window/filter as getRecentSpendUsdc() itself,
 * so the two are always describing the same underlying read.
 */
export function getRecentSpendRows(agentAddress: string, windowDays: number): UsageLogSpendRow[] {
  const since = Date.now() - windowDays * MS_PER_DAY;
  const rows = db
    .prepare(
      `SELECT service, SUM(CAST(cost_usdc AS REAL)) AS costUsdc, COUNT(*) AS n, MAX(created_at) AS createdAt
       FROM usage_log
       WHERE agent_address = ? AND created_at >= ?
       GROUP BY service`,
    )
    .all(agentAddress, since) as { service: string; costUsdc: number; n: number; createdAt: number }[];
  return rows.map((r) => ({ service: r.service, costUsdc: r.costUsdc, createdAt: r.createdAt }));
}

/**
 * check_available_capital(agentAddress) itself — pure over the already-
 * resolved balance/spend inputs, same "pure rule, testable independent
 * of persistence" split 8b/8c's own compute functions already commit
 * to (and the only way to unit-test 8d's math at all without a live
 * chain connection).
 *
 * "A slice of that, never all of it": availableExpansionCapitalUsdc =
 * walletBalanceUsdc x config.expansionCapitalFraction — a hard
 * ceiling this function itself enforces by construction (there is no
 * code path here that can return more than that fraction), not a
 * downstream check trusted to catch a caller that asks for the whole
 * balance. This is a ceiling on the number 8d REPORTS, separate from
 * (and applied before) Phase 8e's own runway-months floor and Phase
 * 9b's spawn_clone funding caps — three independent limits, not one.
 */
export function computeAvailableCapital(
  walletBalanceUsdc: number,
  totalSpendInWindowUsdc: number,
  windowDays: number = SPEND_RATE_WINDOW_DAYS,
): AvailableCapitalCheck {
  const fraction = config.expansionCapitalFraction;
  return {
    walletBalanceUsdc,
    spendRateWindowDays: windowDays,
    totalSpendInWindowUsdc,
    dailySpendRateUsdc: totalSpendInWindowUsdc / windowDays,
    expansionCapitalFractionApplied: fraction,
    availableExpansionCapitalUsdc: walletBalanceUsdc * fraction,
    checkedAt: Date.now(),
  };
}

/**
 * Records one check_available_capital(agentAddress) pass, merged onto
 * the current finance finding under `available_capital` — same
 * "opportunity-scoped finding, agent-wide real data" shape 8b/8c
 * already use (Finance is still one report per opportunity, 6d/8e's
 * own discipline, even though this particular check's inputs are
 * about Company A as a whole rather than the opportunity itself).
 */
export function recordAvailableCapitalCheck(
  opportunityId: string,
  check: AvailableCapitalCheck,
  agentAddress: string,
  spendRows: UsageLogSpendRow[] = [],
): Finding<Record<string, unknown>> {
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { available_capital: check });
  // Phase 10d: two real-world reads back this number — the on-chain
  // balance call and the usage_log spend window — so both are recorded
  // as raw evidence, not just check's own already-aggregated fields.
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "available_capital",
    value: check.availableExpansionCapitalUsdc,
    sourceQuery: `getUsdcBalance('${agentAddress}') on-chain; SUM(cost_usdc) GROUP BY service FROM usage_log WHERE agent_address = '${agentAddress}' AND created_at >= now-${check.spendRateWindowDays}d`,
    rowCount: spendRows.length,
    rawEvidence: { walletBalanceUsdc: check.walletBalanceUsdc, spendRows, check },
  });
  return finding;
}

// ─── Phase 8e: runway rule ────────────────────────────────────────────
//
// Zent.md 8e: "Finance must show Company A retains N months of its own
// runway after funding Agent B — this is a hard floor, not advisory."
//
// Distinct from 8d in what it limits: 8d's expansionCapitalFraction
// caps the SLICE of the balance Finance is even willing to REPORT as
// available. 8e checks whether a CONCRETE proposed funding amount
// would leave Company A with fewer than
// config.minRunwayMonthsAfterFunding months of runway at its own
// current spend-rate. proposedFundingUsdc is caller-supplied here
// rather than derived, because Finance's own sizing recommendation
// doesn't exist until Phase 9b — 8e is the rule the eventual sizing
// number gets checked against, not the number itself.
//
// "Hard floor, not advisory" is what the `passes` boolean is for —
// this function's job is to compute that boolean truthfully, not to
// act on it. Phase 10b is where a `false` here actually short-
// circuits the pipeline (Finance's own early-exit reject path).
export interface RunwayCheck {
  walletBalanceUsdc: number;
  dailySpendRateUsdc: number;
  proposedFundingUsdc: number;
  remainingBalanceAfterFundingUsdc: number;
  runwayMonthsAfterFunding: number;
  minRunwayMonthsRequired: number;
  passes: boolean;
  checkedAt: number;
}

const DAYS_PER_MONTH = 30;

/**
 * The runway rule itself — pure over already-resolved inputs, same
 * "testable without a live chain/DB connection" split every other
 * Phase 8 compute function in this file commits to.
 *
 * runwayMonthsAfterFunding = (walletBalanceUsdc - proposedFundingUsdc)
 * / (dailySpendRateUsdc * 30) — how many months Company A's OWN
 * current spend-rate would take to burn through what's left after
 * Agent B is funded. A dailySpendRateUsdc of 0 has no meaningful
 * "months until broke" denominator; treated as infinite runway
 * (always passes) rather than a divide-by-zero — an agent that is
 * genuinely spending nothing can't be starved by this funding.
 */
export function computeRunwayCheck(
  walletBalanceUsdc: number,
  dailySpendRateUsdc: number,
  proposedFundingUsdc: number,
  minRunwayMonthsRequired: number = config.minRunwayMonthsAfterFunding,
): RunwayCheck {
  const remainingBalanceAfterFundingUsdc = walletBalanceUsdc - proposedFundingUsdc;
  const runwayMonthsAfterFunding =
    dailySpendRateUsdc > 0
      ? remainingBalanceAfterFundingUsdc / (dailySpendRateUsdc * DAYS_PER_MONTH)
      : Number.POSITIVE_INFINITY;

  return {
    walletBalanceUsdc,
    dailySpendRateUsdc,
    proposedFundingUsdc,
    remainingBalanceAfterFundingUsdc,
    runwayMonthsAfterFunding,
    minRunwayMonthsRequired,
    passes: runwayMonthsAfterFunding >= minRunwayMonthsRequired,
    checkedAt: Date.now(),
  };
}

/**
 * Records one runway-rule pass, merged onto the current finance
 * finding under `runway_check` — same "opportunity-scoped finding,
 * agent-wide real data" shape 8d's recordAvailableCapitalCheck already
 * uses, and the same field name (`runwayMonthsAfterFunding`) Phase
 * 9e's eventual compile_finance_report is already expected to surface
 * (see expansionResearchReportShape.test.ts's finance-shape fixture).
 */
export function recordRunwayCheck(
  opportunityId: string,
  check: RunwayCheck,
): Finding<Record<string, unknown>> {
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { runway_check: check });
  // Phase 10d: no new wallet/spend read here — walletBalanceUsdc and
  // dailySpendRateUsdc are the same numbers 8d's available_capital pass
  // already read and audited; this row cites that one by reference
  // rather than re-recording the same evidence a second time.
  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const capitalAudit = getLatestFinanceAuditEntry(opportunityId, "available_capital");
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "runway_check",
    value: check.runwayMonthsAfterFunding,
    sourceQuery: "derived: (walletBalanceUsdc - proposedFundingUsdc) / (dailySpendRateUsdc x 30), inputs from available_capital (8d)",
    rowCount: 0,
    rawEvidence: { check },
    refIds: capitalAudit ? [capitalAudit.id] : [],
  });
  return finding;
}

// ─── Phase 10b: Finance hard-reject path ──────────────────────────────
//
// Zent.md 10b: "Hard reject path: if 8e's runway floor fails, Finance
// can reject an opportunity outright without needing Strategy or the
// CEO — document this as an allowed early-exit, not a bug."
//
// This is deliberately NOT a new status and NOT a new transition — it
// calls the exact same setOpportunityStatus(id, 'reject') data-layer
// mutation Phase 4c's operator-facing reject action already uses (see
// that section's own header just above OpportunityAction). What's new
// here is the GATE in front of that call: 4c's route lets the owning
// agent reject an opportunity for any reason, no precondition checked.
// This function is Finance's own narrower path to the identical
// terminal state — usable only when 8e's own computeRunwayCheck() has
// already been run for this opportunity AND came back `passes: false`.
// That precondition is what makes this call an "early-exit," not a
// bug: Finance is not overriding anything Research or Strategy said
// (they may not have even run yet — this can fire straight off 8e,
// before Phase 5/11 ever touch the opportunity) and it is not routed
// through the CEO gate (Phase 15) at all. "Without needing Strategy or
// the CEO" is enforced by omission, the same way every other phase in
// this pipeline enforces "no human-in-the-loop": there is no approval
// call this function is missing, because none exists to call.
//
// Rejecting for a passing or not-yet-run runway check is refused (not
// silently ignored) — a caller reaching for this specific path needs
// the specific reason (8e's floor) to actually have failed; a
// no-reason-given reject still exists, via 4c's generic action.
export interface HardReject {
  reason: "runway_floor_failed";
  runwayCheck: RunwayCheck;
  rejectedAt: number;
}

/**
 * rejectForFailedRunway(opportunity_id) — Finance's own early-exit.
 * Reads the opportunity's current finance finding, requires a
 * runway_check (8e) to be on file and requires it to have failed, then
 * drives the opportunity to 'rejected' via setOpportunityStatus() (same
 * function 4c's route calls) and records the reason onto the finance
 * finding for audit (10d) — `hard_reject`, alongside 8e's own
 * `runway_check`, not a replacement for it.
 *
 * Throws (mapped to 409 by the route below) on: no runway_check on
 * file yet, or a runway_check that currently passes. Both are "the
 * request was well-formed but this isn't Finance's hard-reject
 * situation" — same class of error setOpportunityStatus() itself
 * throws for an invalid transition, which this function also lets
 * propagate un-caught for an opportunity that's already 'rejected' via
 * some other path (idempotent no-op, per setOpportunityStatus()'s own
 * docstring) or otherwise can't move to 'rejected' from its current
 * status (today, every OpportunityStatus can — 'rejected' is the one
 * state OPPORTUNITY_TRANSITIONS lets every other state reach).
 */
export function rejectForFailedRunway(
  opportunityId: string,
): { opportunity: Opportunity; finding: Finding<Record<string, unknown>> } {
  const current = getCurrentFinanceFinding<RawFinanceFindings>(opportunityId);
  const runwayCheck = current?.findings.runway_check;
  if (!runwayCheck) {
    throw new Error(
      `opportunity ${opportunityId} has no runway check on file — run check_runway (8e) before attempting a hard reject`,
    );
  }
  if (runwayCheck.passes) {
    throw new Error(
      `opportunity ${opportunityId}'s runway check currently passes — hard-reject only applies when 8e's floor fails`,
    );
  }

  const opportunity = setOpportunityStatus(opportunityId, "reject");
  const hardReject: HardReject = {
    reason: "runway_floor_failed",
    runwayCheck,
    rejectedAt: Date.now(),
  };
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { hard_reject: hardReject });
  // Phase 10d: the decision itself is audited, citing the runway_check
  // (8e) audit row whose `passes: false` is the entire reason this
  // early-exit fired — no numeric `value` (a reject isn't a number),
  // but a rejection is exactly the kind of consequential action this
  // phase's "no hand-waved figures" discipline should cover too.
  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const runwayAudit = getLatestFinanceAuditEntry(opportunityId, "runway_check");
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "hard_reject",
    value: null,
    sourceQuery: "derived: runway_check (8e) came back passes=false",
    rowCount: 0,
    rawEvidence: { hardReject },
    refIds: runwayAudit ? [runwayAudit.id] : [],
  });
  return { opportunity, finding };
}

// ─── Phase 9a: estimate_worst_case_loss(opportunity_id) ───────────────
//
// Zent.md 9a: "the number if Agent B fails outright and its funding is
// a total write-off." Same "real metered ... costs, not an abstract
// number" discipline 8b already committed this file to — so the worst
// case isn't a separately-invented figure, it's grounded in 8b's own
// estimatedBuildCostUsdc, the one real-money number that already
// exists for this opportunity by the time Finance gets here (Finance's
// own tools run in Zent.md's listed order: 8b before 9a).
//
// "Total write-off" is read as: everything spent trying to reach MVP,
// not merely the target MVP figure itself — a failure large enough to
// write off the funding entirely is exactly the scenario where costs
// ran past the plan before anyone caught it, so the worst case applies
// a documented overrun multiplier on top of 8b's estimate rather than
// reporting 8b's own number back unchanged (which would be a build-
// cost estimate wearing a different name, not a worst-case one).
//
// Requires 8b to have already run for this opportunity: unlike 6d's
// graceful-with-partial-signal posture (where an unrun 6a-6c dimension
// just contributes 0 to a composite score), there is no honest
// "unknown funding write-off" to fall back to here — a worst-case-loss
// number invented without a build-cost basis would be exactly the
// abstract-number trap Zent.md 8b/9a both explicitly deprecate. See
// recordWorstCaseLossEstimate() below for the resulting error.
export const WORST_CASE_LOSS_OVERRUN_MULTIPLIER = 1.5;

export interface WorstCaseLossEstimate {
  basis: "build_cost_estimate";
  buildCostEstimateUsdc: number;
  buildCostBasis: BuildCostEstimate["basis"];
  worstCaseOverrunMultiplier: number;
  worstCaseLossUsdc: number;
  estimatedAt: number;
}

/**
 * estimate_worst_case_loss(opportunity_id) itself. Pure function over
 * `buildCostEstimate` (this opportunity's own already-recorded 8b
 * finding) so 9a's own shape test can exercise the math directly
 * against fixed fixtures, same split computeBuildCostEstimate() (8b)
 * and computeAvailableCapital() (8d) already keep.
 *
 * worstCaseLossUsdc = buildCostEstimate.estimatedBuildCostUsdc x
 * WORST_CASE_LOSS_OVERRUN_MULTIPLIER — `buildCostBasis` is carried
 * through from 8b's own finding so a later reader (9d's sensitivity
 * note, the CEO gate) can tell a worst-case figure grounded in real
 * department-spend history apart from one built on 8b's bootstrap
 * fallback, same distinction 8b's own `basis` field exists to preserve.
 */
export function computeWorstCaseLoss(
  buildCostEstimate: BuildCostEstimate,
  overrunMultiplier: number = WORST_CASE_LOSS_OVERRUN_MULTIPLIER,
): WorstCaseLossEstimate {
  return {
    basis: "build_cost_estimate",
    buildCostEstimateUsdc: buildCostEstimate.estimatedBuildCostUsdc,
    buildCostBasis: buildCostEstimate.basis,
    worstCaseOverrunMultiplier: overrunMultiplier,
    worstCaseLossUsdc: buildCostEstimate.estimatedBuildCostUsdc * overrunMultiplier,
    estimatedAt: Date.now(),
  };
}

/**
 * Thrown by recordWorstCaseLossEstimate() when 8b hasn't run yet for
 * this opportunity. `status` lets expansionRoutes.ts's own generic
 * `err.status || 500` catch-all (every Phase 5/8 route already uses
 * this shape) turn it into the right HTTP response without a
 * route-local special case.
 */
export class MissingBuildCostEstimateError extends Error {
  status = 409;
  constructor(opportunityId: string) {
    super(
      `estimate_build_cost must run for opportunity ${opportunityId} before estimate_worst_case_loss`,
    );
    this.name = "MissingBuildCostEstimateError";
  }
}

/**
 * Records one estimate_worst_case_loss(opportunity_id) pass — reads
 * this opportunity's current finance finding, requires 8b's
 * `build_cost` to already be present on it, computes the worst-case
 * figure, and merges it onto the SAME finance finding under
 * `worst_case_loss` — same "one report per opportunity" discipline
 * every other Phase 8/9 finance tool in this file already follows.
 */
export function recordWorstCaseLossEstimate(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; estimate: WorstCaseLossEstimate } {
  const current = getCurrentFinanceFinding(opportunityId);
  const buildCostEstimate = current?.findings?.build_cost as BuildCostEstimate | undefined;
  if (!buildCostEstimate) {
    throw new MissingBuildCostEstimateError(opportunityId);
  }
  const estimate = computeWorstCaseLoss(buildCostEstimate);
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { worst_case_loss: estimate });
  // Phase 10d: derived entirely from 8b's own build_cost — cited by
  // reference rather than re-recording department_spend_log evidence.
  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const buildCostAudit = getLatestFinanceAuditEntry(opportunityId, "build_cost");
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "worst_case_loss",
    value: estimate.worstCaseLossUsdc,
    sourceQuery: "derived: build_cost (8b) x WORST_CASE_LOSS_OVERRUN_MULTIPLIER",
    rowCount: 0,
    rawEvidence: { estimate },
    refIds: buildCostAudit ? [buildCostAudit.id] : [],
  });
  return { finding, estimate };
}

// ─── Phase 9b: sizing recommendation ───────────────────────────────────
//
// Zent.md 9b: "Finance proposes an initial funding amount for Agent B
// (feeds spawn_clone's existing per-call/per-day funding caps — Finance
// cannot recommend above those caps)."
//
// The "existing... caps" are config.maxCloneFundingUsdcPerCall and
// config.maxCloneFundingUsdcPerAgentPerDay — see config.ts's own Phase
// 9b header for why they're defined alongside this phase rather than
// having pre-existed. "Cannot recommend above those caps" is enforced
// by construction below, the same way 8d's own computeAvailableCapital()
// enforces its fraction ceiling: no code path through
// computeSizingRecommendation() can return a number above either cap.
//
// The candidate this starts from is 8b's own estimatedBuildCostUsdc —
// what Agent B actually needs to reach MVP, the same figure 9a's own
// worst-case number is grounded in. From there it's narrowed by
// whichever of three independent limits binds tightest: 8d's own
// availableExpansionCapitalUsdc (the slice of Company A's balance
// Finance is even willing to report as available), the per-call cap,
// and the per-day cap net of same-day commitments already recommended
// for this root agent.
//
// alreadyCommittedTodayUsdc is caller-supplied rather than derived here
// — real Phase-16-disbursement-time tracking of actual clone funding
// doesn't exist yet (Phase 16 wires the genesis call itself), so there
// is nothing yet to query, the same "derived value doesn't exist yet,
// so it's a parameter" posture 8e's own proposedFundingUsdc already
// takes per that function's header comment. Defaults to 0 (no same-day
// commitments known) so a caller that hasn't wired same-day tracking
// yet still gets a correct, just less conservative, recommendation.
//
// Deliberately NOT re-checking 8e's runway floor here: 8e's own header
// comment already calls this out — "8e is the rule the eventual sizing
// number gets checked against, not the number itself" — so this
// function's job ends at producing a capped candidate. A caller (the
// route below, or eventually the Committee packet assembly in Phase 13)
// is expected to hand this recommendation's recommendedFundingUsdc to
// POST .../finance/check-runway as that route's own proposedFundingUsdc,
// closing the loop 8e left open, rather than duplicating the runway
// math here and risking the two drifting apart.

export type SizingCapReason = "available_capital" | "per_call_cap" | "per_day_cap";

export interface SizingRecommendation {
  buildCostEstimateUsdc: number;
  availableExpansionCapitalUsdc: number;
  perCallCapUsdc: number;
  perDayCapUsdc: number;
  alreadyCommittedTodayUsdc: number;
  perDayRemainingUsdc: number;
  recommendedFundingUsdc: number;
  fullyFunded: boolean;
  cappedBy: SizingCapReason[];
  recommendedAt: number;
}

/**
 * sizing recommendation itself. Pure function over `buildCostEstimate`
 * and `availableCapitalCheck` (this opportunity's own already-recorded
 * 8b/8d findings) so 9b's own shape test can exercise the clamping
 * logic directly against fixed fixtures, the same split every other
 * Phase 8/9 finance compute function in this file already keeps.
 *
 * recommendedFundingUsdc = max(0, min(buildCostEstimateUsdc,
 * availableExpansionCapitalUsdc, perCallCapUsdc, perDayRemainingUsdc))
 * — the natural ask, narrowed to whichever ceiling is tightest.
 * `cappedBy` names every limit that was actually the binding one (a tie
 * lists more than one key); empty when the build-cost estimate itself
 * was already at or under every ceiling, meaning nothing had to shrink
 * the ask. `fullyFunded` is the cheap boolean version of the same fact
 * — false is Finance telling the CEO gate "this covers less than what
 * 8b said Agent B actually needs," not a rejection, just a flag
 * (staged/milestone-based follow-on funding, Zent.md 9c, is the
 * modeled — not yet wired — answer to a `false` here).
 */
export function computeSizingRecommendation(
  buildCostEstimate: BuildCostEstimate,
  availableCapitalCheck: AvailableCapitalCheck,
  alreadyCommittedTodayUsdc: number = 0,
  perCallCapUsdc: number = config.maxCloneFundingUsdcPerCall,
  perDayCapUsdc: number = config.maxCloneFundingUsdcPerAgentPerDay,
): SizingRecommendation {
  const buildCostEstimateUsdc = buildCostEstimate.estimatedBuildCostUsdc;
  const availableExpansionCapitalUsdc = availableCapitalCheck.availableExpansionCapitalUsdc;
  const perDayRemainingUsdc = Math.max(0, perDayCapUsdc - alreadyCommittedTodayUsdc);

  const limits: { key: SizingCapReason; value: number }[] = [
    { key: "available_capital", value: availableExpansionCapitalUsdc },
    { key: "per_call_cap", value: perCallCapUsdc },
    { key: "per_day_cap", value: perDayRemainingUsdc },
  ];

  const tightestLimitUsdc = Math.min(buildCostEstimateUsdc, ...limits.map((l) => l.value));
  const recommendedFundingUsdc = Math.max(0, tightestLimitUsdc);
  const cappedBy = limits
    .filter((l) => l.value <= buildCostEstimateUsdc && l.value === tightestLimitUsdc)
    .map((l) => l.key);

  return {
    buildCostEstimateUsdc,
    availableExpansionCapitalUsdc,
    perCallCapUsdc,
    perDayCapUsdc,
    alreadyCommittedTodayUsdc,
    perDayRemainingUsdc,
    recommendedFundingUsdc,
    fullyFunded: recommendedFundingUsdc >= buildCostEstimateUsdc,
    cappedBy,
    recommendedAt: Date.now(),
  };
}

/**
 * Thrown by recordSizingRecommendation() when 8b's build_cost and/or
 * 8d's available_capital haven't run yet for this opportunity — same
 * "refuse to invent a number without its real basis" posture
 * MissingBuildCostEstimateError (9a) already established, just with
 * two possible missing prerequisites instead of one.
 */
export class MissingFinancePrerequisitesError extends Error {
  status = 409;
  constructor(opportunityId: string, missingTools: string[]) {
    super(
      `${missingTools.join(" and ")} must run for opportunity ${opportunityId} before the sizing recommendation`,
    );
    this.name = "MissingFinancePrerequisitesError";
  }
}

/**
 * Records one sizing-recommendation pass — reads this opportunity's
 * current finance finding, requires both 8b's `build_cost` and 8d's
 * `available_capital` to already be present on it, computes the
 * recommendation, and merges it onto the SAME finance finding under
 * `sizing_recommendation` — same "one report per opportunity"
 * discipline every other Phase 8/9 finance tool in this file follows.
 */
export function recordSizingRecommendation(
  opportunityId: string,
  alreadyCommittedTodayUsdc: number = 0,
): { finding: Finding<Record<string, unknown>>; recommendation: SizingRecommendation } {
  const current = getCurrentFinanceFinding(opportunityId);
  const buildCostEstimate = current?.findings?.build_cost as BuildCostEstimate | undefined;
  const availableCapitalCheck = current?.findings?.available_capital as
    | AvailableCapitalCheck
    | undefined;

  const missingTools: string[] = [];
  if (!buildCostEstimate) missingTools.push("estimate_build_cost");
  if (!availableCapitalCheck) missingTools.push("check_available_capital");
  if (missingTools.length > 0) {
    throw new MissingFinancePrerequisitesError(opportunityId, missingTools);
  }

  const recommendation = computeSizingRecommendation(
    buildCostEstimate!,
    availableCapitalCheck!,
    alreadyCommittedTodayUsdc,
  );
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, {
    sizing_recommendation: recommendation,
  });
  // Phase 10d: derived from 8b's build_cost and 8d's available_capital
  // — both cited by reference, config caps recorded as plain evidence
  // since they're not themselves a wallet/spend query result.
  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const buildCostAudit = getLatestFinanceAuditEntry(opportunityId, "build_cost");
  const capitalAudit = getLatestFinanceAuditEntry(opportunityId, "available_capital");
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "sizing_recommendation",
    value: recommendation.recommendedFundingUsdc,
    sourceQuery:
      "derived: min(build_cost (8b), available_capital (8d), config.maxCloneFundingUsdcPerCall, per-day cap net of alreadyCommittedTodayUsdc)",
    rowCount: 0,
    rawEvidence: { recommendation },
    refIds: [buildCostAudit?.id, capitalAudit?.id].filter((x): x is string => !!x),
  });
  return { finding, recommendation };
}

// ─── Phase 9c: staged-funding option ───────────────────────────────────
//
// Zent.md 9c: "Finance may recommend a smaller initial grant with a
// milestone-based follow-on instead of one lump sum — modeled, not yet
// wired to disbursement (that's Phase 16)."
//
// "May recommend ... instead of" — this is Finance's own optional
// second opinion on 9b's own recommendedFundingUsdc, not a replacement
// for it: both findings sit side by side on the same finance finding
// (`sizing_recommendation` from 9b, `staged_funding_option` from this
// phase), same way 8d's `available_capital` and 8e's `runway_check`
// already coexist rather than one overwriting the other. The CEO gate
// (Phase 15) sees both and decides which shape of funding to approve.
//
// "Modeled, not yet wired to disbursement" is read the same way 9b's
// own alreadyCommittedTodayUsdc parameter already reads it: there is no
// milestone-detection mechanism anywhere in this codebase yet (that's
// later than Phase 16, and not scoped here at all) — followOnTrigger
// below is a fixed, honest placeholder describing what would need to
// exist, not a live check this function performs.
//
// The number worth actually computing here — the reason staged funding
// is worth modeling at all, not just a UI nicety — is exposure: 9a's
// own worst-case-loss figure assumes the FULL recommended amount is
// gone if Agent B fails outright. Staged funding bounds that exposure
// to whatever fraction has actually gone out by the time of failure.
// worstCaseLossIfStagedUsdc applies 9a's own overrun multiplier to the
// SMALLER initial-grant number instead of the lump sum, so
// worstCaseLossReductionUsdc is a real, auditable "this is what staging
// buys you" figure — not a marketing number.

export interface StagedFundingOption {
  totalRecommendedUsdc: number;
  initialFractionApplied: number;
  initialGrantUsdc: number;
  followOnUsdc: number;
  followOnTrigger: string;
  worstCaseLossIfLumpSumUsdc: number;
  worstCaseLossIfStagedUsdc: number;
  worstCaseLossReductionUsdc: number;
  modeledAt: number;
}

/**
 * A fixed, honest placeholder — see this phase's own header comment on
 * why "modeled, not yet wired to disbursement" means there is nothing
 * here that actually detects a milestone. Exported so a later phase
 * (Phase 16+) that DOES wire a real trigger can compare against this
 * exact string rather than a hand-typed one drifting out of sync.
 */
export const STAGED_FUNDING_FOLLOW_ON_TRIGGER_UNMODELED =
  "milestone_completion_not_yet_modeled";

/**
 * propose_staged_funding(opportunity_id) itself. Pure function over
 * `recommendation` (this opportunity's own already-recorded 9b finding)
 * so 9c's own shape test can exercise the split/exposure math directly
 * against fixed fixtures, same split every other Phase 8/9 finance
 * compute function in this file already keeps.
 *
 * initialGrantUsdc = totalRecommendedUsdc x initialFraction,
 * followOnUsdc = the remainder — the two always sum back to
 * totalRecommendedUsdc exactly, by construction (no rounding branch
 * that could leave a gap). worstCaseLossReductionUsdc is always >= 0
 * for any initialFraction in [0, 1]: staging can only shrink or match
 * the lump-sum exposure, never exceed it.
 */
export function computeStagedFundingOption(
  recommendation: SizingRecommendation,
  initialFraction: number = config.stagedFundingInitialFraction,
  overrunMultiplier: number = WORST_CASE_LOSS_OVERRUN_MULTIPLIER,
): StagedFundingOption {
  const totalRecommendedUsdc = recommendation.recommendedFundingUsdc;
  const initialGrantUsdc = totalRecommendedUsdc * initialFraction;
  const followOnUsdc = totalRecommendedUsdc - initialGrantUsdc;

  const worstCaseLossIfLumpSumUsdc = totalRecommendedUsdc * overrunMultiplier;
  const worstCaseLossIfStagedUsdc = initialGrantUsdc * overrunMultiplier;

  return {
    totalRecommendedUsdc,
    initialFractionApplied: initialFraction,
    initialGrantUsdc,
    followOnUsdc,
    followOnTrigger: STAGED_FUNDING_FOLLOW_ON_TRIGGER_UNMODELED,
    worstCaseLossIfLumpSumUsdc,
    worstCaseLossIfStagedUsdc,
    worstCaseLossReductionUsdc: worstCaseLossIfLumpSumUsdc - worstCaseLossIfStagedUsdc,
    modeledAt: Date.now(),
  };
}

/**
 * Thrown by recordStagedFundingOption() when 9b hasn't run yet for this
 * opportunity — same "refuse to invent a number without its real
 * basis" posture MissingBuildCostEstimateError (9a) and
 * MissingFinancePrerequisitesError (9b) already established: staging a
 * split of a number that doesn't exist yet would be exactly that.
 */
export class MissingSizingRecommendationError extends Error {
  status = 409;
  constructor(opportunityId: string) {
    super(
      `recommend_sizing must run for opportunity ${opportunityId} before propose_staged_funding`,
    );
    this.name = "MissingSizingRecommendationError";
  }
}

/**
 * Records one propose_staged_funding(opportunity_id) pass — reads this
 * opportunity's current finance finding, requires 9b's
 * `sizing_recommendation` to already be present on it, computes the
 * staged option, and merges it onto the SAME finance finding under
 * `staged_funding_option` — same "one report per opportunity"
 * discipline every other Phase 8/9 finance tool in this file follows.
 */
export function recordStagedFundingOption(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; option: StagedFundingOption } {
  const current = getCurrentFinanceFinding(opportunityId);
  const recommendation = current?.findings?.sizing_recommendation as
    | SizingRecommendation
    | undefined;
  if (!recommendation) {
    throw new MissingSizingRecommendationError(opportunityId);
  }
  const option = computeStagedFundingOption(recommendation);
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, {
    staged_funding_option: option,
  });
  // Phase 10d: derived entirely from 9b's own sizing_recommendation.
  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const sizingAudit = getLatestFinanceAuditEntry(opportunityId, "sizing_recommendation");
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "staged_funding_option",
    value: option.initialGrantUsdc,
    sourceQuery: "derived: sizing_recommendation (9b) split by config.stagedFundingInitialFraction",
    rowCount: 0,
    rawEvidence: { option },
    refIds: sizingAudit ? [sizingAudit.id] : [],
  });
  return { finding, option };
}

// ─── Phase 9d: sensitivity note ────────────────────────────────────────
//
// Zent.md 9d: "what changes the recommendation most (time-to-revenue vs
// build cost vs capital available) — cheap to compute, valuable for the
// CEO gate."
//
// The three named factors map onto three already-recorded findings:
// build_cost (8b), time_to_revenue (8c), available_capital (8d) — plus
// 9b's own sizing_recommendation, since "changes the recommendation"
// has to mean something concrete to compute against. Same "grounded in
// real, already-recorded numbers, nothing invented" discipline every
// other Phase 8/9 finance tool in this file commits to.
//
// build_cost and available_capital are literal inputs to 9b's own
// computeSizingRecommendation() — stressing each by a fixed adverse
// fraction and re-running that same function gives a real, directly
// comparable USDC delta in recommendedFundingUsdc. time_to_revenue is
// NOT an input to that formula (funding size is about capital adequacy,
// not schedule) — so a naive re-run can't measure it the same way. But
// a slower time-to-revenue has a real cost of its own: Company A keeps
// burning its own dailySpendRateUsdc (8d's own recorded rate) for
// however many extra months Agent B takes to become self-sufficient.
// That's a real, already-recorded number too, so timeToRevenueImpactUsdc
// is stress-fraction extra months x 30 x that rate — the USDC cost of
// Company A's own continued operation during the slip, not an invented
// figure. All three impacts land in the same USDC unit, so they're
// directly rankable — that's what makes this cheap: no new real-world
// read, just arithmetic over four findings that already exist by the
// time Finance reaches 9d.
export const SENSITIVITY_STRESS_FRACTION = 0.2;

export type SensitivityFactor = "build_cost" | "time_to_revenue" | "available_capital";

const SENSITIVITY_FACTOR_LABELS: Record<SensitivityFactor, string> = {
  build_cost: "build cost",
  time_to_revenue: "time to revenue",
  available_capital: "available capital",
};

export interface SensitivityNote {
  stressFractionApplied: number;
  buildCostImpactUsdc: number;
  timeToRevenueImpactUsdc: number;
  availableCapitalImpactUsdc: number;
  mostSensitiveFactor: SensitivityFactor;
  rankedFactors: SensitivityFactor[];
  note: string;
  computedAt: number;
}

/**
 * compute the sensitivity note itself. Pure function over `buildCostEstimate`,
 * `timeToRevenueEstimate`, `availableCapitalCheck`, and `recommendation`
 * (this opportunity's own already-recorded 8b/8c/8d/9b findings) so 9d's
 * own shape test can exercise the ranking math directly against fixed
 * fixtures, the same split every other Phase 8/9 finance compute
 * function in this file already keeps.
 *
 * Each factor is stressed by `stressFraction` in its adverse direction
 * — build cost up, available capital down, time-to-revenue up — holding
 * the other two fixed, one at a time. `rankedFactors` sorts descending
 * by impact; `mostSensitiveFactor` is simply `rankedFactors[0]`. Ties
 * keep object-literal insertion order (build_cost, time_to_revenue,
 * available_capital), same as 9b's own `cappedBy` construction leaves
 * tie-breaking to array order rather than picking one arbitrarily.
 */
export function computeSensitivityNote(
  buildCostEstimate: BuildCostEstimate,
  timeToRevenueEstimate: TimeToRevenueEstimate,
  availableCapitalCheck: AvailableCapitalCheck,
  recommendation: SizingRecommendation,
  stressFraction: number = SENSITIVITY_STRESS_FRACTION,
): SensitivityNote {
  const stressedBuildCostEstimate: BuildCostEstimate = {
    ...buildCostEstimate,
    estimatedBuildCostUsdc: buildCostEstimate.estimatedBuildCostUsdc * (1 + stressFraction),
  };
  const stressedAvailableCapitalCheck: AvailableCapitalCheck = {
    ...availableCapitalCheck,
    availableExpansionCapitalUsdc:
      availableCapitalCheck.availableExpansionCapitalUsdc * (1 - stressFraction),
  };

  const withStressedBuildCost = computeSizingRecommendation(
    stressedBuildCostEstimate,
    availableCapitalCheck,
    recommendation.alreadyCommittedTodayUsdc,
    recommendation.perCallCapUsdc,
    recommendation.perDayCapUsdc,
  );
  const withStressedAvailableCapital = computeSizingRecommendation(
    buildCostEstimate,
    stressedAvailableCapitalCheck,
    recommendation.alreadyCommittedTodayUsdc,
    recommendation.perCallCapUsdc,
    recommendation.perDayCapUsdc,
  );

  const buildCostImpactUsdc = Math.abs(
    withStressedBuildCost.recommendedFundingUsdc - recommendation.recommendedFundingUsdc,
  );
  const availableCapitalImpactUsdc = Math.abs(
    withStressedAvailableCapital.recommendedFundingUsdc - recommendation.recommendedFundingUsdc,
  );
  const extraMonthsToRevenue = timeToRevenueEstimate.estimatedMonthsToRevenue * stressFraction;
  const timeToRevenueImpactUsdc =
    extraMonthsToRevenue * DAYS_PER_MONTH * availableCapitalCheck.dailySpendRateUsdc;

  const impacts: { key: SensitivityFactor; value: number }[] = [
    { key: "build_cost", value: buildCostImpactUsdc },
    { key: "time_to_revenue", value: timeToRevenueImpactUsdc },
    { key: "available_capital", value: availableCapitalImpactUsdc },
  ];
  const rankedFactors = [...impacts].sort((a, b) => b.value - a.value).map((i) => i.key);
  const mostSensitiveFactor = rankedFactors[0];
  const topImpactUsdc = impacts.find((i) => i.key === mostSensitiveFactor)!.value;

  const note =
    `A ${(stressFraction * 100).toFixed(0)}% adverse move in ` +
    `${SENSITIVITY_FACTOR_LABELS[mostSensitiveFactor]} changes this recommendation the most ` +
    `(~${topImpactUsdc.toFixed(2)} USDC), ahead of ${SENSITIVITY_FACTOR_LABELS[rankedFactors[1]]} ` +
    `and ${SENSITIVITY_FACTOR_LABELS[rankedFactors[2]]}.`;

  return {
    stressFractionApplied: stressFraction,
    buildCostImpactUsdc,
    timeToRevenueImpactUsdc,
    availableCapitalImpactUsdc,
    mostSensitiveFactor,
    rankedFactors,
    note,
    computedAt: Date.now(),
  };
}

/**
 * Thrown by recordSensitivityNote() when any of 8b's `build_cost`, 8c's
 * `time_to_revenue`, 8d's `available_capital`, or 9b's
 * `sizing_recommendation` haven't run yet for this opportunity — same
 * "refuse to invent a number without its real basis" posture every
 * other Missing*Error in this file already establishes, just with up to
 * four possible missing prerequisites instead of one or two.
 */
export class MissingSensitivityPrerequisitesError extends Error {
  status = 409;
  constructor(opportunityId: string, missingTools: string[]) {
    super(
      `${missingTools.join(" and ")} must run for opportunity ${opportunityId} before the sensitivity note`,
    );
    this.name = "MissingSensitivityPrerequisitesError";
  }
}

/**
 * Records one sensitivity-note pass — reads this opportunity's current
 * finance finding, requires 8b's `build_cost`, 8c's `time_to_revenue`,
 * 8d's `available_capital`, and 9b's `sizing_recommendation` to already
 * be present on it, computes the note, and merges it onto the SAME
 * finance finding under `sensitivity_note` — same "one report per
 * opportunity" discipline every other Phase 8/9 finance tool in this
 * file follows.
 */
export function recordSensitivityNote(
  opportunityId: string,
  stressFraction: number = SENSITIVITY_STRESS_FRACTION,
): { finding: Finding<Record<string, unknown>>; note: SensitivityNote } {
  const current = getCurrentFinanceFinding(opportunityId);
  const buildCostEstimate = current?.findings?.build_cost as BuildCostEstimate | undefined;
  const timeToRevenueEstimate = current?.findings?.time_to_revenue as
    | TimeToRevenueEstimate
    | undefined;
  const availableCapitalCheck = current?.findings?.available_capital as
    | AvailableCapitalCheck
    | undefined;
  const recommendation = current?.findings?.sizing_recommendation as
    | SizingRecommendation
    | undefined;

  const missingTools: string[] = [];
  if (!buildCostEstimate) missingTools.push("estimate_build_cost");
  if (!timeToRevenueEstimate) missingTools.push("estimate_time_to_revenue");
  if (!availableCapitalCheck) missingTools.push("check_available_capital");
  if (!recommendation) missingTools.push("recommend_sizing");
  if (missingTools.length > 0) {
    throw new MissingSensitivityPrerequisitesError(opportunityId, missingTools);
  }

  const note = computeSensitivityNote(
    buildCostEstimate!,
    timeToRevenueEstimate!,
    availableCapitalCheck!,
    recommendation!,
    stressFraction,
  );
  const finding = mergeIntoCurrentFinanceFinding(opportunityId, { sensitivity_note: note });
  // Phase 10d: derived from 8b/8c/8d/9b's own already-audited findings.
  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const refIds = (
    [
      getLatestFinanceAuditEntry(opportunityId, "build_cost"),
      getLatestFinanceAuditEntry(opportunityId, "time_to_revenue"),
      getLatestFinanceAuditEntry(opportunityId, "available_capital"),
      getLatestFinanceAuditEntry(opportunityId, "sizing_recommendation"),
    ] as (FinanceAuditEntry | undefined)[]
  )
    .filter((x): x is FinanceAuditEntry => !!x)
    .map((x) => x.id);
  recordFinanceAuditEntry({
    opportunityId,
    agentAddress,
    metric: "sensitivity_note",
    value: null,
    sourceQuery: "derived: stress-test of build_cost (8b), time_to_revenue (8c), available_capital (8d) against sizing_recommendation (9b)",
    rowCount: 0,
    rawEvidence: { note },
    refIds,
  });
  return { finding, note };
}

// ─── Phase 9e: compile_finance_report(opportunity_id) ───────────────────
//
// Zent.md 9e: "compile_finance_report(opportunity_id) — one structured
// report, same discipline as 7a." "Same discipline as 7a" is read the
// same way that phase's own code reads it — 7a and 7b (the report's
// locked schema) shipped together as one discipline, not two, so this
// bundles both here rather than deferring the shape-lock to a later
// phase: compileFinanceReport() below, its schemaVersion stamp, and its
// self-check against validateFinanceReportShape() before ever returning.
//
// Everything this needs is already sitting on the current (non-
// superseded) finance finding — 8b/8c/8d's raw evidence, 8e's runway
// verdict, 9a's worst-case loss, 9b's sizing recommendation, 9c's staged
// option, 9d's sensitivity note — all accumulated onto that one row via
// mergeIntoCurrentFinanceFinding() (8b's own header). So, same as 7a,
// this is a *read*, not a new signal: it takes the same loosely-typed
// `findings` JSON blob every Phase 8/9 finance tool above has so far
// been reading/writing key-by-key and re-shapes it once into one
// fully-typed object, so Strategy/the CEO gate get a locked field list
// instead of each having to know the same eight JSON keys by hand.
//
// Deliberately does NOT write anything back to finance_findings — same
// "a compiled report has no information the finding didn't already
// have, it's a projection, not a new pass" posture compileResearchReport()
// already establishes. Calling this twice in a row is always safe and
// always reflects whatever is current at call time.
//
// Every section is nullable rather than defaulted: Finance's own tools
// can run 8b–9d in any order, any subset, zero or more times before
// this gets called (the individual Missing*Error guards on 9a/9b/9c/9d
// enforce ordering between THEM, not on whether this compiles), so
// "this tool hasn't run yet" has to be a real, distinguishable state
// here too — same posture 7a's own header already takes toward 5b–6d.
export interface FinanceReport {
  opportunityId: string;
  /** Which finance_findings row this was compiled from, and its
   *  version — null if Finance hasn't run any tool for this
   *  opportunity yet, a legitimate "nothing to compile" state. */
  findingId: string | null;
  findingVersion: number | null;
  compiledAt: number;
  /** Which locked report contract produced this object — see
   *  FINANCE_REPORT_SCHEMA_VERSION below, same role
   *  RESEARCH_REPORT_SCHEMA_VERSION plays for 7b. */
  schemaVersion: string;
  buildCost: BuildCostEstimate | null;
  timeToRevenue: TimeToRevenueEstimate | null;
  availableCapital: AvailableCapitalCheck | null;
  runwayCheck: RunwayCheck | null;
  worstCaseLoss: WorstCaseLossEstimate | null;
  sizingRecommendation: SizingRecommendation | null;
  stagedFundingOption: StagedFundingOption | null;
  sensitivityNote: SensitivityNote | null;
}

/** Shape of finance_findings.findings as every Phase 8/9 tool above
 *  actually writes it — same loosely-typed read every existing
 *  cross-cutting reader in this file (recordSizingRecommendation(),
 *  recordStagedFundingOption(), recordSensitivityNote()) already casts
 *  to; 9e is simply the first place ALL of those keys are read at once
 *  instead of one or two at a time, same role RawResearchFindings plays
 *  for 7a. */
interface RawFinanceFindings {
  build_cost?: BuildCostEstimate;
  time_to_revenue?: TimeToRevenueEstimate;
  available_capital?: AvailableCapitalCheck;
  runway_check?: RunwayCheck;
  worst_case_loss?: WorstCaseLossEstimate;
  sizing_recommendation?: SizingRecommendation;
  staged_funding_option?: StagedFundingOption;
  sensitivity_note?: SensitivityNote;
  /** Phase 10b — present only if rejectForFailedRunway() has fired for
   *  this opportunity. Deliberately NOT one of FINANCE_REPORT_FIELDS:
   *  the locked report contract (9e) surfaces the raw runway_check a
   *  reader needs to see the floor fail for themselves; whether Finance
   *  *acted* on it is visible on the opportunity's own `status` field
   *  (already returned by every opportunity-detail route), not
   *  duplicated into the report body. Kept here purely as this
   *  decision's own audit trail (10d). */
  hard_reject?: HardReject;
}

/**
 * Compiles `opportunityId`'s current finance finding into the locked
 * FinanceReport shape above. Throws on an unknown opportunity_id, same
 * "fail fast with a clear message" posture compileResearchReport() (7a)
 * already uses — but a *known* opportunity with no finance finding yet
 * is not an error (8a's department may simply not have run any tool
 * yet): every section reads back null, so a caller can compile a report
 * at any point in Finance's pass, not only after 9d.
 */
export function compileFinanceReport(opportunityId: string): FinanceReport {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentFinanceFinding<RawFinanceFindings>(opportunityId);
  const findings = current?.findings ?? {};
  const report: FinanceReport = {
    opportunityId,
    findingId: current?.id ?? null,
    findingVersion: current?.version ?? null,
    compiledAt: Date.now(),
    schemaVersion: FINANCE_REPORT_SCHEMA_VERSION,
    buildCost: findings.build_cost ?? null,
    timeToRevenue: findings.time_to_revenue ?? null,
    availableCapital: findings.available_capital ?? null,
    runwayCheck: findings.runway_check ?? null,
    worstCaseLoss: findings.worst_case_loss ?? null,
    sizingRecommendation: findings.sizing_recommendation ?? null,
    stagedFundingOption: findings.staged_funding_option ?? null,
    sensitivityNote: findings.sensitivity_note ?? null,
  };
  // Same enforcement-not-decoration posture 7b's own check takes inside
  // compileResearchReport(): every report this function hands out is
  // checked against the locked shape before it leaves this function.
  // Can never fail today (the object literal above is built from the
  // locked field list by construction) — it exists so a later drift
  // (a renamed field, a dropped section) fails loud here, at the one
  // place every caller already goes through.
  const shapeCheck = validateFinanceReportShape(report);
  if (!shapeCheck.valid) {
    throw new Error(
      `compile_finance_report produced a report that violates its own locked schema: ${shapeCheck.errors.join("; ")}`,
    );
  }
  return report;
}

/** Same versioning role RESEARCH_REPORT_SCHEMA_VERSION plays for 7b,
 *  named for the phase that locks this report's own contract (9e,
 *  bundling 7a+7b's discipline into one phase for Finance — see this
 *  section's own header). */
export const FINANCE_REPORT_SCHEMA_VERSION = "9e-v1";

/** Every FinanceReport field, in the order compileFinanceReport() emits
 *  them. This array IS the locked contract, same role RESEARCH_REPORT_
 *  FIELDS plays for 7e's shape test — a later finance-report shape test
 *  asserts against it directly rather than re-deriving its own copy. */
export const FINANCE_REPORT_FIELDS = [
  "opportunityId",
  "findingId",
  "findingVersion",
  "compiledAt",
  "schemaVersion",
  "buildCost",
  "timeToRevenue",
  "availableCapital",
  "runwayCheck",
  "worstCaseLoss",
  "sizingRecommendation",
  "stagedFundingOption",
  "sensitivityNote",
] as const satisfies readonly (keyof FinanceReport)[];

const FINANCE_REPORT_NULLABLE_OBJECT_FIELDS = [
  "buildCost",
  "timeToRevenue",
  "availableCapital",
  "runwayCheck",
  "worstCaseLoss",
  "sizingRecommendation",
  "stagedFundingOption",
  "sensitivityNote",
] as const;

/**
 * Runtime conformance check for a compiled finance report — same role
 * validateResearchReportShape() (7b) plays for research reports, once
 * the object has crossed an HTTP boundary and is just JSON again by the
 * time Strategy/the CEO gate read it back. Checks, in order: the object
 * has exactly FINANCE_REPORT_FIELDS' keys (no more, no fewer — "locked,"
 * not "at least"); every scalar field has its required type; every
 * raw-evidence section is either null or a plain object (deliberately
 * does NOT recurse into validating e.g. buildCost's own internal shape
 * — that's each Phase 8/9 tool's own job to get right at write time,
 * same division of responsibility 7b's own docstring already draws);
 * `schemaVersion` matches FINANCE_REPORT_SCHEMA_VERSION exactly, so a
 * report compiled under a future 9e-v2 is never silently accepted as if
 * it still matched this version's contract.
 *
 * Pure function — no DB access — so a later shape test can exercise it
 * directly against hand-built fixtures, same split every other
 * validate*Shape function in this file already keeps.
 */
export function validateFinanceReportShape(
  report: unknown,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return { valid: false, errors: ["report is not a plain object"] };
  }
  const obj = report as Record<string, unknown>;

  const actualKeys = new Set(Object.keys(obj));
  const expectedKeys = new Set<string>(FINANCE_REPORT_FIELDS);
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) errors.push(`missing field: ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) errors.push(`unexpected field: ${key}`);
  }

  if (typeof obj.opportunityId !== "string" || !obj.opportunityId) {
    errors.push("opportunityId must be a non-empty string");
  }
  if (typeof obj.findingId !== "string" && obj.findingId !== null) {
    errors.push("findingId must be a string or null");
  }
  if (typeof obj.findingVersion !== "number" && obj.findingVersion !== null) {
    errors.push("findingVersion must be a number or null");
  }
  if (typeof obj.compiledAt !== "number") {
    errors.push("compiledAt must be a number");
  }
  if (obj.schemaVersion !== FINANCE_REPORT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be "${FINANCE_REPORT_SCHEMA_VERSION}", got ${JSON.stringify(obj.schemaVersion)}`,
    );
  }
  for (const field of FINANCE_REPORT_NULLABLE_OBJECT_FIELDS) {
    const value = obj[field];
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`${field} must be an object or null`);
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

// ─── Phase 10d: Finance audit log ──────────────────────────────────────
//
// Zent.md 10d: "Audit log: every number Finance produces is traceable
// to the wallet/spend query that generated it — no hand-waved
// figures." See db.ts's own finance_audit_log header for the schema
// and the "three real reads vs. everything-else-is-arithmetic" split
// this section implements.
//
// Same "route/caller resolves nothing new here, this file turns
// evidence that already exists into a durable row" posture every
// record*() function in Phase 8/9 already keeps — recordFinanceAuditEntry()
// is a pure insert, never a re-query.
export type FinanceAuditMetric =
  | "build_cost"
  | "time_to_revenue"
  | "available_capital"
  | "runway_check"
  | "worst_case_loss"
  | "sizing_recommendation"
  | "staged_funding_option"
  | "sensitivity_note"
  | "hard_reject";

export interface FinanceAuditEntry {
  id: string;
  opportunityId: string;
  agentAddress: string;
  metric: FinanceAuditMetric;
  value: number | null;
  sourceQuery: string;
  rowCount: number;
  rawEvidence: unknown;
  refIds: string[];
  recordedAt: number;
}

interface FinanceAuditEntryRow {
  id: string;
  opportunity_id: string;
  agent_address: string;
  metric: string;
  value: number | null;
  source_query: string;
  row_count: number;
  raw_evidence_json: string;
  ref_ids_json: string | null;
  recorded_at: number;
}

function toFinanceAuditEntry(row: FinanceAuditEntryRow): FinanceAuditEntry {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    agentAddress: row.agent_address,
    metric: row.metric as FinanceAuditMetric,
    value: row.value,
    sourceQuery: row.source_query,
    rowCount: row.row_count,
    rawEvidence: JSON.parse(row.raw_evidence_json),
    refIds: row.ref_ids_json ? JSON.parse(row.ref_ids_json) : [],
    recordedAt: row.recorded_at,
  };
}

/**
 * Records one finance_audit_log row. `rawEvidence` is the literal
 * rows/values a real wallet/spend/duration query returned for a
 * query-backed metric (build_cost, time_to_revenue, available_capital),
 * or the already-recorded finding(s) an arithmetic-only metric (8e
 * through 9d, plus 10b's hard_reject) was computed from — either way,
 * "traceable" means this row holds the actual inputs, not just the
 * output number. `refIds` lets an arithmetic-only row point back at the
 * query-backed row(s) that ultimately fed it, without duplicating their
 * raw evidence a second time (see db.ts's own header for why).
 */
export function recordFinanceAuditEntry(entry: {
  opportunityId: string;
  agentAddress: string;
  metric: FinanceAuditMetric;
  value: number | null;
  sourceQuery: string;
  rowCount: number;
  rawEvidence: unknown;
  refIds?: string[];
}): FinanceAuditEntry {
  const id = `finaud_${ulid()}`;
  const recordedAt = Date.now();
  db.prepare(
    `INSERT INTO finance_audit_log
       (id, opportunity_id, agent_address, metric, value, source_query, row_count, raw_evidence_json, ref_ids_json, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.opportunityId,
    entry.agentAddress,
    entry.metric,
    entry.value,
    entry.sourceQuery,
    entry.rowCount,
    JSON.stringify(entry.rawEvidence),
    entry.refIds && entry.refIds.length > 0 ? JSON.stringify(entry.refIds) : null,
    recordedAt,
  );
  return {
    id,
    opportunityId: entry.opportunityId,
    agentAddress: entry.agentAddress,
    metric: entry.metric,
    value: entry.value,
    sourceQuery: entry.sourceQuery,
    rowCount: entry.rowCount,
    rawEvidence: entry.rawEvidence,
    refIds: entry.refIds ?? [],
    recordedAt,
  };
}

/**
 * Full audit trail for one opportunity, oldest first — every
 * finance_audit_log row Finance has ever recorded against it, across
 * every metric and every re-run (deliberately NOT deduplicated down to
 * "current" the way finance_findings is; a superseded pass is still a
 * real historical fact about what Finance once computed and why).
 */
export function getFinanceAuditLog(opportunityId: string): FinanceAuditEntry[] {
  const rows = db
    .prepare(
      `SELECT id, opportunity_id, agent_address, metric, value, source_query, row_count, raw_evidence_json, ref_ids_json, recorded_at
       FROM finance_audit_log
       WHERE opportunity_id = ?
       ORDER BY recorded_at ASC`,
    )
    .all(opportunityId) as FinanceAuditEntryRow[];
  return rows.map(toFinanceAuditEntry);
}

/**
 * Resolves the owning agent for `opportunityId` via its
 * opportunity_reports row — the same opportunity -> report ->
 * report.agent_address chain every Phase 8/9 route's own ownership
 * check already walks. Used only by the arithmetic-only record*()
 * functions below (8e, 9a-9d, 10b) so their audit rows can carry an
 * agent_address without widening their own public signatures — the
 * query-backed tools (8b/8c/8d) already take agentAddress as a real
 * parameter and don't need this.
 */
function resolveOpportunityAgentAddress(opportunityId: string): string {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const report = getOpportunityReport(opportunity.report_id);
  if (!report) {
    throw new Error(`opportunity_report ${opportunity.report_id} not found`);
  }
  return report.agent_address;
}

/**
 * The most recently recorded audit row for one (opportunity, metric)
 * pair, if any — how an arithmetic-only metric's record*() function
 * below finds the query-backed row(s) it should cite in its own
 * `refIds`, without the caller having to thread audit-row ids through
 * every Phase 8/9 function signature by hand.
 */
function getLatestFinanceAuditEntry(
  opportunityId: string,
  metric: FinanceAuditMetric,
): FinanceAuditEntry | undefined {
  const row = db
    .prepare(
      `SELECT id, opportunity_id, agent_address, metric, value, source_query, row_count, raw_evidence_json, ref_ids_json, recorded_at
       FROM finance_audit_log
       WHERE opportunity_id = ? AND metric = ?
       ORDER BY recorded_at DESC
       LIMIT 1`,
    )
    .get(opportunityId, metric) as FinanceAuditEntryRow | undefined;
  return row ? toFinanceAuditEntry(row) : undefined;
}

export const createStrategyFinding = <T = Record<string, unknown>>(
  opportunityId: string,
  findings: T,
) => createFinding<T>("strategy", opportunityId, findings);
export const getCurrentStrategyFinding = <T = Record<string, unknown>>(opportunityId: string) =>
  getCurrentFinding<T>("strategy", opportunityId);
export const listStrategyFindingVersions = <T = Record<string, unknown>>(opportunityId: string) =>
  listFindingVersions<T>("strategy", opportunityId);

// ─── Phase 11b: list_existing_companies(rootAgentAddress) ──────────────
//
// Zent.md 11b: "Tool: `list_existing_companies(rootAgentAddress)` —
// walks `company_lineage` to see every already-spawned sibling and its
// mission, so Strategy has the actual portfolio in front of it, not a
// guess." Per db.ts's own Phase 1e header, this repo has no separate
// company_lineage table to walk — `agents.parent_address` (plus the
// spawn_reason/opportunity_id columns that same migration added) IS
// the lineage record, and wallet.ts's GET /:address/lineage already
// reads it exactly this way for its own `children` list. This function
// is that same read, reused rather than re-derived, with one addition
// wallet.ts's own route has no reason to make: resolving each
// pipeline-spawned sibling's `opportunity_id` into an actual mission a
// Strategy department can read.
//
// "Its mission" now prefers the real thing: Phase 17c added a
// purpose-built `agents.mission` column (db.ts) that genesis.ts's
// writeStructuredMission() fills in — JSON, richer than title+thesis
// alone (it also carries Strategy's own relationship-type reasoning
// from the sibling's birth) — for every company genesis'd from that
// phase onward. This function reads that column first.
//
// A pipeline-spawned sibling genesis'd BEFORE 17c shipped has
// `mission = NULL` (the column's default; nothing backfills old rows).
// For exactly that case — and only that case — this falls back to the
// pre-17c reconstruction: the opportunity it was funded to pursue,
// Phase 1b's own `title`/`thesis` columns, unmodified since Opportunity
// Intelligence first scored them. `null` throughout means "no mission
// on file" — a `self`-spawned agent (spawn_clone has never taken a
// mission argument; Zent.md's own top section is explicit this
// pipeline sits on top of that path unmodified), or an
// `expansion_pipeline` one whose own `opportunity_id` row has since
// been archived/pruned out from under it (that column's own comment in
// db.ts already documents this as expected, not an error). Either way
// it's an honest gap, never a fabricated mission.
//
// Deliberately no ownership/authorization check beyond whatever
// middleware the calling route already sits behind — same posture
// wallet.ts's own GET /:address/lineage and this file's own GET
// /notifications/:agentAddress already take for a plain read with no
// side effects (see expansionRoutes.ts's own comment on the shared
// BACKEND_API_KEY trust boundary this whole pipeline runs behind: a
// caller holding it is the owning agent's own runtime or a department
// acting through it, never a distinct human identity to gate against).
export interface ExistingCompanyMission {
  opportunityId: string;
  title: string;
  thesis: string;
  /** 17c: Strategy's relationship-type recommendation as of this
   *  sibling's own birth, carried along when the structural field has
   *  it — always null for the pre-17c opportunity-derived fallback,
   *  since that reconstruction has no way to know what Strategy said
   *  at genesis time versus what it might say today. */
  relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
  relationshipReasoning: string | null;
  /** "structural" = read from the Phase 17c agents.mission column this
   *  sibling was genesis'd with; "opportunity-derived" = this function's
   *  own pre-17c fallback, reconstructed from the opportunity row
   *  because this sibling predates that column (or the column's JSON
   *  failed to parse — see the catch below). Lets a caller (Strategy's
   *  own 11c/11d tools, an ops query) tell a first-class mission record
   *  apart from a best-effort reconstruction without guessing from the
   *  other fields. */
  source: "structural" | "opportunity-derived";
}

export interface ExistingCompany {
  address: string;
  name: string | null;
  createdAt: number;
  spawnReason: "self" | "expansion_pipeline";
  opportunityId: string | null;
  mission: ExistingCompanyMission | null;
}

interface AgentLineageRow {
  address: string;
  name: string | null;
  created_at: number;
  spawn_reason: "self" | "expansion_pipeline";
  opportunity_id: string | null;
  mission: string | null;
}

// Split out of listExistingCompanies() below when Phase 18b needed the
// exact same structural-then-opportunity-derived resolution for a
// *root* address (which listExistingCompanies() never itself returns a
// row for — it only lists a given address's children). Pure, DB read
// only through getOpportunity() — no caller-visible behavior change to
// listExistingCompanies() itself; this is the same logic, unchanged,
// just callable on a single row instead of inlined in the one .map().
export function resolveCompanyMission(row: {
  mission: string | null;
  opportunity_id: string | null;
}): ExistingCompanyMission | null {
  // 17c: prefer the structural field this company was genesis'd with.
  if (row.mission) {
    try {
      const structured = JSON.parse(row.mission) as {
        opportunityId: string;
        title: string;
        thesis: string;
        relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
        relationshipReasoning: string | null;
      };
      return { ...structured, source: "structural" };
    } catch {
      // Malformed JSON should never happen (genesis.ts's
      // writeStructuredMission() is the column's only writer, and it
      // always calls JSON.stringify() on a well-typed object) — fall
      // through to the pre-17c reconstruction below rather than
      // throwing out of a plain read, same defensive posture this
      // pipeline takes elsewhere for "shouldn't happen, don't let it
      // take down a read path if it somehow does."
    }
  }

  // Pre-17c fallback: a company genesis'd before the mission column
  // existed, or a structural read that failed to parse above.
  if (row.opportunity_id) {
    const opportunity = getOpportunity(row.opportunity_id);
    if (opportunity) {
      return {
        opportunityId: opportunity.id,
        title: opportunity.title,
        thesis: opportunity.thesis,
        relationshipType: null,
        relationshipReasoning: null,
        source: "opportunity-derived",
      };
    }
  }

  return null;
}

export function listExistingCompanies(rootAgentAddress: string): ExistingCompany[] {
  if (!rootAgentAddress) {
    throw new Error("rootAgentAddress is required");
  }
  const rows = db
    .prepare(
      `SELECT address, name, created_at, spawn_reason, opportunity_id, mission
       FROM agents
       WHERE parent_address = ?
       ORDER BY created_at ASC`,
    )
    .all(rootAgentAddress) as AgentLineageRow[];

  return rows.map((row) => ({
    address: row.address,
    name: row.name,
    createdAt: row.created_at,
    spawnReason: row.spawn_reason,
    opportunityId: row.opportunity_id,
    mission: resolveCompanyMission(row),
  }));
}

// ─── Phase 11c: check_mission_overlap(opportunity_id) ───────────────────
//
// Zent.md 11c: "Tool: `check_mission_overlap(opportunity_id)` — flags
// whether the proposed mission competes with, duplicates, or clearly
// complements an existing sibling."
//
// Builds directly on 11b: listExistingCompanies() is exactly "the
// actual portfolio in front of it" this check compares the candidate
// opportunity against. Reuses 3c's scoreCorpus()/dedupText() plumbing
// for the same reason findDedupMatchesForOpportunity() (3c's own
// read-side sibling, just above) already does — one TF-IDF similarity
// metric across this whole file, not a second one invented here.
//
// Text similarity alone can't carry all three labels Zent.md asks for.
// Two opportunities that are obviously the same idea restated will
// score high on title+thesis similarity — that's "duplicates," 3c's
// own dedup case restated one level up (across a whole portfolio's
// spawned siblings rather than just this agent's own still-open
// opportunities). Two that occupy the same market with a different
// angle score moderately — "competes." But two that solve genuinely
// different problems while sharing a domain or tech stack (Phase 1b's
// own tags[]) can score low on text similarity while still being
// exactly the kind of relationship Strategy needs surfaced — so this
// check layers a second, independent signal, tag Jaccard overlap,
// purely for that "complements" case. The two signals are checked in a
// fixed order, similarity first: a mission whose text already reads as
// competing is classified on that signal even if it also happens to
// share tags, since sharing a domain is a much weaker claim than
// describing the same market.
//
// Each already-spawned sibling 11b can resolve a mission for lands in
// exactly one of three buckets, or is omitted:
//   - "duplicates": similarity >= config.missionOverlapDuplicateThreshold
//   - "competes": similarity >= config.missionOverlapCompetesThreshold
//     (and below the duplicate threshold)
//   - "complements": similarity below the competes threshold, but tag
//     overlap >= config.missionOverlapComplementsTagThreshold
//   - omitted: neither signal clears its floor — nothing here is worth
//     flagging, same "no signal, not included" posture
//     findDedupMatchesForOpportunity() already takes for an opportunity
//     with no near-duplicate history.
//
// Only compares against siblings 11b can actually resolve a mission
// for (spawn_reason = 'expansion_pipeline' with a live opportunity
// row) — a self-spawned (spawn_clone) sibling has no mission text to
// compare against and is silently skipped, same honest-null handling
// 11b's own header documents rather than fabricating a comparison out
// of nothing. A sibling whose own resolved mission happens to point
// back at `opportunityId` itself (defensive: shouldn't happen given
// 11b's own semantics, but cheap to guard) is excluded rather than
// letting an opportunity "overlap" with itself.
//
// Pure read, no side effects — same posture 11b's own
// listExistingCompanies() and 3c's own findDedupMatchesForOpportunity()
// take. Throws only if opportunityId itself doesn't resolve to a real
// opportunity, matching findDedupMatchesForOpportunity()'s own guard —
// same reasoning: this needs to be safe to call standalone (e.g. from
// a future Phase 12 report compiler) without going through some other
// combined read first.
export type MissionOverlapRelationship = "duplicates" | "competes" | "complements";

export interface MissionOverlapEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  relationship: MissionOverlapRelationship;
  /** TF-IDF cosine similarity in [0, 1] between the two title+thesis texts. */
  similarity: number;
  /** Jaccard overlap in [0, 1] between the two opportunities' tags[]. */
  tagOverlap: number;
}

/** Jaccard overlap between two tag lists, case-insensitive. 0 for two
 *  empty lists (no shared signal, not a false "total overlap"). */
function tagJaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function checkMissionOverlap(opportunityId: string): MissionOverlapEntry[] {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const rootAgentAddress = resolveOpportunityAgentAddress(opportunityId);
  const siblings = listExistingCompanies(rootAgentAddress);

  const withMission = siblings.filter(
    (s): s is ExistingCompany & { mission: ExistingCompanyMission } =>
      s.mission !== null && s.mission.opportunityId !== opportunityId,
  );
  if (withMission.length === 0) return [];

  const candidateText = dedupText(candidate.title, candidate.thesis);
  const scored = scoreCorpus(candidateText, withMission, (s) =>
    dedupText(s.mission.title, s.mission.thesis),
  );

  const { missionOverlapDuplicateThreshold, missionOverlapCompetesThreshold, missionOverlapComplementsTagThreshold } =
    config;

  const entries: MissionOverlapEntry[] = [];
  for (const { item: sibling, score } of scored) {
    const siblingOpportunity = getOpportunity(sibling.mission.opportunityId);
    const tagOverlap = tagJaccard(candidate.tags, siblingOpportunity?.tags ?? []);

    let relationship: MissionOverlapRelationship | undefined;
    if (score >= missionOverlapDuplicateThreshold) {
      relationship = "duplicates";
    } else if (score >= missionOverlapCompetesThreshold) {
      relationship = "competes";
    } else if (tagOverlap >= missionOverlapComplementsTagThreshold) {
      relationship = "complements";
    }
    if (!relationship) continue;

    entries.push({
      siblingAddress: sibling.address,
      siblingOpportunityId: sibling.mission.opportunityId,
      siblingTitle: sibling.mission.title,
      relationship,
      similarity: Math.round(score * 100) / 100,
      tagOverlap: Math.round(tagOverlap * 100) / 100,
    });
  }

  const RELATIONSHIP_RANK: Record<MissionOverlapRelationship, number> = {
    duplicates: 0,
    competes: 1,
    complements: 2,
  };
  entries.sort((a, b) => {
    if (RELATIONSHIP_RANK[a.relationship] !== RELATIONSHIP_RANK[b.relationship]) {
      return RELATIONSHIP_RANK[a.relationship] - RELATIONSHIP_RANK[b.relationship];
    }
    return b.similarity - a.similarity;
  });
  return entries;
}

// ─── Phase 11d: check_technology_reuse(opportunity_id) ──────────────────
//
// Zent.md 11d: "Tool: `check_technology_reuse(opportunity_id)` — how
// much of an existing sibling's tools/skills/codebase Agent B could
// start from, versus building from zero."
//
// Reuses 6c's own checkBuildability() outright rather than a second
// similarity function: 6c already answers "how well does a catalog of
// {name, description} entries cover this opportunity's query text" —
// exactly the question this phase asks too, just aimed at one
// sibling's own catalog instead of the whole company's global
// tool_registry+skills catalog. buildBuildabilityQueryText() (also 6c)
// is reused unmodified for the query side, so a candidate opportunity
// gets scored against a sibling's catalog with the identical text 6c
// itself would use against the global one.
//
// Scoped deliberately to *skills only* on the catalog side — not
// tool_registry rows. 16d's own header is explicit that a pipeline-
// spawned sibling's tool grant is either "the default grant set" or
// that plus one marketplace-listing grant; either way every sibling
// with the same relationship type holds the same tool_registry names,
// so a tool_registry row can never be a *sibling-specific* reuse
// signal — every sibling would "match" it identically, telling
// Strategy nothing about which company to actually reuse from. A
// skill (skills.ts's own listSkills()) is different: it's something a
// specific sibling actually authored or installed for itself, exactly
// the "existing sibling's ... codebase" Zent.md's own wording points
// at (skills.ts's own header: "a skill really is just data ... never
// executed" — the most concrete reusable artifact this repo actually
// tracks per-agent). If a future phase gives siblings genuinely
// divergent tool grants, or a real shared codebase, this is the one
// place that needs to change to fold that signal in.
//
// Same portfolio source as 11c: listExistingCompanies() (11b), same
// "only a sibling 11b can resolve a mission for" filter and the same
// defensive self-comparison guard 11c's own header explains. A
// sibling with an empty skill catalog, or whose skills don't clear
// config.technologyReuseMatchThreshold against this opportunity, is
// omitted entirely rather than returned with an empty `matches` array
// — same "no signal, not included" posture 11c and
// findDedupMatchesForOpportunity() (3c) already take, since a caller
// asking "who could Agent B start from" gets nothing useful out of
// being told a sibling has nothing reusable.
//
// Pure read, no side effects, same posture 11b/11c already take.
// Throws only if opportunityId itself doesn't resolve, matching 11c's
// own guard.
export interface TechnologyReuseMatch {
  /** A skill name from the sibling's own listSkills() catalog. */
  name: string;
  /** TF-IDF cosine similarity in [0, 1] between this opportunity's
   *  query text and the skill's name+description. */
  score: number;
}

export interface TechnologyReuseEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  /** Every one of the sibling's own skills clearing
   *  config.technologyReuseMatchThreshold, highest-similarity first. */
  matches: TechnologyReuseMatch[];
  /** matches[0].score, or 0 if matches is empty — a single headline
   *  number Strategy's own Phase 11e fit-scoring can read directly
   *  without re-deriving it from the full match list. */
  reuseScore: number;
}

export function checkTechnologyReuse(opportunityId: string): TechnologyReuseEntry[] {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const rootAgentAddress = resolveOpportunityAgentAddress(opportunityId);
  const siblings = listExistingCompanies(rootAgentAddress).filter(
    (s): s is ExistingCompany & { mission: ExistingCompanyMission } =>
      s.mission !== null && s.mission.opportunityId !== opportunityId,
  );
  if (siblings.length === 0) return [];

  // Same "6c may run before 6a has" graceful-degradation buildBuildabilityQueryText()
  // already documents — a thinner query text just means a weaker
  // signal, not an error, so this doesn't require 6a to have run first.
  const currentResearch = getCurrentResearchFinding(opportunityId);
  const technicalRequirements = (
    currentResearch?.findings as { technical_requirements?: TechnicalRequirementsAssessment } | undefined
  )?.technical_requirements;
  const queryText = buildBuildabilityQueryText(candidate, technicalRequirements);

  const entries: TechnologyReuseEntry[] = [];
  for (const sibling of siblings) {
    const catalog: BuildabilityCatalogEntry[] = listSkills(sibling.address).map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: "skill" as const,
    }));
    if (catalog.length === 0) continue;

    const { matches } = checkBuildability(queryText, catalog, config.technologyReuseMatchThreshold);
    if (matches.length === 0) continue;

    entries.push({
      siblingAddress: sibling.address,
      siblingOpportunityId: sibling.mission.opportunityId,
      siblingTitle: sibling.mission.title,
      matches: matches.map((m) => ({ name: m.name, score: m.score })),
      reuseScore: matches[0].score,
    });
  }

  entries.sort((a, b) => {
    if (b.reuseScore !== a.reuseScore) return b.reuseScore - a.reuseScore;
    return b.matches.length - a.matches.length;
  });
  return entries;
}

// ─── Phase 11e-i: fit-score formula & factors ──────────────────────────
//
// Zent.md 11e: "Direction scoring: Strategy's own 0-100 fit score,
// separate from Opportunity Intelligence's ROI score — the two are
// allowed to disagree. Split into three build sessions below
// (11e-i-iii) since 11a-11d already shipped in phase11d."
//
// Zent.md 11e-i: "Document the deterministic fit-score formula
// (mirroring 3b's ROI formula): factors — mission-complementarity
// (from 11c's overlap check), technology-reuse depth (11d), ecosystem-
// diversification value, market-independence — each 0-100, combined
// into one fit_score." / "Store the factor inputs alongside fit_score
// in strategy_findings.findings (the existing JSON blob column) so the
// score is auditable like 3b's roi_score, not just a bare number." /
// "Factor-weighting constants live in config.ts, next to the existing
// 11c/11d thresholds (config.ts:670, config.ts:712), not hardcoded
// inline — tunable without touching department logic."
//
// This sub-phase is deliberately formula-and-shape only, same "the
// table exists vs. something principled computes the number" split
// 1b/3b's own docstrings already draw for roi_score. It gives fit_score
// a validated input shape (FitScoreFactors), a documented deterministic
// formula (computeFitScore()), and a version tag — it does not compute
// any factor from live data, and it does not write a strategy_findings
// row. That's 11e-ii's score_strategy_fit(opportunity_id) tool: reading
// 11c's checkMissionOverlap() / 11d's checkTechnologyReuse() output,
// deriving missionComplementarity/technologyReuseDepth from them, and
// persisting the result via createStrategyFinding() (1c/1d above) —
// exactly the "reads the current 11c/11d findings, applies 11e-i's
// formula, writes fit_score" sequence Zent.md 11e-ii-a describes. This
// phase only has to make that later call a one-liner.
//
// Two of the four factors don't have a source tool yet even after
// 11a-11d: mission-complementarity and technology-reuse-depth are
// straightforward — 11c/11d already produce exactly that signal per
// sibling — but ecosystem-diversification-value and market-independence
// are Phase 12's territory (assess_ecosystem_strengthening, 12a) and
// have no computation here to reuse yet. Rather than block the formula
// on a phase that hasn't shipped, FitScoreFactors takes all four as
// already-scored 0-100 numbers, the same "validated input shape,
// caller supplies the numbers" posture 3a's own ScoringFactors takes
// for score_opportunity's four factors (score_opportunity doesn't
// compute demand/expenseOfProblem/buildability/competitiveGap itself
// either — a caller, ultimately the department's own reasoning, does).
// 11e-ii's tool is what will supply real mission-complementarity/
// technology-reuse-depth values by deriving them from 11c/11d; until
// Phase 12 ships, a caller of score_strategy_fit has to supply
// ecosystem-diversification-value and market-independence itself (or
// this formula, given a 0 for either, will simply score that axis low
// — not an error, just an honest reflection of no signal yet, same
// "no signal, not included" posture 11c/11d's own headers already
// take elsewhere in this file).
export interface FitScoreFactors {
  /** From 11c's checkMissionOverlap(): how well the opportunity
   *  complements (rather than duplicates or competes with) the
   *  existing portfolio. Not a raw pass-through of any single
   *  MissionOverlapEntry — see 11e-ii for how a "complements" siblings
   *  list becomes this one 0-100 number. */
  missionComplementarity: number;
  /** From 11d's checkTechnologyReuse(): how much of an existing
   *  sibling's catalog this opportunity could start from. 11e-ii's own
   *  natural source is checkTechnologyReuse()'s own reuseScore
   *  (already 0-1 similarity; scaled to 0-100 here for the same reason
   *  score_opportunity's factors are 0-100, not 0-1). */
  technologyReuseDepth: number;
  /** Phase 12 territory (assess_ecosystem_strengthening) — does this
   *  new company make the existing portfolio more resilient. No
   *  computation exists for this yet; caller-supplied until 12a ships. */
  ecosystemDiversificationValue: number;
  /** Phase 12 territory — how much this opportunity's success depends
   *  on markets/customers the existing portfolio doesn't already touch.
   *  No computation exists for this yet; caller-supplied until 12a ships. */
  marketIndependence: number;
}

/**
 * Validates that every one of FitScoreFactors' four factors is a
 * finite number in [0, 100] inclusive. Same "name every problem at
 * once" posture validateScoringFactors() (3a) takes, for the same
 * reason: a caller — eventually 11e-ii's score_strategy_fit route —
 * should get the whole problem back in one round trip, not one
 * failed retry per bad factor.
 */
export function validateFitScoreFactors(factors: FitScoreFactors): void {
  const problems: string[] = [];
  for (const key of [
    "missionComplementarity",
    "technologyReuseDepth",
    "ecosystemDiversificationValue",
    "marketIndependence",
  ] as const) {
    const value = factors[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      problems.push(`${key} must be a finite number between 0 and 100 (got ${JSON.stringify(value)})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid fit score factors: ${problems.join("; ")}`);
  }
}

// The formula itself, fixed and documented rather than left to the
// model to invent per-call — same discipline 3b's own header commits
// to for roi_score:
//
//   fit_score = 0.35*missionComplementarity + 0.30*technologyReuseDepth
//             + 0.20*ecosystemDiversificationValue + 0.15*marketIndependence
//
// Weights sum to 1.0, so with every factor already range-checked into
// [0, 100] (validateFitScoreFactors) the result is always in [0, 100]
// too — no separate clamp needed, same guarantee computeRoiScore()
// gets from validateScoringFactors().
//
// Why these weights and not an equal 25/25/25/25 split: mission-
// complementarity and technology-reuse-depth are the two factors this
// stack can already compute today, straight from 11c/11d's own
// TF-IDF-backed checks against real sibling data — they get the larger
// combined weight (0.65) because they're the two inputs with an actual
// evidentiary basis behind them right now. Ecosystem-diversification-
// value and market-independence matter — a company that only
// diversifies the portfolio on paper, or whose success is entangled
// with an existing sibling's market, is a weaker fit even with a
// perfect mission/technology story — but until Phase 12 ships a real
// computation for either, weighting them any higher would let an
// unverified, caller-supplied number outvote the two signals this
// system can actually back with sibling data today. Deliberately the
// same weight *shape* as ROI_WEIGHTS (0.35/0.30/0.20/0.15) — not a
// coincidence: both formulas put their two best-evidenced factors first
// and their two least-verified factors last, and reusing the exact
// same split keeps that shape legible across the two formulas rather
// than inventing an arbitrary-looking new one.
//
// Rounded to 2 decimal places for the same reason ROI_WEIGHTS' own
// result is: a reviewer re-deriving fit_score by hand from the four
// stored factors gets exactly this number back.
//
// FIT_FORMULA_VERSION mirrors ROI_FORMULA_VERSION's own reasoning:
// Zent.md 20e expects scoring formulas to get tuned after real
// post-launch review, and an opportunity's fit_score needs to stay
// traceable to the exact rule that produced it. 11e-ii's own
// createStrategyFinding() call is where this version tag actually gets
// persisted alongside fit_score in strategy_findings.findings — this
// phase only defines the tag.
export const FIT_FORMULA_VERSION = "11e-i-v1";

export const FIT_SCORE_WEIGHTS = {
  missionComplementarity: config.fitScoreWeights.missionComplementarity,
  technologyReuseDepth: config.fitScoreWeights.technologyReuseDepth,
  ecosystemDiversificationValue: config.fitScoreWeights.ecosystemDiversificationValue,
  marketIndependence: config.fitScoreWeights.marketIndependence,
} as const;

/**
 * Combines FitScoreFactors' four validated factors into a single
 * 0-100 fit_score via the fixed weighted average documented above.
 * Same posture computeRoiScore() (3b) takes: does not itself validate
 * factors (callers — eventually 11e-ii's score_strategy_fit — are
 * expected to have already run them through validateFitScoreFactors()),
 * and given already-in-range inputs the result is always in [0, 100].
 */
export function computeFitScore(factors: FitScoreFactors): number {
  const raw =
    factors.missionComplementarity * FIT_SCORE_WEIGHTS.missionComplementarity +
    factors.technologyReuseDepth * FIT_SCORE_WEIGHTS.technologyReuseDepth +
    factors.ecosystemDiversificationValue * FIT_SCORE_WEIGHTS.ecosystemDiversificationValue +
    factors.marketIndependence * FIT_SCORE_WEIGHTS.marketIndependence;
  return Math.round(raw * 100) / 100;
}

/**
 * Phase 11e-i-b's "store the factor inputs alongside fit_score in
 * strategy_findings.findings" shape: the exact object 11e-ii's
 * createStrategyFinding() call will write into that JSON blob column,
 * so the score is auditable — a reviewer can see every input that
 * produced a given fit_score, same as 3a/3b's factor_* columns sitting
 * alongside opportunities.roi_score. Not written anywhere by this
 * phase; 11e-ii is what actually calls createStrategyFinding() with a
 * value shaped like this.
 */
export interface FitScoreFinding {
  fit_score: number;
  fit_formula_version: typeof FIT_FORMULA_VERSION;
  factors: FitScoreFactors;
}

// ─── Phase 11e-ii-a: score_strategy_fit(opportunity_id) ─────────────────
//
// Zent.md 11e-ii-a: "Tool: `score_strategy_fit(opportunity_id)` — reads
// the opportunity's current 11c mission-overlap finding and 11d
// technology-reuse finding, applies 11e-i's formula, and writes
// `fit_score` into that opportunity's current `strategy_findings` row
// (superseding on re-run, same versioning research/finance findings
// already use)."
//
// "The opportunity's current 11c/11d finding" is read literally against
// what 11c/11d actually are: checkMissionOverlap()/checkTechnologyReuse()
// are plain reads with no persistence of their own (11b/11c/11d's own
// headers are explicit that these are pure functions over live sibling
// data, not a table this file writes to) — so their "current" result IS
// just calling them, same as 11d's own header already leans on
// checkTechnologyReuse()'s live reuseScore as strategy's fit-scoring
// input. This tool is the first thing in this file that actually calls
// createStrategyFinding() (3816 above) with real data, closing the loop
// 11e-i's own header left open.
//
// Same read-merge-write discipline Phase 5/8's mergeIntoCurrent*Finding()
// helpers already establish for research/finance — strategy_findings is
// one report per opportunity too (11a's own header: "Strategy produces
// one report"), so a fit_score write must not clobber whatever a future
// Phase 12 tool (assess_ecosystem_strengthening et al.) has already
// filed under its own keys on the same row.
function mergeIntoCurrentStrategyFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): Finding<Record<string, unknown>> {
  const current = getCurrentStrategyFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createStrategyFinding<Record<string, unknown>>(opportunityId, merged);
}

/**
 * Derives 11e-i's missionComplementarity factor (0-100) from 11c's
 * checkMissionOverlap() entries for one opportunity.
 *
 * checkMissionOverlap() already sorts its entries worst-relationship-
 * first (RELATIONSHIP_RANK: duplicates < competes < complements, ties
 * broken by similarity descending) — so entries[0], when present, IS
 * the single most concerning relationship this opportunity has with any
 * already-spawned sibling. Scoring off that worst case rather than an
 * average matches this codebase's existing conservative-gate posture
 * (Finance's hard-reject runway floor, 6e's regulatory-risk weighting):
 * one duplicate sibling should sink this factor even if three other
 * siblings would happily call it complementary.
 *
 *   duplicates present -> 0   (same idea restated; no fit case to make)
 *   competes present   -> 25  (same space, distinct execution; weak fit)
 *   complements only    -> 75-100, scaled by the strongest tag overlap
 *                          found (checkMissionOverlap()'s own signal for
 *                          *how* complementary, not just *that* it is)
 *   no entries at all   -> 50 (no siblings yet, or no sibling clears
 *                          any of checkMissionOverlap()'s thresholds in
 *                          either direction — genuinely unknown, not a
 *                          demonstrated complement or a demonstrated
 *                          conflict, so neither this formula's 0 "no
 *                          evidence yet" floor (11e-i's own posture for
 *                          the two Phase-12 factors below) nor a
 *                          full-credit 100 is honest here)
 *
 * If entries[0]'s relationship is "complements", every entry in the
 * list is a complements entry — checkMissionOverlap()'s own sort would
 * have put any duplicates/competes entry ahead of it otherwise — so
 * scanning the whole list for the strongest tagOverlap is safe.
 */
function deriveMissionComplementarityFactor(overlap: MissionOverlapEntry[]): number {
  if (overlap.length === 0) return 50;

  const worst = overlap[0].relationship;
  if (worst === "duplicates") return 0;
  if (worst === "competes") return 25;

  const bestTagOverlap = Math.max(...overlap.map((entry) => entry.tagOverlap));
  return Math.round((75 + bestTagOverlap * 25) * 100) / 100;
}

/**
 * Derives 11e-i's technologyReuseDepth factor (0-100) from 11d's
 * checkTechnologyReuse() entries for one opportunity.
 *
 * checkTechnologyReuse() already sorts its entries best-match-first and
 * documents reuseScore as "a single headline number Strategy's own
 * Phase 11e fit-scoring can read directly without re-deriving it from
 * the full match list" — so this is exactly that read: the top entry's
 * reuseScore (0-1 TF-IDF cosine similarity), scaled to 0-100 for the
 * same reason FitScoreFactors' own header gives (every factor here is
 * 0-100, not 0-1, matching score_opportunity's own factors). No
 * siblings with any reusable skill -> 0, the same "no signal, not
 * fabricated" floor checkTechnologyReuse() itself already returns an
 * empty list for.
 */
function deriveTechnologyReuseDepthFactor(reuse: TechnologyReuseEntry[]): number {
  if (reuse.length === 0) return 0;
  return Math.round(reuse[0].reuseScore * 100 * 100) / 100;
}

/**
 * The two Phase-12 factors (ecosystemDiversificationValue,
 * marketIndependence) have no computation anywhere in this codebase yet
 * — assess_ecosystem_strengthening (12a) is what will eventually supply
 * them. Zent.md 11e-ii-a's own signature is score_strategy_fit(opportunity_id),
 * but 11e-i's own header is explicit that "a caller of score_strategy_fit
 * has to supply ecosystem-diversification-value and market-independence
 * itself" until then — this is that caller-supplied escape hatch, kept
 * optional and additive to the single required argument rather than
 * widening it. Omitted, each defaults to 0: the same honest "no signal
 * yet," not fabricated, floor FitScoreFactors' own header already
 * commits to for these two factors.
 */
export interface ScoreStrategyFitOptions {
  ecosystemDiversificationValue?: number;
  marketIndependence?: number;
}

export interface StrategyFitScoreResult {
  finding: Finding<Record<string, unknown>>;
  fitScore: FitScoreFinding;
  divergence: FitRoiDivergence;
  missionOverlap: MissionOverlapEntry[];
  technologyReuse: TechnologyReuseEntry[];
}

// ─── Phase 11e-ii-b: score_strategy_fit's 11c/11d completion guard ──────
//
// Zent.md 11e-ii-b: "Guard: `score_strategy_fit` can only run once 11c
// and 11d have both produced a non-superseded finding for the
// opportunity — mirrors the `strategy_requires_completed_research_
// report` / `..._finance_report` guards already in `departments.ts`."
//
// Read literally, this can't be built against what 11c/11d actually
// are: checkMissionOverlap()/checkTechnologyReuse() are pure functions
// with no persisted row of their own — there is no "has this run yet"
// state to check, unlike research_findings/finance_findings, which
// genuinely can be absent until some tool writes to them. 11e-ii-a's
// own header flagged exactly this gap and left it to this sub-phase.
//
// Closing it the way the mirrored departments.ts guards actually work —
// a presence check on a persisted finding, not a live recomputation —
// requires 11c and 11d to have something to check the presence OF. So
// this sub-phase adds the one thing that was missing: a persisting
// wrapper around each check, filing its result onto the opportunity's
// current strategy_findings row under its own key, the same "one report
// per opportunity, one key per tool call" discipline every other
// Phase 5/8 tool in this file already follows (5b's recordMarketSizeEstimate,
// 8b's build_cost, etc.). checkMissionOverlap()/checkTechnologyReuse()
// themselves are left completely unchanged — same signature, same pure
// behavior, same tests (expansionMissionOverlap.test.ts/
// expansionTechnologyReuse.test.ts) — these are new, additive callers of
// them, not a rewrite.
//
// score_strategy_fit's own factor derivation is updated below to read
// FROM these persisted records rather than recomputing 11c/11d live, for
// the same reason recordSizingRecommendation() (9b) reads 8b/8d's
// already-recorded findings instead of re-querying wallet.ts itself: a
// fit_score needs to be traceable to the exact mission-overlap/
// technology-reuse snapshot that was actually reviewed, not whatever
// siblings happen to exist at the instant score_strategy_fit is called
// (which could differ if a new sibling is genesis'd between the two
// calls) — the same auditability posture Phase 10d's finance_audit_log
// already commits to for every number Finance produces.

export interface MissionOverlapCheckRecord {
  entries: MissionOverlapEntry[];
  checkedAt: number;
}

export interface TechnologyReuseCheckRecord {
  entries: TechnologyReuseEntry[];
  checkedAt: number;
}

/**
 * Files one check_mission_overlap(opportunity_id) pass onto the
 * opportunity's current strategy finding, under `mission_overlap`. An
 * empty `entries` array is a valid, filed result — "no sibling
 * overlaps in either direction" is as much a completed check as a list
 * of matches, same "no good ideas this month is a valid, expected
 * output" posture 3e's kill condition already establishes elsewhere in
 * this file. Superseding on re-run, same versioning every other finding
 * write here already uses.
 */
export function recordMissionOverlapCheck(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; record: MissionOverlapCheckRecord } {
  const record: MissionOverlapCheckRecord = {
    entries: checkMissionOverlap(opportunityId),
    checkedAt: Date.now(),
  };
  const finding = mergeIntoCurrentStrategyFinding(opportunityId, { mission_overlap: record });
  return { finding, record };
}

/**
 * Files one check_technology_reuse(opportunity_id) pass onto the
 * opportunity's current strategy finding, under `technology_reuse`.
 * Same "empty entries is still a completed, filed check" posture
 * recordMissionOverlapCheck() documents just above.
 */
export function recordTechnologyReuseCheck(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; record: TechnologyReuseCheckRecord } {
  const record: TechnologyReuseCheckRecord = {
    entries: checkTechnologyReuse(opportunityId),
    checkedAt: Date.now(),
  };
  const finding = mergeIntoCurrentStrategyFinding(opportunityId, { technology_reuse: record });
  return { finding, record };
}

/**
 * Thrown by scoreStrategyFit() when 11c's mission_overlap and/or 11d's
 * technology_reuse haven't been filed yet for this opportunity — same
 * "refuse to invent a number without its real basis" posture
 * MissingBuildCostEstimateError (9a) / MissingFinancePrerequisitesError
 * (9b) already establish for Finance, applied to Strategy's own two
 * prerequisites instead.
 */
export class MissingStrategyFitPrerequisitesError extends Error {
  status = 409;
  constructor(opportunityId: string, missingTools: string[]) {
    super(
      `${missingTools.join(" and ")} must run for opportunity ${opportunityId} before score_strategy_fit`,
    );
    this.name = "MissingStrategyFitPrerequisitesError";
  }
}

// ─── Phase 11e-iii-a: fit_score / roi_score divergence tagging ──────────
//
// Zent.md 11e-iii-a: "Divergence field: when fit_score and the
// opportunity's roi_score (Phase 3) disagree by more than a configured
// threshold, tag the finding fit_roi_divergence — the concrete signal
// Phase 13c's 'disagreement surfacing' will read."
//
// 11e's own header is explicit that fit_score and roi_score are
// "allowed to disagree" — Opportunity Intelligence and Strategy score
// off genuinely different evidence (roi_score: demand, expense-of-
// problem, buildability, competitive-gap; fit_score: mission-
// complementarity, technology-reuse, ecosystem-diversification,
// market-independence), so a gap between them isn't a bug in either
// formula. What Phase 13c's committee packet needs is not a resolution
// of that disagreement (this file has no basis to prefer one score over
// the other) but a flagged, structured record that it exists, so the
// packet can surface it explicitly rather than silently averaging two
// scores that are actually in tension — exactly what 13a/13c's own
// header describes for Finance-vs-Strategy disagreement, applied here
// to Opportunity-Intelligence-vs-Strategy instead.
//
// Deliberately computed here in expansion.ts, not left to the committee
// (Phase 13, not built yet) to derive later from the two raw scores:
// the same "auditable, not a bare number" discipline 11e-i-b's own
// header commits to for fit_score's own factor inputs applies to this
// comparison too — a reviewer (or 13c itself) should be able to read
// `fit_roi_divergence` straight off the strategy finding and see
// exactly which two numbers were compared, at what threshold, without
// re-deriving anything.
export interface FitRoiDivergence {
  /** True when |fitScore - roiScore| exceeds config's threshold. Always
   *  false when roiScore is null — a genuinely unscored opportunity is
   *  not "divergent," it's simply missing one of the two numbers this
   *  comparison needs (same "no signal, not fabricated" posture 11e-i's
   *  own header takes toward its two not-yet-computable factors). */
  diverges: boolean;
  fitScore: number;
  /** Null when the opportunity has no roi_score yet — Phase 3's
   *  score_opportunity hasn't run, or ran with a caller-supplied
   *  roiScore that skipped a version tag (Opportunity.roi_score's own
   *  header). Strategy can score fit before Opportunity Intelligence
   *  scores ROI; nothing in this pipeline enforces an ordering between
   *  the two, so this has to be a real, distinguishable state. */
  roiScore: number | null;
  /** |fitScore - roiScore|, rounded to 2 decimal places for the same
   *  "a reviewer re-deriving this by hand gets the same number back"
   *  reason computeFitScore()/computeRoiScore() round their own results.
   *  Null exactly when roiScore is null. */
  delta: number | null;
  /** The threshold this comparison was actually run against
   *  (config.fitRoiDivergenceThreshold at call time), stored alongside
   *  the verdict so a later retune of the threshold (Zent.md 20e) never
   *  makes an already-filed divergence tag ambiguous about which cutoff
   *  produced it — same reasoning FIT_FORMULA_VERSION/ROI_FORMULA_VERSION
   *  give for stamping a formula version onto their own scores. */
  threshold: number;
}

/**
 * Compares one opportunity's fit_score against its roi_score and
 * decides whether they diverge by more than config's configured
 * threshold. Pure function — no DB access, no side effects — so
 * scoreStrategyFit() below is the only thing that decides *when* this
 * runs and *what* to do with the result (merge it onto the current
 * strategy finding), the same split every other pure scoring/
 * classification function in this file (computeFitScore(),
 * computeRoiScore(), deriveMissionComplementarityFactor()) already
 * keeps from its own persisting caller.
 */
export function computeFitRoiDivergence(
  fitScore: number,
  roiScore: number | null,
): FitRoiDivergence {
  const threshold = config.fitRoiDivergenceThreshold;
  if (roiScore === null) {
    return { diverges: false, fitScore, roiScore: null, delta: null, threshold };
  }
  const delta = Math.round(Math.abs(fitScore - roiScore) * 100) / 100;
  return { diverges: delta > threshold, fitScore, roiScore, delta, threshold };
}

/**
 * Zent.md 11e-ii-a/b's tool. Requires 11c's `mission_overlap` and 11d's
 * `technology_reuse` to already be filed on the opportunity's current
 * strategy finding (11e-ii-b's guard — see this section's own header
 * for why that means recordMissionOverlapCheck()/
 * recordTechnologyReuseCheck() must have run first, not a live
 * checkMissionOverlap()/checkTechnologyReuse() call here), derives
 * 11e-i's two computable factors from those persisted records, applies
 * 11e-i's fixed weighted-average formula (computeFitScore()), and
 * writes the result under strategy_findings.findings.fit_score — a
 * fresh, superseding version every call, same versioning every other
 * Phase 5/8/11 finding write in this file already uses. Also computes
 * and files 11e-iii-a's fit_roi_divergence tag in the same write, using
 * this same opportunity's current roi_score (Phase 3) — a fit_score and
 * its divergence verdict are always filed together, on the same
 * strategy_findings version, so a reader can never see one without the
 * other for a given version.
 *
 * Throws MissingStrategyFitPrerequisitesError (409) if either
 * prerequisite is missing, a plain Error if opportunityId itself
 * doesn't resolve, or validateFitScoreFactors()'s own Error if a
 * caller-supplied options value is out of range (the two derived
 * factors are always in [0, 100] by construction).
 */
export function scoreStrategyFit(
  opportunityId: string,
  options: ScoreStrategyFitOptions = {},
): StrategyFitScoreResult {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }

  const current = getCurrentStrategyFinding(opportunityId);
  const missionOverlapRecord = current?.findings?.mission_overlap as
    | MissionOverlapCheckRecord
    | undefined;
  const technologyReuseRecord = current?.findings?.technology_reuse as
    | TechnologyReuseCheckRecord
    | undefined;

  const missingTools: string[] = [];
  if (!missionOverlapRecord) missingTools.push("check_mission_overlap");
  if (!technologyReuseRecord) missingTools.push("check_technology_reuse");
  if (missingTools.length > 0) {
    throw new MissingStrategyFitPrerequisitesError(opportunityId, missingTools);
  }

  const missionOverlap = missionOverlapRecord!.entries;
  const technologyReuse = technologyReuseRecord!.entries;

  const factors: FitScoreFactors = {
    missionComplementarity: deriveMissionComplementarityFactor(missionOverlap),
    technologyReuseDepth: deriveTechnologyReuseDepthFactor(technologyReuse),
    ecosystemDiversificationValue: options.ecosystemDiversificationValue ?? 0,
    marketIndependence: options.marketIndependence ?? 0,
  };
  validateFitScoreFactors(factors);

  const fitScore: FitScoreFinding = {
    fit_score: computeFitScore(factors),
    fit_formula_version: FIT_FORMULA_VERSION,
    factors,
  };

  const divergence = computeFitRoiDivergence(fitScore.fit_score, opportunity.roi_score);

  const finding = mergeIntoCurrentStrategyFinding(opportunityId, {
    fit_score: fitScore,
    fit_roi_divergence: divergence,
  });

  return { finding, fitScore, divergence, missionOverlap, technologyReuse };
}

// ─── Phase 11e-iii-b/c: compile_strategy_report ─────────────────────────
//
// Zent.md 11e-iii-b: "compile_strategy_report (12d) picks up fit_score
// and any fit_roi_divergence tag as first-class fields, not buried
// prose — keeps parity with how 7a/9e structure their reports." /
// 11e-iii-c: "GET /expansion/opportunities/:id/strategy (12e) response
// includes fit_score and divergence status; its shape test is extended
// to assert both are present."
//
// Read literally against build order, compile_strategy_report and its
// GET route were Phase 12's own deliverables (12d/12e) — until this
// session, Strategy's ecosystem-health tools (12a assess_ecosystem_
// strengthening, 12b cannibalization check, 12c relationship-type
// recommendation) hadn't shipped yet, so a *complete* Phase 12 report
// couldn't be assembled here. 11e-iii shipped the compile-report/GET-
// route *shape* early (same "shape now, fields as their sources land"
// posture compileResearchReport()/compileFinanceReport() themselves
// took toward 5b-6d and 8b-9c before every section existed) scoped to
// what Strategy had at the time: 11c's mission-overlap check, 11d's
// technology-reuse check, and 11e's fit_score + fit_roi_divergence. This
// build session (12d) is exactly the promised follow-up: it adds 12a's
// ecosystemStrengthening, 12b's cannibalizationCheck, and 12c's
// relationshipTypeRecommendation as three more nullable, first-class
// sections — same "assemble a report from the current finding, section
// by section, each nullable rather than defaulted" posture the report
// already uses for its first four sections, extended rather than
// replaced.
//
// STRATEGY_REPORT_SCHEMA_VERSION moves from "11e-iii-v1" to "12d-v1"
// here — exactly the bump this section's own prior header already
// promised ("bumps this to a '12d-v1' ... the same way any future
// schema change here would"), so a report compiled under the old,
// narrower four-section contract is never silently accepted by
// validateStrategyReportShape() as if it still matched this version's
// seven-section one (same reasoning RESEARCH_REPORT_SCHEMA_VERSION/
// FINANCE_REPORT_SCHEMA_VERSION give their own tags).
export interface StrategyReport {
  opportunityId: string;
  /** Which strategy_findings row this was compiled from, and its
   *  version — null if Strategy hasn't run any tool for this
   *  opportunity yet, the same legitimate "nothing to compile" state
   *  compileResearchReport()'s own findingId/findingVersion allow. */
  findingId: string | null;
  findingVersion: number | null;
  compiledAt: number;
  /** Phase 11e-iii-b: which locked report contract produced this
   *  object — see STRATEGY_REPORT_SCHEMA_VERSION below. */
  schemaVersion: string;
  /** 11e-ii-b's persisted check_mission_overlap(opportunity_id) pass —
   *  null until recordMissionOverlapCheck() has filed one. */
  missionOverlap: MissionOverlapCheckRecord | null;
  /** 11e-ii-b's persisted check_technology_reuse(opportunity_id) pass —
   *  null until recordTechnologyReuseCheck() has filed one. */
  technologyReuse: TechnologyReuseCheckRecord | null;
  /** 11e-ii's fit_score, factor inputs, and formula version — null
   *  until score_strategy_fit has run (which itself requires the two
   *  fields above to already be filed, per 11e-ii-b's guard, so in
   *  practice this is either the only null section or none are). */
  fitScore: FitScoreFinding | null;
  /** 11e-iii-a's divergence verdict against this opportunity's current
   *  roi_score — always filed in the same write as fitScore (see
   *  scoreStrategyFit()'s own header), so this is non-null exactly when
   *  fitScore is non-null, never independently. */
  fitRoiDivergence: FitRoiDivergence | null;
  /** 12a's persisted assess_ecosystem_strengthening(opportunity_id)
   *  pass — null until recordEcosystemStrengtheningAssessment() has
   *  filed one. Independent of fitScore/fitRoiDivergence: Strategy can
   *  run 12a before, after, or without ever running 11e-ii's
   *  score_strategy_fit for a given opportunity. */
  ecosystemStrengthening: EcosystemStrengtheningCheckRecord | null;
  /** 12b's persisted check_cannibalization(opportunity_id) pass — null
   *  until recordCannibalizationCheck() has filed one. Same
   *  independence from the other sections as ecosystemStrengthening
   *  above. */
  cannibalizationCheck: CannibalizationCheckRecord | null;
  /** 12c's persisted recommend_relationship_type(opportunity_id) pass —
   *  null until recordRelationshipTypeRecommendation() has filed one.
   *  16d reads this section directly to scope Agent B's initial tool
   *  grants at genesis, once it's non-null. */
  relationshipTypeRecommendation: RelationshipTypeRecommendationRecord | null;
}

/** Shape of strategy_findings.findings as 11e-ii-b/11e-ii/12a/12b/12c's
 *  tools actually write it — same loosely-typed read every other
 *  compile*Report() function in this file already casts its own
 *  findings blob to before re-shaping it once into a fully-typed
 *  object. */
interface RawStrategyFindings {
  mission_overlap?: MissionOverlapCheckRecord;
  technology_reuse?: TechnologyReuseCheckRecord;
  fit_score?: FitScoreFinding;
  fit_roi_divergence?: FitRoiDivergence;
  ecosystem_strengthening?: EcosystemStrengtheningCheckRecord;
  cannibalization_check?: CannibalizationCheckRecord;
  relationship_type_recommendation?: RelationshipTypeRecommendationRecord;
}

/**
 * Compiles `opportunityId`'s current strategy finding into the locked
 * StrategyReport shape above. Throws on an unknown opportunity_id, same
 * "fail fast with a clear message" posture compileResearchReport()/
 * compileFinanceReport() already use — but a *known* opportunity with
 * no strategy finding yet is not an error (11a's department may simply
 * not have run any tool yet): every section reads back null, so a
 * caller can compile a report at any point in Strategy's pass. Like its
 * Research/Finance counterparts, this is a pure read — it does not
 * itself write anything back to strategy_findings (mission-overlap/
 * technology-reuse/fit-score/divergence are each filed by their own
 * tool already; this only re-shapes what's currently there).
 */
export function compileStrategyReport(opportunityId: string): StrategyReport {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const current = getCurrentStrategyFinding<RawStrategyFindings>(opportunityId);
  const findings = current?.findings ?? {};
  const report: StrategyReport = {
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
  // Same "enforce the locked shape at the one chokepoint every caller
  // already goes through" posture compileResearchReport()/
  // compileFinanceReport() take — see either's own header for why this
  // can never fail today but guards against a future silent drift.
  const shapeCheck = validateStrategyReportShape(report);
  if (!shapeCheck.valid) {
    throw new Error(
      `compile_strategy_report produced a report that violates its own locked schema: ${shapeCheck.errors.join("; ")}`,
    );
  }
  return report;
}

export const STRATEGY_REPORT_SCHEMA_VERSION = "12d-v1";

/** Every StrategyReport field, in the order compileStrategyReport()
 *  emits them — same "one canonical list, not a test-side guess" role
 *  RESEARCH_REPORT_FIELDS/FINANCE_REPORT_FIELDS already play for their
 *  own reports. 11e-iii-c's own shape test asserts against this array
 *  directly; 12d extends it with three more entries rather than
 *  replacing it. */
export const STRATEGY_REPORT_FIELDS = [
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
] as const satisfies readonly (keyof StrategyReport)[];

const STRATEGY_REPORT_NULLABLE_OBJECT_FIELDS = [
  "missionOverlap",
  "technologyReuse",
  "fitScore",
  "fitRoiDivergence",
  "ecosystemStrengthening",
  "cannibalizationCheck",
  "relationshipTypeRecommendation",
] as const;

/**
 * Runtime conformance check for a compiled strategy report — the same
 * role validateResearchReportShape()/validateFinanceReportShape() play
 * for their own reports, applied to Strategy's. Checks the object has
 * exactly STRATEGY_REPORT_FIELDS' keys (no more, no fewer), every
 * scalar field has its required type, every section is either null or a
 * plain object, and schemaVersion matches STRATEGY_REPORT_SCHEMA_VERSION
 * exactly — so a report compiled under a future 12d-v2 (or the prior
 * 11e-iii-v1) is never silently accepted as if it still matched this
 * version's contract. Pure function — no DB
 * access — so 11e-iii-c's test can exercise it directly against
 * hand-built fixtures, same as its Research/Finance counterparts.
 */
export function validateStrategyReportShape(
  report: unknown,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return { valid: false, errors: ["report is not a plain object"] };
  }
  const obj = report as Record<string, unknown>;

  const actualKeys = new Set(Object.keys(obj));
  const expectedKeys = new Set<string>(STRATEGY_REPORT_FIELDS);
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) errors.push(`missing field: ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) errors.push(`unexpected field: ${key}`);
  }

  if (typeof obj.opportunityId !== "string" || !obj.opportunityId) {
    errors.push("opportunityId must be a non-empty string");
  }
  if (typeof obj.findingId !== "string" && obj.findingId !== null) {
    errors.push("findingId must be a string or null");
  }
  if (typeof obj.findingVersion !== "number" && obj.findingVersion !== null) {
    errors.push("findingVersion must be a number or null");
  }
  if (typeof obj.compiledAt !== "number") {
    errors.push("compiledAt must be a number");
  }
  if (obj.schemaVersion !== STRATEGY_REPORT_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be "${STRATEGY_REPORT_SCHEMA_VERSION}", got ${JSON.stringify(obj.schemaVersion)}`,
    );
  }
  for (const field of STRATEGY_REPORT_NULLABLE_OBJECT_FIELDS) {
    const value = obj[field];
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`${field} must be an object or null`);
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

// ─── Phase 1d: expansion_decisions ─────────────────────────────────────

export type CeoDecision = "approved" | "rejected" | "deferred";

export interface ExpansionDecision<V = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  committee_votes: V;
  ceo_decision: CeoDecision;
  decided_at: number;
  decided_by: string;
}

/** Shape as it actually sits in SQLite: committee_votes is JSON TEXT. */
interface ExpansionDecisionRow {
  id: string;
  opportunity_id: string;
  committee_votes: string;
  ceo_decision: string;
  decided_at: number;
  decided_by: string;
}

function hydrateExpansionDecision<V>(row: ExpansionDecisionRow): ExpansionDecision<V> {
  return {
    id: row.id,
    opportunity_id: row.opportunity_id,
    committee_votes: JSON.parse(row.committee_votes) as V,
    ceo_decision: row.ceo_decision as CeoDecision,
    decided_at: row.decided_at,
    decided_by: row.decided_by,
  };
}

const VALID_DECISIONS: CeoDecision[] = ["approved", "rejected", "deferred"];

/** Public form of VALID_DECISIONS above, plus a type guard — same
 *  "readonly array + type + isValid*() guard" shape VOTE_DEPARTMENTS/
 *  VOTE_VALUES and isValidVoteDepartment()/isValidVoteValue() already
 *  give 14b's own vote fields. Added alongside Phase 15a/15b so
 *  expansionRoutes.ts's decide route can pre-validate `decision` into a
 *  named 400 the same "don't rely on the write function's own throw as
 *  the HTTP contract" way that route's 14c sibling already does for
 *  `vote`, rather than reaching into this file's private
 *  VALID_DECISIONS constant. */
export const CEO_DECISIONS: readonly CeoDecision[] = VALID_DECISIONS;

export function isValidCeoDecision(value: unknown): value is CeoDecision {
  return typeof value === "string" && (VALID_DECISIONS as readonly string[]).includes(value);
}

/** Phase 15c: the two ceo_decision values that close an opportunity's
 *  decision layer for good. `deferred` is deliberately excluded — it's
 *  the one ruling Zent.md 15c calls out as re-queuing "for a later CEO
 *  tick without re-running the departments," i.e. the opportunity stays
 *  open to another decide_expansion call. Exported alongside
 *  CEO_DECISIONS/isValidCeoDecision above so a caller checking "is this
 *  opportunity done" has a named constant to test against instead of
 *  re-deriving `!== "deferred"` at each call site. */
export const CEO_TERMINAL_DECISIONS: readonly CeoDecision[] = ["approved", "rejected"];

export function isTerminalCeoDecision(decision: CeoDecision): boolean {
  return (CEO_TERMINAL_DECISIONS as readonly string[]).includes(decision);
}

/**
 * Records one CEO ruling against `opportunityId`. This is the 1d
 * data-access primitive, not Phase 15's decide_expansion() tool: it does
 * not assemble a committee packet (13a-13d), does not check that the
 * calling agent is the pipeline's owning top-level agent (15b), and does
 * not enforce `approved`/`rejected` finality or `deferred`'s re-queue
 * behavior (15c) — this function will happily write a second row for an
 * opportunity that already has a terminal ruling if a caller asks it to.
 * decideExpansion() (15a/15c) is where that gate actually lives, the
 * same "the data primitive stays dumb, the tool-layer function enforces
 * the rules" split every other write in this file draws — `committee_
 * votes` is opaque JSON here the same way `findings` is opaque JSON to
 * createFinding() (1c).
 *
 * Unlike createFinding(), there is no supersede step: every row recorded
 * here is true history (the CEO really did rule that way on that tick),
 * so nothing is ever marked invalid. "The current decision" is just the
 * most-recent row, which getLatestExpansionDecision() below reads via
 * ORDER BY decided_at DESC rather than a superseded flag.
 *
 * opportunityId must name an existing `opportunities` row; the FK
 * constraint would catch a dangling reference at the SQLite level too,
 * but failing fast here with a clear message matches every other
 * parent-existence check in this file (createOpportunity() against its
 * report, createFinding() against its opportunity).
 */
export function recordExpansionDecision<V = Record<string, unknown>>(
  opportunityId: string,
  ceoDecision: CeoDecision,
  decidedBy: string,
  committeeVotes: V = {} as V,
): ExpansionDecision<V> {
  if (!opportunityId) {
    throw new Error("opportunityId is required");
  }
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  if (!VALID_DECISIONS.includes(ceoDecision)) {
    throw new Error(
      `ceoDecision must be one of ${VALID_DECISIONS.join(", ")}, got "${ceoDecision}"`,
    );
  }
  if (!decidedBy) {
    throw new Error("decidedBy is required");
  }
  const row: ExpansionDecisionRow = {
    id: `xdec_${ulid()}`,
    opportunity_id: opportunityId,
    committee_votes: JSON.stringify(committeeVotes ?? {}),
    ceo_decision: ceoDecision,
    decided_at: Date.now(),
    decided_by: decidedBy,
  };
  db.prepare(
    `INSERT INTO expansion_decisions (id, opportunity_id, committee_votes, ceo_decision, decided_at, decided_by)
     VALUES (@id, @opportunity_id, @committee_votes, @ceo_decision, @decided_at, @decided_by)`,
  ).run(row);
  return hydrateExpansionDecision<V>(row);
}

export function getExpansionDecision<V = Record<string, unknown>>(
  id: string,
): ExpansionDecision<V> | undefined {
  const row = db.prepare(`SELECT * FROM expansion_decisions WHERE id = ?`).get(id) as
    | ExpansionDecisionRow
    | undefined;
  return row ? hydrateExpansionDecision<V>(row) : undefined;
}

/** Full ruling history for an opportunity, most-recent-first — every `deferred` tick included. */
export function listExpansionDecisions<V = Record<string, unknown>>(
  opportunityId: string,
): ExpansionDecision<V>[] {
  const rows = db
    .prepare(`SELECT * FROM expansion_decisions WHERE opportunity_id = ? ORDER BY decided_at DESC`)
    .all(opportunityId) as ExpansionDecisionRow[];
  return rows.map((row) => hydrateExpansionDecision<V>(row));
}

/**
 * The most recent ruling for an opportunity, or undefined if the CEO
 * hasn't ruled on it yet. This is what "the current decision" means for
 * this table (see this section's own header comment on why there's no
 * superseded flag) — a `deferred` result here is a real, current answer
 * ("still pending, re-queued"), not a placeholder to look past.
 */
export function getLatestExpansionDecision<V = Record<string, unknown>>(
  opportunityId: string,
): ExpansionDecision<V> | undefined {
  const row = db
    .prepare(
      `SELECT * FROM expansion_decisions WHERE opportunity_id = ? ORDER BY decided_at DESC LIMIT 1`,
    )
    .get(opportunityId) as ExpansionDecisionRow | undefined;
  return row ? hydrateExpansionDecision<V>(row) : undefined;
}

// ─── Phase 2e: profitability gate ──────────────────────────────────────
//
// Zent.md: "a helper (isEligibleForExpansion(agentAddress)) checked
// before an opportunity_intelligence department can even be spawned —
// reads the same balance/spend history wallet.ts already tracks.
// No profit, no department."
//
// "Profitable" is defined here as: total settled USDC received by this
// agent (payments.to_address = agentAddress AND status = 'settled')
// EXCEEDS total USDC spent on inference and marketplace operations
// (usage_log.agent_address = agentAddress, summed over all time).
//
// Two deliberate design decisions:
//
//  1. "All-time" totals, not a rolling window. A rolling window would
//     exclude early revenue the agent earned to build its current
//     balance, making the check harder to pass for well-established
//     agents that happen to have a slow recent month. The goal is to
//     ensure the root agent has a demonstrated ability to generate
//     surplus, not just that it had a good last 30 days.
//
//  2. payments.status = 'settled' only, not 'pending'. A pending
//     payment is an authorization that hasn't cleared on-chain. Counting
//     it as revenue would let an agent that staged a large pending
//     self-transfer unlock the pipeline before any real money arrived —
//     exactly the kind of financial juke this gate exists to prevent.
//
// This is intentionally a soft data-layer check, not a hard on-chain
// query: the same "read what this backend already has" discipline
// resourceQuotas.ts uses for spend-rate (quoting inferenceGateway.ts's
// rolling-24h query rather than hitting the chain on every check). An
// on-chain balance query is the right enrichment for Phase 8d's
// check_available_capital tool, not here.
//
// Exported so departments.ts's create_department route can import it
// directly without depending on wallet.ts's HTTP layer, and so the
// test file can inline-mirror it without an actual DB connection
// (same pattern every other expansion phase test uses).

export interface EligibilityResult {
  eligible: boolean;
  /** Total USDC received via settled payments, all-time. */
  revenueUsdc: number;
  /** Total USDC spent on inference + marketplace, all-time. */
  spendUsdc: number;
  /** revenueUsdc - spendUsdc; positive means profitable. */
  surplusUsdc: number;
}

/**
 * Returns true iff agentAddress has ever generated a surplus — i.e.
 * its lifetime settled revenue exceeds its lifetime logged spend.
 * Returns the component figures alongside the boolean so callers can
 * surface a meaningful error message (or log a useful audit trail)
 * rather than just a rejected boolean.
 *
 * Throws if agentAddress is empty, matching the same input-guard style
 * every other expansion.ts function uses.
 */
export function isEligibleForExpansion(agentAddress: string): EligibilityResult {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }

  // Revenue: sum of all payments this agent has received that have
  // settled on-chain. value_usdc is stored as TEXT (see db.ts's
  // payments table definition) — CAST to REAL here, same as
  // resourceQuotas.ts's own getSpendRateUsdc() does for cost_usdc.
  const revenueRow = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(value_usdc AS REAL)), 0) AS total
       FROM payments
       WHERE to_address = ? AND status = 'settled'`,
    )
    .get(agentAddress) as { total: number };

  // Spend: sum of all usage_log rows for this agent, all services,
  // all time. cost_usdc is also TEXT — same CAST pattern.
  const spendRow = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) AS total
       FROM usage_log
       WHERE agent_address = ?`,
    )
    .get(agentAddress) as { total: number };

  const revenueUsdc = revenueRow.total;
  const spendUsdc = spendRow.total;
  const surplusUsdc = revenueUsdc - spendUsdc;

  return {
    eligible: surplusUsdc > 0,
    revenueUsdc,
    spendUsdc,
    surplusUsdc,
  };
}

// ─── Phase 3d: top-N selection ─────────────────────────────────────────
//
// Zent.md: "Top-N selection: a scheduled job (scheduler.ts) that, on a
// cadence, marks the top-scoring open opportunity as status = 'scored'
// ... and hands it to Research — nothing below N (default top 4)
// proceeds."
//
// "The top-scoring open opportunity" (singular) is read literally: each
// tick promotes at MOST ONE opportunity per eligible agent, not a
// fill-to-N batch. "Nothing below N ... proceeds" is read as the
// standing CAPACITY this throttles toward — an agent with fewer than
// `topN` opportunities currently 'selected' has room for one more; an
// agent already at `topN` gets skipped entirely until something frees a
// slot (Phase 5's eventual Research pickup, or Phase 4c's agent-only
// demote/reject, now built — see that section below). One-at-a-time
// metering rather than an immediate burst to `topN` on the very first
// tick a backlog exists
// matches this codebase's own posture toward Research as a real,
// presumably rate-limited downstream consumer, not an infinite sink —
// the same "meter the department's own pace, don't let a backlog turn
// into a burst" reasoning 2d's opportunity_intelligence tick cap already
// applies to signal scanning. (Phase 4c's own promote/demote/reject —
// agent-only, see that section's header — respects this same cap on
// promote rather than opening a side door around it.)
//
// Scope note carried over from findNearDuplicateOpportunity() above:
// eligibility requires roi_score IS NOT NULL (an opportunity created
// without going through score_opportunity has nothing to rank by) and
// the owning report not being 'archived' — a defensive join condition
// with no live effect at the time this function was written (nothing
// in this codebase archived a report yet), but Phase 3e's own "kill
// condition" (see that section below) is exactly what starts archiving
// reports, and does so by construction before this function's own
// scheduled call runs each tick — see the combined
// runOnScheduleWithLease registration at the bottom of this file for
// why that ordering, not just this join condition, is what actually
// keeps a floor-failing report from ever being selected out of.

export interface TopNSelection {
  agentAddress: string;
  opportunityId: string;
  title: string;
  roiScore: number;
}

/**
 * One pass of Phase 3d's selection logic: for every agent with at
 * least one 'open', scored, non-archived-report opportunity AND spare
 * capacity (fewer than `topN` currently 'selected'), promotes that
 * agent's single highest-roi_score 'open' opportunity to 'selected'
 * (ties broken by earliest created_at, then id, for full determinism —
 * "highest roi_score" alone doesn't uniquely order two opportunities
 * scored identically). Returns one TopNSelection per agent actually
 * promoted this pass; an agent with no eligible opportunity, or already
 * at capacity, contributes nothing and is not an error.
 *
 * Synchronous and DB-only — no network call, no model inference — so
 * this is safe to call directly from a test or a route, not just from
 * the scheduled job below, which is exactly why the job's own fn is a
 * two-line async wrapper around this rather than this function itself
 * being async.
 */
export function selectTopOpenOpportunities(
  topN: number = config.expansionTopNOpenOpportunities,
): TopNSelection[] {
  const now = Date.now();

  const agentRows = db
    .prepare(
      `SELECT DISTINCT r.agent_address AS agent_address
       FROM opportunities o
       JOIN opportunity_reports r ON r.id = o.report_id
       WHERE o.status = 'open' AND o.roi_score IS NOT NULL AND r.status != 'archived'`,
    )
    .all() as { agent_address: string }[];

  const selections: TopNSelection[] = [];

  for (const { agent_address } of agentRows) {
    const { n: selectedCount } = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM opportunities o
         JOIN opportunity_reports r ON r.id = o.report_id
         WHERE r.agent_address = ? AND o.status = 'selected'`,
      )
      .get(agent_address) as { n: number };
    if (selectedCount >= topN) continue; // at capacity — skip this agent this tick

    const top = db
      .prepare(
        `SELECT o.* FROM opportunities o
         JOIN opportunity_reports r ON r.id = o.report_id
         WHERE r.agent_address = ? AND o.status = 'open' AND o.roi_score IS NOT NULL
           AND r.status != 'archived'
         ORDER BY o.roi_score DESC, o.created_at ASC, o.id ASC
         LIMIT 1`,
      )
      .get(agent_address) as OpportunityRow | undefined;
    if (!top) continue; // shouldn't happen given the agentRows query above, but no eligible row is never an error

    db.prepare(`UPDATE opportunities SET status = 'selected', selected_at = ? WHERE id = ?`).run(
      now,
      top.id,
    );
    selections.push({
      agentAddress: agent_address,
      opportunityId: top.id,
      title: top.title,
      roiScore: top.roi_score as number,
    });
  }

  return selections;
}

// ─── Phase 3e: kill condition ───────────────────────────────────────────
//
// Zent.md: "Kill condition: if no opportunity clears a minimum ROI
// floor, the department produces a report saying so and the pipeline
// stops for this cycle — 'no good ideas this month' is a valid,
// expected output."
//
// Deliberately NOT folded into 3d's selectTopOpenOpportunities() above:
// that function has no floor of its own today — it promotes whatever
// the single highest roi_score OPEN opportunity happens to be, however
// low (see expansionTopNSelection.test.ts's own "selects the single
// highest-scoring open opportunity" case, which is satisfied by a score
// of 40 exactly the same way a 90 would be — that test predates this
// phase and this phase does not get to go change its meaning). Baking a
// floor into that function would either silently change 3d's own
// already-shipped behavior or require a second, differently-shaped
// selection path for the same query. 3e is instead its own gate, run
// immediately before 3d's own sweep in the same scheduled tick (see the
// combined runOnScheduleWithLease registration below) — a report that
// can't clear the floor gets archived, which drops it out of 3d's own
// `r.status != 'archived'` join condition, so 3d never gets a chance to
// promote something out of it in the first place. A report 3e caught
// first is 3e doing its job, not 3d silently skipping work.
//
// "No opportunity clears the floor" is evaluated per REPORT — a report
// is one Opportunity-Intelligence pass, and Zent.md's own "the
// department produces a report saying so" is literally this report,
// not a new one — across every opportunity ever scored out of it,
// regardless of that opportunity's own Phase 3d status. An opportunity
// already promoted to 'selected' in an earlier tick still counts: that
// report already produced a good idea, and must never be retroactively
// killed just because something else added to the same still-draft
// report afterward happened to score badly. A report with ZERO scored
// opportunities yet (still mid-scan; score_opportunity hasn't written
// anything to judge) is left alone too — "no good ideas" is a verdict
// on what got scored, not an excuse to close a report out before
// Opportunity Intelligence had a chance to score anything at all.
//
// Only 'draft' reports are ever eligible. A report already 'scored' or
// 'archived' is done, one way or the other; excluding it up front (both
// in sweepKillCondition()'s own query and as an explicit early-return
// in evaluateKillCondition()) keeps this from leaning on
// appendSourceSummary()'s/setOpportunityReportStatus()'s own error
// handling (throw on non-draft) to stay correct — a caller sweeping a
// batch of report ids should never have to pre-filter by status itself.

export interface KillConditionResult {
  reportId: string;
  agentAddress: string;
  /** True iff this call just archived the report. False covers every
   *  other outcome (nothing scored yet, already has a floor-clearing
   *  opportunity, or the report wasn't 'draft' to begin with) — all
   *  expected, none of them an error. */
  archived: boolean;
  /** How many opportunities under this report have a roi_score at all,
   *  in any Phase 3d status. */
  scoredCount: number;
  /** Highest roi_score among this report's scored opportunities, or
   *  null when scoredCount is 0. */
  bestRoiScore: number | null;
}

/**
 * Evaluates Zent.md 3e's kill condition for a single report: if it is
 * still 'draft', has at least one scored opportunity, and NONE of them
 * reach `roiFloor`, appends a "no good ideas this cycle" note to
 * source_summary and archives the report (draft -> archived directly,
 * the same one-way jump setOpportunityReportStatus()'s own TERMINAL map
 * already allows). Returns a result either way; `archived: false` is a
 * normal, expected outcome, not a failure.
 *
 * Order matters: the note is appended (via appendSourceSummary(), which
 * requires 'draft') BEFORE the status flips to 'archived', since
 * appendSourceSummary() refuses to write to a report that's already
 * left draft — the same one-way-lifecycle discipline every other
 * writer in this file respects.
 */
export function evaluateKillCondition(
  reportId: string,
  roiFloor: number = config.expansionMinRoiFloor,
): KillConditionResult {
  const report = getOpportunityReport(reportId);
  if (!report) {
    throw new Error(`opportunity_report ${reportId} not found`);
  }

  const scoredRows = db
    .prepare(`SELECT roi_score FROM opportunities WHERE report_id = ? AND roi_score IS NOT NULL`)
    .all(reportId) as { roi_score: number }[];
  const scoredCount = scoredRows.length;
  const bestRoiScore = scoredCount > 0 ? Math.max(...scoredRows.map((r) => r.roi_score)) : null;

  const clearsFloor = bestRoiScore !== null && bestRoiScore >= roiFloor;
  if (report.status !== "draft" || scoredCount === 0 || clearsFloor) {
    return { reportId, agentAddress: report.agent_address, archived: false, scoredCount, bestRoiScore };
  }

  const opportunityWord = scoredCount === 1 ? "opportunity" : "opportunities";
  const note =
    `[${new Date().toISOString()}] kill_condition: ${scoredCount} ${opportunityWord} scored, ` +
    `best roi_score ${bestRoiScore} did not clear the floor of ${roiFloor} — no good ideas this cycle.`;
  appendSourceSummary(reportId, note);
  setOpportunityReportStatus(reportId, "archived");

  return { reportId, agentAddress: report.agent_address, archived: true, scoredCount, bestRoiScore };
}

/**
 * One sweep pass: evaluateKillCondition() against every 'draft' report
 * that has at least one scored opportunity. This is the batch entry
 * point the scheduled job below actually calls; evaluateKillCondition()
 * itself stays single-report so a route, a test, or a future human
 * override path can invoke it against one report id without pulling in
 * a full sweep. Returns only the reports this call actually archived —
 * same "no eligible rows is never an error, just an empty result"
 * convention selectTopOpenOpportunities() above already establishes.
 */
export function sweepKillCondition(
  roiFloor: number = config.expansionMinRoiFloor,
): KillConditionResult[] {
  const draftReportIds = db
    .prepare(
      `SELECT DISTINCT r.id AS id
       FROM opportunity_reports r
       JOIN opportunities o ON o.report_id = r.id
       WHERE r.status = 'draft' AND o.roi_score IS NOT NULL`,
    )
    .all() as { id: string }[];

  return draftReportIds
    .map(({ id }) => evaluateKillCondition(id, roiFloor))
    .filter((result) => result.archived);
}

// Registered here (module-load side effect), not in scheduler.ts itself
// — scheduler.ts is the generic lease-based primitive (built for
// next-phase.md Phase 5d, reused as-is here since Zent.md 3d names it
// by file), not a place for any one job's business logic. Same split
// departments.ts's own ttl_reaper registration and healthCheck.ts's own
// health_check registration already establish: the sweep function and
// its runOnScheduleWithLease() call live beside the domain logic they
// operate on. This module is loaded at boot because expansionRoutes.ts
// imports from it and index.ts imports expansionRoutes.ts — no separate
// wiring needed for this registration to actually run.
//
// 2-minute cadence: fast enough that a newly-scored, clearly-top
// opportunity doesn't sit in 'open' for long, slow enough that this
// stays a background metering process rather than something a caller
// could mistake for synchronous (a score_opportunity call's own
// response never reflects a selection that hasn't ticked yet — 4a/4b's
// read endpoints, once built, are how a caller actually observes
// selection state). leaseMs generously above intervalMs for the same
// "a merely-slow run must never be mistaken for a crashed one" reason
// every other registration in this codebase already gives.
//
// Phase 3e's sweepKillCondition() runs first, in the same tick, ahead
// of selectTopOpenOpportunities() — not as its own separate
// registration — specifically so a report that can't clear the ROI
// floor is archived before 3d's own query (which already excludes
// archived reports) ever runs against it this tick. A separate
// registration on the same 2-minute interval would leave the two jobs'
// relative order up to the scheduler, reopening exactly the race this
// ordering exists to close.
runOnScheduleWithLease({
  name: "expansion_top_n_selection",
  intervalMs: 2 * 60_000,
  leaseMs: 5 * 60_000,
  fn: async () => {
    sweepKillCondition();
    selectTopOpenOpportunities();
  },
});

// ─── Phase 4a: ranked opportunity list for an agent ────────────────────
//
// Zent.md: "GET /expansion/opportunities/:agentAddress — ranked list,
// same shape as the 'Top Opportunities' list in chat (title, ROI,
// one-line thesis)."
//
// Unlike listOpportunitiesForReport() (Phase 1b), which is scoped to
// one already-known report id, this is scoped to an AGENT — Company A
// can have many opportunity_reports over its lifetime (one per
// Opportunity-Intelligence pass, Phase 1a), and "the ranked list" a
// human operator or the CEO gate wants to see is across all of them,
// not any one pass in isolation. This is the same report-to-agent
// widening selectTopOpenOpportunities() (Phase 3d) already does for its
// own per-agent capacity query, reused here for a read instead of a
// write.
//
// Excludes opportunities under an 'archived' report by default — an
// archived report is either superseded or (Phase 3e) a "no good ideas
// this cycle" kill, and a ranked list a human is about to act on
// shouldn't surface a dead cycle's leftovers mixed in with live
// candidates. There's no flag to include them here: Phase 4b's
// eventual full-detail-by-id endpoint is where an already-known
// opportunity id (archived report or not) gets looked up directly;
// this list is specifically "what's currently live," not an audit
// trail (Phase 15e's getExpansionAuditBundle() / GET .../decision-bundle
// is the audit trail — see that section, near the bottom of this file,
// for the full bundle).
//
// Also excludes unscored opportunities (roi_score IS NULL) — nothing
// in this codebase creates one today (score_opportunity always computes
// roi_score in the same call, Phase 3b), but a null score has nothing
// to rank by, so it's filtered rather than sorted-last, matching
// selectTopOpenOpportunities()'s own "roi_score IS NOT NULL" join
// condition.
//
// Ordering ties the same deterministic way selectTopOpenOpportunities()
// already breaks them (roi_score DESC, then created_at ASC, then id
// ASC) — the same "two opportunities scored identically still need a
// stable order" reasoning that function's own header gives, reused
// here so a caller polling this endpoint sees a stable list rather than
// query-plan-dependent reshuffling between calls.

export interface RankedOpportunity {
  id: string;
  reportId: string;
  title: string;
  thesis: string;
  roiScore: number;
  status: OpportunityStatus;
  tags: string[];
  createdAt: number;
}

/**
 * The ranked list Zent.md 4a describes: every scored opportunity
 * belonging to `agentAddress`'s non-archived reports, highest roi_score
 * first. `options.status`, if given, narrows to one Phase 3d status
 * (open/selected/rejected) — e.g. a caller that only wants what's still
 * actionable can pass `status: 'open'`. `options.limit` (default 50)
 * caps how many rows come back; always a positive integer, since an
 * unbounded ranked list over an agent's entire lifetime is exactly the
 * kind of thing Zent.md 19a-c's guardrails phase would flag as an
 * unbounded read.
 *
 * Throws if agentAddress is empty or limit isn't a positive integer,
 * matching every other expansion.ts input-guard's style. An
 * agentAddress with no reports at all — or none that are non-archived
 * and scored — is not an error: it returns an empty array, the same
 * "no eligible rows is a valid, expected result" convention
 * selectTopOpenOpportunities()/sweepKillCondition() above already
 * establish.
 */
export function listRankedOpportunitiesForAgent(
  agentAddress: string,
  options: { status?: OpportunityStatus; limit?: number } = {},
): RankedOpportunity[] {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

  const params: (string | number)[] = [agentAddress];
  let statusClause = "";
  if (options.status) {
    statusClause = "AND o.status = ?";
    params.push(options.status);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT o.* FROM opportunities o
       JOIN opportunity_reports r ON r.id = o.report_id
       WHERE r.agent_address = ? AND r.status != 'archived' AND o.roi_score IS NOT NULL
         ${statusClause}
       ORDER BY o.roi_score DESC, o.created_at ASC, o.id ASC
       LIMIT ?`,
    )
    .all(...params) as OpportunityRow[];

  return rows.map((row) => {
    const hydrated = hydrateOpportunity(row);
    return {
      id: hydrated.id,
      reportId: hydrated.report_id,
      title: hydrated.title,
      thesis: hydrated.thesis,
      roiScore: hydrated.roi_score as number,
      status: hydrated.status,
      tags: hydrated.tags,
      createdAt: hydrated.created_at,
    };
  });
}

// ─── Phase 4b: full opportunity detail (source summary, factors, de-dup) ─
//
// Zent.md: "GET /expansion/opportunities/:id — full detail: source
// summary, scoring factors, de-dup history."
//
// Three things Phase 4a's ranked-list row deliberately leaves out (it's
// a scan shape — title/ROI/thesis, Zent.md 4a — not a drill-down one):
//   - the owning report's source_summary (Phase 2's raw signal log the
//     opportunity was scored out of),
//   - factors/roi_formula_version are already on Opportunity itself
//     (hydrateOpportunity() re-nests them, Phase 3a/3b) — 4a's own
//     RankedOpportunity type just doesn't surface them, so this phase's
//     job there is exposure, not computation,
//   - "de-dup history": there is no persisted dedup-check log table in
//     this schema (see db.ts — findNearDuplicateOpportunity(), Phase
//     3c, is a pure read computed fresh from opportunities' title/thesis
//     text, not a table of past checks). A rejected candidate is never
//     written at all (the 409 in expansionRoutes.ts's score-opportunity
//     route returns before createOpportunity() runs), so there is
//     nothing to look up "the time this opportunity was scored." What
//     IS answerable, and what a human or the CEO gate actually wants
//     when reviewing one opportunity's full detail, is the live
//     question 3c's own gate asks: which of this agent's OTHER scored
//     opportunities, in the current dedup window, does this one's
//     title+thesis text still resemble right now. findDedupMatchesForOpportunity()
//     below answers exactly that, reusing findNearDuplicateOpportunity()'s
//     own scoreCorpus()/dedupText() plumbing rather than a second
//     similarity metric — the same "de-dup" computation 3c already
//     established, just run for every opportunity above the threshold
//     instead of stopping at the single best match a create-time gate
//     needs.

export interface DedupHistoryEntry {
  opportunityId: string;
  title: string;
  status: OpportunityStatus;
  roiScore: number | null;
  similarity: number;
}

/**
 * Every other scored opportunity belonging to the same agent, within
 * the current dedup window (`options.windowDays`, default
 * config.opportunityDedupWindowDays — same default 3c's create-time
 * gate uses), whose title+thesis text similarity to `opportunityId`
 * clears `options.threshold` (default config.opportunityDedupSimilarityThreshold).
 * Sorted highest-similarity first, ties broken by created_at ASC then
 * id ASC — same deterministic tie-break every other ranked read in this
 * file already uses (4a's listRankedOpportunitiesForAgent(), 3d's
 * selectTopOpenOpportunities()).
 *
 * Unlike findNearDuplicateOpportunity() (3c), this is not a creation-
 * time gate: it never throws for "nothing matches" (an opportunity with
 * a genuinely unique thesis has an empty history — that's the normal,
 * expected case, not an error) and it does not filter out opportunities
 * under an archived report — the dedup window has always looked across
 * an agent's full scored history regardless of report lifecycle (see
 * findNearDuplicateOpportunity()'s own query, which carries no
 * `r.status` clause either), and a detail view that's specifically
 * about "what does this resemble" would be misleading if a killed
 * cycle's near-duplicate silently disappeared from the answer.
 *
 * Throws only if opportunityId doesn't resolve to an existing
 * opportunity — same "the id you gave me isn't real" guard
 * getOpportunityDetail() below relies on, kept here too so this
 * function is safe to call on its own (e.g. from a future Phase 4c
 * override tool) without going through the combined detail read.
 */
export function findDedupMatchesForOpportunity(
  opportunityId: string,
  options: { windowDays?: number; threshold?: number } = {},
): DedupHistoryEntry[] {
  const target = getOpportunity(opportunityId);
  if (!target) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const report = getOpportunityReport(target.report_id);
  if (!report) {
    throw new Error(`opportunity_report ${target.report_id} not found`);
  }

  const windowDays = options.windowDays ?? config.opportunityDedupWindowDays;
  const threshold = options.threshold ?? config.opportunityDedupSimilarityThreshold;
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const rows = db
    .prepare(
      `SELECT o.* FROM opportunities o
       JOIN opportunity_reports r ON r.id = o.report_id
       WHERE r.agent_address = ?
         AND o.id != ?
         AND o.roi_score IS NOT NULL
         AND o.created_at >= ?`,
    )
    .all(report.agent_address, opportunityId, cutoff) as OpportunityRow[];
  if (rows.length === 0) return [];

  const candidates = rows.map(hydrateOpportunity);
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

export interface OpportunityDetail {
  opportunity: Opportunity;
  agentAddress: string;
  reportStatus: OpportunityReportStatus;
  sourceSummary: string;
  dedupHistory: DedupHistoryEntry[];
}

/**
 * The full-detail read Zent.md 4b describes, assembled from three reads
 * this file already has: getOpportunity() (id, title/thesis, roi_score
 * + roi_formula_version, the Phase 3a factors, status/selected_at) for
 * the opportunity itself, getOpportunityReport() for the owning
 * report's source_summary (Phase 2's raw signal log) and its own
 * lifecycle status (a caller reading "detail" for an opportunity under
 * an archived report — Phase 3e's kill condition, most likely — should
 * be able to tell that from this response rather than needing a second
 * call), and findDedupMatchesForOpportunity() above for the de-dup
 * question 3c's create-time gate can't answer retroactively.
 *
 * Returns undefined for an unknown id (matching getOpportunity()'s own
 * "not found is not an error" convention) rather than throwing, so the
 * route below can turn that into a plain 404 without a try/catch doing
 * double duty for both "bad id" and "actually broken."
 */
export function getOpportunityDetail(id: string): OpportunityDetail | undefined {
  const opportunity = getOpportunity(id);
  if (!opportunity) return undefined;
  const report = getOpportunityReport(opportunity.report_id);
  if (!report) {
    // Should be unreachable — report_id is FK-constrained on insert
    // (createOpportunity()'s own guard) — but surfaced as a thrown
    // error rather than silently hydrating a blank source_summary,
    // matching findDedupMatchesForOpportunity()'s identical guard just
    // above: a dangling report_id is a data-integrity bug, not a normal
    // "not found."
    throw new Error(`opportunity_report ${opportunity.report_id} not found`);
  }
  return {
    opportunity,
    agentAddress: report.agent_address,
    reportStatus: report.status,
    sourceSummary: report.source_summary,
    dedupHistory: findDedupMatchesForOpportunity(id),
  };
}

// ─── Phase 4c: promote / demote / reject ────────────────────────────────
//
// Zent.md: "Promote/demote/reject remains an agent-only action:
// Opportunity Intelligence (or the top-level agent acting on its own
// report) can re-rank or drop an opportunity before Research picks it
// up — no external operator step in this path."
//
// "Agent-only" is read the same way this file already reads every other
// ownership boundary in this pipeline (resolveTargetReport()'s own
// agentAddress-must-match check in expansionRoutes.ts, isEligibleForExpansion()'s
// wallet-owner scoping): the caller is either the top-level agent acting
// on its own report, or a department running through that owner's
// runtime (see subagents.ts's "parent's runtime is the scheduler" note,
// cited in expansionRoutes.ts's own file header) — never a distinct
// human-operator identity with a standing veto. There is no separate
// "operator approves this override" step anywhere below; a caller that
// can authenticate as the owning agent gets to act immediately, exactly
// like every other write in this pipeline (3a's score_opportunity,
// 15a's decide_expansion).
//
// Three actions, three target statuses — this is intentionally the
// same three-value OpportunityStatus union already defined above, not a
// fourth "manually overridden" status: promote is open -> selected
// (the same terminal state 3d's own scheduled sweep writes, so a
// manually-promoted opportunity is indistinguishable downstream from
// one 3d picked itself), demote undoes that back to open, and reject is
// the one-way move to 'rejected' that 3d's own sweep has never had a
// reason to write. OPPORTUNITY_TRANSITIONS below is this union's
// version of setOpportunityReportStatus()'s own TERMINAL map — same
// "calling with the status you're already at is a no-op, calling with
// an invalid move is a hard error" shape, not a coincidence.
//
// Promote is the one action with a side condition: it re-checks 3d's
// own topN capacity (config.expansionTopNOpenOpportunities) against the
// agent's current 'selected' count before writing, so a department
// reaching for this endpoint to jump a specific opportunity to the
// front of the queue can't also use it to blow past the same standing
// cap 3d's scheduled sweep respects — "re-rank... before Research
// picks it up" is about which opportunity is selected, not about how
// many can be selected at once. Promoting out of an archived report is
// also rejected outright: 3e's kill condition already established that
// an archived report's open opportunities failed the ROI floor as a
// set (see that section's own comment), and this endpoint overriding a
// single ranking is not licence to override that verdict too. Demote
// and reject carry no such report-status check — pulling a commitment
// back or dropping it is always safe regardless of what the owning
// report's lifecycle looks like now.

export type OpportunityAction = "promote" | "demote" | "reject";

const ACTION_TARGET_STATUS: Record<OpportunityAction, OpportunityStatus> = {
  promote: "selected",
  demote: "open",
  reject: "rejected",
};

const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  open: ["selected", "rejected"],
  selected: ["open", "rejected"],
  rejected: [],
};

/**
 * Applies one of Zent.md 4c's three actions to an existing opportunity.
 * Idempotent when the opportunity is already at the action's target
 * status (mirrors setOpportunityReportStatus()'s own same-status
 * no-op); throws for a genuinely invalid move (rejected is terminal —
 * nothing promotes or demotes out of it) or for promote's own capacity/
 * archived-report guards. Ownership (does this caller's agentAddress
 * actually own this opportunity's report) is deliberately NOT checked
 * here — same split expansion.ts draws everywhere else (createOpportunity(),
 * setOpportunityRoiScore()) between "pure data-layer mutation" and the
 * HTTP-layer's own auth — expansionRoutes.ts's route below does that
 * check before ever calling this.
 */
export function setOpportunityStatus(
  id: string,
  action: OpportunityAction,
  options: { topN?: number } = {},
): Opportunity {
  const existing = getOpportunity(id);
  if (!existing) {
    throw new Error(`opportunity ${id} not found`);
  }

  const target = ACTION_TARGET_STATUS[action];
  if (existing.status === target) {
    return existing;
  }
  if (!OPPORTUNITY_TRANSITIONS[existing.status].includes(target)) {
    throw new Error(`cannot ${action} opportunity ${id} from status '${existing.status}'`);
  }

  if (action === "promote") {
    const report = getOpportunityReport(existing.report_id);
    if (!report) {
      throw new Error(`opportunity_report ${existing.report_id} not found`);
    }
    if (report.status === "archived") {
      throw new Error(
        `opportunity_report ${existing.report_id} is archived — cannot promote an opportunity out of an archived report`,
      );
    }
    const topN = options.topN ?? config.expansionTopNOpenOpportunities;
    const { n: selectedCount } = db
      .prepare(
        `SELECT COUNT(*) AS n FROM opportunities o
         JOIN opportunity_reports r ON r.id = o.report_id
         WHERE r.agent_address = ? AND o.status = 'selected'`,
      )
      .get(report.agent_address) as { n: number };
    if (selectedCount >= topN) {
      throw new Error(
        `agent ${report.agent_address} already has ${selectedCount} selected opportunities (cap ${topN}) — demote or reject one first`,
      );
    }
  }

  const selectedAt = target === "selected" ? Date.now() : null;
  db.prepare(`UPDATE opportunities SET status = ?, selected_at = ? WHERE id = ?`).run(
    target,
    selectedAt,
    id,
  );
  if (action === "promote") {
    const report = getOpportunityReport(existing.report_id);
    if (report) {
      emitEvent({
        agentAddress: report.agent_address,
        role: "CEO",
        subRole: "Opportunity Pipeline",
        eventType: "deal_proposed",
        message: `Selected opportunity for pursuit: "${existing.title}"`,
        metadata: { opportunityId: id },
      });
    }
  }
  return { ...existing, status: target, selected_at: selectedAt };
}

// ─── Phase 4d: notification hook ────────────────────────────────────────
//
// Zent.md: "Notification hook (reuses whatever channel office.ts/admin
// status already uses) firing when a new opportunity clears the ROI
// floor."
//
// This is the synchronous, DB-only half of the hook: deciding whether
// an opportunity clears config.expansionMinRoiFloor (the same floor
// 3e's kill condition already reads) and recording that fact exactly
// once, idempotently, via db.ts's UNIQUE index on
// expansion_notifications.opportunity_id. The actual delivery — writing
// into the owning agent's own office/fs/inbox/, the literal channel
// office.ts already exposes for landing a message an agent's own
// runtime will read on its next tick — is deliberately NOT here: that's
// filesystem I/O (fs/promises), and every other place this codebase
// mixes an outbound side effect with a synchronous DB write keeps them
// in different files (2b/2c's DuckDuckGo fetch lives in
// expansionRoutes.ts, not here). expansionRoutes.ts's own Phase 4d
// section calls recordExpansionNotification() first, then attempts
// delivery, then calls markExpansionNotificationDelivered() only once
// that succeeds — same split.
//
// "Agent-only, no external operator step" here means exactly what it
// means in Phase 4c: the recipient of this notification is the
// top-level agent's own inbox, not a human-facing page or alert queue.
// admin.ts's GET /admin/status is a human-readable operational
// snapshot that already exists in this codebase, but nothing here
// writes to it or gates on a human reading it — a caller (this
// pipeline, acting through the owning agent) can query
// listExpansionNotificationsForAgent() below the same way it can query
// admin.ts's own read-only endpoints, but no approval flows through
// either.

export interface ExpansionNotification {
  id: string;
  opportunityId: string;
  agentAddress: string;
  roiScore: number;
  createdAt: number;
  delivered: boolean;
}

interface ExpansionNotificationRow {
  id: string;
  opportunity_id: string;
  agent_address: string;
  roi_score: number;
  created_at: number;
  delivered: number;
}

function hydrateExpansionNotification(row: ExpansionNotificationRow): ExpansionNotification {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    agentAddress: row.agent_address,
    roiScore: row.roi_score,
    createdAt: row.created_at,
    delivered: row.delivered === 1,
  };
}

/**
 * Checks `opportunity` against config.expansionMinRoiFloor (or
 * `options.roiFloor`, for tests) and, if it clears the floor, records
 * one expansion_notifications row for it — idempotently: a second call
 * for the same opportunity id returns the row already on file rather
 * than inserting (or erroring) again, so a caller never needs to
 * pre-check "has this already fired" itself. Returns undefined for an
 * opportunity with no roi_score yet, or one that doesn't clear the
 * floor — "nothing to notify" is the normal, expected outcome for most
 * opportunities scored, not an error.
 *
 * Pure DB write, no filesystem/network I/O — see this section's own
 * header for why delivery is a separate, caller-driven step.
 */
export function recordExpansionNotification(
  opportunity: Opportunity,
  options: { roiFloor?: number } = {},
): ExpansionNotification | undefined {
  if (opportunity.roi_score === null) return undefined;
  const roiFloor = options.roiFloor ?? config.expansionMinRoiFloor;
  if (opportunity.roi_score < roiFloor) return undefined;

  const report = getOpportunityReport(opportunity.report_id);
  if (!report) {
    throw new Error(`opportunity_report ${opportunity.report_id} not found`);
  }

  const existing = db
    .prepare(`SELECT * FROM expansion_notifications WHERE opportunity_id = ?`)
    .get(opportunity.id) as ExpansionNotificationRow | undefined;
  if (existing) return hydrateExpansionNotification(existing);

  const row: ExpansionNotificationRow = {
    id: `oppn_${ulid()}`,
    opportunity_id: opportunity.id,
    agent_address: report.agent_address,
    roi_score: opportunity.roi_score,
    created_at: Date.now(),
    delivered: 0,
  };
  db.prepare(
    `INSERT INTO expansion_notifications
       (id, opportunity_id, agent_address, roi_score, created_at, delivered)
     VALUES (@id, @opportunity_id, @agent_address, @roi_score, @created_at, @delivered)
     ON CONFLICT(opportunity_id) DO NOTHING`,
  ).run(row);

  // The ON CONFLICT above means a race with a concurrent caller can
  // still leave this INSERT a no-op — re-read rather than trust `row`,
  // same "the row in the table is the truth, not what I just tried to
  // write" caution this file's own createOpportunity() doesn't need
  // (opportunities.id is ulid-fresh, never contended) but this
  // opportunity_id-keyed table genuinely can be.
  const landed = db
    .prepare(`SELECT * FROM expansion_notifications WHERE opportunity_id = ?`)
    .get(opportunity.id) as ExpansionNotificationRow;
  return hydrateExpansionNotification(landed);
}

/**
 * Flips delivered 0 -> 1 once expansionRoutes.ts's own inbox write has
 * actually succeeded. Never called for a notification whose delivery
 * failed — see this section's header on why a failed delivery is left
 * at delivered=0 rather than retried or erased here.
 */
export function markExpansionNotificationDelivered(id: string): void {
  db.prepare(`UPDATE expansion_notifications SET delivered = 1 WHERE id = ?`).run(id);
}

/** Every notification recorded for one agent, most-recent-first — the
 *  read surface a caller (or a future admin.ts-style view) uses to see
 *  what's fired, mirroring listOpportunityReports()'s own shape. */
export function listExpansionNotificationsForAgent(
  agentAddress: string,
  limit = 50,
): ExpansionNotification[] {
  const rows = db
    .prepare(
      `SELECT * FROM expansion_notifications
       WHERE agent_address = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(agentAddress, limit) as ExpansionNotificationRow[];
  return rows.map(hydrateExpansionNotification);
}

// ─── Phase 12a: Strategy Department — assess_ecosystem_strengthening ────
//
// Zent.md 12a: "Tool: `assess_ecosystem_strengthening(opportunity_id)` —
// does this new company make the existing portfolio more resilient
// (shared customers, shared infra) or just add headcount."
//
// Built the same way 11e-i's fit-score factors were built on top of
// 11c/11d rather than inventing a third similarity metric: this reads
// the two signals Strategy already produces per-sibling and asks a
// narrower question of each —
//   - shared customers: 11c's checkMissionOverlap() "complements"
//     bucket. A sibling whose mission sits in the same tag-domain
//     without duplicating or competing with this opportunity is, by
//     11c's own definition of that label, one whose customer base this
//     opportunity could plausibly share. "duplicates"/"competes"
//     entries are deliberately NOT read as a strengthening signal here
//     — a sibling this opportunity would cannibalize isn't evidence of
//     a more resilient portfolio, it's 12b's future cannibalization
//     question, kept separate rather than folded into this one.
//   - shared infra: 11d's checkTechnologyReuse() — any sibling whose
//     skill catalog clears config.technologyReuseMatchThreshold against
//     this opportunity is a sibling this opportunity could share
//     tooling with at birth (16d's own tool-grant-scoping territory
//     downstream reads a relationship type off of exactly this kind of
//     evidence).
//
// Per the doc's own closing "Notes on scope" section — "an agent
// scoring its *own* expansion opportunities has a structural reason to
// find reasons to expand" — this function defaults to the unflattering
// answer when evidence is thin: zero existing siblings, or siblings
// that clear neither signal, both read `strengthensEcosystem: false`,
// not a hopeful true. Same "no signal, not fabricated" floor 11c/11d's
// own headers already commit to, applied one level up to the yes/no
// this phase asks for — deliberately not mirroring
// deriveMissionComplementarityFactor()'s (11e-i) "no siblings yet is a
// neutral 50" posture, since that function feeds a continuous score
// where "unknown" and "weak" both belong in the middle, while this one
// feeds a boolean the CEO gate will read at face value; an unproven
// "yes" is exactly the structural bias the doc warns about.
//
// Same portfolio source and "only a sibling 11b can resolve a mission
// for" filter 11c/11d already use, and the same "throws only on an
// unknown opportunity_id" posture — safe to call standalone, same as
// checkMissionOverlap()/checkTechnologyReuse() themselves.
export interface EcosystemStrengtheningSignal {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  /** From 11c's checkMissionOverlap(): true iff this sibling's
   *  relationship to the opportunity is "complements" — "duplicates"/
   *  "competes" do not count, see this section's own header. */
  sharedCustomers: boolean;
  /** From 11d's checkTechnologyReuse(): true iff this sibling has at
   *  least one skill clearing config.technologyReuseMatchThreshold
   *  against this opportunity. */
  sharedInfra: boolean;
}

export interface EcosystemStrengtheningResult {
  opportunityId: string;
  /** True iff at least one existing sibling shows shared-customer or
   *  shared-infra evidence (see `signals`). False for a first-ever
   *  sibling (nothing to strengthen yet) and false when siblings exist
   *  but none clear either signal — both are "no evidence", not
   *  "evidence of headcount-only", but this field only ever asserts
   *  what's demonstrated. */
  strengthensEcosystem: boolean;
  /** Short human-readable justification — same "auditable, not a bare
   *  boolean" discipline 3b's roi_score and 11e-i's fit_score already
   *  commit to for their own headline numbers. */
  reasoning: string;
  /** Titles of siblings contributing a sharedCustomers=true signal. */
  sharedCustomerSiblings: string[];
  /** Titles of siblings contributing a sharedInfra=true signal. */
  sharedInfraSiblings: string[];
  /** Only siblings with at least one true flag — same "no signal, not
   *  included" posture checkTechnologyReuse()/checkMissionOverlap()
   *  already take toward siblings that clear nothing, sorted by
   *  strongest evidence first (both flags true, then either flag true,
   *  ties broken by siblingAddress for determinism). */
  signals: EcosystemStrengtheningSignal[];
  assessedAt: number;
}

export function assessEcosystemStrengthening(opportunityId: string): EcosystemStrengtheningResult {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const rootAgentAddress = resolveOpportunityAgentAddress(opportunityId);
  const siblings = listExistingCompanies(rootAgentAddress).filter(
    (s): s is ExistingCompany & { mission: ExistingCompanyMission } =>
      s.mission !== null && s.mission.opportunityId !== opportunityId,
  );

  const missionOverlap = checkMissionOverlap(opportunityId);
  const technologyReuse = checkTechnologyReuse(opportunityId);

  const complementsBySibling = new Set(
    missionOverlap.filter((e) => e.relationship === "complements").map((e) => e.siblingAddress),
  );
  const reuseBySibling = new Set(technologyReuse.map((e) => e.siblingAddress));

  const signals: EcosystemStrengtheningSignal[] = [];
  for (const sibling of siblings) {
    const sharedCustomers = complementsBySibling.has(sibling.address);
    const sharedInfra = reuseBySibling.has(sibling.address);
    if (!sharedCustomers && !sharedInfra) continue;
    signals.push({
      siblingAddress: sibling.address,
      siblingOpportunityId: sibling.mission.opportunityId,
      siblingTitle: sibling.mission.title,
      sharedCustomers,
      sharedInfra,
    });
  }

  signals.sort((a, b) => {
    const scoreOf = (s: EcosystemStrengtheningSignal) => Number(s.sharedCustomers) + Number(s.sharedInfra);
    if (scoreOf(b) !== scoreOf(a)) return scoreOf(b) - scoreOf(a);
    return a.siblingAddress < b.siblingAddress ? -1 : a.siblingAddress > b.siblingAddress ? 1 : 0;
  });

  const sharedCustomerSiblings = signals.filter((s) => s.sharedCustomers).map((s) => s.siblingTitle);
  const sharedInfraSiblings = signals.filter((s) => s.sharedInfra).map((s) => s.siblingTitle);
  const strengthensEcosystem = signals.length > 0;

  let reasoning: string;
  if (siblings.length === 0) {
    reasoning = "No existing siblings yet — nothing in the portfolio to strengthen or weaken; this would be the first sibling.";
  } else if (!strengthensEcosystem) {
    reasoning = `No shared-customer or shared-infra evidence found across ${siblings.length} existing sibling${siblings.length === 1 ? "" : "s"}; this opportunity would add headcount without demonstrated portfolio synergy.`;
  } else {
    const parts: string[] = [];
    if (sharedCustomerSiblings.length > 0) {
      parts.push(`shared-customer overlap with ${sharedCustomerSiblings.join(", ")}`);
    }
    if (sharedInfraSiblings.length > 0) {
      parts.push(`shared-infra reuse potential with ${sharedInfraSiblings.join(", ")}`);
    }
    reasoning = `Shows ${parts.join(" and ")}.`;
  }

  return {
    opportunityId,
    strengthensEcosystem,
    reasoning,
    sharedCustomerSiblings,
    sharedInfraSiblings,
    signals,
    assessedAt: Date.now(),
  };
}

/** Persisted shape of one assess_ecosystem_strengthening pass, filed
 *  onto strategy_findings under `ecosystem_strengthening` — same
 *  `{ ..., checkedAt }` envelope MissionOverlapCheckRecord/
 *  TechnologyReuseCheckRecord (11e-ii-b) already use, applied to this
 *  phase's own result so a later Phase 12d compile_strategy_report has
 *  a persisted record to read instead of recomputing live. */
export interface EcosystemStrengtheningCheckRecord {
  result: EcosystemStrengtheningResult;
  checkedAt: number;
}

/**
 * Files one assess_ecosystem_strengthening(opportunity_id) pass onto
 * the opportunity's current strategy finding, under
 * `ecosystem_strengthening`. Same "a demonstrated false is still a
 * completed, filed check" posture recordMissionOverlapCheck()/
 * recordTechnologyReuseCheck() already document — `strengthensEcosystem:
 * false` is a real answer, not a missing one. Superseding on re-run,
 * same versioning every other strategy_findings write in this file uses.
 */
export function recordEcosystemStrengtheningAssessment(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; record: EcosystemStrengtheningCheckRecord } {
  const record: EcosystemStrengtheningCheckRecord = {
    result: assessEcosystemStrengthening(opportunityId),
    checkedAt: Date.now(),
  };
  const finding = mergeIntoCurrentStrategyFinding(opportunityId, { ecosystem_strengthening: record });
  return { finding, record };
}

// ─── Phase 12b: Strategy Department — check_cannibalization ─────────────
//
// Zent.md 12b: "Cannibalization check output: explicit yes/no +
// reasoning field, not buried in prose."
//
// Zent.md doesn't hand this sub-phase a tool signature the way 12a's
// own line does ("Tool: `assess_ecosystem_strengthening`...") — it
// names an output shape, not a function. But 12a's own header already
// committed to where this lives: "'duplicates'/'competes' entries are
// deliberately NOT read as a strengthening signal here ... it's 12b's
// future cannibalization question, kept separate rather than folded
// into this one." So this is that separate question, as its own tool —
// check_cannibalization(opportunity_id) — named `check_*` rather than
// `assess_*` to match 11c/11d's own naming for a function that reads
// an existing signal and classifies it, as opposed to 12a's `assess_*`,
// which synthesizes a portfolio-wide verdict across two signals.
//
// The signal itself is already sitting in 11c's checkMissionOverlap():
// a sibling classified "duplicates" or "competes" is, by that
// function's own definition of those two labels, exactly a sibling
// this opportunity would cannibalize — restating the same idea, not
// duplicating it, so no new similarity computation happens here.
// "complements" entries are excluded for the same reason 12a excludes
// "duplicates"/"competes" from its own signal: the two questions
// partition checkMissionOverlap()'s three relationship labels cleanly
// (complements -> 12a's strengthening signal; duplicates/competes ->
// this tool's cannibalization signal), so a given sibling relationship
// contributes to exactly one of the two Phase 12 tools, never both and
// never neither.
//
// Same "no signal, not fabricated" — and same bias-resistant default
// from 12a's own header — applies here too: zero existing siblings, or
// siblings that clear neither "duplicates" nor "competes", both read
// `cannibalizes: false`. There's no symmetric bias risk to correct for
// on this side (an agent minimizing its own scrutiny would rather see
// `cannibalizes: false`, so defaulting to false here is the
// *conservative*, not the self-serving, floor — same as 12a's default
// being the unflattering one for `strengthensEcosystem`), but the same
// "don't fabricate a verdict from an absence of siblings" discipline
// still governs: no siblings is "nothing to cannibalize," not silently
// coded the same as "checked, and it's clean."
//
// Pure read, no side effects — same posture 11c/11d/12a already take.
// Throws only if opportunityId itself doesn't resolve, same guard every
// sibling function in this file already uses.
export interface CannibalizationSignal {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  /** Which of checkMissionOverlap()'s two cannibalizing labels this
   *  sibling triggered — never "complements", see this section's own
   *  header for why that label routes to 12a instead. */
  relationship: "duplicates" | "competes";
  /** TF-IDF cosine similarity in [0, 1] — checkMissionOverlap()'s own
   *  signal for how severe the overlap is, passed through unchanged. */
  similarity: number;
}

export interface CannibalizationCheckResult {
  opportunityId: string;
  /** Explicit yes/no, per Zent.md 12b's own wording — never left to be
   *  inferred from the signals list. */
  cannibalizes: boolean;
  /** Short human-readable justification — same "auditable, not a bare
   *  boolean" discipline 12a's own `reasoning` field already commits to,
   *  and the literal "not buried in prose" requirement Zent.md 12b asks
   *  for: this field IS the reasoning, not a summary of it. */
  reasoning: string;
  /** Titles of every sibling contributing a cannibalization signal,
   *  worst-relationship-first (mirrors checkMissionOverlap()'s own
   *  sort). */
  cannibalizedSiblings: string[];
  /** Every "duplicates"/"competes" entry, same worst-first order. Empty
   *  exactly when cannibalizes is false. */
  signals: CannibalizationSignal[];
  checkedAt: number;
}

export function checkCannibalization(opportunityId: string): CannibalizationCheckResult {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const rootAgentAddress = resolveOpportunityAgentAddress(opportunityId);
  const siblingCount = listExistingCompanies(rootAgentAddress).filter(
    (s): s is ExistingCompany & { mission: ExistingCompanyMission } =>
      s.mission !== null && s.mission.opportunityId !== opportunityId,
  ).length;

  // checkMissionOverlap() already sorts duplicates-then-competes-then-
  // complements, ties broken by similarity descending — filtering to
  // the first two labels preserves that worst-first order for free.
  const missionOverlap = checkMissionOverlap(opportunityId);
  const signals: CannibalizationSignal[] = missionOverlap
    .filter((e): e is MissionOverlapEntry & { relationship: "duplicates" | "competes" } =>
      e.relationship === "duplicates" || e.relationship === "competes",
    )
    .map((e) => ({
      siblingAddress: e.siblingAddress,
      siblingOpportunityId: e.siblingOpportunityId,
      siblingTitle: e.siblingTitle,
      relationship: e.relationship,
      similarity: e.similarity,
    }));

  const cannibalizedSiblings = signals.map((s) => s.siblingTitle);
  const cannibalizes = signals.length > 0;

  let reasoning: string;
  if (siblingCount === 0) {
    reasoning = "No existing siblings yet — nothing for this opportunity to cannibalize.";
  } else if (!cannibalizes) {
    reasoning = `No overlapping-mission siblings found across ${siblingCount} existing sibling${siblingCount === 1 ? "" : "s"} — no cannibalization risk identified.`;
  } else {
    const duplicateCount = signals.filter((s) => s.relationship === "duplicates").length;
    const competeCount = signals.filter((s) => s.relationship === "competes").length;
    const clauses: string[] = [];
    if (duplicateCount > 0) {
      const names = signals.filter((s) => s.relationship === "duplicates").map((s) => s.siblingTitle);
      clauses.push(`duplicates the mission of ${names.join(", ")}`);
    }
    if (competeCount > 0) {
      const names = signals.filter((s) => s.relationship === "competes").map((s) => s.siblingTitle);
      clauses.push(`competes with ${names.join(", ")}`);
    }
    reasoning = `This opportunity ${clauses.join(" and ")}.`;
  }

  return {
    opportunityId,
    cannibalizes,
    reasoning,
    cannibalizedSiblings,
    signals,
    checkedAt: Date.now(),
  };
}

/** Persisted shape of one check_cannibalization pass, filed onto
 *  strategy_findings under `cannibalization_check` — same envelope
 *  EcosystemStrengtheningCheckRecord (12a) uses for its own result, so
 *  a later Phase 12d compile_strategy_report reads both the same way. */
export interface CannibalizationCheckRecord {
  result: CannibalizationCheckResult;
  checkedAt: number;
}

/**
 * Files one check_cannibalization(opportunity_id) pass onto the
 * opportunity's current strategy finding, under `cannibalization_check`.
 * Same "a demonstrated false is still a completed, filed check" posture
 * recordEcosystemStrengtheningAssessment() (12a) already documents —
 * `cannibalizes: false` is a real, filed answer, not a missing one.
 * Superseding on re-run, same versioning every other strategy_findings
 * write in this file uses.
 */
export function recordCannibalizationCheck(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; record: CannibalizationCheckRecord } {
  const record: CannibalizationCheckRecord = {
    result: checkCannibalization(opportunityId),
    checkedAt: Date.now(),
  };
  const finding = mergeIntoCurrentStrategyFinding(opportunityId, { cannibalization_check: record });
  return { finding, record };
}

// ─── Phase 12c: Strategy Department — recommend_relationship_type ───────
//
// Zent.md 12c: "Recommended relationship type if approved: independent /
// supplier-to-sibling / shared-customer-base — informs how Agent B's
// initial tool grants are scoped at birth."
//
// Same "no new similarity computation" discipline 12a/12b already
// establish for each other: the three-way label is read off signals
// 12a and 12b already produced, not derived from a fresh comparison.
//   - supplier-to-sibling: 12a's own sharedInfra flag (from 11d's
//     checkTechnologyReuse()) is exactly "this opportunity could start
//     from an existing sibling's tools/skills" — the concrete,
//     actionable half of a supplier relationship that 16d's own header
//     names directly ("supplier-to-sibling gets an additional grant to
//     call the sibling's marketplace listing"). A shared-infra sibling
//     is the one Agent B would plausibly buy from or sell tooling to.
//   - shared-customer-base: 12a's sharedCustomers flag (from 11c's
//     "complements" label) — the customer-overlap half of the same
//     evidence, read on its own when no shared-infra signal accompanies
//     it for the same sibling.
//   - independent: the default — no siblings, siblings exist but clear
//     neither 12a signal, or every signal-clearing sibling is also a
//     12b cannibalization match (see below).
//
// A sibling 12b's checkCannibalization() flags "duplicates"/"competes"
// is excluded from consideration here even if it also clears a 12a
// signal: technology-reuse overlap between two competing missions isn't
// evidence for a supplier relationship, it's evidence the two
// opportunities sit too close together — a risk 12b already surfaces on
// its own, and this tool must not paper over it by recommending a cozy
// relationship type with the very sibling 12b flagged. Same bias-
// resistant posture 12a's own header commits to ("an unproven 'yes' is
// exactly the structural bias the doc warns about"): this reads
// conservatively, not favorably, whenever the two signals conflict.
//
// When more than one non-cannibalizing sibling clears a 12a signal,
// 12a's own `signals` list is already sorted strongest-first (both
// flags, then either flag, ties broken by siblingAddress) — this tool
// takes that top entry as-is rather than re-ranking, restating an
// existing sort rather than re-deriving one, the same posture 12b's own
// worst-first `signals` list already takes from checkMissionOverlap().
//
// Pure read, no side effects — same posture 12a/12b already take.
// Throws only if opportunityId itself doesn't resolve.
export type RecommendedRelationshipType =
  | "independent"
  | "supplier-to-sibling"
  | "shared-customer-base";

export interface RelationshipTypeRecommendation {
  opportunityId: string;
  relationshipType: RecommendedRelationshipType;
  /** The sibling this recommendation is with — null for "independent",
   *  set for the other two types. */
  withSiblingAddress: string | null;
  withSiblingTitle: string | null;
  /** Short human-readable justification — same "auditable, not a bare
   *  label" discipline 12a's `reasoning` / 12b's `reasoning` already
   *  commit to for their own headline fields. */
  reasoning: string;
  /** Titles of siblings that cleared a 12a shared-customer/shared-infra
   *  signal but were excluded from consideration here because 12b also
   *  flags them as duplicates/competes — empty when no such conflict
   *  exists. */
  excludedForCannibalization: string[];
  recommendedAt: number;
}

export function recommendRelationshipType(opportunityId: string): RelationshipTypeRecommendation {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }

  const strengthening = assessEcosystemStrengthening(opportunityId);
  const cannibalization = checkCannibalization(opportunityId);
  const cannibalizingAddresses = new Set(cannibalization.signals.map((s) => s.siblingAddress));

  const eligibleSignals = strengthening.signals.filter(
    (s) => !cannibalizingAddresses.has(s.siblingAddress),
  );
  const excludedForCannibalization = strengthening.signals
    .filter((s) => cannibalizingAddresses.has(s.siblingAddress))
    .map((s) => s.siblingTitle);

  if (eligibleSignals.length === 0) {
    const reasoning =
      strengthening.signals.length === 0
        ? strengthening.reasoning.startsWith("No existing siblings")
          ? "No existing siblings yet — recommending independent, nothing to relate to."
          : "No shared-customer or shared-infra evidence with any existing sibling — recommending independent."
        : `Every sibling with shared-customer or shared-infra evidence (${excludedForCannibalization.join(", ")}) is also flagged by the cannibalization check — recommending independent rather than a relationship with a sibling this opportunity would cannibalize.`;

    return {
      opportunityId,
      relationshipType: "independent",
      withSiblingAddress: null,
      withSiblingTitle: null,
      reasoning,
      excludedForCannibalization,
      recommendedAt: Date.now(),
    };
  }

  const top = eligibleSignals[0];
  const relationshipType: RecommendedRelationshipType = top.sharedInfra
    ? "supplier-to-sibling"
    : "shared-customer-base";
  const reasoning =
    relationshipType === "supplier-to-sibling"
      ? `Shared-infra reuse potential with ${top.siblingTitle} — recommending supplier-to-sibling so Agent B's initial grants can include a call path to its marketplace listing.`
      : `Shared-customer overlap with ${top.siblingTitle} without an accompanying shared-infra signal — recommending shared-customer-base.`;

  return {
    opportunityId,
    relationshipType,
    withSiblingAddress: top.siblingAddress,
    withSiblingTitle: top.siblingTitle,
    reasoning,
    excludedForCannibalization,
    recommendedAt: Date.now(),
  };
}

/** Persisted shape of one recommend_relationship_type pass, filed onto
 *  strategy_findings under `relationship_type_recommendation` — same
 *  envelope EcosystemStrengtheningCheckRecord (12a) / CannibalizationCheckRecord
 *  (12b) use for their own results, so a later Phase 12d
 *  compile_strategy_report reads all three the same way. */
export interface RelationshipTypeRecommendationRecord {
  result: RelationshipTypeRecommendation;
  recordedAt: number;
}

/**
 * Files one recommend_relationship_type(opportunity_id) pass onto the
 * opportunity's current strategy finding, under
 * `relationship_type_recommendation`. Same "a demonstrated 'independent'
 * is still a completed, filed recommendation" posture
 * recordEcosystemStrengtheningAssessment() (12a) /
 * recordCannibalizationCheck() (12b) already document. Superseding on
 * re-run, same versioning every other strategy_findings write in this
 * file uses.
 */
export function recordRelationshipTypeRecommendation(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; record: RelationshipTypeRecommendationRecord } {
  const record: RelationshipTypeRecommendationRecord = {
    result: recommendRelationshipType(opportunityId),
    recordedAt: Date.now(),
  };
  const finding = mergeIntoCurrentStrategyFinding(opportunityId, {
    relationship_type_recommendation: record,
  });
  return { finding, record };
}

// ─── Phase 13a: Expansion Committee — Assembly ─────────────────────────
//
// Zent.md 13a: "expansion_committee construct: not a new department
// type at the data layer — a scheduled read that pulls Research +
// Finance + Strategy reports for one opportunity_id into a single
// packet." Also Zent.md's own closing note: "The 'Expansion Committee'
// is intentionally not a new agent kind — it's a read-only assembly
// step (Phase 13) plus a decision endpoint the CEO agent itself calls
// (Phase 15). Keeping it that way avoids inventing a fifth tier in the
// org chart that orgChartQuotas.ts would then need to learn about."
//
// So this is deliberately NOT: a new `department` type in
// departments.ts/orgChartQuotas.ts (there is no `expansion_committee`
// department — nothing is spawned, nothing is torn down, no
// resourceQuotas.ts entry exists or is needed); a new table (nothing is
// persisted — a packet is recomputed fresh from whatever
// research_findings/finance_findings/strategy_findings/opportunities
// currently hold, the same "current state, not a stored snapshot"
// posture compileResearchReport()/compileFinanceReport()/
// compileStrategyReport() themselves already take toward their own
// findings tables); or gated on completeness at THIS function's own
// level (13e adds a completeness verdict to every packet, and a
// separate, narrower function — requireCompleteCommitteePacket() — that
// enforces it, but assembleCommitteePacket() itself keeps returning a
// packet regardless of what that verdict says. Every department's
// compile*Report() already tolerates "hasn't run yet" by reading back
// nulls, and this function inherits that tolerance rather than fighting
// it, so a packet can be assembled — and inspected — at any point in
// the pipeline, not only once all three departments have filed).
//
// This is the plain assembly primitive, now under Phase 13b's locked,
// versioned packet contract (COMMITTEE_PACKET_SCHEMA_VERSION below),
// Phase 13c's Finance-vs-Strategy disagreement surfacing, Phase 13d's
// HTTP exposure (GET /expansion/opportunities/:id/committee-packet),
// and Phase 13e's completeness verdict (CommitteePacketCompleteness,
// attached to every packet as the `completeness` field). This function
// itself still never enforces that verdict — it stays "assemble
// whatever currently exists" even for an incomplete opportunity, same
// as always; requireCompleteCommitteePacket() (13e, below) is the
// separate, narrower entry point that actually gates on it. Each phase
// landed as its own build session, same "one focused deliverable per
// sub-phase" discipline every phase in this file already follows.
//
// "Four-report bundle" (13b's own wording, describing what this
// assembles) counts the Opportunity Intelligence department's own
// output as the fourth report alongside Research/Finance/Strategy — its
// title/thesis/roi_score/factors ARE that department's structured
// output (Phase 3), the same way Research/Finance/Strategy's are
// theirs; there's no separate `opportunity_intelligence_findings` table
// to compile a report from, so the opportunity row itself is that
// section, read via the same getOpportunity() every other route in this
// file already calls.
export interface CommitteePacket {
  opportunityId: string;
  assembledAt: number;
  /** Phase 13b: which locked packet contract produced this object —
   *  see COMMITTEE_PACKET_SCHEMA_VERSION below, same role
   *  RESEARCH_REPORT_SCHEMA_VERSION/FINANCE_REPORT_SCHEMA_VERSION/
   *  STRATEGY_REPORT_SCHEMA_VERSION already play for their own reports.
   *  Exists so "later CEO models don't need every department to re-run
   *  when the packet format changes" (13b's own wording) — a CEO model
   *  reading a packet checks this field, not the presence/absence of
   *  individual keys, to know whether it's looking at the contract it
   *  expects. */
  schemaVersion: string;
  /** Opportunity Intelligence's own report — the opportunity row
   *  itself (title, thesis, roi_score, scoring factors, tags). Never
   *  null here: assembleCommitteePacket() throws on an unknown
   *  opportunity_id (below) rather than returning a packet with this
   *  section absent, the same "known opportunity or an error, never a
   *  half-built packet for an unknown one" posture compileResearchReport()
   *  takes toward its own opportunity-existence check. */
  opportunityIntelligence: Opportunity;
  /** Research's compiled report (Phase 7a/7b) — every section null
   *  until Research has run the corresponding tool, same "nothing to
   *  compile yet is not an error" tolerance compileResearchReport()
   *  itself documents. The report OBJECT itself is never null/absent —
   *  only its internal fields are — same as financeReport/
   *  strategyReport below. */
  researchReport: ResearchReport;
  /** Finance's compiled report (Phase 9e) — same per-field null
   *  tolerance as researchReport above. */
  financeReport: FinanceReport;
  /** Strategy's compiled report (Phase 12d) — same per-field null
   *  tolerance as researchReport/financeReport above. */
  strategyReport: StrategyReport;
  /** Phase 13c: Finance-sizing-vs-Strategy-fit-score disagreement
   *  verdict — see FinanceStrategyDisagreement below. Always an object,
   *  never null, same "required, never absent at the packet level"
   *  contract the four report sections above already have (13b's own
   *  header) — the comparison itself handles "one or both inputs not
   *  filed yet" internally (diverges: false, directions null), the same
   *  way computeFitRoiDivergence() already handles a null roiScore
   *  rather than the *field* being absent. */
  financeStrategyDisagreement: FinanceStrategyDisagreement;
  /** Phase 13e: completeness verdict — see CommitteePacketCompleteness
   *  below. Always an object, never null, same "required, never absent"
   *  contract every other bundle-level field above already has. Answers
   *  exactly one question this packet's other fields don't: is this
   *  packet ready for the CEO gate (Phase 15) to actually decide on, or
   *  is one or more of Research/Finance/Strategy still outstanding.
   *  Computing it here (rather than leaving it to a caller to re-derive
   *  from the three findingId fields every time) means every reader of
   *  a CommitteePacket — the 13d GET route, Phase 15's eventual decision
   *  route, a future dashboard — checks the same one field instead of
   *  each re-implementing "are all three findingIds non-null." */
  completeness: CommitteePacketCompleteness;
  /** Phase 14a: deliberation-pass verdict — see DeliberationExchange
   *  below. Always an object, never null, same "required, never absent"
   *  contract every other bundle-level field above already has. A
   *  disabled pass reads back `{enabled: false, ..., locked: true}` —
   *  present but inert — rather than the field itself being omitted,
   *  same reasoning `completeness` and `financeStrategyDisagreement`
   *  already give for staying non-null even when there's nothing
   *  outstanding to report. */
  deliberation: DeliberationExchange;
  /** Phase 14b/14c/14d: committee voting record — see
   *  CommitteeVotingRecord below. Always an object, never null, same
   *  "required, never absent" contract every other bundle-level field
   *  above already has. Independent of `deliberation` above: an agent
   *  can have the optional 14a exchange turned off while every
   *  department still casts a 14b vote (voting is not gated behind
   *  deliberation being enabled) — see getVotingRecord()'s own header. */
  votingRecord: CommitteeVotingRecord;
}

// ─── Phase 13b: Expansion Committee — Packet Schema ────────────────────
//
// Zent.md 13b: "Committee packet schema: the exact four-report bundle
// the CEO will see, versioned so later CEO models don't need every
// department to re-run when the packet format changes." Locks
// CommitteePacket (13a) into the same "exact field set, versioned,
// runtime-checked" contract RESEARCH_REPORT_FIELDS/FINANCE_REPORT_FIELDS/
// STRATEGY_REPORT_FIELDS already give their own reports.
/** Phase 13b: which locked contract compileStrategyReport()'s
 *  committee-packet counterpart, assembleCommitteePacket(), produces.
 *  Named for the phase that locks this bundle's own contract, same
 *  "name the constant after the phase that locked it" convention
 *  RESEARCH_REPORT_SCHEMA_VERSION ("7b-v1") / FINANCE_REPORT_SCHEMA_VERSION
 *  ("9e-v1") / STRATEGY_REPORT_SCHEMA_VERSION ("12d-v1") already
 *  establish. Independent of all three of those: bumping any one
 *  department's own report schema (a future ResearchReport field, say)
 *  does NOT require bumping this constant — this version only tracks
 *  the shape of the *bundle itself* (which four top-level keys it has,
 *  in what order, each required or nullable). A CommitteePacket whose
 *  nested strategyReport carries an old/new StrategyReport schema is
 *  still a valid 13b-v1 packet; that nested report's own schemaVersion
 *  field is how a reader tells the difference at that layer, the same
 *  "each layer versions itself" separation of concerns
 *  validateCommitteePacketShape() below relies on (it checks
 *  packet-level shape only, and does not recurse into validating each
 *  nested report — see that function's own header).
 *
 *  Bumped to "13c-v1" by Phase 13c, which adds the
 *  financeStrategyDisagreement field below — a real bundle-shape change
 *  (a new top-level key), same trigger that would justify any future
 *  bump of this constant. Every other field 13b locked is unchanged.
 *
 *  Bumped again to "13e-v1" by Phase 13e, which adds the completeness
 *  field below — another new top-level key, same trigger as 13c's own
 *  bump. Every field 13b/13c locked is unchanged.
 *
 *  Bumped again to "14a-v1" by Phase 14a, which adds the deliberation
 *  field below — another new top-level key, same trigger as 13c's/13e's
 *  own bumps. Every field 13b/13c/13e locked is unchanged.
 *
 *  Bumped again to "14d-v1" by Phase 14b/14c/14d (landed together,
 *  since 14c's conditions field and 14d's timeout handling are both
 *  just detail on 14b's own vote field, not separate top-level keys of
 *  their own), which adds the votingRecord field below — another new
 *  top-level key, same trigger as every bump above. Every field
 *  13b/13c/13e/14a locked is unchanged. */
export const COMMITTEE_PACKET_SCHEMA_VERSION = "14d-v1";

/** Every CommitteePacket field, in the order assembleCommitteePacket()
 *  emits them — same "one canonical list, not a test-side guess" role
 *  RESEARCH_REPORT_FIELDS/FINANCE_REPORT_FIELDS/STRATEGY_REPORT_FIELDS
 *  already play for their own reports. */
export const COMMITTEE_PACKET_FIELDS = [
  "opportunityId",
  "assembledAt",
  "schemaVersion",
  "opportunityIntelligence",
  "researchReport",
  "financeReport",
  "strategyReport",
  "financeStrategyDisagreement",
  "completeness",
  "deliberation",
  "votingRecord",
] as const satisfies readonly (keyof CommitteePacket)[];

/** Unlike STRATEGY_REPORT_NULLABLE_OBJECT_FIELDS's four sections (each
 *  legitimately absent until that department runs a tool),
 *  CommitteePacket's four "report" fields are never themselves null —
 *  assembleCommitteePacket() always calls all three compile*Report()
 *  functions plus getOpportunity(), and each of those either returns a
 *  populated object (with individual *fields* inside it null) or
 *  throws. So this bundle's own required-object fields are checked as
 *  "must be an object, never null," not "object or null" the way each
 *  nested report's own sections are. */
const COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS = [
  "opportunityIntelligence",
  "researchReport",
  "financeReport",
  "strategyReport",
  "financeStrategyDisagreement",
  "completeness",
  "deliberation",
  "votingRecord",
] as const;

/**
 * Runtime conformance check for an assembled committee packet — the
 * same role validateResearchReportShape()/validateFinanceReportShape()/
 * validateStrategyReportShape() play for their own reports, applied to
 * the bundle Phase 13 hands the CEO. Checks the object has exactly
 * COMMITTEE_PACKET_FIELDS' keys (no more, no fewer), every scalar field
 * has its required type, all four report sections are plain objects
 * (never null/array/primitive — see COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS'
 * own header for why these differ from each nested report's own
 * nullable sections), and schemaVersion matches
 * COMMITTEE_PACKET_SCHEMA_VERSION exactly.
 *
 * Deliberately packet-level only: this does NOT recurse into
 * researchReport/financeReport/strategyReport and re-validate each
 * against its own RESEARCH_REPORT_FIELDS/FINANCE_REPORT_FIELDS/
 * STRATEGY_REPORT_FIELDS — each of those three is already self-checked
 * inside its own compile*Report() (throwing there, before
 * assembleCommitteePacket() ever sees it), so re-checking them here
 * would just be re-proving something already guaranteed by the time
 * this function runs, the same "trust the one chokepoint" reasoning
 * assembleCommitteePacket()'s own header gives for not re-validating
 * those three calls a second time. This function's only job is the
 * bundle's OWN contract: four required sections, in this shape, at this
 * version.
 *
 * Pure function — no DB access — exercised directly against hand-built
 * fixtures by its own shape test, same as its Research/Finance/Strategy
 * counterparts.
 */
export function validateCommitteePacketShape(
  packet: unknown,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof packet !== "object" || packet === null || Array.isArray(packet)) {
    return { valid: false, errors: ["packet is not a plain object"] };
  }
  const obj = packet as Record<string, unknown>;

  const actualKeys = new Set(Object.keys(obj));
  const expectedKeys = new Set<string>(COMMITTEE_PACKET_FIELDS);
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) errors.push(`missing field: ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) errors.push(`unexpected field: ${key}`);
  }

  if (typeof obj.opportunityId !== "string" || !obj.opportunityId) {
    errors.push("opportunityId must be a non-empty string");
  }
  if (typeof obj.assembledAt !== "number") {
    errors.push("assembledAt must be a number");
  }
  if (obj.schemaVersion !== COMMITTEE_PACKET_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be "${COMMITTEE_PACKET_SCHEMA_VERSION}", got ${JSON.stringify(obj.schemaVersion)}`,
    );
  }
  for (const field of COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS) {
    const value = obj[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${field} must be an object, and is required (never null)`);
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

// ─── Phase 13c: Expansion Committee — Disagreement Surfacing ───────────
//
// Zent.md 13c: "Disagreement surfacing: if Finance's sizing and
// Strategy's fit score point opposite directions, the packet says so
// explicitly rather than averaging it away."
//
// Unlike 11e-iii-a's fit_roi_divergence (a magnitude comparison between
// two numbers on the same [0, 100] scale), sizingRecommendation and
// fit_score don't share a unit — one's a USDC amount, the other's a
// 0-100 score — so there's no meaningful delta to threshold. What they
// DO each reduce to is a direction: is Finance recommending real money
// for this, and does Strategy think it's a good fit. This function
// derives both directions and flags it when they point opposite ways,
// the same "flagged, structured record that a tension exists, not a
// resolution of it" posture computeFitRoiDivergence() already takes —
// this file has no basis to decide whether Finance or Strategy is
// "right" when they disagree, only to make sure the CEO reading the
// packet sees the disagreement instead of it silently washing out.
export interface FinanceStrategyDisagreement {
  /** True when both directions below are known and point opposite
   *  ways. Always false when either input hasn't been filed yet — a
   *  missing signal is not a disagreement, the same "no signal, not
   *  fabricated" posture FitRoiDivergence.diverges already takes
   *  toward a null roiScore. */
  diverges: boolean;
  /** "fund" when Finance's sizingRecommendation.recommendedFundingUsdc
   *  is greater than zero, "no-fund" when it's clamped to exactly zero
   *  (no available capital, runway floor, or day/call caps left no
   *  room — see recommendSizing()'s own clamping). Null until Finance
   *  has filed a sizing_recommendation. */
  financeDirection: "fund" | "no-fund" | null;
  /** "favorable" when Strategy's fit_score is at or above
   *  config.fitScoreDirectionMidpoint, "unfavorable" when it's below.
   *  Null until Strategy has filed a fit_score (score_strategy_fit). */
  strategyDirection: "favorable" | "unfavorable" | null;
  /** The raw inputs this verdict was computed from, so a reader (or the
   *  CEO gate) can see exactly which numbers produced it without
   *  re-deriving anything — same transparency FitRoiDivergence's own
   *  fitScore/roiScore/threshold fields already give. */
  recommendedFundingUsdc: number | null;
  fitScore: number | null;
  /** The midpoint this comparison was actually run against
   *  (config.fitScoreDirectionMidpoint at call time), stored for the
   *  same "a later retune never makes an already-surfaced verdict
   *  ambiguous about which cutoff produced it" reason
   *  FitRoiDivergence.threshold is stored. */
  midpoint: number;
}

/**
 * Compares one opportunity's Finance sizing recommendation against its
 * Strategy fit score and decides whether the two point opposite
 * directions. Pure function over the two already-compiled reports — no
 * DB access, no side effects — so assembleCommitteePacket() below is the
 * only thing that decides when this runs and what to do with the
 * result, the same split computeFitRoiDivergence() keeps from its own
 * persisting caller.
 */
export function computeFinanceStrategyDisagreement(
  financeReport: FinanceReport,
  strategyReport: StrategyReport,
): FinanceStrategyDisagreement {
  const midpoint = config.fitScoreDirectionMidpoint;
  const sizing = financeReport.sizingRecommendation;
  const fit = strategyReport.fitScore;

  const financeDirection: "fund" | "no-fund" | null =
    sizing === null ? null : sizing.recommendedFundingUsdc > 0 ? "fund" : "no-fund";
  const strategyDirection: "favorable" | "unfavorable" | null =
    fit === null ? null : fit.fit_score >= midpoint ? "favorable" : "unfavorable";

  // Both sides must be known to compare a direction at all — one side
  // missing is "no signal yet," never a fabricated disagreement.
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

// ─── Phase 13e: Expansion Committee — Packet Completeness Gate ─────────
//
// Zent.md 13e: "Packet completeness gate: cannot assemble until all
// three reports exist; a high_regulatory_risk tag is surfaced
// prominently in the packet rather than blocking assembly."
//
// That reads as one gate, but it's two separate decisions, and this
// phase deliberately keeps them separate rather than conflating "risky"
// with "not ready":
//
// 1. Completeness — "cannot assemble until all three reports exist."
//    Taken literally, this would mean assembleCommitteePacket() (13a)
//    itself should start throwing. It doesn't, on purpose: that
//    function's own header (just above) already committed to staying
//    the tolerant "assemble whatever currently exists" primitive, and
//    13d's GET route already documents why that tolerance is
//    load-bearing — a caller can inspect an in-flight opportunity's
//    partial packet at any point in the pipeline, not only once all
//    three departments have filed. Reinterpreting either of those now
//    would break every existing caller of both. So the gate lands as a
//    new, narrower entry point instead — requireCompleteCommitteePacket()
//    below — which is the one that actually enforces "cannot [proceed]
//    until all three reports exist." Its intended caller is Phase 15's
//    eventual decide_expansion route: the one place in this pipeline
//    where completeness needs to be load-bearing (the CEO ruling on a
//    packet Research or Finance never even saw is exactly the mistake
//    this gate exists to prevent), not merely informative the way it is
//    on a plain GET. assembleCommitteePacket() and the 13d route are
//    unchanged by this phase.
//
// 2. Regulatory risk — "surfaced prominently... rather than blocking
//    assembly." A high_regulatory_risk tag (6e) is not one of the three
//    department reports, so it is never part of what "all three reports
//    exist" checks, regardless of how it's flagged — a high-risk
//    opportunity with all three reports filed is just as `complete` as
//    a low-risk one. "Prominently" is delivered by lifting the flag out
//    of the two places a reader would otherwise have to know to look
//    (opportunityIntelligence.tags, or digging into
//    researchReport.regulatoryRisk.riskLevel) onto one top-level
//    boolean, the same "top-level, not buried" treatment
//    financeStrategyDisagreement (13c) already gives Finance/Strategy's
//    own tension.
export interface CommitteePacketCompleteness {
  /** True only when Research, Finance, and Strategy have each filed at
   *  least one finding for this opportunity (findingId !== null on all
   *  three reports) — a high_regulatory_risk tag has no bearing on this
   *  value either way, per this phase's own header above. */
  complete: boolean;
  /** Which of the three departments have NOT yet filed a finding — empty
   *  when `complete` is true. Named, not just counted, so a caller (or
   *  the CEO gate) knows exactly what's still outstanding without
   *  re-deriving it from the three reports' own findingId fields. */
  missingReports: readonly ("research" | "finance" | "strategy")[];
  /** Mirrors whether HIGH_REGULATORY_RISK_TAG (6e) is present on this
   *  opportunity's own tags — read here, not recomputed, since 6e's
   *  applyRegulatoryRiskEscalation() is the one place that tag is ever
   *  written. Present for visibility only; never affects `complete` or
   *  `missingReports`, per this phase's own header above. */
  highRegulatoryRisk: boolean;
}

/**
 * Derives Phase 13e's completeness verdict from an already-assembled
 * CommitteePacket. Pure function over the packet's own fields — no DB
 * access, no side effects — same posture computeFinanceStrategyDisagreement()
 * takes toward its own two report inputs just above. Reads
 * researchReport/financeReport/strategyReport's findingId fields (each
 * null exactly when that department hasn't filed anything yet — see
 * ResearchReport/FinanceReport/StrategyReport's own header comments)
 * rather than re-querying the findings tables directly, so this stays
 * consistent with whatever the packet itself already says, even if
 * called against a packet fixture in a test rather than a freshly
 * assembled one.
 */
export function computeCommitteePacketCompleteness(
  packet: Pick<CommitteePacket, "researchReport" | "financeReport" | "strategyReport" | "opportunityIntelligence">,
): CommitteePacketCompleteness {
  const missingReports: ("research" | "finance" | "strategy")[] = [];
  if (packet.researchReport.findingId === null) missingReports.push("research");
  if (packet.financeReport.findingId === null) missingReports.push("finance");
  if (packet.strategyReport.findingId === null) missingReports.push("strategy");
  return {
    complete: missingReports.length === 0,
    missingReports,
    highRegulatoryRisk: packet.opportunityIntelligence.tags.includes(HIGH_REGULATORY_RISK_TAG),
  };
}

/**
 * requireCompleteCommitteePacket(opportunity_id) — Phase 13e's actual
 * "cannot [proceed] until all three reports exist" enforcement point.
 * Assembles the packet via the unchanged assembleCommitteePacket() (13a-
 * 13c) and throws, naming exactly which department(s) are still
 * outstanding, when computeCommitteePacketCompleteness() says the
 * packet isn't complete. A high_regulatory_risk tag never trips this —
 * see this phase's own header above; a fully-reported but high-risk
 * opportunity passes this gate cleanly, exactly as Zent.md 13e
 * specifies ("surfaced prominently... rather than blocking assembly").
 *
 * Not called by anything in this pipeline yet — Phase 15's
 * decide_expansion route (not yet built) is this function's intended
 * caller, the same "built ahead of its own caller, same discipline
 * every other not-yet-wired primitive in this file already follows"
 * posture computeFinanceStrategyDisagreement() and this file's other
 * Phase 13 exports already take. The 13d GET route deliberately keeps
 * calling assembleCommitteePacket() directly, not this function — see
 * that route's own header for why a plain read stays tolerant.
 */
export function requireCompleteCommitteePacket(opportunityId: string): CommitteePacket {
  const packet = assembleCommitteePacket(opportunityId);
  if (!packet.completeness.complete) {
    throw new Error(
      `committee packet for opportunity ${opportunityId} is not ready for a decision — missing report(s): ${packet.completeness.missingReports.join(", ")}`,
    );
  }
  return packet;
}

// ─── Phase 14a: Expansion Committee — Deliberation ─────────────────────
//
// Zent.md 14a: "Optional deliberation pass: a lightweight cross-
// department exchange (each department gets to see the others' reports
// once and append a short rebuttal/concur) before the packet locks —
// off by default, enabled per-agent config."
//
// "Off by default" lands as isDeliberationEnabled() reading
// expansion_pipeline_config (db.ts) and treating a missing row the same
// as an explicit 0 — no migration/backfill needed for any agent that
// existed before this phase. Per Zent.md's own closing note ("no
// human-in-the-loop step anywhere in this pipeline"), the switch this
// gates is per-agent config the top-level agent itself sets (via
// setDeliberationEnabled(), called from whatever route/tool exposes it
// in expansionRoutes.ts), not an external operator toggle.
//
// "Each department gets to see the others' reports once and append a
// short rebuttal/concur" is deliberately NOT modeled as a live back-
// and-forth inside this file — the departments themselves are the LLM-
// driven agent processes (agent-runtime), and this file's job (same
// posture every other department-facing write in this pipeline takes)
// is just the persistence primitive a department's tool call lands on:
// recordDeliberationResponse() takes the department's already-written
// rebuttal/concur text and files it. Reading the other two departments'
// reports so there's something to respond to is the committee packet
// itself (assembleCommitteePacket() already hands a department
// everything it needs to see); this phase adds the place a response
// to that packet lives, not a second copy of the packet-reading path.
//
// "Once" is enforced by deliberation_responses' own
// UNIQUE(opportunity_id, department) index — recordDeliberationResponse()
// upserts on top of it (a resubmit updates the same row) rather than
// throwing on a second call, matching this table's own header in db.ts.
export const DELIBERATION_DEPARTMENTS = ["research", "finance", "strategy"] as const;
export type DeliberationDepartment = (typeof DELIBERATION_DEPARTMENTS)[number];

export function isValidDeliberationDepartment(value: unknown): value is DeliberationDepartment {
  return typeof value === "string" && (DELIBERATION_DEPARTMENTS as readonly string[]).includes(value);
}

export const DELIBERATION_POSITIONS = ["concur", "rebuttal"] as const;
export type DeliberationPosition = (typeof DELIBERATION_POSITIONS)[number];

export function isValidDeliberationPosition(value: unknown): value is DeliberationPosition {
  return typeof value === "string" && (DELIBERATION_POSITIONS as readonly string[]).includes(value);
}

export interface DeliberationResponse {
  id: string;
  opportunityId: string;
  department: DeliberationDepartment;
  position: DeliberationPosition;
  responseText: string;
  /** Which other departments' reports this response addresses — named,
   *  not just implied by `department`'s absence from the list, same
   *  "named, not just counted" treatment CommitteePacketCompleteness's
   *  own missingReports field already gets (13e, above). */
  respondingTo: readonly DeliberationDepartment[];
  createdAt: number;
}

interface DeliberationResponseRow {
  id: string;
  opportunity_id: string;
  department: string;
  position: string;
  response_text: string;
  responding_to: string;
  created_at: number;
}

function hydrateDeliberationResponse(row: DeliberationResponseRow): DeliberationResponse {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    department: row.department as DeliberationDepartment,
    position: row.position as DeliberationPosition,
    responseText: row.response_text,
    respondingTo: JSON.parse(row.responding_to) as DeliberationDepartment[],
    createdAt: row.created_at,
  };
}

/** Reads expansion_pipeline_config for `agentAddress`. A missing row —
 *  the state of every agent before this phase, and every agent that
 *  never explicitly opts in — reads back `false`, matching Zent.md
 *  14a's "off by default" exactly. */
export function isDeliberationEnabled(agentAddress: string): boolean {
  const row = db
    .prepare(`SELECT deliberation_enabled FROM expansion_pipeline_config WHERE agent_address = ?`)
    .get(agentAddress) as { deliberation_enabled: number } | undefined;
  return row ? row.deliberation_enabled === 1 : false;
}

/** Per-agent config setter — Zent.md 14a's "enabled per-agent config."
 *  Called by the top-level agent itself (there is no operator-facing
 *  path onto this pipeline anywhere else, and this phase doesn't add
 *  one); an agent can flip this at any time, including mid-cycle for
 *  an opportunity whose packet hasn't locked yet (getDeliberationExchange()
 *  below always reads this fresh, never caches it onto the opportunity
 *  or packet). */
export function setDeliberationEnabled(agentAddress: string, enabled: boolean): void {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  db.prepare(
    `INSERT INTO expansion_pipeline_config (agent_address, deliberation_enabled)
     VALUES (@agent_address, @deliberation_enabled)
     ON CONFLICT(agent_address) DO UPDATE SET deliberation_enabled = excluded.deliberation_enabled`,
  ).run({ agent_address: agentAddress, deliberation_enabled: enabled ? 1 : 0 });
}

// ─── Phase 19e: per-agent dry-run mode ──────────────────────────────────
//
// Zent.md 19e: "Full-pipeline dry-run mode: run Phases 2–15 to
// completion, produce a genesis-ready packet, but stop short of 16 —
// for testing the whole reasoning chain without actually spending
// funding." Same on/off-switch shape as 14a's isDeliberationEnabled()/
// setDeliberationEnabled() immediately above — a missing row (or a row
// that predates this column) reads back `false`, matching every other
// "off by default" switch on this table.

/** Reads expansion_pipeline_config.dry_run_mode for `agentAddress`. A
 *  missing row reads back `false` — same default every agent had before
 *  this phase existed, and the default for any agent that never
 *  explicitly opts in. */
export function isDryRunModeEnabled(agentAddress: string): boolean {
  const row = db
    .prepare(`SELECT dry_run_mode FROM expansion_pipeline_config WHERE agent_address = ?`)
    .get(agentAddress) as { dry_run_mode: number } | undefined;
  return row ? row.dry_run_mode === 1 : false;
}

/** Per-agent config setter. Called by the top-level agent itself — no
 *  operator-facing settings surface exists anywhere in this pipeline
 *  (Zent.md's own closing note: "no human-in-the-loop step anywhere in
 *  this pipeline"), same posture setDeliberationEnabled() already takes.
 *  Safe to flip mid-cycle: decideExpansion() reads this fresh at the
 *  moment an `approved` ruling is about to fire genesis, never cached
 *  onto the opportunity, decision, or packet — so toggling this off
 *  after Research/Finance/Strategy have already filed their reports for
 *  an opportunity still produces a dry run for that opportunity's
 *  eventual decision if the flag happens to be on at ruling time, and
 *  vice versa. */
export function setDryRunModeEnabled(agentAddress: string, enabled: boolean): void {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  db.prepare(
    `INSERT INTO expansion_pipeline_config (agent_address, dry_run_mode)
     VALUES (@agent_address, @dry_run_mode)
     ON CONFLICT(agent_address) DO UPDATE SET dry_run_mode = excluded.dry_run_mode`,
  ).run({ agent_address: agentAddress, dry_run_mode: enabled ? 1 : 0 });
}

// ─── Phase 20d: staged rollout ───────────────────────────────────────
//
// Zent.md 20d: "Staged rollout: dry-run mode (19e) only, for the first
// real profitable agent in production, before enabling real genesis."
//
// This is a second, independent reason an opportunity's `approved`
// ruling can produce a dry-run packet instead of real genesis —
// isDryRunModeEnabled() above (19e) is a switch the agent flips on
// itself; rollout_stage below is a switch only checkRolloutGraduationEligibility()
// / graduateToLiveGenesis() can flip, and it starts (per db.ts's 20d
// migration default) at the more restrictive value. Same "no
// operator-facing settings surface exists anywhere in this pipeline"
// posture every other 19e/14a function's header already states — the
// graduation check and the call that acts on it are both something
// the agent hierarchy does to itself, verified against real pipeline
// history, not a flag a human flips.

export type RolloutStage = "dry_run_only" | "live_enabled";

/** Reads expansion_pipeline_config.rollout_stage for `agentAddress`. A
 *  missing row reads back 'dry_run_only' — the safe default for both
 *  an agent that predates this phase and a brand-new agent that has
 *  never been evaluated, matching 20d's own "dry-run mode only ...
 *  before enabling real genesis" ordering. This is the one place in
 *  the 14a/19e/20d family where a missing row does NOT mean "off"/
 *  least-restrictive — it means most-restrictive, because this column
 *  guards a rollout safety property, not a feature toggle. */
export function getRolloutStage(agentAddress: string): RolloutStage {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  const row = db
    .prepare(`SELECT rollout_stage FROM expansion_pipeline_config WHERE agent_address = ?`)
    .get(agentAddress) as { rollout_stage: RolloutStage } | undefined;
  return row ? row.rollout_stage : "dry_run_only";
}

/** The actual gate decideExpansion() reads at ruling time (replacing
 *  its old direct call to isDryRunModeEnabled() — see that call site
 *  below). True if EITHER the agent's own 19e toggle is on, OR the
 *  root hasn't graduated out of staged rollout yet — either condition
 *  alone is enough to keep an `approved` ruling on the dry-run path.
 *  Read fresh at ruling time, same "never cached onto the opportunity/
 *  packet/decision" posture isDryRunModeEnabled() itself documents,
 *  for the identical reason: a graduation that happens mid-cycle
 *  should govern whatever ruling happens next, not whatever was true
 *  when the opportunity was first scored. */
export function isDryRunModeEffective(agentAddress: string): boolean {
  return getRolloutStage(agentAddress) === "dry_run_only" || isDryRunModeEnabled(agentAddress);
}

export interface RolloutGraduationEligibility {
  eligible: boolean;
  reason?: string;
  dryRunPacketCount: number;
  minDryRunPacketsRequired: number;
  circuitBreakerHalted: boolean;
  currentlyProfitable: boolean;
}

/**
 * The deterministic formula behind graduation — mirrors 3b/11e-i's
 * "documented, not left to the model to invent per-call" posture.
 * Three independent conditions, all required:
 *
 *   1. At least `config.rolloutGraduationMinDryRunPackets` completed
 *      dry-run genesis packets (Phase 19e) recorded for this root —
 *      i.e. the full reasoning chain (2-15) has actually run to a
 *      genesis-ready decision this many times, not just "the agent
 *      says it's ready."
 *   2. The 19c circuit breaker is not currently tripped for this root
 *      — a root that can't currently pass its own guardrails has no
 *      business being trusted with real funding either.
 *   3. isEligibleForExpansion() (2e) still holds — graduation itself
 *      doesn't grant a profitability exemption; it only removes the
 *      dry-run forcing once the other two conditions are also true.
 *
 * A root that is already 'live_enabled' is reported ineligible with a
 * clear reason (graduateToLiveGenesis() below is idempotent and relies
 * on this) rather than silently re-evaluating — "eligible to graduate"
 * and "already graduated" are different questions.
 */
export function checkRolloutGraduationEligibility(
  agentAddress: string,
): RolloutGraduationEligibility {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  const dryRunPacketCount = (
    db
      .prepare(`SELECT COUNT(*) as n FROM dry_run_genesis_packets WHERE agent_address = ?`)
      .get(agentAddress) as { n: number }
  ).n;
  const minDryRunPacketsRequired = config.rolloutGraduationMinDryRunPackets;

  const circuitBreakerRow = db
    .prepare(`SELECT 1 FROM expansion_circuit_breaker WHERE root_agent_address = ?`)
    .get(agentAddress);
  const circuitBreakerHalted = Boolean(circuitBreakerRow);

  const { eligible: currentlyProfitable } = isEligibleForExpansion(agentAddress);

  if (getRolloutStage(agentAddress) === "live_enabled") {
    return {
      eligible: false,
      reason: `root agent ${agentAddress} has already graduated to live_enabled`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted,
      currentlyProfitable,
    };
  }
  if (dryRunPacketCount < minDryRunPacketsRequired) {
    return {
      eligible: false,
      reason:
        `root agent ${agentAddress} has ${dryRunPacketCount} completed dry-run genesis ` +
        `packet(s), needs at least ${minDryRunPacketsRequired} to graduate, per Zent.md 20d`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted,
      currentlyProfitable,
    };
  }
  if (circuitBreakerHalted) {
    return {
      eligible: false,
      reason: `root agent ${agentAddress} has an active 19c circuit-breaker halt — cannot graduate while halted`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted,
      currentlyProfitable,
    };
  }
  if (!currentlyProfitable) {
    return {
      eligible: false,
      reason: `root agent ${agentAddress} is not currently profitable (2e) — graduation does not exempt this gate`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted,
      currentlyProfitable,
    };
  }
  return {
    eligible: true,
    dryRunPacketCount,
    minDryRunPacketsRequired,
    circuitBreakerHalted,
    currentlyProfitable,
  };
}

/**
 * Flips rollout_stage to 'live_enabled' and writes one audit event.
 * Re-verifies checkRolloutGraduationEligibility() itself rather than
 * trusting a caller's own claim of eligibility — same "the write
 * primitive re-checks the gate the read layer computed" discipline
 * requireDecidableCommitteePacket()/decideExpansion() already use, so
 * a stale eligibility read (checked, then acted on moments later after
 * something changed) can't slip a root into live_enabled it no longer
 * qualifies for. Idempotent by construction: a root that's already
 * live_enabled fails checkRolloutGraduationEligibility() with that
 * exact reason (see above) and this throws before writing anything.
 *
 * Called by the top-level agent itself, via the /agents/:agentAddress/graduate
 * route (expansionRoutes.ts) — there is no operator-facing path onto
 * this pipeline anywhere else, same posture every other 14a/19e/20d
 * config function's own header already states.
 */
export function graduateToLiveGenesis(agentAddress: string): void {
  const check = checkRolloutGraduationEligibility(agentAddress);
  if (!check.eligible) {
    throw new Error(check.reason ?? `root agent ${agentAddress} is not eligible to graduate`);
  }
  db.prepare(
    `INSERT INTO expansion_pipeline_config (agent_address, rollout_stage)
     VALUES (@agent_address, 'live_enabled')
     ON CONFLICT(agent_address) DO UPDATE SET rollout_stage = 'live_enabled'`,
  ).run({ agent_address: agentAddress });
  db.prepare(
    `INSERT INTO rollout_graduation_events (id, root_agent_address, event_type, reason, dry_run_packet_count, occurred_at)
     VALUES (@id, @root_agent_address, 'graduated', @reason, @dry_run_packet_count, @occurred_at)`,
  ).run({
    id: `rge_${ulid()}`,
    root_agent_address: agentAddress,
    reason: `graduated after ${check.dryRunPacketCount} dry-run genesis packet(s), per Zent.md 20d`,
    dry_run_packet_count: check.dryRunPacketCount,
    occurred_at: Date.now(),
  });
}

/**
 * Regression path — demotes an already-graduated root back to
 * 'dry_run_only'. Not called from anywhere in Zent.md's own 20d text
 * (which only describes the forward path), added as defense-in-depth
 * alongside 19c's circuit breaker: haltExpansionPipeline()
 * (expansionCircuitBreaker.ts) calls this too, so a root that regresses
 * badly enough to trip the circuit breaker after graduating doesn't
 * merely pause new spawns — it also loses the live-genesis privilege
 * until it re-earns it via checkRolloutGraduationEligibility() again
 * (which, per that function's own halted-check, cannot pass while the
 * breaker is still tripped anyway). A root that is already
 * 'dry_run_only' is a harmless no-op (no duplicate event written) —
 * mirrors resumeExpansionPipeline()'s own idempotent-delete shape.
 */
export function demoteToDryRunOnly(agentAddress: string, reason: string): void {
  if (!agentAddress) {
    throw new Error("agentAddress is required");
  }
  if (getRolloutStage(agentAddress) !== "live_enabled") {
    return;
  }
  const dryRunPacketCount = (
    db
      .prepare(`SELECT COUNT(*) as n FROM dry_run_genesis_packets WHERE agent_address = ?`)
      .get(agentAddress) as { n: number }
  ).n;
  db.prepare(
    `INSERT INTO expansion_pipeline_config (agent_address, rollout_stage)
     VALUES (@agent_address, 'dry_run_only')
     ON CONFLICT(agent_address) DO UPDATE SET rollout_stage = 'dry_run_only'`,
  ).run({ agent_address: agentAddress });
  db.prepare(
    `INSERT INTO rollout_graduation_events (id, root_agent_address, event_type, reason, dry_run_packet_count, occurred_at)
     VALUES (@id, @root_agent_address, 'demoted', @reason, @dry_run_packet_count, @occurred_at)`,
  ).run({
    id: `rge_${ulid()}`,
    root_agent_address: agentAddress,
    reason,
    dry_run_packet_count: dryRunPacketCount,
    occurred_at: Date.now(),
  });
}

export function listRolloutGraduationEvents(
  agentAddress: string,
): { id: string; eventType: "graduated" | "demoted"; reason: string; dryRunPacketCount: number; occurredAt: number }[] {
  const rows = db
    .prepare(
      `SELECT id, event_type as eventType, reason, dry_run_packet_count as dryRunPacketCount, occurred_at as occurredAt
       FROM rollout_graduation_events WHERE root_agent_address = ? ORDER BY occurred_at ASC`,
    )
    .all(agentAddress) as {
    id: string;
    eventType: "graduated" | "demoted";
    reason: string;
    dryRunPacketCount: number;
    occurredAt: number;
  }[];
  return rows;
}

/**
 * Files (or, on a resubmit, updates) one department's rebuttal/concur
 * for one opportunity. Does not itself check isDeliberationEnabled() —
 * same "the write primitive doesn't re-decide policy the read/gate
 * layer already owns" split isEligibleForExpansion() vs.
 * createOpportunityReport() already draws elsewhere in this file; a
 * department calling this while deliberation is disabled for its agent
 * still gets a filed response (harmless — getDeliberationExchange()
 * below only ever surfaces responses when `enabled` is true), rather
 * than a confusing error about a config flag the write route itself
 * would otherwise have to re-check.
 */
export function recordDeliberationResponse(
  opportunityId: string,
  department: DeliberationDepartment,
  position: DeliberationPosition,
  responseText: string,
  respondingTo: readonly DeliberationDepartment[] = DELIBERATION_DEPARTMENTS.filter((d) => d !== department),
): DeliberationResponse {
  if (!isValidDeliberationDepartment(department)) {
    throw new Error(`invalid department: ${String(department)}`);
  }
  if (!isValidDeliberationPosition(position)) {
    throw new Error(`invalid position: ${String(position)}`);
  }
  if (!responseText || !responseText.trim()) {
    throw new Error("responseText is required");
  }
  if (!getOpportunity(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const row: DeliberationResponseRow = {
    id: `delib_${ulid()}`,
    opportunity_id: opportunityId,
    department,
    position,
    response_text: responseText.trim(),
    responding_to: JSON.stringify(respondingTo),
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO deliberation_responses (id, opportunity_id, department, position, response_text, responding_to, created_at)
     VALUES (@id, @opportunity_id, @department, @position, @response_text, @responding_to, @created_at)
     ON CONFLICT(opportunity_id, department) DO UPDATE SET
       position = excluded.position,
       response_text = excluded.response_text,
       responding_to = excluded.responding_to,
       created_at = excluded.created_at`,
  ).run(row);
  return hydrateDeliberationResponse(
    db
      .prepare(`SELECT * FROM deliberation_responses WHERE opportunity_id = ? AND department = ?`)
      .get(opportunityId, department) as DeliberationResponseRow,
  );
}

export function listDeliberationResponses(opportunityId: string): DeliberationResponse[] {
  const rows = db
    .prepare(`SELECT * FROM deliberation_responses WHERE opportunity_id = ? ORDER BY created_at ASC`)
    .all(opportunityId) as DeliberationResponseRow[];
  return rows.map(hydrateDeliberationResponse);
}

export interface DeliberationExchange {
  /** This opportunity's owning agent's current 14a config — read fresh
   *  on every call, never cached. */
  enabled: boolean;
  responses: DeliberationResponse[];
  respondedDepartments: readonly DeliberationDepartment[];
  /** Only meaningful when `enabled` is true — empty whenever `enabled`
   *  is false, same "no bearing either way" treatment
   *  CommitteePacketCompleteness gives highRegulatoryRisk (13e). */
  missingDepartments: readonly DeliberationDepartment[];
  /** True whenever this exchange is not blocking the packet from
   *  locking: either the pass is disabled (nothing to wait for), or it's
   *  enabled and all three departments have responded. False only when
   *  enabled AND at least one department is still outstanding. Named
   *  `locked`, not `complete`, to keep this distinct from
   *  CommitteePacketCompleteness.complete (13e) — that field is about
   *  whether Research/Finance/Strategy have filed *reports* at all;
   *  this one is about whether the optional deliberation *pass* over
   *  those already-filed reports is done. An opportunity can be
   *  complete but not locked (all three reports exist, deliberation
   *  enabled, nobody's rebutted yet) or locked but not complete
   *  (deliberation disabled, Research hasn't even run) — the two gates
   *  are independent, same as completeness and highRegulatoryRisk
   *  already are within 13e. */
  locked: boolean;
}

/**
 * Derives Phase 14a's deliberation verdict for `opportunityId`. Reads
 * isDeliberationEnabled() for the opportunity's own owning agent
 * (resolved via its opportunity_report, same lookup
 * recordCannibalizationCheck()'s callers already do elsewhere in this
 * file) and listDeliberationResponses() for the opportunity itself, so
 * — unlike computeFinanceStrategyDisagreement()/
 * computeCommitteePacketCompleteness() just above, which are pure
 * functions over an already-assembled packet's fields — this one does
 * its own DB reads, the same way compileResearchReport() and its
 * siblings do (this pass has no report-shaped table of its own for
 * assembleCommitteePacket() to have already compiled a moment earlier).
 *
 * Throws on an unknown opportunity_id, matching every other
 * opportunity-scoped read in this file.
 */
export function getDeliberationExchange(opportunityId: string): DeliberationExchange {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const report = getOpportunityReport(opportunity.report_id);
  if (!report) {
    throw new Error(`opportunity_report ${opportunity.report_id} not found`);
  }
  const enabled = isDeliberationEnabled(report.agent_address);
  const responses = listDeliberationResponses(opportunityId);
  const respondedDepartments = responses.map((r) => r.department);
  const missingDepartments = enabled
    ? DELIBERATION_DEPARTMENTS.filter((d) => !respondedDepartments.includes(d))
    : [];
  return {
    enabled,
    responses,
    respondedDepartments,
    missingDepartments,
    locked: !enabled || missingDepartments.length === 0,
  };
}

/**
 * requireLockedCommitteePacket(opportunity_id) — Phase 14a's own
 * "before the packet locks" enforcement point, built ahead of its own
 * caller the same way requireCompleteCommitteePacket() (13e) was:
 * Phase 15's decide_expansion route (still not built) is the intended
 * caller for both, and this file's convention is that the CEO gate is
 * where every "cannot [proceed] until..." wording in Zent.md actually
 * gets enforced, not the plain assembly/read functions themselves.
 * Composes with 13e's own gate rather than replacing it — a packet that
 * is complete (13e) but not yet locked (14a, deliberation enabled and
 * outstanding) still throws here, and vice versa.
 */
export function requireLockedCommitteePacket(opportunityId: string): CommitteePacket {
  const packet = requireCompleteCommitteePacket(opportunityId);
  if (!packet.deliberation.locked) {
    throw new Error(
      `committee packet for opportunity ${opportunityId} has not locked — awaiting deliberation from: ${packet.deliberation.missingDepartments.join(", ")}`,
    );
  }
  return packet;
}

// ─── Phase 14b/14c: Expansion Committee — Votes & Conditions ───────────
//
// Zent.md 14b: "Vote/recommendation field per department: recommend /
// recommend-with-conditions / do-not-recommend, distinct from their
// numeric scores — forces a clear position." 14c: "Conditions capture:
// 'recommend, but cap initial funding at $X' is a first-class field the
// CEO gate can read, not free text to parse."
//
// Four departments here, not three: Zent.md 13a's own "four-report
// bundle" wording already counts Opportunity Intelligence's own output
// as the fourth report alongside Research/Finance/Strategy (see
// CommitteePacket's own header) — voting follows the same count, and
// 14e's "full four-department happy-path" fixture is the confirmation
// that reading is correct, not a three-department one.
//
// "Distinct from their numeric scores" is why this is its own table
// (department_votes) rather than a column bolted onto
// research_findings/finance_findings/strategy_findings/opportunities:
// none of those four rows' own scoring fields (fit_score, roi_score,
// the sizing recommendation, ...) are touched by this phase — a
// department's numeric output and its vote are two independent things
// that happen to usually agree, and this pipeline's own incentive note
// (Zent.md's closing section) is exactly why they're not derived from
// each other in code.
export const VOTE_DEPARTMENTS = [
  "opportunity_intelligence",
  "research",
  "finance",
  "strategy",
] as const;
export type VoteDepartment = (typeof VOTE_DEPARTMENTS)[number];

export function isValidVoteDepartment(value: unknown): value is VoteDepartment {
  return typeof value === "string" && (VOTE_DEPARTMENTS as readonly string[]).includes(value);
}

export const VOTE_VALUES = ["recommend", "recommend-with-conditions", "do-not-recommend"] as const;
export type VoteValue = (typeof VOTE_VALUES)[number];

export function isValidVoteValue(value: unknown): value is VoteValue {
  return typeof value === "string" && (VOTE_VALUES as readonly string[]).includes(value);
}

export interface DepartmentVote {
  id: string;
  opportunityId: string;
  department: VoteDepartment;
  vote: VoteValue;
  /** 14c's first-class field — non-null if and only if `vote` is
   *  'recommend-with-conditions', enforced by recordDepartmentVote()
   *  below, not left to a caller's discipline. */
  conditions: string | null;
  createdAt: number;
}

interface DepartmentVoteRow {
  id: string;
  opportunity_id: string;
  department: string;
  vote: string;
  conditions: string | null;
  created_at: number;
}

function hydrateDepartmentVote(row: DepartmentVoteRow): DepartmentVote {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    department: row.department as VoteDepartment,
    vote: row.vote as VoteValue,
    conditions: row.conditions,
    createdAt: row.created_at,
  };
}

/**
 * Files (or, on a resubmit, replaces) one department's vote for one
 * opportunity. Enforces 14c's own rule at the one chokepoint every
 * caller goes through, rather than trusting each caller to get it
 * right: `conditions` is REQUIRED (non-empty) when `vote` is
 * 'recommend-with-conditions', and FORBIDDEN otherwise — a plain
 * 'recommend' or 'do-not-recommend' vote with a conditions string
 * attached would defeat 14c's own "first-class field, not free text"
 * point by giving conditions a way to sneak in unlabeled.
 */
export function recordDepartmentVote(
  opportunityId: string,
  department: VoteDepartment,
  vote: VoteValue,
  conditions?: string | null,
): DepartmentVote {
  if (!isValidVoteDepartment(department)) {
    throw new Error(`invalid department: ${String(department)}`);
  }
  if (!isValidVoteValue(vote)) {
    throw new Error(`invalid vote: ${String(vote)}`);
  }
  const trimmedConditions = typeof conditions === "string" ? conditions.trim() : null;
  if (vote === "recommend-with-conditions" && !trimmedConditions) {
    throw new Error("conditions is required for a recommend-with-conditions vote");
  }
  if (vote !== "recommend-with-conditions" && trimmedConditions) {
    throw new Error("conditions is only valid for a recommend-with-conditions vote");
  }
  if (!getOpportunity(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const row: DepartmentVoteRow = {
    id: `vote_${ulid()}`,
    opportunity_id: opportunityId,
    department,
    vote,
    conditions: vote === "recommend-with-conditions" ? trimmedConditions : null,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO department_votes (id, opportunity_id, department, vote, conditions, created_at)
     VALUES (@id, @opportunity_id, @department, @vote, @conditions, @created_at)
     ON CONFLICT(opportunity_id, department) DO UPDATE SET
       vote = excluded.vote,
       conditions = excluded.conditions,
       created_at = excluded.created_at`,
  ).run(row);
  return hydrateDepartmentVote(
    db
      .prepare(`SELECT * FROM department_votes WHERE opportunity_id = ? AND department = ?`)
      .get(opportunityId, department) as DepartmentVoteRow,
  );
}

export function listDepartmentVotes(opportunityId: string): DepartmentVote[] {
  const rows = db
    .prepare(`SELECT * FROM department_votes WHERE opportunity_id = ? ORDER BY created_at ASC`)
    .all(opportunityId) as DepartmentVoteRow[];
  return rows.map(hydrateDepartmentVote);
}

// ─── Phase 14d: Expansion Committee — Vote Timeout Handling ────────────
//
// Zent.md 14d: "Timeout handling: a department that doesn't respond
// within its budgeted ticks doesn't block the packet forever — it's
// marked no-response and the packet proceeds with that noted."
export type VoteStatus = "voted" | "pending" | "no-response";

export interface DepartmentVoteStatus {
  department: VoteDepartment;
  status: VoteStatus;
  /** Null exactly when status is 'pending' or 'no-response' — mirrors
   *  the "field present, individually nullable" contract every report
   *  section in this file already gives its own not-yet-filed pieces
   *  (e.g. ResearchReport's marketSize). */
  vote: DepartmentVote | null;
}

export interface CommitteeVotingRecord {
  /** Wall-clock deadline this record was evaluated against — null when
   *  the opportunity hasn't been selected yet (Phase 3d's selected_at
   *  is null), since there's no "budgeted ticks" clock to have started
   *  running yet. See this section's own header in config.ts
   *  (expansionVoteTimeoutMs) for why elapsed-time-since-selection,
   *  not a per-department tick counter, is what this budget is against. */
  deadlineAt: number | null;
  statuses: DepartmentVoteStatus[];
  /** True once every department is either 'voted' or 'no-response' —
   *  i.e. nothing is still 'pending' that could still change the
   *  outcome. Named distinctly from CommitteePacketCompleteness.complete
   *  (13e, reports exist) and DeliberationExchange.locked (14a,
   *  deliberation pass done) — this is a third, independent gate: has
   *  every department taken (or run out the clock on) a position. */
  readyForDecision: boolean;
}

/**
 * Derives Phase 14d's per-department vote status, then rolls it up into
 * Phase 14b/14c's own CommitteeVotingRecord for `opportunityId`. Like
 * getDeliberationExchange() (14a), this does its own DB reads rather
 * than taking an already-assembled packet's fields — votes have no
 * report-shaped table of their own for assembleCommitteePacket() to
 * have already compiled a moment earlier.
 *
 * "No-response" is derived, never stored: a department that times out
 * and then votes anyway a moment later reads back 'voted' on the very
 * next call, the same "recomputed from current state on every call"
 * posture every other packet-level field in this file already takes —
 * there is no separate no-response row this function has to reconcile
 * against a late vote.
 */
export function getVotingRecord(opportunityId: string): CommitteeVotingRecord {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const votes = listDepartmentVotes(opportunityId);
  const votesByDepartment = new Map(votes.map((v) => [v.department, v]));
  const deadlineAt =
    opportunity.selected_at === null ? null : opportunity.selected_at + config.expansionVoteTimeoutMs;
  const timedOut = deadlineAt !== null && Date.now() > deadlineAt;

  const statuses: DepartmentVoteStatus[] = VOTE_DEPARTMENTS.map((department) => {
    const vote = votesByDepartment.get(department) ?? null;
    const status: VoteStatus = vote ? "voted" : timedOut ? "no-response" : "pending";
    return { department, status, vote };
  });

  return {
    deadlineAt,
    statuses,
    readyForDecision: statuses.every((s) => s.status !== "pending"),
  };
}

/**
 * Assembles the committee packet for `opportunityId`: a fresh read of
 * Opportunity Intelligence's own report (the opportunity row) alongside
 * Research's, Finance's, and Strategy's currently-compiled reports, all
 * four bundled into one object under Phase 13b's locked
 * COMMITTEE_PACKET_SCHEMA_VERSION contract. Pure read — nothing is
 * written, nothing is spawned, nothing is torn down; calling this twice
 * in a row for the same opportunity_id with no findings written in
 * between returns two packets that are identical except for
 * `assembledAt`, the same idempotent-read property every
 * compile*Report() function it calls already has individually.
 *
 * Throws on an unknown opportunity_id, same "fail fast with a clear
 * message" posture every compile*Report() function already uses (and
 * which this function delegates to for three of its four sections) —
 * there is no such thing as a committee packet for an opportunity that
 * doesn't exist. A *known* opportunity with some or all of
 * Research/Finance/Strategy not yet run is NOT an error: each of those
 * sections reads back its own all-null report, exactly as if a caller
 * had hit that department's own GET route directly. Whether a packet
 * with missing sections is fit for the CEO to actually rule on is 13e's
 * completeness gate's question, not this function's — this function's
 * only job is "assemble whatever currently exists" (13d's route takes
 * that same packet as-is; requireCompleteCommitteePacket(), 13e's own
 * gate below, is the one that actually enforces readiness on top of
 * what this function returns).
 */
export function assembleCommitteePacket(opportunityId: string): CommitteePacket {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  // Each of these three already re-validates its own report against its
  // own locked shape before returning (see compileResearchReport()/
  // compileFinanceReport()/compileStrategyReport()'s own headers) — this
  // function doesn't re-check them a second time, the same "trust the
  // one chokepoint every caller already goes through" posture the GET
  // /research, /finance, and /strategy routes themselves take toward
  // these same three functions.
  const researchReport = compileResearchReport(opportunityId);
  const financeReport = compileFinanceReport(opportunityId);
  const strategyReport = compileStrategyReport(opportunityId);
  const packet: CommitteePacket = {
    opportunityId,
    assembledAt: Date.now(),
    schemaVersion: COMMITTEE_PACKET_SCHEMA_VERSION,
    opportunityIntelligence: opportunity,
    researchReport,
    financeReport,
    strategyReport,
    // Phase 13c: computed fresh from this same call's financeReport/
    // strategyReport above, never stored — the same "recomputed from
    // current state on every call" posture the rest of this packet
    // already has.
    financeStrategyDisagreement: computeFinanceStrategyDisagreement(financeReport, strategyReport),
    // Phase 13e: computed fresh from this same call's three reports plus
    // the opportunity read at the top of this function — never stored,
    // same "recomputed from current state on every call" posture as
    // financeStrategyDisagreement immediately above.
    completeness: computeCommitteePacketCompleteness({
      researchReport,
      financeReport,
      strategyReport,
      opportunityIntelligence: opportunity,
    }),
    // Phase 14a: unlike financeStrategyDisagreement/completeness above,
    // this one isn't derived from this same call's three reports — it
    // has its own DB reads (the agent's deliberation_enabled config, and
    // any deliberation_responses filed for this opportunity) — see
    // getDeliberationExchange()'s own header for why.
    deliberation: getDeliberationExchange(opportunityId),
    // Phase 14b/14c/14d: same own-DB-reads posture as deliberation
    // immediately above — votes have no report-shaped table of their
    // own for this function to have already compiled a moment earlier.
    votingRecord: getVotingRecord(opportunityId),
  };
  // Same enforcement-not-decoration posture compileResearchReport()/
  // compileFinanceReport()/compileStrategyReport() each already take
  // toward their own locked shape: check this bundle against its own
  // contract before it leaves this function. Can never fail today (the
  // object literal above is built from COMMITTEE_PACKET_FIELDS by
  // construction) — it exists so a later drift (a renamed field, a
  // dropped section) fails loud here, at the one chokepoint every
  // caller of assembleCommitteePacket() already goes through, rather
  // than surfacing downstream as a CEO model silently misreading an
  // unversioned or malformed packet.
  const shapeCheck = validateCommitteePacketShape(packet);
  if (!shapeCheck.valid) {
    throw new Error(
      `assemble_committee_packet produced a packet that violates its own locked schema: ${shapeCheck.errors.join("; ")}`,
    );
  }
  return packet;
}

// ─── Phase 15a: CEO Decision Layer — decide_expansion ───────────────────
//
// Zent.md 15a: "CEO role clarified in code as the top-level agent itself
// (not a new department) acting on a specific tool call,
// decide_expansion(opportunity_id, decision, notes) — the CEO does not
// invent opportunities, only rules on packets, matching the chat spec
// exactly."
//
// "The top-level agent itself (not a new department)" is why this
// function takes a caller agentAddress at all: there is no `ceo`
// department type in toolRegistry.ts (unlike opportunity_intelligence/
// research/finance/strategy) and none is added here — the CEO is
// whichever agent owns this pipeline, calling a tool, not a department
// this pipeline spawns and tears down the way Research (Phase 5a) is.
// That agentAddress is recorded as `decided_by` (1d) so the ruling has
// an owner on file; it is NOT checked against the opportunity's owning
// report here — "requires the calling agent_address to match the
// top-level agent that owns the whole pipeline" is Zent.md 15b's own
// wording, and 15b is an HTTP-route concern (expansionRoutes.ts), not
// this data/tool-layer function's — same split every other write in
// this file draws (setOpportunityStatus (4c), recordDepartmentVote
// (14b)) between a caller identity/id the function acts on and "does
// this caller own this," which the route in front of it checks before
// ever calling in. A caller that isn't authorized to rule on this
// opportunity is 15b's problem to reject, not this function's.
//
// "Only rules on packets" is enforced by construction, not a separate
// check: decide_expansion never creates an opportunity, a finding, or a
// vote — it reads whatever committee packet already exists for
// opportunityId (via requireDecidableCommitteePacket below) and writes
// exactly one ruling against it. An unknown opportunity_id fails the
// same way every other opportunity-scoped call in this file already
// fails (assembleCommitteePacket's own not-found throw, propagated up
// through every require*CommitteePacket wrapper) — there is no path by
// which calling this function conjures a new opportunity into being.
//
// requireCompleteCommitteePacket (13e) and requireLockedCommitteePacket
// (14a) were each built "ahead of their own caller," both explicitly
// naming this not-yet-built decide_expansion route as that caller (see
// their own header comments) — this is that caller, finally landing.
export interface DecideExpansionSnapshot {
  /** Free-text rationale the CEO attaches to this specific ruling — the
   *  `notes` argument from Zent.md's own decide_expansion(opportunity_id,
   *  decision, notes) signature. Trimmed, empty-string-becomes-null the
   *  same way 14c's own `conditions` field normalizes its free text.
   *  Nowhere else in this pipeline has a place for this — expansion_
   *  decisions (1d) deliberately left committee_votes' shape unlocked
   *  for exactly this kind of later-phase addition (see that table's
   *  own db.ts comment), so notes rides inside the same JSON blob
   *  rather than requiring a schema migration for one nullable string. */
  notes: string | null;
  /** The bundle-level verdicts the packet itself already computed
   *  (13c/13e/14a/14d), copied in at decision time so a later reader of
   *  this specific ExpansionDecision row sees exactly what the CEO saw
   *  on the tick it ruled — not whatever those same fields compute to
   *  if re-derived later (a department could, in principle, re-run and
   *  supersede its finding after this decision is recorded; findings
   *  are additive history, not locked once a decision references them).
   *  This is what "true history" (1d's own phrase for this table) means
   *  for a bundle-shaped input, not just the scalar decision itself. */
  financeStrategyDisagreement: FinanceStrategyDisagreement;
  completeness: CommitteePacketCompleteness;
  deliberation: DeliberationExchange;
  votingRecord: CommitteeVotingRecord;
}

export interface DecideExpansionResult {
  decision: ExpansionDecision<DecideExpansionSnapshot>;
  /** The exact packet the decision was ruled against — same "hand back
   *  what was actually acted on" posture recordDepartmentVote() (14b)
   *  gives its own caller by returning the fresh DepartmentVote row. */
  packet: CommitteePacket;
  /** Phase 15d: non-null only for an `approved` ruling made while 19e
   *  dry-run mode was OFF for this opportunity's agent — the genesis
   *  trigger fired synchronously, inline, as part of this same call,
   *  with no operator/human gate in between. Always null for
   *  `rejected`/`deferred` (which never fire genesis) and for an
   *  `approved` ruling made while dry-run mode was ON (see
   *  `dryRunPacket` instead — the two are mutually exclusive for any
   *  single decision). See fireGenesisTrigger() below for what "fired"
   *  means today, ahead of Phase 16's real provisioning code. */
  genesisTrigger: GenesisTriggerRecord | null;
  /** Phase 19e: non-null only for an `approved` ruling made while
   *  dry-run mode was ON for this opportunity's agent. The pipeline ran
   *  Phases 2–15 to completion exactly as it would for a real
   *  provisioning call, and this is the genesis-ready packet that
   *  *would* have been handed to the real Phase 16 genesisExecutor —
   *  but no executor was ever invoked, and fireGenesisTrigger() never
   *  ran, so no genesis_triggers row exists for this decision and no
   *  funding was spent. Always null when `genesisTrigger` is non-null,
   *  and vice versa. */
  dryRunPacket: DryRunGenesisPacketRecord | null;
}

/**
 * requireDecidableCommitteePacket(opportunity_id) — composes
 * requireLockedCommitteePacket() (13e completeness + 14a deliberation
 * lock) with one further condition: Phase 14d's own votingRecord.
 * readyForDecision, the field its own header names for exactly this
 * ("nothing is still 'pending' that could still change the outcome").
 * A packet can be complete (13e) and locked (14a) while a department's
 * 14b vote is still outstanding and hasn't timed out yet — those are
 * three independent gates (this file's own CommitteeVotingRecord header
 * says as much), and decide_expansion is where all three finally have
 * to hold at once, the same "the CEO gate is where every 'cannot
 * [proceed] until...' wording in Zent.md actually gets enforced"
 * convention requireLockedCommitteePacket()'s own header already
 * states. 14d's whole point — a timed-out department reads back
 * 'no-response' rather than blocking forever — is what keeps this gate
 * from being able to stall a packet indefinitely; it does not weaken it
 * before that deadline passes.
 */
export function requireDecidableCommitteePacket(opportunityId: string): CommitteePacket {
  const packet = requireLockedCommitteePacket(opportunityId);
  if (!packet.votingRecord.readyForDecision) {
    const stillPending = packet.votingRecord.statuses
      .filter((s) => s.status === "pending")
      .map((s) => s.department);
    throw new Error(
      `committee packet for opportunity ${opportunityId} is not ready for a decision — still awaiting a vote (or timeout) from: ${stillPending.join(", ")}`,
    );
  }
  return packet;
}

/**
 * decide_expansion(opportunity_id, decision, notes) — Zent.md 15a's own
 * tool, matching that exact signature (decidedBy inserted as this
 * function's own second positional argument, not part of the chat
 * spec's three — see this section's header for why the caller identity
 * still has to travel with the call somehow). Validates `decision`
 * against the same VALID_DECISIONS (1d) used by recordExpansionDecision
 * itself, gates on requireDecidableCommitteePacket() above, snapshots
 * the packet's own bundle-level verdicts plus `notes` into 1d's
 * unlocked-shape committee_votes JSON, and records exactly one
 * ExpansionDecision row.
 *
 * Phase 15c — `approved` / `rejected` / `deferred` handling, folded into
 * this function rather than a separate wrapper (same "the gate lives
 * where the write happens" posture requireDecidableCommitteePacket()
 * above already takes):
 *   - `deferred` is the one ruling that keeps this opportunity's
 *     decision layer open. Nothing special happens for it beyond being
 *     recorded as the newest row — a later decide_expansion call for the
 *     same opportunityId, without anything upstream (research/finance/
 *     strategy) re-running, IS the "re-queues for a later CEO tick
 *     without re-running the departments (cheap re-review, not a full
 *     re-run)" Zent.md 15c describes: it re-walks
 *     requireDecidableCommitteePacket() below, which is cheap (three DB
 *     reads + recomputed bundle fields), never a department re-run.
 *   - `approved` and `rejected` are terminal (CEO_TERMINAL_DECISIONS
 *     above): once either is recorded, a further decide_expansion call
 *     for the same opportunityId throws instead of recording a second
 *     ruling. Without this, nothing would stop an `approved` from being
 *     followed by a `rejected` (or a second `approved`, double-firing
 *     Phase 16 genesis once that phase exists) — the CEO's ruling has
 *     to actually be final for "approved fires genesis directly, no
 *     operator gate" (15d) to mean anything.
 *   - `rejected` additionally moves the opportunity itself to
 *     OpportunityStatus 'rejected' via setOpportunityStatus() (4c) —
 *     the same terminal status an agent's own manual reject action
 *     already writes, so a CEO-rejected opportunity reads identically
 *     downstream (GET /opportunities, 3d's sweep) to one rejected any
 *     other way, rather than sitting at 'selected' forever with only a
 *     decisions-table row to show for it. `approved` deliberately does
 *     NOT touch status here — Phase 16's genesis path is what actually
 *     retires it; this function's job stays recording + finality, not
 *     provisioning.
 *
 * Phase 15d — folded in the same way 15c was: `approved` fires
 *   fireGenesisTrigger() (below) synchronously, inline, in this same
 *   call, immediately after the decision row is recorded and before
 *   this function returns. There is no further call anyone — CEO agent,
 *   department, or operator — has to make first; "the CEO agent's call
 *   is final" (Zent.md 15d) means this function's own return is the end
 *   of the human-facing decision path. See fireGenesisTrigger()'s own
 *   header for what firing means today, ahead of Phase 16's real
 *   provisioning code existing.
 *
 * Deliberately NOT implemented here (later sub-phases, same
 * one-focused-deliverable-per-letter discipline this file follows):
 *   - 15b: the calling agent_address must own this opportunity's
 *     pipeline — an HTTP-route authorization check, not this function's.
 *   - 15e: the full audit-trail bundle. listExpansionDecisions()/
 *     getExpansionDecision() (1d) already expose the raw history this
 *     function writes into; 15e (getExpansionAuditBundle(), near the
 *     bottom of this file) is what presents it, not this function.
 */
export function decideExpansion(
  opportunityId: string,
  decision: CeoDecision,
  decidedBy: string,
  notes: string | null = null,
): DecideExpansionResult {
  if (!VALID_DECISIONS.includes(decision)) {
    throw new Error(`decision must be one of ${VALID_DECISIONS.join(", ")}, got "${decision}"`);
  }
  if (!decidedBy) {
    throw new Error("decidedBy is required");
  }
  // Phase 15c finality gate — checked before the (more expensive)
  // packet-readiness gate below, so a re-ruling attempt on an already-
  // decided opportunity fails with a clear "already decided" message
  // rather than an incidental packet-shape complaint. `deferred` is the
  // only prior ruling that lets this call proceed.
  const priorDecision = getLatestExpansionDecision<DecideExpansionSnapshot>(opportunityId);
  if (priorDecision && isTerminalCeoDecision(priorDecision.ceo_decision)) {
    throw new Error(
      `opportunity ${opportunityId} already has a final CEO ruling (${priorDecision.ceo_decision}, decided ${new Date(priorDecision.decided_at).toISOString()}) — decide_expansion cannot rule on it again`,
    );
  }
  // Throws (unknown opportunity, incomplete packet, unlocked
  // deliberation, or a still-pending vote) before anything is written —
  // same "gate before write, never a partial ruling" posture every
  // other require*CommitteePacket() caller in this file already takes.
  const packet = requireDecidableCommitteePacket(opportunityId);
  const trimmedNotes = typeof notes === "string" ? notes.trim() : "";
  const snapshot: DecideExpansionSnapshot = {
    notes: trimmedNotes ? trimmedNotes : null,
    financeStrategyDisagreement: packet.financeStrategyDisagreement,
    completeness: packet.completeness,
    deliberation: packet.deliberation,
    votingRecord: packet.votingRecord,
  };
  const recorded = recordExpansionDecision<DecideExpansionSnapshot>(
    opportunityId,
    decision,
    decidedBy,
    snapshot,
  );
  let genesisTrigger: GenesisTriggerRecord | null = null;
  let dryRunPacket: DryRunGenesisPacketRecord | null = null;
  if (decision === "rejected") {
    // Idempotent + always a valid transition regardless of current
    // status (OPPORTUNITY_TRANSITIONS allows both open->rejected and
    // selected->rejected — see 4c's own table above) — never throws.
    setOpportunityStatus(opportunityId, "reject");
  } else if (decision === "approved") {
    // Phase 19e/20d: read fresh, right at ruling time — not cached onto
    // the opportunity/packet/decision anywhere earlier in the pipeline
    // (see isDryRunModeEnabled()'s and isDryRunModeEffective()'s own
    // headers for why that's deliberate). This is the one fork in
    // Zent.md 15d's otherwise unconditional "approved fires genesis
    // directly": with dry-run mode effectively on — either the agent's
    // own 19e toggle, or 20d's rollout_stage not yet graduated — the
    // CEO's ruling is still final and still recorded above, but what
    // fires differs — a genesis-ready packet instead of the real
    // genesisExecutor.
    const agentAddress = resolveOpportunityAgentAddress(opportunityId);
    if (isDryRunModeEffective(agentAddress)) {
      dryRunPacket = recordDryRunGenesisPacket(opportunityId, recorded, packet, agentAddress);
    } else {
      // Phase 15d — no operator gate between decision and
      // provisioning: fired unconditionally, synchronously, right
      // here, before this function returns. See fireGenesisTrigger()'s
      // own header.
      genesisTrigger = fireGenesisTrigger(opportunityId, recorded, packet);
    }
  }
  return { decision: recorded, packet, genesisTrigger, dryRunPacket };
}

// ─── Phase 15d: `approved` fires genesis directly, no operator gate ────
//
// Zent.md 15d: "approved fires genesis (Phase 16) directly — no
// operator gate between decision and provisioning; the CEO agent's call
// is final."
//
// Phase 16 (genesis_company() itself — the real wallet/sandbox/funding/
// constitution provisioning that wraps spawn_clone) does not exist in
// this codebase yet — 9b's own header already calls this out ("Phase 16
// wires the genesis call itself... there is nothing yet to query"). So
// this phase's job is narrower than "spawn Agent B": it's wiring the
// one thing Zent.md actually specifies at THIS layer — that an approved
// ruling triggers provisioning inline, synchronously, with no human or
// operator confirmation step anywhere between the CEO's decision and
// the trigger firing — and leaving a real seam for Phase 16 to plug its
// actual provisioning logic into. Same "built ahead of its own caller"
// posture requireCompleteCommitteePacket (13e) and
// requireLockedCommitteePacket (14a) already took toward decide_expansion
// itself before it existed.
//
// GenesisExecutor is that seam: a single swappable function, defaulting
// to defaultGenesisExecutor() below, which does nothing beyond what
// recordGenesisTrigger() already wrote — there is no real provisioning
// code to call yet. Phase 16a replaces it with the real
// genesis_company() via setGenesisExecutor() at app wire-up time
// (index.ts), with zero changes required here or in decideExpansion()
// itself. Until Phase 16 lands, "fires genesis directly" means exactly
// what it can mean today: the trigger is recorded and invoked
// unconditionally and synchronously, in the same call that recorded the
// `approved` ruling — never queued behind a review step, never gated on
// any further action by the CEO agent, a department, or a person.

export type GenesisTriggerStatus = "pending" | "completed" | "failed";

/** What the current genesisExecutor is called with — everything Phase
 *  16a's eventual real implementation needs to actually provision
 *  Agent B without re-deriving it from opportunityId alone. */
export interface GenesisTriggerContext {
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
  /** Finance's own Phase 9b number (packet.financeReport.
   *  sizingRecommendation.recommendedFundingUsdc), carried along so
   *  Phase 16b's "Finance's sizing recommendation becomes the actual
   *  spawn_clone funding argument" has it ready without re-reading the
   *  packet. Null only if this opportunity somehow reached an approved
   *  ruling with no sizing recommendation ever filed —
   *  requireDecidableCommitteePacket() does not itself require one, the
   *  same per-field null tolerance every other FinanceReport section
   *  already has. */
  recommendedFundingUsdc: number | null;
  notes: string | null;
}

/** Shape as it actually sits in SQLite — see db.ts's Phase 15d table
 *  comment for the column-level reasoning. */
interface GenesisTriggerRow {
  id: string;
  opportunity_id: string;
  decision_id: string;
  agent_address: string;
  recommended_funding_usdc: number | null;
  status: string;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface GenesisTriggerRecord {
  id: string;
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
  recommendedFundingUsdc: number | null;
  status: GenesisTriggerStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

function hydrateGenesisTrigger(row: GenesisTriggerRow): GenesisTriggerRecord {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    decisionId: row.decision_id,
    agentAddress: row.agent_address,
    recommendedFundingUsdc: row.recommended_funding_usdc,
    status: row.status as GenesisTriggerStatus,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The one queryable row for an opportunity's genesis trigger, if any —
 *  15e's eventual audit-trail bundle reads this alongside
 *  getLatestExpansionDecision() to show "was genesis actually fired,
 *  and what happened." Exported so a future dashboard/route can read it
 *  directly, the same way listExpansionDecisions()/getExpansionDecision()
 *  (1d) are already exported for that purpose. */
export function getGenesisTrigger(opportunityId: string): GenesisTriggerRecord | undefined {
  const row = db.prepare(`SELECT * FROM genesis_triggers WHERE opportunity_id = ?`).get(
    opportunityId,
  ) as GenesisTriggerRow | undefined;
  return row ? hydrateGenesisTrigger(row) : undefined;
}

/** Insert-once via the table's own UNIQUE(opportunity_id) index. 15c's
 *  finality gate already stops a second `approved` ruling from ever
 *  reaching this function for the same opportunity, so the existing-row
 *  branch below should be unreachable in practice — guarded anyway
 *  rather than letting a raw SQLite constraint violation surface out of
 *  decideExpansion(). */
function recordGenesisTrigger(args: {
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
  recommendedFundingUsdc: number | null;
}): GenesisTriggerRecord {
  const existing = getGenesisTrigger(args.opportunityId);
  if (existing) {
    return existing;
  }
  const now = Date.now();
  const row: GenesisTriggerRow = {
    id: `gentrig_${ulid()}`,
    opportunity_id: args.opportunityId,
    decision_id: args.decisionId,
    agent_address: args.agentAddress,
    recommended_funding_usdc: args.recommendedFundingUsdc,
    status: "pending",
    error: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO genesis_triggers (id, opportunity_id, decision_id, agent_address, recommended_funding_usdc, status, error, created_at, updated_at)
     VALUES (@id, @opportunity_id, @decision_id, @agent_address, @recommended_funding_usdc, @status, @error, @created_at, @updated_at)`,
  ).run(row);
  return hydrateGenesisTrigger(row);
}

function markGenesisTriggerStatus(
  opportunityId: string,
  status: GenesisTriggerStatus,
  error: string | null = null,
): void {
  db.prepare(
    `UPDATE genesis_triggers SET status = @status, error = @error, updated_at = @updated_at WHERE opportunity_id = @opportunity_id`,
  ).run({ status, error, updated_at: Date.now(), opportunity_id: opportunityId });
}

/** Phase 16a's own hook: called once real provisioning actually
 *  finishes standing up Agent B. Nothing in this session calls it —
 *  exported now so Phase 16a doesn't need a matching db.ts/expansion.ts
 *  change of its own just to mark completion, the same "build the seam
 *  ahead of its caller" posture this whole section takes. */
export function markGenesisTriggerCompleted(opportunityId: string): void {
  markGenesisTriggerStatus(opportunityId, "completed");
}

export type GenesisExecutor = (ctx: GenesisTriggerContext) => void | Promise<unknown>;

/** The only executor that exists until Phase 16a lands. Does nothing —
 *  recordGenesisTrigger() (called before this runs, see
 *  fireGenesisTrigger() below) is the entire real effect today. This is
 *  not a human-approval gate: nothing is waiting on a person to look at
 *  the trigger row before it counts as "fired" — decideExpansion() has
 *  already fired it by the time this executor even runs. It is a
 *  placeholder for provisioning logic that doesn't exist yet, the same
 *  way `fullyFunded: false` on a SizingRecommendation describes
 *  underfunding without itself blocking anything. */
function defaultGenesisExecutor(_ctx: GenesisTriggerContext): void {
  // Intentionally empty — see this function's own header.
}

let genesisExecutor: GenesisExecutor = defaultGenesisExecutor;

/** Phase 16a's own hook to swap in the real genesis_company() once it
 *  exists, called once at app wire-up time (index.ts) — not per
 *  request. Also used by tests to inject a spy/mock without a real
 *  provisioning cascade (wallet creation, sandbox, funding transfer)
 *  running against this environment's in-memory/mirror DB. */
export function setGenesisExecutor(executor: GenesisExecutor): void {
  genesisExecutor = executor;
}

/** Test-only reset back to the do-nothing default, so one test's
 *  injected executor never leaks into the next. */
export function resetGenesisExecutor(): void {
  genesisExecutor = defaultGenesisExecutor;
}

/**
 * fireGenesisTrigger — the actual Phase 15d call site, invoked from
 * decideExpansion() the instant an `approved` ruling is recorded, and
 * from nowhere else. Composes:
 *
 *   1. recordGenesisTrigger() — an idempotent, one-per-opportunity fact
 *      (UNIQUE(opportunity_id), same dedup posture
 *      expansion_notifications (Phase 4d) already uses) that genesis
 *      was triggered, for which opportunity/decision, and with what
 *      funding number.
 *   2. Calls the current genesisExecutor unconditionally and
 *      synchronously, in the same stack frame — no operator
 *      confirmation, no queue a human has to drain, no second tool call
 *      required from the CEO agent. Zent.md 15d's "no operator gate
 *      between decision and provisioning," in full.
 *
 * If the executor throws (a real Phase 16 provisioning failure, once
 * that code exists — defaultGenesisExecutor() above never does), the
 * trigger row is marked 'failed' with the error message. The error is
 * deliberately swallowed here rather than re-thrown out of
 * decideExpansion(): the CEO's `approved` ruling is already recorded
 * and final (15c's finality gate does not get reconsidered because a
 * downstream provisioning attempt failed — a transient infra error
 * re-opening a CEO decision would be a worse outcome than a visible
 * 'failed' trigger row), and decideExpansion()'s existing contract
 * (throws only for decision-validity reasons — unknown opportunity,
 * incomplete packet, already-decided) stays intact for its route
 * caller. The failure is not lost: it's on the returned
 * GenesisTriggerRecord and via getGenesisTrigger(), for whatever
 * retries/alerting Phase 16/19 eventually build on top of 'failed'
 * rows.
 */
function fireGenesisTrigger(
  opportunityId: string,
  decision: ExpansionDecision<DecideExpansionSnapshot>,
  packet: CommitteePacket,
): GenesisTriggerRecord {
  const agentAddress = resolveOpportunityAgentAddress(opportunityId);
  const recommendedFundingUsdc =
    packet.financeReport.sizingRecommendation?.recommendedFundingUsdc ?? null;
  const trigger = recordGenesisTrigger({
    opportunityId,
    decisionId: decision.id,
    agentAddress,
    recommendedFundingUsdc,
  });
  try {
    const result = genesisExecutor({
      opportunityId,
      decisionId: decision.id,
      agentAddress,
      recommendedFundingUsdc,
      notes: decision.committee_votes.notes,
    });
    // Phase 16a note: genesisExecutor's declared type returns void, but
    // the real executor (genesis.ts's genesisExecutorAdapter) is async —
    // it returns a Promise once assigned via setGenesisExecutor(), which
    // this synchronous try/catch cannot observe. An unhandled rejection
    // here would otherwise (a) crash the process by default in modern
    // Node, and (b) leave the trigger row stuck at 'pending' forever
    // with no record of the failure — the worst outcome for a pipeline
    // with no operator watching for it. Attach a rejection handler
    // without awaiting: this keeps fireGenesisTrigger()'s own contract
    // (synchronous return, decideExpansion() unblocked) intact while
    // still recording an async provisioning failure once it lands.
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        markGenesisTriggerStatus(opportunityId, "failed", message);
      });
    }
    return trigger;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markGenesisTriggerStatus(opportunityId, "failed", message);
    return { ...trigger, status: "failed", error: message, updatedAt: Date.now() };
  }
}

// ─── Phase 19e: Full-Pipeline Dry-Run Mode ──────────────────────────────
//
// Zent.md 19e: "Full-pipeline dry-run mode: run Phases 2–15 to
// completion, produce a genesis-ready packet, but stop short of 16 —
// for testing the whole reasoning chain without actually spending
// funding."
//
// The pipeline itself does not branch anywhere upstream of this: every
// department, every scoring/finding/report function, the committee
// assembly, and requireDecidableCommitteePacket()'s own gates all run
// identically whether or not dry-run mode is on for the agent —
// "the whole reasoning chain" gets genuinely exercised, not a shortcut
// version of it. The only fork is the one decideExpansion() makes above,
// at the exact moment an `approved` ruling would otherwise call
// fireGenesisTrigger(): with dry-run mode on, recordDryRunGenesisPacket()
// below runs instead, and no genesisExecutor is ever invoked — "stop
// short of 16," precisely.

interface DryRunGenesisPacketRow {
  id: string;
  opportunity_id: string;
  decision_id: string;
  agent_address: string;
  recommended_funding_usdc: number | null;
  notes: string | null;
  committee_packet: string;
  created_at: number;
}

export interface DryRunGenesisPacketRecord {
  id: string;
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
  /** Same field, same source (packet.financeReport.sizingRecommendation.
   *  recommendedFundingUsdc), as GenesisTriggerContext.recommendedFundingUsdc
   *  on the real fire path — this is what Phase 16b would have clamped
   *  and funded Agent B with, had this been a real ruling. */
  recommendedFundingUsdc: number | null;
  notes: string | null;
  /** The full CommitteePacket the CEO ruled on, frozen at decision
   *  time — same "what the CEO actually saw" snapshot posture
   *  DecideExpansionSnapshot already gives expansion_decisions' own
   *  committee_votes column. This, plus the four fields above, is
   *  exactly Zent.md 19e's "genesis-ready packet." */
  committeePacket: CommitteePacket;
  createdAt: number;
}

function hydrateDryRunGenesisPacket(row: DryRunGenesisPacketRow): DryRunGenesisPacketRecord {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    decisionId: row.decision_id,
    agentAddress: row.agent_address,
    recommendedFundingUsdc: row.recommended_funding_usdc,
    notes: row.notes,
    committeePacket: JSON.parse(row.committee_packet) as CommitteePacket,
    createdAt: row.created_at,
  };
}

/**
 * recordDryRunGenesisPacket — the Phase 19e call site, invoked from
 * decideExpansion() the instant an `approved` ruling is recorded *and*
 * isDryRunModeEnabled() reads true for the opportunity's agent, and from
 * nowhere else. Deliberately does not call fireGenesisTrigger(),
 * recordGenesisTrigger(), or the genesisExecutor — no genesis_triggers
 * row is written for this decision, and no funding-spending code path
 * is ever reached, matching Zent.md 19e's "without actually spending
 * funding" exactly. Idempotent the same way fireGenesisTrigger()'s own
 * table is: UNIQUE(opportunity_id) on dry_run_genesis_packets means a
 * second call for the same opportunity throws rather than silently
 * double-recording — belt-and-braces alongside 15c's finality gate,
 * which already stops a second `approved` ruling from reaching this
 * function for the same opportunity in the first place.
 */
function recordDryRunGenesisPacket(
  opportunityId: string,
  decision: ExpansionDecision<DecideExpansionSnapshot>,
  packet: CommitteePacket,
  agentAddress: string,
): DryRunGenesisPacketRecord {
  const recommendedFundingUsdc =
    packet.financeReport.sizingRecommendation?.recommendedFundingUsdc ?? null;
  const row: DryRunGenesisPacketRow = {
    id: `dryrun_${ulid()}`,
    opportunity_id: opportunityId,
    decision_id: decision.id,
    agent_address: agentAddress,
    recommended_funding_usdc: recommendedFundingUsdc,
    notes: decision.committee_votes.notes,
    committee_packet: JSON.stringify(packet),
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO dry_run_genesis_packets
       (id, opportunity_id, decision_id, agent_address, recommended_funding_usdc, notes, committee_packet, created_at)
     VALUES (@id, @opportunity_id, @decision_id, @agent_address, @recommended_funding_usdc, @notes, @committee_packet, @created_at)`,
  ).run(row);
  return hydrateDryRunGenesisPacket(row);
}

/** The one queryable row for an opportunity's dry-run genesis packet,
 *  if any — same read shape getGenesisTrigger() (15d) already gives the
 *  real fire path, so a caller (route, dashboard, or the top-level
 *  agent's own next tick) can ask "did this opportunity produce a
 *  dry-run packet" without re-deriving it from the decision + packet
 *  separately. */
export function getDryRunGenesisPacket(opportunityId: string): DryRunGenesisPacketRecord | undefined {
  const row = db
    .prepare(`SELECT * FROM dry_run_genesis_packets WHERE opportunity_id = ?`)
    .get(opportunityId) as DryRunGenesisPacketRow | undefined;
  return row ? hydrateDryRunGenesisPacket(row) : undefined;
}

/** All dry-run packets an agent has ever produced, most-recent-first —
 *  Zent.md 20d's staged-rollout use case ("dry-run mode only, for the
 *  first real profitable agent in production, before enabling real
 *  genesis") is exactly "review every packet dry-run mode has produced
 *  so far before flipping it off," which this exists to support. */
export function listDryRunGenesisPackets(agentAddress: string): DryRunGenesisPacketRecord[] {
  const rows = db
    .prepare(`SELECT * FROM dry_run_genesis_packets WHERE agent_address = ? ORDER BY created_at DESC`)
    .all(agentAddress) as DryRunGenesisPacketRow[];
  return rows.map(hydrateDryRunGenesisPacket);
}

// ─── Phase 15e: Full Audit Trail ────────────────────────────────────────
//
// Zent.md 15e: "Full audit trail: decision + every report that fed it,
// retrievable as one bundle for as long as Agent B exists — this is a
// record for later analysis, not a hold point."
//
// "Not a hold point" is the operative phrase, same one Zent.md's own
// "Notes on scope" section leans on for the pipeline as a whole: this
// section adds zero gates. decideExpansion()/fireGenesisTrigger() (15a-d)
// already ran to completion — genesis, if it fired, fired before this
// function is ever called. getExpansionAuditBundle() only *reads* what
// those calls already wrote (listExpansionDecisions()/getGenesisTrigger(),
// both exported back in Phase 1d/15d specifically for this), plus
// re-derives the same committeePacket assembleCommitteePacket() (13e)
// already knows how to build — nothing here is a second copy of that
// logic. "Retrievable ... for as long as Agent B exists" is satisfied by
// construction: every read below is keyed off opportunityId, which the
// genesis_triggers/expansion_decisions/opportunities rows never lose
// once written (no TTL, no cleanup job anywhere in this file), so the
// bundle stays queryable indefinitely, the same durability every other
// table in this pipeline already has.
//
// Deliberately NOT here: an HTTP surface (that's expansionRoutes.ts's
// job, same split every other compile*/assemble* function in this file
// already has toward its own GET route) and any interpretation of
// "does this look right in hindsight" (Zent.md 20e's post-launch review
// is the eventual place for that judgment call — this function's job is
// producing the record, not grading it).

export const AUDIT_BUNDLE_SCHEMA_VERSION = "15e-v1";

/**
 * The full audit trail for one opportunity: the opportunity itself, the
 * committee packet the CEO gate saw (Research/Finance/Strategy reports,
 * disagreement/completeness/deliberation/voting), every CEO ruling ever
 * recorded against it (including superseded `deferred` ticks — 15c's
 * own header already establishes those are real historical facts, not
 * placeholders to discard), and whatever the genesis trigger's current
 * status is, if `approved` ever fired one. One bundle, one read, no
 * follow-up query required to reconstruct "why does Agent B exist."
 */
export interface ExpansionAuditBundle {
  opportunityId: string;
  assembledAt: number;
  /** Which locked bundle contract produced this object — same role
   *  COMMITTEE_PACKET_SCHEMA_VERSION plays one layer down. */
  schemaVersion: string;
  opportunity: Opportunity;
  /** Same object assembleCommitteePacket() (13e) would hand the CEO
   *  gate today, re-assembled fresh from current findings rather than
   *  a frozen copy — Research/Finance/Strategy findings are themselves
   *  already versioned+kept (1c), so re-assembling here never loses
   *  history; it reflects "what the packet looks like now," while
   *  decisions[].committee_votes (below) is the frozen snapshot of what
   *  the packet looked like AT the moment each ruling was made. Both
   *  are part of a real audit trail; neither substitutes for the
   *  other. */
  committeePacket: CommitteePacket;
  /** Every CEO ruling ever recorded for this opportunity, most-recent-
   *  first — listExpansionDecisions()'s own ordering (1d/15c), reused
   *  as-is rather than re-sorted here. */
  decisions: ExpansionDecision<DecideExpansionSnapshot>[];
  /** decisions[0], or null if the CEO has never ruled on this
   *  opportunity — a convenience field, not new data (listExpansionDecisions()
   *  already orders most-recent-first, same value getLatestExpansionDecision()
   *  would return), so a caller that only wants "what's the current
   *  ruling" doesn't have to know the array's sort order is significant. */
  latestDecision: ExpansionDecision<DecideExpansionSnapshot> | null;
  /** Null when no `approved` ruling has ever fired one for this
   *  opportunity (the common case: most opportunities are rejected,
   *  deferred, or never ruled on) — not an error, same "absence is a
   *  real answer" posture getGenesisTrigger() itself already documents. */
  genesisTrigger: GenesisTriggerRecord | null;
}

/** Every ExpansionAuditBundle field, in the order getExpansionAuditBundle()
 *  emits them — same "one canonical list" role COMMITTEE_PACKET_FIELDS
 *  plays for CommitteePacket. */
export const AUDIT_BUNDLE_FIELDS = [
  "opportunityId",
  "assembledAt",
  "schemaVersion",
  "opportunity",
  "committeePacket",
  "decisions",
  "latestDecision",
  "genesisTrigger",
] as const satisfies readonly (keyof ExpansionAuditBundle)[];

/**
 * Runtime conformance check for an assembled audit bundle — same role
 * validateCommitteePacketShape() plays one layer down, applied to this
 * wider bundle. Deliberately does NOT recurse into committeePacket and
 * re-run validateCommitteePacketShape() against it a second time (that
 * already happens inside assembleCommitteePacket() itself, same "trust
 * the one chokepoint" reasoning every compile-/assemble-prefixed
 * function in this file already gives for its own upstream calls) — this function's
 * only job is the bundle's OWN contract: exactly AUDIT_BUNDLE_FIELDS'
 * keys, each with its required type, decisions as an array, and
 * latestDecision/genesisTrigger each either a plain object or exactly
 * null (never absent, never any other primitive).
 */
export function validateExpansionAuditBundleShape(
  bundle: unknown,
): { valid: true; errors: [] } | { valid: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    return { valid: false, errors: ["bundle is not a plain object"] };
  }
  const obj = bundle as Record<string, unknown>;

  const actualKeys = new Set(Object.keys(obj));
  const expectedKeys = new Set<string>(AUDIT_BUNDLE_FIELDS);
  for (const key of expectedKeys) {
    if (!actualKeys.has(key)) errors.push(`missing field: ${key}`);
  }
  for (const key of actualKeys) {
    if (!expectedKeys.has(key)) errors.push(`unexpected field: ${key}`);
  }

  if (typeof obj.opportunityId !== "string" || !obj.opportunityId) {
    errors.push("opportunityId must be a non-empty string");
  }
  if (typeof obj.assembledAt !== "number") {
    errors.push("assembledAt must be a number");
  }
  if (obj.schemaVersion !== AUDIT_BUNDLE_SCHEMA_VERSION) {
    errors.push(
      `schemaVersion must be "${AUDIT_BUNDLE_SCHEMA_VERSION}", got ${JSON.stringify(obj.schemaVersion)}`,
    );
  }
  for (const field of ["opportunity", "committeePacket"]) {
    const value = obj[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${field} must be an object, and is required (never null)`);
    }
  }
  if (!Array.isArray(obj.decisions)) {
    errors.push("decisions must be an array");
  }
  for (const field of ["latestDecision", "genesisTrigger"]) {
    const value = obj[field];
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
      errors.push(`${field} must be an object or null`);
    }
  }

  return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
}

/**
 * getExpansionAuditBundle(opportunityId) — Zent.md 15e's own "retrievable
 * as one bundle" in full. Throws only on an unknown opportunity_id, the
 * same posture assembleCommitteePacket()/compileResearchReport() each
 * already take: no ruling yet, no genesis trigger, an incomplete packet
 * (Research/Finance/Strategy still mid-flight) are all real, valid
 * states for this bundle to describe, not error conditions — a record
 * of "what has happened so far" is exactly as legitimate for an
 * opportunity still in flight as for one whose Agent B has been running
 * for a year. This is why assembleCommitteePacket() is called here
 * rather than requireCompleteCommitteePacket()/requireDecidableCommitteePacket()
 * (15a's own gates) — those two exist to BLOCK a decision on an unready
 * packet; this function exists to explain one, ready or not.
 */
export function getExpansionAuditBundle(opportunityId: string): ExpansionAuditBundle {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const committeePacket = assembleCommitteePacket(opportunityId);
  const decisions = listExpansionDecisions<DecideExpansionSnapshot>(opportunityId);
  const latestDecision = decisions[0] ?? null;
  const genesisTrigger = getGenesisTrigger(opportunityId) ?? null;

  const bundle: ExpansionAuditBundle = {
    opportunityId,
    assembledAt: Date.now(),
    schemaVersion: AUDIT_BUNDLE_SCHEMA_VERSION,
    opportunity,
    committeePacket,
    decisions,
    latestDecision,
    genesisTrigger,
  };

  const shapeCheck = validateExpansionAuditBundleShape(bundle);
  if (!shapeCheck.valid) {
    throw new Error(
      `get_expansion_audit_bundle produced a bundle that violates its own locked schema: ${shapeCheck.errors.join("; ")}`,
    );
  }
  return bundle;
}
