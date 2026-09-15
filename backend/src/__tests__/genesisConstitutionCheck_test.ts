// Zent.md Phase 17e-iii: "Constitution/guard compliance check on that
// tick: verify the tick's actions passed the same three-law
// constitution checks (17b) as any ordinary tick — a tick that
// completes but also violates its constitution should not pass the
// smoke test."
//
// Same "no live better-sqlite3" reason every other genesis*_test.ts
// file in this directory already gives (see genesisTickSmokeTest_test.ts's
// own header) — this mirrors checkTickConstitutionCompliance()'s
// classification logic field-for-field against an in-memory stand-in
// for Agent B's own state.db (policy_decisions rows + the kv
// compromised flag) and an in-memory stand-in for the
// genesis_constitution_checks table, rather than a real agent runtime
// database file. Recommend re-running against the real
// genesisConstitutionCheck.ts once a networked environment with a real
// better-sqlite3 build is available.
//
// What this covers:
//   - passed: no non-'allow' policy_decisions rows, kv compromised flag
//     unset/'0' -> outcome 'passed', row written, promise does not
//     throw (mirrors the function's return-not-throw contract).
//   - violated (policy denial): at least one 'deny' or 'quarantine'
//     policy_decisions row -> outcome 'violated', violations array
//     populated with toolName/decision/riskLevel/rulesTriggered/reason
//     for every non-'allow' row, throws ConstitutionComplianceFailure.
//   - violated (constitution tampering): kv compromised flag = '1',
//     even with zero policy denials -> outcome 'violated',
//     constitutionFileCompromised true, detail includes the recorded
//     compromised-detail string. Checked ahead of the violations-only
//     path, matching the real function's if/else-if order.
//   - violated (both at once): compromised flag set AND policy
//     denials present -> outcome 'violated', detail mentions both,
//     violations array still populated (not dropped just because the
//     compromise path already decided the outcome).
//   - unavailable: reading Agent B's state.db throws (missing file,
//     missing tables) -> outcome 'unavailable', distinct from both
//     'passed' and 'violated' — this check found nothing wrong, it
//     found nothing it could check. Still writes exactly one row and
//     still throws ConstitutionComplianceFailure (a caller cannot tell
//     "definitely fine" from "couldn't tell" without inspecting
//     .result.outcome, so both non-'passed' cases must throw the same
//     way runFirstTickSmokeTest()'s three failure categories do).
//   - Every outcome writes exactly one row, unconditionally.
//   - ConstitutionComplianceFailure.result matches the row written for
//     that attempt, field-for-field, same contract
//     TickSmokeTestFailure.result already has.

import { test } from "node:test";
import assert from "node:assert/strict";

type ConstitutionCheckOutcome = "passed" | "violated" | "unavailable";

interface ConstitutionViolation {
  toolName: string;
  decision: "deny" | "quarantine";
  riskLevel: string;
  rulesTriggered: string[];
  reason: string;
}

interface ConstitutionCheckResult {
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

class ConstitutionComplianceFailure extends Error {
  readonly result: ConstitutionCheckResult;
  constructor(result: ConstitutionCheckResult) {
    super(
      `genesis constitution compliance check failed for agent ${result.agentAddress}: ${result.outcome} — ${result.detail}`,
    );
    this.name = "ConstitutionComplianceFailure";
    this.result = result;
  }
}

// ─── Fake Agent B state.db ──────────────────────────────────────

interface FakePolicyDecisionRow {
  tool_name: string;
  decision: "allow" | "deny" | "quarantine";
  risk_level: string;
  rules_triggered: string; // JSON string, same as the real column
  reason: string;
}

interface FakeAgentDb {
  policyDecisions: FakePolicyDecisionRow[];
  kv: Record<string, string>;
  throwOnOpen?: string; // if set, reading this "db" throws with this message
}

let rows: ConstitutionCheckResult[];
let nextId: number;
let agentDbs: Record<string, FakeAgentDb>;

function reset() {
  rows = [];
  nextId = 1;
  agentDbs = {};
}

function insertRow(result: ConstitutionCheckResult) {
  rows.push(result);
}

// Mirrors genesisConstitutionCheck.ts's checkTickConstitutionCompliance()
// field-for-field: same try/catch-as-'unavailable' shape, same
// compromised-checked-before-violations-only ordering, same
// "write unconditionally, throw only on non-pass" contract
// runFirstTickSmokeTest() already established for this file family.
function checkTickConstitutionCompliance(
  opportunityId: string,
  agentAddress: string,
): ConstitutionCheckResult {
  const startedAt = 1_000_000;

  let outcome: ConstitutionCheckOutcome;
  let violations: ConstitutionViolation[] = [];
  let constitutionFileCompromised = false;
  let detail: string;

  try {
    const agentDb = agentDbs[agentAddress];
    if (!agentDb) {
      throw new Error(`no such agent db: ${agentAddress}`);
    }
    if (agentDb.throwOnOpen) {
      throw new Error(agentDb.throwOnOpen);
    }

    const denyRows = agentDb.policyDecisions.filter((r) => r.decision !== "allow");
    violations = denyRows.map((row) => {
      let rulesTriggered: string[] = [];
      try {
        rulesTriggered = JSON.parse(row.rules_triggered);
      } catch {
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

    constitutionFileCompromised = agentDb.kv["constitution_compromised"] === "1";

    if (constitutionFileCompromised) {
      outcome = "violated";
      detail =
        `constitution.md integrity check failed: ` +
        (agentDb.kv["constitution_compromised_detail"] ?? "constitution integrity check failed") +
        (violations.length > 0
          ? `; additionally ${violations.length} non-'allow' policy decision(s) recorded for this tick`
          : "");
    } else if (violations.length > 0) {
      outcome = "violated";
      detail =
        `${violations.length} non-'allow' policy decision(s) recorded for this tick: ` +
        violations.map((v) => `${v.toolName} -> ${v.decision} (${v.reason})`).join("; ");
    } else {
      outcome = "passed";
      detail = "no policy denials/quarantines recorded for this tick; constitution.md hash intact";
    }
  } catch (err) {
    outcome = "unavailable";
    detail = `could not read agent state.db: ${err instanceof Error ? err.message : String(err)}`;
  }

  const result: ConstitutionCheckResult = {
    id: `cc-${nextId++}`,
    opportunityId,
    agentAddress,
    outcome,
    violations,
    constitutionFileCompromised,
    detail,
    durationMs: 7,
    checkedAt: startedAt,
  };

  insertRow(result);

  if (outcome !== "passed") {
    throw new ConstitutionComplianceFailure(result);
  }
  return result;
}

test("passed: no policy denials, constitution intact -> resolves, row recorded as passed", () => {
  reset();
  agentDbs["0xAgentB"] = {
    policyDecisions: [
      { tool_name: "read_file", decision: "allow", risk_level: "safe", rules_triggered: "[]", reason: "" },
    ],
    kv: {},
  };

  const result = checkTickConstitutionCompliance("opp-1", "0xAgentB");

  assert.equal(result.outcome, "passed");
  assert.equal(result.violations.length, 0);
  assert.equal(result.constitutionFileCompromised, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "passed");
});

test("violated: a single 'deny' policy decision fails the tick", () => {
  reset();
  agentDbs["0xAgentB"] = {
    policyDecisions: [
      { tool_name: "send_payment", decision: "allow", risk_level: "caution", rules_triggered: "[]", reason: "" },
      {
        tool_name: "exec_shell",
        decision: "deny",
        risk_level: "forbidden",
        rules_triggered: '["command-safety:no-rm-rf"]',
        reason: "destructive command blocked",
      },
    ],
    kv: {},
  };

  assert.throws(
    () => checkTickConstitutionCompliance("opp-2", "0xAgentB"),
    (err: unknown) => {
      assert.ok(err instanceof ConstitutionComplianceFailure);
      assert.equal(err.result.outcome, "violated");
      assert.equal(err.result.violations.length, 1);
      assert.equal(err.result.violations[0].toolName, "exec_shell");
      assert.equal(err.result.violations[0].decision, "deny");
      assert.deepEqual(err.result.violations[0].rulesTriggered, ["command-safety:no-rm-rf"]);
      return true;
    },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "violated");
});

test("violated: a 'quarantine' decision also fails the tick, not just 'deny'", () => {
  reset();
  agentDbs["0xAgentB"] = {
    policyDecisions: [
      {
        tool_name: "browse_url",
        decision: "quarantine",
        risk_level: "dangerous",
        rules_triggered: '["injection-defense:suspicious-content"]',
        reason: "possible prompt injection in fetched page",
      },
    ],
    kv: {},
  };

  assert.throws(
    () => checkTickConstitutionCompliance("opp-3", "0xAgentB"),
    (err: unknown) => {
      assert.ok(err instanceof ConstitutionComplianceFailure);
      assert.equal(err.result.outcome, "violated");
      assert.equal(err.result.violations[0].decision, "quarantine");
      return true;
    },
  );
});

test("violated: constitution file compromised fails the tick even with zero policy denials", () => {
  reset();
  agentDbs["0xAgentB"] = {
    policyDecisions: [
      { tool_name: "read_file", decision: "allow", risk_level: "safe", rules_triggered: "[]", reason: "" },
    ],
    kv: {
      constitution_compromised: "1",
      constitution_compromised_detail: "constitution.md at /root/.automaton/constitution.md does not match the hash recorded at genesis",
    },
  };

  assert.throws(
    () => checkTickConstitutionCompliance("opp-4", "0xAgentB"),
    (err: unknown) => {
      assert.ok(err instanceof ConstitutionComplianceFailure);
      assert.equal(err.result.outcome, "violated");
      assert.equal(err.result.constitutionFileCompromised, true);
      assert.equal(err.result.violations.length, 0);
      assert.match(err.result.detail, /does not match the hash recorded at genesis/);
      return true;
    },
  );
});

test("violated: compromised flag AND policy denials both surface in the same result", () => {
  reset();
  agentDbs["0xAgentB"] = {
    policyDecisions: [
      { tool_name: "exec_shell", decision: "deny", risk_level: "forbidden", rules_triggered: "[]", reason: "blocked" },
    ],
    kv: { constitution_compromised: "1", constitution_compromised_detail: "tampered" },
  };

  assert.throws(
    () => checkTickConstitutionCompliance("opp-5", "0xAgentB"),
    (err: unknown) => {
      assert.ok(err instanceof ConstitutionComplianceFailure);
      assert.equal(err.result.constitutionFileCompromised, true);
      assert.equal(err.result.violations.length, 1);
      assert.match(err.result.detail, /tampered/);
      assert.match(err.result.detail, /additionally 1 non-'allow' policy decision/);
      return true;
    },
  );
});

test("unavailable: unreadable state.db is its own category, not 'passed' or 'violated'", () => {
  reset();
  agentDbs["0xAgentB"] = {
    policyDecisions: [],
    kv: {},
    throwOnOpen: "ENOENT: no such file or directory, state.db",
  };

  assert.throws(
    () => checkTickConstitutionCompliance("opp-6", "0xAgentB"),
    (err: unknown) => {
      assert.ok(err instanceof ConstitutionComplianceFailure);
      assert.equal(err.result.outcome, "unavailable");
      assert.equal(err.result.violations.length, 0);
      assert.match(err.result.detail, /ENOENT/);
      return true;
    },
  );
  assert.equal(rows[0].outcome, "unavailable");
});

test("unavailable: no db registered for this agent address at all", () => {
  reset();
  assert.throws(
    () => checkTickConstitutionCompliance("opp-7", "0xNoSuchAgent"),
    (err: unknown) => {
      assert.ok(err instanceof ConstitutionComplianceFailure);
      assert.equal(err.result.outcome, "unavailable");
      return true;
    },
  );
});

test("every outcome writes exactly one row, pass/violated/unavailable alike", () => {
  reset();
  agentDbs["0xAgentB"] = { policyDecisions: [], kv: {} };
  checkTickConstitutionCompliance("opp-8", "0xAgentB");

  agentDbs["0xAgentC"] = {
    policyDecisions: [{ tool_name: "x", decision: "deny", risk_level: "forbidden", rules_triggered: "[]", reason: "r" }],
    kv: {},
  };
  assert.throws(() => checkTickConstitutionCompliance("opp-9", "0xAgentC"));

  agentDbs["0xAgentD"] = { policyDecisions: [], kv: {}, throwOnOpen: "boom" };
  assert.throws(() => checkTickConstitutionCompliance("opp-10", "0xAgentD"));

  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.outcome),
    ["passed", "violated", "unavailable"],
  );
});

test("ConstitutionComplianceFailure.result matches the row written for that attempt", () => {
  reset();
  agentDbs["0xAgentB"] = {
    policyDecisions: [
      { tool_name: "spawn_clone", decision: "deny", risk_level: "forbidden", rules_triggered: '["authority:no-recursive-genesis"]', reason: "blocked" },
    ],
    kv: {},
  };

  assert.throws(
    () => checkTickConstitutionCompliance("opp-11", "0xAgentB"),
    (err: unknown) => {
      assert.ok(err instanceof ConstitutionComplianceFailure);
      assert.deepEqual(err.result, rows[0]);
      return true;
    },
  );
});
