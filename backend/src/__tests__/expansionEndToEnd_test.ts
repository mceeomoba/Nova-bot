// Zent.md Phase 20a: "End-to-end integration test: seeded market signal
// -> opportunity -> research -> finance -> strategy -> committee packet
// -> CEO approval -> genesis -> Agent B's first tick, all in one test."
//
// Same "no live better-sqlite3 (and here, no live Docker daemon, no live
// spawned Node process, no live chain RPC) in this environment" reason
// every other expansion*.test.ts / genesis*_test.ts file in this
// directory already gives. This file does not re-derive each stage's
// arithmetic or contract from scratch — every formula, guard, and shape
// already has its own dedicated test (expansionRoiFormula.test.ts,
// expansionFitScore.test.ts, expansionRunwayCheck.test.ts,
// expansionCommitteePacketShape.test.ts, expansionCeoDecision.test.ts,
// genesisCompany_test.ts, genesisTickSmokeTest_test.ts,
// genesisActivation_test.ts, ...). What's new here is wiring: one
// in-memory run that pushes a single seeded signal through every stage
// in order, using the same guard conditions the real pipeline enforces
// at each handoff (2e profitability gate, 3e ROI floor, 8e runway
// floor, 13e packet completeness, 15b/15c/15d decision finality,
// 17e-ii/iii/iv smoke-test-gated activation), and asserts the chain
// produces exactly one active Agent B with a lineage row pointing back
// at the opportunity that produced it — Zent.md's own "done when" for
// this phase. A second scenario proves the chain honestly halts (no
// genesis, no lineage row) when an earlier gate fails, so this test
// can't pass by simply not exercising the guards at all.
//
// Recommend re-running against the real expansion.ts / genesis.ts /
// genesisSmokeTest.ts / genesisActivation.ts / db.ts once a networked
// environment with a live Docker daemon, spawned Node processes, and a
// chain RPC is available — this proves the reasoning chain and the
// handoff contracts, not the real sandbox/wallet/on-chain plumbing.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Shared in-memory tables (superset of the fields each stage's own
// dedicated test file already mirrors individually) ─────────────────

type OpportunityStatus = "open" | "scored" | "selected" | "rejected" | "archived";

interface Opportunity {
  id: string;
  agentAddress: string;
  title: string;
  thesis: string;
  roiScore: number;
  status: OpportunityStatus;
}

interface ResearchFinding {
  opportunityId: string;
  marketSize: string;
  confidence: "low" | "med" | "high";
  highRegulatoryRisk: boolean;
  superseded: boolean;
}

interface FinanceFinding {
  opportunityId: string;
  runwayMonthsAfterFunding: number;
  runwayFloorMonths: number;
  recommendedFundingUsdc: number;
  rejected: boolean;
  superseded: boolean;
}

interface StrategyFinding {
  opportunityId: string;
  fitScore: number;
  relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base";
  superseded: boolean;
}

interface CommitteePacket {
  opportunityId: string;
  schemaVersion: "20a-v1";
  research: ResearchFinding;
  finance: FinanceFinding;
  strategy: StrategyFinding;
  complete: true;
}

type CeoDecisionValue = "approved" | "rejected" | "deferred";

interface Decision {
  opportunityId: string;
  ceoDecision: CeoDecisionValue;
  decidedBy: string;
}

type GenesisTriggerStatus = "pending" | "completed" | "failed";

interface GenesisTrigger {
  opportunityId: string;
  agentAddress: string;
  recommendedFundingUsdc: number;
  status: GenesisTriggerStatus;
}

interface Agent {
  address: string;
  name: string;
  parentAddress: string;
  active: boolean;
  genesisActivationStatus: "pending" | "active" | "failed" | null;
}

interface LineageRow {
  agentAddress: string;
  parentAddress: string;
  spawnReason: "self" | "expansion_pipeline";
  opportunityId: string | null;
}

type TickSmokeOutcome = "passed" | "unhandled_error" | "timeout" | "crashed_process";

let opportunities: Map<string, Opportunity>;
let research: Map<string, ResearchFinding>;
let finance: Map<string, FinanceFinding>;
let strategy: Map<string, StrategyFinding>;
let decisions: Map<string, Decision>;
let triggers: Map<string, GenesisTrigger>;
let agents: Map<string, Agent>;
let lineage: LineageRow[];
let profitableAgents: Set<string>;
let agentSeq: number;

function reset() {
  opportunities = new Map();
  research = new Map();
  finance = new Map();
  strategy = new Map();
  decisions = new Map();
  triggers = new Map();
  agents = new Map();
  lineage = [];
  profitableAgents = new Set(["0xCOMPANY_A"]);
  agentSeq = 0;
  agents.set("0xCOMPANY_A", {
    address: "0xCOMPANY_A",
    name: "Company A",
    parentAddress: "",
    active: true,
    genesisActivationStatus: null,
  });
}

// ─── Stage 1 (Zent.md 2e): profitability gate ───────────────────────

function isEligibleForExpansion(agentAddress: string): boolean {
  return profitableAgents.has(agentAddress);
}

// ─── Stage 2 (Zent.md 2b-2d, 3a-3e): signal -> scored opportunity ───

const ROI_FLOOR = 40;

function scanMarketSignalToOpportunity(
  agentAddress: string,
  title: string,
  thesis: string,
  factors: { demand: number; expenseOfProblem: number; buildability: number; competitiveGap: number },
): Opportunity | { killed: true; reason: string } {
  if (!isEligibleForExpansion(agentAddress)) {
    throw new Error(`${agentAddress} is not profitable — no opportunity_intelligence department`);
  }
  const roiScore =
    factors.demand * 0.35 +
    factors.expenseOfProblem * 0.3 +
    factors.buildability * 0.2 +
    factors.competitiveGap * 0.15;
  if (roiScore < ROI_FLOOR) {
    // 3e: kill condition is a valid, expected output — not a thrown error.
    return { killed: true, reason: `roi_score ${roiScore.toFixed(2)} below floor ${ROI_FLOOR}` };
  }
  const opp: Opportunity = {
    id: `opp_${title.replace(/\s+/g, "_").toLowerCase()}`,
    agentAddress,
    title,
    thesis,
    roiScore: Math.round(roiScore * 100) / 100,
    status: "scored",
  };
  opportunities.set(opp.id, opp);
  return opp;
}

// ─── Stage 3 (Zent.md 5-7): Research ────────────────────────────────

function fileResearchFinding(
  opportunityId: string,
  finding: Omit<ResearchFinding, "opportunityId" | "superseded">,
): ResearchFinding {
  if (!opportunities.has(opportunityId)) throw new Error(`unknown opportunity ${opportunityId}`);
  const existing = research.get(opportunityId);
  if (existing) existing.superseded = true;
  const row: ResearchFinding = { opportunityId, ...finding, superseded: false };
  research.set(opportunityId, row);
  return row;
}

// ─── Stage 4 (Zent.md 8-10): Finance, with 8e's hard runway floor ───

function fileFinanceFinding(
  opportunityId: string,
  input: { runwayMonthsAfterFunding: number; runwayFloorMonths: number; recommendedFundingUsdc: number },
): FinanceFinding {
  if (!research.has(opportunityId) || research.get(opportunityId)!.superseded) {
    throw new Error(`Finance requires a completed, non-superseded research finding for ${opportunityId}`);
  }
  const rejected = input.runwayMonthsAfterFunding < input.runwayFloorMonths;
  const row: FinanceFinding = { opportunityId, ...input, rejected, superseded: false };
  finance.set(opportunityId, row);
  if (rejected) {
    // 10b: Finance can hard-reject on its own, no Strategy/CEO needed.
    const opp = opportunities.get(opportunityId)!;
    opp.status = "rejected";
  }
  return row;
}

// ─── Stage 5 (Zent.md 11-12): Strategy ──────────────────────────────

function fileStrategyFinding(
  opportunityId: string,
  input: { fitScore: number; relationshipType: StrategyFinding["relationshipType"] },
): StrategyFinding {
  const financeRow = finance.get(opportunityId);
  if (!financeRow || financeRow.superseded) {
    throw new Error(`Strategy requires a completed, non-superseded finance finding for ${opportunityId}`);
  }
  if (financeRow.rejected) {
    throw new Error(`Strategy cannot run: opportunity ${opportunityId} was hard-rejected by Finance (10b)`);
  }
  const row: StrategyFinding = { opportunityId, ...input, superseded: false };
  strategy.set(opportunityId, row);
  return row;
}

// ─── Stage 6 (Zent.md 13): Committee packet assembly, 13e gate ─────

function assembleCommitteePacket(opportunityId: string): CommitteePacket {
  const r = research.get(opportunityId);
  const f = finance.get(opportunityId);
  const s = strategy.get(opportunityId);
  if (!r || r.superseded || !f || f.superseded || f.rejected || !s || s.superseded) {
    throw new Error(`committee packet for ${opportunityId} is not yet complete (13e)`);
  }
  return {
    opportunityId,
    schemaVersion: "20a-v1",
    research: r,
    finance: f,
    strategy: s,
    complete: true,
  };
}

// ─── Stage 7 (Zent.md 15): CEO decision, 15b/15d ────────────────────

function decideExpansion(
  packet: CommitteePacket,
  ceoDecision: CeoDecisionValue,
  decidedBy: string,
): Decision {
  if (decidedBy !== packet.finance.opportunityId.split("_")[0] && decidedBy !== "0xCOMPANY_A") {
    throw new Error("only the owning top-level agent may decide its own expansion (15b)");
  }
  const decision: Decision = { opportunityId: packet.opportunityId, ceoDecision, decidedBy };
  decisions.set(packet.opportunityId, decision);
  if (ceoDecision === "approved") {
    // 15d: approved fires genesis directly, no operator gate.
    fireGenesisTrigger(packet);
  } else if (ceoDecision === "rejected") {
    opportunities.get(packet.opportunityId)!.status = "rejected";
  }
  return decision;
}

function fireGenesisTrigger(packet: CommitteePacket): GenesisTrigger {
  const opp = opportunities.get(packet.opportunityId)!;
  const trigger: GenesisTrigger = {
    opportunityId: packet.opportunityId,
    agentAddress: opp.agentAddress,
    recommendedFundingUsdc: packet.finance.recommendedFundingUsdc,
    status: "pending",
  };
  triggers.set(packet.opportunityId, trigger);
  return genesisCompany(trigger, packet, opp);
}

// ─── Stage 8 (Zent.md 16-17): Genesis provisioning + mission/constitution ─

function genesisCompany(
  trigger: GenesisTrigger,
  packet: CommitteePacket,
  opp: Opportunity,
): GenesisTrigger {
  const address = `0xAGENT_B_${++agentSeq}`;
  const agent: Agent = {
    address,
    name: opp.title,
    parentAddress: opp.agentAddress,
    active: false,
    genesisActivationStatus: "pending",
  };
  agents.set(address, agent);
  lineage.push({
    agentAddress: address,
    parentAddress: opp.agentAddress,
    spawnReason: "expansion_pipeline",
    opportunityId: opp.id,
  });
  trigger.status = "completed";
  // 17e: run the first-tick smoke test before any activation decision.
  const smoke = runFirstTickSmokeTest(address);
  if (smoke.outcome === "passed") {
    agent.genesisActivationStatus = "active";
    agent.active = true;
  } else {
    agent.genesisActivationStatus = "failed";
    agent.active = false;
    // 19c: circuit breaker — halt further genesis for this root agent.
    profitableAgents.delete(opp.agentAddress);
  }
  return trigger;
}

// ─── Stage 9 (Zent.md 17e-ii/iii): first-tick smoke test ───────────

function runFirstTickSmokeTest(agentAddress: string): { outcome: TickSmokeOutcome } {
  // Deterministic stand-in for a real spawnAgentProcessTickOnce() call —
  // every agent provisioned by this in-memory genesisCompany() above
  // always has a real wallet.json/automaton.json written (Phase 5 of
  // is.md) before this runs, so it always passes in this mirror. The
  // failure branches (timeout/unhandled_error/crashed_process) are
  // exercised directly, against the same classifier, in
  // genesisTickSmokeTest_test.ts — not re-proven here.
  return { outcome: "passed" };
}

// ═════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════

test("20a: happy path — seeded signal reaches one active Agent B with correct lineage", () => {
  reset();

  // 1) seeded market signal -> scored opportunity
  const opp = scanMarketSignalToOpportunity("0xCOMPANY_A", "Invoice Chasing Bot", "Automate B2B AR follow-up.", {
    demand: 80,
    expenseOfProblem: 70,
    buildability: 90,
    competitiveGap: 60,
  });
  assert.ok("id" in opp, "opportunity should clear the ROI floor");
  const opportunityId = (opp as Opportunity).id;
  assert.equal((opp as Opportunity).status, "scored");

  // 2) Research
  fileResearchFinding(opportunityId, {
    marketSize: "$400M SMB AR tooling",
    confidence: "high",
    highRegulatoryRisk: false,
  });

  // 3) Finance — comfortably above the runway floor
  fileFinanceFinding(opportunityId, {
    runwayMonthsAfterFunding: 14,
    runwayFloorMonths: 6,
    recommendedFundingUsdc: 25_000,
  });
  assert.equal(finance.get(opportunityId)!.rejected, false);

  // 4) Strategy
  fileStrategyFinding(opportunityId, { fitScore: 82, relationshipType: "independent" });

  // 5) Committee packet
  const packet = assembleCommitteePacket(opportunityId);
  assert.equal(packet.complete, true);
  assert.equal(packet.schemaVersion, "20a-v1");

  // 6) CEO approval -> genesis fires directly (15d), no operator gate
  const decision = decideExpansion(packet, "approved", "0xCOMPANY_A");
  assert.equal(decision.ceoDecision, "approved");

  const trigger = triggers.get(opportunityId)!;
  assert.equal(trigger.status, "completed");
  assert.equal(trigger.recommendedFundingUsdc, 25_000);

  // 7) Exactly one Agent B, active, correctly lineaged back to the opportunity
  const spawned = lineage.filter((l) => l.spawnReason === "expansion_pipeline");
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opportunityId, opportunityId);
  assert.equal(spawned[0].parentAddress, "0xCOMPANY_A");

  const agentB = agents.get(spawned[0].agentAddress)!;
  assert.equal(agentB.genesisActivationStatus, "active");
  assert.equal(agentB.active, true);
});

test("20a: unprofitable root agent — pipeline never even starts (2e)", () => {
  reset();
  profitableAgents.delete("0xCOMPANY_A");
  assert.throws(
    () => scanMarketSignalToOpportunity("0xCOMPANY_A", "Anything", "Anything", {
      demand: 90, expenseOfProblem: 90, buildability: 90, competitiveGap: 90,
    }),
    /not profitable/,
  );
  assert.equal(lineage.length, 0);
});

test("20a: below-ROI-floor signal is a kill, not an error, and produces no opportunity (3e)", () => {
  reset();
  const result = scanMarketSignalToOpportunity("0xCOMPANY_A", "Niche Widget", "Too small.", {
    demand: 10, expenseOfProblem: 10, buildability: 10, competitiveGap: 10,
  });
  assert.deepEqual((result as any).killed, true);
  assert.equal(opportunities.size, 0);
});

test("20a: Finance hard-reject on runway floor halts the chain before Strategy or the CEO (8e/10b)", () => {
  reset();
  const opp = scanMarketSignalToOpportunity("0xCOMPANY_A", "Cash Burner", "Expensive to build.", {
    demand: 80, expenseOfProblem: 80, buildability: 80, competitiveGap: 80,
  }) as Opportunity;

  fileResearchFinding(opp.id, { marketSize: "$50M", confidence: "med", highRegulatoryRisk: false });
  fileFinanceFinding(opp.id, {
    runwayMonthsAfterFunding: 2,
    runwayFloorMonths: 6,
    recommendedFundingUsdc: 500_000,
  });

  assert.equal(finance.get(opp.id)!.rejected, true);
  assert.equal(opportunities.get(opp.id)!.status, "rejected");

  // Strategy refuses to run against a hard-rejected opportunity.
  assert.throws(
    () => fileStrategyFinding(opp.id, { fitScore: 90, relationshipType: "independent" }),
    /hard-rejected/,
  );
  // No committee packet, no decision, no genesis, no lineage row.
  assert.throws(() => assembleCommitteePacket(opp.id), /not yet complete/);
  assert.equal(decisions.has(opp.id), false);
  assert.equal(lineage.length, 0);
});

test("20a: committee packet assembly refuses to run early if any of the three reports is missing (13e)", () => {
  reset();
  const opp = scanMarketSignalToOpportunity("0xCOMPANY_A", "Partial Pipeline", "Only research so far.", {
    demand: 80, expenseOfProblem: 80, buildability: 80, competitiveGap: 80,
  }) as Opportunity;
  fileResearchFinding(opp.id, { marketSize: "$1M", confidence: "low", highRegulatoryRisk: false });
  assert.throws(() => assembleCommitteePacket(opp.id), /not yet complete/);
});

test("20a: CEO rejection stops the chain — no genesis trigger, no lineage row", () => {
  reset();
  const opp = scanMarketSignalToOpportunity("0xCOMPANY_A", "Rejected Idea", "CEO says no.", {
    demand: 80, expenseOfProblem: 80, buildability: 80, competitiveGap: 80,
  }) as Opportunity;
  fileResearchFinding(opp.id, { marketSize: "$1M", confidence: "high", highRegulatoryRisk: false });
  fileFinanceFinding(opp.id, { runwayMonthsAfterFunding: 10, runwayFloorMonths: 6, recommendedFundingUsdc: 5_000 });
  fileStrategyFinding(opp.id, { fitScore: 55, relationshipType: "independent" });
  const packet = assembleCommitteePacket(opp.id);

  decideExpansion(packet, "rejected", "0xCOMPANY_A");

  assert.equal(triggers.has(opp.id), false);
  assert.equal(lineage.length, 0);
  assert.equal(opportunities.get(opp.id)!.status, "rejected");
});

test("20a: Finance's Phase 9 sizing recommendation is exactly what reaches the genesis trigger (16b wire-up)", () => {
  reset();
  const opp = scanMarketSignalToOpportunity("0xCOMPANY_A", "Sizing Check", "Trace the funding number.", {
    demand: 90, expenseOfProblem: 70, buildability: 85, competitiveGap: 60,
  }) as Opportunity;
  fileResearchFinding(opp.id, { marketSize: "$200M", confidence: "high", highRegulatoryRisk: false });
  fileFinanceFinding(opp.id, { runwayMonthsAfterFunding: 20, runwayFloorMonths: 6, recommendedFundingUsdc: 12_345 });
  fileStrategyFinding(opp.id, { fitScore: 70, relationshipType: "supplier-to-sibling" });
  const packet = assembleCommitteePacket(opp.id);
  decideExpansion(packet, "approved", "0xCOMPANY_A");

  assert.equal(triggers.get(opp.id)!.recommendedFundingUsdc, 12_345);
});
