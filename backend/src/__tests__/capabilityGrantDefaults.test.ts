// next-phase.md Phase 2i(c) (architecture-agent.md §9, continued from
// Phase 2i(a)/(b)): tests for resolveScopeResource() / resolveBudgetDefault()
// / resolveEnvironmentDefault() — the three pure functions capability.ts
// adds to turn a tool_registry grant's own declared scopeTemplate/cost/
// lifecycle into checkCapability()'s resourceType/resourceId/budget/
// environment fields, per this phase's "Done when" line ("Phase 2g's
// capability checks are visibly using registry-sourced Budget/Scope/
// Environment defaults instead of per-route hardcoded values").
//
// Run via Node's built-in test runner (`node --test` / `npx tsx --test`),
// same no-test-framework-added convention every prior phase's test file in
// this repo has already established.
//
// NOTE on what this file can and can't exercise in this environment, same
// constraint capability.test.ts's own header already documents: this
// repo's backend/src has no network access to `npm install`
// better-sqlite3, and capability.ts itself imports `./db.js` at module
// load, so it cannot be imported directly here. resolveScopeResource(),
// resolveBudgetDefault(), and resolveEnvironmentDefault() are pure
// functions that touch no table at all (they only branch on strings/
// numbers and build a plain object, or throw) — this file inlines that
// exact logic, kept byte-for-byte in sync with capability.ts's own
// versions (see the comment above each function below), rather than
// importing capability.ts directly. Before deploying, re-run this same
// set of cases through the real exported functions against a live
// checkCapability() call (`npm install && npx tsc && node
// dist/__tests__/capabilityGrantDefaults.test.js`) to confirm the inlined
// copy hasn't drifted from the real implementation.

import { test } from "node:test";
import assert from "node:assert/strict";

type ResourceType =
  | "sandbox"
  | "office_path"
  | "wallet"
  | "channel"
  | "subagent"
  | "browser"
  | "department_budget"
  | "department"
  | "department_quota";

interface CapabilityBudget {
  limit: number;
  spent: number;
  unit: "usd" | "compute" | "calls" | "disk";
}

interface RegistryGrantMetadata {
  scopeTemplate: string;
  lifecycle: string;
  costUnit: "usd" | "compute" | "calls" | "disk";
  costAmountPerCall: number | null;
  costAmountPerUnit: number | null;
  agentTierOnly?: boolean;
}

interface ScopeResolutionContext {
  topLevelAgentAddress: string;
  departmentId?: string;
  projectId?: string;
  environmentId?: string;
}

// Mirrors capability.ts's resolveScopeResource() exactly.
function resolveScopeResource(
  scopeTemplate: string,
  context: ScopeResolutionContext,
): { resourceType: ResourceType; resourceId: string } {
  switch (scopeTemplate) {
    case "company_wide":
      return { resourceType: "wallet", resourceId: context.topLevelAgentAddress };
    case "own_office":
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
      return { resourceType: "department", resourceId: `${context.departmentId}:${context.projectId}` };
    default:
      throw new Error(`resolveScopeResource: unrecognized scopeTemplate "${scopeTemplate}"`);
  }
}

// Mirrors capability.ts's resolveBudgetDefault() exactly.
function resolveBudgetDefault(
  grant: RegistryGrantMetadata,
  options?: { currentSpend?: number; founderCeiling?: number },
): CapabilityBudget | undefined {
  const spent = options?.currentSpend ?? 0;

  if (grant.costAmountPerCall === null && grant.costAmountPerUnit === null) {
    if (grant.agentTierOnly && grant.lifecycle === "persistent" && options?.founderCeiling !== undefined) {
      return { limit: options.founderCeiling, spent, unit: grant.costUnit };
    }
    return undefined;
  }

  const meteredAmount = grant.costAmountPerCall ?? grant.costAmountPerUnit!;
  const limit = options?.founderCeiling ?? meteredAmount;
  return { limit, spent, unit: grant.costUnit };
}

// Mirrors capability.ts's resolveEnvironmentDefault() exactly.
function resolveEnvironmentDefault(scopeTemplate: string, context: ScopeResolutionContext): string | undefined {
  if (scopeTemplate !== "own_container") return undefined;
  return context.environmentId;
}

// Also mirrors ownerOf()'s "department" case's new ":"-split — the part
// of capability.ts's existing switch this phase changes, so a resourceId
// produced by resolveScopeResource()'s "assigned_project" branch resolves
// back to the right department id.
function departmentIdFromResourceId(resourceId: string): string {
  return resourceId.includes(":") ? resourceId.slice(0, resourceId.indexOf(":")) : resourceId;
}

// ── resolveScopeResource ──────────────────────────────────────────────

test("resolveScopeResource: company_wide resolves to the agent's own wallet resource", () => {
  assert.deepEqual(resolveScopeResource("company_wide", { topLevelAgentAddress: "agent_1" }), {
    resourceType: "wallet",
    resourceId: "agent_1",
  });
});

test("resolveScopeResource: own_office resolves to office_path keyed by the top-level agent", () => {
  assert.deepEqual(resolveScopeResource("own_office", { topLevelAgentAddress: "agent_1" }), {
    resourceType: "office_path",
    resourceId: "agent_1",
  });
});

test("resolveScopeResource: own_container resolves to sandbox using the provided environmentId", () => {
  assert.deepEqual(
    resolveScopeResource("own_container", { topLevelAgentAddress: "agent_1", environmentId: "sbx-department-dept_9" }),
    { resourceType: "sandbox", resourceId: "sbx-department-dept_9" },
  );
});

test("resolveScopeResource: own_container throws (never guesses a default) when environmentId is missing", () => {
  assert.throws(() => resolveScopeResource("own_container", { topLevelAgentAddress: "agent_1" }), /environmentId/);
});

test("resolveScopeResource: assigned_department resolves to department keyed by departmentId", () => {
  assert.deepEqual(
    resolveScopeResource("assigned_department", { topLevelAgentAddress: "agent_1", departmentId: "dept_9" }),
    { resourceType: "department", resourceId: "dept_9" },
  );
});

test("resolveScopeResource: assigned_department throws when departmentId is missing", () => {
  assert.throws(
    () => resolveScopeResource("assigned_department", { topLevelAgentAddress: "agent_1" }),
    /departmentId/,
  );
});

test("resolveScopeResource: assigned_project resolves to department with a ':'-joined departmentId:projectId resourceId", () => {
  assert.deepEqual(
    resolveScopeResource("assigned_project", {
      topLevelAgentAddress: "agent_1",
      departmentId: "dept_9",
      projectId: "falcon-9-launch",
    }),
    { resourceType: "department", resourceId: "dept_9:falcon-9-launch" },
  );
});

test("resolveScopeResource: assigned_project throws when only departmentId is given (projectId missing)", () => {
  assert.throws(
    () => resolveScopeResource("assigned_project", { topLevelAgentAddress: "agent_1", departmentId: "dept_9" }),
    /departmentId.*projectId/,
  );
});

test("resolveScopeResource: assigned_project throws when only projectId is given (departmentId missing)", () => {
  assert.throws(
    () => resolveScopeResource("assigned_project", { topLevelAgentAddress: "agent_1", projectId: "falcon-9-launch" }),
    /departmentId.*projectId/,
  );
});

test("resolveScopeResource: an unrecognized scopeTemplate throws rather than falling back to any resource", () => {
  assert.throws(
    () => resolveScopeResource("company_wide_but_typo", { topLevelAgentAddress: "agent_1" }),
    /unrecognized scopeTemplate/,
  );
});

test("resolveScopeResource: assigned_project's ':'-joined resourceId round-trips through the department ownerOf() split", () => {
  const { resourceId } = resolveScopeResource("assigned_project", {
    topLevelAgentAddress: "agent_1",
    departmentId: "dept_9",
    projectId: "falcon-9-launch",
  });
  assert.equal(departmentIdFromResourceId(resourceId), "dept_9");
});

test("department id extraction leaves a plain (non-project) department resourceId untouched", () => {
  assert.equal(departmentIdFromResourceId("dept_9"), "dept_9");
});

// ── resolveBudgetDefault ──────────────────────────────────────────────

const unmeteredDeptRow: RegistryGrantMetadata = {
  scopeTemplate: "assigned_department",
  lifecycle: "persistent",
  costUnit: "compute",
  costAmountPerCall: null,
  costAmountPerUnit: null,
};

test("resolveBudgetDefault: an unmetered Department-Agent/Worker grant skips the budget dimension entirely (undefined, never limit:0)", () => {
  assert.equal(resolveBudgetDefault(unmeteredDeptRow), undefined);
});

test("resolveBudgetDefault: an unmetered grant still skips the dimension even with currentSpend passed (no limit to compare it against)", () => {
  assert.equal(resolveBudgetDefault(unmeteredDeptRow, { currentSpend: 3 }), undefined);
});

const unmeteredAgentRow: RegistryGrantMetadata = {
  scopeTemplate: "company_wide",
  lifecycle: "persistent",
  costUnit: "usd",
  costAmountPerCall: null,
  costAmountPerUnit: null,
  agentTierOnly: true,
};

test("resolveBudgetDefault: an unmetered persistent Agent-tier grant gets no ceiling unless the Founder sets one explicitly", () => {
  assert.equal(resolveBudgetDefault(unmeteredAgentRow), undefined);
});

test("resolveBudgetDefault: an unmetered persistent Agent-tier grant respects an explicit founderCeiling when one is passed", () => {
  assert.deepEqual(resolveBudgetDefault(unmeteredAgentRow, { founderCeiling: 500, currentSpend: 120 }), {
    limit: 500,
    spent: 120,
    unit: "usd",
  });
});

test("resolveBudgetDefault: agentTierOnly with a non-persistent lifecycle does NOT get the Founder-ceiling exception (only persistent does)", () => {
  const sessionAgentRow: RegistryGrantMetadata = { ...unmeteredAgentRow, lifecycle: "session" };
  assert.equal(resolveBudgetDefault(sessionAgentRow, { founderCeiling: 500 }), undefined);
});

const meteredPerCallRow: RegistryGrantMetadata = {
  scopeTemplate: "own_container",
  lifecycle: "task",
  costUnit: "usd",
  costAmountPerCall: 0.05,
  costAmountPerUnit: null,
};

test("resolveBudgetDefault: a metered (costAmountPerCall) grant with no founderCeiling gets a starting allowance sized off its own declared cost", () => {
  assert.deepEqual(resolveBudgetDefault(meteredPerCallRow), { limit: 0.05, spent: 0, unit: "usd" });
});

test("resolveBudgetDefault: a metered grant's own cost is overridden by an explicit founderCeiling when one is passed", () => {
  assert.deepEqual(resolveBudgetDefault(meteredPerCallRow, { founderCeiling: 2, currentSpend: 1.5 }), {
    limit: 2,
    spent: 1.5,
    unit: "usd",
  });
});

const meteredPerUnitRow: RegistryGrantMetadata = {
  scopeTemplate: "own_container",
  lifecycle: "task",
  costUnit: "compute",
  costAmountPerCall: null,
  costAmountPerUnit: 10,
};

test("resolveBudgetDefault: costAmountPerUnit is used as the starting allowance when costAmountPerCall is null", () => {
  assert.deepEqual(resolveBudgetDefault(meteredPerUnitRow), { limit: 10, spent: 0, unit: "compute" });
});

test("resolveBudgetDefault: currentSpend defaults to 0 when omitted", () => {
  const result = resolveBudgetDefault(meteredPerCallRow);
  assert.equal(result?.spent, 0);
});

// ── resolveEnvironmentDefault ─────────────────────────────────────────

test("resolveEnvironmentDefault: own_container returns the provided environmentId", () => {
  assert.equal(
    resolveEnvironmentDefault("own_container", { topLevelAgentAddress: "agent_1", environmentId: "sbx-project-dept_9_falcon-9-launch" }),
    "sbx-project-dept_9_falcon-9-launch",
  );
});

test("resolveEnvironmentDefault: own_container with no environmentId in context returns undefined (skips the dimension, doesn't fabricate one)", () => {
  assert.equal(resolveEnvironmentDefault("own_container", { topLevelAgentAddress: "agent_1" }), undefined);
});

test("resolveEnvironmentDefault: any non-own_container scopeTemplate returns undefined, even if environmentId happens to be set", () => {
  for (const scopeTemplate of ["company_wide", "own_office", "assigned_department", "assigned_project"]) {
    assert.equal(
      resolveEnvironmentDefault(scopeTemplate, { topLevelAgentAddress: "agent_1", environmentId: "sbx-1" }),
      undefined,
      `expected undefined for scopeTemplate "${scopeTemplate}"`,
    );
  }
});

// ── Worker-382, re-run through the real Phase 2i(c) resolvers ─────────
// capability.test.ts's own Worker-382 worked example (a grant of
// { tool: exec, scope: /project-alpha, budget: $2 usd, environment:
// temporary-container-382 }), reconstructed here from a tool_registry-
// shaped grant instead of a hand-built CapabilityCheck, confirming the
// three resolvers above produce the exact same 5-tuple this phase's own
// "Done when" line asks for — registry-sourced defaults standing in for
// what was previously a per-route hardcoded value.

const worker382Grant: RegistryGrantMetadata = {
  scopeTemplate: "assigned_project",
  lifecycle: "task",
  costUnit: "usd",
  costAmountPerCall: 2,
  costAmountPerUnit: null,
};

test("Worker-382 reconstructed from a registry grant: scope resolves to the project-tagged department resource", () => {
  const { resourceType, resourceId } = resolveScopeResource("assigned_project", {
    topLevelAgentAddress: "agent_1",
    departmentId: "dept_backend",
    projectId: "project-alpha",
  });
  assert.equal(resourceType, "department");
  assert.equal(resourceId, "dept_backend:project-alpha");
});

test("Worker-382 reconstructed from a registry grant: budget resolves to a $2 starting allowance from the grant's own declared cost", () => {
  assert.deepEqual(resolveBudgetDefault(worker382Grant, { currentSpend: 1.5 }), {
    limit: 2,
    spent: 1.5,
    unit: "usd",
  });
});

test("Worker-382 reconstructed from a registry grant: environment dimension is skipped for an assigned_project scope (own_container is the only scope that has one)", () => {
  assert.equal(
    resolveEnvironmentDefault("assigned_project", {
      topLevelAgentAddress: "agent_1",
      departmentId: "dept_backend",
      projectId: "project-alpha",
      environmentId: "temporary-container-382",
    }),
    undefined,
  );
});
