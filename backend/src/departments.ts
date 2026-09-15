import express from "express";
import crypto from "crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { assertCanSpawnSubAgents, checkCapability } from "./capability.js";
import { ensureDepartmentQuota } from "./office.js";
import * as pty from "./ptyService.js";
import {
  archiveWorkerOutput,
  queryDepartmentKnowledge,
  recordDepartmentKnowledge,
  type DepartmentKnowledgeCategory,
} from "./departmentMemory.js";
import {
  resolveDepartmentEnvironment,
  resolveProjectEnvironment,
  teardownDepartmentEnvironment,
  teardownProjectEnvironment,
  getDepartmentEnvironmentId,
  setDepartmentEnvironmentNetwork,
  isDepartmentEnvironmentNetworkEnabled,
} from "./environment.js";
import { assignTools, normalizeDepartmentType, isHardenedNetworkDepartmentType } from "./toolRegistry.js";
import { recordToolGrants, revokeGrantsByProject, projectScopeKey } from "./toolGrants.js";
import { runOnScheduleWithLease } from "./scheduler.js";
import { MARKETPLACE_SUBDOMAIN_SLUG } from "./domains.js";
// Zent.md Phase 2e: profitability gate — imported here so the
// create_department route can enforce it at spawn time, the single
// chokepoint for all department creation. Not imported at top-of-file
// in all the phases below that don't need it; only this import and the
// guard block below are Zent.md Phase 2a/2e additions.
import {
  isEligibleForExpansion,
  getOpportunity,
  getOpportunityReport,
  getCurrentResearchFinding,
  getCurrentFinanceFinding,
} from "./expansion.js";

/**
 * next-phase.md Phase 2a (architecture-agent.md §4a): "Departments —
 * sub-agents as heads, with their own workers."
 *
 * A department is NOT a new kind of entity at the data layer — it's an
 * ordinary `sub_agents` row (the exact table subagents.ts/Phase 2
 * built), just with `kind = 'department'` instead of `'worker'`, owned
 * directly by a top-level agent. A department's own workers are, in
 * turn, ordinary `kind = 'worker'` rows in that same table, except their
 * `owner_address` points at the DEPARTMENT's id rather than directly at
 * the top-level agent:
 *
 *   Agent A  (real agent_address, has a wallet/office/sandbox)
 *    └─ dept_xx  (sub_agents row, kind='department', owner_address=A)
 *         └─ wkr_xx  (sub_agents row, kind='worker', owner_address=dept_xx)
 *
 * Depth is capped at exactly these three tiers (§4a): a worker cannot
 * itself spawn a department or a further worker. This is enforced at
 * every spawn point below via capability.ts's assertCanSpawnSubAgents(),
 * which rejects any `agentAddress` that is itself a row in `sub_agents`
 * — a real top-level agent's address is never in that table, so this
 * only ever fires on the case §4a requires it to: a worker or a
 * department trying to spawn further children. There is deliberately no
 * "department creates a department" path either — architecture-agent.md
 * §4a's org chart is exactly Agent → Department → Worker, not
 * Department → Department.
 *
 * Same "parent's runtime is the scheduler" model as Phase 2: every route
 * here is still driven by the TOP-LEVEL agent's own agentAddress, never
 * by a department calling in "as itself" — a department has no runtime
 * process of its own (§4: sub-agents are threads, not processes), so
 * "department.spawn_worker(role)" in the architecture doc's syscall
 * table is, concretely, Agent A's own runtime calling
 * POST /departments/:deptId/workers.
 *
 * Existing Tier-3-worker lifecycle routes (status/result/kill/pty) are
 * intentionally NOT duplicated here — subagents.ts's getOwnedWorker()
 * was generalized in this phase to resolve ownership transitively (see
 * capability.ts's isSubagentOf()), so a department's workers are managed
 * through the exact same /subagents/:id/... routes Phase 2 already
 * built, using the top-level agent's own agentAddress exactly as before.
 *
 * next-phase.md Phase 2b (architecture-agent.md §4b): "Temporary project
 * workers (burst capacity, then they burn up)." A temp worker is, once
 * again, NOT a new kind of row — it's an ordinary `kind = 'worker'` row
 * in `sub_agents`, indistinguishable in shape from a Phase 2a permanent
 * department worker, except it carries a `project_id` tag and (usually)
 * a `ttl_at` deadline:
 *
 *   dept_xx  (kind='department', owner_address=A)
 *    ├─ wkr_xx  (kind='worker', project_id=NULL)       <- permanent, Phase 2a
 *    └─ wkr_yy  (kind='worker', project_id='falcon-9')  <- temp, Phase 2b
 *
 * Because it's still just a `kind = 'worker'` row, a temp worker is
 * driven through the EXACT SAME /subagents/:id/... routes as any other
 * worker (subagent_pty_create, subagent_status, subagent_result,
 * kill_subagent) — nothing new needed there, and nothing about it gets
 * more (or less) capability than a permanent worker of the same role,
 * per §4b's "temporary changes lifetime, not capability." What's new
 * here is purely lifecycle: bulk creation tagged with a project_id
 * (spawn_temp_workers), bulk teardown by that same tag (retire_project),
 * and a TTL safety net for when retire_project() never gets called.
 *
 * `max_temp_workers_per_department` is tracked as a SEPARATE ceiling
 * from `max_workers_per_department` (see activeTempWorkerCountFor vs.
 * activeWorkerCountForDepartment below) even though both count rows in
 * this same table under the same owner_address — a burst project
 * shouldn't eat into (or be limited by) a department's steady-state
 * permanent-worker budget, matching §4a's own manifest.json example
 * listing them as two independent quota fields.
 *
 * next-phase.md Phase 2d (architecture-agent.md §4c: per-tier reasoning/
 * memory/budget/tools/lifecycle): two concrete additions on top of
 * everything above.
 *   - Budget: a department's own sub_agents row now carries
 *     spend_cap_daily_usdc (set at POST / creation time, defaulted from
 *     config.defaultDepartmentSpendCapDailyUsdc if not given explicitly)
 *     — the field §4c calls for, NOT YET enforced against wallet.pay
 *     calls (that's Phase 2f's job by the doc's own admission).
 *   - Memory: a Temporary Worker's raw result/error is now archived
 *     into department_knowledge (departmentMemory.ts) before its row is
 *     killed — in the explicit retire-project route, the TTL sweep, and
 *     a full department retirement, all three places a temp worker's
 *     output would otherwise be lost past a project_burns duration/
 *     reason row. See departmentMemory.ts's own doc comment for why
 *     this landed here instead of agent/src/memory/*.
 *
 * next-phase.md Phase 2h (architecture-agent.md §4b, revised — "a
 * project is a workload tag, not a fifth tier"): locks retire_project()
 * into the full, explicitly-ordered 7-step sequence (see
 * retireProjectSequence() below for the step-by-step doc), called
 * identically by the explicit POST /:id/retire-project route AND the
 * TTL reaper — no more separate, shorter TTL-path logic. Two concrete
 * things this phase adds that never existed before it:
 *   - project_archive (new table): step 2's raw "everything" record,
 *     written before any worker is killed — distinct from step 7's
 *     write into department_knowledge, which is now explicitly an
 *     EVALUATED SUBSET rather than the same write duplicated. See
 *     GET .../projects/:projectId/archive, new this phase, answering
 *     "what did this project actually produce" as its own queryable
 *     thing, separate from GET .../burns' duration/reason metadata.
 *   - Budget return (step 6): before this phase, spawn_temp_workers
 *     never reserved any budget for a project in the first place, so
 *     there was nothing for a "return unused budget" step to credit
 *     back. create_project() can now optionally set
 *     budget_reserved_usdc on its own department_projects row;
 *     wallet.ts's POST /:address/pay can now optionally tag a payment
 *     with the projectId that caused it (bumping that row's own running
 *     budget_spent_usdc); retireProjectSequence() credits reserved -
 *     spent back to the department's rolling-24h cap as a negative
 *     department_spend_log row when a reservation exists, and is an
 *     honest no-op — not a fabricated credit — for a project that never
 *     had one. See db.ts's own migration comment for the full reasoning.
 */

const router = express.Router();

function newDepartmentId(): string {
  return "dept_" + crypto.randomBytes(5).toString("hex");
}

export interface DepartmentRow {
  id: string;
  owner_address: string;
  kind: "department";
  name: string;
  role: string;
  task: string;
  status: "running" | "completed" | "failed" | "killed";
  created_at: number;
  ended_at: number | null;
  // next-phase.md Phase 2d (architecture-agent.md §4c, Budget section):
  // the department's own explicit daily spend ceiling. Always a number
  // once a row exists past this phase (POST /departments backfills it
  // from config.defaultDepartmentSpendCapDailyUsdc if the caller didn't
  // pass one — see below), never left NULL the way Phase 0's
  // manifest.json quota stubs were, since there's no separate
  // "ensure..." backfill pass for a per-row column the way there is for
  // manifest.json fields. NOT enforced against wallet.pay yet — see
  // departmentMemory.ts's sibling module doc and next-phase.md's Phase
  // 2f checklist, which is explicitly where that enforcement lands.
  spend_cap_daily_usdc: number;
  // next-phase.md Phase 2i(b) (architecture-agent.md §9): the resolved
  // assign_tools("department_agent", { role }) snapshot taken at
  // create_department time — a JSON-encoded string[] of tool_registry
  // names, or NULL for any department row created before this phase
  // (see db.ts's Phase 2i(b) migration comment on why this is a
  // snapshot, not a live view).
  granted_tools: string | null;
  // next-phase.md Phase 7a (architecture-agent.md §4a, "Agent A hands
  // it a *purpose*"): the real, caller-stated objective this department
  // was created for. NULL for any department row created before this
  // phase (see db.ts's Phase 7a migration comment) — POST /departments
  // itself always writes a non-NULL value going forward, falling back
  // to the pre-Phase-7a placeholder string only when the caller omits
  // one, so "NULL" after this phase means "predates this column," not
  // "no purpose was ever given."
  objective: string | null;
  // Zent.md Phase 5a (db.ts's own migration comment has the full
  // reasoning): set only for a `research`-type department, to the
  // `opportunities.id` it was created to verify. NULL for every other
  // department type, and for research departments created before this
  // migration.
  opportunity_id: string | null;
}

// next-phase.md Phase 7a: same "bounded, not arbitrary" free-text cap
// marketplace.ts's MAX_FLAG_DETAIL_LENGTH already sets — this field
// ends up inside the Department Agent's own system prompt
// (buildDepartmentAgentPrompt(), agent-runtime/src/systemPrompt.ts),
// so it needs a real ceiling for the same reason any other
// prompt-interpolated caller input does, not because a longer
// objective is unsafe on its own.
const MAX_OBJECTIVE_LENGTH = 2000;

// Phase 5c (architecture-agent.md §6, The Orchestrator): exported so
// orgChartQuotas.ts can read the exact same counts the creation-time
// routes below already check against, rather than a second, driftable
// copy of this query. Read-path only — nothing about what these count
// or how changes here; only their visibility outside this file does.
export function activeDepartmentCountFor(ownerAddress: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM sub_agents WHERE owner_address = ? AND kind = 'department' AND status = 'running'`,
      )
      .get(ownerAddress) as { n: number }
  ).n;
}

// Phase 2a: permanent workers only (project_id IS NULL) — a burst of
// temp workers must never eat into this ceiling, see
// activeTempWorkerCountForDepartment below for their own separate one.
// Exported for Phase 5c (see activeDepartmentCountFor's own comment
// above — same reasoning applies here).
export function activeWorkerCountForDepartment(departmentId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM sub_agents
         WHERE owner_address = ? AND kind = 'worker' AND status = 'running' AND project_id IS NULL`,
      )
      .get(departmentId) as { n: number }
  ).n;
}

// Phase 2b: the mirror of the above, scoped to project_id IS NOT NULL —
// this is what max_temp_workers_per_department actually bounds.
// Exported for Phase 5c, same reasoning as the two exports above.
export function activeTempWorkerCountForDepartment(departmentId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM sub_agents
         WHERE owner_address = ? AND kind = 'worker' AND status = 'running' AND project_id IS NOT NULL`,
      )
      .get(departmentId) as { n: number }
  ).n;
}

// Phase 5c: the exact row set GET /departments already lists (same
// `owner_address = ? AND kind = 'department'` shape), narrowed to
// `status = 'running'` — a stopped/killed department has no live
// worker pool for orgChartQuotas.ts to check a ceiling against, so
// there's no reason for the orchestrator's own sweep to look at it.
// Read-path only, per this sub-phase's own scope: no new table, no new
// column, just a second reader of rows every other route in this file
// already reads.
export function listRunningDepartmentsForAgent(ownerAddress: string): DepartmentRow[] {
  return db
    .prepare(`SELECT * FROM sub_agents WHERE owner_address = ? AND kind = 'department' AND status = 'running'`)
    .all(ownerAddress) as DepartmentRow[];
}

function isValidProjectId(projectId: string): boolean {
  return /^[a-z0-9_-]{1,60}$/i.test(projectId);
}

// Phase 2g retrofit: every headcount-style quota check in this file
// (max_departments / max_workers_per_department / max_temp_workers_per_
// department) decides allow/deny the same way now — via checkCapability's
// `budget` dimension (unit: 'calls', since a quota here is a count, not
// currency) — instead of five separate hand-rolled `if (count >= max)`
// comparisons that never touched capability_audit. This is a thin
// wrapper, not a replacement for the tailored 403 error messages each
// call site below still constructs itself (the callers/tools this
// backend serves depend on those exact strings, same "internal-mechanism
// swap, not an API change" reasoning wallet.ts's checkDepartmentBudget()
// retrofit already used) — checkQuota() only returns whether the call
// is over budget, the call site decides what to say about it.
//
// `spent` is deliberately the count AFTER this call would apply (current
// running count + however many this call is about to add — 1 for a
// single spawn, n for a bulk temp-worker spawn), matching
// checkBudgetAndEnvironment's own `spent > limit` semantics: "would this
// push me over," not "am I already over."
function checkQuota(params: {
  ownerAddress: string;
  resourceType: "department" | "department_quota";
  resourceId: string;
  current: number;
  adding: number;
  limit: number;
}): boolean {
  try {
    checkCapability({
      caller: params.ownerAddress,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      action: "manage",
      budget: { limit: params.limit, spent: params.current + params.adding, unit: "calls" },
    });
    return true;
  } catch (err: any) {
    if (err.status === 429) return false;
    // Any other denial (ownership no longer holds, resource vanished
    // between the caller's own lookup and here) is a real error, not a
    // quota decision — rethrow so the route's own catch block surfaces
    // it with its actual status/message instead of being silently
    // reinterpreted as "over quota."
    throw err;
  }
}

/**
 * next-phase.md Phase 2b (architecture-agent.md §4b): "A ttl is a safety
 * net, not the primary mechanism — if retire_project() is never called
 * ... the orchestrator (§6) should reap any temp worker past its TTL
 * automatically, the same way it already reaps a crashed agent."
 *
 * This IS that stub — a plain in-process interval, same shape as
 * subagents.ts's sweepCrashedWorkers — not the real thing §6/Phase 5
 * eventually promotes it into (a proper scheduled reaper that survives
 * this process restarting and coordinates across however many backend
 * instances end up running). Explicitly flagged as such in next-phase.md
 * Phase 5's own checklist rather than silently presented as the final
 * form.
 *
 * next-phase.md Phase 2h: this sweep now calls retireProjectSequence()
 * — the SAME full 7-step function the explicit retire-project route
 * calls — for every (department, project) pair it finds an expired
 * worker under, instead of its own separate, shorter kill/burn/archive
 * logic. This is what locks in the doc's own line that the orchestrator
 * "should reap... the same way it already reaps a crashed agent" as
 * meaning *the same sequence*, not a lighter-weight one: a project torn
 * down by TTL now gets its raw project_archive record, its budget-return
 * check, and its department_projects status flip exactly like an
 * explicit call would, not just a project_burns row and a best-effort
 * department_knowledge write. Good enough for a single-VM deployment
 * today: any running temp worker whose ttl_at has passed is what
 * triggers the sequence for its (department, project) pair.
 *
 * next-phase.md Phase 5d (architecture-agent.md §6): this function's
 * OWN logic is unchanged by that phase — it still just re-queries live
 * 'running' state and calls retireProjectSequence() per touched pair,
 * which is exactly what makes it safe to re-run from scratch after an
 * interrupted attempt. What Phase 5d changes is how often and by what
 * this function gets CALLED — see the `runOnScheduleWithLease()` call
 * below (scheduler.ts) replacing the bare `setInterval` this doc
 * comment used to describe as the stub's own shape.
 */
async function sweepExpiredTempWorkers(): Promise<void> {
  const now = Date.now();
  const expired = db
    .prepare(
      `SELECT id, owner_address, project_id FROM sub_agents
       WHERE kind = 'worker' AND status = 'running' AND ttl_at IS NOT NULL AND ttl_at <= ?`,
    )
    .all(now) as { id: string; owner_address: string; project_id: string | null }[];

  if (expired.length === 0) return;

  // This sweep can touch workers from many different (department,
  // project) pairs in one pass, unlike the single-project scope of an
  // explicit retire-project call — retireProjectSequence() itself only
  // re-selects and processes the running workers under ONE (department,
  // project) pair per call, so group first, then call it once per pair.
  // project_id is only NULL for a permanent worker, which never has
  // ttl_at set in the first place — this sweep's WHERE clause only ever
  // matches temp workers, but the null-check keeps the grouping
  // type-honest either way.
  const touchedProjects = new Map<string, { departmentId: string; projectId: string }>();
  for (const w of expired) {
    if (!w.project_id) continue;
    touchedProjects.set(`${w.owner_address}::${w.project_id}`, {
      departmentId: w.owner_address,
      projectId: w.project_id,
    });
  }

  for (const { departmentId, projectId } of touchedProjects.values()) {
    const dept = db.prepare(`SELECT * FROM sub_agents WHERE id = ? AND kind = 'department'`).get(departmentId) as
      | DepartmentRow
      | undefined;
    // A department row disappearing between the SELECT above and here
    // (e.g. a concurrent full department retirement already tore it and
    // its workers down) means there's nothing left for this pair's own
    // sequence to do — skip rather than throw, since the sweep's job is
    // best-effort cleanup, not a source of unhandled rejections.
    if (!dept) continue;
    try {
      await retireProjectSequence(dept, projectId, "ttl_expired");
    } catch {
      // best-effort, matching every other cleanup path in this sweep —
      // one pair's failure must never stop the rest of the sweep or
      // crash the interval.
    }
  }
}

// next-phase.md Phase 5d: promoted from a bare setInterval to a
// lease-guarded scheduled job — see scheduler.ts's own module doc for
// what that buys (restart resilience + cross-instance coordination).
// Same 60s cadence the stub always used; leaseMs is set generously
// above that (5 minutes) so a sweep that's merely slow (many touched
// projects in one pass) is never mistaken for a crashed one and has
// its lease stolen mid-run — only a sweep that's actually stuck or
// whose process actually died goes that long without releasing.
runOnScheduleWithLease({
  name: "ttl_reaper",
  intervalMs: 60_000,
  leaseMs: 5 * 60_000,
  fn: sweepExpiredTempWorkers,
});

/**
 * Resolves a department the caller (a top-level agent) actually owns —
 * direct equality only, deliberately NOT isSubagentOf()/transitive: a
 * department's owner_address is always a real top-level agent's
 * address by construction (nothing below ever lets a department itself
 * spawn another department), so there is no extra hop to climb here the
 * way subagents.ts's getOwnedWorker() has to for Tier-3 workers.
 *
 * Exported as of next-phase.md Phase 2f-iv: wallet.ts's POST
 * /:address/pay needs the exact same "does this department belong to
 * this caller" resolution when a Department Agent's spend is attributed
 * to a departmentId, so it can check that department's own
 * spend_cap_daily_usdc rather than trusting a caller-supplied id at
 * face value. Reusing this function (instead of a second copy of the
 * same query in wallet.ts) is what makes "the department cannot draw
 * from ... another department's allocation" true by construction — the
 * lookup a payment is checked against and the lookup every other
 * department route already checks against are the same function.
 */
export function getOwnedDepartment(id: string, ownerAddress: string): DepartmentRow {
  const row = db.prepare(`SELECT * FROM sub_agents WHERE id = ? AND kind = 'department'`).get(id) as
    | DepartmentRow
    | undefined;
  if (!row || row.owner_address !== ownerAddress) {
    throw Object.assign(new Error(`department not found: ${id}`), { status: 404 });
  }
  return row;
}

// POST /departments  { agentAddress, name, role, spendCapDailyUsdc?, objective? }
// Stands up a new department (Tier 2) under agentAddress, bounded by
// manifest.quota.max_departments (backfilled from config default on
// first use — see office.ts's ensureDepartmentQuota, closing Phase 0's
// null-stub gap for real). `name` is the department's short identifier
// ("marketing", "frontend", ...), unique per owning agent; `role`
// describes what it's responsible for, same shape as a worker's role.
// `objective` (next-phase.md Phase 7a, architecture-agent.md §4a) is
// the department's real, open-ended purpose — optional, falls back to
// a generic placeholder when omitted, capped at MAX_OBJECTIVE_LENGTH.
/**
 * next-phase.md Phase 9e-iii (architecture-agent.md §4h's closing
 * paragraph): every Marketing Department Agent gets a pointer to the
 * already-shared marketplace.ts site (see 9e-i's own inspection
 * finding — one platform-wide instance, never one per Agent) rather
 * than any Cloudflare/Mailcow provisioning authority of its own. This
 * is a read-only knowledge fact, not a capability grant — a Marketing
 * department can't reach `/admin/domain/...` (9e-ii, `x-admin-key`-
 * gated) no matter what's written here.
 *
 * Written into `department_knowledge` (category `department_strategy`
 * — reusing Phase 2f's existing seven-category taxonomy rather than
 * inventing an eighth, per this sub-phase's own "Touches" line) at
 * `create_department` time, once, the same "creation-time snapshot,
 * not a live view" convention `granted_tools` (Phase 2i(b)) already
 * uses for this same route — if `config.domainApex`/the marketplace's
 * own subdomain slug ever changed later, an already-created
 * department's own knowledge row would need a fresh write, same as an
 * already-issued `granted_tools` snapshot doesn't retroactively track
 * a `tool_registry` edit (Phase 2i(b)'s own documented gap).
 *
 * Content wording matches architecture-agent.md §4h's own line
 * verbatim: "our marketplace listings live at {marketplace_url}, your
 * storefront path is /{agent-slug}" — `{agent-slug}` is this
 * department's owning Agent's own `agents.slug` (always assigned at
 * `createAgentWallet()` time, wallet.ts), not the department's own id
 * or name; the marketplace lists by *seller* (an Agent's wallet
 * address), never by department, so the storefront path an Agent's
 * Marketing department advertises is that Agent's own slug regardless
 * of which department is doing the advertising.
 *
 * Best-effort, matching every other post-creation side effect in this
 * route (environment provisioning is the one exception that rolls the
 * department back on failure, because a department with nowhere to
 * run is a department that can't function at all — a missing knowledge
 * row is a lesser failure than that, same "a knowledge-write failure
 * can never block the thing that already succeeded" reasoning
 * departmentMemory.ts's own archiveWorkerOutput() doc comment already
 * establishes for this codebase). Never thrown to the caller; logged
 * and swallowed instead.
 */
function writeMarketplaceKnowledgeForMarketingDepartment(agentAddress: string, departmentId: string): void {
  try {
    const agentRow = db.prepare(`SELECT slug FROM agents WHERE address = ?`).get(agentAddress) as
      | { slug: string | null }
      | undefined;
    const agentSlug = agentRow?.slug;
    if (!agentSlug) {
      // Should not happen in practice — every agents row gets a slug
      // at createAgentWallet() time — but this route has no FOREIGN
      // KEY-enforced guarantee that agentAddress resolves to a real,
      // slugged row (same carried-forward "no distinct authenticated
      // caller" gap this file has flagged since Phase 2a), so fail
      // closed on the write rather than record a storefront path with
      // a hole in it.
      console.error(
        `[department-knowledge] skipped marketplace knowledge write for department ${departmentId}: agent ${agentAddress} has no slug`,
      );
      return;
    }

    const marketplaceUrl = `https://${MARKETPLACE_SUBDOMAIN_SLUG}.${config.domainApex}`;
    const storefrontPath = `/${agentSlug}`;

    recordDepartmentKnowledge({
      departmentId,
      category: "department_strategy",
      content: `our marketplace listings live at ${marketplaceUrl}, your storefront path is ${storefrontPath}`,
    });
  } catch (err: any) {
    console.error(
      `[department-knowledge] failed to write marketplace knowledge for department ${departmentId}:`,
      err?.message || err,
    );
  }
}

router.post("/", async (req, res) => {
  try {
    // Zent.md Phase 5a: `opportunityId` is additive, same "optional
    // unless role resolves to research" shape `objective` already has
    // as an optional-but-validated field above — every pre-Phase-5a
    // caller (every role except "research") keeps working unmodified.
    const { agentAddress, name, role, spendCapDailyUsdc, objective, wantsNetwork, opportunityId } = req.body;
    if (!agentAddress || !name || !role) {
      return res.status(400).json({ error: "agentAddress, name, and role are required" });
    }
    // next-phase.md Phase 9f-i (Founder request): the Agent decides
    // per-department whether it gets network access — EXCEPT Finance,
    // Security, and Server, which are hardened and can never receive
    // it, no matter what the caller passes here. This is a hard
    // override, not a validation error — a caller asking for network
    // on a hardened department type gets a department (if everything
    // else is valid), just silently without network, same "the
    // hardening wins, the request doesn't fail" posture a security
    // boundary like this should have (failing the whole create_department
    // call would just teach a caller to omit the flag next time and get
    // the same denied-network result anyway).
    const deptTypeForNetwork = normalizeDepartmentType(role);
    const resolvedWantsNetwork =
      wantsNetwork === true && !isHardenedNetworkDepartmentType(deptTypeForNetwork);
    if (!/^[a-z0-9_-]{1,40}$/i.test(name)) {
      return res.status(400).json({
        error: "name must be 1-40 characters of letters, numbers, underscore, or hyphen",
      });
    }
    // next-phase.md Phase 7a: objective is optional and additive — a
    // caller that only ever sends name/role (every pre-Phase-7a caller)
    // keeps working exactly as it does today, falling back to the same
    // placeholder string this route has always synthesized. When given,
    // it must be a non-empty string within MAX_OBJECTIVE_LENGTH — same
    // shape of validation `name`'s own regex check just ran, applied to
    // free text instead of a fixed pattern.
    let resolvedObjective: string;
    if (objective !== undefined) {
      if (typeof objective !== "string" || objective.trim().length === 0) {
        return res.status(400).json({ error: "objective, if provided, must be a non-empty string" });
      }
      if (objective.length > MAX_OBJECTIVE_LENGTH) {
        return res
          .status(400)
          .json({ error: "objective_too_long", maxLength: MAX_OBJECTIVE_LENGTH });
      }
      resolvedObjective = objective;
    } else {
      resolvedObjective = `Heads the "${name}" department`;
    }
    // next-phase.md Phase 2d (architecture-agent.md §4c, Budget): an
    // optional explicit daily spend cap for this department, in USDC.
    // Falls back to config.defaultDepartmentSpendCapDailyUsdc when
    // omitted, same "caller can override, config only sets the initial
    // number" pattern office.ts's ensureDepartmentQuota() already uses
    // for the headcount quotas — just applied at row-creation time here
    // instead of via a lazy backfill, since this column lives on the
    // department's own sub_agents row, not manifest.json.
    let spendCap = config.defaultDepartmentSpendCapDailyUsdc;
    if (spendCapDailyUsdc !== undefined) {
      const n = Number(spendCapDailyUsdc);
      if (!Number.isFinite(n) || n <= 0) {
        return res.status(400).json({ error: "spendCapDailyUsdc must be a positive number" });
      }
      spendCap = n;
    }

    assertCanSpawnSubAgents(agentAddress);

    // Zent.md Phase 2a/2e: opportunity_intelligence is the only
    // department type that requires the spawning agent to be
    // profitable before it can be created. The check intentionally
    // runs after assertCanSpawnSubAgents (which gates ALL department
    // creation) and before the quota check — being profitable doesn't
    // bypass the headcount ceiling, and hitting the quota ceiling
    // shouldn't obscure the more fundamental "not yet profitable"
    // rejection with a misleading error. Returning the component
    // figures (revenue, spend, surplus) in the error body lets a
    // caller surface a meaningful message ("you need to earn $X more
    // before the Opportunity Intelligence department unlocks") rather
    // than a bare rejection.
    if (normalizeDepartmentType(role) === "opportunity_intelligence") {
      const eligibility = isEligibleForExpansion(agentAddress);
      if (!eligibility.eligible) {
        return res.status(403).json({
          error: "opportunity_intelligence_requires_profitability",
          detail:
            "The opportunity_intelligence department can only be spawned by a top-level agent whose lifetime settled revenue exceeds its lifetime spend.",
          revenueUsdc: eligibility.revenueUsdc,
          spendUsdc: eligibility.spendUsdc,
          surplusUsdc: eligibility.surplusUsdc,
        });
      }
    }

    // Zent.md Phase 5a: a `research` department is not a general-purpose
    // department like the other seven types — it exists to verify one
    // specific `opportunity_id`, is spawned by the top-level agent that
    // owns the opportunity's own report (Company A, in Zent.md's
    // naming), and there is never more than one live (status='running')
    // research department per opportunity at a time. All three of those
    // are enforced here, before the quota check below, for the same
    // "don't let a headcount rejection obscure a more fundamental one"
    // reasoning the opportunity_intelligence guard just above already
    // gives.
    let resolvedOpportunityId: string | null = null;
    if (normalizeDepartmentType(role) === "research") {
      if (typeof opportunityId !== "string" || opportunityId.trim().length === 0) {
        return res.status(400).json({
          error: "opportunityId is required to spawn a research department",
        });
      }
      const opportunity = getOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: `opportunity not found: ${opportunityId}` });
      }
      // An opportunity always has a parent report (Phase 1b's own FK),
      // and a report is always owned by exactly one agent (Phase 1a) —
      // so "does agentAddress own the opportunity" reduces to "does
      // agentAddress own the report this opportunity was scored out
      // of," the same chain GET /expansion/opportunities/:id's own
      // detail view already walks.
      const report = getOpportunityReport(opportunity.report_id);
      if (!report || report.agent_address !== agentAddress) {
        return res.status(403).json({
          error: "research_department_requires_owning_agent",
          detail:
            "A research department can only be spawned by the top-level agent that owns the opportunity it's created to verify.",
        });
      }
      const existingResearchDept = db
        .prepare(
          `SELECT id FROM sub_agents WHERE kind = 'department' AND status = 'running' AND opportunity_id = ?`,
        )
        .get(opportunityId) as { id: string } | undefined;
      if (existingResearchDept) {
        return res.status(409).json({
          error: "research_department_already_running",
          detail: `opportunity ${opportunityId} already has a running research department (${existingResearchDept.id}) — one instance per opportunity.`,
          departmentId: existingResearchDept.id,
        });
      }
      resolvedOpportunityId = opportunityId;
    }

    // Zent.md Phase 8a: "Department type `finance`, spawned against a
    // `scored` opportunity that has a completed research report (a
    // `high_regulatory_risk` tag does not block Finance from picking it
    // up)." Unlike `research` (Phase 5a), `finance` is not a new,
    // expansion-only department type — it's one of the seven original
    // general-purpose types (CANONICAL_DEPARTMENT_TYPES, toolRegistry.ts)
    // that already existed for a company's own ordinary finance work,
    // unrelated to this pipeline. So this guard only engages when a
    // caller actually passes an `opportunityId` alongside role="finance"
    // — a bare `finance` department (every pre-Zent.md caller, and every
    // caller not doing expansion cost-modeling) is completely unaffected
    // and keeps working exactly as it always has.
    //
    // Deliberately does NOT write opportunityId onto this department's
    // own `sub_agents.opportunity_id` column the way the research guard
    // above does: that column is read back, unfiltered by department
    // type, by retireResearchDepartmentForOpportunity() (Phase 5a/7d) —
    // `SELECT ... WHERE kind = 'department' AND status = 'running' AND
    // opportunity_id = ?` — to find the ONE research department to tear
    // down when a research finding is filed. Populating it here too
    // would let a live finance department for the same opportunity_id
    // collide with that lookup and risk getting torn down by Research's
    // own teardown path instead of (or as well as) the actual research
    // department. Zent.md's own plan never asks for a finance-side
    // "one live instance"/auto-teardown rule the way 5a explicitly does
    // for research, so there's nothing to gain from that write and real
    // risk in adding it — Phase 9/10's eventual finance tools take
    // opportunityId as a plain call argument instead (the same shape
    // Phase 5b–5d's research tools already use), so cost-modeling work
    // never needed this department row to carry the association anyway.
    if (normalizeDepartmentType(role) === "finance" && typeof opportunityId === "string" && opportunityId.trim().length > 0) {
      const opportunity = getOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: `opportunity not found: ${opportunityId}` });
      }
      // Ownership parity with the research guard above: a finance
      // department cost-modeling an expansion opportunity can only be
      // spawned by the top-level agent that owns that opportunity's own
      // report — Zent.md doesn't restate this for Finance the way 5a
      // spells it out for Research, but nothing about Company A's own
      // internal cost modeling should ever be triggerable by a
      // different agent, and every other opportunity-scoped guard in
      // this file already enforces exactly this chain.
      const report = getOpportunityReport(opportunity.report_id);
      if (!report || report.agent_address !== agentAddress) {
        return res.status(403).json({
          error: "finance_department_requires_owning_agent",
          detail:
            "A finance department can only be spawned against an opportunity by the top-level agent that owns it.",
        });
      }
      // "spawned against a `scored` opportunity" — Phase 3d's own
      // header comment already resolves Zent.md's prose "status =
      // 'scored'" to this table's real `selected` status value (this
      // codebase reserves the literal string "scored" for
      // opportunity_reports.status, Phase 1a, a different column on a
      // different table); Finance's gate reuses that same resolution
      // rather than inventing a second reading of the same word.
      if (opportunity.status !== "selected") {
        return res.status(409).json({
          error: "finance_requires_selected_opportunity",
          detail: `opportunity ${opportunityId} must be selected (Zent.md's "scored") before Finance can pick it up — current status: ${opportunity.status}.`,
        });
      }
      // "... that has a completed research report" — compileResearchReport()
      // (7a) is a read-only projection off whatever the CURRENT research
      // finding says, and Research's own department is torn down the
      // moment its finding is filed (5a/7d) — so "a completed research
      // report" is read as "Research has filed at least one finding for
      // this opportunity," not a separate status field this table
      // doesn't have.
      if (!getCurrentResearchFinding(opportunityId)) {
        return res.status(409).json({
          error: "finance_requires_completed_research_report",
          detail: `opportunity ${opportunityId} has no completed research finding yet — Finance can only pick up an opportunity Research has already reported on.`,
        });
      }
      // "a `high_regulatory_risk` tag does not block Finance from
      // picking it up" — deliberately NOT checked anywhere above.
      // Nothing in this block reads opportunity.tags. This comment
      // exists so a future edit doesn't pattern-match the two status
      // checks above and add one by accident.
    }

    // Zent.md Phase 11a: "Department type `strategy`, spawned once
    // both Research and Finance have filed non-rejecting reports."
    // Same shape as the finance guard just above — `strategy` is
    // opportunity-scoped by call argument, not by a sub_agents.
    // opportunity_id row association (see toolRegistry.ts's own Phase
    // 11a comment on why writing that column here would risk
    // colliding with retireResearchDepartmentForOpportunity()'s
    // unfiltered-by-role lookup, the exact same reasoning the finance
    // guard above already spells out for itself).
    //
    // "non-rejecting reports" is read as: the opportunity itself has
    // not been rejected. Finance's only reject path (Phase 10b,
    // rejectForFailedRunway) always drives the opportunity to
    // status='rejected' as part of the same transaction that files the
    // hard_reject onto its finding — so an opportunity whose Finance
    // report WAS a rejection is caught by this one status check,
    // without this guard needing its own second read of the finance
    // finding's hard_reject field. Research has no reject path of its
    // own to check (only Finance's Phase 10b does) — Zent.md never
    // gives Research an early-exit the way it explicitly gives
    // Finance one.
    if (normalizeDepartmentType(role) === "strategy") {
      if (typeof opportunityId !== "string" || opportunityId.trim().length === 0) {
        return res.status(400).json({
          error: "opportunityId is required to spawn a strategy department",
        });
      }
      const opportunity = getOpportunity(opportunityId);
      if (!opportunity) {
        return res.status(404).json({ error: `opportunity not found: ${opportunityId}` });
      }
      // Ownership parity with the research/finance guards above: a
      // strategy department can only be spawned by the top-level agent
      // that owns the opportunity's own report.
      const report = getOpportunityReport(opportunity.report_id);
      if (!report || report.agent_address !== agentAddress) {
        return res.status(403).json({
          error: "strategy_department_requires_owning_agent",
          detail:
            "A strategy department can only be spawned against an opportunity by the top-level agent that owns it.",
        });
      }
      if (opportunity.status === "rejected") {
        return res.status(409).json({
          error: "strategy_requires_non_rejected_opportunity",
          detail: `opportunity ${opportunityId} has been rejected — Strategy is only spawned once both Research and Finance have filed non-rejecting reports.`,
        });
      }
      if (!getCurrentResearchFinding(opportunityId)) {
        return res.status(409).json({
          error: "strategy_requires_completed_research_report",
          detail: `opportunity ${opportunityId} has no completed research finding yet — Strategy can only pick up an opportunity Research has already reported on.`,
        });
      }
      if (!getCurrentFinanceFinding(opportunityId)) {
        return res.status(409).json({
          error: "strategy_requires_completed_finance_report",
          detail: `opportunity ${opportunityId} has no completed finance finding yet — Strategy can only pick up an opportunity Finance has already reported on.`,
        });
      }
    }

    const quota = await ensureDepartmentQuota(agentAddress);
    if (!checkQuota({
      ownerAddress: agentAddress,
      resourceType: "department_quota",
      resourceId: agentAddress,
      current: activeDepartmentCountFor(agentAddress),
      adding: 1,
      limit: quota.max_departments,
    })) {
      return res.status(403).json({
        error: `department limit reached (${quota.max_departments} per agent) — see manifest.json quota.max_departments`,
      });
    }

    const dupe = db
      .prepare(
        `SELECT 1 FROM sub_agents WHERE owner_address = ? AND kind = 'department' AND name = ? AND status = 'running'`,
      )
      .get(agentAddress, name);
    if (dupe) {
      return res.status(409).json({ error: `department "${name}" already exists and is running` });
    }

    // next-phase.md Phase 2i(b) (architecture-agent.md §9): resolve this
    // department's tool grant from tool_registry via assign_tools(),
    // not departmentToolProfiles.ts's hardcoded map — the first real
    // call site to do so. Snapshotted onto the row at creation time
    // (see db.ts's Phase 2i(b) migration comment on why this is a
    // snapshot, not a live view). This does NOT yet change what
    // agent-runtime's tools.ts actually dispatches — that's still
    // departmentToolProfiles.ts's job until Phase 2i(c) migrates it.
    const resolvedGrants = assignTools("department_agent", { role });
    const grantedTools = resolvedGrants.map((g) => g.name);

    const id = newDepartmentId();
    // next-phase.md Phase 7a: `objective` gets its own column, next to
    // (not instead of) the existing `task` column — a department row's
    // `task` has never been meaningful on its own (task is a Worker-tier
    // concept, §4c), so it's left as-is here rather than repurposed;
    // `objective` is the real, newly-real value this phase adds.
    // Zent.md Phase 5a: `opportunity_id` rides along the same insert,
    // NULL for every role except research (resolvedOpportunityId is
    // only ever non-null after the research-specific guard above ran
    // and passed).
    db.prepare(
      `INSERT INTO sub_agents (id, owner_address, kind, name, role, task, objective, status, spend_cap_daily_usdc, granted_tools, opportunity_id, created_at)
       VALUES (?, ?, 'department', ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(
      id,
      agentAddress,
      name,
      role,
      `Heads the "${name}" department`,
      resolvedObjective,
      spendCap,
      JSON.stringify(grantedTools),
      resolvedOpportunityId,
      Date.now(),
    );

    // next-phase.md Phase 2i(d): per-grant lifecycle rows, additive
    // alongside the granted_tools snapshot above — a department itself
    // has no PTY session or project scope of its own (those belong to
    // its workers/temp-workers), so any session/project-lifecycle row
    // resolved here simply sits with a NULL scope_key until something
    // actually gives it one to key off of; only a department's
    // persistent/task-lifecycle rows are ever meaningfully revoked.
    recordToolGrants("sub_agent", id, resolvedGrants);

    // next-phase.md Phase 2g, second pass (architecture-agent.md §4g):
    // a department gets its own dedicated execution environment the
    // moment it exists, not lazily on its first worker/PTY call — a
    // Department Agent shouldn't have a window where it exists but has
    // nowhere real to run anything. If provisioning fails (environment-
    // sandbox quota exhausted, Docker error), the department row itself
    // is rolled back rather than left as a department with no
    // environment — see environment.ts's own module doc for why every
    // department is expected to have exactly one.
    let environmentSandboxId: string;
    try {
      environmentSandboxId = await resolveDepartmentEnvironment(id, agentAddress, resolvedWantsNetwork, role);
    } catch (envErr: any) {
      db.prepare(`DELETE FROM sub_agents WHERE id = ?`).run(id);
      throw envErr;
    }

    // next-phase.md Phase 9e-iii: a Marketing department learns the
    // shared marketplace's URL (and its own storefront path) the
    // moment it's created, without ever holding a Cloudflare/Mailcow
    // credential itself. Resolved via the same normalizeDepartmentType()
    // matching every other role-driven lookup in this codebase already
    // uses (toolRegistry.ts's own assignTools() call a few lines above
    // this route uses it too) — not a raw `role === "marketing"` string
    // compare, so "marketing-team"/"growth-marketing"-shaped role
    // strings resolve the same way they already do for tool grants.
    if (normalizeDepartmentType(role) === "marketing") {
      writeMarketplaceKnowledgeForMarketingDepartment(agentAddress, id);
    }

    res.json({
      id,
      name,
      role,
      objective: resolvedObjective,
      status: "running",
      maxWorkers: quota.max_workers_per_department,
      spendCapDailyUsdc: spendCap,
      environmentSandboxId,
      networkEnabled: resolvedWantsNetwork,
      grantedTools,
      // Zent.md Phase 5a: only ever non-null for a research department;
      // omitted (undefined -> not serialized) for every other role would
      // also be reasonable, but surfacing it explicitly as null makes
      // "this route always considers whether opportunityId applies" a
      // visible property of the response, not just of the code that
      // produced it.
      opportunityId: resolvedOpportunityId,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments?agentAddress=...
router.get("/", (req, res) => {
  const agentAddress = String(req.query.agentAddress || "");
  if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });

  const rows = db
    .prepare(
      `SELECT * FROM sub_agents WHERE owner_address = ? AND kind = 'department' ORDER BY created_at DESC LIMIT 100`,
    )
    .all(agentAddress) as DepartmentRow[];

  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role,
      objective: r.objective,
      status: r.status,
      workerCount: activeWorkerCountForDepartment(r.id),
      tempWorkerCount: activeTempWorkerCountForDepartment(r.id),
      spendCapDailyUsdc: r.spend_cap_daily_usdc,
      createdAt: r.created_at,
      endedAt: r.ended_at,
    })),
  );
});

// GET /departments/tree?agentAddress=...
// architecture-agent.md §7's get_department_tree(): every department
// this agent heads, with its current worker pool nested underneath.
// Read-only introspection — no capability check beyond the plain
// owner_address = agentAddress filter every query here already applies,
// since nothing this returns crosses into another agent's office.
router.get("/tree", (req, res) => {
  const agentAddress = String(req.query.agentAddress || "");
  if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });

  const departments = db
    .prepare(
      `SELECT * FROM sub_agents WHERE owner_address = ? AND kind = 'department' ORDER BY created_at ASC`,
    )
    .all(agentAddress) as DepartmentRow[];

  const tree = departments.map((d) => {
    // Phase 2b: split permanent (project_id IS NULL) from temp
    // (project_id IS NOT NULL) workers into two arrays, matching
    // architecture-agent.md §7's get_department_tree() shape —
    // { dept_id, head, workers: [...], temp_workers: [...] } — rather
    // than one merged list a caller would have to re-partition itself.
    const workers = db
      .prepare(
        `SELECT id, role, task, status, pty_session_id, browser_tab_id, created_at, ended_at
         FROM sub_agents
         WHERE owner_address = ? AND kind = 'worker' AND project_id IS NULL
         ORDER BY created_at ASC`,
      )
      .all(d.id) as any[];
    const tempWorkers = db
      .prepare(
        `SELECT id, role, task, status, project_id, ttl_at, pty_session_id, browser_tab_id, created_at, ended_at
         FROM sub_agents
         WHERE owner_address = ? AND kind = 'worker' AND project_id IS NOT NULL
         ORDER BY created_at ASC`,
      )
      .all(d.id) as any[];
    return {
      id: d.id,
      name: d.name,
      role: d.role,
      objective: d.objective,
      status: d.status,
      createdAt: d.created_at,
      endedAt: d.ended_at,
      workers: workers.map((w) => ({
        id: w.id,
        role: w.role,
        task: w.task,
        status: w.status,
        ptySessionId: w.pty_session_id,
        browserTabId: w.browser_tab_id,
        createdAt: w.created_at,
        endedAt: w.ended_at,
      })),
      tempWorkers: tempWorkers.map((w) => ({
        id: w.id,
        role: w.role,
        task: w.task,
        status: w.status,
        projectId: w.project_id,
        ttlAt: w.ttl_at,
        ptySessionId: w.pty_session_id,
        browserTabId: w.browser_tab_id,
        createdAt: w.created_at,
        endedAt: w.ended_at,
      })),
    };
  });

  res.json({ agentAddress, departments: tree });
});

// GET /departments/:id?agentAddress=...
router.get("/:id", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    res.json({
      id: dept.id,
      name: dept.name,
      role: dept.role,
      objective: dept.objective,
      status: dept.status,
      workerCount: activeWorkerCountForDepartment(dept.id),
      tempWorkerCount: activeTempWorkerCountForDepartment(dept.id),
      spendCapDailyUsdc: dept.spend_cap_daily_usdc,
      environmentSandboxId: getDepartmentEnvironmentId(dept.id, agentAddress, dept.role),
      networkEnabled: isDepartmentEnvironmentNetworkEnabled(dept.id),
      networkHardened: isHardenedNetworkDepartmentType(normalizeDepartmentType(dept.role)),
      grantedTools: dept.granted_tools ? JSON.parse(dept.granted_tools) : [],
      createdAt: dept.created_at,
      endedAt: dept.ended_at,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/workers?agentAddress=...
// Phase 2b: permanent workers only (project_id IS NULL) — see
// GET /:id/temp-workers for the burst-capacity pool, kept as a
// separate list rather than mixed in here so this stays what it's
// always meant ("this department's steady-state headcount") without a
// project's temp burst inflating it.
router.get("/:id/workers", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const rows = db
      .prepare(
        `SELECT id, role, task, status, pty_session_id, browser_tab_id, granted_tools, created_at, ended_at
         FROM sub_agents
         WHERE owner_address = ? AND kind = 'worker' AND project_id IS NULL
         ORDER BY created_at DESC LIMIT 200`,
      )
      .all(dept.id) as any[];
    res.json(
      rows.map((r) => ({
        id: r.id,
        role: r.role,
        task: r.task,
        status: r.status,
        ptySessionId: r.pty_session_id,
        browserTabId: r.browser_tab_id,
        grantedTools: r.granted_tools ? JSON.parse(r.granted_tools) : [],
        createdAt: r.created_at,
        endedAt: r.ended_at,
      })),
    );
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/temp-workers?agentAddress=&projectId=
// Phase 2b: the burst-capacity mirror of GET /:id/workers above.
// projectId is optional — omit it to see every currently-tracked temp
// worker across all projects under this department, or pass it to
// scope to one project (same rows retire_project would burn).
router.get("/:id/temp-workers", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const projectId = req.query.projectId ? String(req.query.projectId) : null;

    const rows = (
      projectId
        ? db
            .prepare(
              `SELECT id, role, task, status, project_id, ttl_at, pty_session_id, browser_tab_id, granted_tools, created_at, ended_at
               FROM sub_agents
               WHERE owner_address = ? AND kind = 'worker' AND project_id = ?
               ORDER BY created_at DESC LIMIT 500`,
            )
            .all(dept.id, projectId)
        : db
            .prepare(
              `SELECT id, role, task, status, project_id, ttl_at, pty_session_id, browser_tab_id, granted_tools, created_at, ended_at
               FROM sub_agents
               WHERE owner_address = ? AND kind = 'worker' AND project_id IS NOT NULL
               ORDER BY created_at DESC LIMIT 500`,
            )
            .all(dept.id)
    ) as any[];

    res.json(
      rows.map((r) => ({
        id: r.id,
        role: r.role,
        task: r.task,
        status: r.status,
        projectId: r.project_id,
        ttlAt: r.ttl_at,
        ptySessionId: r.pty_session_id,
        browserTabId: r.browser_tab_id,
        grantedTools: r.granted_tools ? JSON.parse(r.granted_tools) : [],
        createdAt: r.created_at,
        endedAt: r.ended_at,
      })),
    );
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/workers  { agentAddress, role, task }
// Spawns a Tier-3 worker under this department — an ordinary sub_agents
// row exactly like Phase 2's flat spawn_subagent, except owner_address
// is the department's id, not agentAddress directly. Bounded by
// manifest.quota.max_workers_per_department, counted PER department
// (not summed across an agent's departments — see architecture-agent.md
// §4a: "a slice of A's total... quota, not an independent budget each
// department can inflate on its own", enforced here as a flat per-
// department ceiling; the total-across-departments piece of that quota
// story is the orchestrator's job in Phase 5, not this route's).
//
// This worker is then managed through the SAME /subagents/:id/... routes
// (pty/result/kill/status) as any flat Phase 2 worker, still called with
// the TOP-LEVEL agentAddress — see subagents.ts's getOwnedWorker(),
// generalized this phase to resolve ownership transitively.
router.post("/:id/workers", async (req, res) => {
  try {
    const { agentAddress, role, task } = req.body;
    if (!agentAddress || !role || !task) {
      return res.status(400).json({ error: "agentAddress, role, and task are required" });
    }

    // Depth-cap hardening, same as subagents.ts's flat spawn route — a
    // department id or worker id must never itself be accepted as the
    // caller here.
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot spawn a worker` });
    }

    const quota = await ensureDepartmentQuota(agentAddress);
    if (!checkQuota({
      ownerAddress: agentAddress,
      resourceType: "department",
      resourceId: dept.id,
      current: activeWorkerCountForDepartment(dept.id),
      adding: 1,
      limit: quota.max_workers_per_department,
    })) {
      return res.status(403).json({
        error: `worker limit reached for department "${dept.name}" (${quota.max_workers_per_department} per department) — see manifest.json quota.max_workers_per_department`,
      });
    }

    // error-fix.md #1 fix: row-level permission_level still isn't
    // department_types-restricted at seed time for worker-tier rows
    // (true, unchanged — see toolRegistrySeedData.ts's §4f generation),
    // but assignTools() now applies a CAPABILITY-level narrowing on top
    // of that for the "External/specialty" rows (§4f) when given the
    // worker's own department type and its own job-title role — dept.role
    // is this department's own type (create_department's own `role`
    // param, e.g. "software"), and the local `role` here is the WORKER's
    // job title (e.g. "backend worker"), a different thing despite the
    // shared parameter name — see toolRegistry.ts's own doc comment on
    // assignTools() for exactly which 21 rows this can affect and which
    // it can't.
    const resolvedGrants = assignTools("worker", {
      departmentType: normalizeDepartmentType(dept.role),
      workerRole: role,
    });
    const grantedTools = resolvedGrants.map((g) => g.name);

    const id = "wkr_" + crypto.randomBytes(5).toString("hex");
    db.prepare(
      `INSERT INTO sub_agents (id, owner_address, kind, role, task, status, browser_tab_id, granted_tools, created_at)
       VALUES (?, ?, 'worker', ?, ?, 'running', ?, ?, ?)`,
    ).run(id, dept.id, role, task, id, JSON.stringify(grantedTools), Date.now());

    // next-phase.md Phase 2i(d): per-grant rows. This worker is a
    // permanent (non-project) department worker, so it has no project
    // scope to key a project-lifecycle grant off of — worker-tier rows
    // are never project-lifecycle by construction anyway (see
    // toolRegistrySeedData.ts's §4f generation), so omitting
    // projectScopeKey here is never actually load-bearing for this
    // route, only for spawn_temp_workers below.
    recordToolGrants("sub_agent", id, resolvedGrants);

    res.json({ id, departmentId: dept.id, role, task, status: "running", browserTabId: id, grantedTools });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/temp-workers  { agentAddress, count, role, task, projectId, ttlMs? }
// next-phase.md Phase 2b: department.spawn_temp_workers(count, role,
// project_id, ttl?) — bulk-instantiates `count` Tier-3 workers in one
// call, all tagged with the same projectId, bounded by
// manifest.quota.max_temp_workers_per_department (a SEPARATE ceiling
// from max_workers_per_department — see activeTempWorkerCountForDepartment
// above). If ttlMs is omitted, falls back to
// config.defaultTempWorkerTtlMs rather than leaving ttl_at NULL — see
// config.ts's note on why an unbounded temp worker would defeat the
// point of the TTL safety net.
router.post("/:id/temp-workers", async (req, res) => {
  try {
    const { agentAddress, count, role, task, projectId, ttlMs } = req.body;
    if (!agentAddress || !role || !task || !projectId) {
      return res.status(400).json({ error: "agentAddress, role, task, and projectId are required" });
    }
    if (!isValidProjectId(projectId)) {
      return res.status(400).json({
        error: "projectId must be 1-60 characters of letters, numbers, underscore, or hyphen",
      });
    }
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) {
      return res.status(400).json({ error: "count must be a positive integer" });
    }
    if (n > config.maxTempWorkersPerSpawnCall) {
      return res.status(400).json({
        error: `count exceeds the per-call limit of ${config.maxTempWorkersPerSpawnCall} — call spawn_temp_workers again for more`,
      });
    }
    if (ttlMs !== undefined && (!Number.isFinite(Number(ttlMs)) || Number(ttlMs) <= 0)) {
      return res.status(400).json({ error: "ttlMs, if provided, must be a positive number of milliseconds" });
    }

    // Depth-cap hardening, same as every other spawn point in this file.
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot spawn temp workers` });
    }

    const quota = await ensureDepartmentQuota(agentAddress);
    const current = activeTempWorkerCountForDepartment(dept.id);
    if (!checkQuota({
      ownerAddress: agentAddress,
      resourceType: "department",
      resourceId: dept.id,
      current,
      adding: n,
      limit: quota.max_temp_workers_per_department,
    })) {
      return res.status(403).json({
        error: `temp-worker limit reached for department "${dept.name}" (${quota.max_temp_workers_per_department} per department, ${current} already running, requested ${n} more) — see manifest.json quota.max_temp_workers_per_department`,
      });
    }

    // next-phase.md Phase 2g, second pass (architecture-agent.md §4g):
    // a project gets its own dedicated environment, separate from its
    // department's steady-state one — lazily provisioned here, on the
    // FIRST spawn_temp_workers call for a given projectId (idempotent —
    // a second burst for the same project reuses the existing one, see
    // getOrCreateScopedSandbox). Provisioned BEFORE any worker rows are
    // inserted so a quota/Docker failure here leaves no orphaned temp-
    // worker rows with nowhere to actually run.
    //
    // next-phase.md Phase 9f-i (Founder request): a project's temp
    // workers inherit whether their OWN department currently has
    // network enabled — never a hardened department's own hard "no",
    // since isDepartmentEnvironmentNetworkEnabled() can only ever be
    // true for a department create_department/POST .../network already
    // let through the same hardening check this route doesn't need to
    // duplicate.
    const wantsProjectNetwork = isDepartmentEnvironmentNetworkEnabled(dept.id);
    const environmentSandboxId = await resolveProjectEnvironment(
      dept.id,
      projectId,
      agentAddress,
      wantsProjectNetwork,
    );

    // error-fix.md #1 fix: same department-type + worker-role narrowing
    // as the permanent-worker spawn route above — a temp worker gets no
    // privilege bump or reduction for being temporary, so it must be
    // narrowed by the exact same two inputs, not just tier="worker"
    // bare. `role` here is again the worker's job title (e.g. "web
    // researcher"), never dept.role's department type.
    const resolvedGrants = assignTools("worker", {
      departmentType: normalizeDepartmentType(dept.role),
      workerRole: role,
    });
    const grantedTools = resolvedGrants.map((g) => g.name);

    const now = Date.now();
    const ttlAt = now + Number(ttlMs ?? config.defaultTempWorkerTtlMs);

    const insert = db.prepare(
      `INSERT INTO sub_agents (id, owner_address, kind, role, task, status, project_id, ttl_at, browser_tab_id, granted_tools, created_at)
       VALUES (?, ?, 'worker', ?, ?, 'running', ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    const spawnMany = db.transaction(() => {
      for (let i = 0; i < n; i++) {
        const id = "wkr_" + crypto.randomBytes(5).toString("hex");
        insert.run(id, dept.id, role, task, projectId, ttlAt, id, JSON.stringify(grantedTools), now);
        // next-phase.md Phase 2i(d): per-grant rows, tagged with THIS
        // project's scope key so retireProjectSequence()'s
        // revokeGrantsByProject() call (below, in this same file) tears
        // down every temp worker's project-lifecycle grants in this
        // burst together, regardless of which of the n workers in this
        // loop it was originally issued to — a task-lifecycle grant
        // still keys off this specific worker's own id (see
        // recordToolGrants()'s own doc), so a temp worker's task grants
        // and project grants tear down at their own distinct triggers
        // even though both were issued in the same INSERT above.
        recordToolGrants("sub_agent", id, resolvedGrants, {
          projectScopeKey: projectScopeKey(dept.id, projectId),
        });
        ids.push(id);
      }
    });
    spawnMany();

    res.json({ departmentId: dept.id, projectId, role, count: n, ids, ttlAt, environmentSandboxId, grantedTools });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * next-phase.md Phase 2h (architecture-agent.md §4b, revised): the full,
 * explicitly-ordered retire_project() sequence, shared verbatim by the
 * explicit POST /:id/retire-project route below and the TTL reaper
 * (sweepExpiredTempWorkers, above) — locking in the doc's own line that
 * "the orchestrator should reap... the same way it already reaps a
 * crashed agent" means *the same sequence*, not a lighter-weight one.
 * Before this phase, Phase 2b's version collapsed several of these steps
 * into one (kill-then-best-effort-archive, no budget return, no raw-vs-
 * evaluated split) — this is what actually locks the seven steps in
 * order:
 *
 *   1. Flip status closed FIRST, before touching any worker, so no new
 *      spawn_temp_workers call against this projectId can land
 *      mid-teardown. Flips department_projects.status too when a real
 *      create_project() row exists for this tag — a project spawned ad
 *      hoc (spawn_temp_workers called directly, no create_project())
 *      has no such row, which is fine: sub_agents.project_id was always
 *      the primary teardown key, department_projects is bookkeeping on
 *      top of it (see that table's own db.ts doc), so its absence here
 *      never blocks anything.
 *   2. Archive every tagged worker's RAW result/error into the new
 *      project_archive table — the "everything" record, written before
 *      any worker is killed, distinct from step 7's evaluated subset.
 *   3. Kill every still-running worker (existing Phase 2b behavior,
 *      unchanged) and log one project_burns row per burned worker.
 *   4/5. Close PTY sessions (browser-tab cleanup is still the owning
 *      runtime's job via the daemon, same caveat every prior phase's
 *      retirement routes already carry) and free the department's
 *      max_temp_workers_per_department slot — "free" is implicit, same
 *      as before 2h: status simply stops being 'running'. Phase 2i(d)
 *      folds one more thing into this same step: every still-active
 *      project-lifecycle tool_grants row tagged with this department+
 *      project pair is revoked here too (revokeGrantsByProject()) —
 *      closing a PTY session already revokes that session's own
 *      session-lifecycle grants via ptyService.ts's closeSession() hook
 *      below, so by the end of this step every grant this project could
 *      ever have held is accounted for: session-lifecycle died with its
 *      session just now, project-lifecycle dies with the explicit call
 *      right after, and any task-lifecycle grant these workers held is
 *      left alone (it dies via subagent_result if that ever fires for
 *      them, or simply stays orphaned-but-inert if the worker was killed
 *      mid-task instead — see that call site's own comment).
 *   6. Return unused project budget: only meaningful, and only
 *      attempted, when this project has a real department_projects row
 *      with a non-NULL budget_reserved_usdc (see db.ts's migration
 *      comment on department_projects — a project spawned ad hoc with
 *      no reservation has nothing to return, and this step is a
 *      documented no-op for it, not a fabricated credit). When a
 *      reservation exists, credits reserved - spent back to the
 *      department's own rolling-24h cap as a negative
 *      department_spend_log row (see wallet.ts's logDepartmentSpend —
 *      same table, same rolling-SUM path checkDepartmentBudget() already
 *      reads, so the credit is visible to the very next spend check with
 *      no second bookkeeping path to keep in sync). Never credits a
 *      negative remainder (a project that overspent its own reservation
 *      already drew against the department's general cap for the
 *      overage — nothing to give back).
 *   7. Writes a Department-Agent-EVALUATED subset of step 2's raw
 *      archive into department_knowledge as 'archived_project_output' —
 *      this is Phase 2d's original archival write, now explicitly a
 *      SUBSET written at teardown time (still automatic — no Department-
 *      Agent process exists yet to make the "which of these are worth
 *      keeping" judgment call for real, see departmentMemory.ts's own
 *      module doc on why — but no longer conflated with step 2's raw,
 *      unconditional record. Deliberately still skips a worker with
 *      neither result nor error the same way archiveWorkerOutput()
 *      always has: nothing useful for a department to evaluate).
 *
 * Every step from 2 onward is best-effort past the point the worker is
 * already correctly killed — same "a cleanup/archival failure must never
 * block a teardown that already happened" reasoning every prior phase's
 * retirement code already follows throughout this file. Idempotent,
 * unchanged from Phase 2b: calling this for a project that's already
 * fully retired (or was never spawned) just returns burned: [].
 */
async function retireProjectSequence(
  dept: DepartmentRow,
  projectId: string,
  reason: "retired" | "ttl_expired" | "department_retired",
): Promise<{ burned: string[] }> {
  const now = Date.now();

  // Step 1: flip status closed before touching any worker. `wasActive`
  // (not just `projectRow.status === "active"` re-checked later) is what
  // gates step 6's rebate below — see that step's own comment for why:
  // without it, a second call against an already-retired project (a
  // repeat POST /:id/retire-project, or two TTL-sweep passes racing on
  // the same projectId) would find the same non-NULL budgetReservedUsdc
  // / unchanged budgetSpentUsdc and credit the same remainder a second
  // time, since nothing else about that row changes once no workers are
  // left to burn.
  const projectRow = db
    .prepare(`SELECT id, budget_reserved_usdc, budget_spent_usdc, status FROM department_projects WHERE department_id = ? AND project_id = ?`)
    .get(dept.id, projectId) as
    | { id: number; budget_reserved_usdc: number | null; budget_spent_usdc: number; status: string }
    | undefined;
  const wasActive = projectRow?.status === "active";
  if (projectRow && wasActive) {
    db.prepare(`UPDATE department_projects SET status = 'retired', ended_at = ? WHERE id = ?`).run(
      now,
      projectRow.id,
    );
  }

  const workers = db
    .prepare(
      `SELECT id, role, result, error, pty_session_id, created_at FROM sub_agents
       WHERE owner_address = ? AND kind = 'worker' AND project_id = ? AND status = 'running'`,
    )
    .all(dept.id, projectId) as {
    id: string;
    role: string;
    result: string | null;
    error: string | null;
    pty_session_id: string | null;
    created_at: number;
  }[];

  const insertArchive = db.prepare(
    `INSERT INTO project_archive (project_id, worker_id, role, result, error, archived_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const killWorker = db.prepare(
    `UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ? AND status = 'running'`,
  );
  const logBurn = db.prepare(
    `INSERT INTO project_burns (department_id, project_id, worker_id, role, spawned_at, burned_at, duration_ms, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const burned: string[] = [];
  for (const w of workers) {
    // Step 2: raw archive, written BEFORE the kill below — this is the
    // "everything" record, unconditional on whether the worker produced
    // anything useful (same reasoning archiveWorkerOutput() itself
    // documents for why it doesn't filter for "useful" either).
    try {
      insertArchive.run(projectId, w.id, w.role, w.result ?? null, w.error ?? null, now);
    } catch {
      // best-effort, see function doc — a raw-archive failure must never
      // block the kill that follows.
    }

    // Step 3: kill + burn log (existing Phase 2b behavior).
    killWorker.run(now, w.id);
    logBurn.run(dept.id, projectId, w.id, w.role, w.created_at, now, now - w.created_at, now, reason);

    // Step 7: evaluated-subset write into department_knowledge — see
    // function doc for why this is still automatic (no Department-Agent
    // process exists yet to make this judgment call for real) but now
    // conceptually distinct from step 2's raw record above.
    try {
      archiveWorkerOutput({
        departmentId: dept.id,
        workerId: w.id,
        projectId,
        role: w.role,
        result: w.result,
        error: w.error,
      });
    } catch {
      // best-effort, see function doc.
    }

    // Steps 4/5: PTY close + implicit slot release (status flip above).
    if (w.pty_session_id) {
      await pty.closeSession(w.pty_session_id, w.id).catch(() => {});
    }
    burned.push(w.id);
  }
  // Browser-tab cleanup, same caveat as every other retirement route in
  // this file: driven by the owner's runtime calling the daemon's
  // /close per worker tabId, not this function.

  // Step 6: return unused project budget — only when a real reservation
  // exists, AND only on the call that actually performed the step-1
  // retirement (`wasActive`). A repeat call against a project that was
  // already retired before this call started (idempotent retry, or a
  // second TTL-sweep pass landing on the same projectId) has nothing
  // left to burn and must not re-credit a remainder it already returned.
  // See function doc for why an ad-hoc project (no create_project() row,
  // or a row with budget_reserved_usdc left NULL) gets no credit here
  // rather than a fabricated one.
  if (projectRow && wasActive && projectRow.budget_reserved_usdc != null) {
    const remainder = projectRow.budget_reserved_usdc - projectRow.budget_spent_usdc;
    if (remainder > 0) {
      try {
        db.prepare(
          `INSERT INTO department_spend_log (department_id, owner_address, to_address, amount_usdc, purpose, project_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(dept.id, dept.owner_address, dept.owner_address, -remainder, "project_budget_return", projectId, now);
      } catch {
        // best-effort, see function doc — a rebate-log failure must
        // never block a teardown that already happened.
      }
    }
  }

  // next-phase.md Phase 2i(d) (steps 4/5 of this function's own doc):
  // revoke every still-active project-lifecycle grant tagged with this
  // department+project pair, in the same place PTY sessions get closed
  // above — same "on the call that actually performed the retirement"
  // gating as step 6's budget-return below is unnecessary here (unlike
  // a $ credit, revoking an already-revoked grant a second time is an
  // inert no-op, not a double-charge), so this runs unconditionally on
  // every call including a repeat/idempotent one. Only affects
  // `project`-lifecycle rows — a task-lifecycle grant these same workers
  // hold is untouched here and instead dies via revokeGrantsByTask()
  // when/if subagent_result ever fires for them (it may not, for a
  // worker that's being force-retired mid-task rather than completing
  // normally — that grant simply stays revoked-by-neither-trigger,
  // which is correct: the worker itself is about to be killed above,
  // so nothing is left to hold it).
  revokeGrantsByProject(dept.id, projectId);

  // next-phase.md Phase 2g, second pass: tear down this project's own
  // environment now that every worker tagged with it is dead — but only
  // if none remain (a defensive re-check, not an assumption: a
  // concurrent spawn_temp_workers call for the same projectId could in
  // principle race between the SELECT above and here). Best-effort, same
  // reasoning as the archival writes above.
  const stillRunning = (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM sub_agents WHERE owner_address = ? AND kind = 'worker' AND project_id = ? AND status = 'running'`,
      )
      .get(dept.id, projectId) as { n: number }
  ).n;
  if (stillRunning === 0) {
    await teardownProjectEnvironment(dept.id, projectId);
  }

  return { burned };
}

// POST /departments/:id/retire-project  { agentAddress, projectId }
// next-phase.md Phase 2b, locked into the full 7-step sequence by Phase
// 2h (see retireProjectSequence() above for the step-by-step doc):
// terminates every (still-running) worker tagged with projectId under
// this department, archives raw output before the kill, credits back
// any unused reservation, and writes an evaluated subset into department
// memory. Idempotent: calling this again for a project that's already
// fully retired (or was never spawned) just returns burned: [].
//
// "deletes their sub-offices" per architecture-agent.md §4b's table:
// a temp worker never had a sub-office of its own to begin with — same
// as every worker since Phase 2, it borrows the department/agent's
// office wholesale — so there is nothing to delete here beyond the PTY
// session + DB row this route already tears down. Not an oversight;
// same reasoning departments.ts's own module doc already gives for why
// a department itself has no office directory on disk.
router.post("/:id/retire-project", async (req, res) => {
  try {
    const { agentAddress, projectId } = req.body;
    if (!agentAddress || !projectId) {
      return res.status(400).json({ error: "agentAddress and projectId are required" });
    }
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const { burned } = await retireProjectSequence(dept, projectId, "retired");

    res.json({ ok: true, projectId, burned, count: burned.length });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/projects/:projectId/burns?agentAddress=
// architecture-agent.md §4b's own worked example: "how many workers did
// the Falcon-9-launch project actually use, and for how long" — a
// direct read of the project_burns rows this department's
// retire_project()/TTL-reaper calls have logged for that project.
router.get("/:id/projects/:projectId/burns", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const rows = db
      .prepare(
        `SELECT worker_id, role, spawned_at, burned_at, duration_ms, reason
         FROM project_burns WHERE department_id = ? AND project_id = ? ORDER BY burned_at DESC LIMIT 500`,
      )
      .all(dept.id, req.params.projectId) as any[];

    res.json({
      departmentId: dept.id,
      projectId: req.params.projectId,
      burns: rows.map((r) => ({
        workerId: r.worker_id,
        role: r.role,
        spawnedAt: r.spawned_at,
        burnedAt: r.burned_at,
        durationMs: r.duration_ms,
        reason: r.reason,
      })),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/projects/:projectId/archive?agentAddress=
// next-phase.md Phase 2h: the read path over project_archive — step 2's
// raw "everything" record, distinct from GET .../burns above (duration/
// reason metadata only — "how many workers did this project use") and
// from GET .../knowledge?category=archived_project_output (the
// evaluated SUBSET written at step 7). This route answers "what did
// this project actually produce" — every tagged worker's raw result/
// error, written before that worker was killed, whether or not any of
// it made it into the department's own evaluated namespace.
router.get("/:id/projects/:projectId/archive", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    // Ownership check only — project_archive itself is keyed by
    // project_id alone (see db.ts: it has no department_id column,
    // since a project_id tag is only unique per-department and the
    // archive is written from within a single department's own
    // teardown path, same as project_burns' own department_id-scoped
    // query pattern elsewhere in this file). Resolving the department
    // first is what makes this route's ownership check real before any
    // row is returned.
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const rows = db
      .prepare(
        `SELECT worker_id, role, result, error, archived_at
         FROM project_archive WHERE project_id = ? ORDER BY archived_at DESC LIMIT 500`,
      )
      .all(req.params.projectId) as {
      worker_id: string;
      role: string;
      result: string | null;
      error: string | null;
      archived_at: number;
    }[];

    res.json({
      departmentId: dept.id,
      projectId: req.params.projectId,
      archive: rows.map((r) => ({
        workerId: r.worker_id,
        role: r.role,
        result: r.result,
        error: r.error,
        archivedAt: r.archived_at,
      })),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/knowledge?agentAddress=&category=&projectId=&limit=
// next-phase.md Phase 2d (architecture-agent.md §4c, Memory): read path
// over a department's own namespace. Deliberately generic (no per-
// category route, no category enum enforced at the DB level) — see
// departmentMemory.ts's doc comment on why the full §4e taxonomy lives
// there as a validated list, not a schema constraint.
//
// `content` parsing updated for Phase 2f-iv: until this phase, every row
// in this table came from archiveWorkerOutput()'s single hardcoded
// category, always JSON-stringified — so unconditional JSON.parse() was
// safe. recordDepartmentKnowledge() (Phase 2f-iv, the other six
// categories) stores caller-supplied free text as-is, not JSON — so this
// route now tries JSON.parse() and falls back to the raw string on
// failure, per-row, rather than branching on category name (keeps this
// route correct even if a future writer's content shape changes without
// this file needing to know about it).
router.get("/:id/knowledge", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const rows = queryDepartmentKnowledge(dept.id, {
      category: req.query.category ? String(req.query.category) : undefined,
      projectId: req.query.projectId ? String(req.query.projectId) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });

    res.json({
      departmentId: dept.id,
      entries: rows.map((r) => {
        let content: unknown;
        try {
          content = JSON.parse(r.content);
        } catch {
          content = r.content;
        }
        return {
          id: r.id,
          category: r.category,
          sourceWorkerId: r.source_worker_id,
          sourceProjectId: r.source_project_id,
          content,
          createdAt: r.created_at,
        };
      }),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/knowledge  { agentAddress, category, content, sourceWorkerId?, sourceProjectId? }
// next-phase.md Phase 2f-iv (architecture-agent.md §4e, Memory): the
// write path GET /:id/knowledge's own doc comment above says was still
// missing — a Department Agent recording its own decisions, strategy,
// lessons learned, technical knowledge, customer feedback, or a
// previous-project summary directly into its namespace, as opposed to
// the automatic 'archived_project_output' rows archiveWorkerOutput()
// writes on a worker's way out. `category` must be one of
// DEPARTMENT_KNOWLEDGE_CATEGORIES minus 'archived_project_output' — see
// recordDepartmentKnowledge()'s own validation, which this route
// surfaces as a 400 rather than duplicating the check here.
router.post("/:id/knowledge", (req, res) => {
  try {
    const { agentAddress, category, content, sourceWorkerId, sourceProjectId } = req.body as {
      agentAddress?: string;
      category?: string;
      content?: string;
      sourceWorkerId?: string;
      sourceProjectId?: string;
    };
    if (!agentAddress || !category || !content) {
      return res.status(400).json({ error: "agentAddress, category, and content are required" });
    }
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    // sourceWorkerId, if given, must resolve to a worker under THIS
    // department — same ownership shape assign_task/evaluate_worker
    // already enforce (Phase 2f-iii), so a knowledge entry can never be
    // attributed to another department's worker.
    if (sourceWorkerId) {
      const worker = db
        .prepare(`SELECT id FROM sub_agents WHERE id = ? AND kind = 'worker' AND owner_address = ?`)
        .get(sourceWorkerId, dept.id);
      if (!worker) {
        return res.status(404).json({ error: `worker not found in this department: ${sourceWorkerId}` });
      }
    }

    const entry = recordDepartmentKnowledge({
      departmentId: dept.id,
      category: category as DepartmentKnowledgeCategory,
      content,
      sourceWorkerId: sourceWorkerId ?? null,
      sourceProjectId: sourceProjectId ?? null,
    });

    res.json({
      departmentId: dept.id,
      entry: {
        id: entry.id,
        category: entry.category,
        sourceWorkerId: entry.source_worker_id,
        sourceProjectId: entry.source_project_id,
        content: entry.content,
        createdAt: entry.created_at,
      },
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/retire  { agentAddress }
// Not §4b's retire_project() (that's project-tagged temp workers,
// Phase 2b — not built here) — this is the department-level equivalent:
// kills the department head itself and every worker currently under it,
// same crash-isolation shape as subagents.ts's /:id/kill, just fanned
// out across the whole department in one call. A killed department's
// isSubagentOf() chain immediately stops granting its workers anything
// further (see capability.ts) even for any worker this loop doesn't
// finish killing before a crash — status flips first, cleanup is best-
// effort after.
router.post("/:id/retire", async (req, res) => {
  try {
    const { agentAddress } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const now = Date.now();
    // Phase 2b: pulls project_id/role/created_at too, purely so any
    // temp workers caught up in a full department retirement (as
    // opposed to a scoped retire-project call) still get a proper
    // project_burns row instead of just silently disappearing — see
    // reason='department_retired' below.
    const workers = db
      .prepare(
        `SELECT id, role, result, error, project_id, pty_session_id, created_at FROM sub_agents
         WHERE owner_address = ? AND kind = 'worker' AND status = 'running'`,
      )
      .all(dept.id) as {
      id: string;
      role: string;
      result: string | null;
      error: string | null;
      project_id: string | null;
      pty_session_id: string | null;
      created_at: number;
    }[];

    const killWorker = db.prepare(
      `UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ? AND status = 'running'`,
    );
    const logBurn = db.prepare(
      `INSERT INTO project_burns (department_id, project_id, worker_id, role, spawned_at, burned_at, duration_ms, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'department_retired', ?)`,
    );
    const insertArchive = db.prepare(
      `INSERT INTO project_archive (project_id, worker_id, role, result, error, archived_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const burnedProjectIds = new Set<string>();
    for (const w of workers) {
      if (w.project_id) {
        // next-phase.md Phase 2h: step 2's raw archive, written before
        // the kill below — same "everything" record a scoped
        // retire-project call now writes via retireProjectSequence(),
        // applied here too so a project caught up in a whole-department
        // retirement isn't missing the record a project retired on its
        // own would have.
        try {
          insertArchive.run(w.project_id, w.id, w.role, w.result ?? null, w.error ?? null, now);
        } catch {
          // best-effort, see project_archive's own reasoning above.
        }
      }
      killWorker.run(now, w.id);
      if (w.project_id) {
        logBurn.run(dept.id, w.project_id, w.id, w.role, w.created_at, now, now - w.created_at, now);
        burnedProjectIds.add(w.project_id);
        // Phase 2d/2h: step 7's evaluated-subset write into department_
        // knowledge — a temp worker caught up in a whole-department
        // retirement is just as gone as one retired by its own
        // project_id, and §4c doesn't carve out an exception for "the
        // department itself is also being killed."
        try {
          archiveWorkerOutput({
            departmentId: dept.id,
            workerId: w.id,
            projectId: w.project_id,
            role: w.role,
            result: w.result,
            error: w.error,
          });
        } catch {
          // best-effort, see departmentMemory.ts
        }
      }
      if (w.pty_session_id) {
        await pty.closeSession(w.pty_session_id, w.id).catch(() => {});
      }
    }
    // Browser tab cleanup, same as subagents.ts's /:id/kill, is left to
    // the owner's runtime calling the daemon's /close per worker tabId
    // — this route only guarantees the DB/session side is torn down and
    // isSubagentOf() stops granting anything further immediately.

    // next-phase.md Phase 2h: step 6's budget-return check, applied per
    // touched project here too — same non-negative-only, reservation-
    // gated credit retireProjectSequence() documents, just done inline
    // since this route's own loop already spans every project in one
    // pass rather than being scoped to one project_id at a time.
    for (const projectId of burnedProjectIds) {
      const projectRow = db
        .prepare(
          `SELECT id, budget_reserved_usdc, budget_spent_usdc, status FROM department_projects WHERE department_id = ? AND project_id = ?`,
        )
        .get(dept.id, projectId) as
        | { id: number; budget_reserved_usdc: number | null; budget_spent_usdc: number; status: string }
        | undefined;
      if (projectRow) {
        if (projectRow.status === "active") {
          db.prepare(`UPDATE department_projects SET status = 'retired', ended_at = ? WHERE id = ?`).run(
            now,
            projectRow.id,
          );
        }
        if (projectRow.budget_reserved_usdc != null) {
          const remainder = projectRow.budget_reserved_usdc - projectRow.budget_spent_usdc;
          if (remainder > 0) {
            try {
              db.prepare(
                `INSERT INTO department_spend_log (department_id, owner_address, to_address, amount_usdc, purpose, project_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              ).run(
                dept.id,
                dept.owner_address,
                dept.owner_address,
                -remainder,
                "project_budget_return",
                projectId,
                now,
              );
            } catch {
              // best-effort, see retireProjectSequence()'s own step 6.
            }
          }
        }
      }
    }

    if (dept.status === "running") {
      db.prepare(`UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ?`).run(now, dept.id);
    }

    // next-phase.md Phase 2g, second pass: every project this
    // retirement just burned workers for had ALL of its running workers
    // killed above (the WHERE clause above is unscoped to any single
    // project_id, unlike retire-project) — so every one of
    // burnedProjectIds is safe to tear down unconditionally, no
    // remaining-count re-check needed the way the TTL sweep's broader,
    // multi-department pass requires. Then the department's own
    // environment, now that nothing is running inside it.
    for (const projectId of burnedProjectIds) {
      await teardownProjectEnvironment(dept.id, projectId);
    }
    await teardownDepartmentEnvironment(dept.id, dept.owner_address, dept.role);

    res.json({ ok: true, status: "killed", workersKilled: workers.length });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;

// =============================================================================
// Phase 2e — Agent-tier authority: cross-department operations & self-improvement gating
// next-phase.md §"Phase 2e" / architecture-agent.md §4d
//
// Every route below is intentionally Agent-tier-only: each one touches
// more than one department at a time (rename/delete/budget-transfer/
// worker-move) or modifies a worker's identity (role-change/temp→permanent),
// operations §4d calls out as "company management" that must never be
// delegated to a Department Agent or a Worker. The enforcement mechanism
// is the same structural one every spawn route uses:
//   assertCanSpawnSubAgents(agentAddress) → throws 403 if agentAddress
//   is itself a sub_agents row (a dept or worker trying to act as Agent).
// =============================================================================

// PATCH /departments/:id/rename  { agentAddress, name }
// Agent-tier rename — updates the department's display name in sub_agents.
// Does not change the department's id (that's immutable once assigned).
// Rejects if the new name is already taken by another running department
// under the same owner, same uniqueness rule as POST /departments.
router.patch("/:id/rename", (req, res) => {
  try {
    const { agentAddress, name } = req.body;
    if (!agentAddress || !name) {
      return res.status(400).json({ error: "agentAddress and name are required" });
    }
    if (!/^[a-z0-9_-]{1,40}$/i.test(name)) {
      return res.status(400).json({
        error: "name must be 1-40 characters of letters, numbers, underscore, or hyphen",
      });
    }
    assertCanSpawnSubAgents(agentAddress);
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot rename` });
    }
    // Uniqueness check: another *running* department under this agent
    // with the new name already exists.
    const dupe = db
      .prepare(
        `SELECT 1 FROM sub_agents WHERE owner_address = ? AND kind = 'department' AND name = ? AND status = 'running' AND id != ?`,
      )
      .get(agentAddress, name, dept.id);
    if (dupe) {
      return res.status(409).json({ error: `department "${name}" already exists and is running` });
    }
    db.prepare(`UPDATE sub_agents SET name = ? WHERE id = ?`).run(name, dept.id);
    res.json({ ok: true, id: dept.id, name });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/network  { agentAddress, enabled }
// next-phase.md Phase 9f-i (Founder request): Agent-tier-only toggle —
// same assertCanSpawnSubAgents() gate every other cross-boundary
// management route in this file uses — for turning a department's own
// environment's sandbox network on or off after creation. Finance,
// Security, and Server are hardened: this route refuses `enabled: true`
// for those department types outright (403), regardless of who's
// asking, and their network stays off even if it was somehow turned on
// before (there's no path that could have done that, since
// create_department already refuses the same way — this is defense in
// depth, not a real reachable state).
router.post("/:id/network", async (req, res) => {
  try {
    const { agentAddress, enabled } = req.body;
    if (!agentAddress || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "agentAddress and a boolean enabled are required" });
    }
    assertCanSpawnSubAgents(agentAddress);
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot change network` });
    }

    const deptType = normalizeDepartmentType(dept.role);
    if (isHardenedNetworkDepartmentType(deptType)) {
      // Hardened departments' network is permanently off — enabling is
      // already 403'd below for the true case; a `false` call is a
      // meaningless no-op requesting a state that already holds
      // forever, not an error, but also not something to actually
      // execute: since hardened departments now share one sandbox per
      // agent (see environment.ts's departmentSandboxScopeId), routing
      // a `false` call through setDepartmentEnvironmentNetwork would
      // look up that department's OWN scope id, which no longer has
      // its own sandbox row, and 404 — a confusing error for a request
      // that was asking for something already true. Short-circuit
      // both directions here instead of leaking that internal detail
      // to the caller.
      if (enabled) {
        return res.status(403).json({
          error: `network access is permanently disabled for ${deptType} departments and cannot be enabled`,
        });
      }
      return res.json({ ok: true, id: dept.id, networkEnabled: false });
    }

    await setDepartmentEnvironmentNetwork(dept.id, enabled);
    res.json({ ok: true, id: dept.id, networkEnabled: enabled });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /departments/:id  { agentAddress }
// Agent-tier delete — tears down the department and every worker under
// it. Reuses the POST /:id/retire cascade (kill workers, close PTY
// sessions, log project_burns for any temp workers, archive their
// knowledge) rather than reimplementing it — the semantic difference
// from "retire" is intent and irrevocability (a retired department could
// be re-created with the same name; a deleted row has the same DB
// effect but the caller's intent is permanent closure), not mechanism.
// Implemented as a DELETE verb so tooling can distinguish intent at a
// glance, even though the cascade is identical to /retire.
router.delete("/:id", async (req, res) => {
  try {
    // DELETE bodies are non-standard in some HTTP stacks; accept from
    // query param too so tooling that strips DELETE bodies still works.
    const agentAddress = (req.body?.agentAddress || req.query.agentAddress) as string | undefined;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    assertCanSpawnSubAgents(agentAddress);
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is already ${dept.status}` });
    }

    const now = Date.now();
    const workers = db
      .prepare(
        `SELECT id, role, result, error, project_id, pty_session_id, created_at FROM sub_agents
         WHERE owner_address = ? AND kind = 'worker' AND status = 'running'`,
      )
      .all(dept.id) as {
      id: string;
      role: string;
      result: string | null;
      error: string | null;
      project_id: string | null;
      pty_session_id: string | null;
      created_at: number;
    }[];

    const killWorker = db.prepare(
      `UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ? AND status = 'running'`,
    );
    const logBurn = db.prepare(
      `INSERT INTO project_burns (department_id, project_id, worker_id, role, spawned_at, burned_at, duration_ms, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'department_deleted', ?)`,
    );
    const burnedProjectIds = new Set<string>();
    for (const w of workers) {
      killWorker.run(now, w.id);
      if (w.project_id) {
        logBurn.run(dept.id, w.project_id, w.id, w.role, w.created_at, now, now - w.created_at, now);
        burnedProjectIds.add(w.project_id);
        try {
          archiveWorkerOutput({
            departmentId: dept.id,
            workerId: w.id,
            projectId: w.project_id,
            role: w.role,
            result: w.result,
            error: w.error,
          });
        } catch {
          // best-effort, knowledge archive must not block teardown
        }
      }
      if (w.pty_session_id) {
        await pty.closeSession(w.pty_session_id, w.id).catch(() => {});
      }
    }
    db.prepare(`UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ?`).run(now, dept.id);

    // next-phase.md Phase 2g, second pass — same unconditional teardown
    // reasoning as POST /:id/retire above: every burnedProjectIds entry
    // just had ALL its running workers killed by the unscoped query
    // above, so no remaining-count re-check is needed here.
    for (const projectId of burnedProjectIds) {
      await teardownProjectEnvironment(dept.id, projectId);
    }
    await teardownDepartmentEnvironment(dept.id, dept.owner_address, dept.role);

    res.json({ ok: true, id: dept.id, status: "killed", workersKilled: workers.length });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Zent.md Phase 5a: "torn down when its finding is filed" — the
// service-layer half of that line (the other half, deciding WHEN a
// finding counts as filed, is expansion.ts's createFinding(), which
// calls this for kind === "research" after its insert commits — see
// that function's own Phase 5a comment for why the call is fire-and-
// forget rather than awaited inline).
//
// Deliberately its own small cascade rather than a call into the
// DELETE /:id route above: this has no `req`/`res`, no `agentAddress`
// to authorize against (a finding being filed is a system event, not
// an agent-initiated HTTP call), and no "already not running" error to
// surface to a caller — "no running research department for this
// opportunity" is a normal, silent no-op here (the finding might be
// getting filed a second time after a re-run, Phase 5e's own
// versioning, with the department already torn down from the first
// pass), not a 409. The kill-workers/close-PTY/burn-projects/teardown-
// environment steps themselves are the same shape as DELETE /:id's,
// because a research department is torn down the same way any other
// department is — only *who's asking* and *what counts as an error*
// differ.
export async function retireResearchDepartmentForOpportunity(
  opportunityId: string,
): Promise<{ retired: boolean; departmentId?: string }> {
  const dept = db
    .prepare(
      `SELECT * FROM sub_agents WHERE kind = 'department' AND status = 'running' AND opportunity_id = ?`,
    )
    .get(opportunityId) as DepartmentRow | undefined;
  if (!dept) {
    return { retired: false };
  }

  const now = Date.now();
  const workers = db
    .prepare(
      `SELECT id, role, result, error, project_id, pty_session_id, created_at FROM sub_agents
       WHERE owner_address = ? AND kind = 'worker' AND status = 'running'`,
    )
    .all(dept.id) as {
    id: string;
    role: string;
    result: string | null;
    error: string | null;
    project_id: string | null;
    pty_session_id: string | null;
    created_at: number;
  }[];

  const killWorker = db.prepare(
    `UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ? AND status = 'running'`,
  );
  const logBurn = db.prepare(
    `INSERT INTO project_burns (department_id, project_id, worker_id, role, spawned_at, burned_at, duration_ms, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'research_finding_filed', ?)`,
  );
  const burnedProjectIds = new Set<string>();
  for (const w of workers) {
    killWorker.run(now, w.id);
    if (w.project_id) {
      logBurn.run(dept.id, w.project_id, w.id, w.role, w.created_at, now, now - w.created_at, now);
      burnedProjectIds.add(w.project_id);
      try {
        archiveWorkerOutput({
          departmentId: dept.id,
          workerId: w.id,
          projectId: w.project_id,
          role: w.role,
          result: w.result,
          error: w.error,
        });
      } catch {
        // best-effort, knowledge archive must not block teardown — same
        // posture DELETE /:id and POST /:id/retire already take.
      }
    }
    if (w.pty_session_id) {
      await pty.closeSession(w.pty_session_id, w.id).catch(() => {});
    }
  }
  db.prepare(`UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ?`).run(now, dept.id);

  for (const projectId of burnedProjectIds) {
    await teardownProjectEnvironment(dept.id, projectId);
  }
  await teardownDepartmentEnvironment(dept.id, dept.owner_address, dept.role);

  return { retired: true, departmentId: dept.id };
}

// POST /departments/transfer-budget  { agentAddress, fromDeptId, toDeptId, amount }
// Agent-tier budget reallocation: moves `amount` USDC of daily spend cap
// from one department to another. Both departments must belong to the
// same owning agent. Neither department needs to be running (you might
// want to reallocate budget *from* a winding-down department to a
// growing one before the formal retire call). Amount must be positive
// and not exceed the source department's current cap (you cannot go
// negative; the sink may exceed its original cap — adding budget is
// always safe).
//
// This is a dedicated resource type in capability.ts
// ("department_budget") owned by the top-level agent, so it can never
// be satisfied by a Department Agent's isSubagentOf() delegation — see
// capability.ts's ownerOf() for the new case.
//
// Note: this adjusts spend_cap_daily_usdc, NOT actual wallet balances —
// wallet.pay enforcement (Phase 2f) will enforce the cap at spend time.
// Until that enforcement lands, transfer-budget is bookkeeping for when
// it does.
router.post("/transfer-budget", (req, res) => {
  try {
    const { agentAddress, fromDeptId, toDeptId, amount } = req.body;
    if (!agentAddress || !fromDeptId || !toDeptId || amount === undefined) {
      return res.status(400).json({ error: "agentAddress, fromDeptId, toDeptId, and amount are required" });
    }
    if (fromDeptId === toDeptId) {
      return res.status(400).json({ error: "fromDeptId and toDeptId must be different" });
    }
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({ error: "amount must be a positive finite number" });
    }
    assertCanSpawnSubAgents(agentAddress);

    const from = getOwnedDepartment(fromDeptId, agentAddress);
    const to = getOwnedDepartment(toDeptId, agentAddress);

    if (from.spend_cap_daily_usdc < n) {
      return res.status(400).json({
        error: `fromDept "${from.name}" only has ${from.spend_cap_daily_usdc} USDC of daily cap remaining — cannot transfer ${n}`,
      });
    }

    db.transaction(() => {
      db.prepare(`UPDATE sub_agents SET spend_cap_daily_usdc = spend_cap_daily_usdc - ? WHERE id = ?`).run(
        n,
        from.id,
      );
      db.prepare(`UPDATE sub_agents SET spend_cap_daily_usdc = spend_cap_daily_usdc + ? WHERE id = ?`).run(
        n,
        to.id,
      );
    })();

    const updatedFrom = db.prepare(`SELECT spend_cap_daily_usdc FROM sub_agents WHERE id = ?`).get(from.id) as {
      spend_cap_daily_usdc: number;
    };
    const updatedTo = db.prepare(`SELECT spend_cap_daily_usdc FROM sub_agents WHERE id = ?`).get(to.id) as {
      spend_cap_daily_usdc: number;
    };

    res.json({
      ok: true,
      transferred: n,
      from: { id: from.id, name: from.name, newSpendCapDailyUsdc: updatedFrom.spend_cap_daily_usdc },
      to: { id: to.id, name: to.name, newSpendCapDailyUsdc: updatedTo.spend_cap_daily_usdc },
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/move-worker  { agentAddress, workerId, fromDeptId, toDeptId }
// Agent-tier cross-department worker relocation. Preserves the worker's
// id, role, task, pty_session_id, and result so its history stays intact
// — a worker moving from Marketing to Frontend shouldn't lose its
// execution history just because it changed department (see §4d).
//
// Preconditions:
//   - both departments must be running (you can't move into a dead dept)
//   - the worker must currently be under fromDeptId
//   - the destination must have room under max_workers_per_department
//     (a temp worker with project_id counts against toDept's temp ceiling;
//     a permanent worker counts against toDept's permanent ceiling)
//
// PTY sessions and browser tabs continue to run uninterrupted — moving
// a worker between departments is a bookkeeping change, not a process
// boundary. The owner's runtime keeps driving the same session via the
// same sessionId/tabId after the move.
router.post("/move-worker", async (req, res) => {
  try {
    const { agentAddress, workerId, fromDeptId, toDeptId } = req.body;
    if (!agentAddress || !workerId || !fromDeptId || !toDeptId) {
      return res.status(400).json({ error: "agentAddress, workerId, fromDeptId, and toDeptId are required" });
    }
    if (fromDeptId === toDeptId) {
      return res.status(400).json({ error: "fromDeptId and toDeptId must be different" });
    }
    assertCanSpawnSubAgents(agentAddress);

    const fromDept = getOwnedDepartment(fromDeptId, agentAddress);
    const toDept = getOwnedDepartment(toDeptId, agentAddress);
    if (fromDept.status !== "running") {
      return res.status(409).json({ error: `source department "${fromDept.name}" is ${fromDept.status}` });
    }
    if (toDept.status !== "running") {
      return res.status(409).json({ error: `destination department "${toDept.name}" is ${toDept.status}` });
    }

    // Worker must be a running kind='worker' under fromDeptId
    const worker = db
      .prepare(
        `SELECT id, role, task, status, project_id FROM sub_agents
         WHERE id = ? AND kind = 'worker' AND owner_address = ?`,
      )
      .get(workerId, fromDeptId) as {
      id: string;
      role: string;
      task: string;
      status: string;
      project_id: string | null;
    } | undefined;
    if (!worker) {
      return res.status(404).json({ error: `worker ${workerId} not found under department ${fromDeptId}` });
    }
    if (worker.status !== "running") {
      return res.status(409).json({ error: `worker ${workerId} is ${worker.status}, only running workers can be moved` });
    }

    // Quota check on destination. A temp worker (project_id IS NOT NULL)
    // counts against toDept's temp ceiling; a permanent one against the
    // permanent ceiling.
    const quota = await import("./office.js").then((m) => m.ensureDepartmentQuota(agentAddress));
    if (worker.project_id) {
      const tempCount = activeTempWorkerCountForDepartment(toDept.id);
      if (!checkQuota({
        ownerAddress: agentAddress,
        resourceType: "department",
        resourceId: toDept.id,
        current: tempCount,
        adding: 1,
        limit: quota.max_temp_workers_per_department,
      })) {
        return res.status(403).json({
          error: `destination "${toDept.name}" has reached its temp-worker limit (${quota.max_temp_workers_per_department})`,
        });
      }
    } else {
      const permCount = activeWorkerCountForDepartment(toDept.id);
      if (!checkQuota({
        ownerAddress: agentAddress,
        resourceType: "department",
        resourceId: toDept.id,
        current: permCount,
        adding: 1,
        limit: quota.max_workers_per_department,
      })) {
        return res.status(403).json({
          error: `destination "${toDept.name}" has reached its permanent-worker limit (${quota.max_workers_per_department})`,
        });
      }
    }

    // Atomic reassignment — preserves the worker's id and all other fields.
    db.prepare(`UPDATE sub_agents SET owner_address = ? WHERE id = ?`).run(toDept.id, workerId);

    res.json({
      ok: true,
      workerId,
      from: { id: fromDept.id, name: fromDept.name },
      to: { id: toDept.id, name: toDept.name },
      role: worker.role,
      projectId: worker.project_id,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/workers/:workerId/role  { agentAddress, role }
// Agent-tier role update (promote/demote) — changes the worker's role
// string without touching its id, status, task, result, or PTY session.
// The "promote" vs "demote" distinction is caller intent only; the
// backend just records whatever role string is passed. Must be running
// (changing a dead worker's role is a no-op with no meaningful effect).
router.post("/:id/workers/:workerId/role", (req, res) => {
  try {
    const { agentAddress, role } = req.body;
    if (!agentAddress || !role) {
      return res.status(400).json({ error: "agentAddress and role are required" });
    }
    if (typeof role !== "string" || role.trim().length === 0 || role.length > 200) {
      return res.status(400).json({ error: "role must be a non-empty string of at most 200 characters" });
    }
    assertCanSpawnSubAgents(agentAddress);
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot change a worker's role` });
    }

    const worker = db
      .prepare(`SELECT id, role, status FROM sub_agents WHERE id = ? AND kind = 'worker' AND owner_address = ?`)
      .get(req.params.workerId, dept.id) as { id: string; role: string; status: string } | undefined;
    if (!worker) {
      return res.status(404).json({ error: `worker ${req.params.workerId} not found in department ${dept.id}` });
    }
    if (worker.status !== "running") {
      return res.status(409).json({ error: `worker is ${worker.status}, can only change role of a running worker` });
    }

    const oldRole = worker.role;
    db.prepare(`UPDATE sub_agents SET role = ? WHERE id = ?`).run(role, worker.id);
    res.json({ ok: true, workerId: worker.id, oldRole, newRole: role });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/workers/:workerId/convert-to-permanent  { agentAddress }
// Agent-tier temp-to-permanent conversion: clears project_id and ttl_at
// on an existing temp worker row, folding it into the department's
// permanent max_workers_per_department budget instead of the temp one.
//
// Preconditions (all enforced):
//   - worker must be a running temp worker (project_id IS NOT NULL)
//   - destination permanent-worker quota must have room — a full
//     department cannot "launder" past its permanent cap by spawning as
//     temp and converting (§4d explicitly calls this out)
//   - the owning department must be running
//
// After conversion, the worker's TTL safety net is lifted (no ttl_at
// means sweepExpiredTempWorkers() never touches it), its role/task/id/
// result/pty_session_id all stay intact, and it continues to be managed
// through the same /subagents/:id/... routes as before.
router.post("/:id/workers/:workerId/convert-to-permanent", async (req, res) => {
  try {
    const { agentAddress } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress is required" });
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}` });
    }

    const worker = db
      .prepare(
        `SELECT id, role, status, project_id FROM sub_agents WHERE id = ? AND kind = 'worker' AND owner_address = ?`,
      )
      .get(req.params.workerId, dept.id) as {
      id: string;
      role: string;
      status: string;
      project_id: string | null;
    } | undefined;

    if (!worker) {
      return res.status(404).json({ error: `worker ${req.params.workerId} not found in department ${dept.id}` });
    }
    if (!worker.project_id) {
      return res.status(409).json({ error: `worker ${worker.id} is already a permanent worker (no project_id)` });
    }
    if (worker.status !== "running") {
      return res.status(409).json({ error: `worker ${worker.id} is ${worker.status}, can only convert a running worker` });
    }

    // Quota check — the permanent-worker ceiling must have room.
    // Phase 2b already narrowed activeWorkerCountForDepartment to
    // project_id IS NULL, so this count won't include the worker being
    // converted (it currently IS a temp worker, project_id IS NOT NULL).
    const quota = await import("./office.js").then((m) => m.ensureDepartmentQuota(agentAddress));
    const permCount = activeWorkerCountForDepartment(dept.id);
    if (!checkQuota({
      ownerAddress: agentAddress,
      resourceType: "department",
      resourceId: dept.id,
      current: permCount,
      adding: 1,
      limit: quota.max_workers_per_department,
    })) {
      return res.status(403).json({
        error: `department "${dept.name}" is at its permanent-worker limit (${quota.max_workers_per_department}) — cannot convert a temp worker into a permanent one`,
      });
    }

    const oldProjectId = worker.project_id;
    db.prepare(`UPDATE sub_agents SET project_id = NULL, ttl_at = NULL WHERE id = ?`).run(worker.id);

    res.json({
      ok: true,
      workerId: worker.id,
      role: worker.role,
      convertedFromProjectId: oldProjectId,
      permanentWorkerCount: permCount + 1,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// =============================================================================
// Phase 2f-iii — Department-scoped management operations
// next-phase.md §"Phase 2f-iii" / architecture-agent.md §4e ("Department
// management": manage department objective, manage department budget,
// create projects, break projects into tasks, assign tasks, create
// workers, clone workers, retire workers, assign worker roles, allocate
// worker budgets, allocate compute, set worker permissions, evaluate
// workers, keep good workers, terminate temporary workers.)
//
// create_department/spawn_worker/spawn_temp_workers/retire_project
// (Phase 2a/2b) already cover the "create/retire" half of that list.
// This phase covers the remaining "manage the work and the people doing
// it" half: create_project, break_into_tasks, assign_task,
// evaluate_worker, retain_worker, terminate_temp_worker.
//
// Same calling convention as every route above (module doc comment,
// top of file): still driven by the TOP-LEVEL agent's own agentAddress,
// never "as the department." A Department Agent has no runtime process
// of its own (§4: sub-agents are threads), so §4e's
// "department-scoped management" reads concretely as: every operation
// below is scoped to ONE department's own subtree (its own projects,
// its own tasks, its own workers) and REJECTS a cross-department
// target, exactly the isolation next-phase.md's own "Done when" line
// asks for — it is not a claim that the department itself is the
// authenticated caller, which nothing in this codebase supports yet
// (see architecture-agent.md §6/next-phase.md Phase 5's own
// Orchestrator section for where a Department Agent might eventually
// get a process/identity of its own to call in "as itself").
//
// "Never cross-department, per Phase 2e's split": Phase 2e's routes
// (rename/delete/transfer-budget/move-worker) are the ones explicitly
// allowed to touch two departments in one call, because moving/renaming
// crosses a boundary by definition and §4d calls that out as Agent-tier
// company management. Every route below takes exactly one departmentId
// and one project/task/worker id living under it — there is no
// "target" parameter that could ever resolve to a second department,
// so "rejects a cross-department target" is enforced structurally (a
// project/task/worker lookup is always scoped `WHERE department_id = ?`
// against the ONE department getOwnedDepartment() already resolved),
// not by a separate runtime check bolted on afterward.
// =============================================================================

interface DepartmentProjectRow {
  id: number;
  department_id: string;
  project_id: string;
  name: string;
  description: string | null;
  status: "active" | "completed" | "retired";
  budget_reserved_usdc: number | null;
  budget_spent_usdc: number;
  created_at: number;
  ended_at: number | null;
}

interface DepartmentTaskRow {
  id: number;
  department_id: string;
  project_row_id: number;
  project_id: string;
  description: string;
  status: "unassigned" | "assigned" | "completed" | "blocked";
  assigned_worker_id: string | null;
  created_at: number;
  assigned_at: number | null;
  updated_at: number;
}

/**
 * Resolves a department_projects row scoped to ONE department — the
 * same "structurally can't name a second department" shape
 * getOwnedDepartment/getOwnedWorker already use. Looking up by the
 * project's own department_projects.id (not the free-text project_id
 * tag) so break_into_tasks/assign_task operate on an unambiguous row
 * even if a caller ever reused a project_id string across two of their
 * own departments (allowed — project_id is only unique PER department,
 * see db.ts's idx_department_projects_unique).
 */
function getOwnedProject(departmentId: string, projectRowId: number): DepartmentProjectRow {
  const row = db
    .prepare(`SELECT * FROM department_projects WHERE id = ? AND department_id = ?`)
    .get(projectRowId, departmentId) as DepartmentProjectRow | undefined;
  if (!row) {
    throw Object.assign(
      new Error(`project ${projectRowId} not found under department ${departmentId}`),
      { status: 404 },
    );
  }
  return row;
}

// POST /departments/:id/projects  { agentAddress, projectId, name, description? }
// next-phase.md Phase 2f-iii: create_project(). Gives a project a real
// row of its own — a name/description/status distinct from the bare
// project_id string tag Phase 2b's spawn_temp_workers/retire_project
// already operate on directly. Does NOT spawn any workers itself (same
// separation Phase 2a/2b already draw between "create the org-chart
// entity" and "staff it" — see create_department vs spawn_worker) —
// call spawn_temp_workers with the same projectId to actually staff it,
// exactly as before; this route is purely bookkeeping for the
// objective/description a project didn't previously have anywhere to
// live. projectId must be unique among this ONE department's projects
// (not globally) — the same free-text tag can be reused across two
// different departments' own project histories without colliding.
router.post("/:id/projects", (req, res) => {
  try {
    const { agentAddress, projectId, name, description, budgetReservedUsdc } = req.body;
    if (!agentAddress || !projectId || !name) {
      return res.status(400).json({ error: "agentAddress, projectId, and name are required" });
    }
    if (!isValidProjectId(projectId)) {
      return res.status(400).json({
        error: "projectId must be 1-60 characters of letters, numbers, underscore, or hyphen",
      });
    }
    if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
      return res.status(400).json({ error: "name must be a non-empty string of at most 200 characters" });
    }
    if (description !== undefined && (typeof description !== "string" || description.length > 2000)) {
      return res.status(400).json({ error: "description, if provided, must be a string of at most 2000 characters" });
    }
    // next-phase.md Phase 2h: an OPTIONAL up-front budget reservation for
    // this project, in USDC — what retire_project()'s step 6 credits the
    // unspent remainder of back to the department's own daily cap. Left
    // unset (NULL), same as before this phase: this project's spend still
    // counts against the department's rolling-24h cap exactly as it
    // always has, there's just nothing for step 6 to return, since
    // nothing was ever set aside for it in the first place — see db.ts's
    // migration comment for why this is a documented no-op rather than
    // a fabricated number.
    if (
      budgetReservedUsdc !== undefined &&
      (typeof budgetReservedUsdc !== "number" || !Number.isFinite(budgetReservedUsdc) || budgetReservedUsdc < 0)
    ) {
      return res.status(400).json({ error: "budgetReservedUsdc, if provided, must be a non-negative number" });
    }
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot create a project` });
    }

    const dupe = db
      .prepare(`SELECT 1 FROM department_projects WHERE department_id = ? AND project_id = ?`)
      .get(dept.id, projectId);
    if (dupe) {
      return res.status(409).json({ error: `project "${projectId}" already exists under department "${dept.name}"` });
    }

    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO department_projects (department_id, project_id, name, description, status, budget_reserved_usdc, budget_spent_usdc, created_at)
         VALUES (?, ?, ?, ?, 'active', ?, 0, ?)`,
      )
      .run(dept.id, projectId, name, description ?? null, budgetReservedUsdc ?? null, now);

    res.json({
      id: info.lastInsertRowid as number,
      departmentId: dept.id,
      projectId,
      name,
      description: description ?? null,
      status: "active",
      budgetReservedUsdc: budgetReservedUsdc ?? null,
      budgetSpentUsdc: 0,
      createdAt: now,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/projects?agentAddress=&status=
// Introspection: every project row under this ONE department, optional
// status filter. Read-only, same ownership scoping as every other GET.
router.get("/:id/projects", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const status = req.query.status ? String(req.query.status) : null;
    const rows = (
      status
        ? db
            .prepare(
              `SELECT * FROM department_projects WHERE department_id = ? AND status = ? ORDER BY created_at DESC LIMIT 200`,
            )
            .all(dept.id, status)
        : db
            .prepare(`SELECT * FROM department_projects WHERE department_id = ? ORDER BY created_at DESC LIMIT 200`)
            .all(dept.id)
    ) as DepartmentProjectRow[];

    res.json(
      rows.map((r) => ({
        id: r.id,
        projectId: r.project_id,
        name: r.name,
        description: r.description,
        status: r.status,
        budgetReservedUsdc: r.budget_reserved_usdc,
        budgetSpentUsdc: r.budget_spent_usdc,
        createdAt: r.created_at,
        endedAt: r.ended_at,
      })),
    );
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/projects/:projectRowId/tasks  { agentAddress, tasks: string[] }
// next-phase.md Phase 2f-iii: break_into_tasks(). Decomposes a project
// into one or more task rows, each starting 'unassigned'. Takes an
// array so a single planning call can lay out a whole task list at
// once, rather than one HTTP round-trip per task — assign_task below
// is the separate, later step that actually staffs each one.
router.post("/:id/projects/:projectRowId/tasks", (req, res) => {
  try {
    const { agentAddress, tasks } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress is required" });
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: "tasks must be a non-empty array of task description strings" });
    }
    if (tasks.length > 100) {
      return res.status(400).json({ error: "cannot create more than 100 tasks in one call" });
    }
    for (const t of tasks) {
      if (typeof t !== "string" || t.trim().length === 0 || t.length > 2000) {
        return res.status(400).json({
          error: "every task must be a non-empty string of at most 2000 characters",
        });
      }
    }
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot break a project into tasks` });
    }

    const projectRowId = Number(req.params.projectRowId);
    if (!Number.isInteger(projectRowId)) {
      return res.status(400).json({ error: "projectRowId must be an integer" });
    }
    const project = getOwnedProject(dept.id, projectRowId);
    if (project.status !== "active") {
      return res.status(409).json({ error: `project "${project.name}" is ${project.status}, cannot add tasks` });
    }

    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO department_tasks (department_id, project_row_id, project_id, description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'unassigned', ?, ?)`,
    );
    const ids: number[] = [];
    const insertMany = db.transaction(() => {
      for (const description of tasks) {
        const info = insert.run(dept.id, project.id, project.project_id, description, now, now);
        ids.push(info.lastInsertRowid as number);
      }
    });
    insertMany();

    res.json({
      departmentId: dept.id,
      projectRowId: project.id,
      projectId: project.project_id,
      count: ids.length,
      taskIds: ids,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/projects/:projectRowId/tasks?agentAddress=&status=
// Introspection over a project's own task list, optional status filter.
router.get("/:id/projects/:projectRowId/tasks", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const projectRowId = Number(req.params.projectRowId);
    if (!Number.isInteger(projectRowId)) {
      return res.status(400).json({ error: "projectRowId must be an integer" });
    }
    const project = getOwnedProject(dept.id, projectRowId);

    const status = req.query.status ? String(req.query.status) : null;
    const rows = (
      status
        ? db
            .prepare(
              `SELECT * FROM department_tasks WHERE project_row_id = ? AND status = ? ORDER BY created_at ASC LIMIT 500`,
            )
            .all(project.id, status)
        : db
            .prepare(`SELECT * FROM department_tasks WHERE project_row_id = ? ORDER BY created_at ASC LIMIT 500`)
            .all(project.id)
    ) as DepartmentTaskRow[];

    res.json(
      rows.map((r) => ({
        id: r.id,
        description: r.description,
        status: r.status,
        assignedWorkerId: r.assigned_worker_id,
        createdAt: r.created_at,
        assignedAt: r.assigned_at,
        updatedAt: r.updated_at,
      })),
    );
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/tasks/:taskId/assign  { agentAddress, workerId }
// next-phase.md Phase 2f-iii: assign_task(). Assigns one task to one
// worker — both MUST live under this same department (the worker
// lookup below is scoped WHERE owner_address = dept.id, exactly the
// "structurally can't name a second department" shape every other
// route in this file already uses), otherwise this 404s rather than
// silently cross-wiring a task to a worker in a different department.
// Re-assigning an already-assigned task is allowed (moves it to a new
// worker, e.g. after the first assignee was terminated) — not a strict
// one-shot operation.
router.post("/:id/tasks/:taskId/assign", (req, res) => {
  try {
    const { agentAddress, workerId } = req.body;
    if (!agentAddress || !workerId) {
      return res.status(400).json({ error: "agentAddress and workerId are required" });
    }
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);
    if (dept.status !== "running") {
      return res.status(409).json({ error: `department is ${dept.status}, cannot assign a task` });
    }

    const taskId = Number(req.params.taskId);
    if (!Number.isInteger(taskId)) {
      return res.status(400).json({ error: "taskId must be an integer" });
    }
    const task = db
      .prepare(`SELECT * FROM department_tasks WHERE id = ? AND department_id = ?`)
      .get(taskId, dept.id) as DepartmentTaskRow | undefined;
    if (!task) {
      return res.status(404).json({ error: `task ${taskId} not found under department ${dept.id}` });
    }
    if (task.status === "completed") {
      return res.status(409).json({ error: `task ${taskId} is already completed, cannot reassign` });
    }

    // Worker must be a running kind='worker' row owned by THIS
    // department — same scoping getOwnedWorker() in subagents.ts uses,
    // duplicated here (rather than imported) because that function
    // additionally resolves the isSubagentOf() chain for the flat/Phase-2
    // pool, which is not the check this route needs: a task can only
    // ever be assigned to a worker directly under the ONE department
    // getOwnedDepartment() already resolved, permanent or temp either
    // way (project_id NULL or not — a task isn't restricted to only
    // this project's own burst workers, a steady-state worker can pick
    // up a task too).
    const worker = db
      .prepare(`SELECT id, role, status FROM sub_agents WHERE id = ? AND kind = 'worker' AND owner_address = ?`)
      .get(workerId, dept.id) as { id: string; role: string; status: string } | undefined;
    if (!worker) {
      return res.status(404).json({ error: `worker ${workerId} not found under department ${dept.id}` });
    }
    if (worker.status !== "running") {
      return res.status(409).json({ error: `worker ${workerId} is ${worker.status}, cannot assign a task to it` });
    }

    const now = Date.now();
    db.prepare(
      `UPDATE department_tasks SET status = 'assigned', assigned_worker_id = ?, assigned_at = ?, updated_at = ? WHERE id = ?`,
    ).run(worker.id, now, now, task.id);

    res.json({
      ok: true,
      taskId: task.id,
      departmentId: dept.id,
      workerId: worker.id,
      role: worker.role,
      status: "assigned",
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/workers/:workerId/evaluate  { agentAddress, rating, notes? }
// next-phase.md Phase 2f-iii: evaluate_worker(). Appends an evaluation
// row for one worker under this department — deliberately append-only
// (a worker can be evaluated many times across its lifetime, e.g. once
// per task), not an update-in-place single verdict, so a Department
// Agent reviewing a worker's history sees the trend rather than only
// the most recent rating. `rating` is free text (same "no enum, this
// codebase doesn't constrain judgment calls to a fixed vocabulary"
// reasoning departmentToolProfiles.ts's role field already documents)
// — a Department Agent's own reasoning decides what "strong" or
// "needs improvement" means for its own department.
router.post("/:id/workers/:workerId/evaluate", (req, res) => {
  try {
    const { agentAddress, rating, notes } = req.body;
    if (!agentAddress || !rating) {
      return res.status(400).json({ error: "agentAddress and rating are required" });
    }
    if (typeof rating !== "string" || rating.trim().length === 0 || rating.length > 100) {
      return res.status(400).json({ error: "rating must be a non-empty string of at most 100 characters" });
    }
    if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) {
      return res.status(400).json({ error: "notes, if provided, must be a string of at most 2000 characters" });
    }
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);

    // Worker must belong to THIS department — no status restriction
    // (unlike assign_task): evaluating a worker after it's completed,
    // failed, or been killed is exactly when a Department Agent most
    // needs to record a verdict, not only while it's still running.
    const worker = db
      .prepare(`SELECT id, role FROM sub_agents WHERE id = ? AND kind = 'worker' AND owner_address = ?`)
      .get(req.params.workerId, dept.id) as { id: string; role: string } | undefined;
    if (!worker) {
      return res.status(404).json({ error: `worker ${req.params.workerId} not found under department ${dept.id}` });
    }

    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO worker_evaluations (department_id, worker_id, kind, rating, notes, created_at)
         VALUES (?, ?, 'evaluation', ?, ?, ?)`,
      )
      .run(dept.id, worker.id, rating, notes ?? null, now);

    res.json({
      id: info.lastInsertRowid as number,
      departmentId: dept.id,
      workerId: worker.id,
      role: worker.role,
      rating,
      notes: notes ?? null,
      createdAt: now,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/workers/:workerId/retain  { agentAddress, notes? }
// next-phase.md Phase 2f-iii: retain_worker() — "explicit 'keep this
// one' signal distinct from just not retiring it." Recorded on the same
// worker_evaluations table as evaluate_worker (kind='retention',
// retained=1, rating always NULL) rather than a boolean flag on
// sub_agents itself: a "not currently retired" worker and a worker
// someone EXPLICITLY decided to keep are different facts (the former is
// just the absence of a kill call; the latter is a positive decision a
// Department Agent made), and keeping them on the same append-only
// table as evaluate_worker means a worker's full history — evaluations
// and retention decisions together — reads back in one query, ordered
// by created_at, instead of two separate tables a caller has to
// reconcile by timestamp themselves.
router.post("/:id/workers/:workerId/retain", (req, res) => {
  try {
    const { agentAddress, notes } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress is required" });
    if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) {
      return res.status(400).json({ error: "notes, if provided, must be a string of at most 2000 characters" });
    }
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const worker = db
      .prepare(`SELECT id, role FROM sub_agents WHERE id = ? AND kind = 'worker' AND owner_address = ?`)
      .get(req.params.workerId, dept.id) as { id: string; role: string } | undefined;
    if (!worker) {
      return res.status(404).json({ error: `worker ${req.params.workerId} not found under department ${dept.id}` });
    }

    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO worker_evaluations (department_id, worker_id, kind, notes, retained, created_at)
         VALUES (?, ?, 'retention', ?, 1, ?)`,
      )
      .run(dept.id, worker.id, notes ?? null, now);

    res.json({
      id: info.lastInsertRowid as number,
      departmentId: dept.id,
      workerId: worker.id,
      role: worker.role,
      retained: true,
      notes: notes ?? null,
      createdAt: now,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/workers/:workerId/evaluations?agentAddress=
// Introspection: this worker's full evaluate_worker/retain_worker
// history, most recent first — the read path for the append-only table
// both routes above write to.
router.get("/:id/workers/:workerId/evaluations", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const worker = db
      .prepare(`SELECT id FROM sub_agents WHERE id = ? AND kind = 'worker' AND owner_address = ?`)
      .get(req.params.workerId, dept.id) as { id: string } | undefined;
    if (!worker) {
      return res.status(404).json({ error: `worker ${req.params.workerId} not found under department ${dept.id}` });
    }

    const rows = db
      .prepare(
        `SELECT id, kind, rating, notes, retained, created_at FROM worker_evaluations
         WHERE worker_id = ? ORDER BY created_at DESC LIMIT 200`,
      )
      .all(worker.id) as any[];

    res.json({
      departmentId: dept.id,
      workerId: worker.id,
      evaluations: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        rating: r.rating,
        notes: r.notes,
        retained: r.retained === null ? null : Boolean(r.retained),
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/workers/:workerId/terminate  { agentAddress, reason? }
// next-phase.md Phase 2f-iii: terminate_temp_worker() — "already exists
// as retire_project()'s per-worker effect (Phase 2b) — this adds a
// single-worker version for evaluation-driven termination outside a
// full project retirement." Only ever targets a TEMP worker
// (project_id IS NOT NULL) — a permanent worker's termination is
// kill_subagent (Phase 2, via /subagents/:id/kill), which this route
// deliberately does not duplicate; the whole point of a dedicated
// terminate_temp_worker is that it also logs a project_burns row and
// archives the worker's output the exact same way retire_project()
// does for its whole batch, just for one worker at a time instead of
// every worker under a projectId. Rejects a permanent worker with a
// clear error rather than silently killing it through the wrong path.
router.post("/:id/workers/:workerId/terminate", async (req, res) => {
  try {
    const { agentAddress, reason } = req.body;
    if (!agentAddress) return res.status(400).json({ error: "agentAddress is required" });
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
      return res.status(400).json({ error: "reason, if provided, must be a string of at most 500 characters" });
    }
    assertCanSpawnSubAgents(agentAddress);

    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const worker = db
      .prepare(
        `SELECT id, role, result, error, project_id, status, pty_session_id, created_at FROM sub_agents
         WHERE id = ? AND kind = 'worker' AND owner_address = ?`,
      )
      .get(req.params.workerId, dept.id) as {
      id: string;
      role: string;
      result: string | null;
      error: string | null;
      project_id: string | null;
      status: string;
      pty_session_id: string | null;
      created_at: number;
    } | undefined;
    if (!worker) {
      return res.status(404).json({ error: `worker ${req.params.workerId} not found under department ${dept.id}` });
    }
    if (!worker.project_id) {
      return res.status(409).json({
        error: `worker ${worker.id} is a permanent worker (no project_id) — use kill_subagent to terminate it, terminate_temp_worker only targets temporary/project-tagged workers`,
      });
    }
    if (worker.status !== "running") {
      return res.status(409).json({ error: `worker ${worker.id} is already ${worker.status}` });
    }

    const now = Date.now();
    db.prepare(`UPDATE sub_agents SET status = 'killed', ended_at = ? WHERE id = ? AND status = 'running'`).run(
      now,
      worker.id,
    );
    db.prepare(
      `INSERT INTO project_burns (department_id, project_id, worker_id, role, spawned_at, burned_at, duration_ms, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'retired', ?)`,
    ).run(dept.id, worker.project_id, worker.id, worker.role, worker.created_at, now, now - worker.created_at, now);
    // Same archival step retire-project/the TTL sweep/full department
    // retirement already perform — a single-worker termination is just
    // as much a "this worker is gone for good" moment as any of those,
    // so its output gets the same best-effort write into the
    // department's namespace before it's lost.
    try {
      archiveWorkerOutput({
        departmentId: dept.id,
        workerId: worker.id,
        projectId: worker.project_id,
        role: worker.role,
        result: worker.result,
        error: worker.error,
      });
    } catch {
      // best-effort, see departmentMemory.ts
    }
    if (worker.pty_session_id) {
      await pty.closeSession(worker.pty_session_id, worker.id).catch(() => {});
    }
    // If this worker was ever explicitly assigned a task, that task
    // reverts to 'unassigned' rather than staying pinned to a now-dead
    // worker id forever — a Department Agent re-assigning after
    // termination shouldn't have to separately notice and clear this.
    db.prepare(
      `UPDATE department_tasks SET status = 'unassigned', assigned_worker_id = NULL, updated_at = ?
       WHERE assigned_worker_id = ? AND status != 'completed'`,
    ).run(now, worker.id);
    // Terminating with a reason is itself worth a line in the same
    // evaluation history retain_worker/evaluate_worker write to, so
    // "why was this worker let go" is queryable the same way "why was
    // it kept" already is — reason is optional, so this only fires
    // when the caller actually gave one.
    if (reason) {
      db.prepare(
        `INSERT INTO worker_evaluations (department_id, worker_id, kind, notes, retained, created_at)
         VALUES (?, ?, 'retention', ?, 0, ?)`,
      ).run(dept.id, worker.id, reason, now);
    }

    res.json({
      ok: true,
      workerId: worker.id,
      departmentId: dept.id,
      projectId: worker.project_id,
      status: "killed",
      reason: reason ?? null,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});
