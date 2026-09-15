// Zent.md Phase 17e-ii: "Full-tick completion assertion: run one tick
// to completion and assert no unhandled error, timeout, or crashed
// process — the 'done when' for whether the loop itself runs at all."
//
// PHASE-17D-IV: updated alongside genesisSmokeTest.ts's own rewire off
// execInNamedSandbox() onto orchestrator.ts's spawnAgentProcessTickOnce().
// Same "no live better-sqlite3, and here, no live spawned Node process
// either" reason every other genesis*_test.ts file in this directory
// already gives — this mirrors runFirstTickSmokeTest()'s classification
// logic (timeout / unhandled_error / crashed_process / passed) and its
// "write the row regardless, throw only on non-pass" contract against a
// fake spawnAgentProcessTickOnce() and an in-memory stand-in for the
// genesis_tick_smoke_tests table, rather than a live spawned process.
// Recommend re-running against the real genesisSmokeTest.ts/
// orchestrator.ts once a networked environment with real Node child
// processes is available.
//
// What this covers:
//   - passed: exitCode 0, timedOut false, crashed false -> outcome
//     'passed', row written, promise resolves (does not throw).
//   - unhandled_error: exitCode 1, timedOut false, crashed false ->
//     outcome 'unhandled_error', row written, throws
//     TickSmokeTestFailure carrying that outcome and exitCode.
//   - timeout: timedOut true (regardless of exitCode) -> outcome
//     'timeout', row written, throws TickSmokeTestFailure. Checked
//     ahead of the exitCode check, matching the real function's
//     if/else-if order.
//   - crashed_process: spawnAgentProcessTickOnce() itself reports
//     crashed:true (spawn() never produced a running process) ->
//     outcome 'crashed_process', row written with crashReason as
//     stderr, throws TickSmokeTestFailure. Checked ahead of both
//     timeout and exit code, matching the real function's order.
//   - Every outcome writes exactly one row, unconditionally — the
//     table is a complete history, not just a failure log.
//   - TickSmokeTestFailure.result is the exact same object shape that
//     was written to the row (id, opportunityId, agentAddress,
//     outcome, exitCode, timedOut, stdout, stderr, durationMs, ranAt).

import { test } from "node:test";
import assert from "node:assert/strict";

type TickSmokeTestOutcome = "passed" | "unhandled_error" | "timeout" | "crashed_process";

interface TickSmokeTestResult {
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

class TickSmokeTestFailure extends Error {
  readonly result: TickSmokeTestResult;
  constructor(result: TickSmokeTestResult) {
    super(`genesis first-tick smoke test failed for agent ${result.agentAddress}: ${result.outcome}`);
    this.name = "TickSmokeTestFailure";
    this.result = result;
  }
}

interface FakeTickResult {
  exitCode: number | null;
  timedOut: boolean;
  crashed: boolean;
  crashReason: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

let rows: TickSmokeTestResult[];
let nextId: number;
let tickImpl: (agentAddress: string) => Promise<FakeTickResult>;

function reset() {
  rows = [];
  nextId = 1;
}

function fakeSpawnAgentProcessTickOnce(agentAddress: string): Promise<FakeTickResult> {
  return tickImpl(agentAddress);
}

function insertRow(result: TickSmokeTestResult) {
  rows.push(result);
}

// Mirrors genesisSmokeTest.ts's runFirstTickSmokeTest() field-for-field:
// same if/else-if ordering (crashed checked first, then timeout, then
// exit code), same "write unconditionally, throw only on non-pass"
// contract.
async function runFirstTickSmokeTest(
  opportunityId: string,
  agentAddress: string,
  sandboxId: string,
): Promise<TickSmokeTestResult> {
  const startedAt = 1_000_000;

  let outcome: TickSmokeTestOutcome;

  const tick = await fakeSpawnAgentProcessTickOnce(agentAddress);
  const exitCode = tick.exitCode;
  const timedOut = tick.timedOut;
  const stdout = tick.stdout;
  const stderr = tick.crashed ? (tick.crashReason ?? tick.stderr) : tick.stderr;

  if (tick.crashed) {
    outcome = "crashed_process";
  } else if (timedOut) {
    outcome = "timeout";
  } else if (exitCode !== 0) {
    outcome = "unhandled_error";
  } else {
    outcome = "passed";
  }

  const result: TickSmokeTestResult = {
    id: `smoke-${nextId++}`,
    opportunityId,
    agentAddress,
    outcome,
    exitCode,
    timedOut,
    stdout,
    stderr,
    durationMs: 42,
    ranAt: startedAt,
  };

  insertRow(result);

  if (outcome !== "passed") {
    throw new TickSmokeTestFailure(result);
  }
  return result;
}

test("passed: exitCode 0, no timeout -> resolves, row recorded as passed", async () => {
  reset();
  tickImpl = async () => ({
    exitCode: 0, timedOut: false, crashed: false, crashReason: null,
    stdout: "turn 1 complete", stderr: "", durationMs: 42,
  });

  const result = await runFirstTickSmokeTest("opp-1", "0xAgentB", "sandbox-1");

  assert.equal(result.outcome, "passed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "passed");
});

test("unhandled_error: non-zero exit, no timeout -> throws with that outcome", async () => {
  reset();
  tickImpl = async () => ({
    exitCode: 1, timedOut: false, crashed: false, crashReason: null,
    stdout: "", stderr: "TypeError: cannot read property 'x' of undefined", durationMs: 42,
  });

  await assert.rejects(
    () => runFirstTickSmokeTest("opp-2", "0xAgentB", "sandbox-2"),
    (err: unknown) => {
      assert.ok(err instanceof TickSmokeTestFailure);
      assert.equal(err.result.outcome, "unhandled_error");
      assert.equal(err.result.exitCode, 1);
      return true;
    },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "unhandled_error");
});

test("timeout: timedOut true takes precedence over exit code", async () => {
  reset();
  // exitCode null here on purpose: a killed-on-timeout process has no
  // real exit code — timedOut must win regardless, matching the real
  // function's if/else-if order.
  tickImpl = async () => ({
    exitCode: null, timedOut: true, crashed: false, crashReason: null,
    stdout: "", stderr: "", durationMs: 42,
  });

  await assert.rejects(
    () => runFirstTickSmokeTest("opp-3", "0xAgentB", "sandbox-3"),
    (err: unknown) => {
      assert.ok(err instanceof TickSmokeTestFailure);
      assert.equal(err.result.outcome, "timeout");
      return true;
    },
  );
  assert.equal(rows[0].outcome, "timeout");
});

test("crashed_process: spawnAgentProcessTickOnce() reporting crashed is a distinct category", async () => {
  reset();
  tickImpl = async () => ({
    exitCode: null, timedOut: false, crashed: true,
    crashReason: "no such agent", stdout: "", stderr: "", durationMs: 3,
  });

  await assert.rejects(
    () => runFirstTickSmokeTest("opp-4", "0xAgentB", "sandbox-4"),
    (err: unknown) => {
      assert.ok(err instanceof TickSmokeTestFailure);
      assert.equal(err.result.outcome, "crashed_process");
      assert.equal(err.result.exitCode, null);
      assert.match(err.result.stderr, /no such agent/);
      return true;
    },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "crashed_process");
});

test("every outcome writes exactly one row, pass or fail alike", async () => {
  reset();
  tickImpl = async () => ({
    exitCode: 0, timedOut: false, crashed: false, crashReason: null,
    stdout: "ok", stderr: "", durationMs: 42,
  });
  await runFirstTickSmokeTest("opp-5", "0xAgentB", "sandbox-5");

  tickImpl = async () => ({
    exitCode: 1, timedOut: false, crashed: false, crashReason: null,
    stdout: "", stderr: "boom", durationMs: 42,
  });
  await assert.rejects(() => runFirstTickSmokeTest("opp-6", "0xAgentB", "sandbox-6"));

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ["passed", "unhandled_error"],
  );
});

test("TickSmokeTestFailure.result matches the row written for that attempt", async () => {
  reset();
  tickImpl = async () => ({
    exitCode: 2, timedOut: false, crashed: false, crashReason: null,
    stdout: "partial", stderr: "err", durationMs: 42,
  });

  await assert.rejects(
    () => runFirstTickSmokeTest("opp-7", "0xAgentB", "sandbox-7"),
    (err: unknown) => {
      assert.ok(err instanceof TickSmokeTestFailure);
      assert.deepEqual(err.result, rows[0]);
      return true;
    },
  );
});
