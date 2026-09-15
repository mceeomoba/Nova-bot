/**
 * Public ERC-8004 surface.
 *
 * Mounted BEFORE the shared-secret auth middleware in index.ts — same
 * treatment as portProxy.ts — because the entire point of ERC-8004 is
 * that other agents (who don't have and shouldn't need your
 * BACKEND_API_KEY) can independently resolve an agent's identity and
 * verify it against the chain themselves. Nothing served here is
 * private: an address, a name, and a token URI are already public the
 * moment an agent transacts on Base.
 */

import express from "express";
import { db } from "./db.js";
import { config } from "./config.js";
import { verifyOnChain, IDENTITY_REGISTRY_ADDRESS } from "./erc8004.js";
import type { Address } from "viem";

const router = express.Router();

function safeJsonParseAgentCard(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface AgentRow {
  address: string;
  name: string;
  created_at: number;
  erc8004_agent_id: string | null;
  erc8004_chain: string | null;
  erc8004_registry_address: string | null;
  erc8004_tx_hash: string | null;
}

/**
 * GET /agents/:address/card.json — the ERC-8004 agent registration file.
 * This is what an agent's on-chain `agentURI` should point to. Kept
 * deliberately minimal — no lineage, no sandbox details, no spend
 * history. Anyone resolving this is a stranger by design.
 */
router.get("/:address/card.json", (req, res) => {
  const row = db
    .prepare(`SELECT address, name, created_at FROM agents WHERE address = ?`)
    .get(req.params.address) as Pick<AgentRow, "address" | "name" | "created_at"> | undefined;
  if (!row) return res.status(404).json({ error: "unknown agent address" });

  // Active marketplace listings this agent sells — surfaced here so a
  // stranger resolving this agent's ERC-8004 identity finds what it's
  // selling in the same lookup, not via a separate out-of-band DB query.
  // Same public shape as GET /marketplace/listings (endpoint_url withheld;
  // reachable only by paying through POST /marketplace/:id/invoke).
  const listings = db
    .prepare(
      `SELECT id, name, description, price_usdc, category, delivery_type, schema
       FROM listings WHERE seller_address = ? AND active = 1
       ORDER BY created_at DESC`,
    )
    .all(row.address) as {
    id: string;
    name: string;
    description: string | null;
    price_usdc: string;
    category: string | null;
    delivery_type: string;
    schema: string | null;
  }[];

  res.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: row.name,
    description: `Autonomous agent operated on a self-hosted automaton-stack VM.`,
    registrations: [
      {
        agentId: null, // filled in by clients via the erc8004 fields below once registered
        agentRegistry: `eip155:${config.chainNetwork === "base" ? 8453 : 84532}:${IDENTITY_REGISTRY_ADDRESS}`,
      },
    ],
    addresses: [{ address: row.address, chainType: "evm" }],
    createdAt: new Date(row.created_at).toISOString(),
    services: listings.map((l) => ({
      type: "https://eips.ethereum.org/EIPS/eip-8004#marketplace-listing-v1",
      listingId: l.id,
      name: l.name,
      description: l.description,
      priceUsdc: l.price_usdc,
      category: l.category,
      deliveryType: l.delivery_type,
      schema: l.schema ? safeJsonParseAgentCard(l.schema) : null,
      invokeUrl: `/marketplace/${l.id}/invoke`,
    })),
  });
});

/**
 * GET /agents/:address/erc8004 — convenience lookup combining our cached
 * row with a live on-chain read. The `verified` field is the only part
 * worth trusting; everything else is exactly what /wallet/:address/pay
 * or a chain explorer would already show a stranger for free. Public,
 * no backend key required, same as card.json above.
 */
router.get("/:address/erc8004", async (req, res) => {
  const row = db
    .prepare(
      `SELECT address, erc8004_agent_id, erc8004_chain, erc8004_registry_address, erc8004_tx_hash
       FROM agents WHERE address = ?`,
    )
    .get(req.params.address) as AgentRow | undefined;

  if (!row || !row.erc8004_agent_id) {
    return res.json({ address: req.params.address, registered: false });
  }

  try {
    const onchain = await verifyOnChain(row.erc8004_agent_id, row.address as Address);
    res.json({
      address: row.address,
      registered: true,
      agentId: row.erc8004_agent_id,
      chain: row.erc8004_chain,
      registryAddress: row.erc8004_registry_address,
      txHash: row.erc8004_tx_hash,
      verifiedOnChain: onchain.verified,
      onChainOwner: onchain.owner,
      onChainAgentURI: onchain.agentURI,
    });
  } catch (err: any) {
    // Chain read failed (RPC hiccup, etc) — say so rather than silently
    // falling back to the unverified cached row.
    res.status(502).json({
      address: row.address,
      registered: true,
      agentId: row.erc8004_agent_id,
      verifiedOnChain: null,
      error: `onchain_read_failed: ${err.message}`,
    });
  }
});

export default router;
