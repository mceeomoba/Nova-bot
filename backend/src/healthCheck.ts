import fs from "fs/promises";
import { db } from "./db.js";
import { config } from "./config.js";
import { getAgentProcessStatus, spawnAgentProcess, killAgentProcess, listAgentProcesses } from "./orchestrator.js";
import { runOnScheduleWithLease } from "./scheduler.js";

/**
 * next-phase.md Phase 5e (architecture-agent.md §6, The Orchestrator):
 * "Health-check + auto-restart per agent." Done when: "a crashed or
 * hung agent process is detected and restarted automatically, without
 * manual intervention and without affecting any other agent's own
 * process."
 *
 * Plan-text mismatch found while implementing (same class as every
 * prior sub-phase's own "Touches" correction, e.g. 5a's orchestrator.ts
 * note, 5c's usage-tables note): this phase's own header names
 * `agent-runtime/spawner.ts` and `deploy/automaton-agent.service` as
 * what it touches. Neither is where this belongs, for the same reason
 * 5a's own module doc already gives: the backend is the only thing in
 * this repo that knows about every top-level agent (via the
 * `agent_processes` table 5a itself introduced) — any one agent-runtime
 * process only ever knows about itself, so it cannot detect, let alone
 * act on, another agent's hang or crash. `deploy/automaton-agent.service`
 * governs the unrelated vendored `automaton-vm` package under root
 * `agent/`, same out-of-scope finding 5a's own doc already made about
 * that same file. This file (`backend/src/healthCheck.ts`) is the real
 * home, built the same way 5b/5c built on top of 5a: it never spawns or
 * kills a process directly, only *decides*, then hands the actual act
 * off to orchestrator.ts's existing `killAgentProcess()`/
 * `spawnAgentProcess()` — the same decide-then-act split
 * resourceQuotas.ts already established. Neither `agent-runtime/
 * spawner.ts` nor `deploy/automaton-agent.service` is touched by this
 * phase at all.
 *
 * Two distinct failure modes, two distinct detection strategies:
 *
 *  - crashed: already detected for free. `getAgentProcessStatus()`
 *    (orchestrator.ts, Phase 5a) reconciles a 'running' row against a
 *    real pid-liveness probe on every read and flips it to 'crashed' the
 *    moment the OS process is actually gone — that file's own module doc
 *    already says as much ("Crash *detection* is this phase's job;
 *    automatic *restart* is deliberately left to Phase 5e"). This file
 *    adds the other half: actually restarting a row found crashed.
 *
 *  - hung: a process whose pid is still alive (so orchestrator.ts's own
 *    reconciliation reports 'running') but which has stopped making
 *    real progress — wedged on a network call with no timeout, deadlocked,
 *    spinning. No heartbeat/liveness *protocol* exists between
 *    agent-runtime and the backend today, and this phase deliberately
 *    doesn't add one (a new push channel is exactly the kind of new
 *    wiring the "plan-text mismatch" note above says this phase doesn't
 *    need) — instead this reuses a signal that already exists for free:
 *    `agent_processes.state_path`, the file agent-runtime's own
 *    `saveState()` (state.ts) writes to at boot and after every
 *    completed iteration. A process that's still genuinely working
 *    keeps that file's mtime moving; one that's stuck doesn't. This is
 *    the exact same "walk real files on disk, no new agent-runtime code"
 *    posture resourceQuotas.ts's own `getDiskUsageMb()` already takes
 *    toward disk quota — same reasoning, same shape, applied to a
 *    different question.
 *
 * Crash-loop protection: naively restarting on every sweep tick would
 * turn one agent that crashes on boot (bad GOAL, corrupted state file,
 * $0 balance — see agent-runtime/src/index.ts's own exit(1) paths) into
 * an infinite respawn loop, burning a process-spawn and a log-open every
 * 60s forever. `restart_count`/`last_restart_at` (new agent_processes
 * columns, db.ts) track "consecutive restarts without an intervening
 * healthy tick" per agent; once an agent hits
 * `config.agentMaxRestartsPerWindow` restarts inside
 * `config.agentRestartWindowMs`, its circuit opens — this sweep leaves it
 * crashed/hung rather than respawning it again, for an operator to look
 * at via the existing `POST /admin/orchestrator/:address/spawn` route.
 * The counter resets to 0 the moment a later sweep finds the agent
 * genuinely healthy (running, state file fresh) — see
 * `resetRestartTrackingIfHealthy()` — and also resets once
 * `last_restart_at` itself falls outside the rolling window even absent
 * an observed healthy tick, so a circuit that opened once doesn't stay
 * open forever purely because the agent never got the chance to prove
 * itself healthy again (e.g. an operator leaves it crashed on purpose
 * for a while, then wants auto-restart to resume without a manual reset).
 */

export type AgentHealthStatus = "healthy" | "hung" | "crashed" | "stopped" | "killed" | "not-tracked";

export interface AgentHealthResult {
  status: AgentHealthStatus;
  /** Only set when status is 'hung' — how long the state file has gone unmodified. */
  staleForMs?: number;
}

/**
 * Age (in ms) of `statePath`'s own mtime, or null if it can't be
 * measured (no path recorded, file doesn't exist yet — e.g. the boot
 * race between spawnAgentProcess() creating the process and
 * agent-runtime's own first saveState() call, permission error). A null
 * reading is a "leave this alone this sweep" signal, never treated as 0
 * (which would make every fresh spawn look instantly hung) or as
 * Infinity (which would make a permanently-unreadable file "always
 * hung") — same convention getDiskUsageMb() (resourceQuotas.ts)
 * already established for its own unmeasurable case.
 */
export async function getStateFileAgeMs(statePath: string | null): Promise<number | null> {
  if (!statePath) return null;
  try {
    const stat = await fs.stat(statePath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Read-only: combines orchestrator.ts's own crash-reconciled status with
 * this file's own hang check. Never mutates anything, never restarts —
 * see restartAgentProcess() below for the decide-then-act split every
 * other Phase 5 sub-phase already uses.
 */
export async function checkAgentHealth(agentAddress: string): Promise<AgentHealthResult> {
  const row = getAgentProcessStatus(agentAddress);
  if (!row) return { status: "not-tracked" };
  if (row.status !== "running") return { status: row.status };

  const ageMs = await getStateFileAgeMs(row.state_path);
  if (ageMs === null) return { status: "healthy" }; // unmeasurable this pass — see module doc
  if (ageMs > config.agentHangTimeoutMs) return { status: "hung", staleForMs: ageMs };
  return { status: "healthy" };
}

interface RestartTrackingRow {
  restart_count: number;
  last_restart_at: number | null;
}

function getRestartTracking(agentAddress: string): RestartTrackingRow {
  const row = db
    .prepare(`SELECT restart_count, last_restart_at FROM agent_processes WHERE agent_address = ?`)
    .get(agentAddress) as RestartTrackingRow | undefined;
  return row ?? { restart_count: 0, last_restart_at: null };
}

function recordRestartAttempt(agentAddress: string, newCount: number, now: number): void {
  db.prepare(`UPDATE agent_processes SET restart_count = ?, last_restart_at = ? WHERE agent_address = ?`).run(
    newCount,
    now,
    agentAddress,
  );
}

/**
 * Resets a row's restart_count to 0 once it's no longer relevant —
 * either because a sweep just found the agent genuinely healthy again,
 * or because the rolling restart window has simply elapsed. A no-op
 * (never issues an UPDATE) when the count is already 0, so a
 * consistently healthy agent doesn't pay a write every sweep tick.
 */
function resetRestartTrackingIfStale(agentAddress: string, now: number): void {
  const tracking = getRestartTracking(agentAddress);
  if (tracking.restart_count === 0) return;
  if (tracking.last_restart_at === null || now - tracking.last_restart_at > config.agentRestartWindowMs) {
    db.prepare(`UPDATE agent_processes SET restart_count = 0 WHERE agent_address = ?`).run(agentAddress);
  }
}

export type RestartResult =
  | { restarted: true; reason: string }
  | { restarted: false; reason: string };

/**
 * Restarts `agentAddress`'s process because it was found `cause`
 * ('crashed' or 'hung'). Decide (circuit-breaker check) then act (kill
 * if still running, then spawn) — same division orchestrator.ts's own
 * spawnAgentProcess()/killAgentProcess() already keep separate from
 * every caller's own decision logic.
 *
 * A hung process is killed with SIGKILL, not the SIGTERM-first default
 * killAgentProcess() itself uses and resourceQuotas.ts's own
 * enforceResourceQuotas() deliberately prefers: SIGTERM's whole point is
 * giving a live, responsive process a chance to flush state before
 * exiting, but "responsive enough to act on a graceful-shutdown signal"
 * is exactly the thing a hang means is no longer true here — waiting out
 * a SIGTERM that a genuinely wedged process will never act on just
 * delays the restart this phase's own "Done when" line asks for. A
 * crashed row has no live pid at all (that's what "crashed" already
 * means, per getAgentProcessStatus()'s own reconciliation) — nothing to
 * kill, so this skips straight to spawning.
 */
export async function restartAgentProcess(
  agentAddress: string,
  cause: "crashed" | "hung",
): Promise<RestartResult> {
  const now = Date.now();
  resetRestartTrackingIfStale(agentAddress, now);
  const tracking = getRestartTracking(agentAddress);

  if (tracking.restart_count >= config.agentMaxRestartsPerWindow) {
    return {
      restarted: false,
      reason: `restart-loop-detected: ${tracking.restart_count} restarts within ${config.agentRestartWindowMs}ms — auto-restart circuit open, needs an operator`,
    };
  }

  const status = getAgentProcessStatus(agentAddress);
  if (status && status.status === "running") {
    killAgentProcess(agentAddress, "SIGKILL", `healthcheck:${cause}:SIGKILL`);
    await waitForExit(status.pid);
  }

  const spawnResult = spawnAgentProcess(agentAddress, `healthcheck:${cause}`);
  recordRestartAttempt(agentAddress, tracking.restart_count + 1, now);

  if (!spawnResult.launched) {
    return { restarted: false, reason: `respawn attempt failed: ${spawnResult.reason}` };
  }
  return { restarted: true, reason: `restarted after ${cause} (pid ${spawnResult.pid})` };
}

/** Wait briefly for the OS to reap a killed child before respawning it. */
async function waitForExit(pid: number | null): Promise<void> {
  if (pid === null) return;
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Best-effort sweep across every agent this backend currently tracks a
 * process row for — same "one bad agent must never stop the rest" shape
 * resourceQuotas.ts's own sweepResourceQuotas() and departments.ts's own
 * sweepExpiredTempWorkers() already use. Only 'crashed' and 'hung' are
 * ever auto-restarted; 'stopped' and 'killed' are left alone on purpose
 * — those are the two statuses an operator (or a quota enforcement)
 * deliberately produced (see orchestratorRoutes.ts's own /kill route,
 * resourceQuotas.ts's own enforceResourceQuotas()), and resurrecting an
 * intentionally-stopped agent behind that decision-maker's back would be
 * exactly the kind of silent authority-creep §6's own "use sparingly"
 * framing warns against elsewhere in this file's sibling modules.
 */
export async function sweepAgentHealth(): Promise<void> {
  const now = Date.now();
  for (const p of listAgentProcesses()) {
    try {
      if (p.status === "crashed") {
        await restartAgentProcess(p.agent_address, "crashed");
        continue;
      }
      if (p.status !== "running") continue; // stopped/killed — operator-intentional, leave alone

      const ageMs = await getStateFileAgeMs(p.state_path);
      if (ageMs !== null && ageMs > config.agentHangTimeoutMs) {
        await restartAgentProcess(p.agent_address, "hung");
      } else {
        resetRestartTrackingIfStale(p.agent_address, now);
      }
    } catch {
      // best-effort — one agent's health check must never stop the sweep
      // from checking the rest.
    }
  }
}

// next-phase.md Phase 5e: registered on scheduler.ts's own lease-guarded
// runner (Phase 5d), not a bare setInterval — by the time this phase was
// built, that general primitive already existed, so there's no reason
// for a brand-new sweep to reintroduce the single-in-process-timer
// limitation 5d's own module doc describes departments.ts's TTL sweep as
// having started with. leaseMs generous relative to intervalMs for the
// same reason departments.ts's own ttl_reaper registration already
// gives: a sweep that's merely slow (many agents checked in one pass)
// must never be mistaken for a crashed one and have its lease stolen
// mid-run.
runOnScheduleWithLease({
  name: "health_check",
  intervalMs: 60_000,
  leaseMs: 5 * 60_000,
  fn: sweepAgentHealth,
});
