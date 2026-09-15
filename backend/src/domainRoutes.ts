import express from "express";
import { db } from "./db.js";
import { config } from "./config.js";
import { getOwnedDepartment } from "./departments.js";
import {
  provisionSubdomain,
  listSubdomains,
  releaseSubdomain,
  createMailbox,
  decryptMailboxPassword,
  deleteMailbox,
  provisionMarketplaceSubdomain,
} from "./domains.js";
import type { DomainResourceRow } from "./domains.js";

/**
 * next-phase.md Phase 9c (architecture-agent.md §4h): the HTTP surface
 * over domains.ts's atomic orchestration functions. Same ownership
 * shape as every other department-scoped route in departments.ts —
 * `getOwnedDepartment(req.params.id, agentAddress)` — so a Domain
 * Management Department can only ever provision/list/release
 * subdomains under its OWN department id, never another department's
 * (or another Agent's) claim.
 *
 * Mounted as `app.use("/departments", domainRoutesRouter)` in
 * index.ts, alongside (not instead of) the existing departmentsRouter
 * — a separate Router instance keeps this sub-phase's routes in their
 * own file per the "Touches" line, while still living under the same
 * `/departments/:id/...` URL space every other department capability
 * already uses.
 */

const router = express.Router();

// POST /departments/:id/domain/subdomains  { agentAddress, subdomainSlug, targetPort }
router.post("/:id/domain/subdomains", async (req, res) => {
  try {
    const { agentAddress, subdomainSlug, targetPort } = req.body as {
      agentAddress?: string;
      subdomainSlug?: string;
      targetPort?: number;
    };
    if (!agentAddress || !subdomainSlug || targetPort === undefined) {
      return res.status(400).json({ error: "agentAddress, subdomainSlug, and targetPort are required" });
    }
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const result = await provisionSubdomain(agentAddress, dept.id, subdomainSlug, Number(targetPort));
    res.json({ ok: true, resource: result.resource, url: result.url });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /departments/:id/domain/subdomains?agentAddress=...
router.get("/:id/domain/subdomains", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const resources = listSubdomains(agentAddress, dept.id);
    res.json({ departmentId: dept.id, resources });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// DELETE /departments/:id/domain/subdomains/:resourceId  { agentAddress }
router.delete("/:id/domain/subdomains/:resourceId", async (req, res) => {
  try {
    const { agentAddress } = req.body as { agentAddress?: string };
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const resource = await releaseSubdomain(agentAddress, dept.id, req.params.resourceId);
    res.json({ ok: true, resource });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/domain/mailboxes  { agentAddress, localPart }
// next-phase.md Phase 9d-i: the write half of §4h's mailbox-provisioning
// tool. GET (list) and the separate reveal-credential route are 9d-ii's
// own job; DELETE is 9d-iii's — this route is create-only.
router.post("/:id/domain/mailboxes", async (req, res) => {
  try {
    const { agentAddress, localPart } = req.body as {
      agentAddress?: string;
      localPart?: string;
    };
    if (!agentAddress || !localPart) {
      return res.status(400).json({ error: "agentAddress and localPart are required" });
    }
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const result = await createMailbox(agentAddress, dept.id, localPart);
    // Deliberately no password/credential field in this response —
    // matches createMailbox()'s own "never returned here" contract.
    res.json({ ok: true, resource: result.resource, mailboxAddress: result.mailboxAddress });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// next-phase.md Phase 9d-ii (architecture-agent.md §4h's read half of
// the mailbox-provisioning tool, and §8's "credentials stay narrowly
// scoped and every access is audited" posture applied to mailbox
// passwords specifically).
//
// Two routes, same ownership shape (getOwnedDepartment) every other
// route in this file already uses:
//
//   GET  .../mailboxes         — mail_list_mailboxes: address + status
//                                 only, same shape listSubdomains()
//                                 already returns for subdomains. The
//                                 underlying domain_resources rows carry
//                                 no credential field at all (that lives
//                                 in the sibling mailbox_credentials
//                                 table — see db.ts's own schema
//                                 comment), so there is no field to
//                                 scrub here; the query itself simply
//                                 never touches mailbox_credentials.
//
//   POST .../mailboxes/:resourceId/reveal
//                              — reveal_mailbox_credential: deliberately
//                                its own route/ACTION, not folded into
//                                the GET above (same "one point in the
//                                whole flow where the password is
//                                actually readable" scoping this
//                                sub-phase's own checklist item
//                                describes). Gated to the owning
//                                department only, via the same
//                                getOwnedDepartment(...) + an explicit
//                                resource_type==='mailbox' check (a
//                                department could otherwise pass a
//                                subdomain/vhost resource id it also
//                                owns and get a confusing "no
//                                credential" error instead of a clean
//                                404). Every call that reaches the
//                                actual decrypt is logged to
//                                capability_audit — allow-only, same
//                                "there's no one to deny at this layer,
//                                a refusal is just returned to the
//                                caller rather than logged as a bare
//                                deny" shape orchestrator.ts's own
//                                auditOrchestrator() already
//                                established for a comparably
//                                caller-is-always-the-resource-owner
//                                route.
// ─────────────────────────────────────────────────────────────────

interface MailboxCredentialRow {
  resource_id: string;
  encrypted_password: string;
  created_at: number;
}

function auditMailboxCredentialReveal(callerAgentId: string, resourceId: string): void {
  db.prepare(
    `INSERT INTO capability_audit (caller, resource_type, resource_id, action, decision, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(callerAgentId, "mailbox_credential", resourceId, "reveal_mailbox_credential", "allow", "owner", Date.now());
}

// GET /departments/:id/domain/mailboxes?agentAddress=...
router.get("/:id/domain/mailboxes", (req, res) => {
  try {
    const agentAddress = String(req.query.agentAddress || "");
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const resources = db
      .prepare(
        `SELECT * FROM domain_resources
         WHERE owner_agent_id = ? AND owner_department_id = ? AND resource_type = 'mailbox'
         ORDER BY created_at DESC`,
      )
      .all(agentAddress, dept.id) as DomainResourceRow[];
    // Deliberately no credential field — matches createMailbox()'s own
    // "never returned here" contract; this query never joins
    // mailbox_credentials at all.
    res.json({ departmentId: dept.id, resources });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// POST /departments/:id/domain/mailboxes/:resourceId/reveal  { agentAddress }
router.post("/:id/domain/mailboxes/:resourceId/reveal", (req, res) => {
  try {
    const { agentAddress } = req.body as { agentAddress?: string };
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);

    const resource = db
      .prepare(`SELECT * FROM domain_resources WHERE id = ? AND owner_agent_id = ? AND owner_department_id = ?`)
      .get(req.params.resourceId, agentAddress, dept.id) as DomainResourceRow | undefined;
    if (!resource || resource.resource_type !== "mailbox") {
      return res.status(404).json({ error: `mailbox resource not found: ${req.params.resourceId}` });
    }
    if (resource.status !== "active") {
      return res.status(409).json({ error: `mailbox is not active: ${resource.full_value} (status: ${resource.status})` });
    }

    const credRow = db
      .prepare(`SELECT * FROM mailbox_credentials WHERE resource_id = ?`)
      .get(resource.id) as MailboxCredentialRow | undefined;
    if (!credRow) {
      // Shouldn't happen for a well-formed mailbox resource (createMailbox()
      // writes both rows atomically, rolling back on failure) — surfaced as
      // a clean 500 rather than silently returning an empty password.
      return res.status(500).json({ error: `no stored credential for mailbox resource: ${resource.id}` });
    }

    const password = decryptMailboxPassword(credRow.encrypted_password);
    auditMailboxCredentialReveal(agentAddress, resource.id);

    res.json({ ok: true, resource, mailboxAddress: resource.full_value, password });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// next-phase.md Phase 9d-iii (architecture-agent.md §4h): the
// teardown half of the mailbox-provisioning tool. Same route shape
// (and same 200-with-{ok,resource} response body) as
// `DELETE .../subdomains/:resourceId` above.

// DELETE /departments/:id/domain/mailboxes/:resourceId  { agentAddress }
router.delete("/:id/domain/mailboxes/:resourceId", async (req, res) => {
  try {
    const { agentAddress } = req.body as { agentAddress?: string };
    if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
    const dept = getOwnedDepartment(req.params.id, agentAddress);
    const resource = await deleteMailbox(agentAddress, dept.id, req.params.resourceId);
    res.json({ ok: true, resource });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// next-phase.md Phase 9e-ii (architecture-agent.md §4h's closing
// paragraph): the one-time platform provisioning call that gives the
// already-shared marketplace.ts (confirmed Agent-agnostic by 9e-i's
// inspection) a real public subdomain.
//
// A SEPARATE Router instance, not another route on `router` above —
// every route on `router` is department-scoped (getOwnedDepartment,
// requiring a real :id in the path) and reachable under
// `/departments`, which sits behind index.ts's regular
// x-backend-key shared-secret middleware (the same key every hosted
// Agent's own runtime holds). This route has no department and isn't
// a per-Agent action at all — per 9e-ii's own spec it's "run once at
// platform setup (Founder or a one-time migration script, not a
// recurring per-Agent action)" — so it's exported separately here and
// mounted by index.ts under `/admin/domain` instead, inheriting that
// prefix's own x-admin-key check (see index.ts's own `app.use("/admin", ...)`
// middleware) rather than the regular per-Agent backend key. An
// ordinary hosted Agent, holding only BACKEND_API_KEY, can never reach
// this route — only whoever holds ADMIN_API_KEY (the platform
// operator) can.
// ─────────────────────────────────────────────────────────────────

export const domainAdminRouter = express.Router();

// POST /admin/domain/marketplace-subdomain  { targetPort? }
// targetPort defaults to config.port — this backend's own listening
// port — since marketplace.ts is mounted on THIS SAME process (see
// index.ts), not a separate service with a port of its own. An
// explicit targetPort is still accepted (not hardcoded) for a
// deployment that, for whatever reason, proxies through a different
// local port than the one this process itself listens on.
domainAdminRouter.post("/domain/marketplace-subdomain", async (req, res) => {
  try {
    const { targetPort } = req.body as { targetPort?: number };
    const resolvedPort = targetPort === undefined ? config.port : Number(targetPort);
    const result = await provisionMarketplaceSubdomain(resolvedPort);
    res.json({ ok: true, resource: result.resource, url: result.url });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
