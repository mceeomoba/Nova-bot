// Zent.md Phase 13b: "Committee packet schema: the exact four-report
// bundle the CEO will see, versioned so later CEO models don't need
// every department to re-run when the packet format changes." This
// file is the CommitteePacket counterpart to
// expansionResearchReportShape.test.ts (7b/7e) /
// expansionFinanceReportShape.test.ts (9e) /
// expansionStrategyReportShape.test.ts (11e-iii/12d): schema
// conformance for validateCommitteePacketShape(), so a later change
// can't silently drift the bundle's own contract.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives —
// validateCommitteePacketShape() itself is pure (no db.js import in the
// real file either), so it's copied verbatim rather than re-derived,
// and exercised here against hand-built fixtures instead of a packet
// assembled from a real DB. Recommend re-running against the real
// expansion.ts once a networked environment is available, to confirm
// assembleCommitteePacket()'s own actual output still passes this same
// check (it self-checks internally too — see that function's own
// header).
//
// Updated by Phase 13c: adds financeStrategyDisagreement as an eighth
// locked field (required object, never null — same contract as the
// other four report sections) and bumps COMMITTEE_PACKET_SCHEMA_VERSION
// to "13c-v1". See expansionFinanceStrategyDisagreement.test.ts for
// coverage of computeFinanceStrategyDisagreement() itself; this file's
// own job stays the bundle's shape, not that function's arithmetic.
//
// Updated by Phase 13e: adds completeness as a ninth locked field
// (required object, never null — same contract as the other five
// bundle-level sections) and bumps COMMITTEE_PACKET_SCHEMA_VERSION to
// "13e-v1". See expansionCommitteePacketCompleteness.test.ts for
// coverage of computeCommitteePacketCompleteness()/
// requireCompleteCommitteePacket() themselves; this file's own job
// stays the bundle's shape, not that function's logic.
//
// Updated by Phase 14a: adds deliberation as a tenth locked field
// (required object, never null — a disabled pass reads back
// {enabled: false, ..., locked: true} rather than being absent) and
// bumps COMMITTEE_PACKET_SCHEMA_VERSION to "14a-v1". See
// expansionDeliberation.test.ts for coverage of
// isDeliberationEnabled()/recordDeliberationResponse()/
// getDeliberationExchange() themselves; this file's own job stays the
// bundle's shape, not that logic.
//
// Updated by Phase 14b/14c/14d (landed together — 14c's conditions
// field and 14d's timeout handling are both detail on 14b's own vote
// field, not separate top-level keys): adds votingRecord as an
// eleventh locked field (required object, never null — same contract
// as every other bundle-level section) and bumps
// COMMITTEE_PACKET_SCHEMA_VERSION to "14d-v1". See
// expansionDeliberation.test.ts's own 14b/14c/14d/14e section for
// coverage of recordDepartmentVote()/listDepartmentVotes()/
// getVotingRecord() themselves; this file's own job stays the bundle's
// shape, not that logic.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Copied verbatim from expansion.ts's own 13b/13c/13e/14a/14d constants/function ─

const COMMITTEE_PACKET_SCHEMA_VERSION = "14d-v1";

const COMMITTEE_PACKET_FIELDS = [
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
] as const;

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

function validateCommitteePacketShape(
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

// ─── A minimal, well-formed packet fixture ──────────────────────────────
//
// The nested report objects here are deliberately minimal/fake — this
// file's own job is the BUNDLE's contract (13b), not each nested
// report's own field-by-field contract (already fully covered by 7b/
// 9e/12d's own shape tests). validateCommitteePacketShape() itself
// doesn't recurse into them (see its own header), so an empty object
// satisfies "must be an object" here just as well as a fully-populated
// real report would.

function basePacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opportunityId: "opp_1",
    assembledAt: Date.now(),
    schemaVersion: COMMITTEE_PACKET_SCHEMA_VERSION,
    opportunityIntelligence: { id: "opp_1", title: "Widget Co", thesis: "t", roi_score: 70 },
    researchReport: { opportunityId: "opp_1", findingId: null },
    financeReport: { opportunityId: "opp_1", findingId: null },
    strategyReport: { opportunityId: "opp_1", findingId: null },
    financeStrategyDisagreement: {
      diverges: false,
      financeDirection: null,
      strategyDirection: null,
      recommendedFundingUsdc: null,
      fitScore: null,
      midpoint: 50,
    },
    completeness: {
      complete: false,
      missingReports: ["research", "finance", "strategy"],
      highRegulatoryRisk: false,
    },
    deliberation: {
      enabled: false,
      responses: [],
      respondedDepartments: [],
      missingDepartments: [],
      locked: true,
    },
    votingRecord: {
      deadlineAt: null,
      statuses: [
        { department: "opportunity_intelligence", status: "pending", vote: null },
        { department: "research", status: "pending", vote: null },
        { department: "finance", status: "pending", vote: null },
        { department: "strategy", status: "pending", vote: null },
      ],
      readyForDecision: false,
    },
    ...overrides,
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────

test("a well-formed packet with minimal-but-present report sections passes validation", () => {
  const { valid, errors } = validateCommitteePacketShape(basePacket());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("a well-formed packet with fully-populated nested reports also passes validation", () => {
  const { valid } = validateCommitteePacketShape(
    basePacket({
      researchReport: {
        opportunityId: "opp_1",
        findingId: "resf_1",
        marketSize: { estimate: 100 },
        confidence: "high",
      },
      financeReport: {
        opportunityId: "opp_1",
        findingId: "finf_1",
        sizingRecommendation: { amountUsdc: 5000 },
      },
      strategyReport: {
        opportunityId: "opp_1",
        findingId: "stgf_1",
        fitScore: { fit_score: 81 },
        ecosystemStrengthening: { result: { strengthensEcosystem: true } },
      },
    }),
  );
  assert.equal(valid, true);
});

// ─── The required object sections are required objects, never null ────
//
// Unlike each nested report's own internal sections (each individually
// nullable until that tool has run — 7b/9e/12d's own shape tests cover
// that), the top-level object fields on a CommitteePacket are never
// themselves null: assembleCommitteePacket() always calls
// getOpportunity() plus all three compile*Report() functions (each
// returns a populated object or throws), and always computes
// financeStrategyDisagreement (13c) and completeness (13e) from those
// same results.

test("opportunityIntelligence, researchReport, financeReport, strategyReport, financeStrategyDisagreement, completeness, deliberation, and votingRecord are all required top-level fields", () => {
  for (const field of COMMITTEE_PACKET_FIELDS) {
    assert.ok(COMMITTEE_PACKET_FIELDS.includes(field));
  }
  for (const field of COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS) {
    const packet = basePacket();
    delete (packet as any)[field];
    assert.equal(validateCommitteePacketShape(packet).valid, false, `missing ${field} should fail`);
  }
});

test("the required object sections reject null — unlike each nested report's own internal sections, these are required, not nullable", () => {
  for (const field of COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS) {
    const { valid, errors } = validateCommitteePacketShape(basePacket({ [field]: null }));
    assert.equal(valid, false, `${field}: null should fail`);
    assert.ok(errors.some((e) => e.includes(field) && e.includes("never null")));
  }
});

test("the required object sections reject non-object, non-null values", () => {
  assert.equal(validateCommitteePacketShape(basePacket({ opportunityIntelligence: "opp_1" })).valid, false);
  assert.equal(validateCommitteePacketShape(basePacket({ researchReport: 42 })).valid, false);
  assert.equal(validateCommitteePacketShape(basePacket({ financeReport: [] })).valid, false);
  assert.equal(validateCommitteePacketShape(basePacket({ strategyReport: true })).valid, false);
  assert.equal(validateCommitteePacketShape(basePacket({ completeness: "complete" })).valid, false);
});

// ─── Phase 13e: completeness is present but not deeply validated here ──
//
// Same "bundle-level only" boundary this file's own header already
// draws for researchReport/financeReport/strategyReport (see the test
// at the bottom of this file): validateCommitteePacketShape() checks
// that `completeness` is an object, never null, nothing more.
// computeCommitteePacketCompleteness()'s own field-by-field correctness
// (complete, missingReports, highRegulatoryRisk) is
// expansionCommitteePacketCompleteness.test.ts's job.

test("a garbage-but-present completeness object still passes at the bundle level", () => {
  const { valid } = validateCommitteePacketShape(basePacket({ completeness: { garbage: true } }));
  assert.equal(valid, true);
});

// ─── Phase 14a/14b: deliberation and votingRecord are present but not ──
//     deeply validated here ────────────────────────────────────────────
//
// Same "bundle-level only" boundary as completeness above: this file
// checks that `deliberation` and `votingRecord` are objects, never
// null, nothing more. Their own field-by-field correctness is
// expansionDeliberation.test.ts's job (both the 14a section and the
// 14b/14c/14d/14e section of that same file).

test("a garbage-but-present deliberation object still passes at the bundle level", () => {
  const { valid } = validateCommitteePacketShape(basePacket({ deliberation: { garbage: true } }));
  assert.equal(valid, true);
});

test("a garbage-but-present votingRecord object still passes at the bundle level", () => {
  const { valid } = validateCommitteePacketShape(basePacket({ votingRecord: { garbage: true } }));
  assert.equal(valid, true);
});

// ─── Locked field set: exact, not "at least" ────────────────────────────

test("a packet missing a required field fails validation, naming the field", () => {
  const packet = basePacket();
  delete (packet as any).assembledAt;
  const { valid, errors } = validateCommitteePacketShape(packet);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: assembledAt")));
});

test("a packet with an extra, undeclared field fails validation, naming the field", () => {
  const packet = basePacket({ ceoNotes: "looks promising" });
  const { valid, errors } = validateCommitteePacketShape(packet);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unexpected field: ceoNotes")));
});

test("a renamed field is caught as both a missing field and an unexpected one", () => {
  // Same drift 7e/9e/11e-iii-c's own shape tests worry about, made
  // concrete for the committee packet: a later refactor renames e.g.
  // opportunityIntelligence -> opportunitySignal.
  const packet = basePacket();
  delete (packet as any).opportunityIntelligence;
  (packet as any).opportunitySignal = { title: "x" };
  const { valid, errors } = validateCommitteePacketShape(packet);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: opportunityIntelligence")));
  assert.ok(errors.some((e) => e.includes("unexpected field: opportunitySignal")));
});

// ─── Type checks on scalar fields ───────────────────────────────────────

test("opportunityId must be a non-empty string", () => {
  assert.equal(validateCommitteePacketShape(basePacket({ opportunityId: "" })).valid, false);
  assert.equal(validateCommitteePacketShape(basePacket({ opportunityId: 123 })).valid, false);
});

test("assembledAt must be a number, not a Date or ISO string", () => {
  assert.equal(
    validateCommitteePacketShape(basePacket({ assembledAt: new Date().toISOString() })).valid,
    false,
  );
});

// ─── schemaVersion must match exactly ───────────────────────────────────

test("a packet assembled under a different (future or past) schema version fails validation", () => {
  const { valid, errors } = validateCommitteePacketShape(basePacket({ schemaVersion: "13a-v1" }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("schemaVersion")));
});

test("a missing schemaVersion fails validation, not silently accepted", () => {
  const packet = basePacket();
  delete (packet as any).schemaVersion;
  const { valid, errors } = validateCommitteePacketShape(packet);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("missing field: schemaVersion")));
});

// ─── Bundle-level only: does not recurse into nested report shapes ─────

test("validateCommitteePacketShape does not itself validate each nested report's internal contract — a garbage-but-present report object still passes at the bundle level", () => {
  // Deliberately proving the boundary drawn in this function's own
  // header: nested-report field-by-field validity is 7b/9e/12d's own
  // job (already enforced inside each compile*Report() before
  // assembleCommitteePacket() ever sees the result), not this
  // function's. A hand-built packet with a garbage researchReport
  // object is still bundle-shape-valid.
  const { valid } = validateCommitteePacketShape(
    basePacket({ researchReport: { garbage: true, notAReport: 42 } }),
  );
  assert.equal(valid, true);
});
