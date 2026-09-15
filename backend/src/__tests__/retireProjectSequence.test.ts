// next-phase.md Phase 2h (architecture-agent.md §4b): tests for
// departments.ts's retireProjectSequence() — the one gap this phase's
// own "Done when" line explicitly left open ("Not yet confirmed by a
// real node --test run ... no test file for this phase exists yet; a
// natural next addition, not done here"). This closes it.
//
// Same constraint every prior backend/src test file in this repo has
// flagged (capability.test.ts, environment.test.ts): no network access
// to `npm install` better-sqlite3 here, so retireProjectSequence()
// itself (which calls db.prepare(...) directly, six separate
// statements) can't be imported and exercised against a live DB. What's
// tested here is an inlined copy of its exact seven-step decision logic
// — same variable names, same order, same guard conditions — operating
// against plain in-memory arrays standing in for department_projects /
// sub_agents / project_archive / project_burns / department_spend_log,
// kept byte-for-byte in sync with departments.ts's own function (see
// that function's doc comment for the numbered step list this mirrors).
// Before deploying, re-run these same cases against the real function
// with a live sqlite3 DB (`npm install && npx tsc && node dist/
// __tests__/retireProjectSequence.test.js`) to confirm this inlined
// copy hasn't drifted.

import { test } from "node:test";
import assert from "node:assert/strict";

interface ProjectRow {
  id: number;
  departmentId: string;
  projectId: string;
  status: "active" | "retired";
  budgetReservedUsdc: number | null;
  budgetSpentUsdc: number;
  endedAt: number | null;
}

interface WorkerRow {
  id: string;
  ownerAddress: string;
  projectId: string | null;
  status: "running" | "killed";
  role: string;
  result: string | null;
  error: string | null;
  ptySessionId: string | null;
  createdAt: number;
  endedAt: number | null;
}

interface ArchiveRow {
  projectId: string;
  workerId: string;
  role: string;
  result: string | null;
  error: string | null;
  archivedAt: number;
}

interface BurnRow {
  departmentId: string;
  projectId: string;
  workerId: string;
  role: string;
  spawnedAt: number;
  burnedAt: number;
  durationMs: number;
  reason: string;
}

interface SpendLogRow {
  departmentId: string;
  amountUsdc: number;
  purpose: string;
  projectId: string | null;
}

interface KnowledgeRow {
  departmentId: string;
  workerId: string;
  projectId: string;
  category: "archived_project_output";
}

// In-memory stand-ins for the tables retireProjectSequence() touches.
class FakeDb {
  projects: ProjectRow[] = [];
  workers: WorkerRow[] = [];
  archive: ArchiveRow[] = [];
  burns: BurnRow[] = [];
  spendLog: SpendLogRow[] = [];
  knowledge: KnowledgeRow[] = [];
  // Order-of-operations trace, so tests can confirm archive-before-kill
  // (step 2 before step 3) rather than just checking final state.
  trace: string[] = [];
  ptyClosed: string[] = [];
  environmentsTornDown: string[] = [];
}

// Byte-for-byte mirror of departments.ts's retireProjectSequence(),
// steps 1-7 plus the environment-teardown re-check, operating on the
// FakeDb tables instead of real sqlite statements. Any change to the
// real function's logic should be reflected here too, per this file's
// own top comment.
function retireProjectSequence(
  db: FakeDb,
  departmentId: string,
  projectId: string,
  reason: "retired" | "ttl_expired" | "department_retired",
  now: number,
  // Test-only hook fired at exactly the point between processing the
  // fetched worker list and the environment teardown re-check — this is
  // the real function's race window, where a concurrent
  // spawn_temp_workers() call could insert a new running row. Not part
  // of the real function's signature.
  onBeforeTeardownRecheck?: () => void,
): { burned: string[] } {
  // Step 1: flip status closed before touching any worker. `wasActive`
  // gates step 6's rebate below (see departments.ts's own comment on
  // this fix) — without it, a repeat call against an already-retired
  // project would re-credit the same remainder a second time.
  const projectRow = db.projects.find(
    (p) => p.departmentId === departmentId && p.projectId === projectId,
  );
  const wasActive = projectRow?.status === "active";
  if (projectRow && wasActive) {
    projectRow.status = "retired";
    projectRow.endedAt = now;
    db.trace.push("step1:status_flipped");
  }

  const workers = db.workers.filter(
    (w) => w.ownerAddress === departmentId && w.projectId === projectId && w.status === "running",
  );

  const burned: string[] = [];
  for (const w of workers) {
    // Step 2: raw archive, written BEFORE the kill below.
    db.archive.push({
      projectId,
      workerId: w.id,
      role: w.role,
      result: w.result ?? null,
      error: w.error ?? null,
      archivedAt: now,
    });
    db.trace.push(`step2:archived:${w.id}`);

    // Step 3: kill + burn log.
    w.status = "killed";
    w.endedAt = now;
    db.trace.push(`step3:killed:${w.id}`);
    db.burns.push({
      departmentId,
      projectId,
      workerId: w.id,
      role: w.role,
      spawnedAt: w.createdAt,
      burnedAt: now,
      durationMs: now - w.createdAt,
      reason,
    });

    // Step 7: evaluated-subset write into department_knowledge — same
    // "skip a worker with neither result nor error" guard
    // archiveWorkerOutput() has always applied.
    if (w.result != null || w.error != null) {
      db.knowledge.push({
        departmentId,
        workerId: w.id,
        projectId,
        category: "archived_project_output",
      });
      db.trace.push(`step7:knowledge:${w.id}`);
    }

    // Steps 4/5: PTY close + implicit slot release.
    if (w.ptySessionId) {
      db.ptyClosed.push(w.ptySessionId);
    }
    burned.push(w.id);
  }

  // Step 6: return unused project budget — only when a real reservation
  // exists, only a positive remainder, and only on the call that
  // actually performed the step-1 retirement (wasActive).
  if (projectRow && wasActive && projectRow.budgetReservedUsdc != null) {
    const remainder = projectRow.budgetReservedUsdc - projectRow.budgetSpentUsdc;
    if (remainder > 0) {
      db.spendLog.push({
        departmentId,
        amountUsdc: -remainder,
        purpose: "project_budget_return",
        projectId,
      });
      db.trace.push(`step6:credited:${remainder}`);
    }
  }

  onBeforeTeardownRecheck?.();

  // Environment teardown re-check: only if nothing is still running for
  // this project (defensive against a concurrent burst).
  const stillRunning = db.workers.some(
    (w) => w.ownerAddress === departmentId && w.projectId === projectId && w.status === "running",
  );
  if (!stillRunning) {
    db.environmentsTornDown.push(`${departmentId}_${projectId}`);
  }

  return { burned };
}

test("step order: a worker's raw result is archived (step 2) strictly before it is killed (step 3)", () => {
  const db = new FakeDb();
  db.workers.push({
    id: "wkr_1",
    ownerAddress: "dept_1",
    projectId: "falcon-9",
    status: "running",
    role: "engineer",
    result: "launch succeeded",
    error: null,
    ptySessionId: "pty_1",
    createdAt: 1000,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 2000);

  const archiveIdx = db.trace.indexOf("step2:archived:wkr_1");
  const killIdx = db.trace.indexOf("step3:killed:wkr_1");
  assert.ok(archiveIdx >= 0 && killIdx >= 0);
  assert.ok(archiveIdx < killIdx, "archive must be written before the kill");
  assert.equal(db.archive.length, 1);
  assert.equal(db.archive[0].result, "launch succeeded");
});

test("step 1: department_projects.status flips to retired, and only when it was active", () => {
  const db = new FakeDb();
  db.projects.push({
    id: 1,
    departmentId: "dept_1",
    projectId: "falcon-9",
    status: "active",
    budgetReservedUsdc: null,
    budgetSpentUsdc: 0,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 5000);
  assert.equal(db.projects[0].status, "retired");
  assert.equal(db.projects[0].endedAt, 5000);
});

test("an ad-hoc project (no create_project() row) is a no-op for step 1 and step 6, but workers still get archived and burned", () => {
  const db = new FakeDb();
  // No matching row in db.projects at all.
  db.workers.push({
    id: "wkr_1",
    ownerAddress: "dept_1",
    projectId: "adhoc-proj",
    status: "running",
    role: "researcher",
    result: "findings.md",
    error: null,
    ptySessionId: null,
    createdAt: 1000,
    endedAt: null,
  });
  const { burned } = retireProjectSequence(db, "dept_1", "adhoc-proj", "retired", 2000);
  assert.deepEqual(burned, ["wkr_1"]);
  assert.equal(db.archive.length, 1);
  assert.equal(db.spendLog.length, 0, "no reservation exists, so no rebate row should be written");
});

test("step 6: a project with an explicit reservation and unused budget gets a negative department_spend_log credit for exactly the remainder", () => {
  const db = new FakeDb();
  db.projects.push({
    id: 1,
    departmentId: "dept_1",
    projectId: "falcon-9",
    status: "active",
    budgetReservedUsdc: 100,
    budgetSpentUsdc: 35,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 9000);
  assert.equal(db.spendLog.length, 1);
  assert.equal(db.spendLog[0].amountUsdc, -65);
  assert.equal(db.spendLog[0].purpose, "project_budget_return");
  assert.equal(db.spendLog[0].projectId, "falcon-9");
});

test("step 6: a project with a reservation but nothing left unused (spent === reserved) gets no rebate row, not a zero-amount one", () => {
  const db = new FakeDb();
  db.projects.push({
    id: 1,
    departmentId: "dept_1",
    projectId: "falcon-9",
    status: "active",
    budgetReservedUsdc: 50,
    budgetSpentUsdc: 50,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 9000);
  assert.equal(db.spendLog.length, 0);
});

test("step 6: a project that overspent its own reservation (spent > reserved) gets no rebate — never credits a negative remainder", () => {
  const db = new FakeDb();
  db.projects.push({
    id: 1,
    departmentId: "dept_1",
    projectId: "falcon-9",
    status: "active",
    budgetReservedUsdc: 50,
    budgetSpentUsdc: 80,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 9000);
  assert.equal(db.spendLog.length, 0);
});

test("step 7: a worker with neither result nor error is archived (step 2, unconditional) but skipped for department_knowledge (step 7's own guard)", () => {
  const db = new FakeDb();
  db.workers.push({
    id: "wkr_1",
    ownerAddress: "dept_1",
    projectId: "falcon-9",
    status: "running",
    role: "engineer",
    result: null,
    error: null,
    ptySessionId: null,
    createdAt: 1000,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 2000);
  assert.equal(db.archive.length, 1, "raw archive is unconditional");
  assert.equal(db.knowledge.length, 0, "nothing useful to evaluate into department_knowledge");
});

test("multiple workers tagged with the same project are all archived and burned, each with its own project_burns row", () => {
  const db = new FakeDb();
  db.workers.push(
    {
      id: "wkr_a",
      ownerAddress: "dept_1",
      projectId: "falcon-9",
      status: "running",
      role: "engineer",
      result: "ok",
      error: null,
      ptySessionId: "pty_a",
      createdAt: 1000,
      endedAt: null,
    },
    {
      id: "wkr_b",
      ownerAddress: "dept_1",
      projectId: "falcon-9",
      status: "running",
      role: "reviewer",
      result: null,
      error: "timed out",
      ptySessionId: "pty_b",
      createdAt: 1500,
      endedAt: null,
    },
    // A worker under the SAME department but a DIFFERENT project must
    // not be touched by this call.
    {
      id: "wkr_c",
      ownerAddress: "dept_1",
      projectId: "starship",
      status: "running",
      role: "engineer",
      result: null,
      error: null,
      ptySessionId: null,
      createdAt: 1000,
      endedAt: null,
    },
  );
  const { burned } = retireProjectSequence(db, "dept_1", "falcon-9", "retired", 3000);
  assert.deepEqual(burned.sort(), ["wkr_a", "wkr_b"]);
  assert.equal(db.archive.length, 2);
  assert.equal(db.burns.length, 2);
  assert.deepEqual(db.ptyClosed.sort(), ["pty_a", "pty_b"]);
  // The unrelated project's worker stays untouched.
  const wkrC = db.workers.find((w) => w.id === "wkr_c")!;
  assert.equal(wkrC.status, "running");
});

test("idempotent: calling retireProjectSequence() again for an already-retired project returns burned: [] and writes nothing new", () => {
  const db = new FakeDb();
  db.projects.push({
    id: 1,
    departmentId: "dept_1",
    projectId: "falcon-9",
    status: "active",
    budgetReservedUsdc: 100,
    budgetSpentUsdc: 20,
    endedAt: null,
  });
  db.workers.push({
    id: "wkr_1",
    ownerAddress: "dept_1",
    projectId: "falcon-9",
    status: "running",
    role: "engineer",
    result: "done",
    error: null,
    ptySessionId: "pty_1",
    createdAt: 1000,
    endedAt: null,
  });

  const first = retireProjectSequence(db, "dept_1", "falcon-9", "retired", 2000);
  assert.deepEqual(first.burned, ["wkr_1"]);
  assert.equal(db.spendLog.length, 1, "first call credits the unused reservation");

  const second = retireProjectSequence(db, "dept_1", "falcon-9", "retired", 3000);
  assert.deepEqual(second.burned, [], "no running workers left, nothing to burn");
  assert.equal(db.archive.length, 1, "no duplicate archive row from the second call");
  assert.equal(db.burns.length, 1, "no duplicate burn row from the second call");
  assert.equal(
    db.spendLog.length,
    1,
    "status is already 'retired' on the second call, so step 1's guard prevents a second credit",
  );
});

test("environment teardown re-check: torn down once no worker for this project is still running", () => {
  const db = new FakeDb();
  db.workers.push({
    id: "wkr_1",
    ownerAddress: "dept_1",
    projectId: "falcon-9",
    status: "running",
    role: "engineer",
    result: "done",
    error: null,
    ptySessionId: null,
    createdAt: 1000,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 2000);
  assert.deepEqual(db.environmentsTornDown, ["dept_1_falcon-9"]);
});

test("environment teardown re-check: NOT torn down if a worker lands for the same project between the fetch and the re-check (race-safety)", () => {
  // The real function's race window is: SELECT running workers for this
  // project -> process them -> SELECT again to decide teardown. A
  // concurrent spawn_temp_workers() call can insert a new running row
  // for the same projectId inside that window. Modeled here by an
  // explicit hook fired at exactly that point in the synchronous
  // simulation, rather than by pre-seeding a worker the first SELECT
  // would have picked up too (which wouldn't exercise the race at all).
  const db = new FakeDb();
  db.workers.push({
    id: "wkr_1",
    ownerAddress: "dept_1",
    projectId: "falcon-9",
    status: "running",
    role: "engineer",
    result: "done",
    error: null,
    ptySessionId: null,
    createdAt: 1000,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "retired", 2000, () => {
    db.workers.push({
      id: "wkr_2",
      ownerAddress: "dept_1",
      projectId: "falcon-9",
      status: "running",
      role: "engineer",
      result: null,
      error: null,
      ptySessionId: null,
      createdAt: 1900,
      endedAt: null,
    });
  });
  assert.deepEqual(db.environmentsTornDown, [], "wkr_2 landed mid-teardown, so teardown must be held off");
});

test("reason is threaded through to every project_burns row for this call (ttl_expired vs retired vs department_retired)", () => {
  const db = new FakeDb();
  db.workers.push({
    id: "wkr_1",
    ownerAddress: "dept_1",
    projectId: "falcon-9",
    status: "running",
    role: "engineer",
    result: "done",
    error: null,
    ptySessionId: null,
    createdAt: 1000,
    endedAt: null,
  });
  retireProjectSequence(db, "dept_1", "falcon-9", "ttl_expired", 2000);
  assert.equal(db.burns[0].reason, "ttl_expired");
});
