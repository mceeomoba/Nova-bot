// Zent.md Phase 12a: "Tool: `assess_ecosystem_strengthening
// (opportunity_id)` — does this new company make the existing
// portfolio more resilient (shared customers, shared infra) or just
// add headcount."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's assessEcosystemStrengthening()
// against plain in-memory maps standing in for `agents`/`opportunities`,
// and against controllable fake checkMissionOverlap()/
// checkTechnologyReuse() results (rather than re-deriving TF-IDF fakes
// a third time — expansionMissionOverlap.test.ts and
// expansionTechnologyReuse.test.ts already cover those two functions'
// own logic in full; this file only needs to control their *output* to
// exercise 12a's own composition rule on top of it).
//
// What this covers:
//   12a — a sibling in checkMissionOverlap()'s "complements" bucket is
//         read as sharedCustomers=true.
//   12a — a sibling in checkMissionOverlap()'s "duplicates"/"competes"
//         buckets is NOT read as sharedCustomers, even though it's a
//         real mission-overlap entry — those are cannibalization
//         signals (12b's future territory), not strengthening ones.
//   12a — a sibling present in checkTechnologyReuse()'s results is read
//         as sharedInfra=true.
//   12a — a sibling with neither signal is omitted from `signals`
//         entirely.
//   12a — a sibling with both signals sorts ahead of a sibling with
//         only one.
//   12a — zero existing siblings -> strengthensEcosystem: false, with
//         a "first sibling" reasoning, not a hopeful true.
//   12a — siblings exist but none clear either signal ->
//         strengthensEcosystem: false, with a "no evidence" reasoning.
//   12a — at least one sibling clears a signal -> strengthensEcosystem:
//         true, and sharedCustomerSiblings/sharedInfraSiblings list the
//         right titles.
//   12a — an opportunity id that doesn't resolve throws.

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
//
// Controllable via setMissionOverlap()/setTechnologyReuse() above — see
// this file's own header for why full TF-IDF fakes aren't re-derived
// here.

type MissionOverlapRelationship = "duplicates" | "competes" | "complements";

interface MissionOverlapEntry {
  siblingAddress: string;
  relationship: MissionOverlapRelationship;
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
    const parts: string[] = [];
    if (sharedCustomerSiblings.length > 0) parts.push(`shared-customer overlap with ${sharedCustomerSiblings.join(", ")}`);
    if (sharedInfraSiblings.length > 0) parts.push(`shared-infra reuse potential with ${sharedInfraSiblings.join(", ")}`);
    reasoning = `Shows ${parts.join(" and ")}.`;
  }

  return { opportunityId, strengthensEcosystem, reasoning, sharedCustomerSiblings, sharedInfraSiblings, signals };
}

// ─── Tests ──────────────────────────────────────────────────────────

test("an opportunity id that doesn't resolve throws", () => {
  reset();
  assert.throws(() => assessEcosystemStrengthening("nope"), /opportunity nope not found/);
});

test("no existing siblings -> strengthensEcosystem: false, 'first sibling' reasoning", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Anything", agent_address: "agentA" });

  const result = assessEcosystemStrengthening("opp_candidate");
  assert.equal(result.strengthensEcosystem, false);
  assert.match(result.reasoning, /first sibling/);
  assert.deepEqual(result.signals, []);
});

test("siblings exist but clear neither signal -> strengthensEcosystem: false", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentB", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_sibling" });
  seedOpportunity({ id: "opp_sibling", title: "Unrelated Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", []);
  setTechnologyReuse("opp_candidate", []);

  const result = assessEcosystemStrengthening("opp_candidate");
  assert.equal(result.strengthensEcosystem, false);
  assert.match(result.reasoning, /No shared-customer or shared-infra evidence/);
});

test("a 'complements' mission-overlap entry reads as sharedCustomers, 'competes' does not", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentComplement", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_complement" });
  seedAgent({ address: "agentCompete", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_compete" });
  seedOpportunity({ id: "opp_complement", title: "Complement Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_compete", title: "Competing Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentComplement", relationship: "complements" },
    { siblingAddress: "agentCompete", relationship: "competes" },
  ]);
  setTechnologyReuse("opp_candidate", []);

  const result = assessEcosystemStrengthening("opp_candidate");
  assert.equal(result.strengthensEcosystem, true);
  assert.deepEqual(result.sharedCustomerSiblings, ["Complement Co"]);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].siblingAddress, "agentComplement");
});

test("a 'duplicates' mission-overlap entry does not read as sharedCustomers", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentDup", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_dup" });
  seedOpportunity({ id: "opp_dup", title: "Duplicate Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [{ siblingAddress: "agentDup", relationship: "duplicates" }]);
  setTechnologyReuse("opp_candidate", []);

  const result = assessEcosystemStrengthening("opp_candidate");
  assert.equal(result.strengthensEcosystem, false);
  assert.deepEqual(result.signals, []);
});

test("a technology-reuse entry reads as sharedInfra", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentReuse", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_reuse" });
  seedOpportunity({ id: "opp_reuse", title: "Reuse Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", []);
  setTechnologyReuse("opp_candidate", [{ siblingAddress: "agentReuse" }]);

  const result = assessEcosystemStrengthening("opp_candidate");
  assert.equal(result.strengthensEcosystem, true);
  assert.deepEqual(result.sharedInfraSiblings, ["Reuse Co"]);
});

test("a sibling with both signals sorts ahead of a sibling with only one", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentBoth", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_both" });
  seedAgent({ address: "agentOne", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_one" });
  seedOpportunity({ id: "opp_both", title: "Both Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_one", title: "One Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentBoth", relationship: "complements" },
    { siblingAddress: "agentOne", relationship: "complements" },
  ]);
  setTechnologyReuse("opp_candidate", [{ siblingAddress: "agentBoth" }]);

  const result = assessEcosystemStrengthening("opp_candidate");
  assert.equal(result.signals[0].siblingAddress, "agentBoth");
  assert.equal(result.signals[0].sharedCustomers, true);
  assert.equal(result.signals[0].sharedInfra, true);
  assert.equal(result.signals[1].siblingAddress, "agentOne");
});

test("a self-spawned (spawn_clone) sibling with no mission is silently skipped", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentB", parent_address: "agentA", spawn_reason: "self" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", []);
  setTechnologyReuse("opp_candidate", []);

  const result = assessEcosystemStrengthening("opp_candidate");
  assert.equal(result.strengthensEcosystem, false);
  assert.match(result.reasoning, /first sibling/);
});
