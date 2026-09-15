import fs from "fs";
import path from "path";
import { db } from "./db.js";
import { officePrivateDir } from "./office.js";
import { isGrantRevoked } from "./toolGrants.js";

/**
 * next-phase.md Phase 1 (architecture-agent.md §8): the generalized
 * version of vmService.ts's requireOwnedSandbox(). Every route that
 * touches disk, Docker, or wallet funnels through checkCapability()
 * instead of hand-rolling its own ownership check, so "who can touch
 * what" lives in one place and every decision — allow or deny — is
 * logged in one place (capability_audit, see db.ts).
 *
 * Phase 1 is a refactor, not new capability: only the direct-ownership
 * path (step 1) could actually allow anything at first. Delegation
 * (step 2, sub-agents acting under a parent) and channel grants (step
 * 3, cross-office access) were wired to the real shape §8 specifies but
 * hard-stubbed to always return false until Phase 2 (delegation) and
 * Phase 3c (channel grants) replaced those stub bodies with real logic.
 * A step-3 channel check only ever fires for resourceType: "channel",
 * whose resourceId follows the "{peerAddress}:{scope}" convention (see
 * findActiveChannelGrant's own doc comment below) — 3d/3e/3f's own
 * capabilities are what actually construct that resourceId once they
 * exist.
 *
 * office/private/ (the vault) is deliberately never a valid resourceType
 * here — see architecture-agent.md §8's note. The wallet oracle
 * (wallet.sign/wallet.pay) stays its own narrower interface that never
 * returns key material, so it doesn't need this same generic resource
 * shape.
 */

export type ResourceType =
  | "sandbox"
  | "office_path"
  | "wallet"
  | "channel"
  | "subagent"
  | "browser"
  | "department_budget"
  | "department"
  | "department_quota"
  // Phase 7b: audit-only label for a checkGrantedToolCapability()
  // grant-revocation pre-check (see that function's own doc comment) —
  // never a real ownerOf()/checkCapability() resourceType lookup target,
  // just what capability_audit's own resource_type column needs to be
  // legible about which mechanism produced a "grant-revoked" row.
  | "tool_grant"
  // Phase 16c: a listing on the shared marketplace (marketplace.ts's
  // own module doc: "any agent, yours or not, can discover a listing
  // and pay to invoke it"). Unlike every other resourceType above,
  // this one is deliberately public, not owned — see checkCapability()'s
  // dedicated branch for it below. Exists so /:id/invoke gets a real,
  // audited capability_audit row (who invoked what) and so a future
  // per-listing restriction has one call site to tighten against,
  // rather than to gate access today.
  | "marketplace_listing";
export type CapabilityAction = "read" | "write" | "exec" | "sign" | "pay" | "manage" | "transfer";

/**
 * Phase 2g (architecture-agent.md §4g): the two dimensions §8's original
 * 4-field check never had a place for. Tool + Scope were already
 * implicit in resourceType/resourceId (confirmed in Phase 1's own doc
 * comment); Role is already implicit in *which* row ownerOf()/
 * isSubagentOf() resolves the caller to (a caller's tier is a fact about
 * its row in sub_agents, not a fifth field to pass in) — so this phase
 * adds exactly the two dimensions that had no existing home: Budget and
 * Environment.
 *
 * Both are optional on the interface, not because §4g considers them
 * optional in principle (next-phase.md's own checklist calls them
 * "required"), but because making them mandatory on every call would be
 * a breaking change to every existing checkCapability() call site built
 * across Phase 1-2f (sandbox ownership, office_path I/O, wallet.sign,
 * browser access, etc.) — none of which have a budget or environment
 * concept to check today. Per next-phase.md's own scope note ("2e/2f are
 * what generate the concrete grants... this phase's mechanism needs to
 * check against"), a call site opts in by passing `budget`/`environment`
 * once it actually has a grant to check them against; omitting either
 * one skips that dimension's check entirely (never treated as "budget:
 * 0" or "wrong environment" by default) rather than silently failing
 * every pre-2g call site closed. wallet.ts's department-budget payment
 * check (Phase 2f-iv) is retrofitted in this phase as the first real
 * caller of the `budget` field — see wallet.ts's checkDepartmentBudget().
 */
export interface CapabilityBudget {
  limit: number;
  spent: number;
  unit: "usd" | "compute" | "calls" | "disk";
}

export interface CapabilityCheck {
  caller: string; // authenticated agent_address making the call
  resourceType: ResourceType;
  resourceId: string; // sandboxId, office-relative path, wallet owner address, channel id, wkr_id, etc.
  action: CapabilityAction;
  /** Phase 2g: pass to have this call denied if it would push `spent` past `limit`. Omit to skip this dimension. */
  budget?: CapabilityBudget;
  /** Phase 2g: the sandbox/container/VM id this call is expected to execute in. Omit to skip this dimension. */
  environment?: string;
  /**
   * Phase 2g: the environment the caller's own grant actually authorizes
   * (e.g. the sandbox id provisioned for a Worker's own task). Required
   * alongside `environment` for the wrong-environment check to run —
   * without it there is nothing to compare `environment` against, so
   * (matching the budget field's own "omit to skip" rule) the check is
   * skipped rather than guessed at.
   */
  grantedEnvironment?: string;
}

/**
 * Phase 2i(c) (architecture-agent.md §9, continued from Phase 2i(a)/(b)):
 * wires tool_registry's own declared metadata (scopeTemplate/cost/
 * lifecycle — Phase 2i(a)'s seed, Phase 2i(b)'s assignTools()) into
 * Phase 2g's checkCapability() 5-tuple as real defaults, instead of
 * every route hand-picking a resourceType/resourceId/budget/environment
 * per call the way Phase 2e/2f/2g's own call sites still do today.
 *
 * Scope, stated precisely per this phase's own next-phase.md entry
 * ("Touches: backend/src/capability.ts"): this resolves a registry
 * grant's declared scope/cost into the shape checkCapability() already
 * accepts. It does not itself re-derive an already-provisioned
 * environment id (that's environment.ts's resolveEnvironmentForSubAgent()
 * job, Phase 2g's own second pass) or change how any existing route
 * calls checkCapability() directly — a route opts in by calling
 * checkGrantedToolCapability() below wherever it currently builds a
 * CapabilityCheck by hand for a tool_registry-backed capability.
 */

/**
 * The subset of a tool_registry row's own metadata (see toolRegistry.ts's
 * ToolGrant / toolRegistrySeedData.ts's SeedRow) that scope/budget
 * resolution actually needs. Declared locally rather than importing
 * ToolGrant directly so this file's own resolution logic stays
 * decoupled from toolRegistry.ts's exact shape — the same "narrow,
 * declared interface" choice CapabilityCheck itself already makes for
 * every other field.
 */
export interface RegistryGrantMetadata {
  scopeTemplate: string; // one of ScopeTemplate (toolRegistrySeedData.ts) — "own_office" | "own_container" | "assigned_department" | "assigned_project" | "company_wide"
  lifecycle: string; // one of Lifecycle — "persistent" | "session" | "task" | "project"
  costUnit: "usd" | "compute" | "calls" | "disk";
  costAmountPerCall: number | null;
  costAmountPerUnit: number | null;
  /**
   * True only for a grant whose tool_registry.permission_level is
   * exactly `["agent"]` — never available to department_agent or
   * worker. Needed because §9's own rule ("a persistent Agent-tier tool
   * gets no ceiling unless the Founder sets one explicitly") is
   * tier-specific: an unmetered Department-Agent/Worker grant simply
   * has no budget dimension to check, full stop, while an unmetered
   * Agent-tier one additionally respects an explicit Founder override
   * if one is ever set. Callers resolving a `ToolGrant` from
   * assignTools("agent", ...) should pass true here; any other tier,
   * false/omit.
   */
  agentTierOnly?: boolean;
}

/**
 * Everything resolveScopeResource() needs to turn a declared
 * scopeTemplate into a concrete (resourceType, resourceId) pair.
 * Fields are optional because which ones are required depends entirely
 * on which scopeTemplate is being resolved — resolveScopeResource()
 * throws (rather than guessing) if a required field for the template
 * actually being resolved is missing, the same fail-closed posture
 * normalizeDepartmentType() already takes on an unrecognized role.
 */
export interface ScopeResolutionContext {
  /** The top-level agent this grant's scope ultimately resolves back
   *  to — company_wide/own_office/own_container's default company-wide
   *  fallback all anchor here. Always the real Agent-tier address, per
   *  isSubagentOf()'s own convention elsewhere in this file, never a
   *  worker's or department's own id. */
  topLevelAgentAddress: string;
  /** Required for "assigned_department" and (together with projectId)
   *  "assigned_project". The department's sub_agents id. */
  departmentId?: string;
  /** Required alongside departmentId for "assigned_project" — the
   *  §4b workload tag (department_projects.id / project_burns.project_id
   *  convention), never a resource with an owner of its own (Phase 2h:
   *  "a project is a workload tag, not a fifth tier"). */
  projectId?: string;
  /** Required for "own_container" — the sandbox/container id already
   *  provisioned for this call's real caller. Pass
   *  environment.ts's resolveEnvironmentForSubAgent() /
   *  resolveDepartmentEnvironment() / resolveProjectEnvironment()
   *  return value directly; this function never provisions one itself
   *  (no DB or Docker access from here — see this file's own
   *  dependency-light convention). */
  environmentId?: string;
  /** Required for "assigned_listing" — the marketplace listing id a
   *  16d-style relationship-scoped grant is tied to. Only meaningful
   *  once something actually restricts a listing (see
   *  checkCapability()'s "marketplace_listing" branch, which today
   *  allows any existing/active listing before this scope is ever
   *  consulted) — this case exists so 16d's tool_registry grant has a
   *  resourceId to resolve to, not because anything reads it yet. */
  listingId?: string;
}

/**
 * §9's scope resolution: "resolve(scopeTemplate, new agent's own
 * office/container/department/project id)". Throws on an unrecognized
 * template or a missing required context field rather than falling
 * back to some default resource — an unresolvable scope must never
 * silently degrade into a broader-than-intended one.
 */
export function resolveScopeResource(
  scopeTemplate: string,
  context: ScopeResolutionContext,
): { resourceType: ResourceType; resourceId: string } {
  switch (scopeTemplate) {
    case "company_wide":
      // Company-wide Agent-tier authority (§4d) resolves against the
      // agent's own wallet row — same "resource and owner are the same
      // thing" shape ownerOf()'s existing "wallet" case already uses,
      // so a company-wide grant is allowed exactly when the caller IS
      // that top-level agent (or a delegated sub-agent acting under
      // it), never a separate resource with its own quota to check.
      return { resourceType: "wallet", resourceId: context.topLevelAgentAddress };
    case "own_office":
      // office_path's existing "{agentId}:{relPath}" convention
      // (ownerOf()'s own comment above) degrades cleanly to a bare
      // agentId when there's no specific relPath to check yet — the
      // colon-split there returns the whole string as owner when no
      // colon is present.
      return { resourceType: "office_path", resourceId: context.topLevelAgentAddress };
    case "own_container":
      if (!context.environmentId) {
        throw new Error(
          `resolveScopeResource: "own_container" scope requires context.environmentId (an already-provisioned sandbox id)`,
        );
      }
      return { resourceType: "sandbox", resourceId: context.environmentId };
    case "assigned_department":
      if (!context.departmentId) {
        throw new Error(`resolveScopeResource: "assigned_department" scope requires context.departmentId`);
      }
      return { resourceType: "department", resourceId: context.departmentId };
    case "assigned_project":
      if (!context.departmentId || !context.projectId) {
        throw new Error(
          `resolveScopeResource: "assigned_project" scope requires both context.departmentId and context.projectId`,
        );
      }
      // See ownerOf()'s "department" case above for why this reuses
      // that ResourceType with a ":"-joined resourceId rather than
      // introducing a dedicated "project" ResourceType for a tag Phase
      // 2h already locked as not being a fifth tier.
      return { resourceType: "department", resourceId: `${context.departmentId}:${context.projectId}` };
    case "assigned_listing":
      if (!context.listingId) {
        throw new Error(`resolveScopeResource: "assigned_listing" scope requires context.listingId`);
      }
      return { resourceType: "marketplace_listing", resourceId: context.listingId };
    default:
      throw new Error(`resolveScopeResource: unrecognized scopeTemplate "${scopeTemplate}"`);
  }
}

/**
 * §9/§4g's budget default: "a metered tool gets a starting allowance
 * sized off amountPerCall/amountPerUnit, a persistent Agent-tier tool
 * gets no ceiling unless the Founder sets one explicitly." Returns
 * undefined (skip the budget dimension entirely, matching
 * CapabilityCheck's own "omit to skip" contract) for any unmetered
 * grant that isn't an Agent-tier tool the Founder has explicitly
 * capped — never a fabricated `limit: 0`, which reads to
 * checkBudgetAndEnvironment() as "already over budget" rather than "no
 * limit to check."
 */
export function resolveBudgetDefault(
  grant: RegistryGrantMetadata,
  options?: { currentSpend?: number; founderCeiling?: number },
): CapabilityBudget | undefined {
  const spent = options?.currentSpend ?? 0;

  if (grant.costAmountPerCall === null && grant.costAmountPerUnit === null) {
    // Unmetered (reasoning-only, or a real ACTION this runtime doesn't
    // meter compute-seconds for — see toolRegistrySeedData.ts's own
    // cost-defaults note). Only an Agent-tier persistent tool with an
    // explicit Founder-set ceiling gets a budget dimension at all in
    // this case.
    if (grant.agentTierOnly && grant.lifecycle === "persistent" && options?.founderCeiling !== undefined) {
      return { limit: options.founderCeiling, spent, unit: grant.costUnit };
    }
    return undefined;
  }

  const meteredAmount = grant.costAmountPerCall ?? grant.costAmountPerUnit!;
  const limit = options?.founderCeiling ?? meteredAmount;
  return { limit, spent, unit: grant.costUnit };
}

/**
 * §4g's Environment dimension default: only an "own_container" grant
 * has an execution environment to compare a caller-asserted sandbox id
 * against in the first place — every other scopeTemplate is a
 * filesystem/ownership check, not an execution one (subagents.ts's
 * `/:id/pty` is still the one real call path that checks this, per
 * capability.ts's own module doc above). Returns undefined for any
 * other scopeTemplate, matching checkCapability's own "omit to skip"
 * contract for the environment dimension.
 */
export function resolveEnvironmentDefault(
  scopeTemplate: string,
  context: ScopeResolutionContext,
): string | undefined {
  if (scopeTemplate !== "own_container") return undefined;
  return context.environmentId;
}

/**
 * The single entry point a route should call once it has a resolved
 * tool_registry grant (from assignTools()/assignToolNames(), Phase
 * 2i(b)) it wants to actually check a call against — resolves scope,
 * budget, and environment from the grant's own declared metadata and
 * dispatches to checkCapability(), so a tool_registry-backed capability
 * check no longer needs its resourceType/resourceId/budget/environment
 * hand-picked per route the way every pre-2i(c) call site still does.
 *
 * `options.targetEnvironment`, if passed, is checked against the
 * resolved own_container default (e.g. a caller-asserted sandboxId on
 * an incoming request, the same shape subagents.ts's `/:id/pty` route
 * already validates by hand) — omit it to skip that specific
 * cross-check while still resolving and auditing scope/budget.
 *
 * `options.holderId`/`options.toolName` (Phase 7b, architecture-agent.md
 * §9's own "authorization is a separate, later job" carve-out, finally
 * picked up): when BOTH are supplied, this is checked FIRST, before
 * scope/budget/environment are even resolved — a revoked grant is
 * denied outright, not merely under-scoped. `holderId` is deliberately
 * a separate field from `caller`: for a Department Agent/Worker call,
 * `caller` here is still the top-level Agent whose credentials the
 * underlying capability actually runs as (same distinction
 * DepartmentDispatchContext's own doc comment draws in
 * agent-runtime/tools.ts), while `holderId` is the dept_xxx/wkr_xxx row
 * `tool_grants` was actually written against by recordToolGrants()
 * (Phase 2i(d)). Passing `caller` for both would silently check the
 * wrong row for every department/worker call and never find a match.
 * Omitting either one skips this check entirely — matching every other
 * dimension on this interface's own "omit to skip" convention — since a
 * caller with no grant-row identity to check (e.g. a bare
 * ScopeResolutionContext call with no Phase 2i(d)-tracked holder) has
 * nothing for `toolGrants.isGrantRevoked()` to look up in the first
 * place.
 */
export function checkGrantedToolCapability(
  caller: string,
  grant: RegistryGrantMetadata,
  context: ScopeResolutionContext,
  options?: {
    action?: CapabilityAction;
    currentSpend?: number;
    founderCeiling?: number;
    targetEnvironment?: string;
    holderId?: string;
    toolName?: string;
  },
): void {
  const action = options?.action ?? "exec";

  if (options?.holderId && options?.toolName && isGrantRevoked(options.holderId, options.toolName)) {
    const revokedCheck: CapabilityCheck = {
      caller,
      resourceType: "tool_grant",
      resourceId: `${options.holderId}:${options.toolName}`,
      action,
    };
    audit(revokedCheck, "deny", "grant-revoked");
    throw Object.assign(
      new Error(
        `${options.holderId}'s grant for "${options.toolName}" has been revoked ` +
          `(session closed, task completed, or project retired) and can no longer be used`,
      ),
      { status: 403 },
    );
  }

  const { resourceType, resourceId } = resolveScopeResource(grant.scopeTemplate, context);
  const budget = resolveBudgetDefault(grant, options);
  const grantedEnvironment = resolveEnvironmentDefault(grant.scopeTemplate, context);

  checkCapability({
    caller,
    resourceType,
    resourceId,
    action,
    budget,
    environment: options?.targetEnvironment ?? grantedEnvironment,
    grantedEnvironment,
  });
}

type AuditReason =
  | "owner"
  | "parent-delegation"
  | `channel:${string}`
  | "no-capability"
  | "over-budget"
  | "wrong-environment"
  | "grant-revoked"
  // Phase 16c: checkCapability()'s "marketplace_listing" branch — the
  // listing existed and was active, which today is the only bar a
  // marketplace invoke has to clear (see that branch's own comment).
  | "public-listing";

function audit(check: CapabilityCheck, decision: "allow" | "deny", reason: AuditReason): void {
  db.prepare(
    `INSERT INTO capability_audit (caller, resource_type, resource_id, action, decision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(check.caller, check.resourceType, check.resourceId, check.action, decision, reason, Date.now());
}

/**
 * Resolves the single agent_address that owns a resource, or null if
 * the resource doesn't exist / isn't the kind of thing that has one
 * owner. Kept separate from checkCapability() so Phase 2's isSubagentOf()
 * check (step 2) can reuse the same lookup instead of re-deriving it.
 *
 * notFound is set to true only when the resource itself doesn't exist
 * (as opposed to existing but belonging to someone else), so
 * checkCapability can preserve requireOwnedSandbox()'s original
 * 404-vs-403 distinction instead of collapsing every denial to 403 —
 * that distinction is real caller-visible behavior (see ptyRoutes.ts /
 * vmService.ts's `err.status || ...` fallbacks) and Phase 1 promises
 * zero behavior change.
 */
function ownerOf(
  resourceType: ResourceType,
  resourceId: string,
): { owner: string | null; notFound: boolean } {
  switch (resourceType) {
    case "sandbox": {
      const row = db
        .prepare(`SELECT agent_address, status FROM sandboxes WHERE id = ?`)
        .get(resourceId) as { agent_address: string; status: string } | undefined;
      if (!row || row.status === "deleted") return { owner: null, notFound: true };
      return { owner: row.agent_address, notFound: false };
    }
    case "wallet": {
      // For a wallet, resourceId IS the owning address — there's no
      // separate lookup, the resource and its owner are the same thing.
      const row = db.prepare(`SELECT address FROM agents WHERE address = ?`).get(resourceId) as
        | { address: string }
        | undefined;
      return row ? { owner: row.address, notFound: false } : { owner: null, notFound: true };
    }
    case "office_path": {
      // Convention: resourceId is "{agentId}:{relPath}" — the agentId
      // prefix IS the owner, the same way safeOfficePath() in office.ts
      // always derives its base from an authenticated agentId rather
      // than trusting a caller-supplied one. No filesystem lookup
      // needed; if the caller lies about the agentId prefix, step 1
      // below simply won't match caller === owner and the check fails
      // closed, same as any other mismatch.
      const idx = resourceId.indexOf(":");
      const owner = idx === -1 ? resourceId : resourceId.slice(0, idx);
      return { owner, notFound: false };
    }
    case "browser": {
      // One browser profile per agent, keyed by agentId directly (see
      // office.ts's browserProfileDir(agentId)) — same shape as wallet.
      return { owner: resourceId, notFound: false };
    }
    case "marketplace_listing": {
      // resourceId is the listing id. The seller is recorded as the
      // nominal owner — so a seller invoking its own listing, or one of
      // the seller's own subagents doing so, still resolves via steps 1
      // and 2 below like any other resource — but owner is NOT what
      // gates a buyer's access here; checkCapability()'s dedicated
      // "marketplace_listing" branch (checked before step 1) allows any
      // caller once the listing exists and is active. notFound mirrors
      // /:id/invoke's own "not found or inactive" 404, so a stale or
      // deactivated listing id reads the same way through either path.
      const row = db.prepare(`SELECT seller_address FROM listings WHERE id = ? AND active = 1`).get(resourceId) as
        | { seller_address: string }
        | undefined;
      return row ? { owner: row.seller_address, notFound: false } : { owner: null, notFound: true };
    }
    case "subagent": {
      // next-phase.md Phase 4f (architecture-agent.md §5, closing Phase
      // 4): this case used to read agents.parent_address here and hand
      // it back as `owner` — meaning, if anything ever called
      // checkCapability() with resourceType: "subagent" against a
      // clone's own address, step 1 above (`owner === check.caller`)
      // would have let a CLONE'S PARENT resolve as that clone's owner,
      // purely because Phase 4e (rightly) started actually populating
      // agents.parent_address for clones. That's exactly the
      // clone-lineage-as-capability bypass this phase exists to rule
      // out — the same distinction isSubagentOf()'s own doc comment
      // above already draws ("never agents.parent_address, which
      // records §5 clone lineage ... and must stay irrelevant to
      // delegation") had a hole in this one case that comment doesn't
      // itself cover.
      //
      // Confirmed by grepping every real checkCapability() call site in
      // backend/src (departments.ts, subagents.ts, vmService.ts,
      // wallet.ts, channelService.ts) that none passes resourceType:
      // "subagent" today — assertCanSpawnSubAgents() above builds a
      // same-shaped object but only ever passes it to audit() directly,
      // never to checkCapability() itself, so this was latent, not yet
      // triggered. Left latent, this table's original intent (from
      // Phase 1, before Phase 2 gave sub-agents their own sub_agents-
      // table rows and their own isSubagentOf() delegation path below)
      // is superseded, not merely stale: Tier delegation has had a
      // correct, dedicated mechanism since Phase 2a, and that mechanism
      // deliberately never reads this column. There is no remaining
      // legitimate case for this branch to resolve an owner at all, so
      // it now always misses — closing the gap rather than patching it
      // to exclude cloned addresses specifically, since a patch would
      // leave the "top-level agent's own optional parentAddress" case
      // (createAgentWallet's non-clone lineage, wallet.ts) just as able
      // to trigger the same bypass.
      return { owner: null, notFound: true };
    }
    case "channel":
      // Channels don't have a single owner — access is grant-based by
      // design (that's the whole point of a channel). Never resolves
      // via step 1; only ever reachable via step 3, whose resourceId
      // convention ("{peerAddress}:{scope}") findActiveChannelGrant()
      // below parses directly rather than needing a resourceId->owner
      // lookup here.
      return { owner: null, notFound: false };
    case "department_budget": {
      // Phase 2e (architecture-agent.md §4d): budget transfer between
      // departments is Agent-tier-only — the resource owner is the
      // top-level agent whose departments the fromDeptId/toDeptId
      // belong to. Convention: resourceId is the fromDeptId (the source
      // of the transfer), whose owner_address in sub_agents is the
      // owning agent. isSubagentOf() delegation deliberately cannot
      // satisfy this type — a Department Agent must never be able to
      // re-allocate budget across departments it doesn't control (it
      // only knows its own budget, not the other department's). This is
      // enforced structurally in departments.ts's /transfer-budget route
      // via assertCanSpawnSubAgents() before the route body runs.
      const row = db
        .prepare(`SELECT owner_address FROM sub_agents WHERE id = ? AND kind = 'department'`)
        .get(resourceId) as { owner_address: string } | undefined;
      if (!row) return { owner: null, notFound: true };
      return { owner: row.owner_address, notFound: false };
    }
    case "department": {
      // Phase 2g retrofit of Phase 2a/2b's per-department headcount
      // quotas (max_workers_per_department / max_temp_workers_per_
      // department): resourceId is the department id whose worker pool
      // is being counted against its own quota — same underlying lookup
      // as "department_budget" above (a department's owner_address IS
      // the top-level agent whose quota this is), kept as a distinct
      // ResourceType rather than reusing "department_budget" so
      // capability_audit's own resource_type column stays legible about
      // *which* dimension of a department's allocation a given row is
      // about (spend vs. headcount) rather than conflating the two under
      // one name.
      //
      // Phase 2i(c) addition: resourceId may also arrive as
      // "{departmentId}:{projectId}" — resolveScopeResource()'s own
      // encoding for an "assigned_project" grant (§4f's Worker
      // financial-access row is the one seeded capability that uses
      // it). Phase 2h already locked "a project is a workload tag, not
      // a fifth tier" — a project has no owner_address of its own to
      // look up, it borrows its department's — so this strips a
      // trailing ":{projectId}" the same way office_path already
      // strips its own "{agentId}:{relPath}" suffix above, rather than
      // adding a whole separate ResourceType for a tag that was
      // deliberately never given tier status. The full "{dept}:
      // {project}" string is still what lands in capability_audit's
      // resource_id column, so an audit row stays legible about which
      // project a Worker's spend was actually attributed to.
      const departmentId = resourceId.includes(":") ? resourceId.slice(0, resourceId.indexOf(":")) : resourceId;
      const row = db
        .prepare(`SELECT owner_address FROM sub_agents WHERE id = ? AND kind = 'department'`)
        .get(departmentId) as { owner_address: string } | undefined;
      if (!row) return { owner: null, notFound: true };
      return { owner: row.owner_address, notFound: false };
    }
    case "department_quota": {
      // Phase 2g retrofit of Phase 2a's per-agent max_departments quota:
      // resourceId is the top-level agent's own address — the quota
      // itself isn't a property of any one department (there may be
      // zero), it's a property of the agent, so this resolves the same
      // way "wallet" does (the resource and its owner are the same
      // row) rather than through a sub_agents lookup.
      const row = db.prepare(`SELECT address FROM agents WHERE address = ?`).get(resourceId) as
        | { address: string }
        | undefined;
      return row ? { owner: row.address, notFound: false } : { owner: null, notFound: true };
    }
    default:
      return { owner: null, notFound: false };
  }
}

/**
 * Phase 2 (architecture-agent.md §4), generalized in Phase 2a (§4a) to
 * walk the org chart instead of assuming exactly one hop: true if
 * `caller` is a live ("running") sub-agent thread that resolves back to
 * `owner` through a chain of sub_agents rows — never agents.parent_
 * address, which records §5 clone lineage (a distinct relationship: new
 * wallet, new office, zero inherited trust) and must stay irrelevant to
 * delegation.
 *
 * Phase 2's flat pool is the depth-1 case: a worker's own owner_address
 * IS `owner` directly. Phase 2a adds departments as a Tier-2 hop: a
 * Tier-3 worker's owner_address is a department id, and the department's
 * OWN owner_address is the top-level agent — so this climbs one row at a
 * time (each hop re-checked for status 'running', so a killed department
 * immediately cuts off every worker beneath it, no separate cascade
 * needed) until it either reaches `owner` (true) or runs out of chain /
 * hits the depth guard (false). The depth guard is a safety bound, not
 * the actual enforcement of §4a's "exactly three tiers" cap — that cap
 * is enforced structurally at spawn time (see departments.ts /
 * subagents.ts's assertCanSpawn), so in practice this loop never climbs
 * more than 2 hops (Tier 3 → Tier 2 → Tier 1).
 *
 * This is what lets a worker's or department's own PTY/browser-tab
 * calls (issued as `caller = wkr_xx` / `dept_xx`) succeed against
 * resources actually owned by the top-level agent — e.g.
 * checkCapability({ caller: 'wkr_01', resourceType: 'sandbox',
 * resourceId: <agent's default sandbox>, ... }) — without either ever
 * holding a capability_grant of its own.
 */
function isSubagentOf(caller: string, owner: string | null, depth = 0): boolean {
  if (!owner || depth > 4) return false;
  const row = db.prepare(`SELECT owner_address FROM sub_agents WHERE id = ? AND status = 'running'`).get(
    caller,
  ) as { owner_address: string } | undefined;
  if (!row) return false;
  if (row.owner_address === owner) return true;
  return isSubagentOf(row.owner_address, owner, depth + 1);
}

/**
 * Phase 2a depth-cap enforcement (architecture-agent.md §4a: "a Tier 3
 * worker has no spawn_subagent/create_department capability at all —
 * attempting either is a capability-check denial, not a soft
 * convention"). Every route that lets something spawn a new sub_agents
 * row (flat worker, department, or department-worker) must call this
 * FIRST, with the caller-supplied `agentAddress` — throws 403 if that
 * address is itself a row in sub_agents (i.e. a worker or department
 * trying to spawn further children), regardless of its `kind` or
 * status. A real top-level agent's address never appears in sub_agents
 * at all, so this only ever fires on the case it's meant to catch.
 */
export function assertCanSpawnSubAgents(callerAddress: string): void {
  const row = db.prepare(`SELECT kind FROM sub_agents WHERE id = ?`).get(callerAddress) as
    | { kind: string }
    | undefined;
  if (row) {
    audit(
      { caller: callerAddress, resourceType: "subagent", resourceId: callerAddress, action: "manage" },
      "deny",
      "no-capability",
    );
    throw Object.assign(
      new Error(
        `${callerAddress} is itself a ${row.kind} (not a top-level agent) and cannot spawn further sub-agents — depth is capped at Agent → Department → Worker`,
      ),
      { status: 403 },
    );
  }
}

/**
 * Exported for subagents.ts / departments.ts, which need the same
 * transitive "does this caller ultimately control this sub_agents row"
 * check for direct route ownership (GET/POST .../:id/...), not just for
 * checkCapability()'s internal delegation step.
 */
export { isSubagentOf };

/**
 * Phase 3c (architecture-agent.md §3, closing Phase 1's other original
 * stub): only ever meaningful for resourceType === "channel" — every
 * other resourceType's resourceId never parses into this function's own
 * "{peerAddress}:{scope}" convention (mirroring ownerOf()'s "office_path"
 * case's own "{agentId}:{relPath}" split above), so this returns null
 * on those without a channels query ever running for them. `action` is
 * accepted (matching this function's own call shape at checkCapability's
 * step 3, unchanged since Phase 1) but deliberately unused: a channel
 * grant is scoped by `scope` (file_transfer/joint_project/payment), not
 * by CapabilityAction — 3d/3e/3f's own capabilities each check a single
 * fixed scope for whatever action they perform, so there is no
 * action-level distinction for a channel grant to make.
 *
 * A channel is bidirectional once active — either the proposer or the
 * recipient may be the caller, with the other party as resourceOwner —
 * per 3b's own revoke_channel design note (permission is symmetric
 * across both parties once a channel exists) and §3's own business-
 * channel model (both sides send_file/join_project once accepted, not
 * only the original proposer).
 */
function parseChannelResource(resourceId: string): { peerAddress: string; scope: string } | null {
  const idx = resourceId.indexOf(":");
  if (idx === -1) return null;
  return { peerAddress: resourceId.slice(0, idx), scope: resourceId.slice(idx + 1) };
}

function findActiveChannelGrant(
  caller: string,
  resourceType: ResourceType,
  resourceId: string,
  _action: CapabilityAction,
): { id: string } | null {
  if (resourceType !== "channel") return null;
  const parsed = parseChannelResource(resourceId);
  if (!parsed) return null;
  const { peerAddress, scope } = parsed;

  // Only status = 'active' ever matches — a still-'proposed' channel
  // (accepted by no one yet) and a 'revoked' one (torn down, per 3b)
  // must both resolve to no grant, the same fail-closed posture every
  // other ownerOf() case in this file already takes on a row that
  // exists but doesn't authorize the caller. ORDER BY resolved_at DESC
  // + LIMIT 1 is a defensive tie-break, not a claim that only one such
  // row can ever exist — propose_channel (3a) places no check against
  // a second concurrent proposal for the same (proposer, recipient,
  // scope) triple, so more than one could in principle reach 'active'
  // (e.g. two independent proposals, each accepted before the other
  // existed). Picking the most-recently-resolved one is an arbitrary
  // but stable choice for that edge case, not a correctness
  // requirement this function depends on.
  const row = db
    .prepare(
      `SELECT id FROM channels
       WHERE status = 'active'
         AND scope = ?
         AND (
           (proposer_address = ? AND recipient_address = ?)
           OR (proposer_address = ? AND recipient_address = ?)
         )
       ORDER BY resolved_at DESC
       LIMIT 1`,
    )
    .get(scope, caller, peerAddress, peerAddress, caller) as { id: string } | undefined;
  return row ? { id: row.id } : null;
}

/**
 * The one function every route that touches disk, Docker, or wallet
 * should call before doing the thing. Throws (never returns false) on
 * denial, matching requireOwnedSandbox()'s existing throw-based
 * contract, so this is a drop-in replacement at every call site.
 */
function checkBudgetAndEnvironment(check: CapabilityCheck): void {
  // Phase 2g (architecture-agent.md §4g): a call that passes Tool+Scope
  // (steps 1-3 above) must still fail if it's over budget or targets the
  // wrong environment — a correctly-owned, correctly-scoped call is not
  // enough on its own once a grant carries these dimensions too. Both
  // checks are opt-in per-call (see CapabilityCheck's own doc comment):
  // a field left undefined skips its check rather than being treated as
  // an automatic failure, so pre-2g callers that never pass either field
  // are completely unaffected by this function existing.
  if (check.budget) {
    const { limit, spent, unit } = check.budget;
    if (spent > limit) {
      audit(check, "deny", "over-budget");
      throw Object.assign(
        new Error(
          `${check.caller} is over budget for ${check.resourceType}:${check.resourceId} — spent ${spent} of ${limit} ${unit}`,
        ),
        { status: 429 },
      );
    }
  }
  if (check.environment !== undefined && check.grantedEnvironment !== undefined) {
    if (check.environment !== check.grantedEnvironment) {
      audit(check, "deny", "wrong-environment");
      throw Object.assign(
        new Error(
          `${check.caller}'s grant for ${check.resourceType}:${check.resourceId} authorizes environment ` +
            `"${check.grantedEnvironment}", not "${check.environment}"`,
        ),
        { status: 403 },
      );
    }
  }
}

export function checkCapability(check: CapabilityCheck): void {
  // 0. Marketplace listings are a shared, public resource by design,
  // not an owned one — every agent lists on the same one marketplace,
  // free to list, and any agent can buy from any other (see
  // marketplace.ts's own module doc: "any agent, yours or not, can
  // discover a listing and pay to invoke it" — the Etsy model, not a
  // walled garden). There is no per-listing buyer allowlist today, so
  // this branch exists to give /:id/invoke a real, audited
  // capability_audit row for every call (who invoked what listing) and
  // a single enforcement point a future per-listing restriction could
  // tighten, not to gate access now. Existence + active is the only
  // bar — same 404-vs-403 split as everything below, just with no 403
  // case yet, since nothing today makes a listing non-public once it
  // exists.
  if (check.resourceType === "marketplace_listing") {
    const { notFound } = ownerOf(check.resourceType, check.resourceId);
    if (notFound) {
      audit(check, "deny", "no-capability");
      throw Object.assign(new Error(`marketplace_listing not found: ${check.resourceId}`), { status: 404 });
    }
    checkBudgetAndEnvironment(check);
    audit(check, "allow", "public-listing");
    return;
  }

  // 1. Direct ownership — the fast, common path. This is
  // requireOwnedSandbox(), generalized to every resource type.
  const { owner, notFound } = ownerOf(check.resourceType, check.resourceId);
  if (owner !== null && owner === check.caller) {
    checkBudgetAndEnvironment(check);
    audit(check, "allow", "owner");
    return;
  }

  // 2. Delegated ownership — sub-agents acting under a parent's identity.
  // Never applies to channels (a channel grant is never inherited by a
  // sub-agent just because its parent holds one — see architecture-agent.md §8).
  if (check.resourceType !== "channel" && isSubagentOf(check.caller, owner)) {
    checkBudgetAndEnvironment(check);
    audit(check, "allow", "parent-delegation");
    return;
  }

  // 3. Grant via an active channel — the only way cross-office access
  // is ever legal. Phase 3c: real for resourceType "channel" (a channel
  // between caller and the resourceId's encoded peer, active, with
  // scope covering the resourceId's encoded scope); every other
  // resourceType misses cleanly, no query executed for it.
  const grant = findActiveChannelGrant(check.caller, check.resourceType, check.resourceId, check.action);
  if (grant) {
    checkBudgetAndEnvironment(check);
    audit(check, "allow", `channel:${grant.id}`);
    return;
  }

  // 4. Default deny — always, no exceptions, always logged. Preserves
  // requireOwnedSandbox()'s original 404-vs-403 split: a resource that
  // doesn't exist at all reads as 404 (not found), one that exists but
  // belongs to someone else reads as 403 (forbidden) — same as before
  // this was generalized.
  audit(check, "deny", "no-capability");
  throw Object.assign(
    new Error(
      notFound
        ? `${check.resourceType} not found: ${check.resourceId}`
        : `${check.caller} has no capability for ${check.resourceType}:${check.resourceId}`,
    ),
    { status: notFound ? 404 : 403 },
  );
}

/**
 * Phase 5f (architecture-agent.md §6, closing Phase 5): "The only entity
 * allowed to force-open a vault (e.g., for a legal/security incident) —
 * and that action should itself be logged to the same trust ledger so
 * it's not a silent backdoor." This is that one path, and it is
 * deliberately NOT routed through checkCapability(): this file's own
 * header comment and §8's own note both already say office/private/
 * (the vault) is never a valid resourceType there — that stays true
 * here too. This isn't a fifth branch bolted onto checkCapability's
 * four-step decision; it's the one root-only bypass architecture-agent.md
 * §6 names as living outside that system entirely, on purpose — a
 * capability grant is something an agent (or its parent, or a channel
 * peer) can hold, and nobody ever holds a grant over their own vault
 * being forced open by someone else.
 *
 * What keeps a bypass from being a backdoor is that it can never be
 * silent. Every call writes to the exact same capability_audit table
 * every other capability decision already lands in — same six columns,
 * same shape — so this phase's own "Done when" requirement
 * ("indistinguishable in shape from any other logged decision except
 * for its own distinct reason code") is true by construction, not by a
 * convention this function has to remember to follow. `reason` always
 * starts with `vault-override:` (the one prefix in this file no other
 * path ever produces) and always carries the caller-supplied
 * justification verbatim — not just a short symbolic tag like every
 * other reason value here uses — so "who opened this vault, and why"
 * is answerable from the audit row alone, with no separate incident
 * ticket required to make the row meaningful. A missing caller or a
 * blank justification is refused outright, before any file is ever
 * read: an incident-response path that will accept an unnamed operator
 * or an empty reason is exactly the silent bypass this function exists
 * not to be.
 *
 * `caller` is the operator's own identifier (an incident ticket id, an
 * on-call handle — whatever the invoking operator supplies), never a
 * fixed "orchestrator:root" the way orchestrator.ts's spawn/kill audit
 * rows are: those have no human to name (routine, automatable actions
 * gated only by the shared x-admin-key), while a vault override is the
 * one root action where naming the specific human responsible is the
 * entire point.
 *
 * Reads only — office/private/ is never written here, and callers
 * should treat what comes back as read-only incident evidence, not
 * something to hand back to the agent whose vault it came from.
 */
export interface VaultFile {
  name: string;
  contents: string;
}

export interface VaultOverrideResult {
  agentAddress: string;
  files: VaultFile[];
  auditedAt: number;
}

export function forceOpenVault(caller: string, agentAddress: string, justification: string): VaultOverrideResult {
  if (!caller || !caller.trim()) {
    throw Object.assign(new Error("forceOpenVault requires a caller identifier for the audit trail"), {
      status: 400,
    });
  }
  if (!justification || !justification.trim()) {
    throw Object.assign(
      new Error("forceOpenVault requires a non-empty justification — a blank reason is never logged"),
      { status: 400 },
    );
  }

  const dir = officePrivateDir(agentAddress);
  let entryNames: string[] = [];
  try {
    entryNames = fs.readdirSync(dir).filter((name: string) => fs.statSync(path.join(dir, name)).isFile());
  } catch {
    // No vault directory for this agent yet (never ensureOffice()'d) or
    // genuinely empty — same "nothing there" outcome either way, not an
    // error condition: an incident responder asking to see an empty
    // vault gets an empty list, not a 500. The override itself is still
    // audited below regardless of what (if anything) was found.
    entryNames = [];
  }

  const files: VaultFile[] = entryNames.map((name) => ({
    name,
    contents: fs.readFileSync(path.join(dir, name), "utf8"),
  }));

  const auditedAt = Date.now();
  db.prepare(
    `INSERT INTO capability_audit (caller, resource_type, resource_id, action, decision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(caller, "vault", agentAddress, "read", "allow", `vault-override:${justification}`, auditedAt);

  return { agentAddress, files, auditedAt };
}

/**
 * Convenience wrapper matching the exact call shape requireOwnedSandbox()
 * had — checkCapability({ resourceType: 'sandbox', ... }) with an
 * 'exec' action, since that's what every existing sandbox check was
 * really gating (own the sandbox → allowed to run something in it /
 * manage it). Kept so vmService.ts's and ptyRoutes.ts's diffs are a
 * pure rename at each call site rather than needing to hand-pick an
 * action per call.
 */
export function requireOwnedSandbox(sandboxId: string, agentAddress: string): void {
  checkCapability({
    caller: agentAddress,
    resourceType: "sandbox",
    resourceId: sandboxId,
    action: "exec",
  });
}
