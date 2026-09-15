// Zent.md Phase 2d: "Rate/spend limits for this department type in
// resourceQuotas.ts — signal scanning is the cheapest department but
// also the easiest to run in an unbounded loop; cap ticks/day."
//
// Inlined mirror of resourceQuotas.ts's new
// getOpportunityIntelligenceTickCount()/hasOpportunityIntelligenceTickCapacity()/
// recordOpportunityIntelligenceTick() and of checkResourceQuotas()'s new
// opportunity_intelligence_ticks branch, plus expansionRoutes.ts's new
// pre-flight gate in its three signal-collection routes — same "no live
// better-sqlite3 in this environment" reason every prior backend/src
// test file in this repo already carries (see resourceQuotas.test.ts's
// own header, whose Group 2 checkResourceQuotas mirror this file's own
// Group 1 below extends with the new resource). Recommend re-running
// against the real modules once a networked environment is available,
// per every prior phase's own standing note.
//
// What this covers:
//   2d — opportunity_intelligence_tick_counters is a calendar-day (UTC)
//         counter, one row per (agent, day), same shape as
//         distribution_rate_counters.
//   2d — hasOpportunityIntelligenceTickCapacity() is a pure read: it
//         never mutates the counter, so checking capacity repeatedly
//         without following through never itself consumes a tick.
//   2d — recordOpportunityIntelligenceTick() is an idempotent-shaped
//         UPSERT (INSERT ... ON CONFLICT DO UPDATE count = count + 1),
//         scoped to the caller-given day, never bleeding into another
//         day's count.
//   2d — checkResourceQuotas() flags opportunity_intelligence_ticks as
//         a violation once the count exceeds the configured cap, same
//         "actual > limit is a violation, actual == limit is not" rule
//         every other resource in that function already follows.
//   2d — expansionRoutes.ts's pre-flight gate: a call at/over the cap
//         is rejected (429-shaped) before any report is resolved or
//         any search runs; a failed (502-shaped) search never consumes
//         a tick; a successful call consumes exactly one.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of resourceQuotas.ts's Phase 2d tick-counter functions ─────

let tickCounters: Map<string, number>; // key: `${agentId}:${day}`

function resetTickCounters(): void {
  tickCounters = new Map();
}

function tickKey(agentId: string, day: string): string {
  return `${agentId}:${day}`;
}

function getOpportunityIntelligenceTickCountMirror(agentId: string, day: string): number {
  return tickCounters.get(tickKey(agentId, day)) ?? 0;
}

function hasOpportunityIntelligenceTickCapacityMirror(
  agentId: string,
  day: string,
  cap: number,
): boolean {
  return getOpportunityIntelligenceTickCountMirror(agentId, day) < cap;
}

function recordOpportunityIntelligenceTickMirror(agentId: string, day: string): number {
  const key = tickKey(agentId, day);
  const next = (tickCounters.get(key) ?? 0) + 1;
  tickCounters.set(key, next);
  return next;
}

// ─── Mirror of checkResourceQuotas()'s new opportunity_intelligence_ticks branch ──

type QuotaResource =
  | "disk"
  | "container_cpu"
  | "container_memory"
  | "inference_spend"
  | "marketplace_spend"
  | "opportunity_intelligence_ticks";

interface QuotaViolation {
  resource: QuotaResource;
  limit: number;
  actual: number;
}

function checkOpportunityIntelligenceTicksMirror(
  agentId: string,
  day: string,
  cap: number,
): QuotaViolation[] {
  const violations: QuotaViolation[] = [];
  const actual = getOpportunityIntelligenceTickCountMirror(agentId, day);
  if (actual > cap) {
    violations.push({ resource: "opportunity_intelligence_ticks", limit: cap, actual });
  }
  return violations;
}

const DEFAULT_CAP = 100;

test("a fresh agent/day has zero ticks and full capacity", () => {
  resetTickCounters();
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", "2026-01-01"), 0);
  assert.equal(hasOpportunityIntelligenceTickCapacityMirror("0xA", "2026-01-01", DEFAULT_CAP), true);
});

test("recordOpportunityIntelligenceTick increments the same (agent, day) counter across repeated calls", () => {
  resetTickCounters();
  const day = "2026-01-01";
  recordOpportunityIntelligenceTickMirror("0xA", day);
  recordOpportunityIntelligenceTickMirror("0xA", day);
  const third = recordOpportunityIntelligenceTickMirror("0xA", day);
  assert.equal(third, 3);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 3);
});

test("checking capacity alone (no record call) never consumes a tick", () => {
  resetTickCounters();
  const day = "2026-01-01";
  hasOpportunityIntelligenceTickCapacityMirror("0xA", day, DEFAULT_CAP);
  hasOpportunityIntelligenceTickCapacityMirror("0xA", day, DEFAULT_CAP);
  hasOpportunityIntelligenceTickCapacityMirror("0xA", day, DEFAULT_CAP);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 0);
});

test("ticks are scoped per agent — one agent's count never bleeds into another's", () => {
  resetTickCounters();
  const day = "2026-01-01";
  recordOpportunityIntelligenceTickMirror("0xA", day);
  recordOpportunityIntelligenceTickMirror("0xA", day);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 2);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xB", day), 0);
});

test("ticks are scoped per calendar day — yesterday's count never bleeds into today's", () => {
  resetTickCounters();
  recordOpportunityIntelligenceTickMirror("0xA", "2026-01-01");
  recordOpportunityIntelligenceTickMirror("0xA", "2026-01-01");
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", "2026-01-01"), 2);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", "2026-01-02"), 0);
});

test("capacity check is exclusive at the cap: exactly at cap means no more room, one below means room for one more", () => {
  resetTickCounters();
  const day = "2026-01-01";
  const cap = 3;
  recordOpportunityIntelligenceTickMirror("0xA", day);
  recordOpportunityIntelligenceTickMirror("0xA", day);
  assert.equal(hasOpportunityIntelligenceTickCapacityMirror("0xA", day, cap), true, "2 of 3 used, room for one more");
  recordOpportunityIntelligenceTickMirror("0xA", day);
  assert.equal(hasOpportunityIntelligenceTickCapacityMirror("0xA", day, cap), false, "3 of 3 used, no room left");
});

test("checkResourceQuotas' opportunity_intelligence_ticks branch: at the cap is not a violation, one over is", () => {
  resetTickCounters();
  const day = "2026-01-01";
  const cap = 5;
  for (let i = 0; i < 5; i++) recordOpportunityIntelligenceTickMirror("0xA", day);
  assert.equal(checkOpportunityIntelligenceTicksMirror("0xA", day, cap).length, 0, "== cap is not yet a violation");

  recordOpportunityIntelligenceTickMirror("0xA", day);
  const violations = checkOpportunityIntelligenceTicksMirror("0xA", day, cap);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].resource, "opportunity_intelligence_ticks");
  assert.equal(violations[0].limit, cap);
  assert.equal(violations[0].actual, 6);
});

test("an agent this backend has never ticked at all is never flagged", () => {
  resetTickCounters();
  const violations = checkOpportunityIntelligenceTicksMirror("0xUNKNOWN", "2026-01-01", DEFAULT_CAP);
  assert.equal(violations.length, 0);
});

// ─── Mirror of expansionRoutes.ts's Phase 2d pre-flight gate, layered ──
// on top of the Phase 2b/2c report + search flow (mirrors copied from
// expansionMarketSignals.test.ts / expansionCustomerComplaintsDemandSignals
// .test.ts, unchanged) so the gate's actual position in the request flow
// — before report resolution, before the search, tick recorded only on
// a successful search — is exercised end to end.

interface MarketSignalResult {
  title: string;
  url: string;
  snippet: string;
}

type OpportunityReportStatus = "draft" | "scored" | "archived";

interface FakeOpportunityReport {
  id: string;
  agent_address: string;
  created_at: number;
  source_summary: string;
  status: OpportunityReportStatus;
}

let reports: Map<string, FakeOpportunityReport>;
let reportSeq: number;

function resetReports(): void {
  reports = new Map();
  reportSeq = 0;
}

function createOpportunityReport(agentAddress: string): FakeOpportunityReport {
  reportSeq += 1;
  const row: FakeOpportunityReport = {
    id: `oppr_${reportSeq}`,
    agent_address: agentAddress,
    created_at: reportSeq,
    source_summary: "",
    status: "draft",
  };
  reports.set(row.id, row);
  return row;
}

function listOpportunityReports(
  agentAddress: string,
  status?: OpportunityReportStatus,
): FakeOpportunityReport[] {
  return Array.from(reports.values())
    .filter((r) => r.agent_address === agentAddress && (!status || r.status === status))
    .sort((a, b) => b.created_at - a.created_at);
}

function appendSourceSummary(id: string, addition: string): FakeOpportunityReport {
  const existing = reports.get(id);
  if (!existing) throw new Error(`opportunity_report ${id} not found`);
  existing.source_summary = existing.source_summary
    ? `${existing.source_summary}\n${addition}`
    : addition;
  return existing;
}

function ensureDraftOpportunityReport(agentAddress: string): FakeOpportunityReport {
  const [mostRecentDraft] = listOpportunityReports(agentAddress, "draft");
  return mostRecentDraft ?? createOpportunityReport(agentAddress);
}

/** Mirror of the POST /reports/scan-market-signals route body, Phase 2d
 *  update: the tick-cap gate runs first, before resolveTargetReport()
 *  or the search itself; the tick is recorded only once the (mocked)
 *  search resolves without throwing. */
async function scanMarketSignalsRouteMirror(
  agentAddress: string,
  day: string,
  cap: number,
  search: () => Promise<MarketSignalResult[]>,
): Promise<{ status: number; body: any }> {
  if (!hasOpportunityIntelligenceTickCapacityMirror(agentAddress, day, cap)) {
    return {
      status: 429,
      body: { error: "daily_opportunity_intelligence_tick_limit_reached", limit: cap },
    };
  }

  const report = ensureDraftOpportunityReport(agentAddress);

  let results: MarketSignalResult[];
  try {
    results = await search();
  } catch (err: any) {
    return { status: 502, body: { error: `scan_market_signals failed: ${err.message}` } };
  }
  recordOpportunityIntelligenceTickMirror(agentAddress, day);

  const entry = `[mock] scan_market_signals: ${results.length} result(s)`;
  const updated = appendSourceSummary(report.id, entry);
  return { status: 200, body: { reportId: updated.id, results, report: updated } };
}

test("route gate: a call under the cap succeeds and consumes exactly one tick", async () => {
  resetTickCounters();
  resetReports();
  const day = "2026-01-01";
  const res = await scanMarketSignalsRouteMirror("0xA", day, 5, async () => []);
  assert.equal(res.status, 200);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 1);
});

test("route gate: a call at the cap is rejected with 429, no report touched, no tick consumed", async () => {
  resetTickCounters();
  resetReports();
  const day = "2026-01-01";
  const cap = 2;
  await scanMarketSignalsRouteMirror("0xA", day, cap, async () => []);
  await scanMarketSignalsRouteMirror("0xA", day, cap, async () => []);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 2);

  const rejected = await scanMarketSignalsRouteMirror("0xA", day, cap, async () => {
    throw new Error("should never be called — the gate must reject before search runs");
  });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.body.error, "daily_opportunity_intelligence_tick_limit_reached");
  assert.equal(rejected.body.limit, cap);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 2, "no tick consumed by a rejected call");
  assert.equal(reports.size, 1, "the rejected call must not create or touch any additional report");
});

test("route gate: a failed (502) search never consumes a tick, so a retry still has room", async () => {
  resetTickCounters();
  resetReports();
  const day = "2026-01-01";
  const failing = await scanMarketSignalsRouteMirror("0xA", day, 5, async () => {
    throw new Error("network timeout");
  });
  assert.equal(failing.status, 502);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 0, "failed search must not consume a tick");

  const retry = await scanMarketSignalsRouteMirror("0xA", day, 5, async () => []);
  assert.equal(retry.status, 200);
  assert.equal(getOpportunityIntelligenceTickCountMirror("0xA", day), 1);
});

test("route gate: two different agents each get their own independent daily allowance", async () => {
  resetTickCounters();
  resetReports();
  const day = "2026-01-01";
  const cap = 1;
  const a = await scanMarketSignalsRouteMirror("0xA", day, cap, async () => []);
  assert.equal(a.status, 200);
  const aAgain = await scanMarketSignalsRouteMirror("0xA", day, cap, async () => []);
  assert.equal(aAgain.status, 429, "0xA is now over its own cap");

  const b = await scanMarketSignalsRouteMirror("0xB", day, cap, async () => []);
  assert.equal(b.status, 200, "0xB's own allowance is untouched by 0xA's usage");
});
