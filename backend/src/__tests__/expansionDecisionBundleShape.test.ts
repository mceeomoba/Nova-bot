// Zent.md Phase 15e: "Full audit trail: decision + every report that
// fed it, retrievable as one bundle for as long as Agent B exists —
// this is a record for later analysis, not a hold point." This file is
// the ExpansionAuditBundle counterpart to expansionCommitteePacketShape.test.ts
// (13b/13c/13e/14a/14d): schema conformance for
// validateExpansionAuditBundleShape(), so a later change can't silently
// drift the bundle's own contract.
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives —
// validateExpansionAuditBundleShape() itself is pure (no db.js import
// in the real file either), so it's copied verbatim rather than
// re-derived, and exercised here against hand-built fixtures instead of
// a bundle assembled from a real DB. Recommend re-running against the
// real expansion.ts once a networked environment is available, to
// confirm getExpansionAuditBundle()'s own actual output still passes
// this same check (it self-checks internally too — see that function's
// own header).
//
// committeePacket's own internal contract is already fully covered by
// expansionCommitteePacketShape.test.ts; validateExpansionAuditBundleShape()
// deliberately doesn't recurse into it (see that function's own
// header), so this file's fixtures use the same minimal/fake nested
// packet that file's own basePacket() helper uses — this file's only
// job is the outer bundle's contract.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Copied verbatim from expansion.ts's own 15e constants/function ────

const AUDIT_BUNDLE_SCHEMA_VERSION = "15e-v1";

const AUDIT_BUNDLE_FIELDS = [
  "opportunityId",
  "assembledAt",
  "schemaVersion",
  "opportunity",
  "committeePacket",
  "decisions",
  "latestDecision",
  "genesisTrigger",
] as const;

function validateExpansionAuditBundleShape(
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

// ─── A minimal, well-formed bundle fixture ──────────────────────────────
//
// committeePacket here is the same minimal/fake fixture
// expansionCommitteePacketShape.test.ts's own basePacket() uses — this
// file doesn't re-validate its internals (see this function's own
// header), so an empty-ish object satisfies "must be an object" here
// just as well as a fully-assembled real packet would.

function minimalPacket(): Record<string, unknown> {
  return {
    opportunityId: "opp_1",
    assembledAt: Date.now(),
    schemaVersion: "14d-v1",
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
    completeness: { complete: true, missingReports: [], highRegulatoryRisk: false },
    deliberation: { enabled: false, responses: [], respondedDepartments: [], missingDepartments: [], locked: true },
    votingRecord: { deadlineAt: null, statuses: [], readyForDecision: true },
  };
}

function approvedDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "dec_1",
    opportunity_id: "opp_1",
    committee_votes: { notes: null },
    ceo_decision: "approved",
    decided_at: Date.now(),
    decided_by: "0xCEO",
    ...overrides,
  };
}

function baseBundle(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opportunityId: "opp_1",
    assembledAt: Date.now(),
    schemaVersion: AUDIT_BUNDLE_SCHEMA_VERSION,
    opportunity: { id: "opp_1", title: "Widget Co", thesis: "t", roi_score: 70 },
    committeePacket: minimalPacket(),
    decisions: [approvedDecision()],
    latestDecision: approvedDecision(),
    genesisTrigger: {
      id: "gt_1",
      opportunityId: "opp_1",
      decisionId: "dec_1",
      agentAddress: "0xA",
      recommendedFundingUsdc: 5000,
      status: "completed",
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    ...overrides,
  };
}

// ─── Happy path ─────────────────────────────────────────────────────────

test("a well-formed bundle for an approved, genesis-fired opportunity passes validation", () => {
  const { valid, errors } = validateExpansionAuditBundleShape(baseBundle());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

// ─── The two never-null-and-required object fields ─────────────────────

test("opportunity and committeePacket are required top-level fields", () => {
  for (const field of ["opportunity", "committeePacket"]) {
    const bundle = baseBundle();
    delete (bundle as any)[field];
    assert.equal(
      validateExpansionAuditBundleShape(bundle).valid,
      false,
      `missing ${field} should fail`,
    );
  }
});

test("opportunity and committeePacket reject null and non-object values", () => {
  for (const field of ["opportunity", "committeePacket"]) {
    assert.equal(validateExpansionAuditBundleShape(baseBundle({ [field]: null })).valid, false);
    assert.equal(validateExpansionAuditBundleShape(baseBundle({ [field]: "nope" })).valid, false);
    assert.equal(validateExpansionAuditBundleShape(baseBundle({ [field]: [] })).valid, false);
  }
});

// ─── decisions is an array; latestDecision/genesisTrigger are nullable ─
//
// Unlike opportunity/committeePacket above, these three describe
// history that legitimately hasn't happened yet for a real opportunity:
// the CEO may never have ruled (decisions: [], latestDecision: null),
// and even an approved ruling's genesis trigger is null for every
// opportunity that was rejected, deferred, or never decided — the
// overwhelming common case (Zent.md's own "no good ideas this cycle"
// kill condition and every rejected opportunity both land here).

test("decisions must be an array — rejects a non-array value", () => {
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ decisions: {} })).valid, false);
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ decisions: "none" })).valid, false);
});

test("decisions may be an empty array — a never-ruled-on opportunity is a valid bundle", () => {
  const { valid, errors } = validateExpansionAuditBundleShape(
    baseBundle({ decisions: [], latestDecision: null, genesisTrigger: null }),
  );
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test("latestDecision and genesisTrigger accept null", () => {
  const { valid } = validateExpansionAuditBundleShape(
    baseBundle({ latestDecision: null, genesisTrigger: null }),
  );
  assert.equal(valid, true);
});

test("latestDecision and genesisTrigger reject non-null, non-object values", () => {
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ latestDecision: "approved" })).valid, false);
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ latestDecision: 1 })).valid, false);
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ genesisTrigger: "pending" })).valid, false);
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ genesisTrigger: [] })).valid, false);
});

// ─── Scalar fields and schema versioning, same discipline as every ─────
// other locked bundle in this pipeline (CommitteePacket, ResearchReport,
// FinanceReport, StrategyReport each already have their own version of
// these three checks).

test("opportunityId must be a non-empty string", () => {
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ opportunityId: "" })).valid, false);
  assert.equal(validateExpansionAuditBundleShape(baseBundle({ opportunityId: 42 })).valid, false);
});

test("assembledAt must be a number", () => {
  assert.equal(
    validateExpansionAuditBundleShape(baseBundle({ assembledAt: "now" })).valid,
    false,
  );
});

test("schemaVersion must match AUDIT_BUNDLE_SCHEMA_VERSION exactly", () => {
  const { valid, errors } = validateExpansionAuditBundleShape(
    baseBundle({ schemaVersion: "14d-v1" }),
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("schemaVersion")));
});

// ─── Locked field set — no more, no fewer ───────────────────────────────

test("rejects an unexpected top-level field", () => {
  const { valid, errors } = validateExpansionAuditBundleShape(
    baseBundle({ extraField: "surprise" }),
  );
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes("unexpected field: extraField")));
});

test("rejects a bundle that isn't a plain object", () => {
  assert.equal(validateExpansionAuditBundleShape(null).valid, false);
  assert.equal(validateExpansionAuditBundleShape("bundle").valid, false);
  assert.equal(validateExpansionAuditBundleShape([]).valid, false);
});

// ─── decisions carries every ruling, including superseded `deferred` ────
// ticks — 15c's own header already establishes those are real
// historical facts, not placeholders to discard. This file only checks
// decisions is an array (see above); ordering/content correctness is
// listExpansionDecisions()'s own well-established contract (1d), not
// re-tested here.

test("decisions may hold multiple rulings (e.g. a deferred tick followed by an approval) without failing shape validation", () => {
  const deferred = approvedDecision({ id: "dec_0", ceo_decision: "deferred", decided_at: 1 });
  const approved = approvedDecision({ id: "dec_1", decided_at: 2 });
  const { valid } = validateExpansionAuditBundleShape(
    baseBundle({ decisions: [approved, deferred], latestDecision: approved }),
  );
  assert.equal(valid, true);
});
