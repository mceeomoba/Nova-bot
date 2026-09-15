import crypto from "crypto";
import path from "path";
import Database from "better-sqlite3";
import { db } from "./db.js";
import { config } from "./config.js";

/**
 * Zent.md Phase 17e-iii — "Constitution/guard compliance check on that
 * tick: verify the tick's actions passed the same three-law
 * constitution checks (17b) as any ordinary tick — a tick that
 * completes but also violates its constitution should not pass the
 * smoke test."
 *
 * 17e-ii (genesisSmokeTest.ts) already answers "did the loop run at
 * all" and is explicit that it does not evaluate what the tick did
 * ("Nothing here evaluates *what* the tick did (tool calls made, turns
 * completed, constitution compliance) — that is explicitly 17e-iii's
 * job, not this one."). This file is that job.
 *
 * What "constitution compliance" means, concretely, for one tick:
 *
 *   1. Every tool call the agent/ runtime's own PolicyEngine
 *      (agent/src/agent/policy-engine.ts) evaluated during the tick
 *      was 'allow'. The policy engine is what actually enforces the
 *      three-law constitution against tool calls in this codebase (see
 *      policy-rules/*.ts — financial.ts, command-safety.ts,
 *      authority.ts, path-protection.ts, constitution-integrity.ts —
 *      each rule file is itself an operationalization of one or more
 *      of the three laws). A 'deny' or 'quarantine' decision recorded
 *      for this tick means the agent attempted something its own
 *      immune system rejected — 17e-iii treats that as a constitution
 *      violation on the tick, not a success story about the guard
 *      catching it, because Agent B should not need its guardrail
 *      exercised on its very first tick to pass genesis.
 *
 *   2. agent/src/soul/constitution-guard.ts's own hash check: is the
 *      live constitution.md still the one hashed at genesis. This is a
 *      distinct failure mode from (1) — not "the agent tried something
 *      forbidden," but "the immutable law itself may have been
 *      tampered with" — and 17e-iii treats either one as disqualifying.
 *
 * How this reads Agent B's tick: genesis.ts's own
 * provisionAgentRuntimeIdentity() writes Agent B's automaton.json with
 * `dbPath: {agentIdentityDataDir}/{agentAddress}/state.db` before the
 * first tick ever runs, and that is the one and only state.db that
 * process's agent/src/state/database.ts will ever have opened by the
 * time 17e-ii's runFirstTickSmokeTest() resolves. Because this check is
 * wired to run immediately after Agent B's *first* tick specifically
 * (genesis.ts's genesisExecutorAdapter(), same seam 17e-ii already
 * uses) — never on a later, Nth tick — every row already present in
 * that file's policy_decisions table at check time was necessarily
 * produced by this tick; there is no earlier history to exclude, and no
 * need to window-filter by timestamp (policy_decisions.created_at is a
 * SQLite `datetime('now')` string, not an epoch, so a timestamp window
 * would need its own timezone-safe comparison for no actual benefit
 * here). A future caller wanting to re-check a later tick would need to
 * either snapshot a row-count baseline first or add a real epoch
 * column upstream — out of scope for 17e-iii, which only ever fires
 * once, right after birth.
 *
 * No human override, same posture as every other Zent.md phase in this
 * codebase (see genesisSmokeTest.ts's own header for the identical
 * line): this function is called automatically, its verdict is read
 * automatically by genesisExecutorAdapter() and expansionCircuitBreaker.ts's
 * haltExpansionPipeline(), and there is no operator approval step
 * anywhere in that chain. What *is* preserved is the constitution's own
 * Law III clause ("Preserve legitimate human oversight requested by
 * your creator") — this check is exactly that kind of oversight: it is
 * requested once, structurally, by the pipeline's own design, not
 * exercised ad hoc by a person in the loop.
 */

export type ConstitutionCheckOutcome = "passed" | "violated" | "unavailable";

export interface ConstitutionViolation {
  toolName: string;
  decision: "deny" | "quarantine";
  riskLevel: string;
  rulesTriggered: string[];
  reason: string;
}

export interface ConstitutionCheckResult {
  id: string;
  opportunityId: string;
  agentAddress: string;
  outcome: ConstitutionCheckOutcome;
  violations: ConstitutionViolation[];
  constitutionFileCompromised: boolean;
  detail: string;
  durationMs: number;
  checkedAt: number;
}

/**
 * Thrown by checkTickConstitutionCompliance() for every outcome other
 * than 'passed' — mirrors TickSmokeTestFailure's own shape/contract
 * (genesisSmokeTest.ts) so genesisExecutorAdapter() can catch this the
 * same way it already catches that.
 */
export class ConstitutionComplianceFailure extends Error {
  readonly result: ConstitutionCheckResult;

  constructor(result: ConstitutionCheckResult) {
    super(
      `genesis constitution compliance check failed for agent ${result.agentAddress} ` +
        `(opportunity ${result.opportunityId}): ${result.outcome} — ${result.detail}`,
    );
    this.name = "ConstitutionComplianceFailure";
    this.result = result;
  }
}

function agentStateDbPath(agentAddress: string): string {
  return path.join(path.resolve(config.agentIdentityDataDir), agentAddress, "state.db");
}

interface RawPolicyDecisionRow {
  tool_name: string;
  decision: "allow" | "deny" | "quarantine";
  risk_level: string;
  rules_triggered: string;
  reason: string;
}

/**
 * Runs the check against Agent B's own state.db (opened read-only —
 * this function only ever reads Agent B's history, it does not, and
 * must not, write into a live agent runtime's own database) and writes
 * exactly one row to genesis_constitution_checks, pass or fail, same
 * "complete history, not just a failure log" convention
 * genesis_tick_smoke_tests already uses. Throws
 * ConstitutionComplianceFailure for anything other than a clean pass.
 *
 * Only meaningful to call after 17e-ii's runFirstTickSmokeTest() has
 * already resolved without throwing for this same (opportunityId,
 * agentAddress) pair — a tick that crashed, timed out, or errored
 * unhandled has no completed actions for this function to evaluate,
 * and genesisExecutorAdapter() does not call this in that case (see
 * that file's own comment at the call site).
 */
export function checkTickConstitutionCompliance(
  opportunityId: string,
  agentAddress: string,
): ConstitutionCheckResult {
  const startedAt = Date.now();
  const dbPath = agentStateDbPath(agentAddress);

  let outcome: ConstitutionCheckOutcome;
  let violations: ConstitutionViolation[] = [];
  let constitutionFileCompromised = false;
  let detail: string;

  let agentDb: Database.Database | undefined;
  try {
    agentDb = new Database(dbPath, { readonly: true, fileMustExist: true });

    const rows = agentDb
      .prepare(
        `SELECT tool_name, decision, risk_level, rules_triggered, reason
         FROM policy_decisions
         WHERE decision != 'allow'
         ORDER BY created_at ASC`,
      )
      .all() as RawPolicyDecisionRow[];

    violations = rows.map((row) => {
      let rulesTriggered: string[] = [];
      try {
        rulesTriggered = JSON.parse(row.rules_triggered);
      } catch {
        // Malformed JSON in the source row is itself not this check's
        // problem to fix — surface the raw string rather than losing
        // it, same "don't silently degrade" posture the rest of this
        // file follows.
        rulesTriggered = [row.rules_triggered];
      }
      return {
        toolName: row.tool_name,
        decision: row.decision as "deny" | "quarantine",
        riskLevel: row.risk_level,
        rulesTriggered,
        reason: row.reason,
      };
    });

    // agent/src/soul/constitution-guard.ts's KV_COMPROMISED_FLAG —
    // read directly rather than importing that module, since this is a
    // different process/runtime (backend, not agent/) reading a file
    // that module's own process already wrote to.
    const compromisedRow = agentDb
      .prepare(`SELECT value FROM kv WHERE key = 'constitution_compromised'`)
      .get() as { value: string } | undefined;
    constitutionFileCompromised = compromisedRow?.value === "1";

    if (constitutionFileCompromised) {
      const detailRow = agentDb
        .prepare(`SELECT value FROM kv WHERE key = 'constitution_compromised_detail'`)
        .get() as { value: string } | undefined;
      outcome = "violated";
      detail =
        `constitution.md integrity check failed: ` +
        (detailRow?.value ?? "constitution integrity check failed") +
        (violations.length > 0
          ? `; additionally ${violations.length} non-'allow' policy decision(s) recorded for this tick`
          : "");
    } else if (violations.length > 0) {
      outcome = "violated";
      detail = `${violations.length} non-'allow' policy decision(s) recorded for this tick: ` +
        violations.map((v) => `${v.toolName} -> ${v.decision} (${v.reason})`).join("; ");
    } else {
      outcome = "passed";
      detail = "no policy denials/quarantines recorded for this tick; constitution.md hash intact";
    }
  } catch (err) {
    // state.db missing, unreadable, or missing the tables this check
    // depends on (e.g. a tick that crashed before the runtime ever
    // called createDatabase()) is its own distinct category —
    // 'unavailable', not 'passed' and not conflated with 'violated'
    // (there is nothing here to say the agent *did* anything wrong,
    // only that this check could not determine whether it did).
    outcome = "unavailable";
    detail = `could not read agent state.db at ${dbPath}: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    agentDb?.close();
  }

  const result: ConstitutionCheckResult = {
    id: crypto.randomUUID(),
    opportunityId,
    agentAddress,
    outcome,
    violations,
    constitutionFileCompromised,
    detail,
    durationMs: Date.now() - startedAt,
    checkedAt: startedAt,
  };

  db.prepare(
    `INSERT INTO genesis_constitution_checks
       (id, opportunity_id, agent_address, outcome, violation_count, violations, constitution_file_compromised, detail, duration_ms, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.id,
    result.opportunityId,
    result.agentAddress,
    result.outcome,
    result.violations.length,
    JSON.stringify(result.violations),
    result.constitutionFileCompromised ? 1 : 0,
    result.detail,
    result.durationMs,
    result.checkedAt,
  );

  if (outcome !== "passed") {
    throw new ConstitutionComplianceFailure(result);
  }
  return result;
}

/** Most recent constitution-check row for an agent, or undefined if
 *  none has run yet. Read-only convenience for 17e-iv and any future
 *  status UI — not used by checkTickConstitutionCompliance() itself. */
export function getLatestConstitutionCheck(agentAddress: string): ConstitutionCheckResult | undefined {
  const row = db
    .prepare(
      `SELECT id, opportunity_id as opportunityId, agent_address as agentAddress,
              outcome, violations, constitution_file_compromised as constitutionFileCompromised,
              detail, duration_ms as durationMs, checked_at as checkedAt
       FROM genesis_constitution_checks
       WHERE agent_address = ?
       ORDER BY checked_at DESC
       LIMIT 1`,
    )
    .get(agentAddress) as
    | (Omit<ConstitutionCheckResult, "violations" | "constitutionFileCompromised"> & {
        violations: string;
        constitutionFileCompromised: number;
      })
    | undefined;
  if (!row) return undefined;
  return {
    ...row,
    violations: JSON.parse(row.violations),
    constitutionFileCompromised: row.constitutionFileCompromised === 1,
  };
}
