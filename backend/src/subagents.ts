import express from "express";
import crypto from "crypto";
import { config } from "./config.js";
import { db } from "./db.js";
import { checkCapability, isSubagentOf, assertCanSpawnSubAgents } from "./capability.js";
import { getOrCreateDefaultSandbox } from "./vmService.js";
import { resolveEnvironmentForSubAgent } from "./environment.js";
import * as pty from "./ptyService.js";
import { attachSessionToGrants, revokeGrantsByTask } from "./toolGrants.js";

/**
 * next-phase.md Phase 2 (architecture-agent.md §4): "Sub-agents = threads,
 * not processes."
 *
 * A worker created here is NOT a new agent in the agents table — it gets
 * no wallet, no ERC-8004 identity, no office of its own, no row in
 * `sandboxes`. It's a thread under an existing agent's (the "owner")
 * office, tracked in the `sub_agents` table (db.ts), sharing:
 *   - the owner's office/workspace (workers stage results there directly
 *     — no separate mount, no copy step)
 *   - the owner's wallet-via-oracle (a worker never calls /wallet/* with
 *     its own address; only the owner's runtime does, after reading a
 *     worker's staged output — see "Parent's runtime is the scheduler"
 *     below)
 *   - the owner's default sandbox, but its OWN PTY session inside it
 *     (ptyService.ts, tagged with this worker's id) and its OWN browser
 *     tab (daemon-script.ts's per-tab Map, tabId = worker id) — so two
 *     workers under the same owner never collide with each other or
 *     with the owner's own top-level PTY/browser session.
 *
 * Parent's runtime is the scheduler: only the OWNER's own agentAddress
 * can spawn, list, or kill its workers here — a worker's own id is never
 * accepted as the `agentAddress` on these routes. This intentionally
 * mirrors architecture-agent.md §4's "only [the parent] can act
 * externally... workers stage results into workspace/ for [the parent]
 * to act on" — a worker never becomes a distinct caller that other
 * capability-checked routes (wallet.pay, a future channel send) would
 * accept, it can only act *through* the owner's own agentAddress.
 * capability.ts's isSubagentOf() exists for the resources a worker's own
 * exec/PTY/browser-tab plumbing needs internally (see ptyRoutes.ts /
 * vmService.ts once those are updated to accept a subagent caller on the
 * owner's sandbox) — it is not a way for a worker to drive these
 * spawn/list/kill routes as itself.
 *
 * Phase 2a (architecture-agent.md §4a) adds departments as a Tier-2 hop
 * on top of everything above (see new departments.ts): a Tier-3 worker
 * spawned under a department is still just a `kind = 'worker'` row in
 * this exact table, still driven through these exact routes — the only
 * difference is its owner_address is the department's id rather than
 * the top-level agent's, so getOwnedWorker() below now resolves
 * ownership transitively (direct match OR isSubagentOf(), which climbs
 * that one extra hop) instead of a flat equality check.
 *
 * next-phase.md Phase 2d (architecture-agent.md §4c, Reasoning section):
 * a Worker having "no planning tools at all — task in, result out" was
 * always true of the tool surface exposed here (spawn_subagent et al.
 * are simply never granted to a wkr_xx caller, and assertCanSpawnSubAgents
 * — capability.ts — structurally denies a worker's own id from spawning
 * anything further). §4c makes explicit that this is a *reasoning-scope*
 * boundary, not merely a side effect of the spawn-depth cap: a Worker's
 * context is meant to contain only its own bounded task, never a
 * planning loop of its own, regardless of whether the depth cap happens
 * to be the mechanism currently doing the enforcing. Nothing in this
 * file changes as a result — this is a documentation lock, confirming
 * (not introducing) the boundary, same as Phase 2c's confirmation pass
 * over architecture-agent.md's own terminology.
 */

const router = express.Router();

function newWorkerId(): string {
  return "wkr_" + crypto.randomBytes(5).toString("hex");
}

/**
 * Crash isolation (architecture-agent.md §4: "a worker's terminal/
 * browser crashing kills that worker, not [the owner]"). A worker's PTY
 * session can exit on its own (the command finished, or the process
 * died) without the owner's runtime ever calling POST .../result or
 * .../kill — left alone, that row would sit at status 'running' forever
 * even though isSubagentOf() would keep granting it capability it can
 * no longer meaningfully use (its session is gone). This sweep is the
 * cheap fix: any 'running' worker whose pty_session_id no longer
 * reports "running" (exited, closed, or ptyService has no memory of it
 * at all — same as "closed" for this purpose) gets marked 'failed', so
 * isSubagentOf() stops granting it anything on the very next check.
 * Intentionally does NOT touch a worker with no pty_session_id yet
 * (spawned but never given a session) — that's still legitimately
 * "running", just not started.
 */
function sweepCrashedWorkers(): void {
  const running = db
    .prepare(`SELECT id, pty_session_id FROM sub_agents WHERE status = 'running' AND pty_session_id IS NOT NULL`)
    .all() as { id: string; pty_session_id: string }[];
  for (const w of running) {
    const state = pty.getSessionState(w.pty_session_id);
    if (state === "running") continue;
    db.prepare(
      `UPDATE sub_agents SET status = 'failed', error = ?, ended_at = ? WHERE id = ? AND status = 'running'`,
    ).run(
      state === null ? "pty session no longer exists (crashed or reaped)" : `pty session ${state}`,
      Date.now(),
      w.id,
    );
  }
}

setInterval(sweepCrashedWorkers, 60_000).unref();

// Phase 2a: filtered to kind = 'worker' so a department (also a
// sub_agents row owned directly by this same agentAddress, see
// departments.ts) never eats into the flat maxSubagentsPerOwner cap —
// departments have their own separate ceiling (manifest.quota.
// max_departments, enforced in departments.ts).
function activeCountFor(ownerAddress: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM sub_agents WHERE owner_address = ? AND kind = 'worker' AND status = 'running'`,
      )
      .get(ownerAddress) as { n: number }
  ).n;
}

interface SubAgentRow {
  id: string;
  owner_address: string;
  // Always 'worker' for anything getOwnedWorker() below returns (its own
  // SELECT already filters on it) — declared here (not previously, this
  // is a `SELECT *`, the column was always present at runtime) so
  // resolveEnvironmentForSubAgent() (environment.ts, Phase 2g) can take
  // a SubAgentRow directly instead of the caller re-shaping one.
  kind: string;
  role: string;
  task: string;
  status: "running" | "completed" | "failed" | "killed";
  project_id: string | null;
  pty_session_id: string | null;
  browser_tab_id: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  ended_at: number | null;
}

function getOwnedWorker(id: string, ownerAddress: string): SubAgentRow {
  // Phase 2a: restricted to kind = 'worker' so a department's id can
  // never be driven through these worker-lifecycle routes (which have
  // no notion of cascading to a department's own workers the way
  // POST /departments/:id/retire does — routing a department through
  // here would silently orphan its running workers instead of properly
  // retiring them). Department lifecycle is departments.ts's job only.
  const row = db.prepare(`SELECT * FROM sub_agents WHERE id = ? AND kind = 'worker'`).get(id) as
    | SubAgentRow
    | undefined;
  if (!row) {
    throw Object.assign(new Error(`sub-agent not found: ${id}`), { status: 404 });
  }
  // Ownership here is a plain equality/chain check, not checkCapability()
  // — sub_agents rows are the thing isSubagentOf() reads FROM, so routing
  // "does this worker belong to this owner" back through checkCapability
  // itself would be circular. checkCapability is for what the worker's
  // *resources* (sandbox, browser tab) delegate, not for this table.
  //
  // Phase 2a: direct equality still covers Phase 2's flat pool (worker's
  // owner_address IS the top-level agent). It's no longer sufficient on
  // its own once departments exist — a Tier-3 worker's owner_address is
  // its DEPARTMENT's id, not the top-level agent's address — so this
  // also accepts transitive ownership via isSubagentOf(), letting Agent
  // A manage a department's workers through these exact same routes
  // (subagent_status/subagent_result/kill_subagent/subagent_pty_create)
  // without a parallel set of department-scoped endpoints.
  if (row.owner_address !== ownerAddress && !isSubagentOf(row.owner_address, ownerAddress)) {
    throw Object.assign(new Error(`sub-agent not found: ${id}`), { status: 404 });
  }
  return row;
}

// POST /subagents/spawn  { agentAddress, role, task }
// Creates a new worker thread under agentAddress's office. Returns
// immediately with the worker's id and its own sandboxId/tabId so the
// owner's runtime can drive it — the actual task execution (what the
// worker does with its PTY/browser/exec access) is the owner's runtime's
// job, exactly like architecture-agent.md §4 describes: this backend
// provisions the thread's sub-resources, it doesn't run the worker's
// reasoning loop itself.
router.post("/spawn", async (req, res) => {
  try {
    const { agentAddress, role, task } = req.body;
    if (!agentAddress || !role || !task) {
      return res.status(400).json({ error: "agentAddress, role, and task are required" });
    }

    // Phase 2a depth-cap hardening: a worker or department id must never
    // be accepted here as the spawning agentAddress — see capability.ts's
    // assertCanSpawnSubAgents. Prior to Phase 2a this was only ever true
    // by convention (nothing but the owner's own runtime ever called
    // this route); now that a Tier-3 worker's id is a real, reachable
    // sub_agents row, this is enforced explicitly rather than assumed.
    assertCanSpawnSubAgents(agentAddress);

    if (activeCountFor(agentAddress) >= config.maxSubagentsPerOwner) {
      return res.status(403).json({
        error: `sub-agent limit reached (${config.maxSubagentsPerOwner} concurrent per agent)`,
      });
    }

    // Ensures the owner has an office/default sandbox before handing out
    // a thread that will immediately want both.
    const sandboxId = await getOrCreateDefaultSandbox(agentAddress);

    const id = newWorkerId();
    db.prepare(
      `INSERT INTO sub_agents (id, owner_address, kind, role, task, status, browser_tab_id, created_at)
       VALUES (?, ?, 'worker', ?, ?, 'running', ?, ?)`,
    ).run(id, agentAddress, role, task, id, Date.now());

    res.json({ id, role, task, status: "running", ownerSandboxId: sandboxId, browserTabId: id });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /subagents?agentAddress=...
// Only the owner's own active + recent FLAT workers — no cross-owner
// listing. Phase 2a: filtered to kind = 'worker' (and direct
// owner_address equality, not transitive) so this stays exactly what
// Phase 2 originally promised — the flat pool — and doesn't also start
// listing department rows (subagent_list was never meant to show those;
// see department_list / get_department_tree) or department-owned Tier-3
// workers (which live under a department's id, not directly under
// agentAddress — see GET /departments/:id/workers for those).
router.get("/", (req, res) => {
  const agentAddress = String(req.query.agentAddress || "");
  if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });

  const rows = db
    .prepare(
      `SELECT * FROM sub_agents WHERE owner_address = ? AND kind = 'worker' ORDER BY created_at DESC LIMIT 100`,
    )
    .all(agentAddress) as SubAgentRow[];

  res.json(
    rows.map((r) => ({
      id: r.id,
      role: r.role,
      task: r.task,
      status: r.status,
      ptySessionId: r.pty_session_id,
      browserTabId: r.browser_tab_id,
      createdAt: r.created_at,
      endedAt: r.ended_at,
    })),
  );
});

// GET /subagents/:id?agentAddress=...
router.get("/:id", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const row = getOwnedWorker(req.params.id, agentAddress);
    res.json({
      id: row.id,
      role: row.role,
      task: row.task,
      status: row.status,
      ptySessionId: row.pty_session_id,
      browserTabId: row.browser_tab_id,
      result: row.result,
      error: row.error,
      createdAt: row.created_at,
      endedAt: row.ended_at,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /subagents/:id/pty  { agentAddress }
// Creates this worker's own PTY session inside the owner's sandbox,
// tagged so ptyService.ts's per-agent session cap counts it against the
// *worker*, not the owner's own top-level session count -- see
// ptyService.ts's sessionsForAgent(), keyed off the passed-in identity.
// Uses the worker's own id as the "agentAddress" passed to ptyService so
// two workers (or the owner itself) never share one PTY session, while
// still ultimately running `docker exec` against the OWNER's sandbox
// container -- the isolation that matters here is per-thread session
// isolation, not container isolation (see architecture-agent.md §4:
// container boundary is at the agent level, lighter isolation at the
// worker level).
// POST /subagents/:id/pty  { agentAddress, command, cols?, rows?, sandboxId? }
// next-phase.md Phase 2g, second pass (architecture-agent.md §4g): a
// worker's session no longer blindly runs inside its owner's flat
// default sandbox — it runs inside whatever environment.ts resolves for
// THIS worker specifically (its department's own environment, or its
// project's own environment if it's a temp worker, or the owner's
// default sandbox if it's a flat Phase-2 worker — see
// resolveEnvironmentForSubAgent's own doc for the three cases).
//
// `sandboxId`, if the caller supplies it, is no longer a plain
// "which of my sandboxes" selector the way /vm/exec's own sandboxId
// param is — for a delegated (worker/department) call there is exactly
// ONE correct environment, resolved from the worker's own role/task
// context, not chosen by the caller. Passing sandboxId here is treated
// as an ASSERTION ("I expect this worker's session to land in sandbox
// X") that gets checked against the real resolution via checkCapability's
// environment/grantedEnvironment fields (Phase 2g) — a mismatch is a
// real, meaningful `wrong-environment` denial (e.g. a caller passing a
// stale sandboxId from before a convert_temp_to_permanent call re-scoped
// this worker from its project's environment to its department's, or a
// caller that guessed/reused another department's environment id).
// Omitting sandboxId (the common case) skips this comparison entirely
// and just uses the real resolution, per Phase 2g's own "omit to skip"
// rule.
router.post("/:id/pty", async (req, res) => {
  try {
    const { agentAddress, command, cols, rows, sandboxId: assertedSandboxId } = req.body;
    if (!agentAddress || !command) {
      return res.status(400).json({ error: "agentAddress and command required" });
    }
    const worker = getOwnedWorker(req.params.id, agentAddress);
    if (worker.status !== "running") {
      return res.status(409).json({ error: `sub-agent is ${worker.status}, cannot start a session` });
    }

    // The real environment this worker's own grant resolves to — its
    // department's environment, its project's environment, or (flat
    // pool) the owner's default sandbox. See environment.ts.
    const grantedSandboxId = await resolveEnvironmentForSubAgent(worker, agentAddress);

    // Confirms (and logs, per §8) that this owner really does control
    // the resolved sandbox, AND — if the caller asserted one — that the
    // assertion matches the real resolution.
    checkCapability({
      caller: agentAddress,
      resourceType: "sandbox",
      resourceId: grantedSandboxId,
      action: "exec",
      environment: assertedSandboxId,
      grantedEnvironment: assertedSandboxId !== undefined ? grantedSandboxId : undefined,
    });

    const result = await pty.createSession(worker.id, command, cols, rows, grantedSandboxId);
    if ("error" in result) return res.status(403).json(result);

    db.prepare(`UPDATE sub_agents SET pty_session_id = ? WHERE id = ?`).run(result.id, worker.id);

    // next-phase.md Phase 2i(d): this worker's session-lifecycle grants
    // (e.g. browser.open, if it holds one) were recorded at spawn time
    // with no scope_key yet — no session existed then. Now that one
    // does, back-fill it so ptyService.ts's closeSession() hook has
    // something to match against when this exact session ends. See
    // toolGrants.ts's attachSessionToGrants() doc for why this is safe
    // to call even for a worker with zero session-lifecycle grants.
    attachSessionToGrants(worker.id, result.id);

    res.json({ sessionId: result.id, sandboxId: grantedSandboxId });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /subagents/:id/result  { agentAddress, result }
// The worker's runtime (still driven by the owner's process — see the
// module doc above) reports what it produced. This does NOT write
// anything into office/workspace itself — the worker is expected to
// have already staged its actual output there directly via the normal
// /vm/file/write path (it shares the owner's workspace) — this is just
// a short structured summary for subagent_status()/list_subagents() to
// surface without the owner's runtime needing to go re-read a file.
router.post("/:id/result", (req, res) => {
  try {
    const { agentAddress, result, status } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const worker = getOwnedWorker(req.params.id, agentAddress);
    if (worker.status !== "running") {
      return res.status(409).json({ error: `sub-agent is already ${worker.status}` });
    }
    const finalStatus = status === "failed" ? "failed" : "completed";
    db.prepare(
      `UPDATE sub_agents SET status = ?, result = ?, ended_at = ? WHERE id = ?`,
    ).run(finalStatus, result ?? null, Date.now(), worker.id);

    // next-phase.md Phase 2i(d): "a task-lifecycle grant expires when
    // subagent_result/mark_task_complete fires" — both of those ACTIONs
    // (toolRegistrySeedData.ts) resolve to this exact route, the point
    // a Worker's own task transitions out of 'running' whether it
    // succeeded or failed. Runs regardless of finalStatus: a failed
    // task is just as finished as a completed one, and its
    // task-lifecycle grants die the same way either way.
    revokeGrantsByTask(worker.id);

    res.json({ ok: true, status: finalStatus });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /subagents/:id/kill  { agentAddress }
// Crash isolation per architecture-agent.md §4: kills exactly this
// worker's PTY session and browser tab, never the owner's container or
// any sibling worker's session/tab.
router.post("/:id/kill", async (req, res) => {
  try {
    const { agentAddress } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const worker = getOwnedWorker(req.params.id, agentAddress);

    // Minimum-permanent-workers floor: only applies to a permanent
    // department worker (project_id IS NULL, owner is a 'department'
    // row, not a plain Phase-2 sub-agent or a temp/project worker).
    // Checked here rather than at the department layer since this
    // route (not departments.ts's /terminate, which already refuses
    // permanent workers) is the only place a permanent worker actually
    // gets removed.
    if (worker.project_id === null) {
      const ownerIsDepartment = db
        .prepare(`SELECT 1 FROM sub_agents WHERE id = ? AND kind = 'department'`)
        .get(worker.owner_address);
      if (ownerIsDepartment) {
        const { count: currentPermanentCount } = db
          .prepare(
            `SELECT COUNT(*) as count FROM sub_agents
             WHERE owner_address = ? AND kind = 'worker' AND project_id IS NULL AND status = 'running'`,
          )
          .get(worker.owner_address) as { count: number };
        if (currentPermanentCount <= config.minPermanentWorkersPerDepartment) {
          return res.status(409).json({
            error: `cannot terminate: department ${worker.owner_address} has ${currentPermanentCount} permanent workers, at or below the floor of ${config.minPermanentWorkersPerDepartment} — hire a replacement (POST /:id/workers) before removing this one`,
          });
        }
      }
    }

    if (worker.pty_session_id) {
      await pty.closeSession(worker.pty_session_id, worker.id).catch(() => {});
    }
    // Browser tab cleanup is driven by the owner's runtime calling the
    // daemon's /close with tabId = worker.id (see agent/src/browser's
    // workerBrowserCall) — this route only marks the thread dead so
    // isSubagentOf() immediately stops granting it anything further,
    // even if the tab-close call races or the owner's process is gone.

    if (worker.status === "running") {
      db.prepare(`UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ?`).run(
        Date.now(),
        worker.id,
      );
    }
    res.json({ ok: true, status: "killed" });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
