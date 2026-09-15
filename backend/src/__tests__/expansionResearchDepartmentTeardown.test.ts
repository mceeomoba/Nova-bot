// Zent.md Phase 7d: "Department teardown on report completion (reuses
// teardownDepartmentEnvironment from environment.ts)."
//
// The real wiring lives in two places, already implemented in this repo:
//   - expansion.ts's createFinding() fires
//     departments.retireResearchDepartmentForOpportunity(opportunityId)
//     (fire-and-forget, dynamic-imported to dodge the departments.ts <->
//     expansion.ts circular import) whenever kind === "research".
//   - departments.ts's retireResearchDepartmentForOpportunity() looks up
//     the one running (status='running') department row with a matching
//     opportunity_id, kills its workers (logging project burns and
//     closing any open PTY sessions along the way, same as DELETE /:id
//     and POST /:id/retire), tears down any burned project environments,
//     and finally calls teardownDepartmentEnvironment(dept.id).
//
// Same "no live better-sqlite3 in this environment" constraint every
// other backend/src test file in this repo already documents
// (expansionFindings.test.ts, environment.test.ts) — this inlines a
// mirror of both functions' logic against plain in-memory stand-ins for
// sub_agents / project_burns / open PTY sessions, and fakes for
// teardownProjectEnvironment / teardownDepartmentEnvironment that just
// record their calls. Re-run against the real functions with a live
// sqlite3 DB before shipping.

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeWorker {
  id: string;
  owner_address: string; // department id
  kind: "worker";
  status: "running" | "killed";
  project_id: string | null;
  pty_session_id: string | null;
  created_at: number;
  ended_at: number | null;
}

interface FakeDepartment {
  id: string;
  kind: "department";
  status: "running" | "killed";
  opportunity_id: string | null;
  ended_at: number | null;
}

type SubAgent = FakeWorker | FakeDepartment;

let subAgents: Map<string, SubAgent>;
let projectBurns: { departmentId: string; projectId: string; workerId: string; reason: string }[];
let closedPtySessions: string[];
let teardownProjectCalls: { departmentId: string; projectId: string }[];
let teardownDepartmentCalls: string[];
let now: number;

function reset() {
  subAgents = new Map();
  projectBurns = [];
  closedPtySessions = [];
  teardownProjectCalls = [];
  teardownDepartmentCalls = [];
  now = 1_000_000;
}

function seedDepartment(id: string, opportunityId: string | null, status: "running" | "killed" = "running"): FakeDepartment {
  const dept: FakeDepartment = { id, kind: "department", status, opportunity_id: opportunityId, ended_at: null };
  subAgents.set(id, dept);
  return dept;
}

function seedWorker(
  id: string,
  departmentId: string,
  opts: { projectId?: string | null; ptySessionId?: string | null; status?: "running" | "killed" } = {},
): FakeWorker {
  const w: FakeWorker = {
    id,
    owner_address: departmentId,
    kind: "worker",
    status: opts.status ?? "running",
    project_id: opts.projectId ?? null,
    pty_session_id: opts.ptySessionId ?? null,
    created_at: now,
    ended_at: null,
  };
  subAgents.set(id, w);
  return w;
}

// ─── Inlined mirror of environment.ts's fakes ──────────────────────────

async function teardownProjectEnvironment(departmentId: string, projectId: string): Promise<void> {
  teardownProjectCalls.push({ departmentId, projectId });
}

async function teardownDepartmentEnvironment(departmentId: string): Promise<void> {
  teardownDepartmentCalls.push(departmentId);
}

async function closePtySession(sessionId: string): Promise<void> {
  closedPtySessions.push(sessionId);
}

// ─── Inlined mirror of departments.ts's retireResearchDepartmentForOpportunity ───

async function retireResearchDepartmentForOpportunity(
  opportunityId: string,
): Promise<{ retired: boolean; departmentId?: string }> {
  const dept = [...subAgents.values()].find(
    (row): row is FakeDepartment =>
      row.kind === "department" && row.status === "running" && row.opportunity_id === opportunityId,
  );
  if (!dept) {
    return { retired: false };
  }

  const workers = [...subAgents.values()].filter(
    (row): row is FakeWorker => row.kind === "worker" && row.owner_address === dept.id && row.status === "running",
  );

  const burnedProjectIds = new Set<string>();
  for (const w of workers) {
    w.status = "killed";
    w.ended_at = now;
    if (w.project_id) {
      projectBurns.push({
        departmentId: dept.id,
        projectId: w.project_id,
        workerId: w.id,
        reason: "research_finding_filed",
      });
      burnedProjectIds.add(w.project_id);
    }
    if (w.pty_session_id) {
      await closePtySession(w.pty_session_id).catch(() => {});
    }
  }
  dept.status = "killed";
  dept.ended_at = now;

  for (const projectId of burnedProjectIds) {
    await teardownProjectEnvironment(dept.id, projectId);
  }
  await teardownDepartmentEnvironment(dept.id);

  return { retired: true, departmentId: dept.id };
}

// ─── Inlined mirror of expansion.ts's createFinding()'s teardown hook ──
// Synchronous here (the real call is fire-and-forget/uncaught-by-design)
// so tests can assert on it directly rather than racing a promise.

async function fileFinding(kind: "research" | "finance" | "strategy", opportunityId: string): Promise<void> {
  if (kind === "research") {
    await retireResearchDepartmentForOpportunity(opportunityId);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────

test("filing a research finding retires the opportunity's running research department", async () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  await fileFinding("research", "opp_1");

  const dept = subAgents.get("dept_1") as FakeDepartment;
  assert.equal(dept.status, "killed");
  assert.equal(dept.ended_at, now);
  assert.deepEqual(teardownDepartmentCalls, ["dept_1"]);
});

test("filing a finance or strategy finding never triggers research department teardown", async () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  await fileFinding("finance", "opp_1");
  await fileFinding("strategy", "opp_1");

  const dept = subAgents.get("dept_1") as FakeDepartment;
  assert.equal(dept.status, "running");
  assert.deepEqual(teardownDepartmentCalls, []);
});

test("no running research department for the opportunity is a silent no-op, not an error", async () => {
  reset();
  // no department seeded at all
  await assert.doesNotReject(() => fileFinding("research", "opp_missing"));
  assert.deepEqual(teardownDepartmentCalls, []);

  const result = await retireResearchDepartmentForOpportunity("opp_missing");
  assert.deepEqual(result, { retired: false });
});

test("filing a second (re-run) research finding after the department is already torn down is also a silent no-op", async () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  await fileFinding("research", "opp_1"); // tears it down
  assert.deepEqual(teardownDepartmentCalls, ["dept_1"]);

  // Phase 5e re-run: a second research pass files a v2 finding against
  // the same opportunity after the department from the first pass is
  // already killed — must not throw, must not call teardown again.
  await fileFinding("research", "opp_1");
  assert.deepEqual(teardownDepartmentCalls, ["dept_1"]);
});

test("retiring kills every running worker under the department, not just the department row itself", () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  seedWorker("wkr_a", "dept_1");
  seedWorker("wkr_b", "dept_1");

  return retireResearchDepartmentForOpportunity("opp_1").then(() => {
    assert.equal((subAgents.get("wkr_a") as FakeWorker).status, "killed");
    assert.equal((subAgents.get("wkr_b") as FakeWorker).status, "killed");
  });
});

test("a temp worker's project gets burn-logged and its project environment torn down, in addition to the department's own", async () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  seedWorker("wkr_temp", "dept_1", { projectId: "verify-falcon-9" });

  await retireResearchDepartmentForOpportunity("opp_1");

  assert.equal(projectBurns.length, 1);
  assert.equal(projectBurns[0].projectId, "verify-falcon-9");
  assert.equal(projectBurns[0].reason, "research_finding_filed");
  assert.deepEqual(teardownProjectCalls, [{ departmentId: "dept_1", projectId: "verify-falcon-9" }]);
  assert.deepEqual(teardownDepartmentCalls, ["dept_1"]);
});

test("two temp workers sharing one project only burn/teardown that project once", async () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  seedWorker("wkr_a", "dept_1", { projectId: "shared-proj" });
  seedWorker("wkr_b", "dept_1", { projectId: "shared-proj" });

  await retireResearchDepartmentForOpportunity("opp_1");

  assert.equal(projectBurns.length, 2); // one burn log row per worker...
  assert.equal(teardownProjectCalls.length, 1); // ...but one teardown per project
});

test("an open PTY session on a worker is closed during teardown", async () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  seedWorker("wkr_a", "dept_1", { ptySessionId: "pty_123" });

  await retireResearchDepartmentForOpportunity("opp_1");

  assert.deepEqual(closedPtySessions, ["pty_123"]);
});

test("only the department matching this opportunity_id is retired — a sibling opportunity's department is untouched", async () => {
  reset();
  seedDepartment("dept_1", "opp_1");
  seedDepartment("dept_2", "opp_2");

  await retireResearchDepartmentForOpportunity("opp_1");

  assert.equal((subAgents.get("dept_1") as FakeDepartment).status, "killed");
  assert.equal((subAgents.get("dept_2") as FakeDepartment).status, "running");
  assert.deepEqual(teardownDepartmentCalls, ["dept_1"]);
});

test("a non-research department (opportunity_id null) is never matched, even for the same opportunityId string by coincidence", async () => {
  reset();
  // opportunity_id is only ever non-null for research departments
  // (Zent.md Phase 5a) — this pins that invariant down from the
  // teardown side too.
  seedDepartment("dept_finance_shaped", null);

  const result = await retireResearchDepartmentForOpportunity("opp_1");
  assert.deepEqual(result, { retired: false });
  assert.equal((subAgents.get("dept_finance_shaped") as FakeDepartment).status, "running");
});
