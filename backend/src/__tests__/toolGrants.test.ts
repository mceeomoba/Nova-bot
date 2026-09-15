// next-phase.md Phase 2i(d) (architecture-agent.md §9): tests for
// toolGrants.ts — recordToolGrants()/attachSessionToGrants()/
// revokeGrantsBySession()/revokeGrantsByTask()/revokeGrantsByProject(),
// and the deprecation-path guarantee ("existing grants already issued
// are left alone until their own lifecycle ends naturally").
//
// Same no-network-for-`npm install` constraint every prior backend/src
// phase (2f-iii/2f-iv/2g/2h-iv/2i(a)/2i(b)/2i(c)) has already flagged
// and worked around. toolGrants.ts imports `./db.js`, which pulls in
// better-sqlite3 at module load — not installed here — so it can't be
// imported and run against a live DB in this environment. What CAN be
// tested without one is the decision logic itself: this file inlines
// recordToolGrants()'s scope-key assignment and each revoke function's
// exact WHERE-clause shape, operating against a plain in-memory array
// standing in for the tool_grants table, kept byte-for-byte in sync
// with toolGrants.ts's own implementation (see the comment above each
// inlined copy). Before deploying, re-run this same set of cases
// through the real functions against a live sqlite3 DB (`npm install
// && npx tsc && node dist/__tests__/toolGrants.test.js`) to confirm
// this inlined copy hasn't drifted.

import { test } from "node:test";
import assert from "node:assert/strict";

type HolderType = "agent" | "sub_agent";
type GrantLifecycle = "persistent" | "session" | "task" | "project";
type RevokeReason = "session_closed" | "task_completed" | "project_retired";

interface FakeGrantInput {
  name: string;
  lifecycle: GrantLifecycle;
}

interface FakeGrantRow {
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

// Mirrors toolGrants.ts's projectScopeKey() exactly.
function projectScopeKey(departmentId: string, projectId: string): string {
  return `${departmentId}:${projectId}`;
}

// In-memory stand-in for the tool_grants table.
let table: FakeGrantRow[] = [];
let nextId = 1;

// Mirrors toolGrants.ts's recordToolGrants() exactly: task-lifecycle
// scope_key defaults to holderId, project-lifecycle uses the passed
// projectScopeKey (or null if omitted — a real bug at the call site,
// not papered over), session and persistent both start NULL.
function recordToolGrants(
  holderType: HolderType,
  holderId: string,
  grants: FakeGrantInput[],
  options?: { projectScopeKey?: string },
  now = Date.now(),
): void {
  if (grants.length === 0) return;
  for (const g of grants) {
    let scopeKey: string | null = null;
    if (g.lifecycle === "task") {
      scopeKey = holderId;
    } else if (g.lifecycle === "project") {
      scopeKey = options?.projectScopeKey ?? null;
    }
    table.push({
      id: nextId++,
      holderType,
      holderId,
      toolName: g.name,
      lifecycle: g.lifecycle,
      scopeKey,
      status: "active",
      grantedAt: now,
      revokedAt: null,
      revokeReason: null,
    });
  }
}

// Mirrors toolGrants.ts's attachSessionToGrants() exactly: only
// still-active session-lifecycle rows for this holder with a NULL
// scope_key so far.
function attachSessionToGrants(holderId: string, ptySessionId: string): void {
  for (const row of table) {
    if (row.holderId === holderId && row.lifecycle === "session" && row.status === "active" && row.scopeKey === null) {
      row.scopeKey = ptySessionId;
    }
  }
}

function revokeGrantsBySession(ptySessionId: string, now = Date.now()): void {
  for (const row of table) {
    if (row.lifecycle === "session" && row.scopeKey === ptySessionId && row.status === "active") {
      row.status = "revoked";
      row.revokedAt = now;
      row.revokeReason = "session_closed";
    }
  }
}

function revokeGrantsByTask(holderId: string, now = Date.now()): void {
  for (const row of table) {
    if (row.lifecycle === "task" && row.holderId === holderId && row.status === "active") {
      row.status = "revoked";
      row.revokedAt = now;
      row.revokeReason = "task_completed";
    }
  }
}

function revokeGrantsByProject(departmentId: string, projectId: string, now = Date.now()): void {
  const key = projectScopeKey(departmentId, projectId);
  for (const row of table) {
    if (row.lifecycle === "project" && row.scopeKey === key && row.status === "active") {
      row.status = "revoked";
      row.revokedAt = now;
      row.revokeReason = "project_retired";
    }
  }
}

function reset() {
  table = [];
  nextId = 1;
}

// --- recordToolGrants() scope-key assignment ---

test("recordToolGrants: task-lifecycle scope_key defaults to holderId", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "exec", lifecycle: "task" }]);
  assert.equal(table[0].scopeKey, "wkr_1");
});

test("recordToolGrants: session-lifecycle scope_key starts NULL", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "browser.open", lifecycle: "session" }]);
  assert.equal(table[0].scopeKey, null);
});

test("recordToolGrants: persistent-lifecycle scope_key stays NULL", () => {
  reset();
  recordToolGrants("agent", "0xAgent", [{ name: "create_department", lifecycle: "persistent" }]);
  assert.equal(table[0].scopeKey, null);
});

test("recordToolGrants: project-lifecycle scope_key uses the joined department:project key", () => {
  reset();
  recordToolGrants(
    "sub_agent",
    "wkr_1",
    [{ name: "exec", lifecycle: "project" }],
    { projectScopeKey: projectScopeKey("dept_a", "falcon-9") },
  );
  assert.equal(table[0].scopeKey, "dept_a:falcon-9");
});

test("recordToolGrants: project-lifecycle with no projectScopeKey passed leaves scope_key null (loud failure, not a guess)", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "exec", lifecycle: "project" }]);
  assert.equal(table[0].scopeKey, null);
});

test("recordToolGrants: no-op on an empty grants array", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", []);
  assert.equal(table.length, 0);
});

test("recordToolGrants: mixed-lifecycle batch assigns each row's scope_key independently", () => {
  reset();
  recordToolGrants(
    "sub_agent",
    "wkr_1",
    [
      { name: "exec", lifecycle: "task" },
      { name: "browser.open", lifecycle: "session" },
      { name: "department.terminal", lifecycle: "project" },
    ],
    { projectScopeKey: projectScopeKey("dept_a", "falcon-9") },
  );
  const byName = Object.fromEntries(table.map((r) => [r.toolName, r]));
  assert.equal(byName["exec"].scopeKey, "wkr_1");
  assert.equal(byName["browser.open"].scopeKey, null);
  assert.equal(byName["department.terminal"].scopeKey, "dept_a:falcon-9");
});

// --- session-lifecycle teardown ---

test("revokeGrantsBySession: revokes only the matching session's active session-lifecycle grants", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "browser.open", lifecycle: "session" }]);
  recordToolGrants("sub_agent", "wkr_2", [{ name: "browser.open", lifecycle: "session" }]);
  attachSessionToGrants("wkr_1", "pty_aaa");
  attachSessionToGrants("wkr_2", "pty_bbb");

  revokeGrantsBySession("pty_aaa");

  const wkr1Grant = table.find((r) => r.holderId === "wkr_1")!;
  const wkr2Grant = table.find((r) => r.holderId === "wkr_2")!;
  assert.equal(wkr1Grant.status, "revoked");
  assert.equal(wkr1Grant.revokeReason, "session_closed");
  assert.equal(wkr2Grant.status, "active");
});

test("revokeGrantsBySession: never touches a task/project/persistent-lifecycle row even if scope_key happened to collide", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "exec", lifecycle: "task" }]);
  // Force a coincidental scope_key collision to prove lifecycle, not
  // just scope_key, gates the match.
  table[0].scopeKey = "pty_aaa";

  revokeGrantsBySession("pty_aaa");

  assert.equal(table[0].status, "active");
});

test("revokeGrantsBySession: a session-lifecycle grant with no session yet (scope_key still null) is untouched by any close", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "browser.open", lifecycle: "session" }]);
  // No attachSessionToGrants() call — this worker never actually
  // created a PTY session before being torn down some other way.
  revokeGrantsBySession("pty_never_existed");
  assert.equal(table[0].status, "active");
});

test("revokeGrantsBySession: calling it twice for the same session is idempotent (second call is a no-op, not an error)", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "browser.open", lifecycle: "session" }]);
  attachSessionToGrants("wkr_1", "pty_aaa");
  revokeGrantsBySession("pty_aaa", 1000);
  revokeGrantsBySession("pty_aaa", 2000);
  assert.equal(table[0].status, "revoked");
  assert.equal(table[0].revokedAt, 1000); // untouched by the second call
});

// --- task-lifecycle teardown ---

test("revokeGrantsByTask: revokes only this holder's own task-lifecycle grants, never a sibling worker's", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "exec", lifecycle: "task" }]);
  recordToolGrants("sub_agent", "wkr_2", [{ name: "exec", lifecycle: "task" }]);

  revokeGrantsByTask("wkr_1");

  assert.equal(table.find((r) => r.holderId === "wkr_1")!.status, "revoked");
  assert.equal(table.find((r) => r.holderId === "wkr_2")!.status, "active");
});

test("revokeGrantsByTask: leaves this same holder's session/project-lifecycle grants untouched", () => {
  reset();
  recordToolGrants(
    "sub_agent",
    "wkr_1",
    [
      { name: "exec", lifecycle: "task" },
      { name: "browser.open", lifecycle: "session" },
      { name: "department.terminal", lifecycle: "project" },
    ],
    { projectScopeKey: "dept_a:falcon-9" },
  );

  revokeGrantsByTask("wkr_1");

  const byName = Object.fromEntries(table.map((r) => [r.toolName, r]));
  assert.equal(byName["exec"].status, "revoked");
  assert.equal(byName["browser.open"].status, "active");
  assert.equal(byName["department.terminal"].status, "active");
});

test("revokeGrantsByTask: fires the same way regardless of whether the task succeeded or failed (caller's job, not this function's)", () => {
  // subagents.ts's POST /:id/result calls this unconditionally on both
  // finalStatus branches — this function itself takes no status
  // parameter at all, confirming there's nothing here that could
  // special-case one outcome over the other.
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "exec", lifecycle: "task" }]);
  revokeGrantsByTask("wkr_1");
  assert.equal(table[0].status, "revoked");
});

// --- project-lifecycle teardown ---

test("revokeGrantsByProject: revokes every worker's project-lifecycle grant sharing the department+project key, across multiple holders", () => {
  reset();
  const key = projectScopeKey("dept_a", "falcon-9");
  recordToolGrants("sub_agent", "wkr_1", [{ name: "department.terminal", lifecycle: "project" }], {
    projectScopeKey: key,
  });
  recordToolGrants("sub_agent", "wkr_2", [{ name: "department.terminal", lifecycle: "project" }], {
    projectScopeKey: key,
  });

  revokeGrantsByProject("dept_a", "falcon-9");

  assert.equal(table.every((r) => r.status === "revoked"), true);
  assert.equal(table.every((r) => r.revokeReason === "project_retired"), true);
});

test("revokeGrantsByProject: never touches a different project's grants under the same department", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "department.terminal", lifecycle: "project" }], {
    projectScopeKey: projectScopeKey("dept_a", "falcon-9"),
  });
  recordToolGrants("sub_agent", "wkr_2", [{ name: "department.terminal", lifecycle: "project" }], {
    projectScopeKey: projectScopeKey("dept_a", "starship-orbital"),
  });

  revokeGrantsByProject("dept_a", "falcon-9");

  assert.equal(table.find((r) => r.holderId === "wkr_1")!.status, "revoked");
  assert.equal(table.find((r) => r.holderId === "wkr_2")!.status, "active");
});

test("revokeGrantsByProject: never touches the same projectId under a different department", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "department.terminal", lifecycle: "project" }], {
    projectScopeKey: projectScopeKey("dept_a", "falcon-9"),
  });
  recordToolGrants("sub_agent", "wkr_2", [{ name: "department.terminal", lifecycle: "project" }], {
    projectScopeKey: projectScopeKey("dept_b", "falcon-9"),
  });

  revokeGrantsByProject("dept_a", "falcon-9");

  assert.equal(table.find((r) => r.holderId === "wkr_1")!.status, "revoked");
  assert.equal(table.find((r) => r.holderId === "wkr_2")!.status, "active");
});

test("revokeGrantsByProject: leaves each worker's own task-lifecycle grant alone (dies via revokeGrantsByTask if at all)", () => {
  reset();
  const key = projectScopeKey("dept_a", "falcon-9");
  recordToolGrants(
    "sub_agent",
    "wkr_1",
    [
      { name: "exec", lifecycle: "task" },
      { name: "department.terminal", lifecycle: "project" },
    ],
    { projectScopeKey: key },
  );

  revokeGrantsByProject("dept_a", "falcon-9");

  const byName = Object.fromEntries(table.map((r) => [r.toolName, r]));
  assert.equal(byName["exec"].status, "active");
  assert.equal(byName["department.terminal"].status, "revoked");
});

test("revokeGrantsByProject: a second (idempotent) retirement call against an already-retired project is inert, not an error", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "department.terminal", lifecycle: "project" }], {
    projectScopeKey: projectScopeKey("dept_a", "falcon-9"),
  });
  revokeGrantsByProject("dept_a", "falcon-9", 1000);
  revokeGrantsByProject("dept_a", "falcon-9", 2000);
  assert.equal(table[0].status, "revoked");
  assert.equal(table[0].revokedAt, 1000);
});

// --- persistent-lifecycle: never auto-expires ---

test("persistent-lifecycle grants are never touched by any of the three revoke functions", () => {
  reset();
  recordToolGrants("agent", "0xAgent", [{ name: "create_department", lifecycle: "persistent" }]);
  revokeGrantsBySession("anything");
  revokeGrantsByTask("0xAgent");
  revokeGrantsByProject("dept_a", "falcon-9");
  assert.equal(table[0].status, "active");
});

// --- cross-holder isolation across all three trigger types at once ---

test("cross-holder isolation: revoking one worker's grants of every lifecycle never revokes a sibling's grants of the same tool names", () => {
  reset();
  const key = projectScopeKey("dept_a", "falcon-9");
  const grants: FakeGrantInput[] = [
    { name: "exec", lifecycle: "task" },
    { name: "browser.open", lifecycle: "session" },
    { name: "department.terminal", lifecycle: "project" },
  ];
  recordToolGrants("sub_agent", "wkr_1", grants, { projectScopeKey: key });
  recordToolGrants("sub_agent", "wkr_2", grants, { projectScopeKey: key });
  attachSessionToGrants("wkr_1", "pty_aaa");
  attachSessionToGrants("wkr_2", "pty_bbb");

  revokeGrantsBySession("pty_aaa");
  revokeGrantsByTask("wkr_1");

  const wkr1 = table.filter((r) => r.holderId === "wkr_1");
  const wkr2 = table.filter((r) => r.holderId === "wkr_2");
  assert.equal(wkr1.find((r) => r.toolName === "exec")!.status, "revoked");
  assert.equal(wkr1.find((r) => r.toolName === "browser.open")!.status, "revoked");
  // wkr_1's project-lifecycle grant is untouched — no retire_project()
  // call happened in this test, only session+task triggers fired.
  assert.equal(wkr1.find((r) => r.toolName === "department.terminal")!.status, "active");
  // wkr_2 shares the same tool names and the same project scope_key
  // but never had its own session or task revocation fired.
  assert.equal(wkr2.every((r) => r.status === "active"), true);
});

// --- deprecation path: assign_tools()'s existing deprecated=0 filter
// already keeps a deprecated row out of any NEW grant (Phase 2i(b)),
// so the only new guarantee this phase adds is the other half: an
// ALREADY-ISSUED grant is untouched by a later deprecation. That's a
// property of what does NOT happen to tool_grants when tool_registry
// changes — confirmed here by showing no function in this module ever
// reads tool_registry.deprecated at all, so there is no code path by
// which flipping that flag could reach an existing tool_grants row.

test("deprecation path: an already-issued grant's row is untouched by nothing in this module ever consulting deprecated status", () => {
  reset();
  recordToolGrants("sub_agent", "wkr_1", [{ name: "legacy_tool", lifecycle: "task" }]);
  const before = { ...table[0] };
  // Simulate "tool_registry.legacy_tool.deprecated flips to true" —
  // there is no analogous field in this in-memory table to flip,
  // because toolGrants.ts's revoke functions take no deprecated flag
  // as input at all (only scope_key/holder_id/lifecycle). Calling every
  // revoke function with irrelevant keys proves none of them have any
  // path that could react to a deprecation flip.
  revokeGrantsBySession("unrelated_session");
  revokeGrantsByTask("unrelated_holder");
  revokeGrantsByProject("unrelated_dept", "unrelated_project");
  assert.deepEqual(table[0], before);
});
