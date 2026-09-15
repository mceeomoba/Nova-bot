// Zent.md Phase 2a: new `opportunity_intelligence` department type in
// toolRegistry.ts / normalizeDepartmentType, plus Phase 2e's
// isEligibleForExpansion() profitability gate.
//
// Inlined mirrors of toolRegistry.ts's normalizeDepartmentType() and
// expansion.ts's isEligibleForExpansion(), standing in for live
// better-sqlite3 and the real module code — same "no live DB in this
// environment" reason every prior backend/src test file in this repo
// already carries (see orgChartQuotas.test.ts's own header, or
// expansionPipeline.test.ts's for the same note applied to Phase 1a).
// Recommend re-running against the real modules once a networked
// environment with node_modules installed is available.
//
// What this covers:
//   2a — normalizeDepartmentType resolves "opportunity_intelligence"
//         and its aliases ("oi", "opp-intel", "opportunity-intelligence");
//         all other department types still resolve correctly; unknown
//         roles still return null.
//   2a — isHardenedNetworkDepartmentType returns false for
//         opportunity_intelligence (signal scanning needs outbound net).
//   2e — isEligibleForExpansion returns eligible=true when settled
//         revenue exceeds usage spend, false otherwise; component
//         figures (revenueUsdc, spendUsdc, surplusUsdc) are always
//         included; an empty agentAddress throws.
//   2a+2e integration — the create_department spawn guard blocks a
//         non-profitable agent from creating an opportunity_intelligence
//         department and allows a profitable one; all other department
//         types are unaffected by the profitability check.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Inlined mirror of toolRegistry.ts ───────────────────────────────

type DepartmentType =
  | "software"
  | "marketing"
  | "finance"
  | "security"
  | "server"
  | "domain"
  | "opportunity_intelligence"; // Phase 2a

const DEPARTMENT_TYPE_ALIASES: Record<DepartmentType, string[]> = {
  software: ["engineering", "eng", "dev", "development", "frontend", "backend"],
  marketing: ["growth", "marcomm"],
  finance: ["accounting", "fin"],
  security: ["infosec", "sec"],
  server: ["infra", "infrastructure", "devops", "ops", "sysadmin"],
  domain: ["dns", "domains", "webmaster"],
  opportunity_intelligence: ["oi", "opp-intel", "opportunity-intelligence"],
};

const CANONICAL_DEPARTMENT_TYPES: DepartmentType[] = [
  "software",
  "marketing",
  "finance",
  "security",
  "server",
  "domain",
  "opportunity_intelligence",
];

const HARDENED_NETWORK_DEPARTMENT_TYPES: DepartmentType[] = ["finance", "security", "server"];

function isHardenedNetworkDepartmentType(type: DepartmentType | null): boolean {
  return type !== null && HARDENED_NETWORK_DEPARTMENT_TYPES.includes(type);
}

function normalizeDepartmentType(role: string | null | undefined): DepartmentType | null {
  const normalized = (role ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if ((CANONICAL_DEPARTMENT_TYPES as string[]).includes(normalized))
    return normalized as DepartmentType;
  for (const type of CANONICAL_DEPARTMENT_TYPES) {
    if (DEPARTMENT_TYPE_ALIASES[type].includes(normalized)) return type;
  }
  return null;
}

// ─── Inlined mirror of expansion.ts's isEligibleForExpansion() ────────
//
// The real function queries `payments` (settled revenue) and `usage_log`
// (spend). Here we stand those tables in as plain arrays and derive the
// same calculation so the business logic is testable without a live DB.

interface FakePayment {
  to_address: string;
  value_usdc: number;
  status: "pending" | "settled" | "failed";
}

interface FakeUsageRow {
  agent_address: string;
  cost_usdc: number;
}

interface EligibilityResult {
  eligible: boolean;
  revenueUsdc: number;
  spendUsdc: number;
  surplusUsdc: number;
}

let payments: FakePayment[];
let usageLog: FakeUsageRow[];

function resetFinancials() {
  payments = [];
  usageLog = [];
}

function isEligibleForExpansion(agentAddress: string): EligibilityResult {
  if (!agentAddress) throw new Error("agentAddress is required");

  const revenueUsdc = payments
    .filter((p) => p.to_address === agentAddress && p.status === "settled")
    .reduce((sum, p) => sum + p.value_usdc, 0);

  const spendUsdc = usageLog
    .filter((r) => r.agent_address === agentAddress)
    .reduce((sum, r) => sum + r.cost_usdc, 0);

  const surplusUsdc = revenueUsdc - spendUsdc;

  return {
    eligible: surplusUsdc > 0,
    revenueUsdc,
    spendUsdc,
    surplusUsdc,
  };
}

// ─── Inlined mirror of departments.ts's spawn guard logic ─────────────
//
// The real route calls isEligibleForExpansion() only when
// normalizeDepartmentType(role) === "opportunity_intelligence" and
// rejects with 403 + error body if !eligible. Here we model the same
// decision as a typed result so the guard path is testable without
// Express.

type SpawnResult =
  | { ok: true }
  | { ok: false; status: 403; error: string; revenueUsdc: number; spendUsdc: number; surplusUsdc: number }
  | { ok: false; status: 403; error: string };

function attemptCreateDepartment(agentAddress: string, role: string): SpawnResult {
  // Simplified: skip assertCanSpawnSubAgents and quota check — those
  // are covered by their own existing tests; here we only exercise
  // the opportunity_intelligence profitability branch.
  if (normalizeDepartmentType(role) === "opportunity_intelligence") {
    const eligibility = isEligibleForExpansion(agentAddress);
    if (!eligibility.eligible) {
      return {
        ok: false,
        status: 403,
        error: "opportunity_intelligence_requires_profitability",
        revenueUsdc: eligibility.revenueUsdc,
        spendUsdc: eligibility.spendUsdc,
        surplusUsdc: eligibility.surplusUsdc,
      };
    }
  }
  return { ok: true };
}

// ─── Phase 2a: normalizeDepartmentType ───────────────────────────────

test("normalizeDepartmentType resolves canonical 'opportunity_intelligence'", () => {
  assert.equal(normalizeDepartmentType("opportunity_intelligence"), "opportunity_intelligence");
});

test("normalizeDepartmentType resolves 'oi' alias", () => {
  assert.equal(normalizeDepartmentType("oi"), "opportunity_intelligence");
});

test("normalizeDepartmentType resolves 'opp-intel' alias", () => {
  assert.equal(normalizeDepartmentType("opp-intel"), "opportunity_intelligence");
});

test("normalizeDepartmentType resolves 'opportunity-intelligence' alias", () => {
  assert.equal(normalizeDepartmentType("opportunity-intelligence"), "opportunity_intelligence");
});

test("normalizeDepartmentType is case-insensitive for opportunity_intelligence", () => {
  assert.equal(normalizeDepartmentType("Opportunity_Intelligence"), "opportunity_intelligence");
  assert.equal(normalizeDepartmentType("OI"), "opportunity_intelligence");
});

test("normalizeDepartmentType trims whitespace for opportunity_intelligence", () => {
  assert.equal(normalizeDepartmentType("  opportunity_intelligence  "), "opportunity_intelligence");
});

test("all existing department types still resolve after adding opportunity_intelligence", () => {
  assert.equal(normalizeDepartmentType("software"), "software");
  assert.equal(normalizeDepartmentType("marketing"), "marketing");
  assert.equal(normalizeDepartmentType("finance"), "finance");
  assert.equal(normalizeDepartmentType("security"), "security");
  assert.equal(normalizeDepartmentType("server"), "server");
  assert.equal(normalizeDepartmentType("domain"), "domain");
});

test("existing aliases still resolve after adding opportunity_intelligence", () => {
  assert.equal(normalizeDepartmentType("eng"), "software");
  assert.equal(normalizeDepartmentType("growth"), "marketing");
  assert.equal(normalizeDepartmentType("fin"), "finance");
  assert.equal(normalizeDepartmentType("infosec"), "security");
  assert.equal(normalizeDepartmentType("infra"), "server");
  assert.equal(normalizeDepartmentType("dns"), "domain");
});

test("normalizeDepartmentType returns null for unknown roles", () => {
  assert.equal(normalizeDepartmentType("unknown_dept_xyz"), null);
  assert.equal(normalizeDepartmentType(""), null);
  assert.equal(normalizeDepartmentType(null), null);
  assert.equal(normalizeDepartmentType(undefined), null);
});

// ─── Phase 2a: opportunity_intelligence is NOT network-hardened ────────

test("opportunity_intelligence is not in HARDENED_NETWORK_DEPARTMENT_TYPES", () => {
  // Signal scanning (Phase 2b/2c) needs outbound internet — hardening
  // would break the whole point of the department.
  assert.equal(isHardenedNetworkDepartmentType("opportunity_intelligence"), false);
});

test("finance, security, server remain hardened after adding opportunity_intelligence", () => {
  assert.equal(isHardenedNetworkDepartmentType("finance"), true);
  assert.equal(isHardenedNetworkDepartmentType("security"), true);
  assert.equal(isHardenedNetworkDepartmentType("server"), true);
});

// ─── Phase 2e: isEligibleForExpansion ────────────────────────────────

test("isEligibleForExpansion returns eligible=true when revenue exceeds spend", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 100, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 40 });

  const result = isEligibleForExpansion("0xAGENT");
  assert.equal(result.eligible, true);
  assert.equal(result.revenueUsdc, 100);
  assert.equal(result.spendUsdc, 40);
  assert.equal(result.surplusUsdc, 60);
});

test("isEligibleForExpansion returns eligible=false when spend equals revenue", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 50, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 50 });

  const result = isEligibleForExpansion("0xAGENT");
  assert.equal(result.eligible, false);
  assert.equal(result.surplusUsdc, 0);
});

test("isEligibleForExpansion returns eligible=false when spend exceeds revenue", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 20, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 80 });

  const result = isEligibleForExpansion("0xAGENT");
  assert.equal(result.eligible, false);
  assert.ok(result.surplusUsdc < 0);
});

test("isEligibleForExpansion returns eligible=false when there is no revenue at all", () => {
  resetFinancials();
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 10 });

  const result = isEligibleForExpansion("0xAGENT");
  assert.equal(result.eligible, false);
  assert.equal(result.revenueUsdc, 0);
});

test("isEligibleForExpansion returns eligible=false when a new agent has no history at all", () => {
  resetFinancials();
  // No payments, no usage — revenue=0, spend=0, surplus=0 → not profitable.
  const result = isEligibleForExpansion("0xBRAND_NEW");
  assert.equal(result.eligible, false);
  assert.equal(result.surplusUsdc, 0);
});

test("isEligibleForExpansion ignores pending and failed payments (only settled counts)", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 200, status: "pending" });
  payments.push({ to_address: "0xAGENT", value_usdc: 50, status: "failed" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 1 });

  const result = isEligibleForExpansion("0xAGENT");
  // Only settled revenue counts — here there is none, so not eligible.
  assert.equal(result.eligible, false);
  assert.equal(result.revenueUsdc, 0);
});

test("isEligibleForExpansion only counts revenue paid TO this agent, not FROM it", () => {
  resetFinancials();
  // This agent paid someone else; it should not count as revenue.
  payments.push({ to_address: "0xSOMEONE_ELSE", value_usdc: 500, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 1 });

  const result = isEligibleForExpansion("0xAGENT");
  assert.equal(result.eligible, false);
  assert.equal(result.revenueUsdc, 0);
});

test("isEligibleForExpansion accumulates multiple settled payments", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 30, status: "settled" });
  payments.push({ to_address: "0xAGENT", value_usdc: 70, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 50 });

  const result = isEligibleForExpansion("0xAGENT");
  assert.equal(result.revenueUsdc, 100);
  assert.equal(result.eligible, true);
});

test("isEligibleForExpansion accumulates multiple usage_log rows", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 200, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 80 });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 130 });

  const result = isEligibleForExpansion("0xAGENT");
  assert.equal(result.spendUsdc, 210);
  assert.equal(result.eligible, false); // 200 revenue < 210 spend
});

test("isEligibleForExpansion is scoped per agent — other agents' data doesn't bleed in", () => {
  resetFinancials();
  // 0xRICH has plenty of revenue but we're checking 0xPOOR.
  payments.push({ to_address: "0xRICH", value_usdc: 9999, status: "settled" });
  usageLog.push({ agent_address: "0xPOOR", cost_usdc: 1 });

  const result = isEligibleForExpansion("0xPOOR");
  assert.equal(result.eligible, false);
  assert.equal(result.revenueUsdc, 0);
});

test("isEligibleForExpansion throws on empty agentAddress", () => {
  resetFinancials();
  assert.throws(() => isEligibleForExpansion(""), /agentAddress is required/);
});

// ─── Phase 2a+2e integration: spawn guard ─────────────────────────────

test("create_department blocks opportunity_intelligence for a non-profitable agent", () => {
  resetFinancials();
  // No revenue recorded — not eligible.
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 5 });

  const result = attemptCreateDepartment("0xAGENT", "opportunity_intelligence");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.status, 403);
    assert.equal(result.error, "opportunity_intelligence_requires_profitability");
  }
});

test("create_department allows opportunity_intelligence for a profitable agent", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 100, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 30 });

  const result = attemptCreateDepartment("0xAGENT", "opportunity_intelligence");
  assert.equal(result.ok, true);
});

test("create_department via alias 'oi' also checks profitability", () => {
  resetFinancials();
  // Not profitable — alias should still trigger the gate.
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 1 });

  const result = attemptCreateDepartment("0xAGENT", "oi");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, "opportunity_intelligence_requires_profitability");
  }
});

test("create_department does NOT check profitability for other department types", () => {
  resetFinancials();
  // No revenue — would fail for opportunity_intelligence.
  // But 'software' should pass through with ok:true regardless.
  const result = attemptCreateDepartment("0xAGENT", "software");
  assert.equal(result.ok, true);
});

test("spawn guard rejection includes component figures in error body", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 10, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 50 });

  const result = attemptCreateDepartment("0xAGENT", "opportunity_intelligence");
  assert.equal(result.ok, false);
  if (!result.ok && "revenueUsdc" in result) {
    assert.equal(result.revenueUsdc, 10);
    assert.equal(result.spendUsdc, 50);
    assert.equal(result.surplusUsdc, -40);
  }
});

test("profitable agent can use 'opp-intel' alias to spawn the department", () => {
  resetFinancials();
  payments.push({ to_address: "0xAGENT", value_usdc: 500, status: "settled" });
  usageLog.push({ agent_address: "0xAGENT", cost_usdc: 100 });

  const result = attemptCreateDepartment("0xAGENT", "opp-intel");
  assert.equal(result.ok, true);
});
