/**
 * next-phase.md Phase 2i(b) — assign_tools() resolver
 * (architecture-agent.md §9)
 *
 * The query §9 describes: given a tier (and, for a Department Agent, a
 * role/department type), return the concrete tool_registry rows that
 * tier is entitled to. This is what makes Phase 2i(a)'s seeded table
 * load-bearing for the first time — before this phase nothing read
 * from tool_registry at all; departmentToolProfiles.ts's hardcoded
 * CAPABILITY_TO_ACTIONS/resolveProfileActions() remained the only live
 * lookup any call site actually used (see that file's own header and
 * db.ts's Phase 2i(a) migration comment).
 *
 * Scope, stated precisely because it's easy to overstate: this phase
 * wires backend/src's own four creation call sites (create_department,
 * department.spawn_worker, department.spawn_temp_workers, top-level
 * agent provisioning in wallet.ts) onto this resolver, per next-
 * phase.md's own "Touches" line for 2i(b). It does NOT touch
 * agent-runtime's systemPrompt.ts/tools.ts dispatch enforcement —
 * those live in a separate TypeScript project (backend/agent-runtime/
 * src, its own package.json/tsconfig.json, no dependency edge to
 * backend/src — see toolRegistrySeedData.ts's own header) and still
 * read departmentToolProfiles.ts's hardcoded map for every real
 * enforcement decision. Migrating THOSE call sites onto tool_registry
 * (necessarily over HTTP, the only channel between the two processes —
 * agent-runtime has no direct DB access, see subagents.ts's own
 * "separate process" note) is explicitly Phase 2i(c)'s job ("wire
 * registry-sourced defaults into Phase 2g's capability check" /
 * migrating callers), not this one's. Until 2i(c), a Department Agent's
 * actual tool DISPATCH is still governed by departmentToolProfiles.ts —
 * this phase's `granted_tools` snapshot is real, queried live from the
 * registry, and correctly narrower for Marketing than Software (the
 * "Done when" line below), but it is a resolved-and-recorded GRANT, not
 * yet the thing tools.ts's executeTool() checks a call against.
 */

import { db } from "./db.js";
import { DEPARTMENT_TOOL_PROFILES } from "./toolRegistrySeedData.js";

export type Tier = "agent" | "department_agent" | "worker";

// Zent.md Phase 2a: `opportunity_intelligence` added as the seventh
// department type. Like every other type here, its canonical name is
// what normalizeDepartmentType() resolves to (and what departments.ts
// and toolRegistrySeedData.ts must agree on), not the display name
// shown to users. Its spawn guard (only a profitable top-level agent
// may create one) lives in expansion.ts's isEligibleForExpansion()
// and is enforced in departments.ts's POST / route — this file is
// purely the type declaration, alias table, and canonical list. It is
// NOT added to HARDENED_NETWORK_DEPARTMENT_TYPES: signal scanning needs
// outbound internet access (the whole point of 2b/2c) and is already
// rate-capped by Phase 2d's quota rather than by network isolation.
// Zent.md Phase 5a: `research` added as the eighth department type —
// same "type declaration, alias table, canonical list only" scope as
// opportunity_intelligence's own Phase 2a comment just above. Spawnable
// only by the top-level agent that owns the `opportunity_id` it's
// created to verify (enforced in departments.ts's POST / route, not
// here), and — unlike every other department type — always tied 1:1 to
// one opportunity for its whole lifetime (sub_agents.opportunity_id,
// db.ts's Phase 5a migration) rather than existing indefinitely. Not
// added to HARDENED_NETWORK_DEPARTMENT_TYPES: Phase 5b/5c's
// estimate_market_size/survey_competition tools are web-search-backed,
// same reasoning opportunity_intelligence's own comment gives for why
// it isn't hardened either.
// Zent.md Phase 11a: `strategy` added as the ninth department type —
// same "type declaration, alias table, canonical list only" scope as
// research's own Phase 5a comment just above. Unlike research, it is
// NOT tied 1:1 to sub_agents.opportunity_id (no auto-teardown-on-
// finding-filed rule for it in Zent.md, the same reasoning finance's
// own opportunity-scoped guard in departments.ts already documents for
// why IT doesn't write that column either) — its opportunity_id is a
// plain call argument the spawn guard validates and Phase 11b-11e's
// eventual tools take directly, not a row-level association. Spawnable
// only once both Research and Finance have filed non-rejecting reports
// for the opportunity (enforced in departments.ts's POST / route, not
// here). Not added to HARDENED_NETWORK_DEPARTMENT_TYPES: Strategy's
// Phase 11b-12d tools (list_existing_companies, check_mission_overlap,
// check_technology_reuse) all read this agent's own lineage/finding
// data, not the open web, so there's nothing here for network
// isolation to guard against either way.
export type DepartmentType = "software" | "marketing" | "finance" | "security" | "server" | "domain" | "opportunity_intelligence" | "research" | "strategy";

export interface ToolGrant {
  name: string;
  description: string;
  inputSchema: object;
  costUnit: "usd" | "compute" | "calls" | "disk";
  costAmountPerCall: number | null;
  costAmountPerUnit: number | null;
  scopeTemplate: string;
  lifecycle: string;
}

// Literal copy of agent-runtime/src/departmentToolProfiles.ts's
// DEPARTMENT_TYPE_ALIASES — see toolRegistrySeedData.ts's own header
// for exactly why this is a deliberate copy rather than a cross-
// package import (backend/src and backend/agent-runtime/src are two
// independent TS projects with no dependency edge anywhere in this
// repo; importing across it would compile under tsx but break `tsc
// --noEmit` for whichever project builds standalone). If this list and
// departmentToolProfiles.ts's own copy ever disagree, that's a real
// bug to fix by hand in both places — same relationship
// toolRegistrySeedData.ts already has to that file.
//
// next-phase.md Phase 9a-ii: this copy is exactly what next-phase.md's
// own Phase 9a "Touches" line for departmentToolProfiles.ts missed —
// found by inspection before building anything further. Without
// `domain` added here too, `create_department(role: "domain")`'s own
// `assignTools("department_agent", { role })` call (departments.ts)
// would resolve `resolvedType` to null via THIS file's
// normalizeDepartmentType(), silently falling back to only the
// department-type-unrestricted tool_registry rows — never the
// domain-specific ones 9a-iii seeds — even though
// departmentToolProfiles.ts's own copy (the one next-phase.md's
// checklist explicitly named) correctly resolves "domain". Two
// independent copies existing at all is exactly the situation this
// file's own header comment already warns can drift; this sub-phase
// updates both rather than leaving one stale.
const DEPARTMENT_TYPE_ALIASES: Record<DepartmentType, string[]> = {
  software: ["engineering", "eng", "dev", "development", "frontend", "backend"],
  marketing: ["growth", "marcomm"],
  finance: ["accounting", "fin"],
  security: ["infosec", "sec"],
  server: ["infra", "infrastructure", "devops", "ops", "sysadmin"],
  domain: ["dns", "domains", "webmaster"],
  // Zent.md Phase 2a: short aliases for the new type. "oi" is the
  // fastest caller-side shorthand; the hyphenated forms match what a
  // human is likely to type when not copy-pasting the canonical name.
  // The agent-runtime copy (departmentToolProfiles.ts) must receive
  // the same entry — see this file's own header comment on the
  // deliberate-duplication relationship between the two copies.
  opportunity_intelligence: ["oi", "opp-intel", "opportunity-intelligence"],
  // Zent.md Phase 5a: aliases for the new `research` type. Deliberately
  // NOT including bare "researcher"/"research worker" — those already
  // resolve to the `web researcher` WORKER role (WORKER_ROLE_ALIASES
  // above), a different tier entirely; conflating the two would make a
  // create_department(role: "researcher") call silently land on the
  // wrong tier's alias table if this file's lookup order ever changed.
  research: ["r&d", "rd", "market-research", "research-dept"],
  // Zent.md Phase 11a: aliases for the new `strategy` type. Deliberately
  // NOT including bare "strategist" — no existing WORKER_ROLE_ALIASES
  // entry claims it today, but keeping the alias list narrow and
  // literal (matching research's own "no bare researcher" reasoning
  // just above) leaves room for a future worker-tier role to claim it
  // without colliding with this department-tier alias.
  strategy: ["biz-strategy", "corp-strategy", "strategy-dept"],
};

const CANONICAL_DEPARTMENT_TYPES: DepartmentType[] = [
  "software",
  "marketing",
  "finance",
  "security",
  "server",
  "domain",
  "opportunity_intelligence", // Zent.md Phase 2a
  "research", // Zent.md Phase 5a
  "strategy", // Zent.md Phase 11a
];

/**
 * next-phase.md Phase 9f-i (Founder request, following up on 9f's own
 * "sandbox network is opt-in, not universal" finding): the Founder
 * wants every Agent's own sandbox to have internet by default, with
 * the Agent itself deciding which of its departments get network
 * access — EXCEPT Finance, Security, and Server, which stay hardened
 * (no sandbox network, ever) regardless of what the Agent requests.
 * This is a HARD deny, not a default: departments.ts checks this list
 * before ever provisioning or toggling a department's environment
 * network flag, and it cannot be overridden by a caller-supplied
 * `wantsNetwork: true` on create_department or a later network-toggle
 * call. Exported as the single source of truth so nothing else in this
 * codebase can drift from it by re-deriving its own copy of "which
 * three types are hardened."
 */
export const HARDENED_NETWORK_DEPARTMENT_TYPES: DepartmentType[] = ["finance", "security", "server"];

export function isHardenedNetworkDepartmentType(type: DepartmentType | null): boolean {
  return type !== null && HARDENED_NETWORK_DEPARTMENT_TYPES.includes(type);
}

/**
 * role -> DepartmentType | null. The same normalizing match
 * departmentToolProfiles.ts's lookupDepartmentToolProfile() performs
 * (case-insensitive, trims whitespace, canonical type name first, then
 * each type's alias list) — returns null (never a made-up sixth type)
 * on no match, so assignTools() can fail closed on an unrecognized
 * role the same way that function's own DEFAULT_TOOL_PROFILE fallback
 * does, rather than silently granting nothing OR the union of every
 * type's rows.
 */
export function normalizeDepartmentType(role: string | null | undefined): DepartmentType | null {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if ((CANONICAL_DEPARTMENT_TYPES as string[]).includes(normalized)) {
    return normalized as DepartmentType;
  }
  for (const type of CANONICAL_DEPARTMENT_TYPES) {
    if (DEPARTMENT_TYPE_ALIASES[type].includes(normalized)) return type;
  }
  return null;
}

/**
 * error-fix.md #1 fix — Worker-role narrowing, live-registry side.
 *
 * Mirrors agent-runtime/src/departmentToolProfiles.ts's own
 * WORKER_ROLE_PROFILES/WORKER_ROLE_ALIASES exactly (same deliberate
 * "two independent TS projects, no dependency edge" duplication this
 * file already carries for DEPARTMENT_TYPE_ALIASES — see this file's
 * header). If the two ever disagree, that's a real bug to fix by hand
 * in both places, same relationship every other duplicated table here
 * already has.
 */
const WORKER_ROLE_PROFILES: Record<string, string[]> = {
  "backend worker": [
    "terminal", "shell", "file system", "git", "package manager",
    "database", "API testing", "deployment", "logs",
  ],
  "frontend worker": [
    "terminal", "shell", "file system", "git", "package manager",
    "build tools", "test tools", "debugging",
  ],
  "web researcher": ["web search", "market research", "competitor research", "customer research", "lead research"],
  designer: ["file system"],
  "sales worker": ["web search", "lead research", "CRM", "customer communication"],
  "security worker": ["logs", "vulnerability testing", "security testing", "vulnerability research"],
};

const WORKER_ROLE_ALIASES: Record<string, string[]> = {
  "backend worker": ["backend", "backend developer", "backend engineer"],
  "frontend worker": ["frontend", "frontend developer", "frontend engineer"],
  "web researcher": ["researcher", "research worker", "market researcher"],
  designer: ["design worker", "ui designer", "ux designer"],
  "sales worker": ["sales", "salesperson"],
  "security worker": ["security researcher", "vulnerability researcher"],
};

/** workerRole -> WORKER_ROLE_PROFILES key, or null on no match. Same
 * normalizing (not fuzzy) match order as normalizeDepartmentType(). */
export function normalizeWorkerRole(workerRole: string | null | undefined): string | null {
  const normalized = (workerRole ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized in WORKER_ROLE_PROFILES) return normalized;
  for (const key of Object.keys(WORKER_ROLE_PROFILES)) {
    if (WORKER_ROLE_ALIASES[key].includes(normalized)) return key;
  }
  return null;
}

/**
 * The tool_registry's Worker-tier rows (WORKER_COMPUTE/WORKER_DEV_TOOLS/
 * WORKER_RESEARCH_TOOLS in toolRegistrySeedData.ts — §4f's "External/
 * specialty tools" bullet, the only Worker-tier section that bullet
 * says "depends entirely on the worker's role") are seeded under their
 * own granular registry names ("terminal (worker)", "git (worker)",
 * "web search (worker)", ...), not the plain capability names
 * DEPARTMENT_TOOL_PROFILES uses. This maps each of those 21 rows onto
 * the capability name it corresponds to, so a Worker's grant can be
 * intersected against its department's own profile and its worker-role
 * profile the same way a Department Agent's already is — every OTHER
 * Worker-tier row (task tools, communication, memory, reasoning,
 * financial access) is intentionally absent from this map and is never
 * narrowed by role, matching §4f's own bullet structure: those
 * sections don't vary by specialty, only Compute/Development/Research
 * tools do.
 */
const WORKER_TOOL_NAME_TO_CAPABILITY: Record<string, string> = {
  "terminal (worker)": "terminal",
  "shell (worker)": "shell",
  "file system (worker)": "file system",
  "logs (worker)": "logs",
  "read code": "file system",
  "write code": "file system",
  "edit code": "file system",
  "run tests (worker)": "test tools",
  "run builds (worker)": "build tools",
  "git (worker)": "git",
  "package managers (worker)": "package manager",
  "debugging (worker)": "debugging",
  "api testing (worker)": "API testing",
  "web search (worker)": "web search",
  "web browsing (worker)": "web search",
  "documentation lookup": "market research",
  "assigned research sources": "market research",
  "data extraction": "market research",
};

interface ToolRegistryRow {
  name: string;
  description: string;
  input_schema: string;
  cost_unit: string;
  cost_amount_per_call: number | null;
  cost_amount_per_unit: number | null;
  permission_level: string;
  department_types: string | null;
  scope_template: string;
  lifecycle: string;
  deprecated: number;
}

/**
 * assign_tools(tier, options?) — architecture-agent.md §9's own query.
 *
 * Queries tool_registry directly for every non-deprecated row whose
 * `permission_level` (JSON array) includes `tier`. For `tier ===
 * "department_agent"`, additionally filters on `department_types`:
 *   - a row with `department_types` NULL ("any department", per §9's
 *     own ToolDefinition comment and Phase 2i(a)'s migration note) is
 *     always included, regardless of the resolved department type —
 *     this is §4e's reasoning/management/memory/finance/communication
 *     bullets, not the per-department-type table.
 *   - a row with `department_types` set is included only when the
 *     resolved department type is one of the listed types — this is
 *     §4e's five-column table (Software/Marketing/Finance/Security/
 *     Server), Phase 2f-i/2i(a)'s own per-type rows.
 *
 * `departmentType` may be passed pre-resolved (e.g. a value already
 * normalized and stored elsewhere) OR `role` may be passed and this
 * function normalizes it itself via normalizeDepartmentType() —
 * passing both is fine, `departmentType` wins so a caller that already
 * did the normalization never pays for a second, possibly-diverging
 * one. Passing neither for a `department_agent` call is legal: it
 * returns only the department-type-unrestricted subset, matching the
 * fail-closed posture normalizeDepartmentType()/
 * lookupDepartmentToolProfile() already take on an unrecognized role
 * — never the union of every department type's rows.
 *
 * `tier`s other than `department_agent` ignore `department_types` at
 * the ROW level entirely by construction (an Agent-tier or Worker-tier
 * row is never department_types-restricted at seed time — see
 * toolRegistrySeedData.ts's own §4d/§4f generation, which never sets
 * that field for those tiers). For `tier === "worker"`, `departmentType`
 * and the new `workerRole` (error-fix.md #1 fix) are instead applied as
 * a CAPABILITY-level narrowing, below, on top of that row-level
 * permission_level check — see WORKER_TOOL_NAME_TO_CAPABILITY's own doc
 * comment for exactly which rows this can affect. Passing
 * role/departmentType/workerRole for an `agent` call remains harmless
 * and a no-op, same as before this fix.
 */
export function assignTools(
  tier: Tier,
  options?: { role?: string | null; departmentType?: DepartmentType | null; workerRole?: string | null },
): ToolGrant[] {
  const rows = db.prepare(`SELECT * FROM tool_registry WHERE deprecated = 0`).all() as ToolRegistryRow[];

  const resolvedType: DepartmentType | null =
    options?.departmentType !== undefined && options?.departmentType !== null
      ? options.departmentType
      : options?.role !== undefined
        ? normalizeDepartmentType(options.role)
        : null;

  // error-fix.md #1 fix: only computed/consulted for tier "worker" — a
  // Department Agent's own row-level department_types filter above is
  // untouched by any of this. `departmentCapabilities` is null when the
  // worker's department type couldn't be resolved (unrecognized role,
  // or none passed at all) — null means "no department context to
  // narrow against," so the department-level check below is skipped
  // rather than treated as "narrow to nothing," matching every other
  // fail-open-to-the-department's-own-scope default in this file.
  const departmentCapabilities: Set<string> | null =
    tier === "worker" && resolvedType ? new Set(DEPARTMENT_TOOL_PROFILES[resolvedType].map((c) => c.toLowerCase())) : null;
  const normalizedWorkerRole = tier === "worker" ? normalizeWorkerRole(options?.workerRole) : null;
  const workerRoleCapabilities: Set<string> | null = normalizedWorkerRole
    ? new Set(WORKER_ROLE_PROFILES[normalizedWorkerRole].map((c) => c.toLowerCase()))
    : null;

  const grants: ToolGrant[] = [];
  for (const row of rows) {
    const permissionLevels: string[] = JSON.parse(row.permission_level);
    if (!permissionLevels.includes(tier)) continue;

    if (tier === "department_agent") {
      const departmentTypes: string[] | null = row.department_types
        ? JSON.parse(row.department_types)
        : null;
      if (departmentTypes !== null) {
        if (!resolvedType || !departmentTypes.includes(resolvedType)) continue;
      }
    }

    // error-fix.md #1 fix: capability-level narrowing for the Worker-
    // tier "External/specialty" rows only (WORKER_TOOL_NAME_TO_CAPABILITY
    // has no entry for task/communication/memory/reasoning/financial
    // rows, so those are never touched here — `capability` stays
    // undefined and both checks below short-circuit as a no-op for
    // them, exactly preserving this function's prior behavior for
    // every row outside the 21 this fix actually narrows).
    if (tier === "worker") {
      const capability = WORKER_TOOL_NAME_TO_CAPABILITY[row.name];
      if (capability) {
        // §4f: "a Worker never has more tool surface than its own
        // Department Agent" — a capability this worker's own
        // department profile doesn't grant at all is denied
        // regardless of workerRole (this fires even with no
        // recognized workerRole at all, e.g. a Security worker's
        // "web search (worker)" row is excluded because Security's
        // own profile — before Phase 12a's "vulnerability research"
        // addition — never had "web search" to begin with).
        if (departmentCapabilities && !departmentCapabilities.has(capability)) continue;
        // Further narrowing by the specific worker role, when recognized.
        if (workerRoleCapabilities && !workerRoleCapabilities.has(capability)) continue;
      }
    }

    grants.push({
      name: row.name,
      description: row.description,
      inputSchema: JSON.parse(row.input_schema),
      costUnit: row.cost_unit as ToolGrant["costUnit"],
      costAmountPerCall: row.cost_amount_per_call,
      costAmountPerUnit: row.cost_amount_per_unit,
      scopeTemplate: row.scope_template,
      lifecycle: row.lifecycle,
    });
  }

  // Deterministic order: SQLite gives no ordering guarantee without an
  // ORDER BY, and a caller diffing "what did I get granted" against
  // "what did I expect" (this phase's own test suite included) needs a
  // stable order to compare against, not incidental row-insertion
  // order that could shift on a future re-seed.
  grants.sort((a, b) => a.name.localeCompare(b.name));
  return grants;
}

/**
 * Convenience wrapper returning just the granted tool names — the
 * shape every current call site (a `granted_tools` JSON column, this
 * phase's own "Done when" verification) actually needs, without every
 * caller re-deriving `.map(g => g.name)` itself.
 */
export function assignToolNames(
  tier: Tier,
  options?: { role?: string | null; departmentType?: DepartmentType | null; workerRole?: string | null },
): string[] {
  return assignTools(tier, options).map((g) => g.name);
}
