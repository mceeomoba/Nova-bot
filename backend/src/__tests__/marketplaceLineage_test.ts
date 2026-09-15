// Zent.md Phase 18c: "Lineage-aware marketplace listing: Agent B can
// list itself in marketplace.ts with its parent's lineage visible to
// other agents evaluating trust."
//
// Same "no live better-sqlite3" reason every other *_test.ts file in
// this directory already gives — this mirrors marketplace.ts's
// buildListingLineage() field-for-field against in-memory stand-ins for
// the `agents` table and the reputation/mission/status building blocks
// it reuses (reputationFor(), resolveCompanyMission(),
// resolveCompanyStatus()).
//
// What this covers:
//   - an ordinary 'self'-spawned seller (or one with no parent at all)
//     gets `lineage: null` — zero visible change for the vast majority
//     of listings, exactly as buildListingLineage()'s own header says.
//   - a pipeline-spawned seller gets a populated lineage: its own
//     mission/status, its parent's address/name, the parent's
//     reputation (computed the same way any seller's is), and how many
//     other pipeline-spawned companies that parent has founded.
//   - the parent's reputation is the PARENT's own invocation history,
//     not the seller's — a buyer is meant to be evaluating who backed
//     this company, not re-reading the seller's own numbers twice.
//   - companiesSpawned counts only expansion_pipeline siblings, not
//     ordinary spawn_clone workers sharing the same parent_address —
//     same filter 18b's ecosystem tree applies.
//   - a parent row that can't be found (should be unreachable — agents
//     rows are never deleted in this codebase) degrades to `name: null`
//     rather than throwing.

import { test } from "node:test";
import assert from "node:assert/strict";

type SpawnReason = "self" | "expansion_pipeline";
type GenesisActivationStatus = "pending" | "active" | "failed";

interface AgentRow {
  address: string;
  name: string | null;
  parent_address: string | null;
  spawn_reason: SpawnReason;
  opportunity_id: string | null;
  mission: string | null;
  status: "active" | "dead";
  genesis_activation_status: GenesisActivationStatus | null;
}

interface Invocation {
  seller_address: string;
  outcome: "delivered" | "seller_error" | "seller_unreachable";
  flagged: boolean;
}

let agents: Record<string, AgentRow>;
let invocations: Invocation[];

function reset() {
  agents = {};
  invocations = [];
}

function seedAgent(row: AgentRow) {
  agents[row.address] = row;
}

// Mirrors marketplace.ts's reputationFor() field-for-field.
function reputationFor(sellerAddress: string): { totalInvocations: number; flaggedInvocations: number; flagRate: number | null } {
  const rows = invocations.filter((i) => i.seller_address === sellerAddress && i.outcome === "delivered");
  const total = rows.length;
  const flagged = rows.filter((r) => r.flagged).length;
  return { totalInvocations: total, flaggedInvocations: flagged, flagRate: total > 0 ? flagged / total : null };
}

// Mirrors expansion.ts's resolveCompanyMission() (same as ecosystemTree_test.ts's own mirror).
interface Mission {
  opportunityId: string;
  title: string;
  thesis: string;
  relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
  relationshipReasoning: string | null;
  source: "structural" | "opportunity-derived";
}

function resolveCompanyMission(row: { mission: string | null; opportunity_id: string | null }): Mission | null {
  if (row.mission) {
    try {
      return { ...(JSON.parse(row.mission) as Omit<Mission, "source">), source: "structural" };
    } catch {
      // fall through
    }
  }
  return null; // no opportunity table needed for this file's own test cases
}

// Mirrors ecosystem.ts's resolveCompanyStatus() minus the erc8004 lookup
// (18c's own tests don't need to re-cover that seam — genesisErc8004_test.ts
// and ecosystemTree_test.ts already do).
function resolveCompanyStatus(row: { status: "active" | "dead"; genesis_activation_status: GenesisActivationStatus | null }) {
  return { liveness: row.status, genesisActivation: row.genesis_activation_status, erc8004: null as null };
}

function listExistingCompanies(parentAddress: string): AgentRow[] {
  return Object.values(agents).filter((a) => a.parent_address === parentAddress);
}

// Mirrors marketplace.ts's buildListingLineage() field-for-field.
function buildListingLineage(sellerAddress: string) {
  const row = agents[sellerAddress];
  if (!row || row.spawn_reason !== "expansion_pipeline" || !row.parent_address) {
    return null;
  }
  const parentAddress = row.parent_address;
  const parentRow = agents[parentAddress];
  const companiesSpawned = listExistingCompanies(parentAddress).filter(
    (c) => c.spawn_reason === "expansion_pipeline",
  ).length;

  return {
    parentAddress,
    opportunityId: row.opportunity_id,
    mission: resolveCompanyMission(row),
    status: resolveCompanyStatus(row),
    parent: {
      address: parentAddress,
      name: parentRow?.name ?? null,
      reputation: reputationFor(parentAddress),
      companiesSpawned,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────

test("ordinary self-spawned seller gets lineage: null", () => {
  reset();
  seedAgent({
    address: "0xSelf",
    name: "Solo agent",
    parent_address: null,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  assert.equal(buildListingLineage("0xSelf"), null);
});

test("a spawn_clone worker (spawn_reason self, but has a parent) also gets null", () => {
  reset();
  seedAgent({
    address: "0xParent",
    name: "Parent Co",
    parent_address: null,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xClone",
    name: "Parent's worker clone",
    parent_address: "0xParent",
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  assert.equal(buildListingLineage("0xClone"), null);
});

test("pipeline-spawned seller gets a populated lineage with the parent's own reputation", () => {
  reset();
  seedAgent({
    address: "0xParent",
    name: "Parent Co",
    parent_address: null,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "Agent B",
    parent_address: "0xParent",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: JSON.stringify({
      opportunityId: "opp-1",
      title: "B's mission",
      thesis: "B's thesis",
      relationshipType: "independent",
      relationshipReasoning: "no overlap",
    }),
    status: "active",
    genesis_activation_status: "active",
  });
  // Parent's own track record as a marketplace seller.
  invocations.push({ seller_address: "0xParent", outcome: "delivered", flagged: false });
  invocations.push({ seller_address: "0xParent", outcome: "delivered", flagged: true });
  // Seller's (B's) own invocations should NOT leak into the parent's number.
  invocations.push({ seller_address: "0xB", outcome: "delivered", flagged: true });
  invocations.push({ seller_address: "0xB", outcome: "delivered", flagged: true });

  const lineage = buildListingLineage("0xB")!;
  assert.ok(lineage);
  assert.equal(lineage.parentAddress, "0xParent");
  assert.equal(lineage.mission?.title, "B's mission");
  assert.equal(lineage.status.genesisActivation, "active");
  assert.equal(lineage.parent.address, "0xParent");
  assert.equal(lineage.parent.name, "Parent Co");
  assert.deepEqual(lineage.parent.reputation, { totalInvocations: 2, flaggedInvocations: 1, flagRate: 0.5 });
});

test("companiesSpawned counts only expansion_pipeline siblings, not ordinary clones", () => {
  reset();
  seedAgent({
    address: "0xParent",
    name: "Parent Co",
    parent_address: null,
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xClone",
    name: "worker",
    parent_address: "0xParent",
    spawn_reason: "self",
    opportunity_id: null,
    mission: null,
    status: "active",
    genesis_activation_status: null,
  });
  seedAgent({
    address: "0xB",
    name: "Agent B",
    parent_address: "0xParent",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });
  seedAgent({
    address: "0xC",
    name: "Agent C",
    parent_address: "0xParent",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-2",
    mission: null,
    status: "active",
    genesis_activation_status: "pending",
  });

  const lineageB = buildListingLineage("0xB")!;
  const lineageC = buildListingLineage("0xC")!;
  assert.equal(lineageB.parent.companiesSpawned, 2);
  assert.equal(lineageC.parent.companiesSpawned, 2);
});

test("a missing parent row degrades to name: null instead of throwing", () => {
  reset();
  seedAgent({
    address: "0xB",
    name: "Agent B",
    parent_address: "0xGoneMissing",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp-1",
    mission: null,
    status: "active",
    genesis_activation_status: "active",
  });

  const lineage = buildListingLineage("0xB")!;
  assert.equal(lineage.parent.address, "0xGoneMissing");
  assert.equal(lineage.parent.name, null);
  assert.deepEqual(lineage.parent.reputation, { totalInvocations: 0, flaggedInvocations: 0, flagRate: null });
  // B itself is still one expansion_pipeline company spawned by that
  // parent_address, whether or not the parent's own row can be found —
  // the count comes from scanning `agents.parent_address`, not from the
  // parent row itself.
  assert.equal(lineage.parent.companiesSpawned, 1);
});
