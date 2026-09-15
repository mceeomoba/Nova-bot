// next-phase.md Phase 2i(e) (architecture-agent.md §7 addition): tests
// for toolRegistryRoutes.ts's GET /available request handling — tier
// validation, departmentType validation/precedence, and the response
// shape (resolvedDepartmentType, tools[] projection).
//
// Same no-network-for-`npm install` constraint every prior backend/src
// phase (2f-iii/2f-iv/2g/2h-iv/2i(a)/2i(b)/2i(c)/2i(d)) has already
// flagged and worked around. toolRegistryRoutes.ts imports both
// `express` and `./toolRegistry.js` (which itself imports `./db.js` ->
// better-sqlite3) — neither installed in this environment — so the real
// route can't be spun up behind a real HTTP server here. What CAN be
// tested without either dependency is the handler's own decision logic:
// this file inlines the exact request-parsing/validation/response-shape
// steps from toolRegistryRoutes.ts's GET /available handler, operating
// against a fake `assignTools()` stand-in instead of a live DB query,
// kept in sync with the real handler by inspection (see the comment
// above each inlined copy). Before deploying, re-run this same set of
// cases against the real route with a live DB and an actual HTTP
// request (`npm install && npx tsc && node dist/index.js`, then `curl
// localhost:PORT/tool-registry/available?...`) to confirm this inlined
// copy hasn't drifted from toolRegistryRoutes.ts's own implementation.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

type Tier = "agent" | "department_agent" | "worker";
type DepartmentType = "software" | "marketing" | "finance" | "security" | "server";

const VALID_TIERS: Tier[] = ["agent", "department_agent", "worker"];

// Mirrors toolRegistry.ts's DEPARTMENT_TYPE_ALIASES/normalizeDepartmentType()
// exactly — same inlined copy toolRegistry.test.ts already established,
// duplicated here rather than imported for the same reason: this file
// stands alone without a `db.js` import chain.
const DEPARTMENT_TYPE_ALIASES: Record<DepartmentType, string[]> = {
  software: ["engineering", "eng", "dev", "development", "frontend", "backend"],
  marketing: ["growth", "marcomm"],
  finance: ["accounting", "fin"],
  security: ["infosec", "sec"],
  server: ["infra", "infrastructure", "devops", "ops", "sysadmin"],
};
const CANONICAL_DEPARTMENT_TYPES: DepartmentType[] = ["software", "marketing", "finance", "security", "server"];

function normalizeDepartmentType(role: string | null | undefined): DepartmentType | null {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if ((CANONICAL_DEPARTMENT_TYPES as string[]).includes(normalized)) return normalized as DepartmentType;
  for (const type of CANONICAL_DEPARTMENT_TYPES) {
    if (DEPARTMENT_TYPE_ALIASES[type].includes(normalized)) return type;
  }
  return null;
}

interface FakeGrant {
  name: string;
  description: string;
  inputSchema: object;
  costUnit: "usd" | "compute" | "calls" | "disk";
  costAmountPerCall: number | null;
  costAmountPerUnit: number | null;
  scopeTemplate: string;
  lifecycle: string;
}

/**
 * Stand-in for toolRegistry.ts's assignTools() — a caller-supplied fake
 * so each test controls exactly what "the registry" returns without a
 * live DB. Real assignTools() is exercised for real in
 * toolRegistry.test.ts/toolRegistrySeedData.test.ts; this file's own job
 * is only the HTTP-handler logic sitting on top of it.
 */
type FakeAssignTools = (
  tier: Tier,
  options?: { role?: string; departmentType?: DepartmentType },
) => FakeGrant[];

interface HandlerRequest {
  query: Record<string, string | undefined>;
}
interface HandlerResponse {
  status: number;
  body: any;
}

/**
 * Byte-for-byte mirror of toolRegistryRoutes.ts's GET /available
 * handler body — same order of operations: tier validation (400 on
 * unknown tier), departmentType validation (400 on unrecognized value,
 * BEFORE it's allowed to silently read as "omitted"), assignTools()
 * call, then the response shape (resolvedDepartmentType only computed
 * for tier==="department_agent", departmentType takes precedence over
 * role when resolving it, agentAddress echoed back but never used to
 * filter).
 */
function simulateAvailableHandler(req: HandlerRequest, assignTools: FakeAssignTools): HandlerResponse {
  const tierParam = String(req.query.tier || "");
  if (!VALID_TIERS.includes(tierParam as Tier)) {
    return { status: 400, body: { error: `tier must be one of: ${VALID_TIERS.join(", ")}` } };
  }
  const tier = tierParam as Tier;

  const role = typeof req.query.role === "string" ? req.query.role : undefined;
  const departmentTypeParam = typeof req.query.departmentType === "string" ? req.query.departmentType : undefined;
  const agentAddress = typeof req.query.agentAddress === "string" ? req.query.agentAddress : undefined;

  let departmentType: DepartmentType | null | undefined;
  if (departmentTypeParam !== undefined) {
    departmentType = normalizeDepartmentType(departmentTypeParam);
    if (departmentType === null) {
      return {
        status: 400,
        body: {
          error: `unrecognized departmentType "${departmentTypeParam}" — expected one of software, marketing, finance, security, server (or a known alias)`,
        },
      };
    }
  }

  const grants = assignTools(tier, { role, departmentType: departmentType ?? undefined });

  return {
    status: 200,
    body: {
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
    },
  };
}

function grant(name: string, overrides: Partial<FakeGrant> = {}): FakeGrant {
  return {
    name,
    description: `desc for ${name}`,
    inputSchema: {},
    costUnit: "compute",
    costAmountPerCall: null,
    costAmountPerUnit: null,
    scopeTemplate: "own_office",
    lifecycle: "task",
    ...overrides,
  };
}

describe("toolRegistryRoutes GET /available (inlined)", () => {
  test("rejects a missing tier with 400", () => {
    const res = simulateAvailableHandler({ query: {} }, () => []);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /tier must be one of/);
  });

  test("rejects an unrecognized tier with 400", () => {
    const res = simulateAvailableHandler({ query: { tier: "ceo" } }, () => []);
    assert.equal(res.status, 400);
  });

  test("accepts every valid tier", () => {
    for (const tier of VALID_TIERS) {
      const res = simulateAvailableHandler({ query: { tier } }, () => [grant("x")]);
      assert.equal(res.status, 200);
      assert.equal(res.body.tier, tier);
    }
  });

  test("rejects an unrecognized departmentType with 400, distinct from an unrecognized tier", () => {
    const res = simulateAvailableHandler(
      { query: { tier: "department_agent", departmentType: "softwar" } },
      () => [],
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error, /unrecognized departmentType/);
  });

  test("accepts a departmentType alias the same as the canonical name", () => {
    let seenOptions: any;
    const res = simulateAvailableHandler(
      { query: { tier: "department_agent", departmentType: "eng" } },
      (tier, options) => {
        seenOptions = options;
        return [];
      },
    );
    assert.equal(res.status, 200);
    assert.equal(seenOptions.departmentType, "software");
    assert.equal(res.body.resolvedDepartmentType, "software");
  });

  test("departmentType takes precedence over role when both are given, matching assignTools()'s own documented precedence", () => {
    let seenOptions: any;
    const res = simulateAvailableHandler(
      { query: { tier: "department_agent", role: "marketing", departmentType: "software" } },
      (tier, options) => {
        seenOptions = options;
        return [];
      },
    );
    assert.equal(seenOptions.departmentType, "software");
    assert.equal(res.body.resolvedDepartmentType, "software");
  });

  test("role alone resolves resolvedDepartmentType via normalizeDepartmentType, same as assignTools() would internally", () => {
    const res = simulateAvailableHandler(
      { query: { tier: "department_agent", role: "growth" } },
      () => [],
    );
    assert.equal(res.body.resolvedDepartmentType, "marketing");
  });

  test("an unrecognized role resolves resolvedDepartmentType to null, not an error — matches assignTools()'s fail-closed-to-unrestricted-subset behavior", () => {
    const res = simulateAvailableHandler(
      { query: { tier: "department_agent", role: "not-a-real-department" } },
      () => [],
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.resolvedDepartmentType, null);
  });

  test("resolvedDepartmentType is always null for tier=agent/worker regardless of role/departmentType", () => {
    for (const tier of ["agent", "worker"] as Tier[]) {
      const res = simulateAvailableHandler({ query: { tier, role: "software" } }, () => []);
      assert.equal(res.body.resolvedDepartmentType, null);
    }
  });

  test("agentAddress is echoed back but never passed into assignTools()", () => {
    let seenOptions: any;
    const res = simulateAvailableHandler(
      { query: { tier: "agent", agentAddress: "0xabc" } },
      (tier, options) => {
        seenOptions = options;
        return [];
      },
    );
    assert.equal(res.body.agentAddress, "0xabc");
    assert.ok(!("agentAddress" in (seenOptions ?? {})));
  });

  test("omitted agentAddress echoes back null, not undefined-as-a-key-omission", () => {
    const res = simulateAvailableHandler({ query: { tier: "agent" } }, () => []);
    assert.equal(res.body.agentAddress, null);
  });

  test("tools[] projects exactly the documented fields, in the documented shape, dropping nothing and adding nothing", () => {
    const g = grant("run_command", {
      description: "runs a command",
      inputSchema: { action: "run_command" },
      costUnit: "usd",
      costAmountPerCall: 0.01,
      costAmountPerUnit: null,
      scopeTemplate: "own_container",
      lifecycle: "task",
    });
    const res = simulateAvailableHandler({ query: { tier: "worker" } }, () => [g]);
    assert.equal(res.body.count, 1);
    assert.deepEqual(res.body.tools[0], {
      name: "run_command",
      description: "runs a command",
      inputSchema: { action: "run_command" },
      costUnit: "usd",
      costAmountPerCall: 0.01,
      costAmountPerUnit: null,
      scopeTemplate: "own_container",
      lifecycle: "task",
    });
  });

  test("count matches tools.length even for an empty result — an unrecognized role/department is a real, valid empty answer, not an error", () => {
    const res = simulateAvailableHandler(
      { query: { tier: "department_agent", role: "not-a-real-department" } },
      () => [],
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 0);
    assert.deepEqual(res.body.tools, []);
  });

  test("role is passed through to assignTools() even when departmentType is absent", () => {
    let seenOptions: any;
    const res = simulateAvailableHandler(
      { query: { tier: "department_agent", role: "server" } },
      (tier, options) => {
        seenOptions = options;
        return [];
      },
    );
    assert.equal(seenOptions.role, "server");
    assert.equal(res.status, 200);
  });
});
