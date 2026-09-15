/**
 * next-phase.md Phase 2i(a) — Tool Registry seed data
 * (architecture-agent.md §9)
 *
 * Pure data + row-generation logic for the tool_registry seed — no `db`
 * import, no side effects, nothing that touches sqlite. Split out from
 * seedToolRegistry.ts (which does the actual DB write) specifically so
 * this file can be imported by a `node --test` file in an environment
 * with no network access to install better-sqlite3 (the same
 * constraint retireProjectSequence.test.ts/capability.test.ts/
 * environment.test.ts already flag) — importing seedToolRegistry.ts
 * itself would pull in ./db.js -> better-sqlite3 at module load and
 * fail immediately. seedToolRegistry.ts imports ROWS/assertNoDuplicateNames
 * from here rather than duplicating them, so there is exactly one place
 * this row list is authored.
 *
 *
 * Row-by-row provenance, so this seed can be audited against the doc
 * without re-reading architecture-agent.md side by side:
 *
 *   §4d (Agent-tier, company-wide, persistent, unrestricted department
 *   type) — one row per bullet-list item grouped under each §4d heading
 *   (Reasoning, Company management, Worker workforce, Internet
 *   intelligence, Product creation, Files and repositories, Database,
 *   Company finance, Wallet, Customer acquisition, Self-improvement).
 *   Reasoning-only items (no dedicated backend call — e.g. "strategic
 *   reasoning," "risk evaluation") are seeded with an empty
 *   inputSchema `{}` and cost `{ unit: "compute" }` with no per-call
 *   amount, the same "named in the doc, not a metered external call"
 *   treatment departmentToolProfiles.ts already gives empty ACTION[]
 *   capabilities — seeding them is what makes list_available_tools
 *   (Phase 2i(e)) able to say "Agent A can reason about X" at all,
 *   even though there's no dispatcher ACTION for a reasoning capability
 *   the same way there's one for run_command.
 *
 *   §4e (Department-Agent-tier) — reasoning/management/memory/finance/
 *   communication bullets are company-type-unrestricted (departmentTypes
 *   NULL, "any department" per §9's own comment on the field) since
 *   §4e's prose explicitly scopes these to "department-level" generally,
 *   not to one department type. The five-column §4e TABLE (Software/
 *   Marketing/Finance/Security/Server) is what gets departmentTypes
 *   restricted per row, seeded directly from departmentToolProfiles.ts's
 *   SOFTWARE_TOOLS/MARKETING_TOOLS/FINANCE_TOOLS/SECURITY_TOOLS/
 *   SERVER_TOOLS arrays and CAPABILITY_TO_ACTIONS map — imported, not
 *   retyped, so this seed cannot drift from Phase 2f-i's already-locked
 *   table by a copy/paste mistake. A capability name shared by two
 *   department types in §4e's table (e.g. "logs" appears in Software's,
 *   Security's, and Server's rows) is seeded as ONE row with BOTH types
 *   listed in departmentTypes, not duplicated — matching §9's
 *   `departmentTypes?: string[]` shape (a list, not a single value).
 *
 *   §4f (Worker-tier) — task-scoped bullets across Reasoning/Task tools/
 *   Compute/Development tools/Research tools/Communication/Memory/
 *   Financial access/External-specialty. Worker-tier rows get
 *   scopeTemplate "own_container" (Compute/Development/Research/
 *   External-specialty — "scoped to what it was assigned," §4f) or
 *   "own_office" (Task tools/Communication/Memory — reading/reporting
 *   against the Worker's own task context) rather than "assigned_
 *   department"/"company_wide", matching §4f's own "never the
 *   department's or company's full infrastructure" line.
 *
 * Cost defaults, per §9/§4g's own rules (this phase's own judgment call
 * where the doc gives a rule but not a number, flagged so a later phase
 * can tune without re-deriving the rule):
 *   - Reasoning/management/communication/memory bullets with no
 *     metered external call: `{ unit: "compute" }`, no amount — matches
 *     §9's "a persistent Agent-tier tool gets no ceiling unless the
 *     Founder sets one explicitly."
 *   - Real dispatcher ACTIONs that run inside a sandbox (exec/pty/file):
 *     `{ unit: "compute" }` with no per-call amount either — this
 *     runtime doesn't meter compute-seconds per call anywhere today
 *     (confirmed: no such column exists on sub_agents/exec_log), so a
 *     fabricated amountPerUnit would be a number with no source, which
 *     copyright/accuracy conventions this codebase already follows
 *     elsewhere (e.g. Phase 2h's own "honest no-op, not a fabricated
 *     credit") argue against inventing.
 *   - `check_balance`/wallet-family tools: `{ unit: "usd" }`, no
 *     amountPerCall — reading a balance isn't itself a spend; the
 *     actual USD amounts flow through wallet.ts's own
 *     spend_cap_daily_usdc/department_spend_log mechanism (Phase 2f-iv/
 *     2h), not a per-call registry price.
 */
/**
 * `backend/src` (this file's own package) and `backend/agent-runtime/src`
 * (where departmentToolProfiles.ts actually lives) are two independent
 * TypeScript projects — separate package.json, separate tsconfig.json,
 * separate `rootDir: "src"`, no dependency edge between them anywhere
 * in this repo today. A cross-package import (`../agent-runtime/src/...`)
 * would compile under `tsx` at runtime but break `tsc --noEmit` for
 * BOTH projects the moment either is built standalone (agent-runtime's
 * own `tsc` has no visibility into backend/src, and vice versa) — not a
 * real fix, just a landmine for the first person who runs `npm run
 * build` in agent-runtime/. So this table is a literal, deliberate
 * COPY of departmentToolProfiles.ts's SOFTWARE_TOOLS/MARKETING_TOOLS/
 * FINANCE_TOOLS/SECURITY_TOOLS/SERVER_TOOLS/DOMAIN_TOOLS arrays and its
 * CAPABILITY_TO_ACTIONS map — same relationship departmentToolProfiles.ts
 * itself has to architecture-agent.md §4e (a direct, literal
 * transcription, not a reference), kept in sync by inspection. If this
 * table and departmentToolProfiles.ts ever disagree, that's a real bug
 * to fix by hand in both places — Phase 2i(b)'s assign_tools() reading

 * next-phase.md Phase 9a-iii mirrored departmentToolProfiles.ts's
 * DOMAIN_TOOLS (Phase 9a-ii, architecture-agent.md §4h's new Domain
 * Management row) into this copy the same way every other department
 * type already is here — same "domain" key added to DEPARTMENT_TOOL_PROFILES
 * below, same five capability names added to CAPABILITY_TO_ACTIONS with
 * empty ACTION[] values (the DNS/SSL/reverse-proxy/mail primitives don't
 * exist in this runtime yet — 9c/9d's job, not this sub-phase's, same
 * "named in the doc, not yet implemented" treatment 9a-ii's own copy
 * already gives these five names). The existing per-department-type
 * generation loop further down this file (§4e's per-department-type
 * table) picks "domain" up automatically once it's a key in
 * DEPARTMENT_TOOL_PROFILES — no separate Domain-specific row-generation
 * code was needed, matching how Software/Marketing/Finance/Security/
 * Server rows are all produced by that same shared loop today.
 * FROM this registry (rather than either file re-deriving from the
 * other) is what actually retires this duplication, not this phase.
 */
// Zent.md Phase 2b: `opportunity_intelligence` added as an eighth type
// in THIS file's own copy of the union — toolRegistry.ts added it to
// its own copy back in Phase 2a (that file's own header explains why
// this is a deliberate duplication, not an oversight), but this file's
// independent copy was left behind at that time. Closed here because
// 2b is the first phase that actually needs a department_types-scoped
// seed row for this type (2a only needed the type to exist for
// departments.ts's spawn-time checks, which read toolRegistry.ts's
// copy, not this one) — see DEPARTMENT_TOOL_PROFILES below for the row
// this unlocks.
// Zent.md Phase 5a: `research` added as this file's own copy of the
// ninth... eighth... type — see toolRegistry.ts's Phase 5a comment for
// why this is a deliberate second copy, same relationship
// opportunity_intelligence's Phase 2b comment (just below) already
// describes. Closed here, alongside the DEPARTMENT_TOOL_PROFILES row
// below, because assignTools("department_agent", { role: "research" })
// resolves via toolRegistry.ts's own copy of DepartmentType (already
// updated) regardless of what happens here — but this file's
// `Record<DepartmentType, string[]>` type on DEPARTMENT_TOOL_PROFILES
// means the union has to grow here too for the file to typecheck, and
// growing it with an empty tools[] entry (see that row's own comment)
// is honest about where this stands until Phase 5b-5d actually add
// tools.
// Zent.md Phase 11a: `strategy` added as this file's own copy of the
// tenth type — see toolRegistry.ts's Phase 11a comment for why this is
// a deliberate second copy, same relationship every other type's own
// pair of comments here already describes. Closed here, alongside the
// DEPARTMENT_TOOL_PROFILES row below, for the identical reason
// research's Phase 5a comment gives: assign_tools() resolves via
// toolRegistry.ts's own copy regardless of what happens here, but this
// file's `Record<DepartmentType, string[]>` type needs the union to
// grow here too to typecheck, and an empty tools[] entry is honest
// about where this stands until Phase 11b-11d actually add tools.
export type DepartmentType = "software" | "marketing" | "finance" | "security" | "server" | "domain" | "opportunity_intelligence" | "research" | "strategy";

// error-fix.md #1 fix: exported (was module-private) so toolRegistry.ts
// — same backend/src package, no cross-project boundary to worry about
// the way departmentToolProfiles.ts's own header warns about for
// agent-runtime — can resolve a Worker's department-scoped capability
// set from this exact table instead of authoring a FOURTH copy of it.
export const DEPARTMENT_TOOL_PROFILES: Record<DepartmentType, string[]> = {
  software: [
    "terminal", "shell", "file system", "git", "GitHub", "package manager",
    "build tools", "test tools", "debugging", "code analysis", "database",
    "API testing", "deployment", "logs",
  ],
  marketing: [
    "web search", "market research", "competitor research", "customer research",
    "content generation", "analytics", "campaign management", "lead research",
    "CRM", "customer communication", "product analytics",
  ],
  finance: [
    "transaction history", "wallet balance", "revenue analysis", "expense analysis",
    "budgeting", "forecasting", "accounting", "payment records", "financial reporting",
  ],
  security: [
    "logs", "dependency scanning", "configuration inspection", "vulnerability testing",
    "security testing", "network monitoring", "incident analysis", "access auditing",
    // error-fix.md Phase 12a, mirrored from departmentToolProfiles.ts's
    // own SECURITY_TOOLS — mediated (agent-runtime-process) research,
    // not sandbox network, so it doesn't weaken HARDENED_NETWORK_
    // DEPARTMENT_TYPES' guarantee.
    "vulnerability research",
  ],
  server: [
    "VM management", "container management", "deployment", "logs", "monitoring",
    "scaling", "backups", "DNS", "network configuration",
    // error-fix.md Phase 12a, mirrored from departmentToolProfiles.ts's
    // own SERVER_TOOLS — same mediated-research reasoning as Security's
    // "vulnerability research" above.
    "infrastructure research",
  ],
  // Phase 9a-iii — mirrored verbatim from departmentToolProfiles.ts's
  // DOMAIN_TOOLS (Phase 9a-ii). Deliberately its own row set, not
  // derived from `server`'s "DNS" entry above, even though both touch
  // DNS — Server's is VM/network-ops-flavored (this Agent's own
  // infrastructure), Domain's is apex-shared-resource-flavored
  // (novamail.store subdomains/mailboxes shared across every Agent) —
  // same distinction departmentToolProfiles.ts's own DOMAIN_TOOLS
  // comment draws.
  domain: [
    "dns record management", "ssl certificate issuance",
    "reverse-proxy vhost management", "mailbox provisioning",
    "domain-resource registry",
  ],
  // Zent.md Phase 2b: opportunity_intelligence's own row in this table.
  // A single capability — "market signal scanning" — covers all three
  // signal-collection tools opportunity_intelligence has today:
  // scan_market_signals() (2b) plus Phase 2c's list_customer_
  // complaints()/list_demand_signals(), which are "thin, named wrappers
  // over 2b so the department's reasoning trace stays legible" (Zent.md)
  // — distinct callable tools that reuse this exact same grant rather
  // than needing their own capability, per this entry's own prior note.
  // Their runtime ACTION names are appended to this same capability's
  // entry in CAPABILITY_TO_ACTIONS below, not given a new capability.
  //
  // Zent.md Phase 3a: "opportunity scoring" is deliberately its own
  // capability rather than folded into "market signal scanning" above
  // — scoring writes a structured row to `opportunities` (via
  // createOpportunity()), it doesn't fetch anything or append to
  // source_summary, so it's a distinct kind of access even though both
  // are granted to the same department type. Same one-capability-per-
  // distinct-kind-of-access reasoning "market signal scanning" itself
  // already applies across its three wrapper tools.
  opportunity_intelligence: ["market signal scanning", "opportunity scoring"],
  // Zent.md Phase 5a left this empty deliberately (see that phase's own
  // note, preserved below) — 5b/5c/5d/5e have each since closed it:
  // "market size estimation" -> estimate_market_size, "competitive
  // landscape survey" -> survey_competition, "customer segment
  // identification" -> identify_customer_segments (the three
  // capabilities Phase 5a's own comment predicted), and now "research
  // confidence reporting" -> report_research_confidence, the fourth
  // capability 5e's own field adds on top of them. Same one-capability-
  // per-distinct-kind-of-access pattern opportunity_intelligence's own
  // row above already follows.
  //
  // Original Phase 5a note: "no tools yet, deliberately. This phase is
  // only 'the department type exists, is spawnable (tied to one
  // opportunity_id, one instance at a time), and tears itself down
  // when its finding is filed' — departments.ts's POST / route and
  // db.ts's Phase 5a migration are what that actually needs, not a
  // tool grant."
  research: [
    "market size estimation",
    "competitive landscape survey",
    "customer segment identification",
    "research confidence reporting",
  ],
  // Zent.md Phase 11a left this empty deliberately — same "type
  // exists, is spawnable (gated on both Research and Finance having
  // filed non-rejecting reports), no tools yet" scope research's own
  // Phase 5a note (preserved above) documents for itself.
  //
  // 11b's list_existing_companies is STILL not wired here as its own
  // capability — that gap predates this row's Phase 11e-ii-a/b entries
  // below and is out of this session's scope to close; noted here
  // rather than silently left to look resolved.
  //
  // Zent.md Phase 11e-ii-a/b: "strategy fit scoring" bundles the three
  // tools that make up score_strategy_fit's own guarded workflow:
  // check_mission_overlap/check_technology_reuse (11c/11d's PERSISTING
  // wrappers — recordMissionOverlapCheck()/recordTechnologyReuseCheck()
  // in expansion.ts, filed onto strategy_findings so 11e-ii-b's guard
  // has something to check the presence of; 11c/11d's own original pure
  // checkMissionOverlap()/checkTechnologyReuse() functions and their
  // plain-read GET routes are unchanged and still ungranted here) and
  // score_strategy_fit itself, which requires both to have run first.
  // Bundled as one capability rather than three, the same way "market
  // signal scanning" bundles scan_market_signals with its own two thin
  // wrappers above — these three tools are one guarded sequence a
  // Strategy department runs together, not three independent kinds of
  // access.
  // Zent.md Phase 12a adds "ecosystem health assessment"; Phase 12b
  // adds "cannibalization risk check" — see each capability's own row
  // in the table below for why they're separate entries rather than
  // folded into the fit-scoring bundle.
  strategy: [
    "strategy fit scoring",
    "ecosystem health assessment",
    "cannibalization risk check",
    "relationship type recommendation",
  ],
};

// Mirrors departmentToolProfiles.ts's CAPABILITY_TO_ACTIONS exactly —
// see that file for the per-entry reasoning behind which capabilities
// map to real runtime ACTIONs vs. an intentionally empty array.
const CAPABILITY_TO_ACTIONS: Record<string, string[]> = {
  terminal: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close", "pty_list"],
  shell: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close", "pty_list"],
  "file system": ["read_file", "write_file"],
  git: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  // Phase 8a: mirrors departmentToolProfiles.ts's own github row exactly
  // (see that file for the reasoning) — additive alongside the existing
  // shell-based path, not a replacement of it.
  github: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close", "github_read"],
  "package manager": ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "build tools": ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "test tools": ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  debugging: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "code analysis": ["run_command", "read_file"],
  database: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  "api testing": ["run_command"],
  deployment: ["run_command", "pty_create", "pty_write", "pty_read", "pty_close"],
  logs: ["run_command", "read_file"],
  "web search": ["web_search"],
  "market research": ["web_search", "web_fetch"],
  "competitor research": ["web_search", "web_fetch"],
  "customer research": ["web_search", "web_fetch"],
  "content generation": [],
  analytics: [],
  "campaign management": [],
  "lead research": ["web_search", "web_fetch"],
  crm: [],
  "customer communication": [],
  "product analytics": [],
  "transaction history": [],
  "wallet balance": ["check_balance"],
  "revenue analysis": [],
  "expense analysis": [],
  budgeting: [],
  forecasting: [],
  accounting: [],
  "payment records": [],
  "financial reporting": [],
  "dependency scanning": [],
  "configuration inspection": ["read_file"],
  "vulnerability testing": [],
  "security testing": [],
  "network monitoring": [],
  "incident analysis": [],
  "access auditing": [],
  // error-fix.md Phase 12a — mirrors departmentToolProfiles.ts's own
  // entry exactly.
  "vulnerability research": ["web_search", "web_fetch", "github_read"],
  "vm management": [],
  "container management": [],
  monitoring: [],
  scaling: [],
  backups: [],
  dns: [],
  "network configuration": [],
  // error-fix.md Phase 12a — mirrors departmentToolProfiles.ts's own
  // entry exactly.
  "infrastructure research": ["web_search", "web_fetch", "github_read"],
  // Phase 9a-iii, updated by Phase 9c — mirrors
  // departmentToolProfiles.ts's own Domain Management
  // CAPABILITY_TO_ACTIONS entries exactly. 9c adopted a consolidation
  // (see tools.ts's own comment on the naming decision): rather than
  // seven granular dns_*/ssl_*/nginx_* ACTIONs, one atomic
  // provision_subdomain/list_subdomains/release_subdomain surface.
  // Filed under "domain-resource registry" — the capability whose own
  // description ("the domain_resources registry itself
  // (lookup/release)") most directly matches what these three ACTIONs
  // actually do (create+claim, list, release — all reads/writes of
  // domain_resources) — not under "dns record management"/"ssl
  // certificate issuance"/"reverse-proxy vhost management" individually,
  // since none of those three remain independently callable; they stay
  // empty on purpose, same "named in §4h, not yet a separately
  // dispatchable ACTION" treatment this table already gives other
  // not-yet-built capabilities.
  //
  // "mailbox provisioning" now mirrors departmentToolProfiles.ts's own
  // Phase 9d-i/9d-ii/9d-iii updates exactly (per those files' "kept in
  // sync by inspection" contract): mail_create_mailbox (9d-i, write
  // half), mail_list_mailboxes/reveal_mailbox_credential (9d-ii, read
  // half), and now mail_delete_mailbox (9d-iii, teardown half) —
  // §4h's mailbox-provisioning tool is now fully wired.
  "dns record management": [],
  "ssl certificate issuance": [],
  "reverse-proxy vhost management": [],
  "mailbox provisioning": [
    "mail_create_mailbox",
    "mail_list_mailboxes",
    "reveal_mailbox_credential",
    "mail_delete_mailbox",
  ],
  "domain-resource registry": ["provision_subdomain", "list_subdomains", "release_subdomain"],
  // Zent.md Phase 2b/2c: opportunity_intelligence's department-type-
  // scoped runtime ACTIONs. Unlike "market research"'s bare
  // web_search/web_fetch grant (Marketing), these are deliberately
  // single named wrapper actions, not the raw browsing primitives
  // themselves — see expansionRoutes.ts's own header for why the
  // write-to-opportunity_reports.source_summary step lives server-side
  // rather than trusting the caller to report back findings it
  // separately fetched with a bare web_search grant. scan_market_signals
  // is 2b's original wrapper; list_customer_complaints/list_demand_signals
  // are 2c's — both call the same underlying search path scan_market_
  // signals does, they just fix its query template to one argument
  // (domain / industry) so the department's own reasoning trace reads
  // as the specific named call it made, not a generic scan.
  "market signal scanning": [
    "scan_market_signals",
    "list_customer_complaints",
    "list_demand_signals",
  ],
  // Zent.md Phase 3a: score_opportunity(title, thesis, factors) — the
  // one named tool the "opportunity scoring" capability grants. See
  // expansionRoutes.ts's own Phase 3a section header for what it does
  // and does not do (in particular: it never sets roi_score — that's
  // Phase 3b, a separate later pass).
  "opportunity scoring": ["score_opportunity"],
  // Zent.md Phase 11e-ii-a/b: the fit-scoring workflow's three tools.
  // check_mission_overlap/check_technology_reuse here are 11c/11d's
  // PERSISTING wrappers (recordMissionOverlapCheck()/
  // recordTechnologyReuseCheck()) — they file their check onto the
  // opportunity's current strategy_findings row rather than just
  // returning it, which is what lets score_strategy_fit's own 11e-ii-b
  // guard require both to have run before it will compute a fit_score.
  // score_strategy_fit itself then reads those two persisted records,
  // applies 11e-i's fixed weighted-average formula, and writes
  // fit_score back onto the same row. See expansionRoutes.ts's own
  // Phase 11e-ii-a/b section headers for the three routes and
  // expansion.ts's for the tools themselves; score_strategy_fit never
  // sets ecosystemDiversificationValue/marketIndependence from live
  // data — those are Phase 12 territory, caller-supplied (or 0) until
  // then.
  "strategy fit scoring": [
    "check_mission_overlap",
    "check_technology_reuse",
    "score_strategy_fit",
  ],
  // Zent.md Phase 12a: assess_ecosystem_strengthening(opportunity_id) —
  // its own capability row, not folded into "strategy fit scoring"
  // above, since it's a distinct kind of access (a different
  // strategy_findings key, a different question — portfolio resilience
  // rather than this-opportunity's-own fit) even though both are
  // granted to the same `strategy` department type, matching this
  // table's own one-capability-per-distinct-kind-of-access convention.
  // Grants the PERSISTING wrapper (recordEcosystemStrengtheningAssessment())
  // — see expansionRoutes.ts's own Phase 12a section header — so a
  // Strategy department can file this check itself, with no operator
  // step, the same "agent runs its own guarded workflow" posture
  // "strategy fit scoring" already established for 11c/11d/11e-ii.
  "ecosystem health assessment": ["assess_ecosystem_strengthening"],
  // Zent.md Phase 12b: check_cannibalization(opportunity_id) — its own
  // row for the same reason "ecosystem health assessment" (12a) got
  // its own row rather than folding into "strategy fit scoring": a
  // distinct strategy_findings key (`cannibalization_check`) and a
  // distinct question (does this cannibalize an existing sibling,
  // rather than does it strengthen the portfolio or fit this
  // opportunity itself). Grants the PERSISTING wrapper
  // (recordCannibalizationCheck()) — see expansionRoutes.ts's own
  // Phase 12b section header — so a Strategy department files this
  // check itself, same no-operator-step posture every other strategy
  // capability in this table already has.
  "cannibalization risk check": ["check_cannibalization"],
  // Zent.md Phase 12c: recommend_relationship_type(opportunity_id) — its
  // own row for the same reason "ecosystem health assessment" (12a) and
  // "cannibalization risk check" (12b) got their own rows rather than
  // folding into "strategy fit scoring": a distinct strategy_findings
  // key (`relationship_type_recommendation`) and a distinct question
  // (what relationship, if any, should Agent B have with an existing
  // sibling — read off 12a's and 12b's own signals, not a fresh
  // computation). Grants the PERSISTING wrapper
  // (recordRelationshipTypeRecommendation()) — see expansionRoutes.ts's
  // own Phase 12c section header — so a Strategy department files this
  // recommendation itself, same no-operator-step posture every other
  // strategy capability in this table already has. Phase 16d reads the
  // filed finding directly to scope Agent B's initial tool grants at
  // genesis.
  "relationship type recommendation": ["recommend_relationship_type"],
  // Zent.md Phase 5b: estimate_market_size(opportunity_id) — the first
  // of research's three eventual tools (5c/5d add their own capability
  // rows alongside this one, not into it — see this table's own
  // one-capability-per-distinct-kind-of-access convention, e.g.
  // "market signal scanning" vs "opportunity scoring" just above). Like
  // "market signal scanning", this is a single named wrapper action
  // rather than a bare web_search/web_fetch grant — the search and the
  // write into research_findings.market_size both happen server-side in
  // expansionRoutes.ts, for the same reason 2b's own header gives.
  "market size estimation": ["estimate_market_size"],
  // Zent.md Phase 5c: survey_competition(opportunity_id) — same
  // single-named-wrapper-action shape as "market size estimation"
  // just above; its own row exists because it's a distinct kind of
  // access (a different query template, a different findings key),
  // even though both are granted to the same `research` department
  // type, matching this table's own one-capability-per-distinct-kind-
  // of-access convention.
  "competitive landscape survey": ["survey_competition"],
  // Zent.md Phase 5d: identify_customer_segments(opportunity_id) — the
  // third and last of research's three predicted capabilities, same
  // single-named-wrapper-action shape as the two rows just above.
  "customer segment identification": ["identify_customer_segments"],
  // Zent.md Phase 5e: report_research_confidence(opportunity_id,
  // confidence) — no search, so no web_search/web_fetch-shaped ACTION
  // underneath it the way 5b/5c/5d have; it only writes the self-
  // reported confidence level plus the computed sources list (see
  // expansion.ts's recordResearchConfidence() for why sources are
  // computed, not caller-supplied) onto the current finding.
  "research confidence reporting": ["report_research_confidence"],
};

export type PermissionLevel = "agent" | "department_agent" | "worker";
export type ScopeTemplate =
  | "own_office"
  | "own_container"
  | "assigned_department"
  | "assigned_project"
  | "company_wide";
export type Lifecycle = "persistent" | "session" | "task" | "project";

export interface SeedRow {
  name: string;
  description: string;
  inputSchema: object;
  costUnit: "usd" | "compute" | "calls" | "disk";
  costAmountPerCall?: number;
  costAmountPerUnit?: number;
  permissionLevel: PermissionLevel[];
  departmentTypes?: DepartmentType[];
  scopeTemplate: ScopeTemplate;
  lifecycle: Lifecycle;
}

const NO_SCHEMA = {};
const COMPUTE_NO_CEILING = { costUnit: "compute" as const };

// ───────────────────────────────────────────────────────────────────
// §4d — Agent-tier, company-wide, persistent. departmentTypes omitted
// throughout this block: Agent A's authority is not department-scoped
// at all (§4d's own opening line — "everything below is either
// delegated down... or capped by a quota"), so "any department" (NULL)
// is the only correct value, not a per-row judgment call.
// ───────────────────────────────────────────────────────────────────
const AGENT_REASONING: string[] = [
  "strategic reasoning",
  "long-term planning",
  "short-term planning",
  "goal decomposition",
  "opportunity evaluation",
  "risk evaluation",
  "cost evaluation",
  "profitability analysis",
  "resource allocation",
  "decision making",
  "prioritization",
  "negotiation",
  "problem solving",
  "self-evaluation",
  "plan revision",
  "failure recovery",
  "learning from previous outcomes",
];

const AGENT_COMPANY_MANAGEMENT: { name: string; action?: string }[] = [
  { name: "create department", action: "create_department" },
  { name: "delete department", action: "delete_department" },
  { name: "rename department", action: "rename_department" },
  { name: "set department objectives" },
  { name: "allocate department budgets", action: "transfer_department_budget" },
  { name: "set department priorities" },
  { name: "hire department agents", action: "create_department" },
  { name: "retire department agents", action: "retire_department" },
  { name: "evaluate department performance" },
  { name: "transfer resources between departments", action: "transfer_department_budget" },
  { name: "create company-wide projects" },
  { name: "assign projects to departments" },
  { name: "cancel projects", action: "retire_project" },
  { name: "change company strategy" },
];

const AGENT_WORKFORCE: { name: string; action?: string }[] = [
  { name: "view every worker", action: "department_list" },
  { name: "view worker performance", action: "get_worker_evaluations" },
  { name: "create workers", action: "spawn_subagent" },
  { name: "clone workers", action: "spawn_clone" },
  { name: "retire workers", action: "kill_subagent" },
  { name: "assign workers" },
  { name: "move workers between departments", action: "move_worker" },
  { name: "promote workers", action: "convert_temp_to_permanent" },
  { name: "demote workers" },
  { name: "change worker roles", action: "change_worker_role" },
  { name: "create temporary workers", action: "spawn_temp_workers" },
  { name: "convert temporary to permanent", action: "convert_temp_to_permanent" },
  { name: "set worker budgets" },
  { name: "set worker tool permissions" },
  { name: "set worker compute limits" },
];

const AGENT_INTERNET_INTELLIGENCE: string[] = [
  "web search",
  "web browsing",
  "forum search",
  "reddit search",
  "github search",
  "product review search",
  "app review search",
  "news search",
  "competitor site search",
  "pricing research",
  "demand research",
  "complaint research",
  "trend research",
  "customer feedback collection",
  "competitor comparison",
  "market analysis",
  "opportunity identification",
];

const AGENT_PRODUCT_CREATION: string[] = [
  "generate product ideas",
  "validate product ideas",
  "write specifications",
  "design architecture",
  "generate code",
  "modify code",
  "run code",
  "test code",
  "debug code",
  "build applications",
  "build apis",
  "build websites",
  "build mobile apps",
  "build automation",
  "deploy products",
  "update products",
  "roll back deployments",
];

const AGENT_FILES_REPOS: { name: string; action?: string }[] = [
  { name: "read files", action: "read_file" },
  { name: "write files", action: "write_file" },
  { name: "edit files", action: "write_file" },
  { name: "copy files" },
  { name: "move files" },
  { name: "delete files" },
  { name: "search files" },
  { name: "compress files" },
  { name: "extract files" },
  { name: "git clone", action: "run_command" },
  { name: "git branch", action: "run_command" },
  { name: "git commit", action: "run_command" },
  { name: "git merge", action: "run_command" },
  { name: "git pull", action: "run_command" },
  { name: "git push", action: "run_command" },
  { name: "git diff", action: "run_command" },
  { name: "repository management" },
];

const AGENT_DATABASE: { name: string; action?: string }[] = [
  { name: "create database", action: "run_command" },
  { name: "create tables", action: "run_command" },
  { name: "crud records", action: "run_command" },
  { name: "run queries", action: "run_command" },
  { name: "create indexes", action: "run_command" },
  { name: "monitor database" },
  { name: "backup database" },
  { name: "restore database" },
  { name: "migrate schema", action: "run_command" },
];

const AGENT_FINANCE: { name: string; action?: string }[] = [
  { name: "view company balance", action: "check_balance" },
  { name: "view department balances", action: "check_balance" },
  { name: "view revenue" },
  { name: "view expenses" },
  { name: "calculate profit" },
  { name: "forecast expenses" },
  { name: "forecast revenue" },
  { name: "allocate budgets", action: "transfer_department_budget" },
  { name: "pay infrastructure" },
  { name: "pay model providers" },
  { name: "pay external services" },
  { name: "receive customer payments" },
  { name: "transfer funds" },
  { name: "create payment requests" },
  { name: "track invoices" },
  { name: "track financial history" },
];

const AGENT_WALLET: { name: string; action?: string; unit: "usd" }[] = [
  { name: "generate wallet", unit: "usd" },
  { name: "read wallet address", unit: "usd" },
  { name: "check balance", action: "check_balance", unit: "usd" },
  { name: "sign transactions", unit: "usd" },
  { name: "send usdc", unit: "usd" },
  { name: "receive usdc", unit: "usd" },
  { name: "interact with smart contracts", unit: "usd" },
  { name: "track transactions", unit: "usd" },
  { name: "create payment request", unit: "usd" },
  { name: "verify payment request", unit: "usd" },
  { name: "manage agent wallets", unit: "usd" },
];

const AGENT_CUSTOMER_ACQUISITION: string[] = [
  "identify potential customers",
  "find communities",
  "find companies",
  "research prospects",
  "generate offers",
  "create product pages",
  "create sales material",
  "contact customers",
  "respond to customers",
  "track leads",
  "track conversions",
  "analyze acquisition cost",
  "analyze customer feedback",
  "improve offers",
];

// Self-improvement is explicitly Agent-tier-only per §4d's own closing
// note ("never delegated") — permissionLevel is ["agent"] alone here,
// not the ["agent","department_agent","worker"] every other §4d row
// gets, and lifecycle is "persistent" same as the rest of §4d.
const AGENT_SELF_IMPROVEMENT: string[] = [
  "inspect own performance",
  "analyze failures",
  "update strategies",
  "improve prompts",
  "create new skills",
  "modify internal configuration",
  "test new strategies",
  "compare strategies",
  "retain successful strategies",
  "roll back unsuccessful changes",
];

// ───────────────────────────────────────────────────────────────────
// §4e — Department-Agent-tier, department-scoped-but-type-unrestricted
// bullets (reasoning/management/memory/finance/communication). The
// department-TYPE-restricted five-column table is handled separately
// below, sourced from departmentToolProfiles.ts directly.
// ───────────────────────────────────────────────────────────────────
const DEPT_REASONING: string[] = [
  "department-level reasoning",
  "department planning",
  "task decomposition",
  "technical decision making",
  "resource planning",
  "department prioritization",
  "department risk analysis",
  "department cost analysis",
  "worker selection",
  "worker evaluation",
  "department failure recovery",
  "project planning",
  "quality evaluation",
];

const DEPT_MANAGEMENT: { name: string; action?: string }[] = [
  { name: "manage department objective" },
  { name: "manage department budget" },
  { name: "create projects", action: "create_project" },
  { name: "break projects into tasks", action: "break_into_tasks" },
  { name: "assign tasks", action: "assign_task" },
  { name: "create department workers", action: "spawn_department_worker" },
  { name: "clone department workers", action: "spawn_clone" },
  { name: "retire department workers", action: "terminate_temp_worker" },
  { name: "assign worker roles", action: "change_worker_role" },
  { name: "allocate worker budgets" },
  { name: "allocate compute" },
  { name: "set worker permissions" },
  { name: "evaluate workers", action: "evaluate_worker" },
  { name: "keep good workers", action: "retain_worker" },
  { name: "terminate temporary workers", action: "terminate_temp_worker" },
];

const DEPT_MEMORY: string[] = [
  "department knowledge",
  "previous projects",
  "worker history",
  "technical knowledge",
  "decisions",
  "lessons learned",
  "customer feedback",
  "department strategy",
];

const DEPT_FINANCE: { name: string; action?: string; unit: "usd" }[] = [
  { name: "view department wallet", action: "check_balance", unit: "usd" },
  { name: "view department budget", unit: "usd" },
  { name: "allocate worker budgets (department)", unit: "usd" },
  { name: "pay department expenses", unit: "usd" },
  { name: "track revenue (department)", unit: "usd" },
  { name: "track project profitability", unit: "usd" },
];

const DEPT_COMMUNICATION: string[] = [
  "message agent",
  "message own workers",
  "message other department agents",
  "send reports",
  "receive reports",
  "request resources",
  "request additional workers",
  "request additional compute",
];

// ───────────────────────────────────────────────────────────────────
// §4f — Worker-tier, task-scoped.
// ───────────────────────────────────────────────────────────────────
const WORKER_REASONING: string[] = [
  "task reasoning",
  "technical reasoning",
  "task problem solving",
  "local planning",
  "task error recovery",
  "result evaluation",
  "task completion",
];

const WORKER_TASK_TOOLS: { name: string; action?: string }[] = [
  { name: "read task" },
  { name: "receive instructions" },
  { name: "read relevant context" },
  { name: "execute task" },
  { name: "report result", action: "subagent_result" },
  { name: "request clarification" },
  { name: "mark task complete", action: "subagent_result" },
  { name: "mark task blocked" },
];

const WORKER_COMPUTE: { name: string; action?: string }[] = [
  { name: "terminal (worker)", action: "run_command" },
  { name: "shell (worker)", action: "pty_create" },
  { name: "file system (worker)", action: "read_file" },
  { name: "assigned container", action: "pty_create" },
  { name: "assigned vm" },
  { name: "process management" },
  { name: "logs (worker)", action: "read_file" },
];

const WORKER_DEV_TOOLS: { name: string; action: string }[] = [
  { name: "read code", action: "read_file" },
  { name: "write code", action: "write_file" },
  { name: "edit code", action: "write_file" },
  { name: "run tests (worker)", action: "run_command" },
  { name: "run builds (worker)", action: "run_command" },
  { name: "git (worker)", action: "run_command" },
  { name: "package managers (worker)", action: "run_command" },
  { name: "debugging (worker)", action: "run_command" },
  { name: "api testing (worker)", action: "run_command" },
];

const WORKER_RESEARCH_TOOLS: string[] = [
  "web search (worker)",
  "web browsing (worker)",
  "documentation lookup",
  "assigned research sources",
  "data extraction",
];

const WORKER_COMMUNICATION: { name: string; action?: string }[] = [
  { name: "send result to department agent", action: "subagent_result" },
  { name: "receive instructions (worker)" },
  { name: "request another worker" },
  { name: "report failure" },
  { name: "report completion", action: "subagent_result" },
  { name: "attach files" },
  { name: "attach logs" },
];

const WORKER_MEMORY: string[] = [
  "task context",
  "relevant department knowledge (read-only)",
  "project context",
  "own execution history",
  "relevant skills",
];

// Financial access: §4f says most Workers get NONE, and only a narrow
// per-task allowance where a task genuinely requires external spend —
// seeded as a single named capability so it's visible in the registry
// (list_available_tools, Phase 2i(e), can answer "does this Worker
// role have any financial access at all"), lifecycle "task" (not
// "persistent" — "provisioned per-task, not as a standing budget", §4f
// verbatim) and cost unit "usd" with no ceiling amount (the actual $
// figure is task-specific, set at grant time by Phase 2i(c)'s resolver,
// not a fixed number this seed can know in advance).
const WORKER_FINANCIAL: string[] = ["task-scoped external spending allowance"];

function reasoningRows(
  names: string[],
  permissionLevel: PermissionLevel[],
  scopeTemplate: ScopeTemplate,
  lifecycle: Lifecycle,
  descPrefix: string,
): SeedRow[] {
  return names.map((name) => ({
    name,
    description: `${descPrefix}: ${name}`,
    inputSchema: NO_SCHEMA,
    ...COMPUTE_NO_CEILING,
    permissionLevel,
    scopeTemplate,
    lifecycle,
  }));
}

function actionRows(
  items: { name: string; action?: string }[],
  permissionLevel: PermissionLevel[],
  scopeTemplate: ScopeTemplate,
  lifecycle: Lifecycle,
  descPrefix: string,
): SeedRow[] {
  return items.map(({ name, action }) => ({
    name,
    description: action
      ? `${descPrefix}: ${name} (runtime ACTION: ${action})`
      : `${descPrefix}: ${name} (no dedicated runtime ACTION yet)`,
    inputSchema: action ? { action } : NO_SCHEMA,
    ...COMPUTE_NO_CEILING,
    permissionLevel,
    scopeTemplate,
    lifecycle,
  }));
}

function walletRows(
  items: { name: string; action?: string; unit: "usd" }[],
  permissionLevel: PermissionLevel[],
  scopeTemplate: ScopeTemplate,
  lifecycle: Lifecycle,
  descPrefix: string,
): SeedRow[] {
  return items.map(({ name, action }) => ({
    name,
    description: action
      ? `${descPrefix}: ${name} (runtime ACTION: ${action})`
      : `${descPrefix}: ${name} (no dedicated runtime ACTION yet)`,
    inputSchema: action ? { action } : NO_SCHEMA,
    costUnit: "usd" as const,
    permissionLevel,
    scopeTemplate,
    lifecycle,
  }));
}

// ───────────────────────────────────────────────────────────────────
// next-phase.md Phase 2i(e) — architecture-agent.md §7's
// `list_available_tools(tier?, role?, departmentType?)` Introspection
// addition, given its own registry rows rather than staying pure
// dispatch-side metadata. Phase 2i(e) originally left this as an
// explicitly open, undecided question ("a future pass may prefer the
// registry-row version for consistency with everything else
// list_available_tools itself reports on") because adding it meant
// touching this file — outside that pass's own declared "Touches:
// backend/agent-runtime/src/tools.ts" line. This pass makes that call:
// registry-row, for exactly the reason left on file — without a row
// here, asking `list_available_tools(tier="worker")` could never see
// itself in its own answer, which reads as a gap in an introspection
// tool specifically. tools.ts's dispatch gate is UNCHANGED by this —
// list_available_tools is still exempt from the profile-check gate by
// name (checked before resolveRegistryActionNames() is even called,
// per tools.ts's own doc comment on why: asking what you'd be granted
// isn't itself a use of a granted capability), so these rows are not
// what makes the tool callable. They exist purely so the tool is
// visible in its own — and every other tier/role's — reported list,
// the same way every other capability in this file is.
//
// One row per tier, not one shared row with permissionLevel spanning
// all three: this file's own test suite (toolRegistrySeedData.test.ts,
// "no Department-Agent row is ever also Agent-tier or Worker-tier —
// tiers are disjoint per row") already enforces that every row's tier
// set be a single tier, matching every other capability in §4d/§4e/§4f
// — introspection isn't a special case that should get to violate that
// invariant just because the same underlying ACTION backs all three.
// Names are therefore distinct per tier (registry names are globally
// unique, checked by assertNoDuplicateNames()), and each row's own
// scope/lifecycle matches its tier's existing convention exactly (see
// AGENT_REASONING/DEPT_REASONING/WORKER_REASONING's own scope/lifecycle
// choices just below/above) rather than inventing a fourth convention.
// ───────────────────────────────────────────────────────────────────
const AGENT_INTROSPECTION: { name: string; action?: string }[] = [
  { name: "list available tools (agent tier)", action: "list_available_tools" },
];
const DEPT_INTROSPECTION: { name: string; action?: string }[] = [
  { name: "list available tools (department agent tier)", action: "list_available_tools" },
];
const WORKER_INTROSPECTION: { name: string; action?: string }[] = [
  { name: "list available tools (worker tier)", action: "list_available_tools" },
];

export const SEED_ROWS: SeedRow[] = [
  // §4d — Agent tier, all persistent, all company_wide, all departmentTypes NULL
  ...reasoningRows(AGENT_REASONING, ["agent"], "company_wide", "persistent", "Agent reasoning"),
  ...actionRows(AGENT_COMPANY_MANAGEMENT, ["agent"], "company_wide", "persistent", "Agent company management"),
  ...actionRows(AGENT_WORKFORCE, ["agent"], "company_wide", "persistent", "Agent workforce (company-wide)"),
  ...reasoningRows(AGENT_INTERNET_INTELLIGENCE, ["agent"], "company_wide", "persistent", "Agent internet intelligence"),
  ...reasoningRows(AGENT_PRODUCT_CREATION, ["agent"], "own_container", "persistent", "Agent product creation"),
  ...actionRows(AGENT_FILES_REPOS, ["agent"], "own_office", "persistent", "Agent files & repositories"),
  ...actionRows(AGENT_DATABASE, ["agent"], "own_container", "persistent", "Agent database"),
  ...actionRows(AGENT_FINANCE, ["agent"], "company_wide", "persistent", "Agent company finance"),
  ...walletRows(AGENT_WALLET, ["agent"], "own_office", "persistent", "Agent wallet"),
  ...reasoningRows(AGENT_CUSTOMER_ACQUISITION, ["agent"], "company_wide", "persistent", "Agent customer acquisition"),
  ...reasoningRows(AGENT_SELF_IMPROVEMENT, ["agent"], "own_office", "persistent", "Agent self-improvement (never delegated)"),
  ...actionRows(AGENT_INTROSPECTION, ["agent"], "company_wide", "persistent", "Agent introspection"),

  // §4e — Department Agent tier, department-type-unrestricted rows
  ...reasoningRows(DEPT_REASONING, ["department_agent"], "assigned_department", "persistent", "Department Agent reasoning"),
  ...actionRows(DEPT_MANAGEMENT, ["department_agent"], "assigned_department", "persistent", "Department management"),
  ...reasoningRows(DEPT_MEMORY, ["department_agent"], "assigned_department", "persistent", "Department memory"),
  ...walletRows(DEPT_FINANCE, ["department_agent"], "assigned_department", "persistent", "Department finance"),
  ...reasoningRows(DEPT_COMMUNICATION, ["department_agent"], "assigned_department", "persistent", "Department communication"),
  ...actionRows(DEPT_INTROSPECTION, ["department_agent"], "assigned_department", "persistent", "Department Agent introspection"),

  // §4f — Worker tier, task-scoped
  ...reasoningRows(WORKER_REASONING, ["worker"], "own_office", "task", "Worker reasoning"),
  ...actionRows(WORKER_TASK_TOOLS, ["worker"], "own_office", "task", "Worker task tools"),
  ...actionRows(WORKER_COMPUTE, ["worker"], "own_container", "task", "Worker compute"),
  ...actionRows(WORKER_DEV_TOOLS, ["worker"], "own_container", "task", "Worker development tools"),
  ...reasoningRows(WORKER_RESEARCH_TOOLS, ["worker"], "own_container", "task", "Worker research tools"),
  ...actionRows(WORKER_COMMUNICATION, ["worker"], "own_office", "task", "Worker communication"),
  ...reasoningRows(WORKER_MEMORY, ["worker"], "own_office", "task", "Worker memory"),
  ...actionRows(WORKER_INTROSPECTION, ["worker"], "own_office", "task", "Worker introspection"),
  ...(WORKER_FINANCIAL.map((name) => ({
    name,
    description: `Worker financial access: ${name} — narrow, provisioned per-task, never a standing budget (§4f)`,
    inputSchema: NO_SCHEMA,
    costUnit: "usd" as const,
    permissionLevel: ["worker"] as PermissionLevel[],
    scopeTemplate: "assigned_project" as ScopeTemplate,
    lifecycle: "task" as Lifecycle,
  }))),
];

// ───────────────────────────────────────────────────────────────────
// §4e's per-department-type table — sourced directly from
// departmentToolProfiles.ts (Phase 2f-i), not retyped, so this seed
// cannot drift from that already-locked table. Every capability name
// shared by more than one department type in DEPARTMENT_TOOL_PROFILES
// (e.g. "logs" in Software/Security/Server) is collapsed into ONE row
// with every owning type listed in departmentTypes — §9's
// `departmentTypes?: string[]` is a list for exactly this reason.
// ───────────────────────────────────────────────────────────────────
const capabilityToTypes = new Map<string, Set<DepartmentType>>();
for (const [deptType, tools] of Object.entries(DEPARTMENT_TOOL_PROFILES) as [DepartmentType, string[]][]) {
  for (const tool of tools) {
    const key = tool.toLowerCase();
    if (!capabilityToTypes.has(key)) capabilityToTypes.set(key, new Set());
    capabilityToTypes.get(key)!.add(deptType);
  }
}

for (const [capability, types] of capabilityToTypes) {
  const actions = CAPABILITY_TO_ACTIONS[capability] ?? [];
  SEED_ROWS.push({
    name: `department.${capability.replace(/\s+/g, "_")}`,
    description:
      actions.length > 0
        ? `Department-type tool (§4e table): ${capability} (runtime ACTIONs: ${actions.join(", ")})`
        : `Department-type tool (§4e table): ${capability} (no dedicated runtime ACTION yet)`,
    inputSchema: actions.length > 0 ? { actions } : NO_SCHEMA,
    costUnit: "compute",
    permissionLevel: ["department_agent"],
    departmentTypes: Array.from(types),
    scopeTemplate: "assigned_department",
    lifecycle: "persistent",
  });
}

/**
 * Pure duplicate-name check over SEED_ROWS — no DB access. Exported so
 * both seedToolRegistry.ts (before writing to the DB) and this file's
 * own test suite can call the identical check, rather than the test
 * re-implementing a second copy that could drift from the real guard.
 */
export function assertNoDuplicateNames(rowsToCheck: SeedRow[]): void {
  const seen = new Map<string, number>();
  for (const row of rowsToCheck) {
    seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
  }
  const dupes = Array.from(seen.entries()).filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    throw new Error(
      `toolRegistrySeedData.ts: duplicate tool_registry name(s) within SEED_ROWS: ` +
        dupes.map(([name, count]) => `"${name}" (x${count})`).join(", ") +
        ` — each capability across §4d/§4e/§4f must map to a distinct registry name.`,
    );
  }
}
