// Zent.md Phase 7b + Phase 7e.
//
// 7b: "Report schema locked down (so Finance/Strategy/CEO can parse it
// programmatically, not just read prose)." This is the runtime-
// conformance half of 7a's ResearchReport type — a copy that
// TypeScript's own compile-time checking can't provide once a report
// has crossed an HTTP boundary and is just JSON again.
//
// 7e: "Test: research-report-shape.test.ts — schema conformance, so a
// later department type can't silently drift the contract." This file
// IS that test (kept under the expansion*.test.ts naming convention
// every other Zent.md phase's test file in this directory already
// uses, rather than the kebab-case filename Zent.md's own prose
// suggests — same translation expansionResearchReport.test.ts (7a),
// expansionRiskScoring.test.ts (6d), etc. already made). It's exercised
// directly against an inlined copy of validateResearchReportShape()/
// RESEARCH_REPORT_FIELDS, kept byte-for-byte in sync with expansion.ts's
// own copy — re-run against the real function once a networked
// environment is available (see the DB note below) to confirm neither
// copy has drifted from the other.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory gives — validateResearchReportShape()
// itself is pure (no db.js import in the real file either), so it's
// copied verbatim rather than re-derived, and exercised here against
// hand-built fixtures instead of records compiled from a real DB.
// Recommend re-running against the real expansion.ts once a networked
// environment is available, to confirm compileResearchReport()'s own
// actual output still passes this same check (it self-checks internally
// too — see that function's own header).

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Copied verbatim from expansion.ts's own Phase 7b constants/function ──

const RESEARCH_REPORT_SCHEMA_VERSION = "7b-v1";

const RESEARCH_REPORT_FIELDS = [
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
] as const;

const RESEARCH_REPORT_NULLABLE_OBJECT_FIELDS = [
  "marketSize",
  "competition",
  "customerSegments",
  "technicalRequirements",
  "regulatoryRisk",
  "buildability",
  "riskScoring",
] as const;

const RESEARCH_CONFIDENCE_LEVELS = ["low", "med", "high"];
function isValidResearchConfidence(value: unknown): boolean {
  return typeof value === "string" && RESEARCH_CONFIDENCE_LEVELS.includes(value);
}

function validateResearchReportShape(
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

// ─── A minimal, fully-null but otherwise valid report fixture ──────────

function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opportunityId: "opp_1",
    findingId: null,
    findingVersion: null,
    compiledAt: Date.now(),
    schemaVersion: RESEARCH_REPORT_SCHEMA_VERSION,
    marketSize: null,
    competition: null,
    customerSegments: null,
    technicalRequirements: null,
    regulatoryRisk: null,
    buildability: null,
    riskScoring: null,
    confidence: null,
    selfReportedConfidence: null,
    sources: [],
    ...overrides,
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────

test("a well-formed all-null report passes validation", () => {
  const { valid, errors } = validateResearchReportShape(baseReport());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("a well-formed report with every section populated passes validation", () => {
  const { valid } = validateResearchReportShape(
    baseReport({
      findingId: "resf_1",
      findingVersion: 3,
      marketSize: { query: "q", results: [], estimatedAt: 1 },
      competition: { query: "q", results: [], surveyedAt: 1 },
      customerSegments: { query: "q", results: [], identifiedAt: 1 },
      technicalRequirements: { query: "q", results: [], assessedAt: 1 },
      regulatoryRisk: { domains: [], riskLevel: "none", assessedAt: 1 },
      buildability: { matches: [], flagged: false, threshold: 0.2, assessedAt: 1 },
      riskScoring: {
        regulatoryRiskLevel: "none",
        buildabilityFlagged: false,
        overallRiskLevel: "low",
        score: 0,
        scoredAt: 1,
      },
      confidence: "high",
      selfReportedConfidence: "high",
      sources: ["https://a.example"],
    }),
  );
  assert.equal(valid, true);
});

// ─── Locked field set: exact, not "at least" ────────────────────────────

test("a report missing a required field fails validation, naming the field", () => {
  const report = baseReport();
  delete (report as any).riskScoring;
  const { valid, errors } = validateResearchReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: riskScoring")));
});

test("a report with an extra, undeclared field fails validation, naming the field", () => {
  const report = baseReport({ finderConfidenceNotes: "looks solid" });
  const { valid, errors } = validateResearchReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unexpected field: finderConfidenceNotes")));
});

test("a renamed field is caught as both a missing field and an unexpected one", () => {
  // Simulates exactly the drift Zent.md 7e worries about: a later
  // department type or a refactor renames e.g. riskScoring -> risk.
  const report = baseReport();
  delete (report as any).riskScoring;
  (report as any).risk = { overallRiskLevel: "low" };
  const { valid, errors } = validateResearchReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: riskScoring")));
  assert.ok(errors.some((e) => e.includes("unexpected field: risk")));
});

// ─── Type checks on scalar fields ───────────────────────────────────────

test("opportunityId must be a non-empty string", () => {
  assert.equal(validateResearchReportShape(baseReport({ opportunityId: "" })).valid, false);
  assert.equal(validateResearchReportShape(baseReport({ opportunityId: 123 })).valid, false);
});

test("compiledAt must be a number, not a Date or ISO string", () => {
  assert.equal(
    validateResearchReportShape(baseReport({ compiledAt: new Date().toISOString() })).valid,
    false,
  );
});

test("findingId/findingVersion accept null OR their real type, nothing else", () => {
  assert.equal(validateResearchReportShape(baseReport({ findingId: null })).valid, true);
  assert.equal(validateResearchReportShape(baseReport({ findingId: "resf_1" })).valid, true);
  assert.equal(validateResearchReportShape(baseReport({ findingId: 42 })).valid, false);
  assert.equal(validateResearchReportShape(baseReport({ findingVersion: null })).valid, true);
  assert.equal(validateResearchReportShape(baseReport({ findingVersion: 2 })).valid, true);
  assert.equal(validateResearchReportShape(baseReport({ findingVersion: "2" })).valid, false);
});

// ─── schemaVersion must match exactly ───────────────────────────────────

test("a report compiled under a different (future or past) schema version fails validation", () => {
  const { valid, errors } = validateResearchReportShape(baseReport({ schemaVersion: "7b-v2" }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("schemaVersion")));
});

test("a missing schemaVersion (pre-7b report shape) fails validation, not silently accepted", () => {
  const report = baseReport();
  delete (report as any).schemaVersion;
  const { valid, errors } = validateResearchReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: schemaVersion")));
});

// ─── Nullable-object sections: null or object, never a bare value ──────

test("a raw-evidence section can't be a string, number, or array — object or null only", () => {
  assert.equal(validateResearchReportShape(baseReport({ marketSize: "not yet run" })).valid, false);
  assert.equal(validateResearchReportShape(baseReport({ buildability: 42 })).valid, false);
  assert.equal(validateResearchReportShape(baseReport({ riskScoring: [] })).valid, false);
});

// ─── confidence / selfReportedConfidence must be real levels or null ────

test("confidence must be low/med/high or null, not an arbitrary string", () => {
  assert.equal(validateResearchReportShape(baseReport({ confidence: "low" })).valid, true);
  assert.equal(validateResearchReportShape(baseReport({ confidence: null })).valid, true);
  assert.equal(validateResearchReportShape(baseReport({ confidence: "very confident" })).valid, false);
});

test("selfReportedConfidence follows the same rule as confidence", () => {
  assert.equal(
    validateResearchReportShape(baseReport({ selfReportedConfidence: "high" })).valid,
    true,
  );
  assert.equal(
    validateResearchReportShape(baseReport({ selfReportedConfidence: "sort of" })).valid,
    false,
  );
});

// ─── sources must be string[] ───────────────────────────────────────────

test("sources must be an array of strings, not a single string or mixed array", () => {
  assert.equal(validateResearchReportShape(baseReport({ sources: [] })).valid, true);
  assert.equal(
    validateResearchReportShape(baseReport({ sources: ["https://a.example"] })).valid,
    true,
  );
  assert.equal(
    validateResearchReportShape(baseReport({ sources: "https://a.example" })).valid,
    false,
  );
  assert.equal(
    validateResearchReportShape(baseReport({ sources: ["https://a.example", 7] })).valid,
    false,
  );
});

// ─── Non-object input entirely ──────────────────────────────────────────

test("null, an array, or a primitive is rejected outright, not partially checked", () => {
  assert.equal(validateResearchReportShape(null).valid, false);
  assert.equal(validateResearchReportShape([1, 2, 3]).valid, false);
  assert.equal(validateResearchReportShape("a report").valid, false);
  assert.equal(validateResearchReportShape(undefined).valid, false);
});

// ─── errors array accumulates every violation, not just the first ──────

test("multiple simultaneous violations all show up in errors, not just the first one found", () => {
  const report = baseReport({
    opportunityId: "",
    schemaVersion: "wrong",
    sources: "not an array",
  });
  delete (report as any).riskScoring;
  const { valid, errors } = validateResearchReportShape(report);
  assert.equal(valid, false);
  assert.ok(errors.length >= 4);
});

// ─── Phase 7e's actual worry, made concrete: a DIFFERENT department's ──
// ─── report shape (Phase 8/11, not built yet) never passes as research ──

test("a finance-report-shaped object (Zent.md Phase 9e's compile_finance_report, not yet built) is rejected outright, not partially accepted", () => {
  // Exactly the drift 7e exists to catch, made concrete instead of
  // abstract: Finance's eventual report will have its own fields
  // (buildCostUsdc, worstCaseLossUsdc, sizingRecommendationUsdc, ...)
  // that mean something in ITS contract and nothing in Research's. A
  // caller that accidentally hands a finance report to something
  // expecting a research report (a wiring mistake in the eventual
  // committee-packet assembly, Phase 13a) must get a loud rejection,
  // not a validator that shrugs because "it's an object with some
  // fields."
  const financeShapedReport = {
    opportunityId: "opp_1",
    compiledAt: Date.now(),
    schemaVersion: "9e-v1",
    buildCostUsdc: 1200,
    timeToRevenueMonths: 4,
    worstCaseLossUsdc: 1200,
    sizingRecommendationUsdc: 500,
    runwayMonthsAfterFunding: 8,
  };
  const { valid, errors } = validateResearchReportShape(financeShapedReport);
  assert.equal(valid, false);
  // Missing every real research field...
  assert.ok(errors.some((e) => e.includes("missing field: findingId")));
  assert.ok(errors.some((e) => e.includes("missing field: marketSize")));
  assert.ok(errors.some((e) => e.includes("missing field: riskScoring")));
  // ...and every finance-only field flagged as unexpected.
  assert.ok(errors.some((e) => e.includes("unexpected field: buildCostUsdc")));
  assert.ok(errors.some((e) => e.includes("unexpected field: sizingRecommendationUsdc")));
  // The wrong schemaVersion is caught too, independent of the field-set checks.
  assert.ok(errors.some((e) => e.includes("schemaVersion")));
});

// ─── The locked field list itself: exactly 15, no accidental additions ──

test("RESEARCH_REPORT_FIELDS has exactly the 15 locked fields — a stray addition here would silently widen the contract for every consumer", () => {
  assert.equal(RESEARCH_REPORT_FIELDS.length, 15);
  assert.deepEqual(new Set(RESEARCH_REPORT_FIELDS).size, RESEARCH_REPORT_FIELDS.length);
});
