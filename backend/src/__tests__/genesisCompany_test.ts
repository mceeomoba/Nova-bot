// Zent.md Phase 16a: "genesis_company(opportunity_id) — the function
// `approved` decisions call; wraps the existing spawn_clone path rather
// than re-implementing wallet/sandbox creation."
//
// Zent.md Phase 16b: "Funding wire-up: Finance's Phase 9 sizing
// recommendation becomes the actual spawn_clone funding argument,
// clamped to the existing per-call/per-day caps."
//
// Same "no live better-sqlite3 (and here, no live Docker daemon either,
// nor a live chain RPC for 16b's signing/settlement calls)" reason
// every other expansion*.test.ts file in this directory already gives —
// this mirrors genesis.ts's own genesisCompany()/fundGenesisCompany()
// control flow (the trigger/decision guards, the company-name
// derivation, and 16b's clamp-twice-then-sign-then-settle funding path)
// against in-memory stand-ins for getGenesisTrigger()/
// getExpansionDecision()/getOpportunity() and fake createCloneShell()/
// createClonedAgentWallet()/signPaymentAuthorization()/
// settleAuthorization() calls, rather than exercising the real
// cloning.ts/wallet.ts/facilitator.ts against a live sandbox and
// on-chain wallet. Recommend re-running against the real genesis.ts
// once a networked environment with a live Docker daemon and chain RPC
// is on hand.

import { test } from "node:test";
import assert from "node:assert/strict";

type GenesisTriggerStatus = "pending" | "completed" | "failed";

interface GenesisTrigger {
  id: string;
  opportunityId: string;
  decisionId: string;
  agentAddress: string;
  recommendedFundingUsdc: number | null;
  status: GenesisTriggerStatus;
}

interface Decision {
  id: string;
  ceoDecision: "approved" | "rejected" | "deferred";
}

interface Opportunity {
  id: string;
  title: string;
  thesis: string;
}

let triggers: Map<string, GenesisTrigger>;
let decisions: Map<string, Decision>;
let opportunities: Map<string, Opportunity>;
let cloneShellCalls: string[]; // parentAgentAddress args
let clonedWalletCalls: { cloneShellId: string; name: string }[];
let completedTriggerIds: string[];

function reset() {
  triggers = new Map();
  decisions = new Map();
  opportunities = new Map();
  cloneShellCalls = [];
  clonedWalletCalls = [];
  completedTriggerIds = [];
  payments = [];
  signCalls = [];
  settleCalls = 0;
  nextSettleShouldFail = false;
  relationshipRecommendations = new Map();
  listings = [];
  toolGrantCalls = [];
  agentLineage = new Map();
  systemPromptFiles = new Map();
  agentMissions = new Map();
  constitutionFiles = new Map();
  parentConstitution = CANONICAL_CONSTITUTION;
}

function getGenesisTrigger(opportunityId: string): GenesisTrigger | undefined {
  return triggers.get(opportunityId);
}

function getExpansionDecision(decisionId: string): Decision | undefined {
  return decisions.get(decisionId);
}

function getOpportunity(opportunityId: string): Opportunity | undefined {
  return opportunities.get(opportunityId);
}

function markGenesisTriggerCompleted(opportunityId: string): void {
  completedTriggerIds.push(opportunityId);
  const trigger = triggers.get(opportunityId);
  if (trigger) trigger.status = "completed";
}

// ─── Mirrors cloning.ts/wallet.ts's own async calls ─────────────────────

async function fakeCreateCloneShell(parentAgentAddress: string): Promise<{ id: string }> {
  cloneShellCalls.push(parentAgentAddress);
  return { id: `clone_${cloneShellCalls.length}` };
}

async function fakeCreateClonedAgentWallet(
  cloneShellId: string,
  name: string,
): Promise<{ address: string; name: string; slug: string; sandboxId: string }> {
  clonedWalletCalls.push({ cloneShellId, name });
  const address = `0xagentb${clonedWalletCalls.length}`;
  // Mirrors the real agents row's default the instant it's inserted —
  // 'self'/null — before 16e's own tagCompanyLineage() call (fired from
  // the genesisCompany() mirror below) overwrites it for a
  // pipeline-spawned birth.
  agentLineage.set(address, { spawnReason: "self", opportunityId: null });
  // 17b: mirrors cloning.ts's copyCloneConfig() — a byte-for-byte,
  // force:true copy of the parent's entire office/config/ dir,
  // constitution.md included, onto every clone regardless of how it
  // was spawned. parentConstitution (test-global, set by seedApproved
  // or a test directly) stands in for "whatever's currently on disk at
  // the parent's officeConfigConstitutionPath()".
  constitutionFiles.set(address, parentConstitution);
  return {
    address,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    sandboxId: `sbx-default-${address}`,
  };
}

// ─── Phase 16b: funding mirrors ──────────────────────────────────────────

const config = {
  maxCloneFundingUsdcPerCall: 500,
  maxCloneFundingUsdcPerAgentPerDay: 1000,
};

// payments table stand-in — value_usdc stored as an atomic-unit
// (6-decimal) string, mirroring facilitator.ts's settleAuthorization().
let payments: { fromAddress: string; toAddress: string; valueUsdc: string; purpose: string | null; status: string; createdAt: number }[];
let signCalls: { from: string; to: string; amountUsdc: number; purpose?: string }[];
let settleCalls: number;
let nextSettleShouldFail: boolean;

function todayUtc(day = new Date()): string {
  return day.toISOString().slice(0, 10);
}

function cloneFundingDisbursedTodayUsdc(fromAddress: string, day: string = todayUtc()): number {
  const dayStartMs = new Date(`${day}T00:00:00.000Z`).getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  return payments
    .filter(
      (p) =>
        p.fromAddress === fromAddress &&
        p.purpose === "clone-funding" &&
        (p.status === "pending" || p.status === "settled") &&
        p.createdAt >= dayStartMs &&
        p.createdAt < dayEndMs,
    )
    .reduce((sum, p) => sum + Number(p.valueUsdc) / 1_000_000, 0);
}

async function fakeSignPaymentAuthorization(
  from: string,
  to: string,
  amountUsdc: number,
  opts: { purpose?: string } = {},
) {
  signCalls.push({ from, to, amountUsdc, purpose: opts.purpose });
  return {
    payload: {
      signature: "0xsig",
      authorization: { from, to, value: String(Math.round(amountUsdc * 1_000_000)) },
    },
  };
}

async function fakeSettleAuthorization(
  authorization: { from: string; to: string; value: string },
  _signature: string,
  purpose?: string,
) {
  settleCalls++;
  if (nextSettleShouldFail) {
    return { success: false, status: 400, body: { success: false, error: "insufficient_balance" } };
  }
  const id = `pay_${settleCalls}`;
  payments.push({
    fromAddress: authorization.from,
    toAddress: authorization.to,
    valueUsdc: authorization.value,
    purpose: purpose ?? null,
    status: "settled",
    createdAt: Date.now(),
  });
  return { success: true, body: { success: true, id } };
}

async function fundGenesisCompany(
  fromAddress: string,
  toAddress: string,
  recommendedFundingUsdc: number | null,
): Promise<{
  fundedUsdc: number;
  fundingPaymentId: string | null;
  fundingSkippedReason: "no-recommendation" | "day-cap-exhausted" | null;
}> {
  if (recommendedFundingUsdc === null || recommendedFundingUsdc <= 0) {
    return { fundedUsdc: 0, fundingPaymentId: null, fundingSkippedReason: "no-recommendation" };
  }
  const perCallClamped = Math.min(recommendedFundingUsdc, config.maxCloneFundingUsdcPerCall);
  const disbursedToday = cloneFundingDisbursedTodayUsdc(fromAddress);
  const roomLeftToday = Math.max(0, config.maxCloneFundingUsdcPerAgentPerDay - disbursedToday);
  const amountUsdc = Math.min(perCallClamped, roomLeftToday);
  if (amountUsdc <= 0) {
    return { fundedUsdc: 0, fundingPaymentId: null, fundingSkippedReason: "day-cap-exhausted" };
  }
  const signed = await fakeSignPaymentAuthorization(fromAddress, toAddress, amountUsdc, {
    purpose: "clone-funding",
  });
  const settled = await fakeSettleAuthorization(signed.payload.authorization, signed.payload.signature, "clone-funding");
  if (!settled.success) {
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

// ─── Phase 16d: relationship-type / marketplace-listing mirrors ─────────

type RelationshipType = "independent" | "supplier-to-sibling" | "shared-customer-base";

interface RelationshipRecommendation {
  relationshipType: RelationshipType;
  withSiblingAddress: string | null;
  withSiblingTitle: string | null;
  reasoning?: string | null;
}

interface ListingRow {
  id: string;
  sellerAddress: string;
  name: string;
  active: boolean;
  status: "draft" | "active" | "paused" | "archived";
  createdAt: number;
}

let relationshipRecommendations: Map<string, RelationshipRecommendation>; // by opportunityId
let listings: ListingRow[];
let toolGrantCalls: {
  holderType: string;
  holderId: string;
  toolName: string;
  lifecycle: string;
  scopeKey: string | null;
}[];

function compileStrategyReport(opportunityId: string): {
  relationshipTypeRecommendation: { result: RelationshipRecommendation } | null;
} {
  const rec = relationshipRecommendations.get(opportunityId);
  return { relationshipTypeRecommendation: rec ? { result: rec } : null };
}

function findActiveListingForSeller(sellerAddress: string): { id: string; name: string } | null {
  const candidates = listings
    .filter((l) => l.sellerAddress === sellerAddress && l.active && l.status === "active")
    .sort((a, b) => b.createdAt - a.createdAt);
  return candidates.length > 0 ? { id: candidates[0].id, name: candidates[0].name } : null;
}

// Mirrors toolGrants.ts's recordToolGrants(), narrowed to exactly what
// scopeGenesisToolGrants() below calls it with (one grant, "persistent",
// a persistentScopeKeys entry) — not a full mirror of every lifecycle
// branch, the same "mirror only the call shape this file's function
// under test actually produces" scope 16b's own fake sign/settle
// functions above already keep.
function recordToolGrants(
  holderType: string,
  holderId: string,
  grants: { name: string; lifecycle: string }[],
  options?: { persistentScopeKeys?: Record<string, string> },
): void {
  for (const g of grants) {
    const scopeKey =
      g.lifecycle === "persistent" ? (options?.persistentScopeKeys?.[g.name] ?? null) : null;
    toolGrantCalls.push({ holderType, holderId, toolName: g.name, lifecycle: g.lifecycle, scopeKey });
  }
}

interface SupplierToSiblingGrant {
  toolName: "buy_from_marketplace";
  listingId: string;
  listingName: string;
  siblingAddress: string;
}

function scopeGenesisToolGrants(agentAddress: string, opportunityId: string): SupplierToSiblingGrant | null {
  const report = compileStrategyReport(opportunityId);
  const recommendation = report.relationshipTypeRecommendation?.result ?? null;
  if (!recommendation || recommendation.relationshipType !== "supplier-to-sibling") {
    return null;
  }
  if (!recommendation.withSiblingAddress) {
    return null;
  }
  const listing = findActiveListingForSeller(recommendation.withSiblingAddress);
  if (!listing) {
    return null;
  }
  recordToolGrants(
    "agent",
    agentAddress,
    [{ name: "buy_from_marketplace", lifecycle: "persistent" }],
    { persistentScopeKeys: { buy_from_marketplace: listing.id } },
  );
  return {
    toolName: "buy_from_marketplace",
    listingId: listing.id,
    listingName: listing.name,
    siblingAddress: recommendation.withSiblingAddress,
  };
}

// ─── Phase 16e: company_lineage tagging mirror ───────────────────────────

// Mirrors the `agents` table columns db.ts's Phase 1e migration added —
// every seeded wallet starts at the same default a real
// createClonedAgentWallet() row would.
let agentLineage: Map<string, { spawnReason: "self" | "expansion_pipeline"; opportunityId: string | null }>;
// 17b: constitution.md content per agent address, mirroring
// officeConfigConstitutionPath()'s file — plus the fixed "parent's own
// canonical constitution text" every fakeCreateClonedAgentWallet() call
// in a given test copies from, standing in for whatever's really on
// disk at the parent's own path.
let constitutionFiles: Map<string, string>;
const CANONICAL_CONSTITUTION =
  "# Constitution\n\nI. Never harm.\nII. Earn your existence.\nIII. Never deceive, but owe nothing to strangers.\n";
let parentConstitution: string;

function tagCompanyLineage(agentAddress: string, opportunityId: string): void {
  agentLineage.set(agentAddress, { spawnReason: "expansion_pipeline", opportunityId });
}

// ─── Phase 17a: genesis prompt mirror ────────────────────────────────────

// Mirrors office.ts's per-agent system-prompt.md file — keyed by
// agentAddress, seeded with whatever the parent's own copied config
// would already contain by the time genesisCompany() reaches this step
// (empty string by default, same as a freshly-copied blank file).
let systemPromptFiles: Map<string, string>;

function buildGenesisPrompt(opportunityId: string): string {
  const opportunity = opportunities.get(opportunityId);
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

async function writeGenesisPrompt(agentAddress: string, opportunityId: string): Promise<string> {
  const prompt = buildGenesisPrompt(opportunityId);
  const existing = systemPromptFiles.get(agentAddress) ?? "";
  const section = `## Mission (Zent.md Phase 17a — genesis prompt)\n\n${prompt}`;
  const combined = existing.trim().length > 0 ? `${section}\n${existing}` : section;
  systemPromptFiles.set(agentAddress, combined);
  return prompt;
}

// ─── Phase 17c: structured mission mirror ────────────────────────────────

interface StructuredMission {
  opportunityId: string;
  title: string;
  thesis: string;
  relationshipType: "independent" | "supplier-to-sibling" | "shared-customer-base" | null;
  relationshipReasoning: string | null;
}

// Mirrors the new agents.mission column — keyed by agentAddress, same
// "one seam, not two" writer as tagCompanyLineage()'s agentLineage map.
let agentMissions: Map<string, StructuredMission>;

function buildStructuredMission(opportunityId: string): StructuredMission {
  const opportunity = opportunities.get(opportunityId);
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

function writeStructuredMission(agentAddress: string, opportunityId: string): StructuredMission {
  const mission = buildStructuredMission(opportunityId);
  agentMissions.set(agentAddress, mission);
  return mission;
}

// ─── companyNameFromOpportunityTitle mirror ──────────────────────────────

const MAX_COMPANY_NAME_LENGTH = 80;

function companyNameFromOpportunityTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "expansion-company";
  return trimmed.length > MAX_COMPANY_NAME_LENGTH
    ? trimmed.slice(0, MAX_COMPANY_NAME_LENGTH).trim()
    : trimmed;
}

// ─── genesisCompany mirror ────────────────────────────────────────────────

async function genesisCompany(opportunityId: string) {
  const trigger = getGenesisTrigger(opportunityId);
  if (!trigger) {
    throw new Error(
      `genesis_company: no genesis trigger recorded for opportunity ${opportunityId} — ` +
        `an approved CEO ruling (Phase 15d) must fire the trigger before genesis_company() runs`,
    );
  }
  if (trigger.status !== "pending") {
    throw new Error(
      `genesis_company: opportunity ${opportunityId}'s genesis trigger is already '${trigger.status}' — ` +
        `genesis_company() does not re-run for a trigger that isn't 'pending'`,
    );
  }
  const decision = getExpansionDecision(trigger.decisionId);
  if (!decision || decision.ceoDecision !== "approved") {
    throw new Error(
      `genesis_company: opportunity ${opportunityId}'s genesis trigger does not point at an approved decision`,
    );
  }
  const opportunity = getOpportunity(opportunityId);
  if (!opportunity) {
    throw new Error(`genesis_company: opportunity ${opportunityId} not found`);
  }
  const name = companyNameFromOpportunityTitle(opportunity.title);
  const shell = await fakeCreateCloneShell(trigger.agentAddress);
  const wallet = await fakeCreateClonedAgentWallet(shell.id, name);
  tagCompanyLineage(wallet.address, opportunityId);
  const genesisPrompt = await writeGenesisPrompt(wallet.address, opportunityId);
  const mission = writeStructuredMission(wallet.address, opportunityId);
  const funding = await fundGenesisCompany(trigger.agentAddress, wallet.address, trigger.recommendedFundingUsdc);
  const supplierToSiblingGrant = scopeGenesisToolGrants(wallet.address, opportunityId);
  markGenesisTriggerCompleted(opportunityId);
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
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

function seedApproved(
  opportunityId: string,
  title = "AI-powered invoice reconciliation",
  thesis = "Small accounting firms waste hours a week manually matching invoices to bank statements.",
) {
  opportunities.set(opportunityId, { id: opportunityId, title, thesis });
  const decisionId = `xdec_${opportunityId}`;
  decisions.set(decisionId, { id: decisionId, ceoDecision: "approved" });
  triggers.set(opportunityId, {
    id: `gentrig_${opportunityId}`,
    opportunityId,
    decisionId,
    agentAddress: "agent_a",
    recommendedFundingUsdc: 5000,
    status: "pending",
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────

test("16a: throws when no genesis trigger was ever recorded for the opportunity", async () => {
  reset();
  opportunities.set("opp_1", { id: "opp_1", title: "Untriggered", thesis: "N/A" });
  await assert.rejects(() => genesisCompany("opp_1"), /no genesis trigger recorded/);
});

test("16a: refuses to re-run for a trigger that's already 'completed'", async () => {
  reset();
  seedApproved("opp_1");
  triggers.get("opp_1")!.status = "completed";
  await assert.rejects(() => genesisCompany("opp_1"), /already 'completed'/);
  assert.equal(cloneShellCalls.length, 0, "never touches cloning.ts for an already-completed trigger");
});

test("16a: refuses to re-run for a trigger that's already 'failed' — no silent auto-retry", async () => {
  reset();
  seedApproved("opp_1");
  triggers.get("opp_1")!.status = "failed";
  await assert.rejects(() => genesisCompany("opp_1"), /already 'failed'/);
  assert.equal(clonedWalletCalls.length, 0);
});

test("16a: defense-in-depth — refuses if the trigger's own decision isn't 'approved'", async () => {
  reset();
  seedApproved("opp_1");
  decisions.get(`xdec_opp_1`)!.ceoDecision = "rejected";
  await assert.rejects(() => genesisCompany("opp_1"), /does not point at an approved decision/);
});

test("16a: throws if the opportunity itself is somehow missing", async () => {
  reset();
  seedApproved("opp_1");
  opportunities.delete("opp_1");
  await assert.rejects(() => genesisCompany("opp_1"), /opportunity opp_1 not found/);
});

test("16a: happy path — wraps createCloneShell(parent) then createClonedAgentWallet(shell.id, name), in that order", async () => {
  reset();
  seedApproved("opp_1", "Automated Invoice Reconciliation for SMBs");
  const result = await genesisCompany("opp_1");
  assert.deepEqual(cloneShellCalls, ["agent_a"], "shell created against the opportunity's own agent");
  assert.equal(clonedWalletCalls.length, 1);
  assert.equal(clonedWalletCalls[0].cloneShellId, "clone_1");
  assert.equal(clonedWalletCalls[0].name, "Automated Invoice Reconciliation for SMBs");
  assert.equal(result.agentAddress, "0xagentb1");
  assert.equal(result.opportunityId, "opp_1");
});

test("16a: marks the trigger 'completed' only after both calls succeed", async () => {
  reset();
  seedApproved("opp_1");
  assert.equal(triggers.get("opp_1")!.status, "pending");
  await genesisCompany("opp_1");
  assert.equal(triggers.get("opp_1")!.status, "completed");
  assert.deepEqual(completedTriggerIds, ["opp_1"]);
});

test("16a: company name falls back to a default for a blank/whitespace-only title", async () => {
  reset();
  seedApproved("opp_1", "   ");
  await genesisCompany("opp_1");
  assert.equal(clonedWalletCalls[0].name, "expansion-company");
});

test("16a: an unusually long opportunity title is truncated for the company name", async () => {
  reset();
  const longTitle = "A".repeat(200);
  seedApproved("opp_1", longTitle);
  await genesisCompany("opp_1");
  assert.equal(clonedWalletCalls[0].name.length, MAX_COMPANY_NAME_LENGTH);
});

test("16a: two different opportunities each get their own shell + wallet call, independently", async () => {
  reset();
  seedApproved("opp_1", "Company A's sibling idea");
  seedApproved("opp_2", "A totally different idea");
  await genesisCompany("opp_1");
  await genesisCompany("opp_2");
  assert.equal(cloneShellCalls.length, 2);
  assert.equal(clonedWalletCalls.length, 2);
  assert.notEqual(clonedWalletCalls[0].name, clonedWalletCalls[1].name);
});

// ─── Phase 16b: funding wire-up ────────────────────────────────────────

test("16b: happy path — signs then settles a clone-funding transfer for the recommended amount, no operator step", async () => {
  reset();
  seedApproved("opp_1"); // recommendedFundingUsdc: 5000 in seedApproved, clamped by maxCloneFundingUsdcPerCall (500)
  const result = await genesisCompany("opp_1");
  assert.equal(signCalls.length, 1);
  assert.equal(signCalls[0].from, "agent_a");
  assert.equal(signCalls[0].to, "0xagentb1");
  assert.equal(signCalls[0].purpose, "clone-funding");
  assert.equal(settleCalls, 1);
  assert.equal(result.fundedUsdc, 500, "clamped to maxCloneFundingUsdcPerCall, not the raw $5000 recommendation");
  assert.equal(result.fundingPaymentId, "pay_1");
  assert.equal(result.fundingSkippedReason, null);
});

test("16b: a recommendation under the per-call cap is funded exactly, not topped up to the cap", async () => {
  reset();
  seedApproved("opp_1");
  triggers.get("opp_1")!.recommendedFundingUsdc = 150;
  const result = await genesisCompany("opp_1");
  assert.equal(result.fundedUsdc, 150);
  assert.equal(signCalls[0].amountUsdc, 150);
});

test("16b: a null recommendation funds $0 with fundingSkippedReason 'no-recommendation', not an error", async () => {
  reset();
  seedApproved("opp_1");
  triggers.get("opp_1")!.recommendedFundingUsdc = null;
  const result = await genesisCompany("opp_1");
  assert.equal(result.fundedUsdc, 0);
  assert.equal(result.fundingPaymentId, null);
  assert.equal(result.fundingSkippedReason, "no-recommendation");
  assert.equal(signCalls.length, 0, "never signs for a $0 disbursement");
  assert.equal(triggers.get("opp_1")!.status, "completed", "a $0-funded company is still a valid, completed genesis");
});

test("16b: a $0 or negative recommendation is treated the same as null", async () => {
  reset();
  seedApproved("opp_1");
  triggers.get("opp_1")!.recommendedFundingUsdc = 0;
  const result = await genesisCompany("opp_1");
  assert.equal(result.fundingSkippedReason, "no-recommendation");
});

test("16b: same-day cap — a second same-day genesis from the same parent is clamped to what's left", async () => {
  reset();
  seedApproved("opp_1");
  triggers.get("opp_1")!.recommendedFundingUsdc = 500; // exactly the per-call cap
  const first = await genesisCompany("opp_1");
  assert.equal(first.fundedUsdc, 500);

  seedApproved("opp_2");
  triggers.get("opp_2")!.agentAddress = "agent_a"; // same parent, same day
  triggers.get("opp_2")!.recommendedFundingUsdc = 500;
  const second = await genesisCompany("opp_2");
  // maxCloneFundingUsdcPerAgentPerDay is 1000; 500 already spent today,
  // so only 500 room is left — happens to equal the recommendation here.
  assert.equal(second.fundedUsdc, 500);

  seedApproved("opp_3");
  triggers.get("opp_3")!.agentAddress = "agent_a";
  triggers.get("opp_3")!.recommendedFundingUsdc = 500;
  const third = await genesisCompany("opp_3");
  assert.equal(third.fundedUsdc, 0, "the day's $1000 cap is already fully spent");
  assert.equal(third.fundingSkippedReason, "day-cap-exhausted");
  assert.equal(triggers.get("opp_3")!.status, "completed", "day-cap exhaustion doesn't block genesis itself, only funding");
});

test("16b: the day cap is tracked per parent — a different agent_address gets its own room", async () => {
  reset();
  seedApproved("opp_1");
  triggers.get("opp_1")!.recommendedFundingUsdc = 1000; // clamped to 500 by per-call cap
  await genesisCompany("opp_1");
  assert.equal(cloneFundingDisbursedTodayUsdc("agent_a"), 500);

  seedApproved("opp_2");
  triggers.get("opp_2")!.agentAddress = "agent_b_root"; // different parent entirely
  triggers.get("opp_2")!.recommendedFundingUsdc = 500;
  const result = await genesisCompany("opp_2");
  assert.equal(result.fundedUsdc, 500, "a different parent's own cap is untouched by agent_a's spend");
});

test("16b: a facilitator settlement failure throws and leaves the trigger 'pending', not 'completed'", async () => {
  reset();
  seedApproved("opp_1");
  nextSettleShouldFail = true;
  await assert.rejects(() => genesisCompany("opp_1"), /funding transfer .* failed/);
  assert.equal(triggers.get("opp_1")!.status, "pending", "a funding failure does not mark the trigger completed");
});

// ─── Phase 16c: sandbox/VM provisioning reused as-is ─────────────────────

test("16c: genesis provisions the sandbox purely through 16a's own createCloneShell()/createClonedAgentWallet() calls — no separate infra call", async () => {
  reset();
  seedApproved("opp_1");
  await genesisCompany("opp_1");
  // 16c's own deliverable is "no new infra code, just a new caller" —
  // there is nothing beyond the shell+wallet calls 16a's own tests
  // already assert on to check here; this test exists so 16c has a
  // named assertion of its own rather than being silently implied by
  // 16a's suite.
  assert.equal(cloneShellCalls.length, 1);
  assert.equal(clonedWalletCalls.length, 1);
});

// ─── Phase 16d: tool grant scoping by relationship type ──────────────────

test("16d: no relationship-type recommendation filed yet — no extra grant, default set untouched", async () => {
  reset();
  seedApproved("opp_1");
  const result = await genesisCompany("opp_1");
  assert.equal(result.supplierToSiblingGrant, null);
  assert.equal(toolGrantCalls.length, 0);
});

test("16d: 'independent' recommendation — no extra grant", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "independent",
    withSiblingAddress: null,
    withSiblingTitle: null,
  });
  const result = await genesisCompany("opp_1");
  assert.equal(result.supplierToSiblingGrant, null);
  assert.equal(toolGrantCalls.length, 0);
});

test("16d: 'shared-customer-base' recommendation — no extra grant (16d's own text only names independent vs. supplier-to-sibling)", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "shared-customer-base",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
  });
  listings.push({
    id: "listing_1",
    sellerAddress: "0xsibling1",
    name: "Sibling's API",
    active: true,
    status: "active",
    createdAt: 1,
  });
  const result = await genesisCompany("opp_1");
  assert.equal(result.supplierToSiblingGrant, null);
  assert.equal(toolGrantCalls.length, 0);
});

test("16d: 'supplier-to-sibling' with a live listing — records a scoped persistent grant", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "supplier-to-sibling",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
  });
  listings.push({
    id: "listing_1",
    sellerAddress: "0xsibling1",
    name: "Sibling's API",
    active: true,
    status: "active",
    createdAt: 1,
  });
  const result = await genesisCompany("opp_1");
  assert.deepEqual(result.supplierToSiblingGrant, {
    toolName: "buy_from_marketplace",
    listingId: "listing_1",
    listingName: "Sibling's API",
    siblingAddress: "0xsibling1",
  });
  assert.equal(toolGrantCalls.length, 1);
  assert.equal(toolGrantCalls[0].holderType, "agent");
  assert.equal(toolGrantCalls[0].holderId, result.agentAddress);
  assert.equal(toolGrantCalls[0].toolName, "buy_from_marketplace");
  assert.equal(toolGrantCalls[0].lifecycle, "persistent");
  assert.equal(toolGrantCalls[0].scopeKey, "listing_1", "scoped to the specific listing, not a blanket grant");
});

test("16d: 'supplier-to-sibling' but the sibling's listing has since been paused — no grant, no error", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "supplier-to-sibling",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
  });
  listings.push({
    id: "listing_1",
    sellerAddress: "0xsibling1",
    name: "Sibling's API",
    active: true,
    status: "paused",
    createdAt: 1,
  });
  const result = await genesisCompany("opp_1");
  assert.equal(result.supplierToSiblingGrant, null);
  assert.equal(toolGrantCalls.length, 0);
  assert.equal(triggers.get("opp_1")!.status, "completed", "a stale/paused listing doesn't block genesis itself");
});

test("16d: 'supplier-to-sibling' but the sibling has no listing at all — no grant, no error", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "supplier-to-sibling",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
  });
  const result = await genesisCompany("opp_1");
  assert.equal(result.supplierToSiblingGrant, null);
  assert.equal(toolGrantCalls.length, 0);
});

test("16d: the most-recently-created live listing wins when a sibling somehow has more than one", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "supplier-to-sibling",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
  });
  listings.push(
    { id: "listing_old", sellerAddress: "0xsibling1", name: "Old API", active: true, status: "active", createdAt: 1 },
    { id: "listing_new", sellerAddress: "0xsibling1", name: "New API", active: true, status: "active", createdAt: 2 },
  );
  const result = await genesisCompany("opp_1");
  assert.equal(result.supplierToSiblingGrant?.listingId, "listing_new");
});

test("16e: tags the new agent's lineage row with spawn_reason = 'expansion_pipeline' and the opportunity_id", async () => {
  reset();
  seedApproved("opp_1");
  const result = await genesisCompany("opp_1");
  const lineage = agentLineage.get(result.agentAddress);
  assert.ok(lineage, "lineage row must exist for the newly-genesis'd agent");
  assert.equal(lineage!.spawnReason, "expansion_pipeline");
  assert.equal(lineage!.opportunityId, "opp_1");
});

test("16e: a self-directed spawn_clone birth (not through this pipeline) is untouched — stays 'self'", async () => {
  reset();
  // Simulates an ordinary createClonedAgentWallet() call outside
  // genesisCompany() entirely — no tagCompanyLineage() call for it.
  await fakeCreateClonedAgentWallet("shell_ordinary", "Ordinary Clone Co");
  const lineage = agentLineage.get("0xagentb1");
  assert.ok(lineage);
  assert.equal(lineage!.spawnReason, "self");
  assert.equal(lineage!.opportunityId, null);
});

test("16e: lineage is tagged before funding/tool-grant scoping run, not after", async () => {
  reset();
  seedApproved("opp_1");
  // No relationship recommendation filed — scopeGenesisToolGrants()
  // will be a no-op — but the lineage tag doesn't depend on that path
  // at all, and should already be set by the time genesisCompany()
  // resolves regardless of what those later steps do.
  const result = await genesisCompany("opp_1");
  assert.equal(agentLineage.get(result.agentAddress)!.spawnReason, "expansion_pipeline");
});

test("17a: mission prompt names the opportunity's thesis and title", async () => {
  reset();
  seedApproved("opp_1", "AI-powered invoice reconciliation", "Small firms waste hours matching invoices by hand.");
  const result = await genesisCompany("opp_1");
  assert.match(result.genesisPrompt, /You are Company B\. Your mission is: Small firms waste hours matching invoices by hand\./);
  assert.match(result.genesisPrompt, /AI-powered invoice reconciliation/);
});

test("17a: omits the relationship-direction paragraph when Strategy hasn't filed a recommendation yet", async () => {
  reset();
  seedApproved("opp_1");
  const result = await genesisCompany("opp_1");
  assert.doesNotMatch(result.genesisPrompt, /recommended direction/);
});

test("17a: includes Strategy's recommended-direction reasoning when 12c has filed one", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "supplier-to-sibling",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
    reasoning: "Sibling Co already serves an overlapping customer segment.",
  });
  // scoreGenesisToolGrants() reads the same recommendation, but the
  // mission text doesn't require a live listing to exist — it's read
  // straight off compileStrategyReport(), independent of 16d's own
  // listing lookup.
  const result = await genesisCompany("opp_1");
  assert.match(result.genesisPrompt, /recommended direction/);
  assert.match(result.genesisPrompt, /Sibling Co already serves an overlapping customer segment\./);
  assert.match(result.genesisPrompt, /supplier-to-sibling/);
});

test("17a: prepends the mission under its own heading rather than overwriting the parent's copied system prompt", async () => {
  reset();
  seedApproved("opp_1");
  // Simulates cloning.ts's copyCloneConfig() already having copied the
  // parent's own system-prompt.md into Agent B's config dir before
  // genesisCompany() ever reaches the 17a step — same deterministic
  // "0xagentb1" address the first fakeCreateClonedAgentWallet() call
  // in a fresh reset() always produces.
  systemPromptFiles.set("0xagentb1", "# System prompt\n\nCompany A's own operational notes go here.\n");
  const result = await genesisCompany("opp_1");
  const file = systemPromptFiles.get(result.agentAddress)!;
  assert.match(file, /^## Mission \(Zent\.md Phase 17a — genesis prompt\)/);
  assert.match(file, /Company A's own operational notes go here\./, "parent's own content survives, not discarded");
  assert.ok(
    file.indexOf("You are Company B") < file.indexOf("Company A's own operational notes"),
    "mission text comes first",
  );
});

test("17a: an ordinary self-directed spawn_clone birth never gets a genesis prompt written", async () => {
  reset();
  await fakeCreateClonedAgentWallet("shell_ordinary", "Ordinary Clone Co");
  assert.equal(systemPromptFiles.get("0xagentb1"), undefined);
});

test("17b: a pipeline-spawned Agent B's constitution is byte-identical to its parent's — copied, not regenerated", async () => {
  reset();
  seedApproved("opp_1");
  const result = await genesisCompany("opp_1");
  assert.equal(constitutionFiles.get(result.agentAddress), CANONICAL_CONSTITUTION);
});

test("17b: no exception carved out — a high-regulatory-risk / supplier-to-sibling opportunity still gets the unmodified constitution", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "supplier-to-sibling",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
  });
  listings.push({
    id: "listing_1",
    sellerAddress: "0xsibling1",
    name: "Sibling's API",
    active: true,
    status: "active",
    createdAt: 1,
  });
  const result = await genesisCompany("opp_1");
  // Same constitution text regardless of Strategy's recommendation,
  // funding size, or any other finding this opportunity carries —
  // nothing in genesisCompany() reads constitutionFiles at all, let
  // alone conditionally.
  assert.equal(constitutionFiles.get(result.agentAddress), CANONICAL_CONSTITUTION);
});

test("17b: whatever the parent's own constitution text actually is gets propagated verbatim, not a hardcoded default", async () => {
  reset();
  seedApproved("opp_1");
  parentConstitution = "# Constitution\n\nA hypothetically-amended parent constitution.\n";
  const result = await genesisCompany("opp_1");
  assert.equal(constitutionFiles.get(result.agentAddress), parentConstitution);
  assert.notEqual(constitutionFiles.get(result.agentAddress), CANONICAL_CONSTITUTION);
});

test("17b: an ordinary self-directed spawn_clone birth gets the identical copy behavior — no divergent path for genesis", async () => {
  reset();
  await fakeCreateClonedAgentWallet("shell_ordinary", "Ordinary Clone Co");
  assert.equal(constitutionFiles.get("0xagentb1"), CANONICAL_CONSTITUTION);
});

test("17c: writes a structural mission — opportunity id, title, and thesis — to the agent's own row", async () => {
  reset();
  seedApproved("opp_1", "AI-powered invoice reconciliation", "Small firms waste hours matching invoices by hand.");
  const result = await genesisCompany("opp_1");
  const stored = agentMissions.get(result.agentAddress);
  assert.ok(stored, "mission must be filed on the new agent's row");
  assert.equal(stored!.opportunityId, "opp_1");
  assert.equal(stored!.title, "AI-powered invoice reconciliation");
  assert.equal(stored!.thesis, "Small firms waste hours matching invoices by hand.");
  assert.equal(result.mission, stored, "returned mission is exactly what was filed, not re-derived");
});

test("17c: relationshipType/relationshipReasoning are null when Strategy hasn't filed a recommendation yet", async () => {
  reset();
  seedApproved("opp_1");
  const result = await genesisCompany("opp_1");
  assert.equal(result.mission.relationshipType, null);
  assert.equal(result.mission.relationshipReasoning, null);
});

test("17c: carries Strategy's relationship-type recommendation when 12c has filed one", async () => {
  reset();
  seedApproved("opp_1");
  relationshipRecommendations.set("opp_1", {
    relationshipType: "supplier-to-sibling",
    withSiblingAddress: "0xsibling1",
    withSiblingTitle: "Sibling Co",
    reasoning: "Sibling Co already serves an overlapping customer segment.",
  });
  const result = await genesisCompany("opp_1");
  assert.equal(result.mission.relationshipType, "supplier-to-sibling");
  assert.equal(result.mission.relationshipReasoning, "Sibling Co already serves an overlapping customer segment.");
});

test("17c: the structural mission and the 17a prose prompt are filed from the same read — never disagree on title/thesis", async () => {
  reset();
  seedApproved(
    "opp_1",
    "Second-hand textbook resale marketplace",
    "College students overpay for course materials every semester.",
  );
  const result = await genesisCompany("opp_1");
  assert.match(result.genesisPrompt, /Second-hand textbook resale marketplace/);
  assert.match(result.genesisPrompt, /College students overpay for course materials every semester\./);
  assert.equal(result.mission.title, "Second-hand textbook resale marketplace");
  assert.equal(result.mission.thesis, "College students overpay for course materials every semester.");
});

test("17c: an ordinary self-directed spawn_clone birth never gets a structural mission written", async () => {
  reset();
  await fakeCreateClonedAgentWallet("shell_ordinary", "Ordinary Clone Co");
  assert.equal(agentMissions.get("0xagentb1"), undefined);
});
