// Zent.md Phase 3b: "Deterministic ROI formula (documented, not left
// to the model to invent per-call) combining 3a's factors into
// `roi_score`; stored alongside the inputs so it's auditable, not
// just a number."
//
// Inlined mirror of expansion.ts's computeRoiScore()/ROI_WEIGHTS/
// ROI_FORMULA_VERSION, of createOpportunity()'s Phase 3b
// roiFormulaVersion handling, and of the score-opportunity route's
// Phase 3b update (computeRoiScore() called on validated factors,
// result + ROI_FORMULA_VERSION passed straight into createOpportunity())
// — same "no live better-sqlite3 in this environment" reason every
// prior backend/src test file in this repo already carries (see
// expansionScoreOpportunity.test.ts's own header for the identical
// note on the Phase 3a route it mirrors).
//
// What this covers:
//   3b — computeRoiScore() applies the documented fixed weighted
//         average (demand*0.35 + expenseOfProblem*0.30 +
//         buildability*0.20 + competitiveGap*0.15) and nothing else —
//         no per-call reweighting, no hidden clamp beyond what
//         already-in-range inputs guarantee.
//   3b — the four weights sum to exactly 1.0, so an all-0 input scores
//         0, an all-100 input scores 100, and every in-range input
//         lands in [0, 100] with no separate clamp needed.
//   3b — the result is rounded to 2 decimal places, deterministically
//         (same input always produces the exact same output — no
//         randomness, no per-call model judgment).
//   3b — createOpportunity() rejects roiFormulaVersion supplied
//         without roiScore (a dangling audit tag naming no score), and
//         stores roiFormulaVersion as null when a caller supplies a
//         roiScore without one (a manually-set score is never mistaken
//         for one the current formula actually produced).
//   3b — the score-opportunity route now sets roi_score (via
//         computeRoiScore()) and roi_formula_version (via
//         ROI_FORMULA_VERSION) at creation time, in the same call that
//         validates and stores the four factors — no separate "now
//         score it" step, no window where a successfully-created
//         opportunity has a null roi_score.

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

// ─── Mirror of expansion.ts's Phase 3b formula ─────────────────────────

const ROI_FORMULA_VERSION = "3b-v1";

const ROI_WEIGHTS = {
  demand: 0.35,
  expenseOfProblem: 0.3,
  buildability: 0.2,
  competitiveGap: 0.15,
} as const;

function computeRoiScore(factors: ScoringFactors): number {
  const raw =
    factors.demand * ROI_WEIGHTS.demand +
    factors.expenseOfProblem * ROI_WEIGHTS.expenseOfProblem +
    factors.buildability * ROI_WEIGHTS.buildability +
    factors.competitiveGap * ROI_WEIGHTS.competitiveGap;
  return Math.round(raw * 100) / 100;
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
  roi_formula_version: string | null;
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

// Mirror of expansion.ts's createOpportunity(), Phase 3b signature.
function createOpportunity(
  reportId: string,
  title: string,
  thesis: string,
  options: {
    roiScore?: number;
    roiFormulaVersion?: string;
    tags?: string[];
    factors?: ScoringFactors;
  } = {},
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
  if (options.roiFormulaVersion !== undefined && roiScore === null) {
    throw new Error("roiFormulaVersion was provided without roiScore");
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
    roi_formula_version: options.roiFormulaVersion ?? null,
    tags: options.tags ?? [],
    factors: options.factors ?? null,
  };
  opportunities.push(opp);
  return opp;
}

function createReport(agentAddress: string, status: FakeReport["status"] = "draft"): FakeReport {
  const report: FakeReport = { id: `oppr_${nextId++}`, agent_address: agentAddress, status };
  reports.push(report);
  return report;
}

// ─── Mirror of the Phase 3b score-opportunity route update ────────────
// (validate -> computeRoiScore -> createOpportunity with both roiScore
// and ROI_FORMULA_VERSION — see expansionRoutes.ts's Phase 3b comment)

function scoreOpportunityRoute(
  reportId: string,
  title: string,
  thesis: string,
  factors: ScoringFactors,
): FakeOpportunity {
  validateScoringFactors(factors);
  const roiScore = computeRoiScore(factors);
  return createOpportunity(reportId, title, thesis, {
    factors,
    roiScore,
    roiFormulaVersion: ROI_FORMULA_VERSION,
  });
}

// ─── 3b: computeRoiScore ────────────────────────────────────────────────

describe("computeRoiScore", () => {
  test("weights sum to 1.0 (within floating-point tolerance)", () => {
    const sum =
      ROI_WEIGHTS.demand + ROI_WEIGHTS.expenseOfProblem + ROI_WEIGHTS.buildability + ROI_WEIGHTS.competitiveGap;
    // 0.35 + 0.30 + 0.20 + 0.15 is exactly 1 in decimal but not
    // necessarily in IEEE 754 binary floating point (it comes out to
    // 0.9999999999999999 in JS) — assert within a tight epsilon rather
    // than bitwise equality, which is what actually matters for the
    // "always in [0, 100], no separate clamp needed" property this
    // section's own header claims.
    assert.ok(Math.abs(sum - 1) < 1e-9, `expected weights to sum to ~1, got ${sum}`);
  });

  test("all-zero factors score 0", () => {
    assert.equal(
      computeRoiScore({ demand: 0, expenseOfProblem: 0, buildability: 0, competitiveGap: 0 }),
      0,
    );
  });

  test("all-100 factors score 100", () => {
    assert.equal(
      computeRoiScore({ demand: 100, expenseOfProblem: 100, buildability: 100, competitiveGap: 100 }),
      100,
    );
  });

  test("applies the documented weighted average for distinct factor values", () => {
    // 80*0.35 + 60*0.30 + 40*0.20 + 20*0.15 = 28 + 18 + 8 + 3 = 57
    const score = computeRoiScore({
      demand: 80,
      expenseOfProblem: 60,
      buildability: 40,
      competitiveGap: 20,
    });
    assert.equal(score, 57);
  });

  test("is a pure function of its inputs: same factors always produce the same score", () => {
    const factors = { demand: 37, expenseOfProblem: 82, buildability: 15, competitiveGap: 64 };
    const first = computeRoiScore(factors);
    const second = computeRoiScore({ ...factors });
    assert.equal(first, second);
  });

  test("demand is weighted more heavily than competitiveGap", () => {
    // Isolate one factor at a time against an otherwise-zeroed input so
    // the weight ordering is visible directly in the output, not just
    // in the ROI_WEIGHTS constants themselves.
    const demandOnly = computeRoiScore({ demand: 100, expenseOfProblem: 0, buildability: 0, competitiveGap: 0 });
    const gapOnly = computeRoiScore({ demand: 0, expenseOfProblem: 0, buildability: 0, competitiveGap: 100 });
    assert.ok(demandOnly > gapOnly);
  });

  test("rounds to 2 decimal places", () => {
    // 33*0.35 + 33*0.30 + 33*0.20 + 33*0.15 = 33 * 1.0 = 33, but use
    // values that don't divide evenly to actually exercise rounding.
    const score = computeRoiScore({
      demand: 33,
      expenseOfProblem: 17,
      buildability: 9,
      competitiveGap: 71,
    });
    // 33*0.35=11.55, 17*0.30=5.1, 9*0.20=1.8, 71*0.15=10.65 -> 29.1
    assert.equal(score, 29.1);
    // Result must never carry more than 2 decimal digits.
    const decimals = (String(score).split(".")[1] ?? "").length;
    assert.ok(decimals <= 2);
  });
});

// ─── 3b: createOpportunity's roiFormulaVersion handling ────────────────

describe("createOpportunity — roiFormulaVersion (Phase 3b)", () => {
  test("stores roiScore and roiFormulaVersion together", () => {
    resetState();
    const report = createReport("agent-1");
    const factors = { demand: 90, expenseOfProblem: 70, buildability: 50, competitiveGap: 40 };
    const roiScore = computeRoiScore(factors);
    const opp = createOpportunity(report.id, "Title", "Thesis", {
      factors,
      roiScore,
      roiFormulaVersion: ROI_FORMULA_VERSION,
    });
    assert.equal(opp.roi_score, roiScore);
    assert.equal(opp.roi_formula_version, ROI_FORMULA_VERSION);
  });

  test("a caller-supplied roiScore with no version is stored with roi_formula_version null", () => {
    resetState();
    const report = createReport("agent-1");
    const opp = createOpportunity(report.id, "Title", "Thesis", { roiScore: 42 });
    assert.equal(opp.roi_score, 42);
    assert.equal(opp.roi_formula_version, null);
  });

  test("rejects roiFormulaVersion supplied without roiScore", () => {
    resetState();
    const report = createReport("agent-1");
    assert.throws(
      () =>
        createOpportunity(report.id, "Title", "Thesis", {
          roiFormulaVersion: ROI_FORMULA_VERSION,
        }),
      /roiFormulaVersion was provided without roiScore/,
    );
  });

  test("an opportunity created with neither roiScore nor factors is untouched by 3b (backward compatible)", () => {
    resetState();
    const report = createReport("agent-1");
    const opp = createOpportunity(report.id, "Title", "Thesis");
    assert.equal(opp.roi_score, null);
    assert.equal(opp.roi_formula_version, null);
    assert.equal(opp.factors, null);
  });
});

// ─── 3b: the score-opportunity route sets roi_score at creation time ──

describe("score-opportunity route (Phase 3b update)", () => {
  test("computes and stores roi_score + roi_formula_version in the same call that stores factors", () => {
    resetState();
    const report = createReport("agent-1");
    const factors = { demand: 80, expenseOfProblem: 60, buildability: 40, competitiveGap: 20 };
    const opp = scoreOpportunityRoute(report.id, "New idea", "Because reasons", factors);
    assert.equal(opp.roi_score, 57); // same weighted average verified above
    assert.equal(opp.roi_formula_version, ROI_FORMULA_VERSION);
    assert.deepEqual(opp.factors, factors);
  });

  test("never leaves roi_score null after a successful call", () => {
    resetState();
    const report = createReport("agent-1");
    const opp = scoreOpportunityRoute(
      report.id,
      "Idea",
      "Thesis",
      { demand: 0, expenseOfProblem: 0, buildability: 0, competitiveGap: 0 },
    );
    // Even the worst possible factors still produce a real (zero) score,
    // not a null one — "no good ideas" is Phase 3e's job to decide from
    // this number, not this route's job to represent as an absent one.
    assert.equal(opp.roi_score, 0);
    assert.notEqual(opp.roi_score, null);
  });

  test("propagates validateScoringFactors' rejection before any opportunity is created", () => {
    resetState();
    const report = createReport("agent-1");
    assert.throws(
      () =>
        scoreOpportunityRoute(report.id, "Idea", "Thesis", {
          demand: 150,
          expenseOfProblem: 50,
          buildability: 50,
          competitiveGap: 50,
        }),
      /demand must be a finite number between 0 and 100/,
    );
    assert.equal(opportunities.length, 0);
  });
});
