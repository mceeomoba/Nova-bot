import express from "express";
import fs from "fs/promises";
import path from "path";
import { config } from "./config.js";
import { db } from "./db.js";
import {
  execInNamedSandbox,
  createNamedSandbox,
  deleteNamedSandbox,
  setSandboxNetwork,
} from "./docker.js";
import { exposePort as exposePortImpl, removePort as removePortImpl, listExposedPorts } from "./portProxy.js";
import { ensureOffice, safeOfficePath } from "./office.js";
import { checkCapability, requireOwnedSandbox } from "./capability.js";
import crypto from "crypto";

const router = express.Router();

fs.mkdir(config.vmWorkdir, { recursive: true }).catch(() => {});

/**
 * next-phase.md Phase 0 follow-up: "migrate /vm/exec's no-sandboxId path
 * off the shared container." Previously, an agent that never called
 * POST /vm/sandboxes ran its *commands* (as opposed to file I/O, which
 * Phase 0 already scoped) in one container shared across every such
 * agent on the box — a real isolation gap even though file reads/writes
 * were already correctly scoped to office/workspace.
 *
 * This gives every agent a deterministic, lazily-created "default"
 * named sandbox (id = `sbx-default-{agentAddress}`) the first time it
 * calls /vm/exec (or, since ptyService.ts also imports this, /vm/pty)
 * without an explicit sandboxId, reusing the exact same
 * createNamedSandbox() + sandboxes-table bookkeeping POST /vm/sandboxes
 * already uses — so the default sandbox is a real row, counts against
 * the agent's maxSandboxesPerAgent quota, shows up in GET /vm/sandboxes,
 * and can be deleted like any other. Exported (not module-private)
 * specifically so ptyService.ts can reuse it instead of duplicating this
 * logic with its own copy that could drift.
 *
 * No remaining callers of the shared, unscoped ensureSandboxContainer()
 * in docker.ts from either vmService.ts or ptyService.ts — index.ts's
 * startup call is the only one left, and it's a harmless warm-up/health
 * check, not a per-request path.
 */
export async function getOrCreateDefaultSandbox(agentAddress: string): Promise<string> {
  const id = `sbx-default-${agentAddress}`;
  const row = db
    .prepare(`SELECT status, network_enabled FROM sandboxes WHERE id = ?`)
    .get(id) as { status: string; network_enabled: number } | undefined;
  if (row && row.status !== "deleted") {
    // next-phase.md Phase 9f-i (Founder request): every top-level Agent
    // should have internet in its own sandbox, including one created
    // before this change under the old network-disabled-by-default
    // posture. Upgrade in place rather than only applying the new
    // default to brand-new sandboxes — best-effort: a Docker error here
    // must never break an otherwise-working /vm/exec call, so this is
    // fire-and-forget with the existing sandbox id still returned even
    // if the upgrade attempt itself fails.
    if (config.defaultAgentSandboxNetwork && row.network_enabled === 0) {
      try {
        await setSandboxNetwork(id, true);
        db.prepare(`UPDATE sandboxes SET network_enabled = 1 WHERE id = ?`).run(id);
      } catch {
        // best-effort upgrade — leave the sandbox as-is, try again next call
      }
    }
    return id;
  }

  // Doesn't exist yet (or was deleted) — create it. Runs the same
  // quota/office/createNamedSandbox path as POST /vm/sandboxes, just
  // with a fixed id and modest default size instead of caller-chosen
  // ones, since nothing has explicitly asked for a sized sandbox here.
  const activeCount = (
    db
      .prepare(`SELECT COUNT(*) as n FROM sandboxes WHERE agent_address = ? AND status != 'deleted'`)
      .get(agentAddress) as { n: number }
  ).n;
  if (activeCount >= config.maxSandboxesPerAgent) {
    throw Object.assign(
      new Error(`sandbox limit reached (${config.maxSandboxesPerAgent} per agent) — cannot create default sandbox`),
      { status: 403 },
    );
  }

  const vcpu = 1;
  const memoryMb = config.minSandboxMemoryMb;
  const diskGb = 1;

  const wantsNetwork = config.defaultAgentSandboxNetwork;

  db.prepare(
    `INSERT INTO sandboxes (id, agent_address, status, vcpu, memory_mb, disk_gb, network_enabled, created_at)
     VALUES (?, ?, 'creating', ?, ?, ?, ?, ?)`,
  ).run(id, agentAddress, vcpu, memoryMb, diskGb, wantsNetwork ? 1 : 0, Date.now());

  await ensureOffice(agentAddress);
  await createNamedSandbox(id, { vcpu, memoryMb, diskGb, agentAddress, network: wantsNetwork });

  db.prepare(`UPDATE sandboxes SET status = 'running' WHERE id = ?`).run(id);
  return id;
}

/**
 * next-phase.md Phase 2g, second pass (architecture-agent.md §4g): the
 * generalized sibling of getOrCreateDefaultSandbox above, for a
 * department's or a project's own dedicated environment rather than a
 * whole top-level agent's. Same lazy-create-if-missing shape, same
 * office-fs/browser-profile bind mount (via createNamedSandbox), same
 * hardening profile — the only real differences are the id convention
 * (`sbx-{kind}-{scopeId}`, kind/scope_id recorded on the row itself, see
 * db.ts's migration) and a SEPARATE quota pool
 * (config.maxEnvironmentSandboxesPerAgent, not maxSandboxesPerAgent —
 * see config.ts's own comment on why these must stay independent).
 *
 * `scopeId` must already be filesystem/Docker-name-safe by the time it
 * gets here — callers (environment.ts) are responsible for building it
 * from already-validated pieces (a department id, always `dept_[hex]`;
 * a project id, always matched against departments.ts's own
 * isValidProjectId() before ever reaching this far) rather than this
 * function re-validating a free-form string.
 */
export async function getOrCreateScopedSandbox(
  agentAddress: string,
  kind: "department" | "project",
  scopeId: string,
  // next-phase.md Phase 9f-i (Founder request): unlike getOrCreateDefaultSandbox
  // above, department/project environments do NOT get network by
  // default — the owning Agent must explicitly opt one in
  // (create_department's wantsNetwork flag, or a later
  // POST /departments/:id/network call), and departments.ts is
  // responsible for refusing that opt-in outright for a hardened
  // department type (see toolRegistry.ts's
  // HARDENED_NETWORK_DEPARTMENT_TYPES) before this function is ever
  // called with `true`. This function itself has no notion of
  // department roles — it trusts whatever its caller already decided.
  wantsNetwork: boolean = false,
): Promise<string> {
  const id = `sbx-${kind}-${scopeId}`;
  const row = db
    .prepare(`SELECT status FROM sandboxes WHERE id = ?`)
    .get(id) as { status: string } | undefined;
  if (row && row.status !== "deleted") return id;

  const activeCount = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM sandboxes WHERE agent_address = ? AND kind IN ('department', 'project') AND status != 'deleted'`,
      )
      .get(agentAddress) as { n: number }
  ).n;
  if (activeCount >= config.maxEnvironmentSandboxesPerAgent) {
    throw Object.assign(
      new Error(
        `environment-sandbox limit reached (${config.maxEnvironmentSandboxesPerAgent} per agent) — cannot provision ${kind} environment for ${scopeId}`,
      ),
      { status: 403 },
    );
  }

  const vcpu = 1;
  const memoryMb = config.minSandboxMemoryMb;
  const diskGb = 1;

  db.prepare(
    `INSERT INTO sandboxes (id, agent_address, status, vcpu, memory_mb, disk_gb, network_enabled, created_at, kind, scope_id)
     VALUES (?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, agentAddress, vcpu, memoryMb, diskGb, wantsNetwork ? 1 : 0, Date.now(), kind, scopeId);

  await ensureOffice(agentAddress);
  // Deliberately still binds THIS agent's own office/fs (same as every
  // sandbox this agent has ever had, per architecture-agent.md §4/§4a:
  // "sub-resources of A's office, not new offices") — a department/
  // project environment is a new CONTAINER (execution/resource
  // isolation), never a new filesystem. Workers under this department/
  // project keep staging files into the exact same workspace/ every
  // other route already reads/writes.
  await createNamedSandbox(id, { vcpu, memoryMb, diskGb, agentAddress, network: wantsNetwork });

  db.prepare(`UPDATE sandboxes SET status = 'running' WHERE id = ?`).run(id);
  return id;
}

/**
 * next-phase.md Phase 9f-i: toggles network access on an already-
 * provisioned department/project environment (POST
 * /departments/:id/network's real implementation) — the recreate-in-
 * place mirror of setSandboxNetwork's own doc comment in docker.ts.
 * Callers are responsible for the hardening check (a hardened
 * department type must never reach this function with `wantsNetwork:
 * true` — see toolRegistry.ts's HARDENED_NETWORK_DEPARTMENT_TYPES) and
 * for confirming the environment actually exists first
 * (getDepartmentEnvironmentId/getOwnedDepartment) — this function only
 * flips the switch and updates the DB row to match.
 */
export async function setScopedSandboxNetwork(
  kind: "department" | "project",
  scopeId: string,
  wantsNetwork: boolean,
): Promise<void> {
  const id = `sbx-${kind}-${scopeId}`;
  const row = db
    .prepare(`SELECT status FROM sandboxes WHERE id = ?`)
    .get(id) as { status: string } | undefined;
  if (!row || row.status === "deleted") {
    throw Object.assign(new Error(`no ${kind} environment provisioned for ${scopeId}`), {
      status: 404,
    });
  }
  await setSandboxNetwork(id, wantsNetwork);
  db.prepare(`UPDATE sandboxes SET network_enabled = ? WHERE id = ?`).run(wantsNetwork ? 1 : 0, id);
}

/** Read-only: is a given department/project environment's sandbox
 *  currently network-enabled? Returns false (not an error) if the
 *  environment doesn't exist yet — same "no environment = nothing to
 *  report" posture getDepartmentEnvironmentId() (environment.ts)
 *  already takes for its own null case. */
export function isScopedSandboxNetworkEnabled(kind: "department" | "project", scopeId: string): boolean {
  const id = `sbx-${kind}-${scopeId}`;
  const row = db
    .prepare(`SELECT network_enabled, status FROM sandboxes WHERE id = ?`)
    .get(id) as { network_enabled: number; status: string } | undefined;
  if (!row || row.status === "deleted") return false;
  return row.network_enabled === 1;
}

/** Best-effort teardown of a department/project environment. Never
 *  throws — matches the "a knowledge/session-cleanup failure must never
 *  block the teardown that already happened" pattern departments.ts's
 *  own PTY-close calls already use throughout. No-op if the environment
 *  was never provisioned (a pre-Phase-2g department, or a project that
 *  never actually burst any temp workers). */
export async function deleteScopedSandboxIfExists(
  kind: "department" | "project",
  scopeId: string,
): Promise<void> {
  const id = `sbx-${kind}-${scopeId}`;
  const row = db
    .prepare(`SELECT status FROM sandboxes WHERE id = ?`)
    .get(id) as { status: string } | undefined;
  if (!row || row.status === "deleted") return;
  try {
    await deleteNamedSandbox(id);
  } catch {
    // container may already be gone (crash, manual docker rm, ...) —
    // still mark the row deleted below so quota/lookups reflect reality.
  }
  db.prepare(`UPDATE sandboxes SET status = 'deleted', deleted_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

// POST /vm/exec  { agentAddress, command, args: [], sandboxId? }
// Runs inside the hardened container (see docker.ts), never on the host directly.
// Without sandboxId: that agent's own lazily-created default sandbox
// (see getOrCreateDefaultSandbox above) — no longer the old cross-agent
// shared container.
// With sandboxId: that agent's isolated sandbox, created via POST /vm/sandboxes.
router.post("/exec", async (req, res) => {
  const { agentAddress, command, args = [], sandboxId } = req.body;
  if (!agentAddress || !command) {
    return res.status(400).json({ error: "agentAddress and command required" });
  }

  if (
    config.vmAllowedCommands.length > 0 &&
    !config.vmAllowedCommands.includes(command)
  ) {
    return res.status(403).json({ error: `command not allowed: ${command}` });
  }

  const start = Date.now();
  try {
    const targetSandboxId = sandboxId ?? (await getOrCreateDefaultSandbox(agentAddress));
    if (sandboxId) requireOwnedSandbox(sandboxId, agentAddress);

    const result = await execInNamedSandbox(
      targetSandboxId,
      command,
      args,
      config.execTimeoutMs,
      config.execMaxOutputBytes,
    );
    const seconds = (Date.now() - start) / 1000;

    db.prepare(
      `INSERT INTO usage_log (agent_address, service, units, cost_usdc, created_at)
       VALUES (?, 'vm', ?, '0', ?)`,
    ).run(agentAddress, seconds, Date.now());

    db.prepare(
      `INSERT INTO exec_log (agent_address, command, args, exit_code, timed_out, seconds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agentAddress,
      command,
      JSON.stringify(args),
      result.exitCode,
      result.timedOut ? 1 : 0,
      seconds,
      Date.now(),
    );

    res.json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      seconds,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /vm/file/write  { path, content, agentAddress, sandboxId? }
// Writes into the calling agent's own office/workspace (see office.ts),
// which is the SAME directory bind-mounted into every one of that
// agent's sandboxes as /workspace — no need to shell into the container
// for file I/O. sandboxId, if given, is only used to confirm ownership
// of that specific sandbox; it no longer changes which directory this
// writes into, since all of one agent's sandboxes share one office.
router.post("/file/write", async (req, res) => {
  try {
    const { path: relPath, content, agentAddress, sandboxId } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    if (sandboxId) requireOwnedSandbox(sandboxId, agentAddress);
    // office_path's owner is always the agentId prefix of resourceId
    // (see capability.ts), so caller === agentAddress always allows
    // here — safeOfficePath() below is what actually prevents escaping
    // this agent's own workspace regardless. This call exists so every
    // disk-touching route is logged through the one audit trail, per
    // architecture-agent.md §8, not because there's a real cross-agent
    // case to deny yet (that's Phase 3's job, once channels exist).
    checkCapability({
      caller: agentAddress,
      resourceType: "office_path",
      resourceId: `${agentAddress}:${relPath}`,
      action: "write",
    });

    await ensureOffice(agentAddress);
    const target = safeOfficePath(agentAddress, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// GET /vm/file/read?path=...&agentAddress=...&sandboxId=...
router.get("/file/read", async (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const sandboxId = req.query.sandboxId ? String(req.query.sandboxId) : undefined;
    if (sandboxId) requireOwnedSandbox(sandboxId, agentAddress);
    const relPath = String(req.query.path);
    checkCapability({
      caller: agentAddress,
      resourceType: "office_path",
      resourceId: `${agentAddress}:${relPath}`,
      action: "read",
    });

    await ensureOffice(agentAddress);
    const target = safeOfficePath(agentAddress, relPath);
    const content = await fs.readFile(target, "utf8");
    res.json({ content });
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// GET /vm/office/manifest?agentAddress=...
// Introspection stub for the get_manifest() call in architecture-agent.md
// §7. Only ever returns the caller's own manifest — there is no
// cross-agent lookup here yet (that's Phase 8's job, once §8's
// capability check exists to decide what a non-owner is allowed to see).
router.get("/office/manifest", async (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const manifest = await ensureOffice(agentAddress);
    res.json(manifest);
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ─── Multi-sandbox management ──────────────────────────────────────

// POST /vm/sandboxes  { agentAddress, vcpu, memoryMb, diskGb, exposedPorts?: number[] }
router.post("/sandboxes", async (req, res) => {
  try {
    const { agentAddress, vcpu = 1, memoryMb = 512, diskGb = 5, exposedPorts = [] } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });

    const activeCount = (
      db
        .prepare(`SELECT COUNT(*) as n FROM sandboxes WHERE agent_address = ? AND status != 'deleted'`)
        .get(agentAddress) as { n: number }
    ).n;
    if (activeCount >= config.maxSandboxesPerAgent) {
      return res.status(403).json({
        error: `sandbox limit reached (${config.maxSandboxesPerAgent} per agent)`,
      });
    }
    if (vcpu < 1 || vcpu > config.maxSandboxVcpu) {
      return res.status(400).json({ error: `vcpu must be between 1 and ${config.maxSandboxVcpu}` });
    }
    if (memoryMb < config.minSandboxMemoryMb || memoryMb > config.maxSandboxMemoryMb) {
      return res.status(400).json({
        error: `memoryMb must be between ${config.minSandboxMemoryMb} and ${config.maxSandboxMemoryMb}`,
      });
    }
    if (diskGb < 1 || diskGb > config.maxSandboxDiskGb) {
      return res.status(400).json({ error: `diskGb must be between 1 and ${config.maxSandboxDiskGb}` });
    }
    if (exposedPorts.length > config.maxExposedPortsPerSandbox) {
      return res.status(400).json({
        error: `at most ${config.maxExposedPortsPerSandbox} exposed ports per sandbox`,
      });
    }

    const id = `sbx-${crypto.randomBytes(6).toString("hex")}`;
    db.prepare(
      `INSERT INTO sandboxes (id, agent_address, status, vcpu, memory_mb, disk_gb, network_enabled, created_at)
       VALUES (?, ?, 'creating', ?, ?, ?, ?, ?)`,
    ).run(id, agentAddress, vcpu, memoryMb, diskGb, exposedPorts.length > 0 ? 1 : 0, Date.now());

    // Phase 0: every sandbox binds that agent's own office/fs + browser
    // profile (architecture-agent.md §1/§2a) — never a flat, id-keyed
    // scratch dir. ensureOffice() is idempotent, so this is a no-op for
    // an agent that already has one from a prior sandbox or from wallet
    // creation (see wallet.ts's createAgentWallet).
    await ensureOffice(agentAddress);
    await createNamedSandbox(id, {
      vcpu,
      memoryMb,
      diskGb,
      agentAddress,
      exposedContainerPorts: exposedPorts,
    });

    db.prepare(`UPDATE sandboxes SET status = 'running' WHERE id = ?`).run(id);

    res.json({ id, status: "running", vcpu, memoryMb, diskGb, region: "self-hosted" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /vm/sandboxes?agentAddress=...
router.get("/sandboxes", (req, res) => {
  const agentAddress = String(req.query.agentAddress || "");
  const rows = db
    .prepare(`SELECT * FROM sandboxes WHERE agent_address = ? AND status != 'deleted'`)
    .all(agentAddress) as Array<any>;
  res.json(
    rows.map((r) => ({
      id: r.id,
      status: r.status,
      vcpu: r.vcpu,
      memoryMb: r.memory_mb,
      diskGb: r.disk_gb,
      region: r.region,
    })),
  );
});

// DELETE /vm/sandboxes/:id  { agentAddress }
router.delete("/sandboxes/:id", async (req, res) => {
  try {
    const { agentAddress } = req.body;
    requireOwnedSandbox(req.params.id, agentAddress);
    await deleteNamedSandbox(req.params.id);
    db.prepare(`UPDATE sandboxes SET status = 'deleted', deleted_at = ? WHERE id = ?`).run(
      Date.now(),
      req.params.id,
    );
    db.prepare(`DELETE FROM exposed_ports WHERE sandbox_id = ?`).run(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Ports ──────────────────────────────────────────────────────────

// POST /vm/sandboxes/:id/ports  { agentAddress, containerPort }
router.post("/sandboxes/:id/ports", async (req, res) => {
  try {
    const { agentAddress, containerPort } = req.body;
    requireOwnedSandbox(req.params.id, agentAddress);
    const result = await exposePortImpl(req.params.id, agentAddress, containerPort);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /vm/sandboxes/:id/ports/:containerPort  { agentAddress }
router.delete("/sandboxes/:id/ports/:containerPort", (req, res) => {
  try {
    const { agentAddress } = req.body;
    requireOwnedSandbox(req.params.id, agentAddress);
    removePortImpl(req.params.id, Number(req.params.containerPort));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /vm/ports?agentAddress=...
router.get("/ports", (req, res) => {
  res.json(listExposedPorts(String(req.query.agentAddress || "")));
});

export default router;
