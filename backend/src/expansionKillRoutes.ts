import express from "express";
import { db } from "./db.js";
import {
  killPipelineSpawnedCompany,
  securityShutdown,
  financeLockFunds,
  listKillEvents,
  KillSwitchTargetError,
} from "./expansionKillSwitch.js";
import type { KillInitiator } from "./expansionKillSwitch.js";

/**
 * Zent.md Phase 19d — agent-facing surface over expansionKillSwitch.ts.
 * Mounted at /expansion in index.ts, behind that prefix's existing
 * shared-secret (x-backend-key) middleware, same tier as every other
 * expansion-pipeline route (expansionRoutes.ts) — no separate auth
 * layer here.
 *
 * "No human override" applies to this router specifically: nothing here
 * lets an arbitrary caller act on an arbitrary company. Every route
 * below re-derives who is allowed to act from `agents.parent_address`
 * in the DB itself, not from whatever the request body claims — the
 * request body's `callerAddress` is checked AGAINST that row, never
 * trusted as an assertion of authority on its own (same posture
 * decide_expansion's own CEO-address check already takes in genesis.ts,
 * Phase 15b: "requires the calling agent_address to match the top-level
 * agent that owns the whole pipeline").
 *
 * The one external-operator path this phase adds (admin backstop) is
 * deliberately NOT in this router — it lives under /admin/orchestrator,
 * which already sits behind x-admin-key, a categorically different and
 * separately-held credential from this router's x-backend-key. See
 * PHASE-19D-NOTES.md for the reasoning; it does not change anything
 * about how this file itself authorizes self/parent calls.
 */
const router = express.Router();

function resolveInitiator(
  agentAddress: string,
  callerAddress: string | undefined,
): { initiator: KillInitiator; initiatorAddress: string } {
  if (!callerAddress || typeof callerAddress !== "string") {
    throw Object.assign(new Error("callerAddress is required"), { status: 400 });
  }
  if (callerAddress === agentAddress) {
    return { initiator: "self", initiatorAddress: callerAddress };
  }
  const target = db
    .prepare(`SELECT parent_address FROM agents WHERE address = ?`)
    .get(agentAddress) as { parent_address: string | null } | undefined;
  if (target && target.parent_address === callerAddress) {
    return { initiator: "parent", initiatorAddress: callerAddress };
  }
  throw Object.assign(
    new Error(
      `${callerAddress} is neither ${agentAddress} itself nor its direct parent — ` +
        `only the company itself or its parent may trigger the kill/recall path for it`,
    ),
    { status: 403 },
  );
}

function handleKillSwitchError(err: any, res: express.Response): void {
  if (err instanceof KillSwitchTargetError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (typeof err?.status === "number") {
    res.status(err.status).json({ error: err.message });
    return;
  }
  // eslint-disable-next-line no-console
  console.error("expansionKillRoutes: unexpected error", err);
  res.status(500).json({ error: "internal error handling kill/recall request" });
}

/**
 * POST /expansion/:agentAddress/security/shutdown
 * Body: { callerAddress, reason }
 * Security-department half: stops the target's process, leaves its
 * wallet untouched. callerAddress must be the target itself (its own
 * failure detection) or its direct parent.
 */
router.post("/:agentAddress/security/shutdown", (req, res) => {
  const { agentAddress } = req.params;
  const { callerAddress, reason } = req.body ?? {};
  try {
    const { initiator, initiatorAddress } = resolveInitiator(agentAddress, callerAddress);
    const result = securityShutdown(
      agentAddress,
      typeof reason === "string" && reason.trim() ? reason : "unspecified — no reason provided by caller",
      initiator,
      initiatorAddress,
    );
    res.json(result);
  } catch (err: any) {
    handleKillSwitchError(err, res);
  }
});

/**
 * POST /expansion/:agentAddress/finance/lock-funds
 * Body: { callerAddress, reason }
 * Finance-department half: freezes the target's wallet, leaves its
 * process untouched.
 */
router.post("/:agentAddress/finance/lock-funds", (req, res) => {
  const { agentAddress } = req.params;
  const { callerAddress, reason } = req.body ?? {};
  try {
    const { initiator, initiatorAddress } = resolveInitiator(agentAddress, callerAddress);
    const result = financeLockFunds(
      agentAddress,
      typeof reason === "string" && reason.trim() ? reason : "unspecified — no reason provided by caller",
      initiator,
      initiatorAddress,
    );
    res.json(result);
  } catch (err: any) {
    handleKillSwitchError(err, res);
  }
});

/**
 * POST /expansion/:agentAddress/kill
 * Body: { callerAddress, reason }
 * Full wind-down: shutdown + freeze-funds together. This is the route
 * Zent.md 19d itself describes — "freeze or wind down a specific
 * pipeline-spawned company."
 */
router.post("/:agentAddress/kill", (req, res) => {
  const { agentAddress } = req.params;
  const { callerAddress, reason } = req.body ?? {};
  try {
    const { initiator, initiatorAddress } = resolveInitiator(agentAddress, callerAddress);
    const result = killPipelineSpawnedCompany(
      agentAddress,
      typeof reason === "string" && reason.trim() ? reason : "unspecified — no reason provided by caller",
      initiator,
      initiatorAddress,
    );
    res.json(result);
  } catch (err: any) {
    handleKillSwitchError(err, res);
  }
});

/**
 * GET /expansion/:agentAddress/kill-events
 * Read-only audit trail for one company. Purely observational — no
 * corresponding write route beyond the three above.
 */
router.get("/:agentAddress/kill-events", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  res.json({ events: listKillEvents(req.params.agentAddress, limit) });
});

export default router;
