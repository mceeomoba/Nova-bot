// next-phase.md Phase 5c (architecture-agent.md §6, The Orchestrator):
// "Also enforces the department/worker ceilings (max_departments,
// max_workers_per_department, max_temp_workers_per_department) added in
// Phase 2a/2b, from the orchestrator rather than only at each individual
// route." orgChartQuotas.ts is a pure read — no kill, no mutation — so
// unlike resourceQuotas.test.ts's own two-group split, there's only one
// group needed here: an inlined, byte-for-byte mirror of
// checkOrgChartQuotas()'s own decision logic, operating against plain
// in-memory data standing in for `sub_agents`/manifest.json, same
// standing "no live better-sqlite3 in this environment" reason every
// prior backend/src test file in this repo has already carried since
// Phase 2f-iii. Recommend re-running against the real
// checkOrgChartQuotas()/office.ts/departments.ts once a networked
// environment is available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

type OrgChartResource = "departments" | "department_workers" | "department_temp_workers";

interface OrgChartViolation {
  resource: OrgChartResource;
  departmentId?: string;
  departmentName?: string;
  limit: number;
  actual: number;
}

interface FakeQuota {
  max_departments: number;
  max_workers_per_department: number;
  max_temp_workers_per_department: number;
}

interface FakeDepartmentRow {
  id: string;
  name: string;
  ownerAddress: string;
  status: "running" | "killed";
}

interface FakeWorkerRow {
  id: string;
  ownerAddress: string; // a department's own id
  status: "running" | "killed";
  projectId: string | null;
}

let quotas: Map<string, FakeQuota>;
let departments: FakeDepartmentRow[];
let workers: FakeWorkerRow[];

function reset() {
  quotas = new Map([["0xAGENT", { max_departments: 2, max_workers_per_department: 3, max_temp_workers_per_department: 5 }]]);
  departments = [];
  workers = [];
}

// ─── Inlined mirror of departments.ts's own exported count functions ──

function activeDepartmentCountForMirror(ownerAddress: string): number {
  return departments.filter((d) => d.ownerAddress === ownerAddress && d.status === "running").length;
}

function activeWorkerCountForDepartmentMirror(departmentId: string): number {
  return workers.filter((w) => w.ownerAddress === departmentId && w.status === "running" && w.projectId === null).length;
}

function activeTempWorkerCountForDepartmentMirror(departmentId: string): number {
  return workers.filter((w) => w.ownerAddress === departmentId && w.status === "running" && w.projectId !== null).length;
}

function listRunningDepartmentsForAgentMirror(ownerAddress: string): FakeDepartmentRow[] {
  return departments.filter((d) => d.ownerAddress === ownerAddress && d.status === "running");
}

// ─── Inlined mirror of orgChartQuotas.ts's own checkOrgChartQuotas() ──

function checkOrgChartQuotasMirror(agentAddress: string): { ok: boolean; violations: OrgChartViolation[] } {
  const quota = quotas.get(agentAddress);
  const violations: OrgChartViolation[] = [];
  if (!quota) return { ok: true, violations };

  const departmentCount = activeDepartmentCountForMirror(agentAddress);
  if (departmentCount > quota.max_departments) {
    violations.push({ resource: "departments", limit: quota.max_departments, actual: departmentCount });
  }

  for (const dept of listRunningDepartmentsForAgentMirror(agentAddress)) {
    const workerCount = activeWorkerCountForDepartmentMirror(dept.id);
    if (workerCount > quota.max_workers_per_department) {
      violations.push({
        resource: "department_workers",
        departmentId: dept.id,
        departmentName: dept.name,
        limit: quota.max_workers_per_department,
        actual: workerCount,
      });
    }
    const tempCount = activeTempWorkerCountForDepartmentMirror(dept.id);
    if (tempCount > quota.max_temp_workers_per_department) {
      violations.push({
        resource: "department_temp_workers",
        departmentId: dept.id,
        departmentName: dept.name,
        limit: quota.max_temp_workers_per_department,
        actual: tempCount,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

test("an agent within every ceiling reports ok, zero violations", () => {
  reset();
  departments.push({ id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" });
  workers.push({ id: "wkr_1", ownerAddress: "dept_a", status: "running", projectId: null });
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
});

test("exceeding max_departments is detected, agent-wide (no departmentId on the violation)", () => {
  reset();
  departments.push(
    { id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" },
    { id: "dept_b", name: "Marketing", ownerAddress: "0xAGENT", status: "running" },
    { id: "dept_c", name: "Finance", ownerAddress: "0xAGENT", status: "running" }, // ceiling is 2
  );
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, false);
  const v = result.violations.find((v) => v.resource === "departments");
  assert.ok(v);
  assert.equal(v!.departmentId, undefined);
  assert.equal(v!.limit, 2);
  assert.equal(v!.actual, 3);
});

test("a killed department never counts toward max_departments", () => {
  reset();
  departments.push(
    { id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" },
    { id: "dept_b", name: "Marketing", ownerAddress: "0xAGENT", status: "killed" },
    { id: "dept_c", name: "Finance", ownerAddress: "0xAGENT", status: "killed" },
  );
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, true);
});

test("exceeding max_workers_per_department is detected per-department, carrying the department's id/name", () => {
  reset();
  departments.push({ id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" });
  for (let i = 0; i < 4; i++) {
    workers.push({ id: `wkr_${i}`, ownerAddress: "dept_a", status: "running", projectId: null }); // ceiling is 3
  }
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, false);
  const v = result.violations.find((v) => v.resource === "department_workers");
  assert.ok(v);
  assert.equal(v!.departmentId, "dept_a");
  assert.equal(v!.departmentName, "Software");
  assert.equal(v!.limit, 3);
  assert.equal(v!.actual, 4);
});

test("permanent-worker and temp-worker ceilings are checked independently — bursting temp workers never trips the permanent ceiling and vice versa", () => {
  reset();
  departments.push({ id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" });
  workers.push({ id: "wkr_perm", ownerAddress: "dept_a", status: "running", projectId: null }); // 1/3, fine
  for (let i = 0; i < 6; i++) {
    workers.push({ id: `wkr_temp_${i}`, ownerAddress: "dept_a", status: "running", projectId: "proj-x" }); // 6 > 5 ceiling
  }
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, false);
  const resources = result.violations.map((v) => v.resource);
  assert.ok(resources.includes("department_temp_workers"));
  assert.ok(!resources.includes("department_workers"));
});

test("two departments under the same agent are checked independently — one over ceiling doesn't flag the other", () => {
  reset();
  departments.push(
    { id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" },
    { id: "dept_b", name: "Marketing", ownerAddress: "0xAGENT", status: "running" },
  );
  for (let i = 0; i < 5; i++) {
    workers.push({ id: `wkr_${i}`, ownerAddress: "dept_a", status: "running", projectId: null }); // over dept_a's ceiling of 3
  }
  workers.push({ id: "wkr_b1", ownerAddress: "dept_b", status: "running", projectId: null }); // well within dept_b's ceiling
  const result = checkOrgChartQuotasMirror("0xAGENT");
  const violatingDepts = result.violations.filter((v) => v.resource === "department_workers").map((v) => v.departmentId);
  assert.deepEqual(violatingDepts, ["dept_a"]);
});

test("a killed department's own workers are never checked at all, even if they'd exceed the ceiling", () => {
  reset();
  departments.push({ id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "killed" });
  for (let i = 0; i < 10; i++) {
    workers.push({ id: `wkr_${i}`, ownerAddress: "dept_a", status: "running", projectId: null });
  }
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, true, "a killed department is never enumerated by listRunningDepartmentsForAgent");
});

test("an agent this backend has no quota entry for at all is never flagged", () => {
  reset();
  const result = checkOrgChartQuotasMirror("0xUNKNOWN");
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
});

test("multiple simultaneous violations (agent-wide and per-department) are all reported together, not just the first one found", () => {
  reset();
  departments.push(
    { id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" },
    { id: "dept_b", name: "Marketing", ownerAddress: "0xAGENT", status: "running" },
    { id: "dept_c", name: "Finance", ownerAddress: "0xAGENT", status: "running" }, // over max_departments (2)
  );
  for (let i = 0; i < 4; i++) {
    workers.push({ id: `wkr_${i}`, ownerAddress: "dept_a", status: "running", projectId: null }); // over dept_a's worker ceiling (3)
  }
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, false);
  const resources = result.violations.map((v) => v.resource);
  assert.ok(resources.includes("departments"));
  assert.ok(resources.includes("department_workers"));
  assert.equal(result.violations.length, 2);
});

test("exactly at the ceiling (not one over) is not a violation — strictly greater-than, matching resourceQuotas.ts's own convention", () => {
  reset();
  departments.push(
    { id: "dept_a", name: "Software", ownerAddress: "0xAGENT", status: "running" },
    { id: "dept_b", name: "Marketing", ownerAddress: "0xAGENT", status: "running" }, // exactly 2, ceiling is 2
  );
  for (let i = 0; i < 3; i++) {
    workers.push({ id: `wkr_${i}`, ownerAddress: "dept_a", status: "running", projectId: null }); // exactly 3, ceiling is 3
  }
  const result = checkOrgChartQuotasMirror("0xAGENT");
  assert.equal(result.ok, true);
});
