import { db } from "./db.js";
import {
  listExistingCompanies,
  resolveCompanyMission,
  type ExistingCompanyMission,
} from "./expansion.js";
import {
  getLatestGenesisErc8004Registration,
  type GenesisErc8004Result,
} from "./genesisErc8004.js";
import type { GenesisActivationStatus } from "./genesisActivation.js";

/**
 * Zent.md Phase 18b — "GET /ecosystem/:rootAgentAddress — full tree
 * view: root company, every pipeline-spawned sibling, mission, status,
 * spawn date."
 *
 * Builds on three read-only seams earlier phases already left for
 * exactly this: listExistingCompanies() (11b, expansion.ts) for one
 * level of children + mission resolution, getGenesisActivationStatus's
 * sibling column (17e-iv) for "is this company actually alive yet",
 * and getLatestGenesisErc8004Registration() (18a's own docstring names
 * this file by number as its intended reader). Nothing here writes
 * anything — this is a pure read path, same posture wallet.ts's GET
 * /:address/lineage and expansionUiRoutes.ts's read-only UI already
 * take, for the same reason: Zent.md's "Notes on scope" is explicit
 * that no external operator step exists anywhere in this pipeline, so
 * a view surface has nothing to gate and nothing to let a person steer.
 *
 * "Tree", not "list": listExistingCompanies() alone only ever answers
 * "who did THIS address spawn," one level deep. Phase 18e's own "done
 * when" — "multi-generation tree (Company A → B → and B's own eventual
 * child, if B itself becomes profitable and repeats the cycle) resolves
 * correctly" — only makes sense if 18b itself walks the tree, not just
 * the first rung of it, so this recurses: every pipeline-spawned child
 * gets its own children resolved the same way, all the way down.
 *
 * Scoped to `expansion_pipeline` lineage only, deliberately excluding
 * ordinary `spawn_clone` clones (spawn_reason = 'self') that happen to
 * share a parent_address: Zent.md's whole premise is that "the
 * ecosystem" is the family of independently-missioned companies this
 * pipeline creates, not the worker-clones an agent spins up for its own
 * departments/capacity. A clone has no opportunity_id, no mission, and
 * (17e-iv's own column comment) no genesis_activation_status to report
 * either — there is nothing this tree could say about one that
 * wallet.ts's own GET /:address/lineage doesn't already say better.
 *
 * Root note: the root address itself is included and returned with its
 * own mission/status resolved the same way a child would be — Phase
 * 18e's own "B's own eventual child" case means this endpoint gets
 * called with B (a pipeline-spawned company) as the root, not just with
 * an original Company A, and B has a real mission/status of its own to
 * report. resolveCompanyMission() is the same function
 * listExistingCompanies() itself now calls per-row (split out of it for
 * exactly this reuse) — one mission-resolution algorithm, not two
 * copies that could drift.
 */

export interface EcosystemErc8004Status {
  outcome: GenesisErc8004Result["outcome"];
  agentId: string | null;
  txHash: string | null;
  registeredAt: number;
}

export interface EcosystemNodeStatus {
  /** Agent liveness — socialGroups.ts's death-report column. 'active'
   *  unless/until a death report lands; unrelated to genesis. */
  liveness: "active" | "dead";
  /** 17e-iv's pre/post-activation gate. null for the root when the root
   *  is an ordinary top-level agent that never ran this pipeline at all
   *  (spawn_reason = 'self') — there is no genesis smoke test to gate
   *  for a company that wasn't born through it. */
  genesisActivation: GenesisActivationStatus | null;
  /** 18a's on-chain identity attempt, if any was ever made. null means
   *  "never attempted" (self-spawned agent, or a pipeline company whose
   *  genesis predates 18a, or one still pending 17e-iv activation —
   *  registerGenesisIdentity() only ever fires after activation). */
  erc8004: EcosystemErc8004Status | null;
}

export interface EcosystemNode {
  address: string;
  name: string | null;
  createdAt: number;
  spawnReason: "self" | "expansion_pipeline";
  opportunityId: string | null;
  mission: ExistingCompanyMission | null;
  status: EcosystemNodeStatus;
  children: EcosystemNode[];
  /** Set only on the node(s) where recursion was cut short by
   *  MAX_ECOSYSTEM_DEPTH below — see that constant's own comment. Every
   *  other node omits this field entirely rather than carrying
   *  `truncated: false` on every row in a normal, shallow tree. */
  truncated?: true;
}

interface AgentStatusRow {
  address: string;
  name: string | null;
  created_at: number;
  spawn_reason: "self" | "expansion_pipeline";
  opportunity_id: string | null;
  mission: string | null;
  status: "active" | "dead";
  genesis_activation_status: GenesisActivationStatus | null;
}

// Zent.md Phase 19a ("Global expansion rate limit per root agent... max
// N companies spawned per time window") and 19b (portfolio spend cap)
// are the real, principled guards against a runaway-wide ecosystem —
// neither is built yet (Phase 19 is still ahead of 18 in the plan).
// This constant is NOT a stand-in for either: it is only a recursion
// depth guard, protecting this one read endpoint against pathological
// input (or a future bug elsewhere that let a cycle into parent_address)
// turning a single GET into an unbounded walk. 25 generations of
// company-spawns-company is already far deeper than any real portfolio
// is likely to reach; hitting it truncates the walk (see `truncated`
// above) rather than throwing, so a caller gets a real, if incomplete,
// tree back instead of a 500.
const MAX_ECOSYSTEM_DEPTH = 25;

function getAgentStatusRow(address: string): AgentStatusRow | undefined {
  return db
    .prepare(
      `SELECT address, name, created_at, spawn_reason, opportunity_id, mission,
              status, genesis_activation_status
       FROM agents WHERE address = ?`,
    )
    .get(address) as AgentStatusRow | undefined;
}

export function buildErc8004Status(address: string): EcosystemErc8004Status | null {
  const reg = getLatestGenesisErc8004Registration(address);
  if (!reg) return null;
  return {
    outcome: reg.outcome,
    agentId: reg.agentId,
    txHash: reg.txHash,
    registeredAt: reg.registeredAt,
  };
}

/** Split out for Phase 18c's reuse (marketplace.ts's lineage-aware
 *  listing): the exact same {liveness, genesisActivation, erc8004}
 *  status shape a tree node gets here, buildable from just the row this
 *  phase already fetches plus the address — one status algorithm, not
 *  a second copy living in marketplace.ts that could drift from this
 *  one the next time either file changes. */
export function resolveCompanyStatus(
  row: { status: "active" | "dead"; genesis_activation_status: GenesisActivationStatus | null },
  address: string,
): EcosystemNodeStatus {
  return {
    liveness: row.status,
    genesisActivation: row.genesis_activation_status,
    erc8004: buildErc8004Status(address),
  };
}

function buildNode(row: AgentStatusRow, depth: number): EcosystemNode {
  const node: EcosystemNode = {
    address: row.address,
    name: row.name,
    createdAt: row.created_at,
    spawnReason: row.spawn_reason,
    opportunityId: row.opportunity_id,
    mission: resolveCompanyMission(row),
    status: resolveCompanyStatus(row, row.address),
    children: [],
  };

  if (depth >= MAX_ECOSYSTEM_DEPTH) {
    node.truncated = true;
    return node;
  }

  node.children = listExistingCompanies(row.address)
    .filter((c) => c.spawnReason === "expansion_pipeline")
    .map((c) => {
      const childRow = getAgentStatusRow(c.address);
      if (!childRow) {
        // listExistingCompanies() just read this exact row from the
        // same table a moment ago — this should be unreachable outside
        // a concurrent delete racing this read. Degrade to the fields
        // that call already gave us rather than drop the child (or
        // throw) out of what is otherwise a complete tree.
        return {
          address: c.address,
          name: c.name,
          createdAt: c.createdAt,
          spawnReason: c.spawnReason,
          opportunityId: c.opportunityId,
          mission: c.mission,
          status: { liveness: "active", genesisActivation: null, erc8004: null },
          children: [],
        };
      }
      return buildNode(childRow, depth + 1);
    });

  return node;
}

/** Undefined means no agent exists at that address at all — the route
 *  turns that into a 404, distinct from a found agent with an empty
 *  `children` array (a company that hasn't spawned anything yet, the
 *  ordinary and expected case for most of the ecosystem at any given
 *  moment). */
export function buildEcosystemTree(rootAgentAddress: string): EcosystemNode | undefined {
  if (!rootAgentAddress) {
    throw new Error("rootAgentAddress is required");
  }
  const row = getAgentStatusRow(rootAgentAddress);
  if (!row) return undefined;
  return buildNode(row, 0);
}
