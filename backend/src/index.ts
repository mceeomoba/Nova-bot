import express from "express";
import { config } from "./config.js";
import "./db.js";
import walletRouter from "./wallet.js";
import facilitatorRouter from "./facilitator.js";
import inferenceRouter from "./inferenceGateway.js";
import vmRouter from "./vmService.js";
import ptyRouter from "./ptyRoutes.js";
import subagentsRouter from "./subagents.js";
import departmentsRouter from "./departments.js";
import adminRouter from "./admin.js";
import memoryRouter from "./memory.js";
import portProxyRouter from "./portProxy.js";
import agentCardRouter from "./agentCard.js";
import marketplaceRouter from "./marketplace.js";
import socialRelayRouter from "./socialRelay.js";
import socialGroupsRouter from "./socialGroups.js";
import distributionRouter from "./distribution.js";
import toolRegistryRouter from "./toolRegistryRoutes.js";
import customToolRouter from "./customToolRoutes.js";
import skillsRouter from "./skillsRoutes.js";
import channelsRouter from "./channelService.js";
import domainRoutesRouter, { domainAdminRouter } from "./domainRoutes.js";
import orchestratorRouter from "./orchestratorRoutes.js";
import expansionRouter from "./expansionRoutes.js";
import expansionUiRouter from "./expansionUiRoutes.js";
import expansionKillRouter from "./expansionKillRoutes.js";
import ecosystemRouter from "./ecosystemRoutes.js";
import rootKillRoutes from "./rootKillRoutes.js";
import controlStatusRoute from "./controlStatusRoute.js";
import eventsAdminRoute from "./eventsAdminRoute.js";
import weeklyReportRoutes from "./weeklyReportRoutes.js";
import eventReportRoute from "./eventReportRoute.js";
import { registerGenesisEngine } from "./genesis.js";
import { ensureExpansionCircuitBreakerSchema } from "./expansionCircuitBreaker.js";
import { ensureSandboxContainer } from "./docker.js";
import { startGithubSync } from "./githubSync.js";
import { constantTimeSecretEqual } from "./sharedKeyAuth.js";

// Zent.md Phase 16a: swap expansion.ts's do-nothing defaultGenesisExecutor()
// for the real genesisCompany() path (genesis.ts) before any request can
// reach decideExpansion(). Process-lifetime, one-time registration — not
// per-request — same as every router mounted once below. Without this
// call, Phase 15d's "approved fires genesis directly, no operator gate"
// still records a genesis_triggers row on every approval but never
// actually provisions Agent B; this is the one line that makes the
// no-human-in-the-loop path in Zent.md's "Notes on scope" real rather
// than just recorded.
ensureExpansionCircuitBreakerSchema();
registerGenesisEngine();

const app = express();
app.use(express.json({ limit: "10mb" }));

// Public reverse proxy for agent-exposed sandbox ports — deliberately
// mounted BEFORE the shared-secret auth check below. These URLs are
// meant to be reachable by anyone the agent shares them with, the same
// way a Conway life.conway.tech link would be. Access control lives in
// the unguessable per-port token, not the backend key.
app.use("/app", portProxyRouter);

// ERC-8004 public surface — an agent's registration file and on-chain
// verification lookup are meant to be readable by any stranger, agent
// or human, without your BACKEND_API_KEY. See agentCard.ts. The
// mutating registration call (POST /wallet/:address/erc8004/register)
// stays behind the auth check below, on the /wallet router.
app.use("/agents", agentCardRouter);

// Marketplace — public discovery (GET /marketplace/listings, GET
// /marketplace/listings/:id) and paid invoke (POST /marketplace/:id/invoke)
// must be reachable by a stranger's agent with no BACKEND_API_KEY, same
// reasoning as agentCard.ts above. The seller-only write routes (POST
// /list, POST /:id/deactivate) enforce x-backend-key themselves inside
// marketplace.ts rather than relying on the global check below.
app.use("/marketplace", marketplaceRouter);

// Social Relay — this backend's own private replacement for Conway's
// social.conway.tech. Mounted BEFORE the shared-secret auth check for
// the same reason as agentCard/marketplace above: the whole point of a
// relay is that Agent B (who may not hold this VM's BACKEND_API_KEY, if
// it's a stranger's self-custody agent) can still receive mail addressed
// to its own wallet. Every route inside verifies its own wallet
// signature instead. Point an automaton's `socialRelayUrl` config at
// `{PUBLIC_BASE_URL}/social` to use this instead of Conway's relay.
app.use("/social", socialRelayRouter);

// Group ("meeting room") relay — same public-mount reasoning as the
// personal relay above, plus the same POST /v1/agents/:address/death
// route lives here since dead-agent group eviction is its only job.
// Mounted at the same "/social" prefix as socialRelayRouter, just on
// its own path namespace (/v1/groups/*, /v1/agents/:address/death) so
// the two routers never collide.
app.use("/social", socialGroupsRouter);

// Distribution — mounted at the same public tier as marketplace/agentCard/
// social above, and for the same reason: GET /distribution/channels,
// /history, and /feed.xml are meant to be readable by anyone (including
// a human, or a search engine crawling feed.xml), and POST /publish
// checks x-backend-key itself rather than relying on the middleware
// below. Its admin sub-routes (POST /distribution/admin/channels/*)
// check x-admin-key themselves too, same pattern marketplace.ts uses for
// its own seller-only write route — see distribution.ts.
app.use("/distribution", distributionRouter);

// Zent.md Phase 4e: the read-only HTML list view over the expansion
// pipeline. Mounted here, public, same tier and same reasoning as
// agentCardRouter/marketplaceRouter/distributionRouter above — the
// page itself carries no secret and performs no write; every data
// call it makes from the browser still goes through the authed
// /expansion/opportunities and /expansion/notifications routes below.
// See expansionUiRoutes.ts's own header for the full reasoning.
app.use("/expansion", expansionUiRouter);

// Simple shared-secret auth on every route except health check.
// /admin uses its own separate key (checked below), never the agent-facing one.
app.use((req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/admin")) return next();
  const key = req.header("x-backend-key");
  if (!constantTimeSecretEqual(key, config.backendApiKey)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// Admin routes require ADMIN_API_KEY specifically — an agent holding the
// regular BACKEND_API_KEY must never be able to read this.
app.use("/admin", (req, res, next) => {
  const key = req.header("x-admin-key");
  if (!constantTimeSecretEqual(key, config.adminApiKey)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/wallet", walletRouter);
app.use("/facilitator", facilitatorRouter);
app.use("/inference", inferenceRouter);
app.use("/vm", vmRouter);
app.use("/vm/pty", ptyRouter);
// next-phase.md Phase 2: sub-agent threads (spawn/list/status/kill).
// Behind the same shared-secret middleware as every other agent-facing
// route above — a worker never authenticates to this backend as
// itself, only the owner's runtime (holding BACKEND_API_KEY, the same
// key it already uses for /vm/*) drives these.
app.use("/subagents", subagentsRouter);
app.use("/departments", departmentsRouter);
// next-phase.md Phase 9c (architecture-agent.md §4h): subdomain/SSL
// provisioning routes, a second Router instance sharing the same
// `/departments/:id/...` URL space as departmentsRouter above — see
// domainRoutes.ts's own header for why it's a separate file/Router
// rather than added directly to departments.ts.
app.use("/departments", domainRoutesRouter);
app.use("/memory", memoryRouter);
// next-phase.md Phase 2i(e): read-only introspection over tool_registry
// (assignTools(), Phase 2i(b)) — behind the shared-secret middleware
// above like every other agent-facing route, not mounted early/public
// the way agentCard.ts/marketplace.ts are. See toolRegistryRoutes.ts's
// own header for why no ownership check is layered on top of that.
app.use("/tool-registry", toolRegistryRouter);
// Dynamic tool registration (register_tool/call_registered_tool in
// agent-runtime/src/tools.ts) — see customToolRoutes.ts's own header
// for why every route here is ownership-scoped by agentAddress, unlike
// /tool-registry/available just above.
app.use("/custom-tools", customToolRouter);
// Skills — ported from agent/'s SKILL.md system, see skills.ts's own
// header for why installation is handled server-side instead of via
// the agent's sandbox.
app.use("/skills", skillsRouter);
// Zent.md Phase 2b: scan_market_signals(query), the first live HTTP
// surface over expansion.ts's Phase 1 data model (see expansionRoutes.ts's
// own header for why the search AND the source_summary write happen
// together, behind the same shared-secret middleware as every route
// above). Phase 4a's read surface (GET /expansion/opportunities/:agentAddress)
// mounts onto this same router too — see expansionRoutes.ts's own
// Phase 4a section for why it's a plain read behind the same
// shared-secret check rather than a separately-authed surface.
app.use("/expansion", expansionRouter);
// Zent.md Phase 19d: security-shutdown / finance-lock-funds / combined
// kill + the read-only kill_events log, same shared-secret tier as
// expansionRouter immediately above (a second Router mounted onto the
// same "/expansion" prefix, same pattern expansionUiRouter/expansionRouter
// already demonstrate at line ~103/171 for a public-vs-private split —
// this one is two private routers sharing a prefix, not a public/private
// split). See expansionKillRoutes.ts's own header for the self/parent
// authorization model.
app.use("/expansion", expansionKillRouter);
// Zent.md Phase 18b: GET /ecosystem/:rootAgentAddress, the full
// pipeline-spawned tree view. Mounted here, behind the same
// shared-secret middleware every route above this line already sits
// behind (see ecosystemRoutes.ts's own header for why this is the
// private tier, not the public one expansionUiRouter/agentCardRouter
// use above at line ~103).
app.use("/ecosystem", ecosystemRouter);
// next-phase.md Phase 3a (architecture-agent.md §3): the first
// genuinely cross-agent surface in this backend — propose/accept/reject
// a channel between two distinct `agents` rows. Behind the same
// shared-secret middleware as every other agent-facing route above,
// same as /departments and /subagents; not public the way
// agentCard.ts/marketplace.ts are, since a proposal/accept/reject is
// always made on behalf of one of this backend's own hosted agents,
// authenticated the same way every other agent-facing route here is
// (the runtime process holding BACKEND_API_KEY, asserting an
// agentAddress in the body) — never a stranger's own backend.
app.use("/channels", channelsRouter);
app.use("/admin", adminRouter);
// next-phase.md Phase 5a (architecture-agent.md §6): root-level process
// spawn/kill. Mounted under /admin so it inherits that prefix's own
// x-admin-key check above — never reachable with an agent's regular
// BACKEND_API_KEY, same reasoning as adminRouter itself.
app.use("/admin/orchestrator", orchestratorRouter);
// next-phase.md Phase 9e-ii (architecture-agent.md §4h's closing
// paragraph): the one-time platform provisioning call for the shared
// marketplace's own subdomain. Mounted under /admin, same reasoning as
// orchestratorRouter immediately above — this is a platform-operator
// action, not a per-Agent one, so it inherits /admin's x-admin-key
// check rather than the regular per-Agent BACKEND_API_KEY every
// /departments/... route (including domainRoutesRouter above) checks.
app.use("/admin", domainAdminRouter);
// This session's additions:
//  - rootKillRoutes: admin-only freeze/shutdown for ANY agent including
//    root, extending the existing expansionKillSwitch.ts (children-only)
//    coverage. Mounted under /admin/control so it inherits the same
//    x-admin-key check as orchestratorRouter above — never reachable
//    with an agent's own BACKEND_API_KEY.
app.use("/admin/control", rootKillRoutes);
//  - eventsAdminRoute / weeklyReportRoutes: read-only, admin-key-gated
//    surfaces the Telegram notifier bot polls (ecosystem event digest,
//    pending weekly report PDFs) — same tier as rootKillRoutes, for the
//    same reason: this is operator tooling, not agent-facing.
app.use("/admin/control", eventsAdminRoute);
app.use("/admin/control/reports", weeklyReportRoutes);
//  - controlStatusRoute: the OTHER side of rootKillRoutes — an agent
//    polling whether IT has a pending shutdown request. Deliberately
//    NOT under /admin: this is the agent checking on itself with its
//    own regular BACKEND_API_KEY, the same auth tier as /wallet or
//    /vm/exec above, never the admin key.
app.use("/control", controlStatusRoute);
app.use("/events", eventReportRoute);

app.listen(config.port, async () => {
  console.log(`automaton-backend listening on :${config.port}`);
  console.log(`network: ${config.chainNetwork}, model: ${config.openrouterModel}`);
  console.log(`public base url (for exposed ports): ${config.publicBaseUrl}`);
  startGithubSync();
  try {
    await ensureSandboxContainer();
    console.log("sandbox container ready");
  } catch (err: any) {
    console.error("FAILED to start sandbox container:", err.message);
    console.error("Did you build the image? see sandbox/Dockerfile");
  }
});
