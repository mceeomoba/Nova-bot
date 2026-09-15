import Docker from "dockerode";
import { config } from "./config.js";
import { getOrCreateDefaultSandbox } from "./vmService.js";
import { db } from "./db.js";
import { revokeGrantsBySession } from "./toolGrants.js";

/**
 * Interactive PTY sessions.
 *
 * next-phase.md Phase 0 follow-up: "migrate /vm/pty off the shared
 * container." Previously every agent's PTY session ran in one
 * container (ensureSandboxContainer()) shared across every agent on
 * the box — the same isolation gap /vm/exec had before its own fix,
 * just for interactive sessions instead of one-shot commands. Now each
 * session runs `docker exec` against that agent's own sandbox
 * (getOrCreateDefaultSandbox() from vmService.ts, or an explicit
 * sandboxId — same shape as /vm/exec), so two agents' terminals never
 * share a container, filesystem, process namespace, or resource limits.
 *
 * Same hardening as /vm/exec either way: no network by default, dropped
 * caps, read-only rootfs, resource limits — those live on the sandbox
 * container itself (docker.ts), not here. Unlike /vm/exec, a PTY
 * session stays alive across multiple HTTP calls: create once,
 * write/read many times, close when done. State lives in this
 * process's memory only — a backend restart drops all sessions, which
 * is intentional (nothing about a REPL session is meant to survive
 * that).
 */

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

interface PtySession {
  id: string;
  agentAddress: string;
  sandboxId: string;
  command: string;
  cols: number;
  rows: number;
  state: "running" | "exited" | "closed";
  createdAt: number;
  lastActivityAt: number;
  exec: Docker.Exec;
  stream: NodeJS.ReadWriteStream;
  buffer: string;
  exitCode: number | null;
}

const MAX_SCROLLBACK_BYTES = 200_000;
const MAX_SESSIONS_PER_AGENT = config.maxPtySessionsPerAgent ?? 3;
const IDLE_TIMEOUT_MS = config.ptyIdleTimeoutMs ?? 10 * 60 * 1000; // 10 min default

const sessions = new Map<string, PtySession>();

function newSessionId(): string {
  return "pty_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function sessionsForAgent(agentAddress: string): PtySession[] {
  return [...sessions.values()].filter((s) => s.agentAddress === agentAddress && s.state === "running");
}

/**
 * next-phase.md Phase 2: a worker's PTY session is created with
 * session.agentAddress = the worker's own id (wkr_xx), not its owner's
 * address — see subagents.ts's POST /:id/pty, which intentionally keys
 * sessions per-thread so two workers (or a worker and its owner) never
 * collide. But the owner's runtime is the one actually driving that
 * session turn by turn via the plain pty_write/pty_read/pty_close tools
 * (architecture-agent.md §4: "[the parent's] runtime is the scheduler"),
 * and those tools only ever send the OWNER's agentAddress, never the
 * worker's id — the model never sees or handles a worker's raw id as if
 * it were its own address. So a session lookup here has to accept
 * either an exact match (the normal top-level-agent-driving-its-own-
 * session case) OR a caller that owns the session's agent as a sub-agent
 * thread (sub_agents.owner_address — same relationship capability.ts's
 * isSubagentOf() already encodes, checked directly against the table
 * here rather than importing capability.ts, to avoid coupling this
 * module's hot read/write path to the audit-logging checkCapability()
 * wrapper for a check this cheap).
 */
function callerControlsSession(session: PtySession, callerAddress: string): boolean {
  if (session.agentAddress === callerAddress) return true;
  const row = db
    .prepare(`SELECT 1 FROM sub_agents WHERE id = ? AND owner_address = ? AND status = 'running'`)
    .get(session.agentAddress, callerAddress);
  return !!row;
}

/** Periodic sweep: close sessions nobody has touched in IDLE_TIMEOUT_MS. */
setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const s of sessions.values()) {
    if (s.state === "running" && s.lastActivityAt < cutoff) {
      closeSession(s.id).catch(() => {});
    }
  }
}, 60_000).unref();

export async function createSession(
  agentAddress: string,
  command: string,
  cols = 80,
  rows = 24,
  sandboxId?: string,
): Promise<{ id: string } | { error: string }> {
  if (sessionsForAgent(agentAddress).length >= MAX_SESSIONS_PER_AGENT) {
    return { error: `max concurrent PTY sessions (${MAX_SESSIONS_PER_AGENT}) reached for this agent` };
  }

  // No explicit sandboxId: lazily give this agent its own default
  // sandbox (same one /vm/exec falls back to), not the old cross-agent
  // shared container. If sandboxId IS given, the caller (ptyRouter) is
  // responsible for having already confirmed it belongs to this agent
  // via requireOwnedSandbox — mirrors how /vm/exec's sandboxId path works.
  const resolvedSandboxId = sandboxId ?? (await getOrCreateDefaultSandbox(agentAddress));

  const container = docker.getContainer(resolvedSandboxId);
  const exec = await container.exec({
    Cmd: [command],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    WorkingDir: "/workspace",
  });

  const stream = await exec.start({ hijack: true, stdin: true, Tty: true } as any);

  const id = newSessionId();
  const session: PtySession = {
    id,
    agentAddress,
    sandboxId: resolvedSandboxId,
    command,
    cols,
    rows,
    state: "running",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    exec,
    stream: stream as any,
    buffer: "",
    exitCode: null,
  };

  stream.on("data", (chunk: Buffer) => {
    session.buffer += chunk.toString("utf8");
    if (session.buffer.length > MAX_SCROLLBACK_BYTES) {
      session.buffer = session.buffer.slice(session.buffer.length - MAX_SCROLLBACK_BYTES);
    }
  });

  stream.on("end", async () => {
    session.state = "exited";
    try {
      const inspectResult = await exec.inspect();
      session.exitCode = inspectResult.ExitCode ?? null;
    } catch {
      // container may already be gone; leave exitCode null
    }
  });

  try {
    await exec.resize({ h: rows, w: cols });
  } catch {
    // resize is best-effort; some docker versions race with exec start
  }

  sessions.set(id, session);
  return { id };
}

export function writeToSession(agentAddress: string, id: string, input: string): { ok: true } | { error: string } {
  const session = sessions.get(id);
  if (!session || !callerControlsSession(session, agentAddress)) return { error: "session not found" };
  if (session.state !== "running") return { error: `session is ${session.state}, cannot write` };

  session.lastActivityAt = Date.now();
  (session.stream as any).write(input);
  return { ok: true };
}

export function readFromSession(
  agentAddress: string,
  id: string,
  full = false,
): { output: string; state: string; exitCode: number | null } | { error: string } {
  const session = sessions.get(id);
  if (!session || !callerControlsSession(session, agentAddress)) return { error: "session not found" };

  session.lastActivityAt = Date.now();
  const output = full ? session.buffer : session.buffer.slice(-4000);
  return { output, state: session.state, exitCode: session.exitCode };
}

/**
 * next-phase.md Phase 2i(d): the single session-close path every real
 * trigger in this codebase already funnels through — an explicit
 * /kill, the idle-timeout sweep above, and retireProjectSequence()'s
 * own step 4/5 (departments.ts) — so hooking grant revocation in here,
 * once, covers "a session-lifecycle grant is revoked when its
 * PTY/browser session ends" for every one of those callers without
 * needing a separate hook wired into each. Fires even when the session
 * was already `exited` (a process that finished on its own, not yet
 * explicitly closed) — the grant tied to it is just as dead either way.
 * Runs AFTER the session is actually torn down, not before, so a
 * failure in the stream cleanup above never leaves a grant revoked for
 * a session that's still technically alive.
 */
export async function closeSession(id: string, agentAddress?: string): Promise<{ ok: true } | { error: string }> {
  const session = sessions.get(id);
  if (!session) return { error: "session not found" };
  if (agentAddress && !callerControlsSession(session, agentAddress)) return { error: "session not found" };

  try {
    (session.stream as any).end?.();
    (session.stream as any).destroy?.();
  } catch {
    // best-effort
  }
  session.state = "closed";
  sessions.delete(id);
  try {
    revokeGrantsBySession(id);
  } catch {
    // best-effort, same "a cleanup/archival failure must never block a
    // teardown that already happened" reasoning every prior phase's
    // retirement code in this repo already follows — the session is
    // already gone above regardless of whether this revoke succeeds.
  }
  return { ok: true };
}

export function listSessions(agentAddress: string) {
  return sessionsForAgent(agentAddress).map((s) => ({
    id: s.id,
    sandboxId: s.sandboxId,
    command: s.command,
    state: s.state,
    createdAt: s.createdAt,
    cols: s.cols,
    rows: s.rows,
  }));
}

/**
 * next-phase.md Phase 2 crash isolation: lets subagents.ts check whether
 * a specific PTY session has exited without needing its own copy of the
 * sessions map, and without ptyService.ts needing to know what a
 * "sub-agent" is. Returns null for a session this process has never
 * heard of (already closed/reaped, or simply invalid) — callers should
 * treat that the same as "not running" rather than erroring, since a
 * session that's fully gone is at least as dead as one that's "exited".
 */
export function getSessionState(id: string): "running" | "exited" | "closed" | null {
  return sessions.get(id)?.state ?? null;
}
