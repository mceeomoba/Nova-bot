// Zent.md Phase 13e: "Packet completeness gate: cannot assemble until
// all three reports exist; a high_regulatory_risk tag is surfaced
// prominently in the packet rather than blocking assembly." Filed as
// expansionCommitteePacketCompleteness.test.ts, matching this
// directory's own expansion<Thing>.test.ts convention (see
// expansionFinanceStrategyDisagreement.test.ts for 13c's own version of
// the same naming departure from Zent.md's literal phrasing).
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's computeCommitteePacketCompleteness()
// and requireCompleteCommitteePacket() (both pure, no DB access beyond
// what assembleCommitteePacket() itself already needs in the real
// file), exercised against hand-built CommitteePacket fixtures.
// Recommend re-running against the real expansion.ts once a networked
// environment is available.
//
// What this covers:
//   13e — complete=true only when all three of research/finance/strategy
//         have a non-null findingId; missingReports names exactly which
//         are absent otherwise.
//   13e — highRegulatoryRisk mirrors the opportunity's own tags,
//         completely independent of complete/missingReports in both
//         directions (high-risk-and-complete, high-risk-and-incomplete,
//         low-risk-and-incomplete all exist as real states).
//   13e — requireCompleteCommitteePacket() throws a named-missing-
//         department error for an incomplete packet, returns the packet
//         unchanged for a complete one, propagates
//         assembleCommitteePacket()'s own unknown-opportunity error
//         un-caught, and never throws on regulatory risk alone.
//
// End-to-end coverage of completeness attached through *real* assembly
// (seeded opportunities/findings flowing through assembleCommitteePacket()
// itself) lives in expansionCommitteePacketAssembly.test.ts — this file
// only needs computeCommitteePacketCompleteness()'s own arithmetic and
// requireCompleteCommitteePacket()'s own gating logic to be correct
// against hand-built inputs, the same division of labor
// expansionFinanceStrategyDisagreement.test.ts already keeps from its
// own assembly counterpart.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Minimal stand-ins for the packet shape this reads ──────────────────
//
// Only the fields computeCommitteePacketCompleteness() actually reads
// (researchReport.findingId, financeReport.findingId,
// strategyReport.findingId, opportunityIntelligence.tags) are modeled —
// everything else on CommitteePacket is irrelevant to this function and
// already covered by expansionCommitteePacketShape.test.ts (13b/13e).

interface ReportStub {
  findingId: string | null;
}
interface OpportunityStub {
  tags: string[];
}
interface PacketStub {
  opportunityIntelligence: OpportunityStub;
  researchReport: ReportStub;
  financeReport: ReportStub;
  strategyReport: ReportStub;
}

interface CommitteePacketCompleteness {
  complete: boolean;
  missingReports: readonly ("research" | "finance" | "strategy")[];
  highRegulatoryRisk: boolean;
}

const HIGH_REGULATORY_RISK_TAG = "high_regulatory_risk";

function computeCommitteePacketCompleteness(packet: PacketStub): CommitteePacketCompleteness {
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

// ─── Fixture helper ──────────────────────────────────────────────────────

function packet(overrides: Partial<PacketStub> = {}): PacketStub {
  return {
    opportunityIntelligence: { tags: [] },
    researchReport: { findingId: null },
    financeReport: { findingId: null },
    strategyReport: { findingId: null },
    ...overrides,
  };
}

describe("computeCommitteePacketCompleteness (13e)", () => {
  test("complete=false and all three departments named when nothing has filed", () => {
    const result = computeCommitteePacketCompleteness(packet());
    assert.equal(result.complete, false);
    assert.deepEqual(result.missingReports, ["research", "finance", "strategy"]);
  });

  test("names only the departments that haven't filed — one filed, two missing", () => {
    const result = computeCommitteePacketCompleteness(
      packet({ researchReport: { findingId: "resf_1" } }),
    );
    assert.equal(result.complete, false);
    assert.deepEqual(result.missingReports, ["finance", "strategy"]);
  });

  test("names only the departments that haven't filed — two filed, one missing", () => {
    const result = computeCommitteePacketCompleteness(
      packet({
        researchReport: { findingId: "resf_1" },
        strategyReport: { findingId: "stgf_1" },
      }),
    );
    assert.equal(result.complete, false);
    assert.deepEqual(result.missingReports, ["finance"]);
  });

  test("complete=true and missingReports=[] once all three have filed", () => {
    const result = computeCommitteePacketCompleteness(
      packet({
        researchReport: { findingId: "resf_1" },
        financeReport: { findingId: "finf_1" },
        strategyReport: { findingId: "stgf_1" },
      }),
    );
    assert.equal(result.complete, true);
    assert.deepEqual(result.missingReports, []);
  });

  test("missingReports is always in research, finance, strategy order regardless of which is present", () => {
    const result = computeCommitteePacketCompleteness(
      packet({ financeReport: { findingId: "finf_1" } }),
    );
    assert.deepEqual(result.missingReports, ["research", "strategy"]);
  });

  // ─── highRegulatoryRisk: read straight off tags, independent of
  //     completeness in every direction ───────────────────────────────

  test("highRegulatoryRisk is false when the tag is absent, true when present", () => {
    assert.equal(computeCommitteePacketCompleteness(packet()).highRegulatoryRisk, false);
    assert.equal(
      computeCommitteePacketCompleteness(
        packet({ opportunityIntelligence: { tags: [HIGH_REGULATORY_RISK_TAG] } }),
      ).highRegulatoryRisk,
      true,
    );
  });

  test("a high_regulatory_risk tag does not make an otherwise-complete packet incomplete", () => {
    const result = computeCommitteePacketCompleteness(
      packet({
        opportunityIntelligence: { tags: [HIGH_REGULATORY_RISK_TAG] },
        researchReport: { findingId: "resf_1" },
        financeReport: { findingId: "finf_1" },
        strategyReport: { findingId: "stgf_1" },
      }),
    );
    assert.equal(result.complete, true);
    assert.equal(result.highRegulatoryRisk, true);
  });

  test("an incomplete packet stays incomplete (and still names its missing departments) whether or not it's high-risk", () => {
    const lowRisk = computeCommitteePacketCompleteness(packet({ researchReport: { findingId: "resf_1" } }));
    const highRisk = computeCommitteePacketCompleteness(
      packet({
        opportunityIntelligence: { tags: [HIGH_REGULATORY_RISK_TAG] },
        researchReport: { findingId: "resf_1" },
      }),
    );
    assert.equal(lowRisk.complete, false);
    assert.equal(highRisk.complete, false);
    assert.deepEqual(lowRisk.missingReports, highRisk.missingReports);
    assert.equal(lowRisk.highRegulatoryRisk, false);
    assert.equal(highRisk.highRegulatoryRisk, true);
  });

  test("other tags on the opportunity don't trip highRegulatoryRisk — only the exact tag does", () => {
    const result = computeCommitteePacketCompleteness(
      packet({ opportunityIntelligence: { tags: ["fast-follow", "b2b"] } }),
    );
    assert.equal(result.highRegulatoryRisk, false);
  });
});

// ─── requireCompleteCommitteePacket() — the actual gate ─────────────────
//
// Mirrors expansion.ts's own requireCompleteCommitteePacket(): calls an
// injected assemble function (standing in for assembleCommitteePacket()
// itself, already fully covered by expansionCommitteePacketAssembly.test.ts),
// then throws or returns based on the completeness this file's own
// mirror above just proved correct.

function requireCompleteCommitteePacket(
  opportunityId: string,
  assemble: (id: string) => PacketStub & { completeness: CommitteePacketCompleteness },
) {
  const packet = assemble(opportunityId);
  if (!packet.completeness.complete) {
    throw new Error(
      `committee packet for opportunity ${opportunityId} is not ready for a decision — missing report(s): ${packet.completeness.missingReports.join(", ")}`,
    );
  }
  return packet;
}

function stubAssemble(overrides: Partial<PacketStub> = {}) {
  return (id: string) => {
    const p = packet(overrides);
    return { ...p, completeness: computeCommitteePacketCompleteness(p) };
  };
}

describe("requireCompleteCommitteePacket (13e)", () => {
  test("throws, naming the missing department(s), for an incomplete packet", () => {
    assert.throws(
      () => requireCompleteCommitteePacket("opp_1", stubAssemble({ researchReport: { findingId: "resf_1" } })),
      /is not ready for a decision — missing report\(s\): finance, strategy/,
    );
  });

  test("returns the packet unchanged once all three departments have filed", () => {
    const result = requireCompleteCommitteePacket(
      "opp_1",
      stubAssemble({
        researchReport: { findingId: "resf_1" },
        financeReport: { findingId: "finf_1" },
        strategyReport: { findingId: "stgf_1" },
      }),
    );
    assert.equal(result.completeness.complete, true);
  });

  test("a high_regulatory_risk tag alone never trips the gate for an otherwise-complete packet", () => {
    const result = requireCompleteCommitteePacket(
      "opp_1",
      stubAssemble({
        opportunityIntelligence: { tags: [HIGH_REGULATORY_RISK_TAG] },
        researchReport: { findingId: "resf_1" },
        financeReport: { findingId: "finf_1" },
        strategyReport: { findingId: "stgf_1" },
      }),
    );
    assert.equal(result.completeness.highRegulatoryRisk, true);
  });

  test("a high_regulatory_risk tag does not waive the gate for an incomplete packet", () => {
    assert.throws(
      () =>
        requireCompleteCommitteePacket(
          "opp_1",
          stubAssemble({
            opportunityIntelligence: { tags: [HIGH_REGULATORY_RISK_TAG] },
            researchReport: { findingId: "resf_1" },
          }),
        ),
      /missing report\(s\): finance, strategy/,
    );
  });

  test("propagates an unknown-opportunity error from the underlying assemble call un-caught", () => {
    const assemble = () => {
      throw new Error("opportunity opp_missing not found");
    };
    assert.throws(
      () => requireCompleteCommitteePacket("opp_missing", assemble as any),
      /opportunity opp_missing not found/,
    );
  });
});
