// Zent.md Phase 11e-ii-c: "Test: `strategy-fit-score.test.ts` covering
// the formula's arithmetic and the guard." (Filed as expansionFitScore
// .test.ts, matching this directory's own expansion<Thing>.test.ts
// convention — see expansionRoiFormula.test.ts / expansionResearchReportShape
// .test.ts for the same naming departure from Zent.md's literal filename.)
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this inlines
// a mirror of expansion.ts's:
//   - FitScoreFactors / validateFitScoreFactors / FIT_SCORE_WEIGHTS /
//     computeFitScore / FIT_FORMULA_VERSION (11e-i's formula)
//   - deriveMissionComplementarityFactor / deriveTechnologyReuseDepthFactor
//     (11e-ii-a's two computable-today factor derivations)
//   - recordMissionOverlapCheck / recordTechnologyReuseCheck /
//     scoreStrategyFit / MissingStrategyFitPrerequisitesError (11e-ii-b's
//     persisting wrappers and guard)
// against plain in-memory maps standing in for strategy_findings, the
// same posture expansionMissionOverlap.test.ts and expansionTechnologyReuse
// .test.ts already take for checkMissionOverlap()/checkTechnologyReuse()
// themselves. Recommend re-running against the real expansion.ts/db.ts
// once a networked environment is available.
//
// What this covers:
//   11e-i  — computeFitScore() applies the documented fixed weighted
//            average (missionComplementarity*0.35 + technologyReuseDepth
//            *0.30 + ecosystemDiversificationValue*0.20 + market
//            Independence*0.15) and nothing else.
//   11e-i  — the four weights sum to exactly 1.0, so an all-0 input
//            scores 0, an all-100 input scores 100.
//   11e-i  — the result is rounded to 2 decimal places, deterministically.
//   11e-i  — validateFitScoreFactors rejects any factor outside [0, 100]
//            and names every problem at once, same as validateScoringFactors.
//   11e-ii-a — deriveMissionComplementarityFactor scores duplicates=0,
//            competes=25, complements=75-100 scaled by tagOverlap, and
//            no-entries=50 — using entries[0] (the worst relationship)
//            rather than an average.
//   11e-ii-a — deriveTechnologyReuseDepthFactor scales the top match's
//            reuseScore (0-1) to 0-100, and no-entries=0.
//   11e-ii-b — scoreStrategyFit throws MissingStrategyFitPrerequisitesError
//            naming both missing tools when neither has run, and naming
//            only the one still missing when just one has.
//   11e-ii-b — scoreStrategyFit succeeds once both recordMissionOverlapCheck
//            and recordTechnologyReuseCheck have filed their checks, even
//            if that happened on an earlier, now-superseded call — the
//            guard reads the current row, not call order.
//   11e-ii-b — scoreStrategyFit writes fit_score onto the *same*
//            strategy_findings row as mission_overlap/technology_reuse
//            (merge, not clobber) and is itself superseding on re-run.
//   11e-ii-b — a caller-supplied ecosystemDiversificationValue/market
//            Independence out of [0, 100] is rejected via
//            validateFitScoreFactors before any finding is written.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's Finding<T> + strategy_findings versioning
//     (createStrategyFinding / getCurrentStrategyFinding, Phase 1c/11a) ──

interface Finding<T = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  created_at: number;
  version: number;
  superseded: boolean;
  findings: T;
}

let strategyFindings: Finding<Record<string, unknown>>[];
let nextId: number;

function reset() {
  strategyFindings = [];
  nextId = 1;
}

function createStrategyFinding<T = Record<string, unknown>>(
  opportunityId: string,
  findings: T,
): Finding<T> {
  const current = getCurrentStrategyFinding(opportunityId);
  for (const f of strategyFindings) {
    if (f.opportunity_id === opportunityId && !f.superseded) f.superseded = true;
  }
  const finding: Finding<T> = {
    id: `sf_${nextId++}`,
    opportunity_id: opportunityId,
    created_at: Date.now(),
    version: (current?.version ?? 0) + 1,
    superseded: false,
    findings,
  };
  strategyFindings.push(finding as Finding<Record<string, unknown>>);
  return finding;
}

function getCurrentStrategyFinding(
  opportunityId: string,
): Finding<Record<string, unknown>> | undefined {
  return strategyFindings.find((f) => f.opportunity_id === opportunityId && !f.superseded);
}

function mergeIntoCurrentStrategyFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): Finding<Record<string, unknown>> {
  const current = getCurrentStrategyFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createStrategyFinding<Record<string, unknown>>(opportunityId, merged);
}

// ─── Mirror of expansion.ts's MissionOverlapEntry / TechnologyReuseEntry
//     shapes (Phase 11c/11d) — only the fields 11e-ii's derivations read ──

type MissionOverlapRelationship = "duplicates" | "competes" | "complements";

interface MissionOverlapEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  relationship: MissionOverlapRelationship;
  similarity: number;
  tagOverlap: number;
}

interface TechnologyReuseEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  matches: { name: string; score: number }[];
  reuseScore: number;
}

// checkMissionOverlap()/checkTechnologyReuse() themselves are pure reads
// over live sibling data (11c/11d, unchanged by this phase) — this test
// doesn't need to re-derive them, only to stand in a fixed set of
// entries as "what they returned," the same way scoreStrategyFit() only
// ever reads the *persisted* record 11e-ii-b's guard requires. So these
// two maps play the role 11c/11d's own live functions would.
const missionOverlapByOpportunity = new Map<string, MissionOverlapEntry[]>();
const technologyReuseByOpportunity = new Map<string, TechnologyReuseEntry[]>();

function checkMissionOverlap(opportunityId: string): MissionOverlapEntry[] {
  return missionOverlapByOpportunity.get(opportunityId) ?? [];
}

function checkTechnologyReuse(opportunityId: string): TechnologyReuseEntry[] {
  return technologyReuseByOpportunity.get(opportunityId) ?? [];
}

// ─── Mirror of expansion.ts's Phase 11e-i formula ───────────────────────

interface FitScoreFactors {
  missionComplementarity: number;
  technologyReuseDepth: number;
  ecosystemDiversificationValue: number;
  marketIndependence: number;
}

function validateFitScoreFactors(factors: FitScoreFactors): void {
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

const FIT_FORMULA_VERSION = "11e-i-v1";

const FIT_SCORE_WEIGHTS = {
  missionComplementarity: 0.35,
  technologyReuseDepth: 0.3,
  ecosystemDiversificationValue: 0.2,
  marketIndependence: 0.15,
} as const;

function computeFitScore(factors: FitScoreFactors): number {
  const raw =
    factors.missionComplementarity * FIT_SCORE_WEIGHTS.missionComplementarity +
    factors.technologyReuseDepth * FIT_SCORE_WEIGHTS.technologyReuseDepth +
    factors.ecosystemDiversificationValue * FIT_SCORE_WEIGHTS.ecosystemDiversificationValue +
    factors.marketIndependence * FIT_SCORE_WEIGHTS.marketIndependence;
  return Math.round(raw * 100) / 100;
}

interface FitScoreFinding {
  fit_score: number;
  fit_formula_version: typeof FIT_FORMULA_VERSION;
  factors: FitScoreFactors;
}

// ─── Mirror of expansion.ts's Phase 11e-ii-a factor derivations ────────

function deriveMissionComplementarityFactor(overlap: MissionOverlapEntry[]): number {
  if (overlap.length === 0) return 50;

  const worst = overlap[0].relationship;
  if (worst === "duplicates") return 0;
  if (worst === "competes") return 25;

  const bestTagOverlap = Math.max(...overlap.map((entry) => entry.tagOverlap));
  return Math.round((75 + bestTagOverlap * 25) * 100) / 100;
}

function deriveTechnologyReuseDepthFactor(reuse: TechnologyReuseEntry[]): number {
  if (reuse.length === 0) return 0;
  return Math.round(reuse[0].reuseScore * 100 * 100) / 100;
}

// ─── Mirror of expansion.ts's Phase 11e-ii-b persisting wrappers + guard ─

interface MissionOverlapCheckRecord {
  entries: MissionOverlapEntry[];
  checkedAt: number;
}

interface TechnologyReuseCheckRecord {
  entries: TechnologyReuseEntry[];
  checkedAt: number;
}

function recordMissionOverlapCheck(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; record: MissionOverlapCheckRecord } {
  const record: MissionOverlapCheckRecord = {
    entries: checkMissionOverlap(opportunityId),
    checkedAt: Date.now(),
  };
  const finding = mergeIntoCurrentStrategyFinding(opportunityId, { mission_overlap: record });
  return { finding, record };
}

function recordTechnologyReuseCheck(
  opportunityId: string,
): { finding: Finding<Record<string, unknown>>; record: TechnologyReuseCheckRecord } {
  const record: TechnologyReuseCheckRecord = {
    entries: checkTechnologyReuse(opportunityId),
    checkedAt: Date.now(),
  };
  const finding = mergeIntoCurrentStrategyFinding(opportunityId, { technology_reuse: record });
  return { finding, record };
}

class MissingStrategyFitPrerequisitesError extends Error {
  status = 409;
  constructor(opportunityId: string, missingTools: string[]) {
    super(
      `${missingTools.join(" and ")} must run for opportunity ${opportunityId} before score_strategy_fit`,
    );
    this.name = "MissingStrategyFitPrerequisitesError";
  }
}

interface ScoreStrategyFitOptions {
  ecosystemDiversificationValue?: number;
  marketIndependence?: number;
}

interface StrategyFitScoreResult {
  finding: Finding<Record<string, unknown>>;
  fitScore: FitScoreFinding;
  missionOverlap: MissionOverlapEntry[];
  technologyReuse: TechnologyReuseEntry[];
}

// Opportunities are just IDs as far as this mirror is concerned — the
// real getOpportunity()'s not-found check is exercised elsewhere
// (expansionOpportunities.test.ts); this file's own concern is 11e-i/
// 11e-ii-a/b, so opportunities "exist" simply by having a strategy
// finding row (or not) the same way every other opportunity here does.
const knownOpportunities = new Set<string>();
function seedOpportunity(id: string) {
  knownOpportunities.add(id);
}

function scoreStrategyFit(
  opportunityId: string,
  options: ScoreStrategyFitOptions = {},
): StrategyFitScoreResult {
  if (!knownOpportunities.has(opportunityId)) {
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

  const finding = mergeIntoCurrentStrategyFinding(opportunityId, { fit_score: fitScore });

  return { finding, fitScore, missionOverlap, technologyReuse };
}

// ─── 11e-i: computeFitScore ─────────────────────────────────────────────

describe("computeFitScore", () => {
  test("weights sum to 1.0 (within floating-point tolerance)", () => {
    const sum =
      FIT_SCORE_WEIGHTS.missionComplementarity +
      FIT_SCORE_WEIGHTS.technologyReuseDepth +
      FIT_SCORE_WEIGHTS.ecosystemDiversificationValue +
      FIT_SCORE_WEIGHTS.marketIndependence;
    assert.ok(Math.abs(sum - 1) < 1e-9, `expected weights to sum to ~1, got ${sum}`);
  });

  test("all-zero factors score 0", () => {
    assert.equal(
      computeFitScore({
        missionComplementarity: 0,
        technologyReuseDepth: 0,
        ecosystemDiversificationValue: 0,
        marketIndependence: 0,
      }),
      0,
    );
  });

  test("all-100 factors score 100", () => {
    assert.equal(
      computeFitScore({
        missionComplementarity: 100,
        technologyReuseDepth: 100,
        ecosystemDiversificationValue: 100,
        marketIndependence: 100,
      }),
      100,
    );
  });

  test("applies the documented weighted average for distinct factor values", () => {
    // 80*0.35 + 60*0.30 + 40*0.20 + 20*0.15 = 28 + 18 + 8 + 3 = 57
    const score = computeFitScore({
      missionComplementarity: 80,
      technologyReuseDepth: 60,
      ecosystemDiversificationValue: 40,
      marketIndependence: 20,
    });
    assert.equal(score, 57);
  });

  test("rounds to 2 decimal places", () => {
    // 33*0.35=11.55, 17*0.30=5.1, 9*0.20=1.8, 71*0.15=10.65 -> 29.1
    const score = computeFitScore({
      missionComplementarity: 33,
      technologyReuseDepth: 17,
      ecosystemDiversificationValue: 9,
      marketIndependence: 71,
    });
    assert.equal(score, 29.1);
    const decimals = (String(score).split(".")[1] ?? "").length;
    assert.ok(decimals <= 2);
  });

  test("missionComplementarity is weighted more heavily than marketIndependence", () => {
    const missionOnly = computeFitScore({
      missionComplementarity: 100,
      technologyReuseDepth: 0,
      ecosystemDiversificationValue: 0,
      marketIndependence: 0,
    });
    const marketOnly = computeFitScore({
      missionComplementarity: 0,
      technologyReuseDepth: 0,
      ecosystemDiversificationValue: 0,
      marketIndependence: 100,
    });
    assert.ok(missionOnly > marketOnly);
  });
});

describe("validateFitScoreFactors", () => {
  test("accepts all-in-range factors without throwing", () => {
    assert.doesNotThrow(() =>
      validateFitScoreFactors({
        missionComplementarity: 50,
        technologyReuseDepth: 50,
        ecosystemDiversificationValue: 50,
        marketIndependence: 50,
      }),
    );
  });

  test("rejects a single out-of-range factor by name", () => {
    assert.throws(
      () =>
        validateFitScoreFactors({
          missionComplementarity: 150,
          technologyReuseDepth: 50,
          ecosystemDiversificationValue: 50,
          marketIndependence: 50,
        }),
      /missionComplementarity must be a finite number between 0 and 100/,
    );
  });

  test("names every problem at once, not just the first", () => {
    assert.throws(
      () =>
        validateFitScoreFactors({
          missionComplementarity: -5,
          technologyReuseDepth: 200,
          ecosystemDiversificationValue: 50,
          marketIndependence: 50,
        }),
      /missionComplementarity.*technologyReuseDepth/s,
    );
  });
});

// ─── 11e-ii-a: factor derivations ───────────────────────────────────────

describe("deriveMissionComplementarityFactor", () => {
  test("no overlap entries scores 50 (unknown, not demonstrated either way)", () => {
    assert.equal(deriveMissionComplementarityFactor([]), 50);
  });

  test("a duplicates relationship scores 0", () => {
    const entries: MissionOverlapEntry[] = [
      {
        siblingAddress: "a",
        siblingOpportunityId: "o1",
        siblingTitle: "T",
        relationship: "duplicates",
        similarity: 0.9,
        tagOverlap: 0.9,
      },
    ];
    assert.equal(deriveMissionComplementarityFactor(entries), 0);
  });

  test("a competes relationship scores 25", () => {
    const entries: MissionOverlapEntry[] = [
      {
        siblingAddress: "a",
        siblingOpportunityId: "o1",
        siblingTitle: "T",
        relationship: "competes",
        similarity: 0.6,
        tagOverlap: 0.5,
      },
    ];
    assert.equal(deriveMissionComplementarityFactor(entries), 25);
  });

  test("complements-only scores 75-100, scaled by the strongest tagOverlap", () => {
    const entries: MissionOverlapEntry[] = [
      {
        siblingAddress: "a",
        siblingOpportunityId: "o1",
        siblingTitle: "T1",
        relationship: "complements",
        similarity: 0.3,
        tagOverlap: 0.2,
      },
      {
        siblingAddress: "b",
        siblingOpportunityId: "o2",
        siblingTitle: "T2",
        relationship: "complements",
        similarity: 0.4,
        tagOverlap: 0.8,
      },
    ];
    // 75 + 0.8*25 = 95, taken from the strongest tagOverlap across all
    // entries, not just entries[0].
    assert.equal(deriveMissionComplementarityFactor(entries), 95);
  });

  test("uses the worst (first-sorted) relationship, not an average", () => {
    // entries[0] is duplicates even though a later entry complements —
    // checkMissionOverlap()'s own sort guarantees the worst relationship
    // leads, so the factor must key off entries[0] alone.
    const entries: MissionOverlapEntry[] = [
      {
        siblingAddress: "a",
        siblingOpportunityId: "o1",
        siblingTitle: "T1",
        relationship: "duplicates",
        similarity: 0.95,
        tagOverlap: 0.9,
      },
    ];
    assert.equal(deriveMissionComplementarityFactor(entries), 0);
  });
});

describe("deriveTechnologyReuseDepthFactor", () => {
  test("no reuse entries scores 0", () => {
    assert.equal(deriveTechnologyReuseDepthFactor([]), 0);
  });

  test("scales the top entry's reuseScore (0-1) to 0-100", () => {
    const entries: TechnologyReuseEntry[] = [
      { siblingAddress: "a", siblingOpportunityId: "o1", siblingTitle: "T", matches: [], reuseScore: 0.42 },
    ];
    assert.equal(deriveTechnologyReuseDepthFactor(entries), 42);
  });

  test("reads only the top (first-sorted) entry, ignoring the rest", () => {
    const entries: TechnologyReuseEntry[] = [
      { siblingAddress: "a", siblingOpportunityId: "o1", siblingTitle: "T1", matches: [], reuseScore: 0.8 },
      { siblingAddress: "b", siblingOpportunityId: "o2", siblingTitle: "T2", matches: [], reuseScore: 0.99 },
    ];
    assert.equal(deriveTechnologyReuseDepthFactor(entries), 80);
  });
});

// ─── 11e-ii-b: scoreStrategyFit's guard ─────────────────────────────────

describe("scoreStrategyFit — 11c/11d completion guard", () => {
  test("throws naming both missing tools when neither has run", () => {
    reset();
    seedOpportunity("opp1");
    assert.throws(
      () => scoreStrategyFit("opp1"),
      (err: unknown) =>
        err instanceof MissingStrategyFitPrerequisitesError &&
        /check_mission_overlap and check_technology_reuse/.test(err.message),
    );
  });

  test("throws naming only check_technology_reuse when mission overlap has run", () => {
    reset();
    seedOpportunity("opp1");
    missionOverlapByOpportunity.set("opp1", []);
    recordMissionOverlapCheck("opp1");
    assert.throws(
      () => scoreStrategyFit("opp1"),
      (err: unknown) =>
        err instanceof MissingStrategyFitPrerequisitesError &&
        /^check_technology_reuse must run/.test(err.message),
    );
  });

  test("throws naming only check_mission_overlap when technology reuse has run", () => {
    reset();
    seedOpportunity("opp1");
    technologyReuseByOpportunity.set("opp1", []);
    recordTechnologyReuseCheck("opp1");
    assert.throws(
      () => scoreStrategyFit("opp1"),
      (err: unknown) =>
        err instanceof MissingStrategyFitPrerequisitesError &&
        /^check_mission_overlap must run/.test(err.message),
    );
  });

  test("succeeds once both persisting checks have filed, even from an earlier superseded call", () => {
    reset();
    seedOpportunity("opp1");
    missionOverlapByOpportunity.set("opp1", []);
    technologyReuseByOpportunity.set("opp1", []);
    recordMissionOverlapCheck("opp1");
    // A later, unrelated re-run of the same check still leaves a
    // current (non-superseded) mission_overlap record on the row —
    // the guard reads the current row, not "did it run exactly once."
    recordMissionOverlapCheck("opp1");
    recordTechnologyReuseCheck("opp1");

    assert.doesNotThrow(() => scoreStrategyFit("opp1"));
  });

  test("an opportunity id that doesn't resolve throws", () => {
    reset();
    assert.throws(() => scoreStrategyFit("nope"), /opportunity nope not found/);
  });
});

// ─── 11e-ii-b: writing fit_score onto the shared strategy_findings row ──

describe("scoreStrategyFit — writes fit_score without clobbering 11c/11d", () => {
  test("merges fit_score onto the same row as mission_overlap/technology_reuse", () => {
    reset();
    seedOpportunity("opp1");
    missionOverlapByOpportunity.set("opp1", []);
    technologyReuseByOpportunity.set("opp1", []);
    recordMissionOverlapCheck("opp1");
    recordTechnologyReuseCheck("opp1");

    const { finding } = scoreStrategyFit("opp1");
    assert.ok("mission_overlap" in finding.findings);
    assert.ok("technology_reuse" in finding.findings);
    assert.ok("fit_score" in finding.findings);
  });

  test("is superseding on re-run, same versioning as every other finding write", () => {
    reset();
    seedOpportunity("opp1");
    missionOverlapByOpportunity.set("opp1", []);
    technologyReuseByOpportunity.set("opp1", []);
    recordMissionOverlapCheck("opp1");
    recordTechnologyReuseCheck("opp1");

    const first = scoreStrategyFit("opp1");
    const second = scoreStrategyFit("opp1");

    assert.equal(strategyFindings.filter((f) => f.opportunity_id === "opp1" && !f.superseded).length, 1);
    assert.ok(first.finding.version < second.finding.version);
    assert.equal(getCurrentStrategyFinding("opp1")?.id, second.finding.id);
  });

  test("computes fit_score from the derived factors via the documented formula", () => {
    reset();
    seedOpportunity("opp1");
    // complements-only, tagOverlap 0.4 -> missionComplementarity = 75 + 0.4*25 = 85
    missionOverlapByOpportunity.set("opp1", [
      {
        siblingAddress: "a",
        siblingOpportunityId: "o1",
        siblingTitle: "T",
        relationship: "complements",
        similarity: 0.5,
        tagOverlap: 0.4,
      },
    ]);
    // reuseScore 0.6 -> technologyReuseDepth = 60
    technologyReuseByOpportunity.set("opp1", [
      { siblingAddress: "b", siblingOpportunityId: "o2", siblingTitle: "T2", matches: [], reuseScore: 0.6 },
    ]);
    recordMissionOverlapCheck("opp1");
    recordTechnologyReuseCheck("opp1");

    const { fitScore } = scoreStrategyFit("opp1", {
      ecosystemDiversificationValue: 50,
      marketIndependence: 20,
    });

    // 85*0.35 + 60*0.30 + 50*0.20 + 20*0.15 = 29.75 + 18 + 10 + 3 = 60.75
    assert.equal(fitScore.fit_score, 60.75);
    assert.equal(fitScore.fit_formula_version, FIT_FORMULA_VERSION);
    assert.deepEqual(fitScore.factors, {
      missionComplementarity: 85,
      technologyReuseDepth: 60,
      ecosystemDiversificationValue: 50,
      marketIndependence: 20,
    });
  });

  test("omitted ecosystemDiversificationValue/marketIndependence default to 0, not fabricated", () => {
    reset();
    seedOpportunity("opp1");
    missionOverlapByOpportunity.set("opp1", []);
    technologyReuseByOpportunity.set("opp1", []);
    recordMissionOverlapCheck("opp1");
    recordTechnologyReuseCheck("opp1");

    const { fitScore } = scoreStrategyFit("opp1");
    assert.equal(fitScore.factors.ecosystemDiversificationValue, 0);
    assert.equal(fitScore.factors.marketIndependence, 0);
  });

  test("rejects an out-of-range caller-supplied factor before writing any finding", () => {
    reset();
    seedOpportunity("opp1");
    missionOverlapByOpportunity.set("opp1", []);
    technologyReuseByOpportunity.set("opp1", []);
    recordMissionOverlapCheck("opp1");
    recordTechnologyReuseCheck("opp1");
    const beforeCount = strategyFindings.length;

    assert.throws(
      () => scoreStrategyFit("opp1", { marketIndependence: 500 }),
      /marketIndependence must be a finite number between 0 and 100/,
    );
    assert.equal(strategyFindings.length, beforeCount);
  });
});
