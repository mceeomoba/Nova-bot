import { ensureDepartmentQuota } from "./office.js";
import {
  activeDepartmentCountFor,
  activeWorkerCountForDepartment,
  activeTempWorkerCountForDepartment,
  listRunningDepartmentsForAgent,
} from "./departments.js";
import { listAgentProcesses } from "./orchestrator.js";

/**
 * next-phase.md Phase 5c (architecture-agent.md §6, The Orchestrator):
 * "Also enforces the department/worker ceilings (max_departments,
 * max_workers_per_department, max_temp_workers_per_department) added in
 * Phase 2a/2b, from the orchestrator rather than only at each individual
 * route."
 *
 * Plan-text mismatch found while implementing (same class as every
 * prior phase's own "Touches" corrections — 4c's erc8004Trust.ts, 4d's
 * spawner.ts, 5a's orchestrator.ts, 5b's own header): this sub-phase's
 * header in next-phase.md lists "usage tables in wallet.ts/
 * facilitator.ts" as a Touches target. Nothing in this sub-phase's own
 * "Implements"/"Done when" lines is about spend at all — that's 5b's
 * job (resourceQuotas.ts's own inference_spend/marketplace_spend
 * checks already read those exact tables). The line appears to be
 * carried over from 5b's own header rather than rewritten for 5c — this
 * sub-phase's real scope, confirmed by its own "Implements"/"Done when"
 * text, is Phase 2a/2b's headcount ceilings only. Left uncorrected in
 * next-phase.md's own historical record (same as every prior
 * plan-text-mismatch note in this file), but this module does not touch
 * wallet.ts or facilitator.ts, and does not need to.
 *
 * Same division of labor resourceQuotas.ts already established relative
 * to orchestrator.ts: this file only ever DECIDES whether an agent (or
 * one of its departments) is over a headcount ceiling; it never spawns,
 * kills, or mutates anything itself. Unlike resourceQuotas.ts, there is
 * no enforce-then-kill half here at all — a department/worker-count
 * ceiling breach has no single OS process it makes sense to kill (which
 * of an agent's N departments would be "the" violator?), and the
 * ceilings themselves are already enforced, synchronously, at the exact
 * moment they could be exceeded (checkQuota() in departments.ts, called
 * from POST /departments, POST /departments/:id/workers, and
 * POST /departments/:id/temp-workers). What this sub-phase adds is
 * exactly what its own "Done when" line asks for and no more: a second,
 * independent reader of the same live counts, callable from the
 * orchestrator rather than only from those three routes — so an
 * operator (or a future automated sweep) can confirm an agent's org
 * chart is where it should be without trusting that every creation-time
 * check along the way actually ran, the same "verify, don't just trust"
 * posture orchestrator.ts's own getAgentProcessStatus() already takes
 * toward a tracked process row, and findActiveChannelGrant() takes
 * toward a channel row.
 *
 * Three resources, each already backed by a real Phase 2a/2b ceiling
 * and a real live count elsewhere in this codebase — this file adds no
 * new measurement of its own, only a shared read of the existing ones:
 *
 *  - departments: activeDepartmentCountFor(agentAddress) vs.
 *    manifest.quota.max_departments — the one ceiling checked directly
 *    against the top-level agent.
 *  - department_workers: activeWorkerCountForDepartment(deptId) vs.
 *    manifest.quota.max_workers_per_department — checked per running
 *    department the agent currently heads.
 *  - department_temp_workers: activeTempWorkerCountForDepartment(deptId)
 *    vs. manifest.quota.max_temp_workers_per_department — the separate
 *    burst-capacity ceiling, per running department, same "never let a
 *    project burst eat into the steady-state budget" split Phase 2b's
 *    own two counters already draw.
 */

export type OrgChartResource = "departments" | "department_workers" | "department_temp_workers";

export interface OrgChartViolation {
  resource: OrgChartResource;
  // Present for the two per-department resources, absent for the
  // agent-wide "departments" ceiling — mirrors resourceQuotas.ts's own
  // QuotaViolation shape (no field invented that resource doesn't need).
  departmentId?: string;
  departmentName?: string;
  limit: number;
  actual: number;
}

export interface OrgChartCheckResult {
  ok: boolean;
  violations: OrgChartViolation[];
}

/**
 * Compares one agent's real, live department/worker counts against its
 * own manifest.json ceilings (backfilling any still-null field via
 * ensureDepartmentQuota() first, same one-time-then-authoritative
 * pattern every other quota read in this repo already uses). Read-only,
 * per this sub-phase's own scope — never mutates anything, never kills
 * anything. A violation reported here should, by construction, never
 * actually be reachable through the normal creation routes (they
 * already refuse the request that would cause it) — this function
 * existing is what lets that claim be independently checked rather than
 * only assumed, e.g. after a direct DB edit, a bug in one of the three
 * creation-time checkQuota() call sites, or a manifest ceiling lowered
 * by an operator after departments/workers already existed under the
 * old, higher one.
 */
export async function checkOrgChartQuotas(agentAddress: string): Promise<OrgChartCheckResult> {
  const quota = await ensureDepartmentQuota(agentAddress);
  const violations: OrgChartViolation[] = [];

  const departmentCount = activeDepartmentCountFor(agentAddress);
  if (departmentCount > quota.max_departments) {
    violations.push({
      resource: "departments",
      limit: quota.max_departments,
      actual: departmentCount,
    });
  }

  const departments = listRunningDepartmentsForAgent(agentAddress);
  for (const dept of departments) {
    const workerCount = activeWorkerCountForDepartment(dept.id);
    if (workerCount > quota.max_workers_per_department) {
      violations.push({
        resource: "department_workers",
        departmentId: dept.id,
        departmentName: dept.name,
        limit: quota.max_workers_per_department,
        actual: workerCount,
      });
    }

    const tempWorkerCount = activeTempWorkerCountForDepartment(dept.id);
    if (tempWorkerCount > quota.max_temp_workers_per_department) {
      violations.push({
        resource: "department_temp_workers",
        departmentId: dept.id,
        departmentName: dept.name,
        limit: quota.max_temp_workers_per_department,
        actual: tempWorkerCount,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Best-effort sweep across every agent this backend currently tracks a
 * 'running' process for — same shape as resourceQuotas.ts's own
 * sweepResourceQuotas() and departments.ts's own sweepExpiredTempWorkers(),
 * including the same "one bad agent's failure must never stop the rest
 * of the sweep" posture. Deliberately does not call killAgentProcess() or
 * any other mutating function — see this module's own doc comment above
 * for why a headcount ceiling has no single process it makes sense to
 * act on automatically. A violation found here is logged for an
 * operator to see (console.warn, same visibility level this repo's
 * other best-effort background sweeps already use — e.g.
 * archiveWorkerOutput()'s own try/catch-and-log calls), not silently
 * dropped and not escalated into a kill this sub-phase's own "Done
 * when" line never asked for.
 */
export async function sweepOrgChartQuotas(): Promise<void> {
  const running = listAgentProcesses().filter((p) => p.status === "running");
  for (const p of running) {
    try {
      const { ok, violations } = await checkOrgChartQuotas(p.agent_address);
      if (!ok) {
        console.warn(
          `[org-chart-quota] ${p.agent_address} is over ${violations.length} ceiling(s): ` +
            violations
              .map((v) => `${v.resource}${v.departmentId ? `(${v.departmentId})` : ""}=${v.actual}/${v.limit}`)
              .join(", "),
        );
      }
    } catch {
      // best-effort — one agent's measurement failure must never stop
      // the sweep from checking the rest, same posture
      // sweepResourceQuotas()/sweepExpiredTempWorkers() already take.
    }
  }
}

setInterval(() => {
  sweepOrgChartQuotas().catch(() => {});
}, 60_000).unref();
