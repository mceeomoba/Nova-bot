// Zent.md Phase 9e ("compile_finance_report(opportunity_id) — one
// structured report, same discipline as 7a") bundles 7a+7b's discipline
// into one phase for Finance — see expansion.ts's own Phase 9e header.
// This file is the finance counterpart to
// expansionResearchReportShape.test.ts (7b/7e): schema conformance, so
// a later change can't silently drift the finance report's own locked
// contract.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory gives — validateFinanceReportShape()
// itself is pure (no db.js import in the real file either), so it's
// copied verbatim rather than re-derived, and exercised here against
// hand-built fixtures instead of records compiled from a real DB.
// Recommend re-running against the real expansion.ts once a networked
// environment is available, to confirm compileFinanceReport()'s own
// actual output still passes this same check (it self-checks internally
// too — see that function's own header).

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Copied verbatim from expansion.ts's own Phase 9e constants/function ──

const FINANCE_REPORT_SCHEMA_VERSION = "9e-v1";

const FINANCE_REPORT_FIELDS = [
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
] as const;

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

function validateFinanceReportShape(
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

// ─── A minimal, fully-null but otherwise valid report fixture ──────────

function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opportunityId: "opp_1",
    findingId: null,
    findingVersion: null,
    compiledAt: Date.now(),
    schemaVersion: FINANCE_REPORT_SCHEMA_VERSION,
    buildCost: null,
    timeToRevenue: null,
    availableCapital: null,
    runwayCheck: null,
    worstCaseLoss: null,
    sizingRecommendation: null,
    stagedFundingOption: null,
    sensitivityNote: null,
    ...overrides,
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────

test("a well-formed all-null report passes validation", () => {
  const { valid, errors } = validateFinanceReportShape(baseReport());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("a well-formed report with every section populated passes validation", () => {
  const { valid } = validateFinanceReportShape(
    baseReport({
      findingId: "finf_1",
      findingVersion: 5,
      buildCost: { basis: "historical_department_spend", estimatedBuildCostUsdc: 300 },
      timeToRevenue: { basis: "historical_department_duration", estimatedMonthsToRevenue: 6 },
      availableCapital: { availableExpansionCapitalUsdc: 400, dailySpendRateUsdc: 10 },
      runwayCheck: { runwayMonthsAfterFunding: 12, passes: true },
      worstCaseLoss: { worstCaseLossUsdc: 450 },
      sizingRecommendation: { recommendedFundingUsdc: 300, fullyFunded: true },
      stagedFundingOption: { initialGrantUsdc: 150, followOnUsdc: 150 },
      sensitivityNote: { mostSensitiveFactor: "build_cost" },
    }),
  );
  assert.equal(valid, true);
});

// ─── Locked field set: exact, not "at least" ────────────────────────────

test("a report missing a required field fails validation, naming the field", () => {
  const report = baseReport();
  delete (report as any).sensitivityNote;
  const { valid, errors } = validateFinanceReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: sensitivityNote")));
});

test("a report with an extra, undeclared field fails validation, naming the field", () => {
  const report = baseReport({ financeAnalystNotes: "looks solid" });
  const { valid, errors } = validateFinanceReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unexpected field: financeAnalystNotes")));
});

test("a renamed field is caught as both a missing field and an unexpected one", () => {
  // Same drift 7e worried about for research, made concrete for
  // finance: a later refactor renames e.g. sensitivityNote -> sensitivity.
  const report = baseReport();
  delete (report as any).sensitivityNote;
  (report as any).sensitivity = { mostSensitiveFactor: "build_cost" };
  const { valid, errors } = validateFinanceReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: sensitivityNote")));
  assert.ok(errors.some((e) => e.includes("unexpected field: sensitivity")));
});

// ─── Type checks on scalar fields ───────────────────────────────────────

test("opportunityId must be a non-empty string", () => {
  assert.equal(validateFinanceReportShape(baseReport({ opportunityId: "" })).valid, false);
  assert.equal(validateFinanceReportShape(baseReport({ opportunityId: 123 })).valid, false);
});

test("compiledAt must be a number, not a Date or ISO string", () => {
  assert.equal(
    validateFinanceReportShape(baseReport({ compiledAt: new Date().toISOString() })).valid,
    false,
  );
});

test("findingId/findingVersion accept null OR their real type, nothing else", () => {
  assert.equal(validateFinanceReportShape(baseReport({ findingId: null })).valid, true);
  assert.equal(validateFinanceReportShape(baseReport({ findingId: "finf_1" })).valid, true);
  assert.equal(validateFinanceReportShape(baseReport({ findingId: 42 })).valid, false);
  assert.equal(validateFinanceReportShape(baseReport({ findingVersion: null })).valid, true);
  assert.equal(validateFinanceReportShape(baseReport({ findingVersion: 2 })).valid, true);
  assert.equal(validateFinanceReportShape(baseReport({ findingVersion: "2" })).valid, false);
});

// ─── schemaVersion must match exactly ───────────────────────────────────

test("a report compiled under a different (future or past) schema version fails validation", () => {
  const { valid, errors } = validateFinanceReportShape(baseReport({ schemaVersion: "9e-v2" }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("schemaVersion")));
});

test("a missing schemaVersion (pre-9e report shape) fails validation, not silently accepted", () => {
  const report = baseReport();
  delete (report as any).schemaVersion;
  const { valid, errors } = validateFinanceReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: schemaVersion")));
});

// ─── Nullable-object sections: null or object, never a bare value ──────

test("a raw-evidence section can't be a string, number, or array — object or null only", () => {
  assert.equal(validateFinanceReportShape(baseReport({ buildCost: "not yet run" })).valid, false);
  assert.equal(validateFinanceReportShape(baseReport({ worstCaseLoss: 450 })).valid, false);
  assert.equal(validateFinanceReportShape(baseReport({ sensitivityNote: [] })).valid, false);
});

// ─── Non-object input entirely ──────────────────────────────────────────

test("null, an array, or a primitive is rejected outright, not partially checked", () => {
  assert.equal(validateFinanceReportShape(null).valid, false);
  assert.equal(validateFinanceReportShape([1, 2, 3]).valid, false);
  assert.equal(validateFinanceReportShape("a report").valid, false);
  assert.equal(validateFinanceReportShape(undefined).valid, false);
});

// ─── errors array accumulates every violation, not just the first ──────

test("multiple simultaneous violations all show up in errors, not just the first one found", () => {
  const report = baseReport({
    opportunityId: "",
    schemaVersion: "wrong",
    buildCost: "not an object",
  });
  delete (report as any).sensitivityNote;
  const { valid, errors } = validateFinanceReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.length >= 4);
});

// ─── This file's own equivalent of research-shape's cross-department ───
// ─── worry: a research-report-shaped object never passes as finance ────

test("a research-report-shaped object is rejected outright, not partially accepted", () => {
  const researchShapedReport = {
    opportunityId: "opp_1",
    findingId: "resf_1",
    findingVersion: 1,
    compiledAt: Date.now(),
    schemaVersion: "7b-v1",
    marketSize: { query: "q", results: [], estimatedAt: 1 },
    competition: null,
    customerSegments: null,
    technicalRequirements: null,
    regulatoryRisk: null,
    buildability: null,
    riskScoring: null,
    confidence: "med",
    selfReportedConfidence: null,
    sources: [],
  };
  const { valid, errors } = validateFinanceReportShape(researchShapedReport);
  assert.equal(valid, false);
  // Missing every real finance field...
  assert.ok(errors.some((e) => e.includes("missing field: buildCost")));
  assert.ok(errors.some((e) => e.includes("missing field: sizingRecommendation")));
  // ...and every research-only field flagged as unexpected.
  assert.ok(errors.some((e) => e.includes("unexpected field: marketSize")));
  assert.ok(errors.some((e) => e.includes("unexpected field: riskScoring")));
  // The wrong schemaVersion is caught too, independent of the field-set checks.
  assert.ok(errors.some((e) => e.includes("schemaVersion")));
});

// ─── The locked field list itself: exactly 13, no accidental additions ──

test("FINANCE_REPORT_FIELDS has exactly the 13 locked fields — a stray addition here would silently widen the contract for every consumer", () => {
  assert.equal(FINANCE_REPORT_FIELDS.length, 13);
  assert.deepEqual(new Set(FINANCE_REPORT_FIELDS).size, FINANCE_REPORT_FIELDS.length);
});
