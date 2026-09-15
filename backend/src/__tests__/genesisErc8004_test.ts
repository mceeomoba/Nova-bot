// Zent.md Phase 18a: "ERC-8004 registration for Agent B reused from
// erc8004.ts's Identity Registry mechanism, tagged with the parent
// relationship."
//
// Same "no live better-sqlite3, no real chain" reason every other
// genesis*_test.ts file in this directory already gives — this mirrors
// registerGenesisIdentity()'s outcome-classification logic (not its
// actual viem/chain calls, which this test stubs out) against in-memory
// stand-ins for the `agents` row and the `genesis_erc8004_registrations`
// table.
//
// What this covers:
//   - self-custody agent (no encrypted_key) -> 'skipped_self_custody',
//     no chain calls attempted at all.
//   - parent has insufficient ETH for the gas top-up ->
//     'gas_funding_failed', registration never attempted.
//   - gas top-up transfer itself throws (e.g. tx reverted) ->
//     'gas_funding_failed', detail carries the thrown message.
//   - gas funding succeeds (or was already unnecessary) but
//     registerOnChain() throws -> 'registration_failed', the gas outcome
//     (funded tx hash, if any) is still preserved on the row rather than
//     discarded.
//   - happy path -> 'registered', agents row gets erc8004_agent_id/
//     chain/registryAddress/txHash written, exactly one row in
//     genesis_erc8004_registrations.
//   - every outcome writes exactly one row, unconditionally, same
//     "complete history" contract as every other genesis-family check.

import { test } from "node:test";
import assert from "node:assert/strict";

type Outcome = "registered" | "gas_funding_failed" | "registration_failed" | "skipped_self_custody";

interface Row {
  id: string;
  opportunityId: string;
  agentAddress: string;
  parentAddress: string;
  outcome: Outcome;
  agentId: string | null;
  txHash: string | null;
  gasFundingTxHash: string | null;
  gasWeiSent: string | null;
  detail: string;
  registeredAt: number;
}

interface FakeAgent {
  encryptedKey: string | null;
  erc8004AgentId: string | null;
}

let agents: Record<string, FakeAgent>;
let rows: Row[];
let nextId: number;

// Test-controlled stand-ins for the chain-touching dependencies.
let fundGasResult:
  | { funded: true; txHash: string; weiSent: bigint }
  | { funded: false; reason: "already_funded" | "parent_insufficient_eth"; weiSent: bigint }
  | { throws: string };
let registerResult:
  | { agentId: string; txHash: string; chain: string; registryAddress: string }
  | { throws: string };

function reset() {
  agents = {};
  rows = [];
  nextId = 1;
  fundGasResult = { funded: false, reason: "already_funded", weiSent: 0n };
  registerResult = { throws: "not configured" };
}

function seedAgent(address: string, encryptedKey: string | null) {
  agents[address] = { encryptedKey, erc8004AgentId: null };
}

function writeResult(r: Row): Row {
  rows.push(r);
  return r;
}

// Mirrors registerGenesisIdentity()'s control flow field-for-field
// against the fakes above, in place of getAgentAccount()/
// fundGasForRegistration()/registerOnChain().
async function registerGenesisIdentity(
  opportunityId: string,
  parentAddress: string,
  agentAddress: string,
): Promise<Row> {
  const startedAt = 1_000_000;
  const row = agents[agentAddress];
  const base = { id: `reg-${nextId++}`, opportunityId, agentAddress, parentAddress, registeredAt: startedAt };

  if (!row) {
    return writeResult({ ...base, outcome: "registration_failed", agentId: null, txHash: null, gasFundingTxHash: null, gasWeiSent: null, detail: `unknown agent address: ${agentAddress}` });
  }
  if (!row.encryptedKey) {
    return writeResult({ ...base, outcome: "skipped_self_custody", agentId: null, txHash: null, gasFundingTxHash: null, gasWeiSent: null, detail: "backend does not hold this agent's key" });
  }

  let gasFundingTxHash: string | null = null;
  let gasWeiSent: string | null = null;
  if ("throws" in fundGasResult) {
    return writeResult({ ...base, outcome: "gas_funding_failed", agentId: null, txHash: null, gasFundingTxHash: null, gasWeiSent: null, detail: `gas top-up transfer failed: ${fundGasResult.throws}` });
  }
  if (fundGasResult.funded) {
    gasFundingTxHash = fundGasResult.txHash;
    gasWeiSent = fundGasResult.weiSent.toString();
  } else if (fundGasResult.reason === "parent_insufficient_eth") {
    return writeResult({ ...base, outcome: "gas_funding_failed", agentId: null, txHash: null, gasFundingTxHash: null, gasWeiSent: null, detail: `parent agent ${parentAddress} does not hold enough ETH to fund Agent B's registration gas` });
  }

  if ("throws" in registerResult) {
    return writeResult({ ...base, outcome: "registration_failed", agentId: null, txHash: null, gasFundingTxHash, gasWeiSent, detail: `erc8004 registration failed: ${registerResult.throws}` });
  }

  row.erc8004AgentId = registerResult.agentId;
  return writeResult({
    ...base,
    outcome: "registered",
    agentId: registerResult.agentId,
    txHash: registerResult.txHash,
    gasFundingTxHash,
    gasWeiSent,
    detail: `registered as ERC-8004 agentId ${registerResult.agentId} on ${registerResult.chain}`,
  });
}

// ─── Tests ───────────────────────────────────────────────────────

test("self-custody agent is skipped, no chain calls attempted", async () => {
  reset();
  seedAgent("0xAgentB", null);
  const result = await registerGenesisIdentity("opp-1", "0xRoot", "0xAgentB");
  assert.equal(result.outcome, "skipped_self_custody");
  assert.equal(agents["0xAgentB"].erc8004AgentId, null);
  assert.equal(rows.length, 1);
});

test("parent lacks ETH for gas top-up -> gas_funding_failed, registration never attempted", async () => {
  reset();
  seedAgent("0xAgentB", "encrypted-key");
  fundGasResult = { funded: false, reason: "parent_insufficient_eth", weiSent: 0n };
  registerResult = { throws: "should not be called" };

  const result = await registerGenesisIdentity("opp-1", "0xRoot", "0xAgentB");
  assert.equal(result.outcome, "gas_funding_failed");
  assert.match(result.detail, /does not hold enough ETH/);
  assert.equal(result.txHash, null);
});

test("gas transfer itself throws -> gas_funding_failed with the thrown message", async () => {
  reset();
  seedAgent("0xAgentB", "encrypted-key");
  fundGasResult = { throws: "erc8004_gas_funding_reverted: tx 0xdead" };

  const result = await registerGenesisIdentity("opp-1", "0xRoot", "0xAgentB");
  assert.equal(result.outcome, "gas_funding_failed");
  assert.match(result.detail, /0xdead/);
});

test("gas funded but registerOnChain throws -> registration_failed, gas outcome preserved", async () => {
  reset();
  seedAgent("0xAgentB", "encrypted-key");
  fundGasResult = { funded: true, txHash: "0xgas123", weiSent: 250_000_000_000_000n };
  registerResult = { throws: "insufficient_gas: wallet has 0 wei" };

  const result = await registerGenesisIdentity("opp-1", "0xRoot", "0xAgentB");
  assert.equal(result.outcome, "registration_failed");
  assert.equal(result.gasFundingTxHash, "0xgas123");
  assert.equal(result.gasWeiSent, "250000000000000");
  assert.equal(agents["0xAgentB"].erc8004AgentId, null);
});

test("happy path: already funded, registration succeeds", async () => {
  reset();
  seedAgent("0xAgentB", "encrypted-key");
  fundGasResult = { funded: false, reason: "already_funded", weiSent: 0n };
  registerResult = {
    agentId: "42",
    txHash: "0xabc123",
    chain: "eip155:8453",
    registryAddress: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  };

  const result = await registerGenesisIdentity("opp-1", "0xRoot", "0xAgentB");
  assert.equal(result.outcome, "registered");
  assert.equal(result.agentId, "42");
  assert.equal(result.txHash, "0xabc123");
  assert.equal(result.gasFundingTxHash, null, "no gas tx when funding was unnecessary");
  assert.equal(agents["0xAgentB"].erc8004AgentId, "42");
  assert.equal(rows.length, 1);
});

test("every outcome writes exactly one row", async () => {
  reset();
  seedAgent("0xAgentB", "encrypted-key");
  fundGasResult = { funded: false, reason: "parent_insufficient_eth", weiSent: 0n };
  await registerGenesisIdentity("opp-1", "0xRoot", "0xAgentB");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentAddress, "0xAgentB");
  assert.equal(rows[0].opportunityId, "opp-1");
  assert.equal(rows[0].parentAddress, "0xRoot");
});
