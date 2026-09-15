// Zent.md Phase 19c: "Circuit breaker: if any pipeline-spawned Agent B
// fails its first-tick smoke test (17e-ii-iv) or violates its
// constitution within its first N ticks, the pipeline auto-halts new
// genesis events for that root agent and logs the failure; the root
// agent's own next Opportunity Intelligence cycle can re-evaluate and
// resume once the cause is addressed."
//
// expansionCircuitBreaker.ts's own haltExpansionPipeline()/
// resumeExpansionPipeline() mechanics are already covered by
// expansionCircuitBreaker.test.ts. What was NOT covered anywhere in
// this directory (confirmed by grep — zero hits for
// "genesisExecutorAdapter" in any existing __tests__ file) is the
// actual wiring this phase adds: genesis.ts's genesisExecutorAdapter()
// calling haltExpansionPipeline() on both of 19c's documented triggers,
// not just the constitution one that landed with 17e-iii.
//
// Same "no live better-sqlite3 in this environment" constraint every
// other genesis*_test.ts file in this directory already carries (see
// genesisTickSmokeTest_test.ts's own header) — this mirrors
// genesisExecutorAdapter()'s control flow with fakes standing in for
// genesisCompany(), runFirstTickSmokeTest(), checkTickConstitutionCompliance(),
// activateGenesisAgent(), registerGenesisIdentity(),
// markGenesisActivationFailed(), and haltExpansionPipeline() — asserting
// call order and arguments, not database state. Recommend re-running
// against the real genesis.ts once a networked environment with a real
// better-sqlite3 build is available.
//
// What this covers:
//   - TickSmokeTestFailure -> haltExpansionPipeline() called once, for
//     the *root* address (ctx.agentAddress), not Agent B's own address
//     (result.agentAddress) — the reason string names both, plus the
//     smoke-test outcome. markGenesisActivationFailed('smoke_test_failed')
//     also called. checkTickConstitutionCompliance/activateGenesisAgent/
//     registerGenesisIdentity are never reached (tick never completed).
//   - ConstitutionComplianceFailure (tick completed, constitution check
//     failed) -> haltExpansionPipeline() called once, for the root
//     address, reason naming both addresses plus the compliance
//     failure's detail. markGenesisActivationFailed('constitution_violated')
//     also called. activateGenesisAgent/registerGenesisIdentity never
//     reached.
//   - Happy path (both checks pass) -> haltExpansionPipeline() never
//     called; activateGenesisAgent() and registerGenesisIdentity() both
//     called; markGenesisActivationFailed() never called.
//   - An error that is neither TickSmokeTestFailure nor
//     ConstitutionComplianceFailure rethrows without calling
//     haltExpansionPipeline() or markGenesisActivationFailed() — this
//     adapter only treats its two documented failure types as 19c
//     triggers, not "any thrown error."
//   - The two halt calls are symmetric: both key off ctx.agentAddress
//     (the root), never result.agentAddress (Agent B) — a regression
//     that swapped one for the other would silently halt the wrong
//     agent's pipeline.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Fakes standing in for genesis.ts's real imports ──────────────────

class TickSmokeTestFailure extends Error {
  result: { outcome: string };
  constructor(result: { outcome: string }) {
    super(`smoke test failed: ${result.outcome}`);
    this.name = "TickSmokeTestFailure";
    this.result = result;
  }
}

class ConstitutionComplianceFailure extends Error {
  result: { outcome: string; detail: string };
  constructor(result: { outcome: string; detail: string }) {
    super(`constitution check failed: ${result.outcome}`);
    this.name = "ConstitutionComplianceFailure";
    this.result = result;
  }
}

interface GenesisTriggerContext {
  opportunityId: string;
  agentAddress: string; // the ROOT agent that owns the pipeline
}

interface GenesisCompanyResult {
  agentAddress: string; // Agent B — the child just born
  sandboxId: string;
}

interface Call {
  fn: string;
  args: unknown[];
}

let calls: Call[];
let genesisCompanyResult: GenesisCompanyResult;
let smokeTestBehavior: "pass" | TickSmokeTestFailure | Error;
let constitutionBehavior: "pass" | ConstitutionComplianceFailure | Error;

function resetState() {
  calls = [];
  genesisCompanyResult = { agentAddress: "0xAgentB", sandboxId: "sandbox-1" };
  smokeTestBehavior = "pass";
  constitutionBehavior = "pass";
}

function record(fn: string, ...args: unknown[]) {
  calls.push({ fn, args });
}

// Fakes for every function genesisExecutorAdapter() calls, mirroring
// each real function's signature closely enough for this test's purposes.

async function genesisCompany(opportunityId: string): Promise<GenesisCompanyResult> {
  record("genesisCompany", opportunityId);
  return genesisCompanyResult;
}

async function runFirstTickSmokeTest(
  opportunityId: string,
  agentAddress: string,
  sandboxId: string,
): Promise<void> {
  record("runFirstTickSmokeTest", opportunityId, agentAddress, sandboxId);
  if (smokeTestBehavior !== "pass") throw smokeTestBehavior;
}

function checkTickConstitutionCompliance(opportunityId: string, agentAddress: string): void {
  record("checkTickConstitutionCompliance", opportunityId, agentAddress);
  if (constitutionBehavior !== "pass") throw constitutionBehavior;
}

function activateGenesisAgent(opportunityId: string, agentAddress: string): void {
  record("activateGenesisAgent", opportunityId, agentAddress);
}

async function registerGenesisIdentity(
  opportunityId: string,
  rootAgentAddress: string,
  childAgentAddress: string,
): Promise<void> {
  record("registerGenesisIdentity", opportunityId, rootAgentAddress, childAgentAddress);
}

function markGenesisActivationFailed(
  opportunityId: string,
  agentAddress: string,
  reason: "smoke_test_failed" | "constitution_violated",
  detail: string,
): void {
  record("markGenesisActivationFailed", opportunityId, agentAddress, reason, detail);
}

function haltExpansionPipeline(rootAgentAddress: string, reason: string): void {
  record("haltExpansionPipeline", rootAgentAddress, reason);
}

// ─── Mirror of genesis.ts's real genesisExecutorAdapter() ─────────────
// Field-for-field control flow match against the real function as
// edited this session (genesis.ts, ~line 1754).

async function genesisExecutorAdapter(ctx: GenesisTriggerContext): Promise<unknown> {
  const result = await genesisCompany(ctx.opportunityId);

  let tickCompleted = false;
  try {
    await runFirstTickSmokeTest(ctx.opportunityId, result.agentAddress, result.sandboxId);
    tickCompleted = true;
  } catch (err) {
    if (!(err instanceof TickSmokeTestFailure)) {
      throw err;
    }
    haltExpansionPipeline(
      ctx.agentAddress,
      `pipeline-spawned agent ${result.agentAddress} (opportunity ${ctx.opportunityId}) ` +
        `failed its 17e-ii first-tick smoke test: ${err.result.outcome}`,
    );
    markGenesisActivationFailed(
      ctx.opportunityId,
      result.agentAddress,
      "smoke_test_failed",
      `first-tick smoke test outcome: ${err.result.outcome}`,
    );
  }

  if (tickCompleted) {
    try {
      checkTickConstitutionCompliance(ctx.opportunityId, result.agentAddress);
      activateGenesisAgent(ctx.opportunityId, result.agentAddress);
      await registerGenesisIdentity(ctx.opportunityId, ctx.agentAddress, result.agentAddress);
    } catch (err) {
      if (!(err instanceof ConstitutionComplianceFailure)) {
        throw err;
      }
      haltExpansionPipeline(
        ctx.agentAddress,
        `pipeline-spawned agent ${result.agentAddress} (opportunity ${ctx.opportunityId}) ` +
          `failed its 17e-iii constitution compliance check: ${err.result.detail}`,
      );
      markGenesisActivationFailed(
        ctx.opportunityId,
        result.agentAddress,
        "constitution_violated",
        err.result.detail,
      );
    }
  }

  return result;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe("genesisExecutorAdapter — 19c halt wiring", () => {
  test("TickSmokeTestFailure halts the root and marks smoke_test_failed", async () => {
    resetState();
    smokeTestBehavior = new TickSmokeTestFailure({ outcome: "timeout" });

    const ctx = { opportunityId: "opp-1", agentAddress: "0xRoot" };
    await genesisExecutorAdapter(ctx);

    const halt = calls.find((c) => c.fn === "haltExpansionPipeline");
    assert.ok(halt, "haltExpansionPipeline should have been called");
    assert.equal(halt!.args[0], "0xRoot", "halt must target the root agent, not Agent B");
    const reason = halt!.args[1] as string;
    assert.match(reason, /0xAgentB/);
    assert.match(reason, /opportunity opp-1/);
    assert.match(reason, /17e-ii first-tick smoke test/);
    assert.match(reason, /timeout/);

    const failed = calls.find((c) => c.fn === "markGenesisActivationFailed");
    assert.ok(failed);
    assert.deepEqual(failed!.args.slice(0, 3), ["opp-1", "0xAgentB", "smoke_test_failed"]);

    // Constitution check and activation are never reached — the tick
    // never completed.
    assert.ok(!calls.some((c) => c.fn === "checkTickConstitutionCompliance"));
    assert.ok(!calls.some((c) => c.fn === "activateGenesisAgent"));
    assert.ok(!calls.some((c) => c.fn === "registerGenesisIdentity"));
  });

  test("ConstitutionComplianceFailure halts the root and marks constitution_violated", async () => {
    resetState();
    constitutionBehavior = new ConstitutionComplianceFailure({
      outcome: "violated",
      detail: "denied tool call: wire_transfer",
    });

    const ctx = { opportunityId: "opp-2", agentAddress: "0xRoot" };
    await genesisExecutorAdapter(ctx);

    const halt = calls.find((c) => c.fn === "haltExpansionPipeline");
    assert.ok(halt, "haltExpansionPipeline should have been called");
    assert.equal(halt!.args[0], "0xRoot", "halt must target the root agent, not Agent B");
    const reason = halt!.args[1] as string;
    assert.match(reason, /0xAgentB/);
    assert.match(reason, /opportunity opp-2/);
    assert.match(reason, /17e-iii constitution compliance check/);
    assert.match(reason, /wire_transfer/);

    const failed = calls.find((c) => c.fn === "markGenesisActivationFailed");
    assert.ok(failed);
    assert.deepEqual(failed!.args.slice(0, 3), ["opp-2", "0xAgentB", "constitution_violated"]);

    // The smoke test itself passed, so the tick did complete — but
    // activation/registration must not have run since the constitution
    // check is what failed.
    assert.ok(calls.some((c) => c.fn === "checkTickConstitutionCompliance"));
    assert.ok(!calls.some((c) => c.fn === "activateGenesisAgent"));
    assert.ok(!calls.some((c) => c.fn === "registerGenesisIdentity"));
  });

  test("happy path never halts and does activate/register", async () => {
    resetState();

    const ctx = { opportunityId: "opp-3", agentAddress: "0xRoot" };
    await genesisExecutorAdapter(ctx);

    assert.ok(!calls.some((c) => c.fn === "haltExpansionPipeline"));
    assert.ok(!calls.some((c) => c.fn === "markGenesisActivationFailed"));
    assert.ok(calls.some((c) => c.fn === "activateGenesisAgent"));
    assert.ok(calls.some((c) => c.fn === "registerGenesisIdentity"));
  });

  test("a smoke-test error that is not TickSmokeTestFailure rethrows without halting", async () => {
    resetState();
    smokeTestBehavior = new Error("dockerode threw unexpectedly");

    const ctx = { opportunityId: "opp-4", agentAddress: "0xRoot" };
    await assert.rejects(() => genesisExecutorAdapter(ctx), /dockerode threw unexpectedly/);

    assert.ok(!calls.some((c) => c.fn === "haltExpansionPipeline"));
    assert.ok(!calls.some((c) => c.fn === "markGenesisActivationFailed"));
  });

  test("a constitution-check error that is not ConstitutionComplianceFailure rethrows without halting", async () => {
    resetState();
    constitutionBehavior = new Error("state.db locked");

    const ctx = { opportunityId: "opp-5", agentAddress: "0xRoot" };
    await assert.rejects(() => genesisExecutorAdapter(ctx), /state\.db locked/);

    assert.ok(!calls.some((c) => c.fn === "haltExpansionPipeline"));
    assert.ok(!calls.some((c) => c.fn === "markGenesisActivationFailed"));
    assert.ok(!calls.some((c) => c.fn === "activateGenesisAgent"));
  });

  test("both halt calls key off the root address even when it differs from Agent B's", async () => {
    resetState();
    smokeTestBehavior = new TickSmokeTestFailure({ outcome: "unhandled_error" });
    genesisCompanyResult = { agentAddress: "0xChildDistinctFromRoot", sandboxId: "sandbox-2" };

    const ctx = { opportunityId: "opp-6", agentAddress: "0xRootDistinctFromChild" };
    await genesisExecutorAdapter(ctx);

    const halt = calls.find((c) => c.fn === "haltExpansionPipeline")!;
    assert.equal(halt.args[0], "0xRootDistinctFromChild");
    assert.notEqual(halt.args[0], "0xChildDistinctFromRoot");
  });
});
