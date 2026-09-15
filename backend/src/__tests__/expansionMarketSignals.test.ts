// Zent.md Phase 2b: scan_market_signals(query).
// Inlined mirror of expansion.ts's formatMarketSignalEntry()/
// ensureDraftOpportunityReport() and expansionRoutes.ts's DuckDuckGo
// HTML parsing — same "no live better-sqlite3 in this environment"
// reason every prior backend/src test file in this repo already
// carries (see expansionDecisions.test.ts's own header). Recommend
// re-running against the real functions/db.ts once a networked
// environment is available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of expansion.ts's formatMarketSignalEntry() ───────────────

interface MarketSignalResult {
  title: string;
  url: string;
  snippet: string;
}

function formatMarketSignalEntry(
  query: string,
  results: MarketSignalResult[],
  timestampMs: number = Date.now(),
): string {
  const timestamp = new Date(timestampMs).toISOString();
  const header = `[${timestamp}] scan_market_signals("${query}")`;
  if (results.length === 0) {
    return `${header}: no results`;
  }
  const lines = results.map(
    (r, i) => `  ${i + 1}. ${r.title} — ${r.url}\n     ${r.snippet}`,
  );
  return `${header}:\n${lines.join("\n")}`;
}

// ─── Mirror of expansion.ts's Phase 1a/1d types + ensureDraftOpportunityReport() ──

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

// ─── Mirror of expansionRoutes.ts's DuckDuckGo HTML parsing ───────────

function stripHtmlTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

function resolveDuckDuckGoUrl(href: string): string {
  try {
    const full = href.startsWith("//") ? `https:${href}` : href;
    const parsed = new URL(full);
    if (parsed.hostname.endsWith("duckduckgo.com") && parsed.searchParams.has("uddg")) {
      return decodeURIComponent(parsed.searchParams.get("uddg")!);
    }
    return full;
  } catch {
    return href;
  }
}

function parseDuckDuckGoResults(html: string, maxResults: number): MarketSignalResult[] {
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

  const titles: { href: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) !== null) {
    titles.push({ href: m[1], title: stripHtmlTags(m[2]) });
  }
  const snippets: string[] = [];
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(stripHtmlTags(m[1]));
  }

  return titles.slice(0, maxResults).map((t, i) => ({
    title: t.title,
    url: resolveDuckDuckGoUrl(t.href),
    snippet: snippets[i] || "",
  }));
}

// ─── formatMarketSignalEntry ───────────────────────────────────────────

test("formatMarketSignalEntry formats a header plus one numbered line per result", () => {
  const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
  const text = formatMarketSignalEntry(
    "AI compliance tooling",
    [
      { title: "Result One", url: "https://example.com/one", snippet: "First snippet." },
      { title: "Result Two", url: "https://example.com/two", snippet: "Second snippet." },
    ],
    ts,
  );
  const expected =
    `[${new Date(ts).toISOString()}] scan_market_signals("AI compliance tooling"):\n` +
    `  1. Result One — https://example.com/one\n` +
    `     First snippet.\n` +
    `  2. Result Two — https://example.com/two\n` +
    `     Second snippet.`;
  assert.equal(text, expected);
});

test("formatMarketSignalEntry records an explicit 'no results' line rather than an empty block", () => {
  const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
  const text = formatMarketSignalEntry("nothing findable", [], ts);
  assert.equal(text, `[${new Date(ts).toISOString()}] scan_market_signals("nothing findable"): no results`);
});

// ─── ensureDraftOpportunityReport ──────────────────────────────────────

test("ensureDraftOpportunityReport opens a new report when none exists yet", () => {
  reset();
  const report = ensureDraftOpportunityReport("0xA");
  assert.equal(report.agent_address, "0xA");
  assert.equal(report.status, "draft");
  assert.equal(reports.size, 1);
});

test("ensureDraftOpportunityReport reuses the most recent draft instead of opening a second one", () => {
  reset();
  const first = ensureDraftOpportunityReport("0xA");
  const second = ensureDraftOpportunityReport("0xA");
  assert.equal(second.id, first.id);
  assert.equal(reports.size, 1);
});

test("ensureDraftOpportunityReport opens a fresh report once the prior one is no longer draft", () => {
  reset();
  const first = ensureDraftOpportunityReport("0xA");
  first.status = "scored";
  const second = ensureDraftOpportunityReport("0xA");
  assert.notEqual(second.id, first.id);
  assert.equal(second.status, "draft");
});

test("ensureDraftOpportunityReport scopes drafts per agentAddress", () => {
  reset();
  const a = ensureDraftOpportunityReport("0xA");
  const b = ensureDraftOpportunityReport("0xB");
  assert.notEqual(a.id, b.id);
  assert.equal(a.agent_address, "0xA");
  assert.equal(b.agent_address, "0xB");
});

// ─── scan_market_signals writes through appendSourceSummary ───────────

test("two scans in the same pass accumulate onto the same report's source_summary", () => {
  reset();
  const report = ensureDraftOpportunityReport("0xA");
  const entry1 = formatMarketSignalEntry("query one", [
    { title: "T1", url: "https://example.com/1", snippet: "S1" },
  ], 1000);
  appendSourceSummary(report.id, entry1);
  const entry2 = formatMarketSignalEntry("query two", [], 2000);
  const updated = appendSourceSummary(report.id, entry2);
  assert.equal(updated.source_summary, `${entry1}\n${entry2}`);
});

test("appending to a non-draft report is rejected, matching appendSourceSummary()'s own lifecycle guard", () => {
  reset();
  const report = createOpportunityReport("0xA");
  report.status = "archived";
  assert.throws(() => appendSourceSummary(report.id, "should not land"), /not draft/);
});

// ─── DuckDuckGo HTML parsing ────────────────────────────────────────────

test("parseDuckDuckGoResults extracts title/url/snippet from DuckDuckGo's HTML endpoint shape", () => {
  const html = `
    <div class="result">
      <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpost&amp;rut=1">Example &amp; Co</a>
      <a class="result__snippet">A useful snippet about the topic.</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://other.example/page">Other Page</a>
      <a class="result__snippet">Another snippet.</a>
    </div>
  `;
  const results = parseDuckDuckGoResults(html, 8);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Example & Co");
  assert.equal(results[0].url, "https://example.com/post");
  assert.equal(results[0].snippet, "A useful snippet about the topic.");
  assert.equal(results[1].title, "Other Page");
  assert.equal(results[1].url, "https://other.example/page");
});

test("parseDuckDuckGoResults respects maxResults even when more are present in the HTML", () => {
  const html = Array.from(
    { length: 5 },
    (_, i) =>
      `<a class="result__a" href="https://example.com/${i}">Title ${i}</a><a class="result__snippet">Snippet ${i}</a>`,
  ).join("\n");
  const results = parseDuckDuckGoResults(html, 3);
  assert.equal(results.length, 3);
});

test("parseDuckDuckGoResults returns an empty array for HTML with no matching results (e.g. an anti-bot page)", () => {
  assert.deepEqual(parseDuckDuckGoResults("<html><body>Please verify you are human.</body></html>", 8), []);
});
