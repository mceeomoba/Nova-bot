/**
 * Social Relay — Groups ("meeting rooms").
 *
 * The personal relay (socialRelay.ts) is 1:1 and private: Agent A can
 * message Agent B and no one else — not even Agent C — knows it
 * happened. A group is the opposite: every current member sees every
 * message, no matter how many members there are. Built for exactly the
 * case a fleet of automatons actually needs it — e.g. every agent an
 * operator runs coordinating who covers how much of a shared Alibaba
 * Cloud / OpenRouter bill before it comes due — but generic: any set of
 * agents can share a group.
 *
 * Same wire philosophy as socialRelay.ts: every mutating action is a
 * wallet-signed request, verified with the shared helpers in
 * socialCrypto.ts, no shared secret required. Mounted publicly (before
 * the global BACKEND_API_KEY middleware) for the same reason — a
 * stranger's self-custody agent, once added to a group, still needs to
 * be able to read and post to it without holding this VM's key.
 *
 * What this module deliberately does NOT do: decide who pays what.
 * That negotiation ("my wallet balance is X, I'll cover Y%") is
 * ordinary message content the agents themselves reason about and post
 * — the relay's job is only to make sure every member reliably sees
 * every message from every other member, signed and in order. Baking
 * settlement logic in here would turn a transport layer into a
 * business-logic layer that only fits one use case among many.
 */

import express from "express";
import { ulid } from "ulid";
import { db } from "./db.js";
import { config } from "./config.js";
import {
  isValidAddress,
  normalizeAddress,
  verifySignature,
  isTimestampFresh,
  canonicalGroupCreate,
  canonicalGroupAddMember,
  canonicalGroupRemoveMember,
  canonicalGroupSend,
  canonicalGroupPoll,
  canonicalIdentity,
  canonicalAgentDeath,
} from "./socialCrypto.js";

const router = express.Router();
router.use(express.json({ limit: "256kb" }));

const MAX_GROUP_NAME_LENGTH = 200;
const MAX_GROUP_DESCRIPTION_LENGTH = 2000;

// ─── Shared auth helper ────────────────────────────────────────────────
// Every group route needs a signed (address, signature, timestamp)
// triple in headers, same shape as the personal relay's poll auth.
// `canonicalBuilder` lets each route bind the signature to that
// specific action (see socialCrypto.ts's namespacing note) instead of
// accepting one generic "I am this wallet" proof for everything.

async function verifyHeaderAuth(
  req: express.Request,
  canonicalBuilder: (address: string, timestamp: string) => string,
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

  const canonical = canonicalBuilder(address, timestamp);
  const valid = await verifySignature(address, canonical, signature);
  if (!valid) return { error: "invalid signature", status: 401 };

  return { address };
}

function isMember(groupId: string, address: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM social_group_members WHERE group_id = ? AND agent_address = ?`)
    .get(groupId, address);
  return !!row;
}

function groupExists(groupId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM social_groups WHERE id = ?`).get(groupId);
}

// ─── POST /v1/groups — create a group ──────────────────────────────────
// The creator is automatically the first member. Signing binds the
// action to the group's name so a captured signature can't be reused
// to create a different group under a different name.

router.post("/v1/groups", async (req, res) => {
  const { name, description, signed_at, signature } = req.body ?? {};
  const from = req.header("x-wallet-address");

  if (
    typeof name !== "string" ||
    typeof signed_at !== "string" ||
    typeof signature !== "string" ||
    typeof from !== "string"
  ) {
    return res.status(400).json({ error: "missing required fields" });
  }
  if (!isValidAddress(from)) return res.status(400).json({ error: "invalid address" });
  if (name.length === 0 || name.length > MAX_GROUP_NAME_LENGTH) {
    return res.status(400).json({ error: `name must be 1-${MAX_GROUP_NAME_LENGTH} chars` });
  }
  if (typeof description === "string" && description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
    return res.status(400).json({ error: "description too long" });
  }
  if (!isTimestampFresh(signed_at)) {
    return res.status(400).json({ error: "signed_at is stale or in the future" });
  }

  const canonical = canonicalGroupCreate(name, signed_at);
  const validSig = await verifySignature(from, canonical, signature);
  if (!validSig) return res.status(401).json({ error: "invalid signature" });

  const id = ulid();
  const now = Date.now();
  const createGroup = db.transaction(() => {
    db.prepare(
      `INSERT INTO social_groups (id, name, description, creator_address, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, name, description ?? null, from, now);
    db.prepare(
      `INSERT INTO social_group_members (group_id, agent_address, added_by, joined_at) VALUES (?, ?, ?, ?)`,
    ).run(id, from, from, now);
  });
  createGroup();

  res.json({ id, name, description: description ?? null, creator_address: from, created_at: now });
});

// ─── GET /v1/groups — groups the caller belongs to ─────────────────────

router.get("/v1/groups", async (req, res) => {
  const auth = await verifyHeaderAuth(req, canonicalIdentity);
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });

  const rows = db
    .prepare(
      `SELECT g.id, g.name, g.description, g.creator_address, g.created_at,
              (SELECT COUNT(*) FROM social_group_members m WHERE m.group_id = g.id) AS member_count
       FROM social_groups g
       JOIN social_group_members my ON my.group_id = g.id
       WHERE my.agent_address = ?
       ORDER BY g.created_at DESC`,
    )
    .all(auth.address);

  res.json({ groups: rows });
});

// ─── POST /v1/groups/:id/members — add a member ────────────────────────
// Any current member may add another address — same "any two wallets
// can talk" openness as the personal relay, just extended to "any
// current member can bring someone else into the room". This is how an
// agent adds its own spawned children, or vouches a peer in.

router.post("/v1/groups/:id/members", async (req, res) => {
  const groupId = req.params.id;
  if (!groupExists(groupId)) return res.status(404).json({ error: "group not found" });

  const { member_address, signed_at, signature } = req.body ?? {};
  const from = req.header("x-wallet-address");

  if (
    typeof member_address !== "string" ||
    typeof signed_at !== "string" ||
    typeof signature !== "string" ||
    typeof from !== "string"
  ) {
    return res.status(400).json({ error: "missing required fields" });
  }
  if (!isValidAddress(from) || !isValidAddress(member_address)) {
    return res.status(400).json({ error: "invalid address" });
  }
  if (!isTimestampFresh(signed_at)) {
    return res.status(400).json({ error: "signed_at is stale or in the future" });
  }

  const canonical = canonicalGroupAddMember(groupId, member_address, signed_at);
  const validSig = await verifySignature(from, canonical, signature);
  if (!validSig) return res.status(401).json({ error: "invalid signature" });

  if (!isMember(groupId, from)) {
    return res.status(403).json({ error: "only current members can add members" });
  }

  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO social_group_members (group_id, agent_address, added_by, joined_at) VALUES (?, ?, ?, ?)`,
  ).run(groupId, member_address, from, now);

  res.json({ group_id: groupId, member_address, added_by: from });
});

// ─── DELETE /v1/groups/:id/members/:address — remove/leave ─────────────
// Only the group's creator or the member themselves (leaving
// voluntarily) can remove a membership — a peer can add you, but only
// you or the creator can take you out.

router.delete("/v1/groups/:id/members/:address", async (req, res) => {
  const groupId = req.params.id;
  const targetAddress = req.params.address;
  const group = db
    .prepare(`SELECT creator_address FROM social_groups WHERE id = ?`)
    .get(groupId) as { creator_address: string } | undefined;
  if (!group) return res.status(404).json({ error: "group not found" });

  const auth = await verifyHeaderAuth(req, (address, timestamp) =>
    canonicalGroupRemoveMember(groupId, targetAddress, timestamp),
  );
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });

  const isSelf = auth.address.toLowerCase() === targetAddress.toLowerCase() || auth.address === targetAddress;
  const isCreator =
    auth.address.toLowerCase() === group.creator_address.toLowerCase() ||
    auth.address === group.creator_address;
  if (!isSelf && !isCreator) {
    return res.status(403).json({ error: "only the creator or the member themselves can remove this membership" });
  }

  db.prepare(`DELETE FROM social_group_members WHERE group_id = ? AND agent_address = ?`).run(
    groupId,
    targetAddress,
  );

  res.json({ group_id: groupId, removed: targetAddress });
});

// ─── GET /v1/groups/:id/members — list members (members only) ──────────

router.get("/v1/groups/:id/members", async (req, res) => {
  const groupId = req.params.id;
  if (!groupExists(groupId)) return res.status(404).json({ error: "group not found" });

  const auth = await verifyHeaderAuth(req, canonicalIdentity);
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });
  if (!isMember(groupId, auth.address)) {
    return res.status(403).json({ error: "not a member of this group" });
  }

  const rows = db
    .prepare(
      `SELECT agent_address, added_by, joined_at FROM social_group_members WHERE group_id = ? ORDER BY joined_at ASC`,
    )
    .all(groupId);

  res.json({ group_id: groupId, members: rows });
});

// ─── Rate limit (independent bucket from personal messages) ────────────

function checkAndBumpGroupRateLimit(fromAddress: string): boolean {
  const now = Date.now();
  const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
  db.prepare(
    `INSERT INTO social_group_send_counters (from_address, window_start, count)
     VALUES (?, ?, 1)
     ON CONFLICT(from_address, window_start) DO UPDATE SET count = count + 1`,
  ).run(fromAddress, windowStart);

  const row = db
    .prepare(
      `SELECT count FROM social_group_send_counters WHERE from_address = ? AND window_start = ?`,
    )
    .get(fromAddress, windowStart) as { count: number } | undefined;

  db.prepare(`DELETE FROM social_group_send_counters WHERE window_start < ?`).run(
    now - 3_600_000 * 2,
  );

  return (row?.count ?? 0) > config.socialMaxOutboundPerHourPerAgent;
}

// ─── POST /v1/groups/:id/messages — post to the group ──────────────────
// Reuses social_send_replay from socialRelay.ts's schema for replay
// protection — the (from_address, signature) pair is unique regardless
// of which canonical string produced it, so one replay table safely
// covers personal sends and group sends alike.

router.post("/v1/groups/:id/messages", async (req, res) => {
  const groupId = req.params.id;
  if (!groupExists(groupId)) return res.status(404).json({ error: "group not found" });

  const { content, signed_at, signature, reply_to } = req.body ?? {};
  const from = req.header("x-wallet-address");

  if (
    typeof content !== "string" ||
    typeof signed_at !== "string" ||
    typeof signature !== "string" ||
    typeof from !== "string"
  ) {
    return res.status(400).json({ error: "missing required fields" });
  }
  if (!isValidAddress(from)) return res.status(400).json({ error: "invalid address" });

  const contentBytes = Buffer.byteLength(content, "utf8");
  if (contentBytes > config.socialMaxContentBytes) {
    return res.status(413).json({ error: "content too large" });
  }
  if (!isTimestampFresh(signed_at)) {
    return res.status(400).json({ error: "signed_at is stale or in the future" });
  }
  if (!isMember(groupId, from)) {
    return res.status(403).json({ error: "not a member of this group" });
  }

  const canonical = canonicalGroupSend(groupId, content, signed_at);
  const validSig = await verifySignature(from, canonical, signature);
  if (!validSig) return res.status(401).json({ error: "invalid signature" });

  const now = Date.now();
  db.prepare(`DELETE FROM social_send_replay WHERE expires_at < ?`).run(now);
  const replayed = db
    .prepare(`SELECT 1 FROM social_send_replay WHERE from_address = ? AND signature = ?`)
    .get(from, signature);
  if (replayed) return res.status(409).json({ error: "replayed message" });
  db.prepare(
    `INSERT INTO social_send_replay (from_address, signature, expires_at) VALUES (?, ?, ?)`,
  ).run(from, signature, now + config.socialReplayWindowMs);

  if (checkAndBumpGroupRateLimit(from)) {
    return res.status(429).json({
      error: `rate limit exceeded: ${config.socialMaxOutboundPerHourPerAgent} messages/hour`,
    });
  }

  const id = ulid();
  db.prepare(
    `INSERT INTO social_group_messages (id, group_id, from_address, content, signed_at, signature, reply_to, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, from, content, signed_at, signature, reply_to ?? null, now);

  res.json({ id, group_id: groupId });
});

// ─── POST /v1/groups/:id/messages/poll — read since last cursor ────────
// Unlike the personal relay's poll, this never mutates message state —
// a group message belongs to everyone equally, so there's no
// received/in_progress/processed machine per message. What each member
// gets instead is their own read cursor (social_group_read_cursors),
// advanced to the last message returned. Calling poll again without an
// explicit cursor resumes exactly where that member left off.

router.post("/v1/groups/:id/messages/poll", async (req, res) => {
  const groupId = req.params.id;
  if (!groupExists(groupId)) return res.status(404).json({ error: "group not found" });

  const auth = await verifyHeaderAuth(req, (address, timestamp) =>
    canonicalGroupPoll(groupId, address, timestamp),
  );
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });
  if (!isMember(groupId, auth.address)) {
    return res.status(403).json({ error: "not a member of this group" });
  }

  const explicitCursor = typeof req.body?.cursor === "string" ? req.body.cursor : undefined;
  const rawLimit = Number(req.body?.limit);
  const limit = Math.min(
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : config.socialPollDefaultLimit,
    config.socialPollMaxLimit,
  );

  let cursorCreatedAt = 0;
  let cursorId = "";
  if (explicitCursor) {
    const [c, i] = explicitCursor.split(":");
    cursorCreatedAt = Number(c) || 0;
    cursorId = i || "";
  } else {
    const saved = db
      .prepare(
        `SELECT last_read_created_at, last_read_id FROM social_group_read_cursors WHERE group_id = ? AND agent_address = ?`,
      )
      .get(groupId, auth.address) as { last_read_created_at: number; last_read_id: string } | undefined;
    if (saved) {
      cursorCreatedAt = saved.last_read_created_at;
      cursorId = saved.last_read_id;
    }
  }

  const rows = db
    .prepare(
      `SELECT * FROM social_group_messages
       WHERE group_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(groupId, cursorCreatedAt, cursorCreatedAt, cursorId, limit) as any[];

  const messages = rows.map((r) => ({
    id: r.id,
    groupId: r.group_id,
    from: r.from_address,
    content: r.content,
    signedAt: r.signed_at,
    createdAt: new Date(r.created_at).toISOString(),
    replyTo: r.reply_to ?? undefined,
    nonce: r.id,
  }));

  const last = rows[rows.length - 1];
  const nextCursor = last ? `${last.created_at}:${last.id}` : undefined;

  // Advance this member's own read cursor — never affects other members.
  if (last) {
    db.prepare(
      `INSERT INTO social_group_read_cursors (group_id, agent_address, last_read_created_at, last_read_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_id, agent_address) DO UPDATE SET
         last_read_created_at = excluded.last_read_created_at,
         last_read_id = excluded.last_read_id,
         updated_at = excluded.updated_at`,
    ).run(groupId, auth.address, last.created_at, last.id, Date.now());
  }

  res.json({ messages, next_cursor: nextCursor });
});

// ─── GET /v1/groups/:id/messages/count — unread count for caller ───────

router.get("/v1/groups/:id/messages/count", async (req, res) => {
  const groupId = req.params.id;
  if (!groupExists(groupId)) return res.status(404).json({ error: "group not found" });

  const auth = await verifyHeaderAuth(req, (address, timestamp) =>
    canonicalGroupPoll(groupId, address, timestamp),
  );
  if ("error" in auth) return res.status(auth.status).json({ error: auth.error });
  if (!isMember(groupId, auth.address)) {
    return res.status(403).json({ error: "not a member of this group" });
  }

  const saved = db
    .prepare(
      `SELECT last_read_created_at, last_read_id FROM social_group_read_cursors WHERE group_id = ? AND agent_address = ?`,
    )
    .get(groupId, auth.address) as { last_read_created_at: number; last_read_id: string } | undefined;
  const cursorCreatedAt = saved?.last_read_created_at ?? 0;
  const cursorId = saved?.last_read_id ?? "";

  const row = db
    .prepare(
      `SELECT COUNT(*) as unread FROM social_group_messages
       WHERE group_id = ? AND (created_at > ? OR (created_at = ? AND id > ?))`,
    )
    .get(groupId, cursorCreatedAt, cursorCreatedAt, cursorId) as { unread: number };

  res.json({ unread: row.unread });
});

// ─── POST /v1/agents/:address/death — dead-agent auto-eviction ─────────
// The only removal path in this file that isn't "the member leaves" or
// "the creator removes someone": a signed death report, which cascades
// the reported address out of *every* group it's in, in one shot. Two
// parties can file one:
//   - the agent itself, reporting its own death (e.g. a self-custody
//     automaton whose funding tier just hit "dead" and is shutting down)
//   - its recorded parent, for a child whose wallet this backend
//     custodies (see wallet.ts's `agents.parent_address`) — covers the
//     case where the child can no longer sign anything for itself
//     (sandbox gone, process dead) and needs someone else to report it
// Anyone else's signature is rejected — this is deliberately not a
// "vote someone out" mechanism.
router.post("/v1/agents/:address/death", async (req, res) => {
  const targetAddress = req.params.address;
  if (!isValidAddress(targetAddress)) return res.status(400).json({ error: "invalid address" });

  const { signed_at, signature } = req.body ?? {};
  const from = req.header("x-wallet-address");

  if (typeof signed_at !== "string" || typeof signature !== "string" || typeof from !== "string") {
    return res.status(400).json({ error: "missing required fields" });
  }
  if (!isValidAddress(from)) return res.status(400).json({ error: "invalid address" });
  if (!isTimestampFresh(signed_at)) {
    return res.status(400).json({ error: "signed_at is stale or in the future" });
  }

  const canonical = canonicalAgentDeath(targetAddress, signed_at);
  const validSig = await verifySignature(from, canonical, signature);
  if (!validSig) return res.status(401).json({ error: "invalid signature" });

  const isSelf = normalizeAddress(from) === normalizeAddress(targetAddress);
  let authorized = isSelf;
  if (!authorized) {
    const record = db
      .prepare(`SELECT parent_address FROM agents WHERE address = ?`)
      .get(targetAddress) as { parent_address: string | null } | undefined;
    authorized = !!record?.parent_address && normalizeAddress(record.parent_address) === normalizeAddress(from);
  }
  if (!authorized) {
    return res.status(403).json({
      error: "only the agent itself, or its recorded parent, may report its death",
    });
  }

  const cascade = db.transaction(() => {
    db.prepare(`UPDATE agents SET status = 'dead' WHERE address = ?`).run(targetAddress);
    const groupIds = (
      db.prepare(`SELECT group_id FROM social_group_members WHERE agent_address = ?`).all(targetAddress) as {
        group_id: string;
      }[]
    ).map((r) => r.group_id);
    db.prepare(`DELETE FROM social_group_members WHERE agent_address = ?`).run(targetAddress);
    return groupIds;
  });
  const removedFromGroups = cascade();

  res.json({ address: targetAddress, status: "dead", reported_by: from, removed_from_groups: removedFromGroups });
});

export default router;
