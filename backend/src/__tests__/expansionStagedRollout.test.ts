// Zent.md Phase 20d: "Staged rollout: dry-run mode (19e) only, for the
// first real profitable agent in production, before enabling real
// genesis."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory gives. This mirrors the
// real functions added to expansion.ts (getRolloutStage,
// isDryRunModeEffective, checkRolloutGraduationEligibility,
// graduateToLiveGenesis, demoteToDryRunOnly) and the one-line change to
// expansionCircuitBreaker.ts's haltExpansionPipeline() that calls
// demoteToDryRunOnly() — not expansion.ts's already-covered 19e
// toggle (isDryRunModeEnabled/setDryRunModeEnabled), its already-covered
// 15a-d decision flow (expansionCeoDecision.test.ts), or its
// already-covered 19a/19c rate-limit/halt mechanics
// (expansionCircuitBreaker.test.ts, if present, or genesis.ts's own
// smoke tests) — those keep their own dedicated coverage.
//
// Recommend re-running against the real expansion.ts /
// expansionCircuitBreaker.ts / db.ts once a networked environment with
// a live Docker daemon and a real better-sqlite3 connection is
// available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion_pipeline_config + rollout_graduation_events + dry_run_genesis_packets ───

type RolloutStage = "dry_run_only" | "live_enabled";

interface AgentConfig {
  dryRunMode: boolean;
  rolloutStage: RolloutStage;
}

let agentConfigs: Map<string, AgentConfig>;
let dryRunPacketCounts: Map<string, number>; // agentAddress -> count of dry_run_genesis_packets rows
let circuitBreakerHalted: Set<string>;
let profitableAgents: Set<string>;
let graduationEvents: { agentAddress: string; eventType: "graduated" | "demoted"; reason: string; dryRunPacketCount: number }[];

const MIN_DRY_RUN_PACKETS = 3; // mirrors config.rolloutGraduationMinDryRunPackets's default

function reset(): void {
  agentConfigs = new Map();
  dryRunPacketCounts = new Map();
  circuitBreakerHalted = new Set();
  profitableAgents = new Set();
  graduationEvents = [];
}

// ─── Mirror of getRolloutStage() ────────────────────────────────────

function getRolloutStage(agentAddress: string): RolloutStage {
  return agentConfigs.get(agentAddress)?.rolloutStage ?? "dry_run_only";
}

function isDryRunModeEnabled(agentAddress: string): boolean {
  return agentConfigs.get(agentAddress)?.dryRunMode ?? false;
}

function setDryRunModeEnabled(agentAddress: string, enabled: boolean): void {
  const existing = agentConfigs.get(agentAddress) ?? { dryRunMode: false, rolloutStage: "dry_run_only" as RolloutStage };
  agentConfigs.set(agentAddress, { ...existing, dryRunMode: enabled });
}

// ─── Mirror of isDryRunModeEffective() ──────────────────────────────

function isDryRunModeEffective(agentAddress: string): boolean {
  return getRolloutStage(agentAddress) === "dry_run_only" || isDryRunModeEnabled(agentAddress);
}

// ─── Mirror of checkRolloutGraduationEligibility() ──────────────────

interface Eligibility {
  eligible: boolean;
  reason?: string;
  dryRunPacketCount: number;
  minDryRunPacketsRequired: number;
  circuitBreakerHalted: boolean;
  currentlyProfitable: boolean;
}

function checkRolloutGraduationEligibility(agentAddress: string): Eligibility {
  const dryRunPacketCount = dryRunPacketCounts.get(agentAddress) ?? 0;
  const minDryRunPacketsRequired = MIN_DRY_RUN_PACKETS;
  const halted = circuitBreakerHalted.has(agentAddress);
  const currentlyProfitable = profitableAgents.has(agentAddress);

  if (getRolloutStage(agentAddress) === "live_enabled") {
    return {
      eligible: false,
      reason: `already graduated`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted: halted,
      currentlyProfitable,
    };
  }
  if (dryRunPacketCount < minDryRunPacketsRequired) {
    return {
      eligible: false,
      reason: `needs ${minDryRunPacketsRequired}, has ${dryRunPacketCount}`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted: halted,
      currentlyProfitable,
    };
  }
  if (halted) {
    return {
      eligible: false,
      reason: `circuit breaker active`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted: halted,
      currentlyProfitable,
    };
  }
  if (!currentlyProfitable) {
    return {
      eligible: false,
      reason: `not profitable`,
      dryRunPacketCount,
      minDryRunPacketsRequired,
      circuitBreakerHalted: halted,
      currentlyProfitable,
    };
  }
  return { eligible: true, dryRunPacketCount, minDryRunPacketsRequired, circuitBreakerHalted: halted, currentlyProfitable };
}

// ─── Mirror of graduateToLiveGenesis() / demoteToDryRunOnly() ──────

function graduateToLiveGenesis(agentAddress: string): void {
  const check = checkRolloutGraduationEligibility(agentAddress);
  if (!check.eligible) {
    throw new Error(check.reason ?? "not eligible");
  }
  const existing = agentConfigs.get(agentAddress) ?? { dryRunMode: false, rolloutStage: "dry_run_only" as RolloutStage };
  agentConfigs.set(agentAddress, { ...existing, rolloutStage: "live_enabled" });
  graduationEvents.push({
    agentAddress,
    eventType: "graduated",
    reason: `graduated after ${check.dryRunPacketCount} packets`,
    dryRunPacketCount: check.dryRunPacketCount,
  });
}

function demoteToDryRunOnly(agentAddress: string, reason: string): void {
  if (getRolloutStage(agentAddress) !== "live_enabled") return;
  const existing = agentConfigs.get(agentAddress)!;
  agentConfigs.set(agentAddress, { ...existing, rolloutStage: "dry_run_only" });
  graduationEvents.push({
    agentAddress,
    eventType: "demoted",
    reason,
    dryRunPacketCount: dryRunPacketCounts.get(agentAddress) ?? 0,
  });
}

// ─── Mirror of haltExpansionPipeline()'s Phase 20d addition ─────────

function haltExpansionPipeline(agentAddress: string, reason: string): void {
  circuitBreakerHalted.add(agentAddress);
  demoteToDryRunOnly(agentAddress, `19c circuit breaker tripped: ${reason}`);
}

function resumeExpansionPipeline(agentAddress: string): void {
  circuitBreakerHalted.delete(agentAddress);
}

// ═════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════

test("20d: a brand-new agent, and any agent that predates this phase, defaults to dry_run_only", () => {
  reset();
  assert.equal(getRolloutStage("0xNEW"), "dry_run_only");
  assert.equal(isDryRunModeEffective("0xNEW"), true, "effective dry-run is on even though the agent never touched the 19e toggle");
});

test("20d: rollout_stage forces dry-run even if the agent's own 19e toggle is explicitly off", () => {
  reset();
  setDryRunModeEnabled("0xAGENT", false); // agent explicitly wants live behavior
  assert.equal(isDryRunModeEnabled("0xAGENT"), false);
  assert.equal(getRolloutStage("0xAGENT"), "dry_run_only");
  assert.equal(
    isDryRunModeEffective("0xAGENT"),
    true,
    "an un-graduated root cannot escape dry-run by flipping its own toggle",
  );
});

test("20d: graduation is refused below the minimum dry-run packet count", () => {
  reset();
  dryRunPacketCounts.set("0xAGENT", 2);
  profitableAgents.add("0xAGENT");
  const check = checkRolloutGraduationEligibility("0xAGENT");
  assert.equal(check.eligible, false);
  assert.match(check.reason!, /needs 3, has 2/);
  assert.throws(() => graduateToLiveGenesis("0xAGENT"));
  assert.equal(getRolloutStage("0xAGENT"), "dry_run_only");
});

test("20d: graduation is refused while the circuit breaker is tripped, even with enough packets and profit", () => {
  reset();
  dryRunPacketCounts.set("0xAGENT", 10);
  profitableAgents.add("0xAGENT");
  circuitBreakerHalted.add("0xAGENT");
  const check = checkRolloutGraduationEligibility("0xAGENT");
  assert.equal(check.eligible, false);
  assert.match(check.reason!, /circuit breaker/);
  assert.throws(() => graduateToLiveGenesis("0xAGENT"));
});

test("20d: graduation is refused if the agent is not currently profitable, even with enough packets", () => {
  reset();
  dryRunPacketCounts.set("0xAGENT", 10);
  // not profitable
  const check = checkRolloutGraduationEligibility("0xAGENT");
  assert.equal(check.eligible, false);
  assert.match(check.reason!, /not profitable/);
});

test("20d: meeting all three conditions graduates the agent, writes one audit event, and flips isDryRunModeEffective", () => {
  reset();
  dryRunPacketCounts.set("0xAGENT", 3);
  profitableAgents.add("0xAGENT");

  graduateToLiveGenesis("0xAGENT");

  assert.equal(getRolloutStage("0xAGENT"), "live_enabled");
  assert.equal(graduationEvents.length, 1);
  assert.equal(graduationEvents[0].eventType, "graduated");
  assert.equal(graduationEvents[0].dryRunPacketCount, 3);

  // Now the agent's own 19e toggle actually governs again.
  assert.equal(isDryRunModeEffective("0xAGENT"), false, "graduated + toggle off => real genesis path");
  setDryRunModeEnabled("0xAGENT", true);
  assert.equal(isDryRunModeEffective("0xAGENT"), true, "graduated agents can still opt back into dry-run voluntarily");
});

test("20d: graduation is idempotent — a second call on an already-graduated agent throws and writes no second event", () => {
  reset();
  dryRunPacketCounts.set("0xAGENT", 5);
  profitableAgents.add("0xAGENT");
  graduateToLiveGenesis("0xAGENT");
  assert.equal(graduationEvents.length, 1);

  assert.throws(() => graduateToLiveGenesis("0xAGENT"), /already graduated/);
  assert.equal(graduationEvents.length, 1, "no duplicate graduation event from the rejected second call");
});

test("20d: a 19c circuit-breaker halt after graduation demotes the agent back to dry_run_only", () => {
  reset();
  dryRunPacketCounts.set("0xAGENT", 5);
  profitableAgents.add("0xAGENT");
  graduateToLiveGenesis("0xAGENT");
  assert.equal(getRolloutStage("0xAGENT"), "live_enabled");

  haltExpansionPipeline("0xAGENT", "first-tick smoke test failed");

  assert.equal(getRolloutStage("0xAGENT"), "dry_run_only", "the halt also revokes live-genesis, not just pausing spawns");
  assert.equal(isDryRunModeEffective("0xAGENT"), true);
  const demotionEvent = graduationEvents.find((e) => e.eventType === "demoted");
  assert.ok(demotionEvent, "a demotion audit event was written");
  assert.match(demotionEvent!.reason, /circuit breaker tripped/);
});

test("20d: halting an agent that was never graduated is a harmless no-op for rollout_stage", () => {
  reset();
  assert.equal(getRolloutStage("0xNEVER_GRADUATED"), "dry_run_only");
  haltExpansionPipeline("0xNEVER_GRADUATED", "some other failure");
  assert.equal(getRolloutStage("0xNEVER_GRADUATED"), "dry_run_only");
  assert.equal(graduationEvents.length, 0, "no demotion event written for a root that was never live_enabled");
});

test("20d: a demoted agent must re-earn graduation the same way — resuming the pipeline (19c) does not itself restore live_enabled", () => {
  reset();
  dryRunPacketCounts.set("0xAGENT", 5);
  profitableAgents.add("0xAGENT");
  graduateToLiveGenesis("0xAGENT");
  haltExpansionPipeline("0xAGENT", "constitution violation on first tick");
  assert.equal(getRolloutStage("0xAGENT"), "dry_run_only");

  resumeExpansionPipeline("0xAGENT"); // 19c's own resume — only clears the halt, per that function's own header
  assert.equal(circuitBreakerHalted.has("0xAGENT"), false);
  assert.equal(
    getRolloutStage("0xAGENT"),
    "dry_run_only",
    "resuming the pipeline is not the same as re-graduating — rollout_stage stays demoted until re-earned",
  );

  // Re-earning: still eligible immediately since packet count/profitability never changed
  // and the breaker is clear again.
  const check = checkRolloutGraduationEligibility("0xAGENT");
  assert.equal(check.eligible, true);
  graduateToLiveGenesis("0xAGENT");
  assert.equal(getRolloutStage("0xAGENT"), "live_enabled");
});

test("20d: two different agents' rollout stages are fully independent", () => {
  reset();
  dryRunPacketCounts.set("0xA", 5);
  profitableAgents.add("0xA");
  graduateToLiveGenesis("0xA");

  assert.equal(getRolloutStage("0xA"), "live_enabled");
  assert.equal(getRolloutStage("0xB"), "dry_run_only", "an unrelated agent is unaffected by 0xA's graduation");
});
