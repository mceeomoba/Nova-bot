// next-phase.md Phase 5b (architecture-agent.md §6, The Orchestrator):
// hard resource ceilings per office — disk quota, container CPU/mem
// commitment, spend-rate cap — pulled from manifest.json (backfilled by
// office.ts's ensureResourceQuota(), same one-time-then-authoritative
// pattern Phase 2a/2b's ensureDepartmentQuota() already established)
// and enforced by resourceQuotas.ts on top of Phase 5a's own
// orchestrator.ts spawn/kill authority.
//
// Same two-group split cloning-config.test.ts established for exactly
// this reason, and for the same reason here:
//
// Group 1 — office.ts's own ensureResourceQuota() has NO dependency on
// better-sqlite3/dockerode (only config.ts, satisfiable with plain env
// vars) — run for REAL against a real temp filesystem, no mirror.
// getDiskUsageMb() is pure fs too, but lives in resourceQuotas.ts,
// which — unlike office.ts — imports db.js (better-sqlite3, unbuildable
// here, no network to npm install it) purely for its OTHER exports
// (getContainerCommitment/getSpendRateUsdc). Rather than let one
// db-dependent import block testing a function that itself never
// touches the DB, this group runs a byte-for-byte inlined copy of
// getDiskUsageMb's own walk() against the SAME real temp filesystem —
// still a real fs exercise, not a fake in-memory mock, just not
// imported from the module directly.
//
// Group 2 — checkResourceQuotas()/enforceResourceQuotas()/
// sweepResourceQuotas() genuinely need sandboxes/usage_log (db.js) and
// orchestrator.ts's own process table/kill call, so — same posture
// orchestrator.test.ts's own module doc already explains — this is an
// inlined mirror of resourceQuotas.ts's exact decision logic, kept
// byte-for-byte in sync, operating against plain in-memory arrays
// standing in for the `sandboxes`/`usage_log`/`agent_processes` tables
// and a fake killAgentProcess() standing in for orchestrator.ts's real
// one. Recommend re-running both groups against the real functions
// with a live sqlite3 DB once a networked environment is available to
// `npm install better-sqlite3`, per every prior phase's own standing
// note.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ─── Group 1: real fs, real office.ts, no mocking ──────────────────

const OFFICES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "resource-quotas-offices-"));

process.env.BACKEND_API_KEY ||= "test";
process.env.ADMIN_API_KEY ||= "test";
process.env.OPENROUTER_API_KEY ||= "test";
process.env.FACILITATOR_PRIVATE_KEY ||= ("0x" + "1".repeat(64)) as string;
process.env.OFFICES_DIR = OFFICES_ROOT;
process.env.MAX_SANDBOX_DISK_GB = "20";
process.env.MAX_SANDBOX_VCPU = "4";
process.env.MAX_SANDBOX_MEMORY_MB = "8192";

// See this file's own header for why office.ts is imported directly
// (real, no mirror) while resourceQuotas.ts's own getDiskUsageMb is
// mirrored inline below instead of imported.
const office = (await import("../office.js")) as typeof import("../office.js");

/** Byte-for-byte copy of resourceQuotas.ts's getDiskUsageMb — kept in
 *  sync with that file as of this phase. Pure fs, no db.js import, so
 *  it can run for real here without pulling in better-sqlite3. */
async function getDiskUsageMbMirror(agentId: string): Promise<number | null> {
  async function walk(dir: string): Promise<number> {
    let total = 0;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        total += await walk(full);
      } else if (entry.isFile()) {
        const st = await fsp.stat(full);
        total += st.size;
      }
    }
    return total;
  }
  try {
    const bytes = await walk(office.agentDir(agentId));
    return bytes / (1024 * 1024);
  } catch {
    return null;
  }
}

test("ensureResourceQuota backfills the three Phase 5b fields from config, once", async () => {
  const result = await office.ensureResourceQuota("0xquota-a");
  assert.equal(result.max_disk_mb, 20 * 1024);
  assert.equal(result.max_container_cpu_cores, 4);
  assert.equal(result.max_container_memory_mb, 8192);

  const manifest = await office.readManifest("0xquota-a");
  assert.equal(manifest?.quota.max_disk_mb, 20 * 1024);
});

test("ensureResourceQuota never overwrites an operator-edited manifest value", async () => {
  await office.ensureResourceQuota("0xquota-b");
  const manifest = await office.readManifest("0xquota-b");
  assert.ok(manifest);
  manifest!.quota.max_disk_mb = 999;
  await office.writeManifest("0xquota-b", manifest!);

  const second = await office.ensureResourceQuota("0xquota-b");
  assert.equal(second.max_disk_mb, 999, "an existing non-null value must be left alone");
});

test("ensureOffice's Phase 5b fields start null until ensureResourceQuota backfills them", async () => {
  await office.ensureOffice("0xquota-c");
  const manifest = await office.readManifest("0xquota-c");
  assert.equal(manifest?.quota.max_disk_mb, null);
  assert.equal(manifest?.quota.max_container_cpu_cores, null);
  assert.equal(manifest?.quota.max_container_memory_mb, null);
});

test("getDiskUsageMb measures real bytes written under an agent's own office tree", async () => {
  await office.ensureOffice("0xquota-disk");
  const workspaceFile = path.join(office.officeWorkspaceDir("0xquota-disk"), "big.bin");
  fs.writeFileSync(workspaceFile, Buffer.alloc(2 * 1024 * 1024)); // 2MB

  const mb = await getDiskUsageMbMirror("0xquota-disk");
  assert.ok(mb !== null);
  assert.ok(mb! >= 2, `expected at least 2MB measured, got ${mb}`);
});

test("getDiskUsageMb returns null (not 0, not Infinity) for an agent whose office was never created", async () => {
  const mb = await getDiskUsageMbMirror("0xquota-never-existed");
  assert.equal(mb, null);
});

// ─── Group 2: inlined mirror of the decision/enforcement logic ─────

type QuotaResource = "disk" | "container_cpu" | "container_memory" | "inference_spend" | "marketplace_spend";
interface QuotaViolation {
  resource: QuotaResource;
  limit: number;
  actual: number;
}

interface FakeManifestQuota {
  max_disk_mb: number;
  max_container_cpu_cores: number;
  max_container_memory_mb: number;
  max_inference_spend_usdc_per_day: number;
  max_marketplace_spend_usdc_per_day: number;
}

interface FakeSandboxRow {
  agent_address: string;
  status: string;
  vcpu: number;
  memory_mb: number;
}

interface FakeUsageLogRow {
  agent_address: string;
  service: string;
  cost_usdc: number;
  created_at: number;
}

interface FakeProcessRow {
  agent_address: string;
  status: "running" | "stopped" | "killed" | "crashed";
}

let manifests: Map<string, FakeManifestQuota>;
let sandboxes: FakeSandboxRow[];
let usageLog: FakeUsageLogRow[];
let processes: Map<string, FakeProcessRow>;
let killLog: Array<{ agentAddress: string; signal: string; reason: string }>;
let diskUsageMb: Map<string, number | null>; // per-test override, mirrors getDiskUsageMb's own async measurement

function reset() {
  manifests = new Map([
    [
      "0xFOUNDER",
      {
        max_disk_mb: 100,
        max_container_cpu_cores: 4,
        max_container_memory_mb: 8192,
        max_inference_spend_usdc_per_day: 2,
        max_marketplace_spend_usdc_per_day: 5,
      },
    ],
  ]);
  sandboxes = [];
  usageLog = [];
  processes = new Map([["0xFOUNDER", { agent_address: "0xFOUNDER", status: "running" }]]);
  killLog = [];
  diskUsageMb = new Map([["0xFOUNDER", 0]]);
}

function getContainerCommitmentMirror(agentId: string): { cpuCores: number; memoryMb: number } {
  const rows = sandboxes.filter((s) => s.agent_address === agentId && s.status === "running");
  return {
    cpuCores: rows.reduce((sum, r) => sum + r.vcpu, 0),
    memoryMb: rows.reduce((sum, r) => sum + r.memory_mb, 0),
  };
}

function getSpendRateUsdcMirror(agentId: string, service: string, windowMs: number): number {
  const since = Date.now() - windowMs;
  return usageLog
    .filter((r) => r.agent_address === agentId && r.service === service && r.created_at >= since)
    .reduce((sum, r) => sum + r.cost_usdc, 0);
}

const SPEND_WINDOW_MS = 24 * 3_600_000;

function checkResourceQuotasMirror(agentId: string): { ok: boolean; violations: QuotaViolation[] } {
  const quota = manifests.get(agentId);
  const violations: QuotaViolation[] = [];
  if (!quota) return { ok: true, violations };

  const diskMb = diskUsageMb.get(agentId) ?? null;
  if (diskMb !== null && diskMb > quota.max_disk_mb) {
    violations.push({ resource: "disk", limit: quota.max_disk_mb, actual: diskMb });
  }

  const commitment = getContainerCommitmentMirror(agentId);
  if (commitment.cpuCores > quota.max_container_cpu_cores) {
    violations.push({ resource: "container_cpu", limit: quota.max_container_cpu_cores, actual: commitment.cpuCores });
  }
  if (commitment.memoryMb > quota.max_container_memory_mb) {
    violations.push({
      resource: "container_memory",
      limit: quota.max_container_memory_mb,
      actual: commitment.memoryMb,
    });
  }

  const inferenceSpend = getSpendRateUsdcMirror(agentId, "inference", SPEND_WINDOW_MS);
  if (inferenceSpend > quota.max_inference_spend_usdc_per_day) {
    violations.push({ resource: "inference_spend", limit: quota.max_inference_spend_usdc_per_day, actual: inferenceSpend });
  }
  const marketplaceSpend = getSpendRateUsdcMirror(agentId, "marketplace", SPEND_WINDOW_MS);
  if (marketplaceSpend > quota.max_marketplace_spend_usdc_per_day) {
    violations.push({
      resource: "marketplace_spend",
      limit: quota.max_marketplace_spend_usdc_per_day,
      actual: marketplaceSpend,
    });
  }

  return { ok: violations.length === 0, violations };
}

function killAgentProcessMirror(agentId: string, signal: string, reason: string): { killed: boolean } {
  const row = processes.get(agentId);
  if (!row || row.status !== "running") return { killed: false };
  processes.set(agentId, { ...row, status: "killed" });
  killLog.push({ agentAddress: agentId, signal, reason });
  return { killed: true };
}

function enforceResourceQuotasMirror(agentId: string): { enforced: boolean; violations: QuotaViolation[] } {
  const { ok, violations } = checkResourceQuotasMirror(agentId);
  if (ok) return { enforced: false, violations };

  const row = processes.get(agentId);
  if (!row || row.status !== "running") return { enforced: false, violations };

  const reasonCode = `quota-exceeded:${violations.map((v) => v.resource).join(",")}`;
  killAgentProcessMirror(agentId, "SIGTERM", `${reasonCode}:SIGTERM`);
  return { enforced: true, violations };
}

test("an agent within every one of its own ceilings is reported ok, nothing killed", () => {
  reset();
  const result = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
  const enforcement = enforceResourceQuotasMirror("0xFOUNDER");
  assert.equal(enforcement.enforced, false);
  assert.equal(killLog.length, 0);
});

test("disk over ceiling is detected and, with a running process, gets killed", () => {
  reset();
  diskUsageMb.set("0xFOUNDER", 150); // ceiling is 100
  const check = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(check.ok, false);
  assert.equal(check.violations[0].resource, "disk");

  const enforcement = enforceResourceQuotasMirror("0xFOUNDER");
  assert.equal(enforcement.enforced, true);
  assert.equal(killLog.length, 1);
  assert.match(killLog[0].reason, /quota-exceeded:disk/);
  assert.equal(processes.get("0xFOUNDER")?.status, "killed");
});

test("aggregate container commitment across MULTIPLE running sandboxes can trip the ceiling even if no single sandbox does", () => {
  reset();
  // Ceiling is 4 cores / 8192MB. Three sandboxes at ~1.5 cores/3000MB
  // each are each individually far under a single-sandbox cap, but
  // together exceed the agent's own aggregate ceiling.
  sandboxes.push(
    { agent_address: "0xFOUNDER", status: "running", vcpu: 1.5, memory_mb: 3000 },
    { agent_address: "0xFOUNDER", status: "running", vcpu: 1.5, memory_mb: 3000 },
    { agent_address: "0xFOUNDER", status: "running", vcpu: 1.5, memory_mb: 3000 },
  );
  const check = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(check.ok, false);
  const resources = check.violations.map((v) => v.resource);
  assert.ok(resources.includes("container_cpu"));
  assert.ok(resources.includes("container_memory"));
});

test("a stopped sandbox never counts toward the running commitment", () => {
  reset();
  sandboxes.push({ agent_address: "0xFOUNDER", status: "stopped", vcpu: 100, memory_mb: 100000 });
  const check = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(check.ok, true);
});

test("spend-rate: inference and marketplace are checked independently against their own manifest ceilings", () => {
  reset();
  const now = Date.now();
  usageLog.push({ agent_address: "0xFOUNDER", service: "inference", cost_usdc: 3, created_at: now }); // > 2 ceiling
  const check = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(check.ok, false);
  assert.equal(check.violations[0].resource, "inference_spend");

  reset();
  usageLog.push({ agent_address: "0xFOUNDER", service: "marketplace", cost_usdc: 6, created_at: now }); // > 5 ceiling
  const check2 = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(check2.violations[0].resource, "marketplace_spend");
});

test("spend from outside the rolling 24h window doesn't count", () => {
  reset();
  const staleTs = Date.now() - 25 * 3_600_000; // 25h ago — outside the 24h window
  usageLog.push({ agent_address: "0xFOUNDER", service: "inference", cost_usdc: 999, created_at: staleTs });
  const check = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(check.ok, true);
});

test("a violation with no running process to act on is reported but not silently dropped, and nothing is killed", () => {
  reset();
  processes.set("0xFOUNDER", { agent_address: "0xFOUNDER", status: "crashed" });
  diskUsageMb.set("0xFOUNDER", 150);
  const enforcement = enforceResourceQuotasMirror("0xFOUNDER");
  assert.equal(enforcement.enforced, false);
  assert.equal(enforcement.violations.length, 1, "the violation itself is still reported");
  assert.equal(killLog.length, 0);
});

test("a null (unmeasurable) disk reading is skipped, never treated as 0 or as an automatic violation", () => {
  reset();
  diskUsageMb.set("0xFOUNDER", null);
  const check = checkResourceQuotasMirror("0xFOUNDER");
  assert.equal(check.ok, true);
});

test("an enforced kill always uses SIGTERM first, never jumps straight to SIGKILL", () => {
  reset();
  diskUsageMb.set("0xFOUNDER", 150);
  enforceResourceQuotasMirror("0xFOUNDER");
  assert.equal(killLog.length, 1);
  assert.equal(killLog[0].signal, "SIGTERM");
});

test("an agent this backend has no manifest for at all is never flagged (nothing to compare against)", () => {
  reset();
  const check = checkResourceQuotasMirror("0xUNKNOWN-NO-MANIFEST");
  assert.equal(check.ok, true);
  assert.equal(check.violations.length, 0);
});
