// Zent.md Phase 2c: list_customer_complaints(domain) and
// list_demand_signals(industry) — "thin, named wrappers over 2b so the
// department's reasoning trace stays legible in logs".
//
// Inlined mirror of expansion.ts's formatMarketSignalEntry() (extended
// with the optional `callLabel` param) and expansionRoutes.ts's
// buildComplaintsQuery()/buildDemandSignalsQuery() — same "no live
// better-sqlite3 in this environment" reason every prior backend/src
// test file in this repo already carries (see expansionMarketSignals
// .test.ts's own header, which this file's report/appendSourceSummary
// mirror is copied from verbatim). Recommend re-running against the
// real modules once a networked environment is available, per every
// prior phase's own standing note.
//
// What this covers:
//   2c — buildComplaintsQuery()/buildDemandSignalsQuery() expand a bare
//         domain/industry into a DuckDuckGo-shaped query string.
//   2c — formatMarketSignalEntry()'s callLabel overrides the header's
//         `name("arg")` to the named wrapper + the department's own
//         argument, not the (longer, internally-expanded) search
//         string — the actual legibility mechanism Zent.md 2c asks
//         for.
//   2c — formatMarketSignalEntry() without a callLabel still defaults
//         to `scan_market_signals("<query>")`, so 2b's own callers and
//         tests are unaffected by 2c's addition.
//   2c — both wrappers' entries land in the same opportunity_reports
//         draft via ensureDraftOpportunityReport()/appendSourceSummary(),
//         accumulating alongside plain scan_market_signals() entries in
//         one legible timeline, same as two 2b scans already do.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's MarketSignalResult + formatMarketSignalEntry() ──

interface MarketSignalResult {
  title: string;
  url: string;
  snippet: string;
}

interface CallLabel {
  toolName: string;
  arg: string;
}

function formatMarketSignalEntry(
  query: string,
  results: MarketSignalResult[],
  timestampMs: number = Date.now(),
  callLabel: CallLabel = { toolName: "scan_market_signals", arg: query },
): string {
  const timestamp = new Date(timestampMs).toISOString();
  const header = `[${timestamp}] ${callLabel.toolName}("${callLabel.arg}")`;
  if (results.length === 0) {
    return `${header}: no results`;
  }
  const lines = results.map(
    (r, i) => `  ${i + 1}. ${r.title} — ${r.url}\n     ${r.snippet}`,
  );
  return `${header}:\n${lines.join("\n")}`;
}

// ─── Mirror of expansionRoutes.ts's Phase 2c query builders ────────────

function buildComplaintsQuery(domain: string): string {
  return `${domain} complaints reviews problems reddit`;
}

function buildDemandSignalsQuery(industry: string): string {
  return `${industry} demand growing trend "need a" OR "wish there was"`;
}

// ─── Mirror of expansion.ts's Phase 1a/1d types + ensureDraftOpportunityReport() ──
// (copied from expansionMarketSignals.test.ts's own mirror, unchanged)

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

function reset(): void {
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
  if (existing.status !== "draft") {
    throw new Error(`opportunity_report ${id} is ${existing.status}, not draft`);
  }
  existing.source_summary = existing.source_summary
    ? `${existing.source_summary}\n${addition}`
    : addition;
  return existing;
}

function ensureDraftOpportunityReport(agentAddress: string): FakeOpportunityReport {
  const [mostRecentDraft] = listOpportunityReports(agentAddress, "draft");
  return mostRecentDraft ?? createOpportunityReport(agentAddress);
}

// ─── buildComplaintsQuery / buildDemandSignalsQuery ────────────────────

test("buildComplaintsQuery expands a bare domain into a complaints-shaped search query", () => {
  assert.equal(
    buildComplaintsQuery("acme.com"),
    "acme.com complaints reviews problems reddit",
  );
});

test("buildDemandSignalsQuery expands a bare industry into a demand-shaped search query", () => {
  assert.equal(
    buildDemandSignalsQuery("pet grooming"),
    `pet grooming demand growing trend "need a" OR "wish there was"`,
  );
});

// ─── formatMarketSignalEntry: default vs. callLabel ────────────────────

test("formatMarketSignalEntry defaults to scan_market_signals(query) when no callLabel is passed", () => {
  const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
  const text = formatMarketSignalEntry("AI compliance tooling", [], ts);
  assert.equal(
    text,
    `[${new Date(ts).toISOString()}] scan_market_signals("AI compliance tooling"): no results`,
  );
});

test("formatMarketSignalEntry with a list_customer_complaints callLabel headers with the domain, not the expanded query", () => {
  const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
  const domain = "acme.com";
  const expandedQuery = buildComplaintsQuery(domain);
  const results: MarketSignalResult[] = [
    { title: "Acme sucks", url: "https://reddit.com/r/acme/1", snippet: "Never buying again." },
  ];
  const text = formatMarketSignalEntry(expandedQuery, results, ts, {
    toolName: "list_customer_complaints",
    arg: domain,
  });
  const expected =
    `[${new Date(ts).toISOString()}] list_customer_complaints("acme.com"):\n` +
    `  1. Acme sucks — https://reddit.com/r/acme/1\n` +
    `     Never buying again.`;
  assert.equal(text, expected);
  // The expanded query is what actually got searched, but it never
  // appears in the log line itself — only the department's own arg does.
  assert.ok(!text.includes(expandedQuery));
});

test("formatMarketSignalEntry with a list_demand_signals callLabel headers with the industry, not the expanded query", () => {
  const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
  const industry = "pet grooming";
  const text = formatMarketSignalEntry(buildDemandSignalsQuery(industry), [], ts, {
    toolName: "list_demand_signals",
    arg: industry,
  });
  assert.equal(
    text,
    `[${new Date(ts).toISOString()}] list_demand_signals("pet grooming"): no results`,
  );
});

// ─── Both wrappers accumulate into the same report as plain scans ─────

test("a list_customer_complaints entry and a plain scan_market_signals entry accumulate onto the same draft report", () => {
  reset();
  const report = ensureDraftOpportunityReport("0xA");

  const scanEntry = formatMarketSignalEntry("AI compliance tooling", [], 1000);
  appendSourceSummary(report.id, scanEntry);

  const domain = "acme.com";
  const complaintsEntry = formatMarketSignalEntry(buildComplaintsQuery(domain), [], 2000, {
    toolName: "list_customer_complaints",
    arg: domain,
  });
  const updated = appendSourceSummary(report.id, complaintsEntry);

  assert.equal(updated.source_summary, `${scanEntry}\n${complaintsEntry}`);
  assert.equal(reports.size, 1);
});

test("list_demand_signals reuses the caller's existing draft report rather than opening a new one", () => {
  reset();
  const first = ensureDraftOpportunityReport("0xA");
  const industry = "pet grooming";
  const entry = formatMarketSignalEntry(buildDemandSignalsQuery(industry), [], 3000, {
    toolName: "list_demand_signals",
    arg: industry,
  });
  appendSourceSummary(first.id, entry);
  const second = ensureDraftOpportunityReport("0xA");
  assert.equal(second.id, first.id);
  assert.equal(reports.size, 1);
});

test("appending a list_customer_complaints entry to a non-draft report is rejected, matching 2b's own lifecycle guard", () => {
  reset();
  const report = createOpportunityReport("0xA");
  report.status = "archived";
  const domain = "acme.com";
  const entry = formatMarketSignalEntry(buildComplaintsQuery(domain), [], 4000, {
    toolName: "list_customer_complaints",
    arg: domain,
  });
  assert.throws(() => appendSourceSummary(report.id, entry), /not draft/);
});
