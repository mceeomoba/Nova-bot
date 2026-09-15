import { randomUUID } from "crypto";
import { db } from "./db.js";
import { killAgentProcess, getAgentProcessStatus } from "./orchestrator.js";
import { emitEvent } from "./ecosystemEvents.js";

/**
 * Zent.md Phase 19d — Kill/recall path.
 *
 * "The root agent (or Agent B's own failure detection) can freeze or
 * wind down a specific pipeline-spawned company without touching the
 * pipeline or any of its other siblings — an internal control, not an
 * external operator action."
 *
 * Two independent sub-actions, matched to the two authorities that can
 * actually see a problem in a live company:
 *
 *   - shutdownAgentServer()  — the security-department half: stop the
 *     process (orchestrator.ts's own killAgentProcess(), already built
 *     for Phase 5a/next-phase.md; this file adds no new process-control
 *     mechanism, only a company-scoped, audited wrapper around it).
 *   - freezeAgentFunds()     — the finance-department half: set
 *     agents.frozen, enforced at wallet.ts's signPaymentAuthorization()
 *     chokepoint (Phase 16b), so it holds regardless of which process
 *     or department later tries to spend.
 *
 * killPipelineSpawnedCompany() composes both into the full "wind down
 * this company" action a self- or parent-triggered kill decision calls.
 * Each half is independently try/caught: a security-department failure
 * (process already dead, sandbox gone) never prevents finance from
 * still locking the wallet, and vice versa — the two are not each
 * other's precondition. Every call, whichever path it came through, is
 * idempotent (safe to call twice) and writes exactly one kill_events
 * row recording what actually happened, so "no error occurs" here means
 * "no unhandled exception ever escapes this module," not "the target
 * process/wallet was necessarily already in a killable state" — a
 * fully-idle target is a successful no-op, not a failure.
 *
 * Deliberately not built: an "unfreeze" / "resume" route. Same posture
 * expansionCircuitBreaker.ts already takes for resumeExpansionPipeline()
 * (not exposed as an HTTP route) — per Zent.md's own closing notes,
 * every recovery path in this pipeline is the root agent's own next
 * cycle noticing conditions have changed and acting again, never a
 * flip-the-switch-back call. A frozen/killed company stays that way
 * until something re-provisions it from scratch.
 *
 * Authorization model (checked by the route layer, not duplicated here
 * — see expansionKillRoutes.ts): the only initiators are (a) the target
 * agent itself, (b) its direct parent (agents.parent_address match), or
 * (c) an admin call authenticated by index.ts's existing x-admin-key
 * middleware on /admin/*. This module trusts the initiator fields it is
 * given because the route layer has already verified them — it does not
 * re-derive authorization from request headers itself.
 */

export type KillInitiator = "self" | "parent" | "admin";

export interface ShutdownResult {
  attempted: boolean;
  succeeded: boolean;
  detail: string;
}

export interface FreezeResult {
  attempted: boolean;
  succeeded: boolean;
  alreadyFrozen: boolean;
  detail: string;
}

export interface KillSwitchResult {
  agentAddress: string;
  action: "shutdown" | "freeze_funds" | "kill";
  initiator: KillInitiator;
  initiatorAddress: string | null;
  shutdown: ShutdownResult | null;
  freezeFunds: FreezeResult | null;
  eventId: string;
}

interface AgentRow {
  address: string;
  parent_address: string | null;
  spawn_reason: string;
  frozen: number;
}

class KillSwitchTargetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "KillSwitchTargetError";
  }
}

/**
 * Shared precondition every one of this file's exported actions checks
 * first, before touching a process or a wallet: the target has to exist
 * and has to actually be a pipeline-spawned sibling (spawn_reason =
 * 'expansion_pipeline'), never the root agent itself. Zent.md 19d's own
 * scope is explicit — "a specific pipeline-spawned company," "without
 * touching the pipeline" — a root agent is the pipeline, not a company
 * the pipeline spawned, so it is never a valid target here regardless of
 * who's asking. Throws rather than returning a soft failure: every
 * caller in this file wants this checked once, synchronously, before
 * any side effect starts.
 */
function loadKillableTarget(agentAddress: string): AgentRow {
  if (!agentAddress || typeof agentAddress !== "string") {
    throw new KillSwitchTargetError("agentAddress is required", 400);
  }
  const row = db
    .prepare(`SELECT address, parent_address, spawn_reason, frozen FROM agents WHERE address = ?`)
    .get(agentAddress) as AgentRow | undefined;
  if (!row) {
    throw new KillSwitchTargetError(`unknown agent address: ${agentAddress}`, 404);
  }
  if (row.spawn_reason !== "expansion_pipeline") {
    throw new KillSwitchTargetError(
      `${agentAddress} is not a pipeline-spawned company (spawn_reason='${row.spawn_reason}') — ` +
        `the kill/recall path only ever targets a specific expansion-pipeline sibling, never the ` +
        `root agent or an ordinary spawn_clone worker`,
      403,
    );
  }
  return row;
}

/**
 * Root address for audit/log purposes. Pipeline-spawned companies are
 * always exactly one generation below the root that funded them in this
 * phase's own scope (Phase 18e's "B's own eventual child" case is a
 * separate future root for its own sub-tree) — parent_address IS the
 * root here.
 */
function rootAddressFor(row: AgentRow): string {
  return row.parent_address ?? row.address;
}

function recordKillEvent(params: {
  agentAddress: string;
  rootAgentAddress: string;
  action: KillSwitchResult["action"];
  initiator: KillInitiator;
  initiatorAddress: string | null;
  reason: string;
  shutdown: ShutdownResult | null;
  freezeFunds: FreezeResult | null;
}): string {
  const id = randomUUID();
  try {
    db.prepare(
      `INSERT INTO kill_events
         (id, agent_address, root_agent_address, action, initiator, initiator_address, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      params.agentAddress,
      params.rootAgentAddress,
      params.action,
      params.initiator,
      params.initiatorAddress,
      params.reason,
      JSON.stringify({ shutdown: params.shutdown, freezeFunds: params.freezeFunds }),
      Date.now(),
    );
  } catch (err: any) {
    // The audit write itself must never be what makes a kill/freeze
    // action fail — the side effects above (process signal sent, DB
    // frozen flag set) already happened or were attempted by this
    // point. Losing the log row is bad; silently reverting a real
    // freeze/kill because the log insert hit a transient SQLITE_BUSY
    // would be worse. Swallow, but leave a trace in the process log.
    // eslint-disable-next-line no-console
    console.error(`kill_events insert failed for ${params.agentAddress}:`, err?.message ?? err);
  }

  emitEvent({
    agentAddress: params.agentAddress,
    role: "Security",
    subRole: params.initiator === "admin" ? "Admin Kill Switch" : `${params.initiator} action`,
    eventType: params.action === "freeze_funds" ? "freeze" : "kill",
    message: `${params.action.replace("_", " ")} — ${params.reason}`,
    metadata: { eventId: id, rootAgentAddress: params.rootAgentAddress, initiatorAddress: params.initiatorAddress },
  });

  return id;
}

/**
 * Security-department half. Idempotent: an already-stopped/killed/
 * never-started process is a successful no-op (attempted=true,
 * succeeded=true), not an error — same posture orchestrator.ts's own
 * killAgentProcess() already takes (`{ killed: false, reason: "not
 * running" }` is a normal return, not a throw). This function never
 * throws for an ordinary "nothing to kill" case; it only throws
 * KillSwitchTargetError for an invalid target, caught by the route
 * layer and turned into a 4xx.
 */
export function shutdownAgentServer(
  agentAddress: string,
  reason: string,
  initiator: KillInitiator,
  initiatorAddress: string | null,
): ShutdownResult {
  loadKillableTarget(agentAddress); // throws on invalid target; validates before any side effect

  let result: ShutdownResult;
  try {
    const status = getAgentProcessStatus(agentAddress);
    if (!status || status.status !== "running" || status.pid === null) {
      // Nothing live to signal — already stopped, never started, or
      // crashed on its own. Treat as a successful shutdown outcome:
      // the end state ("not running") is exactly what was asked for.
      result = {
        attempted: true,
        succeeded: true,
        detail: status ? `already ${status.status}, no signal needed` : "no tracked process for this agent",
      };
    } else {
      const killResult = killAgentProcess(agentAddress, "SIGTERM", `kill-switch:${initiator}:${reason}`);
      if (killResult.killed) {
        result = { attempted: true, succeeded: true, detail: killResult.reason };
      } else {
        // SIGTERM delivery failed (e.g. process died between the status
        // read and the signal). Fall back once to SIGKILL before giving
        // up — belt-and-suspenders so a transient race doesn't leave a
        // "frozen funds but still-running server" half-state.
        const forceResult = killAgentProcess(agentAddress, "SIGKILL", `kill-switch:${initiator}:${reason}:retry`);
        result = {
          attempted: true,
          succeeded: forceResult.killed,
          detail: forceResult.killed
            ? `SIGTERM failed (${killResult.reason}), SIGKILL succeeded`
            : `SIGTERM failed (${killResult.reason}), SIGKILL also failed (${forceResult.reason})`,
        };
      }
    }
  } catch (err: any) {
    // Defensive catch-all: nothing above should throw besides
    // loadKillableTarget (already returned), but a process-control call
    // reaching into the OS is exactly the kind of thing that can fail
    // in ways this file's own tests won't enumerate. Report as a failed
    // (not attempted-and-crashed) outcome rather than propagating —
    // this function's contract is "never throws for a live target."
    result = { attempted: true, succeeded: false, detail: `unexpected error: ${err?.message ?? err}` };
  }
  return result;
}

/**
 * Finance-department half. Idempotent: freezing an already-frozen
 * agent updates the reason/timestamp (same upsert posture
 * haltExpansionPipeline() already uses in expansionCircuitBreaker.ts)
 * and reports alreadyFrozen=true rather than erroring.
 */
export function freezeAgentFunds(
  agentAddress: string,
  reason: string,
  initiator: KillInitiator,
  initiatorAddress: string | null,
): FreezeResult {
  const target = loadKillableTarget(agentAddress);
  const wasAlreadyFrozen = target.frozen === 1;

  try {
    db.prepare(`UPDATE agents SET frozen = 1, frozen_reason = ?, frozen_at = ? WHERE address = ?`).run(
      reason,
      Date.now(),
      agentAddress,
    );
    return {
      attempted: true,
      succeeded: true,
      alreadyFrozen: wasAlreadyFrozen,
      detail: wasAlreadyFrozen ? "was already frozen; reason/timestamp updated" : "funds frozen",
    };
  } catch (err: any) {
    return {
      attempted: true,
      succeeded: false,
      alreadyFrozen: wasAlreadyFrozen,
      detail: `unexpected error: ${err?.message ?? err}`,
    };
  }
}

/**
 * Full kill/recall — the combined action a self- or parent-triggered
 * "wind this company down" decision calls. Runs shutdown and
 * freeze-funds independently (neither is the other's precondition, see
 * this file's own header), records one kill_events row covering both
 * outcomes, and never throws once the target itself has been validated
 * — a caller only ever gets a KillSwitchTargetError (bad target) or a
 * fully-populated KillSwitchResult, never a partially-applied action
 * with no record of what happened.
 */
export function killPipelineSpawnedCompany(
  agentAddress: string,
  reason: string,
  initiator: KillInitiator,
  initiatorAddress: string | null,
): KillSwitchResult {
  const target = loadKillableTarget(agentAddress);
  const rootAgentAddress = rootAddressFor(target);

  const shutdown = shutdownAgentServer(agentAddress, reason, initiator, initiatorAddress);
  const freezeFunds = freezeAgentFunds(agentAddress, reason, initiator, initiatorAddress);

  const eventId = recordKillEvent({
    agentAddress,
    rootAgentAddress,
    action: "kill",
    initiator,
    initiatorAddress,
    reason,
    shutdown,
    freezeFunds,
  });

  return {
    agentAddress,
    action: "kill",
    initiator,
    initiatorAddress,
    shutdown,
    freezeFunds,
    eventId,
  };
}

/** Security-department-only action: process shutdown, wallet untouched. */
export function securityShutdown(
  agentAddress: string,
  reason: string,
  initiator: KillInitiator,
  initiatorAddress: string | null,
): KillSwitchResult {
  const target = loadKillableTarget(agentAddress);
  const rootAgentAddress = rootAddressFor(target);
  const shutdown = shutdownAgentServer(agentAddress, reason, initiator, initiatorAddress);
  const eventId = recordKillEvent({
    agentAddress,
    rootAgentAddress,
    action: "shutdown",
    initiator,
    initiatorAddress,
    reason,
    shutdown,
    freezeFunds: null,
  });
  return { agentAddress, action: "shutdown", initiator, initiatorAddress, shutdown, freezeFunds: null, eventId };
}

/** Finance-department-only action: wallet frozen, process untouched. */
export function financeLockFunds(
  agentAddress: string,
  reason: string,
  initiator: KillInitiator,
  initiatorAddress: string | null,
): KillSwitchResult {
  const target = loadKillableTarget(agentAddress);
  const rootAgentAddress = rootAddressFor(target);
  const freezeFunds = freezeAgentFunds(agentAddress, reason, initiator, initiatorAddress);
  const eventId = recordKillEvent({
    agentAddress,
    rootAgentAddress,
    action: "freeze_funds",
    initiator,
    initiatorAddress,
    reason,
    shutdown: null,
    freezeFunds,
  });
  return { agentAddress, action: "freeze_funds", initiator, initiatorAddress, shutdown: null, freezeFunds, eventId };
}

/**
 * Read-only history for one company or, when agentAddress is omitted,
 * every kill_events row (admin view). No write path corresponds to this
 * read beyond the four functions above — this is purely observational.
 */
export function listKillEvents(agentAddress?: string, limit = 100): any[] {
  const rows = agentAddress
    ? db
        .prepare(`SELECT * FROM kill_events WHERE agent_address = ? ORDER BY created_at DESC LIMIT ?`)
        .all(agentAddress, limit)
    : db.prepare(`SELECT * FROM kill_events ORDER BY created_at DESC LIMIT ?`).all(limit);
  return (rows as any[]).map((r) => ({ ...r, detail: safeParseJson(r.detail) }));
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: true, raw: text };
  }
}

export { KillSwitchTargetError };
