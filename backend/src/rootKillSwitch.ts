import { randomUUID } from "crypto";
import { db } from "./db.js";
import { killAgentProcess, getAgentProcessStatus } from "./orchestrator.js";
import { emitEvent } from "./ecosystemEvents.js";

/**
 * Root Kill Switch — admin-only control over ANY agent, including the
 * root/main automaton that expansionKillSwitch.ts deliberately excludes.
 *
 * Why this is separate from expansionKillSwitch.ts rather than a patch
 * to it: that module's whole design is "self or parent can act on a
 * pipeline-spawned child" — a peer-authority model with no place for
 * "an external human, acting on literally any agent." Bolting that
 * onto the existing precondition would weaken an already-reasoned-about
 * authorization boundary. This file is intentionally narrower in who
 * can call it (x-admin-key ONLY, no self/parent path) and broader in
 * what it can target (any agent row, spawn_reason unrestricted).
 *
 * Two independent mechanisms, both idempotent:
 *
 *   1. freezeFunds(address) — sets agents.frozen = 1. Enforced at
 *      wallet.ts's signPaymentAuthorization() chokepoint, which checks
 *      `frozen` for ANY address already (see wallet.ts:~895-913) — this
 *      file adds no new enforcement, just an entry point that isn't
 *      gated behind the expansion-pipeline precondition. Takes effect
 *      immediately regardless of whether the agent's process is even
 *      reachable (e.g. root agent running on the user's own phone/VM,
 *      not on this backend's host).
 *
 *   2. requestShutdown(address) — sets a poll flag the agent's own
 *      heartbeat checks each cycle (see agent/src/heartbeat/tasks.ts's
 *      checkKillSwitch task) and exits gracefully on. This is
 *      COOPERATIVE, not forced — an agent whose process is hung or
 *      whose heartbeat has stopped won't see it. That's why it's
 *      paired with freezeFunds: even if the process never checks in
 *      again, it can't move money once frozen. If the target process
 *      happens to be tracked in agent_processes (true for
 *      pipeline-spawned children, not for a manually-run root agent
 *      on unrelated infrastructure), we ALSO attempt a direct SIGTERM
 *      via the existing killAgentProcess() as a best-effort belt.
 *
 * Nothing here assumes the agent is on this host. For a root agent
 * running on the operator's own machine (the common case per the
 * README's `node dist/index.js --run`), freezeFunds is the real stop —
 * it can't transact anymore even if it keeps running — and
 * requestShutdown is the polite ask for it to actually exit.
 */

export interface KillSwitchAdminResult {
  address: string;
  action: "freeze" | "shutdown_request" | "freeze_and_shutdown";
  frozen: { attempted: boolean; alreadyFrozen: boolean; detail: string };
  shutdownRequested: { attempted: boolean; detail: string };
  processSignal: { attempted: boolean; succeeded: boolean; detail: string };
  eventId: string;
}

function ensureControlFlagsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS control_flags (
      agent_address TEXT PRIMARY KEY,
      shutdown_requested INTEGER NOT NULL DEFAULT 0,
      shutdown_reason TEXT,
      requested_at INTEGER,
      acked_at INTEGER
    )
  `);
}

function ensureAgentRowExists(address: string): void {
  // Root agents provisioned outside the pipeline may never have gotten
  // a row in `agents` (that table has historically been populated by
  // spawn_child/genesis flows). freezeFunds/requestShutdown must work
  // even for an agent this backend has never spawned itself, as long
  // as it registered a wallet against this backend at all.
  const exists = db.prepare(`SELECT 1 FROM agents WHERE address = ?`).get(address);
  if (!exists) {
    throw Object.assign(
      new Error(`no agent registered with address ${address} — nothing to act on`),
      { status: 404 },
    );
  }
}

/** Finance half: freeze funds for ANY agent, no spawn_reason restriction. */
function freezeFunds(address: string, reason: string): KillSwitchAdminResult["frozen"] {
  ensureAgentRowExists(address);
  const row = db.prepare(`SELECT frozen FROM agents WHERE address = ?`).get(address) as
    | { frozen: number }
    | undefined;
  const wasAlreadyFrozen = row?.frozen === 1;

  if (!wasAlreadyFrozen) {
    db.prepare(
      `UPDATE agents SET frozen = 1, frozen_reason = ?, frozen_at = ? WHERE address = ?`,
    ).run(reason, Date.now(), address);
  }

  return {
    attempted: true,
    alreadyFrozen: wasAlreadyFrozen,
    detail: wasAlreadyFrozen ? "was already frozen" : "funds frozen — signPaymentAuthorization will now reject this address",
  };
}

/** Cooperative half: flag for the agent's own heartbeat to notice and act on. */
function requestShutdown(address: string, reason: string): KillSwitchAdminResult["shutdownRequested"] {
  ensureControlFlagsTable();
  db.prepare(
    `INSERT INTO control_flags (agent_address, shutdown_requested, shutdown_reason, requested_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(agent_address) DO UPDATE SET
       shutdown_requested = 1, shutdown_reason = excluded.shutdown_reason, requested_at = excluded.requested_at`,
  ).run(address, reason, Date.now());
  return { attempted: true, detail: "flag set — agent will see this on its next heartbeat/turn poll" };
}

/** Best-effort direct signal, only works if this backend is tracking the process (pipeline children). */
function tryDirectSignal(address: string, reason: string): KillSwitchAdminResult["processSignal"] {
  const tracked = getAgentProcessStatus(address);
  if (!tracked) {
    return { attempted: false, succeeded: false, detail: "not a process this backend tracks (expected for an operator-run root agent) — relying on freeze + cooperative shutdown" };
  }
  const result = killAgentProcess(address, "SIGTERM", reason);
  return { attempted: true, succeeded: result.killed, detail: result.reason ?? "signal delivered" };
}

/**
 * The one function the admin route calls. Does all three: freeze funds
 * (hard stop on money movement), request cooperative shutdown (polite
 * ask), and attempt a direct process signal (best-effort, usually a
 * no-op for a root agent — that's fine, freeze already covers it).
 */
export function adminKillAgent(address: string, reason: string): KillSwitchAdminResult {
  const frozen = freezeFunds(address, reason);
  const shutdownRequested = requestShutdown(address, reason);
  const processSignal = tryDirectSignal(address, reason);

  const eventId = randomUUID();
  // kill_events is db.ts's table (created once, canonically, at DB init —
  // this file must never CREATE TABLE it itself: a second, differently-
  // shaped definition here previously caused a real NOT NULL constraint
  // failure the first time this path actually ran, since whichever
  // CREATE TABLE IF NOT EXISTS runs first wins and the other's INSERT
  // silently assumed its own column set). root_agent_address is the
  // agent's own address for a root-level kill — it IS its own root.
  db.prepare(
    `INSERT INTO kill_events (id, agent_address, root_agent_address, action, initiator, initiator_address, reason, detail, created_at)
     VALUES (?, ?, ?, 'kill', 'admin', NULL, ?, ?, ?)`,
  ).run(eventId, address, address, reason, JSON.stringify({ frozen, shutdownRequested, processSignal }), Date.now());

  emitEvent({
    agentAddress: address,
    role: "Security",
    subRole: "Admin Kill Switch",
    eventType: "kill",
    message: `Admin kill switch triggered: ${reason}`,
    metadata: { eventId, frozen, shutdownRequested, processSignal },
  });

  return {
    address,
    action: "freeze_and_shutdown",
    frozen,
    shutdownRequested,
    processSignal,
    eventId,
  };
}

/** Admin-only unfreeze — deliberately the ONLY "undo" in this whole kill-switch story. */
export function adminUnfreeze(address: string, reason: string): { address: string; unfrozen: boolean } {
  ensureAgentRowExists(address);
  db.prepare(`UPDATE agents SET frozen = 0, frozen_reason = NULL, frozen_at = NULL WHERE address = ?`).run(address);
  ensureControlFlagsTable();
  db.prepare(`UPDATE control_flags SET shutdown_requested = 0 WHERE agent_address = ?`).run(address);
  emitEvent({
    agentAddress: address,
    role: "Security",
    subRole: "Admin Kill Switch",
    eventType: "unfreeze",
    message: `Admin unfroze funds: ${reason}`,
  });
  return { address, unfrozen: true };
}

/** Agent-facing: does THIS agent have a pending shutdown request? Polled by the heartbeat task. */
export function checkShutdownFlag(address: string): { shutdown: boolean; reason: string | null } {
  ensureControlFlagsTable();
  const row = db
    .prepare(`SELECT shutdown_requested, shutdown_reason FROM control_flags WHERE agent_address = ?`)
    .get(address) as { shutdown_requested: number; shutdown_reason: string | null } | undefined;
  if (!row || !row.shutdown_requested) return { shutdown: false, reason: null };
  return { shutdown: true, reason: row.shutdown_reason };
}

export function listActiveAgents(): { address: string; frozen: boolean; spawn_reason: string | null }[] {
  return db
    .prepare(`SELECT address, frozen, spawn_reason FROM agents ORDER BY created_at DESC LIMIT 200`)
    .all() as any[];
}

/**
 * Single-agent status — the read-only counterpart to adminKillAgent/
 * adminUnfreeze above. Added alongside control-bot.ts's `/status`
 * command: that command was documented (header comment + its own help
 * text) and called backendCall(`/status/${address}`), but this route
 * never actually existed — a genuine wiring gap between the bot and
 * this backend, not something either side did wrong on its own.
 */
export function getAgentStatus(address: string): {
  address: string;
  name: string | null;
  frozen: boolean;
  frozenReason: string | null;
  frozenAt: number | null;
  spawnReason: string | null;
  shutdownRequested: boolean;
  shutdownReason: string | null;
  process: { status: string; pid: number | null } | null;
} {
  const row = db
    .prepare(`SELECT address, name, frozen, frozen_reason, frozen_at, spawn_reason FROM agents WHERE address = ?`)
    .get(address) as
    | {
        address: string;
        name: string | null;
        frozen: number;
        frozen_reason: string | null;
        frozen_at: number | null;
        spawn_reason: string | null;
      }
    | undefined;
  if (!row) {
    throw Object.assign(
      new Error(`no agent registered with address ${address} — nothing to report`),
      { status: 404 },
    );
  }

  const shutdown = checkShutdownFlag(address);
  const tracked = getAgentProcessStatus(address);

  return {
    address: row.address,
    name: row.name,
    frozen: row.frozen === 1,
    frozenReason: row.frozen_reason,
    frozenAt: row.frozen_at,
    spawnReason: row.spawn_reason,
    shutdownRequested: shutdown.shutdown,
    shutdownReason: shutdown.reason,
    process: tracked ? { status: tracked.status, pid: tracked.pid } : null,
  };
}
