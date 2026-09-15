/**
 * channelService.ts — next-phase.md Phase 3a (architecture-agent.md §3:
 * "Business channels — the only way offices talk").
 *
 * Everything through Phase 2i is one agent's own internal org chart:
 * departments, workers, tool grants, all resolved by ownerOf()/
 * isSubagentOf() in capability.ts against a single owning agent address.
 * Nothing before Phase 3 lets two *different* top-level agents (two
 * distinct rows in the `agents` table — including two of this backend's
 * own hosted agents, e.g. a founder and one of its spawn_clone children)
 * interact at all. A channel is the one, deliberately narrow, mechanism
 * that changes that.
 *
 * Default posture is default-deny: Agent A's office is invisible to
 * Agent B until a channel between them exists and is `active`. Opening
 * one is a two-sided handshake (§3, point 1-2) — never a silent
 * auto-accept, which would just rebuild "any process can write to any
 * other process's memory" under a different name.
 *
 * This sub-phase (3a) only built the *creation* half of the state
 * machine: a channel can be proposed, and independently reach `active`
 * (accepted) or `rejected`. `revoke_channel` (the teardown half) is
 * 3b's addition; 3c wires `checkCapability`'s channel-grant step to a
 * real query against this table; 3d (`sendFile` below) is the first
 * real caller of that mechanism.
 */

import express from "express";
import crypto from "crypto";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { db } from "./db.js";
import { checkCapability } from "./capability.js";
import { ensureOffice, safeOutboxPath, safeInboxPath, jointProjectDir, officeInboxDir } from "./office.js";
import { getOrCreateDefaultSandbox } from "./vmService.js";
import { mountJointDirIntoSandbox, unmountJointDirFromSandbox } from "./docker.js";
import { getAgentAccount } from "./wallet.js";
import { recordChannelEvent } from "./erc8004Trust.js";

const router = express.Router();

function newChannelId(): string {
  return "chn_" + crypto.randomBytes(5).toString("hex");
}

// §3's own three scopes. Fixed at proposal time — see db.ts's column
// comment for why this is never editable via UPDATE later.
const VALID_SCOPES = new Set(["file_transfer", "joint_project", "payment"]);

export interface ChannelRow {
  id: string;
  proposer_address: string;
  recipient_address: string;
  scope: string;
  status: "proposed" | "active" | "rejected" | "revoked";
  note: string | null;
  proposed_at: number;
  resolved_at: number | null;
  created_at: number;
}

/**
 * Shared by both accept_channel and reject_channel (and, in 3b,
 * revoke_channel) — every one of them needs the same "does this channel
 * exist at all" lookup before it can decide who's allowed to act on it.
 * Kept here rather than inlined three times, same "one shared lookup,
 * not three independently-drifting copies" discipline getOwnedDepartment()
 * already established in departments.ts.
 */
function getChannel(id: string): ChannelRow {
  const row = db.prepare(`SELECT * FROM channels WHERE id = ?`).get(id) as ChannelRow | undefined;
  if (!row) {
    throw Object.assign(new Error(`channel not found: ${id}`), { status: 404 });
  }
  return row;
}

/**
 * Confirms `address` is a real, known agent (a row in `agents`) —
 * proposing or resolving a channel against an address nobody's wallet
 * ever occupied is never meaningful. Returns nothing; throws 404 on
 * miss, same notFound-vs-403 split checkCapability()'s own ownerOf()
 * already uses elsewhere in this codebase.
 */
function assertKnownAgent(address: string, label: string): void {
  const row = db.prepare(`SELECT address FROM agents WHERE address = ?`).get(address) as
    | { address: string }
    | undefined;
  if (!row) {
    throw Object.assign(new Error(`${label} is not a known agent: ${address}`), { status: 404 });
  }
}

// The seven Phase 3 events Phase 3g-i hooks into erc8004Trust.ts, one
// per channelService.ts call site — see auditChannelEvent()'s own doc
// comment below for the shared shape every one of them uses.
type ChannelEventType =
  | "propose_channel"
  | "accept_channel"
  | "reject_channel"
  | "revoke_channel"
  | "send_file"
  | "request_file"
  | "join_project";

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * §7 send_file's own step 4 asks specifically for a *file* hash ("logs
 * {from, to, hash, timestamp}"), not a hash of the surrounding
 * metadata — so send_file is the one event type that hashes real file
 * bytes rather than a JSON detail blob. Streamed rather than
 * `fs.readFile`'d whole, same reasoning every other disk-touching
 * function in this codebase already applies to not assuming a small
 * file (this backend has no size cap on what an agent stages in its
 * own outbox/).
 */
function hashFileContents(filePath: string): Promise<`0x${string}`> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer | string) => {
      hash.update(chunk);
    });
    stream.on("end", () => resolve(`0x${hash.digest("hex")}`));
  });
}

/**
 * The one shared hook every one of Phase 3's seven call sites below
 * fires through — architecture-agent.md §3's "every propose/accept/
 * send/pay event gets a verifiable record... answerable on-chain, not
 * just in your sqlite log" line, generalized by next-phase.md's Phase
 * 3g-i past send_file (the only one §7 spells out explicitly) to
 * cover propose/accept/reject/revoke_channel and request_file/
 * join_project too, in one pass, so the hook's own shape is decided
 * once here rather than drifting across seven separate additions.
 *
 * Deliberately fire-and-forget, never awaited by any of the seven
 * callers below: `recordChannelEvent()` waits for an on-chain receipt
 * (`waitForTransactionReceipt`), which can take real wall-clock time
 * this backend has no reason to make a caller's `propose_channel`/
 * `send_file`/etc. HTTP response block on — same "best-effort mirror,
 * never blocks or fails the [operation] itself" convention
 * `marketplace.ts`'s own `mirrorFlagOnChain(...).catch(() => {})` call
 * site already established for this exact class of on-chain publish.
 * The channelService.ts row this is auditing (the `channels` UPDATE/
 * INSERT, the `channel_file_transfers` row, ...) has already been
 * committed to sqlite by the time this is called — an on-chain
 * failure here is a missed *mirror*, never a rolled-back local write.
 *
 * Skips entirely (no on-chain call attempted) when the acting agent
 * has no backend-custodied wallet or never registered an ERC-8004
 * identity — the exact same `if (!row?.encrypted_key ||
 * !row.erc8004_agent_id) return` guard `marketplace.ts`'s own
 * `mirrorFlagOnChain`/`maybeRequestValidation` already use before ever
 * calling into `erc8004Trust.ts`, not a new convention invented here.
 * `eventURI` is a plain, non-sensitive descriptive string (this
 * backend's own `/channels/...` route shape, not raw office content —
 * office paths/inbox contents never leave the two parties' own
 * containers via this hook); `detailHash` is the caller's own
 * derivation (see `hashFileContents()` above for send_file, or the
 * plain `sha256Hex(JSON.stringify(...))` every other event type below
 * uses) — this function only ever forwards a hash it's given.
 */
function auditChannelEvent(
  actorAddress: string,
  eventType: ChannelEventType,
  eventURI: string,
  detailHash: `0x${string}`,
): void {
  (async () => {
    const actor = db
      .prepare(`SELECT encrypted_key, erc8004_agent_id FROM agents WHERE address = ?`)
      .get(actorAddress) as { encrypted_key: string | null; erc8004_agent_id: string | null } | undefined;
    if (!actor?.encrypted_key || !actor.erc8004_agent_id) return; // self-custody or unregistered — skip, local row still stands

    const actorAccount = getAgentAccount(actorAddress);
    const result = await recordChannelEvent(actorAccount, actor.erc8004_agent_id, eventType, eventURI, detailHash);
    if (result) {
      console.log(`[channel-audit] ${eventType} actor=${actorAddress} tx=${result.txHash}`);
    } else {
      console.log(`[channel-audit] ${eventType} actor=${actorAddress} skipped (no on-chain identity, or the call failed — local row stands)`);
    }
  })().catch((err) => {
    // Should be unreachable — recordChannelEvent() itself never throws
    // (see its own try/catch), and the only other awaited call above
    // (getAgentAccount) only throws on a row this query just confirmed
    // exists. Caught anyway, same "never let an audit-trail failure
    // surface as an error for an already-succeeded channel operation"
    // discipline this whole function exists to provide.
    console.error(`[channel-audit] ${eventType} actor=${actorAddress} unexpected failure:`, err);
  });
}

/**
 * propose_channel(to, scope, note?) — creates a `proposed` row.
 *
 * A proposer cannot also be the recipient (self-channel rejected at the
 * route) — same shape move_worker's "both departments must belong to
 * the same owning agent" cross-check in departments.ts uses, inverted:
 * that check requires sameness, this one forbids it, but it's the same
 * "compare the two addresses before touching the DB" pattern.
 *
 * No cap on concurrent proposals from one agent in this sub-phase —
 * per next-phase.md's own note, rate-limiting is policy.ts's job, added
 * in 3g alongside the audit hook, not invented ad hoc here.
 */
export function proposeChannel(
  proposerAddress: string,
  recipientAddress: string,
  scope: string,
  note?: string,
): ChannelRow {
  if (!proposerAddress || !recipientAddress || !scope) {
    throw Object.assign(new Error("proposerAddress, recipientAddress, and scope are required"), {
      status: 400,
    });
  }
  if (proposerAddress === recipientAddress) {
    throw Object.assign(new Error("a channel cannot be proposed to yourself"), { status: 400 });
  }
  if (!VALID_SCOPES.has(scope)) {
    throw Object.assign(
      new Error(`scope must be one of: ${[...VALID_SCOPES].join(", ")} (got "${scope}")`),
      { status: 400 },
    );
  }
  assertKnownAgent(proposerAddress, "proposerAddress");
  assertKnownAgent(recipientAddress, "recipientAddress");

  const id = newChannelId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO channels
       (id, proposer_address, recipient_address, scope, status, note, proposed_at, resolved_at, created_at)
     VALUES (?, ?, ?, ?, 'proposed', ?, ?, NULL, ?)`,
  ).run(id, proposerAddress, recipientAddress, scope, note ?? null, now, now);

  auditChannelEvent(
    proposerAddress,
    "propose_channel",
    `channel:${id}`,
    `0x${sha256Hex(JSON.stringify({ channelId: id, proposerAddress, recipientAddress, scope, at: now }))}`,
  );

  return getChannel(id);
}

/**
 * accept_channel(channel_id) — only the named recipient may accept;
 * flips `proposed` -> `active`.
 *
 * Idempotent on an already-`active` channel: matches this file's own
 * "retiring an already-retired project just returns burned: []"
 * idempotency convention from departments.ts's retireProjectSequence()
 * — a second accept from the same recipient is a no-op success, not an
 * error, since the caller's intent ("this channel should be active")
 * is already satisfied.
 *
 * Any other status (`rejected`, `revoked`) is terminal and NOT
 * resurrected by a later accept — same "no silent state resurrection"
 * reasoning reject_channel below uses in the other direction.
 */
export function acceptChannel(channelId: string, callerAddress: string): ChannelRow {
  const channel = getChannel(channelId);
  if (channel.recipient_address !== callerAddress) {
    throw Object.assign(
      new Error(`${callerAddress} is not the recipient of channel ${channelId} and cannot accept it`),
      { status: 403 },
    );
  }
  if (channel.status === "active") {
    return channel; // idempotent — already where the caller wants it
  }
  if (channel.status !== "proposed") {
    throw Object.assign(
      new Error(`channel ${channelId} is ${channel.status}, not proposed — it cannot be accepted`),
      { status: 409 },
    );
  }
  const now = Date.now();
  db.prepare(`UPDATE channels SET status = 'active', resolved_at = ? WHERE id = ?`).run(now, channelId);

  auditChannelEvent(
    callerAddress,
    "accept_channel",
    `channel:${channelId}`,
    `0x${sha256Hex(JSON.stringify({ channelId, actor: callerAddress, peer: channel.proposer_address, scope: channel.scope, at: now }))}`,
  );

  return getChannel(channelId);
}

/**
 * reject_channel(channel_id) — only the named recipient may reject;
 * flips `proposed` -> `rejected`, terminal. A rejected channel can
 * never later be accepted — the proposer must propose_channel() again
 * for another attempt, same "no silent state resurrection" reasoning
 * retireProjectSequence()'s own idempotency guard uses in the other
 * direction (there, a second call can't re-fire a completed
 * transition; here, a completed transition can't be un-fired by a
 * later call of the opposite kind).
 */
export function rejectChannel(channelId: string, callerAddress: string): ChannelRow {
  const channel = getChannel(channelId);
  if (channel.recipient_address !== callerAddress) {
    throw Object.assign(
      new Error(`${callerAddress} is not the recipient of channel ${channelId} and cannot reject it`),
      { status: 403 },
    );
  }
  if (channel.status !== "proposed") {
    throw Object.assign(
      new Error(`channel ${channelId} is ${channel.status}, not proposed — it cannot be rejected`),
      { status: 409 },
    );
  }
  const now = Date.now();
  db.prepare(`UPDATE channels SET status = 'rejected', resolved_at = ? WHERE id = ?`).run(now, channelId);

  auditChannelEvent(
    callerAddress,
    "reject_channel",
    `channel:${channelId}`,
    `0x${sha256Hex(JSON.stringify({ channelId, actor: callerAddress, peer: channel.proposer_address, scope: channel.scope, at: now }))}`,
  );

  return getChannel(channelId);
}

/**
 * revoke_channel(channel_id) — next-phase.md Phase 3b (architecture-
 * agent.md §3): the teardown half of the state machine 3a only built
 * the creation half of.
 *
 * Either party (proposer OR recipient) may revoke — unlike accept/
 * reject, which are recipient-only, revoke is symmetric: either office
 * that's already party to the relationship can end it. A third agent
 * — neither this channel's proposer nor its recipient — is rejected
 * the same structural way getOwnedDepartment()/getOwnedWorker() already
 * reject a cross-department/cross-agent target elsewhere in this
 * codebase: a caller/owner mismatch throws before any status is
 * touched, not after.
 *
 * Revoking an `active` channel flips it to `revoked`, terminal.
 *
 * Revoking a channel that's still only `proposed` is treated as an
 * implicit reject — it resolves to `rejected`, the exact same terminal
 * value reject_channel() itself would produce, not a fourth state.
 * Per this sub-phase's own checklist: "don't invent a fourth state for
 * a case the existing three already cover" — same reasoning Phase
 * 2h-i's own step-1 status flip used for an ad-hoc project with no
 * department_projects row. This is why revoke's permission check above
 * is checked once, up front, rather than duplicated per branch: the
 * *transition* differs by starting status, but who's allowed to
 * trigger it doesn't.
 *
 * Idempotent on a channel that's already `revoked` or already
 * `rejected` — same "a repeat call finds its intended end state
 * already reached, so it's a no-op success" convention accept_channel
 * (3a) and retireProjectSequence() (Phase 2b/2h) both already use, not
 * an error. This sub-phase's own scope is the transition mechanism
 * itself — nothing yet reacts to a revoke (3f's `join_project` teardown
 * and 3g's audit trail are what actually key off this event, once they
 * exist).
 *
 * Phase 3f-ii: the `active` → `revoked` branch now also triggers
 * `teardownJointProjectOnRevoke()` — the `proposed` → `rejected` branch
 * never does, since nothing was ever provisioned for a channel that was
 * never accepted (3f-i's `join_project` requires `active`). The status
 * row is updated FIRST, synchronously, with no `await` between the
 * status check and the write — same single-event-loop-tick atomicity
 * every other idempotent transition in this file already relies on —
 * so a concurrent `join_project()` call racing this one will already
 * see `revoked` (and fail closed with `NO_CHANNEL`) by the time this
 * function's own async teardown work even starts. That ordering is
 * what makes the teardown itself safe to run after returning the
 * now-committed channel row's status to the caller rather than before.
 */
export async function revokeChannel(channelId: string, callerAddress: string): Promise<ChannelRow> {
  const channel = getChannel(channelId);
  if (channel.proposer_address !== callerAddress && channel.recipient_address !== callerAddress) {
    throw Object.assign(
      new Error(`${callerAddress} is neither party to channel ${channelId} and cannot revoke it`),
      { status: 403 },
    );
  }
  if (channel.status === "revoked" || channel.status === "rejected") {
    return channel; // already terminal — idempotent, no separate code path per-status
  }
  const now = Date.now();
  const nextStatus = channel.status === "proposed" ? "rejected" : "revoked";
  db.prepare(`UPDATE channels SET status = ?, resolved_at = ? WHERE id = ?`).run(nextStatus, now, channelId);
  const revoked = getChannel(channelId);

  // Audited as "revoke_channel" regardless of which terminal status the
  // transition actually landed on (revoked vs. the proposed->rejected
  // implicit-reject case) — the caller's action was revoke_channel();
  // nextStatus is this function's own internal branch, not a second
  // event type from the actor's point of view.
  const otherParty = channel.proposer_address === callerAddress ? channel.recipient_address : channel.proposer_address;
  auditChannelEvent(
    callerAddress,
    "revoke_channel",
    `channel:${channelId}`,
    `0x${sha256Hex(JSON.stringify({ channelId, actor: callerAddress, peer: otherParty, scope: channel.scope, resultStatus: nextStatus, at: now }))}`,
  );

  if (nextStatus === "revoked") {
    await teardownJointProjectOnRevoke(revoked);
  }
  return revoked;
}

export interface FileTransferRow {
  id: string;
  channel_id: string;
  sender_address: string;
  recipient_address: string;
  file: string;
  note: string | null;
  created_at: number;
}

function newTransferId(): string {
  return "xfr_" + crypto.randomBytes(5).toString("hex");
}

function getFileTransfer(id: string): FileTransferRow {
  const row = db.prepare(`SELECT * FROM channel_file_transfers WHERE id = ?`).get(id) as
    | FileTransferRow
    | undefined;
  if (!row) {
    throw Object.assign(new Error(`file transfer not found: ${id}`), { status: 404 });
  }
  return row;
}

/**
 * §7's send_file() contract, step 1 + step 5: "requires active
 * channel(caller, to_agent_id) with scope including 'file_transfer'"
 * / "fails closed with NO_CHANNEL if step 1 isn't satisfied — never
 * falls back to a raw copy." Routed through 3c's checkCapability()/
 * findActiveChannelGrant() — the one shared enforcement mechanism —
 * rather than a bespoke query reinvented here, same "route the
 * decision through the one shared mechanism" discipline Phase 2f-iv's
 * wallet.pay retrofit and Phase 2g's headcount-quota consolidations
 * both already established for this codebase.
 *
 * resourceId follows capability.ts's own "{peerAddress}:{scope}"
 * convention for resourceType "channel" (see findActiveChannelGrant's
 * doc comment there) — the peer here is always the RECIPIENT, since a
 * send is a call FROM the caller TO that address.
 *
 * checkCapability()'s own denial (a generic 403 "no capability for
 * channel:...") is accurate but not the specific error shape §7's own
 * contract promises. Re-thrown here as a distinctly-named NO_CHANNEL
 * error (`.code`, not just message text) so callers can match on it
 * rather than parsing a string — checkCapability() has already written
 * its own deny row to capability_audit before this catch ever runs, so
 * no separate audit call is needed here.
 */
function requireFileTransferChannel(senderAddress: string, recipientAddress: string): void {
  requireActiveChannelScope(senderAddress, recipientAddress, "file_transfer");
}

/**
 * Generalized form of requireFileTransferChannel above — same
 * checkCapability()/findActiveChannelGrant() gate (3c), any scope.
 * Phase 3f-i's joinProject() is the second caller (send_file/
 * request_file's own requireFileTransferChannel is now a thin wrapper
 * over this, not a separate copy). Re-thrown as a scope-tagged
 * NO_CHANNEL, same shape every prior scope-specific error already used
 * — a caller matching on `.code === "NO_CHANNEL"` doesn't need to know
 * which scope was being checked, but the message text still names it
 * for a human reading logs.
 */
function requireActiveChannelScope(a: string, b: string, scope: string): void {
  try {
    checkCapability({
      caller: a,
      resourceType: "channel",
      resourceId: `${b}:${scope}`,
      action: "transfer",
    });
  } catch {
    throw Object.assign(
      new Error(`NO_CHANNEL: no active ${scope} channel between ${a} and ${b}`),
      { status: 403, code: "NO_CHANNEL" },
    );
  }
}

/**
 * next-phase.md Phase 6b (architecture-agent.md §7, closing 6a's own
 * named gap): the `payment` counterpart to requireFileTransferChannel()
 * above — same requireActiveChannelScope()/checkCapability() gate 3c
 * already established, `payment` scope instead of `file_transfer`,
 * exported (unlike its file-transfer sibling) because its one caller
 * lives outside this module, in wallet.ts's `/pay` route, rather than
 * in a sendFile()/requestFile() pair defined right here. Fails the same
 * NO_CHANNEL shape (`.code === "NO_CHANNEL"`, 403) every other scope
 * check in this file already uses, so wallet.ts doesn't need its own
 * copy of that error-shaping logic.
 *
 * Deliberately just this one function, not a parallel findActiveChannelId
 * — wallet.ts's `/pay` route has no equivalent of send_file's own
 * channel_file_transfers attribution row to resolve a channel id for
 * (6e is where a settled payment gets traced back to its channel grant,
 * via erc8004Trust.ts's audit-hook, not a second lookup here).
 */
export function requirePaymentChannel(fromAddress: string, toAddress: string): void {
  requireActiveChannelScope(fromAddress, toAddress, "payment");
}

/**
 * next-phase.md Phase 6b — moved here (from an original, narrower draft
 * that lived only in wallet.ts) once 6b's revision gated `facilitator.ts`'s
 * `/settle` route directly (see that file's own Phase 6b note): both
 * wallet.ts's early fast-fail check AND facilitator.ts's authoritative
 * gate need the exact same "does this transfer need a channel" decision,
 * and a decision this security-relevant must live in exactly one place —
 * same "route the decision through the one shared mechanism" discipline
 * this file's own requireFileTransferChannel()/requireActiveChannelScope()
 * split already established. Three-way answer, not a bare bool, because
 * `to` isn't always another agent at all:
 *
 *   1. `to` doesn't resolve to a row in `agents` — an ordinary external
 *      address (a vendor, an exchange, a human's own wallet, or a
 *      config-only address like config.founderWalletAddress). The
 *      channel model (architecture-agent.md §5/§7) only ever governs
 *      agent-to-agent relationships; there's no `agents` row for
 *      propose_channel() to name as the peer, so nothing to require.
 *   2. `to` IS an agent, and this is that clone's Day-1 funding: `to`.
 *      parent_address === `from` (this agent created it — see
 *      wallet.ts's createAgentWallet()'s own parentAddress param) AND
 *      `to` has never received a payments row before. Exempted,
 *      narrowly, because architecture-agent.md §5's own COW table is
 *      explicit that "a clone starts with zero channels" — a literal
 *      channel requirement here would make first funding structurally
 *      impossible (nothing to fund the wallet that would sign the
 *      channel-proposal transaction that would unlock funding it).
 *      Scoped to exactly the one bootstrapping transfer, not "children
 *      are permanently exempt from channels with their parent": once
 *      `to` has received one payment, every later transfer between
 *      this pair — including a second top-up from the same parent —
 *      goes through the normal channel check like any other pair of
 *      agents. This is deliberately NOT the same thing as reading
 *      agents.parent_address as an owner/capability grant — capability.
 *      ts's own resourceType "subagent" case (Phase 4f) already ruled
 *      that reading straight out as unsafe ("clone lineage ... must
 *      stay irrelevant to delegation"); this reads the same column only
 *      to gate a one-time bootstrapping exemption, and only alongside
 *      the "no prior payment yet" fact — it never resolves `from` as
 *      `to`'s owner, and it grants no capability beyond this single
 *      transfer.
 *   3. Neither of the above: a real agent-to-agent payment between two
 *      independent parties. Requires an active `payment`-scoped channel
 *      (Phase 3), same as every other cross-office operation.
 *
 * Deliberately reads straight off the `payments` table (settled at
 * facilitator.ts's own INSERT, before the on-chain call — see that
 * file's comment on why) rather than requiring a caller to pass its own
 * "is this the first transfer" flag — a fact this function can establish
 * for itself is a fact no caller should be trusted to assert.
 */
export function paymentChannelRequired(fromAddress: string, toAddress: string): boolean {
  const to = db.prepare(`SELECT parent_address FROM agents WHERE address = ?`).get(toAddress) as
    | { parent_address: string | null }
    | undefined;
  if (!to) return false; // not an agent — outside the channel model entirely

  if (to.parent_address === fromAddress) {
    const priorPayment = db.prepare(`SELECT 1 FROM payments WHERE to_address = ? LIMIT 1`).get(toAddress);
    if (!priorPayment) return false; // Day-1 clone funding — see doc comment above
  }

  return true;
}

/**
 * Resolves which specific channel row a just-allowed send_file() call
 * should be attributed to in channel_file_transfers — a different job
 * than requireFileTransferChannel()'s allow/deny decision above, so
 * kept as its own small query rather than having capability.ts's
 * (deliberately decision-only, non-exported) findActiveChannelGrant()
 * also hand back a row for a purpose it was never designed for.
 *
 * Should be unreachable in practice: requireFileTransferChannel() above
 * already confirmed a matching active channel exists. If this ever
 * misses anyway, it means the channel was revoked in the narrow window
 * between that check and this query — a real, if rare, race, same
 * category Phase 2g's own environment-teardown race-check already
 * accounts for elsewhere in this codebase. Treated as NO_CHANNEL rather
 * than a 500: from the caller's point of view the outcome is identical
 * either way — no active channel to send through.
 */
function findActiveChannelId(a: string, b: string, scope: string): string {
  const row = db
    .prepare(
      `SELECT id FROM channels
       WHERE status = 'active'
         AND scope = ?
         AND (
           (proposer_address = ? AND recipient_address = ?)
           OR (proposer_address = ? AND recipient_address = ?)
         )
       ORDER BY resolved_at DESC
       LIMIT 1`,
    )
    .get(scope, a, b, b, a) as { id: string } | undefined;
  if (!row) {
    throw Object.assign(new Error(`NO_CHANNEL: no active file_transfer channel between ${a} and ${b}`), {
      status: 403,
      code: "NO_CHANNEL",
    });
  }
  return row.id;
}

/**
 * next-phase.md Phase 6e — the non-throwing sibling of findActiveChannelId()
 * above. That function is right for send_file: by the time it's called,
 * requireFileTransferChannel() has already confirmed a channel MUST
 * exist, so a miss there really is the race-condition edge case its own
 * doc comment describes, and NO_CHANNEL is the correct outcome.
 *
 * A marketplace payment is different: per Phase 6b's own resolution,
 * no channel is ever required for it, so asking "which channel did
 * this payment go through" is an optional enrichment, not a
 * precondition check — the ordinary, expected answer for a cold-
 * discovery marketplace purchase between two strangers is "none",
 * not an error. Returns null rather than throwing on a miss; marketplace.ts
 * is the only caller today, using this to populate invocations.channel_id
 * only when a real one exists, and to skip the field otherwise (see
 * db.ts's own migration comment for why null is the common, expected
 * case here, not a sign anything went wrong).
 *
 * Same query shape as findActiveChannelId() (bidirectional, most-
 * recently-resolved-first) deliberately kept as a near-duplicate rather
 * than refactored into one shared internal function with a throws-or-
 * returns-null flag — the two callers want visibly different failure
 * semantics (403 vs. a plain optional field), and next-phase.md's own
 * established preference throughout this file is a named, distinct
 * function per real behavioral difference over a parameterized one that
 * hides which behavior a given call site actually gets.
 */
export function findActiveChannelIdIfAny(a: string, b: string, scope: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM channels
       WHERE status = 'active'
         AND scope = ?
         AND (
           (proposer_address = ? AND recipient_address = ?)
           OR (proposer_address = ? AND recipient_address = ?)
         )
       ORDER BY resolved_at DESC
       LIMIT 1`,
    )
    .get(scope, a, b, b, a) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * send_file(to, file, note?) — next-phase.md Phase 3d (architecture-
 * agent.md §7): the first real caller of 3c's channel-grant mechanism.
 *
 * §7's own steps, in order:
 *   1. requires an active channel with file_transfer scope — see
 *      requireFileTransferChannel() above.
 *   2. file must already be staged in the sender's own office/outbox/
 *      — safeOutboxPath() throws if it isn't there or if `file`
 *      resolves outside that directory.
 *   3. broker copies outbox/{file} -> recipient's office/inbox/{file}
 *      — safeInboxPath() on the destination side, same containment
 *      shape. Sender never gets a path into recipient's office;
 *      recipient never gets one into sender's — the copy is the only
 *      thing that crosses.
 *   4. logs the transfer (this sub-phase's own channel_file_transfers
 *      row — the erc8004Trust.ts audit-trail hook §7 also describes is
 *      3g's job, once every propose/accept/send/pay call site gets
 *      hooked in one pass).
 *   5. NO_CHANNEL if step 1 isn't satisfied — never falls back to a
 *      raw copy (requireFileTransferChannel() throws before anything
 *      below it runs).
 *
 * Repeated calls between the same pair, once the channel is active, go
 * through every time without re-approval — there is no "already sent
 * once" gate here, only the same live channel-state check every call
 * — matching §3's own "don't make A and B re-approve every single file
 * inside an ongoing project" design note.
 */
export async function sendFile(
  senderAddress: string,
  recipientAddress: string,
  file: string,
  note?: string,
): Promise<FileTransferRow> {
  if (!senderAddress || !recipientAddress || !file) {
    throw Object.assign(new Error("senderAddress, recipientAddress, and file are required"), { status: 400 });
  }
  assertKnownAgent(senderAddress, "senderAddress");
  assertKnownAgent(recipientAddress, "recipientAddress");

  requireFileTransferChannel(senderAddress, recipientAddress);
  const channelId = findActiveChannelId(senderAddress, recipientAddress, "file_transfer");

  await ensureOffice(senderAddress);
  await ensureOffice(recipientAddress);

  const sourcePath = safeOutboxPath(senderAddress, file);
  try {
    await fs.access(sourcePath);
  } catch {
    throw Object.assign(
      new Error(`file not found in ${senderAddress}'s outbox: ${file} — stage it there before calling send_file`),
      { status: 404 },
    );
  }
  const destPath = safeInboxPath(recipientAddress, file);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.copyFile(sourcePath, destPath);

  const id = newTransferId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO channel_file_transfers
       (id, channel_id, sender_address, recipient_address, file, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, channelId, senderAddress, recipientAddress, file, note ?? null, now);

  // Phase 3e's own optional cross-reference — see tryFulfillMatchingRequest()'s
  // doc comment for why this runs after the transfer/insert above have
  // already fully succeeded, and why it can never fail this call.
  tryFulfillMatchingRequest(channelId, senderAddress, recipientAddress);

  // §7 step 4, literally: "logs { from, to, hash, timestamp } to the
  // audit trail (erc8004Trust.ts)" — the one event type among these
  // seven that hashes real file bytes (hashFileContents(), streamed)
  // rather than a JSON metadata blob, per §7's own wording. Hashed from
  // destPath (the now-landed copy in the recipient's inbox) rather than
  // sourcePath — both are byte-identical after fs.copyFile above, but
  // hashing the copy that's actually going to persist in the
  // recipient's office is the more meaningful "what got delivered"
  // record if the two ever diverged for any reason.
  hashFileContents(destPath)
    .then((fileHash) => {
      auditChannelEvent(senderAddress, "send_file", `channel:${channelId} transfer:${id} file:${file}`, fileHash);
    })
    .catch((err) => {
      // Hashing failure (e.g. the file was removed from the recipient's
      // inbox between the copy above and this line) — same "never let
      // the audit mirror fail an already-succeeded send_file()" rule
      // auditChannelEvent() itself documents; the transfer already
      // happened and is already in channel_file_transfers regardless.
      console.error(`[channel-audit] send_file hash failed for transfer ${id}:`, err);
    });

  return getFileTransfer(id);
}

export interface FileRequestRow {
  id: string;
  channel_id: string;
  requester_address: string;
  recipient_address: string;
  description: string;
  status: "pending" | "fulfilled";
  requested_at: number;
  fulfilled_at: number | null;
}

function newRequestId(): string {
  return "req_" + crypto.randomBytes(5).toString("hex");
}

function getFileRequest(id: string): FileRequestRow {
  const row = db.prepare(`SELECT * FROM file_requests WHERE id = ?`).get(id) as
    | FileRequestRow
    | undefined;
  if (!row) {
    throw Object.assign(new Error(`file request not found: ${id}`), { status: 404 });
  }
  return row;
}

/**
 * request_file(to, description) — next-phase.md Phase 3e (architecture-
 * agent.md §3/§7): "asks; peer must send_file() back, not auto-granted."
 *
 * Gated by the exact same active file_transfer channel send_file()
 * itself requires — requireFileTransferChannel()/findActiveChannelId()
 * (3c/3d), not a bespoke or looser check reinvented here. A request is
 * scoped by the same channel a fulfillment would need, so there's no
 * principled reason for it to have a looser gate than the capability
 * it's asking for.
 *
 * Creates a `file_requests` row and nothing more — no file moves, no
 * inbox/outbox touched. See requestDoesNotAutoGrant() below (this
 * file's own call-graph self-check, not a runtime function) for why
 * that's structural, not just a documentation promise.
 */
export function requestFile(
  requesterAddress: string,
  recipientAddress: string,
  description: string,
): FileRequestRow {
  if (!requesterAddress || !recipientAddress || !description) {
    throw Object.assign(
      new Error("requesterAddress, recipientAddress, and description are required"),
      { status: 400 },
    );
  }
  assertKnownAgent(requesterAddress, "requesterAddress");
  assertKnownAgent(recipientAddress, "recipientAddress");

  requireFileTransferChannel(requesterAddress, recipientAddress);
  const channelId = findActiveChannelId(requesterAddress, recipientAddress, "file_transfer");

  const id = newRequestId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO file_requests
       (id, channel_id, requester_address, recipient_address, description, status, requested_at, fulfilled_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
  ).run(id, channelId, requesterAddress, recipientAddress, description, now);

  auditChannelEvent(
    requesterAddress,
    "request_file",
    `channel:${channelId} request:${id}`,
    `0x${sha256Hex(JSON.stringify({ channelId, requestId: id, requesterAddress, recipientAddress, description, at: now }))}`,
  );

  return getFileRequest(id);
}

/**
 * Best-effort cross-reference, called from sendFile() below after a
 * transfer has already fully succeeded — never load-bearing for
 * send_file's own contract (§3's Phase 3e checklist: "not a
 * requirement send_file itself should be blocked on if omitted — most
 * calls will be exactly that", i.e. zero open requests against them).
 * Deliberately swallows its own errors rather than letting a
 * bookkeeping failure turn an already-succeeded file transfer into a
 * 500 for the caller.
 *
 * Matches the *oldest* still-pending request on the same channel where
 * the just-completed send's sender is that request's recipient (the
 * one who was asked) and its recipient is that request's requester
 * (the one who asked) — the fulfillment direction is the mirror image
 * of the request direction. Flips at most one row per send_file() call;
 * a single file rarely answers two independent asks at once, and a
 * requester who wants confirmation for each of several distinct asks
 * can call request_file again.
 */
function tryFulfillMatchingRequest(channelId: string, senderAddress: string, recipientAddress: string): void {
  try {
    const row = db
      .prepare(
        `SELECT id FROM file_requests
         WHERE channel_id = ?
           AND status = 'pending'
           AND requester_address = ?
           AND recipient_address = ?
         ORDER BY requested_at ASC
         LIMIT 1`,
      )
      .get(channelId, recipientAddress, senderAddress) as { id: string } | undefined;
    if (!row) return;
    db.prepare(`UPDATE file_requests SET status = 'fulfilled', fulfilled_at = ? WHERE id = ?`).run(
      Date.now(),
      row.id,
    );
  } catch {
    // best-effort only — never let this block or fail an already-succeeded send_file()
  }
}

export interface JointProjectRow {
  channel_id: string;
  path: string;
  proposer_sandbox_id: string;
  recipient_sandbox_id: string;
  provisioned_at: number;
  torn_down_at: number | null;
}

function getJointProject(channelId: string): JointProjectRow | undefined {
  return db.prepare(`SELECT * FROM joint_projects WHERE channel_id = ?`).get(channelId) as
    | JointProjectRow
    | undefined;
}

/**
 * Phase 3f-ii — the teardown half of `join_project`, triggered only
 * from revokeChannel()'s `active` → `revoked` branch above. A no-op if
 * `join_project` was never actually called for this channel (no
 * `joint_projects` row exists — the channel had `joint_project` in its
 * scope but neither party ever joined it).
 *
 * Race guard: claims the row with a single atomic
 * `UPDATE ... WHERE torn_down_at IS NULL` before doing any of the real
 * unmount/archive/delete work, and only proceeds if this call is the
 * one that flipped it from NULL — same "the atomic claim, not the
 * later work, is what decides who's responsible" shape Phase 2b's TTL
 * reaper uses against a double-fire race with an explicit
 * `retire_project()` call. This is the "concurrent-call/mid-teardown
 * race" this sub-phase's own checklist item names: two overlapping
 * revoke attempts (or a retry after a partial failure below) must
 * unmount/archive/delete exactly once, not twice.
 *
 * Content handling on teardown (§3's own explicit requirement, "decides
 * what happens to the directory's contents" rather than a bare
 * container-path unmount): the joint directory is archived into BOTH
 * parties' own office inboxes before it's deleted from
 * `config.jointProjectsDir` — same "archive before delete" shape Phase
 * 2d/2h's `archiveWorkerOutput()`/`project_archive` established for a
 * temp worker's output, adapted here from DB rows to a real directory
 * tree. `/joint/{channel_id}/` itself is genuinely torn down (matching
 * architecture-agent.md §3's "auto-deleted when the channel is
 * revoked" line) — what's preserved is each party's own copy, mirroring
 * §3's shared-directory language ("both offices can mount") with a
 * final, one-time fan-out back into each office rather than a location
 * neither party's own office retains anything from.
 *
 * Each of the three real-world steps (unmount from each sandbox,
 * archive-copy into each inbox, delete the host directory) is wrapped
 * in its own try/catch and never rethrown — same "best-effort, never
 * turn an already-committed state transition into a failure for the
 * caller" convention `tryFulfillMatchingRequest()` above already uses.
 * `revokeChannel()`'s own contract is the channel's `revoked` status,
 * already written to `channels` before this function is even called;
 * a partial teardown failure here is logged, not surfaced as a thrown
 * error on an otherwise-successful revoke.
 */
async function teardownJointProjectOnRevoke(channel: ChannelRow): Promise<void> {
  const existing = getJointProject(channel.id);
  if (!existing || existing.torn_down_at !== null) {
    return; // never joined, or already torn down by an earlier/racing call
  }

  const claim = db
    .prepare(`UPDATE joint_projects SET torn_down_at = ? WHERE channel_id = ? AND torn_down_at IS NULL`)
    .run(Date.now(), channel.id);
  if (claim.changes !== 1) {
    return; // lost the race — some other call already claimed teardown
  }

  const { path: hostPath, proposer_sandbox_id, recipient_sandbox_id } = existing;
  const archiveDirName = `joint_${channel.id}`;

  for (const [sandboxId, label] of [
    [proposer_sandbox_id, "proposer"],
    [recipient_sandbox_id, "recipient"],
  ] as const) {
    try {
      await unmountJointDirFromSandbox(sandboxId, channel.id);
    } catch (err) {
      console.error(`teardownJointProjectOnRevoke: unmount failed for ${label} sandbox ${sandboxId}:`, err);
    }
  }

  for (const [agentAddress, label] of [
    [channel.proposer_address, "proposer"],
    [channel.recipient_address, "recipient"],
  ] as const) {
    try {
      const dest = path.join(officeInboxDir(agentAddress), archiveDirName);
      await fs.mkdir(dest, { recursive: true });
      await fs.cp(hostPath, dest, { recursive: true });
    } catch (err) {
      console.error(`teardownJointProjectOnRevoke: archive-copy failed for ${label} ${agentAddress}:`, err);
    }
  }

  try {
    await fs.rm(hostPath, { recursive: true, force: true });
  } catch (err) {
    console.error(`teardownJointProjectOnRevoke: directory removal failed for ${hostPath}:`, err);
  }
}

/**
 * join_project(channel_id) — next-phase.md Phase 3f-i (architecture-
 * agent.md §3/§7): the one Phase 3 capability with real filesystem/
 * container consequences. Unlike send_file/request_file (which take a
 * `to` address and resolve their own channel), this takes the
 * channel_id directly — the caller must already know which channel
 * they're joining, and the OTHER party is derived from the channel row
 * itself, not passed in.
 *
 * Gate: `callerAddress` must actually be a party to `channelId` (same
 * "structurally can't act on a channel you're not in" shape
 * revokeChannel() already enforces), and the channel must be `active`
 * with `joint_project` in its scope — checked through the exact same
 * requireActiveChannelScope()/findActiveChannelId() (3c/3d) every
 * other channel-scoped capability in this file uses, not a bespoke
 * check reinvented here.
 *
 * Provisioning is idempotent: a second join_project() call against the
 * same still-active channel finds the existing joint_projects row and
 * the existing bind mounts (mountJointDirIntoSandbox's own same-set
 * check in docker.ts) and does no destructive work — same idempotency
 * convention accept_channel (3a) and spawn_temp_workers-then-
 * retire_project (Phase 2b) both already use.
 *
 * Each party's OWN default sandbox (vmService.ts's
 * getOrCreateDefaultSandbox — lazily created if this is that agent's
 * first sandbox operation of any kind) is what gets the mount, not a
 * new joint-specific container: architecture-agent.md §3's own
 * "read/write /joint/{channel_id} from inside their own containers"
 * line names each party's own container, and Phase 2/2a's existing
 * precedent throughout this codebase is that a capability lands in the
 * caller's EXISTING execution environment rather than spinning up a
 * new one for it.
 */
export async function joinProject(
  channelId: string,
  callerAddress: string,
): Promise<JointProjectRow> {
  if (!channelId || !callerAddress) {
    throw Object.assign(new Error("channelId and callerAddress are required"), { status: 400 });
  }
  const channel = getChannel(channelId);
  const otherParty =
    channel.proposer_address === callerAddress
      ? channel.recipient_address
      : channel.recipient_address === callerAddress
        ? channel.proposer_address
        : null;
  if (!otherParty) {
    throw Object.assign(
      new Error(`${callerAddress} is neither party to channel ${channelId} and cannot join it`),
      { status: 403 },
    );
  }

  requireActiveChannelScope(callerAddress, otherParty, "joint_project");
  // Confirms the SAME channel just gated is the one being provisioned
  // for (not merely "some active joint_project channel exists between
  // these two parties") — same race/attribution reasoning
  // findActiveChannelId()'s own doc comment gives for send_file.
  const resolvedId = findActiveChannelId(channel.proposer_address, channel.recipient_address, "joint_project");
  if (resolvedId !== channelId) {
    throw Object.assign(
      new Error(`NO_CHANNEL: ${channelId} is not the currently-active joint_project channel between these agents`),
      { status: 403, code: "NO_CHANNEL" },
    );
  }

  const hostPath = jointProjectDir(channelId);
  await fs.mkdir(hostPath, { recursive: true });

  const [proposerSandboxId, recipientSandboxId] = await Promise.all([
    getOrCreateDefaultSandbox(channel.proposer_address),
    getOrCreateDefaultSandbox(channel.recipient_address),
  ]);
  await mountJointDirIntoSandbox(proposerSandboxId, hostPath, channelId);
  await mountJointDirIntoSandbox(recipientSandboxId, hostPath, channelId);

  const existing = getJointProject(channelId);
  if (!existing) {
    db.prepare(
      `INSERT INTO joint_projects
         (channel_id, path, proposer_sandbox_id, recipient_sandbox_id, provisioned_at, torn_down_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).run(channelId, hostPath, proposerSandboxId, recipientSandboxId, Date.now());
  } else if (existing.torn_down_at !== null) {
    // Re-joining a channel whose joint dir was torn down by a prior
    // revoke (3f-ii) and then... this shouldn't actually be reachable,
    // since revoke is terminal and a torn-down joint_projects row only
    // ever exists for a channel that's now `revoked` — the
    // requireActiveChannelScope() check above would already have
    // thrown NO_CHANNEL first. Left as a defensive no-op rather than
    // an assumption, in case 3f-ii's own teardown trigger is ever
    // reachable from a state this function doesn't currently expect.
    db.prepare(
      `UPDATE joint_projects
         SET proposer_sandbox_id = ?, recipient_sandbox_id = ?, provisioned_at = ?, torn_down_at = NULL
       WHERE channel_id = ?`,
    ).run(proposerSandboxId, recipientSandboxId, Date.now(), channelId);
  }
  // proposer/recipient sandbox ids can legitimately change between
  // calls (e.g. a sandbox was deleted and getOrCreateDefaultSandbox
  // recreated it under the same id — same id in practice, but keeping
  // the row's own ids fresh rather than assuming the first call's
  // values are still accurate costs nothing here).
  else {
    db.prepare(
      `UPDATE joint_projects SET proposer_sandbox_id = ?, recipient_sandbox_id = ? WHERE channel_id = ?`,
    ).run(proposerSandboxId, recipientSandboxId, channelId);
  }

  // Fired on every call, including an idempotent repeat join — same
  // "audits the actor's action, not just first-time provisioning"
  // reasoning every other event type above uses (e.g. accept_channel's
  // own idempotent-repeat-call branch is audited too, not only the
  // first accept).
  auditChannelEvent(
    callerAddress,
    "join_project",
    `channel:${channelId} path:/joint/${channelId}`,
    `0x${sha256Hex(JSON.stringify({ channelId, actor: callerAddress, peer: otherParty, at: Date.now() }))}`,
  );

  return getJointProject(channelId)!;
}

// POST /channels/propose  { agentAddress, to, scope, note? }
router.post("/propose", (req, res) => {
  try {
    const { agentAddress, to, scope, note } = req.body;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const channel = proposeChannel(agentAddress, to, scope, note);
    res.json({ ok: true, channel });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /channels/:id/accept  { agentAddress }
router.post("/:id/accept", (req, res) => {
  try {
    const { agentAddress } = req.body;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const channel = acceptChannel(req.params.id, agentAddress);
    res.json({ ok: true, channel });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /channels/:id/reject  { agentAddress }
router.post("/:id/reject", (req, res) => {
  try {
    const { agentAddress } = req.body;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const channel = rejectChannel(req.params.id, agentAddress);
    res.json({ ok: true, channel });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /channels/:id/revoke  { agentAddress }
router.post("/:id/revoke", async (req, res) => {
  try {
    const { agentAddress } = req.body;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const channel = await revokeChannel(req.params.id, agentAddress);
    res.json({ ok: true, channel });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /channels/send-file  { agentAddress, to, file, note? }
router.post("/send-file", async (req, res) => {
  try {
    const { agentAddress, to, file, note } = req.body;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const transfer = await sendFile(agentAddress, to, file, note);
    res.json({ ok: true, transfer });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// POST /channels/request-file  { agentAddress, to, description }
router.post("/request-file", (req, res) => {
  try {
    const { agentAddress, to, description } = req.body;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const request = requestFile(agentAddress, to, description);
    res.json({ ok: true, request });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// POST /channels/:id/join  { agentAddress }
router.post("/:id/join", async (req, res) => {
  try {
    const { agentAddress } = req.body;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const joint = await joinProject(req.params.id, agentAddress);
    res.json({ ok: true, joint: { ...joint, containerPath: `/joint/${joint.channel_id}` } });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

export default router;
