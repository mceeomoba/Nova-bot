// Zent.md Phase 11e-iii-b/c: "compile_strategy_report (12d) picks up
// fit_score and any fit_roi_divergence tag as first-class fields, not
// buried prose — keeps parity with how 7a/9e structure their reports."
// / "GET /expansion/opportunities/:id/strategy (12e) response includes
// fit_score and divergence status; its shape test is extended to assert
// both are present." This file is the Strategy counterpart to
// expansionResearchReportShape.test.ts (7b/7e) and
// expansionFinanceReportShape.test.ts (9e's own shape test): schema
// conformance, so a later change can't silently drift the contract this
// session locked down.
//
// Updated for Phase 12d: compileStrategyReport() now also carries 12a's
// ecosystemStrengthening, 12b's cannibalizationCheck, and 12c's
// relationshipTypeRecommendation as three more nullable, first-class
// sections, and STRATEGY_REPORT_SCHEMA_VERSION moves from "11e-iii-v1"
// to "12d-v1" to match — this file's constants/function are re-copied
// from expansion.ts's own post-12d versions rather than patched
// piecemeal, same as the rest of this file's own "copied verbatim"
// discipline.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives —
// validateStrategyReportShape() itself is pure (no db.js import in the
// real file either), so it's copied verbatim rather than re-derived,
// and exercised here against hand-built fixtures instead of records
// compiled from a real DB. Recommend re-running against the real
// expansion.ts once a networked environment is available, to confirm
// compileStrategyReport()'s own actual output still passes this same
// check (it self-checks internally too — see that function's own
// header).

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Copied verbatim from expansion.ts's own post-12d constants/function ──

const STRATEGY_REPORT_SCHEMA_VERSION = "12d-v1";

const STRATEGY_REPORT_FIELDS = [
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
] as const;

const STRATEGY_REPORT_NULLABLE_OBJECT_FIELDS = [
  "missionOverlap",
  "technologyReuse",
  "fitScore",
  "fitRoiDivergence",
  "ecosystemStrengthening",
  "cannibalizationCheck",
  "relationshipTypeRecommendation",
] as const;

function validateStrategyReportShape(
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

// ─── A minimal, fully-null but otherwise valid report fixture ──────────

function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opportunityId: "opp_1",
    findingId: null,
    findingVersion: null,
    compiledAt: Date.now(),
    schemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
    missionOverlap: null,
    technologyReuse: null,
    fitScore: null,
    fitRoiDivergence: null,
    ecosystemStrengthening: null,
    cannibalizationCheck: null,
    relationshipTypeRecommendation: null,
    ...overrides,
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────

test("a well-formed all-null report (Strategy hasn't run yet) passes validation", () => {
  const { valid, errors } = validateStrategyReportShape(baseReport());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("a well-formed report with every section populated passes validation", () => {
  const { valid } = validateStrategyReportShape(
    baseReport({
      findingId: "stgf_1",
      findingVersion: 3,
      missionOverlap: { entries: [], checkedAt: Date.now() },
      technologyReuse: { entries: [], checkedAt: Date.now() },
      fitScore: {
        fit_score: 62.5,
        fit_formula_version: "11e-i-v1",
        factors: {
          missionComplementarity: 75,
          technologyReuseDepth: 40,
          ecosystemDiversificationValue: 0,
          marketIndependence: 0,
        },
      },
      fitRoiDivergence: { diverges: false, fitScore: 62.5, roiScore: 55, delta: 7.5, threshold: 30 },
      ecosystemStrengthening: {
        result: {
          opportunityId: "opp_1",
          strengthensEcosystem: true,
          reasoning: "Shows shared-infra reuse potential with Infra Co.",
          sharedCustomerSiblings: [],
          sharedInfraSiblings: ["Infra Co"],
          signals: [],
          assessedAt: Date.now(),
        },
        checkedAt: Date.now(),
      },
      cannibalizationCheck: {
        result: {
          opportunityId: "opp_1",
          cannibalizes: false,
          reasoning: "No overlapping-mission siblings found — no cannibalization risk identified.",
          cannibalizedSiblings: [],
          signals: [],
          checkedAt: Date.now(),
        },
        checkedAt: Date.now(),
      },
      relationshipTypeRecommendation: {
        result: {
          opportunityId: "opp_1",
          relationshipType: "supplier-to-sibling",
          withSiblingAddress: "agentInfra",
          withSiblingTitle: "Infra Co",
          reasoning: "Shared-infra reuse potential with Infra Co.",
          excludedForCannibalization: [],
          recommendedAt: Date.now(),
        },
        recordedAt: Date.now(),
      },
    }),
  );
  assert.equal(valid, true);
});

// ─── 12d: ecosystemStrengthening/cannibalizationCheck/
//     relationshipTypeRecommendation are first-class fields ───────────

test("ecosystemStrengthening, cannibalizationCheck, and relationshipTypeRecommendation are all required top-level fields", () => {
  assert.ok(STRATEGY_REPORT_FIELDS.includes("ecosystemStrengthening"));
  assert.ok(STRATEGY_REPORT_FIELDS.includes("cannibalizationCheck"));
  assert.ok(STRATEGY_REPORT_FIELDS.includes("relationshipTypeRecommendation"));

  for (const field of ["ecosystemStrengthening", "cannibalizationCheck", "relationshipTypeRecommendation"] as const) {
    const report = baseReport();
    delete (report as any)[field];
    assert.equal(validateStrategyReportShape(report).valid, false, `missing ${field} should fail`);
  }
});

test("a report where 12a/12b/12c haven't run yet (all three null) still passes, same as the older sections", () => {
  const { valid } = validateStrategyReportShape(
    baseReport({ fitScore: null, fitRoiDivergence: null }),
  );
  assert.equal(valid, true);
});

test("12a/12b/12c sections reject non-object, non-null values", () => {
  assert.equal(validateStrategyReportShape(baseReport({ ecosystemStrengthening: "yes" })).valid, false);
  assert.equal(validateStrategyReportShape(baseReport({ cannibalizationCheck: true })).valid, false);
  assert.equal(validateStrategyReportShape(baseReport({ relationshipTypeRecommendation: [] })).valid, false);
});

// ─── 11e-iii-c: fit_score and divergence status must be present as
//     first-class top-level fields, not buried prose ─────────────────

test("fitScore and fitRoiDivergence are both required top-level fields", () => {
  assert.ok(STRATEGY_REPORT_FIELDS.includes("fitScore"));
  assert.ok(STRATEGY_REPORT_FIELDS.includes("fitRoiDivergence"));

  const missingFitScore = baseReport();
  delete (missingFitScore as any).fitScore;
  assert.equal(validateStrategyReportShape(missingFitScore).valid, false);

  const missingDivergence = baseReport();
  delete (missingDivergence as any).fitRoiDivergence;
  assert.equal(validateStrategyReportShape(missingDivergence).valid, false);
});

test("a report with a divergence verdict but no fit_score still passes shape validation", () => {
  // The shape check only enforces the report's own top-level contract
  // (object-or-null per section) — it does not cross-validate that
  // fitRoiDivergence is only ever non-null alongside fitScore. That
  // pairing invariant is scoreStrategyFit()'s own job (it always writes
  // both in the same merge — see that function's header), not this
  // report-shape check's; a hand-built fixture violating the invariant
  // is still a structurally valid report as far as this function is
  // concerned, the same "guard the report's own contract, don't
  // duplicate each section's internal shape" posture
  // validateResearchReportShape()'s own header commits to.
  const { valid } = validateStrategyReportShape(
    baseReport({
      fitRoiDivergence: { diverges: true, fitScore: 80, roiScore: 20, delta: 60, threshold: 30 },
    }),
  );
  assert.equal(valid, true);
});

// ─── Locked field set: exact, not "at least" ────────────────────────────

test("a report missing a required field fails validation, naming the field", () => {
  const report = baseReport();
  delete (report as any).technologyReuse;
  const { valid, errors } = validateStrategyReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: technologyReuse")));
});

test("a report with an extra, undeclared field fails validation, naming the field", () => {
  const report = baseReport({ strategyAnalystNotes: "strong complement to sibling B" });
  const { valid, errors } = validateStrategyReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unexpected field: strategyAnalystNotes")));
});

test("a renamed field is caught as both a missing field and an unexpected one", () => {
  // Same drift 7e/9e's own shape tests worry about, made concrete for
  // Strategy: a later refactor renames e.g. fitRoiDivergence -> divergence.
  const report = baseReport();
  delete (report as any).fitRoiDivergence;
  (report as any).divergence = { diverges: false };
  const { valid, errors } = validateStrategyReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: fitRoiDivergence")));
  assert.ok(errors.some((e) => e.includes("unexpected field: divergence")));
});

// ─── Type checks on scalar fields ───────────────────────────────────────

test("opportunityId must be a non-empty string", () => {
  assert.equal(validateStrategyReportShape(baseReport({ opportunityId: "" })).valid, false);
  assert.equal(validateStrategyReportShape(baseReport({ opportunityId: 123 })).valid, false);
});

test("compiledAt must be a number, not a Date or ISO string", () => {
  assert.equal(
    validateStrategyReportShape(baseReport({ compiledAt: new Date().toISOString() })).valid,
    false,
  );
});

test("findingId/findingVersion accept null OR their real type, nothing else", () => {
  assert.equal(validateStrategyReportShape(baseReport({ findingId: null })).valid, true);
  assert.equal(validateStrategyReportShape(baseReport({ findingId: "stgf_1" })).valid, true);
  assert.equal(validateStrategyReportShape(baseReport({ findingId: 42 })).valid, false);
  assert.equal(validateStrategyReportShape(baseReport({ findingVersion: null })).valid, true);
  assert.equal(validateStrategyReportShape(baseReport({ findingVersion: 2 })).valid, true);
  assert.equal(validateStrategyReportShape(baseReport({ findingVersion: "2" })).valid, false);
});

// ─── schemaVersion must match exactly ───────────────────────────────────

test("a report compiled under a different (future or past) schema version fails validation", () => {
  const { valid, errors } = validateStrategyReportShape(baseReport({ schemaVersion: "11e-iii-v1" }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("schemaVersion")));
});

test("a missing schemaVersion fails validation, not silently accepted", () => {
  const report = baseReport();
  delete (report as any).schemaVersion;
  const { valid, errors } = validateStrategyReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: schemaVersion")));
});

// ─── Nullable-object sections: null or object, never a bare value ──────

test("a section can't be a string, number, or array — object or null only", () => {
  assert.equal(validateStrategyReportShape(baseReport({ fitScore: "not yet run" })).valid, false);
  assert.equal(validateStrategyReportShape(baseReport({ fitRoiDivergence: 60 })).valid, false);
  assert.equal(validateStrategyReportShape(baseReport({ missionOverlap: [] })).valid, false);
});
