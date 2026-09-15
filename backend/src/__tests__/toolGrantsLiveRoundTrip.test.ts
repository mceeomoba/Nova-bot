// next-phase.md Phase 2i(d) (architecture-agent.md §9): the one item
// every "Left undone" / "Not yet done" note in this phase's own section
// named explicitly — a real round trip against a LIVE better-sqlite3
// `tool_registry` + `tool_grants` DB, not the inlined-logic copy
// toolGrants.test.ts uses. Every prior 2i sub-phase (2i(a) through
// 2i(d)) inlined its own decision logic instead of importing db.ts
// directly because `npm install` had no network access in the
// environment those phases were built in. That constraint does not
// hold in this environment (registry.npmjs.org is reachable), so this
// file does the real thing: import the actual db.ts/toolRegistry.ts/
// toolGrants.ts modules, run them against a real temp sqlite file, and
// confirm both structural halves of the deprecation guarantee —
// (a) a deprecated row stops being granted to new callers, and
// (b) an already-issued tool_grants row for that same tool is
// untouched by the deprecation — plus a live pass of all three
// lifecycle-specific revoke triggers and the persistent-survives-all-
// three guarantee, so the whole module is exercised for real at least
// once, not only in the inlined copy.
//
// Isolation: uses its own throwaway `tool_registry` row name
// (`zz.live-roundtrip.*`, never a real §4d/§4e/§4f capability name) and
// its own throwaway holder ids, deleted in this file's own cleanup —
// never touches or depends on the real 304-row seed. DB_PATH points at
// a fresh temp file per run (not `./data/backend.db`), so this can't
// collide with a real dev/prod database either. Config's required env
// vars (BACKEND_API_KEY etc.) are irrelevant to anything this file
// actually exercises (db.ts/toolRegistry.ts/toolGrants.ts never read
// them) but config.ts throws at import time if they're missing, so
// this file sets harmless dummy values before the dynamic import below
// — never overwriting a real value if one is already set in the
// environment this happens to run in.
//
// Uses dynamic import() (not a static top-level `import`) specifically
// so the DB_PATH/dummy-config env vars below are guaranteed to run
// BEFORE db.ts's module-body `new Database(config.dbPath)` call —
// static imports are hoisted ahead of any other top-level code in an
// ES module, which would read `config.dbPath` before this file got a
// chance to set it.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const dbPath = path.join(os.tmpdir(), `automaton-toolgrants-live-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.BACKEND_API_KEY ??= "test-dummy";
process.env.ADMIN_API_KEY ??= "test-dummy";
process.env.OPENROUTER_API_KEY ??= "test-dummy";
process.env.FACILITATOR_PRIVATE_KEY ??= `0x${"1".repeat(64)}`;

const { db } = await import("../db.js");
const { assignTools } = await import("../toolRegistry.js");
const {
  recordToolGrants,
  attachSessionToGrants,
  revokeGrantsBySession,
  revokeGrantsByTask,
  revokeGrantsByProject,
  activeGrantsFor,
  projectScopeKey,
} = await import("../toolGrants.js");

const TASK_TOOL = "zz.live-roundtrip.task-tool";
const SESSION_TOOL = "zz.live-roundtrip.session-tool";
const PROJECT_TOOL = "zz.live-roundtrip.project-tool";
const PERSISTENT_TOOL = "zz.live-roundtrip.persistent-tool";

function seedRow(name: string, lifecycle: string) {
  const now = Date.now();
  db.prepare(`DELETE FROM tool_registry WHERE name = ?`).run(name);
  db.prepare(
    `INSERT INTO tool_registry
      (name, description, input_schema, cost_unit, cost_amount_per_call, cost_amount_per_unit,
       permission_level, department_types, scope_template, lifecycle, deprecated, created_at, updated_at)
     VALUES (?, 'live round-trip test row', '{}', 'calls', 1, null, '["worker"]', null, 'own_office', ?, 0, ?, ?)`,
  ).run(name, lifecycle, now, now);
}

test.after(() => {
  for (const name of [TASK_TOOL, SESSION_TOOL, PROJECT_TOOL, PERSISTENT_TOOL]) {
    db.prepare(`DELETE FROM tool_registry WHERE name = ?`).run(name);
  }
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test("deprecation: assignTools() excludes a deprecated row from a new grant", () => {
  seedRow(TASK_TOOL, "task");
  const before = assignTools("worker").map((g) => g.name);
  assert.ok(before.includes(TASK_TOOL));

  db.prepare(`UPDATE tool_registry SET deprecated = 1 WHERE name = ?`).run(TASK_TOOL);
  const after = assignTools("worker").map((g) => g.name);
  assert.ok(!after.includes(TASK_TOOL));

  db.prepare(`UPDATE tool_registry SET deprecated = 0 WHERE name = ?`).run(TASK_TOOL);
});

test("deprecation: an already-issued tool_grants row survives a later registry deprecation", () => {
  seedRow(TASK_TOOL, "task");
  const holderId = "zz-holder-deprecation";
  const grants = assignTools("worker").filter((g) => g.name === TASK_TOOL);
  assert.equal(grants.length, 1);

  recordToolGrants("sub_agent", holderId, grants);
  const issued = activeGrantsFor(holderId);
  assert.equal(issued.length, 1);
  assert.equal(issued[0].status, "active");

  // The real registry-side event this phase's deprecation guarantee is
  // about: flip the row's `deprecated` flag on the live tool_registry
  // table, same column recordToolGrants() itself never reads.
  db.prepare(`UPDATE tool_registry SET deprecated = 1 WHERE name = ?`).run(TASK_TOOL);

  // (a) a fresh assignTools() call no longer sees it —
  const stillOffered = assignTools("worker").some((g) => g.name === TASK_TOOL);
  assert.equal(stillOffered, false);

  // (b) but the grant already issued before the deprecation is untouched —
  const stillIssued = activeGrantsFor(holderId);
  assert.equal(stillIssued.length, 1);
  assert.equal(stillIssued[0].status, "active");
  assert.equal(stillIssued[0].revokedAt, null);
});

test("task lifecycle: revokeGrantsByTask() revokes live rows scoped to that holder only", () => {
  seedRow(TASK_TOOL, "task");
  const holder = "zz-holder-task";
  const sibling = "zz-holder-task-sibling";
  const grant = assignTools("worker").filter((g) => g.name === TASK_TOOL);

  recordToolGrants("sub_agent", holder, grant);
  recordToolGrants("sub_agent", sibling, grant);

  revokeGrantsByTask(holder);

  assert.equal(activeGrantsFor(holder).length, 0);
  assert.equal(activeGrantsFor(sibling).length, 1);

  // idempotent: calling again on an already-revoked holder is inert
  revokeGrantsByTask(holder);
  assert.equal(activeGrantsFor(holder).length, 0);
});

test("session lifecycle: attachSessionToGrants() then revokeGrantsBySession() against a real DB", () => {
  seedRow(SESSION_TOOL, "session");
  const holder = "zz-holder-session";
  const grant = assignTools("worker").filter((g) => g.name === SESSION_TOOL);
  recordToolGrants("sub_agent", holder, grant);

  // scope_key starts NULL — no session exists yet at grant time.
  const before = db
    .prepare(`SELECT scope_key FROM tool_grants WHERE holder_id = ? AND tool_name = ?`)
    .get(holder, SESSION_TOOL) as { scope_key: string | null };
  assert.equal(before.scope_key, null);

  attachSessionToGrants(holder, "pty-session-live-1");
  const attached = db
    .prepare(`SELECT scope_key FROM tool_grants WHERE holder_id = ? AND tool_name = ?`)
    .get(holder, SESSION_TOOL) as { scope_key: string | null };
  assert.equal(attached.scope_key, "pty-session-live-1");

  revokeGrantsBySession("pty-session-live-1");
  assert.equal(activeGrantsFor(holder).length, 0);
});

test("project lifecycle: revokeGrantsByProject() revokes every worker's grant under that project's scope key in one call", () => {
  seedRow(PROJECT_TOOL, "project");
  const scopeKey = projectScopeKey("dept-live-1", "proj-live-1");
  const grant = assignTools("worker").filter((g) => g.name === PROJECT_TOOL);

  recordToolGrants("sub_agent", "zz-worker-a", grant, { projectScopeKey: scopeKey });
  recordToolGrants("sub_agent", "zz-worker-b", grant, { projectScopeKey: scopeKey });
  // a different project must not be touched
  recordToolGrants("sub_agent", "zz-worker-c", grant, {
    projectScopeKey: projectScopeKey("dept-live-1", "proj-live-OTHER"),
  });

  revokeGrantsByProject("dept-live-1", "proj-live-1");

  assert.equal(activeGrantsFor("zz-worker-a").length, 0);
  assert.equal(activeGrantsFor("zz-worker-b").length, 0);
  assert.equal(activeGrantsFor("zz-worker-c").length, 1);
});

test("persistent grants: none of the three revoke functions touch a persistent-lifecycle row", () => {
  seedRow(PERSISTENT_TOOL, "persistent");
  const holder = "zz-holder-persistent";
  const grant = assignTools("worker").filter((g) => g.name === PERSISTENT_TOOL);
  recordToolGrants("sub_agent", holder, grant);

  revokeGrantsBySession(holder);
  revokeGrantsByTask(holder);
  revokeGrantsByProject(holder, holder);

  assert.equal(activeGrantsFor(holder).length, 1);
});
