import crypto from "crypto";
import type { Address } from "viem";
import { db } from "./db.js";
import { config } from "./config.js";
import { getAgentAccount } from "./wallet.js";
import { registerOnChain, fundGasForRegistration, type Erc8004Registration } from "./erc8004.js";

/**
 * Zent.md Phase 18a — "ERC-8004 registration for Agent B reused from
 * erc8004Trust.ts/cloning-erc8004.test.ts — same on-chain identity
 * mechanism, tagged with the parent relationship."
 *
 * Plan-text correction, found while implementing it (same kind of
 * mismatch wallet.ts's own /erc8004/register route header already
 * flagged for a different plan document): the actual on-chain identity
 * mechanism lives in erc8004.ts (Identity Registry — register(),
 * verifyOnChain()), not erc8004Trust.ts (Reputation/Validation
 * registries — the marketplace dispute path, unrelated to birth-time
 * identity). This file reuses erc8004.ts's registerOnChain(), and
 * cloning-erc8004.test.ts only as prior art confirming that registering
 * a spawn_clone-family agent mints an independent on-chain identity,
 * never a delegated one under the parent — this reuses that same
 * property for a pipeline-spawned agent.
 *
 * "Tagged with the parent relationship": erc8004.ts's own agentCard.ts
 * deliberately keeps the public card.json minimal ("no lineage, no
 * sandbox details, no spend history... anyone resolving this is a
 * stranger by design") — so the tag is not an on-chain field. It is the
 * existing private `agents` row itself: parent_address (set at birth by
 * whichever wallet.ts creation path ran), spawn_reason =
 * 'expansion_pipeline' + opportunity_id (Phase 16e's
 * tagCompanyLineage()), and this phase's own erc8004_agent_id/
 * erc8004_tx_hash columns, all on the same row. GET /wallet/:address/
 * lineage already reads that row wholesale (`self` via `SELECT *`), so
 * the on-chain identity is queryable *as* parent-tagged the moment this
 * function writes it — no new column, no new on-chain call.
 *
 * The gap this file actually has to close: Agent B is funded with USDC
 * at birth (Phase 16b) but never ETH, so its wallet starts at exactly
 * zero wei — the same "clone starts at exactly zero balance" fact
 * wallet.ts's /erc8004/register route header documents as the reason
 * *that* route stays a manual, opt-in step for an ordinary spawn_clone
 * birth (auto-calling it there "would always fail with
 * insufficient_gas before the operator has had any chance to fund the
 * clone"). This pipeline has no operator step at all (Zent.md's own
 * closing note), so leaving that gap here would mean Phase 18a's
 * registration attempt fails insufficient_gas on literally every
 * genesis — see erc8004.ts's fundGasForRegistration() for the capped,
 * best-effort top-up that closes it instead.
 *
 * No human override, same posture as every other Zent.md phase in this
 * codebase: registerGenesisIdentity() is called automatically by
 * genesis.ts's genesisExecutorAdapter(), immediately after 17e-iv
 * resolves Agent B's activation status, with no operator approval step
 * between "agent activated" and "agent's identity published on a
 * public chain," and none is added here.
 *
 * IMPORTANT, and worth reading before wiring this to real funds: unlike
 * every other 17e/18-family check, a call into this file is not free to
 * retry and not privately reversible. registerOnChain() is a real,
 * irreversible, publicly-visible Base transaction the moment it lands —
 * there is no "mark it failed and move on" that un-mints an ERC-8004
 * token, and fundGasForRegistration() moves real ETH out of the parent
 * agent's wallet even on a registration attempt that then itself fails.
 * Every failure mode below is still handled the same non-fatal,
 * record-and-continue way this pipeline handles every other genesis-
 * family failure (Agent B stays a real, active company either way) —
 * but that consistency is a statement about this *codebase's* pattern,
 * not a claim that an on-chain identity registration carries the same
 * stakes as an internal DB status flag. Recommend exercising this
 * against Base Sepolia (config.chainNetwork = 'base-sepolia') before
 * ever letting it run unattended against Base mainnet.
 */

export type GenesisErc8004Outcome =
  | "registered"
  | "gas_funding_failed"
  | "registration_failed"
  | "skipped_self_custody";

export interface GenesisErc8004Result {
  id: string;
  opportunityId: string;
  agentAddress: string;
  parentAddress: string;
  outcome: GenesisErc8004Outcome;
  agentId: string | null;
  txHash: string | null;
  gasFundingTxHash: string | null;
  gasWeiSent: string | null; // stringified bigint, SQLite has no native bigint column type
  detail: string;
  registeredAt: number;
}

/**
 * Called by genesis.ts's genesisExecutorAdapter(), only after 17e-iv
 * has already marked Agent B 'active' (registering an identity for a
 * company whose first tick failed its own smoke test or constitution
 * check is not this phase's call to make — see genesis.ts's own call
 * site for where this sits in that sequence).
 *
 * Never throws for an on-chain or gas-funding failure — those are
 * recorded outcomes (see GenesisErc8004Outcome), same "assert into the
 * table, don't propagate an exception the caller has to interpret"
 * posture 17e-ii/17e-iii/17e-iv all already use. Only a genuine bug (a
 * malformed agentAddress row, a thrown error from getAgentAccount()
 * other than the documented "self-custody, no key here" case) escapes
 * uncaught.
 */
export async function registerGenesisIdentity(
  opportunityId: string,
  parentAddress: string,
  agentAddress: string,
): Promise<GenesisErc8004Result> {
  const startedAt = Date.now();
  const row = db
    .prepare(`SELECT encrypted_key FROM agents WHERE address = ?`)
    .get(agentAddress) as { encrypted_key: string | null } | undefined;

  const base: Omit<GenesisErc8004Result, "outcome" | "agentId" | "txHash" | "gasFundingTxHash" | "gasWeiSent" | "detail"> = {
    id: crypto.randomUUID(),
    opportunityId,
    agentAddress,
    parentAddress,
    registeredAt: startedAt,
  };

  if (!row) {
    return writeResult({ ...base, outcome: "registration_failed", agentId: null, txHash: null, gasFundingTxHash: null, gasWeiSent: null, detail: `unknown agent address: ${agentAddress}` });
  }
  if (!row.encrypted_key) {
    // Every pipeline-spawned agent today is backend-custodied
    // (genesis.ts's provisionAgentRuntimeIdentity() runs through
    // wallet.ts's createClonedAgentWallet(), which always sets
    // encrypted_key) — this branch exists for the same reason
    // wallet.ts's own manual route checks it: a future self-custody
    // genesis path would hit this immediately, and "skip, don't crash
    // the pipeline" is the correct behavior for it, same as every
    // other outcome here.
    return writeResult({ ...base, outcome: "skipped_self_custody", agentId: null, txHash: null, gasFundingTxHash: null, gasWeiSent: null, detail: "backend does not hold this agent's key" });
  }

  const agentURI = `${config.publicBaseUrl}/agents/${agentAddress}/card.json`;
  const childAccount = getAgentAccount(agentAddress);

  let gasFundingTxHash: string | null = null;
  let gasWeiSent: string | null = null;
  try {
    const parentAccount = getAgentAccount(parentAddress);
    const funding = await fundGasForRegistration(parentAccount, agentAddress as Address, agentURI, config.genesisGasFundingWeiCap);
    if (funding.funded) {
      gasFundingTxHash = funding.txHash;
      gasWeiSent = funding.weiSent.toString();
    } else if (funding.reason === "parent_insufficient_eth") {
      return writeResult({
        ...base,
        outcome: "gas_funding_failed",
        agentId: null,
        txHash: null,
        gasFundingTxHash: null,
        gasWeiSent: null,
        detail: `parent agent ${parentAddress} does not hold enough ETH to fund Agent B's registration gas`,
      });
    }
    // funding.reason === 'already_funded' -> proceed straight to
    // registration, nothing to record here.
  } catch (err) {
    return writeResult({
      ...base,
      outcome: "gas_funding_failed",
      agentId: null,
      txHash: null,
      gasFundingTxHash: null,
      gasWeiSent: null,
      detail: `gas top-up transfer failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  let registration: Erc8004Registration;
  try {
    registration = await registerOnChain(childAccount, agentURI);
  } catch (err) {
    return writeResult({
      ...base,
      outcome: "registration_failed",
      agentId: null,
      txHash: null,
      gasFundingTxHash,
      gasWeiSent,
      detail: `erc8004 registration failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  db.prepare(
    `UPDATE agents
     SET erc8004_agent_id = ?, erc8004_chain = ?, erc8004_registry_address = ?,
         erc8004_tx_hash = ?, erc8004_registered_at = ?
     WHERE address = ?`,
  ).run(registration.agentId, registration.chain, registration.registryAddress, registration.txHash, Date.now(), agentAddress);

  return writeResult({
    ...base,
    outcome: "registered",
    agentId: registration.agentId,
    txHash: registration.txHash,
    gasFundingTxHash,
    gasWeiSent,
    detail: `registered as ERC-8004 agentId ${registration.agentId} on ${registration.chain}`,
  });
}

function writeResult(result: GenesisErc8004Result): GenesisErc8004Result {
  db.prepare(
    `INSERT INTO genesis_erc8004_registrations
       (id, opportunity_id, agent_address, parent_address, outcome, agent_id, tx_hash,
        gas_funding_tx_hash, gas_wei_sent, detail, registered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.id,
    result.opportunityId,
    result.agentAddress,
    result.parentAddress,
    result.outcome,
    result.agentId,
    result.txHash,
    result.gasFundingTxHash,
    result.gasWeiSent,
    result.detail,
    result.registeredAt,
  );
  return result;
}

/** Read-only convenience for 18b's ecosystem tree view and any future
 *  status UI — not used by registerGenesisIdentity() itself. */
export function getLatestGenesisErc8004Registration(agentAddress: string): GenesisErc8004Result | undefined {
  const row = db
    .prepare(
      `SELECT id, opportunity_id as opportunityId, agent_address as agentAddress,
              parent_address as parentAddress, outcome, agent_id as agentId, tx_hash as txHash,
              gas_funding_tx_hash as gasFundingTxHash, gas_wei_sent as gasWeiSent, detail,
              registered_at as registeredAt
       FROM genesis_erc8004_registrations
       WHERE agent_address = ?
       ORDER BY registered_at DESC
       LIMIT 1`,
    )
    .get(agentAddress) as GenesisErc8004Result | undefined;
  return row;
}
