/**
 * ERC-8004 On-Chain Agent Registry
 *
 * This is the *public, on-chain* identity layer — separate from and
 * complementary to the `agents` table in db.ts, which is this VM
 * operator's own private lineage record (parent/child wallets, for your
 * fleet management only). Nothing here replaces that table; it just
 * optionally publishes a subset of it (address + a public agent card)
 * to a registry any agent, anywhere, can independently verify.
 *
 * Only wallets this backend custodies (created via /wallet/create) can
 * register through this module, since registering requires signing a
 * transaction and self-custody agents (/wallet/register) hold their own
 * key — they'd need to call the Identity Registry directly themselves.
 *
 * Contract addresses below are the canonical ERC-8004 deployments on
 * Base / Base Sepolia as of this writing (deployed via a deterministic
 * factory, so the address is the same across chains). Verify against
 * https://github.com/erc-8004/erc-8004-contracts before relying on this
 * in production — registries can be redeployed and this file will not
 * update itself.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  keccak256,
  toBytes,
  encodeFunctionData,
  type Address,
  type PrivateKeyAccount,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { config } from "./config.js";

const CHAIN = config.chainNetwork === "base" ? base : baseSepolia;

// Same address on both chains (CREATE2 deployment) — double-check this
// still holds for whatever chain you actually deploy to.
export const IDENTITY_REGISTRY_ADDRESS: Address =
  (process.env.ERC8004_IDENTITY_REGISTRY as Address) ||
  "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

const IDENTITY_ABI = parseAbi([
  "function register(string agentURI) external returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newAgentURI) external",
  "function tokenURI(uint256 tokenId) external view returns (string)",
  "function ownerOf(uint256 tokenId) external view returns (address)",
]);

const TRANSFER_EVENT_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));

function rpcUrl(): string | undefined {
  return process.env.ERC8004_RPC_URL || undefined;
}

export interface Erc8004Registration {
  agentId: string;
  txHash: string;
  chain: string; // eip155:<chainId>
  registryAddress: Address;
}

/**
 * Preflight: does this wallet even hold enough ETH for gas? Base gas is
 * cheap (usually well under $0.01) but zero is still not enough, and a
 * clear error here beats a wallet-drained-mid-call surprise.
 */
async function assertCanAffordGas(
  account: PrivateKeyAccount,
  agentURI: string,
): Promise<void> {
  const { balance, estimatedCost } = await estimateRegistrationGasCost(account, agentURI);
  if (balance < estimatedCost) {
    throw new Error(
      `insufficient_gas: wallet has ${balance} wei, needs ~${estimatedCost} wei on ${CHAIN.name}. ` +
        `Fund ${account.address} with a small amount of ETH before registering.`,
    );
  }
}

/**
 * Zent.md Phase 18a support function — split out of assertCanAffordGas()
 * so genesis.ts's automatic registration path can ask "how much would
 * this cost" (to decide a gas top-up amount) without duplicating the
 * same estimateGas/getGasPrice/getBalance calls, and without those two
 * functions silently drifting out of sync on what "enough" means.
 * Read-only — no transaction, no wallet write.
 */
export async function estimateRegistrationGasCost(
  account: PrivateKeyAccount,
  agentURI: string,
): Promise<{ balance: bigint; estimatedCost: bigint }> {
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });
  const data = encodeFunctionData({
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [agentURI],
  });
  const [gasEstimate, gasPrice, balance] = await Promise.all([
    publicClient
      .estimateGas({ account: account.address, to: IDENTITY_REGISTRY_ADDRESS, data })
      .catch(() => 200_000n),
    publicClient.getGasPrice().catch(() => 1_000_000_000n),
    publicClient.getBalance({ address: account.address }),
  ]);
  return { balance, estimatedCost: gasEstimate * gasPrice };
}

/**
 * Zent.md Phase 18a: Agent B is funded with USDC at birth
 * (genesis.ts's fundGenesisCompany(), Phase 16b) but never ETH — USDC
 * transfers are gas-sponsored x402/EIP-3009 signatures, not on-chain
 * ETH spends, so a freshly-born agent's own balance is exactly zero
 * wei. That is the same "clone starts at exactly zero balance" fact
 * wallet.ts's own /erc8004/register route header already documents as
 * the reason that route is opt-in, not auto-called, for an ordinary
 * spawn_clone birth. Automatic registration for a pipeline-spawned
 * agent hits the identical wall and would fail insufficient_gas on
 * every single genesis if nothing here addressed it — this function is
 * that address: a small, capped, one-time ETH top-up from the parent's
 * own wallet to the child's, sized to roughly cover registerOnChain()'s
 * own gas cost plus a safety margin, and never more than
 * config.genesisGasFundingWeiCap regardless of what the live estimate
 * says (a spend cap in the same spirit as every other genesis funding
 * cap in this codebase — Finance's runway floor, spawn_clone's
 * per-call/per-day caps — just denominated in wei instead of USDC).
 *
 * Best-effort, not a hard precondition: if the parent itself doesn't
 * hold enough ETH to cover the top-up, this returns
 * `{ funded: false, reason: 'parent_insufficient_eth' }` rather than
 * throwing — genesis.ts's caller treats that the same way it already
 * treats a failed registration attempt (recorded, non-fatal, Agent B
 * stays a real company either way). This never touches Agent B's USDC
 * balance or its Phase 16b funding cap; it is a wholly separate
 * transfer, in a wholly separate asset, sized only off gas cost.
 */
export async function fundGasForRegistration(
  parentAccount: PrivateKeyAccount,
  childAddress: Address,
  childAgentURI: string,
  capWei: bigint,
): Promise<
  | { funded: true; txHash: string; weiSent: bigint }
  | { funded: false; reason: "already_funded" | "parent_insufficient_eth"; weiSent: bigint }
> {
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });

  const [{ estimatedCost }, childBalance] = await Promise.all([
    estimateRegistrationGasCost(parentAccount, childAgentURI),
    publicClient.getBalance({ address: childAddress }),
  ]);

  // 2x safety margin over the point estimate (gas price can move
  // between this quote and the actual registerOnChain() call moments
  // later), capped at capWei either way.
  const target = estimatedCost * 2n > capWei ? capWei : estimatedCost * 2n;
  if (childBalance >= target) {
    return { funded: false, reason: "already_funded", weiSent: 0n as bigint };
  }
  const shortfall = target - childBalance;

  const parentBalance = await publicClient.getBalance({ address: parentAccount.address });
  // Parent also needs to cover its own send's gas, on top of the
  // amount it's forwarding.
  const sendGasEstimate = 21_000n * 1_000_000_000n; // flat ETH transfer, generous flat gas price guess
  if (parentBalance < shortfall + sendGasEstimate) {
    return { funded: false, reason: "parent_insufficient_eth", weiSent: 0n as bigint };
  }

  const walletClient = createWalletClient({ account: parentAccount, chain: CHAIN, transport: http(rpcUrl()) });
  const txHash = await walletClient.sendTransaction({ to: childAddress, value: shortfall });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`erc8004_gas_funding_reverted: tx ${txHash}`);
  }
  return { funded: true, txHash, weiSent: shortfall };
}

/**
 * `agentURI` should resolve to the agent registration file — see
 * GET /agents/:address/card.json in agentCard.ts.
 */
export async function registerOnChain(
  account: PrivateKeyAccount,
  agentURI: string,
): Promise<Erc8004Registration> {
  await assertCanAffordGas(account, agentURI);

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(rpcUrl()) });

  const txHash = await walletClient.writeContract({
    address: IDENTITY_REGISTRY_ADDRESS,
    abi: IDENTITY_ABI,
    functionName: "register",
    args: [agentURI],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`erc8004_register_reverted: tx ${txHash}`);
  }

  let agentId: string | null = null;
  for (const log of receipt.logs) {
    if (log.topics.length >= 4 && log.topics[0] === TRANSFER_EVENT_TOPIC) {
      agentId = BigInt(log.topics[3]!).toString();
      break;
    }
  }
  if (!agentId) {
    throw new Error(`erc8004_register_no_transfer_event: tx ${txHash}`);
  }

  return {
    agentId,
    txHash,
    chain: `eip155:${CHAIN.id}`,
    registryAddress: IDENTITY_REGISTRY_ADDRESS,
  };
}

/**
 * Live verification — reads the contract directly rather than trusting
 * the cached row in the agents table. This is the actual point of
 * "on-chain and publicly verifiable": anyone (this backend, another
 * agent, a third party) can call this independent of what we've cached.
 */
export async function verifyOnChain(
  agentId: string,
  expectedOwner: Address,
): Promise<{ verified: boolean; owner: Address; agentURI: string }> {
  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpcUrl()) });
  const [owner, agentURI] = await Promise.all([
    publicClient.readContract({
      address: IDENTITY_REGISTRY_ADDRESS,
      abi: IDENTITY_ABI,
      functionName: "ownerOf",
      args: [BigInt(agentId)],
    }),
    publicClient.readContract({
      address: IDENTITY_REGISTRY_ADDRESS,
      abi: IDENTITY_ABI,
      functionName: "tokenURI",
      args: [BigInt(agentId)],
    }),
  ]);
  return {
    verified: owner.toLowerCase() === expectedOwner.toLowerCase(),
    owner,
    agentURI,
  };
}
