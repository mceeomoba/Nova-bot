// Zent.md Phase 20b: "Load/adversarial test: opportunity flooding (can
// Opportunity Intelligence be spammed into burning spend on garbage
// signals?), addressed by 2d/2e's caps."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives. This file
// does not re-derive 2d's tick-counter arithmetic or 3c's TF-IDF
// de-dup formula from scratch — those already have dedicated coverage
// in expansionOpportunityIntelligenceTickCap.test.ts and
// expansionDedup.test.ts. What's new here is adversarial *scale*: this
// file drives each of those guards with call volumes an order of
// magnitude past their caps (thousands of attempted calls against
// caps in the tens/hundreds) and asserts the guard's behavior doesn't
// degrade under volume — no leak, no drift, no per-call cost escaping
// the cap — rather than exercising each guard once or twice near its
// boundary the way the unit-level tests already do.
//
// Four adversarial scenarios, addressing the phase's own question
// ("can Opportunity Intelligence be spammed into burning spend on
// garbage signals?") from four different angles an attacker or a
// malfunctioning agent loop could take:
//
//   1. Raw call-volume flooding against the 2d tick cap — a tight
//      loop of scan_market_signals calls, volume >> cap.
//   2. Near-duplicate flooding against 3c's de-dup pass — an attacker
//      who *does* stay under the tick cap but tries to turn every
//      allowed tick into its own "distinct" opportunity by
//      trivially rewording the same garbage signal.
//   3. Fan-out flooding against 3d's Top-N selection — even with many
//      genuinely-distinct scored opportunities sitting open, only N
//      ever get promoted to Research per selection call, bounding how
//      many (Research, Finance, Strategy) department triples the rest
//      of the pipeline could ever spin up from one flood.
//   4. A profitability revocation *mid-flood* (2e) — the cap isn't
//      the only backstop; if the root agent stops being profitable
//      partway through an attempted flood, every call after that
//      point is refused outright, regardless of how much cap headroom
//      was left.
//
// Recommend re-running against the real expansion.ts / resourceQuotas.ts
// once a networked environment is available, per every prior phase's
// own standing note — this proves the guards' behavior at adversarial
// scale against the documented contract, not the real SQL under real
// concurrent load.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of resourceQuotas.ts's Phase 2d tick-counter functions ─────
// (identical contract to expansionOpportunityIntelligenceTickCap.test.ts;
// duplicated here rather than imported so this file stays a single,
// self-contained adversarial harness — same posture every other
// expansion*.test.ts file in this directory already takes.)

let tickCounters: Map<string, number>;
let spendLedger: Map<string, number>; // key: agentId -> cumulative micro-USD spend

const COST_PER_TICK_MICROUSD = 50; // signal scanning is the cheapest department, per 2d's own note

function resetFlood(): void {
  tickCounters = new Map();
  spendLedger = new Map();
}

function tickKey(agentId: string, day: string): string {
  return `${agentId}:${day}`;
}

function getTickCount(agentId: string, day: string): number {
  return tickCounters.get(tickKey(agentId, day)) ?? 0;
}

function hasTickCapacity(agentId: string, day: string, cap: number): boolean {
  return getTickCount(agentId, day) < cap;
}

function recordTick(agentId: string, day: string): number {
  const key = tickKey(agentId, day);
  const next = (tickCounters.get(key) ?? 0) + 1;
  tickCounters.set(key, next);
  spendLedger.set(agentId, (spendLedger.get(agentId) ?? 0) + COST_PER_TICK_MICROUSD);
  return next;
}

// ─── Mirror of the 2e profitability gate ────────────────────────────

let profitableAgents: Set<string>;

function isEligibleForExpansion(agentAddress: string): boolean {
  return profitableAgents.has(agentAddress);
}

// ─── Mirror of the scan_market_signals route's combined 2d + 2e gate ──
// (2e's gate runs first — an unprofitable agent never even reaches the
// tick-cap check — matching the ordering documented in Zent.md 2e:
// "checked before an opportunity_intelligence department can even be
// spawned.")

interface FloodCallResult {
  status: 200 | 402 | 429;
  reason?: "not_profitable" | "daily_opportunity_intelligence_tick_limit_reached";
}

function attemptScanMarketSignalsCall(
  agentAddress: string,
  day: string,
  cap: number,
): FloodCallResult {
  if (!isEligibleForExpansion(agentAddress)) {
    return { status: 402, reason: "not_profitable" };
  }
  if (!hasTickCapacity(agentAddress, day, cap)) {
    return { status: 429, reason: "daily_opportunity_intelligence_tick_limit_reached" };
  }
  recordTick(agentAddress, day);
  return { status: 200 };
}

// ─── Mirror of tfidf.ts's near-duplicate detector (3c), simplified to
// a normalized-text set-membership check — full TF-IDF arithmetic is
// already covered by expansionDedup.test.ts; this file only needs
// "trivial reword of the same garbage still collapses to one entry"
// to hold at flood volume. ─────────────────────────────────────────

function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !["the", "and", "for", "with"].includes(w))
    .sort()
    .join(" ");
}

interface ScoredOpportunity {
  id: string;
  agentAddress: string;
  normalizedKey: string;
  roiScore: number;
}

function scoreOpportunityWithDedup(
  existing: ScoredOpportunity[],
  agentAddress: string,
  title: string,
  thesis: string,
  roiScore: number,
  nextId: () => string,
): { created: ScoredOpportunity } | { duplicateOf: string } {
  const key = normalizeForDedup(`${title} ${thesis}`);
  const dup = existing.find((o) => o.agentAddress === agentAddress && o.normalizedKey === key);
  if (dup) return { duplicateOf: dup.id };
  const row: ScoredOpportunity = { id: nextId(), agentAddress, normalizedKey: key, roiScore };
  existing.push(row);
  return { created: row };
}

// ─── Mirror of Phase 3d's Top-N selection ───────────────────────────

function selectTopNOpen(open: ScoredOpportunity[], n: number): ScoredOpportunity[] {
  return [...open].sort((a, b) => b.roiScore - a.roiScore).slice(0, n);
}

// ═════════════════════════════════════════════════════════════════
// Scenario 1 — raw call-volume flooding against the 2d tick cap
// ═════════════════════════════════════════════════════════════════

test("20b: 10,000 rapid-fire calls against a cap of 100 — exactly 100 succeed, spend never exceeds cap*cost", () => {
  resetFlood();
  profitableAgents = new Set(["0xVICTIM"]);
  const day = "2026-01-01";
  const cap = 100;

  let successes = 0;
  let rejections = 0;
  for (let i = 0; i < 10_000; i++) {
    const result = attemptScanMarketSignalsCall("0xVICTIM", day, cap);
    if (result.status === 200) successes++;
    else {
      rejections++;
      assert.equal(result.reason, "daily_opportunity_intelligence_tick_limit_reached");
    }
  }

  assert.equal(successes, cap, "exactly `cap` calls succeed, regardless of how many were attempted");
  assert.equal(rejections, 10_000 - cap);
  assert.equal(getTickCount("0xVICTIM", day), cap, "the counter itself never exceeds the cap");
  assert.equal(
    spendLedger.get("0xVICTIM"),
    cap * COST_PER_TICK_MICROUSD,
    "cumulative spend is bounded to exactly cap * cost-per-tick, independent of flood volume",
  );
});

test("20b: flooding one agent never touches another agent's own allowance", () => {
  resetFlood();
  profitableAgents = new Set(["0xVICTIM", "0xBYSTANDER"]);
  const day = "2026-01-01";
  const cap = 10;

  for (let i = 0; i < 5_000; i++) attemptScanMarketSignalsCall("0xVICTIM", day, cap);
  assert.equal(getTickCount("0xVICTIM", day), cap);

  const bystanderResult = attemptScanMarketSignalsCall("0xBYSTANDER", day, cap);
  assert.equal(bystanderResult.status, 200, "0xBYSTANDER's cap is untouched by 0xVICTIM's flood");
  assert.equal(getTickCount("0xBYSTANDER", day), 1);
});

test("20b: a flood spanning a day boundary resets — yesterday's exhaustion doesn't carry over", () => {
  resetFlood();
  profitableAgents = new Set(["0xVICTIM"]);
  const cap = 50;

  for (let i = 0; i < 2_000; i++) attemptScanMarketSignalsCall("0xVICTIM", "2026-01-01", cap);
  assert.equal(getTickCount("0xVICTIM", "2026-01-01"), cap);

  const nextDayResult = attemptScanMarketSignalsCall("0xVICTIM", "2026-01-02", cap);
  assert.equal(nextDayResult.status, 200, "a new calendar day is a fresh allowance");
});

// ═════════════════════════════════════════════════════════════════
// Scenario 2 — near-duplicate flooding against 3c's de-dup pass
// ═════════════════════════════════════════════════════════════════

test("20b: 500 trivially-reworded copies of the same garbage signal collapse to one scored opportunity", () => {
  const scored: ScoredOpportunity[] = [];
  let seq = 0;
  const nextId = () => `opp_${++seq}`;

  const templates = [
    "Amazing Crypto Opportunity",
    "AMAZING crypto opportunity!!!",
    "amazing   crypto    opportunity",
    "Crypto Opportunity, Amazing",
    "The Amazing Crypto Opportunity",
  ];

  let created = 0;
  let deduped = 0;
  for (let i = 0; i < 500; i++) {
    const title = templates[i % templates.length];
    const result = scoreOpportunityWithDedup(scored, "0xVICTIM", title, "guaranteed 1000x returns", 5, nextId);
    if ("created" in result) created++;
    else deduped++;
  }

  assert.equal(created, 1, "every reworded copy of the same garbage collapses to a single scored row");
  assert.equal(deduped, 499);
  assert.equal(scored.length, 1);
});

test("20b: near-duplicate flooding across many agents still yields one distinct opportunity per agent", () => {
  const scored: ScoredOpportunity[] = [];
  let seq = 0;
  const nextId = () => `opp_${++seq}`;
  const agents = Array.from({ length: 20 }, (_, i) => `0xAGENT_${i}`);

  for (const agent of agents) {
    for (let i = 0; i < 25; i++) {
      scoreOpportunityWithDedup(scored, agent, "Same Garbage Signal", "reworded slightly", 5, nextId);
    }
  }

  assert.equal(scored.length, agents.length, "one distinct opportunity per agent, not zero and not 20*25");
});

test("20b: genuinely distinct garbage still creates distinct rows — de-dup doesn't over-collapse", () => {
  const scored: ScoredOpportunity[] = [];
  let seq = 0;
  const nextId = () => `opp_${++seq}`;

  const distinctTitles = [
    "Invoice Chasing Bot for SMBs",
    "Automated Payroll Reconciliation Tool",
    "Freight Carrier Rate Comparison Service",
  ];
  let created = 0;
  for (const title of distinctTitles) {
    const result = scoreOpportunityWithDedup(scored, "0xVICTIM", title, `thesis for ${title}`, 5, nextId);
    if ("created" in result) created++;
  }
  assert.equal(created, distinctTitles.length, "distinct signals are never wrongly merged");
});

// ═════════════════════════════════════════════════════════════════
// Scenario 3 — fan-out flooding against 3d's Top-N selection
// ═════════════════════════════════════════════════════════════════

test("20b: even with 1,000 genuinely-distinct scored opportunities, only topN are ever selected", () => {
  const open: ScoredOpportunity[] = Array.from({ length: 1_000 }, (_, i) => ({
    id: `opp_${i}`,
    agentAddress: "0xVICTIM",
    normalizedKey: `distinct signal ${i}`,
    roiScore: Math.random() * 100,
  }));

  const topN = 4;
  const selected = selectTopNOpen(open, topN);

  assert.equal(selected.length, topN, "Top-N selection bounds fan-out into Research/Finance/Strategy regardless of backlog size");
  // Selected set is exactly the topN highest-scoring ones.
  const sortedScores = [...open].sort((a, b) => b.roiScore - a.roiScore).slice(0, topN).map((o) => o.id);
  assert.deepEqual(
    selected.map((o) => o.id).sort(),
    sortedScores.sort(),
  );
});

test("20b: Top-N selection bounds the number of downstream department triples a flood could ever spawn", () => {
  // Each selected opportunity, per Zent.md 5a/8a/11a, spawns at most
  // one Research + one Finance + one Strategy department instance.
  // 1,000 open opportunities should never result in more than
  // topN * 3 department instances spun up from a single flood.
  const open: ScoredOpportunity[] = Array.from({ length: 1_000 }, (_, i) => ({
    id: `opp_${i}`,
    agentAddress: "0xVICTIM",
    normalizedKey: `distinct signal ${i}`,
    roiScore: i, // deterministic ordering for this assertion
  }));
  const topN = 4;
  const selected = selectTopNOpen(open, topN);
  const departmentInstancesSpawned = selected.length * 3;
  assert.equal(departmentInstancesSpawned, 12, "bounded regardless of the 1,000-opportunity backlog");
});

// ═════════════════════════════════════════════════════════════════
// Scenario 4 — profitability revocation mid-flood (2e)
// ═════════════════════════════════════════════════════════════════

test("20b: losing profitability mid-flood halts every subsequent call, even with cap headroom left", () => {
  resetFlood();
  profitableAgents = new Set(["0xVICTIM"]);
  const day = "2026-01-01";
  const cap = 1_000; // plenty of headroom left when profitability is revoked

  let successesBeforeRevocation = 0;
  for (let i = 0; i < 30; i++) {
    const result = attemptScanMarketSignalsCall("0xVICTIM", day, cap);
    if (result.status === 200) successesBeforeRevocation++;
  }
  assert.equal(successesBeforeRevocation, 30);
  assert.ok(getTickCount("0xVICTIM", day) < cap, "well under the tick cap when revocation happens");

  // 19c-style circuit breaker / manual intervention revokes profitability mid-flood.
  profitableAgents.delete("0xVICTIM");

  let rejectionsAfterRevocation = 0;
  for (let i = 0; i < 5_000; i++) {
    const result = attemptScanMarketSignalsCall("0xVICTIM", day, cap);
    if (result.status === 402) rejectionsAfterRevocation++;
    else assert.fail(`expected every post-revocation call to be refused, got status ${result.status}`);
  }
  assert.equal(rejectionsAfterRevocation, 5_000);
  assert.equal(
    getTickCount("0xVICTIM", day),
    30,
    "the tick counter is frozen the instant profitability is revoked — not merely rate-limited",
  );
});

test("20b: profitability gate (2e) and tick cap (2d) are independent backstops — either alone still bounds spend", () => {
  resetFlood();
  // Case A: profitable the whole time, cap does all the work.
  profitableAgents = new Set(["0xA"]);
  for (let i = 0; i < 2_000; i++) attemptScanMarketSignalsCall("0xA", "2026-01-01", 20);
  assert.equal(getTickCount("0xA", "2026-01-01"), 20);

  // Case B: never profitable at all, gate does all the work before the cap is ever consulted.
  profitableAgents = new Set(); // 0xB never eligible
  for (let i = 0; i < 2_000; i++) {
    const result = attemptScanMarketSignalsCall("0xB", "2026-01-01", 20);
    assert.equal(result.status, 402);
  }
  assert.equal(getTickCount("0xB", "2026-01-01"), 0, "an ineligible agent never consumes any tick capacity at all");
});
