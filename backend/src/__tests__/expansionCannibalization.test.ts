// Zent.md Phase 12b: "Cannibalization check output: explicit yes/no +
// reasoning field, not buried in prose."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's checkCannibalization() against
// plain in-memory maps standing in for `agents`/`opportunities`, and
// against a controllable fake checkMissionOverlap() result (same
// "control the output of 11c rather than re-deriving TF-IDF fakes a
// third time" approach expansionEcosystemStrengthening.test.ts already
// takes — expansionMissionOverlap.test.ts covers 11c's own logic in
// full).
//
// What this covers:
//   12b — a "duplicates" mission-overlap entry counts as cannibalizing.
//   12b — a "competes" mission-overlap entry counts as cannibalizing.
//   12b — a "complements" mission-overlap entry does NOT count as
//         cannibalizing (that's 12a's signal, not this one).
//   12b — zero existing siblings -> cannibalizes: false, "nothing to
//         cannibalize" reasoning.
//   12b — siblings exist but none duplicate/compete -> cannibalizes:
//         false, "no cannibalization risk identified" reasoning.
//   12b — reasoning names duplicated siblings and competing siblings
//         separately when both are present.
//   12b — worst-first order (duplicates before competes) is preserved
//         from checkMissionOverlap() into `signals`.
//   12b — an opportunity id that doesn't resolve throws.

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

function reset() {
  agents = new Map();
  opportunities = new Map();
  missionOverlapFixture = new Map();
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

// ─── Stand-in for checkMissionOverlap() (11c) — controllable via
// setMissionOverlap() above; see this file's own header for why. ──────

type MissionOverlapRelationship = "duplicates" | "competes" | "complements";

interface MissionOverlapEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  relationship: MissionOverlapRelationship;
  similarity: number;
}

function checkMissionOverlap(opportunityId: string): MissionOverlapEntry[] {
  if (!getOpportunity(opportunityId)) throw new Error(`opportunity ${opportunityId} not found`);
  return missionOverlapFixture.get(opportunityId) ?? [];
}

// ─── Inlined mirror of checkCannibalization() (Phase 12b) ──────────────

interface CannibalizationSignal {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  relationship: "duplicates" | "competes";
  similarity: number;
}

interface CannibalizationCheckResult {
  opportunityId: string;
  cannibalizes: boolean;
  reasoning: string;
  cannibalizedSiblings: string[];
  signals: CannibalizationSignal[];
}

function checkCannibalization(opportunityId: string): CannibalizationCheckResult {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) throw new Error(`opportunity ${opportunityId} not found`);

  const rootAgentAddress = candidate.agent_address;
  const siblingCount = listExistingCompanies(rootAgentAddress).filter(
    (s): s is ExistingCompany & { mission: ExistingCompanyMission } =>
      s.mission !== null && s.mission.opportunityId !== opportunityId,
  ).length;

  const missionOverlap = checkMissionOverlap(opportunityId);
  const signals: CannibalizationSignal[] = missionOverlap
    .filter((e): e is MissionOverlapEntry & { relationship: "duplicates" | "competes" } =>
      e.relationship === "duplicates" || e.relationship === "competes",
    )
    .map((e) => ({
      siblingAddress: e.siblingAddress,
      siblingOpportunityId: e.siblingOpportunityId,
      siblingTitle: e.siblingTitle,
      relationship: e.relationship,
      similarity: e.similarity,
    }));

  const cannibalizedSiblings = signals.map((s) => s.siblingTitle);
  const cannibalizes = signals.length > 0;

  let reasoning: string;
  if (siblingCount === 0) {
    reasoning = "No existing siblings yet — nothing for this opportunity to cannibalize.";
  } else if (!cannibalizes) {
    reasoning = `No overlapping-mission siblings found across ${siblingCount} existing sibling${siblingCount === 1 ? "" : "s"} — no cannibalization risk identified.`;
  } else {
    const clauses: string[] = [];
    const duplicateNames = signals.filter((s) => s.relationship === "duplicates").map((s) => s.siblingTitle);
    const competeNames = signals.filter((s) => s.relationship === "competes").map((s) => s.siblingTitle);
    if (duplicateNames.length > 0) clauses.push(`duplicates the mission of ${duplicateNames.join(", ")}`);
    if (competeNames.length > 0) clauses.push(`competes with ${competeNames.join(", ")}`);
    reasoning = `This opportunity ${clauses.join(" and ")}.`;
  }

  return { opportunityId, cannibalizes, reasoning, cannibalizedSiblings, signals };
}

// ─── Tests ──────────────────────────────────────────────────────────

test("an opportunity id that doesn't resolve throws", () => {
  reset();
  assert.throws(() => checkCannibalization("nope"), /opportunity nope not found/);
});

test("no existing siblings -> cannibalizes: false, 'nothing to cannibalize' reasoning", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });

  const result = checkCannibalization("opp_candidate");
  assert.equal(result.cannibalizes, false);
  assert.match(result.reasoning, /nothing for this opportunity to cannibalize/);
  assert.deepEqual(result.signals, []);
});

test("siblings exist but none overlap -> cannibalizes: false", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentB", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_sibling" });
  seedOpportunity({ id: "opp_sibling", title: "Unrelated Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", []);

  const result = checkCannibalization("opp_candidate");
  assert.equal(result.cannibalizes, false);
  assert.match(result.reasoning, /no cannibalization risk identified/);
});

test("a 'duplicates' entry counts as cannibalizing", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentDup", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_dup" });
  seedOpportunity({ id: "opp_dup", title: "Duplicate Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentDup", siblingOpportunityId: "opp_dup", siblingTitle: "Duplicate Co", relationship: "duplicates", similarity: 0.95 },
  ]);

  const result = checkCannibalization("opp_candidate");
  assert.equal(result.cannibalizes, true);
  assert.deepEqual(result.cannibalizedSiblings, ["Duplicate Co"]);
  assert.match(result.reasoning, /duplicates the mission of Duplicate Co/);
});

test("a 'competes' entry counts as cannibalizing", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentCompete", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_compete" });
  seedOpportunity({ id: "opp_compete", title: "Competing Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentCompete", siblingOpportunityId: "opp_compete", siblingTitle: "Competing Co", relationship: "competes", similarity: 0.6 },
  ]);

  const result = checkCannibalization("opp_candidate");
  assert.equal(result.cannibalizes, true);
  assert.match(result.reasoning, /competes with Competing Co/);
});

test("a 'complements' entry does NOT count as cannibalizing", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentComp", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_comp" });
  seedOpportunity({ id: "opp_comp", title: "Complement Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentComp", siblingOpportunityId: "opp_comp", siblingTitle: "Complement Co", relationship: "complements", similarity: 0.1 },
  ]);

  const result = checkCannibalization("opp_candidate");
  assert.equal(result.cannibalizes, false);
  assert.deepEqual(result.signals, []);
});

test("reasoning names duplicated and competing siblings separately when both are present", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentDup", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_dup" });
  seedAgent({ address: "agentCompete", parent_address: "agentA", spawn_reason: "expansion_pipeline", opportunity_id: "opp_compete" });
  seedOpportunity({ id: "opp_dup", title: "Duplicate Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_compete", title: "Competing Co", agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "Candidate", agent_address: "agentA" });
  setMissionOverlap("opp_candidate", [
    { siblingAddress: "agentDup", siblingOpportunityId: "opp_dup", siblingTitle: "Duplicate Co", relationship: "duplicates", similarity: 0.9 },
    { siblingAddress: "agentCompete", siblingOpportunityId: "opp_compete", siblingTitle: "Competing Co", relationship: "competes", similarity: 0.55 },
  ]);

  const result = checkCannibalization("opp_candidate");
  assert.match(result.reasoning, /duplicates the mission of Duplicate Co and competes with Competing Co/);
  assert.deepEqual(
    result.signals.map((s) => s.relationship),
    ["duplicates", "competes"],
  );
});
