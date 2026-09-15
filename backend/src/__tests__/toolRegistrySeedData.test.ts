/**
 * next-phase.md Phase 2i(a) — tests for toolRegistrySeedData.ts (the
 * §4d/§4e/§4f -> tool_registry row generation, architecture-agent.md §9).
 *
 * Unlike retireProjectSequence.test.ts/capability.test.ts/environment.test.ts,
 * this file imports the real module directly rather than inlining a copy —
 * toolRegistrySeedData.ts has no `db` import and no side effects (that's
 * exactly why it was split out from seedToolRegistry.ts, see that file's
 * own header comment), so it can be exercised in this no-network,
 * no-better-sqlite3 environment the same way departmentToolProfiles.test.ts
 * already imports departmentToolProfiles.ts directly. seedToolRegistry.ts's
 * own DB-write path (the `upsert`/`seed`/`runSeed` plumbing) is NOT covered
 * here for the same reason it isn't covered elsewhere in this repo yet — it
 * needs a live sqlite3 DB to exercise meaningfully; re-run `runSeed()`
 * against a real DB (`npm install && npx tsx src/seedToolRegistry.ts`)
 * before deploying to confirm the writes themselves behave as expected.
 *
 * Run with: node --test (via tsx, same convention as every other test file
 * in this repo — see any sibling test file's own header for the reasoning).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  SEED_ROWS,
  assertNoDuplicateNames,
  type SeedRow,
  type PermissionLevel,
  type ScopeTemplate,
  type Lifecycle,
} from "../toolRegistrySeedData.js";

const VALID_PERMISSION_LEVELS: PermissionLevel[] = ["agent", "department_agent", "worker"];
const VALID_SCOPE_TEMPLATES: ScopeTemplate[] = [
  "own_office",
  "own_container",
  "assigned_department",
  "assigned_project",
  "company_wide",
];
const VALID_LIFECYCLES: Lifecycle[] = ["persistent", "session", "task", "project"];
const VALID_COST_UNITS = ["usd", "compute", "calls", "disk"];
const VALID_DEPARTMENT_TYPES = [
  "software",
  "marketing",
  "finance",
  "security",
  "server",
  "domain",
  // Zent.md Phase 2b: this list had already fallen behind Phase 9a-iii's
  // "domain" addition before this phase touched it — fixed alongside
  // adding "opportunity_intelligence" rather than leaving a second gap
  // next to the one this phase is closing (see toolRegistrySeedData.ts's
  // own DepartmentType union, which this list mirrors).
  "opportunity_intelligence",
  // This list had again fallen behind toolRegistrySeedData.ts's own
  // DepartmentType union, which had already gained "research" and
  // "strategy" for the expansion/research-department work — added here
  // for the same reason "opportunity_intelligence" was above.
  "research",
  "strategy",
];

describe("toolRegistrySeedData: structural validity", () => {
  test("SEED_ROWS is non-empty", () => {
    assert.ok(SEED_ROWS.length > 0, "expected at least one seed row");
  });

  test("no duplicate names — assertNoDuplicateNames does not throw on the real data", () => {
    assert.doesNotThrow(() => assertNoDuplicateNames(SEED_ROWS));
  });

  test("assertNoDuplicateNames DOES throw on a deliberately duplicated list", () => {
    const dupeRow: SeedRow = { ...SEED_ROWS[0] };
    assert.throws(() => assertNoDuplicateNames([dupeRow, { ...dupeRow }]), /duplicate tool_registry name/);
  });

  test("every row has a non-empty name and description", () => {
    for (const row of SEED_ROWS) {
      assert.ok(row.name && row.name.trim().length > 0, `row missing name: ${JSON.stringify(row)}`);
      assert.ok(
        row.description && row.description.trim().length > 0,
        `row "${row.name}" missing description`,
      );
    }
  });

  test("every row's permissionLevel is non-empty and only contains valid tiers", () => {
    for (const row of SEED_ROWS) {
      assert.ok(row.permissionLevel.length > 0, `row "${row.name}" has empty permissionLevel`);
      for (const level of row.permissionLevel) {
        assert.ok(
          VALID_PERMISSION_LEVELS.includes(level),
          `row "${row.name}" has invalid permissionLevel "${level}"`,
        );
      }
    }
  });

  test("every row's scopeTemplate and lifecycle are from the §9 enums", () => {
    for (const row of SEED_ROWS) {
      assert.ok(
        VALID_SCOPE_TEMPLATES.includes(row.scopeTemplate),
        `row "${row.name}" has invalid scopeTemplate "${row.scopeTemplate}"`,
      );
      assert.ok(
        VALID_LIFECYCLES.includes(row.lifecycle),
        `row "${row.name}" has invalid lifecycle "${row.lifecycle}"`,
      );
    }
  });

  test("every row's cost unit is valid, and cost amounts are non-negative when present", () => {
    for (const row of SEED_ROWS) {
      assert.ok(
        VALID_COST_UNITS.includes(row.costUnit),
        `row "${row.name}" has invalid costUnit "${row.costUnit}"`,
      );
      if (row.costAmountPerCall !== undefined) {
        assert.ok(row.costAmountPerCall >= 0, `row "${row.name}" has negative costAmountPerCall`);
      }
      if (row.costAmountPerUnit !== undefined) {
        assert.ok(row.costAmountPerUnit >= 0, `row "${row.name}" has negative costAmountPerUnit`);
      }
    }
  });

  test("every row's departmentTypes, when present, is non-empty and only contains §4e's five types", () => {
    for (const row of SEED_ROWS) {
      if (row.departmentTypes === undefined) continue;
      assert.ok(row.departmentTypes.length > 0, `row "${row.name}" has empty departmentTypes array`);
      for (const type of row.departmentTypes) {
        assert.ok(
          VALID_DEPARTMENT_TYPES.includes(type),
          `row "${row.name}" has invalid departmentType "${type}"`,
        );
      }
    }
  });

  test("inputSchema is always a plain object (JSON-serializable, matches §9's JSONSchema field)", () => {
    for (const row of SEED_ROWS) {
      assert.strictEqual(typeof row.inputSchema, "object");
      assert.doesNotThrow(() => JSON.stringify(row.inputSchema), `row "${row.name}" inputSchema not serializable`);
    }
  });
});

describe("toolRegistrySeedData: §4d Agent-tier rows", () => {
  const agentRows = SEED_ROWS.filter((r) => r.permissionLevel.includes("agent"));

  test("at least one Agent-tier row exists", () => {
    assert.ok(agentRows.length > 0);
  });

  test("no Agent-tier row restricts departmentTypes — §4d authority is not department-scoped", () => {
    for (const row of agentRows) {
      assert.strictEqual(
        row.departmentTypes,
        undefined,
        `Agent-tier row "${row.name}" unexpectedly has departmentTypes set — §4d's authority is company-wide, never department-restricted`,
      );
    }
  });

  test("every Agent-tier row is lifecycle 'persistent' — §4d has no session/task/project-scoped capability", () => {
    for (const row of agentRows) {
      assert.strictEqual(row.lifecycle, "persistent", `Agent-tier row "${row.name}" has non-persistent lifecycle`);
    }
  });

  test("self-improvement rows are Agent-tier ONLY (never delegated, per §4d's own closing note)", () => {
    const selfImprovementNames = [
      "inspect own performance",
      "analyze failures",
      "create new skills",
      "modify internal configuration",
    ];
    for (const name of selfImprovementNames) {
      const row = SEED_ROWS.find((r) => r.name === name);
      assert.ok(row, `expected a seed row for self-improvement capability "${name}"`);
      assert.deepEqual(
        row!.permissionLevel,
        ["agent"],
        `"${name}" should be Agent-tier-only (§4d: "Agent-tier only, never delegated"), got ${JSON.stringify(row!.permissionLevel)}`,
      );
    }
  });

  test("wallet-family Agent rows use cost unit 'usd'", () => {
    const walletRow = SEED_ROWS.find((r) => r.name === "check balance" && r.permissionLevel.includes("agent"));
    assert.ok(walletRow);
    assert.strictEqual(walletRow!.costUnit, "usd");
  });
});

describe("toolRegistrySeedData: §4e Department-Agent-tier rows", () => {
  const deptRows = SEED_ROWS.filter((r) => r.permissionLevel.includes("department_agent"));

  test("at least one Department-Agent-tier row exists", () => {
    assert.ok(deptRows.length > 0);
  });

  test("no Department-Agent row is ever also Agent-tier or Worker-tier — tiers are disjoint per row", () => {
    for (const row of deptRows) {
      assert.ok(
        !row.permissionLevel.includes("agent"),
        `row "${row.name}" is both department_agent and agent — §4c's tiers are meant to be distinct capability sets`,
      );
      assert.ok(
        !row.permissionLevel.includes("worker"),
        `row "${row.name}" is both department_agent and worker`,
      );
    }
  });

  test("§4e's department-type table rows (department.* names) are ALL department_agent-only and departmentTypes-restricted", () => {
    const deptTypedRows = SEED_ROWS.filter((r) => r.name.startsWith("department."));
    assert.ok(deptTypedRows.length > 0, "expected department.* rows from the §4e per-type table");
    for (const row of deptTypedRows) {
      assert.deepEqual(row.permissionLevel, ["department_agent"]);
      assert.ok(row.departmentTypes && row.departmentTypes.length > 0, `"${row.name}" missing departmentTypes`);
      assert.strictEqual(row.scopeTemplate, "assigned_department");
    }
  });

  test("a capability shared by multiple department types (e.g. 'logs') is ONE row listing every owning type, not duplicated", () => {
    const logsRow = SEED_ROWS.find((r) => r.name === "department.logs");
    assert.ok(logsRow, "expected a single 'department.logs' row");
    // §4e's table: logs appears in Software, Security, and Server.
    const types = new Set(logsRow!.departmentTypes);
    assert.ok(types.has("software"), "expected 'software' among department.logs's departmentTypes");
    assert.ok(types.has("security"), "expected 'security' among department.logs's departmentTypes");
    assert.ok(types.has("server"), "expected 'server' among department.logs's departmentTypes");
    const logsRowCount = SEED_ROWS.filter((r) => r.name === "department.logs").length;
    assert.strictEqual(logsRowCount, 1, "expected exactly one 'department.logs' row, not one per department type");
  });

  test("Marketing-only department.* rows never grant an exec/pty-family ACTION (confirms §4e's table survives seeding)", () => {
    const marketingOnlyRows = SEED_ROWS.filter(
      (r) => r.name.startsWith("department.") && r.departmentTypes?.length === 1 && r.departmentTypes[0] === "marketing",
    );
    assert.ok(marketingOnlyRows.length > 0, "expected at least one marketing-only department.* row");
    const execFamily = ["run_command", "pty_create", "pty_write", "pty_read", "pty_close", "pty_list"];
    for (const row of marketingOnlyRows) {
      const actions: string[] = (row.inputSchema as { actions?: string[] }).actions ?? [];
      for (const action of actions) {
        assert.ok(
          !execFamily.includes(action),
          `marketing-only row "${row.name}" unexpectedly grants exec/pty ACTION "${action}"`,
        );
      }
    }
  });
});

describe("toolRegistrySeedData: §4f Worker-tier rows", () => {
  const workerRows = SEED_ROWS.filter((r) => r.permissionLevel.includes("worker"));

  test("at least one Worker-tier row exists", () => {
    assert.ok(workerRows.length > 0);
  });

  test("every Worker-tier row is scoped to own_office/own_container/assigned_project — never company_wide or assigned_department", () => {
    for (const row of workerRows) {
      assert.ok(
        row.scopeTemplate === "own_office" ||
          row.scopeTemplate === "own_container" ||
          row.scopeTemplate === "assigned_project",
        `Worker-tier row "${row.name}" has scopeTemplate "${row.scopeTemplate}" — §4f: "never the department's or company's full infrastructure"`,
      );
    }
  });

  test("no Worker-tier row is lifecycle 'persistent' — §4f's authority is task-scoped, per-task financial access is explicitly non-standing", () => {
    for (const row of workerRows) {
      assert.notStrictEqual(
        row.lifecycle,
        "persistent",
        `Worker-tier row "${row.name}" is persistent — §4f gives Workers no standing/persistent grants`,
      );
    }
  });

  test("the Worker financial-access row is task-lifecycle and usd-denominated, not a standing budget", () => {
    const finRow = SEED_ROWS.find((r) => r.name === "task-scoped external spending allowance");
    assert.ok(finRow, "expected the §4f financial-access row");
    assert.strictEqual(finRow!.lifecycle, "task");
    assert.strictEqual(finRow!.costUnit, "usd");
    assert.deepEqual(finRow!.permissionLevel, ["worker"]);
  });
});

describe("toolRegistrySeedData: cross-tier sanity", () => {
  test("tier row counts roughly match §4d/§4e/§4f's relative sizes (agent has the most bullets, then department, then worker)", () => {
    const counts = { agent: 0, department_agent: 0, worker: 0 };
    for (const row of SEED_ROWS) {
      for (const level of row.permissionLevel) counts[level]++;
    }
    assert.ok(counts.agent > 0 && counts.department_agent > 0 && counts.worker > 0);
    // Not a strict doc-derived assertion (row counts aren't specified by
    // architecture-agent.md itself), just a smoke check that no tier
    // silently ended up empty or wildly disproportionate due to a
    // copy-paste mistake while authoring the row lists.
    assert.ok(counts.agent >= counts.worker, "expected Agent tier (§4d) to have at least as many rows as Worker tier (§4f)");
  });

  test("every row's name is unique across the entire registry, including department.*-prefixed rows", () => {
    const names = SEED_ROWS.map((r) => r.name);
    const unique = new Set(names);
    assert.strictEqual(unique.size, names.length);
  });
});

describe("toolRegistrySeedData: Phase 2i(e) — list_available_tools introspection rows", () => {
  const introspectionRows = SEED_ROWS.filter((r) => r.name.startsWith("list available tools"));

  test("exactly one list_available_tools row per tier, none shared across tiers", () => {
    assert.strictEqual(introspectionRows.length, 3, "expected one row per tier (agent, department_agent, worker)");
    for (const row of introspectionRows) {
      assert.strictEqual(row.permissionLevel.length, 1, `"${row.name}" should be exactly one tier, got ${JSON.stringify(row.permissionLevel)}`);
    }
    const tiers = new Set(introspectionRows.map((r) => r.permissionLevel[0]));
    assert.strictEqual(tiers.size, 3, "expected agent, department_agent, and worker each covered exactly once");
  });

  test("every introspection row declares the list_available_tools runtime ACTION", () => {
    for (const row of introspectionRows) {
      assert.deepEqual(row.inputSchema, { action: "list_available_tools" }, `"${row.name}" should declare the list_available_tools ACTION`);
    }
  });

  test("each tier's introspection row matches that tier's own scope/lifecycle convention, not a fourth one", () => {
    const agentRow = introspectionRows.find((r) => r.permissionLevel[0] === "agent");
    const deptRow = introspectionRows.find((r) => r.permissionLevel[0] === "department_agent");
    const workerRow = introspectionRows.find((r) => r.permissionLevel[0] === "worker");
    assert.ok(agentRow && deptRow && workerRow);

    assert.strictEqual(agentRow!.scopeTemplate, "company_wide");
    assert.strictEqual(agentRow!.lifecycle, "persistent");
    assert.strictEqual(agentRow!.departmentTypes, undefined);

    assert.strictEqual(deptRow!.scopeTemplate, "assigned_department");
    assert.strictEqual(deptRow!.lifecycle, "persistent");
    assert.strictEqual(deptRow!.departmentTypes, undefined, "introspection should be department-type-unrestricted, not locked to one type");

    assert.strictEqual(workerRow!.scopeTemplate, "own_office");
    assert.strictEqual(workerRow!.lifecycle, "task");
    assert.notStrictEqual(workerRow!.lifecycle, "persistent", "Worker-tier rows are never persistent, per §4f — introspection is no exception");
  });
});
