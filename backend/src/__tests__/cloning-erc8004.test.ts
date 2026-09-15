// next-phase.md Phase 4c (architecture-agent.md §5): tests for the
// clone's on-chain ERC-8004 identity path.
//
// The real correction this phase's own plan needed, found while
// implementing it (same shape as 4a's agt_... correction and 4b's
// office/private/ correction): this phase's header line says
// "Touches: erc8004Trust.ts", but on-chain *registration* has never
// lived there — erc8004Trust.ts is the Reputation/Validation
// ("trust signal") registries; registerOnChain() lives in erc8004.ts
// and is called from wallet.ts's existing POST
// /wallet/:address/erc8004/register route. That route is already
// fully generic over `address` — it does a single
// `SELECT encrypted_key, erc8004_agent_id FROM agents WHERE address = ?`,
// with no join, no parent lookup, and no code path anywhere in
// erc8004.ts or wallet.ts's register handler that reads a `parent`
// or `parent_address` field. A clone's `agents` row (wallet.ts's
// createClonedAgentWallet(), Phase 4b) is inserted with
// erc8004_agent_id/erc8004_chain/erc8004_registry_address/erc8004_tx_hash
// all implicitly NULL (never set at insert time — same as any other
// brand-new top-level agent, see createAgentWallet() for the
// identical insert shape), so calling the same existing route against
// a clone's own address registers a genuinely fresh on-chain identity
// through the exact same path, with nothing to wire that doesn't
// already exist. This phase's own two checklist items are therefore
// a confirmation phase, not a new-code phase — same shape as Phase
// 2c's own "it turned out ... was already done" finding.
//
// Deliberately NOT auto-called from createClonedAgentWallet() (Phase
// 4b) itself: registerOnChain()'s own assertCanAffordGas() preflight
// requires a nonzero ETH balance for gas, and Phase 4b's own "Done
// when" guarantees a clone starts at exactly zero balance — an
// auto-registration at claim time would deterministically fail every
// time with insufficient_gas, before the clone's operator has had any
// chance to fund it. Registration stays the same opt-in step for a
// clone as it already is for any other agent.
//
// Same constraint every prior backend/src test file in this repo has
// flagged: no network access to `npm install` viem/better-sqlite3
// here, so the real registerOnChain()/wallet.ts route can't be
// imported and exercised end-to-end against a real chain. What's
// tested here is an inlined mirror of the actual decision logic (the
// register route's own guard order, and registerOnChain's own "mint
// -> read Transfer event -> return agentId" shape) operating against
// plain in-memory arrays standing in for `agents`, plus a fake
// registry contract that mints sequential token ids so "distinct from
// the parent's agentId" is a real, checkable assertion rather than an
// assumption.
//
// Compiled with `tsc --target es2020 --module commonjs` to plain JS
// in a scratch dir and run with `node --test`, same as every prior
// phase's own inlined-copy tests. Recommend re-running against the
// real functions with a live sqlite3 DB and an RPC endpoint once a
// networked environment is available, per every prior phase's own
// standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

interface AgentRow {
  address: string;
  name: string;
  parent_address: string | null;
  encrypted_key: string | null;
  erc8004_agent_id: string | null;
  erc8004_chain: string | null;
  erc8004_registry_address: string | null;
  erc8004_tx_hash: string | null;
}

// --- Fake tables + fake on-chain registry, reset per test ---
let agents: AgentRow[];
let nextTokenId: number;
let mintCalls: Array<{ callerAddress: string; agentURI: string }>;

function reset() {
  agents = [
    {
      address: "0xparent",
      name: "parent",
      parent_address: null,
      encrypted_key: "parent-key",
      erc8004_agent_id: "1", // parent already registered, agentId 1
      erc8004_chain: "eip155:8453",
      erc8004_registry_address: "0xIDENTITY",
      erc8004_tx_hash: "0xparenttx",
    },
    {
      address: "0xclone1",
      name: "clone-of-parent",
      parent_address: null, // Phase 4e's job, not this phase's — see wallet.ts's own note
      encrypted_key: "clone-key",
      erc8004_agent_id: null, // never copied at insert — see this file's header note
      erc8004_chain: null,
      erc8004_registry_address: null,
      erc8004_tx_hash: null,
    },
    {
      address: "0xselfcustody",
      name: "self-custody-clone",
      parent_address: null,
      encrypted_key: null, // backend never custodied this one's key
      erc8004_agent_id: null,
      erc8004_chain: null,
      erc8004_registry_address: null,
      erc8004_tx_hash: null,
    },
  ];
  nextTokenId = 2; // parent already minted 1 — next real mint starts at 2
  mintCalls = [];
}

// Inlined mirror of erc8004.ts's registerOnChain(): mints a fresh
// token, returns the id read back off the (fake) Transfer event. Takes
// no `parent` argument anywhere in its signature — there is nothing
// for a caller to pass even if it wanted to reference the parent's
// identity.
function registerOnChain(callerAddress: string, agentURI: string): { agentId: string; txHash: string } {
  mintCalls.push({ callerAddress, agentURI });
  const agentId = String(nextTokenId);
  nextTokenId += 1;
  return { agentId, txHash: `0xtx${agentId}` };
}

// Inlined mirror of wallet.ts's POST /:address/erc8004/register handler.
function registerRoute(address: string, agentURI?: string): { agentId: string; alreadyRegistered: boolean } {
  const row = agents.find((a) => a.address === address);
  if (!row) throw Object.assign(new Error("unknown agent address"), { status: 404 });
  if (!row.encrypted_key) {
    throw Object.assign(new Error("self_custody_wallet: backend does not hold this agent's key"), {
      status: 403,
    });
  }
  if (row.erc8004_agent_id) {
    return { agentId: row.erc8004_agent_id, alreadyRegistered: true };
  }
  const uri = agentURI || `https://example.invalid/agents/${address}/card.json`;
  const result = registerOnChain(address, uri);
  row.erc8004_agent_id = result.agentId;
  row.erc8004_chain = "eip155:8453";
  row.erc8004_registry_address = "0xIDENTITY";
  row.erc8004_tx_hash = result.txHash;
  return { agentId: result.agentId, alreadyRegistered: false };
}

// Inlined mirror of agentCard.ts's GET /:address/card.json — confirms
// the shape this phase's second checklist item cares about: no parent,
// lineage, or reputation field anywhere in what a stranger resolving
// the clone's identity can see.
function cardJson(address: string): Record<string, unknown> {
  const row = agents.find((a) => a.address === address)!;
  return {
    name: row.name,
    addresses: [{ address: row.address, chainType: "evm" }],
    registrations: [{ agentId: null, agentRegistry: "eip155:8453:0xIDENTITY" }],
  };
}

// --- Tests ---

test("registering a clone's address mints a fresh, real on-chain identity", () => {
  reset();
  const result = registerRoute("0xclone1");
  assert.equal(result.alreadyRegistered, false);
  assert.equal(agents.find((a) => a.address === "0xclone1")?.erc8004_agent_id, result.agentId);
});

test("a clone's registered agentId is distinct from its parent's", () => {
  reset();
  const result = registerRoute("0xclone1");
  const parentId = agents.find((a) => a.address === "0xparent")?.erc8004_agent_id;
  assert.notEqual(result.agentId, parentId);
});

test("registerOnChain is called with only the clone's own address, never the parent's", () => {
  reset();
  registerRoute("0xclone1");
  assert.equal(mintCalls.length, 1);
  assert.equal(mintCalls[0].callerAddress, "0xclone1");
});

test("registering a clone does not read or mutate the parent's row at all", () => {
  reset();
  const parentBefore = { ...agents.find((a) => a.address === "0xparent")! };
  registerRoute("0xclone1");
  const parentAfter = agents.find((a) => a.address === "0xparent")!;
  assert.deepEqual(parentAfter, parentBefore);
});

test("a clone starts with no erc8004 fields set (never copied at insert time)", () => {
  reset();
  const row = agents.find((a) => a.address === "0xclone1")!;
  assert.equal(row.erc8004_agent_id, null);
  assert.equal(row.erc8004_chain, null);
  assert.equal(row.erc8004_registry_address, null);
  assert.equal(row.erc8004_tx_hash, null);
});

test("registering an already-registered clone is idempotent and mints nothing new", () => {
  reset();
  registerRoute("0xclone1");
  const second = registerRoute("0xclone1");
  assert.equal(second.alreadyRegistered, true);
  assert.equal(mintCalls.length, 1); // no second mint
});

test("a self-custody clone (no backend-held key) is rejected the same way any self-custody agent is", () => {
  reset();
  assert.throws(() => registerRoute("0xselfcustody"), /self_custody_wallet/);
  assert.equal(mintCalls.length, 0);
});

test("registering an unknown address is rejected", () => {
  reset();
  assert.throws(() => registerRoute("0xnope"), /unknown agent address/);
});

test("the clone's public agent card carries no parent, lineage, or reputation reference", () => {
  reset();
  registerRoute("0xclone1");
  const card = cardJson("0xclone1");
  // Field-level check rather than a raw substring scan — the clone's
  // own display name ("clone-of-parent") legitimately contains the
  // word "parent", which a naive substring check would misfire on;
  // what actually matters is that no key/value in the card resolves
  // to the parent's own address or an on-chain reputation record.
  assert.ok(!("parent" in card));
  assert.ok(!("lineage" in card));
  assert.ok(!("reputation" in card));
  assert.ok(!JSON.stringify(card).includes("0xparent"));
});
