// Zent.md Phase 19a: "Global expansion rate limit per root agent: max N
// companies spawned per time window, independent of how many
// opportunities clear the ROI floor — prevents runaway compounding."
//
// Zent.md Phase 19b: "Total-portfolio spend cap: sum of all
// pipeline-spawned siblings' funding cannot exceed a configured
// fraction of the root's lifetime revenue."
//
// The 19a rate-limit logic (checkGenesisSpawnCapacity) and its wiring
// into genesis.ts's genesisCompany() were pulled forward during the 19c
// circuit-breaker work (see expansionCircuitBreaker.ts's own header) and
// have been live since then. 19b's own logic
// (checkPortfolioSpendCapacity / checkPortfolioFundingRoom /
// getTotalPipelineFundingDisbursedUsdc) and its two-checkpoint wiring
// (an early reject in genesisCompany(), a disbursement-time clamp in
// fundGenesisCompany()) were added and wired in this session. Nothing
// in genesisCompany_test.ts or elsewhere in this directory exercised
// either — this file covers both.
//
// Inlined mirror of expansionCircuitBreaker.ts's own logic — same "no
// live better-sqlite3 in this environment" reason every prior
// backend/src test file in this repo already carries (see
// expansionTopNSelection.test.ts's own header for the identical note).
//
// What this covers:
//   19a — an agent below the per-window cap is allowed to spawn.
//   19a — an agent at the cap is blocked, with a reason naming the
//         count, the cap, and the window.
//   19a — the window rolls: a spawn older than the window no longer
//         counts against the cap.
//   19a — scoping: only rows tagged spawn_reason = 'expansion_pipeline'
//         count (an ordinary spawn_clone child does not); only rows
//         under this root's own parent_address count (another agent's
//         spawns never affect this one's capacity).
//   19a/19c — a halted root is blocked regardless of how far under the
//         spawn cap it is, and the halt reason/timestamp are surfaced.
//   19c — haltExpansionPipeline() is an upsert: halting an
//         already-halted root updates the reason/timestamp rather than
//         erroring or duplicating a row.
//   19c — resumeExpansionPipeline() clears the halt and restores normal
//         cap-based evaluation.
//   19b — getTotalPipelineFundingDisbursedUsdc sums only clone-funding
//         payments, only pending/settled, only from this root, all-time
//         (not window-scoped, unlike 19a).
//   19b — checkPortfolioSpendCapacity blocks once disbursed >= cap
//         (revenueUsdc x portfolioSpendCapFraction), allows below it,
//         and a $0-lifetime-revenue root has a $0 cap.
//   19b — checkPortfolioFundingRoom returns the exact room left, never
//         negative.
//   19b — the three-way clamp in fundGenesisCompany (per-call, per-day,
//         portfolio) correctly identifies which ceiling actually bound
//         the disbursement, and reports "portfolio-cap-exhausted"
//         specifically when the portfolio cap is what zeroed it out
//         (not just whichever check happens to run last).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of the `agents` table columns checkGenesisSpawnCapacity()
//     reads, and the `expansion_circuit_breaker` table it/haltExpansion-
//     Pipeline()/resumeExpansionPipeline() read and write ──────────────

interface FakeAgentRow {
  address: string;
  parent_address: string | null;
  spawn_reason: "self" | "expansion_pipeline" | null;
  created_at: number;
}

interface FakeHaltRow {
  root_agent_address: string;
  reason: string;
  halted_at: number;
}

let agents: FakeAgentRow[];
let halts: Map<string, FakeHaltRow>;

function resetState() {
  agents = [];
  halts = new Map();
}

function seedAgent(row: Partial<FakeAgentRow> & { address: string }): FakeAgentRow {
  const full: FakeAgentRow = {
    parent_address: null,
    spawn_reason: null,
    created_at: Date.now(),
    ...row,
  };
  agents.push(full);
  return full;
}

// ─── Mirror of expansionCircuitBreaker.ts ──────────────────────────────

const MAX_GENESIS_SPAWNS_PER_WINDOW = 3;
const GENESIS_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CircuitBreakerCheck {
  allowed: boolean;
  reason?: string;
}

function getHaltedState(rootAgentAddress: string): FakeHaltRow | undefined {
  return halts.get(rootAgentAddress);
}

function checkGenesisSpawnCapacity(rootAgentAddress: string): CircuitBreakerCheck {
  const halted = getHaltedState(rootAgentAddress);
  if (halted) {
    return {
      allowed: false,
      reason: `expansion pipeline is halted for ${rootAgentAddress}: ${halted.reason} (halted_at=${halted.halted_at})`,
    };
  }

  const windowStart = Date.now() - GENESIS_WINDOW_MS;
  const spawnedInWindow = agents.filter(
    (a) =>
      a.parent_address === rootAgentAddress &&
      a.spawn_reason === "expansion_pipeline" &&
      a.created_at >= windowStart,
  ).length;

  if (spawnedInWindow >= MAX_GENESIS_SPAWNS_PER_WINDOW) {
    return {
      allowed: false,
      reason:
        `root agent ${rootAgentAddress} has already spawned ${spawnedInWindow} ` +
        `expansion-pipeline companies in the last ${GENESIS_WINDOW_MS / 3_600_000}h ` +
        `(cap ${MAX_GENESIS_SPAWNS_PER_WINDOW}) — this cycle's Opportunity Intelligence ` +
        `pass can re-evaluate once the window rolls, per Zent.md 19a`,
    };
  }

  return { allowed: true };
}

function haltExpansionPipeline(rootAgentAddress: string, reason: string): void {
  halts.set(rootAgentAddress, { root_agent_address: rootAgentAddress, reason, halted_at: Date.now() });
}

function resumeExpansionPipeline(rootAgentAddress: string): void {
  halts.delete(rootAgentAddress);
}

// ─── Mirror of the `payments` table columns 19b's functions read, and
//     of expansion.ts's isEligibleForExpansion() revenueUsdc figure ────

interface FakePaymentRow {
  from_address: string;
  to_address: string;
  value_usdc: string; // atomic-unit (6-decimal) string, same as the real table
  purpose: string | null;
  status: "pending" | "settled" | "failed";
  created_at: number;
}

let payments: FakePaymentRow[];
let revenueByAgent: Map<string, number>; // stands in for isEligibleForExpansion()'s revenueUsdc

function resetPortfolioState() {
  payments = [];
  revenueByAgent = new Map();
}

function seedPayment(row: Partial<FakePaymentRow> & { from_address: string; value_usdc: string }): void {
  payments.push({
    to_address: "0xsibling",
    purpose: "clone-funding",
    status: "settled",
    created_at: Date.now(),
    ...row,
  });
}

function seedRevenue(agentAddress: string, revenueUsdc: number): void {
  revenueByAgent.set(agentAddress, revenueUsdc);
}

// ─── Mirror of expansionCircuitBreaker.ts's 19b functions ─────────────

const PORTFOLIO_SPEND_CAP_FRACTION = 0.5; // config.portfolioSpendCapFraction default

function isEligibleForExpansion(agentAddress: string): { revenueUsdc: number } {
  return { revenueUsdc: revenueByAgent.get(agentAddress) ?? 0 };
}

function getTotalPipelineFundingDisbursedUsdc(rootAgentAddress: string): number {
  return payments
    .filter(
      (p) =>
        p.from_address === rootAgentAddress &&
        p.purpose === "clone-funding" &&
        (p.status === "pending" || p.status === "settled"),
    )
    .reduce((sum, p) => sum + Number(p.value_usdc) / 1_000_000, 0);
}

interface PortfolioSpendCapCheck {
  allowed: boolean;
  reason?: string;
  capUsdc: number;
  disbursedUsdc: number;
  revenueUsdc: number;
}

function checkPortfolioSpendCapacity(rootAgentAddress: string): PortfolioSpendCapCheck {
  const { revenueUsdc } = isEligibleForExpansion(rootAgentAddress);
  const capUsdc = revenueUsdc * PORTFOLIO_SPEND_CAP_FRACTION;
  const disbursedUsdc = getTotalPipelineFundingDisbursedUsdc(rootAgentAddress);

  if (disbursedUsdc >= capUsdc) {
    return {
      allowed: false,
      reason:
        `root agent ${rootAgentAddress} has already disbursed $${disbursedUsdc.toFixed(2)} ` +
        `to pipeline-spawned siblings, at or above its portfolio cap of $${capUsdc.toFixed(2)} ` +
        `(${PORTFOLIO_SPEND_CAP_FRACTION * 100}% of lifetime settled revenue of ` +
        `$${revenueUsdc.toFixed(2)}) — no further genesis funding until lifetime revenue grows, ` +
        `per Zent.md 19b`,
      capUsdc,
      disbursedUsdc,
      revenueUsdc,
    };
  }

  return { allowed: true, capUsdc, disbursedUsdc, revenueUsdc };
}

function checkPortfolioFundingRoom(rootAgentAddress: string): number {
  const { capUsdc, disbursedUsdc } = checkPortfolioSpendCapacity(rootAgentAddress);
  return Math.max(0, capUsdc - disbursedUsdc);
}

// ─── Mirror of genesis.ts's fundGenesisCompany() three-way clamp,
//     post-19b (per-call, per-day, portfolio) ──────────────────────────

const FUND_CONFIG = { maxCloneFundingUsdcPerCall: 500, maxCloneFundingUsdcPerAgentPerDay: 1000 };

function cloneFundingDisbursedTodayUsdc(fromAddress: string): number {
  const dayStart = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z").getTime();
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  return payments
    .filter(
      (p) =>
        p.from_address === fromAddress &&
        p.purpose === "clone-funding" &&
        (p.status === "pending" || p.status === "settled") &&
        p.created_at >= dayStart &&
        p.created_at < dayEnd,
    )
    .reduce((sum, p) => sum + Number(p.value_usdc) / 1_000_000, 0);
}

function clampFundingAmount(
  fromAddress: string,
  recommendedFundingUsdc: number | null,
): { amountUsdc: number; skipReason: "no-recommendation" | "day-cap-exhausted" | "portfolio-cap-exhausted" | null } {
  if (recommendedFundingUsdc === null || recommendedFundingUsdc <= 0) {
    return { amountUsdc: 0, skipReason: "no-recommendation" };
  }
  const perCallClamped = Math.min(recommendedFundingUsdc, FUND_CONFIG.maxCloneFundingUsdcPerCall);
  const disbursedToday = cloneFundingDisbursedTodayUsdc(fromAddress);
  const roomLeftToday = Math.max(0, FUND_CONFIG.maxCloneFundingUsdcPerAgentPerDay - disbursedToday);
  const roomLeftInPortfolio = checkPortfolioFundingRoom(fromAddress);
  const amountUsdc = Math.min(perCallClamped, roomLeftToday, roomLeftInPortfolio);

  if (amountUsdc <= 0) {
    return { amountUsdc: 0, skipReason: roomLeftInPortfolio <= 0 ? "portfolio-cap-exhausted" : "day-cap-exhausted" };
  }
  return { amountUsdc, skipReason: null };
}

// ─── 19a: checkGenesisSpawnCapacity ────────────────────────────────────

describe("checkGenesisSpawnCapacity", () => {
  test("allows a root agent with zero prior expansion-pipeline spawns", () => {
    resetState();
    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, true);
    assert.equal(result.reason, undefined);
  });

  test("allows a root agent below the cap", () => {
    resetState();
    seedAgent({ address: "b-1", parent_address: "root-1", spawn_reason: "expansion_pipeline" });
    seedAgent({ address: "b-2", parent_address: "root-1", spawn_reason: "expansion_pipeline" });

    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, true);
  });

  test("blocks a root agent that has hit the cap, naming count/cap/window in the reason", () => {
    resetState();
    for (let i = 0; i < MAX_GENESIS_SPAWNS_PER_WINDOW; i++) {
      seedAgent({ address: `b-${i}`, parent_address: "root-1", spawn_reason: "expansion_pipeline" });
    }

    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, false);
    assert.match(result.reason!, /already spawned 3/);
    assert.match(result.reason!, /cap 3/);
    assert.match(result.reason!, /24h/);
  });

  test("blocks a root agent that has exceeded the cap, not just met it", () => {
    resetState();
    for (let i = 0; i < MAX_GENESIS_SPAWNS_PER_WINDOW + 2; i++) {
      seedAgent({ address: `b-${i}`, parent_address: "root-1", spawn_reason: "expansion_pipeline" });
    }

    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, false);
  });

  test("a spawn older than the 24h window no longer counts against the cap", () => {
    resetState();
    const staleTime = Date.now() - GENESIS_WINDOW_MS - 60_000;
    for (let i = 0; i < MAX_GENESIS_SPAWNS_PER_WINDOW; i++) {
      seedAgent({
        address: `stale-${i}`,
        parent_address: "root-1",
        spawn_reason: "expansion_pipeline",
        created_at: staleTime,
      });
    }

    // All three spawns are outside the window, so the root is back under
    // capacity even though it has spawned MAX_GENESIS_SPAWNS_PER_WINDOW
    // companies in its lifetime.
    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, true);
  });

  test("a mix of stale and recent spawns only counts the recent ones", () => {
    resetState();
    const staleTime = Date.now() - GENESIS_WINDOW_MS - 60_000;
    seedAgent({ address: "stale-1", parent_address: "root-1", spawn_reason: "expansion_pipeline", created_at: staleTime });
    seedAgent({ address: "stale-2", parent_address: "root-1", spawn_reason: "expansion_pipeline", created_at: staleTime });
    seedAgent({ address: "recent-1", parent_address: "root-1", spawn_reason: "expansion_pipeline" });

    // Only 1 of 3 falls inside the window — still under the cap of 3.
    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, true);
  });

  test("an ordinary spawn_clone child (spawn_reason = 'self') never counts against the cap", () => {
    resetState();
    for (let i = 0; i < 10; i++) {
      seedAgent({ address: `self-${i}`, parent_address: "root-1", spawn_reason: "self" });
    }

    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, true);
  });

  test("another root agent's expansion-pipeline spawns never affect this root's capacity", () => {
    resetState();
    for (let i = 0; i < MAX_GENESIS_SPAWNS_PER_WINDOW; i++) {
      seedAgent({ address: `other-${i}`, parent_address: "root-2", spawn_reason: "expansion_pipeline" });
    }

    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, true);
  });

  test("a halted root is blocked even with zero prior spawns", () => {
    resetState();
    haltExpansionPipeline("root-1", "first-tick smoke test failed");

    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, false);
    assert.match(result.reason!, /halted for root-1/);
    assert.match(result.reason!, /first-tick smoke test failed/);
  });

  test("halting one root agent does not block a different root agent", () => {
    resetState();
    haltExpansionPipeline("root-1", "constitution violation");

    const result = checkGenesisSpawnCapacity("root-2");
    assert.equal(result.allowed, true);
  });
});

// ─── 19c (halt half): haltExpansionPipeline / resumeExpansionPipeline ──

describe("haltExpansionPipeline / resumeExpansionPipeline", () => {
  test("halting an already-halted root updates reason/timestamp rather than duplicating", () => {
    resetState();
    haltExpansionPipeline("root-1", "first failure");
    assert.equal(halts.size, 1);

    haltExpansionPipeline("root-1", "second, different failure");
    assert.equal(halts.size, 1, "upsert should not create a second row for the same root");
    assert.equal(getHaltedState("root-1")!.reason, "second, different failure");
  });

  test("resumeExpansionPipeline clears the halt and restores normal evaluation", () => {
    resetState();
    haltExpansionPipeline("root-1", "first-tick smoke test failed");
    assert.equal(checkGenesisSpawnCapacity("root-1").allowed, false);

    resumeExpansionPipeline("root-1");
    assert.equal(checkGenesisSpawnCapacity("root-1").allowed, true);
  });

  test("resumeExpansionPipeline on a root that was never halted is a no-op, not an error", () => {
    resetState();
    assert.doesNotThrow(() => resumeExpansionPipeline("root-never-halted"));
    assert.equal(checkGenesisSpawnCapacity("root-never-halted").allowed, true);
  });

  test("resume does not affect the cap: a resumed root still at cap is blocked again on the cap check", () => {
    resetState();
    for (let i = 0; i < MAX_GENESIS_SPAWNS_PER_WINDOW; i++) {
      seedAgent({ address: `b-${i}`, parent_address: "root-1", spawn_reason: "expansion_pipeline" });
    }
    haltExpansionPipeline("root-1", "manual halt");
    resumeExpansionPipeline("root-1");

    // Halt is cleared, but the root is still at its spawn cap.
    const result = checkGenesisSpawnCapacity("root-1");
    assert.equal(result.allowed, false);
    assert.match(result.reason!, /already spawned 3/);
  });
});

// ─── 19b: getTotalPipelineFundingDisbursedUsdc ─────────────────────────

describe("getTotalPipelineFundingDisbursedUsdc", () => {
  test("sums pending and settled clone-funding payments from this root, all-time", () => {
    resetPortfolioState();
    seedPayment({ from_address: "root-1", value_usdc: "100000000", status: "settled", created_at: 1000 });
    seedPayment({ from_address: "root-1", value_usdc: "50000000", status: "pending", created_at: 2000 });

    assert.equal(getTotalPipelineFundingDisbursedUsdc("root-1"), 150);
  });

  test("excludes failed payments", () => {
    resetPortfolioState();
    seedPayment({ from_address: "root-1", value_usdc: "100000000", status: "failed" });

    assert.equal(getTotalPipelineFundingDisbursedUsdc("root-1"), 0);
  });

  test("excludes payments with a purpose other than clone-funding", () => {
    resetPortfolioState();
    seedPayment({ from_address: "root-1", value_usdc: "100000000", purpose: "inference" });

    assert.equal(getTotalPipelineFundingDisbursedUsdc("root-1"), 0);
  });

  test("excludes another root agent's clone-funding payments", () => {
    resetPortfolioState();
    seedPayment({ from_address: "root-2", value_usdc: "100000000" });

    assert.equal(getTotalPipelineFundingDisbursedUsdc("root-1"), 0);
  });

  test("counts a payment made long ago — this is all-time, unlike 19a's 24h window", () => {
    resetPortfolioState();
    const longAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    seedPayment({ from_address: "root-1", value_usdc: "100000000", created_at: longAgo });

    assert.equal(getTotalPipelineFundingDisbursedUsdc("root-1"), 100);
  });
});

// ─── 19b: checkPortfolioSpendCapacity ──────────────────────────────────

describe("checkPortfolioSpendCapacity", () => {
  test("allows a root with no prior disbursements and positive revenue", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1000);

    const result = checkPortfolioSpendCapacity("root-1");
    assert.equal(result.allowed, true);
    assert.equal(result.capUsdc, 500); // 1000 * 0.5
    assert.equal(result.disbursedUsdc, 0);
  });

  test("allows a root disbursed below its cap", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1000); // cap = 500
    seedPayment({ from_address: "root-1", value_usdc: "300000000" }); // $300 disbursed

    const result = checkPortfolioSpendCapacity("root-1");
    assert.equal(result.allowed, true);
  });

  test("blocks a root disbursed exactly at its cap", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1000); // cap = 500
    seedPayment({ from_address: "root-1", value_usdc: "500000000" }); // $500 disbursed

    const result = checkPortfolioSpendCapacity("root-1");
    assert.equal(result.allowed, false);
    assert.match(result.reason!, /\$500\.00/);
    assert.match(result.reason!, /50% of lifetime settled revenue/);
  });

  test("blocks a root disbursed beyond its cap", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1000); // cap = 500
    seedPayment({ from_address: "root-1", value_usdc: "600000000" }); // $600 disbursed

    const result = checkPortfolioSpendCapacity("root-1");
    assert.equal(result.allowed, false);
  });

  test("a root with zero lifetime revenue has a $0 cap and is blocked even with zero disbursed", () => {
    resetPortfolioState();
    // No seedRevenue call — revenueUsdc defaults to 0.

    const result = checkPortfolioSpendCapacity("root-1");
    assert.equal(result.allowed, false);
    assert.equal(result.capUsdc, 0);
    assert.equal(result.disbursedUsdc, 0);
  });

  test("another root's disbursements never affect this root's cap check", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1000);
    seedPayment({ from_address: "root-2", value_usdc: "10000000000" }); // huge, but a different root

    const result = checkPortfolioSpendCapacity("root-1");
    assert.equal(result.allowed, true);
  });
});

// ─── 19b: checkPortfolioFundingRoom ────────────────────────────────────

describe("checkPortfolioFundingRoom", () => {
  test("returns the exact room left under the cap", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1000); // cap = 500
    seedPayment({ from_address: "root-1", value_usdc: "200000000" }); // $200 disbursed

    assert.equal(checkPortfolioFundingRoom("root-1"), 300);
  });

  test("returns 0, never negative, once disbursed has passed the cap", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1000); // cap = 500
    seedPayment({ from_address: "root-1", value_usdc: "900000000" }); // $900 disbursed

    assert.equal(checkPortfolioFundingRoom("root-1"), 0);
  });

  test("returns the full cap when nothing has been disbursed yet", () => {
    resetPortfolioState();
    seedRevenue("root-1", 2000); // cap = 1000

    assert.equal(checkPortfolioFundingRoom("root-1"), 1000);
  });
});

// ─── 19b: fundGenesisCompany's three-way clamp ─────────────────────────

describe("clampFundingAmount (fundGenesisCompany's per-call/per-day/portfolio clamp)", () => {
  test("a recommendation within all three ceilings goes out in full", () => {
    resetPortfolioState();
    seedRevenue("root-1", 10_000); // portfolio cap = 5000, plenty of room

    const result = clampFundingAmount("root-1", 200);
    assert.equal(result.amountUsdc, 200);
    assert.equal(result.skipReason, null);
  });

  test("null or non-positive recommendation is a no-recommendation skip, checked before any clamp", () => {
    resetPortfolioState();
    seedRevenue("root-1", 10_000);

    assert.equal(clampFundingAmount("root-1", null).skipReason, "no-recommendation");
    assert.equal(clampFundingAmount("root-1", 0).skipReason, "no-recommendation");
    assert.equal(clampFundingAmount("root-1", -50).skipReason, "no-recommendation");
  });

  test("the per-call cap clamps a recommendation above it, independent of portfolio room", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1_000_000); // enormous portfolio room

    const result = clampFundingAmount("root-1", 5000); // above maxCloneFundingUsdcPerCall (500)
    assert.equal(result.amountUsdc, 500);
    assert.equal(result.skipReason, null);
  });

  test("the portfolio cap is the binding constraint: reports portfolio-cap-exhausted, not day-cap-exhausted", () => {
    resetPortfolioState();
    seedRevenue("root-1", 100); // portfolio cap = $50, small
    seedPayment({ from_address: "root-1", value_usdc: "50000000" }); // already disbursed the full $50

    // Day cap (1000) and per-call cap (500) both have plenty of room —
    // only the portfolio cap is actually exhausted.
    const result = clampFundingAmount("root-1", 200);
    assert.equal(result.amountUsdc, 0);
    assert.equal(result.skipReason, "portfolio-cap-exhausted");
  });

  test("the day cap is the binding constraint when portfolio room exists but today's disbursements don't", () => {
    resetPortfolioState();
    seedRevenue("root-1", 1_000_000); // enormous portfolio room
    seedPayment({ from_address: "root-1", value_usdc: "1000000000", created_at: Date.now() }); // $1000 disbursed today

    const result = clampFundingAmount("root-1", 200);
    assert.equal(result.amountUsdc, 0);
    assert.equal(result.skipReason, "day-cap-exhausted");
  });

  test("a recommendation gets clamped down to whatever portfolio room remains, not zeroed, when some room is left", () => {
    resetPortfolioState();
    seedRevenue("root-1", 400); // portfolio cap = $200
    seedPayment({ from_address: "root-1", value_usdc: "150000000" }); // $150 disbursed already

    // $50 of portfolio room left; recommendation of $200 is clamped down
    // to that $50, not rejected outright.
    const result = clampFundingAmount("root-1", 200);
    assert.equal(result.amountUsdc, 50);
    assert.equal(result.skipReason, null);
  });
});
