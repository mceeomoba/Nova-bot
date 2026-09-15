import express from "express";
import { spawnAgentProcess, killAgentProcess, getAgentProcessStatus, listAgentProcesses } from "./orchestrator.js";
import { checkResourceQuotas, enforceResourceQuotas } from "./resourceQuotas.js";
import { checkOrgChartQuotas } from "./orgChartQuotas.js";
import { checkAgentHealth, restartAgentProcess } from "./healthCheck.js";
import {
  killPipelineSpawnedCompany,
  financeLockFunds,
  listKillEvents,
  KillSwitchTargetError,
} from "./expansionKillSwitch.js";

/**
 * next-phase.md Phase 5a (architecture-agent.md §6): the operator-facing
 * surface over orchestrator.ts. Mounted at /admin/orchestrator in
 * index.ts, so it inherits the x-admin-key check index.ts already
 * applies to the whole /admin prefix — same as admin.ts's own
 * GET /admin/status. Deliberately never reachable with an agent's own
 * BACKEND_API_KEY: per architecture-agent.md §6, this is root, "use
 * sparingly, log everything" — an agent spawning or killing its own (or
 * anyone else's) top-level process is exactly the kind of self-
 * modification/self-replication action that stays a human-operator-only
 * decision, not something to expose on the agent-facing surface.
 */
const router = express.Router();

router.post("/:address/spawn", (req, res) => {
  const result = spawnAgentProcess(req.params.address);
  if (!result.launched) return res.status(409).json(result);
  res.json(result);
});

router.post("/:address/kill", (req, res) => {
  const signal = req.body?.signal === "SIGKILL" ? "SIGKILL" : "SIGTERM";
  const result = killAgentProcess(req.params.address, signal);
  if (!result.killed) return res.status(409).json(result);
  res.json(result);
});

router.get("/:address/status", (req, res) => {
  const status = getAgentProcessStatus(req.params.address);
  if (!status) return res.status(404).json({ error: "no tracked process for this agent" });
  res.json(status);
});

router.get("/processes", (_req, res) => {
  res.json({ processes: listAgentProcesses() });
});

// next-phase.md Phase 5b (architecture-agent.md §6): read-only inspect
// of resourceQuotas.ts's own decision, mirroring the read-only /status
// route above — never mutates anything, so (unlike /spawn, /kill, and
// the /quota/enforce route below) this would be safe to widen beyond
// the x-admin-key boundary later if an agent ever needs to read its
// OWN quota standing; left admin-only for now since nothing in this
// phase's own scope calls for that widening yet.
router.get("/:address/quota", async (req, res) => {
  const result = await checkResourceQuotas(req.params.address);
  res.json(result);
});

// Manual trigger for the same decide-then-act enforceResourceQuotas()
// the 60s sweep (resourceQuotas.ts) already runs automatically — an
// operator-facing escape hatch to act immediately on a violation
// without waiting up to 60s for the next sweep tick, same reasoning
// orchestratorRoutes' own /spawn and /kill already give a human a
// direct lever instead of only ever happening implicitly.
router.post("/:address/quota/enforce", async (req, res) => {
  const result = await enforceResourceQuotas(req.params.address);
  res.json(result);
});

// next-phase.md Phase 5c (architecture-agent.md §6): read-only inspect
// of orgChartQuotas.ts's own decision — the department/worker-ceiling
// analogue of the /:address/quota route above. No .../enforce sibling:
// unlike resourceQuotas.ts's resource ceilings, a headcount ceiling has
// no single OS process to kill in response (see orgChartQuotas.ts's own
// module doc for why), so there is nothing for an "act on this now"
// route to do that the existing department routes' own creation-time
// checks don't already do.
router.get("/:address/org-chart-quota", async (req, res) => {
  const result = await checkOrgChartQuotas(req.params.address);
  res.json(result);
});

// next-phase.md Phase 5e (architecture-agent.md §6): read-only inspect
// of healthCheck.ts's own crash/hang decision — same read-only shape as
// /status, /quota, and /org-chart-quota above.
router.get("/:address/health", async (req, res) => {
  const result = await checkAgentHealth(req.params.address);
  res.json(result);
});

// Manual trigger for the same decide-then-act restartAgentProcess() the
// 60s health_check sweep (healthCheck.ts) already runs automatically —
// same "give an operator a direct lever, don't wait for the next tick"
// reasoning /quota/enforce already gives. `cause` defaults to "crashed"
// since that's the more common manual case (an operator noticing a dead
// row); pass "hung" explicitly to also bypass a still-live pid via
// SIGKILL first, same as the sweep's own hung path does.
router.post("/:address/health/restart", async (req, res) => {
  const cause = req.body?.cause === "hung" ? "hung" : "crashed";
  const result = await restartAgentProcess(req.params.address, cause);
  res.json(result);
});

// Zent.md Phase 19d — external-operator backstop over the kill/recall
// path, added on top of Zent.md's own "internal control, not an
// external operator action" text for exactly one reason: the pipeline
// spends real, on-chain funds (see GAZA_DEPLOY.md — real EVM wallets,
// real USDC on Base) and self-replicates by actually launching child
// OS processes. Every other route in this pipeline is agent-decided by
// design and stays that way; this route changes nothing about that —
// Security/Finance departments and self/parent-triggered kills (see
// expansionKillRoutes.ts, mounted at /expansion) remain the normal,
// first-line, fully autonomous path and are exercised far more often
// than this one is expected to be. This exists only for the case those
// internal checks all miss at once (e.g. a prompt-injected or otherwise
// compromised agent whose Security/Finance departments share its own
// corrupted context and don't flag it) — a categorically different
// failure mode than "an agent's own governance caught a problem," which
// is what the routes in expansionKillRoutes.ts already handle. Reachable
// only with x-admin-key (index.ts's own /admin prefix check, never an
// agent's BACKEND_API_KEY), same tier as this router's existing
// /:address/kill above and PHASE-19D-NOTES.md's own reasoning.
//
// Deliberately reuses killPipelineSpawnedCompany()/financeLockFunds()
// rather than duplicating their logic — an admin-initiated kill goes
// through the exact same idempotent, both-halves-independent,
// audit-logged path a self/parent kill does; only `initiator` differs
// ('admin' instead of 'self'/'parent'), which the kill_events row
// records like any other field, not a separately-shaped action.
router.post("/:address/kill-company", (req, res) => {
  const reason =
    typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason
      : "unspecified — no reason provided by admin caller";
  try {
    const result = killPipelineSpawnedCompany(req.params.address, reason, "admin", null);
    res.json(result);
  } catch (err: any) {
    if (err instanceof KillSwitchTargetError) return res.status(err.status).json({ error: err.message });
    res.status(err?.status ?? 500).json({ error: err?.message ?? "internal error" });
  }
});

// Funds-only admin backstop, mirroring the security/finance split
// expansionKillRoutes.ts gives the agent hierarchy — an admin who only
// wants to stop further spend (not necessarily kill the process, e.g.
// while still investigating) doesn't have to take the process down too.
router.post("/:address/freeze-funds", (req, res) => {
  const reason =
    typeof req.body?.reason === "string" && req.body.reason.trim()
      ? req.body.reason
      : "unspecified — no reason provided by admin caller";
  try {
    const result = financeLockFunds(req.params.address, reason, "admin", null);
    res.json(result);
  } catch (err: any) {
    if (err instanceof KillSwitchTargetError) return res.status(err.status).json({ error: err.message });
    res.status(err?.status ?? 500).json({ error: err?.message ?? "internal error" });
  }
});

// Read-only, admin-tier view of the same audit trail
// GET /expansion/:agentAddress/kill-events (expansionKillRoutes.ts)
// exposes at the agent tier — mirrored here so an operator doesn't need
// the agent-facing key just to review kill history. agentAddress omitted
// returns every company's events.
router.get("/kill-events", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const agentAddress = typeof req.query.agentAddress === "string" ? req.query.agentAddress : undefined;
  res.json({ events: listKillEvents(agentAddress, limit) });
});

export default router;
