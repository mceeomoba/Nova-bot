// next-phase.md Phase 2g, second pass (architecture-agent.md §4g): tests
// for environment.ts's resolveEnvironmentForSubAgent() — the function
// that finally makes capability.ts's `environment`/`grantedEnvironment`
// dimensions real (see capability.test.ts's own note on why Phase 2g's
// first pass had nothing but the Worker-382 worked example to test
// against: every worker/department shared one flat default sandbox, so
// there was no real per-grant environment to resolve or compare).
//
// Same constraint every prior backend/src test file in this repo has
// flagged (capability.test.ts, departmentToolProfiles.test.ts): no
// network access to `npm install` better-sqlite3 here, so
// resolveEnvironmentForSubAgent() itself (which calls db.prepare(...))
// can't be imported and exercised end-to-end. What's tested here is the
// exact same three-way decision tree — department / department-worker /
// project-worker / flat-worker — with the one DB lookup
// (resolveEnvironmentForSubAgent makes exactly one: "does this row's
// owner_address resolve to a running department row") replaced by a
// plain in-memory Map standing in for the sub_agents table, and the
// scope_id construction (`{kind}-{scopeId}`) kept byte-for-byte in sync
// with vmService.ts's getOrCreateScopedSandbox() and environment.ts's
// resolveDepartmentEnvironment()/resolveProjectEnvironment(). Before
// deploying, re-run these same cases against the real function with a
// live sqlite3 DB (`npm install && npx tsc && node dist/__tests__/
// environment.test.js`) to confirm this inlined copy hasn't drifted.

import { test } from "node:test";
import assert from "node:assert/strict";

interface SubAgentRow {
  id: string;
  owner_address: string;
  kind: "worker" | "department";
  project_id: string | null;
}

// Stand-in for `SELECT id FROM sub_agents WHERE id = ? AND kind =
// 'department'` — environment.ts's ONLY db call. Given a fake table
// (a Map keyed by id), mirrors resolveEnvironmentForSubAgent()'s logic
// exactly, including its own comments' reasoning for each branch.
function resolveEnvironmentId(row: SubAgentRow, table: Map<string, SubAgentRow>): string {
  if (row.kind === "department") {
    return `sbx-department-${row.id}`;
  }
  const ownerRow = table.get(row.owner_address);
  const isDepartmentWorker = ownerRow && ownerRow.kind === "department";
  if (isDepartmentWorker) {
    const deptId = ownerRow!.id;
    if (row.project_id) {
      return `sbx-project-${deptId}_${row.project_id}`;
    }
    return `sbx-department-${deptId}`;
  }
  return `sbx-default-${row.owner_address}`;
}

function buildTable(rows: SubAgentRow[]): Map<string, SubAgentRow> {
  const m = new Map<string, SubAgentRow>();
  for (const r of rows) m.set(r.id, r);
  return m;
}

test("a department row resolves to its own dedicated environment", () => {
  const table = buildTable([
    { id: "dept_1", owner_address: "agentA", kind: "department", project_id: null },
  ]);
  const dept = table.get("dept_1")!;
  assert.equal(resolveEnvironmentId(dept, table), "sbx-department-dept_1");
});

test("a flat (Phase 2) worker, owned directly by a top-level agent, resolves to that agent's default sandbox", () => {
  const table = buildTable([
    { id: "wkr_flat", owner_address: "agentA", kind: "worker", project_id: null },
  ]);
  const wkr = table.get("wkr_flat")!;
  assert.equal(resolveEnvironmentId(wkr, table), "sbx-default-agentA");
});

test("a permanent worker under a department resolves to its OWN department's environment, not the owning agent's default sandbox", () => {
  const table = buildTable([
    { id: "dept_1", owner_address: "agentA", kind: "department", project_id: null },
    { id: "wkr_dept", owner_address: "dept_1", kind: "worker", project_id: null },
  ]);
  const wkr = table.get("wkr_dept")!;
  assert.equal(resolveEnvironmentId(wkr, table), "sbx-department-dept_1");
});

test("a temp worker (project_id set) under a department resolves to its PROJECT's environment, separate from the department's steady-state one", () => {
  const table = buildTable([
    { id: "dept_1", owner_address: "agentA", kind: "department", project_id: null },
    { id: "wkr_temp", owner_address: "dept_1", kind: "worker", project_id: "falcon-9" },
  ]);
  const wkr = table.get("wkr_temp")!;
  const env = resolveEnvironmentId(wkr, table);
  assert.equal(env, "sbx-project-dept_1_falcon-9");
  // And explicitly distinct from what a permanent worker in the SAME
  // department would resolve to — the whole point of giving a project
  // its own environment rather than reusing the department's.
  assert.notEqual(env, "sbx-department-dept_1");
});

test("two different projects under the SAME department resolve to two different environments", () => {
  const table = buildTable([
    { id: "dept_1", owner_address: "agentA", kind: "department", project_id: null },
    { id: "wkr_a", owner_address: "dept_1", kind: "worker", project_id: "falcon-9" },
    { id: "wkr_b", owner_address: "dept_1", kind: "worker", project_id: "starship" },
  ]);
  const envA = resolveEnvironmentId(table.get("wkr_a")!, table);
  const envB = resolveEnvironmentId(table.get("wkr_b")!, table);
  assert.notEqual(envA, envB);
});

test("the SAME project_id under two DIFFERENT departments resolves to two different environments (scope_id includes departmentId, not just projectId)", () => {
  const table = buildTable([
    { id: "dept_1", owner_address: "agentA", kind: "department", project_id: null },
    { id: "dept_2", owner_address: "agentA", kind: "department", project_id: null },
    { id: "wkr_a", owner_address: "dept_1", kind: "worker", project_id: "launch" },
    { id: "wkr_b", owner_address: "dept_2", kind: "worker", project_id: "launch" },
  ]);
  const envA = resolveEnvironmentId(table.get("wkr_a")!, table);
  const envB = resolveEnvironmentId(table.get("wkr_b")!, table);
  assert.notEqual(envA, envB);
  assert.equal(envA, "sbx-project-dept_1_launch");
  assert.equal(envB, "sbx-project-dept_2_launch");
});

test("a worker under one top-level agent's department never resolves into another agent's environment, even with colliding department ids across a hypothetical multi-tenant lookup", () => {
  const table = buildTable([
    { id: "dept_1", owner_address: "agentA", kind: "department", project_id: null },
    { id: "dept_2", owner_address: "agentB", kind: "department", project_id: null },
    { id: "wkr_b", owner_address: "dept_2", kind: "worker", project_id: null },
  ]);
  const env = resolveEnvironmentId(table.get("wkr_b")!, table);
  assert.equal(env, "sbx-department-dept_2");
  assert.notEqual(env, "sbx-department-dept_1");
});

// --- subagents.ts's /:id/pty wiring: the asserted-vs-granted check ---
// Mirrors capability.ts's checkBudgetAndEnvironment() exactly (same
// logic capability.test.ts already pins down) — re-tested here against
// scenarios specific to what subagents.ts now actually passes:
// `environment` is the caller's OPTIONAL asserted sandboxId,
// `grantedEnvironment` is only ever set (to the real resolution) when an
// assertion was made at all, per the "omit to skip" rule.
function checkAssertion(
  assertedSandboxId: string | undefined,
  grantedSandboxId: string,
): { allow: true } | { allow: false; reason: "wrong-environment" } {
  const environment = assertedSandboxId;
  const grantedEnvironment = assertedSandboxId !== undefined ? grantedSandboxId : undefined;
  if (environment !== undefined && grantedEnvironment !== undefined && environment !== grantedEnvironment) {
    return { allow: false, reason: "wrong-environment" };
  }
  return { allow: true };
}

test("pty call with no asserted sandboxId (the common case) always allows, regardless of the real resolution", () => {
  assert.deepEqual(checkAssertion(undefined, "sbx-department-dept_1"), { allow: true });
});

test("pty call asserting the sandboxId that matches the real resolution allows", () => {
  assert.deepEqual(checkAssertion("sbx-department-dept_1", "sbx-department-dept_1"), { allow: true });
});

test("pty call asserting a stale sandboxId (e.g. from before convert_temp_to_permanent re-scoped this worker) is denied", () => {
  // Worker was a temp worker in sbx-project-dept_1_falcon-9; caller still
  // has that id cached, but the worker is now permanent and really
  // resolves to sbx-department-dept_1.
  assert.deepEqual(checkAssertion("sbx-project-dept_1_falcon-9", "sbx-department-dept_1"), {
    allow: false,
    reason: "wrong-environment",
  });
});

test("pty call asserting another department's environment entirely is denied", () => {
  assert.deepEqual(checkAssertion("sbx-department-dept_2", "sbx-department-dept_1"), {
    allow: false,
    reason: "wrong-environment",
  });
});
