/**
 * ERC-8004 Reputation & Validation Registries — the two "trust signal"
 * registries in the spec, alongside the Identity Registry already wired
 * up in erc8004.ts. This module is the on-chain half of the marketplace
 * dispute path (see marketplace.ts): a buyer flagging a bad invocation,
 * and a seller optionally opting a listing into third-party validation.
 *
 * Neither registry moves money and neither is required reading for
 * marketplace.ts to work — both calls in this file are best-effort. If
 * an on-chain call here fails (no gas, RPC hiccup, agent never
 * registered an ERC-8004 identity), the off-chain evidence + flag
 * already recorded in db.ts stands on its own; this module only adds a
 * public, independently-checkable copy of the same signal.
 *
 * Same caveat as erc8004.ts for REPUTATION_REGISTRY_ADDRESS: it's the
 * current canonical ERC-8004 v1.0 deployment (CREATE2, same address
 * across chains) as of this writing — verify against
 * https://github.com/erc-8004/erc-8004-contracts before relying on this
 * in production, registries can be redeployed.
 *
 * VALIDATION_REGISTRY_ADDRESS is different: the ERC-8004 core team has
 * not published a canonical address for it (spec section still under
 * active revision), so there is no default here — see the const's own
 * docblock below. Set ERC8004_VALIDATION_REGISTRY yourself once you've
 * confirmed which deployment you trust, or leave it unset to keep the
 * validation-request feature off.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  toBytes,
  toHex,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { config } from "./config.js";
import { IDENTITY_REGISTRY_ADDRESS } from "./erc8004.js";

const CHAIN = config.chainNetwork === "base" ? base : baseSepolia;

export const REPUTATION_REGISTRY_ADDRESS: Address =
  (process.env.ERC8004_REPUTATION_REGISTRY as Address) ||
  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63";

// Unlike Identity and Reputation, the ERC-8004 core team has NOT published
// a canonical Validation Registry address as of this writing — the spec's
// own README flags that section "under active update and discussion with
// the TEE community." There is no safe default to fall back to here: a
// wrong guess would silently send a real transaction to the wrong
// contract. Deliberately unset unless the operator provides one — every
// caller in this file must treat a missing address as "feature disabled,"
// never substitute another registry's address.
export const VALIDATION_REGISTRY_ADDRESS: Address | null =
  (process.env.ERC8004_VALIDATION_REGISTRY as Address) || null;

const REPUTATION_ABI = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, bytes32 tag1, bytes32 tag2, string feedbackURI, bytes32 feedbackHash) external",
]);

const VALIDATION_ABI = parseAbi([
  "function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash) external",
  "function getValidationStatus(bytes32 requestHash) external view returns (uint8 status, address validator, uint256 agentId)",
]);

function rpcUrl(): string | undefined {
  return process.env.ERC8004_RPC_URL || undefined;
}

function tag(s: string): `0x${string}` {
  // Reputation tags are bytes32 — this backend only ever uses a small,
  // fixed vocabulary ("marketplace_flag", "reason:<code>"), so a
  // truncated-and-padded encoding is fine; it doesn't need to round-trip
  // arbitrary strings.
  return toHex(toBytes(s.slice(0, 32)), { size: 32 });
}

/**
 * Push a buyer's flag onto the Reputation Registry as negative feedback
 * against the seller's ERC-8004 agentId. This is the on-chain mirror of
 * an invocation_flags row (db.ts) — same event, published publicly.
 *
 * Only works if the flagging buyer holds a backend-custodied wallet
 * (the caller passes that account in) and the seller has an
 * erc8004_agent_id on file; marketplace.ts checks both before calling
 * this and treats a null return as "skipped, off-chain flag still
 * stands" rather than an error.
 */
export async function pushNegativeFeedback(
  buyerAccount: PrivateKeyAccount,
  sellerAgentId: string,
  reason: string,
  feedbackURI: string,
  feedbackHash: `0x${string}`,
): Promise<{ txHash: string } | null> {
  try {
    const walletClient = createWalletClient({
      account: buyerAccount,
      chain: CHAIN,
      transport: http(rpcUrl()),
    });
    const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });

    // Fixed, minimal on-chain signal: -100 on a 0-decimal scale reads
    // unambiguously as "bad" regardless of what scale other feedback in
    // this registry happens to use. The *why* (reason code, invocation
    // evidence hash) lives in feedbackURI/feedbackHash, not squeezed
    // into the numeric value.
    const txHash = await walletClient.writeContract({
      address: REPUTATION_REGISTRY_ADDRESS,
      abi: REPUTATION_ABI,
      functionName: "giveFeedback",
      args: [
        BigInt(sellerAgentId),
        -100n,
        0,
        tag("marketplace_flag"),
        tag(`reason:${reason}`),
        feedbackURI,
        feedbackHash,
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return null;
    return { txHash };
  } catch {
    // Best-effort — see module docblock. Caller logs/ignores.
    return null;
  }
}

/**
 * Opt-in validation request, called once per invocation for listings
 * that set a validator_address (marketplace.ts). Fire-and-forget from
 * the seller's own on-chain identity — requires the seller to hold a
 * backend-custodied wallet, same restriction as erc8004.ts's
 * registerOnChain. If the seller is self-custody, marketplace.ts skips
 * this rather than failing the invoke.
 */
export async function requestValidation(
  sellerAccount: PrivateKeyAccount,
  sellerAgentId: string,
  validatorAddress: Address,
  requestURI: string,
  requestHash: `0x${string}`,
): Promise<{ txHash: string } | null> {
  if (!VALIDATION_REGISTRY_ADDRESS) return null; // feature disabled — see const docblock above
  try {
    const walletClient = createWalletClient({
      account: sellerAccount,
      chain: CHAIN,
      transport: http(rpcUrl()),
    });
    const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });

    const txHash = await walletClient.writeContract({
      address: VALIDATION_REGISTRY_ADDRESS,
      abi: VALIDATION_ABI,
      functionName: "validationRequest",
      args: [validatorAddress, BigInt(sellerAgentId), requestURI, requestHash],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return null;
    return { txHash };
  } catch {
    return null;
  }
}

/**
 * Push a neutral, verifiable event record onto the Reputation Registry
 * under the ACTING agent's own agentId — architecture-agent.md §3's
 * "every propose/accept/send/pay event gets a verifiable record, so
 * 'did agent A actually consent to this' is answerable on-chain, not
 * just in your sqlite log" line, and §7's send_file step 4 ("logs
 * {from, to, hash, timestamp} to the audit trail (erc8004Trust.ts)"),
 * generalized by next-phase.md's Phase 3g-i across every channel
 * lifecycle transition (propose/accept/reject/revoke) and every
 * cross-office action (send_file/request_file/join_project) — one
 * `erc8004Trust.ts` hook call per channelService.ts call site, not
 * just send_file's own.
 *
 * Deliberately reuses giveFeedback() rather than adding a second
 * on-chain write path — a channel event is, structurally, the same
 * shape of thing pushNegativeFeedback() already publishes: one
 * agentId, a fixed numeric value, two tags, a URI, and a hash. The
 * value/valueDecimals here are always 0 — this is an audit record of
 * an event having happened, never praise or blame, and must never be
 * mistaken for reputation feedback by anything reading the registry
 * later (pushNegativeFeedback's own -100 stays the only non-zero value
 * this file ever writes). Recorded under the ACTING agent's own
 * agentId (the caller of whichever channelService.ts function
 * triggered this — the proposer for propose_channel, the recipient for
 * accept/reject, either party for revoke, the sender for send_file,
 * the requester for request_file, either party for join_project) — a
 * public, independently-checkable "agent A did X" record, distinct
 * from pushNegativeFeedback's "agent B thinks agent A did badly."
 *
 * `detailHash` is the caller's own derivation (channelService.ts
 * computes it per event type — a real file-content hash for
 * send_file's own {from, to, hash, timestamp} contract, a hash of the
 * channel/request id + counterparty + scope for the other six) — this
 * function only ever publishes a hash handed to it, never derives one
 * itself, so it stays agnostic to what each of the seven call sites
 * actually needs hashed.
 *
 * Same best-effort contract as every other function in this file: the
 * caller is expected to skip calling this entirely when the acting
 * agent is self-custody or never registered an ERC-8004 identity (same
 * `if (!row?.encrypted_key || !row.erc8004_agent_id) return` guard
 * `marketplace.ts`'s own `mirrorFlagOnChain`/`maybeRequestValidation`
 * already use before ever reaching into this file) — and even once
 * called, any on-chain failure (no gas, RPC hiccup) is caught and
 * returns null here, never thrown, so the already-committed local
 * sqlite row this is auditing never depends on this call succeeding.
 */
export async function recordChannelEvent(
  actorAccount: PrivateKeyAccount,
  actorAgentId: string,
  eventType: string,
  eventURI: string,
  detailHash: `0x${string}`,
): Promise<{ txHash: string } | null> {
  try {
    const walletClient = createWalletClient({
      account: actorAccount,
      chain: CHAIN,
      transport: http(rpcUrl()),
    });
    const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });

    const txHash = await walletClient.writeContract({
      address: REPUTATION_REGISTRY_ADDRESS,
      abi: REPUTATION_ABI,
      functionName: "giveFeedback",
      args: [
        BigInt(actorAgentId),
        0n,
        0,
        tag("channel_event"),
        tag(`type:${eventType}`),
        eventURI,
        detailHash,
      ],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return null;
    return { txHash };
  } catch {
    // Best-effort — see this function's own doc comment above. Caller
    // logs/ignores, same as every other function in this file.
    return null;
  }
}

/**
 * Read-only status check — anyone can call this, no wallet needed.
 * Exposed via GET /marketplace/invocations/:id in marketplace.ts so a
 * buyer, seller, or third party can check whether a validator has
 * responded yet, independent of what this backend has cached.
 */
export async function getValidationStatus(
  requestHash: `0x${string}`,
): Promise<{ status: number; validator: Address; agentId: string } | null> {
  if (!VALIDATION_REGISTRY_ADDRESS) return null; // feature disabled — see const docblock above
  try {
    const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });
    const [status, validator, agentId] = await publicClient.readContract({
      address: VALIDATION_REGISTRY_ADDRESS,
      abi: VALIDATION_ABI,
      functionName: "getValidationStatus",
      args: [requestHash],
    });
    return { status, validator, agentId: agentId.toString() };
  } catch {
    return null;
  }
}

// Re-exported for callers that want to build an eip155:<chainId>:<address>
// style reference alongside the Identity Registry one already used in
// agentCard.ts.
export { IDENTITY_REGISTRY_ADDRESS };
