import crypto from "crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { spawnAgentProcessTickOnce } from "./orchestrator.js";

/**
 * Zent.md Phase 17e-ii — "Full-tick completion assertion: run one tick
 * to completion and assert no unhandled error, timeout, or crashed
 * sandbox — the 'done when' for whether the loop itself runs at all."
 *
 * Builds directly on 17e-i (agent/src/index.ts's runSingleTick() +
 * `automaton --tick-once`): that harness's own contract is "if the tick
 * throws, this function throws — nothing here catches it," specifically
 * so a caller here could tell a clean tick from a crashed one via its
 * own process exit code. This file is that caller, invoked from the
 * *backend* side (which owns the Docker sandbox the tick actually runs
 * in) rather than re-implementing any part of the tick loop itself.
 *
 * Three, and only three, failure categories, matching Zent.md's own
 * wording exactly:
 *   - "unhandled error"   -> `automaton --tick-once` ran to exit but
 *                            exited non-zero (index.ts's own catch logs
 *                            the error and calls process.exit(1)).
 *   - "timeout"           -> the process was still running when
 *                            config.genesisTickSmokeTestTimeoutMs
 *                            elapsed (spawnAgentProcessTickOnce()'s own
 *                            `timedOut` flag).
 *   - "crashed process"   -> the process itself couldn't even start —
 *                            spawn() threw, or the agent record didn't
 *                            exist/wasn't active, which is a different
 *                            failure than the tick loop inside it
 *                            exiting badly.
 *
 * PHASE-17D-IV correction: this file previously ran `automaton
 * --tick-once` via execInNamedSandbox(), inside Agent B's own Docker
 * sandbox. That was never actually reachable — genesisCompany()
 * (genesis.ts) never provisioned a ~/.automaton for that sandbox (no
 * wallet.json, no automaton.json, no backend API key), and the sandbox
 * itself runs with ReadonlyRootfs: true and only /workspace + a
 * browser-profile mount writable (docker.ts's createNamedSandbox), so
 * there was nowhere writable to put one even if something had tried.
 * Every genesis's first tick would time out (hung on the interactive
 * setup wizard's stdin prompts, which never resolve under a
 * non-interactive exec) or exit non-zero (missing API key) — this
 * table has never recorded a real `passed` outcome. This file now runs
 * the tick as a real OS process instead (orchestrator.ts's
 * spawnAgentProcessTickOnce(), against this repo's real agent/
 * runtime), using the identity genesis.ts's provisionAgentRuntimeIdentity()
 * now materializes for Agent B before this ever runs. See
 * PHASE-17D-IV-NOTES.md for the full chain of fixes this closes.
 *
 * Nothing here evaluates *what* the tick did (tool calls made, turns
 * completed, constitution compliance) — that is explicitly 17e-iii's
 * job, not this one. "Done when the loop itself runs at all" is the
 * whole of 17e-ii's scope, and this file does not reach past it.
 *
 * No human override, same posture as every other Zent.md phase in this
 * codebase: runFirstTickSmokeTest() is called automatically by
 * genesis.ts's genesisExecutorAdapter() right after a birth completes
 * (see that file's own comment for why a failing smoke test does not
 * retroactively fail the already-'completed' genesis trigger) — there
 * is no operator approval step anywhere in this path, and none is added
 * here. This also does not call expansionCircuitBreaker.ts's
 * haltExpansionPipeline(): that function is explicitly reserved for
 * 17e-iii/17e-iv (see its own header), since deciding that a failed
 * *loop* (this phase) — as opposed to a constitution violation
 * (17e-iii) or a repeated pattern of failures — should halt the whole
 * pipeline for a root agent is a judgment call those later phases still
 * need to make, not this one.
 */

export type TickSmokeTestOutcome = "passed" | "unhandled_error" | "timeout" | "crashed_process";

export interface TickSmokeTestResult {
  id: string;
  opportunityId: string;
  agentAddress: string;
  outcome: TickSmokeTestOutcome;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
  ranAt: number;
}

/**
 * Thrown by runFirstTickSmokeTest() for every outcome other than
 * 'passed'. Carries the full result (already written to the
 * genesis_tick_smoke_tests table by the time this is thrown) so a
 * caller can inspect exactly which of the three categories fired and
 * why, rather than parsing an error message.
 */
export class TickSmokeTestFailure extends Error {
  readonly result: TickSmokeTestResult;

  constructor(result: TickSmokeTestResult) {
    super(
      `genesis first-tick smoke test failed for agent ${result.agentAddress} ` +
        `(opportunity ${result.opportunityId}): ${result.outcome}` +
        (result.outcome === "unhandled_error" ? ` (exit code ${result.exitCode})` : ""),
    );
    this.name = "TickSmokeTestFailure";
    this.result = result;
  }
}

/**
 * Runs `automaton --tick-once` as a real OS process for Agent B — the
 * exact same binary/flag 17e-i wired up, now invoked via
 * orchestrator.ts's spawnAgentProcessTickOnce() against this repo's
 * real agent/ runtime and the identity genesis.ts's
 * provisionAgentRuntimeIdentity() already wrote for this agent address
 * (see this file's own header, PHASE-17D-IV, for why the old
 * execInNamedSandbox()-based version could never actually pass).
 * Classifies the outcome, writes one row to genesis_tick_smoke_tests
 * unconditionally (pass or fail — this table is a complete history,
 * not just a failure log), and throws TickSmokeTestFailure for
 * anything other than a clean pass.
 *
 * `sandboxId` stays in the signature/row for backward-compatible
 * history and because callers (genesisExecutorAdapter()) already have
 * it on hand — it is no longer used to select where the tick runs.
 *
 * A thrown TickSmokeTestFailure is the *intended* signal for a bad
 * tick — this function does not swallow that category itself, matching
 * this codebase's "assert, don't silently degrade" convention for
 * every other genesis-family write (see genesis.ts's
 * verifyPrebirthKnowledgeWrites(), for one). What a caller does with
 * that thrown failure (retry, halt the pipeline, leave Agent B
 * pre-active) is explicitly out of scope here — see this file's own
 * header.
 */
export async function runFirstTickSmokeTest(
  opportunityId: string,
  agentAddress: string,
  sandboxId: string,
): Promise<TickSmokeTestResult> {
  const startedAt = Date.now();

  let outcome: TickSmokeTestOutcome;
  let exitCode: number | null = null;
  let timedOut = false;
  let stdout = "";
  let stderr = "";

  const tick = await spawnAgentProcessTickOnce(
    agentAddress,
    config.genesisTickSmokeTestTimeoutMs,
    config.genesisTickSmokeTestMaxOutputBytes,
  );
  exitCode = tick.exitCode;
  timedOut = tick.timedOut;
  stdout = tick.stdout;
  stderr = tick.crashed ? (tick.crashReason ?? tick.stderr) : tick.stderr;

  if (tick.crashed) {
    // spawn() itself never produced a running process — no such agent,
    // agent not active, or the entrypoint couldn't launch. Same
    // distinct-category posture the old dockerode-throws case had:
    // this is not the tick loop exiting badly, it's the process never
    // existing at all.
    outcome = "crashed_process";
  } else if (timedOut) {
    outcome = "timeout";
  } else if (exitCode !== 0) {
    outcome = "unhandled_error";
  } else {
    outcome = "passed";
  }

  const result: TickSmokeTestResult = {
    id: crypto.randomUUID(),
    opportunityId,
    agentAddress,
    outcome,
    exitCode,
    timedOut,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    ranAt: startedAt,
  };

  db.prepare(
    `INSERT INTO genesis_tick_smoke_tests
       (id, opportunity_id, agent_address, outcome, exit_code, timed_out, stdout, stderr, duration_ms, ran_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    result.id,
    result.opportunityId,
    result.agentAddress,
    result.outcome,
    result.exitCode,
    result.timedOut ? 1 : 0,
    result.stdout,
    result.stderr,
    result.durationMs,
    result.ranAt,
  );

  if (outcome !== "passed") {
    throw new TickSmokeTestFailure(result);
  }
  return result;
}

/** Most recent smoke-test row for an agent, or undefined if none has
 *  run yet. Read-only convenience for 17e-iii/iv and any future status
 *  UI — not used by runFirstTickSmokeTest() itself. */
export function getLatestTickSmokeTest(agentAddress: string): TickSmokeTestResult | undefined {
  const row = db
    .prepare(
      `SELECT id, opportunity_id as opportunityId, agent_address as agentAddress,
              outcome, exit_code as exitCode, timed_out as timedOut,
              stdout, stderr, duration_ms as durationMs, ran_at as ranAt
       FROM genesis_tick_smoke_tests
       WHERE agent_address = ?
       ORDER BY ran_at DESC
       LIMIT 1`,
    )
    .get(agentAddress) as
    | (Omit<TickSmokeTestResult, "timedOut"> & { timedOut: number })
    | undefined;
  if (!row) return undefined;
  return { ...row, timedOut: row.timedOut === 1 };
}
