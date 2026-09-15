/**
 * next-phase.md Phase 2i(a) — Tool Registry seed migration
 * (architecture-agent.md §9)
 *
 * One-time script: writes `toolRegistrySeedData.ts`'s `SEED_ROWS` — every
 * capability §4d (Agent), §4e (Department Agent, including its
 * per-department-type table), and §4f (Worker) already enumerate in
 * prose — into the new `tool_registry` table (db.ts). This is what
 * makes `departmentToolProfiles.ts` — Phase 2f-i's hand-maintained
 * `role -> tool list` map — a migration INPUT rather than the tools'
 * long-term home: every capability name and every ACTION mapping it
 * already locked in is carried over here verbatim (see
 * toolRegistrySeedData.ts's own header for exactly how and why it's a
 * literal copy, not a cross-package import).
 *
 * Run once: `npx tsx src/seedToolRegistry.ts` (needs the same env vars
 * db.ts itself requires — BACKEND_API_KEY/ADMIN_API_KEY/etc, see
 * .env.example). Idempotent — safe to run again: every row is written
 * with `INSERT ... ON CONFLICT DO UPDATE`, keyed on `name`, so a second
 * run refreshes existing rows to match toolRegistrySeedData.ts rather
 * than erroring or duplicating. That matters because that file, not a
 * live database, is the actual source of truth for what SHOULD be
 * seeded — re-running after editing it is the intended way to change
 * the registry's contents until Phase 2i(b)+ gives it its own runtime
 * write path.
 *
 * What this phase deliberately does NOT do (later phases' jobs, not
 * skipped by oversight):
 *   - Nothing reads from tool_registry yet. departmentToolProfiles.ts's
 *     CAPABILITY_TO_ACTIONS/resolveProfileActions() remains the live
 *     lookup every call site (systemPrompt.ts, tools.ts's executeTool)
 *     still uses. Phase 2i(b)'s assign_tools() is what actually queries
 *     this table and Phase 2i(c) is what migrates callers onto it.
 *   - No scope/budget/environment RESOLUTION happens here — scopeTemplate
 *     and lifecycle are stored as declared metadata per §9's
 *     ToolDefinition shape, not resolved against any live agent/
 *     department/project id. That resolution is Phase 2i(b)/(c)'s job.
 *   - No grant-lifecycle enforcement (session/task/project teardown
 *     hooks) — Phase 2i(d).
 *
 * See toolRegistrySeedData.ts for the actual row data, its §4d/§4e/§4f
 * provenance, and the cost-default rules applied per row. This file is
 * intentionally just plumbing: read SEED_ROWS, validate, write.
 */
import { db } from "./db.js";
import { SEED_ROWS, assertNoDuplicateNames, type SeedRow } from "./toolRegistrySeedData.js";

const upsert = db.prepare(`
  INSERT INTO tool_registry (
    name, description, input_schema, cost_unit, cost_amount_per_call,
    cost_amount_per_unit, permission_level, department_types,
    scope_template, lifecycle, deprecated, created_at, updated_at
  ) VALUES (
    @name, @description, @inputSchema, @costUnit, @costAmountPerCall,
    @costAmountPerUnit, @permissionLevel, @departmentTypes,
    @scopeTemplate, @lifecycle, 0, @createdAt, @updatedAt
  )
  ON CONFLICT(name) DO UPDATE SET
    description = excluded.description,
    input_schema = excluded.input_schema,
    cost_unit = excluded.cost_unit,
    cost_amount_per_call = excluded.cost_amount_per_call,
    cost_amount_per_unit = excluded.cost_amount_per_unit,
    permission_level = excluded.permission_level,
    department_types = excluded.department_types,
    scope_template = excluded.scope_template,
    lifecycle = excluded.lifecycle,
    updated_at = excluded.updated_at
`);

function seed(rowsToSeed: SeedRow[]): { inserted: number; updated: number } {
  const existing = new Set(
    (db.prepare(`SELECT name FROM tool_registry`).all() as { name: string }[]).map((r) => r.name),
  );
  let inserted = 0;
  let updated = 0;
  const now = Date.now();

  const insertMany = db.transaction((items: SeedRow[]) => {
    for (const row of items) {
      upsert.run({
        name: row.name,
        description: row.description,
        inputSchema: JSON.stringify(row.inputSchema),
        costUnit: row.costUnit,
        costAmountPerCall: row.costAmountPerCall ?? null,
        costAmountPerUnit: row.costAmountPerUnit ?? null,
        permissionLevel: JSON.stringify(row.permissionLevel),
        departmentTypes: row.departmentTypes ? JSON.stringify(row.departmentTypes) : null,
        scopeTemplate: row.scopeTemplate,
        lifecycle: row.lifecycle,
        createdAt: now,
        updatedAt: now,
      });
      if (existing.has(row.name)) updated++;
      else inserted++;
    }
  });
  insertMany(rowsToSeed);
  return { inserted, updated };
}

export function runSeed(): { inserted: number; updated: number; total: number } {
  assertNoDuplicateNames(SEED_ROWS);
  const { inserted, updated } = seed(SEED_ROWS);
  return { inserted, updated, total: SEED_ROWS.length };
}

// Run directly (`npx tsx src/seedToolRegistry.ts`), not just importable —
// same "standalone script" convention smoke_groups.ts already uses in
// this repo.
const isMain = process.argv[1] && process.argv[1].endsWith("seedToolRegistry.ts");
if (isMain) {
  const result = runSeed();
  console.log(
    `tool_registry seeded: ${result.inserted} inserted, ${result.updated} updated, ${result.total} total rows.`,
  );
}
