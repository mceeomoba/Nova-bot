import { db } from "./db.js";
import {
  getOrCreateDefaultSandbox,
  getOrCreateScopedSandbox,
  deleteScopedSandboxIfExists,
  setScopedSandboxNetwork,
  isScopedSandboxNetworkEnabled,
} from "./vmService.js";
import { normalizeDepartmentType, isHardenedNetworkDepartmentType } from "./toolRegistry.js";

/**
 * Hardened department types (finance/security/server) share ONE
 * sandbox per agent instead of getting one each. Safe specifically
 * because — unlike every other department type — their network-
 * disabled state is permanent: POST /departments/:id/network 403s any
 * attempt to enable network for a hardened type, so there's no
 * "toggle network mid-life and now this department's permission
 * profile no longer matches its sandbox-mates" case to handle. A
 * non-hardened department (coding, marketing, ...) CAN legitimately
 * toggle its own network on/off at any point in its life via that
 * same route — sharing those would mean one department's toggle
 * silently changing network for every other department sharing its
 * container, which is a real correctness bug, not a resource saving.
 * So only the permanently-fixed tier is grouped; every other
 * department keeps its existing one-sandbox-per-department behavior,
 * completely unchanged below.
 */
function departmentSandboxScopeId(departmentId: string, agentAddress: string, role: string | null): string {
  return isHardenedNetworkDepartmentType(normalizeDepartmentType(role))
    ? `hardened-shared-${agentAddress}`
    : departmentId;
}

/** How many OTHER active (non-deleted/killed) hardened departments this
 *  agent still has, excluding `excludeDepartmentId` itself — used by
 *  teardownDepartmentEnvironment to decide whether retiring one hardened
 *  department is safe to also delete the shared sandbox, or whether a
 *  sibling is still using it. */
function activeHardenedSiblingCount(agentAddress: string, excludeDepartmentId: string): number {
  const rows = db
    .prepare(
      `SELECT role FROM sub_agents WHERE owner_address = ? AND kind = 'department' AND id != ? AND status = 'running'`,
    )
    .all(agentAddress, excludeDepartmentId) as { role: string | null }[];
  return rows.filter((r) => isHardenedNetworkDepartmentType(normalizeDepartmentType(r.role))).length;
}

/**
 * next-phase.md Phase 2g, second pass (architecture-agent.md §4g) — real
 * per-department / per-project environment provisioning, closing the one
 * dimension the first pass of Phase 2g left honestly unwired (see
 * capability.ts's own "real, honest finding" comment on `environment`).
 * Until this module existed, EVERY worker and department under one
 * top-level agent shared that agent's own single default sandbox
 * (getOrCreateDefaultSandbox, vmService.ts Phase 0) — there was no real
 * per-grant environment for checkCapability's `environment`/
 * `grantedEnvironment` fields to meaningfully compare once a call
 * actually supplied them.
 *
 * The concrete design (deliberately narrower than "every worker gets its
 * own container", which would multiply container count by
 * max_workers_per_department for zero isolation benefit over the
 * existing shared-office model — a PERMANENT worker's whole point, per
 * Phase 2/2a's own module docs, is that it borrows the owner's/
 * department's world wholesale, not that it gets a new one):
 *
 *   - A DEPARTMENT gets its own dedicated environment (one container,
 *     `sbx-department-{departmentId}`), provisioned the moment
 *     create_department() runs and torn down when the department is
 *     retired/deleted. Every PERMANENT worker under that department
 *     (project_id IS NULL) runs inside it. This is the real isolation
 *     boundary §4e's per-department tool profiles were already implying
 *     but couldn't enforce on their own — Phase 2f-ii-a's own "known
 *     limitation" note: Software/Security/Server all resolve to the same
 *     ACTION set, so ACTION-only enforcement can't yet tell one
 *     department's exec access from another's. A real per-department
 *     environment is exactly the missing half; §4g's Scope element
 *     enforced alongside Tool is what this module makes real.
 *   - A PROJECT (a department + a project_id tag — §4b's temp-worker
 *     burst) gets its OWN environment too, separate from its
 *     department's steady-state one (`sbx-project-{departmentId}_
 *     {projectId}`), provisioned the first time spawn_temp_workers is
 *     called for that project_id and torn down by retire_project() / the
 *     TTL sweep / a full department retirement (departments.ts) —
 *     matching §4g's own Worker-382 example (`environment:
 *     temporary-container-382`) exactly: a temp worker's environment is
 *     scoped to its OWN project, never shared with its department's
 *     permanent headcount or with any other project running concurrently
 *     under the same department.
 *   - A FLAT (Phase 2, non-department) worker keeps using its owning
 *     top-level agent's existing default sandbox — unchanged from every
 *     prior phase. The flat pool's own isolation model (or lack of one —
 *     see Phase 2's own module doc: "no new container, no new office")
 *     was never the gap next-phase.md's Phase 2g section named;
 *     departments/projects were.
 *
 * All three provisioning paths reuse getOrCreateDefaultSandbox /
 * getOrCreateScopedSandbox (vmService.ts) — same office-fs bind-mount,
 * same hardening profile (docker.ts's createNamedSandbox), same
 * quota-tracked `sandboxes` row shape every prior sandbox has always
 * had. A department/project environment is a REAL row: it counts against
 * config.maxEnvironmentSandboxesPerAgent (a pool kept separate from
 * maxSandboxesPerAgent — see config.ts), and is deleted the same way any
 * sandbox is (deleteScopedSandboxIfExists).
 */

export interface SubAgentForEnvironment {
  id: string;
  owner_address: string;
  kind: string; // 'worker' | 'department'
  project_id: string | null;
}

/** The environment a department's own calls — and every PERMANENT worker
 *  underneath it — should run in. Idempotent: provisions on first call
 *  (create_department time, or lazily for a pre-2g department row that
 *  never had one), returns the existing one on every call after. */
export async function resolveDepartmentEnvironment(
  departmentId: string,
  topLevelAgentAddress: string,
  // next-phase.md Phase 9f-i (Founder request): defaults to false —
  // the caller (departments.ts) is responsible for resolving whether
  // this department should have network per the Founder's own
  // per-department opt-in model, and for enforcing the hardened-type
  // hard deny (Finance/Security/Server) before ever passing `true`
  // here.
  wantsNetwork: boolean = false,
  // Added for the hardened-department sandbox-sharing optimization —
  // see departmentSandboxScopeId's doc comment above. Pass the
  // department's own `role` column value; null/unrecognized roles are
  // treated as non-hardened (their own dedicated sandbox), same as
  // normalizeDepartmentType()'s existing fail-open-to-individual
  // posture elsewhere in this codebase.
  role: string | null = null,
): Promise<string> {
  const scopeId = departmentSandboxScopeId(departmentId, topLevelAgentAddress, role);
  return getOrCreateScopedSandbox(topLevelAgentAddress, "department", scopeId, wantsNetwork);
}

/** Toggles network access on an already-provisioned department
 *  environment. Callers MUST have already rejected this for a
 *  hardened department type — see toolRegistry.ts's
 *  HARDENED_NETWORK_DEPARTMENT_TYPES — this function has no role
 *  information of its own to check. */
export async function setDepartmentEnvironmentNetwork(
  departmentId: string,
  wantsNetwork: boolean,
): Promise<void> {
  await setScopedSandboxNetwork("department", departmentId, wantsNetwork);
}

/** Read-only: is this department's environment currently network-
 *  enabled? False if no environment has been provisioned yet. */
export function isDepartmentEnvironmentNetworkEnabled(departmentId: string): boolean {
  return isScopedSandboxNetworkEnabled("department", departmentId);
}

/** The environment a specific project's temp workers should run in,
 *  scoped by department too (see module doc: `projectId` only needs to
 *  be unique per-department, same convention departments.ts's own
 *  department_projects table already established, so the environment id
 *  must include both, not `projectId` alone). */
export async function resolveProjectEnvironment(
  departmentId: string,
  projectId: string,
  topLevelAgentAddress: string,
  // next-phase.md Phase 9f-i: same opt-in-only default as
  // resolveDepartmentEnvironment above — a project burst under a
  // network-enabled department is NOT automatically network-enabled
  // itself; the caller (departments.ts's spawn_temp_workers) decides
  // per call, and still must not pass `true` for a hardened
  // department's project.
  wantsNetwork: boolean = false,
): Promise<string> {
  return getOrCreateScopedSandbox(
    topLevelAgentAddress,
    "project",
    `${departmentId}_${projectId}`,
    wantsNetwork,
  );
}

/**
 * The single entry point subagents.ts (and anything else that ends up
 * driving a sub_agents row's exec/PTY access) should call to find out
 * which sandbox a given row is actually supposed to run in — resolves
 * the three cases in the module doc above. `topLevelAgentAddress` is
 * always the real Agent-tier caller's own address (the one every route
 * in this backend is already driven by — see departments.ts/
 * subagents.ts's own "parent's runtime is the scheduler" module docs),
 * never a worker's or department's own id.
 */
export async function resolveEnvironmentForSubAgent(
  row: SubAgentForEnvironment,
  topLevelAgentAddress: string,
): Promise<string> {
  if (row.kind === "department") {
    return resolveDepartmentEnvironment(row.id, topLevelAgentAddress);
  }

  // Does this worker belong to a department (Tier 3), or is it a flat
  // Phase-2 worker owned directly by the top-level agent? Looked up
  // directly against sub_agents rather than pattern-matching an id
  // prefix convention (departments.ts's newDepartmentId() always
  // produces "dept_..." today, but that's an implementation detail this
  // module shouldn't depend on).
  const deptRow = db
    .prepare(`SELECT id FROM sub_agents WHERE id = ? AND kind = 'department'`)
    .get(row.owner_address) as { id: string } | undefined;

  if (deptRow) {
    if (row.project_id) {
      return resolveProjectEnvironment(deptRow.id, row.project_id, topLevelAgentAddress);
    }
    return resolveDepartmentEnvironment(deptRow.id, topLevelAgentAddress);
  }

  // Flat worker: owner_address IS the top-level agent directly.
  return getOrCreateDefaultSandbox(topLevelAgentAddress);
}

/** Read-only lookup for introspection routes (GET /departments/:id and
 *  friends) — returns the department's currently-provisioned
 *  environment id, or null if none exists yet (a pre-2g row that
 *  hasn't been touched by anything that would lazily provision one).
 *  Never provisions — use resolveDepartmentEnvironment() for that. */
export function getDepartmentEnvironmentId(
  departmentId: string,
  agentAddress: string,
  role: string | null = null,
): string | null {
  const scopeId = departmentSandboxScopeId(departmentId, agentAddress, role);
  const row = db
    .prepare(`SELECT id FROM sandboxes WHERE kind = 'department' AND scope_id = ? AND status != 'deleted'`)
    .get(scopeId) as { id: string } | undefined;
  return row ? row.id : null;
}

/** Best-effort teardown — never throws, same "a cleanup failure must
 *  never block the kill/archive that already happened" pattern
 *  departments.ts's own PTY-close and archiveWorkerOutput() calls
 *  already use throughout. No-op if the environment was never
 *  provisioned.
 *
 *  For a hardened department sharing the agent's one hardened sandbox
 *  (see departmentSandboxScopeId): only actually deletes the container
 *  if this was the LAST active hardened department for this agent —
 *  retiring Finance while Security is still running must not pull the
 *  sandbox out from under Security. */
export async function teardownDepartmentEnvironment(
  departmentId: string,
  agentAddress: string,
  role: string | null = null,
): Promise<void> {
  try {
    const isHardened = isHardenedNetworkDepartmentType(normalizeDepartmentType(role));
    if (isHardened && activeHardenedSiblingCount(agentAddress, departmentId) > 0) {
      return; // a sibling hardened department still owns this shared sandbox
    }
    const scopeId = departmentSandboxScopeId(departmentId, agentAddress, role);
    await deleteScopedSandboxIfExists("department", scopeId);
  } catch {
    // best-effort, see doc above
  }
}

export async function teardownProjectEnvironment(departmentId: string, projectId: string): Promise<void> {
  try {
    await deleteScopedSandboxIfExists("project", `${departmentId}_${projectId}`);
  } catch {
    // best-effort, see doc above
  }
}
