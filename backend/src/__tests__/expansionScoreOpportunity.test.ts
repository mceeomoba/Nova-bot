// Zent.md Phase 3a: "score_opportunity(title, thesis, factors) tool
// that writes one row to `opportunities`, factors = demand,
// expense-of-problem, buildability-by-our-stack, competitive-gap —
// each 0-100."
//
// Inlined mirror of expansion.ts's ScoringFactors/validateScoringFactors()/
// createOpportunity() update and of expansionRoutes.ts's new
// POST /expansion/opportunities/score-opportunity route (including the
// resolveTargetReport() helper it shares with the Phase 2b/2c routes)
// — same "no live better-sqlite3 in this environment" reason every
// prior backend/src test file in this repo already carries (see
// expansionOpportunityIntelligenceTickCap.test.ts's own header, or
// expansionPipeline.test.ts's for the same note applied to Phase 1a).
// Recommend re-running against the real modules once a networked
// environment with node_modules installed is available.
//
// What this covers:
//   3a — validateScoringFactors accepts every factor in [0, 100]
//         inclusive (boundary-tested at 0 and 100) and rejects
//         non-numbers, out-of-range values, and missing keys, naming
//         every problem at once rather than just the first.
//   3a — createOpportunity() writes all four factors together when
//         options.factors is provided, leaves them all null when it
//         isn't (backward compatible with every pre-3a caller), and
//         never sets roi_score — that stays Phase 3b's job.
//   3a — the score_opportunity route's validation order: agentAddress,
//         title, thesis, factors-is-an-object, then
//         validateScoringFactors, then report resolution — matching
//         "cheapest, most-decisive rejection first" convention this
//         file's Phase 2d note already established for the sibling
//         routes.
//   3a — report resolution reuses resolveTargetReport() exactly: a
//         caller-supplied reportId must belong to the calling agent
//         and be in 'draft' status; omitting it reuses/opens the
//         agent's current draft, same as 2b/2c.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's ScoringFactors + validateScoringFactors ──

interface ScoringFactors {
  demand: number;
  expenseOfProblem: number;
  buildability: number;
  competitiveGap: number;
}

function validateScoringFactors(factors: ScoringFactors): void {
  const problems: string[] = [];
  for (const key of ["demand", "expenseOfProblem", "buildability", "competitiveGap"] as const) {
    const value = (factors as any)[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      problems.push(`${key} must be a finite number between 0 and 100 (got ${JSON.stringify(value)})`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`invalid scoring factors: ${problems.join("; ")}`);
  }
}

// ─── Mirror of expansion.ts's opportunity_reports / opportunities rows ─

interface FakeReport {
  id: string;
  agent_address: string;
  status: "draft" | "scored" | "archived";
}

interface FakeOpportunity {
  id: string;
  report_id: string;
  created_at: number;
  title: string;
  thesis: string;
  roi_score: number | null;
  tags: string[];
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

function findReport(id: string): FakeReport | undefined {
  return reports.find((r) => r.id === id);
}

// Mirror of expansion.ts's createOpportunity(), Phase 3a signature.
function createOpportunity(
  reportId: string,
  title: string,
  thesis: string,
  options: { roiScore?: number; tags?: string[]; factors?: ScoringFactors } = {},
): FakeOpportunity {
  if (!reportId) throw new Error("reportId is required");
  if (!title) throw new Error("title is required");
  if (!thesis) throw new Error("thesis is required");
  const report = findReport(reportId);
  if (!report) throw new Error(`opportunity_report ${reportId} not found`);
  const roiScore = options.roiScore ?? null;
  if (roiScore !== null && !Number.isFinite(roiScore)) {
    throw new Error("roiScore must be a finite number");
  }
  if (options.factors !== undefined) {
    validateScoringFactors(options.factors);
  }
  const opp: FakeOpportunity = {
    id: `opp_${nextId++}`,
    report_id: reportId,
    created_at: Date.now(),
    title,
    thesis,
    roi_score: roiScore,
    tags: options.tags ?? [],
    factors: options.factors ?? null,
  };
  opportunities.push(opp);
  return opp;
}

// ─── Mirror of expansionRoutes.ts's resolveTargetReport() ─────────────

function ensureDraftOpportunityReport(agentAddress: string): FakeReport {
  const existingDraft = reports
    .filter((r) => r.agent_address === agentAddress && r.status === "draft")
    .at(-1);
  if (existingDraft) return existingDraft;
  const created: FakeReport = { id: `oppr_${nextId++}`, agent_address: agentAddress, status: "draft" };
  reports.push(created);
  return created;
}

function resolveTargetReport(
  agentAddress: string,
  reportId: unknown,
): { report: FakeReport } | { status: number; error: string } {
  if (reportId !== undefined) {
    if (typeof reportId !== "string" || !reportId) {
      return { status: 400, error: "reportId, if provided, must be a non-empty string" };
    }
    const existing = findReport(reportId);
    if (!existing) {
      return { status: 404, error: `opportunity_report ${reportId} not found` };
    }
    if (existing.agent_address !== agentAddress) {
      return { status: 403, error: "reportId does not belong to agentAddress" };
    }
    if (existing.status !== "draft") {
      return { status: 409, error: `opportunity_report ${reportId} is ${existing.status}, not draft` };
    }
    return { report: existing };
  }
  return { report: ensureDraftOpportunityReport(agentAddress) };
}

// ─── Mirror of the POST /expansion/opportunities/score-opportunity route ─

const MAX_TITLE_LENGTH = 200;
const MAX_THESIS_LENGTH = 2000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Loosely typed on purpose (status: number, body: any): this mirror only
// needs to exercise the real route's branching/response shape for
// assertions below, not reproduce its exact Express typing.
interface RouteResult {
  status: number;
  body: { error?: string; reportId?: string; opportunity?: FakeOpportunity };
}

function scoreOpportunityRoute(body: {
  agentAddress?: unknown;
  title?: unknown;
  thesis?: unknown;
  factors?: unknown;
  reportId?: unknown;
}): RouteResult {
  const { agentAddress, title, thesis, factors, reportId } = body;

  if (typeof agentAddress !== "string" || !agentAddress) {
    return { status: 400, body: { error: "agentAddress is required" } };
  }
  if (typeof title !== "string" || !title.trim()) {
    return { status: 400, body: { error: "title is required" } };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { status: 400, body: { error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` } };
  }
  if (typeof thesis !== "string" || !thesis.trim()) {
    return { status: 400, body: { error: "thesis is required" } };
  }
  if (thesis.length > MAX_THESIS_LENGTH) {
    return { status: 400, body: { error: `thesis must be ${MAX_THESIS_LENGTH} characters or fewer` } };
  }
  if (!isPlainObject(factors)) {
    return {
      status: 400,
      body: {
        error:
          "factors is required and must be an object with demand, expenseOfProblem, buildability, competitiveGap",
      },
    };
  }

  const candidateFactors = factors as unknown as ScoringFactors;
  try {
    validateScoringFactors(candidateFactors);
  } catch (err: any) {
    return { status: 400, body: { error: err.message } };
  }

  const resolved = resolveTargetReport(agentAddress, reportId);
  if ("error" in resolved) {
    return { status: resolved.status, body: { error: resolved.error } };
  }

  const opportunity = createOpportunity(resolved.report.id, title.trim(), thesis.trim(), {
    factors: candidateFactors,
  });

  return { status: 201, body: { reportId: resolved.report.id, opportunity } };
}

// ─── Phase 3a: validateScoringFactors ──────────────────────────────────

describe("validateScoringFactors", () => {
  test("accepts a valid mid-range set of factors", () => {
    assert.doesNotThrow(() =>
      validateScoringFactors({ demand: 80, expenseOfProblem: 60, buildability: 70, competitiveGap: 50 }),
    );
  });

  test("accepts boundary value 0", () => {
    assert.doesNotThrow(() =>
      validateScoringFactors({ demand: 0, expenseOfProblem: 0, buildability: 0, competitiveGap: 0 }),
    );
  });

  test("accepts boundary value 100", () => {
    assert.doesNotThrow(() =>
      validateScoringFactors({ demand: 100, expenseOfProblem: 100, buildability: 100, competitiveGap: 100 }),
    );
  });

  test("rejects a negative factor", () => {
    assert.throws(
      () => validateScoringFactors({ demand: -1, expenseOfProblem: 50, buildability: 50, competitiveGap: 50 }),
      /demand must be a finite number between 0 and 100/,
    );
  });

  test("rejects a factor over 100", () => {
    assert.throws(
      () => validateScoringFactors({ demand: 50, expenseOfProblem: 101, buildability: 50, competitiveGap: 50 }),
      /expenseOfProblem must be a finite number between 0 and 100/,
    );
  });

  test("rejects a non-numeric factor", () => {
    assert.throws(
      () =>
        validateScoringFactors({
          demand: 50,
          expenseOfProblem: 50,
          buildability: "high" as any,
          competitiveGap: 50,
        }),
      /buildability must be a finite number/,
    );
  });

  test("rejects NaN and Infinity", () => {
    assert.throws(() =>
      validateScoringFactors({ demand: NaN, expenseOfProblem: 50, buildability: 50, competitiveGap: 50 }),
    );
    assert.throws(() =>
      validateScoringFactors({
        demand: 50,
        expenseOfProblem: Infinity,
        buildability: 50,
        competitiveGap: 50,
      }),
    );
  });

  test("names every invalid factor at once, not just the first", () => {
    try {
      validateScoringFactors({ demand: -5, expenseOfProblem: 200, buildability: 50, competitiveGap: 50 });
      assert.fail("expected validateScoringFactors to throw");
    } catch (err: any) {
      assert.match(err.message, /demand must be a finite number/);
      assert.match(err.message, /expenseOfProblem must be a finite number/);
      assert.doesNotMatch(err.message, /buildability must be/);
    }
  });
});

// ─── Phase 3a: createOpportunity() with factors ────────────────────────

describe("createOpportunity with Phase 3a factors", () => {
  test("writes all four factors together and leaves roi_score null", () => {
    resetState();
    const report = ensureDraftOpportunityReport("0xAGENT");
    const opp = createOpportunity(report.id, "AI receipts", "Automate expense receipts", {
      factors: { demand: 80, expenseOfProblem: 60, buildability: 90, competitiveGap: 40 },
    });
    assert.deepEqual(opp.factors, { demand: 80, expenseOfProblem: 60, buildability: 90, competitiveGap: 40 });
    assert.equal(opp.roi_score, null);
  });

  test("leaves factors null when not provided (backward compatible with pre-3a callers)", () => {
    resetState();
    const report = ensureDraftOpportunityReport("0xAGENT");
    const opp = createOpportunity(report.id, "Some idea", "Some thesis");
    assert.equal(opp.factors, null);
  });

  test("rejects invalid factors before writing anything", () => {
    resetState();
    const report = ensureDraftOpportunityReport("0xAGENT");
    assert.throws(() =>
      createOpportunity(report.id, "Bad idea", "Bad thesis", {
        factors: { demand: 500, expenseOfProblem: 50, buildability: 50, competitiveGap: 50 },
      }),
    );
    assert.equal(opportunities.length, 0);
  });
});

// ─── Phase 3a: POST /expansion/opportunities/score-opportunity route ──

describe("score_opportunity route", () => {
  const validFactors = { demand: 70, expenseOfProblem: 55, buildability: 65, competitiveGap: 45 };

  test("rejects a missing agentAddress", () => {
    resetState();
    const result = scoreOpportunityRoute({ title: "T", thesis: "Th", factors: validFactors });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "agentAddress is required");
  });

  test("rejects a missing title", () => {
    resetState();
    const result = scoreOpportunityRoute({ agentAddress: "0xAGENT", thesis: "Th", factors: validFactors });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "title is required");
  });

  test("rejects a title over the max length", () => {
    resetState();
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "x".repeat(MAX_TITLE_LENGTH + 1),
      thesis: "Th",
      factors: validFactors,
    });
    assert.equal(result.status, 400);
    assert.ok(result.body.error);
    assert.match(result.body.error, /title must be/);
  });

  test("rejects a missing thesis", () => {
    resetState();
    const result = scoreOpportunityRoute({ agentAddress: "0xAGENT", title: "T", factors: validFactors });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "thesis is required");
  });

  test("rejects missing factors", () => {
    resetState();
    const result = scoreOpportunityRoute({ agentAddress: "0xAGENT", title: "T", thesis: "Th" });
    assert.equal(result.status, 400);
    assert.ok(result.body.error);
    assert.match(result.body.error, /factors is required/);
  });

  test("rejects factors given as an array", () => {
    resetState();
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "T",
      thesis: "Th",
      factors: [70, 55, 65, 45],
    });
    assert.equal(result.status, 400);
    assert.ok(result.body.error);
    assert.match(result.body.error, /factors is required/);
  });

  test("rejects out-of-range factors with the validateScoringFactors message", () => {
    resetState();
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "T",
      thesis: "Th",
      factors: { demand: -1, expenseOfProblem: 55, buildability: 65, competitiveGap: 45 },
    });
    assert.equal(result.status, 400);
    assert.ok(result.body.error);
    assert.match(result.body.error, /demand must be a finite number/);
  });

  test("succeeds with no reportId, opening a fresh draft report", () => {
    resetState();
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "AI receipts",
      thesis: "Automate expense receipts",
      factors: validFactors,
    });
    assert.equal(result.status, 201);
    if (result.status === 201) {
      assert.equal(result.body.opportunity!.title, "AI receipts");
      assert.deepEqual(result.body.opportunity!.factors, validFactors);
      assert.equal(result.body.opportunity!.roi_score, null);
      const report = findReport(result.body.reportId!);
      assert.ok(report);
      assert.equal(report!.agent_address, "0xAGENT");
    }
  });

  test("two calls with no reportId land on the same current draft report", () => {
    resetState();
    const first = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "Idea A",
      thesis: "Thesis A",
      factors: validFactors,
    });
    const second = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "Idea B",
      thesis: "Thesis B",
      factors: validFactors,
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    if (first.status === 201 && second.status === 201) {
      assert.equal(first.body.reportId!, second.body.reportId!);
    }
  });

  test("rejects a reportId belonging to a different agent", () => {
    resetState();
    const report = ensureDraftOpportunityReport("0xOTHER");
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "T",
      thesis: "Th",
      factors: validFactors,
      reportId: report.id,
    });
    assert.equal(result.status, 403);
  });

  test("rejects a reportId that is not in draft status", () => {
    resetState();
    const report = ensureDraftOpportunityReport("0xAGENT");
    report.status = "scored";
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "T",
      thesis: "Th",
      factors: validFactors,
      reportId: report.id,
    });
    assert.equal(result.status, 409);
  });

  test("rejects a reportId that does not exist", () => {
    resetState();
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "T",
      thesis: "Th",
      factors: validFactors,
      reportId: "oppr_does_not_exist",
    });
    assert.equal(result.status, 404);
  });

  test("accepts an explicit valid reportId belonging to the caller", () => {
    resetState();
    const report = ensureDraftOpportunityReport("0xAGENT");
    const result = scoreOpportunityRoute({
      agentAddress: "0xAGENT",
      title: "T",
      thesis: "Th",
      factors: validFactors,
      reportId: report.id,
    });
    assert.equal(result.status, 201);
    if (result.status === 201) {
      assert.equal(result.body.reportId!, report.id);
    }
  });
});
