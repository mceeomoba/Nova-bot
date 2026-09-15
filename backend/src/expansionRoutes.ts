import express from "express";
import fs from "fs/promises";
import path from "path";
import {
  getPostLaunchReview,
  listPostLaunchReviewsForRoot,
  summarizeRoiCalibration,
  runDuePostLaunchReviews,
} from "./postLaunchReview.js";
import {
  appendSourceSummary,
  applyRegulatoryRiskEscalation,
  computeRoiScore,
  createOpportunity,
  ensureDraftOpportunityReport,
  findNearDuplicateOpportunity,
  formatMarketSignalEntry,
  getOpportunity,
  getOpportunityDetail,
  getOpportunityReport,
  listExpansionNotificationsForAgent,
  listRankedOpportunitiesForAgent,
  markExpansionNotificationDelivered,
  recordExpansionNotification,
  recordCompetitionSurvey,
  recordCustomerSegments,
  recordMarketSizeEstimate,
  recordRegulatoryRiskAssessment,
  recordResearchConfidence,
  recordBuildCostEstimate,
  recordTimeToRevenueEstimate,
  recordAvailableCapitalCheck,
  computeAvailableCapital,
  recordRunwayCheck,
  computeRunwayCheck,
  rejectForFailedRunway,
  recordWorstCaseLossEstimate,
  recordSizingRecommendation,
  recordStagedFundingOption,
  recordSensitivityNote,
  getRecentSpendUsdc,
  getRecentSpendRows,
  getFinanceAuditLog,
  recordTechnicalRequirements,
  recordBuildabilityAssessment,
  classifyRegulatoryRisk,
  buildBuildabilityCatalog,
  buildBuildabilityQueryText,
  checkBuildability,
  computeAndRecordResearchRiskScoring,
  compileResearchReport,
  RESEARCH_REPORT_SCHEMA_VERSION,
  validateResearchReportShape,
  compileFinanceReport,
  FINANCE_REPORT_SCHEMA_VERSION,
  validateFinanceReportShape,
  countCurrentResearchFindings,
  getCurrentResearchFinding,
  isValidResearchConfidence,
  setOpportunityStatus,
  validateScoringFactors,
  ROI_FORMULA_VERSION,
  listExistingCompanies,
  checkMissionOverlap,
  checkTechnologyReuse,
  scoreStrategyFit,
  recordMissionOverlapCheck,
  recordTechnologyReuseCheck,
  compileStrategyReport,
  STRATEGY_REPORT_SCHEMA_VERSION,
  validateStrategyReportShape,
  assessEcosystemStrengthening,
  recordEcosystemStrengtheningAssessment,
  checkCannibalization,
  recordCannibalizationCheck,
  recommendRelationshipType,
  recordRelationshipTypeRecommendation,
  assembleCommitteePacket,
  validateCommitteePacketShape,
  COMMITTEE_PACKET_SCHEMA_VERSION,
  isDeliberationEnabled,
  setDeliberationEnabled,
  recordDeliberationResponse,
  getDeliberationExchange,
  isValidDeliberationDepartment,
  isValidDeliberationPosition,
  DELIBERATION_DEPARTMENTS,
  recordDepartmentVote,
  listDepartmentVotes,
  getVotingRecord,
  isValidVoteDepartment,
  isValidVoteValue,
  VOTE_DEPARTMENTS,
  decideExpansion,
  isValidCeoDecision,
  CEO_DECISIONS,
  getExpansionAuditBundle,
  validateExpansionAuditBundleShape,
  AUDIT_BUNDLE_SCHEMA_VERSION,
  isDryRunModeEnabled,
  setDryRunModeEnabled,
  getDryRunGenesisPacket,
  listDryRunGenesisPackets,
  getRolloutStage,
  checkRolloutGraduationEligibility,
  graduateToLiveGenesis,
  listRolloutGraduationEvents,
  type ExpansionNotification,
  type MarketSignalResult,
  type Opportunity,
  type OpportunityAction,
  type OpportunityReport,
  type OpportunityStatus,
  type ScoringFactors,
  type TechnicalRequirementsAssessment,
} from "./expansion.js";
import { ensureOffice, officeInboxDir } from "./office.js";
import { getUsdcBalance } from "./wallet.js";
import {
  hasOpportunityIntelligenceTickCapacity,
  recordOpportunityIntelligenceTick,
  hasFinanceTickCapacity,
  recordFinanceTick,
} from "./resourceQuotas.js";
import { config } from "./config.js";

/**
 * Zent.md Phase 2b — the HTTP surface for scan_market_signals(query).
 *
 * Mounted as `app.use("/expansion", expansionRouter)` in index.ts,
 * behind the same shared-secret `x-backend-key` middleware every other
 * agent-facing route sits behind (see index.ts's own comment on that
 * middleware) — same trust boundary skillsRoutes.ts/customToolRoutes.ts
 * already document: a caller holding BACKEND_API_KEY is either the
 * owner agent's own runtime, or (per subagents.ts's "Parent's runtime
 * is the scheduler" note) a department/worker acting *through* that
 * owner's agentAddress, never as a distinct identity of its own. This
 * route follows that exact shape — every write is scoped by the
 * `agentAddress` in the request body, not by any department-specific
 * auth, matching skillsRoutes.ts's own ownership model rather than
 * domainRoutes.ts's getOwnedDepartment() one (there is no
 * department-id concept in the opportunity_reports data model at all —
 * see expansion.ts's Phase 1a comment: reports belong to the top-level
 * agent, "Company A", not to whichever opportunity_intelligence
 * department instance happens to be running a given pass).
 *
 * Why the search AND the write both happen here, server-side, rather
 * than the department's own harness fetching results itself (via its
 * existing web_search/web_fetch grant) and separately reporting them
 * back: Zent.md 2b describes scan_market_signals as a single named
 * tool a department calls, not a two-step "search yourself, then tell
 * us what you found" protocol — collapsing it into one route call means
 * source_summary can never end up out of sync with what was actually
 * searched (no window where a department fetches results and crashes,
 * or edits them, before relaying them onward), the same "the record is
 * exactly what happened, not a self-report of what happened" property
 * expansion.ts's own isEligibleForExpansion() comment calls out for
 * revenue/spend figures.
 *
 * The DuckDuckGo HTML-endpoint scraping below is a deliberate
 * duplicate of agent/src/agent/tools.ts's own web_search tool, not a
 * shared import — backend/src and agent/src are two independent
 * TypeScript projects with no dependency edge between them anywhere in
 * this repo (see toolRegistry.ts's own header for the identical
 * reasoning behind its DEPARTMENT_TYPE_ALIASES duplication). If the
 * parsing logic ever needs to change, both copies need the same fix by
 * hand.
 *
 * Zent.md Phase 2c update: list_customer_complaints(domain) and
 * list_demand_signals(industry) below are "thin, named wrappers over
 * 2b" exactly as the doc specifies — each one builds its own search
 * query from its single argument, calls the *same* scanMarketSignals()
 * DuckDuckGo path 2b's route already uses, and writes into the same
 * opportunity_reports lifecycle via ensureDraftOpportunityReport()/
 * appendSourceSummary(). The only thing that's actually new is the
 * query-building (buildComplaintsQuery()/buildDemandSignalsQuery()) and
 * the `callLabel` passed to formatMarketSignalEntry() — the log entry
 * for a list_customer_complaints("acme.com") call reads exactly that,
 * not the longer DuckDuckGo query it expanded into under the hood, so
 * a department reading its own report back sees the tool call it made,
 * not the search machinery behind it.
 *
 * Zent.md Phase 2d update: all three routes below now open with a
 * daily tick-cap check — hasOpportunityIntelligenceTickCapacity()
 * (resourceQuotas.ts) — before doing any other work, same position
 * "2. Daily rate cap" occupies in distribution.ts's own POST /publish
 * (cheapest, most-decisive rejection first, ahead of report resolution
 * or an actual outbound search). A call over the cap gets a 429 with
 * no search performed and no report touched.
 * recordOpportunityIntelligenceTick() is only called once
 * scanMarketSignals() has actually returned successfully — a 502
 * search failure below never consumes a tick, matching every other
 * "count what happened, not what was attempted" convention in this
 * file.
 */

const router = express.Router();

const MAX_QUERY_LENGTH = 300;
const MAX_RESULTS = 8;
const SEARCH_TIMEOUT_MS = 15_000;

// ─── DuckDuckGo HTML endpoint scraping (mirrors agent/src/agent/tools.ts) ──

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

/**
 * Runs the actual search. Thrown errors are network/HTTP failures only
 * — "zero results for this query" is not an error (see
 * formatMarketSignalEntry()'s own "no results" handling), it's a
 * legitimate, expected outcome the caller still gets a 200 for.
 */
async function scanMarketSignals(query: string): Promise<MarketSignalResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const html = await res.text();
    return parseDuckDuckGoResults(html, MAX_RESULTS);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolves the target draft report for a signal-collecting tool call,
 * shared by scan-market-signals (2b) and the 2c wrappers below. Mirrors
 * the reportId-optional behavior the 2b route already documented above
 * this file's header: omit it to reuse/open the caller's current draft
 * via ensureDraftOpportunityReport(); pass it to target a specific
 * report. Returns either the resolved report or an { status, error }
 * pair the caller should send back as-is — kept as a plain return
 * rather than a thrown error so every route here can stay symmetric
 * with 2b's own existing error-response shapes without a shared
 * exception type.
 */
function resolveTargetReport(
  agentAddress: string,
  reportId: unknown,
): { report: OpportunityReport } | { status: number; error: string } {
  if (reportId !== undefined) {
    if (typeof reportId !== "string" || !reportId) {
      return { status: 400, error: "reportId, if provided, must be a non-empty string" };
    }
    const existing = getOpportunityReport(reportId);
    if (!existing) {
      return { status: 404, error: `opportunity_report ${reportId} not found` };
    }
    if (existing.agent_address !== agentAddress) {
      return { status: 403, error: "reportId does not belong to agentAddress" };
    }
    if (existing.status !== "draft") {
      return { status: 409, error: `opportunity_report ${reportId} is ${existing.status}, not draft` };
    }
    return { report: existing };
  }
  return { report: ensureDraftOpportunityReport(agentAddress) };
}

// POST /expansion/reports/scan-market-signals
// body: { agentAddress, query, reportId? }
//
// reportId is optional: omit it (the common case — a department mid-
// pass usually doesn't track its own report id across calls) to have
// this route resolve/open the caller's current draft report itself via
// ensureDraftOpportunityReport(). Pass it explicitly when a caller
// already holds a specific report id (e.g. a test, or a future Phase 4
// UI action) and wants to target that exact report rather than
// whichever draft happens to be most recent.
router.post("/reports/scan-market-signals", async (req, res) => {
  try {
    const { agentAddress, query, reportId } = req.body || {};

    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (typeof query !== "string" || !query.trim()) {
      return res.status(400).json({ error: "query is required" });
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return res
        .status(400)
        .json({ error: `query must be ${MAX_QUERY_LENGTH} characters or fewer` });
    }

    if (!hasOpportunityIntelligenceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_opportunity_intelligence_tick_limit_reached",
        limit: config.maxOpportunityIntelligenceTicksPerAgentPerDay,
      });
    }

    const resolved = resolveTargetReport(agentAddress, reportId);
    if ("error" in resolved) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const { report } = resolved;

    let results: MarketSignalResult[];
    try {
      results = await scanMarketSignals(query);
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `scan_market_signals failed: ${err?.message || "unknown error"}` });
    }
    recordOpportunityIntelligenceTick(agentAddress);

    const entry = formatMarketSignalEntry(query, results);
    const updated = appendSourceSummary(report.id, entry);

    res.json({ reportId: updated.id, query, results, report: updated });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 2c: list_customer_complaints(domain) / list_demand_signals(industry) ──
//
// Both are "thin, named wrappers over 2b" (Zent.md): each takes one
// caller-facing argument, expands it into a DuckDuckGo query internally,
// runs the exact same scanMarketSignals() path 2b's route uses, and
// writes into the same opportunity_reports draft lifecycle. The only
// per-tool work is the query template below plus the callLabel passed
// to formatMarketSignalEntry() (see that function's own docstring in
// expansion.ts) — no new report/result shape, no new lifecycle.

const MAX_DOMAIN_LENGTH = 253; // longest a valid DNS name can be
const MAX_INDUSTRY_LENGTH = 200;

function buildComplaintsQuery(domain: string): string {
  return `${domain} complaints reviews problems reddit`;
}

function buildDemandSignalsQuery(industry: string): string {
  return `${industry} demand growing trend "need a" OR "wish there was"`;
}

// POST /expansion/reports/list-customer-complaints
// body: { agentAddress, domain, reportId? }
router.post("/reports/list-customer-complaints", async (req, res) => {
  try {
    const { agentAddress, domain, reportId } = req.body || {};

    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (typeof domain !== "string" || !domain.trim()) {
      return res.status(400).json({ error: "domain is required" });
    }
    if (domain.length > MAX_DOMAIN_LENGTH) {
      return res
        .status(400)
        .json({ error: `domain must be ${MAX_DOMAIN_LENGTH} characters or fewer` });
    }

    if (!hasOpportunityIntelligenceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_opportunity_intelligence_tick_limit_reached",
        limit: config.maxOpportunityIntelligenceTicksPerAgentPerDay,
      });
    }

    const resolved = resolveTargetReport(agentAddress, reportId);
    if ("error" in resolved) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const { report } = resolved;

    let results: MarketSignalResult[];
    try {
      results = await scanMarketSignals(buildComplaintsQuery(domain));
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `list_customer_complaints failed: ${err?.message || "unknown error"}` });
    }
    recordOpportunityIntelligenceTick(agentAddress);

    const entry = formatMarketSignalEntry(domain, results, Date.now(), {
      toolName: "list_customer_complaints",
      arg: domain,
    });
    const updated = appendSourceSummary(report.id, entry);

    res.json({ reportId: updated.id, domain, results, report: updated });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// POST /expansion/reports/list-demand-signals
// body: { agentAddress, industry, reportId? }
router.post("/reports/list-demand-signals", async (req, res) => {
  try {
    const { agentAddress, industry, reportId } = req.body || {};

    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (typeof industry !== "string" || !industry.trim()) {
      return res.status(400).json({ error: "industry is required" });
    }
    if (industry.length > MAX_INDUSTRY_LENGTH) {
      return res
        .status(400)
        .json({ error: `industry must be ${MAX_INDUSTRY_LENGTH} characters or fewer` });
    }

    if (!hasOpportunityIntelligenceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_opportunity_intelligence_tick_limit_reached",
        limit: config.maxOpportunityIntelligenceTicksPerAgentPerDay,
      });
    }

    const resolved = resolveTargetReport(agentAddress, reportId);
    if ("error" in resolved) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const { report } = resolved;

    let results: MarketSignalResult[];
    try {
      results = await scanMarketSignals(buildDemandSignalsQuery(industry));
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `list_demand_signals failed: ${err?.message || "unknown error"}` });
    }
    recordOpportunityIntelligenceTick(agentAddress);

    const entry = formatMarketSignalEntry(industry, results, Date.now(), {
      toolName: "list_demand_signals",
      arg: industry,
    });
    const updated = appendSourceSummary(report.id, entry);

    res.json({ reportId: updated.id, industry, results, report: updated });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 3a: score_opportunity(title, thesis, factors) ──────────────
//
// Zent.md: "score_opportunity(title, thesis, factors) tool that writes
// one row to opportunities, factors = demand, expense-of-problem,
// buildability-by-our-stack, competitive-gap — each 0-100."
//
// Unlike 2b/2c above, this route doesn't call out to anything external
// — it's a pure validate-then-write against the opportunities table via
// expansion.ts's createOpportunity(), which is why it's synchronous and
// has no scan/search failure mode. reportId is optional for the exact
// same reason 2b/2c's is: a department mid-pass usually doesn't track
// its own report id across calls, so resolveTargetReport() (shared with
// those two routes above) reuses/opens the caller's current draft
// report by default. A report must still be 'draft' status to accept a
// new opportunity — resolveTargetReport()'s own check already enforces
// that. (An earlier version of this comment guessed Phase 3d's top-N
// selection would be what eventually flips a report out of 'draft' —
// it turned out 3d's selection state is per-OPPORTUNITY
// (opportunities.status), not per-report, since one report's several
// opportunities can sit at different selection states; see
// expansion.ts's own Phase 3d section for the corrected reasoning.
// Phase 3e update: a report now does move out of 'draft' on its own —
// expansion.ts's sweepKillCondition()/evaluateKillCondition(), wired
// into the same scheduled tick as 3d's own selectTopOpenOpportunities()
// sweep, archives a 'draft' report directly (skipping 'scored' — see
// setOpportunityReportStatus()'s TERMINAL map) once it has at least one
// scored opportunity and none of them clear config.expansionMinRoiFloor.
// Nothing in this route or file needs to change for that: this route
// still only ever writes an opportunity row and lets resolveTargetReport()
// below keep resolving the caller's current draft report normally right
// up until the tick that report gets killed out from under it — a
// score_opportunity call against an already-archived report fails the
// same way any other post-draft write does (resolveTargetReport()'s own
// 'must still be draft' check), which is the correct behavior: a killed
// report is done accepting new opportunities.)
//
// Phase 3b update: roi_score is now set at creation time, not left
// null for a later pass. Once candidateFactors passes
// validateScoringFactors() below, computeRoiScore() (expansion.ts)
// runs the same fixed weighted-average formula against them and the
// result — plus ROI_FORMULA_VERSION, so the row records which formula
// produced it — goes straight into createOpportunity()'s options.
// score_opportunity is one tool call from a department's point of
// view; there's no separate "now score it" step for a caller to
// forget, and no window where an opportunity sits with a null
// roi_score after a successful call.
//
// No tick/spend cap here either: 2d's opportunity_intelligence_ticks
// cap is specific to the three signal-collection tools (2b/2c) that
// make an outbound network call on this backend's own dime; scoring an
// already-collected opportunity — factors in, one deterministic
// arithmetic pass, row written — has no equivalent cost to bound.
//
// Phase 3c update: a de-dup check (findNearDuplicateOpportunity(),
// expansion.ts) now runs right after factor validation and before
// resolveTargetReport() — deliberately ahead of report resolution, not
// after, so a call that's about to be rejected as a duplicate never
// triggers resolveTargetReport()'s side effect of opening a fresh
// draft report when the caller omitted reportId. A match returns 409
// naming the existing near-duplicate (id, title, similarity) rather
// than silently merging into it or creating a second near-identical
// row — see findNearDuplicateOpportunity()'s own header for why reject
// was chosen over merge.

const MAX_TITLE_LENGTH = 200;
const MAX_THESIS_LENGTH = 2000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Phase 4d: notification delivery ───────────────────────────────────
//
// Zent.md: "Notification hook (reuses whatever channel office.ts/admin
// status already uses) firing when a new opportunity clears the ROI
// floor."
//
// The channel reused here is office.ts's per-agent inbox — the same
// office/fs/inbox/ directory channelService.ts's send_file() already
// lands cross-agent messages in for an agent's own runtime to read on
// its next tick (see office.ts's own "written only by the future
// channel broker" doc comment). This is a system-generated message
// about the agent's own pipeline, not a message from another agent, so
// it skips channelService.ts's channel-grant machinery entirely (that
// machinery exists to gate messages BETWEEN two different agents — an
// agent doesn't need its own consent to notify itself) and writes
// directly via ensureOffice()/officeInboxDir(), tagged with a
// `from: "system:expansion-pipeline"` sender so the agent's own inbox
// reader can tell this apart from a genuine peer message at a glance.
//
// Deliberately agent-facing, not human-facing: admin.ts's
// GET /admin/status is a read-only operational snapshot a human
// operator MAY look at, but nothing here pushes to it or waits on
// anyone reading it — the agent's own inbox is the actual delivery
// target, matching Zent.md's own "no external operator step in this
// path" framing carried over from Phase 4c.
//
// Best-effort: a filesystem failure here must never fail the
// already-succeeded score_opportunity call that triggered it — same
// "never let a side-channel failure undo or block the write it's a
// side effect of" rule sendFile()'s own hashFileContents().catch()
// applies in channelService.ts. recordExpansionNotification()'s DB row
// (expansion.ts) is what actually records "this opportunity cleared
// the floor"; this function only decides whether the agent's inbox
// also got told, and marks delivered accordingly.
async function deliverExpansionNotification(
  notification: ExpansionNotification,
  opportunity: Opportunity,
): Promise<void> {
  if (notification.delivered) return; // already landed on a prior call — nothing to do
  try {
    await ensureOffice(notification.agentAddress);
    const inboxDir = officeInboxDir(notification.agentAddress);
    await fs.mkdir(inboxDir, { recursive: true });
    const envelope = {
      type: "expansion_opportunity_notification",
      from: "system:expansion-pipeline",
      opportunityId: opportunity.id,
      title: opportunity.title,
      thesis: opportunity.thesis,
      roiScore: opportunity.roi_score,
      createdAt: notification.createdAt,
    };
    const destPath = path.join(inboxDir, `expansion-notification-${notification.id}.json`);
    await fs.writeFile(destPath, JSON.stringify(envelope, null, 2), "utf8");
    markExpansionNotificationDelivered(notification.id);
  } catch (err: any) {
    // Logged, not thrown: the caller (score-opportunity route below)
    // already sent its 201 response by the time this settles in the
    // common case, and even if it hasn't yet, a delivery failure is
    // never a reason to fail a scoring call that has already written
    // its opportunity row. The notification row stays at delivered=0
    // for a future retry/sweep (out of this phase's scope) rather than
    // being silently dropped.
    console.error(
      `[expansion-notification] delivery failed for notification ${notification.id} (opportunity ${opportunity.id}):`,
      err?.message || err,
    );
  }
}

// POST /expansion/opportunities/score-opportunity
// body: { agentAddress, title, thesis, factors: { demand, expenseOfProblem, buildability, competitiveGap }, reportId? }
router.post("/opportunities/score-opportunity", async (req, res) => {
  try {
    const { agentAddress, title, thesis, factors, reportId } = req.body || {};

    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return res.status(400).json({ error: `title must be ${MAX_TITLE_LENGTH} characters or fewer` });
    }
    if (typeof thesis !== "string" || !thesis.trim()) {
      return res.status(400).json({ error: "thesis is required" });
    }
    if (thesis.length > MAX_THESIS_LENGTH) {
      return res.status(400).json({ error: `thesis must be ${MAX_THESIS_LENGTH} characters or fewer` });
    }
    if (!isPlainObject(factors)) {
      return res.status(400).json({
        error: "factors is required and must be an object with demand, expenseOfProblem, buildability, competitiveGap",
      });
    }

    const candidateFactors = factors as unknown as ScoringFactors;
    try {
      validateScoringFactors(candidateFactors);
    } catch (err: any) {
      return res.status(400).json({ error: err.message || "invalid scoring factors" });
    }

    const duplicate = findNearDuplicateOpportunity(agentAddress, title.trim(), thesis.trim());
    if (duplicate) {
      return res.status(409).json({
        error: "near-duplicate of an already-scored opportunity for this agent",
        duplicate: {
          opportunityId: duplicate.opportunity.id,
          title: duplicate.opportunity.title,
          roiScore: duplicate.opportunity.roi_score,
          similarity: duplicate.similarity,
        },
      });
    }

    const resolved = resolveTargetReport(agentAddress, reportId);
    if ("error" in resolved) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const { report } = resolved;

    const roiScore = computeRoiScore(candidateFactors);

    const opportunity = createOpportunity(report.id, title.trim(), thesis.trim(), {
      factors: candidateFactors,
      roiScore,
      roiFormulaVersion: ROI_FORMULA_VERSION,
    });

    // Phase 4d: fire-and-record the notification hook. This runs after
    // createOpportunity() has already committed — a notification is
    // strictly downstream of a successfully-scored opportunity, never a
    // precondition for one. recordExpansionNotification() itself is a
    // synchronous DB check (does this clear config.expansionMinRoiFloor,
    // has it already fired) with no failure mode that should ever
    // reach here for a freshly-created opportunity; deliverExpansionNotification()
    // is the best-effort half and never throws (see its own header).
    const notification = recordExpansionNotification(opportunity);
    if (notification) {
      await deliverExpansionNotification(notification, opportunity);
    }

    res.status(201).json({ reportId: report.id, opportunity });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 4a: GET /expansion/opportunities/:agentAddress ─────────────
// ─── Phase 4b: GET /expansion/opportunities/:id ────────────────────────
//
// Zent.md names these as two distinct endpoints:
//   4a: "GET /expansion/opportunities/:agentAddress — ranked list, same
//        shape as the 'Top Opportunities' list in chat (title, ROI,
//        one-line thesis)."
//   4b: "GET /expansion/opportunities/:id — full detail: source
//        summary, scoring factors, de-dup history."
// but both are, at the HTTP layer, `GET /expansion/opportunities/:x` —
// one path segment, no way for Express to route on "is this an
// agentAddress or an opportunity id" by shape of the pattern alone.
// Registering two identical-shaped GET routes wouldn't raise an error;
// it would just mean the second registration silently never fires,
// which is worse than a routing conflict because nothing would ever
// flag it. Resolved the same way this codebase resolves every other
// "two things share an identifier position" ambiguity it's hit
// (cloning.ts's spawn_clone vs. a plain agent address, subagents.ts's
// department-id-vs-worker-id lookups): dispatch on the identifier's own
// shape, which is already unambiguous — agentAddress is always a
// 0x-prefixed EVM address (wallet.ts's account.address, viem), and
// every id this file's data layer mints is ULID-based with an explicit
// prefix (expansion.ts's `opp_${ulid()}` for an opportunity, `oppr_` for
// a report) that a real EVM address can never collide with. A single
// route registration below inspects the one path param it receives and
// hands off to whichever handler matches; nothing about that dispatch
// touches the two handlers' own logic below, each of which is
// exactly the single-purpose function Zent.md names.
//
// Deliberately a GET with no request body and no x-backend-key-derived
// ownership check beyond what the shared middleware in index.ts already
// enforces — same posture toolRegistryRoutes.ts's own read-only
// GET /tool-registry/available takes (see that file's header): any
// caller already holding this backend's BACKEND_API_KEY can read any
// agentAddress's ranked list or any opportunity's full detail, not just
// "its own." There is no cross-tenant concern to defend against here —
// this backend is self-hosted per operator (see wallet.ts's own
// header), so every agentAddress/opportunity reachable through it
// already belongs to the same operator this key belongs to.

/** Every id expansion.ts mints for an opportunity is `opp_${ulid()}` —
 *  see createOpportunity() there. An agentAddress is a viem EVM
 *  account.address (wallet.ts), always `0x`-prefixed and never this
 *  prefix, so this check alone is enough to route unambiguously. */
function looksLikeOpportunityId(value: string): boolean {
  return value.startsWith("opp_");
}

// 4a handler — see this section's header above for what stays the same
// from before 4b's routing change (this is exactly the prior
// GET /opportunities/:agentAddress body, unmodified, just no longer
// registered under a route pattern of its own).
function handleListForAgent(agentAddress: string, req: express.Request, res: express.Response) {
  try {
    const options: { status?: OpportunityStatus; limit?: number } = {};

    const { status, limit } = req.query;
    if (status !== undefined) {
      if (typeof status !== "string" || !["open", "selected", "rejected"].includes(status)) {
        return res.status(400).json({ error: "status must be one of: open, selected, rejected" });
      }
      options.status = status as OpportunityStatus;
    }

    if (limit !== undefined) {
      const parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
      options.limit = parsedLimit;
    }

    const opportunities = listRankedOpportunitiesForAgent(agentAddress, options);
    res.json({ agentAddress, opportunities });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
}

// 4b handler — all ranking/assembly logic is getOpportunityDetail()
// (expansion.ts); this route's own job is the same thin "parse the
// path param, map not-found/thrown-errors onto the right HTTP status"
// role every other route in this file plays relative to expansion.ts.
// getOpportunityDetail() returning undefined (an id that simply doesn't
// exist) maps to a plain 404 — distinct from the 500 a genuinely
// thrown Error still gets below, matching getOpportunity()'s own
// "not found is not an error" convention rather than treating every
// miss as a server fault.
function handleOpportunityDetail(id: string, res: express.Response) {
  try {
    const detail = getOpportunityDetail(id);
    if (!detail) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    res.json({
      id: detail.opportunity.id,
      reportId: detail.opportunity.report_id,
      agentAddress: detail.agentAddress,
      reportStatus: detail.reportStatus,
      title: detail.opportunity.title,
      thesis: detail.opportunity.thesis,
      roiScore: detail.opportunity.roi_score,
      roiFormulaVersion: detail.opportunity.roi_formula_version,
      factors: detail.opportunity.factors,
      tags: detail.opportunity.tags,
      status: detail.opportunity.status,
      selectedAt: detail.opportunity.selected_at,
      createdAt: detail.opportunity.created_at,
      sourceSummary: detail.sourceSummary,
      dedupHistory: detail.dedupHistory,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
}

router.get("/opportunities/:idOrAgentAddress", (req, res) => {
  const { idOrAgentAddress } = req.params;
  if (!idOrAgentAddress) {
    return res.status(400).json({ error: "agentAddress is required" });
  }
  if (looksLikeOpportunityId(idOrAgentAddress)) {
    return handleOpportunityDetail(idOrAgentAddress, res);
  }
  return handleListForAgent(idOrAgentAddress, req, res);
});

// ─── Phase 4c: promote / demote / reject ────────────────────────────────
//
// Zent.md: "Promote/demote/reject remains an agent-only action:
// Opportunity Intelligence (or the top-level agent acting on its own
// report) can re-rank or drop an opportunity before Research picks it
// up — no external operator step in this path."
//
// "Agent-only" is enforced the exact same way every other write route
// in this file enforces ownership (resolveTargetReport()'s own
// agentAddress-must-match check, above) — not by a distinct operator
// role or a second approval step, since none exists in this pipeline
// (see this file's own header on the shared BACKEND_API_KEY trust
// boundary: a caller holding it is the owner agent's own runtime or a
// department acting through it, never a separate human identity with a
// veto). The three checks below — id shape, action name, then
// ownership — run in that order so a caller pointed at someone else's
// opportunity gets 403 before setOpportunityStatus() ever touches the
// row, and a caller with an invalid action name gets 400 before either
// existence or ownership is even looked up.
//
// setOpportunityStatus() (expansion.ts) does the actual transition
// validation/write; this route's own job is exactly what 4b's route
// above already does relative to expansion.ts — parse the params, map
// "not found" / "not yours" / "invalid move" onto the right status
// code, nothing more. An invalid transition (rejected -> anything,
// promote against an archived report, promote past the topN cap) comes
// back as a thrown Error from setOpportunityStatus() and is reported as
// 409 — same "the request was well-formed but the current state won't
// allow it" convention score-opportunity's own near-duplicate 409 and
// resolveTargetReport()'s own non-draft 409 already use in this file.

const VALID_OPPORTUNITY_ACTIONS: OpportunityAction[] = ["promote", "demote", "reject"];

// POST /expansion/opportunities/:id/status
// body: { agentAddress, action: "promote" | "demote" | "reject" }
router.post("/opportunities/:id/status", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, action } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (typeof action !== "string" || !VALID_OPPORTUNITY_ACTIONS.includes(action as OpportunityAction)) {
      return res
        .status(400)
        .json({ error: `action must be one of: ${VALID_OPPORTUNITY_ACTIONS.join(", ")}` });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — report_id is FK-constrained at insert
      // (createOpportunity()'s own guard) — but treated as a genuine
      // server fault rather than a 404, matching getOpportunityDetail()'s
      // identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    let updated;
    try {
      updated = setOpportunityStatus(id, action as OpportunityAction);
    } catch (err: any) {
      return res.status(409).json({ error: err.message || "invalid status transition" });
    }

    res.json({ opportunity: updated });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 5b: POST /expansion/opportunities/:id/research/estimate-market-size ──
//
// Tool surface for estimate_market_size(opportunity_id) — Zent.md 5b:
// "web-search backed, writes to research_findings.market_size." Unlike
// 2b/2c above (which take a caller-supplied query), this tool takes
// only the opportunity_id: the search query is built here, server-side,
// from the opportunity's own title/thesis, the same "the record is
// exactly what happened, not a self-report" reasoning 2b's own header
// gives for doing the search in the route rather than trusting a
// department-supplied query and results pair.
//
// Ownership check mirrors /opportunities/:id/status above exactly
// (opportunity -> its report -> report.agent_address must equal the
// caller's agentAddress) — a research department instance is spawned
// by, and reports to, one specific top-level agent (Zent.md 5a), so
// this route only ever writes on behalf of the opportunity's own owner.
//
// No department-type/tick-cap gate here the way 2d's
// hasOpportunityIntelligenceTickCapacity() gates scan_market_signals:
// a `research` department is spawned one-per-opportunity and torn down
// the moment its finding is filed (5a, and see createFinding()'s own
// Phase 5a comment for the retire-on-file mechanism), which already
// bounds how many times this can run for a given opportunity far more
// tightly than a per-day tick counter would. If a future phase adds a
// research-specific quota, it belongs here in the same "cheapest,
// most-decisive rejection first" position 2b's own cap check occupies.
router.post("/opportunities/:id/research/estimate-market-size", async (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see getOpportunityDetail()'s and
      // /opportunities/:id/status's identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    // Query-building from the opportunity itself, not a caller argument
    // — same "single named tool, one fixed argument" shape 2c's
    // buildComplaintsQuery()/buildDemandSignalsQuery() already use for
    // list_customer_complaints(domain)/list_demand_signals(industry).
    const query = `"${opportunity.title}" market size total addressable market`.slice(
      0,
      MAX_QUERY_LENGTH,
    );

    let results: MarketSignalResult[];
    try {
      results = await scanMarketSignals(query);
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `estimate_market_size failed: ${err?.message || "unknown error"}` });
    }

    const finding = recordMarketSizeEstimate(id, {
      query,
      results,
      estimatedAt: Date.now(),
    });

    res.json({ opportunityId: id, query, results, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 5c: POST /expansion/opportunities/:id/research/survey-competition ──
//
// Tool surface for survey_competition(opportunity_id) — Zent.md 5c:
// "lists incumbents, pricing tiers, obvious gaps." Structurally
// identical to 5b's route just above: same opportunity-derived query
// (no caller-supplied argument), same ownership check, same
// scanMarketSignals() search path, same 502-on-search-failure /
// 502-only-consumes-nothing-else posture. The only things that differ
// are the query template and which recordX() persistence call and
// response key get used — everything else is copy-shaped on purpose so
// 5d's own route reads as the same pattern a third time, not a new one.
router.post("/opportunities/:id/research/survey-competition", async (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see getOpportunityDetail()'s and
      // /opportunities/:id/status's identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    // "incumbents, pricing tiers, obvious gaps" (5c) — one query tuned
    // to surface competitor/pricing pages rather than 5b's TAM-style
    // query, same one-fixed-query-per-tool shape 5b/2c both already use.
    const query = `"${opportunity.title}" competitors pricing alternatives`.slice(
      0,
      MAX_QUERY_LENGTH,
    );

    let results: MarketSignalResult[];
    try {
      results = await scanMarketSignals(query);
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `survey_competition failed: ${err?.message || "unknown error"}` });
    }

    const finding = recordCompetitionSurvey(id, {
      query,
      results,
      surveyedAt: Date.now(),
    });

    res.json({ opportunityId: id, query, results, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 5d: POST /expansion/opportunities/:id/research/identify-customer-segments ──
//
// Tool surface for identify_customer_segments(opportunity_id) —
// Zent.md 5d: "who actually buys this, and how they currently solve
// the problem." Same shape as 5b/5c's routes once more: opportunity-
// derived query, same ownership check, same scanMarketSignals() search
// path, same failure/response posture. This is the third and last of
// the three tools Phase 5's own comment predicted for `research`.
router.post("/opportunities/:id/research/identify-customer-segments", async (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see getOpportunityDetail()'s and
      // /opportunities/:id/status's identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    // "who actually buys this, and how they currently solve the
    // problem" (5d) — one query tuned toward buyer identity and
    // existing-workaround language, distinct from 5b's TAM query and
    // 5c's competitor/pricing query.
    const query = `who buys "${opportunity.title}" how do they solve it today`.slice(
      0,
      MAX_QUERY_LENGTH,
    );

    let results: MarketSignalResult[];
    try {
      results = await scanMarketSignals(query);
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `identify_customer_segments failed: ${err?.message || "unknown error"}` });
    }

    const finding = recordCustomerSegments(id, {
      query,
      results,
      identifiedAt: Date.now(),
    });

    res.json({ opportunityId: id, query, results, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 6a: POST /expansion/opportunities/:id/research/assess-technical-requirements ──
//
// Tool surface for assess_technical_requirements(opportunity_id) —
// Zent.md 6a: "what would Agent B actually need to build, in terms of
// this stack's existing tool/skill catalog." Same shape as 5b/5c/5d's
// routes just above once more: opportunity-derived query (no
// caller-supplied argument), same ownership check, same
// scanMarketSignals() search path, same failure/response posture.
// Persists via recordTechnicalRequirements() into the same current
// research finding 5b/5c/5d already write to — 6b-6e (regulatory risk,
// the buildability check against toolRegistrySeedData.ts/
// skillsRoutes.ts, the merged risk score, and the escalation path) are
// separate, not-yet-built sub-phases that read this field rather than
// this route computing a buildability verdict itself.
router.post("/opportunities/:id/research/assess-technical-requirements", async (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see getOpportunityDetail()'s and
      // /opportunities/:id/status's identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    // "what would Agent B actually need to build" (6a) — one query
    // tuned toward implementation/tech-stack language, distinct from
    // 5b's TAM query, 5c's competitor/pricing query, and 5d's
    // buyer-identity query.
    const query = `"${opportunity.title}" tech stack build requirements engineering`.slice(
      0,
      MAX_QUERY_LENGTH,
    );

    let results: MarketSignalResult[];
    try {
      results = await scanMarketSignals(query);
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `assess_technical_requirements failed: ${err?.message || "unknown error"}` });
    }

    const finding = recordTechnicalRequirements(id, {
      query,
      results,
      assessedAt: Date.now(),
    });

    res.json({ opportunityId: id, query, results, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 6b: POST /expansion/opportunities/:id/research/assess-regulatory-risk ──
//
// Tool surface for assess_regulatory_risk(opportunity_id) — Zent.md
// 6b: "flags healthcare/finance/legal-style domains that need real
// compliance work a pure software agent can't discharge alone." Same
// ownership-check shape as 5b/5c/5d/6a's routes, but no
// scanMarketSignals() call and no caller-supplied or opportunity-
// derived search query — classifyRegulatoryRisk() (expansion.ts) is a
// pure, deterministic function over the opportunity's own
// title/thesis/tags, so there's nothing to fetch and nothing that can
// 502. 6e's escalation path fires automatically at the end of this
// same route (applyRegulatoryRiskEscalation()) — a `high` verdict
// tags the opportunity itself in the same call that recorded it, no
// separate agent step required.
router.post("/opportunities/:id/research/assess-regulatory-risk", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see getOpportunityDetail()'s and
      // /opportunities/:id/status's identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const { domains, riskLevel } = classifyRegulatoryRisk(
      opportunity.title,
      opportunity.thesis,
      opportunity.tags,
    );

    const finding = recordRegulatoryRiskAssessment(id, {
      domains,
      riskLevel,
      assessedAt: Date.now(),
    });

    // Phase 6e: fires on every call, not just the first time a "high"
    // verdict lands — applyRegulatoryRiskEscalation() is idempotent
    // (addOpportunityTag()'s own guard), so re-running 6b after a prior
    // high verdict is a harmless no-op tag-wise, and a re-run that
    // clears from "high" back to "none" simply reports escalated:false
    // without untagging (the escalation is a historical fact about this
    // opportunity having flagged high at some point, not a live status
    // this route un-asserts on a cleaner re-read).
    const { escalated, opportunity: escalatedOpportunity } = applyRegulatoryRiskEscalation(id);

    res.json({
      opportunityId: id,
      domains,
      riskLevel,
      finding,
      escalated,
      tags: escalatedOpportunity.tags,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 6c: POST /expansion/opportunities/:id/research/check-buildability ──
//
// Tool surface for 6c's buildability check — Zent.md: "can an agent
// with today's tool catalog actually execute on this, or does it need
// new tools first (flag, don't block)." Same ownership-check shape as
// every Phase 5/6 route above; no scanMarketSignals() call (like 6b,
// nothing here is network-backed, so there's no 502 path) — this route
// assembles the two pure inputs checkBuildability() (expansion.ts)
// needs — buildBuildabilityQueryText() (from the opportunity's own
// fields plus 6a's technical_requirements finding, if it's run yet)
// and buildBuildabilityCatalog() (SEED_ROWS + this agent's own skills)
// — and persists whatever it returns. Always 200: `flagged: true` is a
// normal, expected result (6c's own "flag, don't block"), not an
// error condition this route treats specially.
router.post("/opportunities/:id/research/check-buildability", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see getOpportunityDetail()'s and
      // /opportunities/:id/status's identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    // 6a may or may not have run yet on this opportunity —
    // buildBuildabilityQueryText() handles an undefined
    // technicalRequirements gracefully (see its own doc comment), so
    // this route never blocks on 6a's ordering the way 6d's merged
    // report will eventually depend on 6a-6c all having landed.
    const currentResearch = getCurrentResearchFinding(id);
    const technicalRequirements = (currentResearch?.findings as
      | { technical_requirements?: TechnicalRequirementsAssessment }
      | undefined)?.technical_requirements;

    const queryText = buildBuildabilityQueryText(opportunity, technicalRequirements);
    const catalog = buildBuildabilityCatalog(agentAddress);
    const { matches, flagged } = checkBuildability(queryText, catalog);

    const finding = recordBuildabilityAssessment(id, {
      matches,
      flagged,
      threshold: config.buildabilityMatchThreshold,
      assessedAt: Date.now(),
    });

    res.json({ opportunityId: id, matches, flagged, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 6d: POST /expansion/opportunities/:id/research/score-risk ────
//
// Tool surface for 6d's risk-scoring consolidation — Zent.md: "risk
// scoring merged into research_findings alongside the market data."
// Same ownership-check shape as every Phase 5/6 route above; no search,
// no request body beyond agentAddress (like 6b, this is a deterministic
// read-and-compute over whatever 6b/6c already recorded, not a new
// external call) — this route is a thin wrapper around
// computeAndRecordResearchRiskScoring() (expansion.ts), which owns
// both reading the current finding and merging the consolidated
// verdict back onto it. Always 200: an "unknown" or "high" overall
// level is exactly as valid a result as "low" (6c's own "flag, don't
// block" posture, extended to 6d) — Research's own report (7a) is
// where a high risk_scoring becomes visible to Finance/Strategy/the
// CEO, never a reason for this call itself to fail.
router.post("/opportunities/:id/research/score-risk", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see the identical dangling-report_id
      // guard on every other Phase 5/6 route in this file.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const finding = computeAndRecordResearchRiskScoring(id);
    // Cheap, load-bearing invariant check, not decoration: proves 6d's
    // own "one report per opportunity, not two" on every call, in the
    // same live path Phase 20a's eventual end-to-end test will also
    // exercise, rather than only asserting it in a comment.
    const currentReportCount = countCurrentResearchFindings(id);

    res.json({
      opportunityId: id,
      riskScoring: (finding.findings as { risk_scoring?: unknown }).risk_scoring,
      finding,
      currentReportCount,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 5e: POST /expansion/opportunities/:id/research/report-confidence ──
//
// Tool surface for report_research_confidence(opportunity_id,
// confidence) — Zent.md 5e: "every research_findings row carries a
// self-reported confidence (low/med/high) plus the sources it used."
// Unlike 5b/5c/5d, this route runs no search at all — it takes the
// caller's confidence level, computes `sources` itself from whatever
// market_size/competition/customer_segments results already sit on the
// current finding (collectCurrentResearchSources(), see that
// function's own docstring in expansion.ts for why sources are
// computed rather than accepted as free-text input), and writes both
// onto a fresh version. Same ownership check every other Phase 5 route
// here uses.
//
// Phase 6e note: the `confidence` this route echoes back is the
// EFFECTIVE value recordResearchConfidence() persisted — which may be
// lower than the caller's own request-body value if 6e's weighting
// capped it against a 6b high-regulatory-risk flag. `selfReportedConfidence`
// is only present in the response when that capping actually happened,
// so a caller can tell "you asked for high, this is what got recorded"
// apart from the normal case where they're identical.
router.post("/opportunities/:id/research/report-confidence", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, confidence } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (!isValidResearchConfidence(confidence)) {
      return res.status(400).json({ error: "confidence must be one of: low, med, high" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see getOpportunityDetail()'s and
      // /opportunities/:id/status's identical dangling-report_id guard.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const finding = recordResearchConfidence(id, confidence);
    const effectiveConfidence = (finding.findings as { confidence?: unknown }).confidence;
    const selfReportedConfidence = (finding.findings as { selfReportedConfidence?: unknown })
      .selfReportedConfidence;

    res.json({
      opportunityId: id,
      confidence: effectiveConfidence,
      // null (not capped) is the normal case and stays out of the
      // response body entirely — only a real capped self-report is
      // worth a caller's attention.
      ...(selfReportedConfidence != null ? { selfReportedConfidence } : {}),
      sources: finding.findings.sources,
      finding,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 7a/7b: POST /expansion/opportunities/:id/research/compile-report ──
//
// Tool surface for compile_research_report(opportunity_id) — Zent.md
// 7a: "assembles 5b–6d into the single structured report the committee
// will read." Same ownership-check shape as every Phase 5/6 route
// above, but — like 6b/6d — no search and no request body beyond
// agentAddress: compileResearchReport() (expansion.ts) only reads
// whatever the current research finding already holds, it never calls
// out anywhere or asks the model to supply anything.
//
// Phase 7b ("report schema locked down") needs no separate wiring here:
// compileResearchReport() itself now stamps every report with
// `schemaVersion` (RESEARCH_REPORT_SCHEMA_VERSION) and self-checks the
// result against validateResearchReportShape() before ever returning —
// so by the time this route JSON-serializes the response, the object
// has already been verified to have exactly the locked field set, not
// "probably does because the TypeScript compiled." A caller that wants
// to re-verify a report it received over HTTP (rather than trusting
// this route did it) can run the same validateResearchReportShape()
// against the parsed JSON — same pure, DB-free function either way.
//
// Always 200: an opportunity with none of 5b-6d run yet compiles to a
// report that's all-null sections and an empty sources list rather than
// an error — same "not a reason for this call to fail" posture 6d's own
// route comment gives "unknown"/"high" risk levels. The one real error
// case is an unknown opportunity_id, which compileResearchReport()
// itself throws on (as would, in principle, a schema-shape violation —
// see that function's own header) and the catch block below turns into
// its normal 404/500 response the same way every other route in this
// file does.
//
// Deliberately doesn't merge anything back onto research_findings (see
// compileResearchReport()'s own header) — this route is read-only
// against the DB even though it's a POST, matching the tool-call shape
// Phase 5/6's own routes use (department calls a named tool with
// opportunity_id, gets a response) rather than REST GET semantics; 7c's
// eventual GET /expansion/opportunities/:id/research is the plain-read
// counterpart for anyone (Finance, Strategy, the CEO gate, a UI) that
// wants the same compiled shape without calling it as a tool.
router.post("/opportunities/:id/research/compile-report", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see the identical dangling-report_id
      // guard on every other Phase 5/6 route in this file.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    // Compile + Phase 7b shape re-check + response body: shared with
    // 7c's plain GET below via sendCompiledResearchReport(), so the two
    // routes can never quietly diverge on what "the research report for
    // this opportunity" actually contains. This route's own job above
    // this point — id shape, agentAddress presence, existence, then
    // ownership, in that order — is what makes it a *tool* call a
    // specific department makes about *its own* opportunity, versus
    // 7c's unauthenticated-beyond-BACKEND_API_KEY read.
    sendCompiledResearchReport(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 7c: GET /expansion/opportunities/:id/research ────────────────
//
// Zent.md 7c: "GET /expansion/opportunities/:id/research endpoint." The
// plain-read counterpart to the compile-report tool route just above —
// same compileResearchReport() + validateResearchReportShape() pair,
// same response shape, but GET semantics (no request body, no
// agentAddress, nothing written or re-computed as a side effect beyond
// what compileResearchReport() itself already does — which is nothing;
// see that function's own header) rather than a POST tool call a
// department invokes mid-pass.
//
// No ownership check here, deliberately matching 4b's own
// handleOpportunityDetail() (GET /opportunities/:id) rather than 5b-7a's
// write routes: every GET route in this file that takes a bare
// opportunity id is a read of already-public-within-the-pipeline data,
// gated only by the shared BACKEND_API_KEY middleware every route in
// this router already sits behind (this file's own header) — not a
// second, route-specific agentAddress-must-match check the way every
// *write* route (5b through 7a's compile-report) enforces. Finance,
// Strategy, and the CEO gate (Phase 8+, not built yet) all need to read
// a sibling department's research report about the same opportunity
// they're now working, and none of them "own" that report the way the
// research department that filed it did — this is exactly the kind of
// cross-department read 7c exists to serve, so gating it behind the
// filing department's own agentAddress would break the pipeline it's
// meant to feed.
router.get("/opportunities/:id/research", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    sendCompiledResearchReport(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 7a/7c shared response tail ────────────────────────────────
//
// Everything both the compile-report POST route and 7c's GET route do
// once they've each finished their own (different) authorization check
// and confirmed the opportunity exists: compile the report, re-verify
// it against 7b's locked shape at the actual HTTP boundary (not just
// trusting that compileResearchReport()'s own internal self-check
// already ran), and send the same {opportunityId, schemaVersion,
// researchReport} body. Factored into one function specifically so a
// future change to what a research-report response contains — an added
// top-level field, a different not-found/failure message — only has to
// happen once for both routes to pick it up, rather than the tool-call
// and plain-read surfaces silently drifting from each other the same
// way 7b's own header worries about the *report's own* shape drifting.
//
// In practice the 7b re-check here can only ever pass —
// compileResearchReport() already throws first if it wouldn't (see that
// function's own header) — so this is the same "load-bearing invariant
// check, not decoration" posture 6d's own route takes with
// countCurrentResearchFindings(), not a real failure path either route
// expects to hit.
function sendCompiledResearchReport(id: string, res: express.Response) {
  const researchReport = compileResearchReport(id);

  const shapeCheck = validateResearchReportShape(researchReport);
  if (!shapeCheck.valid) {
    res.status(500).json({
      error: `compiled research report failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
    });
    return;
  }

  res.json({
    opportunityId: id,
    schemaVersion: RESEARCH_REPORT_SCHEMA_VERSION,
    researchReport,
  });
}

// ─── Phase 8b: POST /expansion/opportunities/:id/finance/estimate-build-cost ──
//
// Tool surface for estimate_build_cost(opportunity_id) — Zent.md 8b.
// Ownership check mirrors every Phase 5 write route above (opportunity
// -> its report -> report.agent_address must equal the caller's
// agentAddress): Finance is modeling what THIS specific top-level
// agent's own expansion would cost, using that same agent's own real
// spend history, so a different agent's agentAddress can neither read
// nor write against an opportunity it doesn't own.
//
// Gated on 8a's own eligibility chain having already passed at spawn
// time (opportunity selected + a completed research finding exists —
// see departments.ts's POST / finance guard) — this route itself
// doesn't re-check that a finance department is actually running,
// same posture 5b's own route takes toward 5a's research-department
// spawn gate: the tool call trusts that spawning got this far, and
// re-derives nothing about department lifecycle here.
router.post("/opportunities/:id/finance/estimate-build-cost", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    const { finding, estimate } = recordBuildCostEstimate(id, agentAddress);
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, estimate, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 8c: POST /expansion/opportunities/:id/finance/estimate-time-to-revenue ──
//
// Tool surface for estimate_time_to_revenue(opportunity_id) — Zent.md
// 8c. Structurally identical to 8b's route just above: same ownership
// chain (opportunity -> its report -> report.agent_address must equal
// the caller's agentAddress), same "trusts 8a's spawn-time eligibility
// gate already ran, re-derives nothing about department lifecycle
// here" posture. The only things that differ are which history table
// gets read (sub_agents instead of department_spend_log) and which
// recordX()/response key gets used.
router.post("/opportunities/:id/finance/estimate-time-to-revenue", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    const { finding, estimate } = recordTimeToRevenueEstimate(id, agentAddress);
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, estimate, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 8d: POST /expansion/opportunities/:id/finance/check-available-capital ──
//
// Tool surface for check_available_capital(agentAddress) — Zent.md 8d.
// Same ownership chain every Phase 5/8 write route in this file
// enforces. Unlike 8b/8c, the real-world read here is an on-chain
// balance query (wallet.ts's getUsdcBalance()) rather than a SQLite
// read — see expansion.ts's own Phase 8d header for why that split
// exists (Phase 2e's isEligibleForExpansion() already flagged this as
// the one enrichment that belongs at the chain, not the ledger). This
// route does both real-world reads (chain balance + usage_log spend
// window) and hands the resolved numbers to computeAvailableCapital(),
// same "route resolves the input, expansion.ts turns it into a
// finding" split every other Phase 5/8 tool route already follows.
router.post("/opportunities/:id/finance/check-available-capital", async (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    let walletBalanceUsdc: number;
    try {
      walletBalanceUsdc = await getUsdcBalance(agentAddress as `0x${string}`);
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `check_available_capital failed to read on-chain balance: ${err?.message || "unknown error"}` });
    }

    const windowDays = 30;
    const totalSpendInWindowUsdc = getRecentSpendUsdc(agentAddress, windowDays);
    const spendRows = getRecentSpendRows(agentAddress, windowDays);
    const check = computeAvailableCapital(walletBalanceUsdc, totalSpendInWindowUsdc, windowDays);
    const finding = recordAvailableCapitalCheck(id, check, agentAddress, spendRows);
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, check, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 8e: POST /expansion/opportunities/:id/finance/check-runway ──
//
// Tool surface for Zent.md 8e's runway rule. Same ownership chain and
// on-chain-balance-plus-usage_log-window read 8d's route just above
// already does. proposedFundingUsdc is the one new caller-supplied
// input — Finance's own sizing recommendation doesn't exist until
// Phase 9b, so this route takes a candidate funding amount rather than
// deriving one.
//
// "Hard floor, not advisory" per Zent.md 8e: this route reports
// `check.passes === false` when the floor isn't met — it does not
// itself reject, block, or short-circuit anything. Phase 10b is where
// a `false` here starts actually stopping the pipeline (Finance's own
// early-exit reject path); this route's only job is to produce the
// number and the boolean truthfully.
router.post("/opportunities/:id/finance/check-runway", async (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, proposedFundingUsdc } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (
      typeof proposedFundingUsdc !== "number" ||
      !Number.isFinite(proposedFundingUsdc) ||
      proposedFundingUsdc < 0
    ) {
      return res.status(400).json({ error: "proposedFundingUsdc must be a non-negative number" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    let walletBalanceUsdc: number;
    try {
      walletBalanceUsdc = await getUsdcBalance(agentAddress as `0x${string}`);
    } catch (err: any) {
      return res
        .status(502)
        .json({ error: `check_runway failed to read on-chain balance: ${err?.message || "unknown error"}` });
    }

    const windowDays = 30;
    const totalSpendInWindowUsdc = getRecentSpendUsdc(agentAddress, windowDays);
    const dailySpendRateUsdc = totalSpendInWindowUsdc / windowDays;
    const check = computeRunwayCheck(walletBalanceUsdc, dailySpendRateUsdc, proposedFundingUsdc);
    const finding = recordRunwayCheck(id, check);
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, check, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 10b: POST /expansion/opportunities/:id/finance/reject-for-failed-runway ──
//
// Zent.md 10b: "Hard reject path: if 8e's runway floor fails, Finance
// can reject an opportunity outright without needing Strategy or the
// CEO — document this as an allowed early-exit, not a bug."
//
// Same ownership chain every Phase 8/9 write route in this file already
// enforces (id shape -> opportunity exists -> owning report's
// agentAddress matches the caller). Once that passes, the actual
// gate/transition is entirely rejectForFailedRunway()'s job
// (expansion.ts): it re-reads 8e's own last-recorded runway_check
// finding (not a value trusted from the request body — this route
// takes no body fields beyond agentAddress, deliberately, so a caller
// can't hard-reject on a number it just made up), requires that check
// to exist and to have failed, then calls the same
// setOpportunityStatus(id, 'reject') data-layer mutation Phase 4c's
// operator-facing action already uses.
//
// No Strategy read, no committee packet, no CEO decide_expansion call
// anywhere in this path — that omission IS the "without needing
// Strategy or the CEO" the phase spec calls for, not a shortcut this
// route is taking. A caller that reaches for this route without 8e
// having failed yet gets 409, same "well-formed request, wrong current
// state" convention 4c's own status route already uses for an invalid
// transition — this is Finance's own version of that, one level more
// specific than a generic reject.
router.post("/opportunities/:id/finance/reject-for-failed-runway", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    let result;
    try {
      result = rejectForFailedRunway(id);
    } catch (err: any) {
      return res.status(409).json({ error: err.message || "cannot hard-reject this opportunity" });
    }

    res.json({
      opportunityId: id,
      opportunity: result.opportunity,
      finding: result.finding,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 9a: POST /expansion/opportunities/:id/finance/estimate-worst-case-loss ──
//
// Tool surface for estimate_worst_case_loss(opportunity_id) — Zent.md
// 9a. Same ownership chain every Phase 5/8/9 write route in this file
// enforces. Unlike 8b/8c/8d/8e, this route makes no real-world read of
// its own (no wallet call, no usage_log query) — its one real input is
// this opportunity's own already-recorded `build_cost` finding from
// 8b, read inside recordWorstCaseLossEstimate() itself. If 8b hasn't
// run yet, that function throws MissingBuildCostEstimateError (status
// 409), caught by this route's own generic `err.status || 500`
// handler like every other Phase 5/8/9 route already does — no
// route-local special case needed.
router.post("/opportunities/:id/finance/estimate-worst-case-loss", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    const { finding, estimate } = recordWorstCaseLossEstimate(id);
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, estimate, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 9b: POST /expansion/opportunities/:id/finance/recommend-sizing ──
//
// Tool surface for Finance's sizing recommendation — Zent.md 9b. Same
// ownership chain every Phase 5/8/9 write route in this file enforces.
// Like 9a, this route makes no real-world read of its own — its two
// real inputs are this opportunity's own already-recorded `build_cost`
// (8b) and `available_capital` (8d) findings, read inside
// recordSizingRecommendation() itself. If either hasn't run yet, that
// function throws MissingFinancePrerequisitesError (status 409),
// caught by this route's own generic `err.status || 500` handler like
// every other Phase 5/8/9 route already does — no route-local special
// case needed.
//
// alreadyCommittedTodayUsdc is the one optional caller-supplied input:
// expansion.ts's own Phase 9b header explains why it isn't derived here
// (no Phase-16 disbursement history exists yet to query) — omitted, it
// defaults to 0, same as calling computeSizingRecommendation() directly
// with nothing known about same-day commitments.
router.post("/opportunities/:id/finance/recommend-sizing", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, alreadyCommittedTodayUsdc } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (
      alreadyCommittedTodayUsdc !== undefined &&
      (typeof alreadyCommittedTodayUsdc !== "number" ||
        !Number.isFinite(alreadyCommittedTodayUsdc) ||
        alreadyCommittedTodayUsdc < 0)
    ) {
      return res
        .status(400)
        .json({ error: "alreadyCommittedTodayUsdc must be a non-negative number when provided" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    const { finding, recommendation } = recordSizingRecommendation(
      id,
      alreadyCommittedTodayUsdc ?? 0,
    );
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, recommendation, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 9c: POST /expansion/opportunities/:id/finance/propose-staged-funding ──
//
// Tool surface for Finance's staged-funding option — Zent.md 9c. Same
// ownership chain every Phase 5/8/9 write route in this file enforces.
// Like 9a/9b, this route makes no real-world read of its own — its one
// real input is this opportunity's own already-recorded
// `sizing_recommendation` finding from 9b, read inside
// recordStagedFundingOption() itself. If 9b hasn't run yet, that
// function throws MissingSizingRecommendationError (status 409),
// caught by this route's own generic `err.status || 500` handler like
// every other Phase 5/8/9 route already does — no route-local special
// case needed.
//
// No caller-supplied body beyond agentAddress: unlike 9b's
// alreadyCommittedTodayUsdc, everything computeStagedFundingOption()
// needs either lives on 9b's own finding or defaults from
// config.stagedFundingInitialFraction — see expansion.ts's own Phase 9c
// header for why a real per-opportunity fraction isn't exposed here
// (it's a documented assumption, not a derived number, same posture
// 8b's own ASSUMED_DEPARTMENTS_FOR_MVP already takes).
router.post("/opportunities/:id/finance/propose-staged-funding", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    const { finding, option } = recordStagedFundingOption(id);
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, option, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 9d: POST /expansion/opportunities/:id/finance/note-sensitivity ──
//
// Tool surface for Finance's sensitivity note — Zent.md 9d. Same
// ownership chain every Phase 5/8/9 write route in this file enforces.
// Like 9a/9c, this route makes no real-world read of its own — its four
// real inputs are this opportunity's own already-recorded `build_cost`
// (8b), `time_to_revenue` (8c), `available_capital` (8d), and
// `sizing_recommendation` (9b) findings, read inside
// recordSensitivityNote() itself. If any hasn't run yet, that function
// throws MissingSensitivityPrerequisitesError (status 409), caught by
// this route's own generic `err.status || 500` handler like every other
// Phase 5/8/9 route already does — no route-local special case needed.
//
// stressFraction is the one optional caller-supplied input, same
// "override the documented default, don't require it" posture 9b's own
// alreadyCommittedTodayUsdc already takes — omitted, it defaults to
// expansion.ts's own SENSITIVITY_STRESS_FRACTION.
router.post("/opportunities/:id/finance/note-sensitivity", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, stressFraction } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (
      stressFraction !== undefined &&
      (typeof stressFraction !== "number" ||
        !Number.isFinite(stressFraction) ||
        stressFraction <= 0 ||
        stressFraction >= 1)
    ) {
      return res
        .status(400)
        .json({ error: "stressFraction must be a number strictly between 0 and 1 when provided" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    if (!hasFinanceTickCapacity(agentAddress)) {
      return res.status(429).json({
        error: "daily_finance_tick_limit_reached",
        limit: config.maxFinanceTicksPerAgentPerDay,
      });
    }

    const { finding, note } = recordSensitivityNote(id, stressFraction);
    recordFinanceTick(agentAddress);

    res.json({ opportunityId: id, note, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 9e: POST /expansion/opportunities/:id/finance/compile-report ──
//
// Tool surface for compile_finance_report(opportunity_id) — Zent.md 9e:
// "one structured report, same discipline as 7a." Same shape as 7a's
// own compile-report route: ownership-check chain identical to every
// Phase 8/9 write route above, but no search and no request body beyond
// agentAddress — compileFinanceReport() (expansion.ts) only reads
// whatever the current finance finding already holds.
//
// Always 200: an opportunity with none of 8b–9d run yet compiles to a
// report that's all-null sections rather than an error — same "not a
// reason for this call to fail" posture 7a's own route takes. The one
// real error case is an unknown opportunity_id, which
// compileFinanceReport() itself throws on, caught by this route's own
// generic `err.status || 500` handler like every other route here.
//
// Deliberately doesn't merge anything back onto finance_findings (see
// compileFinanceReport()'s own header) — this route is read-only
// against the DB even though it's a POST, matching the tool-call shape
// every Phase 8/9 route above uses. Phase 10a's eventual GET
// /expansion/opportunities/:id/finance is the plain-read counterpart
// for Strategy/the CEO gate/a UI that wants the same compiled shape
// without calling it as a tool — not built here, out of this phase's
// scope (Zent.md 9e is the compile tool only; 10a is its own phase).
router.post("/opportunities/:id/finance/compile-report", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const financeReport = compileFinanceReport(id);

    // Re-verify at the actual HTTP boundary rather than just trusting
    // compileFinanceReport()'s own internal self-check already ran —
    // same belt-and-suspenders posture sendCompiledResearchReport()
    // takes for 7a/7c. Can only ever pass in practice; not decoration.
    const shapeCheck = validateFinanceReportShape(financeReport);
    if (!shapeCheck.valid) {
      return res.status(500).json({
        error: `compiled finance report failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
      });
    }

    res.json({ opportunityId: id, schemaVersion: FINANCE_REPORT_SCHEMA_VERSION, financeReport });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 10a: GET /expansion/opportunities/:id/finance ────────────────
//
// Zent.md 10a: "GET /expansion/opportunities/:id/finance endpoint." The
// plain-read counterpart to 9e's compile-report tool route just above —
// same compileFinanceReport() + validateFinanceReportShape() pair, same
// response shape, but GET semantics (no request body, no agentAddress,
// nothing written or re-computed beyond what compileFinanceReport()
// itself already does — which is nothing) rather than a POST tool call
// a department invokes mid-pass. This is the exact GET/POST split 7c
// already established for research; this route is its finance mirror,
// down to the ownership posture: no agentAddress ownership check here,
// deliberately matching 7c and 4b's own handleOpportunityDetail() rather
// than 8a-9e's write routes. Strategy (Phase 11) and the CEO gate
// (Phase 15) both need to read Finance's report about an opportunity
// they don't themselves own the finance_findings row for, and the
// Committee packet (Phase 13) reads all three departments' reports the
// same way — gating this behind the filing Finance department's own
// agentAddress would break exactly the cross-department read this phase
// exists to serve. Still sits behind this router's shared
// BACKEND_API_KEY middleware like every route in this file.
router.get("/opportunities/:id/finance", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    sendCompiledFinanceReport(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 9e/10a shared response tail ───────────────────────────────
//
// Same factoring reason as sendCompiledResearchReport() above: the
// compile-report POST route and 10a's GET route each finish their own
// (different) authorization check and confirm the opportunity exists,
// then both need the identical "compile, re-verify against the locked
// shape at the HTTP boundary, send the same body" tail. Factored once so
// a future change to what a finance-report response contains only has
// to happen here. The re-check below can only ever pass in practice —
// compileFinanceReport() already throws first if it wouldn't — same
// belt-and-suspenders posture as the research pair, not a real failure
// path either route expects to hit.
function sendCompiledFinanceReport(id: string, res: express.Response) {
  const financeReport = compileFinanceReport(id);

  const shapeCheck = validateFinanceReportShape(financeReport);
  if (!shapeCheck.valid) {
    res.status(500).json({
      error: `compiled finance report failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
    });
    return;
  }

  res.json({
    opportunityId: id,
    schemaVersion: FINANCE_REPORT_SCHEMA_VERSION,
    financeReport,
  });
}

// ─── Phase 10d: GET /expansion/opportunities/:id/finance/audit-log ────
//
// Zent.md 10d: "Audit log: every number Finance produces is traceable
// to the wallet/spend query that generated it — no hand-waved
// figures." Plain read over finance_audit_log (expansion.ts's own
// getFinanceAuditLog()) — every row Finance has ever recorded for this
// opportunity, oldest first, across every metric and every re-run.
//
// Same no-ownership-check posture 10a's own GET /finance route takes:
// Strategy, the CEO gate, and the eventual Committee packet (Phase 13)
// all need to be able to inspect WHY a Finance number is what it is,
// not just what it is, and none of them own the finance_findings row
// this trail explains. Still sits behind this router's shared
// BACKEND_API_KEY middleware like every route in this file.
router.get("/opportunities/:id/finance/audit-log", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const auditLog = getFinanceAuditLog(id);
    res.json({ opportunityId: id, auditLog });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 4d: GET /expansion/notifications/:agentAddress ─────────────
//
// Read surface for the notification hook above — every
// expansion_notifications row filed for this agent, most-recent-first,
// including whether it was actually delivered to the agent's own
// inbox. Same posture as 4a/4b's own read routes: no request body,
// no ownership check beyond the shared BACKEND_API_KEY middleware
// already sitting in front of this whole router — this is an
// operational read a department or the top-level agent's own runtime
// can use to confirm what's already been recorded, not a step anyone
// needs to pass through to get here.
router.get("/notifications/:agentAddress", (req, res) => {
  try {
    const { agentAddress } = req.params;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const { limit } = req.query;
    let parsedLimit = 50;
    if (limit !== undefined) {
      parsedLimit = Number(limit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
        return res.status(400).json({ error: "limit must be a positive integer" });
      }
    }

    const notifications = listExpansionNotificationsForAgent(agentAddress, parsedLimit);
    res.json({ agentAddress, notifications });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11b: GET /expansion/companies/:rootAgentAddress ─────────────
//
// Tool surface for Zent.md 11b's list_existing_companies(rootAgentAddress)
// — every already-spawned sibling of rootAgentAddress (agents.parent_
// address = rootAgentAddress), each with its mission when one can
// honestly be resolved (see listExistingCompanies()'s own header in
// expansion.ts for what "mission" means before Phase 17c exists). A
// plain read with no side effects, so this takes the same posture the
// notifications route just above and wallet.ts's own GET /:address/
// lineage already take: no request body, no ownership check beyond the
// shared BACKEND_API_KEY middleware in front of this whole router.
router.get("/companies/:rootAgentAddress", (req, res) => {
  try {
    const { rootAgentAddress } = req.params;
    if (!rootAgentAddress) {
      return res.status(400).json({ error: "rootAgentAddress is required" });
    }
    const companies = listExistingCompanies(rootAgentAddress);
    res.json({ rootAgentAddress, companies });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11c: GET /expansion/opportunities/:id/mission-overlap ───────
//
// Tool surface for Zent.md 11c's check_mission_overlap(opportunity_id)
// — every already-spawned sibling (11b's own portfolio read) that this
// opportunity duplicates, competes with, or complements, per
// checkMissionOverlap()'s own header in expansion.ts for exactly how
// those three labels are decided. Same posture as 11b's route just
// above and 3c's own dedup-history route: a plain read with no side
// effects, no request body, no ownership check beyond the shared
// BACKEND_API_KEY middleware this whole router already sits behind.
router.get("/opportunities/:id/mission-overlap", (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "opportunity id is required" });
    }
    const overlap = checkMissionOverlap(id);
    res.json({ opportunityId: id, overlap });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11d: GET /expansion/opportunities/:id/technology-reuse ──────
//
// Tool surface for Zent.md 11d's check_technology_reuse(opportunity_id)
// — for every already-spawned sibling 11b/11c already resolve a
// mission for, how much of that sibling's own skill catalog this
// opportunity's query text matches, per checkTechnologyReuse()'s own
// header in expansion.ts for exactly what "reuse" means here and why
// it's skills-only, not tool_registry rows. Same posture as 11b/11c's
// routes just above: a plain read with no side effects, no request
// body, no ownership check beyond the shared BACKEND_API_KEY
// middleware this whole router already sits behind.
router.get("/opportunities/:id/technology-reuse", (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "opportunity id is required" });
    }
    const reuse = checkTechnologyReuse(id);
    res.json({ opportunityId: id, reuse });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11e-ii-b: POST .../strategy/check-mission-overlap ───────────
// ─── Phase 11e-ii-b: POST .../strategy/check-technology-reuse ──────────
//
// Tool surface for the persisting wrappers 11e-ii-b's guard needs —
// recordMissionOverlapCheck()/recordTechnologyReuseCheck() in
// expansion.ts. The GET /mission-overlap and /technology-reuse routes
// just above stay exactly as they were (11b/11c/11d's own plain reads,
// no side effects, unchanged); these are new, additive POST routes that
// file the SAME underlying check onto the opportunity's current
// strategy_findings row, under `mission_overlap`/`technology_reuse` —
// exactly what score_strategy_fit's own 11e-ii-b guard checks for. Same
// ownership chain every Phase 5/8/9 write route in this file enforces.
router.post("/opportunities/:id/strategy/check-mission-overlap", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const { finding, record } = recordMissionOverlapCheck(id);
    res.json({ opportunityId: id, record, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.post("/opportunities/:id/strategy/check-technology-reuse", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const { finding, record } = recordTechnologyReuseCheck(id);
    res.json({ opportunityId: id, record, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11e-ii-a/b: POST /expansion/opportunities/:id/strategy/score-fit ──
//
// Tool surface for Zent.md 11e-ii-a's score_strategy_fit(opportunity_id)
// — the first write route strategy_findings ever gets in this file (the
// GET /mission-overlap and /technology-reuse routes above are plain
// reads with no persistence of their own). Same ownership chain every
// Phase 5/8/9 write route in this file already enforces: agentAddress
// must match the top-level agent that owns the opportunity's own
// report.
//
// 11e-ii-b's guard lives inside scoreStrategyFit() itself, not this
// route: a caller who hasn't first called check-mission-overlap and
// check-technology-reuse (just above) gets
// MissingStrategyFitPrerequisitesError, its own .status=409 — which is
// why the inner catch below keys off `err.status || 400` rather than a
// hardcoded 400, the same `err.status || 500` pattern this file's outer
// catches already use, just defaulting to 400 (bad input) instead of
// 500 for the one case here that isn't a missing prerequisite:
// validateFitScoreFactors()'s own plain Error when a caller-supplied
// options value is out of range.
//
// ecosystemDiversificationValue/marketIndependence are the two optional,
// caller-supplied inputs expansion.ts's own ScoreStrategyFitOptions
// documents — Phase 12 territory with no computation to derive them
// from yet, so a caller either supplies real numbers or accepts the
// honest 0 "no signal yet" default scoreStrategyFit() itself applies.
//
// Deliberately no tick-capacity check here the way hasFinanceTickCapacity
// gates every Finance write route: no equivalent per-strategy-tick
// limiter exists anywhere in resourceQuotas.ts/config.ts yet. Adding one
// would be scope creep beyond this tool — this route relies on the
// department's own spend_cap_daily_usdc (set at spawn time, same as
// every other department type) for now.
router.post("/opportunities/:id/strategy/score-fit", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, ecosystemDiversificationValue, marketIndependence } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    for (const [key, value] of [
      ["ecosystemDiversificationValue", ecosystemDiversificationValue],
      ["marketIndependence", marketIndependence],
    ] as const) {
      if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
        return res.status(400).json({ error: `${key} must be a finite number between 0 and 100 when provided` });
      }
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    let result;
    try {
      result = scoreStrategyFit(id, { ecosystemDiversificationValue, marketIndependence });
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message || "invalid fit score factors" });
    }

    res.json({
      opportunityId: id,
      fitScore: result.fitScore,
      missionOverlap: result.missionOverlap,
      technologyReuse: result.technologyReuse,
      finding: result.finding,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11e-iii-b: POST /expansion/opportunities/:id/strategy/compile-report ──
//
// Tool surface for Zent.md 11e-iii-b/12d's compile_strategy_report
// (opportunity_id) — same "tool-call shape, department calls a named
// tool with opportunity_id, gets a response" posture 7a's own route
// takes for Research (see that route's own header). As of 12d, the
// compiled report's seven sections span all of Strategy's tools to
// date: 11c/11d's mission-overlap and technology-reuse checks, 11e's
// fit_score + fit_roi_divergence, and 12a/12b/12c's ecosystem-
// strengthening, cannibalization, and relationship-type sections (see
// compileStrategyReport()'s own header in expansion.ts).
//
// Always 200: an opportunity with none of Strategy's tools run yet
// compiles to a report that's all-null sections rather than an
// error — same posture 7a's own route takes toward an unstarted
// Research pass. The one real error case is an unknown opportunity_id,
// which compileStrategyReport() itself throws on, turned into this
// route's normal 404/500 response the same way every other route here
// does.
//
// Deliberately doesn't merge anything back onto strategy_findings (see
// compileStrategyReport()'s own header) — read-only against the DB even
// though it's a POST, matching 7a's own tool-call shape rather than REST
// GET semantics; the GET route just below is the plain-read counterpart
// for anyone (the committee packet, a UI) that wants the same compiled
// shape without calling it as a tool.
router.post("/opportunities/:id/strategy/compile-report", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice — see the identical dangling-report_id
      // guard on every other Phase 5/8/11 route in this file.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    sendCompiledStrategyReport(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11e-iii-c: GET /expansion/opportunities/:id/strategy ────────
//
// Zent.md 11e-iii-c: "GET /expansion/opportunities/:id/strategy (12e)
// response includes fit_score and divergence status; its shape test is
// extended to assert both are present." Same plain-read posture 7c's
// own GET /research route takes for Research (see that route's own
// header): no request body, no agentAddress, nothing written or
// re-computed as a side effect, no ownership check beyond the shared
// BACKEND_API_KEY middleware this whole router already sits behind —
// Finance, the CEO gate, and the eventual committee packet (Phase 13)
// all need to read Strategy's report about an opportunity they're now
// working, and none of them "own" it the way the strategy department
// that filed it did.
router.get("/opportunities/:id/strategy", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    sendCompiledStrategyReport(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 11e-iii-b/c shared response tail ────────────────────────────
//
// Same role sendCompiledResearchReport() plays for 7a/7c: compile the
// report, re-verify it against its own locked shape at the HTTP
// boundary, and send one consistent body — {opportunityId,
// schemaVersion, strategyReport} — so the tool-call and plain-read
// surfaces can never quietly drift from each other. 11e-iii-c's own
// "fit_score and divergence status" requirement is satisfied by
// strategyReport.fitScore / strategyReport.fitRoiDivergence, both
// always present as top-level keys on this object (null until Strategy
// has run score_strategy_fit, present together once it has — see
// compileStrategyReport()'s own header) rather than nested inside
// findings prose.
function sendCompiledStrategyReport(id: string, res: express.Response) {
  const strategyReport = compileStrategyReport(id);

  const shapeCheck = validateStrategyReportShape(strategyReport);
  if (!shapeCheck.valid) {
    res.status(500).json({
      error: `compiled strategy report failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
    });
    return;
  }

  res.json({
    opportunityId: id,
    schemaVersion: STRATEGY_REPORT_SCHEMA_VERSION,
    strategyReport,
  });
}

// ─── Phase 12a: GET /expansion/opportunities/:id/ecosystem-strengthening ──
//
// Tool surface for Zent.md 12a's assess_ecosystem_strengthening
// (opportunity_id) — same plain-read posture the GET /mission-overlap
// and GET /technology-reuse routes (11c/11d) already take: no request
// body, no ownership check beyond the shared BACKEND_API_KEY middleware
// this whole router already sits behind. See assessEcosystemStrengthening()'s
// own header in expansion.ts for exactly how shared-customer/shared-infra
// evidence is derived from 11c/11d's own signals.
router.get("/opportunities/:id/ecosystem-strengthening", (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "opportunity id is required" });
    }
    const assessment = assessEcosystemStrengthening(id);
    res.json({ opportunityId: id, assessment });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 12a: POST .../strategy/assess-ecosystem-strengthening ───────
//
// Tool surface for the persisting wrapper —
// recordEcosystemStrengtheningAssessment() in expansion.ts — the write
// route an autonomous Strategy department actually calls to file its
// 12a pass onto strategy_findings under `ecosystem_strengthening`. Same
// ownership chain every Phase 5/8/11e-ii-b write route in this file
// enforces: agentAddress must match the top-level agent that owns the
// opportunity's own report, no operator step in between. The GET route
// just above is unaffected — it stays a pure read with no persistence
// of its own.
router.post("/opportunities/:id/strategy/assess-ecosystem-strengthening", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const { finding, record } = recordEcosystemStrengtheningAssessment(id);
    res.json({ opportunityId: id, record, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 12b: GET /expansion/opportunities/:id/cannibalization ───────
//
// Tool surface for Zent.md 12b's check_cannibalization(opportunity_id)
// — same plain-read posture the GET /mission-overlap, /technology-reuse,
// and /ecosystem-strengthening routes already take: no request body, no
// ownership check beyond the shared BACKEND_API_KEY middleware this
// whole router already sits behind. See checkCannibalization()'s own
// header in expansion.ts for exactly how the explicit yes/no is derived
// from 11c's own "duplicates"/"competes" labels.
router.get("/opportunities/:id/cannibalization", (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "opportunity id is required" });
    }
    const cannibalization = checkCannibalization(id);
    res.json({ opportunityId: id, cannibalization });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 12b: POST .../strategy/check-cannibalization ────────────────
//
// Tool surface for the persisting wrapper —
// recordCannibalizationCheck() in expansion.ts — the write route an
// autonomous Strategy department calls to file its 12b pass onto
// strategy_findings under `cannibalization_check`. Same ownership chain
// every Phase 5/8/11e-ii-b/12a write route in this file enforces:
// agentAddress must match the top-level agent that owns the
// opportunity's own report — no operator step, no approval gate, same
// as every other write route in this pipeline. The GET route just
// above is unaffected — it stays a pure read with no persistence.
router.post("/opportunities/:id/strategy/check-cannibalization", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const { finding, record } = recordCannibalizationCheck(id);
    res.json({ opportunityId: id, record, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 12c: GET /expansion/opportunities/:id/relationship-type ─────
//
// Tool surface for Zent.md 12c's recommend_relationship_type
// (opportunity_id) — same plain-read posture the GET
// /ecosystem-strengthening and /cannibalization routes (12a/12b) already
// take: no request body, no ownership check beyond the shared
// BACKEND_API_KEY middleware this whole router already sits behind. See
// recommendRelationshipType()'s own header in expansion.ts for exactly
// how the independent/supplier-to-sibling/shared-customer-base label is
// derived from 12a's and 12b's own signals.
router.get("/opportunities/:id/relationship-type", (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: "opportunity id is required" });
    }
    const recommendation = recommendRelationshipType(id);
    res.json({ opportunityId: id, recommendation });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 12c: POST .../strategy/recommend-relationship-type ──────────
//
// Tool surface for the persisting wrapper —
// recordRelationshipTypeRecommendation() in expansion.ts — the write
// route an autonomous Strategy department calls to file its 12c pass
// onto strategy_findings under `relationship_type_recommendation`. Same
// ownership chain every Phase 5/8/11e-ii-b/12a/12b write route in this
// file enforces: agentAddress must match the top-level agent that owns
// the opportunity's own report — no operator step, no approval gate,
// same as every other write route in this pipeline. The GET route just
// above is unaffected — it stays a pure read with no persistence of its
// own. Phase 16d reads this finding directly to scope Agent B's initial
// tool grants at genesis.
router.post("/opportunities/:id/strategy/recommend-relationship-type", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const { finding, record } = recordRelationshipTypeRecommendation(id);
    res.json({ opportunityId: id, record, finding });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 13d: GET /expansion/opportunities/:id/committee-packet ──────
//
// Zent.md 13d: "GET /expansion/opportunities/:id/committee-packet."
// Same plain-read posture 7c/10a/11e-iii-c's own GET /research,
// /finance, and /strategy routes already take (see 11e-iii-c's own
// route header just above for the fullest statement of that posture):
// no request body, no agentAddress, nothing written or re-computed as
// a side effect beyond the shared BACKEND_API_KEY middleware this whole
// router already sits behind. The CEO agent (Phase 15) is this route's
// main reader, but nothing here checks that the caller IS the CEO —
// same as the three per-department GET routes it bundles, ownership of
// *reading* a report isn't enforced the way ownership of *writing* one
// is throughout this file; ownership enforcement is Phase 15's own job,
// at the decide_expansion write route, not here.
//
// No completeness gate: this route deliberately keeps calling
// assembleCommitteePacket() directly rather than 13e's own
// requireCompleteCommitteePacket() — a known opportunity with some or
// all of Research/Finance/Strategy not yet run still returns 200 with a
// packet whose corresponding sections read back null (and whose new
// `completeness.complete` field reads back false, naming what's
// missing), exactly as if a caller had hit each of those three GET
// routes directly. Only an *unknown* opportunity_id is an error here
// (404), matching every other opportunity-scoped GET route in this
// file. Enforcing completeness is Phase 15's eventual decide_expansion
// route's job, via requireCompleteCommitteePacket() — this plain read
// stays plain.
router.get("/opportunities/:id/committee-packet", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    sendCommitteePacket(id, res);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 13d response tail ────────────────────────────────────────────
//
// Same role sendCompiledResearchReport()/sendCompiledStrategyReport()
// play for 7c/11e-iii-c: assemble the packet, re-verify it against its
// own locked shape at the HTTP boundary (assembleCommitteePacket()
// already self-checks internally — see that function's own header —
// but every GET route in this file re-checks its own compiled/assembled
// object a second time at the response boundary, the same belt-and-
// braces posture sendCompiledResearchReport()/sendCompiledFinanceReport()/
// sendCompiledStrategyReport() already take toward their own
// compile*Report() calls), and send one consistent body —
// {opportunityId, schemaVersion, packet} — so this route can never
// quietly drift from what assembleCommitteePacket() actually produces.
function sendCommitteePacket(id: string, res: express.Response) {
  const packet = assembleCommitteePacket(id);

  const shapeCheck = validateCommitteePacketShape(packet);
  if (!shapeCheck.valid) {
    res.status(500).json({
      error: `assembled committee packet failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
    });
    return;
  }

  res.json({
    opportunityId: id,
    schemaVersion: COMMITTEE_PACKET_SCHEMA_VERSION,
    packet,
  });
}

// ─── Phase 14a: per-agent deliberation config ──────────────────────────
//
// Zent.md 14a: "off by default, enabled per-agent config." There is no
// operator-facing settings surface anywhere in this pipeline (Zent.md's
// own closing note: "no human-in-the-loop step anywhere in this
// pipeline") — this route is the top-level agent's own way of flipping
// its config, called by the agent itself the same way every other
// write route in this file is, and gated the same way: the caller's
// agentAddress in the body IS the agent whose config is being set,
// there's no separate identity that could set it on another agent's
// behalf.
router.post("/agents/:agentAddress/deliberation-config", (req, res) => {
  try {
    const { agentAddress } = req.params;
    const { enabled } = req.body || {};
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    setDeliberationEnabled(agentAddress, enabled);
    res.json({ agentAddress, deliberationEnabled: isDeliberationEnabled(agentAddress) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.get("/agents/:agentAddress/deliberation-config", (req, res) => {
  try {
    const { agentAddress } = req.params;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    res.json({ agentAddress, deliberationEnabled: isDeliberationEnabled(agentAddress) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 19e: per-agent dry-run-mode config ───────────────────────────
//
// Zent.md 19e: "for testing the whole reasoning chain without actually
// spending funding." Same shape as the 14a deliberation-config pair
// immediately above — no operator-facing settings surface anywhere in
// this pipeline, this route is the top-level agent's own way of
// flipping its config, gated the same way: the caller's agentAddress in
// the URL IS the agent whose config is being set, there's no separate
// identity that could set it on another agent's behalf.
router.post("/agents/:agentAddress/dry-run-config", (req, res) => {
  try {
    const { agentAddress } = req.params;
    const { enabled } = req.body || {};
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }
    setDryRunModeEnabled(agentAddress, enabled);
    res.json({ agentAddress, dryRunModeEnabled: isDryRunModeEnabled(agentAddress) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.get("/agents/:agentAddress/dry-run-config", (req, res) => {
  try {
    const { agentAddress } = req.params;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    res.json({ agentAddress, dryRunModeEnabled: isDryRunModeEnabled(agentAddress) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 19e: reading back a produced dry-run packet ──────────────────
//
// GET .../opportunities/:id/dry-run-packet — the single packet for one
// opportunity, if its `approved` ruling was made under dry-run mode.
// GET .../agents/:agentAddress/dry-run-packets — every packet an agent
// has ever produced, most-recent-first; Zent.md 20d's staged-rollout use
// case ("dry-run mode only... before enabling real genesis") is
// reviewing this list before flipping the switch off. Both are reads,
// no ownership check, same public-within-the-shared-secret-perimeter
// posture the audit-bundle GET route below already takes.
router.get("/opportunities/:id/dry-run-packet", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (!getOpportunity(id)) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const packet = getDryRunGenesisPacket(id);
    if (!packet) {
      return res
        .status(404)
        .json({ error: `no dry-run genesis packet recorded for opportunity ${id}` });
    }
    res.json({ opportunityId: id, dryRunPacket: packet });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.get("/agents/:agentAddress/dry-run-packets", (req, res) => {
  try {
    const { agentAddress } = req.params;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    res.json({ agentAddress, dryRunPackets: listDryRunGenesisPackets(agentAddress) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 20d: staged rollout ───────────────────────────────────────
//
// Zent.md 20d: "Staged rollout: dry-run mode (19e) only, for the first
// real profitable agent in production, before enabling real genesis."
//
// GET .../rollout-status — read-only: current stage, plus the same
// eligibility snapshot checkRolloutGraduationEligibility() computes
// (dry-run packet count vs. the required minimum, circuit-breaker
// state, current profitability), so an agent (or anyone reviewing its
// history) can see exactly what's still missing without attempting the
// graduation call itself. Same "no ownership check on a read" posture
// the dry-run-packets GET route immediately above already takes.
//
// POST .../graduate — the one write in this pair, and the only way
// rollout_stage ever moves to 'live_enabled' anywhere in this codebase.
// Same "the caller's agentAddress in the URL IS the agent whose config
// is being set" self-only shape the dry-run-config POST route above
// uses — no separate identity can graduate another agent's pipeline on
// its behalf, and there is still no operator-facing path onto this
// pipeline anywhere else. graduateToLiveGenesis() (expansion.ts)
// re-verifies eligibility itself before writing anything, so this
// route is a thin call-and-report wrapper, not a second copy of the
// gate.
router.get("/agents/:agentAddress/rollout-status", (req, res) => {
  try {
    const { agentAddress } = req.params;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    res.json({
      agentAddress,
      rolloutStage: getRolloutStage(agentAddress),
      eligibility: checkRolloutGraduationEligibility(agentAddress),
      history: listRolloutGraduationEvents(agentAddress),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.post("/agents/:agentAddress/graduate", (req, res) => {
  try {
    const { agentAddress } = req.params;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    graduateToLiveGenesis(agentAddress);
    res.json({
      agentAddress,
      rolloutStage: getRolloutStage(agentAddress),
      history: listRolloutGraduationEvents(agentAddress),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 20e: post-launch review ──────────────────────────────────
//
// Zent.md 20e: "a scheduled review of whether the ROI/fit scores it
// was approved on actually held up — feeds back into tuning 3b's
// formula." schedulePostLaunchReview()/runDuePostLaunchReviews()
// (postLaunchReview.ts) already run on their own — the former at
// genesis activation, the latter on this file's own 6-hour sweep — so
// every route below is a read, plus one manual-trigger POST for
// operational visibility (e.g. forcing a sweep in a test/staging
// environment without waiting for the next scheduled tick). None of
// these gate or alter the pipeline itself.
router.get("/agents/:agentAddress/post-launch-review", (req, res) => {
  try {
    const { agentAddress } = req.params;
    if (!agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    const review = getPostLaunchReview(agentAddress);
    if (!review) {
      return res
        .status(404)
        .json({ error: `no post-launch review scheduled for agent ${agentAddress}` });
    }
    res.json({ agentAddress, review });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.get("/agents/:rootAgentAddress/post-launch-reviews", (req, res) => {
  try {
    const { rootAgentAddress } = req.params;
    if (!rootAgentAddress) {
      return res.status(400).json({ error: "rootAgentAddress is required" });
    }
    res.json({
      rootAgentAddress,
      reviews: listPostLaunchReviewsForRoot(rootAgentAddress),
      calibrationSummary: summarizeRoiCalibration(rootAgentAddress),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.get("/calibration-summary", (req, res) => {
  try {
    res.json(summarizeRoiCalibration());
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

router.post("/post-launch-reviews/run-due", (req, res) => {
  try {
    const completed = runDuePostLaunchReviews();
    res.json({ completed });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 14a: POST .../deliberation — a department's rebuttal/concur ──
//
// Tool surface for recordDeliberationResponse() — the write route a
// Research/Finance/Strategy department calls once it has read the
// committee packet (GET .../committee-packet, 13d) and wants to file
// its rebuttal or concurrence on the other two departments' reports.
// Same ownership chain every write route in this file enforces:
// agentAddress must match the top-level agent that owns the
// opportunity's own report — no operator step, matching every other
// write route in this pipeline (see Phase 12c's own route header just
// above for the fullest statement of that chain).
//
// Deliberately does NOT check isDeliberationEnabled() before accepting
// a response — same "the write primitive doesn't re-decide policy the
// read/gate layer already owns" reasoning recordDeliberationResponse()'s
// own header gives: a department that calls this while its agent has
// the pass turned off still gets a filed response back (harmless — it
// just won't be load-bearing for locking, since getDeliberationExchange()
// only surfaces `enabled: true` exchanges as gating anything).
router.post("/opportunities/:id/deliberation", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, department, position, responseText, respondingTo } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (!isValidDeliberationDepartment(department)) {
      return res.status(400).json({
        error: `department must be one of: ${DELIBERATION_DEPARTMENTS.join(", ")}`,
      });
    }
    if (!isValidDeliberationPosition(position)) {
      return res.status(400).json({ error: "position must be one of: concur, rebuttal" });
    }
    if (typeof responseText !== "string" || !responseText.trim()) {
      return res.status(400).json({ error: "responseText is required" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const response = recordDeliberationResponse(
      id,
      department,
      position,
      responseText,
      Array.isArray(respondingTo) ? respondingTo : undefined,
    );
    res.json({ opportunityId: id, response, exchange: getDeliberationExchange(id) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 14a: GET .../deliberation — read the current exchange ───────
//
// Plain read, same posture the committee-packet GET route (13d) already
// takes: no agentAddress, nothing written. Exists separately from the
// committee-packet route (which already embeds this same object under
// `packet.deliberation`) so a caller — a department deciding whether it
// still needs to respond, or a dashboard — doesn't have to re-assemble
// (and pay for) all three department reports just to check deliberation
// status.
router.get("/opportunities/:id/deliberation", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    res.json({ opportunityId: id, exchange: getDeliberationExchange(id) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 14b/14c: POST .../vote — a department's recommendation ─────
//
// Tool surface for recordDepartmentVote() — the write route Opportunity
// Intelligence/Research/Finance/Strategy each call once to file their
// recommend / recommend-with-conditions / do-not-recommend position,
// distinct from (and alongside) their own 14a deliberation rebuttal.
// Same ownership chain every write route in this file enforces —
// agentAddress must match the top-level agent that owns the
// opportunity's own report.
router.post("/opportunities/:id/vote", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, department, vote, conditions } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (!isValidVoteDepartment(department)) {
      return res.status(400).json({
        error: `department must be one of: ${VOTE_DEPARTMENTS.join(", ")}`,
      });
    }
    if (!isValidVoteValue(vote)) {
      return res.status(400).json({
        error: "vote must be one of: recommend, recommend-with-conditions, do-not-recommend",
      });
    }
    if (conditions !== undefined && conditions !== null && typeof conditions !== "string") {
      return res.status(400).json({ error: "conditions must be a string when provided" });
    }
    // Phase 14c: same "pre-validate everything the write function would
    // otherwise throw on, so a bad request is a clean 400 rather than
    // an opaque 500" convention the 14a deliberation route above already
    // follows for its own required fields. recordDepartmentVote() below
    // still re-checks this itself (it has its own non-route callers),
    // but the route shouldn't rely on that fallback for its own HTTP
    // contract — a first-class field the CEO gate can trust means a
    // caller sending it wrong finds out with a named 400, not a 500.
    const trimmedConditions = typeof conditions === "string" ? conditions.trim() : "";
    if (vote === "recommend-with-conditions" && !trimmedConditions) {
      return res.status(400).json({ error: "conditions is required for a recommend-with-conditions vote" });
    }
    if (vote !== "recommend-with-conditions" && trimmedConditions) {
      return res.status(400).json({ error: "conditions is only valid for a recommend-with-conditions vote" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res.status(403).json({ error: "agentAddress does not own this opportunity" });
    }

    const record = recordDepartmentVote(id, department, vote, conditions);
    res.json({ opportunityId: id, vote: record, votingRecord: getVotingRecord(id) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 14b/14d: GET .../votes — current voting record ──────────────
//
// Plain read, same posture the deliberation GET route (14a) takes: no
// agentAddress, nothing written or re-computed as a side effect. Same
// "don't make a caller re-assemble the whole four-report packet just to
// check one bundle-level field" reasoning that route's own header
// gives — this one already sits under `packet.votingRecord` too.
router.get("/opportunities/:id/votes", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    res.json({ opportunityId: id, votingRecord: getVotingRecord(id), votes: listDepartmentVotes(id) });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});


// ─── Phase 15b: POST .../decide — the CEO's ruling ──────────────────────
//
// Zent.md 15b: "POST /expansion/opportunities/:id/decide — writes
// expansion_decisions, requires the calling agent_address to match the
// top-level agent that owns the whole pipeline (no other agent can
// approve another's expansion)."
//
// Tool surface for Phase 15a's decideExpansion() — the actual ruling
// logic (validating `decision`, gating on requireDecidableCommitteePacket()'s
// composed 13e/14a/14d checks, snapshotting the packet, and writing the
// expansion_decisions row) all lives there. This route's own job is
// exactly what 15b names: turn a caller-supplied agentAddress/decision/
// notes into a clean HTTP contract, and enforce ownership before
// decideExpansion() is ever called — same ownership chain every other
// write route in this file already enforces (opportunity -> its report
// -> report.agent_address must equal the caller's agentAddress), here
// read the same way Zent.md 15b's own wording reads it: "the top-level
// agent that owns the whole pipeline" IS that opportunity's own
// report.agent_address, since the whole pipeline (Opportunity
// Intelligence's report through Research/Finance/Strategy's findings to
// this decision) hangs off that one report the same top-level agent
// created back in Phase 1a/2a. "No other agent can approve another's
// expansion" is exactly the 403 below, not a second check anywhere
// else.
//
// `decision`/`notes` pre-validation mirrors the 14c fix's own
// convention on the sibling vote route immediately above: a caller
// sending a malformed `decision` gets a named 400 here, not decideExpansion()'s
// internal throw surfacing as an opaque 500 — decideExpansion() still
// re-validates both itself (it has its own non-route callers, same as
// recordDepartmentVote()), but the route doesn't rely on that as its
// own HTTP contract.
//
// A packet that isn't ready for a decision (13e incomplete, 14a not
// locked, or 14d's votingRecord not yet readyForDecision) is a real
// state precondition failure, not a malformed request — same 409
// setOpportunityStatus()'s own invalid-transition case already uses on
// /opportunities/:id/status above, not a 400 or 500.
router.post("/opportunities/:id/decide", (req, res) => {
  try {
    const { id } = req.params;
    const { agentAddress, decision, notes } = req.body || {};

    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    if (typeof agentAddress !== "string" || !agentAddress) {
      return res.status(400).json({ error: "agentAddress is required" });
    }
    if (!isValidCeoDecision(decision)) {
      return res.status(400).json({ error: `decision must be one of: ${CEO_DECISIONS.join(", ")}` });
    }
    if (notes !== undefined && notes !== null && typeof notes !== "string") {
      return res.status(400).json({ error: "notes must be a string when provided" });
    }

    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }
    const report = getOpportunityReport(opportunity.report_id);
    if (!report) {
      // Unreachable in practice (report_id is FK-constrained at
      // insert) — treated as a genuine server fault, same as every
      // other dangling-report_id guard in this file.
      return res.status(500).json({ error: `opportunity_report ${opportunity.report_id} not found` });
    }
    if (report.agent_address !== agentAddress) {
      return res
        .status(403)
        .json({ error: "agentAddress does not own this opportunity's expansion pipeline" });
    }

    let result;
    try {
      result = decideExpansion(id, decision, agentAddress, notes ?? null);
    } catch (err: any) {
      return res
        .status(409)
        .json({ error: err.message || "committee packet is not ready for a decision" });
    }

    res.json({
      opportunityId: id,
      decision: result.decision,
      packet: result.packet,
      // Phase 15d: non-null only when this call just recorded an
      // `approved` ruling with dry-run mode OFF for this opportunity's
      // agent — the genesis trigger fired inline, as part of this same
      // request, with no further operator step. See expansion.ts's
      // fireGenesisTrigger() for what "fired" means ahead of Phase 16's
      // real provisioning code.
      genesisTrigger: result.genesisTrigger,
      // Phase 19e: non-null only when this call just recorded an
      // `approved` ruling with dry-run mode ON for this opportunity's
      // agent — the genesis-ready packet was produced and stored, but
      // no genesisExecutor ran and no funding was spent. Mutually
      // exclusive with genesisTrigger above.
      dryRunPacket: result.dryRunPacket,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// ─── Phase 15e: GET .../decision-bundle — the full audit trail ─────────
//
// Zent.md 15e: "Full audit trail: decision + every report that fed it,
// retrievable as one bundle for as long as Agent B exists — this is a
// record for later analysis, not a hold point."
//
// Same GET-route shape every other read route in this file already
// takes toward its own compile*/assemble* function (sendCommitteePacket()
// immediately above is the closest sibling): validate the id, confirm
// the opportunity exists (a clean 404 rather than getExpansionAuditBundle()'s
// own generic "not found" throw surfacing as a 500), call the one
// data-layer function, re-verify its shape at the HTTP boundary same
// belt-and-braces posture as every other GET route here, and return one
// consistent body. No ownership check here, unlike POST .../decide —
// this is a read, same public-within-the-shared-secret-perimeter
// posture GET .../committee-packet, .../research, .../finance, and
// .../strategy already take; "for as long as Agent B exists" (15e) is
// about retention, not about narrowing who can read it.
router.get("/opportunities/:id/decision-bundle", (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !looksLikeOpportunityId(id)) {
      return res.status(400).json({ error: `${id ?? ""} is not a valid opportunity id` });
    }
    const opportunity = getOpportunity(id);
    if (!opportunity) {
      return res.status(404).json({ error: `opportunity ${id} not found` });
    }

    const bundle = getExpansionAuditBundle(id);
    const shapeCheck = validateExpansionAuditBundleShape(bundle);
    if (!shapeCheck.valid) {
      return res.status(500).json({
        error: `assembled audit bundle failed its own locked schema: ${shapeCheck.errors.join("; ")}`,
      });
    }

    res.json({
      opportunityId: id,
      schemaVersion: AUDIT_BUNDLE_SCHEMA_VERSION,
      bundle,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

export default router;
