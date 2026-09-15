// next-phase.md Phase 2i(b) (architecture-agent.md §9): tests for
// assignTools()/normalizeDepartmentType() — the resolver that makes
// Phase 2i(a)'s seeded tool_registry table load-bearing for the first
// time.
//
// NOTE on what this file can and can't exercise in this environment:
// same no-network-for-`npm install` constraint every prior backend/src
// phase (2f-iii, 2f-iv, 2g, 2h-iv, 2i(a)) has already flagged and
// worked around. toolRegistry.ts imports `./db.js`, which pulls in
// better-sqlite3 at module load — not installed here — so it cannot be
// imported and run against a live DB in this environment. What CAN be
// tested without a live DB is the decision logic itself (row
// filtering by permission_level/department_types, and
// normalizeDepartmentType()'s alias matching), since neither touches
// a table — this file inlines both, kept byte-for-byte in sync with
// toolRegistry.ts's own implementation (see the comment above each).
// Before deploying, re-run this same set of cases through a real
// assignTools() call against a live sqlite3 DB (`npm install && npx
// tsc && node dist/__tests__/toolRegistry.test.js`) to confirm the
// inlined copy hasn't drifted from the real function.

import { test } from "node:test";
import assert from "node:assert/strict";

type Tier = "agent" | "department_agent" | "worker";
type DepartmentType = "software" | "marketing" | "finance" | "security" | "server" | "domain";

// Mirrors toolRegistry.ts's DEPARTMENT_TYPE_ALIASES / normalizeDepartmentType()
// exactly — a literal copy, not an import, per this file's own header.
const DEPARTMENT_TYPE_ALIASES: Record<DepartmentType, string[]> = {
  software: ["engineering", "eng", "dev", "development", "frontend", "backend"],
  marketing: ["growth", "marcomm"],
  finance: ["accounting", "fin"],
  security: ["infosec", "sec"],
  server: ["infra", "infrastructure", "devops", "ops", "sysadmin"],
  domain: ["dns", "domains", "webmaster"],
};
const CANONICAL_DEPARTMENT_TYPES: DepartmentType[] = [
  "software",
  "marketing",
  "finance",
  "security",
  "server",
  "domain",
];

function normalizeDepartmentType(role: string | null | undefined): DepartmentType | null {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if ((CANONICAL_DEPARTMENT_TYPES as string[]).includes(normalized)) return normalized as DepartmentType;
  for (const type of CANONICAL_DEPARTMENT_TYPES) {
    if (DEPARTMENT_TYPE_ALIASES[type].includes(normalized)) return type;
  }
  return null;
}

interface FakeRow {
  name: string;
  permissionLevel: Tier[];
  departmentTypes: DepartmentType[] | null;
  deprecated: boolean;
}

// Mirrors toolRegistry.ts's assignTools() filtering exactly: excludes
// deprecated rows, requires `tier` in permission_level, and for
// tier==="department_agent" additionally requires departmentTypes to
// be NULL ("any department") or to include the resolved type — a
// resolved type of null with a departmentTypes-restricted row is
// always excluded (fail closed on an unrecognized role).
function assignNames(
  rows: FakeRow[],
  tier: Tier,
  options?: { role?: string | null; departmentType?: DepartmentType | null },
): string[] {
  const resolvedType: DepartmentType | null =
    options?.departmentType !== undefined && options?.departmentType !== null
      ? options.departmentType
      : options?.role !== undefined
        ? normalizeDepartmentType(options.role)
        : null;

  const out: string[] = [];
  for (const row of rows) {
    if (row.deprecated) continue;
    if (!row.permissionLevel.includes(tier)) continue;
    if (tier === "department_agent" && row.departmentTypes !== null) {
      if (!resolvedType || !row.departmentTypes.includes(resolvedType)) continue;
    }
    out.push(row.name);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// ── normalizeDepartmentType() ──────────────────────────────────────

test("normalizeDepartmentType: matches canonical names case-insensitively", () => {
  assert.equal(normalizeDepartmentType("software"), "software");
  assert.equal(normalizeDepartmentType("Software"), "software");
  assert.equal(normalizeDepartmentType("  MARKETING  "), "marketing");
});

test("normalizeDepartmentType: matches each type's alias list", () => {
  assert.equal(normalizeDepartmentType("engineering"), "software");
  assert.equal(normalizeDepartmentType("devops"), "server");
  assert.equal(normalizeDepartmentType("infosec"), "security");
  assert.equal(normalizeDepartmentType("fin"), "finance");
  assert.equal(normalizeDepartmentType("growth"), "marketing");
  assert.equal(normalizeDepartmentType("dns"), "domain");
  assert.equal(normalizeDepartmentType("webmaster"), "domain");
});

test("normalizeDepartmentType: unrecognized/empty role returns null, never a guess", () => {
  assert.equal(normalizeDepartmentType("totally-unknown-role"), null);
  assert.equal(normalizeDepartmentType(""), null);
  assert.equal(normalizeDepartmentType(null), null);
  assert.equal(normalizeDepartmentType(undefined), null);
});

// ── assignTools() row-filtering decision logic ─────────────────────

const ROWS: FakeRow[] = [
  { name: "agent.strategic_reasoning", permissionLevel: ["agent"], departmentTypes: null, deprecated: false },
  { name: "department.reasoning", permissionLevel: ["department_agent"], departmentTypes: null, deprecated: false },
  {
    name: "department.terminal",
    permissionLevel: ["department_agent"],
    departmentTypes: ["software"],
    deprecated: false,
  },
  {
    name: "department.crm",
    permissionLevel: ["department_agent"],
    departmentTypes: ["marketing"],
    deprecated: false,
  },
  {
    name: "department.logs",
    permissionLevel: ["department_agent"],
    departmentTypes: ["software", "security", "server"],
    deprecated: false,
  },
  {
    name: "department.dns_create_record",
    permissionLevel: ["department_agent"],
    departmentTypes: ["domain"],
    deprecated: false,
  },
  { name: "worker.read_file", permissionLevel: ["worker"], departmentTypes: null, deprecated: false },
  {
    name: "deprecated.old_tool",
    permissionLevel: ["agent", "department_agent", "worker"],
    departmentTypes: null,
    deprecated: true,
  },
];

test("assignTools: agent tier gets only agent-permissioned rows, never department/worker rows", () => {
  assert.deepEqual(assignNames(ROWS, "agent"), ["agent.strategic_reasoning"]);
});

test("assignTools: worker tier gets only worker-permissioned rows", () => {
  assert.deepEqual(assignNames(ROWS, "worker"), ["worker.read_file"]);
});

test("assignTools: department_agent with no role/departmentType gets only the type-unrestricted subset", () => {
  assert.deepEqual(assignNames(ROWS, "department_agent"), ["department.reasoning"]);
});

test("assignTools: a Software department gets terminal + the shared logs row, never CRM", () => {
  const granted = assignNames(ROWS, "department_agent", { role: "software" });
  assert.ok(granted.includes("department.terminal"));
  assert.ok(granted.includes("department.logs"));
  assert.ok(granted.includes("department.reasoning"));
  assert.ok(!granted.includes("department.crm"));
});

test("assignTools: a Marketing department gets CRM but never terminal — confirms §4e separation survives assign_tools()", () => {
  const granted = assignNames(ROWS, "department_agent", { role: "marketing" });
  assert.ok(granted.includes("department.crm"));
  assert.ok(granted.includes("department.reasoning"));
  assert.ok(!granted.includes("department.terminal"));
  assert.ok(!granted.includes("department.logs"));
});

test("assignTools: role alias resolves the same as the canonical name", () => {
  assert.deepEqual(
    assignNames(ROWS, "department_agent", { role: "engineering" }),
    assignNames(ROWS, "department_agent", { role: "software" }),
  );
});

test("assignTools: an explicit departmentType wins over a conflicting role", () => {
  const granted = assignNames(ROWS, "department_agent", { role: "software", departmentType: "marketing" });
  assert.ok(granted.includes("department.crm"));
  assert.ok(!granted.includes("department.terminal"));
});

test("assignTools: an unrecognized role fails closed to the type-unrestricted subset, never the union of every type", () => {
  const granted = assignNames(ROWS, "department_agent", { role: "totally-unknown-role" });
  assert.deepEqual(granted, ["department.reasoning"]);
});

test("assignTools: a shared row (logs) is granted to every listed type and denied to types not listed", () => {
  assert.ok(assignNames(ROWS, "department_agent", { role: "security" }).includes("department.logs"));
  assert.ok(assignNames(ROWS, "department_agent", { role: "server" }).includes("department.logs"));
  assert.ok(!assignNames(ROWS, "department_agent", { role: "finance" }).includes("department.logs"));
});

test("assignTools: deprecated rows are never granted to any tier", () => {
  assert.ok(!assignNames(ROWS, "agent").includes("deprecated.old_tool"));
  assert.ok(!assignNames(ROWS, "department_agent", { role: "software" }).includes("deprecated.old_tool"));
  assert.ok(!assignNames(ROWS, "worker").includes("deprecated.old_tool"));
});

test("assignTools: result is deterministically sorted by name", () => {
  const granted = assignNames(ROWS, "department_agent", { role: "software" });
  const sorted = [...granted].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(granted, sorted);
});

// next-phase.md Phase 9a-ii: the real gap found by inspection before
// this sub-phase's own code changes — this file's DEPARTMENT_TYPE_ALIASES/
// CANONICAL_DEPARTMENT_TYPES copy is a separate literal mirror of
// toolRegistry.ts's own (see this file's header), which is itself a
// separate literal mirror of departmentToolProfiles.ts's copy. All
// three needed "domain" added by hand for a Domain department's own
// tool_registry rows (9a-iii's DOMAIN_* seed rows) to ever actually
// resolve for it — next-phase.md's own Phase 9a "Touches" line named
// only departmentToolProfiles.ts, not this file or toolRegistry.ts,
// which would have left create_department(role: "domain") silently
// falling back to the type-unrestricted subset once 9a-iii's rows
// existed to grant.
test("assignTools: a Domain department gets its own dns row, never CRM or terminal", () => {
  const granted = assignNames(ROWS, "department_agent", { role: "domain" });
  assert.ok(granted.includes("department.dns_create_record"));
  assert.ok(granted.includes("department.reasoning"));
  assert.ok(!granted.includes("department.crm"));
  assert.ok(!granted.includes("department.terminal"));
});

test("assignTools: domain's own alias (dns) resolves the same as the canonical name", () => {
  assert.deepEqual(
    assignNames(ROWS, "department_agent", { role: "dns" }),
    assignNames(ROWS, "department_agent", { role: "domain" }),
  );
});
