// Zent.md Phase 11d: "Tool: `check_technology_reuse(opportunity_id)` —
// how much of an existing sibling's tools/skills/codebase Agent B
// could start from, versus building from zero."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's checkTechnologyReuse() (plus the
// listExistingCompanies() it builds on) against plain in-memory maps
// standing in for `agents`, `opportunities`, and each sibling's own
// skills. The TF-IDF similarity itself is a simplified stand-in (see
// FAKE_SIMILARITY below), same reasoning expansionMissionOverlap.test.ts
// and expansionDedup.test.ts already apply to the same underlying
// scoreCorpus()/checkBuildability(). Recommend re-running against the
// real expansion.ts/db.ts/tfidf.ts/skills.ts once a networked
// environment is available.
//
// What this covers:
//   11d — a sibling whose skill clears the match threshold is included,
//         with that skill in `matches` and `reuseScore` set to its
//         score.
//   11d — a sibling with an empty skill catalog is omitted entirely.
//   11d — a sibling whose skills all score below the threshold is
//         omitted entirely, not returned with an empty matches array.
//   11d — a sibling with multiple matching skills gets them all,
//         highest-similarity first, and reuseScore is the top one.
//   11d — a self-spawned (spawn_clone) sibling with no mission is
//         silently skipped, not compared against.
//   11d — a sibling that (defensively) resolves back to the candidate's
//         own opportunity id is excluded.
//   11d — results are sorted by reuseScore descending.
//   11d — an opportunity id that doesn't resolve throws.

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
  thesis: string;
  tags: string[];
  agent_address: string;
}

interface FakeSkill {
  name: string;
  description: string;
}

let agents: Map<string, FakeAgent>;
let opportunities: Map<string, FakeOpportunity>;
let skillsByAgent: Map<string, FakeSkill[]>;

function reset() {
  agents = new Map();
  opportunities = new Map();
  skillsByAgent = new Map();
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

function seedSkills(agentAddress: string, skills: FakeSkill[]) {
  skillsByAgent.set(agentAddress, skills);
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

function listSkills(agentAddress: string): FakeSkill[] {
  return skillsByAgent.get(agentAddress) ?? [];
}

// ─── Inlined mirror of listExistingCompanies() (Phase 11b) ─────────────

interface ExistingCompanyMission {
  opportunityId: string;
  title: string;
  thesis: string;
}

interface ExistingCompany {
  address: string;
  spawnReason: "self" | "expansion_pipeline";
  opportunityId: string | null;
  mission: ExistingCompanyMission | null;
}

function listExistingCompanies(rootAgentAddress: string): ExistingCompany[] {
  if (!rootAgentAddress) {
    throw new Error("rootAgentAddress is required");
  }
  const rows = [...agents.values()].filter((a) => a.parent_address === rootAgentAddress);
  return rows.map((row) => {
    let mission: ExistingCompanyMission | null = null;
    if (row.opportunity_id) {
      const opportunity = getOpportunity(row.opportunity_id);
      if (opportunity) {
        mission = { opportunityId: opportunity.id, title: opportunity.title, thesis: opportunity.thesis };
      }
    }
    return { address: row.address, spawnReason: row.spawn_reason, opportunityId: row.opportunity_id, mission };
  });
}

// ─── Simplified stand-ins for tfidf.ts's scoreCorpus() ─────────────────

const FAKE_SIMILARITY = new Map<string, number>();
function setSimilarity(queryText: string, skillText: string, score: number) {
  FAKE_SIMILARITY.set(`${queryText}|${skillText}`, score);
}
function similarity(queryText: string, skillText: string): number {
  return FAKE_SIMILARITY.get(`${queryText}|${skillText}`) ?? 0;
}
function skillText(skill: FakeSkill): string {
  return `${skill.name} ${skill.description}`;
}
function buildQueryText(o: FakeOpportunity): string {
  return [o.title, o.thesis, ...(o.tags ?? [])].join("\n");
}

const THRESHOLD = 0.12;

// ─── Inlined mirror of checkBuildability() (Phase 6c), scoped to one
//     sibling's own skill catalog rather than the global one ─────────

function checkBuildability(
  queryText: string,
  catalog: FakeSkill[],
  threshold: number,
): { name: string; score: number }[] {
  return catalog
    .map((skill) => ({ name: skill.name, score: similarity(queryText, skillText(skill)) }))
    .filter((m) => m.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

// ─── Inlined mirror of checkTechnologyReuse() (Phase 11d) ──────────────

interface TechnologyReuseMatch {
  name: string;
  score: number;
}

interface TechnologyReuseEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  matches: TechnologyReuseMatch[];
  reuseScore: number;
}

function checkTechnologyReuse(opportunityId: string): TechnologyReuseEntry[] {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const rootAgentAddress = candidate.agent_address;
  const siblings = listExistingCompanies(rootAgentAddress).filter(
    (s): s is ExistingCompany & { mission: ExistingCompanyMission } =>
      s.mission !== null && s.mission.opportunityId !== opportunityId,
  );
  if (siblings.length === 0) return [];

  const queryText = buildQueryText(candidate);

  const entries: TechnologyReuseEntry[] = [];
  for (const sibling of siblings) {
    const catalog = listSkills(sibling.address);
    if (catalog.length === 0) continue;

    const matches = checkBuildability(queryText, catalog, THRESHOLD);
    if (matches.length === 0) continue;

    entries.push({
      siblingAddress: sibling.address,
      siblingOpportunityId: sibling.mission.opportunityId,
      siblingTitle: sibling.mission.title,
      matches,
      reuseScore: matches[0].score,
    });
  }

  entries.sort((a, b) => {
    if (b.reuseScore !== a.reuseScore) return b.reuseScore - a.reuseScore;
    return b.matches.length - a.matches.length;
  });
  return entries;
}

// ─── Tests ──────────────────────────────────────────────────────────

test("an opportunity id that doesn't resolve throws", () => {
  reset();
  assert.throws(() => checkTechnologyReuse("nope"), /opportunity nope not found/);
});

test("a sibling whose skill clears the threshold is included with that skill and a matching reuseScore", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({
    id: "opp_sibling",
    title: "Invoice reconciliation tool",
    thesis: "Automates matching invoices to bank transactions",
    tags: [],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "Payroll reconciliation tool",
    thesis: "Automates matching payroll runs to bank transactions",
    tags: [],
    agent_address: "agentA",
  });
  seedSkills("agentB", [{ name: "bank-transaction-matcher", description: "Reconciles ledger rows to bank feeds" }]);
  setSimilarity(
    buildQueryText(opportunities.get("opp_candidate")!),
    skillText({ name: "bank-transaction-matcher", description: "Reconciles ledger rows to bank feeds" }),
    0.4,
  );

  const [entry] = checkTechnologyReuse("opp_candidate");
  assert.equal(entry.siblingAddress, "agentB");
  assert.equal(entry.matches.length, 1);
  assert.equal(entry.matches[0].name, "bank-transaction-matcher");
  assert.equal(entry.reuseScore, 0.4);
});

test("a sibling with an empty skill catalog is omitted entirely", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({ id: "opp_sibling", title: "T1", thesis: "Thesis 1", tags: [], agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "TC", thesis: "Candidate thesis", tags: [], agent_address: "agentA" });
  // deliberately no seedSkills("agentB", ...)

  assert.deepEqual(checkTechnologyReuse("opp_candidate"), []);
});

test("a sibling whose skills all score below the threshold is omitted, not returned with empty matches", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({ id: "opp_sibling", title: "T1", thesis: "Thesis 1", tags: [], agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "TC", thesis: "Candidate thesis", tags: [], agent_address: "agentA" });
  seedSkills("agentB", [{ name: "unrelated-skill", description: "Does something completely unrelated" }]);
  setSimilarity(
    buildQueryText(opportunities.get("opp_candidate")!),
    skillText({ name: "unrelated-skill", description: "Does something completely unrelated" }),
    0.02, // below THRESHOLD
  );

  assert.deepEqual(checkTechnologyReuse("opp_candidate"), []);
});

test("a sibling with multiple matching skills gets them all, highest-similarity first", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({ id: "opp_sibling", title: "T1", thesis: "Thesis 1", tags: [], agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "TC", thesis: "Candidate thesis", tags: [], agent_address: "agentA" });
  const skillLow = { name: "skill-low", description: "Low match" };
  const skillHigh = { name: "skill-high", description: "High match" };
  seedSkills("agentB", [skillLow, skillHigh]);
  const q = buildQueryText(opportunities.get("opp_candidate")!);
  setSimilarity(q, skillText(skillLow), 0.15);
  setSimilarity(q, skillText(skillHigh), 0.6);

  const [entry] = checkTechnologyReuse("opp_candidate");
  assert.deepEqual(
    entry.matches.map((m) => m.name),
    ["skill-high", "skill-low"],
  );
  assert.equal(entry.reuseScore, 0.6);
});

test("a self-spawned (spawn_clone) sibling with no mission is silently skipped", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentB", parent_address: "agentA", spawn_reason: "self" });
  seedOpportunity({ id: "opp_candidate", title: "TC", thesis: "Candidate thesis", tags: [], agent_address: "agentA" });
  seedSkills("agentB", [{ name: "some-skill", description: "Some skill" }]);
  setSimilarity(
    buildQueryText(opportunities.get("opp_candidate")!),
    skillText({ name: "some-skill", description: "Some skill" }),
    0.9,
  );

  assert.deepEqual(checkTechnologyReuse("opp_candidate"), []);
});

test("a sibling resolving back to the candidate's own opportunity id is excluded", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_candidate",
  });
  seedOpportunity({ id: "opp_candidate", title: "TC", thesis: "Candidate thesis", tags: [], agent_address: "agentA" });
  seedSkills("agentB", [{ name: "some-skill", description: "Some skill" }]);

  assert.deepEqual(checkTechnologyReuse("opp_candidate"), []);
});

test("results sort by reuseScore descending across siblings", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentLow",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_low",
  });
  seedAgent({
    address: "agentHigh",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_high",
  });
  seedOpportunity({ id: "opp_low", title: "L", thesis: "Low thesis", tags: [], agent_address: "agentA" });
  seedOpportunity({ id: "opp_high", title: "H", thesis: "High thesis", tags: [], agent_address: "agentA" });
  seedOpportunity({ id: "opp_candidate", title: "TC", thesis: "Candidate thesis", tags: [], agent_address: "agentA" });
  const skillA = { name: "skill-a", description: "Skill A" };
  const skillB = { name: "skill-b", description: "Skill B" };
  seedSkills("agentLow", [skillA]);
  seedSkills("agentHigh", [skillB]);
  const q = buildQueryText(opportunities.get("opp_candidate")!);
  setSimilarity(q, skillText(skillA), 0.2);
  setSimilarity(q, skillText(skillB), 0.7);

  const results = checkTechnologyReuse("opp_candidate");
  assert.deepEqual(
    results.map((r) => r.siblingAddress),
    ["agentHigh", "agentLow"],
  );
});
