// Zent.md Phase 12c: "Recommended relationship type if approved:
// independent / supplier-to-sibling / shared-customer-base — informs
// how Agent B's initial tool grants are scoped at birth."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's recommendRelationshipType() on top
// of inlined mirrors of assessEcosystemStrengthening() (12a) and
// checkCannibalization() (12b), against controllable fake
// checkMissionOverlap()/checkTechnologyReuse() results (rather than
// re-deriving TF-IDF fakes a fourth time — expansionMissionOverlap.test.ts
// and expansionTechnologyReuse.test.ts already cover those two
// functions' own logic in full, expansionEcosystemStrengthening.test.ts
// and expansionCannibalization.test.ts already cover 12a/12b's own
// composition rules; this file only needs to exercise 12c's own rule on
// top of both).
//
// What this covers:
//   12c — a sibling with a sharedInfra signal (12a) and no
//         cannibalization flag (12b) -> supplier-to-sibling, naming
//         that sibling.
//   12c — a sibling with only a sharedCustomers signal and no
//         cannibalization flag -> shared-customer-base, naming that
//         sibling.
//   12c — a sibling with both signals is still supplier-to-sibling
//         (shared-infra takes priority over shared-customer-only).
//   12c — zero existing siblings -> independent, "nothing to relate to"
//         reasoning.
//   12c — siblings exist but clear neither 12a signal -> independent.
//   12c — a sibling that clears a 12a signal but is ALSO flagged by
//         12b's cannibalization check is excluded — recommends
//         independent, not a relationship with that sibling, and lists
//         it in excludedForCannibalization.
//   12c — when the top-scoring eligible signal and a cannibalizing
//         signal are different siblings, the eligible one still wins.
//   12c — an opportunity id that doesn't resolve throws.

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeAgent {
  address: string;
  parent_address: string | null;
  spawn_reason: "self" | "expansion_pipeline";
  opportunity_id: string | null;
}

interface FakeOpportunity {
  id: string;
  title: string;
  agent_address: string;
}

let agents: Map<string, FakeAgent>;
let opportunities: Map<string, FakeOpportunity>;
let missionOverlapFixture: Map<string, MissionOverlapEntry[]>;
let technologyReuseFixture: Map<string, TechnologyReuseEntry[]>;

function reset() {
  agents = new Map();
  opportunities = new Map();
  missionOverlapFixture = new Map();
  technologyReuseFixture = new Map();
}

function seedAgent(overrides: Partial<FakeAgent> & { address: string }): FakeAgent {
  const agent: FakeAgent = {
    parent_address: null,
    spawn_reason: "self",
    opportunity_id: null,
    ...overrides,
  };
  agents.set(agent.address, agent);
  return agent;
}

function seedOpportunity(o: FakeOpportunity): FakeOpportunity {
  opportunities.set(o.id, o);
  return o;
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function setMissionOverlap(opportunityId: string, entries: MissionOverlapEntry[]) {
  missionOverlapFixture.set(opportunityId, entries);
}

function setTechnologyReuse(opportunityId: string, entries: TechnologyReuseEntry[]) {
  technologyReuseFixture.set(opportunityId, entries);
}

// ─── Inlined mirror of listExistingCompanies() (Phase 11b) ─────────────

interface ExistingCompanyMission {
  opportunityId: string;
  title: string;
}

interface ExistingCompany {
  address: string;
  spawnReason: "self" | "expansion_pipeline";
  opportunityId: string | null;
  mission: ExistingCompanyMission | null;
}

function listExistingCompanies(rootAgentAddress: string): ExistingCompany[] {
  const rows = [...agents.values()].filter((a) => a.parent_address === rootAgentAddress);
  return rows.map((row) => {
    let mission: ExistingCompanyMission | null = null;
    if (row.opportunity_id) {
      const opportunity = getOpportunity(row.opportunity_id);
      if (opportunity) {
        mission = { opportunityId: opportunity.id, title: opportunity.title };
      }
    }
    return { address: row.address, spawnReason: row.spawn_reason, opportunityId: row.opportunity_id, mission };
  });
}

// ─── Stand-ins for checkMissionOverlap()/checkTechnologyReuse() (11c/11d) ─

type MissionOverlapRelationship = "duplicates" | "competes" | "complements";

interface MissionOverlapEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  relationship: MissionOverlapRelationship;
  similarity: number;
}

interface TechnologyReuseEntry {
  siblingAddress: string;
}

function checkMissionOverlap(opportunityId: string): MissionOverlapEntry[] {
  if (!getOpportunity(opportunityId)) throw new Error(`opportunity ${opportunityId} not found`);
  return missionOverlapFixture.get(opportunityId) ?? [];
}

function checkTechnologyReuse(opportunityId: string): TechnologyReuseEntry[] {
  if (!getOpportunity(opportunityId)) throw new Error(`opportunity ${opportunityId} not found`);
  return technologyReuseFixture.get(opportunityId) ?? [];
}

// ─── Inlined mirror of assessEcosystemStrengthening() (Phase 12a) ──────

interface EcosystemStrengtheningSignal {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  sharedCustomers: boolean;
  sharedInfra: boolean;
}

interface EcosystemStrengtheningResult {
  opportunityId: string;
  strengthensEcosystem: boolean;
  reasoning: string;
  sharedCustomerSiblings: string[];
  sharedInfraSiblings: string[];
  signals: EcosystemStrengtheningSignal[];
}

function assessEcosystemStrengthening(opportunityId: string): EcosystemStrengtheningResult {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) throw new Error(`opportunity ${opportunityId} not found`);

  const rootAgentAddress = candidate.agent_address;
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
    reasoning = "Shows synergy with at least one existing sibling.";
  }

  return { opportunityId, strengthensEcosystem, reasoning, sharedCustomerSiblings, sharedInfraSiblings, signals };
}

// ─── Inlined mirror of checkCannibalization() (Phase 12b) ──────────────

interface CannibalizationSignal {
  siblingAddress: string;
}

interface CannibalizationCheckResult {
  opportunityId: string;
  cannibalizes: boolean;
  signals: CannibalizationSignal[];
}

function checkCannibalization(opportunityId: string): CannibalizationCheckResult {
  if (!getOpportunity(opportunityId)) throw new Error(`opportunity ${opportunityId} not found`);

  const missionOverlap = checkMissionOverlap(opportunityId);
  const signals: CannibalizationSignal[] = missionOverlap
    .filter((e) => e.relationship === "duplicates" || e.relationship === "competes")
    .map((e) => ({ siblingAddress: e.siblingAddress }));

  return { opportunityId, cannibalizes: signals.length > 0, signals };
}

// ─── Inlined mirror of recommendRelationshipType() (Phase 12c) ─────────

type RecommendedRelationshipType = "independent" | "supplier-to-sibling" | "shared-customer-base";

interface RelationshipTypeRecommendation {
  opportunityId: string;
  relationshipType: RecommendedRelationshipType;
  withSiblingAddress: string | null;
  withSiblingTitle: string | null;
  reasoning: string;
  excludedForCannibalization: string[];
}

function recommendRelationshipType(opportunityId: string): RelationshipTypeRecommendation {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) throw new Error(`opportunity ${opportunityId} not found`);

  const strengthening = assessEcosystemStrengthening(opportunityId);
  const cannibalization = checkCannibalization(opportunityId);
  const cannibalizingAddresses = new Set(cannibalization.signals.map((s) => s.siblingAddress));

  const eligibleSignals = strengthening.signals.filter((s) => !cannibalizingAddresses.has(s.siblingAddress));
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
    };
  }

  const top = eligibleSignals[0];
  const relationshipType: RecommendedRelationshipType = top.sharedInfra ? "supplier-to-sibling" : "shared-customer-base";
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
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

test("an opportunity id that doesn't resolve throws", () => {
  reset();
  assert.throws(() => recommendRelationshipType("nope"), /opportunity nope not found/);
});

test("no existing siblings -> independent, 'nothing to relate to' reasoning", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });

  const result = recommendRelationshipType("opp_candidate");
  assert.equal(result.relationshipType, "independent");
  assert.equal(result.withSiblingAddress, null);
  assert.match(result.reasoning, /nothing to relate to/);
  assert.deepEqual(result.excludedForCannibalization, []);
});

test("siblings exist but clear neither 12a signal -> independent", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentSib", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_sib" });
  seedOpportunity({ id: "opp_sib", title: "Unrelated Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", []);
  setTechnologyReuse("opp_candidate", []);

  const result = recommendRelationshipType("opp_candidate");
  assert.equal(result.relationshipType, "independent");
  assert.match(result.reasoning, /No shared-customer or shared-infra evidence/);
});

test("a sharedInfra-only sibling -> supplier-to-sibling, naming that sibling", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentInfra", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_infra" });
  seedOpportunity({ id: "opp_infra", title: "Infra Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", []);
  setTechnologyReuse("opp_candidate", [{ siblingAddress: "agentInfra" }]);

  const result = recommendRelationshipType("opp_candidate");
  assert.equal(result.relationshipType, "supplier-to-sibling");
  assert.equal(result.withSiblingTitle, "Infra Co");
  assert.match(result.reasoning, /Shared-infra reuse potential with Infra Co/);
});

test("a sharedCustomers-only sibling -> shared-customer-base, naming that sibling", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentComp", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_comp" });
  seedOpportunity({ id: "opp_comp", title: "Complement Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentComp", siblingOpportunityId: "opp_comp", siblingTitle: "Complement Co", relationship: "complements", similarity: 0.4 },
  ]);
  setTechnologyReuse("opp_candidate", []);

  const result = recommendRelationshipType("opp_candidate");
  assert.equal(result.relationshipType, "shared-customer-base");
  assert.equal(result.withSiblingTitle, "Complement Co");
});

test("a sibling with both signals -> supplier-to-sibling (infra takes priority)", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentBoth", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_both" });
  seedOpportunity({ id: "opp_both", title: "Both Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentBoth", siblingOpportunityId: "opp_both", siblingTitle: "Both Co", relationship: "complements", similarity: 0.5 },
  ]);
  setTechnologyReuse("opp_candidate", [{ siblingAddress: "agentBoth" }]);

  const result = recommendRelationshipType("opp_candidate");
  assert.equal(result.relationshipType, "supplier-to-sibling");
});

test("a sibling clearing a 12a signal but also flagged by 12b cannibalization is excluded -> independent", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentDup", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_dup" });
  seedOpportunity({ id: "opp_dup", title: "Duplicate Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  // Same sibling shows up as a "duplicates" mission-overlap entry (12b
  // territory) while also carrying tech-reuse overlap (12a's sharedInfra
  // input) — trivially plausible for two near-identical missions.
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentDup", siblingOpportunityId: "opp_dup", siblingTitle: "Duplicate Co", relationship: "duplicates", similarity: 0.95 },
  ]);
  setTechnologyReuse("opp_candidate", [{ siblingAddress: "agentDup" }]);

  const result = recommendRelationshipType("opp_candidate");
  assert.equal(result.relationshipType, "independent");
  assert.equal(result.withSiblingAddress, null);
  assert.deepEqual(result.excludedForCannibalization, ["Duplicate Co"]);
  assert.match(result.reasoning, /is also flagged by the cannibalization check/);
});

test("an eligible sibling still wins when a different sibling is excluded for cannibalization", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentDup", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_dup" });
  seedAgent({ address: "agentInfra", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_infra" });
  seedOpportunity({ id: "opp_dup", title: "Duplicate Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_infra", title: "Infra Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentDup", siblingOpportunityId: "opp_dup", siblingTitle: "Duplicate Co", relationship: "duplicates", similarity: 0.95 },
  ]);
  setTechnologyReuse("opp_candidate", [
    { siblingAddress: "agentDup" },
    { siblingAddress: "agentInfra" },
  ]);

  const result = recommendRelationshipType("opp_candidate");
  assert.equal(result.relationshipType, "supplier-to-sibling");
  assert.equal(result.withSiblingTitle, "Infra Co");
  assert.deepEqual(result.excludedForCannibalization, ["Duplicate Co"]);
});
