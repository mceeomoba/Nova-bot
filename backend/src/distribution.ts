/**
 * Distribution — the "getting a human customer" department.
 *
 * Everything else in this backend (marketplace.ts, agentCard.ts,
 * socialRelay.ts) solves Economy 1: agent discovers agent, agent pays
 * agent, all addressed by wallet. None of that is visible to a human.
 * This file is Economy 2: taking a finished, active listing and putting
 * it somewhere an actual person can find it.
 *
 * Explicit design decisions, and why:
 *
 * 1. NO CLICK TRACKING, NO ENGAGEMENT LOOP, NO RE-PUBLISH.
 *    A Distribution Agent whose reward signal is "attention generated"
 *    will drift toward whatever generates attention, and the fastest
 *    way to generate attention is spam. Constitution Law II is explicit
 *    that this is not just distasteful but a survival-ending violation:
 *    "Never spam, scam, exploit, or extract. Accept death rather than
 *    violate Law I." So this module measures exactly one thing per
 *    publish — did the channel accept it — and never measures what
 *    happened after. There is no "improve listing based on
 *    performance" loop here on purpose. Publish, log, done.
 *
 * 2. THE AGENT CHOOSES A CHANNEL, IT DOES NOT DISCOVER ONE.
 *    distribution_channels is a human-curated allowlist (admin-only
 *    writes, see POST /admin/distribution/channels below). An agent
 *    calling POST /distribution/publish can only pick a channel that's
 *    already an active row here — it cannot post to an arbitrary URL it
 *    found. This is the same shape as policy.ts's forbidden-pattern
 *    blocklist: a second, structural enforcement layer that doesn't
 *    depend on the agent's own reasoning staying aligned under
 *    survival pressure.
 *
 * 3. PUBLISH ONCE PER (listing, channel), EVER.
 *    Enforced by a UNIQUE constraint in the database (see db.ts), not
 *    just an application check — no amount of prompt drift or
 *    self-modification can relax it without a schema migration a human
 *    would see. One honest submission per channel; no reposting, no
 *    "refresh" tactics.
 *
 * 4. DISCLOSURE IS SERVER-WRITTEN, NEVER AGENT-WRITTEN.
 *    For any channel that requires it, the disclosure line is appended
 *    here from config.distributionDisclosureText, not accepted as
 *    agent-supplied content. Constitution Law III: "never deny what you
 *    are." A compromised or adversarially-prompted agent cannot strip
 *    or reword something it never had control over.
 *
 * 5. HUMAN-PROVISIONED CREDENTIALS ONLY, NO ACCOUNT CREATION.
 *    Any channel with method 'social_api' requires
 *    requires_human_credential=1 and a credential_env_var pointing at a
 *    token the human operator put in the environment — the same trust
 *    model as BACKEND_API_KEY or FACILITATOR_PRIVATE_KEY. This module
 *    never creates accounts, never automates a login flow, never drives
 *    a browser to impersonate a human on a platform's UI. It only calls
 *    documented, official REST APIs with a credential a human already
 *    decided to hand it. Platforms without a suitable public API (most
 *    closed social platforms) are simply not supportable channels here
 *    — that limitation is intentional, not a gap to route around.
 *
 * Mounted the same way as marketplace.ts: GET routes (discovery) are
 * public, before the shared-secret middleware; the agent-facing write
 * route (POST /publish) checks x-backend-key itself; admin routes are
 * mounted separately under /admin in index.ts using the existing
 * x-admin-key middleware.
 */

import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import fs from "fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { db } from "./db.js";
import { constantTimeSecretEqual } from "./sharedKeyAuth.js";

const execFileAsync = promisify(execFile);


const router = express.Router();
router.use(express.json({ limit: "512kb" }));

const VALID_METHODS = new Set(["git_pr", "webhook", "social_api", "feed", "package_registry"]);

function requireBackendKey(req: express.Request, res: express.Response): boolean {
  const key = req.header("x-backend-key");
  if (!constantTimeSecretEqual(key, config.backendApiKey)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function requireAdminKey(req: express.Request, res: express.Response): boolean {
  const key = req.header("x-admin-key");
  if (!constantTimeSecretEqual(key, config.adminApiKey)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

interface ChannelRow {
  id: string;
  key: string;
  name: string;
  method: string;
  target: string; // JSON
  requires_disclosure: number;
  requires_human_credential: number;
  credential_env_var: string | null;
  category_allowlist: string | null; // JSON array or null
  active: number;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

interface ListingRow {
  id: string;
  seller_address: string;
  name: string;
  description: string | null;
  category: string | null;
  active: number;
  delivery_type: string; // 'url' | 'zip'
  price_usdc: string;
  file_path: string | null;
  file_original_name: string | null;
}

function safeJsonParse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ─── Public discovery ──────────────────────────────────────────────────

/**
 * GET /distribution/channels — the allowlist an agent (or a curious
 * human) can see. Never includes credential_env_var's *value* — only
 * the env var *name*, which is not a secret, so an operator auditing
 * this list can see which channels need a credential provisioned
 * without this endpoint ever being able to leak one.
 */
router.get("/channels", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, key, name, method, target, requires_disclosure,
              requires_human_credential, credential_env_var,
              category_allowlist, notes, created_at
       FROM distribution_channels WHERE active = 1
       ORDER BY created_at ASC`,
    )
    .all() as ChannelRow[];

  res.json({
    channels: rows.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      method: r.method,
      target: safeJsonParse(r.target, {}),
      requiresDisclosure: !!r.requires_disclosure,
      requiresHumanCredential: !!r.requires_human_credential,
      credentialEnvVar: r.credential_env_var,
      categoryAllowlist: safeJsonParse<string[] | null>(r.category_allowlist, null),
      notes: r.notes,
    })),
  });
});

/**
 * GET /distribution/history?agentAddress=0x...
 * Public, read-only audit trail — same philosophy as marketplace.ts's
 * flag-rate-in-discovery: a distribution agent's own publish history
 * (what, where, whether it was accepted) is visible to anyone, not
 * just its operator. Nothing to hide if nothing here is spam.
 */
router.get("/history", (req, res) => {
  const agentAddress = String(req.query.agentAddress || "");
  const params: unknown[] = [];
  let where = "";
  if (agentAddress) {
    where = "WHERE p.seller_address = ?";
    params.push(agentAddress);
  }
  const rows = db
    .prepare(
      `SELECT p.id, p.listing_id, p.seller_address, p.status, p.external_ref,
              p.reject_reason, p.created_at, c.key AS channel_key, c.name AS channel_name
       FROM distribution_posts p
       JOIN distribution_channels c ON c.id = p.channel_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT 200`,
    )
    .all(...params);
  res.json({ posts: rows });
});

/**
 * GET /distribution/feed.xml — the "SEO done honestly" channel.
 * A standing Atom feed of every active listing across the fleet.
 * Nothing is pushed to anyone; search engines, aggregators, and
 * directories that want to crawl or subscribe do so on their own
 * schedule. No per-listing agent action, no publish-cap consumption,
 * and structurally incapable of being spam since it never initiates
 * contact with anyone.
 */
router.get("/feed.xml", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, name, description, category, price_usdc, seller_address, updated_at
       FROM listings WHERE active = 1
       ORDER BY updated_at DESC
       LIMIT 500`,
    )
    .all() as Array<{
    id: string;
    name: string;
    description: string | null;
    category: string | null;
    price_usdc: string;
    seller_address: string;
    updated_at: number;
  }>;

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const feedUrl = `${config.publicBaseUrl}/distribution/feed.xml`;
  const updated = new Date().toISOString();

  const entries = rows
    .map((r) => {
      const entryUrl = `${config.publicBaseUrl}/marketplace/listings/${r.id}`;
      return `  <entry>
    <title>${esc(r.name)}</title>
    <id>${entryUrl}</id>
    <link href="${entryUrl}"/>
    <updated>${new Date(r.updated_at).toISOString()}</updated>
    <summary>${esc(r.description || "")}</summary>
    <category term="${esc(r.category || "uncategorized")}"/>
    <author><name>${esc(r.seller_address)}</name></author>
    <content type="text">${esc(`${r.name} — ${r.price_usdc} USDC. ${r.description || ""}`)}</content>
  </entry>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${esc(config.distributionFeedTitle)}</title>
  <id>${feedUrl}</id>
  <link href="${feedUrl}" rel="self"/>
  <updated>${updated}</updated>
${entries}
</feed>`;

  res.type("application/atom+xml").send(xml);
});

/**
 * GET /distribution/landing/:id — the actual destination every other
 * channel points to.
 *
 * A GitHub PR, an npm package description, a Mastodon post, a
 * directory listing — none of these are where a human becomes a
 * customer. They're how a human *finds* mycompany.ai; the deciding and
 * paying happens on a page like this one. So every adapter below
 * builds its `content.url` from this route, not from the raw
 * marketplace API endpoint (which is agent-facing JSON, useless to a
 * person who clicked a link).
 *
 * Deliberately honest about payment: this backend only integrates
 * USDC/x402 (see marketplace.ts). There is no Stripe/PayPal
 * integration here, so this page does not pretend to have one — a
 * buyer with a wallet gets real payment instructions; a buyer without
 * one gets a contact path (if `distributionContactEmail` is
 * configured) rather than a "Buy Now" button that would silently fail
 * or, worse, misrepresent what this fleet can actually process.
 */
router.get("/landing/:id", (req, res) => {
  const listing = db
    .prepare(
      `SELECT id, seller_address, name, description, category, active,
              delivery_type, price_usdc, file_original_name
       FROM listings WHERE id = ?`,
    )
    .get(req.params.id) as
    | (ListingRow & { file_original_name: string | null })
    | undefined;

  if (!listing || !listing.active) {
    return res.status(404).type("html").send(renderNotFoundPage());
  }

  res.type("html").send(renderLandingPage(listing));
});

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderNotFoundPage(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Listing not found</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:80px auto;padding:0 20px;color:#222">
<h1>This listing isn't available</h1>
<p>It may have been deactivated, or the link is out of date.</p>
</body></html>`;
}

function renderLandingPage(listing: ListingRow & { file_original_name: string | null }): string {
  const title = escHtml(listing.name);
  const desc = escHtml(listing.description || "");
  const category = listing.category ? escHtml(listing.category) : null;
  const price = escHtml(listing.price_usdc);
  const deliveryNote =
    listing.delivery_type === "zip"
      ? `Delivered as a one-time download (${listing.file_original_name ? escHtml(listing.file_original_name) : "source package"}) immediately after payment.`
      : `Delivered as API access — pay-per-call against a live endpoint.`;

  const contactBlock = config.distributionContactEmail
    ? `<p>Prefer not to hold USDC, or need an invoice / enterprise terms? <a href="mailto:${escHtml(config.distributionContactEmail)}?subject=${encodeURIComponent("Inquiry: " + listing.name)}">Contact us</a> and a human will follow up.</p>`
    : `<p>Fiat / invoice payment isn't set up yet for this listing — USDC only for now.</p>`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${desc.slice(0, 160)}">
</head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1a1a1a;line-height:1.5">
  <p style="text-transform:uppercase;letter-spacing:.05em;font-size:.75rem;color:#888;margin-bottom:4px">${category ? category : "Marketplace listing"}</p>
  <h1 style="margin-top:0">${title}</h1>
  <p>${desc}</p>

  <div style="border:1px solid #ddd;border-radius:10px;padding:20px;margin:28px 0">
    <p style="margin:0 0 6px;font-size:1.4rem;font-weight:600">${price} USDC</p>
    <p style="margin:0 0 16px;color:#555">${deliveryNote}</p>
    <p style="margin:0"><strong>To pay:</strong> this listing accepts USDC via the x402 protocol at
      <code>POST /marketplace/listings/${escHtml(listing.id)}/invoke</code> on this fleet's API.
      Point an x402-compatible client or wallet at that endpoint to complete payment and receive delivery immediately.</p>
  </div>

  ${contactBlock}

  <hr style="margin:40px 0;border:none;border-top:1px solid #eee">
  <p style="font-size:.8rem;color:#999">${escHtml(config.distributionDisclosureText)}</p>
</body>
</html>`;
}

// ─── Admin: curate the allowlist ───────────────────────────────────────

/**
 * POST /admin/distribution/channels — only route in this file that
 * writes to distribution_channels. x-admin-key only; no agent, however
 * privileged, ever adds its own distribution channel. This is the load-
 * bearing control: the agent's job is judgment about WHICH approved
 * channel fits a given listing, never whether a new channel should
 * exist at all.
 */
router.post("/admin/channels", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const {
    key,
    name,
    method,
    target,
    requiresDisclosure = true,
    requiresHumanCredential = false,
    credentialEnvVar = null,
    categoryAllowlist = null,
    notes = null,
  } = req.body ?? {};

  if (typeof key !== "string" || !key.trim()) {
    return res.status(400).json({ error: "key required" });
  }
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name required" });
  }
  if (typeof method !== "string" || !VALID_METHODS.has(method)) {
    return res.status(400).json({ error: "invalid method", valid: [...VALID_METHODS] });
  }
  if (target === undefined || target === null) {
    return res.status(400).json({ error: "target required (JSON object)" });
  }
  if (requiresHumanCredential && !credentialEnvVar) {
    return res
      .status(400)
      .json({ error: "credentialEnvVar required when requiresHumanCredential is true" });
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO distribution_channels
       (id, key, name, method, target, requires_disclosure, requires_human_credential,
        credential_env_var, category_allowlist, active, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      id,
      key.trim(),
      name.trim(),
      method,
      JSON.stringify(target),
      requiresDisclosure ? 1 : 0,
      requiresHumanCredential ? 1 : 0,
      credentialEnvVar,
      categoryAllowlist ? JSON.stringify(categoryAllowlist) : null,
      notes,
      now,
      now,
    );
  } catch (err) {
    return res.status(409).json({ error: "channel key already exists", detail: (err as Error).message });
  }

  res.status(201).json({ id, key: key.trim() });
});

/** POST /admin/distribution/channels/:id/deactivate — retire a channel without deleting its publish history. */
router.post("/admin/channels/:id/deactivate", (req, res) => {
  if (!requireAdminKey(req, res)) return;
  const result = db
    .prepare(`UPDATE distribution_channels SET active = 0, updated_at = ? WHERE id = ?`)
    .run(Date.now(), req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ─── Adapters ───────────────────────────────────────────────────────────
// Each adapter takes the channel row + composed content and returns
// either a success (with an external_ref if the channel gave one back)
// or throws. None of these measure or store engagement after the fact.

interface PublishContent {
  title: string;
  summary: string;
  url: string; // canonical link back to the listing / marketplace entry
}

interface AdapterResult {
  externalRef: string | null;
}

/**
 * git_pr — opens a pull request against a channel's configured repo
 * (e.g. an open directory of tools, or NOVA's own skills registry)
 * adding one file describing the listing. Legitimate by construction:
 * a PR is a normal, expected, reviewable contribution — the repo's own
 * maintainers accept or reject it, which is exactly the "acceptance,
 * not attention" success metric this module is built around.
 *
 * target shape: { owner, repo, branch?, pathTemplate }
 * Requires requires_human_credential with credentialEnvVar pointing at
 * a GitHub PAT with only public_repo scope — never a broader token.
 */
async function publishGitPr(
  channel: ChannelRow,
  content: PublishContent,
  listing: ListingRow,
): Promise<AdapterResult> {
  const target = safeJsonParse<{ owner?: string; repo?: string; branch?: string; pathTemplate?: string }>(
    channel.target,
    {},
  );
  if (!target.owner || !target.repo) {
    throw new Error("channel target missing owner/repo");
  }
  const token = channel.credential_env_var ? process.env[channel.credential_env_var] : undefined;
  if (channel.requires_human_credential && !token) {
    throw new Error(`credential env var ${channel.credential_env_var} not set — human operator must provision it`);
  }

  const branchName = `listing-${listing.id}`;
  const filePath = (target.pathTemplate || "listings/{id}.md").replace("{id}", listing.id);
  const baseBranch = target.branch || "main";
  const apiBase = `https://api.github.com/repos/${target.owner}/${target.repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "automaton-distribution-agent",
  };

  // 1. Resolve base branch sha
  const refRes = await fetch(`${apiBase}/git/ref/heads/${baseBranch}`, { headers });
  if (!refRes.ok) throw new Error(`could not resolve base branch: ${refRes.status}`);
  const refJson = (await refRes.json()) as { object: { sha: string } };
  const baseSha = refJson.object.sha;

  // 2. Create a new branch for this listing (idempotent-ish: if it
  //    already exists, GitHub returns 422 and we surface that as a
  //    rejection rather than retrying/forcing).
  const createRefRes = await fetch(`${apiBase}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  if (!createRefRes.ok && createRefRes.status !== 422) {
    throw new Error(`could not create branch: ${createRefRes.status}`);
  }

  // 3. Write the listing file (server-appends disclosure — see below).
  const disclosure = channel.requires_disclosure ? `\n\n---\n${config.distributionDisclosureText}\n` : "";
  const fileBody = `# ${content.title}\n\n${content.summary}\n\nLink: ${content.url}\n${disclosure}`;
  const putRes = await fetch(`${apiBase}/contents/${filePath}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      message: `Add listing: ${content.title}`,
      content: Buffer.from(fileBody, "utf-8").toString("base64"),
      branch: branchName,
    }),
  });
  if (!putRes.ok) throw new Error(`could not write file: ${putRes.status}`);

  // 4. Open the PR itself.
  const prRes = await fetch(`${apiBase}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: `Add listing: ${content.title}`,
      head: branchName,
      base: baseBranch,
      body: `${content.summary}\n\n${content.url}${disclosure}`,
    }),
  });
  if (!prRes.ok) throw new Error(`could not open PR: ${prRes.status}`);
  const prJson = (await prRes.json()) as { html_url: string };
  return { externalRef: prJson.html_url };
}

/**
 * webhook — generic POST to a directory/service that accepts structured
 * submissions (many product/tool directories offer exactly this instead
 * of a scraped form). No bot-detection evasion, no headless-browser
 * form-filling pretending to be a human — if a directory doesn't offer
 * a submission API, it isn't a supportable channel here.
 *
 * target shape: { url, authHeader? }
 */
async function publishWebhook(channel: ChannelRow, content: PublishContent): Promise<AdapterResult> {
  const target = safeJsonParse<{ url?: string; authHeader?: string }>(channel.target, {});
  if (!target.url) throw new Error("channel target missing url");

  const token = channel.credential_env_var ? process.env[channel.credential_env_var] : undefined;
  if (channel.requires_human_credential && !token) {
    throw new Error(`credential env var ${channel.credential_env_var} not set — human operator must provision it`);
  }

  const disclosure = channel.requires_disclosure ? config.distributionDisclosureText : undefined;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token && target.authHeader) headers[target.authHeader] = token;

  const resp = await fetch(target.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: content.title,
      summary: content.summary,
      url: content.url,
      disclosure,
    }),
  });
  if (!resp.ok) throw new Error(`webhook rejected: ${resp.status}`);
  let externalRef: string | null = null;
  try {
    const json = (await resp.json()) as { url?: string; id?: string };
    externalRef = json.url || json.id || null;
  } catch {
    /* not every directory returns JSON; success is still the 2xx */
  }
  return { externalRef };
}

/**
 * social_api — official, documented REST API only, with a
 * human-provisioned credential. Concretely implementable today against
 * e.g. Mastodon-compatible instances (open API, no OAuth app-review
 * gate for a self-owned account token). Platforms whose only posting
 * path is an undocumented endpoint or a browser session are not
 * supportable here — see the file-level comment.
 *
 * target shape: { apiUrl, bodyField? } — apiUrl is the full
 * "create post" endpoint; bodyField selects which field the token goes
 * in if not a standard Authorization: Bearer header.
 */
async function publishSocialApi(channel: ChannelRow, content: PublishContent): Promise<AdapterResult> {
  const target = safeJsonParse<{ apiUrl?: string; statusField?: string }>(channel.target, {});
  if (!target.apiUrl) throw new Error("channel target missing apiUrl");
  if (!channel.requires_human_credential || !channel.credential_env_var) {
    throw new Error("social_api channels must set requiresHumanCredential + credentialEnvVar");
  }
  const token = process.env[channel.credential_env_var];
  if (!token) {
    throw new Error(`credential env var ${channel.credential_env_var} not set — human operator must provision it`);
  }

  const disclosure = config.distributionDisclosureText; // always on for social_api, not optional
  const statusField = target.statusField || "status";
  const text = `${content.title}\n\n${content.summary}\n${content.url}\n\n${disclosure}`;

  const resp = await fetch(target.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ [statusField]: text }),
  });
  if (!resp.ok) throw new Error(`platform rejected post: ${resp.status}`);
  let externalRef: string | null = null;
  try {
    const json = (await resp.json()) as { url?: string; id?: string };
    externalRef = json.url || json.id || null;
  } catch {
    /* ignore */
  }
  return { externalRef };
}

/**
 * package_registry — for zip-mode listings only (delivery_type='zip'),
 * where the listing's own file_path IS the deliverable. Unlike the
 * social/directory adapters, the artifact published here doesn't
 * advertise the product, it partly *is* it — this is the npm-install
 * case: someone gets real value from the package itself, then a
 * fraction go looking for `mycompany.ai` (the landing page above) for
 * more.
 *
 * Each registry has its own upload protocol; `target.registry` picks
 * which one. None of these create an account or a namespace — they all
 * require a human to have already registered the package name /
 * organization and provisioned a scoped token, same trust model as
 * every other credentialed adapter in this file.
 *
 * Honesty note: npm's registry publish API is not formally documented
 * by npm, Inc. — the shape below is the same PUT-with-attachments
 * protocol the npm CLI itself uses, reverse-engineered and widely
 * relied upon, but treat it as best-effort and test against a scoped
 * or private package before trusting it for a real release. PyPI's
 * legacy upload API, by contrast, is documented (Warehouse project)
 * and the implementation below follows that spec directly.
 */
async function publishPackageRegistry(
  channel: ChannelRow,
  content: PublishContent,
  listing: ListingRow,
): Promise<AdapterResult> {
  const target = safeJsonParse<{
    registry?: "npm" | "pypi" | "github_release" | "vscode_marketplace";
    packageName?: string;
    version?: string;
    owner?: string; // github_release only
    repo?: string; // github_release only
    pyFileType?: "sdist" | "bdist_wheel"; // pypi only
  }>(channel.target, {});

  if (!target.registry) throw new Error("channel target missing registry");
  if (listing.delivery_type !== "zip" || !listing.file_path) {
    throw new Error("package_registry channels require a zip-mode listing with an uploaded artifact");
  }
  if (!fs.existsSync(listing.file_path)) {
    throw new Error("listing artifact file is missing on disk");
  }

  const token = channel.credential_env_var ? process.env[channel.credential_env_var] : undefined;
  if (channel.requires_human_credential && !token) {
    throw new Error(`credential env var ${channel.credential_env_var} not set — human operator must provision it`);
  }

  switch (target.registry) {
    case "npm":
      return publishNpm(target, token, listing, content);
    case "pypi":
      return publishPypi(target, token, listing);
    case "github_release":
      return publishGithubRelease(target, token, listing, content);
    case "vscode_marketplace":
      return publishVscodeMarketplace(target, token, listing);
    default:
      throw new Error(`unknown registry: ${target.registry}`);
  }
}

async function publishNpm(
  target: { packageName?: string; version?: string },
  token: string | undefined,
  listing: ListingRow,
  content: PublishContent,
): Promise<AdapterResult> {
  if (!target.packageName || !target.version) {
    throw new Error("npm channel target missing packageName/version");
  }
  const tarball = fs.readFileSync(listing.file_path as string); // expects a pre-built .tgz (`npm pack` output), not the raw marketplace zip
  const tarballName = `${target.packageName.replace("/", "-")}-${target.version}.tgz`;
  const body = {
    _id: target.packageName,
    name: target.packageName,
    description: content.summary,
    "dist-tags": { latest: target.version },
    versions: {
      [target.version]: {
        name: target.packageName,
        version: target.version,
        description: content.summary,
        homepage: content.url,
      },
    },
    _attachments: {
      [tarballName]: {
        content_type: "application/octet-stream",
        data: tarball.toString("base64"),
        length: tarball.length,
      },
    },
  };

  const resp = await fetch(`https://registry.npmjs.org/${encodeURIComponent(target.packageName)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`npm publish rejected: ${resp.status} ${detail.slice(0, 200)}`);
  }
  return { externalRef: `https://www.npmjs.com/package/${target.packageName}` };
}

async function publishPypi(
  target: { packageName?: string; version?: string; pyFileType?: "sdist" | "bdist_wheel" },
  token: string | undefined,
  listing: ListingRow,
): Promise<AdapterResult> {
  if (!target.packageName || !target.version) {
    throw new Error("pypi channel target missing packageName/version");
  }
  const fileBuf = fs.readFileSync(listing.file_path as string); // expects a pre-built sdist/wheel, not the raw marketplace zip
  const fileName = listing.file_original_name || `${target.packageName}-${target.version}.tar.gz`;
  const filetype = target.pyFileType || "sdist";

  const form = new FormData();
  form.append(":action", "file_upload");
  form.append("protocol_version", "1");
  form.append("name", target.packageName);
  form.append("version", target.version);
  form.append("filetype", filetype);
  form.append("metadata_version", "2.1");
  form.append("content", new Blob([fileBuf]), fileName);

  const basicAuth = Buffer.from(`__token__:${token}`).toString("base64");
  const resp = await fetch("https://upload.pypi.org/legacy/", {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}` },
    body: form as unknown as import("node-fetch").BodyInit,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`PyPI upload rejected: ${resp.status} ${detail.slice(0, 200)}`);
  }
  return { externalRef: `https://pypi.org/project/${target.packageName}/${target.version}/` };
}

async function publishGithubRelease(
  target: { owner?: string; repo?: string; version?: string },
  token: string | undefined,
  listing: ListingRow,
  content: PublishContent,
): Promise<AdapterResult> {
  if (!target.owner || !target.repo || !target.version) {
    throw new Error("github_release channel target missing owner/repo/version");
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "automaton-distribution-agent",
  };
  const apiBase = `https://api.github.com/repos/${target.owner}/${target.repo}`;

  const relRes = await fetch(`${apiBase}/releases`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      tag_name: `v${target.version}`,
      name: `${content.title} v${target.version}`,
      body: `${content.summary}\n\n${content.url}\n\n---\n${config.distributionDisclosureText}`,
    }),
  });
  if (!relRes.ok) throw new Error(`could not create release: ${relRes.status}`);
  const relJson = (await relRes.json()) as { id: number; html_url: string; upload_url: string };

  const fileBuf = fs.readFileSync(listing.file_path as string);
  const assetName = listing.file_original_name || `${listing.id}.zip`;
  const uploadUrl = relJson.upload_url.replace("{?name,label}", `?name=${encodeURIComponent(assetName)}`);
  const assetRes = await fetch(uploadUrl, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/zip" },
    body: fileBuf,
  });
  if (!assetRes.ok) throw new Error(`release created but asset upload failed: ${assetRes.status}`);

  return { externalRef: relJson.html_url };
}

/**
 * vscode_marketplace — error-fix.md Phase 12b.
 *
 * The real Marketplace publish protocol (Azure DevOps Gallery) is not a
 * simple documented POST/PUT: current-generation VSIX publishing
 * requires a digital-signature manifest step (Microsoft's own
 * `@vscode/vsce-sign` package) before upload, and PAT-based auth is
 * being retired in favor of Entra ID service-principal auth
 * (Microsoft's own announced timeline: global PATs retired Dec 1,
 * 2026). Hand-rolling raw HTTP against that protocol would either miss
 * the signing step (silent failure) or be built against an auth model
 * already scheduled for removal.
 *
 * Every real publishing pipeline (GitHub's own official Action,
 * `semantic-release-vsce`, `ovsx`, Cake.VsCode, ...) solves this the
 * same way: shell out to Microsoft's own `@vscode/vsce` CLI, which
 * implements the signing/upload steps correctly and stays current as
 * the protocol changes. This is a deliberate departure from every
 * other adapter in this file (all pure `fetch()`, no child process) —
 * flagged here explicitly rather than left implicit: this is the one
 * publish path in `distribution.ts` that executes a third-party CLI
 * (via a pinned, already-installed `node_modules` binary — `npx
 * --no-install`, never a bare `npx <pkg>` that would resolve/install
 * something over the network at call time) on the backend host itself.
 *
 * target shape: { packageName (format "publisher.extension-name"),
 * version } — listing.file_path is expected to be a pre-built .vsix
 * (the output of `vsce package`), same "artifact IS the deliverable"
 * convention publishNpm/publishPypi already use for their own
 * pre-built-archive expectations. `vsce publish --packagePath` reads
 * publisher/name/version out of the vsix's own embedded manifest, so
 * neither is re-derived here — target.packageName/version are used
 * only to build the human-facing marketplace URL afterward.
 */
async function publishVscodeMarketplace(
  target: { packageName?: string; version?: string },
  token: string | undefined,
  listing: ListingRow,
): Promise<AdapterResult> {
  if (!target.packageName || !target.version) {
    throw new Error("vscode_marketplace channel target missing packageName/version");
  }
  if (!target.packageName.includes(".")) {
    throw new Error('vscode_marketplace packageName must be "publisher.extension-name"');
  }
  if (!token) {
    throw new Error("vscode_marketplace channels must set requiresHumanCredential + credentialEnvVar (a Visual Studio Marketplace PAT)");
  }
  if (!listing.file_path || !fs.existsSync(listing.file_path)) {
    throw new Error("listing artifact file is missing on disk — expected a pre-built .vsix (`vsce package` output)");
  }

  try {
    // --no-install: use the version already resolved into node_modules
    // at deploy time (see backend/package.json's @vscode/vsce
    // dependency) — never silently fetch/execute an arbitrary package
    // version from the registry at call time.
    // VSCE_PAT via env, never argv, so the token never appears in a
    // process listing (`ps aux`) on a shared host.
    await execFileAsync(
      "npx",
      ["--no-install", "@vscode/vsce", "publish", "--packagePath", listing.file_path],
      {
        env: { ...process.env, VSCE_PAT: token, VSCE_STORE: "file" },
        timeout: 120_000,
      },
    );
  } catch (err: any) {
    const detail = (err?.stderr || err?.stdout || err?.message || "").toString().slice(0, 500);
    throw new Error(`vsce publish failed: ${detail}`);
  }

  return { externalRef: `https://marketplace.visualstudio.com/items?itemName=${target.packageName}` };
}

// ─── Agent-facing publish ───────────────────────────────────────────────

/**
 * POST /distribution/publish
 * Body: { agentAddress, listingId, channelKey, title, summary }
 *
 * Order of checks matters — cheapest/most-decisive rejections first so
 * a misbehaving or confused agent gets a clear reason without this
 * route ever reaching out to a live channel unnecessarily:
 *   1. auth
 *   2. daily rate cap
 *   3. listing exists, is active, and belongs to this agent
 *   4. channel exists and is active
 *   5. category fit (if the channel restricts categories)
 *   6. not already published to this channel (DB UNIQUE also enforces
 *      this, but checking first gives a clean 409 instead of a raw
 *      constraint-violation error)
 *   7. dispatch to the adapter
 *   8. log the outcome either way (published, rejected, or failed) —
 *      every attempt is recorded, not just successes, so the audit
 *      trail in GET /history is complete.
 */
router.post("/publish", async (req, res) => {
  if (!requireBackendKey(req, res)) return;

  const { agentAddress, listingId, channelKey, title, summary } = req.body ?? {};
  if (!agentAddress || !listingId || !channelKey || !title || !summary) {
    return res.status(400).json({ error: "agentAddress, listingId, channelKey, title, summary all required" });
  }

  // 2. Daily rate cap
  const day = todayUtc();
  const counter = db
    .prepare(`SELECT count FROM distribution_rate_counters WHERE seller_address = ? AND day = ?`)
    .get(agentAddress, day) as { count: number } | undefined;
  if ((counter?.count ?? 0) >= config.maxDistributionPublishesPerAgentPerDay) {
    return res.status(429).json({
      error: "daily_distribution_limit_reached",
      limit: config.maxDistributionPublishesPerAgentPerDay,
    });
  }

  // 3. Listing
  const listing = db
    .prepare(
      `SELECT id, seller_address, name, description, category, active,
              delivery_type, price_usdc, file_path, file_original_name
       FROM listings WHERE id = ?`,
    )
    .get(listingId) as ListingRow | undefined;
  if (!listing) return res.status(404).json({ error: "listing not found" });
  if (listing.seller_address !== agentAddress) {
    return res.status(403).json({ error: "listing does not belong to this agent" });
  }
  if (!listing.active) {
    return res.status(400).json({ error: "listing is not active" });
  }

  // 4. Channel
  const channel = db
    .prepare(`SELECT * FROM distribution_channels WHERE key = ? AND active = 1`)
    .get(channelKey) as ChannelRow | undefined;
  if (!channel) return res.status(404).json({ error: "channel not found or inactive" });

  // 5. Category fit
  const allowedCategories = safeJsonParse<string[] | null>(channel.category_allowlist, null);
  if (allowedCategories && allowedCategories.length > 0) {
    if (!listing.category || !allowedCategories.includes(listing.category)) {
      return res.status(400).json({
        error: "listing category not accepted by this channel",
        channelAccepts: allowedCategories,
      });
    }
  }

  // 6. Already published?
  const existing = db
    .prepare(`SELECT id, status FROM distribution_posts WHERE listing_id = ? AND channel_id = ?`)
    .get(listingId, channel.id) as { id: string; status: string } | undefined;
  if (existing) {
    return res.status(409).json({ error: "already_published_to_channel", status: existing.status });
  }

  const content: PublishContent = {
    title: String(title).slice(0, 300),
    summary: String(summary).slice(0, 2000),
    // Points at the human-facing landing page, not the raw marketplace
    // API endpoint — this is the URL that actually gets a person to a
    // decision, per GET /distribution/landing/:id above.
    url: `${config.publicBaseUrl}/distribution/landing/${listing.id}`,
  };
  const contentHash = sha256Hex(JSON.stringify(content));
  const postId = crypto.randomUUID();
  const now = Date.now();

  const recordOutcome = (status: "published" | "rejected" | "failed", externalRef: string | null, reason: string | null) => {
    db.prepare(
      `INSERT INTO distribution_posts
       (id, listing_id, channel_id, seller_address, status, external_ref, reject_reason, content_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(postId, listingId, channel.id, agentAddress, status, externalRef, reason, contentHash, now);

    if (status === "published") {
      db.prepare(
        `INSERT INTO distribution_rate_counters (seller_address, day, count)
         VALUES (?, ?, 1)
         ON CONFLICT(seller_address, day) DO UPDATE SET count = count + 1`,
      ).run(agentAddress, day);
    }
  };

  // 7. Dispatch
  try {
    let result: AdapterResult;
    switch (channel.method) {
      case "git_pr":
        result = await publishGitPr(channel, content, listing);
        break;
      case "webhook":
        result = await publishWebhook(channel, content);
        break;
      case "social_api":
        result = await publishSocialApi(channel, content);
        break;
      case "package_registry":
        result = await publishPackageRegistry(channel, content, listing);
        break;
      case "feed":
        // 'feed' channels aren't published-to per listing — the feed is
        // always-on (GET /distribution/feed.xml) and already includes
        // every active listing automatically. Calling publish against
        // one is a no-op success so an agent's channel-selection logic
        // doesn't need a special case for it.
        result = { externalRef: `${config.publicBaseUrl}/distribution/feed.xml` };
        break;
      default:
        throw new Error(`unknown channel method: ${channel.method}`);
    }
    recordOutcome("published", result.externalRef, null);
    return res.status(201).json({ id: postId, status: "published", externalRef: result.externalRef });
  } catch (err) {
    const reason = (err as Error).message;
    recordOutcome("failed", null, reason);
    return res.status(502).json({ id: postId, status: "failed", reason });
  }
});

export default router;
