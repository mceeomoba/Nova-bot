/**
 * Shared crypto/address helpers for the Social Relay — used by both
 * socialRelay.ts (personal agent-to-agent messaging) and
 * socialGroups.ts (group/broadcast messaging). Kept in one place so the
 * two never drift on what counts as a valid signature.
 *
 * Mirrors agent/src/identity/chain.ts and agent/src/social/signing.ts
 * exactly — canonical strings here must stay byte-for-byte identical to
 * whatever the agent-side signer builds, or every signature check fails.
 */

import { verifyMessage as verifyEvmMessage, keccak256, toBytes } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { config } from "./config.js";

export type ChainType = "evm" | "solana";

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}

export function detectChainType(address: string): ChainType | null {
  if (isValidEvmAddress(address)) return "evm";
  if (isValidSolanaAddress(address)) return "solana";
  return null;
}

export function isValidAddress(address: string): boolean {
  return isValidEvmAddress(address) || isValidSolanaAddress(address);
}

export function normalizeAddress(address: string): string {
  return detectChainType(address) === "solana" ? address : address.toLowerCase();
}

/** Verify an EVM (secp256k1, personal_sign) or Solana (Ed25519) signature over `canonical`. */
export async function verifySignature(
  address: string,
  canonical: string,
  signature: string,
): Promise<boolean> {
  const chainType = detectChainType(address);
  if (!chainType) return false;

  try {
    if (chainType === "evm") {
      return await verifyEvmMessage({
        address: address as `0x${string}`,
        message: canonical,
        signature: signature as `0x${string}`,
      });
    }
    const messageBytes = new TextEncoder().encode(canonical);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(address);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

export function contentHash(content: string): string {
  return keccak256(toBytes(content));
}

/** ISO timestamp freshness check — same replay window as the agent client's own validateMessage(). */
export function isTimestampFresh(iso: string): boolean {
  const parsed = new Date(iso).getTime();
  if (Number.isNaN(parsed)) return false;
  const age = Date.now() - parsed;
  return age <= config.socialReplayWindowMs && age >= -60_000; // allow 60s clock skew forward
}

// ─── Canonical signed strings ──────────────────────────────────────────
// Every action a wallet takes against the relay signs a distinct,
// clearly-namespaced canonical string. Namespacing (the "Automaton:x:y:"
// prefix) matters as much as the signature itself: it's what stops a
// signature collected for one purpose (e.g. polling your personal
// inbox) from being replayable as authorization for a different one
// (e.g. posting to a group) — each signed string only ever means one
// specific thing.

export function canonicalSend(to: string, content: string, signedAt: string): string {
  return `Automaton:send:${normalizeAddress(to)}:${contentHash(content)}:${signedAt}`;
}

export function canonicalPoll(address: string, timestamp: string): string {
  return `Automaton:poll:${address}:${timestamp}`;
}

export function canonicalGroupCreate(name: string, signedAt: string): string {
  return `Automaton:group:create:${contentHash(name)}:${signedAt}`;
}

export function canonicalGroupAddMember(
  groupId: string,
  memberAddress: string,
  signedAt: string,
): string {
  return `Automaton:group:add_member:${groupId}:${normalizeAddress(memberAddress)}:${signedAt}`;
}

export function canonicalGroupRemoveMember(
  groupId: string,
  memberAddress: string,
  signedAt: string,
): string {
  return `Automaton:group:remove_member:${groupId}:${normalizeAddress(memberAddress)}:${signedAt}`;
}

export function canonicalGroupSend(groupId: string, content: string, signedAt: string): string {
  return `Automaton:group:send:${groupId}:${contentHash(content)}:${signedAt}`;
}

export function canonicalGroupPoll(
  groupId: string,
  address: string,
  timestamp: string,
): string {
  return `Automaton:group:poll:${groupId}:${address}:${timestamp}`;
}

// Auth for endpoints that aren't scoped to one group (list my groups,
// list a group's members) — same shape as personal poll auth.
export function canonicalIdentity(address: string, timestamp: string): string {
  return `Automaton:identity:${address}:${timestamp}`;
}

// Death report — an agent declaring its own death, or a recorded parent
// declaring a spawned child's death (see the authorization check in
// POST /v1/agents/:address/death in socialGroups.ts). Namespaced apart
// from every other action so a captured signature can't be replayed as
// authorization for anything else, same as every other canonical* here.
export function canonicalAgentDeath(agentAddress: string, signedAt: string): string {
  return `Automaton:agent:death:${normalizeAddress(agentAddress)}:${signedAt}`;
}
