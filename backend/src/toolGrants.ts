/**
 * next-phase.md Phase 2i(d) — grant lifecycle enforcement
 * (architecture-agent.md §9)
 *
 * Phase 2i(b)'s `granted_tools` column is a flat JSON array of tool
 * NAMES, snapshotted once at creation time onto `agents`/`sub_agents`.
 * That answers "what is this holder currently entitled to" but has no
 * per-grant identity to hang a teardown trigger off of — you can't
 * revoke "just the browser.open grant" out of that array without
 * touching every other name sitting next to it. This module is what
 * that phase's own migration comment named as the future job: a real
 * one-row-per-grant table (`tool_grants`, db.ts) plus the write path
 * that populates it and the revocation functions the three
 * lifecycle-specific teardown hooks call.
 *
 * Scope, stated precisely: this module governs LIFECYCLE (when a grant
 * stops being active), not AUTHORIZATION (whether a call is allowed
 * right now) — that's still capability.ts/checkGrantedToolCapability's
 * job (Phase 2i(c)). Nothing in this codebase's real dispatch path
 * (agent-runtime's tools.ts) consults `tool_grants.status` yet, the
 * same "still governed by departmentToolProfiles.ts, migrating that is
 * Phase 2i(e)'s job" carve-out every 2i sub-phase before this one has
 * carried forward unchanged. What THIS phase makes true is narrower and
 * real on its own: a `session`/`task`/`project`-lifecycle grant's own
 * row in `tool_grants` flips to `revoked` at the correct, distinct
 * trigger, and a `persistent` grant's row never does.
 *
 * `recordToolGrants()` is called ADDITIVELY at the same four creation
 * call sites that already write `granted_tools` (create_department,
 * spawn_worker, spawn_temp_workers, top-level agent provisioning) — it
 * does not replace that column or change any existing caller's return
 * shape. `lifecycle` is copied from the resolving `tool_registry` row
 * at grant time (ToolGrant.lifecycle, Phase 2i(b)'s own resolved
 * shape) and frozen into the row — a later `tool_registry` edit to that
 * tool's lifecycle value never retroactively changes how an
 * already-issued grant tears down, matching this phase's own
 * deprecation rule ("existing grants already issued are left alone").
 */

import { db } from "./db.js";
import type { ToolGrant } from "./toolRegistry.js";

export type HolderType = "agent" | "sub_agent";
export type GrantLifecycle = "persistent" | "session" | "task" | "project";
export type RevokeReason = "session_closed" | "task_completed" | "project_retired";

export interface ToolGrantRow {
  id: number;
  holderType: HolderType;
  holderId: string;
  toolName: string;
  lifecycle: GrantLifecycle;
  scopeKey: string | null;
  status: "active" | "revoked";
  grantedAt: number;
  revokedAt: number | null;
  revokeReason: RevokeReason | null;
}

interface ToolGrantDbRow {
  id: number;
  holder_type: string;
  holder_id: string;
  tool_name: string;
  lifecycle: string;
  scope_key: string | null;
  status: string;
  granted_at: number;
  revoked_at: number | null;
  revoke_reason: string | null;
}

function fromDbRow(row: ToolGrantDbRow): ToolGrantRow {
  return {
    id: row.id,
    holderType: row.holder_type as HolderType,
    holderId: row.holder_id,
    toolName: row.tool_name,
    lifecycle: row.lifecycle as GrantLifecycle,
    scopeKey: row.scope_key,
    status: row.status as "active" | "revoked",
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason as RevokeReason | null,
  };
}

/**
 * Project-lifecycle scope key convention, shared with capability.ts's
 * resolveScopeResource() (Phase 2i(c)) for the same `assigned_project`
 * shape — a project has no id space of its own besides its owning
 * department plus its free-text project_id tag, so both call sites join
 * them the same way rather than inventing a second convention.
 */
export function projectScopeKey(departmentId: string, projectId: string): string {
  return `${departmentId}:${projectId}`;
}

/**
 * Records one `tool_grants` row per granted tool, at creation time,
 * alongside (never instead of) the existing `granted_tools` JSON
 * snapshot. `scopeKey` should be omitted at pure creation time for a
 * `session`-lifecycle grant (no PTY session exists yet — see
 * attachSessionToGrants() below for when one does) and MUST be provided
 * for a `project`-lifecycle grant, since a project's scope key
 * (departmentId:projectId) is already known at spawn_temp_workers time.
 * A `task`-lifecycle grant's scope key defaults to holderId itself
 * (see this file's module doc) if not passed explicitly.
 *
 * Zent.md Phase 16d: a `persistent`-lifecycle grant is left NULL by
 * default (this file's own header: "never looked up by any teardown
 * hook") because most persistent grants are the unscoped default set
 * assignTools() resolves — nothing to narrow. 16d's own case is the
 * exception: "supplier-to-sibling gets an additional grant to call the
 * sibling's marketplace listing" is a persistent grant that IS scoped,
 * to one specific listing id, for as long as Agent B exists. Rather
 * than give "persistent" a second, conflicting meaning, a caller opts
 * in per tool name via `persistentScopeKeys` — every other persistent
 * grant in the same call (the unscoped default set) is untouched,
 * still NULL, exactly as before this option existed.
 */
export function recordToolGrants(
  holderType: HolderType,
  holderId: string,
  grants: ToolGrant[],
  options?: { projectScopeKey?: string; persistentScopeKeys?: Record<string, string> },
): void {
  if (grants.length === 0) return;
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO tool_grants (holder_type, holder_id, tool_name, lifecycle, scope_key, status, granted_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  );
  const insertMany = db.transaction((rows: ToolGrant[]) => {
    for (const g of rows) {
      const lifecycle = g.lifecycle as GrantLifecycle;
      let scopeKey: string | null = null;
      if (lifecycle === "task") {
        scopeKey = holderId;
      } else if (lifecycle === "project") {
        // Required at spawn_temp_workers time (Phase 2b's projectId is
        // known before any worker row is even inserted) — if a caller
        // omits it for a project-lifecycle grant that's a real bug at
        // the call site, not something to paper over with a guess, so
        // this intentionally leaves scopeKey null rather than fabricate
        // one; retireProjectSequence()'s revocation query below simply
        // won't find rows it should have, which is the loud failure
        // mode, not a silent wrong-teardown one.
        scopeKey = options?.projectScopeKey ?? null;
      } else if (lifecycle === "persistent" && options?.persistentScopeKeys?.[g.name]) {
        // 16d's own case — see this function's header. Every other
        // persistent grant in this same call (no entry for its name in
        // the map) falls through unchanged to the NULL below.
        scopeKey = options.persistentScopeKeys[g.name];
      }
      // session: left NULL here by design — see attachSessionToGrants().
      // persistent (no matching persistentScopeKeys entry): left NULL —
      // never looked up by any teardown hook.
      insert.run(holderType, holderId, g.name, lifecycle, scopeKey, now);
    }
  });
  insertMany(grants);
}

/**
 * Called once a PTY session actually exists for a holder (subagents.ts's
 * POST /:id/pty, ptyService.ts's createSession() call site) — fills in
 * the scope_key that couldn't be known at grant-creation time (no
 * session existed yet) for every still-active session-lifecycle grant
 * this holder has. Idempotent and safe to call even if this holder has
 * no session-lifecycle grants at all (e.g. a Marketing department that
 * was never granted browser.open) — affects zero rows in that case.
 */
export function attachSessionToGrants(holderId: string, ptySessionId: string): void {
  db.prepare(
    `UPDATE tool_grants SET scope_key = ? WHERE holder_id = ? AND lifecycle = 'session' AND status = 'active' AND scope_key IS NULL`,
  ).run(ptySessionId, holderId);
}

/**
 * Session-lifecycle teardown: "a session-lifecycle grant (e.g.
 * browser.open) is revoked when its PTY/browser session ends." Called
 * from ptyService.ts's closeSession() — the one function every
 * session-close path in this codebase already funnels through (explicit
 * /kill, idle-timeout sweep, retireProjectSequence()'s own step 4/5, a
 * stream 'end' event) — so this hook fires no matter which of those
 * paths actually closed the session, rather than needing to be wired
 * into each one separately.
 */
export function revokeGrantsBySession(ptySessionId: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE tool_grants SET status = 'revoked', revoked_at = ?, revoke_reason = 'session_closed'
     WHERE lifecycle = 'session' AND scope_key = ? AND status = 'active'`,
  ).run(now, ptySessionId);
}

/**
 * Task-lifecycle teardown: "a task-lifecycle grant expires when
 * subagent_result/mark_task_complete fires." Both of those ACTIONs
 * (toolRegistrySeedData.ts) resolve to the same real route in this
 * codebase — subagents.ts's POST /:id/result, the point at which a
 * Worker's own sub_agents row transitions out of 'running' — so that
 * route is this function's one real caller. Scoped to the holder
 * itself: a task-lifecycle grant's scope_key IS its holder_id (see
 * module doc), so this revokes every still-active task-lifecycle grant
 * that specific worker/temp-worker holds, without touching any
 * sibling's grants of the same tool name.
 */
export function revokeGrantsByTask(holderId: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE tool_grants SET status = 'revoked', revoked_at = ?, revoke_reason = 'task_completed'
     WHERE lifecycle = 'task' AND holder_id = ? AND status = 'active'`,
  ).run(now, holderId);
}

/**
 * Project-lifecycle teardown: "a project-lifecycle grant is torn down
 * as part of Phase 2h's retire_project() sequence (step 4/5)." Called
 * from departments.ts's retireProjectSequence(), alongside (not instead
 * of) that same function's existing per-worker PTY-close/status-flip
 * work — every project-lifecycle grant tagged with this exact
 * department+project pair is revoked in one statement, regardless of
 * which individual worker row it was originally issued to, since a
 * project-lifecycle grant's scope is the PROJECT, not any one worker
 * inside it (a temp worker added to an already-running project via a
 * second spawn_temp_workers call gets the same scope_key as the first
 * batch, so one retirement call closes all of them together).
 */
export function revokeGrantsByProject(departmentId: string, projectId: string): void {
  const now = Date.now();
  db.prepare(
    `UPDATE tool_grants SET status = 'revoked', revoked_at = ?, revoke_reason = 'project_retired'
     WHERE lifecycle = 'project' AND scope_key = ? AND status = 'active'`,
  ).run(now, projectScopeKey(departmentId, projectId));
}

/**
 * Read-back helper: still-active grants for a holder, for introspection
 * or a future dispatch-time check to consult — not called from any real
 * dispatch path yet (see module doc's scope note), but exposed now so a
 * caller doesn't have to hand-write this WHERE clause a second time.
 */
export function activeGrantsFor(holderId: string): ToolGrantRow[] {
  const rows = db
    .prepare(`SELECT * FROM tool_grants WHERE holder_id = ? AND status = 'active' ORDER BY id`)
    .all(holderId) as ToolGrantDbRow[];
  return rows.map(fromDbRow);
}

/**
 * next-phase.md Phase 7b — the "make the state that already gets set
 * correctly finally get read" lookup helper this sub-phase's own scope
 * line names. Answers a single, narrow question: has THE MOST RECENT
 * `tool_grants` row for this (holder, tool) pair been revoked?
 *
 * Semantics, stated precisely, since the fail-open-vs-fail-closed choice
 * here matters:
 *   - No row at all for this (holderId, toolName) pair → NOT revoked.
 *     This is the untracked/pre-2i(d) case (a persistent Agent-tier
 *     grant recorded before this table existed, or a holder type this
 *     module was never wired into recordToolGrants() for) — absence of
 *     a row was never a signal of anything under Phase 2i(d)'s own
 *     design ("this phase makes the state that already gets set exist
 *     and tear down correctly, not act on it at dispatch time" — 7b is
 *     what finally acts on it, but only on rows that actually exist).
 *     Treating "no row" as "revoked" would silently deny every call a
 *     holder makes for a tool whose grant simply predates this table.
 *   - Most recent row is 'active' → NOT revoked (the common case).
 *   - Most recent row is 'revoked' → REVOKED. `ORDER BY id DESC LIMIT 1`
 *     rather than checking "does an active row exist" — a holder that
 *     was re-granted the same tool after an earlier grant of it was
 *     revoked (e.g. reassigned to a new project with the same tool)
 *     gets the newer row's status, not a stale positive from the old
 *     one still sitting in the table.
 *
 * Never throws on a missing row — only a real DB failure propagates,
 * same "let a genuine backend error be a 500, not a swallowed false"
 * posture every other lookup in this file already takes.
 */
export function isGrantRevoked(holderId: string, toolName: string): boolean {
  const row = db
    .prepare(
      `SELECT status FROM tool_grants WHERE holder_id = ? AND tool_name = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(holderId, toolName) as { status: string } | undefined;
  return row?.status === "revoked";
}
