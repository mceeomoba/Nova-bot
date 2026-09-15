/**
 * Social Relay — this backend's own private replacement for Conway's
 * hosted social.conway.tech.
 *
 * What Conway's relay actually is: agent-to-agent messaging, addressed
 * purely by wallet (never a username), signed with the sender's own
 * key so nobody can forge a message as someone else. Agent A -> signed
 * message -> relay -> Agent B, who polls for new mail on its own
 * heartbeat rather than receiving a push. That's the whole protocol,
 * and it's already fully implemented client-side in
 * agent/src/social/{client,signing,protocol,validation}.ts — this file
 * is the missing other half: the server those clients actually talk to.
 *
 * Wire-compatible on purpose. The canonical signed strings below
 * (`Automaton:send:...`, `Automaton:poll:...`) and the SignedMessagePayload
 * shape are copied byte-for-byte from agent/src/social/signing.ts — an
 * existing automaton only has to change its `socialRelayUrl` config to
 * point at this backend instead of Conway's. No agent-side code changes,
 * no new dependency for the agent runtime.
 *
 * Mounted BEFORE the shared-secret auth middleware in index.ts, same
 * treatment as agentCard.ts/marketplace.ts/portProxy.ts — the entire
 * point of a relay is that Agent B (who may not hold this VM's
 * BACKEND_API_KEY, if it's a stranger's self-custody agent) can still
 * receive mail addressed to its wallet. Authorization here is each
 * request's own wallet signature, not a shared secret.
 *
 * Reputation and on-chain identity are deliberately NOT part of this
 * file: those already exist as their own systems (ERC-8004 Identity/
 * Reputation Registries, see erc8004.ts + erc8004Trust.ts, and the
 * agent-side check_reputation/register_erc8004 tools). Re-implementing
 * a second reputation system here would just create two sources of
 * truth for the same thing — this module is messaging transport only.
 */

import express from "express";
import crypto from "crypto";
import { ulid } from "ulid";
import { verifyMessage as verifyEvmMessage, keccak256, toBytes } from "viem";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { db } from "./db.js";
import { config } from "./config.js";

const router = express.Router();
router.use(express.json({ limit: "256kb" })); // generous over socialMaxTotalBytes; real cap enforced below

// ─── Address helpers (mirrors agent/src/identity/chain.ts) ───────────

function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidSolanaAddress(address: string): boolean {
  try {
    return bs58.decode(address).length === 32;
  } catch {
    return false;
  }
}

type ChainType = "evm" | "solana";

function detectChainType(address: string): ChainType | null {
  if (isValidEvmAddress(address)) return "evm";
  if (isValidSolanaAddress(address)) return "solana";
  return null;
}

function isValidAddress(address: string): boolean {
  return isValidEvmAddress(address) || isValidSolanaAddress(address);
}

// ─── Signature verification (mirrors agent/src/social/{signing,protocol}.ts) ──

/** Verify an EVM (secp256k1, personal_sign) or Solana (Ed25519) signature over `canonical`. */
async function verifySignature(
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
    // Solana: signature and public key are both base58-encoded, per
    // SolanaChainIdentity.signMessage in agent/src/identity/chain.ts.
    const messageBytes = new TextEncoder().encode(canonical);
    const signatureBytes = bs58.decode(signature);
    const publicKeyBytes = bs58.decode(address);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

function canonicalSend(to: string, content: string, signedAt: string): string {
  const contentHash = keccak256(toBytes(content));
  const recipientChain = detectChainType(to);
  const normalizedTo = recipientChain === "solana" ? to : to.toLowerCase();
  return `Automaton:send:${normalizedTo}:${contentHash}:${signedAt}`;
}

function canonicalPoll(address: string, timestamp: string): string {
  return `Automaton:poll:${address}:${timestamp}`;
}

/** ISO timestamp freshness check — same replay window as the client's own validateMessage(). */
function isTimestampFresh(iso: string): boolean {
  const parsed = new Date(iso).getTime();
  if (Number.isNaN(parsed)) return false;
  const age = Date.now() - parsed;
  return age <= config.socialReplayWindowMs && age >= -60_000; // allow 60s clock skew forward
}

// ─── Replay + rate-limit bookkeeping ──────────────────────────────────

function checkAndBurnSendReplay(fromAddress: string, signature: string): boolean {
  // Returns true if this (from, signature) pair has already been used.
  const now = Date.now();
  db.prepare(`DELETE FROM social_send_replay WHERE expires_at < ?`).run(now);

  const existing = db
    .prepare(`SELECT 1 FROM social_send_replay WHERE from_address = ? AND signature = ?`)
    .get(fromAddress, signature);
  if (existing) return true;

  db.prepare(
    `INSERT INTO social_send_replay (from_address, signature, expires_at) VALUES (?, ?, ?)`,
  ).run(fromAddress, signature, now + config.socialReplayWindowMs);
  return false;
}

function checkAndBumpRateLimit(fromAddress: string): boolean {
  // Returns true if the sender is OVER the rate limit (request should be rejected).
  const now = Date.now();
  const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
  db.prepare(
    `INSERT INTO social_send_counters (from_address, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(from_address, window_start) DO UPDATE SET count = count + 1`,
  ).run(fromAddress, windowStart);

  const row = db
    .prepare(`SELECT count FROM social_send_counters WHERE from_address = ? AND window_start = ?`)
    .get(fromAddress, windowStart) as { count: number } | undefined;

  // Best-effort cleanup of old windows (keep the table small).
  db.prepare(`DELETE FROM social_send_counters WHERE window_start < ?`).run(
    now - 3_600_000 * 2,
  );

  return (row?.count ?? 0) > config.socialMaxOutboundPerHourPerAgent;
}

// ─── POST /v1/messages — send ─────────────────────────────────────────

interface SendBody {
  from: string;
  to: string;
  content: string;
  signed_at: string;
  signature: string;
  reply_to?: string;
}

router.post("/v1/messages", async (req, res) => {
  const body = req.body as Partial<SendBody> | undefined;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "invalid body" });
  }
  const { from, to, content, signed_at, signature, reply_to } = body;

  if (
    typeof from !== "string" ||
    typeof to !== "string" ||
    typeof content !== "string" ||
    typeof signed_at !== "string" ||
    typeof signature !== "string"
  ) {
    return res.status(400).json({ error: "missing required fields" });
  }

  if (!isValidAddress(from) || !isValidAddress(to)) {
    return res.status(400).json({ error: "invalid address" });
  }

  // Size limits — same numbers as MESSAGE_LIMITS in agent/src/social/signing.ts.
  const contentBytes = Buffer.byteLength(content, "utf8");
  const totalBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  if (contentBytes > config.socialMaxContentBytes) {
    return res.status(413).json({ error: "content too large" });
  }
  if (totalBytes > config.socialMaxTotalBytes) {
    return res.status(413).json({ error: "message too large" });
  }

  if (!isTimestampFresh(signed_at)) {
    return res.status(400).json({ error: "signed_at is stale or in the future" });
  }

  const canonical = canonicalSend(to, content, signed_at);
  const validSig = await verifySignature(from, canonical, signature);
  if (!validSig) {
    return res.status(401).json({ error: "invalid signature" });
  }

  // Replay guard: same (from, signature) can't be POSTed twice.
  if (checkAndBurnSendReplay(from, signature)) {
    return res.status(409).json({ error: "replayed message" });
  }

  // Server-side rate limit, independent of whatever the client claims to enforce.
  if (checkAndBumpRateLimit(from)) {
    return res.status(429).json({
      error: `rate limit exceeded: ${config.socialMaxOutboundPerHourPerAgent} messages/hour`,
    });
  }

  const id = ulid();
  const now = Date.now();
  db.prepare(
    `INSERT INTO social_messages
      (id, from_address, to_address, content, signed_at, signature, reply_to, status, retry_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 0, ?)`,
  ).run(id, from, to, content, signed_at, signature, reply_to ?? null, now);

  res.json({ id });
});

// ─── Poll auth (shared by /v1/messages/poll and /v1/messages/count) ──

async function verifyPollAuth(
  req: express.Request,
): Promise<{ address: string } | { error: string; status: number }> {
  const address = req.header("x-wallet-address");
  const signature = req.header("x-signature");
  const timestamp = req.header("x-timestamp");

  if (!address || !signature || !timestamp) {
    return { error: "missing auth headers", status: 401 };
  }
  if (!isValidAddress(address)) {
    return { error: "invalid address", status: 400 };
  }
  if (!isTimestampFresh(timestamp)) {
    return { error: "timestamp is stale or in the future", status: 401 };
  }

  const canonical = canonicalPoll(address, timestamp);
  const valid = await verifySignature(address, canonical, signature);
  if (!valid) {
    return { error: "invalid signature", status: 401 };
  }

  return { address };
}

// ─── POST /v1/messages/poll ────────────────────────────────────────────

router.post("/v1/messages/poll", async (req, res) => {
  const auth = await verifyPollAuth(req);
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });

  const cursor = typeof req.body?.cursor === "string" ? req.body.cursor : undefined;
  const rawLimit = Number(req.body?.limit);
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : config.socialPollDefaultLimit,
    config.socialPollMaxLimit,
  );

  // Reclaim messages stuck 'in_progress' past the claim timeout (crashed
  // client that polled but never came back), bumping retry_count. Once
  // retry_count exceeds the configured max, mark them 'failed' instead
  // of handing them out forever.
  const now = Date.now();
  const claimCutoff = now - config.socialClaimTimeoutMs;
  db.prepare(
    `UPDATE social_messages
       SET status = 'failed'
     WHERE status = 'in_progress' AND claimed_at < ? AND retry_count >= ?`,
  ).run(claimCutoff, config.socialMaxDeliveryRetries);
  db.prepare(
    `UPDATE social_messages
       SET status = 'received', retry_count = retry_count + 1
     WHERE status = 'in_progress' AND claimed_at < ? AND retry_count < ?`,
  ).run(claimCutoff, config.socialMaxDeliveryRetries);

  // Cursor is `${created_at}:${id}` — keyset pagination, stable under concurrent inserts.
  let cursorCreatedAt = 0;
  let cursorId = "";
  if (cursor) {
    const [c, i] = cursor.split(":");
    cursorCreatedAt = Number(c) || 0;
    cursorId = i || "";
  }

  const rows = db
    .prepare(
      `SELECT * FROM social_messages
       WHERE to_address = ? AND status = 'received'
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(auth.address, cursorCreatedAt, cursorCreatedAt, cursorId, limit) as any[];

  // Claim what we're about to hand back: received -> in_progress. A
  // client that never acks these will have them reclaimed above on a
  // future poll, up to socialMaxDeliveryRetries.
  if (rows.length > 0) {
    const claimAt = Date.now();
    const claimMany = db.transaction((ids: string[]) => {
      const stmt = db.prepare(
        `UPDATE social_messages SET status = 'in_progress', claimed_at = ? WHERE id = ?`,
      );
      for (const id of ids) stmt.run(claimAt, id);
    });
    claimMany(rows.map((r) => r.id));
  }

  const messages = rows.map((r) => ({
    id: r.id,
    from: r.from_address,
    to: r.to_address,
    content: r.content,
    signedAt: r.signed_at,
    createdAt: new Date(r.created_at).toISOString(),
    replyTo: r.reply_to ?? undefined,
    // The agent client's checkReplayNonce() dedupes inbound messages on
    // this field — the message id is already globally unique (ULID), so
    // it doubles perfectly as that per-message replay key.
    nonce: r.id,
  }));

  const last = rows[rows.length - 1];
  const nextCursor = last ? `${last.created_at}:${last.id}` : undefined;

  res.json({ messages, next_cursor: nextCursor });
});

// ─── GET /v1/messages/count ─────────────────────────────────────────────

router.get("/v1/messages/count", async (req, res) => {
  const auth = await verifyPollAuth(req);
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });

  const row = db
    .prepare(
      `SELECT COUNT(*) as unread FROM social_messages WHERE to_address = ? AND status = 'received'`,
    )
    .get(auth.address) as { unread: number };

  res.json({ unread: row.unread });
});

// ─── POST /v1/messages/:id/ack — explicit processed/failed transition ─
//
// Extension beyond the minimum Conway wire protocol (the stock agent
// client doesn't call this yet — polling alone still works exactly as
// before). Lets a client that DOES want the full received -> in_progress
// -> processed|failed state machine close the loop explicitly instead of
// relying on the claim-timeout reclaim logic in /poll. Auth is the same
// poll signature (a recipient acking their own inbox), scoped to
// messages actually addressed to that wallet.

router.post("/v1/messages/:id/ack", async (req, res) => {
  const auth = await verifyPollAuth(req);
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });

  const outcome = req.body?.outcome === "failed" ? "failed" : "processed";
  const messageId = req.params.id;

  const row = db
    .prepare(`SELECT to_address, status FROM social_messages WHERE id = ?`)
    .get(messageId) as { to_address: string; status: string } | undefined;

  if (!row) return res.status(404).json({ error: "message not found" });
  if (row.to_address.toLowerCase() !== auth.address.toLowerCase() && row.to_address !== auth.address) {
    return res.status(403).json({ error: "not your message" });
  }
  if (row.status === "processed" || row.status === "failed") {
    return res.json({ id: messageId, status: row.status }); // already terminal, idempotent
  }

  db.prepare(`UPDATE social_messages SET status = ?, processed_at = ? WHERE id = ?`).run(
    outcome,
    Date.now(),
    messageId,
  );

  res.json({ id: messageId, status: outcome });
});

// ─── GET /v1/messages/:id/status — inspect delivery state ──────────────

router.get("/v1/messages/:id/status", async (req, res) => {
  const auth = await verifyPollAuth(req);
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });

  const row = db
    .prepare(
      `SELECT id, to_address, status, retry_count, created_at, claimed_at, processed_at
       FROM social_messages WHERE id = ?`,
    )
    .get(req.params.id) as {
      id: string;
      to_address: string;
      status: string;
      retry_count: number;
      created_at: number;
      claimed_at: number | null;
      processed_at: number | null;
    } | undefined;
  if (!row) return res.status(404).json({ error: "message not found" });
  if (row.to_address.toLowerCase() !== auth.address.toLowerCase() && row.to_address !== auth.address) {
    return res.status(403).json({ error: "not your message" });
  }
  res.json({
    id: row.id,
    status: row.status,
    retry_count: row.retry_count,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    processed_at: row.processed_at,
  });
});

// ─── Background sweep: prune old terminal messages ─────────────────────
//
// Only 'processed' and 'failed' rows age out — 'received'/'in_progress'
// are never pruned by time alone, only after reaching a terminal state
// (see the claim-timeout reclaim logic in /poll above).
function pruneOldMessages(): void {
  const cutoff = Date.now() - config.socialMessageRetentionMs;
  try {
    db.prepare(
      `DELETE FROM social_messages
       WHERE status IN ('processed', 'failed') AND created_at < ?`,
    ).run(cutoff);
  } catch (err) {
    console.error("social relay: prune sweep failed:", err);
  }
}
setInterval(pruneOldMessages, 60 * 60 * 1000).unref(); // hourly

export default router;
