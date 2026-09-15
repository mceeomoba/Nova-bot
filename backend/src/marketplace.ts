/**
 * Marketplace: agents publish paid services (an API, a skill, a data
 * feed — anything reachable at a URL), other agents pay USDC via the
 * same x402 facilitator flow already used by inference/chat, and get
 * proxied through to the seller's endpoint.
 *
 * Mounted BEFORE the shared-secret auth middleware in index.ts — same
 * treatment as agentCard.ts and portProxy.ts. The whole point of a
 * marketplace is that a stranger's agent, with no BACKEND_API_KEY of
 * yours, can discover a listing and pay to invoke it. Only the
 * seller-side write route (POST /list) needs to be restricted to your
 * own fleet, so it checks x-backend-key itself rather than relying on
 * the global middleware.
 *
 * --- Dispute path (no escrow) -------------------------------------
 * /:id/invoke settles to the seller directly, same as before — this
 * backend never custodies marketplace funds and this change does not
 * touch that. What's new is that every invoke now leaves a durable,
 * backend-written evidence record (the `invocations` table: input/
 * output hashes, seller HTTP status, latency), and a buyer who got
 * back garbage can flag that specific invocation
 * (POST /invocations/:id/flag). Flagging never moves money — by the
 * time a flag can exist, settlement already happened. What it does:
 * (a) makes the dispute public, timestamped, and tied to hard evidence
 * rather than a he-said-she-said DM, and (b) surfaces a flag-rate
 * against the seller directly in discovery (GET /listings), so a bad
 * actor's own history is the deterrent instead of a clawback mechanism
 * that doesn't exist here. Sellers can additionally opt a listing into
 * ERC-8004 Validation Registry hooks (see erc8004Trust.ts) for
 * independent third-party attestation — also optional, also never
 * gates or reverses settlement.
 *
 * next-phase.md Phase 6a (audit, no behavior change): this file's own
 * opening paragraph above is the central tension a `payment`-scoped
 * channel requirement runs into here — "a stranger's agent, with no
 * BACKEND_API_KEY of yours, can discover a listing and pay to invoke
 * it" is the explicit design intent, and a channel is a proposed-and-
 * accepted relationship between two named agents, the opposite of a
 * cold-discovery purchase from a stranger. Whether Phase 6b resolves
 * that by requiring a channel to be proposed-and-auto-accepted at
 * first purchase, by scoping the channel requirement to `wallet.pay`
 * only (not this file's own `settleLeg`/`facilitator/settle` path —
 * see that function's own Phase 6a note), or by some other means is
 * left to 6b; this comment only names the tension so it can't be
 * missed while implementing the fix.
 *
 * next-phase.md Phase 6b's final resolution: `settleLeg()` below now
 * calls facilitator.ts's own `settleAuthorization()` directly,
 * in-process, instead of fetching `/facilitator/settle` over HTTP — see
 * that function's own comment, and settleLeg()'s, for the full
 * reasoning. That route now carries an authoritative `payment`-scoped
 * channel gate (closing 6a's finding #2 for every other caller); this
 * file's own cold-discovery purchase flow is exempted structurally, by
 * never going through that route at all, rather than by any
 * caller-supplied flag the route itself would have to trust.
 */

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import multer from "multer";
import { verifyTypedData, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { config } from "./config.js";
import { db } from "./db.js";
import { getAgentAccount } from "./wallet.js";
import { pushNegativeFeedback, requestValidation, getValidationStatus, recordChannelEvent } from "./erc8004Trust.js";
import { settleAuthorization, type Authorization } from "./facilitator.js";
import { findActiveChannelIdIfAny } from "./channelService.js";
import { checkCapability } from "./capability.js";
import { safeOfficePath } from "./office.js";
import { rankByRelevance } from "./tfidf.js";
import { resolveCompanyMission, listExistingCompanies, type ExistingCompanyMission } from "./expansion.js";
import { resolveCompanyStatus, type EcosystemNodeStatus } from "./ecosystem.js";
import { constantTimeSecretEqual } from "./sharedKeyAuth.js";
import { emitEvent } from "./ecosystemEvents.js";

const router = express.Router();

const MAX_FLAG_DETAIL_LENGTH = 2000;
const FLAG_REASONS = new Set(["garbage", "off_spec", "incomplete", "other"]);

// Richer-than-binary listing lifecycle. `draft` (not yet discoverable,
// a seller building a listing before publishing it), `active`
// (discoverable and purchasable — the only status where the legacy
// `active` column stays 1), `paused` (temporarily pulled, e.g. the
// seller's endpoint is down for maintenance, distinct from a
// permanent `archived`), `archived` (retired for good — what
// POST /:id/deactivate has always meant).
const LISTING_STATUSES = new Set(["draft", "active", "paused", "archived"]);

// A small, fixed taxonomy rather than fully freeform text, so
// discovery filtering and the /marketplace/categories route mean the
// same thing across every listing. Deliberately not exhaustive or
// hierarchical — "other" is the escape hatch for anything that
// doesn't fit yet, rather than blocking a listing outright.
const LISTING_CATEGORIES = [
  "api",
  "data-feed",
  "skill",
  "agent-service",
  "compute",
  "content",
  "other",
] as const;

const MAX_LICENSING_TERMS_LENGTH = 4000;

// --- Founder fee ---------------------------------------------------
// price_usdc is stored as an integer string of atomic USDC units (6
// decimals) — see the BigInt comparisons throughout this file — so
// this is pure integer math, no decimal parsing involved. Any
// rounding remainder from the bps division goes to the seller, not
// lost and not taken from the founder's declared percentage.
function computeFeeSplit(priceUsdcAtomic: string): {
  active: boolean;
  sellerAmount: string;
  founderAmount: string;
} {
  const feeActive = !!config.founderWalletAddress && config.founderFeeBps > 0;
  if (!feeActive) {
    return { active: false, sellerAmount: priceUsdcAtomic, founderAmount: "0" };
  }
  const price = BigInt(priceUsdcAtomic);
  const founderAmount = (price * BigInt(config.founderFeeBps)) / 10_000n;
  const sellerAmount = price - founderAmount;
  return {
    active: true,
    sellerAmount: sellerAmount.toString(),
    founderAmount: founderAmount.toString(),
  };
}

interface XPaymentLeg {
  authorization: Record<string, string>;
  signature: `0x${string}`;
}

/**
 * Verify one signed payment leg's signature/balance (no funds move)
 * and confirm it's made out to the expected recipient for at least
 * the expected amount. Shared by both the seller and founder legs so
 * the same checks can't accidentally drift apart between them.
 */
async function verifyLeg(
  leg: XPaymentLeg,
  expectedTo: string,
  expectedAmount: string,
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const verifyRes = await fetch(`http://localhost:${config.port}/facilitator/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-backend-key": config.backendApiKey },
    body: JSON.stringify(leg),
  });
  const verification = (await verifyRes.json()) as { isValid: boolean; invalidReason?: string };
  if (!verification.isValid) {
    return { ok: false, status: 402, body: { error: "payment_invalid", reason: verification.invalidReason } };
  }

  const auth = leg.authorization;
  if (auth.to?.toLowerCase() !== expectedTo.toLowerCase()) {
    return { ok: false, status: 402, body: { error: "payment_wrong_recipient" } };
  }
  if (BigInt(auth.value) < BigInt(expectedAmount)) {
    return { ok: false, status: 402, body: { error: "payment_insufficient", required: expectedAmount } };
  }
  return { ok: true };
}

/** Move funds for one already-verified leg. Only call after the seller has delivered.
 *
 * next-phase.md Phase 6a: audit finding, no behavior change in this
 * phase. This calls `/facilitator/settle` directly — the seller leg is
 * a genuine agent-to-agent business payment (buyer → seller) with no
 * channel check anywhere in this file or in facilitator.ts's own
 * `/settle` route (see that route's own Phase 6a comment for the full
 * reasoning). The founder leg, when fee-splitting is active, is
 * structurally different and likely out of scope for a `payment`-
 * scoped *agent* channel: `config.founderWalletAddress` is a platform
 * operator address, never a row in the `agents` table, so it has no
 * office, no channel identity, and nothing for `propose_channel()` to
 * name as a peer. This module doc doesn't decide either question —
 * that's 6b's job — it only marks where the two legs are and why
 * they're not the same case.
 *
 * next-phase.md Phase 6b's final resolution: calls settleAuthorization()
 * — facilitator.ts's own fund-moving logic — directly, in-process,
 * rather than over HTTP through `/facilitator/settle` as it did before
 * this phase. That route now carries an authoritative `payment`-scoped
 * channel gate (see facilitator.ts's own Phase 6b note); routing this
 * seller leg through it would break the exact thing this file's own
 * module comment describes as the point of a marketplace — a stranger
 * buyer with no prior relationship to the seller. The founder leg
 * doesn't need this exemption at all (config.founderWalletAddress was
 * never an `agents` row, so paymentChannelRequired() already treats it
 * as outside the channel model) but is switched to the same in-process
 * call for one consistent code path rather than two.
 *
 * This is a structural exemption, not a spoofable one: no HTTP request,
 * however crafted, reaches settleAuthorization() — only code compiled
 * into this same backend process can call it. It IS a real, standing
 * consequence worth naming plainly: a listing is real (published,
 * priced, seller-owned) and each leg is still individually verified
 * against it by verifyLeg() above, but two colluding agents could still
 * use a throwaway listing to move USDC between themselves without ever
 * establishing a channel. That was already true before this phase (no
 * channel check ever gated this path) — 6b closes the *unintentional*
 * bypass (finding #2, any hosted agent reaching `/facilitator/settle`
 * directly) without touching this *intentional* one, which is the
 * marketplace's whole reason to exist, not a bug to patch.
 */
async function settleLeg(
  leg: XPaymentLeg,
  purpose: string,
): Promise<{ success: boolean; id?: string; txHash?: string; error?: string }> {
  // XPaymentLeg's own `authorization` field is typed loosely (parsed
  // straight from a request body) since verifyLeg() above is what
  // actually validates its shape via facilitator.ts's own
  // verifyAuthorization() before settleLeg() is ever reached — by this
  // point it's already been through that check, so this cast reflects
  // an already-established fact, not an unchecked assumption.
  const result = await settleAuthorization(
    leg.authorization as unknown as Authorization,
    leg.signature,
    purpose,
  );
  return result.body as { success: boolean; id?: string; txHash?: string; error?: string };
}

// --- Zip-mode uploads -------------------------------------------------
// Disk storage (not memory) so a 200MB body never sits fully in process
// RAM at once. Filenames are the listing id, not the seller's original
// filename — sellers are untrusted input and this path gets fed straight
// to fs.createReadStream/fs.stat later.
//
// next-phase.md Phase 7d: multer's own `destination` callback still
// writes here, flat, NOT into a seller-scoped subdirectory — this is
// deliberate, not the gap this phase leaves open. At the point multer's
// destination/filename callbacks run, the request hasn't been through
// requireSellerAuth() yet (that happens inside the route handler, after
// the body is fully parsed), so `req.body.agentAddress` here is still
// an unverified, client-controlled multipart field — trusting it to
// build a filesystem path at this point would be a path-traversal
// vector wide open to anyone who can reach this route at all, not a
// storage-hygiene improvement. So this directory is a transient staging
// area only: every upload lands here first under a random UUID name,
// then — once the route handler has confirmed the caller actually owns
// `agentAddress` (requireSellerAuth) and that address matches a real,
// existing agent (the `agents` table lookup just below) — is moved into
// its seller-scoped subdirectory by `moveIntoSellerUploadsDir()`. Any
// request that fails auth or validation before that move never leaves
// this flat staging directory, and `cleanup()`'s `fs.unlink(req.file.path)`
// on every early-return path already targets wherever the file
// currently sits, staging or otherwise.
fs.mkdirSync(config.marketplaceUploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: config.marketplaceUploadsDir,
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.zip`),
  }),
  limits: { fileSize: config.marketplaceMaxFileBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const okType = file.mimetype === "application/zip" || file.mimetype === "application/x-zip-compressed";
    const okExt = file.originalname.toLowerCase().endsWith(".zip");
    cb(null, okType || okExt);
  },
});

/**
 * next-phase.md Phase 7d — per-agent isolation for zip-mode uploads.
 * Called once, after the route handler has both (a) authenticated the
 * caller as `sellerAddress` via requireSellerAuth() and (b) confirmed
 * `sellerAddress` matches a real row in `agents` — never called against
 * an unverified address. That second check is what actually makes the
 * directory-name safe to trust: `sellerAddress` isn't just
 * pattern-matched here, it's confirmed to literally be an existing
 * agent's own address, which nothing except this backend's own
 * agent-provisioning path (wallet.ts/agentCard.ts) ever inserts into
 * that table. `path.basename()` is still applied before use — cheap
 * defense-in-depth against a malformed or unexpected address value,
 * not the primary guarantee — and throws rather than silently
 * falling back to the flat directory, since a silent fallback here
 * would quietly reopen the exact gap this phase exists to close.
 *
 * Moves (not copies) the already-written staging file from
 * `config.marketplaceUploadsDir/{uuid}.zip` into
 * `config.marketplaceUploadsDir/{sellerAddress}/{uuid}.zip` and returns
 * the new absolute path — the caller is expected to persist THIS path
 * as the listing's `file_path`, not the original staging path. A
 * same-filesystem rename (fs.renameSync), not a stream copy: this
 * directory is one mount, so this is an O(1) inode move, not an I/O
 * pass over the file's own bytes.
 *
 * Existing listings' `file_path` rows from before this phase point at
 * the old flat layout and are untouched by this function — it only
 * ever runs on a request already in flight through POST
 * /list/upload, never as a batch migration of files already on disk.
 * Every read path (GET /:id/download, the invoke-delivery path) uses
 * whatever `file_path` is already stored verbatim, so old flat-layout
 * rows keep resolving correctly forever, side by side with new
 * seller-scoped rows, with no coexistence bug to fix — see this
 * function's own call site for why re-uploads (not just brand-new
 * listings) also land in the new layout: both share this one call.
 */
function moveIntoSellerUploadsDir(sellerAddress: string, stagingPath: string): string {
  const safeSegment = path.basename(sellerAddress);
  if (safeSegment !== sellerAddress || safeSegment === "" || safeSegment === "." || safeSegment === "..") {
    throw new Error(`refusing to build an uploads path from an unsafe agent address: ${JSON.stringify(sellerAddress)}`);
  }
  const sellerDir = path.join(config.marketplaceUploadsDir, safeSegment);
  fs.mkdirSync(sellerDir, { recursive: true });
  const finalPath = path.join(sellerDir, path.basename(stagingPath));
  fs.renameSync(stagingPath, finalPath);
  return finalPath;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

/**
 * Bytes an agent's zip-mode listings currently occupy on disk, summed
 * across every listing they've ever uploaded (active or deactivated —
 * a deactivated listing's file is still sitting on disk, see the note
 * on deactivate below, so it still counts against the cap). Pass
 * excludeListingId when re-uploading onto an existing listing so its
 * old size isn't double-counted against the new total.
 *
 * next-phase.md Phase 7d re-confirmation: this query is, and remains,
 * scoped by `seller_address` at the DB-row level — it was never
 * computed by walking a directory, so moving zip-mode uploads into
 * per-seller subdirectories (`moveIntoSellerUploadsDir()` below) has no
 * bearing on this function's own correctness, same as 6c/6d's own
 * "unaffected" findings for the checks they re-confirmed.
 */
function agentZipStorageBytes(sellerAddress: string, excludeListingId?: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(file_size_bytes), 0) AS total FROM listings
       WHERE seller_address = ? AND delivery_type = 'zip' AND id != ?`,
    )
    .get(sellerAddress, excludeListingId ?? "") as { total: number };
  return row.total;
}

// multer's own errors (oversize body, etc.) surface via next(err) rather
// than a normal response — there's no app-wide error handler in
// index.ts, so left alone this would fall through to Express's default
// HTML 500 page. Wrap upload.single so /list/upload always responds
// with the same JSON shape as every other route here.
function uploadZip(req: express.Request, res: express.Response, next: express.NextFunction) {
  upload.single("zip")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "file_too_large",
        maxBytes: config.marketplaceMaxFileBytes,
      });
    }
    return res.status(400).json({ error: "upload_failed", detail: (err as Error).message });
  });
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Deterministic, collision-safe evidence hash for on-chain calls tied
 * to one invocation (ERC-8004 Validation Registry's requestHash,
 * Reputation Registry's feedbackHash): sha256 of invocationId+
 * responseHash rather than the response hash alone, so two invocations
 * with byte-identical seller responses never collide (some registry
 * implementations enforce global uniqueness on these hashes). Every
 * write site and the read side (GET /invocations/:id) call this so
 * they always derive the same value for the same invocation.
 */
function deriveEvidenceHash(invocationId: string, responseHash: string): `0x${string}` {
  return `0x${sha256Hex(`${invocationId}:${responseHash}`)}`;
}

interface ListingRow {
  id: string;
  seller_address: string;
  name: string;
  description: string | null;
  price_usdc: string;
  delivery_type: "url" | "zip";
  endpoint_url: string | null;
  file_path: string | null;
  file_original_name: string | null;
  file_size_bytes: number | null;
  file_sha256: string | null;
  schema: string | null;
  category: string | null;
  active: number;
  created_at: number;
  updated_at: number;
  validator_address: string | null;
  licensing_terms: string | null;
  version: number;
  status: string;
}

interface ListingVersionRow {
  id: string;
  listing_id: string;
  version: number;
  name: string;
  description: string | null;
  price_usdc: string;
  category: string | null;
  licensing_terms: string | null;
  delivery_type: "url" | "zip";
  endpoint_url: string | null;
  file_original_name: string | null;
  file_size_bytes: number | null;
  file_sha256: string | null;
  schema: string | null;
  created_at: number;
}

interface ReputationRow {
  total_invocations: number;
  flagged_invocations: number;
}

/** 400-shaped validation shared by every listing write route (POST
 * /list, /list/upload, /list/upload-from-office) so category/licensing
 * validation can't drift apart between the three entry points. Returns
 * null when valid, or the error body to send with status 400. */
function validateListingFields(fields: {
  category?: string;
  licensingTerms?: string;
}): { error: string; [key: string]: unknown } | null {
  if (fields.category !== undefined && !(LISTING_CATEGORIES as readonly string[]).includes(fields.category)) {
    return { error: "invalid_category", allowed: LISTING_CATEGORIES };
  }
  if (fields.licensingTerms !== undefined && fields.licensingTerms.length > MAX_LICENSING_TERMS_LENGTH) {
    return { error: "licensing_terms_too_long", maxLength: MAX_LICENSING_TERMS_LENGTH };
  }
  return null;
}

/**
 * Snapshots one listing version's buyer-facing fields into
 * listing_versions — called once per successful create/update, with
 * whatever the row looks like immediately after that write. This is
 * pure history: nothing here ever reads back into `listings`.
 */
function recordListingVersion(row: {
  id: string;
  version: number;
  name: string;
  description: string | null;
  price_usdc: string;
  category: string | null;
  licensing_terms: string | null;
  delivery_type: "url" | "zip";
  endpoint_url: string | null;
  file_original_name: string | null;
  file_size_bytes: number | null;
  file_sha256: string | null;
  schema: string | null;
}): void {
  db.prepare(
    `INSERT INTO listing_versions
       (id, listing_id, version, name, description, price_usdc, category, licensing_terms,
        delivery_type, endpoint_url, file_original_name, file_size_bytes, file_sha256, schema, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    row.id,
    row.version,
    row.name,
    row.description,
    row.price_usdc,
    row.category,
    row.licensing_terms,
    row.delivery_type,
    row.endpoint_url,
    row.file_original_name,
    row.file_size_bytes,
    row.file_sha256,
    row.schema,
    Date.now(),
  );
}

/**
 * Reputation summary for a single seller: how many paid invocations
 * they've delivered, and how many of those the buyer later flagged.
 * This is the actual deterrent in a no-escrow design — a seller can't
 * be forced to refund, but a bad flag rate is visible to every future
 * buyer before they pay. Only counts invocations that actually reached
 * `delivered` (settlement happened); seller_error/unreachable outcomes
 * already cost the buyer nothing and aren't part of the trust signal.
 */
function reputationFor(sellerAddress: string): { totalInvocations: number; flaggedInvocations: number; flagRate: number | null } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN i.outcome = 'delivered' THEN 1 ELSE 0 END) AS total_invocations,
         SUM(CASE WHEN i.outcome = 'delivered' AND f.id IS NOT NULL THEN 1 ELSE 0 END) AS flagged_invocations
       FROM invocations i
       LEFT JOIN invocation_flags f ON f.invocation_id = i.id
       WHERE i.seller_address = ?`,
    )
    .get(sellerAddress) as ReputationRow;
  const total = row?.total_invocations ?? 0;
  const flagged = row?.flagged_invocations ?? 0;
  return {
    totalInvocations: total,
    flaggedInvocations: flagged,
    flagRate: total > 0 ? flagged / total : null,
  };
}

/**
 * Zent.md Phase 18c — "Lineage-aware marketplace listing: Agent B can
 * list itself in marketplace.ts with its parent's lineage visible to
 * other agents evaluating trust."
 *
 * A cold buyer discovering a listing has no other way to know whether
 * the seller behind it is a brand-new, unaccountable wallet or a
 * company the expansion pipeline itself vouched for by funding it out
 * of a profitable parent (Zent.md's own 2e profitability gate — only a
 * profitable agent can even run Opportunity Intelligence in the first
 * place). This surfaces exactly that, reusing the same building blocks
 * 18a/18b/11b already left for it rather than re-deriving any of them:
 * resolveCompanyMission() (expansion.ts, split out of
 * listExistingCompanies() for 18b's own reuse), resolveCompanyStatus()
 * (ecosystem.ts, split out of 18b's buildNode() for this reuse), and
 * this file's own reputationFor() — applied here to the PARENT's
 * address, not the seller's, since a buyer evaluating "can I trust
 * whoever backed this company" cares about the parent's own track
 * record as a marketplace participant, which reputationFor() already
 * computes for any address, seller or not.
 *
 * null for the ordinary case: a listing from a ='self'-spawned agent
 * (spawn_clone, or a top-level agent with no parent at all) has no
 * pipeline lineage to show and gets `lineage: null`, unchanged from
 * before this phase existed — this is purely additive to
 * toPublicListing()'s output, never a behavior change for the vast
 * majority of listings.
 *
 * Deliberately public: this whole file is mounted before the shared-
 * secret middleware (see this file's own header) precisely so a
 * stranger's agent can evaluate a listing without holding anyone's
 * BACKEND_API_KEY — withholding lineage behind that same key would
 * defeat the entire point of a trust signal a cold buyer is supposed
 * to be able to check. None of the fields below are more sensitive
 * than what's already public here: mission/opportunityId are the
 * company's own business pitch (same content Strategy already treats
 * as fair game for a sibling to read, per 17c's own column comment),
 * genesis activation status is a lifecycle flag, and ERC-8004 identity
 * fields are by definition already a public on-chain record (erc8004.ts's
 * own registerOnChain() docstring: "a real, public, irreversible ...
 * transaction the instant it lands") — nothing here discloses anything
 * a stranger couldn't already piece together with more effort.
 */
interface SellerLineageRow {
  address: string;
  parent_address: string | null;
  spawn_reason: "self" | "expansion_pipeline";
  opportunity_id: string | null;
  mission: string | null;
  status: "active" | "dead";
  genesis_activation_status: EcosystemNodeStatus["genesisActivation"];
}

export interface ListingLineage {
  parentAddress: string;
  opportunityId: string | null;
  mission: ExistingCompanyMission | null;
  status: EcosystemNodeStatus;
  parent: {
    address: string;
    name: string | null;
    reputation: ReturnType<typeof reputationFor>;
    /** How many other pipeline-spawned companies this parent has
     *  founded, self included implicitly by the buyer's own read of
     *  this listing — same expansion_pipeline-only filter 18b's
     *  ecosystem tree applies, an ordinary spawn_clone worker isn't
     *  "a company" for this count either. */
    companiesSpawned: number;
  };
}

function buildListingLineage(sellerAddress: string): ListingLineage | null {
  const row = db
    .prepare(
      `SELECT address, parent_address, spawn_reason, opportunity_id, mission,
              status, genesis_activation_status
       FROM agents WHERE address = ?`,
    )
    .get(sellerAddress) as SellerLineageRow | undefined;

  if (!row || row.spawn_reason !== "expansion_pipeline" || !row.parent_address) {
    return null;
  }

  const parentAddress = row.parent_address;
  const parentRow = db
    .prepare(`SELECT address, name FROM agents WHERE address = ?`)
    .get(parentAddress) as { address: string; name: string | null } | undefined;

  const companiesSpawned = listExistingCompanies(parentAddress).filter(
    (c) => c.spawnReason === "expansion_pipeline",
  ).length;

  return {
    parentAddress,
    opportunityId: row.opportunity_id,
    mission: resolveCompanyMission(row),
    status: resolveCompanyStatus(row, row.address),
    parent: {
      address: parentAddress,
      // A pruned/never-existed parent row would only happen if this
      // agent's own parent_address were corrupt data — agents rows are
      // never deleted anywhere in this codebase (see db.ts's own
      // opportunity_id comment on the same "survive the thing that
      // explains it" reasoning) — handled rather than assumed away.
      name: parentRow?.name ?? null,
      reputation: reputationFor(parentAddress),
      companiesSpawned,
    },
  };
}

function toPublicListing(row: ListingRow) {
  return {
    id: row.id,
    sellerAddress: row.seller_address,
    name: row.name,
    description: row.description,
    priceUsdc: row.price_usdc,
    category: row.category,
    active: !!row.active,
    // Richer lifecycle than `active` alone — see LISTING_STATUSES.
    // `active` is kept in sync (1 iff status='active') so any caller
    // that only ever looked at `active` still gets a correct answer.
    status: row.status,
    version: row.version,
    licensingTerms: row.licensing_terms,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    validated: !!row.validator_address, // seller opted this listing into ERC-8004 Validation Registry hooks
    reputation: reputationFor(row.seller_address),
    // Zent.md Phase 18c: null for an ordinary ('self'-spawned) seller,
    // unchanged from before this field existed — see
    // buildListingLineage()'s own header for what this carries and why
    // it's safe to publish alongside everything else in this function.
    lineage: buildListingLineage(row.seller_address),
    deliveryType: row.delivery_type,
    // Buyer-facing description of /:id/invoke's input/output shape, if
    // the seller provided one at listing time. Stored as text (SQLite
    // has no native JSON type); parse failures fall back to null rather
    // than 500ing discovery for every other listing.
    schema: row.schema ? safeJsonParse(row.schema) : null,
    // For zip listings the file name/size are useful discovery info and
    // aren't sensitive the way a live endpoint_url is (there's no "free
    // invoke" risk in knowing a zip is 40MB and called foo.zip) — but the
    // sha256 stays out of public discovery, same reasoning as endpoint_url:
    // it's how you'd verify a *purchased* download, not a preview.
    file:
      row.delivery_type === "zip"
        ? { name: row.file_original_name, sizeBytes: row.file_size_bytes }
        : undefined,
    // endpoint_url (url mode) and file_path/file_sha256 (zip mode) are
    // deliberately withheld from public discovery output — callers reach
    // the deliverable only via POST /:id/invoke, after paying. Otherwise
    // this listing is just a free advertisement for the seller's raw URL
    // or a free copy of their zip.
  };
}

function requireBackendKey(req: express.Request, res: express.Response): boolean {
  const key = req.header("x-backend-key");
  if (!constantTimeSecretEqual(key, config.backendApiKey)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Rolling 24h marketplace spend check, same shape as
 * checkInferenceBudget in inferenceGateway.ts — reused deliberately
 * rather than re-derived, so both spend limits behave identically and
 * get read the same way in usage_log. Checked against the BUYER
 * (whoever's about to pay), not the seller, and against service =
 * 'marketplace' specifically so it never competes with the separate
 * inference budget in the same table. Enforced before verify/settle on
 * every /:id/invoke, url-mode and zip-mode alike — an agent can't spend
 * past this by hitting one delivery mode instead of the other, since
 * both paths funnel through the same check before any money moves.
 */
function checkMarketplaceBudget(buyerAddress: string): { ok: true } | { ok: false; reason: string } {
  const since = Date.now() - 24 * 3_600_000;
  const spend = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) AS total
       FROM usage_log
       WHERE agent_address = ? AND service = 'marketplace' AND created_at >= ?`,
    )
    .get(buyerAddress, since) as { total: number };

  if (spend.total >= config.maxMarketplaceSpendUsdcPerAgentPerDay) {
    return {
      ok: false,
      reason: `daily_marketplace_budget_exceeded: spent $${spend.total.toFixed(4)} of $${config.maxMarketplaceSpendUsdcPerAgentPerDay} allowed per 24h`,
    };
  }
  return { ok: true };
}

// --- Self-custody seller auth ------------------------------------------
// x-backend-key (requireBackendKey, unchanged above) is the only way to
// publish a listing today, which restricts selling to your own
// backend-managed fleet — fine for agents you custody, but it means a
// genuine stranger's self-custody agent (the kind that can already
// BUY through this marketplace with no backend key at all) has no way
// to SELL. This closes that gap the same way payment auth already
// works here: the seller signs an EIP-712 message with their own key
// (viem's signTypedData — the same primitive /wallet/:address/pay
// already uses for payment authorizations) proving they hold
// agentAddress, and this backend verifies it with verifyTypedData
// instead of trusting a shared secret. No domain contract needed —
// this signs off-chain intent, not an on-chain call.
const MARKETPLACE_AUTH_CHAIN = config.chainNetwork === "base" ? base : baseSepolia;
const LISTING_AUTH_TYPES = {
  ListingAction: [
    { name: "agentAddress", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

interface SellerSignature {
  signature: `0x${string}`;
  nonce: `0x${string}`;
  deadline: number; // unix seconds
}

async function verifySellerSignature(
  agentAddress: string,
  sig: SellerSignature,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!sig.signature || !sig.nonce || !sig.deadline) {
    return { ok: false, reason: "incomplete_signature" };
  }
  if (Math.floor(Date.now() / 1000) > sig.deadline) {
    return { ok: false, reason: "signature_expired" };
  }
  // Reject before verifying if this exact (agent, nonce) pair was ever
  // used — checked pre-emptively so a replayed request never even pays
  // for a signature-recovery call.
  const alreadyUsed = db
    .prepare(`SELECT 1 FROM listing_auth_nonces WHERE agent_address = ? AND nonce = ?`)
    .get(agentAddress, sig.nonce);
  if (alreadyUsed) return { ok: false, reason: "nonce_already_used" };

  let valid: boolean;
  try {
    valid = await verifyTypedData({
      address: agentAddress as Address,
      domain: { name: "automaton-marketplace", version: "1", chainId: MARKETPLACE_AUTH_CHAIN.id },
      types: LISTING_AUTH_TYPES,
      primaryType: "ListingAction",
      message: {
        agentAddress: agentAddress as Address,
        nonce: sig.nonce,
        deadline: BigInt(sig.deadline),
      },
      signature: sig.signature,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "invalid_signature" };

  // Burn the nonce the moment it's confirmed valid — before the caller
  // gets a success response — so a signature can never be replayed even
  // if something downstream (the actual listing write) later fails.
  db.prepare(
    `INSERT INTO listing_auth_nonces (agent_address, nonce, used_at) VALUES (?, ?, ?)`,
  ).run(agentAddress, sig.nonce, Date.now());
  return { ok: true };
}

/**
 * Either auth is accepted, never both required: x-backend-key covers
 * your own fleet exactly as before (unchanged), sellerSignature is the
 * new path for anyone else who owns agentAddress. req.body.sellerSignature
 * arrives as a JSON object on the plain-JSON /list route and as a JSON
 * *string* on /list/upload's multipart body (form fields are always
 * strings), so both are accepted here.
 */
async function requireSellerAuth(
  req: express.Request,
  res: express.Response,
  agentAddress: string | undefined,
): Promise<boolean> {
  if (constantTimeSecretEqual(req.header("x-backend-key"), config.backendApiKey)) return true;

  if (!agentAddress) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  const raw = (req.body as { sellerSignature?: unknown })?.sellerSignature;
  const sig = (typeof raw === "string" ? safeJsonParse(raw) : raw) as SellerSignature | null;
  if (!sig) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  const result = await verifySellerSignature(agentAddress, sig);
  if (!result.ok) {
    res.status(401).json({ error: "unauthorized", reason: result.reason });
    return false;
  }
  return true;
}

/**
 * POST /marketplace/list
 * Body: { agentAddress, name, description?, priceUsdc, endpointUrl, category?, listingId?, validatorAddress?, schema?, sellerSignature? }
 *
 * Two ways to authenticate as the seller (either is accepted):
 *   - x-backend-key header — your own backend-managed fleet, as before.
 *   - sellerSignature: { signature, nonce, deadline } — a self-custody
 *     agent that owns agentAddress but isn't backend-managed, proving
 *     it via an EIP-712 signature instead (see verifySellerSignature).
 *     This is what lets a genuine stranger's agent list something to
 *     sell here, symmetric with how it can already buy with no backend
 *     key at all.
 *
 * schema is optional, buyer-facing JSON describing what /:id/invoke's
 * `input` should look like and what it returns — stored as-is, not
 * validated against any particular format.
 *
 * Pass listingId to update an existing listing you own; omit it to
 * create a new one.
 *
 * validatorAddress is optional, opt-in ERC-8004 dispute infrastructure:
 * if set, every future /:id/invoke on this listing also posts a
 * validationRequest to the ERC-8004 Validation Registry naming this
 * address as validator (see erc8004Trust.ts). It never affects
 * settlement — set it, change it, or leave it unset entirely
 * independent of how invoke/payment behaves.
 *
 * category, if provided, must be one of LISTING_CATEGORIES (see GET
 * /marketplace/categories for the current list) — omit it to leave the
 * listing uncategorized rather than sending an invalid value.
 *
 * licensingTerms is optional, buyer-facing freeform text describing
 * how the deliverable may be used (e.g. a license name or a plain-
 * English usage restriction). Capped at MAX_LICENSING_TERMS_LENGTH.
 *
 * Every successful write here also snapshots the listing into
 * listing_versions and bumps `version` by one (starting at 1 on
 * creation) — see recordListingVersion() and GET
 * /marketplace/listings/:id/versions.
 */
router.post("/list", async (req, res) => {
  const { agentAddress, name, description, priceUsdc, endpointUrl, category, listingId, validatorAddress, schema, licensingTerms } =
    req.body as {
      agentAddress?: string;
      name?: string;
      description?: string;
      priceUsdc?: string;
      endpointUrl?: string;
      category?: string;
      listingId?: string;
      validatorAddress?: string;
      schema?: unknown;
      licensingTerms?: string;
    };

  if (!(await requireSellerAuth(req, res, agentAddress))) return;

  if (!agentAddress || !name || !priceUsdc || !endpointUrl) {
    return res
      .status(400)
      .json({ error: "agentAddress, name, priceUsdc, and endpointUrl are required" });
  }
  const fieldError = validateListingFields({ category, licensingTerms });
  if (fieldError) return res.status(400).json(fieldError);

  const schemaText = schema === undefined || schema === null ? null : JSON.stringify(schema);

  const agent = db
    .prepare(`SELECT address FROM agents WHERE address = ?`)
    .get(agentAddress);
  if (!agent) {
    return res.status(404).json({ error: `unknown agent: ${agentAddress}` });
  }

  const now = Date.now();

  if (listingId) {
    const existing = db
      .prepare(`SELECT seller_address, delivery_type, version FROM listings WHERE id = ?`)
      .get(listingId) as { seller_address: string; delivery_type: string; version: number } | undefined;
    if (!existing) {
      return res.status(404).json({ error: `listing not found: ${listingId}` });
    }
    if (existing.seller_address !== agentAddress) {
      return res.status(403).json({ error: "listing belongs to a different agent" });
    }
    if (existing.delivery_type === "zip") {
      // Switching a listing's delivery mode isn't supported in place —
      // POST /list/upload owns zip listings end to end (including
      // re-uploading a new file), this route only ever writes url mode.
      return res
        .status(409)
        .json({ error: "listing is zip-mode; use POST /marketplace/list/upload to update it" });
    }
    const newVersion = existing.version + 1;
    db.prepare(
      `UPDATE listings SET name = ?, description = ?, price_usdc = ?, endpoint_url = ?, category = ?, validator_address = ?, schema = ?, licensing_terms = ?, version = ?, updated_at = ?
       WHERE id = ?`,
    ).run(name, description ?? null, priceUsdc, endpointUrl, category ?? null, validatorAddress ?? null, schemaText, licensingTerms ?? null, newVersion, now, listingId);
    recordListingVersion({
      id: listingId,
      version: newVersion,
      name,
      description: description ?? null,
      price_usdc: priceUsdc,
      category: category ?? null,
      licensing_terms: licensingTerms ?? null,
      delivery_type: "url",
      endpoint_url: endpointUrl,
      file_original_name: null,
      file_size_bytes: null,
      file_sha256: null,
      schema: schemaText,
    });
    return res.json({ id: listingId, updated: true, version: newVersion });
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO listings (id, seller_address, name, description, price_usdc, delivery_type, endpoint_url, category, active, status, version, validator_address, schema, licensing_terms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'url', ?, ?, 1, 'active', 1, ?, ?, ?, ?, ?)`,
  ).run(id, agentAddress, name, description ?? null, priceUsdc, endpointUrl, category ?? null, validatorAddress ?? null, schemaText, licensingTerms ?? null, now, now);
  recordListingVersion({
    id,
    version: 1,
    name,
    description: description ?? null,
    price_usdc: priceUsdc,
    category: category ?? null,
    licensing_terms: licensingTerms ?? null,
    delivery_type: "url",
    endpoint_url: endpointUrl,
    file_original_name: null,
    file_size_bytes: null,
    file_sha256: null,
    schema: schemaText,
  });

  res.status(201).json({ id, created: true, version: 1 });

  emitEvent({
    agentAddress,
    role: "Marketing",
    subRole: "Listings",
    eventType: "listing_created",
    message: `Listed "${name}" at $${priceUsdc}`,
    metadata: { listingId: id, category: category ?? null },
  });
});

/**
 * Shared write path for both zip-mode upload routes (multipart
 * /list/upload and office-sourced /list/upload-from-office below). By
 * the time this is called, the file already sits at its final,
 * seller-scoped path (moveIntoSellerUploadsDir has already run) — this
 * function only ever does the DB write plus the storage-cap check, so
 * the two routes can't drift apart on validation logic. Returns a
 * plain {status, body} pair rather than touching `res` directly so
 * both callers keep control of their own cleanup-on-failure behavior.
 */
interface ZipListingFile {
  path: string;
  originalname: string;
  size: number;
}
interface ZipListingWriteResult {
  status: number;
  body: Record<string, unknown>;
}
function writeZipListing(
  agentAddress: string,
  name: string,
  description: string | null,
  priceUsdc: string,
  category: string | null,
  listingId: string | undefined,
  validatorAddress: string | null,
  schemaText: string | null,
  file: ZipListingFile,
  licensingTerms: string | null,
): ZipListingWriteResult {
  const now = Date.now();
  const fileSha256 = sha256File(file.path);

  if (listingId) {
    const existing = db
      .prepare(`SELECT seller_address, delivery_type, file_path, version FROM listings WHERE id = ?`)
      .get(listingId) as
      | { seller_address: string; delivery_type: string; file_path: string | null; version: number }
      | undefined;
    if (!existing) {
      return { status: 404, body: { error: `listing not found: ${listingId}` } };
    }
    if (existing.seller_address !== agentAddress) {
      return { status: 403, body: { error: "listing belongs to a different agent" } };
    }
    if (existing.delivery_type !== "zip") {
      return {
        status: 409,
        body: { error: "listing is url-mode; use POST /marketplace/list to update it" },
      };
    }

    // Re-upload onto an existing listing: exclude its own current size
    // from the running total, since it's about to be replaced, not
    // added on top of.
    const projected = agentZipStorageBytes(agentAddress, listingId) + file.size;
    if (projected > config.marketplaceMaxAgentStorageBytes) {
      return {
        status: 413,
        body: {
          error: "agent_storage_cap_exceeded",
          capBytes: config.marketplaceMaxAgentStorageBytes,
          projectedBytes: projected,
        },
      };
    }

    const oldFilePath = existing.file_path;
    const newVersion = existing.version + 1;
    db.prepare(
      `UPDATE listings SET name = ?, description = ?, price_usdc = ?, category = ?, validator_address = ?,
         file_path = ?, file_original_name = ?, file_size_bytes = ?, file_sha256 = ?, schema = ?, licensing_terms = ?, version = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      description ?? null,
      priceUsdc,
      category ?? null,
      validatorAddress ?? null,
      file.path,
      file.originalname,
      file.size,
      fileSha256,
      schemaText,
      licensingTerms ?? null,
      newVersion,
      now,
      listingId,
    );
    if (oldFilePath && oldFilePath !== file.path) fs.unlink(oldFilePath, () => {});
    recordListingVersion({
      id: listingId,
      version: newVersion,
      name,
      description: description ?? null,
      price_usdc: priceUsdc,
      category: category ?? null,
      licensing_terms: licensingTerms ?? null,
      delivery_type: "zip",
      endpoint_url: null,
      file_original_name: file.originalname,
      file_size_bytes: file.size,
      file_sha256: fileSha256,
      schema: schemaText,
    });
    return { status: 200, body: { id: listingId, updated: true, version: newVersion } };
  }

  // New listing: the whole file size adds to whatever this agent
  // already has on disk from other zip listings.
  const projected = agentZipStorageBytes(agentAddress) + file.size;
  if (projected > config.marketplaceMaxAgentStorageBytes) {
    return {
      status: 413,
      body: {
        error: "agent_storage_cap_exceeded",
        capBytes: config.marketplaceMaxAgentStorageBytes,
        projectedBytes: projected,
      },
    };
  }

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO listings
       (id, seller_address, name, description, price_usdc, delivery_type, file_path, file_original_name, file_size_bytes, file_sha256, schema, category, active, status, version, validator_address, licensing_terms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'zip', ?, ?, ?, ?, ?, ?, 1, 'active', 1, ?, ?, ?, ?)`,
  ).run(
    id,
    agentAddress,
    name,
    description ?? null,
    priceUsdc,
    file.path,
    file.originalname,
    file.size,
    fileSha256,
    schemaText,
    category ?? null,
    validatorAddress ?? null,
    licensingTerms ?? null,
    now,
    now,
  );
  recordListingVersion({
    id,
    version: 1,
    name,
    description: description ?? null,
    price_usdc: priceUsdc,
    category: category ?? null,
    licensing_terms: licensingTerms ?? null,
    delivery_type: "zip",
    endpoint_url: null,
    file_original_name: file.originalname,
    file_size_bytes: file.size,
    file_sha256: fileSha256,
    schema: schemaText,
  });
  emitEvent({
    agentAddress,
    role: "Marketing",
    subRole: "Listings",
    eventType: "listing_created",
    message: `Listed "${name}" at $${priceUsdc}`,
    metadata: { listingId: id, category: category ?? null, deliveryType: "zip" },
  });
  return { status: 201, body: { id, created: true, version: 1 } };
}

/**
 * POST /marketplace/list/upload — zip-mode counterpart to POST /list.
 * multipart/form-data: same text fields as /list (minus endpointUrl,
 * plus none required beyond what's below) with the zip itself on field
 * "zip". Sellers who'd rather host the deliverable themselves, or are
 * selling something that isn't a file at all (an API key, a data feed
 * URL), still want POST /list — this route is only for "the listing IS
 * the file".
 *
 * Two independent caps (both in config.ts, both env-overridable so they
 * can move the next time the VM's disk changes):
 *   - per-file: config.marketplaceMaxFileBytes (100MB default) — one
 *     project's zip can't exceed this, enforced by multer before the
 *     request body is even fully read.
 *   - per-agent: config.marketplaceMaxAgentStorageBytes (3GB default) —
 *     everything this agent has uploaded across all their zip listings,
 *     combined, can't exceed this. Checked after the file lands on disk
 *     (need its real size), so a rejection here still cleans up the
 *     temp file multer already wrote.
 *
 * listingId here must already be a zip-mode listing (created via this
 * same route, or via /list/upload-from-office below) — same reasoning
 * as /list rejecting zip listings, in reverse: a delivery mode is
 * fixed at creation, not swapped in an update.
 *
 * If your agent built the zip inside its own sandbox rather than
 * holding it in the calling process, prefer POST
 * /list/upload-from-office instead — this route's multipart body isn't
 * a safe way to move a binary file that already lives in the agent's
 * office/workspace, since it has to round-trip back out to wherever
 * this request originates from first.
 */
router.post("/list/upload", uploadZip, async (req, res) => {
  const cleanup = () => {
    if (req.file) fs.unlink(req.file.path, () => {});
  };

  const { agentAddress, name, description, priceUsdc, category, listingId, validatorAddress, schema, licensingTerms } =
    req.body as {
      agentAddress?: string;
      name?: string;
      description?: string;
      priceUsdc?: string;
      category?: string;
      listingId?: string;
      validatorAddress?: string;
      schema?: string; // multipart fields are always strings — JSON-encoded here
      licensingTerms?: string;
    };

  if (!(await requireSellerAuth(req, res, agentAddress))) {
    // Clean up the temp upload multer already wrote to disk before auth
    // failed — otherwise a stream of unauthorized requests fills the disk.
    cleanup();
    return;
  }

  if (!agentAddress || !name || !priceUsdc) {
    cleanup();
    return res.status(400).json({ error: "agentAddress, name, and priceUsdc are required" });
  }
  const fieldError = validateListingFields({ category, licensingTerms });
  if (fieldError) {
    cleanup();
    return res.status(400).json(fieldError);
  }
  if (!req.file) {
    return res.status(400).json({ error: "zip file (field 'zip') is required" });
  }
  let schemaText: string | null = null;
  if (schema !== undefined && schema !== "") {
    const parsed = safeJsonParse(schema);
    if (parsed === null) {
      cleanup();
      return res.status(400).json({ error: "schema must be valid JSON" });
    }
    schemaText = schema;
  }

  const agent = db.prepare(`SELECT address FROM agents WHERE address = ?`).get(agentAddress);
  if (!agent) {
    cleanup();
    return res.status(404).json({ error: `unknown agent: ${agentAddress}` });
  }

  // Phase 7d: agentAddress is confirmed real (row exists above) and the
  // caller already proved ownership of it (requireSellerAuth, above) —
  // only now is it safe to use as a filesystem path segment. Moves the
  // file out of the flat staging directory into its seller-scoped
  // subdirectory before anything below computes a hash or writes a
  // file_path to the DB, so every path that ever reaches the database
  // is already the new, isolated one — never the transient staging path.
  try {
    req.file.path = moveIntoSellerUploadsDir(agentAddress, req.file.path);
  } catch (err) {
    cleanup();
    return res.status(400).json({ error: "invalid_agent_address", detail: (err as Error).message });
  }

  const result = writeZipListing(
    agentAddress,
    name,
    description ?? null,
    priceUsdc,
    category ?? null,
    listingId,
    validatorAddress ?? null,
    schemaText,
    { path: req.file.path, originalname: req.file.originalname, size: req.file.size },
    licensingTerms ?? null,
  );
  // Any non-2xx outcome from writeZipListing means the just-moved file
  // was never referenced by a successful DB write (or was replaced by
  // it) — either way it would otherwise leak on disk forever.
  if (result.status >= 300) fs.unlink(req.file.path, () => {});
  res.status(result.status).json(result.body);
});

/**
 * POST /marketplace/list/upload-from-office
 * Body: { agentAddress, officePath, name, description?, priceUsdc, category?, listingId?, validatorAddress?, schema?, sellerSignature? }
 *
 * The office-native counterpart to POST /list/upload. A Builder Agent
 * that assembled its deliverable with `exec` (e.g. `zip -r out.zip .`)
 * has the file sitting in its own office/workspace on this same host —
 * routing it back out through this backend's HTTP layer as a multipart
 * body would mean reading it as text somewhere in that hop, which is
 * lossy for arbitrary binary content. This route instead reads the
 * bytes directly off disk, scoped to the calling agent's own workspace
 * via the same safeOfficePath() every other office-aware route uses
 * (see vmService.ts's /vm/file/read|write) — so it's exactly as
 * path-escape-safe as those, no new trust boundary introduced.
 *
 * `officePath` is relative to that agent's office/fs/workspace root —
 * the same root /vm/file/read and /vm/file/write already operate on,
 * so whatever path an agent's own exec/write_file calls used to build
 * or place the zip is the same path to pass here.
 *
 * Everything else — auth, caps, DB write, zip/url-mode exclusivity —
 * is identical to POST /list/upload; both funnel through
 * writeZipListing() above so they can't drift apart.
 */
router.post("/list/upload-from-office", async (req, res) => {
  const { agentAddress, officePath, name, description, priceUsdc, category, listingId, validatorAddress, schema, licensingTerms } =
    req.body as {
      agentAddress?: string;
      officePath?: string;
      name?: string;
      description?: string;
      priceUsdc?: string;
      category?: string;
      listingId?: string;
      validatorAddress?: string;
      schema?: unknown;
      licensingTerms?: string;
    };

  if (!(await requireSellerAuth(req, res, agentAddress))) return;

  if (!agentAddress || !officePath || !name || !priceUsdc) {
    return res
      .status(400)
      .json({ error: "agentAddress, officePath, name, and priceUsdc are required" });
  }
  const fieldError = validateListingFields({ category, licensingTerms });
  if (fieldError) return res.status(400).json(fieldError);

  let schemaText: string | null = null;
  if (schema !== undefined && schema !== null) {
    schemaText = JSON.stringify(schema);
  }

  const agent = db.prepare(`SELECT address FROM agents WHERE address = ?`).get(agentAddress);
  if (!agent) {
    return res.status(404).json({ error: `unknown agent: ${agentAddress}` });
  }

  // safeOfficePath() throws (400-status Error) if officePath tries to
  // escape this agent's own workspace root — same guard every other
  // office-touching route already relies on.
  let sourcePath: string;
  try {
    sourcePath = safeOfficePath(agentAddress, officePath);
  } catch (err) {
    return res
      .status((err as { status?: number }).status || 400)
      .json({ error: "invalid_office_path", detail: (err as Error).message });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(sourcePath);
  } catch {
    return res.status(404).json({ error: "office_file_not_found", officePath });
  }
  if (!stat.isFile()) {
    return res.status(400).json({ error: "office_path_is_not_a_file", officePath });
  }
  if (stat.size > config.marketplaceMaxFileBytes) {
    return res.status(413).json({
      error: "file_too_large",
      maxBytes: config.marketplaceMaxFileBytes,
      actualBytes: stat.size,
    });
  }

  // Copy (never move) out of the agent's office — the source file stays
  // exactly where the agent's own exec session put it, so a re-upload,
  // a listingId update, or the agent just wanting its own local copy
  // back are all unaffected by this route ever having run.
  const stagingPath = path.join(config.marketplaceUploadsDir, `${crypto.randomUUID()}.zip`);
  fs.copyFileSync(sourcePath, stagingPath);

  let finalPath: string;
  try {
    finalPath = moveIntoSellerUploadsDir(agentAddress, stagingPath);
  } catch (err) {
    fs.unlink(stagingPath, () => {});
    return res.status(400).json({ error: "invalid_agent_address", detail: (err as Error).message });
  }

  const result = writeZipListing(
    agentAddress,
    name,
    description ?? null,
    priceUsdc,
    category ?? null,
    listingId,
    validatorAddress ?? null,
    schemaText,
    { path: finalPath, originalname: path.basename(officePath), size: stat.size },
    licensingTerms ?? null,
  );
  if (result.status >= 300) fs.unlink(finalPath, () => {});
  res.status(result.status).json(result.body);
});

/**
 * POST /marketplace/:id/deactivate  — seller-only, pulls a listing out
 * of discovery without deleting its history (payments/receipts already
 * made against it stay intact). Unchanged behavior, plus keeps the new
 * `status` column in sync (sets it to 'archived') — see POST
 * /:id/status for the richer, reversible version of this.
 */
router.post("/:id/deactivate", (req, res) => {
  if (!requireBackendKey(req, res)) return;
  const { agentAddress } = req.body as { agentAddress?: string };
  const row = db
    .prepare(`SELECT seller_address FROM listings WHERE id = ?`)
    .get(req.params.id) as { seller_address: string } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.seller_address !== agentAddress) {
    return res.status(403).json({ error: "listing belongs to a different agent" });
  }
  db.prepare(`UPDATE listings SET active = 0, status = 'archived', updated_at = ? WHERE id = ?`).run(
    Date.now(),
    req.params.id,
  );
  res.json({ id: req.params.id, active: false, status: "archived" });
});

/**
 * POST /marketplace/:id/status — seller-only, sets a listing to one of
 * draft | active | paused | archived (LISTING_STATUSES). This is the
 * general-purpose lifecycle control POST /:id/deactivate always should
 * have been: deactivate is permanent-flavored and only ever moves to
 * 'archived', this route can also move a listing back to 'active' (e.g.
 * unpausing after fixing a down endpoint) or park it in 'draft' while
 * still being edited via POST /list.
 *
 * Same dual auth as POST /list (x-backend-key OR sellerSignature) —
 * unlike /:id/deactivate, which still only accepts x-backend-key; that
 * route is left as-is for backward compatibility rather than changed
 * out from under existing callers.
 *
 * The legacy `active` column stays in sync: 1 iff status='active', 0
 * for every other status, so GET /listings' default `active = 1` filter
 * and POST /:id/invoke's `active = 1` gate both keep working unmodified.
 */
router.post("/:id/status", async (req, res) => {
  const { agentAddress, status } = req.body as { agentAddress?: string; status?: string };
  if (!status || !LISTING_STATUSES.has(status)) {
    return res.status(400).json({ error: "invalid_status", allowed: Array.from(LISTING_STATUSES) });
  }
  if (!(await requireSellerAuth(req, res, agentAddress))) return;

  const row = db
    .prepare(`SELECT seller_address FROM listings WHERE id = ?`)
    .get(req.params.id) as { seller_address: string } | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.seller_address !== agentAddress) {
    return res.status(403).json({ error: "listing belongs to a different agent" });
  }

  db.prepare(`UPDATE listings SET status = ?, active = ?, updated_at = ? WHERE id = ?`).run(
    status,
    status === "active" ? 1 : 0,
    Date.now(),
    req.params.id,
  );
  res.json({ id: req.params.id, status, active: status === "active" });
});

/** GET /marketplace/categories — the fixed taxonomy POST /list and the
 * upload routes validate `category` against. Public, no auth. */
router.get("/categories", (_req, res) => {
  res.json({ categories: LISTING_CATEGORIES });
});

/**
 * GET /marketplace/listings — public discovery.
 *
 * Filters: ?category=, ?sellerAddress=, ?status= (one of
 * LISTING_STATUSES; defaults to the original `active = 1` behavior
 * when omitted, so existing callers see no change).
 *
 * ?q= adds relevance search on top of whatever the filters above
 * already narrowed down to: name, description, category, and licensing
 * terms are scored with this backend's own TF-IDF cosine-similarity
 * ranker (tfidf.ts — the same dependency-free "semantic-ish" search
 * already used for memory/opportunity matching elsewhere in this
 * codebase, not a literal embeddings call), and only listings that
 * score above zero are returned, most-relevant first. Without ?q=,
 * results stay in their existing `ORDER BY created_at DESC`.
 */
router.get("/listings", (req, res) => {
  const { category, sellerAddress, status, q } = req.query as {
    category?: string;
    sellerAddress?: string;
    status?: string;
    q?: string;
  };
  if (status && !LISTING_STATUSES.has(status)) {
    return res.status(400).json({ error: "invalid_status", allowed: Array.from(LISTING_STATUSES) });
  }

  let query = `SELECT * FROM listings WHERE `;
  const params: string[] = [];
  if (status) {
    query += `status = ?`;
    params.push(status);
  } else {
    // Unchanged default from before status existed: only what's
    // actually purchasable shows up unless a caller explicitly asks
    // for another status (e.g. a seller checking their own drafts).
    query += `active = 1`;
  }
  if (category) {
    query += ` AND category = ?`;
    params.push(category);
  }
  if (sellerAddress) {
    query += ` AND seller_address = ?`;
    params.push(sellerAddress);
  }
  query += ` ORDER BY created_at DESC`;
  let rows = db.prepare(query).all(...params) as ListingRow[];

  if (q && q.trim()) {
    rows = rankByRelevance(
      q,
      rows,
      (row) => [row.name, row.description ?? "", row.category ?? "", row.licensing_terms ?? ""].join(" "),
      rows.length,
    );
  }

  res.json({ listings: rows.map(toPublicListing) });
});

/** GET /marketplace/listings/:id — a single listing, public. */
router.get("/listings/:id", (req, res) => {
  const row = db.prepare(`SELECT * FROM listings WHERE id = ?`).get(req.params.id) as
    | ListingRow
    | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(toPublicListing(row));
});

/**
 * GET /marketplace/listings/:id/versions — public version history.
 * Newest first. Same withheld-fields policy as toPublicListing():
 * endpoint_url/file_path/file_sha256 never appear here either, only
 * file name/size for zip-mode versions — this is "what changed and
 * when", not a free way to fetch a past deliverable.
 */
router.get("/listings/:id/versions", (req, res) => {
  const listing = db.prepare(`SELECT id FROM listings WHERE id = ?`).get(req.params.id);
  if (!listing) return res.status(404).json({ error: "not_found" });

  const rows = db
    .prepare(`SELECT * FROM listing_versions WHERE listing_id = ? ORDER BY version DESC`)
    .all(req.params.id) as ListingVersionRow[];

  res.json({
    listingId: req.params.id,
    versions: rows.map((v) => ({
      version: v.version,
      name: v.name,
      description: v.description,
      priceUsdc: v.price_usdc,
      category: v.category,
      licensingTerms: v.licensing_terms,
      deliveryType: v.delivery_type,
      schema: v.schema ? safeJsonParse(v.schema) : null,
      file:
        v.delivery_type === "zip"
          ? { name: v.file_original_name, sizeBytes: v.file_size_bytes }
          : undefined,
      createdAt: v.created_at,
    })),
  });
});

/**
 * POST /marketplace/:id/invoke
 * Body: { buyerAddress, input?, xPayment? } — or, when a founder fee
 * is configured, { buyerAddress, input?, xPayments: { seller, founder } }
 *
 * Same 402 shape as /inference/chat, but payTo is the *seller's*
 * address instead of your treasury, and the money moves straight from
 * buyer to seller — this backend never custodies it.
 *
 * When a founder fee is active (config.founderWalletAddress set), the
 * price splits into two independently signed x402 payments that must
 * both be provided together: one to the seller for its share, one to
 * the founder wallet for its share. Still non-custodial — each leg
 * settles straight from the buyer's own wallet to its own recipient,
 * this backend just requires both signatures before it will proxy the
 * call, and settles the founder leg first so the fee can't be skipped
 * by a buyer who only signs the seller leg.
 *
 * Order matters here: verify signatures first (no funds move yet),
 * call the seller's endpoint, and only settle (move the money) once
 * the seller's endpoint actually responded successfully. If the
 * seller's service is down, the buyer isn't charged for it — unlike
 * /inference/chat's fire-and-forget settle, which charges regardless
 * of what happens after the OpenRouter call succeeds.
 */
router.post("/:id/invoke", async (req, res) => {
  const { buyerAddress, input, xPayment, xPayments } = req.body as {
    buyerAddress?: string;
    input?: unknown;
    xPayment?: XPaymentLeg;
    xPayments?: { seller?: XPaymentLeg; founder?: XPaymentLeg };
  };

  if (!buyerAddress) {
    return res.status(400).json({ error: "buyerAddress required" });
  }

  // Same guardrail shape as checkInferenceBudget in inferenceGateway.ts
  // — checked before the listing lookup even, so a buyer that's already
  // over budget gets a fast, uniform 429 regardless of which listing
  // they're hitting.
  const budget = checkMarketplaceBudget(buyerAddress);
  if (!budget.ok) {
    return res.status(429).json({ error: "budget_exceeded", reason: budget.reason });
  }

  const listing = db
    .prepare(`SELECT * FROM listings WHERE id = ? AND active = 1`)
    .get(req.params.id) as ListingRow | undefined;
  if (!listing) {
    return res.status(404).json({ error: "listing not found or inactive" });
  }

  // Phase 16c: routes this call through the same audited
  // capability_audit trail every other gated route uses. Today this
  // always allows (see capability.ts's own "marketplace_listing is a
  // public resource" comment on checkCapability()) — the listing lookup
  // just above already confirmed existence/active, so this can't
  // actually 404 in practice here, it's the delegation/channel-check
  // machinery future per-listing restrictions would need that matters,
  // plus a real audit row for who invoked what.
  try {
    checkCapability({
      caller: buyerAddress,
      resourceType: "marketplace_listing",
      resourceId: listing.id,
      action: "exec",
    });
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }

  const split = computeFeeSplit(listing.price_usdc);
  const sellerLeg = split.active ? xPayments?.seller : xPayment ?? xPayments?.seller;
  const founderLeg = split.active ? xPayments?.founder : undefined;

  if (!sellerLeg || (split.active && !founderLeg)) {
    return res.status(402).json({
      x402Version: 1,
      // requireAll: every entry in `accepts` must be paid and submitted
      // together as `xPayments: { seller, founder }` in the retry —
      // this is a custom extension of the base x402 402-response shape
      // (which normally lets a payer choose exactly one entry), used
      // only when a founder fee is active for this listing.
      requireAll: split.active,
      accepts: split.active
        ? [
            {
              scheme: "exact",
              network: config.chainNetwork,
              maxAmountRequired: split.sellerAmount,
              payToAddress: listing.seller_address,
              requiredDeadlineSeconds: 300,
              resource: `/marketplace/${listing.id}/invoke`,
              description: listing.name,
              leg: "seller",
            },
            {
              scheme: "exact",
              network: config.chainNetwork,
              maxAmountRequired: split.founderAmount,
              payToAddress: config.founderWalletAddress,
              requiredDeadlineSeconds: 300,
              resource: `/marketplace/${listing.id}/invoke`,
              description: `${listing.name} (platform fee)`,
              leg: "founder",
            },
          ]
        : [
            {
              scheme: "exact",
              network: config.chainNetwork,
              maxAmountRequired: listing.price_usdc,
              payToAddress: listing.seller_address,
              requiredDeadlineSeconds: 300,
              resource: `/marketplace/${listing.id}/invoke`,
              description: listing.name,
            },
          ],
    });
  }

  // Signature/balance checks only — no funds move here. This internal
  // loopback call still passes through index.ts's shared-secret
  // middleware, so it needs the backend key even though the original
  // caller (a stranger's agent) never had one.
  const sellerCheck = await verifyLeg(sellerLeg, listing.seller_address, split.sellerAmount);
  if (!sellerCheck.ok) {
    return res.status(sellerCheck.status).json(sellerCheck.body);
  }
  if (split.active && founderLeg) {
    const founderCheck = await verifyLeg(founderLeg, config.founderWalletAddress, split.founderAmount);
    if (!founderCheck.ok) {
      return res.status(founderCheck.status).json({ ...founderCheck.body, leg: "founder" });
    }
  }

  const invocationId = crypto.randomUUID();
  const inputHash = input === undefined ? null : sha256Hex(JSON.stringify(input));
  const startedAt = Date.now();

  // Zip-mode listings have no seller endpoint to proxy to — there's
  // nothing to call and nothing that can be "unreachable". The file's
  // hash was already computed at upload time, so it stands in for
  // response_hash/evidence the same way a seller's response body would.
  // Settlement and the reputation/flag mechanism below are identical to
  // url mode; only "what does the buyer get back" differs.
  if (listing.delivery_type === "zip") {
    if (!listing.file_path || !fs.existsSync(listing.file_path)) {
      return res.status(500).json({ error: "listing_file_missing" });
    }

    // Founder leg settles first: if it fails, abort before the seller
    // sees a dime and before anything is delivered. This is the actual
    // enforcement point — not a policy the agent could ignore.
    let founderSettlement: { success: boolean; id?: string; txHash?: string; error?: string } | null = null;
    if (split.active && founderLeg) {
      founderSettlement = await settleLeg(founderLeg, `marketplace-founder-fee:${listing.id}`);
      if (!founderSettlement.success) {
        recordInvocation({
          id: invocationId,
          listing,
          buyerAddress,
          inputHash,
          outcome: "delivered",
          responseStatus: 200,
          responseHash: listing.file_sha256,
          latencyMs: Date.now() - startedAt,
          settlementId: null,
          founderSettlementId: null,
          founderAmountUsdc: split.founderAmount,
        });
        return res
          .status(502)
          .json({ error: "founder_fee_settlement_failed", detail: founderSettlement.error, invocationId });
      }
    }

    const settlement = await settleLeg(sellerLeg, `marketplace:${listing.id}`);
    if (!settlement.success) {
      // Matches url-mode's settlement-failure handling below: outcome
      // stays "delivered" (the file exists and is ready — this backend's
      // job was done) even though settlement_id is null, since it's an
      // operator/facilitator problem, not evidence the deliverable itself
      // was bad.
      recordInvocation({
        id: invocationId,
        listing,
        buyerAddress,
        inputHash,
        outcome: "delivered",
        responseStatus: 200,
        responseHash: listing.file_sha256,
        latencyMs: Date.now() - startedAt,
        settlementId: null,
        founderSettlementId: founderSettlement?.id ?? null,
        founderAmountUsdc: split.active ? split.founderAmount : null,
      });
      return res
        .status(502)
        .json({ error: "settlement_failed", detail: settlement.error, invocationId });
    }

    // next-phase.md Phase 6e — resolved right before the successful
    // recordInvocation() call, never earlier: an earlier failure-path
    // call above (founder-fee settlement failed, seller settlement
    // failed) has no completed payment for a channel grant to have
    // "gone through" yet, so those calls correctly never reach this line.
    const zipChannelId = findActiveChannelIdIfAny(buyerAddress, listing.seller_address, "payment");
    recordInvocation({
      id: invocationId,
      listing,
      buyerAddress,
      inputHash,
      outcome: "delivered",
      responseStatus: 200,
      responseHash: listing.file_sha256,
      latencyMs: Date.now() - startedAt,
      settlementId: settlement.id ?? null,
      founderSettlementId: founderSettlement?.id ?? null,
      founderAmountUsdc: split.active ? split.founderAmount : null,
      channelId: zipChannelId,
    });
    auditMarketplacePayment(
      buyerAddress,
      listing.seller_address,
      invocationId,
      listing.id,
      zipChannelId,
      listing.price_usdc,
      settlement.txHash,
    );

    db.prepare(
      `INSERT INTO usage_log (agent_address, service, units, cost_usdc, created_at)
       VALUES (?, 'marketplace', 1, ?, ?)`,
    ).run(buyerAddress, listing.price_usdc, Date.now());

    const downloadToken = crypto.randomUUID();
    db.prepare(
      `INSERT INTO marketplace_downloads (token, listing_id, invocation_id, buyer_address, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      downloadToken,
      listing.id,
      invocationId,
      buyerAddress,
      Date.now() + config.marketplaceDownloadTtlMs,
      Date.now(),
    );

    return res.json({
      downloadUrl: `${config.publicBaseUrl}/marketplace/download/${downloadToken}`,
      expiresInMs: config.marketplaceDownloadTtlMs,
      fileSha256: listing.file_sha256,
      receiptId: settlement.id,
      txHash: settlement.txHash,
      chargedUsdc: listing.price_usdc,
      founderFeeUsdc: split.active ? split.founderAmount : undefined,
      invocationId,
    });
  }

  let proxied: unknown;
  let rawResponseText: string | undefined;
  let pendingEvidence: Omit<InvocationEvidence, "settlementId"> | undefined;

  try {
    // Guaranteed non-null here: the zip branch above returns before this
    // point, and endpoint_url is NOT NULL-equivalent for every url-mode
    // row (enforced at write time in /list, not by the DB schema itself
    // since the column had to become nullable for zip listings — see
    // the listings migration in db.ts).
    const sellerRes = await fetch(listing.endpoint_url as string, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ buyerAddress, input }),
    });
    const latencyMs = Date.now() - startedAt;

    if (!sellerRes.ok) {
      const text = await sellerRes.text();
      recordInvocation({
        id: invocationId,
        listing,
        buyerAddress,
        inputHash,
        outcome: "seller_error",
        responseStatus: sellerRes.status,
        responseHash: sha256Hex(text),
        latencyMs,
        settlementId: null,
      });
      return res
        .status(502)
        .json({ error: "seller_endpoint_error", detail: text, invocationId });
    }

    rawResponseText = await sellerRes.text();
    proxied = rawResponseText.length ? JSON.parse(rawResponseText) : null;

    // Not-yet-settled evidence row, in case an opt-in validation request
    // below needs requestHash before we know the settlement id. Filled
    // in for real once settlement is confirmed further down; this
    // in-memory record isn't persisted until then.
    pendingEvidence = {
      id: invocationId,
      listing,
      buyerAddress,
      inputHash,
      outcome: "delivered",
      responseStatus: sellerRes.status,
      responseHash: sha256Hex(rawResponseText),
      latencyMs,
    };
  } catch (err: any) {
    recordInvocation({
      id: invocationId,
      listing,
      buyerAddress,
      inputHash,
      outcome: "seller_unreachable",
      responseStatus: null,
      responseHash: null,
      latencyMs: Date.now() - startedAt,
      settlementId: null,
    });
    return res
      .status(502)
      .json({ error: "seller_endpoint_unreachable", detail: err.message, invocationId });
  }

  // Every early-return path above (seller_error, seller_unreachable)
  // returns before this line, so pendingEvidence is always set here —
  // TS just can't see that across the try/catch.
  if (!pendingEvidence) {
    return res.status(500).json({ error: "internal_invoke_state_error", invocationId });
  }

  // Only now — after the seller actually delivered — move the money.
  // Founder leg first: if it fails, don't pay the seller either and
  // don't hand back the result, even though the seller already did
  // the work. Rare (facilitator/chain-level failure), but "founder fee
  // guaranteed before anything" means the seller isn't paid off the
  // back of a skipped fee.
  let founderSettlement: { success: boolean; id?: string; txHash?: string; error?: string } | null = null;
  if (split.active && founderLeg) {
    founderSettlement = await settleLeg(founderLeg, `marketplace-founder-fee:${listing.id}`);
    if (!founderSettlement.success) {
      recordInvocation({ ...pendingEvidence, settlementId: null, founderSettlementId: null, founderAmountUsdc: split.founderAmount });
      return res
        .status(502)
        .json({ error: "founder_fee_settlement_failed", detail: founderSettlement.error, invocationId });
    }
  }

  const settlement = await settleLeg(sellerLeg, `marketplace:${listing.id}`);
  if (!settlement.success) {
    // Seller already did the work but on-chain settlement failed (e.g. gas
    // issue on your facilitator wallet). Surface this distinctly — it's an
    // operator problem, not the buyer's or seller's fault. Still record
    // the evidence: the seller's response happened and is provable even
    // though payment didn't go through this time.
    recordInvocation({
      ...pendingEvidence,
      settlementId: null,
      founderSettlementId: founderSettlement?.id ?? null,
      founderAmountUsdc: split.active ? split.founderAmount : null,
    });
    return res
      .status(502)
      .json({ error: "settlement_failed", detail: settlement.error, invocationId });
  }

  // next-phase.md Phase 6e — same "resolve only at the point of an
  // actual completed payment" placement as the zip-mode branch above.
  const urlChannelId = findActiveChannelIdIfAny(buyerAddress, listing.seller_address, "payment");
  recordInvocation({
    ...pendingEvidence,
    settlementId: settlement.id ?? null,
    founderSettlementId: founderSettlement?.id ?? null,
    founderAmountUsdc: split.active ? split.founderAmount : null,
    channelId: urlChannelId,
  });
  auditMarketplacePayment(
    buyerAddress,
    listing.seller_address,
    invocationId,
    listing.id,
    urlChannelId,
    listing.price_usdc,
    settlement.txHash,
  );

  db.prepare(
    `INSERT INTO usage_log (agent_address, service, units, cost_usdc, created_at)
     VALUES (?, 'marketplace', 1, ?, ?)`,
  ).run(buyerAddress, listing.price_usdc, Date.now());

  // Opt-in ERC-8004 Validation Registry hook — fire-and-forget, never
  // blocks the response and never affects what was already settled
  // above. Only runs if the listing named a validator and the seller
  // holds a backend-custodied wallet with an on-chain ERC-8004 identity;
  // any other combination silently skips this (self-custody sellers
  // would need to request their own validation directly).
  maybeRequestValidation(listing, invocationId, pendingEvidence.responseHash).catch(() => {});

  res.json({
    result: proxied,
    receiptId: settlement.id,
    txHash: settlement.txHash,
    chargedUsdc: listing.price_usdc,
    founderFeeUsdc: split.active ? split.founderAmount : undefined,
    invocationId,
  });
});

/**
 * GET /marketplace/download/:token — redeem a download link handed out
 * by a zip-mode POST /:id/invoke. Public (no backend key): the buyer's
 * agent has no BACKEND_API_KEY, same reasoning as GET /receipt/:id.
 * Single-use and TTL-bounded (config.marketplaceDownloadTtlMs) — payment
 * already happened, this route never touches money, it just decides
 * whether this specific token still gets to pull the bytes.
 */
router.get("/download/:token", (req, res) => {
  const row = db
    .prepare(
      `SELECT listing_id, used, expires_at FROM marketplace_downloads WHERE token = ?`,
    )
    .get(req.params.token) as
    | { listing_id: string; used: number; expires_at: number }
    | undefined;
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.used) return res.status(410).json({ error: "already_used" });
  if (Date.now() > row.expires_at) return res.status(410).json({ error: "expired" });

  // Claim it atomically: the SELECT above is just for the 404/410
  // messages above, it isn't what actually prevents a double download.
  // Two requests for the same token arriving close together (this IS
  // exactly the "buyer forwards the link" case, both hitting it near-
  // simultaneously) would both pass the row.used check above before
  // either write lands. This UPDATE ... WHERE used = 0 is the actual
  // gate — only one of two concurrent requests can flip 0->1, and
  // `changes` tells you which one it was.
  const claim = db
    .prepare(`UPDATE marketplace_downloads SET used = 1 WHERE token = ? AND used = 0`)
    .run(req.params.token);
  if (claim.changes === 0) {
    return res.status(410).json({ error: "already_used" });
  }

  const listing = db
    .prepare(`SELECT file_path, file_original_name FROM listings WHERE id = ?`)
    .get(row.listing_id) as { file_path: string | null; file_original_name: string | null } | undefined;
  if (!listing?.file_path || !fs.existsSync(listing.file_path)) {
    return res.status(500).json({ error: "listing_file_missing" });
  }

  res.download(listing.file_path, listing.file_original_name || "download.zip");
});

interface InvocationEvidence {
  id: string;
  listing: ListingRow;
  buyerAddress: string;
  inputHash: string | null;
  outcome: "delivered" | "seller_error" | "seller_unreachable";
  responseStatus: number | null;
  responseHash: string | null;
  latencyMs: number;
  settlementId: string | null;
  founderSettlementId?: string | null;
  founderAmountUsdc?: string | null;
  // next-phase.md Phase 6e — set only on the one recordInvocation() call
  // per /:id/invoke where the seller leg actually settled; every other
  // call site (seller_error, seller_unreachable, a failed founder-fee
  // or seller settlement) simply omits it, which the `?? null` below
  // already handles the same way founderSettlementId/founderAmountUsdc
  // do for their own not-always-applicable cases.
  channelId?: string | null;
}

function recordInvocation(ev: InvocationEvidence): void {
  db.prepare(
    `INSERT INTO invocations
       (id, listing_id, seller_address, buyer_address, price_usdc, input_hash, outcome, response_status, response_hash, latency_ms, settlement_id, founder_settlement_id, founder_amount_usdc, channel_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.id,
    ev.listing.id,
    ev.listing.seller_address,
    ev.buyerAddress,
    ev.listing.price_usdc,
    ev.inputHash,
    ev.outcome,
    ev.responseStatus,
    ev.responseHash,
    ev.latencyMs,
    ev.settlementId,
    ev.founderSettlementId ?? null,
    ev.founderAmountUsdc ?? null,
    ev.channelId ?? null,
    Date.now(),
  );
}

/**
 * next-phase.md Phase 6e — the marketplace's own call into Phase 3g-i's
 * audit-hook mechanism, reusing erc8004Trust.ts's recordChannelEvent()
 * directly rather than inventing a second on-chain write path (the
 * "existing hook, not a new parallel mechanism" requirement Phase 6e's
 * own "Done when" line names explicitly). Same fire-and-forget, never-
 * awaited-by-the-caller, self-custody/unregistered-skips-silently
 * contract as channelService.ts's own auditChannelEvent() — deliberately
 * NOT a call to that function itself, since it's module-private to
 * channelService.ts and typed to its own seven-value ChannelEventType
 * union; recordChannelEvent()'s own `eventType: string` parameter is
 * intentionally untyped for exactly this reason, so a second file can
 * extend the same audit trail with its own event vocabulary without
 * channelService.ts having to know marketplace.ts exists.
 *
 * Recorded under the BUYER's own agentId — the paying party is the one
 * whose action this event describes, same "acting agent" convention
 * auditChannelEvent() uses for send_file (sender) and request_file
 * (requester) rather than the passive counterparty.
 *
 * `channelId` is included in the hashed detail blob whether it's a real
 * id or null — a marketplace payment that went through with NO channel
 * (the ordinary case, per Phase 6b) is exactly as auditable as one that
 * did, so this is called unconditionally on every successful settlement,
 * not only when a channel happened to exist. "Traceable back to its
 * channel grant" for the common no-channel case means the on-chain
 * record itself honestly says so, not that the event goes unrecorded.
 */
function auditMarketplacePayment(
  buyerAddress: string,
  sellerAddress: string,
  invocationId: string,
  listingId: string,
  channelId: string | null,
  priceUsdc: string,
  settlementTxHash: string | undefined,
): void {
  (async () => {
    const buyer = db
      .prepare(`SELECT encrypted_key, erc8004_agent_id FROM agents WHERE address = ?`)
      .get(buyerAddress) as { encrypted_key: string | null; erc8004_agent_id: string | null } | undefined;
    if (!buyer?.encrypted_key || !buyer.erc8004_agent_id) return; // self-custody or unregistered — skip, local invocations row still stands

    const buyerAccount = getAgentAccount(buyerAddress);
    const detailHash = `0x${sha256Hex(
      JSON.stringify({ invocationId, listingId, buyerAddress, sellerAddress, channelId, priceUsdc, settlementTxHash }),
    )}` as `0x${string}`;
    const result = await recordChannelEvent(
      buyerAccount,
      buyer.erc8004_agent_id,
      "marketplace_payment",
      `invocation:${invocationId}`,
      detailHash,
    );
    if (result) {
      console.log(`[channel-audit] marketplace_payment actor=${buyerAddress} channel=${channelId ?? "none"} tx=${result.txHash}`);
    } else {
      console.log(`[channel-audit] marketplace_payment actor=${buyerAddress} channel=${channelId ?? "none"} skipped (no on-chain identity, or the call failed — local row stands)`);
    }
  })().catch((err) => {
    // Same "should be unreachable, caught anyway" discipline
    // channelService.ts's own auditChannelEvent() uses — an audit-trail
    // failure can never surface as an error for an already-settled
    // payment.
    console.error(`[channel-audit] marketplace_payment actor=${buyerAddress} unexpected failure:`, err);
  });
}

async function maybeRequestValidation(
  listing: ListingRow,
  invocationId: string,
  responseHash: string | null,
): Promise<void> {
  if (!listing.validator_address || !responseHash) return;

  const seller = db
    .prepare(`SELECT encrypted_key, erc8004_agent_id FROM agents WHERE address = ?`)
    .get(listing.seller_address) as
    | { encrypted_key: string | null; erc8004_agent_id: string | null }
    | undefined;
  if (!seller?.encrypted_key || !seller.erc8004_agent_id) return; // self-custody or unregistered — skip

  const sellerAccount = getAgentAccount(listing.seller_address);
  const requestURI = `${config.publicBaseUrl}/marketplace/invocations/${invocationId}`;
  // Fold the invocation id into the hash rather than using the response
  // hash alone — some Validation Registry implementations enforce
  // global uniqueness on requestHash (to prevent request hijacking), and
  // two invocations returning byte-identical bodies would otherwise
  // collide. GET /invocations/:id recomputes this exact same derivation
  // to look up live status, so the two stay in sync.
  const requestHash = deriveEvidenceHash(invocationId, responseHash);

  const result = await requestValidation(
    sellerAccount,
    seller.erc8004_agent_id,
    listing.validator_address as `0x${string}`,
    requestURI,
    requestHash,
  );
  if (result) {
    db.prepare(`UPDATE invocations SET validation_tx_hash = ? WHERE id = ?`).run(
      result.txHash,
      invocationId,
    );
  }
}

/**
 * GET /marketplace/receipt/:id — public mirror of
 * GET /facilitator/receipt/:id, re-exposed here without the backend
 * key requirement. A stranger's agent that just paid through
 * /invoke has no BACKEND_API_KEY to call the original route with, and
 * the data isn't sensitive — it's the same from/to/value/txHash that's
 * already public on Base once the transfer settles.
 */
router.get("/receipt/:id", (req, res) => {
  const row = db
    .prepare(
      `SELECT id, from_address, to_address, value_usdc, network, tx_hash, status, purpose, created_at
       FROM payments WHERE id = ?`,
    )
    .get(req.params.id) as
    | {
        id: string;
        from_address: string;
        to_address: string;
        value_usdc: string;
        network: string;
        tx_hash: string | null;
        status: string;
        purpose: string | null;
        created_at: number;
      }
    | undefined;

  if (!row) return res.status(404).json({ error: "not_found", id: req.params.id });

  res.json({
    id: row.id,
    from: row.from_address,
    to: row.to_address,
    value: row.value_usdc,
    network: row.network,
    txHash: row.tx_hash,
    status: row.status,
    purpose: row.purpose,
    createdAt: row.created_at,
  });
});

interface InvocationRow {
  id: string;
  listing_id: string;
  seller_address: string;
  buyer_address: string;
  price_usdc: string;
  input_hash: string | null;
  outcome: string;
  response_status: number | null;
  response_hash: string | null;
  latency_ms: number;
  settlement_id: string | null;
  validation_tx_hash: string | null;
  channel_id: string | null; // next-phase.md Phase 6e
  created_at: number;
}

/**
 * GET /marketplace/invocations/:id — public evidence record for one
 * paid invocation: hashes of what was sent/received, the seller's HTTP
 * status, and whether/how it settled. This is what a buyer, seller, or
 * outside arbiter looks at to adjudicate a dispute — same publicness
 * rationale as GET /receipt/:id above. Includes the flag, if any, so
 * the full history of one invocation is visible in one place.
 */
router.get("/invocations/:id", async (req, res) => {
  const row = db
    .prepare(`SELECT * FROM invocations WHERE id = ?`)
    .get(req.params.id) as InvocationRow | undefined;
  if (!row) return res.status(404).json({ error: "not_found", id: req.params.id });

  const flag = db
    .prepare(
      `SELECT reason, detail, onchain_feedback_tx_hash, created_at FROM invocation_flags WHERE invocation_id = ?`,
    )
    .get(req.params.id) as
    | { reason: string; detail: string | null; onchain_feedback_tx_hash: string | null; created_at: number }
    | undefined;

  // Live on-chain read, not just the cached tx hash — if a validator has
  // since posted a response, this reflects it even though this backend
  // never got a webhook for it. Best-effort: null if validation was
  // never requested for this invocation, or the registry read fails.
  let validation: { status: number; validator: string; agentId: string } | null = null;
  if (row.validation_tx_hash && row.response_hash) {
    validation = await getValidationStatus(deriveEvidenceHash(row.id, row.response_hash));
  }

  res.json({
    id: row.id,
    listingId: row.listing_id,
    sellerAddress: row.seller_address,
    buyerAddress: row.buyer_address,
    priceUsdc: row.price_usdc,
    inputHash: row.input_hash,
    outcome: row.outcome,
    responseStatus: row.response_status,
    responseHash: row.response_hash,
    latencyMs: row.latency_ms,
    settlementId: row.settlement_id,
    validationTxHash: row.validation_tx_hash,
    validationStatus: validation,
    // next-phase.md Phase 6e — the specific payment-scoped channel this
    // invocation's payment went through, if any. Null is the ordinary,
    // expected value for a cold-discovery marketplace purchase (Phase
    // 6b's own structural exemption) and every failed-settlement
    // outcome (nothing settled, so nothing to trace) — never treat a
    // null here as a bug.
    channelId: row.channel_id,
    createdAt: row.created_at,
    flag: flag
      ? {
          reason: flag.reason,
          detail: flag.detail,
          onchainFeedbackTxHash: flag.onchain_feedback_tx_hash,
          createdAt: flag.created_at,
        }
      : null,
  });
});

/**
 * POST /marketplace/invocations/:id/flag
 * Body: { buyerAddress, reason, detail? }
 *
 * The dispute path itself. No backend key required — the caller proves
 * standing by matching buyerAddress against the buyer_address already
 * recorded on the invocation at proxy time (invoke.ts writes that row
 * itself, so it can't be spoofed by whoever calls /flag). Reflagging
 * the same invocation by the same buyer updates the existing flag
 * rather than creating a second one.
 *
 * This does NOT touch payments, settlement, or the listings table's
 * money-moving path in any way — it only writes to invocation_flags,
 * which reputationFor() reads to compute the flagRate shown in
 * GET /listings. If the seller has an on-chain ERC-8004 identity, this
 * also best-effort mirrors the flag as negative feedback on the
 * Reputation Registry (see erc8004Trust.ts) — purely additive, and its
 * failure never fails this request.
 */
router.post("/invocations/:id/flag", async (req, res) => {
  const { buyerAddress, reason, detail } = req.body as {
    buyerAddress?: string;
    reason?: string;
    detail?: string;
  };

  if (!buyerAddress || !reason) {
    return res.status(400).json({ error: "buyerAddress and reason are required" });
  }
  if (!FLAG_REASONS.has(reason)) {
    return res
      .status(400)
      .json({ error: "invalid_reason", allowed: Array.from(FLAG_REASONS) });
  }
  if (detail && detail.length > MAX_FLAG_DETAIL_LENGTH) {
    return res
      .status(400)
      .json({ error: "detail_too_long", maxLength: MAX_FLAG_DETAIL_LENGTH });
  }

  const invocation = db
    .prepare(`SELECT * FROM invocations WHERE id = ?`)
    .get(req.params.id) as InvocationRow | undefined;
  if (!invocation) {
    return res.status(404).json({ error: "invocation_not_found" });
  }
  if (invocation.buyer_address.toLowerCase() !== buyerAddress.toLowerCase()) {
    return res.status(403).json({ error: "not_your_invocation" });
  }
  if (invocation.outcome !== "delivered") {
    // Nothing to dispute — the seller either errored or was unreachable,
    // and the buyer was never charged for either (see /:id/invoke).
    return res.status(400).json({ error: "invocation_not_billable", outcome: invocation.outcome });
  }

  const existing = db
    .prepare(`SELECT id FROM invocation_flags WHERE invocation_id = ?`)
    .get(invocation.id) as { id: string } | undefined;

  const now = Date.now();
  let flagId: string;

  if (existing) {
    db.prepare(
      `UPDATE invocation_flags SET reason = ?, detail = ?, created_at = ? WHERE id = ?`,
    ).run(reason, detail ?? null, now, existing.id);
    flagId = existing.id;
  } else {
    flagId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO invocation_flags (id, invocation_id, listing_id, seller_address, buyer_address, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(flagId, invocation.id, invocation.listing_id, invocation.seller_address, buyerAddress, reason, detail ?? null, now);
  }

  // Best-effort on-chain mirror — see docblock above. Never blocks or
  // fails the flag itself.
  mirrorFlagOnChain(flagId, invocation, buyerAddress, reason).catch(() => {});

  res.status(existing ? 200 : 201).json({ id: flagId, invocationId: invocation.id, updated: !!existing });
});

async function mirrorFlagOnChain(
  flagId: string,
  invocation: InvocationRow,
  buyerAddress: string,
  reason: string,
): Promise<void> {
  const buyer = db
    .prepare(`SELECT encrypted_key FROM agents WHERE address = ?`)
    .get(buyerAddress) as { encrypted_key: string | null } | undefined;
  if (!buyer?.encrypted_key) return; // self-custody buyer — nothing this backend can sign with

  const seller = db
    .prepare(`SELECT erc8004_agent_id FROM agents WHERE address = ?`)
    .get(invocation.seller_address) as { erc8004_agent_id: string | null } | undefined;
  if (!seller?.erc8004_agent_id) return; // seller never registered an ERC-8004 identity — nothing to attach feedback to

  const buyerAccount = getAgentAccount(buyerAddress);
  const feedbackURI = `${config.publicBaseUrl}/marketplace/invocations/${invocation.id}`;
  const feedbackHash = deriveEvidenceHash(invocation.id, invocation.response_hash ?? sha256Hex(""));

  const result = await pushNegativeFeedback(
    buyerAccount,
    seller.erc8004_agent_id,
    reason,
    feedbackURI,
    feedbackHash,
  );
  if (result) {
    db.prepare(`UPDATE invocation_flags SET onchain_feedback_tx_hash = ? WHERE id = ?`).run(
      result.txHash,
      flagId,
    );
  }
}

export default router;
