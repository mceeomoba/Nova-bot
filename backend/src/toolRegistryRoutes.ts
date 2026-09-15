import express from "express";
import { assignTools, normalizeDepartmentType, type Tier } from "./toolRegistry.js";
import { isGrantRevoked } from "./toolGrants.js";
import { db } from "./db.js";

/**
 * next-phase.md Phase 2i(e) — Tool introspection: list_available_tools
 * (architecture-agent.md §7 addition)
 *
 * Every prior 2i sub-phase either built tool_registry (2i(a)), queried
 * it (2i(b)'s assign_tools()), resolved its metadata into Phase 2g's
 * 5-tuple (2i(c)), or enforced its per-grant lifecycle (2i(d)) — but
 * nothing yet let an agent or Department Agent simply ASK "what tools
 * would I/a new hire be entitled to." That's the entire job of this
 * route: a thin, read-only HTTP surface over 2i(b)'s own assignTools(),
 * so agent-runtime (a separate process with no direct DB access — see
 * subagents.ts's own "separate process" note, and toolRegistry.ts's own
 * header on why this split exists at all) can expose it as a real tool.
 *
 * Deliberately NOT ownership-scoped the way most routes in this
 * backend are (contrast departments.ts's GET /, which filters by
 * `agentAddress`): a resolved tool grant is a function of (tier, role)
 * against the shared tool_registry table, not of any one agent's own
 * data. Two different agents asking "what would a Marketing Department
 * Agent be entitled to" always get the identical answer, so there is no
 * owned resource here to check a caller against — the same reasoning
 * agentCard.ts's public ERC-8004 lookups already document for why they
 * don't need one either. `agentAddress` is accepted but optional, for
 * audit-log/observability parity with every other route's query-string
 * convention only — never used to filter or gate the result.
 *
 * Mounted at `/tool-registry` in index.ts, behind the same shared-secret
 * `x-backend-key` middleware every other agent-facing route sits behind
 * (unlike agentCard.ts/marketplace.ts's public routes) — this is not
 * meant to be a public catalog a stranger can enumerate, only something
 * an authenticated agent-runtime process (holding BACKEND_API_KEY) can
 * ask on behalf of whichever agent it's driving. See
 * agent-runtime/src/toolRegistryClient.ts for the HTTP client that
 * consumes this endpoint from the separate agent-runtime process, and
 * agent-runtime/src/tools.ts's `list_available_tools` ACTION for the
 * one real caller today.
 */

const router = express.Router();

const VALID_TIERS: Tier[] = ["agent", "department_agent", "worker"];

// Monotonic signal for immediate invalidation of remote grant caches.
router.get("/version", (_req, res) => {
  const row = db.prepare("SELECT COALESCE(MAX(updated_at), 0) AS version FROM tool_registry").get() as { version: number };
  res.json({ version: row.version });
});

// GET /tool-registry/available?tier=department_agent&role=marketing
// GET /tool-registry/available?tier=department_agent&departmentType=software
// GET /tool-registry/available?tier=agent
// GET /tool-registry/available?tier=worker
//
// `role` and `departmentType` are both optional and only meaningful for
// tier=department_agent — see toolRegistry.ts's own assignTools() doc
// comment for the exact precedence (`departmentType` wins if both are
// given) and the fail-closed behavior on an unrecognized role (the
// department-type-unrestricted subset, never the union of every type).
router.get("/available", (req, res) => {
  try {
    const tierParam = String(req.query.tier || "");
    if (!VALID_TIERS.includes(tierParam as Tier)) {
      return res.status(400).json({
        error: `tier must be one of: ${VALID_TIERS.join(", ")}`,
      });
    }
    const tier = tierParam as Tier;

    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    const departmentTypeParam =
      typeof req.query.departmentType === "string" ? req.query.departmentType : undefined;
    // Accepted purely for audit-log/observability parity with every
    // other route's query-string convention (see header comment) —
    // never read again below, never used to filter assignTools().
    const agentAddress = typeof req.query.agentAddress === "string" ? req.query.agentAddress : undefined;

    // Validate an explicit departmentType up front (rather than letting an
    // unrecognized value silently fall through to normalizeDepartmentType()
    // returning null, which reads identically to "omitted") — a caller
    // that typo'd "softwar" deserves a 400, not a quietly-narrower answer.
    let departmentType: ReturnType<typeof normalizeDepartmentType> | undefined;
    if (departmentTypeParam !== undefined) {
      departmentType = normalizeDepartmentType(departmentTypeParam);
      if (departmentType === null) {
        return res.status(400).json({
          error: `unrecognized departmentType "${departmentTypeParam}" — expected one of software, marketing, finance, security, server (or a known alias)`,
        });
      }
    }

    const grants = assignTools(tier, { role, departmentType });

    res.json({
      tier,
      role: role ?? null,
      resolvedDepartmentType:
        tier === "department_agent" ? (departmentType ?? normalizeDepartmentType(role)) : null,
      agentAddress: agentAddress ?? null,
      count: grants.length,
      tools: grants.map((g) => ({
        name: g.name,
        description: g.description,
        inputSchema: g.inputSchema,
        costUnit: g.costUnit,
        costAmountPerCall: g.costAmountPerCall,
        costAmountPerUnit: g.costAmountPerUnit,
        scopeTemplate: g.scopeTemplate,
        lifecycle: g.lifecycle,
      })),
    });
  } catch (err: any) {
    // assignTools() is a live `db.prepare(...).all()` query — a real
    // sqlite failure (locked file, corrupt row) is a 500, not a 400;
    // don't let it crash the process the way an uncaught throw inside
    // an Express handler would. Same "wrap the DB-touching handler"
    // convention ptyRoutes.ts's own POST /create already follows.
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// GET /tool-registry/grant-status?holderId=dept_xxx&toolName=run_command
//
// next-phase.md Phase 7b — the one piece of read surface agent-runtime
// (a separate process, no direct DB access) needs to actually consult
// tool_grants.status at dispatch time: capability.ts's own
// checkGrantedToolCapability() can call toolGrants.ts's
// isGrantRevoked() directly (same process, same DB), but tools.ts's
// executeTool() cannot — this is that lookup's thin HTTP mirror, same
// "thin, read-only HTTP surface over a backend/src function" shape
// GET /available already established one level up in this same file.
// Deliberately NOT cached anywhere in this call path (see
// agent-runtime/src/toolRegistryClient.ts's own isGrantRevoked() doc
// comment) — a revocation needs to take effect on the very next call,
// not after some TTL window a caller might still be inside of.
router.get("/grant-status", (req, res) => {
  try {
    const holderId = typeof req.query.holderId === "string" ? req.query.holderId.trim() : "";
    const toolName = typeof req.query.toolName === "string" ? req.query.toolName.trim() : "";
    if (!holderId || !toolName) {
      return res.status(400).json({ error: "holderId and toolName are both required" });
    }
    res.json({ holderId, toolName, revoked: isGrantRevoked(holderId, toolName) });
  } catch (err: any) {
    // Same "don't let a real sqlite failure crash the process" posture
    // GET /available already takes above.
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

export default router;
