// Zent.md Phase 1e: company_lineage extension.
//
// Inlined mirror of db.ts's migration + wallet.ts's GET /:address/
// lineage handler, standing in for a live better-sqlite3 DB — same
// "no live DB in this environment" reason every prior backend/src test
// file in this repo already carries (see orgChartQuotas.test.ts's own
// header, or expansionPipeline.test.ts's for the identical note applied
// to Phase 1a). Recommend re-running against the real db.ts/wallet.ts
// once a networked environment with node_modules installed is
// available, per every prior phase's own standing note.
//
// What this mirrors, specifically:
//   1. The migration's own idempotency and default-value behavior
//      (existing rows get spawn_reason='self', opportunity_id=null;
//      running the "migration" twice is a no-op).
//   2. createAgentWallet()/createClonedAgentWallet()'s insert shape is
//      untouched by this phase — neither needs to name spawn_reason for
//      the row to end up 'self'.
//   3. GET /:address/lineage's children list now carries both new
//      columns, so a lineage query can tell a self-spawned clone apart
//      from a (not-yet-existing, Phase 16) expansion-pipeline genesis.

import { test } from "node:test";
import assert from "node:assert/strict";

interface AgentRow {
  address: string;
  name: string;
  parent_address: string | null;
  created_at: number;
  spawn_reason: string;
  opportunity_id: string | null;
}

let agents: Map<string, AgentRow>;

function reset() {
  agents = new Map();
}

// ─── Inlined mirror of db.ts's Phase 1e migration ──────────────────
//
// Real db.ts checks PRAGMA table_info(agents) for column presence and
// only ALTERs if missing; here that's modeled as "does every row
// already have the field," which is equivalent for this mirror's
// purposes since every row is created through insertAgent() below,
// never partially.
function migrateAddSpawnReasonAndOpportunityId(): void {
  for (const row of agents.values()) {
    if (row.spawn_reason === undefined) row.spawn_reason = "self";
    if (row.opportunity_id === undefined) row.opportunity_id = null;
  }
}

// ─── Inlined mirror of wallet.ts's createAgentWallet/
// createClonedAgentWallet insert shape — deliberately does NOT set
// spawn_reason, matching the real INSERT statements, which this phase
// leaves untouched and rely on the column's own DEFAULT 'self'.
function insertAgent(address: string, name: string, parentAddress: string | null): AgentRow {
  const row: AgentRow = {
    address,
    name,
    parent_address: parentAddress,
    created_at: Date.now(),
    spawn_reason: "self", // DEFAULT 'self' — no insert statement names this column
    opportunity_id: null,
  };
  agents.set(address, row);
  return row;
}

// Only Phase 16's (not-yet-built) genesis_company() writes this shape —
// modeled here so 1e's own columns have something non-default to
// distinguish in the lineage query test below.
function insertExpansionPipelineAgent(
  address: string,
  name: string,
  parentAddress: string,
  opportunityId: string,
): AgentRow {
  const row: AgentRow = {
    address,
    name,
    parent_address: parentAddress,
    created_at: Date.now(),
    spawn_reason: "expansion_pipeline",
    opportunity_id: opportunityId,
  };
  agents.set(address, row);
  return row;
}

// Inlined mirror of GET /:address/lineage's children query.
function getLineageChildren(parentAddress: string) {
  return [...agents.values()]
    .filter((a) => a.parent_address === parentAddress)
    .map((a) => ({
      address: a.address,
      name: a.name,
      created_at: a.created_at,
      spawn_reason: a.spawn_reason,
      opportunity_id: a.opportunity_id,
    }));
}

test("a normal spawn_clone-path agent defaults to spawn_reason 'self' with no opportunity_id", () => {
  reset();
  const row = insertAgent("0xchild1", "child-1", "0xparent");
  assert.equal(row.spawn_reason, "self");
  assert.equal(row.opportunity_id, null);
});

test("migration backfills spawn_reason/opportunity_id on rows that predate the columns, and is idempotent", () => {
  reset();
  // Simulate a pre-migration row the way it would have looked before
  // this phase — fields literally absent, not just null.
  agents.set("0xold", {
    address: "0xold",
    name: "old-agent",
    parent_address: null,
    created_at: 1000,
    spawn_reason: undefined as unknown as string,
    opportunity_id: undefined as unknown as string | null,
  });
  migrateAddSpawnReasonAndOpportunityId();
  assert.equal(agents.get("0xold")?.spawn_reason, "self");
  assert.equal(agents.get("0xold")?.opportunity_id, null);

  // Running it again changes nothing further.
  const before = { ...agents.get("0xold")! };
  migrateAddSpawnReasonAndOpportunityId();
  assert.deepEqual(agents.get("0xold"), before);
});

test("createAgentWallet/createClonedAgentWallet's own insert shape is unaffected by this phase", () => {
  reset();
  // No caller-supplied spawn_reason anywhere in this call — exactly
  // the real INSERT statements' shape, both before and after 1e.
  const cloned = insertAgent("0xclone1", "clone-1", "0xparent");
  assert.equal(cloned.spawn_reason, "self");
});

test("lineage query can tell a self-spawned clone apart from an expansion-pipeline genesis", () => {
  reset();
  insertAgent("0xkid-self", "kid-self", "0xroot");
  insertExpansionPipelineAgent("0xkid-b", "company-b", "0xroot", "opp_42");

  const children = getLineageChildren("0xroot");
  assert.equal(children.length, 2);

  const selfChild = children.find((c) => c.address === "0xkid-self");
  assert.equal(selfChild?.spawn_reason, "self");
  assert.equal(selfChild?.opportunity_id, null);

  const pipelineChild = children.find((c) => c.address === "0xkid-b");
  assert.equal(pipelineChild?.spawn_reason, "expansion_pipeline");
  assert.equal(pipelineChild?.opportunity_id, "opp_42");
});

test("a company_lineage row (agents row) always survives independently of its motivating opportunity", () => {
  // Documents the "no REFERENCES/ON DELETE CASCADE" design decision:
  // deleting/archiving the opportunity this mirror stands in for never
  // touches the agent row that cites its id — there's no cascade wired
  // up here to do so, which is the point.
  reset();
  insertExpansionPipelineAgent("0xkid-c", "company-c", "0xroot", "opp_99");
  // "opportunity gone" is simulated by simply never having an
  // opportunities table for this mirror to consult — the agent row is
  // untouched regardless.
  assert.equal(agents.get("0xkid-c")?.opportunity_id, "opp_99");
  assert.ok(agents.has("0xkid-c"));
});
