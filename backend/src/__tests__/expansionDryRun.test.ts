// Zent.md Phase 19e: "Full-pipeline dry-run mode: run Phases 2–15 to
// completion, produce a genesis-ready packet, but stop short of 16 —
// for testing the whole reasoning chain without actually spending
// funding."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this is an
// inlined mirror of decideExpansion()'s Phase 19e fork (isDryRunModeEnabled()/
// setDryRunModeEnabled()/recordDryRunGenesisPacket() from expansion.ts),
// built directly on top of the same minimal opportunity/decision/
// genesis-trigger scaffolding expansionCeoDecision.test.ts already uses,
// so this file only exercises what's actually new here: the dry-run
// config switch and the fork it creates at `approved` ruling time.
// Recommend re-running against the real expansion.ts once a networked
// environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Minimal opportunity + decision scaffolding (mirrors expansionCeoDecision.test.ts) ─

interface Opportunity {
  id: string;
  agentAddress: string;
}

let opportunities: Map<string, Opportunity>;
let dryRunModeByAgent: Map<string, boolean>; // mirrors expansion_pipeline_config.dry_run_mode
let decisions: Map<string, Decision[]>;
let decisionSeq: number;
let genesisTriggers: Map<string, GenesisTrigger>;
let genesisTriggerSeq: number;
let dryRunPackets: Map<string, DryRunPacket>; // opportunityId -> row, mirrors UNIQUE(opportunity_id)
let dryRunPacketSeq: number;
let genesisExecutorCallCount: number;

function reset() {
  opportunities = new Map();
  dryRunModeByAgent = new Map();
  decisions = new Map();
  decisionSeq = 0;
  genesisTriggers = new Map();
  genesisTriggerSeq = 0;
  dryRunPackets = new Map();
  dryRunPacketSeq = 0;
  genesisExecutorCallCount = 0;
}

function makeOpportunity(id: string, agentAddress: string = "agent_a"): Opportunity {
  const o: Opportunity = { id, agentAddress };
  opportunities.set(id, o);
  return o;
}

// ─── 19e mirror: isDryRunModeEnabled() / setDryRunModeEnabled() ────────

function isDryRunModeEnabled(agentAddress: string): boolean {
  return dryRunModeByAgent.get(agentAddress) ?? false;
}

function setDryRunModeEnabled(agentAddress: string, enabled: boolean): void {
  if (!agentAddress) throw new Error("agentAddress is required");
  dryRunModeByAgent.set(agentAddress, enabled);
}

// ─── 1d / 15d mirrors ────────────────────────────────────────────────

type CeoDecision = "approved" | "rejected" | "deferred";

interface Decision {
  id: string;
  opportunityId: string;
  ceoDecision: CeoDecision;
  decidedBy: string;
}

function recordExpansionDecision(opportunityId: string, ceoDecision: CeoDecision, decidedBy: string): Decision {
  const row: Decision = { id: `xdec_${++decisionSeq}`, opportunityId, ceoDecision, decidedBy };
  if (!decisions.has(opportunityId)) decisions.set(opportunityId, []);
  decisions.get(opportunityId)!.push(row);
  return row;
}

interface GenesisTrigger {
  id: string;
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
}

function fireGenesisTrigger(opportunityId: string, decision: Decision, agentAddress: string): GenesisTrigger {
  const trigger: GenesisTrigger = {
    id: `gentrig_${++genesisTriggerSeq}`,
    opportunityId,
    decisionId: decision.id,
    agentAddress,
  };
  genesisTriggers.set(opportunityId, trigger);
  genesisExecutorCallCount += 1; // stands in for the real genesisExecutor() call
  return trigger;
}

// ─── 19e mirror: dry_run_genesis_packets + recordDryRunGenesisPacket() ──

interface DryRunPacket {
  id: string;
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
  committeePacket: { fake: true };
}

function recordDryRunGenesisPacket(opportunityId: string, decision: Decision, agentAddress: string): DryRunPacket {
  // Mirrors the real table's UNIQUE(opportunity_id) — a second call for
  // the same opportunity throws rather than silently double-recording.
  if (dryRunPackets.has(opportunityId)) {
    throw new Error(`dry-run genesis packet for opportunity ${opportunityId} already recorded`);
  }
  const row: DryRunPacket = {
    id: `dryrun_${++dryRunPacketSeq}`,
    opportunityId,
    decisionId: decision.id,
    agentAddress,
    committeePacket: { fake: true },
  };
  dryRunPackets.set(opportunityId, row);
  return row;
}

// ─── decideExpansion mirror, Phase 19e fork only ────────────────────────
//
// Simplified relative to expansionCeoDecision.test.ts's own mirror: no
// 13e/14a/14d gates re-exercised here (those already have their own
// dedicated test files) — this function assumes a decidable packet and
// focuses entirely on what happens at the `approved` branch, which is
// the only place Phase 19e changes anything.

interface DecideResult {
  decision: Decision;
  genesisTrigger: GenesisTrigger | null;
  dryRunPacket: DryRunPacket | null;
}

function decideExpansion(opportunityId: string, decision: CeoDecision, decidedBy: string): DecideResult {
  const o = opportunities.get(opportunityId);
  if (!o) throw new Error(`opportunity ${opportunityId} not found`);
  const recorded = recordExpansionDecision(opportunityId, decision, decidedBy);
  let genesisTrigger: GenesisTrigger | null = null;
  let dryRunPacket: DryRunPacket | null = null;
  if (decision === "approved") {
    // Phase 19e: read fresh, right at ruling time.
    if (isDryRunModeEnabled(o.agentAddress)) {
      dryRunPacket = recordDryRunGenesisPacket(opportunityId, recorded, o.agentAddress);
    } else {
      genesisTrigger = fireGenesisTrigger(opportunityId, recorded, o.agentAddress);
    }
  }
  return { decision: recorded, genesisTrigger, dryRunPacket };
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("19e: dry-run mode defaults to off for an agent with no config row", () => {
  reset();
  assert.equal(isDryRunModeEnabled("agent_never_configured"), false);
});

test("19e: setDryRunModeEnabled requires an agentAddress", () => {
  reset();
  assert.throws(() => setDryRunModeEnabled("", true), /agentAddress is required/);
});

test("19e: setDryRunModeEnabled is per-agent — flipping one agent doesn't affect another", () => {
  reset();
  setDryRunModeEnabled("agent_a", true);
  assert.equal(isDryRunModeEnabled("agent_a"), true);
  assert.equal(isDryRunModeEnabled("agent_b"), false);
});

test("19e: dry-run mode ON — approved ruling produces a dry-run packet, never fires genesis, never spends", () => {
  reset();
  makeOpportunity("opp_1", "agent_a");
  setDryRunModeEnabled("agent_a", true);
  const result = decideExpansion("opp_1", "approved", "agent_ceo");
  assert.equal(result.decision.ceoDecision, "approved");
  assert.ok(result.dryRunPacket, "dry-run packet should be produced");
  assert.equal(result.genesisTrigger, null, "genesis trigger must stay null under dry-run mode");
  assert.equal(genesisTriggers.has("opp_1"), false, "no genesis_triggers row should ever be written");
  assert.equal(genesisExecutorCallCount, 0, "the real genesisExecutor must never be invoked — no spend");
});

test("19e: dry-run mode OFF (default) — approved ruling fires genesis exactly as Phase 15d always did", () => {
  reset();
  makeOpportunity("opp_1", "agent_a");
  // isDryRunModeEnabled defaults false — no explicit setDryRunModeEnabled call.
  const result = decideExpansion("opp_1", "approved", "agent_ceo");
  assert.ok(result.genesisTrigger, "genesis trigger should fire exactly as before this phase");
  assert.equal(result.dryRunPacket, null);
  assert.equal(genesisExecutorCallCount, 1);
});

test("19e: rejected and deferred never produce a dry-run packet, even with dry-run mode on", () => {
  reset();
  makeOpportunity("opp_1", "agent_a");
  makeOpportunity("opp_2", "agent_a");
  setDryRunModeEnabled("agent_a", true);
  const rejected = decideExpansion("opp_1", "rejected", "agent_ceo");
  assert.equal(rejected.dryRunPacket, null);
  assert.equal(rejected.genesisTrigger, null);
  const deferred = decideExpansion("opp_2", "deferred", "agent_ceo");
  assert.equal(deferred.dryRunPacket, null);
  assert.equal(deferred.genesisTrigger, null);
  assert.equal(genesisExecutorCallCount, 0);
});

test("19e: toggling dry-run mode off after the fact does not retroactively remove an already-produced packet", () => {
  reset();
  makeOpportunity("opp_1", "agent_a");
  setDryRunModeEnabled("agent_a", true);
  decideExpansion("opp_1", "approved", "agent_ceo");
  assert.ok(dryRunPackets.has("opp_1"));
  setDryRunModeEnabled("agent_a", false);
  assert.ok(dryRunPackets.has("opp_1"), "flipping the switch later must not erase prior history");
});

test("19e: dry-run mode is read fresh at ruling time, not cached from when the opportunity was created", () => {
  reset();
  makeOpportunity("opp_1", "agent_a"); // created while dry-run mode is off
  setDryRunModeEnabled("agent_a", true); // flipped on before the CEO ever rules
  const result = decideExpansion("opp_1", "approved", "agent_ceo");
  assert.ok(result.dryRunPacket, "the flag at decision time governs, not at opportunity-creation time");
  assert.equal(result.genesisTrigger, null);
});

test("19e: recordDryRunGenesisPacket is idempotent-guarded — a second dry-run approval on the same opportunity is unreachable via decideExpansion, but the primitive itself still refuses a duplicate", () => {
  reset();
  makeOpportunity("opp_1", "agent_a");
  setDryRunModeEnabled("agent_a", true);
  const { decision } = decideExpansion("opp_1", "approved", "agent_ceo");
  assert.throws(
    () => recordDryRunGenesisPacket("opp_1", decision, "agent_a"),
    /already recorded/,
  );
});

test("19e: genesisTrigger and dryRunPacket are mutually exclusive on every result", () => {
  reset();
  makeOpportunity("opp_dry", "agent_dry");
  makeOpportunity("opp_live", "agent_live");
  setDryRunModeEnabled("agent_dry", true);
  const dry = decideExpansion("opp_dry", "approved", "agent_ceo");
  const live = decideExpansion("opp_live", "approved", "agent_ceo");
  assert.ok(dry.dryRunPacket && !dry.genesisTrigger, "dry-run agent gets a packet, never a trigger");
  assert.ok(!live.dryRunPacket && live.genesisTrigger, "live agent gets a trigger, never a packet");
});
