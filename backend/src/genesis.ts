import { promises as fsPromises } from "node:fs";
import path from "path";
import { createCloneShell } from "./cloning.js";
import { createClonedAgentWallet, signPaymentAuthorization, getAgentPrivateKeyHex } from "./wallet.js";
import { settleAuthorization } from "./facilitator.js";
import { recordToolGrants } from "./toolGrants.js";
import { officeConfigSystemPromptPath } from "./office.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { addKnowledge, getKnowledgeById, type KnowledgeProvenance } from "./knowledgeStore.js";
import {
  getOpportunity,
  getExpansionDecision,
  getGenesisTrigger,
  markGenesisTriggerCompleted,
  setGenesisExecutor,
  compileStrategyReport,
  getCurrentResearchFinding,
  getCurrentStrategyFinding,
  formatMarketSignalEntry,
  type DecideExpansionSnapshot,
  type ExpansionDecision,
  type GenesisTriggerContext,
  type MarketSizeEstimate,
  type CompetitionSurvey,
  type CustomerSegmentsFinding,
  type ResearchConfidence,
  type TechnologyReuseCheckRecord,
} from "./expansion.js";
import {
  checkGenesisSpawnCapacity,
  checkPortfolioSpendCapacity,
  checkPortfolioFundingRoom,
  haltExpansionPipeline,
} from "./expansionCircuitBreaker.js";
import { spawnAgentProcess } from "./orchestrator.js";
import { runFirstTickSmokeTest, TickSmokeTestFailure } from "./genesisSmokeTest.js";
import { checkTickConstitutionCompliance, ConstitutionComplianceFailure } from "./genesisConstitutionCheck.js";
import { markGenesisPending, activateGenesisAgent, markGenesisActivationFailed } from "./genesisActivation.js";
import { schedulePostLaunchReview } from "./postLaunchReview.js";
import { registerGenesisIdentity } from "./genesisErc8004.js";
import { emitEvent } from "./ecosystemEvents.js";

/**
 * Zent.md Phase 16 — "Genesis Engine: Provisioning."
 *
 * 16a. "genesis_company(opportunity_id) — the function `approved`
 *      decisions call; wraps the existing spawn_clone path rather than
 *      re-implementing wallet/sandbox creation."
 *
 * This is the function Phase 15d's fireGenesisTrigger() (expansion.ts)
 * has been calling into a no-op default executor for since that phase
 * landed — see registerGenesisEngine() at the bottom of this file, and
 * index.ts's one-line call to it, for how genesisCompany() becomes the
 * real executor in place of expansion.ts's own defaultGenesisExecutor().
 * Nothing about the wiring in expansion.ts changes for this: 15d's own
 * header already named this exact seam ("Phase 16a replaces it with the
 * real genesis_company() via setGenesisExecutor() at app wire-up time
 * ... with zero changes required here or in decideExpansion() itself").
 *
 * "Wraps the existing spawn_clone path" means exactly the two-call
 * sequence architecture-agent.md §5 / this repo's cloning.ts module doc
 * already define for the Docker-sandboxed clone mechanism: cloning.ts's
 * createCloneShell() (mints an agent_id, stands up a bare sandbox) then
 * wallet.ts's createClonedAgentWallet() (claims that shell, mints a real
 * wallet, copies the parent's skills/system-prompt/constitution config,
 * migrates the sandbox to the wallet address, writes the `agents` row).
 * Neither function is modified by this phase — same "reused as-is"
 * posture Zent.md's own "Notes on scope" section states for
 * wallet.ts/resourceQuotas.ts/erc8004Trust.ts/marketplace.ts.
 *
 * Zent.md Phase 16b — "Funding wire-up: Finance's Phase 9 sizing
 * recommendation becomes the actual spawn_clone funding argument,
 * clamped to the existing per-call/per-day caps — Finance proposes, the
 * cap still governs."
 *
 * Agent B comes out of createClonedAgentWallet() at zero balance, same
 * as any other call to it (cloning.ts's own module doc: "no inherited
 * funds"). This phase spends Finance's recommendedFundingUsdc (sitting
 * on the genesis_triggers row since Phase 15d) via the same two-call
 * sequence every other USDC transfer in this backend goes through:
 * wallet.ts's signPaymentAuthorization() (this phase's own extraction of
 * the `/:address/pay` route's signing logic into an in-process-callable
 * function, the same "extracted from its own route for exactly this
 * kind of in-process caller" move facilitator.ts's settleAuthorization()
 * already made) to sign, then facilitator.ts's settleAuthorization()
 * itself to actually move the funds on-chain. See fundGenesisCompany()
 * below for the clamping and the "how much has this parent already
 * disbursed today" accounting.
 *
 * Zent.md Phase 16c — "Sandbox/VM provisioning reused as-is from the
 * existing clone path; no new infra code, just a new caller."
 *
 * Nothing to add here beyond what 16a already wired: createCloneShell()
 * stands up the Docker sandbox (cloning.ts's own createNamedSandbox()
 * call) and createClonedAgentWallet() migrates it to the real wallet
 * address — genesisCompany() calling those two functions in sequence
 * (16a) IS 16c's "new caller." No infra code lives in this file.
 *
 * Zent.md Phase 16d — "Tool grant scoping from Strategy's Phase 12c
 * relationship type: independent gets the default grant set,
 * supplier-to-sibling gets an additional grant to call the sibling's
 * marketplace listing."
 *
 * "independent" (12c's default) and "shared-customer-base" (12c's
 * third label, not named by 16d's own text) both leave Agent B at
 * exactly the default grant set createClonedAgentWallet()'s own
 * assignTools("agent") call already gives it — nothing to add for
 * either. Only "supplier-to-sibling" adds anything: an additional,
 * persistent `tool_grants` row for `buy_from_marketplace`, scoped
 * (toolGrants.ts's own `scopeKey` field, via this phase's new
 * `persistentScopeKeys` option on recordToolGrants()) to the specific
 * listing id Strategy's recommendation named — see
 * scopeGenesisToolGrants() below for the full reasoning, including why
 * a since-paused/archived listing is a no-op here, not an error.
 *
 * Zent.md Phase 16e — "`company_lineage` row written with `spawn_reason =
 * 'expansion_pipeline'` and `opportunity_id` set, so this birth is
 * distinguishable from a self-directed `spawn_clone` forever after."
 *
 * db.ts's own Phase 1e comment already named this function as the one
 * future writer of those two columns; see tagCompanyLineage() below for
 * the single UPDATE that does it. Fired right after
 * createClonedAgentWallet() returns (the row exists at its default
 * spawn_reason = 'self' the instant that call commits — this is the
 * very next statement, not deferred to the end of the function), same
 * "not caught here" posture as 16b/16d: a throw here propagates to
 * fireGenesisTrigger()'s own catch and leaves the trigger 'pending'
 * rather than 'completed' on a company whose lineage tag never landed.
 * Ordered before funding/tool-grant scoping rather than after — nothing
 * downstream in this function reads spawn_reason/opportunity_id back,
 * so there's no dependency either way; done first simply because
 * "this agent exists and here's why" is the most basic fact about
 * Agent B, true before a single dollar has moved or a grant has been
 * scoped.
 *
 * Zent.md Phase 17a — "Genesis Prompt builder: assembles Agent B's
 * mission text from the opportunity's title/thesis + Strategy's
 * recommended direction — produces exactly the kind of prompt shown
 * in chat ('You are Company B. Your mission is...')."
 *
 * buildGenesisPrompt() (pure, no side effects) assembles the text;
 * writeGenesisPrompt() (below it) is this phase's own "wire it in"
 * half — it's not enough for the prompt to exist as a return value
 * nobody reads, so this phase also files it where Agent B's own
 * agent-runtime process will actually pick it up:
 * officeConfigSystemPromptPath() (office.ts), the one per-agent file
 * that process already appends to its own base prompt for every
 * agent, pipeline-spawned or not. Called from genesisCompany() right
 * after 16e's lineage tag — see that call site below for why mission
 * text comes before funding/tool-grant scoping in this function's own
 * sequence.
 *
 * Zent.md Phase 17b — "Constitution inheritance reused unmodified from
 * the existing spawn_clone path — Agent B gets the same three-law
 * constitution, hash-verified on boot, no exceptions carved out for
 * pipeline-spawned companies."
 *
 * Same "16c: nothing to build" posture as Phase 16's own sandbox-reuse
 * sub-phase (see PHASE-16C-16D-NOTES.md): genesisCompany() calls
 * createClonedAgentWallet() unmodified (16a), which calls cloning.ts's
 * copyCloneConfig() unmodified (Phase 4d), which `fs.cp()`s the
 * parent's entire office/config/ directory — skills, system-prompt.md,
 * AND constitution.md — into Agent B's own config dir, byte-for-byte,
 * force: true. Nothing in this file reads, writes, or special-cases
 * constitution.md for a pipeline-spawned birth; there is no code path
 * here that could carve out an exception even by accident, since this
 * file never touches that file at all. "Hash-verified on boot" is a
 * property of whatever process boots Agent B's own reasoning loop and
 * reads its copied constitution.md at startup (agent-runtime's own
 * soul/constitution-guard.ts — recordGenesisHash()/
 * checkConstitutionIntegrity() — a separate package, a separate
 * boot-time concern, genuinely reused as-is, not something this
 * pipeline could plausibly re-implement or should try to). A named
 * test (`17b: ...` in genesisCompany_test.ts) was added so this phase
 * has an assertion of its own confirming the copy happens unmodified
 * and unconditionally for a genesis birth, rather than being silently
 * implied by 16a's own suite.
 *
 * Zent.md Phase 17c — "Mission field stored structurally (not just
 * prose in the prompt) so later Strategy passes (Phase 11b) can read
 * siblings' missions programmatically."
 *
 * buildStructuredMission() (pure — same opportunity+Strategy-recommendation
 * inputs 17a's own buildGenesisPrompt() reads, just returned as data
 * instead of assembled into prose) / writeStructuredMission() (this
 * phase's own "wire it in" half, mirroring 17a's own prompt/write split)
 * below. Written to the new `agents.mission` column (db.ts's own Phase
 * 17c migration, right above this file's agents.spawn_reason/
 * opportunity_id columns in that file) — a JSON `StructuredMission`
 * object, not a second copy of 17a's prose. Called from genesisCompany()
 * immediately after writeGenesisPrompt(), same "mission text is basic,
 * comes right after lineage, nothing downstream reads it back so no
 * ordering dependency" posture 17a's own call site already documents.
 *
 * This is the one change expansion.ts's listExistingCompanies() (Phase
 * 11b) header already named as its own future update: that function
 * now reads `agents.mission` first and only falls back to
 * reconstructing a mission from the opportunity's title+thesis for a
 * pipeline-spawned sibling genesis'd before this column existed. A
 * later Strategy pass calling it gets the richer, structural record —
 * including Strategy's own relationship-type reasoning from the
 * sibling's OWN birth, not just the opportunity's original thesis — for
 * every company genesis'd from this point on.
 *
 * Deliberately NOT in this session's scope (each is its own later
 * sub-phase, same one-focused-deliverable-per-letter discipline this
 * pipeline has followed since Phase 1):
 *
 *   - 17d (initial knowledge-base seed into knowledgeStore.ts), 17e
 *     (first-tick smoke test), and Phase 18 (ERC-8004 registration,
 *     ecosystem registry, marketplace listing) — Agent B comes out of
 *     this function as a real, missioned (as of this phase) but still
 *     unregistered, un-smoke-tested clone, until those phases run.
 *   - Enforcing the 16d grant. capability.ts's checkCapability() for
 *     marketplace_listing exec is documented (marketplace.ts's own
 *     comment on that check) as always-allow today — this phase files
 *     an honest, auditable record of the relationship (the "delegation
 *     ... machinery future per-listing restrictions would need," per
 *     that same comment), it does not make checkCapability() start
 *     consulting tool_grants. buy_from_marketplace already works
 *     against any active listing for any agent regardless of this row,
 *     same as before this phase.
 *
 * What this DOES do, beyond the bare two-call wrap:
 *
 *   - Validates the genesis trigger this opportunity's `approved` ruling
 *     already created (Phase 15d's recordGenesisTrigger(), called from
 *     fireGenesisTrigger() before this function is ever invoked) is
 *     still 'pending' — see the idempotency guard below for why a
 *     second call for the same opportunity is refused rather than
 *     silently provisioning a second Agent B.
 *   - Cross-checks the opportunity's latest CEO ruling is genuinely
 *     'approved' — defense in depth. decideExpansion() (expansion.ts)
 *     already guarantees this is true by construction (fireGenesisTrigger()
 *     is only ever called from the `approved` branch), so this should be
 *     unreachable in practice; checked anyway rather than trusting a
 *     future caller that might invoke genesisCompany() directly, outside
 *     the decideExpansion() -> fireGenesisTrigger() path this was
 *     designed for.
 *   - Resolves a company name for spawn_clone's own `name` argument from
 *     the opportunity's own title — Zent.md never specifies where that
 *     string should come from, and the opportunity's title is the only
 *     human-legible description of what Agent B is for that exists
 *     anywhere in this pipeline by the time genesis fires.
 *   - Disburses Finance's recommendedFundingUsdc to the new wallet
 *     (fundGenesisCompany(), 16b) — clamped to both funding caps, $0 if
 *     Finance recommended nothing or today's per-agent cap is already
 *     spent, no operator step anywhere in between.
 *   - Marks the trigger 'completed' (expansion.ts's own
 *     markGenesisTriggerCompleted()) once every call above succeeds.
 *
 * Error handling: a failure in createCloneShell(), createClonedAgentWallet(),
 * or fundGenesisCompany() is NOT caught here — it propagates up to
 * fireGenesisTrigger()'s own .catch() (expansion.ts), which marks the
 * trigger 'failed' with the error message and leaves the CEO's
 * `approved` ruling itself untouched (15d's own documented posture: a
 * provisioning failure does not reopen a decision). This function has
 * nothing to add to that handling, so it doesn't duplicate it.
 */

export interface GenesisCompanyResult {
  opportunityId: string;
  agentAddress: string;
  name: string;
  slug: string;
  sandboxId: string;
  cloneShellId: string;
  /** 16b: the USDC amount actually disbursed to Agent B at birth — 0 if
   *  funding was skipped (see fundedSkippedReason). Never above either
   *  of config.maxCloneFundingUsdcPerCall / ...PerAgentPerDay. */
  fundedUsdc: number;
  /** 16b: the payments.id row settleAuthorization() wrote for the
   *  funding transfer, or null if fundedUsdc is 0. */
  fundingPaymentId: string | null;
  /** 16b: why fundedUsdc is 0, or null if funding actually went out.
   *  One of "no-recommendation" (Finance recommended $0 or the
   *  recommendation field was never set), "day-cap-exhausted" (this
   *  parent already disbursed config.maxCloneFundingUsdcPerAgentPerDay
   *  in clone-funding today, before this genesis event), or (Zent.md
   *  19b) "portfolio-cap-exhausted" (this parent's total lifetime
   *  clone-funding has reached config.portfolioSpendCapFraction of its
   *  lifetime settled revenue — see expansionCircuitBreaker.ts's
   *  checkPortfolioFundingRoom()). Never thrown — Agent B is still a
   *  real, provisioned company at $0 either way; see this file's header
   *  for why a zero-funded birth is a valid outcome here, not a
   *  failure. */
  fundingSkippedReason: "no-recommendation" | "day-cap-exhausted" | "portfolio-cap-exhausted" | null;
  /** 16d: the additional supplier-to-sibling marketplace grant Agent B
   *  was given at birth, or null if Strategy's relationship-type
   *  recommendation was "independent"/"shared-customer-base", was never
   *  filed, or named a sibling with no currently-live listing — see
   *  scopeGenesisToolGrants()'s own header for why each of those is a
   *  normal outcome, not a failure. */
  supplierToSiblingGrant: SupplierToSiblingGrant | null;
  /** 17a: the exact text buildGenesisPrompt() produced and
   *  writeGenesisPrompt() filed into Agent B's own
   *  officeConfigSystemPromptPath() — returned here too so a caller
   *  (a route, a test, an ops log) doesn't have to re-derive it or go
   *  re-read the file to know what Agent B was actually told its
   *  mission is. */
  genesisPrompt: string;
  /** 17c: the same mission, as data — buildStructuredMission()'s
   *  output, exactly what writeStructuredMission() filed into
   *  agents.mission. Returned here for the same reason genesisPrompt
   *  is: a caller shouldn't have to re-query the row it just caused to
   *  be written. */
  mission: StructuredMission;
  /** 17d-i-a: the knowledge_store row id seedMarketSizeKnowledge() wrote
   *  for Agent B, or null if Research never ran estimate_market_size
   *  (5b) for this opportunity — a normal outcome, not a failure; see
   *  seedMarketSizeKnowledge()'s own header. Returned here for the same
   *  "caller shouldn't have to re-query" reason genesisPrompt/mission
   *  already are. */
  marketSizeKnowledgeId: string | null;
  /** 17d-i-b: the knowledge_store row id seedCompetitionKnowledge() wrote
   *  for Agent B, or null if Research never ran survey_competition (5c)
   *  for this opportunity — a normal outcome, not a failure; see
   *  seedCompetitionKnowledge()'s own header. Returned here for the same
   *  "caller shouldn't have to re-query" reason marketSizeKnowledgeId
   *  already is. */
  competitionKnowledgeId: string | null;
  /** 17d-i-c: the knowledge_store row id seedCustomerSegmentsKnowledge()
   *  wrote for Agent B, or null if Research never ran
   *  identify_customer_segments (5d) for this opportunity — a normal
   *  outcome, not a failure; see seedCustomerSegmentsKnowledge()'s own
   *  header. Returned here for the same "caller shouldn't have to
   *  re-query" reason marketSizeKnowledgeId/competitionKnowledgeId
   *  already are. Completes the Research handoff Zent.md 17d-i names:
   *  market/competitor/customer context all exist before Agent B's
   *  first tick. */
  customerSegmentsKnowledgeId: string | null;
  /** 17d-II: the knowledge_store row id seedTechnologyReuseKnowledge()
   *  wrote for Agent B, or null if Strategy never ran
   *  check_technology_reuse (11d) for this opportunity — a normal
   *  outcome, not a failure; see seedTechnologyReuseKnowledge()'s own
   *  header. Returned here for the same "caller shouldn't have to
   *  re-query" reason marketSizeKnowledgeId/competitionKnowledgeId/
   *  customerSegmentsKnowledgeId already are. Distinct from those three
   *  (Research's handoff, 17d-i): this one is Strategy's own "what I
   *  can reuse to build this" note, not another slice of market
   *  context. */
  technologyReuseKnowledgeId: string | null;
  /** PHASE-17D-IV: config.agentIdentityDataDir/{agentAddress} —
   *  the directory provisionAgentRuntimeIdentity() wrote Agent B's
   *  wallet.json/automaton.json into, and the same directory
   *  AUTOMATON_CONFIG_DIR points at for every process this backend
   *  ever spawns for this agent (orchestrator.ts). Returned for the
   *  same "caller shouldn't have to re-derive it" reason genesisPrompt/
   *  mission already are. */
  agentIdentityDir: string;
}

// ─── Phase 16b: funding wire-up ──────────────────────────────────────

/** Own local todayUtc() rather than importing resourceQuotas.ts's
 *  private one — same "two independent files, no dependency edge"
 *  duplication that file's own header already documents for its copy
 *  of distribution.ts's todayUtc(). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

/** Sum, in whole USDC, of everything `fromAddress` has already sent
 *  today (UTC) with purpose = 'clone-funding' — db.ts's own payments
 *  table comment already names 'clone-funding' as this purpose
 *  string's documented example, so this reads that same convention
 *  rather than inventing a parallel counter table. Includes 'pending'
 *  and 'settled' rows (a payment is a real commitment against the cap
 *  the moment it's inserted — facilitator.ts's settleAuthorization()
 *  INSERTs before the on-chain call, same "committed at signing, not
 *  at confirmation" posture wallet.ts's own logDepartmentSpend() takes)
 *  but not 'failed' ones (a failed transfer never moved anything,
 *  so it shouldn't count against a spend cap). value_usdc is stored
 *  as a stringified atomic-unit (6-decimal) integer — see wallet.ts's
 *  signPaymentAuthorization()/facilitator.ts's settleAuthorization()
 *  for why — so this divides back down rather than treating the column
 *  as already-human USDC. */
function cloneFundingDisbursedTodayUsdc(fromAddress: string, day: string = todayUtc()): number {
  const dayStartMs = new Date(`${day}T00:00:00.000Z`).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT value_usdc FROM payments
       WHERE from_address = ? AND purpose = 'clone-funding' AND status IN ('pending', 'settled')
         AND created_at >= ? AND created_at < ?`,
    )
    .all(fromAddress, dayStartMs, dayEndMs) as { value_usdc: string }[];
  return rows.reduce((sum, row) => sum + Number(row.value_usdc) / 1_000_000, 0);
}

/**
 * Disburses Finance's recommendedFundingUsdc to a freshly-provisioned
 * Agent B — the actual funds-moving half of 16b, called from
 * genesisCompany() below right after the shell/wallet exist. Not
 * exported: genesisCompany() is the one public entry point 16b adds to
 * (same "one seam, not two" posture the rest of this file takes), and
 * this helper's signature (raw numbers/addresses, not an opportunityId)
 * would need the caller to already have done genesisCompany()'s own
 * trigger/decision validation anyway.
 *
 * Clamps twice, both hard ceilings (config.ts's own 9b comment: "there
 * is no code path through [computeSizingRecommendation] that can return
 * a number above either cap" — this is that same pair of numbers'
 * *second*, disbursement-time check, not a duplicate of the first):
 *
 *   1. Never sends more than config.maxCloneFundingUsdcPerCall for this
 *      one opportunity, regardless of what Finance recommended.
 *   2. Never lets fromAddress's SAME-DAY clone-funding total exceed
 *      config.maxCloneFundingUsdcPerAgentPerDay — if today's prior
 *      disbursements already consumed the whole cap, this genesis event
 *      gets $0, not a partial top-up of "whatever's left" (an amount
 *      that small would rarely be enough to matter and would silently
 *      encourage recommendedFundingUsdc to be read as a suggestion
 *      rather than a real number); if there's room but not the full
 *      recommendation, it's clamped down to what's left.
 *
 * A recommendation of null or <= 0 (Finance's own "no-fund" case —
 * expansionRoutes.ts's own sizingRecommendation.recommendedFundingUsdc
 * <= 0 → "no-fund" decision comment) is never an error here: Agent B
 * is still genuinely provisioned, just capitalized at $0 by Finance's
 * own call, not this function's.
 */
async function fundGenesisCompany(
  fromAddress: string,
  toAddress: string,
  recommendedFundingUsdc: number | null,
): Promise<{
  fundedUsdc: number;
  fundingPaymentId: string | null;
  fundingSkippedReason: GenesisCompanyResult["fundingSkippedReason"];
}> {
  if (recommendedFundingUsdc === null || recommendedFundingUsdc <= 0) {
    return { fundedUsdc: 0, fundingPaymentId: null, fundingSkippedReason: "no-recommendation" };
  }

  const perCallClamped = Math.min(recommendedFundingUsdc, config.maxCloneFundingUsdcPerCall);
  const disbursedToday = cloneFundingDisbursedTodayUsdc(fromAddress);
  const roomLeftToday = Math.max(0, config.maxCloneFundingUsdcPerAgentPerDay - disbursedToday);
  // Zent.md 19b's third clamp, same "clamp to what's left" shape as the
  // day-cap clamp just above — the portfolio-wide backstop on top of
  // the per-call and per-day ceilings. genesisCompany()'s own
  // checkPortfolioSpendCapacity() call already rejects outright once
  // disbursedUsdc >= capUsdc; this covers the case where there's still
  // some room, but less than this call's recommendation/day-cap would
  // otherwise send.
  const roomLeftInPortfolio = checkPortfolioFundingRoom(fromAddress);
  const amountUsdc = Math.min(perCallClamped, roomLeftToday, roomLeftInPortfolio);

  if (amountUsdc <= 0) {
    const skipReason: GenesisCompanyResult["fundingSkippedReason"] =
      roomLeftInPortfolio <= 0 ? "portfolio-cap-exhausted" : "day-cap-exhausted";
    return { fundedUsdc: 0, fundingPaymentId: null, fundingSkippedReason: skipReason };
  }

  // Same two-call sequence every other USDC transfer in this backend
  // goes through: sign (wallet.ts), then settle (facilitator.ts) — see
  // this file's own header for why each is reused unmodified rather
  // than genesis.ts growing its own third way to move funds.
  // paymentChannelRequired()'s Day-1 clone-funding carve-out
  // (channelService.ts) is what lets this sign without a payment
  // channel: Agent B's parent_address is fromAddress, and this is
  // necessarily Agent B's very first payment (it was born microseconds
  // ago in genesisCompany() above).
  const signed = await signPaymentAuthorization(fromAddress as `0x${string}`, toAddress, amountUsdc, {
    purpose: "clone-funding",
  });
  const settled = await settleAuthorization(signed.payload.authorization, signed.payload.signature, "clone-funding");
  if (!settled.success) {
    // Propagates up to genesisCompany()'s own caller exactly like a
    // createCloneShell()/createClonedAgentWallet() failure would — see
    // this file's header's "Error handling" section. Agent B's shell
    // and wallet already exist by the time this can happen; a
    // funding-only failure leaving a real, zero-funded Agent B behind
    // is a known gap (same category as 16a's own "failed trigger's own
    // retry path is a later phase's job" note), not something this
    // session adds recovery logic for.
    throw new Error(
      `genesis_company: funding transfer from ${fromAddress} to ${toAddress} failed: ` +
        `${(settled.body as { error?: string }).error ?? "unknown facilitator error"}`,
    );
  }

  return {
    fundedUsdc: amountUsdc,
    fundingPaymentId: (settled.body as { id?: string }).id ?? null,
    fundingSkippedReason: null,
  };
}

// ─── Phase 16d: tool grant scoping by relationship type ──────────────

/** Zent.md 16d's own listing lookup: the sibling's current live
 *  listing, if any — "gets an additional grant to call the sibling's
 *  marketplace listing" only means something if the sibling actually
 *  has one right now. No exported helper exists on marketplace.ts for
 *  this (every seller-scoped query there is inline in its own route
 *  handler); mirrors those same `active = 1 AND status = 'active'`
 *  terms rather than adding a marketplace.ts export for this one
 *  caller. Most-recently-created listing wins on the rare chance a
 *  seller has more than one live at once — no ordering guarantee
 *  beyond that is promised or needed here. */
function findActiveListingForSeller(sellerAddress: string): { id: string; name: string } | null {
  const row = db
    .prepare(
      `SELECT id, name FROM listings WHERE seller_address = ? AND active = 1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sellerAddress) as { id: string; name: string } | undefined;
  return row ?? null;
}

/** Result of one scopeGenesisToolGrants() pass — always non-throwing;
 *  see that function's own header for why "nothing to grant" is a
 *  normal outcome, not a failure. */
export interface SupplierToSiblingGrant {
  toolName: "buy_from_marketplace";
  listingId: string;
  listingName: string;
  siblingAddress: string;
}

/**
 * Zent.md 16d — see this file's header for the full independent /
 * supplier-to-sibling / shared-customer-base breakdown. Reads Strategy's
 * 12c recommendation (compileStrategyReport()'s own
 * relationshipTypeRecommendation section — that section's doc comment
 * in expansion.ts already names this exact function as its reader) and,
 * only for "supplier-to-sibling" with a still-live sibling listing,
 * records one additional persistent tool_grants row scoped to that
 * listing's id.
 *
 * Every other case — no recommendation filed yet (Strategy simply
 * hasn't run recommend_relationship_type for this opportunity),
 * "independent," "shared-customer-base," or a "supplier-to-sibling"
 * recommendation whose named sibling has since paused/archived its
 * listing (12c's recommendation can predate genesis by an arbitrary
 * number of decideExpansion() 'deferred' re-queue cycles) — returns
 * null and grants nothing beyond createClonedAgentWallet()'s own
 * default set. None of these are errors: a missing or stale
 * recommendation just means Agent B is born with the default grant set,
 * same as "independent" would have produced anyway.
 */
function scopeGenesisToolGrants(agentAddress: string, opportunityId: string): SupplierToSiblingGrant | null {
  const report = compileStrategyReport(opportunityId);
  const recommendation = report.relationshipTypeRecommendation?.result ?? null;
  if (!recommendation || recommendation.relationshipType !== "supplier-to-sibling") {
    return null;
  }
  if (!recommendation.withSiblingAddress) {
    // Unreachable per recommendRelationshipType()'s own contract
    // (withSiblingAddress is always set for a non-"independent" type) —
    // guarded anyway rather than trusting that invariant here.
    return null;
  }

  const listing = findActiveListingForSeller(recommendation.withSiblingAddress);
  if (!listing) {
    return null;
  }

  recordToolGrants(
    "agent",
    agentAddress,
    [
      {
        name: "buy_from_marketplace",
        description:
          `Zent.md 16d supplier-to-sibling grant: call ` +
          `${recommendation.withSiblingTitle ?? recommendation.withSiblingAddress}'s ` +
          `marketplace listing "${listing.name}".`,
        inputSchema: {},
        costUnit: "usd",
        costAmountPerCall: null,
        costAmountPerUnit: null,
        scopeTemplate: "",
        lifecycle: "persistent",
      },
    ],
    { persistentScopeKeys: { buy_from_marketplace: listing.id } },
  );

  return {
    toolName: "buy_from_marketplace",
    listingId: listing.id,
    listingName: listing.name,
    siblingAddress: recommendation.withSiblingAddress,
  };
}

// ─── Phase 16e: company_lineage tagging ───────────────────────────────

/** Zent.md 16e's own UPDATE — the two columns db.ts's Phase 1e migration
 *  already added to `agents` (`spawn_reason` NOT NULL DEFAULT 'self',
 *  `opportunity_id` nullable TEXT, no declared FK — see that migration's
 *  own comment for why this table intentionally doesn't cascade off
 *  `opportunities`) get their one and only writer here. Every other
 *  agent-creation path (createAgentWallet()'s fresh-key path,
 *  createClonedAgentWallet()'s own default for an ordinary
 *  self-directed spawn_clone call) leaves the row at its default —
 *  this function is called from exactly one place, genesisCompany()
 *  below, and only for a pipeline-spawned Agent B.
 *
 *  Not exported: same "one seam, not two" posture fundGenesisCompany()
 *  and scopeGenesisToolGrants() already take in this file — a second
 *  caller would mean lineage tagging happening outside the one function
 *  that's actually allowed to produce an 'expansion_pipeline' agent. */
function tagCompanyLineage(agentAddress: string, opportunityId: string): void {
  db.prepare(`UPDATE agents SET spawn_reason = 'expansion_pipeline', opportunity_id = ? WHERE address = ?`).run(
    opportunityId,
    agentAddress,
  );
  // Zent.md 17e-iv: the agent's "distinguishable pre-active state"
  // starts existing the same instant its lineage is tagged — before its
  // first tick has even run, let alone passed 17e-ii/17e-iii. See
  // genesisActivation.ts's own header for the full pending -> active |
  // failed state machine this seeds.
  markGenesisPending(agentAddress);
}

// ─── Phase 17a: Genesis Prompt builder ────────────────────────────────

/**
 * Zent.md 17a — see this file's own header for full scope. Pure
 * function: no DB access beyond the two read-only lookups below, no
 * file I/O, no side effects — writeGenesisPrompt() (right below) is
 * the half of this phase that actually files the result anywhere.
 *
 * Assembles exactly the two things Zent.md's own text names:
 *
 *   - opportunity.title / opportunity.thesis (Phase 1b's own columns)
 *     — the only mission-shaped text this pipeline has ever recorded
 *     for an opportunity; 11b's listExistingCompanies() already reads
 *     this same pair as its own mission stand-in until 17c gives
 *     Agent B a real structural field.
 *   - Strategy's 12c relationship-type recommendation
 *     (compileStrategyReport().relationshipTypeRecommendation) — its
 *     `reasoning` field is "Strategy's recommended direction" in
 *     Zent.md's own words for this phase: 12c's own doc comment
 *     already frames the recommendation as informing how Agent B's
 *     grants are scoped at birth (16d); this is that same finding
 *     showing up in Agent B's own mission text, not just its grant
 *     list. Omitted, not fabricated, when Strategy hasn't filed one
 *     yet for this opportunity — same "a missing recommendation just
 *     means the default" posture scopeGenesisToolGrants() (16d)
 *     already takes for this exact finding.
 *
 * Throws on an unknown opportunity_id, same "fail fast with a clear
 * message" posture every compile*Report() function in expansion.ts
 * already uses — unreachable in practice from genesisCompany() itself
 * (that function already resolves and validates the opportunity before
 * this is ever called), guarded anyway for any future direct caller
 * (a route, a test, an ops replay script) the way this file's other
 * exported functions already are.
 */
export function buildGenesisPrompt(opportunityId: string): string {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`build_genesis_prompt: opportunity ${opportunityId} not found`);
  }

  const lines: string[] = [
    `You are Company B. Your mission is: ${opportunity.thesis}`,
    ``,
    `You were founded to pursue this opportunity: "${opportunity.title}".`,
  ];

  const report = compileStrategyReport(opportunityId);
  const recommendation = report.relationshipTypeRecommendation?.result ?? null;
  if (recommendation) {
    lines.push(``);
    lines.push(
      `Strategy's recommended direction for how you relate to your parent company and its ` +
        `siblings: ${recommendation.relationshipType}. ${recommendation.reasoning}`,
    );
  }

  return lines.join("\n") + "\n";
}

/**
 * Zent.md 17a's own "wire it in" half — a prompt nobody reads doesn't
 * mission anything. officeConfigSystemPromptPath() (office.ts) is the
 * one per-agent file agent-runtime's own base-prompt builder already
 * appends to for every agent, pipeline-spawned or not (office.ts's own
 * DEFAULT_SYSTEM_PROMPT comment: "anything written here is appended,
 * not a replacement" for the base prompt).
 *
 * Prepended to whatever's already there, never overwritten:
 * createClonedAgentWallet() has already byte-for-byte copied the
 * PARENT's system-prompt.md into Agent B's own config dir by the time
 * this runs (cloning.ts's copyCloneConfig(), Phase 4d) — whatever
 * operational overrides Company A wrote for itself are still
 * legitimately useful to a sibling that otherwise starts from zero,
 * and this file's own "reused as-is" posture for everything upstream
 * of Phase 17 argues for keeping that content rather than discarding
 * it. The mission goes first, under its own heading, so genesis-
 * authored content is visually distinguishable from whatever the
 * parent had already written — for a human auditor, and for a later
 * self-mod tool call that might want to edit one without touching the
 * other.
 *
 * Not caught here, same posture as every other step in genesisCompany()
 * (see this file's header's "Error handling" section): a filesystem
 * failure propagates to fireGenesisTrigger()'s own catch and leaves
 * the trigger 'pending' rather than 'completed' on a company whose
 * mission never actually reached its own runtime.
 */
async function writeGenesisPrompt(agentAddress: string, opportunityId: string): Promise<string> {
  const prompt = buildGenesisPrompt(opportunityId);
  const path = officeConfigSystemPromptPath(agentAddress);
  const existing = await fsPromises.readFile(path, "utf8").catch(() => "");
  const section = `## Mission (Zent.md Phase 17a — genesis prompt)\n\n${prompt}`;
  const combined = existing.trim().length > 0 ? `${section}\n${existing}` : section;
  await fsPromises.writeFile(path, combined, "utf8");
  return prompt;
}

// ─── Phase 17c: mission field stored structurally ─────────────────────

/** The structural (JSON, `agents.mission`) counterpart to 17a's own
 *  prose prompt — see this file's header for the full rationale. Same
 *  fields buildGenesisPrompt() reads, kept separate rather than
 *  re-parsed out of that function's assembled text so a later reader
 *  (11b's listExistingCompanies(), a Strategy tool, an ops query) never
 *  has to scrape prose to get a fact this pipeline already has as data. */
export interface StructuredMission {
  opportunityId: string;
  title: string;
  thesis: string;
  /** Strategy's 12c relationship-type recommendation, if one had been
   *  filed by the time Agent B was genesis'd — null with no reasoning
   *  when it hadn't, same "omitted, not fabricated" posture
   *  buildGenesisPrompt() already takes for this exact finding. */
  relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
  relationshipReasoning: string | null;
}

/**
 * Zent.md 17c — pure function, no DB writes, no side effects. Reads
 * exactly the same two sources buildGenesisPrompt() (17a) does — same
 * opportunity, same compileStrategyReport() lookup — and returns them
 * as data instead of assembling them into prose. Kept as a separate
 * read rather than derived from buildGenesisPrompt()'s own string
 * output on purpose: parsing prose back out into fields is the exact
 * "scrape it out of a prompt" problem this phase exists to remove.
 *
 * Throws on an unknown opportunity_id, same posture buildGenesisPrompt()
 * already takes for the same reason — unreachable from genesisCompany()
 * itself, guarded for any future direct caller.
 */
export function buildStructuredMission(opportunityId: string): StructuredMission {
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`build_structured_mission: opportunity ${opportunityId} not found`);
  }

  const report = compileStrategyReport(opportunityId);
  const recommendation = report.relationshipTypeRecommendation?.result ?? null;

  return {
    opportunityId,
    title: opportunity.title,
    thesis: opportunity.thesis,
    relationshipType: recommendation?.relationshipType ?? null,
    relationshipReasoning: recommendation?.reasoning ?? null,
  };
}

/**
 * Zent.md 17c's own "wire it in" half, mirroring writeGenesisPrompt()'s
 * split. Files buildStructuredMission()'s result into the new
 * `agents.mission` column (db.ts's Phase 17c migration) as JSON — this
 * is the row's ONE writer, same "one seam, not two" posture
 * tagCompanyLineage() already documents for spawn_reason/opportunity_id:
 * every other agent-creation path (a fresh top-level agent, an ordinary
 * self-directed spawn_clone) leaves the column at its default NULL.
 */
function writeStructuredMission(agentAddress: string, opportunityId: string): StructuredMission {
  const mission = buildStructuredMission(opportunityId);
  db.prepare(`UPDATE agents SET mission = ? WHERE address = ?`).run(JSON.stringify(mission), agentAddress);
  return mission;
}

// ─── Zent.md Phase 17d-i-a: market-size knowledge seed ─────────────────
//
// "Market-size seed: estimate_market_size output (5b) for this
// opportunity is copied into Agent B's own knowledgeStore.ts at birth,
// under its own section, so market-sizing context exists before Agent
// B's first tick."
//
// Same read 17a's own buildGenesisPrompt() and 17c's buildStructuredMission()
// already do — one opportunity_id, no new inputs — but pulling the
// *research* finding this time instead of the opportunity/Strategy pair
// those two read. getCurrentResearchFinding() (expansion.ts) is Research's
// one source of truth for this: whatever the department's last
// (non-superseded) pass wrote, findings.market_size is 5b's own payload
// exactly as recordMarketSizeEstimate() persisted it — this function
// does not re-derive or re-search anything, it only copies what Research
// already found.
//
// "Under its own section" is implemented as its own knowledge_store
// `key` (`research:market_size:<opportunity_id>`) and its own `category`
// ("market", the closest of KnowledgeCategory's five buckets to what a
// market-size estimate actually is) — 17d-i-b/17d-i-c land as siblings
// under the same category with their own keys, so Agent B's first
// searchKnowledgeStore("market") call surfaces all three sections
// without any one of them clobbering another the way a single shared
// key would.
//
// A finding with no market_size section yet (Research never ran 5b, or
// only ran 5c/5d before its report was compiled) is a legitimate state,
// not an error — same "no good ideas this cycle" posture Zent.md 3e
// already normalizes for an empty pipeline outcome. This function is a
// no-op in that case: it returns null, genesisCompany() below doesn't
// treat that as a failure, and Agent B is simply born without a
// market-size section rather than with a fabricated one.

/** formatMarketSignalEntry() (Phase 2b) already turns a query + raw
 *  {title,url,snippet}[] into the exact legible block this repo's other
 *  knowledge-store writes use — reused here rather than re-formatting
 *  the same MarketSizeEstimate shape a second, slightly different way. */
function formatMarketSizeEstimate(estimate: MarketSizeEstimate): string {
  return formatMarketSignalEntry(estimate.query, estimate.results, estimate.estimatedAt, {
    toolName: "estimate_market_size",
    arg: estimate.query,
  });
}

/** Research's own self-reported confidence (5e) is a `low`/`med`/`high`
 *  enum on the finding as a whole, not a per-tool number — knowledgeStore's
 *  `confidence` column is 0–1 (addKnowledge()'s own default is 0.5, same
 *  file). Mapped here rather than in knowledgeStore.ts itself, which has
 *  no notion of Research's own confidence vocabulary; a finding that
 *  hasn't called report_research_confidence() yet (5e) falls back to
 *  addKnowledge()'s own 0.5 default rather than this function inventing
 *  a number Research never actually reported. */
const RESEARCH_CONFIDENCE_TO_SCORE: Record<ResearchConfidence, number> = {
  low: 0.3,
  med: 0.6,
  high: 0.9,
};

function researchConfidenceToScore(confidence: ResearchConfidence | undefined): number | undefined {
  return confidence ? RESEARCH_CONFIDENCE_TO_SCORE[confidence] : undefined;
}

/**
 * Zent.md Phase 17d-iii-a: builds the structured tag each of this file's
 * four 17d-i-a/b/c + 17d-II seed functions attaches to its addKnowledge()
 * call, so a seeded row is provably distinct from anything Agent B
 * learns on its own after birth. One shared builder rather than four
 * inline object literals — `seededAt` in particular has to be the exact
 * same instant across every seed genesisCompany() fires in the same
 * birth (not each function independently calling Date.now() a few
 * ticks apart), so it's a required argument here, sourced once by the
 * caller, rather than this function reaching for the clock itself.
 */
function buildSeedProvenance(
  opportunityId: string,
  reportId: string,
  department: KnowledgeProvenance["department"],
  seededAt: number,
): KnowledgeProvenance {
  return { opportunityId, reportId, department, seededAt };
}

/**
 * Zent.md 17d-i-a's own "wire it in" half. Reads opportunityId's current
 * research finding, and — if 5b actually ran — writes one knowledge_store
 * row for `agentAddress` (Agent B, always called with its own freshly
 * minted address, never Company A's) under category "market". Returns
 * the written entry's id, or null when there was nothing to seed.
 *
 * Source is `research_finding:<finding.id>` — the exact versioned row
 * this content came from, not just the opportunity — so a later reader
 * (17d-III, once it lands) can trace a knowledge_store entry back to
 * the specific Research pass that produced it, the same way every other
 * provenance-conscious write in this pipeline (tagCompanyLineage's
 * opportunity_id, writeStructuredMission's own fields) points at a row,
 * not a vague description.
 */
export function seedMarketSizeKnowledge(
  agentAddress: string,
  opportunityId: string,
  seededAt: number = Date.now(),
): string | null {
  const finding = getCurrentResearchFinding<{
    market_size?: MarketSizeEstimate;
    confidence?: ResearchConfidence;
  }>(opportunityId);
  const marketSize = finding?.findings.market_size;
  if (!finding || !marketSize) {
    return null;
  }

  return addKnowledge(agentAddress, {
    category: "market",
    key: `research:market_size:${opportunityId}`,
    content: formatMarketSizeEstimate(marketSize),
    source: `research_finding:${finding.id}`,
    confidence: researchConfidenceToScore(finding.findings.confidence),
    provenance: buildSeedProvenance(opportunityId, finding.id, "research", seededAt),
  });
}

// ─── Zent.md Phase 17d-i-b: competition knowledge seed ─────────────────
//
// "Competition seed: survey_competition output (5c) — incumbents,
// pricing tiers, gaps — is copied into knowledgeStore.ts as a distinct
// section from 17d-i-a, so Agent B can read 'how big' and 'who else is
// here' independently."
//
// Same shape as 17d-i-a in every structural way: one opportunity_id in,
// getCurrentResearchFinding()'s `competition` field out, formatted with
// the same formatMarketSignalEntry() helper 17d-i-a's
// formatMarketSizeEstimate() already wraps, and written under its own
// knowledge_store `key` (`research:competition:<opportunity_id>`) so a
// searchKnowledgeStore("market") call surfaces both sections side by
// side rather than one clobbering the other. Same category ("market")
// as 17d-i-a — a competitor survey is still market context, just a
// different slice of it than a size estimate — and the same
// `research_finding:<finding.id>` source convention, so this entry
// traces back to the exact versioned Research pass that produced it,
// not just the opportunity.
//
// A finding with no `competition` section yet (Research never ran 5c,
// or only ran 5b/5d before its report was compiled) is a legitimate
// state here too, not an error — this function returns null and
// genesisCompany() below treats that the same "born without this
// section rather than a fabricated one" way it already treats a missing
// market-size pass.

/** formatMarketSignalEntry() (Phase 2b) reused here for the same reason
 *  17d-i-a's formatMarketSizeEstimate() reuses it: CompetitionSurvey's
 *  `{query, results, surveyedAt}` shape is structurally identical to
 *  MarketSizeEstimate's `{query, results, estimatedAt}`, so this is the
 *  same formatter with survey_competition's own tool name/timestamp
 *  swapped in, not a second, slightly different reimplementation. */
function formatCompetitionSurvey(survey: CompetitionSurvey): string {
  return formatMarketSignalEntry(survey.query, survey.results, survey.surveyedAt, {
    toolName: "survey_competition",
    arg: survey.query,
  });
}

/**
 * Zent.md 17d-i-b's own "wire it in" half. Reads opportunityId's current
 * research finding, and — if 5c actually ran — writes one knowledge_store
 * row for `agentAddress` (Agent B, always its own freshly minted
 * address, never Company A's) under category "market", alongside
 * whatever 17d-i-a's seedMarketSizeKnowledge() already wrote (or didn't)
 * for the same opportunity. Returns the written entry's id, or null when
 * there was nothing to seed.
 *
 * Source is `research_finding:<finding.id>` — same provenance convention
 * seedMarketSizeKnowledge() already uses — so a later reader (17d-III,
 * once it lands) can trace this entry back to the specific Research pass
 * that produced it, not just the opportunity it belongs to.
 */
export function seedCompetitionKnowledge(
  agentAddress: string,
  opportunityId: string,
  seededAt: number = Date.now(),
): string | null {
  const finding = getCurrentResearchFinding<{
    competition?: CompetitionSurvey;
    confidence?: ResearchConfidence;
  }>(opportunityId);
  const competition = finding?.findings.competition;
  if (!finding || !competition) {
    return null;
  }

  return addKnowledge(agentAddress, {
    category: "market",
    key: `research:competition:${opportunityId}`,
    content: formatCompetitionSurvey(competition),
    source: `research_finding:${finding.id}`,
    confidence: researchConfidenceToScore(finding.findings.confidence),
    provenance: buildSeedProvenance(opportunityId, finding.id, "research", seededAt),
  });
}

// ─── Zent.md Phase 17d-i-c: customer-segments knowledge seed ───────────
//
// "Customer-segments seed: identify_customer_segments output (5d) is
// copied into knowledgeStore.ts as its own section, completing the
// Research handoff so market/competitor/customer context all exist
// before Agent B's first tick."
//
// Same shape as 17d-i-a/17d-i-b in every structural way: one
// opportunity_id in, getCurrentResearchFinding()'s `customer_segments`
// field out (CustomerSegmentsFinding — same {query, results,
// identifiedAt} raw-evidence shape MarketSizeEstimate/CompetitionSurvey
// already use, per expansion.ts's own comment on the type), formatted
// with the same formatMarketSignalEntry() helper 17d-i-a/17d-i-b's own
// formatters wrap, and written under its own knowledge_store `key`
// (`research:customer_segments:${opportunityId}`) so a
// searchKnowledgeStore("market") call surfaces all three sections side
// by side rather than any one clobbering another. Same category
// ("market") as 17d-i-a/17d-i-b — who buys and how they solve it today
// is still market context, just a third slice of it — and the same
// `research_finding:<finding.id>` source convention, so this entry
// traces back to the exact versioned Research pass that produced it,
// not just the opportunity. This is the third and last of the three
// Research-handoff seeds Zent.md 17d-i names; 17d-II (Strategy's
// technology-reuse seed) is a distinct, separate section and not part
// of this sub-phase.
//
// A finding with no `customer_segments` section yet (Research never ran
// 5d, or only ran 5b/5c before its report was compiled) is a legitimate
// state here too, not an error — this function returns null and
// genesisCompany() below treats that the same "born without this
// section rather than a fabricated one" way it already treats a missing
// market-size or competition pass.

/** formatMarketSignalEntry() (Phase 2b) reused here for the same reason
 *  17d-i-a/17d-i-b's own formatters reuse it: CustomerSegmentsFinding's
 *  `{query, results, identifiedAt}` shape is structurally identical to
 *  MarketSizeEstimate's `{query, results, estimatedAt}` and
 *  CompetitionSurvey's `{query, results, surveyedAt}`, so this is the
 *  same formatter with identify_customer_segments' own tool name/
 *  timestamp swapped in, not a third, slightly different
 *  reimplementation. */
function formatCustomerSegments(segments: CustomerSegmentsFinding): string {
  return formatMarketSignalEntry(segments.query, segments.results, segments.identifiedAt, {
    toolName: "identify_customer_segments",
    arg: segments.query,
  });
}

/**
 * Zent.md 17d-i-c's own "wire it in" half. Reads opportunityId's current
 * research finding, and — if 5d actually ran — writes one knowledge_store
 * row for `agentAddress` (Agent B, always its own freshly minted
 * address, never Company A's) under category "market", alongside
 * whatever 17d-i-a's seedMarketSizeKnowledge() and 17d-i-b's
 * seedCompetitionKnowledge() already wrote (or didn't) for the same
 * opportunity. Returns the written entry's id, or null when there was
 * nothing to seed.
 *
 * Source is `research_finding:<finding.id>` — same provenance convention
 * seedMarketSizeKnowledge()/seedCompetitionKnowledge() already use — so
 * a later reader (17d-III, once it lands) can trace this entry back to
 * the specific Research pass that produced it, not just the opportunity
 * it belongs to.
 */
export function seedCustomerSegmentsKnowledge(
  agentAddress: string,
  opportunityId: string,
  seededAt: number = Date.now(),
): string | null {
  const finding = getCurrentResearchFinding<{
    customer_segments?: CustomerSegmentsFinding;
    confidence?: ResearchConfidence;
  }>(opportunityId);
  const customerSegments = finding?.findings.customer_segments;
  if (!finding || !customerSegments) {
    return null;
  }

  return addKnowledge(agentAddress, {
    category: "market",
    key: `research:customer_segments:${opportunityId}`,
    content: formatCustomerSegments(customerSegments),
    source: `research_finding:${finding.id}`,
    confidence: researchConfidenceToScore(finding.findings.confidence),
    provenance: buildSeedProvenance(opportunityId, finding.id, "research", seededAt),
  });
}

// ─── Zent.md Phase 17d-II: Strategy technology-reuse knowledge seed ────
//
// "Strategy technology-reuse seed: Strategy's Phase 11 reuse notes
// (which of Company A's existing components/skills apply to this
// opportunity) are copied into the same knowledgeStore.ts, kept as a
// distinct section from 17d-i-a–c so Agent B can tell 'what the market
// looks like' from 'what I can reuse to build this.'"
//
// Structurally the odd one out among the four 17d seeds: 17d-i-a/b/c
// all read a *research_findings* row (getCurrentResearchFinding) and
// share one raw-evidence shape (formatMarketSignalEntry's {query,
// results, timestamp}). This one reads a *strategy_findings* row
// (getCurrentStrategyFinding) and Phase 11d's checkTechnologyReuse()
// output — TechnologyReuseCheckRecord's {entries, checkedAt}, entries
// being per-sibling {siblingAddress, siblingOpportunityId,
// siblingTitle, matches, reuseScore} — which has no query/results pair
// to hand formatMarketSignalEntry(), so it gets its own formatter
// rather than a forced reuse of that helper. Same knowledge_store
// *category* as 17d-i-a/b/c is deliberately NOT used here: "technical"
// (not "market") is the category, matching this file's own framing
// above ("what I can reuse to build this" is a technical fact about
// Agent B, not another slice of market context) — so a
// searchKnowledgeStore(agentAddress, q, "market") call surfaces only
// 17d-i-a/b/c, and a "technical" one surfaces this seed on its own.
// Key is `strategy:technology_reuse:${opportunityId}`, source is
// `strategy_finding:<finding.id>` — distinct prefix from the three
// Research seeds' `research_finding:<finding.id>`, since this content
// traces back to a strategy_findings row, not a research_findings one.
//
// A strategy finding that hasn't run 11d yet (check_technology_reuse
// never called — 11c's mission-overlap check ran alone, or Strategy
// hasn't started this opportunity at all) is a legitimate state here
// too, not an error — this function returns null and genesisCompany()
// below treats that the same "born without this section rather than a
// fabricated one" way it already treats a missing Research pass. An
// empty `entries` array, on the other hand, IS a completed 11d check
// (recordTechnologyReuseCheck()'s own header: "no sibling overlaps ...
// is as much a completed check as a list of matches") — this function
// still writes a knowledge_store row for that case, just one that says
// plainly that no reusable technology was found, rather than treating
// "checked, found nothing" the same as "never checked."

/** checkTechnologyReuse() (11d, expansion.ts) has no query/results/
 *  timestamp triple to hand formatMarketSignalEntry() — its record is
 *  a list of per-sibling skill matches, not raw search evidence — so
 *  this is a small dedicated formatter rather than a forced reuse of
 *  that helper. Mirrors formatMarketSignalEntry()'s own header/no-
 *  results shape (`[timestamp] label: ...` / `: no results`) so a
 *  reader of Agent B's knowledgeStore.ts sees a familiar block style
 *  across every 17d-* seed, even though the underlying data differs. */
function formatTechnologyReuse(record: TechnologyReuseCheckRecord): string {
  const timestamp = new Date(record.checkedAt).toISOString();
  const header = `[${timestamp}] check_technology_reuse()`;
  if (record.entries.length === 0) {
    return `${header}: no reusable technology found among existing siblings`;
  }
  const lines = record.entries.map((entry, i) => {
    const matchList = entry.matches
      .map((m) => `${m.name} (${m.score.toFixed(2)})`)
      .join(", ");
    return (
      `  ${i + 1}. ${entry.siblingTitle} [${entry.siblingAddress}]` +
      ` — reuseScore ${entry.reuseScore.toFixed(2)}\n` +
      `     reusable skills: ${matchList}`
    );
  });
  return `${header}:\n${lines.join("\n")}`;
}

/**
 * Zent.md 17d-II's own "wire it in" half. Reads opportunityId's current
 * strategy finding, and — if 11d actually ran — writes one
 * knowledge_store row for `agentAddress` (Agent B, always its own
 * freshly minted address, never Company A's) under category
 * "technical" (not "market" — see this section's own header for why),
 * alongside whatever 17d-i-a/b/c already wrote (or didn't) for the same
 * opportunity. Returns the written entry's id, or null when Strategy's
 * technology-reuse check never ran for this opportunity.
 *
 * Confidence is derived from the check's own headline number —
 * `entries[0]?.reuseScore` (0-1 TF-IDF cosine similarity, the same
 * number checkTechnologyReuse() itself documents as "a single headline
 * number Strategy's own Phase 11e fit-scoring can read directly") —
 * rather than Research's low/med/high vocabulary (5e), which
 * strategy_findings has no equivalent of. An empty `entries` array
 * leaves this undefined, falling back to addKnowledge()'s own 0.5
 * default, the same "no signal, don't invent one" posture
 * researchConfidenceToScore() takes for an unset Research confidence.
 */
export function seedTechnologyReuseKnowledge(
  agentAddress: string,
  opportunityId: string,
  seededAt: number = Date.now(),
): string | null {
  const finding = getCurrentStrategyFinding<{
    technology_reuse?: TechnologyReuseCheckRecord;
  }>(opportunityId);
  const technologyReuse = finding?.findings.technology_reuse;
  if (!finding || !technologyReuse) {
    return null;
  }

  return addKnowledge(agentAddress, {
    category: "technical",
    key: `strategy:technology_reuse:${opportunityId}`,
    content: formatTechnologyReuse(technologyReuse),
    source: `strategy_finding:${finding.id}`,
    confidence: technologyReuse.entries[0]?.reuseScore,
    provenance: buildSeedProvenance(opportunityId, finding.id, "strategy", seededAt),
  });
}

// ─── Zent.md Phase 17d-iii-b: pre-birth write acceptance check ─────────
//
// "Pre-birth write acceptance check: knowledgeStore.ts is verified to
// accept these tagged pre-birth writes — the write path itself,
// exercised before any smoke-test assertions run."
//
// Distinct from 17d-iii-c's round-trip *test* (a test-suite assertion
// that runs against fixtures) and from 17e's first-tick smoke test (a
// live Agent B completing one real agent-loop tick): this is a runtime
// check genesisCompany() itself performs on every real birth, reading
// back exactly the rows its own four 17d-i-a/b/c + 17d-II seed calls
// just wrote and confirming addKnowledge()'s write path actually
// accepted the tagged provenance it was handed — not merely that some
// row with some id exists. A seed function returning `null` (Research
// or Strategy never ran that pass) is not this function's concern —
// that's a legitimate "born without this section" outcome the four
// seed functions already handle themselves; this only fires for an id
// that came back non-null, where genesisCompany() is entitled to
// assume the row is really there with its provenance intact.

/** One seed's outcome, checked independently so a single bad write
 *  names itself precisely in the thrown error rather than the whole
 *  batch failing with one generic message. */
interface SeedAcceptanceSpec {
  label: string;
  id: string | null;
  expectedDepartment: KnowledgeProvenance["department"];
}

/**
 * Reads back every non-null seed id via getKnowledgeById() and confirms:
 * the row exists under `agentAddress` (not silently written to the
 * wrong agent, or not written at all despite addKnowledge() returning
 * an id), its `provenance` column parsed back to a real
 * KnowledgeProvenance rather than `null` (knowledgeStore.ts's own
 * parseProvenance() already treats malformed JSON as absent — this is
 * where that "absent" would surface as a birth-blocking problem, not a
 * silently-degraded read later), and that provenance's `opportunityId`/
 * `seededAt`/`department` match exactly what genesisCompany() asked
 * this birth's seeds to tag. A mismatch on any of those is the same
 * class of problem as a missing row: the write path did not accept the
 * tagged write as given, even though something landed.
 *
 * Throws (does not return a pass/fail value) on the first failing seed
 * — matching this file's existing "not caught here" posture for every
 * other write in genesisCompany(): the error propagates to
 * fireGenesisTrigger()'s own catch and leaves the trigger 'pending'
 * rather than genesisCompany() returning a result whose knowledge base
 * silently isn't what it claims to be. Called for its side effect
 * (throwing on failure); nothing downstream reads a return value, so
 * there isn't one.
 */
function verifyPrebirthKnowledgeWrites(
  agentAddress: string,
  opportunityId: string,
  seededAt: number,
  seeds: SeedAcceptanceSpec[],
): void {
  for (const seed of seeds) {
    if (seed.id === null) continue; // best-effort miss upstream — not this check's problem

    const entry = getKnowledgeById(agentAddress, seed.id);
    if (!entry) {
      throw new Error(
        `genesis_company: pre-birth write acceptance check failed for ${seed.label} — ` +
          `addKnowledge() returned id ${seed.id} but no such row exists for agent ${agentAddress}`,
      );
    }
    if (!entry.provenance) {
      throw new Error(
        `genesis_company: pre-birth write acceptance check failed for ${seed.label} — ` +
          `row ${seed.id} exists but its provenance did not round-trip (read back null)`,
      );
    }
    if (
      entry.provenance.opportunityId !== opportunityId ||
      entry.provenance.seededAt !== seededAt ||
      entry.provenance.department !== seed.expectedDepartment
    ) {
      throw new Error(
        `genesis_company: pre-birth write acceptance check failed for ${seed.label} — ` +
          `row ${seed.id} provenance ${JSON.stringify(entry.provenance)} does not match ` +
          `expected {opportunityId: ${opportunityId}, seededAt: ${seededAt}, department: ${seed.expectedDepartment}}`,
      );
    }
  }
}

/** Zent.md never names a required length for spawn_clone's own `name`
 *  argument; this is just enough to keep an unusually long opportunity
 *  title from producing an unwieldy agent name — generateAgentSlug()
 *  (wallet.ts) does its own, separate truncation for the DNS-safe slug
 *  regardless of what's passed here. */
const MAX_COMPANY_NAME_LENGTH = 80;

function companyNameFromOpportunityTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) {
    // An opportunity's title is required at creation (createOpportunity()'s
    // own validation, expansion.ts) — this is unreachable in practice,
    // guarded the same "don't let a downstream function invent a name
    // out of nothing" way slugifyBase()'s own "agent" fallback (wallet.ts)
    // guards its own edge case.
    return "expansion-company";
  }
  return trimmed.length > MAX_COMPANY_NAME_LENGTH
    ? trimmed.slice(0, MAX_COMPANY_NAME_LENGTH).trim()
    : trimmed;
}

/**
 * genesis_company(opportunity_id) — Zent.md 16a's own tool, matching
 * that exact signature. See this file's own header for full scope.
 */
// ─── PHASE-17D-IV: real agent/-runtime identity provisioning ─────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsPromises.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * PHASE-17D-IV — "New sub-phase before 17e-ii can mean anything real:
 * teach genesisCompany() to provision a real agent/-compatible identity
 * for Agent B."
 *
 * genesisCompany() has always given Agent B a wallet (createClonedAgentWallet(),
 * 16a) and an office/config/ tree (copyCloneConfig(), 17b) — but neither
 * of those is where agent/'s own runtime (agent/src/identity/wallet.ts's
 * getAutomatonDir(), agent/src/config.ts's loadConfig()) looks. Nothing
 * in this codebase ever put a wallet.json/automaton.json anywhere that
 * process could find, so no agent/-runtime process has ever been able
 * to boot as Agent B — 17e-ii's own smoke test (genesisSmokeTest.ts)
 * has never had anything real to run against; see that file's own
 * PHASE-17D-IV correction note for the two independent reasons why.
 *
 * This writes exactly the two files agent/'s own code reads at boot:
 *
 *   - wallet.json, in the shape agent/src/identity/wallet.ts's
 *     WalletData expects ({ chainType, privateKey, createdAt }) —
 *     reusing the EXACT key createClonedAgentWallet() (16a) already
 *     minted, via wallet.ts's new getAgentPrivateKeyHex(), rather than
 *     generating a second, orphaned key Agent B's own wallet routes
 *     would never recognize.
 *   - automaton.json (agent/src/config.ts's CONFIG_FILENAME — NOT
 *     config.json), with a real, working backendApiKey. This backend
 *     authenticates every agent with a single shared secret
 *     (config.backendApiKey, checked in index.ts's x-backend-key
 *     middleware — there is no per-agent key issuance anywhere in this
 *     codebase), so Agent B's automaton.json gets that same shared
 *     secret directly; there is nothing to "issue."
 *
 * Both land under config.agentIdentityDataDir/{agentAddress} — a new,
 * host-side, per-agent directory (see config.ts's own PHASE-17D-IV
 * comment) that orchestrator.ts's spawnAgentProcess()/
 * spawnAgentProcessTickOnce() point AUTOMATON_CONFIG_DIR at for this
 * exact address, so the process that eventually reads these files is
 * guaranteed to be looking in the same place this function wrote them.
 *
 * Called from genesisCompany() right after 16e's tagCompanyLineage() —
 * same "basic fact about Agent B, no downstream dependency either way"
 * posture 17a/17c's own writes there already use (see that call site).
 * Not caught here, same as every other write in genesisCompany(): a
 * throw propagates to fireGenesisTrigger()'s own catch and leaves the
 * genesis trigger 'pending' rather than 'completed' on a company that
 * still has no runtime identity.
 */
async function provisionAgentRuntimeIdentity(
  agentAddress: string,
  name: string,
): Promise<string> {
  const identityDir = path.join(path.resolve(config.agentIdentityDataDir), agentAddress);

  // Idempotency guard — a genesis retry (e.g. a caller invoking
  // genesisCompany() a second time after some later step in this
  // function threw, once a future retry path exists) must never
  // silently overwrite an already-written wallet.json: that file
  // contains a real private key, and overwriting it without also
  // rotating funds/grants/lineage that already point at the original
  // key would leave Agent B in an inconsistent, unrecoverable state.
  // Refuse instead — same "refuse rather than double-provision"
  // posture the genesis trigger's own 'pending'-only guard already
  // takes in genesisCompany() above.
  if (await fileExists(path.join(identityDir, "wallet.json"))) {
    throw new Error(
      `provisionAgentRuntimeIdentity: identity directory for ${agentAddress} already ` +
        `has a wallet.json — refusing to overwrite an existing agent runtime identity`,
    );
  }

  await fsPromises.mkdir(identityDir, { recursive: true, mode: 0o700 });

  const privateKey = getAgentPrivateKeyHex(agentAddress);
  await fsPromises.writeFile(
    path.join(identityDir, "wallet.json"),
    JSON.stringify(
      { chainType: "evm", privateKey, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  await fsPromises.writeFile(
    path.join(identityDir, "automaton.json"),
    JSON.stringify(
      {
        name,
        // No human creator for a pipeline-spawned company — sovereign
        // from birth, same framing Zent.md itself uses ("not a worker,
        // not a department... an independently-missioned company").
        creatorAddress: agentAddress,
        sandboxId: "", // Docker sandbox reuse (16c) is a separate, already-provisioned mechanism this file doesn't touch; agent/'s own config doesn't require this to be Agent B's Docker sandbox id.
        backendApiUrl: config.publicBaseUrl,
        backendApiKey: config.backendApiKey,
        dbPath: path.join(identityDir, "state.db"),
        chainType: "evm",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  return identityDir;
}

export async function genesisCompany(opportunityId: string): Promise<GenesisCompanyResult> {
  const trigger = getGenesisTrigger(opportunityId);
  if (!trigger) {
    // Only reachable if something calls genesisCompany() directly,
    // outside the decideExpansion() -> fireGenesisTrigger() path — that
    // path always calls recordGenesisTrigger() (expansion.ts) before
    // this function ever runs.
    throw new Error(
      `genesis_company: no genesis trigger recorded for opportunity ${opportunityId} — ` +
        `an approved CEO ruling (Phase 15d) must fire the trigger before genesis_company() runs`,
    );
  }
  if (trigger.status !== "pending") {
    // Idempotency: refuses to provision a second Agent B for an
    // opportunity that already has a 'completed' or 'failed' trigger.
    // A 'failed' trigger's own retry path is a later phase's job (19d's
    // kill/recall path is the nearest fit in Zent.md's own plan, not
    // this function silently re-running) — not something this session
    // adds on its own.
    throw new Error(
      `genesis_company: opportunity ${opportunityId}'s genesis trigger is already '${trigger.status}' — ` +
        `genesis_company() does not re-run for a trigger that isn't 'pending'`,
    );
  }

  // Defense in depth — see this file's own header for why decideExpansion()
  // already guarantees this by construction.
  const decision = getExpansionDecision<DecideExpansionSnapshot>(trigger.decisionId) as
    | ExpansionDecision<DecideExpansionSnapshot>
    | undefined;
  if (!decision || decision.ceo_decision !== "approved") {
    throw new Error(
      `genesis_company: opportunity ${opportunityId}'s genesis trigger does not point at an approved decision`,
    );
  }

  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    // Unreachable in practice — the FK chain (genesis_triggers ->
    // opportunities, ON DELETE CASCADE, db.ts) means a trigger can't
    // outlive its own opportunity row. Guarded anyway rather than
    // letting companyNameFromOpportunityTitle() below fail on undefined.
    throw new Error(`genesis_company: opportunity ${opportunityId} not found`);
  }

  // Zent.md 19a/19c, pulled forward ahead of Phase 19 itself so 17e-i's
  // first real tick can't cascade into an unbounded spawn chain before
  // the rest of Phase 19 lands. Checked here, before createCloneShell()
  // below does anything real, same "fail before anything is
  // provisioned" posture as the trigger/decision/opportunity guards
  // just above. Agent-internal only, same as every other guard in this
  // function — see expansionCircuitBreaker.ts's own header for why this
  // is not, and was never asked to be, a human approval step.
  const circuitBreaker = checkGenesisSpawnCapacity(trigger.agentAddress);
  if (!circuitBreaker.allowed) {
    throw new Error(`genesis_company: ${circuitBreaker.reason}`);
  }

  // Zent.md 19b, same "fail before anything is provisioned" posture as
  // 19a just above — checked here so a root already at/over its
  // portfolio cap never gets as far as a shell/wallet for a company it
  // can't fund. fundGenesisCompany() below applies the number-specific
  // clamp (checkPortfolioFundingRoom()) once this opportunity's actual
  // recommendedFundingUsdc is known; this is the earlier, coarser gate.
  const portfolioCap = checkPortfolioSpendCapacity(trigger.agentAddress);
  if (!portfolioCap.allowed) {
    throw new Error(`genesis_company: ${portfolioCap.reason}`);
  }

  const name = companyNameFromOpportunityTitle(opportunity.title);

  const shell = await createCloneShell(trigger.agentAddress);
  const wallet = await createClonedAgentWallet(shell.id, name);

  // 16e — tagged the instant the row exists, before a single dollar
  // moves or a grant is scoped. See this file's header for why a throw
  // here isn't caught: it propagates the same way a shell/wallet
  // failure would, leaving the trigger 'pending' rather than
  // 'completed' on a company whose lineage tag never landed.
  tagCompanyLineage(wallet.address, opportunityId);

  // PHASE-17D-IV — real agent/-runtime identity, filed right after
  // lineage: same "basic fact about Agent B, no downstream dependency
  // either way" posture 17a/17c's own writes just below already use,
  // and this has to exist before 17e-ii's genesisExecutorAdapter() ever
  // tries to run a first tick against this address. See
  // provisionAgentRuntimeIdentity()'s own header for why this reuses
  // the wallet's real key rather than minting a second one, and why a
  // throw here is not caught (same "not caught here" posture as every
  // other write in this function).
  const agentIdentityDir = await provisionAgentRuntimeIdentity(wallet.address, name);

  // 17a — mission text filed right after lineage, before funding/tool-
  // grant scoping: nothing downstream reads it back, so there's no
  // dependency either way, but "who am I and what am I here to do" is
  // the second most basic fact about Agent B, right after "where did I
  // come from" (16e, just above). See writeGenesisPrompt()'s own header
  // for why this is prepended to the parent's copied system-prompt.md
  // rather than replacing it.
  const genesisPrompt = await writeGenesisPrompt(wallet.address, opportunityId);

  // 17c — the same mission, filed as structured data right alongside
  // 17a's own prose write, same "no ordering dependency, done here
  // because it's basic" reasoning. See writeStructuredMission()'s own
  // header for why this is a second column, not a re-parse of
  // genesisPrompt above.
  const mission = writeStructuredMission(wallet.address, opportunityId);

  // 17d-i-a — Research's market-size finding, copied into Agent B's own
  // knowledgeStore.ts right alongside 17a/17c's identity/mission writes:
  // same "basic fact about Agent B, filed before funding/grants, no
  // downstream dependency either way" posture those two already use.
  // Best-effort by design (see seedMarketSizeKnowledge()'s own header):
  // a null return (Research never ran 5b for this opportunity) is a
  // normal outcome, not a reason to fail genesis — Agent B is simply
  // born without this section rather than the whole birth aborting on
  // a missing market-size pass. A thrown DB error, on the other hand,
  // is NOT swallowed here — same "not caught here" posture this
  // function takes for every other write above — it propagates to
  // fireGenesisTrigger()'s own catch and leaves the trigger 'pending'.
  // Zent.md 17d-iii-a: one shared birth instant for all four seeds below,
  // rather than each seed function independently calling Date.now() a
  // few ticks apart — see buildSeedProvenance()'s own header for why
  // that matters for a caller comparing seededAt across an agent's
  // knowledge_store rows.
  const knowledgeSeededAt = Date.now();

  const marketSizeKnowledgeId = seedMarketSizeKnowledge(wallet.address, opportunityId, knowledgeSeededAt);

  // 17d-i-b — Research's competition finding, copied into Agent B's own
  // knowledgeStore.ts right alongside 17d-i-a's market-size write: same
  // "basic fact about Agent B, filed before funding/grants, no
  // downstream dependency either way" posture, and the same best-effort
  // null-is-normal contract (see seedCompetitionKnowledge()'s own
  // header) — a thrown DB error still propagates to fireGenesisTrigger()'s
  // own catch and leaves the trigger 'pending', same as every other
  // write in this function.
  const competitionKnowledgeId = seedCompetitionKnowledge(wallet.address, opportunityId, knowledgeSeededAt);

  // 17d-i-c — Research's customer-segments finding, copied into Agent B's
  // own knowledgeStore.ts right alongside 17d-i-a/17d-i-b's writes: same
  // "basic fact about Agent B, filed before funding/grants, no
  // downstream dependency either way" posture, and the same best-effort
  // null-is-normal contract (see seedCustomerSegmentsKnowledge()'s own
  // header) — a thrown DB error still propagates to fireGenesisTrigger()'s
  // own catch and leaves the trigger 'pending', same as every other
  // write in this function. Completes Zent.md 17d-i's three-part
  // Research handoff (market size, competition, customer segments).
  const customerSegmentsKnowledgeId = seedCustomerSegmentsKnowledge(
    wallet.address,
    opportunityId,
    knowledgeSeededAt,
  );

  // 17d-II — Strategy's technology-reuse finding, copied into Agent B's
  // own knowledgeStore.ts right alongside 17d-i-a/b/c's writes: same
  // "basic fact about Agent B, filed before funding/grants, no
  // downstream dependency either way" posture, and the same best-effort
  // null-is-normal contract (see seedTechnologyReuseKnowledge()'s own
  // header) — a thrown DB error still propagates to fireGenesisTrigger()'s
  // own catch and leaves the trigger 'pending', same as every other
  // write in this function. This is the last of Zent.md 17d-i/17d-II's
  // four knowledge seeds. Each now carries its own 17d-iii-a provenance
  // tag (opportunity_id, report id, department, knowledgeSeededAt above)
  // via buildSeedProvenance() — verifyPrebirthKnowledgeWrites() just
  // below is 17d-iii-b's own acceptance check on exactly these four
  // writes; 17d-iii-c's separate round-trip test suite still isn't
  // built.
  const technologyReuseKnowledgeId = seedTechnologyReuseKnowledge(
    wallet.address,
    opportunityId,
    knowledgeSeededAt,
  );

  // 17d-iii-b — pre-birth write acceptance check, run immediately after
  // the four seeds above and before a single dollar of funding moves
  // (16b, next) or 17e's first-tick smoke test (not yet built) gets a
  // chance to run against a knowledge base that only *looks* seeded.
  // Same "not caught here" posture as every other write in this
  // function: a thrown failure here propagates to fireGenesisTrigger()'s
  // own catch and leaves the trigger 'pending', same as a funding or
  // grant-scoping failure would.
  verifyPrebirthKnowledgeWrites(wallet.address, opportunityId, knowledgeSeededAt, [
    { label: "17d-i-a market-size", id: marketSizeKnowledgeId, expectedDepartment: "research" },
    { label: "17d-i-b competition", id: competitionKnowledgeId, expectedDepartment: "research" },
    {
      label: "17d-i-c customer-segments",
      id: customerSegmentsKnowledgeId,
      expectedDepartment: "research",
    },
    {
      label: "17d-II technology-reuse",
      id: technologyReuseKnowledgeId,
      expectedDepartment: "strategy",
    },
  ]);

  // Phase 16b — funded after the shell/wallet exist (there is nothing
  // to send USDC to before that), before the trigger is marked
  // 'completed' (a funding failure here still leaves the trigger
  // 'pending' when this throws, matching this file's documented "not
  // caught here" posture rather than marking 'completed' on a company
  // that never got funded). No operator step in between: the CEO's
  // `approved` ruling (Phase 15d) is the only authorization this
  // transfer ever gets.
  const funding = await fundGenesisCompany(trigger.agentAddress, wallet.address, trigger.recommendedFundingUsdc);

  // 16d — after the wallet exists (there's no holder to grant against
  // before that), same "not caught here" posture as 16b's funding call
  // just above: a throw here (e.g. a DB error inserting the tool_grants
  // row) propagates to fireGenesisTrigger()'s own catch and leaves the
  // trigger 'pending' rather than marking it 'completed' on a company
  // whose grants didn't actually land. Ordered after funding rather
  // than before/interleaved — no dependency either way, done last
  // simply because it's the last thing this function adds before
  // marking completion.
  const supplierToSiblingGrant = scopeGenesisToolGrants(wallet.address, opportunityId);

  markGenesisTriggerCompleted(opportunityId);

  emitEvent({
    agentAddress: trigger.agentAddress,
    role: "CEO",
    subRole: "Opportunity Pipeline",
    eventType: "deal_closed",
    message: `Genesis complete: "${mission.title ?? wallet.name}" funded $${funding.fundedUsdc} and provisioned as ${wallet.name}`,
    metadata: { opportunityId, newAgentAddress: wallet.address, fundedUsdc: funding.fundedUsdc },
  });

  return {
    opportunityId,
    agentAddress: wallet.address,
    name: wallet.name,
    slug: wallet.slug,
    sandboxId: wallet.sandboxId,
    cloneShellId: shell.id,
    fundedUsdc: funding.fundedUsdc,
    fundingPaymentId: funding.fundingPaymentId,
    fundingSkippedReason: funding.fundingSkippedReason,
    supplierToSiblingGrant,
    genesisPrompt,
    mission,
    marketSizeKnowledgeId,
    competitionKnowledgeId,
    customerSegmentsKnowledgeId,
    technologyReuseKnowledgeId,
    agentIdentityDir,
  };
}

/**
 * Adapter registered with expansion.ts's setGenesisExecutor() — the
 * GenesisExecutor type (expansion.ts) is `(ctx) => void | Promise<unknown>`,
 * matched against fireGenesisTrigger()'s GenesisTriggerContext, while
 * Zent.md's own genesis_company() signature takes just an opportunityId.
 * This is the one-line seam between the two, not a second copy of
 * genesisCompany()'s own logic — genesisCompany() re-derives everything
 * it needs (agent address, funding number, notes) from the DB via
 * getGenesisTrigger()/getExpansionDecision() rather than trusting the
 * ctx object, so it stays independently callable (a future ops replay
 * script, a test) without this adapter in the loop at all.
 *
 * Zent.md 17e-ii: once genesisCompany() itself resolves — the company
 * is born, funded, and its genesis trigger already marked 'completed' —
 * this adapter runs Agent B's first real tick to completion as the very
 * next step, with no operator between birth and that first tick. This
 * is the automatic wiring 17e-i's own header anticipated ("genesis.ts
 * (backend) ... invokes this") and 19c's circuit-breaker comment
 * depends on existing at all ("the smoke-test result these key off of
 * doesn't exist until 17e-ii/17e-iii land").
 *
 * A TickSmokeTestFailure is deliberately swallowed here, not
 * re-thrown: fireGenesisTrigger()'s own catch treats any rejection from
 * this adapter as a *provisioning* failure and marks the genesis
 * trigger 'failed' — correct for a thrown wallet/funding/DB error
 * during genesisCompany() itself, wrong for a bad first tick on a
 * company that was, in fact, successfully provisioned. Agent B is a
 * real company either way; runFirstTickSmokeTest() has already written
 * the failing outcome to genesis_tick_smoke_tests (readable via
 * getLatestTickSmokeTest()) before this catch ever runs, so the failure
 * is on record — it simply isn't this seam's job to decide what a bad
 * first tick means for the pipeline as a whole. That judgment (halt via
 * expansionCircuitBreaker.ts, or gate Agent B's active-status
 * transition) is explicitly 17e-iii/17e-iv's scope; 17e-iii's half of
 * it (the halt) is wired in below — see this function's own body.
 * 17e-iv's half (gating Agent B's active-status transition) is still to
 * be built; see genesisSmokeTest.ts's own header for why this file does
 * not reach into that decision on its own. Any *other* error thrown out
 * of runFirstTickSmokeTest() (a bug in the harness itself, not one of
 * its three documented outcome categories) is not a case this adapter
 * knows how to interpret as "smoke test ran and failed" — it propagates
 * like any other unexpected error, same as genesisCompany()'s own
 * failures above it.
 *
 * Zent.md 17e-iii: once the first tick has actually completed (17e-ii
 * passed), checkTickConstitutionCompliance() (genesisConstitutionCheck.ts)
 * runs next, in the same no-operator chain — a tick that ran to
 * completion but denied/quarantined a tool call, or whose
 * constitution.md no longer matches its genesis hash, is not a company
 * this pipeline should keep spawning siblings from. Deliberately *not*
 * run when 17e-ii itself failed: a crashed/timed-out tick produced no
 * completed actions for this check to evaluate (see
 * genesisConstitutionCheck.ts's own header), and the `continue` below
 * the first catch already leaves the smoke-test failure as the sole
 * recorded outcome for that case.
 *
 * A ConstitutionComplianceFailure also calls expansionCircuitBreaker.ts's
 * haltExpansionPipeline() for the *root* agent (ctx.agentAddress;
 * result.agentAddress is Agent B, the child just born) before being
 * swallowed: Zent.md 19c ties the halt explicitly to "violates its
 * constitution within its first N ticks," and this is that violation,
 * detected as early as it can be. haltExpansionPipeline() only stops
 * the *root* agent's Opportunity Intelligence cycle from firing new
 * genesis events — Agent B itself is a real, already-provisioned
 * company either way, same posture the smoke-test catch above
 * documents.
 *
 * Zent.md 19c's *other* trigger — "fails its first-tick smoke test" —
 * is the TickSmokeTestFailure branch just above, and it calls the same
 * haltExpansionPipeline() for the same reason: a company that can't get
 * through one completed tick is exactly the signal 19c names, not a
 * lesser case that only logs and moves on. Both branches halt the root,
 * both branches leave Agent B itself provisioned-but-never-activated
 * (17e-iv), and both branches are read by checkGenesisSpawnCapacity()
 * (19a) the next time this root's pipeline tries to fire — no operator
 * decides which failures count; both documented 19c triggers do.
 *
 * Zent.md 17e-iv: this is where Agent B's own 'pending' status
 * (written at birth by tagCompanyLineage(), above) finally resolves.
 * Exactly one of three things happens to it below, and no operator
 * chooses which:
 *   - 17e-ii fails            -> markGenesisActivationFailed('smoke_test_failed')
 *   - 17e-ii passes, 17e-iii fails -> markGenesisActivationFailed('constitution_violated')
 *     (in addition to the halt above)
 *   - both pass               -> activateGenesisAgent()
 * genesisActivation.ts's own header covers why this is one-shot and
 * why a 'failed' agent is never silently retried or held for review.
 *
 * Zent.md 18a: only once activateGenesisAgent() above has actually run
 * — i.e. only for an agent that cleared both 17e-ii and 17e-iii — does
 * this adapter call genesisErc8004.ts's registerGenesisIdentity() to
 * publish Agent B's on-chain identity. Deliberately gated on activation
 * rather than firing right after genesisCompany() resolves: an agent
 * whose first tick crashed or violated its constitution is not one this
 * pipeline should be minting a public, permanent identity for. Like
 * every registerGenesisIdentity() outcome, a thrown error here would be
 * a bug in the harness itself, not an expected on-chain/gas failure —
 * those are recorded outcomes, not exceptions (see that file's own
 * header) — so nothing here catches it specially.
 */
async function genesisExecutorAdapter(ctx: GenesisTriggerContext): Promise<unknown> {
  const result = await genesisCompany(ctx.opportunityId);

  let tickCompleted = false;
  try {
    await runFirstTickSmokeTest(ctx.opportunityId, result.agentAddress, result.sandboxId);
    tickCompleted = true;
  } catch (err) {
    if (!(err instanceof TickSmokeTestFailure)) {
      throw err;
    }
    // Recorded already (genesisSmokeTest.ts writes the row before
    // throwing) — nothing further to do here beyond 19c's halt. See
    // this function's own header for why the genesis trigger itself
    // stays 'completed'.
    //
    // Zent.md 19c: "fails its first-tick smoke test ... the pipeline
    // auto-halts new genesis events for that root agent" — this is
    // that trigger, symmetric with the ConstitutionComplianceFailure
    // branch below. Fired for the *root* (ctx.agentAddress), not Agent
    // B (result.agentAddress) — same distinction that branch's own
    // comment makes.
    haltExpansionPipeline(
      ctx.agentAddress,
      `pipeline-spawned agent ${result.agentAddress} (opportunity ${ctx.opportunityId}) ` +
        `failed its 17e-ii first-tick smoke test: ${err.result.outcome}`,
    );
    markGenesisActivationFailed(
      ctx.opportunityId,
      result.agentAddress,
      "smoke_test_failed",
      `first-tick smoke test outcome: ${err.result.outcome}`,
    );
  }

  if (tickCompleted) {
    try {
      checkTickConstitutionCompliance(ctx.opportunityId, result.agentAddress);
      activateGenesisAgent(ctx.opportunityId, result.agentAddress);
      const processStart = spawnAgentProcess(result.agentAddress, "genesis:activation");
      if (!processStart.launched) {
        throw new Error(
          `genesis_company: activated agent process failed to start: ${processStart.reason}`,
        );
      }
      // Zent.md 20e: scheduled exactly once, right here — the same
      // "only for an agent that actually cleared 17e-ii/17e-iii" gate
      // 18a's own registerGenesisIdentity() call below already uses,
      // for the identical reason: an agent that never activated has no
      // operating history to review. See postLaunchReview.ts's own
      // header for why this call sits beside activateGenesisAgent()
      // rather than inside genesisActivation.ts itself.
      schedulePostLaunchReview(ctx.opportunityId, result.agentAddress);
      await registerGenesisIdentity(ctx.opportunityId, ctx.agentAddress, result.agentAddress);
    } catch (err) {
      if (!(err instanceof ConstitutionComplianceFailure)) {
        throw err;
      }
      // Recorded already (genesisConstitutionCheck.ts writes the row
      // before throwing). Same 19c halt as the TickSmokeTestFailure
      // branch above — a constitution violation is 19c's other
      // documented trigger — so this root agent's expansion pipeline
      // halts until its next Opportunity Intelligence cycle
      // re-evaluates before another sibling is spawned.
      haltExpansionPipeline(
        ctx.agentAddress,
        `pipeline-spawned agent ${result.agentAddress} (opportunity ${ctx.opportunityId}) ` +
          `failed its 17e-iii constitution compliance check: ${err.result.detail}`,
      );
      markGenesisActivationFailed(
        ctx.opportunityId,
        result.agentAddress,
        "constitution_violated",
        err.result.detail,
      );
    }
  }

  return result;
}

/**
 * Call once at app wire-up time (index.ts) — swaps expansion.ts's
 * do-nothing defaultGenesisExecutor() for the real genesisCompany()
 * path. Not per-request, not per-opportunity: a single process-lifetime
 * registration, same as every other router mounted once in index.ts.
 */
export function registerGenesisEngine(): void {
  setGenesisExecutor(genesisExecutorAdapter);
}
