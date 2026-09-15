import crypto from "crypto";
import { db } from "./db.js";

/**
 * Zent.md Phase 17e-iv — "Active-status transition: only after 17e-ii
 * and 17e-iii both pass is Agent B marked `active`; a failing smoke
 * test leaves it in a distinguishable pre-active state instead of
 * silently retrying."
 *
 * This is the last of the four 17e sub-phases and the one that actually
 * closes the loop genesisSmokeTest.ts (17e-ii) and
 * genesisConstitutionCheck.ts (17e-iii) both left open on their own
 * "not this phase's job" note: neither of those files touches
 * `agents.genesis_activation_status`. This one does, and does nothing
 * else — it does not re-run either check, does not decide what a
 * failure means for the root agent's pipeline (that's
 * expansionCircuitBreaker.ts, already wired by 17e-iii), and does not
 * retry a failed birth. It reads the two prior checks' already-recorded
 * verdicts and writes exactly one terminal transition for Agent B.
 *
 * State machine, enforced by the WHERE clause on every UPDATE below
 * (see each function): pending -> active | failed, and nothing else.
 * There is no active -> * or failed -> * transition anywhere in this
 * file — genesis fires once per agent, so 17e-ii/17e-iii's checks run
 * once per agent, so this module's own writes are exactly one-shot too.
 * An UPDATE that matches zero rows (agent already active/failed, or
 * never pending in the first place — e.g. a 'self'-spawned agent this
 * module was never meant to touch) is not an error; it is silently a
 * no-op, logged via the affected-row count rather than thrown, because
 * genesisExecutorAdapter() calling this exactly once per birth is an
 * invariant enforced by that file's own control flow, not by this one
 * needing to defend against being called twice.
 *
 * No human override, same posture as every other Zent.md phase in this
 * codebase (see genesisSmokeTest.ts's and genesisConstitutionCheck.ts's
 * own headers for the identical line): activateGenesisAgent() and
 * markGenesisActivationFailed() are called automatically by
 * genesisExecutorAdapter() (genesis.ts) immediately after 17e-ii/17e-iii
 * resolve, with no operator approval step anywhere between "smoke test
 * passed" and "agent marked active," and none is added here. A failed
 * agent is not held for a person to review and re-activate — it simply
 * stays `failed` forever, a record, not a queue.
 */

export type GenesisActivationStatus = "pending" | "active" | "failed";

export interface GenesisActivationEvent {
  id: string;
  opportunityId: string;
  agentAddress: string;
  status: "active" | "failed";
  reason: "smoke_test_failed" | "constitution_violated" | "passed";
  detail: string;
  createdAt: number;
}

function writeEvent(
  opportunityId: string,
  agentAddress: string,
  status: "active" | "failed",
  reason: GenesisActivationEvent["reason"],
  detail: string,
): void {
  db.prepare(
    `INSERT INTO genesis_activation_events
       (id, opportunity_id, agent_address, status, reason, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), opportunityId, agentAddress, status, reason, detail, Date.now());
}

/**
 * Written once, at birth, by genesis.ts's tagCompanyLineage() — the
 * same call that already writes spawn_reason = 'expansion_pipeline'
 * (Phase 16e) — so a pipeline-spawned agent has a distinguishable
 * pre-active status from the moment it exists, before its first tick
 * has even run. Not logged to genesis_activation_events: that table is
 * for the *terminal* transition (active/failed), which 'pending' is
 * not — the column write itself is the whole record for this step.
 */
export function markGenesisPending(agentAddress: string): void {
  db.prepare(`UPDATE agents SET genesis_activation_status = 'pending' WHERE address = ?`).run(
    agentAddress,
  );
}

/**
 * Called by genesisExecutorAdapter() (genesis.ts) after
 * runFirstTickSmokeTest() (17e-ii) resolved without throwing AND
 * checkTickConstitutionCompliance() (17e-iii) resolved without
 * throwing, for the same agent. Only actually flips the row if it is
 * still 'pending' — an agent whose birth wasn't through this pipeline
 * (no 'pending' row to begin with) is left untouched.
 */
export function activateGenesisAgent(opportunityId: string, agentAddress: string): void {
  const result = db
    .prepare(
      `UPDATE agents SET genesis_activation_status = 'active'
       WHERE address = ? AND genesis_activation_status = 'pending'`,
    )
    .run(agentAddress);
  if (result.changes > 0) {
    writeEvent(
      opportunityId,
      agentAddress,
      "active",
      "passed",
      "17e-ii tick smoke test and 17e-iii constitution compliance check both passed",
    );
  }
}

/**
 * Called by genesisExecutorAdapter() when either 17e-ii or 17e-iii
 * throws for this agent's first tick. `reason` distinguishes which of
 * the two failed (a caller with both failures still only gets one
 * terminal row here, since a crashed/timed-out tick — 17e-ii failing —
 * never reaches 17e-iii's check at all; see genesisConstitutionCheck.ts's
 * own header for why). `detail` should be the failing check's own
 * human-readable explanation (TickSmokeTestResult.outcome or
 * ConstitutionCheckResult.detail) so this row is legible without a join
 * back to genesis_tick_smoke_tests/genesis_constitution_checks.
 */
export function markGenesisActivationFailed(
  opportunityId: string,
  agentAddress: string,
  reason: "smoke_test_failed" | "constitution_violated",
  detail: string,
): void {
  const result = db
    .prepare(
      `UPDATE agents SET genesis_activation_status = 'failed'
       WHERE address = ? AND genesis_activation_status = 'pending'`,
    )
    .run(agentAddress);
  if (result.changes > 0) {
    writeEvent(opportunityId, agentAddress, "failed", reason, detail);
  }
}

/** Read-only convenience: current activation status for an agent, or
 *  undefined if the agent doesn't exist. `null` (not undefined) means
 *  the agent exists but was never pipeline-spawned. */
export function getGenesisActivationStatus(
  agentAddress: string,
): GenesisActivationStatus | null | undefined {
  const row = db
    .prepare(`SELECT genesis_activation_status AS status FROM agents WHERE address = ?`)
    .get(agentAddress) as { status: GenesisActivationStatus | null } | undefined;
  if (!row) return undefined;
  return row.status;
}

/** Read-only convenience: the terminal transition event for an agent,
 *  if one has been recorded. Undefined while still 'pending' (no event
 *  written yet — see markGenesisPending()'s own comment). */
export function getGenesisActivationEvent(agentAddress: string): GenesisActivationEvent | undefined {
  const row = db
    .prepare(
      `SELECT id, opportunity_id as opportunityId, agent_address as agentAddress,
              status, reason, detail, created_at as createdAt
       FROM genesis_activation_events
       WHERE agent_address = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(agentAddress) as GenesisActivationEvent | undefined;
  return row;
}
