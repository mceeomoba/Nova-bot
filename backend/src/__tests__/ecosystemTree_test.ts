// Zent.md Phase 18b: "GET /ecosystem/:rootAgentAddress — full tree
// view: root company, every pipeline-spawned sibling, mission, status,
// spawn date."
//
// Same "no live better-sqlite3" reason every other *_test.ts file in
// this directory already gives (see genesisActivation_test.ts's own
// header) — this mirrors ecosystem.ts's buildEcosystemTree()/buildNode()
// field-for-field against in-memory stand-ins for the `agents` table,
// the mission-resolution fallback expansion.ts's resolveCompanyMission()
// does, and genesisErc8004.ts's getLatestGenesisErc8004Registration().
//
// What this covers:
//   - unknown root address -> undefined (route turns this into a 404).
//   - a root with no pipeline-spawned children -> empty children array,
//     not a missing field or an error.
//   - multi-generation tree (Company A -> B -> C) resolves correctly —
//     the exact case Phase 18e's own "done when" names.
//   - an ordinary spawn_clone child (spawn_reason = 'self') sharing the
//     same parent_address is excluded from the tree entirely — "the
//     ecosystem" is pipeline lineage only.
//   - mission resolution: structural field preferred when present,
//     opportunity-derived fallback used when mission is null but
//     opportunity_id is set, null when neither is available.
//   - status.genesisActivation is null for a 'self'-spawned company and
//     carries the real value ('pending'/'active'/'failed') for a
//     pipeline-spawned one.
//   - status.erc8004 is null when no registration was ever attempted,
//     populated when one exists.
//   - a root that is ITSELF a pipeline-spawned company (Phase 18e's "B
//     as root" case) gets its own mission/status resolved, not just its
//     children's.
//   - depth truncation: recursing past the guard marks a node
//     `truncated: true` and stops, rather than throwing or looping
//     forever — verified against a small test-local depth cap so the
//     test doesn't need to construct 25 real generations.

import { test } from "node:test";
import assert from "node:assert/strict";

type SpawnReason = "self" | "expansion_pipeline";
type GenesisActivationStatus = "pending" | "active" | "failed";
type Erc8004Outcome = "registered" | "gas_funding_failed" | "registration_failed" | "skipped_self_custody";

interface AgentRow {
  address: string;
  name: string | null;
  parent_address: string | null;
  created_at: number;
  spawn_reason: SpawnReason;
  opportunity_id: string | null;
  mission: string | null; // JSON StructuredMission, or null
  status: "active" | "dead";
  genesis_activation_status: GenesisActivationStatus | null;
}

interface Opportunity {
  id: string;
  title: string;
  thesis: string;
}

interface Erc8004Reg {
  outcome: Erc8004Outcome;
  agentId: string | null;
  txHash: string | null;
  registeredAt: number;
}

interface Mission {
  opportunityId: string;
  title: string;
  thesis: string;
  relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
  relationshipReasoning: string | null;
  source: "structural" | "opportunity-derived";
}

interface EcosystemNode {
  address: string;
  name: string | null;
  createdAt: number;
  spawnReason: SpawnReason;
  opportunityId: string | null;
  mission: Mission | null;
  status: {
    liveness: "active" | "dead";
    genesisActivation: GenesisActivationStatus | null;
    erc8004: Erc8004Reg | null;
  };
  children: EcosystemNode[];
  truncated?: true;
}

let agents: Record<string, AgentRow>;
let opportunities: Record<string, Opportunity>;
let erc8004Regs: Record<string, Erc8004Reg>;
let maxDepth: number;

function reset(depth = 25) {
  agents = {};
  opportunities = {};
  erc8004Regs = {};
  maxDepth = depth;
}

function seedAgent(row: AgentRow) {
  agents[row.address] = row;
}

// Mirrors expansion.ts's resolveCompanyMission() field-for-field.
function resolveCompanyMission(row: { mission: string | null; opportunity_id: string | null }): Mission | null {
  if (row.mission) {
    try {
      const structured = JSON.parse(row.mission) as Omit<Mission, "source">;
      return { ...structured, source: "structural" };
    } catch {
      // fall through
    }
  }
  if (row.opportunity_id) {
    const opp = opportunities[row.opportunity_id];
    if (opp) {
      return {
        opportunityId: opp.id,
        title: opp.title,
        thesis: opp.thesis,
        relationshipType: null,
        relationshipReasoning: null,
        source: "opportunity-derived",
      };
    }
  }
  return null;
}

function listExistingCompanies(parentAddress: string): AgentRow[] {
  return Object.values(agents)
    .filter((a) => a.parent_address === parentAddress)
    .sort((a, b) => a.created_at - b.created_at);
}

function buildNode(row: AgentRow, depth: number): EcosystemNode {
  const node: EcosystemNode = {
    address: row.address,
    name: row.name,
    createdAt: row.created_at,
    spawnReason: row.spawn_reason,
    opportunityId: row.opportunity_id,
    mission: resolveCompanyMission(row),
    status: {
      liveness: row.status,
      genesisActivation: row.genesis_activation_status,
      erc8004: erc8004Regs[row.address] ?? null,
    },
    children: [],
  };

  if (depth >= maxDepth) {
    node.truncated = true;
    return node;
  }

  node.children = listExistingCompanies(row.address)
    .filter((c) => c.spawn_reason === "expansion_pipeline")
    .map((c) => buildNode(c, depth + 1));

  return node;
}

function buildEcosystemTree(rootAgentAddress: string): EcosystemNode | undefined {
  if (!rootAgentAddress) throw new Error("rootAgentAddress is required");
  const row = agents[rootAgentAddress];
  if (!row) return undefined;
  return buildNode(row, 0);
}

// ─── Tests ───────────────────────────────────────────────────────

test("unknown root address returns undefined", () => {
  reset();
  assert.equal(buildEcosystemTree("0xNoSuchAgent"), undefined);
});

test("root with no children returns an empty children array", () => {
  reset();
  seedAgent({
    address: "0xA",
    name: "Company A",
    parent_address: null,
    created_at: 1000,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });

  const tree = buildEcosystemTree("0xA");
  assert.ok(tree);
  assert.equal(tree!.address, "0xA");
  assert.deepEqual(tree!.children, []);
  assert.equal(tree!.mission, null);
  assert.equal(tree!.status.genesisActivation, null);
  assert.equal(tree!.status.erc8004, null);
});

test("multi-generation tree resolves correctly (A -> B -> C)", () => {
  reset();
  seedAgent({
    address: "0xA",
    name: "Company A",
    parent_address: null,
    created_at: 1000,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "Company B",
    parent_address: "0xA",
    created_at: 2000,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: JSON.stringify({
      opportunityId: "opp-1",
      title: "B's mission",
      thesis: "B's thesis",
      relationshipType: "independent",
      relationshipReasoning: "no overlap with A",
    }),
    status: "active",
    genesis_activation_status: "active",
  });
  seedAgent({
    address: "0xC",
    name: "Company C",
    parent_address: "0xB",
    created_at: 3000,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-2",
    mission: JSON.stringify({
      opportunityId: "opp-2",
      title: "C's mission",
      thesis: "C's thesis",
      relationshipType: "supplier-to-sibling",
      relationshipReasoning: "sells to B",
    }),
    status: "active",
    genesis_activation_status: "pending",
  });

  const tree = buildEcosystemTree("0xA")!;
  assert.equal(tree.address, "0xA");
  assert.equal(tree.children.length, 1);

  const b = tree.children[0];
  assert.equal(b.address, "0xB");
  assert.equal(b.mission?.title, "B's mission");
  assert.equal(b.status.genesisActivation, "active");
  assert.equal(b.children.length, 1);

  const c = b.children[0];
  assert.equal(c.address, "0xC");
  assert.equal(c.mission?.title, "C's mission");
  assert.equal(c.status.genesisActivation, "pending");
  assert.equal(c.children.length, 0);
});

test("ordinary spawn_clone children (spawn_reason 'self') are excluded from the tree", () => {
  reset();
  seedAgent({
    address: "0xA",
    name: "Company A",
    parent_address: null,
    created_at: 1000,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xClone",
    name: "A's worker clone",
    parent_address: "0xA",
    created_at: 1500,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "Company B",
    parent_address: "0xA",
    created_at: 2000,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });

  const tree = buildEcosystemTree("0xA")!;
  assert.equal(tree.children.length, 1);
  assert.equal(tree.children[0].address, "0xB");
});

test("mission falls back to opportunity-derived when the structural column is null", () => {
  reset();
  opportunities["opp-1"] = { id: "opp-1", title: "Pre-17c title", thesis: "Pre-17c thesis" };
  seedAgent({
    address: "0xA",
    name: "Company A",
    parent_address: null,
    created_at: 1000,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "Company B",
    parent_address: "0xA",
    created_at: 2000,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: null, // predates the Phase 17c structural column
    status: "active",
    genesis_activation_status: "active",
  });

  const tree = buildEcosystemTree("0xA")!;
  const b = tree.children[0];
  assert.equal(b.mission?.source, "opportunity-derived");
  assert.equal(b.mission?.title, "Pre-17c title");
});

test("mission is null when neither the structural column nor the opportunity row exist", () => {
  reset();
  seedAgent({
    address: "0xA",
    name: "Company A",
    parent_address: null,
    created_at: 1000,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "Company B",
    parent_address: "0xA",
    created_at: 2000,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-archived", // pruned out from under it, per db.ts's own comment
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });

  const tree = buildEcosystemTree("0xA")!;
  assert.equal(tree.children[0].mission, null);
});

test("erc8004 status is null when never attempted, populated when present", () => {
  reset();
  seedAgent({
    address: "0xA",
    name: "Company A",
    parent_address: null,
    created_at: 1000,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "Company B",
    parent_address: "0xA",
    created_at: 2000,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });
  seedAgent({
    address: "0xC",
    name: "Company C",
    parent_address: "0xA",
    created_at: 2500,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-2",
    mission: null,
    status: "active",
    genesis_activation_status: "pending",
  });
  erc8004Regs["0xB"] = { outcome: "registered", agentId: "42", txHash: "0xdeadbeef", registeredAt: 5000 };

  const tree = buildEcosystemTree("0xA")!;
  const b = tree.children.find((n) => n.address === "0xB")!;
  const c = tree.children.find((n) => n.address === "0xC")!;
  assert.deepEqual(b.status.erc8004, { outcome: "registered", agentId: "42", txHash: "0xdeadbeef", registeredAt: 5000 });
  assert.equal(c.status.erc8004, null);
});

test("a pipeline-spawned company as ROOT resolves its own mission/status, not just its children's", () => {
  reset();
  seedAgent({
    address: "0xB",
    name: "Company B",
    parent_address: "0xA",
    created_at: 2000,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: JSON.stringify({
      opportunityId: "opp-1",
      title: "B's mission",
      thesis: "B's thesis",
      relationshipType: "independent",
      relationshipReasoning: "no overlap with A",
    }),
    status: "active",
    genesis_activation_status: "active",
  });
  erc8004Regs["0xB"] = { outcome: "registered", agentId: "7", txHash: "0xabc", registeredAt: 4000 };

  const tree = buildEcosystemTree("0xB")!;
  assert.equal(tree.address, "0xB");
  assert.equal(tree.spawnReason, "expansion_pipeline");
  assert.equal(tree.mission?.title, "B's mission");
  assert.equal(tree.status.genesisActivation, "active");
  assert.deepEqual(tree.status.erc8004, { outcome: "registered", agentId: "7", txHash: "0xabc", registeredAt: 4000 });
});

test("depth guard truncates instead of recursing forever", () => {
  reset(2); // test-local cap, not the real 25 — see this file's header
  seedAgent({
    address: "0xA",
    name: "A",
    parent_address: null,
    created_at: 0,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "B",
    parent_address: "0xA",
    created_at: 1,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });
  seedAgent({
    address: "0xC",
    name: "C",
    parent_address: "0xB",
    created_at: 2,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-2",
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });
  seedAgent({
    address: "0xD",
    name: "D",
    parent_address: "0xC",
    created_at: 3,
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-3",
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });

  const tree = buildEcosystemTree("0xA")!; // depth 0
  assert.equal(tree.truncated, undefined);
  const b = tree.children[0]; // depth 1
  assert.equal(b.truncated, undefined);
  const c = b.children[0]; // depth 2 -- hits maxDepth, truncated before recursing to D
  assert.equal(c.truncated, true);
  assert.equal(c.children.length, 0, "truncated node reports no children rather than guessing");
});
