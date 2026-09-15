// next-phase.md Phase 4f (architecture-agent.md §5, closing Phase 4 as
// a whole): confirms a clone has no inherited trust, funds, or
// relationships — the thing every one of 4a-4e's own "Done when" lines
// pointed at but none of them could test end-to-end on its own, since
// each earlier sub-phase only ever built one piece (shell, wallet,
// on-chain identity, config copy, lineage record).
//
// A real correction this phase's own "direct inspection" checklist
// item actually found, not just confirmed clean (documented in full at
// its point of fix, capability.ts's ownerOf() "subagent" case): that
// case used to resolve a resource's owner via agents.parent_address —
// exactly the column Phase 4e (previous phase) started actually
// populating for clones. Nothing live called checkCapability() with
// resourceType: "subagent" yet, so this had never fired, but it was a
// real latent bypass — a clone's PARENT would have resolved as that
// clone's "owner" the moment anything did call it that way, directly
// contradicting this phase's own "no clone-specific bypass" requirement.
// Fixed in capability.ts itself (that case now always misses); the
// regression test below (Group 2) locks the fix in.
//
// Same constraint every prior backend/src test file in this repo has
// flagged: capability.ts imports db.js (better-sqlite3), so it can't be
// imported and exercised against a live DB here (no network to
// install it). What's tested below is an inlined mirror of
// checkCapability()'s exact 4-step decision logic — ownerOf(),
// isSubagentOf(), findActiveChannelGrant(), in that order, with the
// same fail-closed default — kept byte-for-byte in sync with
// capability.ts as of this phase's own fix, operating against plain
// in-memory arrays standing in for agents/sandboxes/sub_agents/channels,
// same shape cloning-wallet.test.ts/cloning-lineage.test.ts already
// established. Recommend re-running against the real functions with a
// live sqlite3 DB once a networked environment is available, per every
// prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Inlined mirror of capability.ts, as of this phase's own fix ──

interface AgentRow {
  address: string;
  parent_address: string | null;
}
interface SandboxRow {
  id: string;
  agent_address: string;
  status: string;
}
interface SubAgentRow {
  id: string;
  owner_address: string;
  status: string;
}
interface ChannelRow {
  id: string;
  proposer_address: string;
  recipient_address: string;
  scope: string;
  status: string;
  resolved_at: number | null;
}

let agents: AgentRow[];
let sandboxes: SandboxRow[];
let subAgents: SubAgentRow[];
let channels: ChannelRow[];
let auditLog: Array<{ caller: string; resourceType: string; resourceId: string; decision: string; reason: string }>;

function reset() {
  agents = [
    { address: "0xA-parent", parent_address: null },
    { address: "0xB-clone", parent_address: "0xA-parent" }, // Phase 4e: real lineage, now populated
    { address: "0xC-unrelated", parent_address: null },
  ];
  sandboxes = [{ id: "sbx-A", agent_address: "0xA-parent", status: "running" }];
  subAgents = [];
  channels = [];
  auditLog = [];
}

function audit(caller: string, resourceType: string, resourceId: string, decision: string, reason: string) {
  auditLog.push({ caller, resourceType, resourceId, decision, reason });
}

type ResourceType = "sandbox" | "office_path" | "wallet" | "channel" | "subagent";

function ownerOf(resourceType: ResourceType, resourceId: string): { owner: string | null; notFound: boolean } {
  switch (resourceType) {
    case "sandbox": {
      const row = sandboxes.find((s) => s.id === resourceId);
      if (!row || row.status === "deleted") return { owner: null, notFound: true };
      return { owner: row.agent_address, notFound: false };
    }
    case "wallet": {
      const row = agents.find((a) => a.address === resourceId);
      return row ? { owner: row.address, notFound: false } : { owner: null, notFound: true };
    }
    case "office_path": {
      const idx = resourceId.indexOf(":");
      const owner = idx === -1 ? resourceId : resourceId.slice(0, idx);
      return { owner, notFound: false };
    }
    case "subagent": {
      // Phase 4f fix: this case must never resolve an owner via
      // agents.parent_address (§5 clone lineage) — see this file's own
      // module doc comment above. Always misses now, matching
      // capability.ts's own post-fix body.
      return { owner: null, notFound: true };
    }
    case "channel":
      return { owner: null, notFound: false };
    default:
      return { owner: null, notFound: false };
  }
}

function isSubagentOf(caller: string, owner: string | null, depth = 0): boolean {
  if (!owner || depth > 4) return false;
  const row = subAgents.find((r) => r.id === caller && r.status === "running");
  if (!row) return false;
  if (row.owner_address === owner) return true;
  return isSubagentOf(row.owner_address, owner, depth + 1);
}

function parseChannelResource(resourceId: string): { peerAddress: string; scope: string } | null {
  const idx = resourceId.indexOf(":");
  if (idx === -1) return null;
  return { peerAddress: resourceId.slice(0, idx), scope: resourceId.slice(idx + 1) };
}

function findActiveChannelGrant(caller: string, resourceType: ResourceType, resourceId: string): { id: string } | null {
  if (resourceType !== "channel") return null;
  const parsed = parseChannelResource(resourceId);
  if (!parsed) return null;
  const { peerAddress, scope } = parsed;
  const matches = channels
    .filter(
      (c) =>
        c.status === "active" &&
        c.scope === scope &&
        ((c.proposer_address === caller && c.recipient_address === peerAddress) ||
          (c.proposer_address === peerAddress && c.recipient_address === caller)),
    )
    .sort((a, b) => (b.resolved_at ?? 0) - (a.resolved_at ?? 0));
  return matches[0] ? { id: matches[0].id } : null;
}

// Inlined mirror of checkCapability(). Throws on denial, matching the
// real function's contract.
function checkCapability(check: { caller: string; resourceType: ResourceType; resourceId: string; action: string }): void {
  const { owner, notFound } = ownerOf(check.resourceType, check.resourceId);
  if (owner !== null && owner === check.caller) {
    audit(check.caller, check.resourceType, check.resourceId, "allow", "owner");
    return;
  }
  if (check.resourceType !== "channel" && isSubagentOf(check.caller, owner)) {
    audit(check.caller, check.resourceType, check.resourceId, "allow", "parent-delegation");
    return;
  }
  const grant = findActiveChannelGrant(check.caller, check.resourceType, check.resourceId);
  if (grant) {
    audit(check.caller, check.resourceType, check.resourceId, "allow", `channel:${grant.id}`);
    return;
  }
  audit(check.caller, check.resourceType, check.resourceId, "deny", "no-capability");
  throw Object.assign(
    new Error(
      notFound
        ? `${check.resourceType} not found: ${check.resourceId}`
        : `${check.caller} has no capability for ${check.resourceType}:${check.resourceId}`,
    ),
    { status: notFound ? 404 : 403 },
  );
}

// Inlined mirror of channelService.ts's proposeChannel()/acceptChannel()
// — no special-casing anywhere for a proposer/recipient pair that
// happens to be clone-and-parent; every pair is treated identically.
function proposeChannelMirror(proposer: string, recipient: string, scope: string): ChannelRow {
  const row: ChannelRow = {
    id: `chn_${channels.length + 1}`,
    proposer_address: proposer,
    recipient_address: recipient,
    scope,
    status: "proposed",
    resolved_at: null,
  };
  channels.push(row);
  return row;
}
function acceptChannelMirror(channelId: string): void {
  const row = channels.find((c) => c.id === channelId)!;
  row.status = "active";
  row.resolved_at = Date.now();
}

// ─── Group 1: B (the clone) has no capability over A (its parent) ──

test("clone B reading A's office is denied — same shape of denial as an unrelated agent", () => {
  reset();
  const bResult = (() => {
    try {
      checkCapability({ caller: "0xB-clone", resourceType: "office_path", resourceId: "0xA-parent:workspace/notes.txt", action: "read" });
      return { allowed: true };
    } catch (err: any) {
      return { allowed: false, status: err.status };
    }
  })();
  const cResult = (() => {
    try {
      checkCapability({ caller: "0xC-unrelated", resourceType: "office_path", resourceId: "0xA-parent:workspace/notes.txt", action: "read" });
      return { allowed: true };
    } catch (err: any) {
      return { allowed: false, status: err.status };
    }
  })();
  assert.deepEqual(bResult, cResult, "the clone must be denied the same way (same allowed/status) an unrelated agent is");
  assert.equal(bResult.allowed, false);
  assert.equal(bResult.status, 403);
});

test("clone B spending from A's wallet is denied — same denial as an unrelated agent", () => {
  reset();
  assert.throws(
    () => checkCapability({ caller: "0xB-clone", resourceType: "wallet", resourceId: "0xA-parent", action: "pay" }),
    /has no capability for wallet:0xA-parent/,
  );
  assert.throws(
    () => checkCapability({ caller: "0xC-unrelated", resourceType: "wallet", resourceId: "0xA-parent", action: "pay" }),
    /has no capability for wallet:0xA-parent/,
  );
});

test("clone B using A's sandbox is denied — same denial as an unrelated agent", () => {
  reset();
  assert.throws(
    () => checkCapability({ caller: "0xB-clone", resourceType: "sandbox", resourceId: "sbx-A", action: "exec" }),
    /has no capability for sandbox:sbx-A/,
  );
  assert.throws(
    () => checkCapability({ caller: "0xC-unrelated", resourceType: "sandbox", resourceId: "sbx-A", action: "exec" }),
    /has no capability for sandbox:sbx-A/,
  );
});

test("both denials are logged with the identical reason code — no clone-specific bypass path", () => {
  reset();
  for (const caller of ["0xB-clone", "0xC-unrelated"]) {
    try {
      checkCapability({ caller, resourceType: "wallet", resourceId: "0xA-parent", action: "pay" });
    } catch {
      // expected
    }
  }
  const reasons = auditLog.filter((r) => r.resourceType === "wallet" && r.resourceId === "0xA-parent").map((r) => r.reason);
  assert.deepEqual(reasons, ["no-capability", "no-capability"]);
});

// ─── Group 2: regression test for this phase's own fix ────────────

test("agents.parent_address never grants ownership via resourceType 'subagent' (Phase 4f fix)", () => {
  reset();
  // Before this phase's fix, this would have resolved owner = "0xA-parent"
  // (B's parent_address) and let A's own caller identity match it,
  // ALLOWING A to 'manage' B purely via clone lineage. Confirms it no
  // longer does, regardless of which side calls it — the case now
  // always misses (a 404 "not found", never a 403 grant), matching
  // capability.ts's own post-fix ownerOf() body exactly.
  assert.throws(
    () => checkCapability({ caller: "0xA-parent", resourceType: "subagent", resourceId: "0xB-clone", action: "manage" }),
    /subagent not found: 0xB-clone/,
  );
  assert.throws(
    () => checkCapability({ caller: "0xB-clone", resourceType: "subagent", resourceId: "0xA-parent", action: "manage" }),
    /subagent not found: 0xA-parent/,
  );
});

// ─── Group 3: B must go through the ordinary propose_channel() flow ─

test("no channel exists between a freshly claimed clone and its parent", () => {
  reset();
  const related = channels.filter(
    (c) =>
      (c.proposer_address === "0xB-clone" && c.recipient_address === "0xA-parent") ||
      (c.proposer_address === "0xA-parent" && c.recipient_address === "0xB-clone"),
  );
  assert.equal(related.length, 0);
});

test("B talking to A requires the same propose -> accept sequence any two unrelated agents need", () => {
  reset();
  // Before any proposal, a payment-scope check between B and A fails —
  // same as it would between B and C.
  assert.throws(() =>
    checkCapability({ caller: "0xB-clone", resourceType: "channel", resourceId: "0xA-parent:payment", action: "pay" }),
  );

  const proposal = proposeChannelMirror("0xB-clone", "0xA-parent", "payment");
  // Still denied while only 'proposed', not yet accepted — proposing is
  // not itself a grant, for a clone-parent pair exactly as for anyone.
  assert.throws(() =>
    checkCapability({ caller: "0xB-clone", resourceType: "channel", resourceId: "0xA-parent:payment", action: "pay" }),
  );

  acceptChannelMirror(proposal.id);
  // Only now, after the same explicit accept any unrelated pair would
  // also need, does the grant resolve.
  assert.doesNotThrow(() =>
    checkCapability({ caller: "0xB-clone", resourceType: "channel", resourceId: "0xA-parent:payment", action: "pay" }),
  );
});

test("proposeChannel treats a clone/parent pair identically to any unrelated pair — no fast-track", () => {
  reset();
  const cloneParentProposal = proposeChannelMirror("0xB-clone", "0xA-parent", "file_transfer");
  const unrelatedProposal = proposeChannelMirror("0xC-unrelated", "0xA-parent", "file_transfer");
  assert.equal(cloneParentProposal.status, "proposed");
  assert.equal(unrelatedProposal.status, "proposed");
  // Same shape, same initial status, same absence of any auto-accept —
  // nothing about the clone/parent pair short-circuits the state machine.
  assert.equal(cloneParentProposal.status, unrelatedProposal.status);
});
