import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import fetch from "node-fetch";
import { db } from "./db.js";
import { config } from "./config.js";
import { execInNamedContainer } from "./docker.js";

/**
 * next-phase.md Phase 9c (architecture-agent.md §4h): Subdomain + SSL
 * provisioning, end to end. Everything else in this sub-phase
 * (domainRoutes.ts, agent-runtime/tools.ts) calls into this file — it
 * is the only place that talks to Cloudflare, writes Nginx vhost
 * files, or execs into the Phase 9b domain-stack containers.
 *
 * Three externally-visible operations, matching the "one atomic
 * create, one atomic teardown, one list" naming decision next-phase.md
 * itself flags and this pass adopts (see tools.ts's own comment on why
 * the seven originally-named granular ACTIONs collapse into three):
 *
 *   provisionSubdomain()  — DNS record + vhost file + cert, claim-first,
 *                            undo-on-failure at every step.
 *   releaseSubdomain()    — mirror teardown, claim released last.
 *   listSubdomains()      — pure read of domain_resources.
 *
 * Every other function here (Cloudflare calls, vhost file I/O, nginx
 * reload, certbot exec) is an internal building block, not a separately
 * dispatchable ACTION — see tools.ts.
 */

// ─────────────────────────────────────────────────────────────────
// domain_resources — the collision-avoidance data layer (Phase 9a-i).
// ─────────────────────────────────────────────────────────────────

export interface DomainResourceRow {
  id: string;
  resource_type: "subdomain" | "mailbox" | "vhost";
  full_value: string;
  owner_agent_id: string;
  owner_department_id: string | null;
  status: "active" | "released";
  created_at: number;
}

function newDomainResourceId(): string {
  return "dom_" + crypto.randomBytes(5).toString("hex");
}

export function listSubdomains(ownerAgentId: string, ownerDepartmentId: string): DomainResourceRow[] {
  return db
    .prepare(
      `SELECT * FROM domain_resources
       WHERE owner_agent_id = ? AND owner_department_id = ? AND resource_type = 'subdomain'
       ORDER BY created_at DESC`,
    )
    .all(ownerAgentId, ownerDepartmentId) as DomainResourceRow[];
}

/**
 * Slug naming convention (Phase 9c checklist): the caller's own
 * `agents.slug` prefix is required — "spacex-blog" for agent slug
 * "spacex" is fine, a bare "blog" is not — unless the caller is using
 * the platform-reserved `marketplace` value 9e owns. Enforced here,
 * not left to caller discipline, so the one shared apex can't be
 * squatted flat by whichever Agent calls first.
 */
const PLATFORM_RESERVED_SLUG = "marketplace";

/**
 * next-phase.md Phase 9e-iii: the same reserved slug, re-exported under
 * a name that reads correctly from a caller that has nothing to do with
 * subdomain-provisioning internals (departments.ts, writing the
 * marketplace URL into a new Marketing department's own knowledge at
 * creation time). Deliberately re-exporting the existing constant
 * rather than letting departments.ts hardcode a second "marketplace"
 * literal of its own — a single source of truth for the slug, same
 * "don't let two files silently drift on the same fact" discipline
 * every prior phase's own cross-file constants in this codebase
 * already follow (e.g. toolRegistrySeedData.ts transcribing
 * departmentToolProfiles.ts's table verbatim rather than re-deriving
 * it, per that phase's own header comment).
 */
export const MARKETPLACE_SUBDOMAIN_SLUG = PLATFORM_RESERVED_SLUG;

/**
 * next-phase.md Phase 9e-ii: the owner_agent_id value written for the
 * shared marketplace's own platform-owned domain_resources row.
 * db.ts's own schema comment is explicit that this column stays
 * NOT NULL even for that row ("Always set ... provisioned by a real
 * one-time migration/Founder action, not by no one" — it's
 * owner_department_id that goes null, not this column). This is
 * deliberately NOT a real agents.address: domain_resources has no
 * DB-level FOREIGN KEY on owner_agent_id (checked by inspection — see
 * this table's own CREATE TABLE in db.ts, unlike e.g. listings'
 * explicit FOREIGN KEY on seller_address), so nothing enforces or
 * assumes it resolves to a live agent row. Using an obviously-not-an-
 * address sentinel here (rather than, say, config.founderWalletAddress
 * or an arbitrary hosted agent's own address) makes a query or an
 * audit log immediately legible as "the platform itself provisioned
 * this," with zero risk of ever colliding with a real 0x... agent
 * address or being mistaken for one agent's own claim on a resource.
 */
const PLATFORM_OWNER_SENTINEL = "platform";

function requireValidSubdomainSlug(subdomainSlug: string, ownerAgentId: string): void {
  if (!/^[a-z0-9-]{1,63}$/.test(subdomainSlug)) {
    throw Object.assign(
      new Error(`invalid subdomain_slug: "${subdomainSlug}" — must be lowercase alphanumeric/hyphen, 1-63 chars`),
      { status: 400 },
    );
  }
  if (subdomainSlug === PLATFORM_RESERVED_SLUG) {
    // The platform-reserved value itself is fine as an exact match —
    // 9e's own marketplace provisioning is the one caller allowed to
    // use it bare. Anything ELSE bare (no owning agent's slug prefix)
    // is rejected below.
    return;
  }
  const agentRow = db.prepare(`SELECT slug FROM agents WHERE address = ?`).get(ownerAgentId) as
    | { slug: string | null }
    | undefined;
  const agentSlug = agentRow?.slug;
  if (!agentSlug) {
    throw Object.assign(
      new Error(`agent ${ownerAgentId} has no slug yet — cannot provision a subdomain without one`),
      { status: 400 },
    );
  }
  if (subdomainSlug !== agentSlug && !subdomainSlug.startsWith(`${agentSlug}-`)) {
    throw Object.assign(
      new Error(
        `subdomain_slug "${subdomainSlug}" must be your own agent slug ("${agentSlug}") or start with "${agentSlug}-" — a bare, unrelated slug would let one Agent squat the shared apex`,
      ),
      { status: 400 },
    );
  }
}

/**
 * Mailbox naming convention (Phase 9d-i checklist, mirroring
 * requireValidSubdomainSlug's own subdomain enforcement above): a
 * mailbox's local-part must be the caller's own `agents.slug`, or
 * start with `{agent-slug}-`, unless it's the platform-reserved
 * `marketplace` value 9e's own shared-marketplace mailbox uses.
 * Enforced here, not left to caller discipline, so the one shared
 * apex's mailbox namespace can't be squatted flat by whichever Agent
 * calls first — same reasoning, same shape as the subdomain check.
 *
 * Deliberately restricted to the same DNS-safe charset
 * (lowercase alphanumeric + hyphen) as subdomain slugs, rather than
 * the wider charset RFC 5321 local-parts technically allow (dots,
 * plus-addressing, etc.) — this keeps exactly one validation shape to
 * reason about across both subdomains and mailboxes, and avoids
 * having to separately consider header-injection-style edge cases a
 * dot- or plus-containing local part could open up in some mail
 * clients. A future phase can widen this deliberately if a real need
 * for `.`/`+` in a local part ever comes up; nothing here assumes it
 * will.
 */
function requireValidMailboxLocalPart(localPart: string, ownerAgentId: string): void {
  if (!/^[a-z0-9-]{1,63}$/.test(localPart)) {
    throw Object.assign(
      new Error(`invalid local_part: "${localPart}" — must be lowercase alphanumeric/hyphen, 1-63 chars`),
      { status: 400 },
    );
  }
  if (localPart === PLATFORM_RESERVED_SLUG) {
    // Same carve-out requireValidSubdomainSlug gives the platform-
    // reserved value — 9e's own marketplace mailbox is the one caller
    // allowed to use it bare.
    return;
  }
  const agentRow = db.prepare(`SELECT slug FROM agents WHERE address = ?`).get(ownerAgentId) as
    | { slug: string | null }
    | undefined;
  const agentSlug = agentRow?.slug;
  if (!agentSlug) {
    throw Object.assign(
      new Error(`agent ${ownerAgentId} has no slug yet — cannot provision a mailbox without one`),
      { status: 400 },
    );
  }
  if (localPart !== agentSlug && !localPart.startsWith(`${agentSlug}-`)) {
    throw Object.assign(
      new Error(
        `local_part "${localPart}" must be your own agent slug ("${agentSlug}") or start with "${agentSlug}-" — a bare, unrelated local-part would let one Agent squat the shared apex's mailbox namespace`,
      ),
      { status: 400 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Cloudflare API client
// ─────────────────────────────────────────────────────────────────

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

function requireCloudflareConfigured(): { apiToken: string; zoneId: string } {
  if (!config.cloudflareApiToken || !config.cloudflareZoneId) {
    throw Object.assign(
      new Error("Cloudflare is not configured on this deployment (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ZONE_ID unset)"),
      { status: 503 },
    );
  }
  return { apiToken: config.cloudflareApiToken, zoneId: config.cloudflareZoneId };
}

async function cloudflareRequest<T>(
  apiToken: string,
  urlPath: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${CLOUDFLARE_API_BASE}${urlPath}`, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = (await res.json()) as { success: boolean; errors?: unknown[]; result: T };
  if (!res.ok || !body.success) {
    throw Object.assign(new Error(`cloudflare_api_error: ${JSON.stringify(body.errors ?? body)}`), {
      status: 502,
    });
  }
  return body.result;
}

/**
 * Creates an `A` record for `{subdomainSlug}.{domainApex}` pointing at
 * `targetIp` (the VM's own public IP — the same host every provisioned
 * subdomain on this single-VM deployment resolves to). Not proxied
 * (`proxied: false`) — Let's Encrypt's HTTP-01 challenge (9b's own
 * certbot+webroot design) needs the request to actually reach this
 * host directly, not Cloudflare's edge.
 */
export async function createDnsRecord(subdomainSlug: string, targetIp: string): Promise<CloudflareDnsRecord> {
  const { apiToken, zoneId } = requireCloudflareConfigured();
  return cloudflareRequest<CloudflareDnsRecord>(apiToken, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: {
      type: "A",
      name: `${subdomainSlug}.${config.domainApex}`,
      content: targetIp,
      proxied: false,
      ttl: 300,
    },
  });
}

export async function listDnsRecords(subdomainSlug: string): Promise<CloudflareDnsRecord[]> {
  const { apiToken, zoneId } = requireCloudflareConfigured();
  return cloudflareRequest<CloudflareDnsRecord[]>(
    apiToken,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(`${subdomainSlug}.${config.domainApex}`)}`,
  );
}

export async function deleteDnsRecord(recordId: string): Promise<void> {
  const { apiToken, zoneId } = requireCloudflareConfigured();
  await cloudflareRequest<{ id: string }>(apiToken, `/zones/${zoneId}/dns_records/${recordId}`, {
    method: "DELETE",
  });
}

// ─────────────────────────────────────────────────────────────────
// Nginx vhost template writer + reload (Phase 9b's plain-fs-shared-
// -directory design — see config.ts's own domainStackConfDDir doc
// comment for why this is a direct fs write, not a Docker API call).
// ─────────────────────────────────────────────────────────────────

function vhostFilePath(subdomainSlug: string): string {
  // subdomainSlug is already validated by requireValidSubdomainSlug()
  // before this is ever called — no path-traversal surface, but
  // path.join + a defensive basename-equality check costs nothing.
  const file = path.join(config.domainStackConfDDir, `${subdomainSlug}.conf`);
  if (path.basename(file) !== `${subdomainSlug}.conf`) {
    throw Object.assign(new Error(`invalid subdomain_slug for vhost path: "${subdomainSlug}"`), { status: 400 });
  }
  return file;
}

/**
 * next-phase.md Phase 9e-ii (architecture-agent.md §4h's closing
 * paragraph) — a real gap found by inspection while wiring the shared
 * marketplace's own subdomain, not pre-empted by 9c: every prior
 * caller of provisionSubdomain() reverse-proxies a whole standalone
 * service occupying its own port, so `location / { proxy_pass
 * http://127.0.0.1:${targetPort}; }` (no path component) was always
 * correct — the department's app owns everything at that port. The
 * shared marketplace is different: it's marketplace.ts, mounted at
 * /marketplace on THIS SAME backend process (see index.ts), not a
 * separate service with a port of its own. Proxying
 * marketplace.novamail.store's root at this backend's own port with
 * no path rewrite would hit the backend's OWN root routes (wallet,
 * vm, etc.), never marketplace.ts at all.
 *
 * proxyPathPrefix (optional, defaults to none — every existing caller
 * of provisionSubdomain()/writeVhostFile() passes nothing and gets
 * byte-identical output to before this change) fixes this the
 * standard nginx way: when set, proxy_pass gets a URI component
 * (http://127.0.0.1:${targetPort}${prefix}/), which for a catch-all
 * `location /` block means nginx replaces the matched prefix with
 * proxy_pass's own URI and appends the remainder — so
 * marketplace.novamail.store/listings reaches
 * 127.0.0.1:${targetPort}/marketplace/listings upstream, not
 * /listings. A trailing slash is enforced (prefix normalized to strip
 * any trailing slash the caller passed, then one added back) so this
 * never produces a double or missing slash regardless of how the
 * caller writes the prefix.
 */
function renderVhostTemplate(subdomainSlug: string, targetPort: number, proxyPathPrefix?: string): string {
  const serverName = `${subdomainSlug}.${config.domainApex}`;
  const normalizedPrefix = proxyPathPrefix ? proxyPathPrefix.replace(/\/+$/, "") : "";
  const proxyTarget = normalizedPrefix
    ? `http://127.0.0.1:${targetPort}${normalizedPrefix}/`
    : `http://127.0.0.1:${targetPort}`;
  // HTTP: serves the ACME webroot (certbot's own challenge path, per
  // 9b's certonly --webroot design) and reverse-proxies everything
  // else to the caller's own already-running service on localhost.
  // HTTPS: only added once issueCert() has actually produced a
  // certificate for this name — see writeVhostFile()'s two-pass call
  // below, matching 9b's "acme-companion-to-certbot" note that a
  // vhost referencing a not-yet-issued cert file would make nginx
  // fail to reload at all.
  return `# Managed by Automaton Domain Management — Phase 9c provision_subdomain(${subdomainSlug})
server {
    listen 80;
    server_name ${serverName};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        proxy_pass ${proxyTarget};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

function renderVhostTemplateWithSsl(subdomainSlug: string, targetPort: number, proxyPathPrefix?: string): string {
  const serverName = `${subdomainSlug}.${config.domainApex}`;
  const normalizedPrefix = proxyPathPrefix ? proxyPathPrefix.replace(/\/+$/, "") : "";
  const proxyTarget = normalizedPrefix
    ? `http://127.0.0.1:${targetPort}${normalizedPrefix}/`
    : `http://127.0.0.1:${targetPort}`;
  const base = renderVhostTemplate(subdomainSlug, targetPort, proxyPathPrefix);
  return `${base}
server {
    listen 443 ssl;
    server_name ${serverName};

    ssl_certificate /etc/letsencrypt/live/${subdomainSlug}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${subdomainSlug}/privkey.pem;

    location / {
        proxy_pass ${proxyTarget};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

export async function writeVhostFile(
  subdomainSlug: string,
  targetPort: number,
  withSsl: boolean,
  proxyPathPrefix?: string,
): Promise<void> {
  const content = withSsl
    ? renderVhostTemplateWithSsl(subdomainSlug, targetPort, proxyPathPrefix)
    : renderVhostTemplate(subdomainSlug, targetPort, proxyPathPrefix);
  await fs.writeFile(vhostFilePath(subdomainSlug), content, "utf8");
}

export async function deleteVhostFile(subdomainSlug: string): Promise<void> {
  try {
    await fs.unlink(vhostFilePath(subdomainSlug));
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
    // Already gone — deletion is idempotent, matching this sub-phase's
    // "release the claim last, not first" ordering discipline: a
    // retry after a partial teardown must not fail just because the
    // file half of the job already succeeded.
  }
}

export async function reloadNginx(): Promise<void> {
  const result = await execInNamedContainer(
    config.domainStackNginxContainer,
    "nginx",
    ["-s", "reload"],
    15_000,
    64 * 1024,
  );
  if (result.exitCode !== 0) {
    throw Object.assign(
      new Error(`nginx -s reload failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`),
      { status: 502 },
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Cert issuance (certbot, one-shot exec against the Phase 9b
// certbot container — 9b's own always-running `certbot renew` loop
// handles actual renewal; renewCert() below only confirms status).
// ─────────────────────────────────────────────────────────────────

export async function issueCert(subdomainSlug: string): Promise<void> {
  if (!config.domainStackCertbotEmail) {
    // Refusing to run at all rather than silently passing
    // --register-unsafely-without-email — an expiring-soon notice
    // with no reachable owner is exactly the silent failure this
    // system's own "no silent gaps" posture exists to avoid.
    throw Object.assign(
      new Error("DOMAIN_STACK_CERTBOT_EMAIL is not configured — refusing to issue a cert with no reachable owner"),
      { status: 503 },
    );
  }
  const serverName = `${subdomainSlug}.${config.domainApex}`;
  const result = await execInNamedContainer(
    config.domainStackCertbotContainer,
    "certbot",
    [
      "certonly",
      "--webroot",
      "-w",
      "/var/www/certbot",
      "-d",
      serverName,
      "--non-interactive",
      "--agree-tos",
      "-m",
      config.domainStackCertbotEmail,
      "--cert-name",
      subdomainSlug,
    ],
    120_000,
    128 * 1024,
  );
  if (result.exitCode !== 0) {
    throw Object.assign(
      new Error(`certbot certonly failed for ${serverName} (exit ${result.exitCode}): ${result.stderr || result.stdout}`),
      { status: 502 },
    );
  }
}

/** Thin status-confirmation wrapper — actual renewal is 9b's own always-running `certbot renew` loop. */
export async function renewCert(subdomainSlug: string): Promise<{ stdout: string }> {
  const result = await execInNamedContainer(
    config.domainStackCertbotContainer,
    "certbot",
    ["certificates", "--cert-name", subdomainSlug],
    30_000,
    64 * 1024,
  );
  if (result.exitCode !== 0) {
    throw Object.assign(
      new Error(`certbot certificates failed for ${subdomainSlug} (exit ${result.exitCode}): ${result.stderr || result.stdout}`),
      { status: 502 },
    );
  }
  return { stdout: result.stdout };
}

async function revokeCertBestEffort(subdomainSlug: string): Promise<void> {
  try {
    await execInNamedContainer(
      config.domainStackCertbotContainer,
      "certbot",
      ["delete", "--cert-name", subdomainSlug, "--non-interactive"],
      30_000,
      64 * 1024,
    );
  } catch {
    // Best-effort, matching this sub-phase's "a partial Docker/fs
    // failure never turns an already-committed released status into a
    // thrown error" discipline (Phase 3f-ii precedent) — a cert that
    // fails to delete cleanly just expires unrenewed later; it is not
    // load-bearing for the domain_resources row's own correctness.
  }
}

// ─────────────────────────────────────────────────────────────────
// Bounded polling — provisionSubdomain() doesn't return "requested",
// it returns a genuinely working HTTPS URL. Up to 12x10s (2 minutes)
// waiting for certbot's HTTP-01 challenge to be satisfiable, which
// itself depends on the DNS record above having propagated and the
// vhost's :80 ACME-challenge location already being live.
// ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function issueCertWithBoundedRetries(subdomainSlug: string, attempts = 12, delayMs = 10_000): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await issueCert(subdomainSlug);
      return;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`issueCert failed after ${attempts} attempts for ${subdomainSlug}`);
}

// ─────────────────────────────────────────────────────────────────
// Atomic orchestration
// ─────────────────────────────────────────────────────────────────

export interface ProvisionSubdomainResult {
  resource: DomainResourceRow;
  url: string;
}

/**
 * Single call doing all three steps in sequence, each step's failure
 * rolling back the steps before it — same "claim first, then do the
 * work, undo the claim on failure" shape Phase 3f-ii's channel
 * teardown already established:
 *
 *   1. domain_resources collision check + insert (status='active') —
 *      the atomic claim.
 *   2. Cloudflare A record for {subdomainSlug}.{domainApex} -> targetIp.
 *   3. Nginx vhost (HTTP-only pass first, so certbot's HTTP-01
 *      challenge has somewhere to land) + cert issuance (bounded
 *      retries) + a second vhost pass adding the :443 server block +
 *      final reload.
 *
 * A failure at step 2 deletes the domain_resources claim. A failure
 * at step 3 deletes both the DNS record AND the domain_resources
 * claim, and removes any partially-written vhost file — no orphaned
 * Cloudflare entry or vhost file with nothing behind it.
 */
export async function provisionSubdomain(
  ownerAgentId: string,
  // next-phase.md Phase 9e-ii: nullable, not widened from the
  // Phase 9a-i schema's own already-nullable owner_department_id
  // column — the shared marketplace's own platform row (9e) is the
  // one caller that passes null here, matching db.ts's own schema
  // comment ("owner_department_id ... nullable specifically for the
  // shared marketplace's own row"). ownerAgentId stays a required
  // string per that same comment's other half: "owner_agent_id ...
  // Always set — even the shared marketplace's own platform-owned row
  // is provisioned by a real one-time migration/Founder action, not
  // by no one." See provisionMarketplaceSubdomain() below for what
  // value it passes.
  ownerDepartmentId: string | null,
  subdomainSlug: string,
  targetPort: number,
  // next-phase.md Phase 9e-ii: see writeVhostFile()'s own comment.
  // Optional, defaults to none — every pre-existing caller (9c's own
  // department-scoped provision_subdomain ACTION) passes nothing and
  // gets byte-identical vhost output to before this parameter existed.
  proxyPathPrefix?: string,
): Promise<ProvisionSubdomainResult> {
  requireValidSubdomainSlug(subdomainSlug, ownerAgentId);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw Object.assign(new Error(`invalid target_port: ${targetPort}`), { status: 400 });
  }
  if (!config.domainStackPublicIp) {
    throw Object.assign(
      new Error("DOMAIN_STACK_PUBLIC_IP is not configured on this deployment — refusing to create a DNS record pointing nowhere"),
      { status: 503 },
    );
  }
  const targetIp = config.domainStackPublicIp;

  const fullValue = `${subdomainSlug}.${config.domainApex}`;

  // Step 1: the atomic claim. The UNIQUE index on full_value
  // (db.ts's Phase 9a-i migration) is the actual collision guard —
  // this SELECT is a fast-path check for a clean error message before
  // ever touching Cloudflare, not the sole enforcement.
  const existing = db
    .prepare(`SELECT id, status FROM domain_resources WHERE full_value = ?`)
    .get(fullValue) as { id: string; status: string } | undefined;
  if (existing && existing.status === "active") {
    throw Object.assign(new Error(`subdomain already provisioned and active: ${fullValue}`), { status: 409 });
  }

  const resourceId = newDomainResourceId();
  const now = Date.now();
  try {
    if (existing) {
      // A previously-released row for this exact value — reclaim it
      // rather than violating the UNIQUE(full_value) index with a
      // second row for the same name.
      db.prepare(
        `UPDATE domain_resources SET id = ?, owner_agent_id = ?, owner_department_id = ?, status = 'active', created_at = ? WHERE full_value = ?`,
      ).run(resourceId, ownerAgentId, ownerDepartmentId, now, fullValue);
    } else {
      db.prepare(
        `INSERT INTO domain_resources (id, resource_type, full_value, owner_agent_id, owner_department_id, status, created_at)
         VALUES (?, 'subdomain', ?, ?, ?, 'active', ?)`,
      ).run(resourceId, fullValue, ownerAgentId, ownerDepartmentId, now);
    }
  } catch (err: any) {
    // UNIQUE(full_value) collision raced us — someone else claimed it
    // between our SELECT and this INSERT.
    throw Object.assign(new Error(`subdomain already provisioned (race): ${fullValue}`), { status: 409 });
  }

  const undoClaim = () => {
    db.prepare(`UPDATE domain_resources SET status = 'released' WHERE id = ?`).run(resourceId);
  };

  // Step 2: DNS.
  let dnsRecord: CloudflareDnsRecord;
  try {
    dnsRecord = await createDnsRecord(subdomainSlug, targetIp);
  } catch (err) {
    undoClaim();
    throw err;
  }

  // Step 3: vhost (HTTP-only pass) + cert + vhost (HTTPS pass) + reload.
  try {
    await writeVhostFile(subdomainSlug, targetPort, false, proxyPathPrefix);
    await reloadNginx();
    await issueCertWithBoundedRetries(subdomainSlug);
    await writeVhostFile(subdomainSlug, targetPort, true, proxyPathPrefix);
    await reloadNginx();
  } catch (err) {
    await deleteVhostFile(subdomainSlug).catch(() => {});
    await deleteDnsRecord(dnsRecord.id).catch(() => {});
    undoClaim();
    throw err;
  }

  const resource = db.prepare(`SELECT * FROM domain_resources WHERE id = ?`).get(resourceId) as DomainResourceRow;
  return { resource, url: `https://${fullValue}` };
}

/**
 * next-phase.md Phase 9e-ii (architecture-agent.md §4h's closing
 * paragraph): the one-time platform provisioning call that gives the
 * already-shared marketplace.ts (confirmed Agent-agnostic by 9e-i's
 * inspection) a real public subdomain. A thin, deliberately narrow
 * wrapper around provisionSubdomain() itself — not a separate code
 * path, so it gets the exact same claim-first/DNS/vhost+cert
 * orchestration and the exact same rollback-on-failure guarantees
 * every department's own provision_subdomain call already has — that
 * only fixes four things a general caller could otherwise get wrong:
 *   - ownerAgentId is always PLATFORM_OWNER_SENTINEL, never a caller-
 *     supplied agent address (nothing here should ever "belong" to a
 *     specific hosted Agent).
 *   - ownerDepartmentId is always null (the "has no single owning
 *     department" case db.ts's own schema comment already documents).
 *   - subdomainSlug is always the PLATFORM_RESERVED_SLUG constant, not
 *     a caller-supplied string — this is the one caller allowed to use
 *     it bare, and hardcoding it here means that's enforced by this
 *     function's own signature, not by caller discipline.
 *   - proxyPathPrefix is always "/marketplace" — matching where
 *     index.ts actually mounts marketplaceRouter on this same backend
 *     process (see writeVhostFile()'s own comment for why this
 *     matters for this one caller and no other).
 * Meant to be invoked exactly once, by a one-time platform-setup
 * script or an admin-key-gated route (see domainRoutes.ts's
 * `domainAdminRouter`) — never dispatched to any Agent as a tool.
 * Calling it twice is not unsafe (provisionSubdomain()'s own
 * already-active/already-claimed checks apply identically), just
 * redundant.
 */
export async function provisionMarketplaceSubdomain(targetPort: number): Promise<ProvisionSubdomainResult> {
  return provisionSubdomain(PLATFORM_OWNER_SENTINEL, null, PLATFORM_RESERVED_SLUG, targetPort, "/marketplace");
}

/**
 * Mirror teardown — release the claim LAST, not first, so a crash
 * mid-teardown never leaves domain_resources claiming a resource
 * that's already gone from Cloudflare/disk. Every individual step is
 * best-effort/idempotent (missing DNS record, missing vhost file, and
 * a certbot delete failure are all tolerated) so a repeat call on an
 * already-partially-torn-down resource still converges.
 */
export async function releaseSubdomain(
  ownerAgentId: string,
  ownerDepartmentId: string,
  resourceId: string,
): Promise<DomainResourceRow> {
  const resource = db
    .prepare(
      `SELECT * FROM domain_resources WHERE id = ? AND owner_agent_id = ? AND owner_department_id = ? AND resource_type = 'subdomain'`,
    )
    .get(resourceId, ownerAgentId, ownerDepartmentId) as DomainResourceRow | undefined;
  if (!resource) {
    throw Object.assign(new Error(`subdomain resource not found: ${resourceId}`), { status: 404 });
  }
  if (resource.status === "released") {
    return resource; // already terminal — idempotent, same convention as revokeChannel()
  }

  const subdomainSlug = resource.full_value.slice(0, resource.full_value.length - config.domainApex.length - 1);

  await deleteVhostFile(subdomainSlug);
  await reloadNginx().catch(() => {});
  await revokeCertBestEffort(subdomainSlug);

  try {
    const records = await listDnsRecords(subdomainSlug);
    for (const record of records) {
      await deleteDnsRecord(record.id).catch(() => {});
    }
  } catch {
    // Cloudflare unreachable/unconfigured — best-effort, doesn't block
    // the domain_resources status transition below.
  }

  db.prepare(`UPDATE domain_resources SET status = 'released' WHERE id = ?`).run(resourceId);
  return db.prepare(`SELECT * FROM domain_resources WHERE id = ?`).get(resourceId) as DomainResourceRow;
}

// ─────────────────────────────────────────────────────────────────
// Phase 9d-i — Mailcow client, encrypted credential storage, and
// createMailbox(). The write half of §4h's mailbox-provisioning tool;
// mail_list_mailboxes/reveal_mailbox_credential (9d-ii) and
// mail_delete_mailbox (9d-iii) build on top of what's here.
// ─────────────────────────────────────────────────────────────────

/**
 * Mailbox credential encryption — same AES-256-GCM at-rest scheme
 * wallet.ts's own encrypt()/decrypt() use for the wallet keypair, but
 * a distinct derived key (see db.ts's mailbox_credentials migration
 * comment for why this deliberately does NOT reuse wallet.ts's
 * literal ENC_KEY). Not exported: decryptMailboxPassword() is only
 * ever called from reveal_mailbox_credential (9d-ii) — this sub-phase
 * writes an encrypted password and never reads it back in plaintext,
 * matching the "never in any tool-call response that might land in a
 * model's own visible context/transcript" requirement in its own
 * checklist item.
 */
const MAILBOX_ENC_KEY = crypto.createHash("sha256").update(`${config.backendApiKey}:mailbox-credentials`).digest();

function encryptMailboxPassword(password: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MAILBOX_ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/**
 * Not called anywhere in Phase 9d-i — kept alongside its own encrypt
 * function, ready for 9d-ii's reveal_mailbox_credential to import.
 * Phase 9d-ii is that caller: domainRoutes.ts's own POST
 * .../mailboxes/:resourceId/reveal route imports this directly (this
 * sub-phase's "Touches" line doesn't list domains.ts precisely because
 * nothing here needed to change — this export already existed, fully
 * formed, waiting on exactly this call site).
 */
export function decryptMailboxPassword(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", MAILBOX_ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}

/**
 * Generates a real random password for a new mailbox — 24 random
 * bytes, base64url-encoded (32 chars, URL/shell-safe, no padding),
 * comfortably clears Mailcow's own default minimum-length password
 * policy. Never derived from anything guessable (agent address, slug,
 * local part) — a mailbox password carries no relationship to the
 * mailbox's own public-facing name.
 */
function generateMailboxPassword(): string {
  return crypto.randomBytes(24).toString("base64url");
}

// ─────────────────────────────────────────────────────────────────
// Mailcow API client
// ─────────────────────────────────────────────────────────────────

interface MailcowApiResponseItem {
  type: "success" | "error" | "danger";
  msg: unknown;
}

function requireMailcowConfigured(): { apiUrl: string; apiKey: string } {
  if (!config.mailcowApiUrl || !config.mailcowApiKey) {
    throw Object.assign(
      new Error("Mailcow is not configured on this deployment (MAILCOW_API_URL / MAILCOW_API_KEY unset)"),
      { status: 503 },
    );
  }
  return { apiUrl: config.mailcowApiUrl, apiKey: config.mailcowApiKey };
}

async function mailcowRequest(
  apiUrl: string,
  apiKey: string,
  urlPath: string,
  body: unknown,
): Promise<MailcowApiResponseItem[]> {
  const res = await fetch(`${apiUrl}${urlPath}`, {
    method: "POST",
    headers: {
      "X-API-Key": apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  // Mailcow's own API returns 200 with a JSON array of
  // {type, msg} items even on a semantic failure (e.g. "mailbox
  // already exists") — the HTTP status alone doesn't tell success
  // from failure, so every item's own `type` has to be checked.
  const result = (await res.json()) as MailcowApiResponseItem[] | MailcowApiResponseItem;
  const items = Array.isArray(result) ? result : [result];
  if (!res.ok || items.some((item) => item.type === "error" || item.type === "danger")) {
    throw Object.assign(new Error(`mailcow_api_error: ${JSON.stringify(items)}`), { status: 502 });
  }
  return items;
}

/**
 * Creates `{localPart}@{domainApex}` in Mailcow — Mailcow's own
 * `POST /api/v1/add/mailbox` (see Mailcow's admin API docs), full
 * mailbox quota left at a conservative default rather than an
 * agent-supplied value (not part of this sub-phase's own checklist
 * item; a future phase can expose a `quota` parameter deliberately if
 * a real need for one shows up).
 */
async function createMailcowMailbox(localPart: string, password: string): Promise<void> {
  const { apiUrl, apiKey } = requireMailcowConfigured();
  await mailcowRequest(apiUrl, apiKey, "/api/v1/add/mailbox", {
    local_part: localPart,
    domain: config.domainApex,
    name: localPart,
    quota: "1024",
    password,
    password2: password,
    active: "1",
  });
}

/**
 * Deletes `{localPart}@{domainApex}` in Mailcow — Mailcow's own
 * `POST /api/v1/delete/mailbox` (see Mailcow's admin API docs), taking
 * a JSON array of full addresses to delete, same shape
 * `createMailbox()`'s own best-effort rollback call already uses.
 * Idempotent-tolerant at the call site (deleteMailbox() below treats a
 * "not found"-shaped Mailcow error as success), not here — this
 * function itself just relays whatever Mailcow returns.
 */
async function deleteMailcowMailbox(fullValue: string): Promise<void> {
  const { apiUrl, apiKey } = requireMailcowConfigured();
  await mailcowRequest(apiUrl, apiKey, "/api/v1/delete/mailbox", [fullValue]);
}

// ─────────────────────────────────────────────────────────────────
// Atomic orchestration — createMailbox()
// ─────────────────────────────────────────────────────────────────

export interface CreateMailboxResult {
  resource: DomainResourceRow;
  mailboxAddress: string;
}

/**
 * Single call: (1) domain_resources collision check + insert
 * (status='active') — the atomic claim, same "claim first, then do
 * the work, undo the claim on failure" shape provisionSubdomain()
 * above already establishes; (2) Mailcow API call creating the actual
 * mailbox; (3) a generated password, encrypted, written to
 * mailbox_credentials keyed on the new resource's id. A failure at
 * step 2 or 3 deletes the domain_resources claim — no orphaned Mailcow
 * mailbox with no domain_resources row behind it, and no
 * domain_resources row claiming a mailbox Mailcow never actually
 * created.
 *
 * Returns `{ resource, mailboxAddress }` only — the generated password
 * is never returned here or logged anywhere; retrieving it is 9d-ii's
 * own separate, audited reveal_mailbox_credential call.
 */
export async function createMailbox(
  ownerAgentId: string,
  ownerDepartmentId: string,
  localPart: string,
): Promise<CreateMailboxResult> {
  requireValidMailboxLocalPart(localPart, ownerAgentId);

  const fullValue = `${localPart}@${config.domainApex}`;

  // Step 1: the atomic claim — same UNIQUE(full_value)-backed
  // claim-first-check-second shape provisionSubdomain() uses above;
  // the index is the real guard, this SELECT is a fast-path clean
  // error before ever touching Mailcow.
  const existing = db
    .prepare(`SELECT id, status FROM domain_resources WHERE full_value = ?`)
    .get(fullValue) as { id: string; status: string } | undefined;
  if (existing && existing.status === "active") {
    throw Object.assign(new Error(`mailbox already provisioned and active: ${fullValue}`), { status: 409 });
  }

  const resourceId = newDomainResourceId();
  const now = Date.now();
  try {
    if (existing) {
      db.prepare(
        `UPDATE domain_resources SET id = ?, owner_agent_id = ?, owner_department_id = ?, status = 'active', created_at = ? WHERE full_value = ?`,
      ).run(resourceId, ownerAgentId, ownerDepartmentId, now, fullValue);
    } else {
      db.prepare(
        `INSERT INTO domain_resources (id, resource_type, full_value, owner_agent_id, owner_department_id, status, created_at)
         VALUES (?, 'mailbox', ?, ?, ?, 'active', ?)`,
      ).run(resourceId, fullValue, ownerAgentId, ownerDepartmentId, now);
    }
  } catch (err) {
    // UNIQUE(full_value) collision raced us.
    throw Object.assign(new Error(`mailbox already provisioned (race): ${fullValue}`), { status: 409 });
  }

  const undoClaim = () => {
    db.prepare(`UPDATE domain_resources SET status = 'released' WHERE id = ?`).run(resourceId);
  };

  // Step 2: Mailcow.
  const password = generateMailboxPassword();
  try {
    await createMailcowMailbox(localPart, password);
  } catch (err) {
    undoClaim();
    throw err;
  }

  // Step 3: encrypted credential row. If this fails, the mailbox now
  // exists in Mailcow with no retrievable password anywhere — worse
  // than a clean rollback would be, so this also rolls the Mailcow
  // side back (best-effort delete) rather than leaving an orphaned,
  // permanently-locked-out mailbox behind.
  try {
    db.prepare(
      `INSERT INTO mailbox_credentials (resource_id, encrypted_password, created_at) VALUES (?, ?, ?)`,
    ).run(resourceId, encryptMailboxPassword(password), now);
  } catch (err) {
    await mailcowRequest(config.mailcowApiUrl, config.mailcowApiKey, "/api/v1/delete/mailbox", [fullValue]).catch(
      () => {},
    );
    undoClaim();
    throw err;
  }

  const resource = db.prepare(`SELECT * FROM domain_resources WHERE id = ?`).get(resourceId) as DomainResourceRow;
  return { resource, mailboxAddress: fullValue };
}

/**
 * next-phase.md Phase 9d-iii (architecture-agent.md §4h): the
 * teardown half of Domain Management's mailbox-provisioning tool.
 * Same ordering discipline releaseSubdomain() above already
 * establishes — release the domain_resources claim LAST, not first,
 * so a crash mid-teardown never leaves domain_resources claiming a
 * mailbox that's already gone from Mailcow. The encrypted credential
 * row is deleted alongside the claim (there's nothing left worth
 * decrypting once the mailbox itself is gone), not before Mailcow
 * deletion succeeds — a failed Mailcow call must leave the credential
 * retrievable, since the mailbox itself is still live.
 *
 * Idempotent, same "already terminal — return, don't re-run
 * teardown" convention releaseSubdomain()/revokeChannel() already use:
 * a second call on an already-'released' resource is a no-op success,
 * not an error.
 */
export async function deleteMailbox(
  ownerAgentId: string,
  ownerDepartmentId: string,
  resourceId: string,
): Promise<DomainResourceRow> {
  const resource = db
    .prepare(
      `SELECT * FROM domain_resources WHERE id = ? AND owner_agent_id = ? AND owner_department_id = ? AND resource_type = 'mailbox'`,
    )
    .get(resourceId, ownerAgentId, ownerDepartmentId) as DomainResourceRow | undefined;
  if (!resource) {
    throw Object.assign(new Error(`mailbox resource not found: ${resourceId}`), { status: 404 });
  }
  if (resource.status === "released") {
    return resource; // already terminal — idempotent, same convention as releaseSubdomain()
  }

  // Mailcow deletion — best-effort-tolerant of "already gone" so a
  // repeat call (e.g. retried after a prior partial teardown) still
  // converges, mirroring releaseSubdomain()'s own best-effort DNS/vhost
  // cleanup. A genuine, live-mailbox-exists deletion failure (Mailcow
  // reachable but refuses, e.g. auth error) is NOT swallowed here — it
  // propagates, leaving domain_resources still claiming the mailbox
  // (status unchanged) rather than releasing a claim over a mailbox
  // that may still actually exist in Mailcow.
  try {
    await deleteMailcowMailbox(resource.full_value);
  } catch (err: any) {
    // Mailcow's own API returns a {type:"error", msg:[...]} item (see
    // mailcowRequest()'s own doc comment) whose msg text names the
    // specific failure — "mailbox_not_found" or "object_does_not_exist"
    // shaped errors (the exact wording Mailcow's own API uses for a
    // mailbox that's already gone) are tolerated as an already-converged
    // outcome; any other error (unconfigured Mailcow, auth failure, a
    // real API error) propagates unchanged.
    const message = String(err?.message ?? "");
    const alreadyGone = /not_found|does_not_exist|no_mailbox_found/i.test(message);
    if (!alreadyGone) {
      throw err;
    }
  }

  db.prepare(`DELETE FROM mailbox_credentials WHERE resource_id = ?`).run(resourceId);
  db.prepare(`UPDATE domain_resources SET status = 'released' WHERE id = ?`).run(resourceId);
  return db.prepare(`SELECT * FROM domain_resources WHERE id = ?`).get(resourceId) as DomainResourceRow;
}
