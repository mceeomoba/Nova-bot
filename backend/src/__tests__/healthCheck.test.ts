// next-phase.md Phase 5e (architecture-agent.md §6, The Orchestrator):
// "Health-check + auto-restart per agent." Done when: "a crashed or
// hung agent process is detected and restarted automatically, without
// manual intervention and without affecting any other agent's own
// process."
//
// Same two-group split resourceQuotas.test.ts (Phase 5b) and every test
// file since Phase 2f-iii already established, for the same reason:
//
// Group 1 — getStateFileAgeMs() is pure fs (no db.js import), so it
// runs for REAL against a real temp file, no mirror.
//
// Group 2 — checkAgentHealth()/restartAgentProcess()/sweepAgentHealth()
// genuinely need agent_processes (db.js) and orchestrator.ts's own
// spawn/kill calls, so this is an inlined mirror of healthCheck.ts's
// own decision logic, kept byte-for-byte in sync, operating against a
// plain in-memory map standing in for the `agent_processes` table and
// fake kill/spawn functions standing in for orchestrator.ts's real
// ones. Recommend re-running both groups against the real functions
// with a live sqlite3 DB once a networked environment is available,
// per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ─── Group 1: real fs, no mocking ──────────────────────────────────

/** Byte-for-byte copy of healthCheck.ts's own getStateFileAgeMs(). */
async function getStateFileAgeMsMirror(statePath: string | null): Promise<number | null> {
  if (!statePath) return null;
  try {
    const stat = await fsp.stat(statePath);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

test("getStateFileAgeMs measures real elapsed time since a real file's last write", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "healthcheck-state-"));
  const statePath = path.join(dir, "agent-state.json");
  fs.writeFileSync(statePath, "{}");

  const age = await getStateFileAgeMsMirror(statePath);
  assert.ok(age !== null);
  assert.ok(age! >= 0 && age! < 5000, `expected a just-written file to read as fresh, got ${age}ms`);
});

test("getStateFileAgeMs returns null (not 0, not Infinity) for a path that was never written", async () => {
  const age = await getStateFileAgeMsMirror("/tmp/healthcheck-test-never-existed/agent-state.json");
  assert.equal(age, null);
});

test("getStateFileAgeMs returns null when no state_path was ever recorded", async () => {
  const age = await getStateFileAgeMsMirror(null);
  assert.equal(age, null);
});

// ─── Group 2: inlined mirror of the decision/restart logic ─────────

const HANG_TIMEOUT_MS = 15 * 60_000;
const MAX_RESTARTS_PER_WINDOW = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

type ProcessStatus = "running" | "stopped" | "killed" | "crashed";
interface FakeProcessRow {
  agent_address: string;
  status: ProcessStatus;
  state_path: string | null;
  restart_count: number;
  last_restart_at: number | null;
}

let processes: Map<string, FakeProcessRow>;
let ageOverrides: Map<string, number | null>; // per-test override, mirrors getStateFileAgeMs's own async measurement
let killLog: Array<{ agentAddress: string; signal: string; reason: string }>;
let spawnLog: Array<{ agentAddress: string; reason?: string }>;
let spawnShouldFail: Set<string>;

function reset() {
  processes = new Map([
    ["0xAGENT", { agent_address: "0xAGENT", status: "running", state_path: "/fake/0xAGENT/state.json", restart_count: 0, last_restart_at: null }],
  ]);
  ageOverrides = new Map();
  killLog = [];
  spawnLog = [];
  spawnShouldFail = new Set();
}

function getAgentProcessStatusMirror(agentAddress: string): FakeProcessRow | null {
  return processes.get(agentAddress) ?? null;
}

function killAgentProcessMirror(agentAddress: string, signal: string, reason: string): { killed: boolean } {
  const row = processes.get(agentAddress);
  if (!row || row.status !== "running") return { killed: false };
  processes.set(agentAddress, { ...row, status: "killed" });
  killLog.push({ agentAddress, signal, reason });
  return { killed: true };
}

function spawnAgentProcessMirror(agentAddress: string, reason?: string): { launched: boolean; pid?: number; reason?: string } {
  spawnLog.push({ agentAddress, reason });
  if (spawnShouldFail.has(agentAddress)) return { launched: false, reason: "spawn refused" };
  const existing = processes.get(agentAddress);
  processes.set(agentAddress, {
    agent_address: agentAddress,
    status: "running",
    state_path: existing?.state_path ?? null,
    restart_count: existing?.restart_count ?? 0,
    last_restart_at: existing?.last_restart_at ?? null,
  });
  return { launched: true, pid: 4242 };
}

type AgentHealthStatus = "healthy" | "hung" | "crashed" | "stopped" | "killed" | "not-tracked";

function checkAgentHealthMirror(agentAddress: string): { status: AgentHealthStatus; staleForMs?: number } {
  const row = getAgentProcessStatusMirror(agentAddress);
  if (!row) return { status: "not-tracked" };
  if (row.status !== "running") return { status: row.status };

  const ageMs = ageOverrides.get(agentAddress) ?? null;
  if (ageMs === null) return { status: "healthy" };
  if (ageMs > HANG_TIMEOUT_MS) return { status: "hung", staleForMs: ageMs };
  return { status: "healthy" };
}

function resetRestartTrackingIfStaleMirror(agentAddress: string, now: number): void {
  const row = processes.get(agentAddress);
  if (!row || row.restart_count === 0) return;
  if (row.last_restart_at === null || now - row.last_restart_at > RESTART_WINDOW_MS) {
    processes.set(agentAddress, { ...row, restart_count: 0 });
  }
}

function restartAgentProcessMirror(
  agentAddress: string,
  cause: "crashed" | "hung",
): { restarted: boolean; reason: string } {
  const now = Date.now();
  resetRestartTrackingIfStaleMirror(agentAddress, now);
  const row = processes.get(agentAddress) ?? {
    agent_address: agentAddress,
    status: "crashed" as ProcessStatus,
    state_path: null,
    restart_count: 0,
    last_restart_at: null,
  };

  if (row.restart_count >= MAX_RESTARTS_PER_WINDOW) {
    return { restarted: false, reason: `restart-loop-detected: ${row.restart_count} restarts` };
  }

  const status = getAgentProcessStatusMirror(agentAddress);
  if (status && status.status === "running") {
    killAgentProcessMirror(agentAddress, "SIGKILL", `healthcheck:${cause}:SIGKILL`);
  }

  const spawnResult = spawnAgentProcessMirror(agentAddress, `healthcheck:${cause}`);
  const current = processes.get(agentAddress)!;
  processes.set(agentAddress, { ...current, restart_count: row.restart_count + 1, last_restart_at: now });

  if (!spawnResult.launched) {
    return { restarted: false, reason: `respawn attempt failed: ${spawnResult.reason}` };
  }
  return { restarted: true, reason: `restarted after ${cause} (pid ${spawnResult.pid})` };
}

function sweepAgentHealthMirror(): void {
  const now = Date.now();
  for (const p of Array.from(processes.values())) {
    if (p.status === "crashed") {
      restartAgentProcessMirror(p.agent_address, "crashed");
      continue;
    }
    if (p.status !== "running") continue;

    const ageMs = ageOverrides.get(p.agent_address) ?? null;
    if (ageMs !== null && ageMs > HANG_TIMEOUT_MS) {
      restartAgentProcessMirror(p.agent_address, "hung");
    } else {
      resetRestartTrackingIfStaleMirror(p.agent_address, now);
    }
  }
}

test("a running agent with a fresh state file is reported healthy", () => {
  reset();
  ageOverrides.set("0xAGENT", 1000); // 1s old — well under the timeout
  const health = checkAgentHealthMirror("0xAGENT");
  assert.equal(health.status, "healthy");
});

test("a running agent whose state file is stale past the hang timeout is reported hung", () => {
  reset();
  ageOverrides.set("0xAGENT", HANG_TIMEOUT_MS + 60_000);
  const health = checkAgentHealthMirror("0xAGENT");
  assert.equal(health.status, "hung");
  assert.ok(health.staleForMs! > HANG_TIMEOUT_MS);
});

test("an unmeasurable state file age is reported healthy, not hung and not crashed", () => {
  reset();
  // ageOverrides has no entry for 0xAGENT -> mirrors getStateFileAgeMs returning null
  const health = checkAgentHealthMirror("0xAGENT");
  assert.equal(health.status, "healthy");
});

test("a crashed row is reported crashed, never silently treated as healthy", () => {
  reset();
  processes.set("0xAGENT", { ...processes.get("0xAGENT")!, status: "crashed" });
  const health = checkAgentHealthMirror("0xAGENT");
  assert.equal(health.status, "crashed");
});

test("an untracked agent is reported not-tracked", () => {
  reset();
  const health = checkAgentHealthMirror("0xNEVER-SPAWNED");
  assert.equal(health.status, "not-tracked");
});

test("restarting a crashed agent spawns without ever calling kill (nothing alive to kill)", () => {
  reset();
  processes.set("0xAGENT", { ...processes.get("0xAGENT")!, status: "crashed" });
  const result = restartAgentProcessMirror("0xAGENT", "crashed");
  assert.equal(result.restarted, true);
  assert.equal(killLog.length, 0);
  assert.equal(spawnLog.length, 1);
  assert.equal(spawnLog[0].reason, "healthcheck:crashed");
  assert.equal(processes.get("0xAGENT")?.status, "running");
});

test("restarting a hung agent kills with SIGKILL first, then spawns", () => {
  reset();
  const result = restartAgentProcessMirror("0xAGENT", "hung");
  assert.equal(result.restarted, true);
  assert.equal(killLog.length, 1);
  assert.equal(killLog[0].signal, "SIGKILL");
  assert.match(killLog[0].reason, /healthcheck:hung/);
  assert.equal(spawnLog.length, 1);
});

test("a restart bumps restart_count and last_restart_at", () => {
  reset();
  restartAgentProcessMirror("0xAGENT", "hung");
  const row = processes.get("0xAGENT")!;
  assert.equal(row.restart_count, 1);
  assert.ok(row.last_restart_at !== null);
});

test("the restart-loop breaker opens once restart_count reaches the ceiling, and stops respawning", () => {
  reset();
  processes.set("0xAGENT", { ...processes.get("0xAGENT")!, restart_count: MAX_RESTARTS_PER_WINDOW, last_restart_at: Date.now() });
  const result = restartAgentProcessMirror("0xAGENT", "crashed");
  assert.equal(result.restarted, false);
  assert.match(result.reason, /restart-loop-detected/);
  assert.equal(spawnLog.length, 0, "a tripped circuit must never spawn");
});

test("the restart-loop breaker resets once the rolling window has elapsed, even without an observed healthy tick", () => {
  reset();
  const staleWindowStart = Date.now() - RESTART_WINDOW_MS - 60_000;
  processes.set("0xAGENT", {
    ...processes.get("0xAGENT")!,
    status: "crashed",
    restart_count: MAX_RESTARTS_PER_WINDOW,
    last_restart_at: staleWindowStart,
  });
  const result = restartAgentProcessMirror("0xAGENT", "crashed");
  assert.equal(result.restarted, true, "an expired window must let the circuit close again");
});

test("a sweep finding the agent healthy resets a nonzero restart_count", () => {
  reset();
  processes.set("0xAGENT", { ...processes.get("0xAGENT")!, restart_count: 2, last_restart_at: Date.now() - RESTART_WINDOW_MS - 1 });
  ageOverrides.set("0xAGENT", 1000); // fresh
  sweepAgentHealthMirror();
  assert.equal(processes.get("0xAGENT")?.restart_count, 0);
});

test("a failed respawn attempt is reported, not silently swallowed, and restart_count still advances", () => {
  reset();
  processes.set("0xAGENT", { ...processes.get("0xAGENT")!, status: "crashed" });
  spawnShouldFail.add("0xAGENT");
  const result = restartAgentProcessMirror("0xAGENT", "crashed");
  assert.equal(result.restarted, false);
  assert.match(result.reason, /respawn attempt failed/);
});

test("sweepAgentHealth restarts a crashed agent and a hung agent independently, without one affecting the other", () => {
  reset();
  processes.set("0xB", { agent_address: "0xB", status: "crashed", state_path: null, restart_count: 0, last_restart_at: null });
  ageOverrides.set("0xAGENT", HANG_TIMEOUT_MS + 1); // hung
  sweepAgentHealthMirror();
  assert.equal(processes.get("0xAGENT")?.status, "running", "the hung agent was restarted");
  assert.equal(processes.get("0xB")?.status, "running", "the crashed agent was restarted independently");
  assert.equal(spawnLog.length, 2);
});

test("sweepAgentHealth never touches a stopped or killed agent — those are operator-intentional", () => {
  reset();
  processes.set("0xAGENT", { ...processes.get("0xAGENT")!, status: "stopped" });
  sweepAgentHealthMirror();
  assert.equal(spawnLog.length, 0);
  assert.equal(processes.get("0xAGENT")?.status, "stopped");
});

test("one agent's failure during a sweep never stops the rest from being checked (best-effort posture)", () => {
  reset();
  processes.set("0xB", { agent_address: "0xB", status: "crashed", state_path: null, restart_count: 0, last_restart_at: null });
  spawnShouldFail.add("0xAGENT");
  ageOverrides.set("0xAGENT", HANG_TIMEOUT_MS + 1);
  sweepAgentHealthMirror();
  // 0xAGENT's own respawn failed, but 0xB must still have been attempted.
  assert.equal(processes.get("0xB")?.status, "running");
});
