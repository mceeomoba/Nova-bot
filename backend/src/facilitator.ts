import express from "express";
import {
  createPublicClient,
  createWalletClient,
  http,
  verifyTypedData,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import crypto from "crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { paymentChannelRequired, requirePaymentChannel } from "./channelService.js";
import { emitEvent, isRegisteredAgent } from "./ecosystemEvents.js";

const router = express.Router();

const CHAIN = config.chainNetwork === "base" ? base : baseSepolia;
const USDC: Record<string, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const usdcAddress = USDC[config.chainNetwork];

const facilitatorAccount = privateKeyToAccount(config.facilitatorPrivateKey);
const publicClient = createPublicClient({ chain: CHAIN, transport: http() });
const walletClient = createWalletClient({
  account: facilitatorAccount,
  chain: CHAIN,
  transport: http(),
});

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
}

async function verifyAuthorization(authorization: Authorization, signature: `0x${string}`) {
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(authorization.validAfter) || now > Number(authorization.validBefore)) {
    return { isValid: false, invalidReason: "expired_or_not_yet_valid" };
  }

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: CHAIN.id,
    verifyingContract: usdcAddress,
  } as const;

  const valid = await verifyTypedData({
    address: authorization.from,
    domain,
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
    signature,
  });
  if (!valid) return { isValid: false, invalidReason: "bad_signature" };

  const balance = await publicClient.readContract({
    address: usdcAddress,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [authorization.from],
  });
  if (BigInt(balance) < BigInt(authorization.value)) {
    return { isValid: false, invalidReason: "insufficient_balance" };
  }

  return { isValid: true };
}

// POST /facilitator/verify  { authorization, signature }
router.post("/verify", async (req, res) => {
  const { authorization, signature } = req.body;
  const result = await verifyAuthorization(authorization, signature);
  res.json(result);
});

// POST /facilitator/settle  { authorization, signature, purpose? }
//
// next-phase.md Phase 6a (architecture-agent.md §7's own note: "The
// only calls that ever touch another agent's office are send_file,
// wallet.pay, and join_project — and all three hard-require an active
// channel"): audit finding, no behavior change in that phase. This is
// the real chokepoint for every agent-to-agent USDC transfer this
// backend can produce — not `/wallet/:address/pay` (that route only
// ever *signs*; it never moves a single atomic unit). See
// next-phase.md's Phase 6a write-up for the complete enumerated list
// this finding is one line of.
//
// next-phase.md Phase 6b's revised resolution (superseding this file's
// original Phase 6b note, which left this route ungated): the
// authoritative `payment`-scoped channel check now lives HERE, not only
// in wallet.ts's `/pay` route — this is the one route every fund-moving
// path actually goes through (wallet.ts's own signing flow never calls
// this directly; it hands the signed payload back to its caller, who
// settles separately), so it's the only place a check can't be routed
// around by any HTTP caller. `/wallet/pay`'s own check (still in place)
// is now a fast-fail convenience, not the sole gate — see that route's
// own comment.
//
// This closes 6a's finding #2 (a self-custody agent skipping
// `/wallet/pay` and calling this route directly with its own signed
// authorization) for real: every caller reaching this ROUTE — as
// opposed to the settleAuthorization() function below, see its own
// comment — goes through paymentChannelRequired()/requirePaymentChannel()
// exactly like every other cross-office operation. `purpose` is never
// consulted for this decision (a caller-supplied free string was never
// trustworthy enough to gate on — see marketplace.ts's own Phase 6b
// note for why marketplace payments are exempted structurally instead).
router.post("/settle", async (req, res) => {
  const { authorization, signature, purpose } = req.body as {
    authorization: Authorization;
    signature: `0x${string}`;
    purpose?: string;
  };

  if (paymentChannelRequired(authorization.from, authorization.to)) {
    try {
      requirePaymentChannel(authorization.from, authorization.to);
    } catch (err: any) {
      return res.status(err.status || 403).json({ error: err.message });
    }
  }

  const result = await settleAuthorization(authorization, signature, purpose);
  const status = result.success ? 200 : result.status ?? 400;
  res.status(status).json(result.body);
});

/**
 * The actual verify-and-move-funds logic, extracted from the `/settle`
 * route above so it has a second, in-process calling convention that
 * never touches HTTP or this route's new channel gate — see
 * marketplace.ts's own Phase 6b note for why `settleLeg()` calls this
 * directly instead of the HTTP route it used to fetch(). This is a
 * structural exemption, not a flag any request body can set: the only
 * code that can reach this function is code compiled into this same
 * process, which means "does this call skip the channel check" is
 * decided by which .ts file is calling, not by anything an external
 * caller — cooperative or adversarial — can supply. Unchanged fund-
 * moving behavior from before this phase; only the calling convention
 * (a real return value instead of an HTTP response) is new.
 */
export async function settleAuthorization(
  authorization: Authorization,
  signature: `0x${string}`,
  purpose?: string,
): Promise<{ success: boolean; status?: number; body: Record<string, unknown> }> {
  const check = await verifyAuthorization(authorization, signature);
  if (!check.isValid) return { success: false, status: 400, body: check };

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO payments (id, from_address, to_address, value_usdc, network, status, purpose, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    id,
    authorization.from,
    authorization.to,
    authorization.value,
    config.chainNetwork,
    purpose ?? null,
    Date.now(),
  );

  const r = `0x${signature.slice(2, 66)}` as `0x${string}`;
  const s = `0x${signature.slice(66, 130)}` as `0x${string}`;
  const v = parseInt(signature.slice(130, 132), 16);

  try {
    const txHash = await walletClient.writeContract({
      address: usdcAddress,
      abi: [
        {
          name: "transferWithAuthorization",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
            { name: "v", type: "uint8" },
            { name: "r", type: "bytes32" },
            { name: "s", type: "bytes32" },
          ],
          outputs: [],
        },
      ] as const,
      functionName: "transferWithAuthorization",
      args: [
        authorization.from,
        authorization.to,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        v,
        r,
        s,
      ],
    });
    db.prepare(`UPDATE payments SET status = 'settled', tx_hash = ? WHERE id = ?`).run(
      txHash,
      id,
    );
    const amountUsdc = (Number(authorization.value) / 1_000_000).toFixed(2);
    if (isRegisteredAgent(authorization.from)) {
      emitEvent({
        agentAddress: authorization.from,
        eventType: "transfer_out",
        message: `$${amountUsdc} sent to ${authorization.to.slice(0, 10)}…${purpose ? ` (${purpose})` : ""}`,
        metadata: { paymentId: id, txHash, to: authorization.to, purpose: purpose ?? null },
      });
    }
    if (isRegisteredAgent(authorization.to)) {
      emitEvent({
        agentAddress: authorization.to,
        eventType: "transfer_in",
        message: `$${amountUsdc} received from ${authorization.from.slice(0, 10)}…${purpose ? ` (${purpose})` : ""}`,
        metadata: { paymentId: id, txHash, from: authorization.from, purpose: purpose ?? null },
      });
    }
    return { success: true, body: { success: true, id, txHash, network: config.chainNetwork } };
  } catch (err: any) {
    db.prepare(`UPDATE payments SET status = 'failed' WHERE id = ?`).run(id);
    if (isRegisteredAgent(authorization.from)) {
      emitEvent({
        agentAddress: authorization.from,
        eventType: "error_critical",
        message: `Payment settlement failed: ${err.message}`,
        metadata: { paymentId: id, to: authorization.to, purpose: purpose ?? null },
      });
    }
    return { success: false, status: 400, body: { success: false, id, error: err.message } };
  }
}

// GET /facilitator/receipt/:id
router.get("/receipt/:id", (req, res) => {
  const row = db
    .prepare(
      `SELECT id, from_address, to_address, value_usdc, network, tx_hash, status, purpose, created_at
       FROM payments WHERE id = ?`,
    )
    .get(req.params.id) as
    | {
        id: string;
        from_address: string;
        to_address: string;
        value_usdc: string;
        network: string;
        tx_hash: string | null;
        status: string;
        purpose: string | null;
        created_at: number;
      }
    | undefined;

  if (!row) {
    return res.status(404).json({ error: "not_found", id: req.params.id });
  }

  res.json({
    id: row.id,
    from: row.from_address,
    to: row.to_address,
    value: row.value_usdc,
    network: row.network,
    txHash: row.tx_hash,
    status: row.status,
    purpose: row.purpose,
    createdAt: row.created_at,
  });
});

export default router;
