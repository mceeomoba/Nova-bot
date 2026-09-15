import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { db } from "./db.js";
import { config } from "./config.js";

/**
 * next-phase.md Phase 5a (architecture-agent.md §6, The Orchestrator):
 * "Spawn/kill top-level agents (maps to your `agent-runtime/spawner.ts`)."
 * This file is that spawn/kill authority, replacing the previous model
 * where exactly one agent process ever ran, launched by hand (or by
 * the singleton `automaton-agent.service` systemd unit) with no
 * process-level notion of *which* agent it was beyond whatever env vars
 * happened to be set.
 *
 * Why this lives in backend/src and not backend/agent-runtime/src, even
 * though the architecture doc's own shorthand points at
 * agent-runtime/spawner.ts: architecture-agent.md §6 itself defines the
 * orchestrator as "one level above all of this: something that knows
 * about every top-level agent" — and the only thing in this repo that
 * actually knows about every top-level agent is the backend, via the
 * `agents` table. Any one agent-runtime process is, by construction,
 * only ever aware of itself. spawner.ts's existing spawnChildProcess()
 * is real and stays as-is (see its own doc comment and cloning.ts's
 * module doc for how it relates to the newer clone() architecture) —
 * it is a single running agent forking a child of ITSELF, funded from
 * its own wallet, gated by a per-process fork-bomb cap
 * (MAX_SPAWNS_PER_PROCESS). That is a fundamentally different
 * operation from what this file does: a root-level authority, backed
 * by durable DB state, spawning or killing the OS process for ANY
 * top-level agent this backend already knows about — including one
 * that has never run before (e.g. a Phase 4 clone(), which today gets
 * a wallet/sandbox/office but no process at all — nothing currently
 * starts one). The two mechanisms deliberately stay unreconciled here,
 * same as cloning.ts left them; this phase only replaces the OTHER
 * half of the old model, the singleton systemd unit.
 *
 * Deploy-side plan/reality note (same class of finding as 4c's
 * erc8004Trust.ts and 4d's spawner.ts touch-list mismatches): this
 * phase's own next-phase.md header says "Touches: ... deploy/
 * automaton-agent.service" — but that file's WorkingDirectory
 * (/opt/automaton/agent) governs the vendored automaton-vm
 * package under the repo's root agent/ directory, a pre-existing
 * codebase this next-phase.md build track has never touched (it has
 * its own, unrelated orchestration/orchestrator.ts — a task/goal
 * planner, not a process-lifecycle layer, naming collision only). The
 * singleton unit this phase actually replaces is
 * backend/agent-runtime/automaton-agent.service, the one paired with
 * agent-runtime/spawner.ts and everything Phase 0-4f built. That file
 * is rewritten to a deprecation notice; deploy/automaton-agent.service
 * is left alone as out of scope, same as cloning.ts left the older
 * spawn_clone mechanism alone.
 *
 * Every spawn/kill decision is logged to capability_audit — the same
 * shared audit trail every other capability decision in this backend
 * already logs to (capability.ts's audit()). Reusing it here, not a
 * separate table, is deliberate: Phase 5f's own "Done when" requires
 * its eventual vault-override entry to be "indistinguishable in shape
 * from any other logged decision except its own distinct reason code"
 * — starting orchestrator actions in that same table now means 5f
 * doesn't have to retrofit a second audit path later. caller is always
 * "orchestrator:root" here (there is no delegated caller to resolve —
 * this is root, invoked only via the x-admin-key-gated routes in
 * orchestratorRoutes.ts, never by an agent's own runtime), resourceType
 * "process", resourceId the agent address, decision always "allow"
 * (there's no one to deny; a refusal — e.g. agent not found, or
 * already running — is returned to the caller and logged as its own
 * distinct reason instead of a bare deny).
 */

type ProcessStatus = "running" | "stopped" | "killed" | "crashed";

interface AgentProcessRow {
  agent_address: string;
  pid: number | null;
  status: ProcessStatus;
  log_path: string | null;
  state_path: string | null;
  started_at: number | null;
  stopped_at: number | null;
}

function auditOrchestrator(action: "spawn" | "kill", agentAddress: string, reason: string): void {
  db.prepare(
    `INSERT INTO capability_audit (caller, resource_type, resource_id, action, decision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run("orchestrator:root", "process", agentAddress, action, "allow", reason, Date.now());
}

function getProcessRow(agentAddress: string): AgentProcessRow | undefined {
  return db
    .prepare(`SELECT * FROM agent_processes WHERE agent_address = ?`)
    .get(agentAddress) as AgentProcessRow | undefined;
}

/**
 * True if `pid` is a live OS process. Sending signal 0 doesn't actually
 * signal anything — it's the standard POSIX/Node way to test existence
 * and permission without side effects.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconciles a tracked 'running' row against reality and returns the
 * corrected, current row. A row that claims 'running' but whose pid is
 * no longer alive gets flipped to 'crashed' here rather than trusted —
 * same "verify, don't just trust the row" posture capability.ts's
 * findActiveChannelGrant() already takes toward channel rows. Crash
 * *detection* is this phase's job; automatic *restart* is deliberately
 * left to Phase 5e (health-check + auto-restart), per next-phase.md's
 * own sequencing — this only makes sure the status this backend reports
 * is never a stale lie.
 */
export function getAgentProcessStatus(agentAddress: string): AgentProcessRow | null {
  const row = getProcessRow(agentAddress);
  if (!row) return null;
  if (row.status === "running" && (row.pid === null || !isPidAlive(row.pid))) {
    db.prepare(`UPDATE agent_processes SET status = 'crashed' WHERE agent_address = ?`).run(agentAddress);
    return { ...row, status: "crashed" };
  }
  return row;
}

export function listAgentProcesses(): AgentProcessRow[] {
  const rows = db.prepare(`SELECT agent_address FROM agent_processes`).all() as { agent_address: string }[];
  return rows
    .map((r) => getAgentProcessStatus(r.agent_address))
    .filter((r): r is AgentProcessRow => r !== null);
}

export type SpawnResult =
  | { launched: true; pid: number; logPath: string }
  | { launched: false; reason: string };

/**
 * Spawns a fresh OS process for `agentAddress`, running the compiled
 * `agent/` runtime entrypoint against that agent's own existing identity
 * (AGENT_ADDRESS — see agent/src/index.ts's resume-verification check,
 * added by PHASE-17D-IV/4c: no `agent-runtime` package exists in this
 * repo, and the resume path lives in `agent/`, not "alongside this
 * phase" as this comment previously and incorrectly claimed). Refuses
 * to spawn for an address this backend
 * doesn't know about, an agent marked 'dead' (POST /v1/agents/:address/
 * death), or one that already has a live tracked process — one runtime
 * instance per agent, per this phase's own "Done when" line, not
 * "however many you ask for."
 *
 * `auditReason` (Phase 5e addition, mirroring killAgentProcess's own
 * Phase 5b addition below) lets a non-operator-initiated caller --
 * currently only healthCheck.ts's own restartAgentProcess() -- override
 * the default `operator-initiated` audit reason with its own distinct
 * one (`healthcheck:crashed`, `healthcheck:hung`, and so on), so an
 * automatic restart is never misreported as a human operator action in
 * capability_audit, same reasoning killAgentProcess's own auditReason
 * param already documents.
 */
export function spawnAgentProcess(agentAddress: string, auditReason?: string): SpawnResult {
  const agent = db.prepare(`SELECT * FROM agents WHERE address = ?`).get(agentAddress) as
    | { address: string; name: string | null; parent_address: string | null; status: string }
    | undefined;
  if (!agent) {
    return { launched: false, reason: "no such agent" };
  }
  if (agent.status !== "active") {
    return { launched: false, reason: `agent status is '${agent.status}', not 'active'` };
  }

  const existing = getAgentProcessStatus(agentAddress);
  if (existing && existing.status === "running") {
    return { launched: false, reason: `already running (pid ${existing.pid})` };
  }

  const stateDir = path.join(path.resolve(config.agentProcessDataDir), agentAddress);
  fs.mkdirSync(stateDir, { recursive: true });
  const logPath = path.join(stateDir, "agent.log");
  const statePath = path.join(stateDir, "agent-state.json");
  const logFd = fs.openSync(logPath, "a");

  const entrypoint = path.resolve(config.agentRuntimeDir, "dist", "index.js");
  const cwd = path.resolve(config.agentRuntimeDir);

  // PHASE-17D-IV: AUTOMATON_CONFIG_DIR — one directory per agent
  // address, under the new config.agentIdentityDataDir — so this
  // process resolves its own wallet.json/automaton.json instead of
  // colliding with every other agent this backend has ever spawned on
  // the same host at the shared $HOME/.automaton default. For a
  // pipeline-spawned agent this directory was already populated by
  // genesis.ts's provisionAgentRuntimeIdentity() before genesis; for an
  // agent spawned by other means, something upstream of this call must
  // provision it the same way, or bootstrapAgentRuntime()'s new
  // non-interactive guard (agent/src/index.ts) will throw instead of
  // hanging on the setup wizard. AUTOMATON_NON_INTERACTIVE=1 makes that
  // guard's behavior explicit rather than inferred from `!isTTY` (a
  // detached child's stdin is not a TTY either way, but being explicit
  // here avoids relying on that as the only signal).
  const automatonConfigDir = path.join(path.resolve(config.agentIdentityDataDir), agentAddress);

  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    env: {
      ...process.env,
      AGENT_ADDRESS: agent.address,
      AGENT_NAME: agent.name || agent.address,
      PARENT_ADDRESS: agent.parent_address || undefined,
      GOAL: config.defaultAgentGoal,
      STATE_PATH: statePath,
      AUTOMATON_CONFIG_DIR: automatonConfigDir,
      AUTOMATON_NON_INTERACTIVE: "1",
    },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);

  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_processes (agent_address, pid, status, log_path, state_path, started_at, stopped_at)
     VALUES (?, ?, 'running', ?, ?, ?, NULL)
     ON CONFLICT(agent_address) DO UPDATE SET
       pid = excluded.pid, status = 'running', log_path = excluded.log_path,
       state_path = excluded.state_path, started_at = excluded.started_at, stopped_at = NULL`,
  ).run(agentAddress, child.pid ?? null, logPath, statePath, now);

  auditOrchestrator("spawn", agentAddress, auditReason ?? "operator-initiated");
  return { launched: true, pid: child.pid!, logPath };
}

export type KillResult = { killed: boolean; reason: string };

/**
 * Kills the tracked process for `agentAddress`. Defaults to SIGTERM (the
 * same graceful-shutdown signal automaton-agent.service's own
 * `Restart=on-failure` model relied on) so the agent-runtime process
 * gets a chance to run its own shutdown path rather than being cut off
 * mid-write; pass "SIGKILL" if that has already been tried and failed.
 *
 * `auditReason` (Phase 5b addition) lets a non-operator-initiated
 * caller — currently only resourceQuotas.ts's own enforceResourceQuotas()
 * — override the default `operator-initiated:${signal}` audit reason
 * with its own distinct one (`quota-exceeded:disk,container_cpu:SIGTERM`
 * and so on), so a resource-ceiling kill is never misreported as a
 * human operator action in capability_audit while still landing in the
 * exact same table/shape as one — the same "indistinguishable in shape
 * except its own distinct reason code" posture this file's own module
 * doc already flags Phase 5f's future vault-override entry as needing;
 * this is the first, smaller instance of that same idea.
 */
export function killAgentProcess(
  agentAddress: string,
  signal: NodeJS.Signals = "SIGTERM",
  auditReason?: string,
): KillResult {
  const row = getAgentProcessStatus(agentAddress);
  if (!row) {
    return { killed: false, reason: "no tracked process for this agent" };
  }
  if (row.status !== "running" || row.pid === null) {
    return { killed: false, reason: `not running (status: ${row.status})` };
  }

  try {
    process.kill(row.pid, signal);
  } catch (err: any) {
    return { killed: false, reason: `signal delivery failed: ${err.message}` };
  }

  db.prepare(`UPDATE agent_processes SET status = 'killed', stopped_at = ? WHERE agent_address = ?`).run(
    Date.now(),
    agentAddress,
  );
  auditOrchestrator("kill", agentAddress, auditReason ?? `operator-initiated:${signal}`);
  return { killed: true, reason: `sent ${signal}` };
}

// ─── PHASE-17D-IV / 17E-II rewire: one-shot tick, awaited in-process ──

export interface TickOnceResult {
  /** Process exit code, or null if it never got the chance to exit
   *  (timedOut or crashed both leave this null). */
  exitCode: number | null;
  /** True if timeoutMs elapsed before the process exited — mirrors
   *  execInNamedSandbox()'s own `timedOut` flag, the thing this
   *  replaces as genesisSmokeTest.ts's execution mechanism. */
  timedOut: boolean;
  /** True if spawn() itself could not start the process at all (e.g.
   *  entrypoint missing, no such agent, agent not active) — the
   *  process-based equivalent of dockerode throwing when a target
   *  container isn't running. Never true at the same time as
   *  timedOut. */
  crashed: boolean;
  crashReason: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Runs `automaton --tick-once` for `agentAddress` as a real OS process
 * (via this repo's own agent/ runtime, config.agentRuntimeDir) and
 * resolves once it exits, times out, or fails to launch — genesisSmokeTest.ts's
 * runFirstTickSmokeTest() needs exactly this shape to classify a
 * genesis birth's first tick into passed/timeout/unhandled_error/
 * crashed_process.
 *
 * Deliberately separate from spawnAgentProcess() above rather than a
 * `tickOnce` option bolted onto it: spawnAgentProcess() is built around
 * a long-running, detached, unref()'d background process tracked in
 * agent_processes and capability_audit — exactly wrong for a transient,
 * single-tick call this function needs to synchronously await the
 * result of. This does not write to agent_processes or
 * capability_audit for the same reason the execInNamedSandbox() call it
 * replaces never did either: a smoke-test tick isn't a tracked,
 * killable, ongoing "process" in the orchestrator's own sense.
 *
 * Requires an identity (wallet.json/automaton.json) to already exist at
 * config.agentIdentityDataDir/{agentAddress} — this function does not
 * provision one. See genesis.ts's provisionAgentRuntimeIdentity()
 * (PHASE-17D-IV), which genesisCompany() now calls before a genesis
 * trigger's first tick is ever attempted.
 */
export function spawnAgentProcessTickOnce(
  agentAddress: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<TickOnceResult> {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const agent = db.prepare(`SELECT * FROM agents WHERE address = ?`).get(agentAddress) as
      | { address: string; name: string | null; parent_address: string | null; status: string }
      | undefined;
    if (!agent) {
      resolve({
        exitCode: null,
        timedOut: false,
        crashed: true,
        crashReason: "no such agent",
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    const identityDir = path.join(path.resolve(config.agentIdentityDataDir), agentAddress);
    const entrypoint = path.resolve(config.agentRuntimeDir, "dist", "index.js");
    const cwd = path.resolve(config.agentRuntimeDir);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [entrypoint, "--tick-once"], {
        cwd,
        env: {
          ...process.env,
          AGENT_ADDRESS: agent.address,
          AGENT_NAME: agent.name || agent.address,
          AUTOMATON_CONFIG_DIR: identityDir,
          AUTOMATON_NON_INTERACTIVE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      resolve({
        exitCode: null,
        timedOut: false,
        crashed: true,
        crashReason: err?.message ?? String(err),
        stdout: "",
        stderr: "",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const cap = (buf: string, chunk: Buffer): string => {
      const next = buf + chunk.toString("utf8");
      return next.length > maxOutputBytes ? next.slice(next.length - maxOutputBytes) : next;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = cap(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = cap(stderr, chunk);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited between the timer firing and the kill call
      }
      resolve({
        exitCode: null,
        timedOut: true,
        crashed: false,
        crashReason: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        timedOut: false,
        crashed: true,
        crashReason: err.message,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        timedOut: false,
        crashed: false,
        crashReason: null,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
