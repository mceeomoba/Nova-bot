// next-phase.md Phase 5a (architecture-agent.md §6, The Orchestrator):
// top-level per-agent process spawn/kill, replacing the singleton
// automaton-agent.service model. Covers: refusing to spawn for an
// unknown or 'dead' agent, refusing a second spawn while one is already
// tracked as running, status reconciliation flipping a stale 'running'
// row to 'crashed' when its pid is no longer alive (never trusting the
// row blindly), kill only succeeding against a genuinely running row,
// and every spawn/kill decision landing in the same audit trail
// capability.ts's own checkCapability() already writes to — see
// orchestrator.ts's own module doc for why that reuse is deliberate.
//
// Same constraint every prior backend/src test file in this repo has
// flagged: orchestrator.ts imports db.js (better-sqlite3) and
// child_process.spawn, neither of which this sandboxed test harness can
// exercise for real (no network to install better-sqlite3; no interest
// in actually forking node processes from a test run). What's tested
// below is an inlined mirror of orchestrator.ts's exact decision logic
// — spawnAgentProcess()/killAgentProcess()/getAgentProcessStatus(), in
// the same order, with the same fail-closed refusals — kept
// byte-for-byte in sync with orchestrator.ts as of this phase,
// operating against a plain in-memory map standing in for the
// agent_processes table and a fake pid-liveness probe standing in for
// process.kill(pid, 0), same shape cloning-verification.test.ts already
// established for capability.ts. Recommend re-running against the real
// functions with a live sqlite3 DB (and real child processes) once a
// networked environment is available, per every prior phase's own
// standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Inlined mirror of orchestrator.ts, as of this phase ──────────────

type ProcessStatus = "running" | "stopped" | "killed" | "crashed";

interface AgentRow {
  address: string;
  status: "active" | "dead";
}

interface AgentProcessRow {
  agent_address: string;
  pid: number | null;
  status: ProcessStatus;
  started_at: number | null;
  stopped_at: number | null;
}

let agents: AgentRow[];
let processes: Map<string, AgentProcessRow>;
let livePids: Set<number>;
let auditLog: Array<{ caller: string; resourceType: string; resourceId: string; action: string; reason: string }>;
let nextPid: number;

function reset() {
  agents = [
    { address: "0xFOUNDER", status: "active" },
    { address: "0xCLONE-1", status: "active" },
    { address: "0xDEAD-1", status: "dead" },
  ];
  processes = new Map();
  livePids = new Set();
  auditLog = [];
  nextPid = 1000;
}

function auditOrchestrator(action: "spawn" | "kill", agentAddress: string, reason: string): void {
  auditLog.push({ caller: "orchestrator:root", resourceType: "process", resourceId: agentAddress, action, reason });
}

function isPidAlive(pid: number): boolean {
  return livePids.has(pid);
}

function getAgentProcessStatus(agentAddress: string): AgentProcessRow | null {
  const row = processes.get(agentAddress);
  if (!row) return null;
  if (row.status === "running" && (row.pid === null || !isPidAlive(row.pid))) {
    const crashed: AgentProcessRow = { ...row, status: "crashed" };
    processes.set(agentAddress, crashed);
    return crashed;
  }
  return row;
}

type SpawnResult = { launched: true; pid: number } | { launched: false; reason: string };

function spawnAgentProcess(agentAddress: string): SpawnResult {
  const agent = agents.find((a) => a.address === agentAddress);
  if (!agent) return { launched: false, reason: "no such agent" };
  if (agent.status !== "active") return { launched: false, reason: `agent status is '${agent.status}', not 'active'` };

  const existing = getAgentProcessStatus(agentAddress);
  if (existing && existing.status === "running") {
    return { launched: false, reason: `already running (pid ${existing.pid})` };
  }

  const pid = nextPid++;
  livePids.add(pid);
  processes.set(agentAddress, {
    agent_address: agentAddress,
    pid,
    status: "running",
    started_at: Date.now(),
    stopped_at: null,
  });
  auditOrchestrator("spawn", agentAddress, "operator-initiated");
  return { launched: true, pid };
}

type KillResult = { killed: boolean; reason: string };

function killAgentProcess(agentAddress: string, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): KillResult {
  const row = getAgentProcessStatus(agentAddress);
  if (!row) return { killed: false, reason: "no tracked process for this agent" };
  if (row.status !== "running" || row.pid === null) {
    return { killed: false, reason: `not running (status: ${row.status})` };
  }
  livePids.delete(row.pid);
  processes.set(agentAddress, { ...row, status: "killed", stopped_at: Date.now() });
  auditOrchestrator("kill", agentAddress, `operator-initiated:${signal}`);
  return { killed: true, reason: `sent ${signal}` };
}

// ─── Tests ─────────────────────────────────────────────────────────────

test("refuses to spawn for an agent address the backend doesn't know about", () => {
  reset();
  const result = spawnAgentProcess("0xNOBODY");
  assert.equal(result.launched, false);
  assert.match((result as { reason: string }).reason, /no such agent/);
});

test("refuses to spawn for an agent marked dead", () => {
  reset();
  const result = spawnAgentProcess("0xDEAD-1");
  assert.equal(result.launched, false);
  assert.match((result as { reason: string }).reason, /not 'active'/);
});

test("spawns successfully for an active, previously-never-run agent (e.g. a fresh clone)", () => {
  reset();
  const result = spawnAgentProcess("0xCLONE-1");
  assert.equal(result.launched, true);
  const status = getAgentProcessStatus("0xCLONE-1");
  assert.equal(status?.status, "running");
});

test("refuses a second spawn while one is already tracked as running — one instance per agent", () => {
  reset();
  const first = spawnAgentProcess("0xFOUNDER");
  assert.equal(first.launched, true);
  const second = spawnAgentProcess("0xFOUNDER");
  assert.equal(second.launched, false);
  assert.match((second as { reason: string }).reason, /already running/);
});

test("a respawn after a clean kill succeeds (killed status doesn't block future spawns)", () => {
  reset();
  spawnAgentProcess("0xFOUNDER");
  killAgentProcess("0xFOUNDER");
  const respawn = spawnAgentProcess("0xFOUNDER");
  assert.equal(respawn.launched, true);
});

test("status reconciliation: a row claiming 'running' whose pid has died reports 'crashed', not a stale lie", () => {
  reset();
  const spawned = spawnAgentProcess("0xFOUNDER");
  assert.equal(spawned.launched, true);
  // Simulate the OS process dying without going through killAgentProcess
  // (a real crash) — the tracked row still says 'running' until read.
  livePids.delete((spawned as { pid: number }).pid);
  const status = getAgentProcessStatus("0xFOUNDER");
  assert.equal(status?.status, "crashed");
});

test("a crashed agent can be spawned again — crashed is not treated as still-running", () => {
  reset();
  const spawned = spawnAgentProcess("0xCLONE-1");
  livePids.delete((spawned as { pid: number }).pid);
  const respawn = spawnAgentProcess("0xCLONE-1");
  assert.equal(respawn.launched, true);
});

test("kill only succeeds against a genuinely running row", () => {
  reset();
  const neverSpawned = killAgentProcess("0xFOUNDER");
  assert.equal(neverSpawned.killed, false);
  assert.match(neverSpawned.reason, /no tracked process/);

  spawnAgentProcess("0xFOUNDER");
  killAgentProcess("0xFOUNDER");
  const doubleKill = killAgentProcess("0xFOUNDER");
  assert.equal(doubleKill.killed, false);
  assert.match(doubleKill.reason, /not running/);
});

test("every spawn and kill decision lands in the shared audit trail, one entry each", () => {
  reset();
  spawnAgentProcess("0xFOUNDER");
  killAgentProcess("0xFOUNDER", "SIGKILL");
  assert.equal(auditLog.length, 2);
  assert.equal(auditLog[0].action, "spawn");
  assert.equal(auditLog[0].caller, "orchestrator:root");
  assert.equal(auditLog[0].resourceType, "process");
  assert.equal(auditLog[1].action, "kill");
  assert.match(auditLog[1].reason, /SIGKILL/);
  // A failed spawn/kill attempt (agent unknown, already running, not
  // running, etc.) is returned to the caller directly and does NOT get
  // its own audit row here — only decisions the orchestrator actually
  // carried out do, same as capability.ts only audits an actual
  // allow/deny check, not a malformed request.
  spawnAgentProcess("0xNOBODY");
  assert.equal(auditLog.length, 2);
});
