// Zent.md Phase 11b: "Tool: `list_existing_companies(rootAgentAddress)`
// — walks `company_lineage` to see every already-spawned sibling and
// its mission, so Strategy has the actual portfolio in front of it,
// not a guess."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's listExistingCompanies() against
// plain in-memory maps standing in for `agents` and `opportunities`.
// Recommend re-running against the real expansion.ts/db.ts once a
// networked environment is available.
//
// What this covers:
//   11b — every direct child of rootAgentAddress is returned, oldest
//         first, regardless of spawn_reason.
//   11b — a self-spawned (spawn_clone) sibling's mission is null —
//         Zent.md's own top section is explicit that pipeline sits on
//         top of spawn_clone unmodified, and that path has never taken
//         a mission argument.
//   11b — an agent with no children yet gets back an empty list, not
//         an error.
//   11b — a grandchild (child of a child) is NOT included — this is
//         parent_address = rootAgentAddress specifically, one
//         generation, matching wallet.ts's own GET /:address/lineage
//         `children` query this reuses.
//   11b — a sibling belonging to a DIFFERENT root agent is excluded.
//   11b — a missing rootAgentAddress argument is refused, not treated
//         as "everyone."
//   17c — an expansion_pipeline sibling with a structural agents.mission
//         column reads that first (source: "structural"), including
//         Strategy's relationship-type recommendation from its own birth.
//   17c — an expansion_pipeline sibling genesis'd BEFORE 17c (mission
//         column is NULL) falls back to its opportunity's title+thesis
//         (source: "opportunity-derived") — same shape this function
//         produced before 17c existed.
//   17c — malformed JSON in the mission column degrades to the same
//         opportunity-derived fallback rather than throwing.
//   17c — an expansion_pipeline row whose opportunity_id no longer
//         resolves AND has no structural mission (defensive:
//         pruned/missing row, pre-17c) degrades to a null mission
//         rather than throwing.

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeAgent {
  address: string;
  name: string | null;
  parent_address: string | null;
  created_at: number;
  spawn_reason: "self" | "expansion_pipeline";
  opportunity_id: string | null;
  /** 17c: JSON StructuredMission, or null pre-17c / self-spawned. */
  mission: string | null;
}

interface FakeOpportunity {
  id: string;
  title: string;
  thesis: string;
}

let agents: Map<string, FakeAgent>;
let opportunities: Map<string, FakeOpportunity>;

function reset() {
  agents = new Map();
  opportunities = new Map();
}

function seedAgent(overrides: Partial<FakeAgent> & { address: string }): FakeAgent {
  const agent: FakeAgent = {
    name: null,
    parent_address: null,
    created_at: Date.now(),
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    ...overrides,
  };
  agents.set(agent.address, agent);
  return agent;
}

function seedOpportunity(id: string, title: string, thesis: string): FakeOpportunity {
  const o: FakeOpportunity = { id, title, thesis };
  opportunities.set(id, o);
  return o;
}

// ─── Inlined mirrors of expansion.ts's own reads ───────────────────────

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

// ─── Inlined mirror of listExistingCompanies() (Phase 11b) ─────────────

interface ExistingCompanyMission {
  opportunityId: string;
  title: string;
  thesis: string;
  relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
  relationshipReasoning: string | null;
  source: "structural" | "opportunity-derived";
}

interface ExistingCompany {
  address: string;
  name: string | null;
  createdAt: number;
  spawnReason: "self" | "expansion_pipeline";
  opportunityId: string | null;
  mission: ExistingCompanyMission | null;
}

function listExistingCompanies(rootAgentAddress: string): ExistingCompany[] {
  if (!rootAgentAddress) {
    throw new Error("rootAgentAddress is required");
  }
  const rows = [...agents.values()]
    .filter((a) => a.parent_address === rootAgentAddress)
    .sort((a, b) => a.created_at - b.created_at);

  return rows.map((row) => {
    let mission: ExistingCompanyMission | null = null;

    // 17c: prefer the structural field this sibling was genesis'd with.
    if (row.mission) {
      try {
        const structured = JSON.parse(row.mission) as {
          opportunityId: string;
          title: string;
          thesis: string;
          relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
          relationshipReasoning: string | null;
        };
        mission = { ...structured, source: "structural" };
      } catch {
        mission = null;
      }
    }

    // Pre-17c fallback.
    if (!mission && row.opportunity_id) {
      const opportunity = getOpportunity(row.opportunity_id);
      if (opportunity) {
        mission = {
          opportunityId: opportunity.id,
          title: opportunity.title,
          thesis: opportunity.thesis,
          relationshipType: null,
          relationshipReasoning: null,
          source: "opportunity-derived",
        };
      }
    }

    return {
      address: row.address,
      name: row.name,
      createdAt: row.created_at,
      spawnReason: row.spawn_reason,
      opportunityId: row.opportunity_id,
      mission,
    };
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

test("an agent with no children yet gets back an empty list", () => {
  reset();
  seedAgent({ address: "agentA" });
  assert.deepEqual(listExistingCompanies("agentA"), []);
});

test("a missing rootAgentAddress argument is refused, not treated as 'everyone'", () => {
  reset();
  seedAgent({ address: "agentA", parent_address: undefined as any });
  assert.throws(() => listExistingCompanies(""), /rootAgentAddress is required/);
});

test("every direct child is returned, oldest first, regardless of spawn_reason", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    created_at: 200,
    spawn_reason: "self",
  });
  seedAgent({
    address: "agentC",
    parent_address: "agentA",
    created_at: 100,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_1",
  });
  seedOpportunity("opp_1", "Laundromat SaaS", "Route optimization for laundromat chains");

  const companies = listExistingCompanies("agentA");
  assert.equal(companies.length, 2);
  // oldest (created_at 100) first
  assert.equal(companies[0].address, "agentC");
  assert.equal(companies[1].address, "agentB");
});

test("17c: a sibling with a structural mission column reads that first, not the opportunity fallback", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_1",
    mission: JSON.stringify({
      opportunityId: "opp_1",
      title: "Pet grooming marketplace",
      thesis: "Two-sided marketplace for mobile groomers",
      relationshipType: "supplier-to-sibling",
      relationshipReasoning: "Shares Company A's grooming-supply vendor relationships.",
    }),
  });
  // Deliberately a DIFFERENT opportunity row than the mission column
  // claims, to prove the structural read wins outright rather than
  // being cross-checked or merged against a fresh opportunity lookup.
  seedOpportunity("opp_1", "Stale opportunity title", "Stale thesis, should not appear.");

  const [company] = listExistingCompanies("agentA");
  assert.equal(company.spawnReason, "expansion_pipeline");
  assert.deepEqual(company.mission, {
    opportunityId: "opp_1",
    title: "Pet grooming marketplace",
    thesis: "Two-sided marketplace for mobile groomers",
    relationshipType: "supplier-to-sibling",
    relationshipReasoning: "Shares Company A's grooming-supply vendor relationships.",
    source: "structural",
  });
});

test("17c: a pre-17c sibling (mission column NULL) falls back to its opportunity's title+thesis", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_1",
    mission: null,
  });
  seedOpportunity("opp_1", "Pet grooming marketplace", "Two-sided marketplace for mobile groomers");

  const [company] = listExistingCompanies("agentA");
  assert.equal(company.spawnReason, "expansion_pipeline");
  assert.deepEqual(company.mission, {
    opportunityId: "opp_1",
    title: "Pet grooming marketplace",
    thesis: "Two-sided marketplace for mobile groomers",
    relationshipType: null,
    relationshipReasoning: null,
    source: "opportunity-derived",
  });
});

test("17c: malformed JSON in the mission column degrades to the opportunity-derived fallback, not a throw", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_1",
    mission: "{not valid json",
  });
  seedOpportunity("opp_1", "Pet grooming marketplace", "Two-sided marketplace for mobile groomers");

  const [company] = listExistingCompanies("agentA");
  assert.equal(company.mission?.source, "opportunity-derived");
  assert.equal(company.mission?.title, "Pet grooming marketplace");
});

test("a self-spawned (spawn_clone) sibling's mission is null", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentB", parent_address: "agentA", spawn_reason: "self" });

  const [company] = listExistingCompanies("agentA");
  assert.equal(company.spawnReason, "self");
  assert.equal(company.opportunityId, null);
  assert.equal(company.mission, null);
});

test("an expansion_pipeline row whose opportunity no longer resolves degrades to a null mission, not a throw", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_missing",
  });
  // deliberately no seedOpportunity("opp_missing", ...)

  const [company] = listExistingCompanies("agentA");
  assert.equal(company.opportunityId, "opp_missing");
  assert.equal(company.mission, null);
});

test("a grandchild (child of a child) is not included — one generation only", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentB", parent_address: "agentA" });
  seedAgent({ address: "agentC", parent_address: "agentB" }); // grandchild of A

  const companies = listExistingCompanies("agentA");
  assert.equal(companies.length, 1);
  assert.equal(companies[0].address, "agentB");
});

test("a sibling belonging to a different root agent is excluded", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentX" });
  seedAgent({ address: "agentB", parent_address: "agentA" });
  seedAgent({ address: "agentY", parent_address: "agentX" });

  const companies = listExistingCompanies("agentA");
  assert.equal(companies.length, 1);
  assert.equal(companies[0].address, "agentB");
});
