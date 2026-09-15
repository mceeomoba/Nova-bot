import fs from "fs/promises";
import { db } from "./db.js";
import { config } from "./config.js";
import { agentDir, readManifest, ensureResourceQuota } from "./office.js";
import { getAgentProcessStatus, killAgentProcess, listAgentProcesses } from "./orchestrator.js";

/**
 * next-phase.md Phase 5b (architecture-agent.md §6, The Orchestrator):
 * "Enforce hard resource ceilings per office: disk quota, container
 * CPU/mem, spend-rate cap pulled from wallet.ts/facilitator.ts usage
 * logs — this is what stops one runaway agent (or a bug in one) from
 * starving the VM or draining a shared facilitator wallet."
 *
 * Builds on Phase 5a's orchestrator.ts (spawn/kill authority) rather
 * than duplicating it: this file only ever DECIDES whether an agent is
 * over one of its own manifest.json ceilings, then hands the actual
 * kill off to orchestrator.ts's own killAgentProcess() — same division
 * of labor as departments.ts's routes deciding "is this within quota"
 * and cloning.ts deciding "is this a valid clone," neither of which
 * re-implements its own process/audit primitives either.
 *
 * Five resources, five different measurement strategies, matched to
 * where each one's real signal actually lives in this repo:
 *
 *  - disk: no existing per-agent disk-usage table anywhere in this
 *    repo (sandboxes.disk_gb is an ALLOCATION, i.e. what a sandbox was
 *    created with, not what's actually written) — so this is measured
 *    directly, by walking the agent's own office/ tree on disk. Pure
 *    fs, no docker/db dependency, which also makes it the one check in
 *    this file that's directly unit-testable against a real temp
 *    filesystem (see __tests__/resourceQuotas.test.ts).
 *  - container cpu/mem: measured as the SUM of `sandboxes.vcpu` /
 *    `sandboxes.memory_mb` across every row this agent currently has
 *    in status 'running' — i.e. total *committed* capacity, not live
 *    cgroup usage. Live per-container usage (dockerode's own
 *    container.stats()) would be a strictly better signal, but this
 *    repo's own standing constraint (no docker daemon reachable in
 *    every environment this build track has run in — see orchestrator's
 *    own re-verification notes) means a check that depends on it can't
 *    be verified here at all. Committed capacity is still a real,
 *    already-enforced-at-creation-time ceiling (docker.ts's
 *    createNamedSandbox already sizes each container's own Memory/
 *    NanoCpus from these exact same columns) — this only adds the
 *    cross-sandbox AGGREGATE check createNamedSandbox never had a
 *    reason to make on its own, since it only ever sizes one container
 *    at a time. Swapping in a live dockerode stats sum later is a
 *    strictly additive follow-up, not a rewrite of this decision layer.
 *  - spend-rate: identical rolling-24h-window query
 *    inferenceGateway.ts's own checkInferenceBudget() and
 *    marketplace.ts's own per-request check already run against
 *    usage_log, just re-run here so the ORCHESTRATOR can independently
 *    act on the same number those two request-time gates already read.
 *    Per-request gating (Phase 0/2d) stops an agent from spending PAST
 *    its cap one call at a time; this stops the underlying process from
 *    continuing to run at all once it already has, which matters for a
 *    compromised or badly-prompted agent hammering a free (non-billed)
 *    loop that never trips a spend gate itself but still ties up a
 *    process slot / other resources — belt and suspenders, not a
 *    redundant check.
 *  - opportunity_intelligence ticks (Zent.md Phase 2d): the concrete
 *    case the paragraph above was describing before this resource
 *    existed to name. scan_market_signals/list_customer_complaints/
 *    list_demand_signals (Zent.md 2b/2c) cost nothing in usage_log —
 *    the DuckDuckGo scrape expansionRoutes.ts runs is free — so an
 *    opportunity_intelligence department can loop those tools forever
 *    without ever tripping inference_spend or marketplace_spend above.
 *    opportunity_intelligence_tick_counters (db.ts) is that department
 *    type's own per-day counter, calendar-day scoped like
 *    distribution_rate_counters rather than a rolling window. Same
 *    two-layer split as spend-rate: expansionRoutes.ts's three routes
 *    call hasOpportunityIntelligenceTickCapacity() as a real-time
 *    per-request gate (429 before the scan even runs) and
 *    recordOpportunityIntelligenceTick() after a successful one; this
 *    file's checkResourceQuotas() independently re-reads the same
 *    counter so the sweep can still kill a runaway process even if
 *    something ever bypassed the route-level gate.
 *  - finance ticks (Zent.md Phase 10c): the identical gap, one
 *    department type over. estimate_build_cost through note_sensitivity
 *    (Zent.md 8b-9d) are compute over numbers this backend already has
 *    (a wallet balance read, a usage_log window sum, arithmetic on an
 *    opportunity's own prior findings) — none of it a metered charge
 *    logged to usage_log — so a finance department can re-model the
 *    same opportunity forever without ever tripping inference_spend or
 *    marketplace_spend either. finance_tick_counters (db.ts) is that
 *    department type's own per-day counter, same shape and same
 *    two-layer split (hasFinanceTickCapacity()/recordFinanceTick() in
 *    expansionRoutes.ts, re-checked here) as opportunity_intelligence's
 *    own — a separate counter and a separate (lower) daily cap, not a
 *    shared budget with OI, since these are two different department
 *    types doing two different amounts of normal, expected work.
 */

export type QuotaResource =
  | "disk"
  | "container_cpu"
  | "container_memory"
  | "inference_spend"
  | "marketplace_spend"
  | "opportunity_intelligence_ticks"
  | "finance_ticks";

export interface QuotaViolation {
  resource: QuotaResource;
  limit: number;
  actual: number;
}

export interface QuotaCheckResult {
  ok: boolean;
  violations: QuotaViolation[];
}

/**
 * Recursively sums file sizes under an agent's own office tree
 * (agentDir — office/{fs,private}, browser/, manifest.json, config/ —
 * everything that counts against ITS disk quota, not just the fs/
 * subtree that gets bind-mounted into its container). Returns null,
 * not 0 or Infinity, on a measurement failure (missing dir, permission
 * error, race with a concurrent delete): disk quota here is an
 * anti-abuse guard, not a security boundary the way capability.ts's
 * tool-registry check is (see toolRegistryClient.ts's own fail-CLOSED
 * design) — an agent whose usage this backend genuinely can't measure
 * right now should be left alone this sweep, not killed for an
 * instrumentation gap that isn't its fault, and not silently treated
 * as "0 bytes used" either (which would mean a quota that can never
 * fire once the underlying directory becomes unreadable for any
 * reason). Callers treat a null return as "skip this resource this
 * pass," same as this file's own checkResourceQuotas() does below.
 */
export async function getDiskUsageMb(agentId: string): Promise<number | null> {
  async function walk(dir: string): Promise<number> {
    let total = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) continue; // never follow — no double-counting, no escaping agentDir
      if (entry.isDirectory()) {
        total += await walk(full);
      } else if (entry.isFile()) {
        const st = await fs.stat(full);
        total += st.size;
      }
    }
    return total;
  }

  try {
    const bytes = await walk(agentDir(agentId));
    return bytes / (1024 * 1024);
  } catch {
    return null;
  }
}

interface ContainerCommitment {
  cpuCores: number;
  memoryMb: number;
}

/** Sum of allocated vcpu/memory_mb across this agent's currently-running
 *  sandboxes (docker.ts's createNamedSandbox is what actually sizes
 *  each one from these same columns). See module doc above for why
 *  this is committed capacity, not live cgroup usage. */
export function getContainerCommitment(agentId: string): ContainerCommitment {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(vcpu), 0) AS cpu, COALESCE(SUM(memory_mb), 0) AS mem
       FROM sandboxes WHERE agent_address = ? AND status = 'running'`,
    )
    .get(agentId) as { cpu: number; mem: number };
  return { cpuCores: row.cpu, memoryMb: row.mem };
}

/** Rolling-window spend for one usage_log `service` value — identical
 *  query shape to inferenceGateway.ts's own checkInferenceBudget(), just
 *  parameterized so this file doesn't fork two near-duplicate copies for
 *  'inference' and 'marketplace'. */
export function getSpendRateUsdc(agentId: string, service: string, windowMs: number): number {
  const since = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) AS total
       FROM usage_log WHERE agent_address = ? AND service = ? AND created_at >= ?`,
    )
    .get(agentId, service, since) as { total: number };
  return row.total;
}

const SPEND_WINDOW_MS = 24 * 3_600_000; // matches inferenceGateway.ts's own rolling window

// ─── Zent.md Phase 2d: opportunity_intelligence ticks/day ─────────────
//
// Own local todayUtc() rather than importing distribution.ts's private
// (unexported) one — same "two independent files, no dependency edge"
// duplication toolRegistry.ts's own header already documents for its
// DEPARTMENT_TYPE_ALIASES copy. If the day format ever changes, both
// copies need the same fix by hand.
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

/** Today's (UTC) opportunity_intelligence tick count for agentId, or a
 *  caller-supplied day for tests / the sweep. Reads
 *  opportunity_intelligence_tick_counters (db.ts, Phase 2d) — 0 for an
 *  agent/day with no row yet, same "absence means zero, not unknown"
 *  posture distribution.ts's own daily-rate check already takes for
 *  distribution_rate_counters. */
export function getOpportunityIntelligenceTickCount(
  agentId: string,
  day: string = todayUtc(),
): number {
  const row = db
    .prepare(
      `SELECT count FROM opportunity_intelligence_tick_counters WHERE agent_address = ? AND day = ?`,
    )
    .get(agentId, day) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Real-time, per-request gate: does agentId have room for one more
 * opportunity_intelligence tick today, checked BEFORE the tool call it
 * would cover actually runs. expansionRoutes.ts's three signal-
 * collection routes (2b/2c) call this first — cheapest-rejection-first,
 * same ordering distribution.ts's own POST /publish documents for its
 * daily rate cap — and only call recordOpportunityIntelligenceTick()
 * below once the scan has actually completed successfully. This
 * function never mutates the counter itself, so calling it to merely
 * check capacity (without following through) is always safe.
 */
export function hasOpportunityIntelligenceTickCapacity(agentId: string): boolean {
  return (
    getOpportunityIntelligenceTickCount(agentId) <
    config.maxOpportunityIntelligenceTicksPerAgentPerDay
  );
}

/**
 * Atomically increments today's opportunity_intelligence tick counter
 * for agentId and returns the post-increment count. Same day-scoped
 * UPSERT shape as distribution.ts's own distribution_rate_counters
 * increment (ON CONFLICT...DO UPDATE SET count = count + 1) — called
 * only after a tool call actually completes (a 502 search failure never
 * increments), matching that same "count what happened, not what was
 * attempted" convention.
 */
export function recordOpportunityIntelligenceTick(
  agentId: string,
  day: string = todayUtc(),
): number {
  db.prepare(
    `INSERT INTO opportunity_intelligence_tick_counters (agent_address, day, count)
     VALUES (?, ?, 1)
     ON CONFLICT(agent_address, day) DO UPDATE SET count = count + 1`,
  ).run(agentId, day);
  return getOpportunityIntelligenceTickCount(agentId, day);
}

// ─── Phase 10c: Finance's own ticks-per-day cap ───────────────────────
//
// Zent.md 10c: "Reuse resourceQuotas.ts patterns for Finance
// department's own spend cap — modeling other companies' costs must
// stay cheap." Exactly the opportunity_intelligence trio above,
// mirrored for the `finance` department type — see
// finance_tick_counters' own db.ts header for why this needs a
// separate counter/cap rather than sharing the OI one, and
// config.ts's maxFinanceTicksPerAgentPerDay for why the daily number
// itself differs.

/** Today's (UTC) finance tick count for agentId, or a caller-supplied
 *  day for tests / the sweep. Reads finance_tick_counters (db.ts,
 *  Phase 10c) — 0 for an agent/day with no row yet, same "absence
 *  means zero, not unknown" posture getOpportunityIntelligenceTickCount()
 *  already takes. */
export function getFinanceTickCount(agentId: string, day: string = todayUtc()): number {
  const row = db
    .prepare(`SELECT count FROM finance_tick_counters WHERE agent_address = ? AND day = ?`)
    .get(agentId, day) as { count: number } | undefined;
  return row?.count ?? 0;
}

/**
 * Real-time, per-request gate: does agentId have room for one more
 * finance tick today, checked BEFORE the tool call it would cover
 * actually runs. expansionRoutes.ts's Phase 8/9 modeling routes
 * (estimate-build-cost through note-sensitivity) call this first,
 * same cheapest-rejection-first ordering
 * hasOpportunityIntelligenceTickCapacity() already established, and
 * only call recordFinanceTick() below once their own tool call has
 * actually completed successfully. Never mutates the counter itself,
 * so calling it to merely check capacity is always safe.
 */
export function hasFinanceTickCapacity(agentId: string): boolean {
  return getFinanceTickCount(agentId) < config.maxFinanceTicksPerAgentPerDay;
}

/**
 * Atomically increments today's finance tick counter for agentId and
 * returns the post-increment count. Same day-scoped UPSERT shape as
 * recordOpportunityIntelligenceTick() above — called only after a
 * tool call actually completes (a failed on-chain balance read in
 * check-available-capital/check-runway never increments), matching
 * that same "count what happened, not what was attempted" convention.
 */
export function recordFinanceTick(agentId: string, day: string = todayUtc()): number {
  db.prepare(
    `INSERT INTO finance_tick_counters (agent_address, day, count)
     VALUES (?, ?, 1)
     ON CONFLICT(agent_address, day) DO UPDATE SET count = count + 1`,
  ).run(agentId, day);
  return getFinanceTickCount(agentId, day);
}

/**
 * Compares one agent's real, measured usage against its own
 * manifest.json ceilings (backfilling any still-null Phase 5b field via
 * ensureResourceQuota() first, same as every other quota check in this
 * repo does before reading a manifest number). Read-only — never kills
 * or mutates anything; see enforceResourceQuotas() below for the
 * decide-then-act split.
 */
export async function checkResourceQuotas(agentId: string): Promise<QuotaCheckResult> {
  const resourceQuota = await ensureResourceQuota(agentId);
  const manifest = await readManifest(agentId);
  const violations: QuotaViolation[] = [];

  const diskMb = await getDiskUsageMb(agentId);
  if (diskMb !== null && diskMb > resourceQuota.max_disk_mb) {
    violations.push({ resource: "disk", limit: resourceQuota.max_disk_mb, actual: diskMb });
  }

  const commitment = getContainerCommitment(agentId);
  if (commitment.cpuCores > resourceQuota.max_container_cpu_cores) {
    violations.push({
      resource: "container_cpu",
      limit: resourceQuota.max_container_cpu_cores,
      actual: commitment.cpuCores,
    });
  }
  if (commitment.memoryMb > resourceQuota.max_container_memory_mb) {
    violations.push({
      resource: "container_memory",
      limit: resourceQuota.max_container_memory_mb,
      actual: commitment.memoryMb,
    });
  }

  // Spend-rate caps live on the manifest fields Phase 0 already created
  // (see office.ts's AgentManifest doc for why Phase 5b doesn't add new
  // ones for these two) — manifest is only ever null if ensureOffice()
  // itself has never run for this agentId, which ensureResourceQuota()
  // above already guarantees isn't the case by the time we're here.
  const inferenceSpend = getSpendRateUsdc(agentId, "inference", SPEND_WINDOW_MS);
  if (manifest && inferenceSpend > manifest.quota.max_inference_spend_usdc_per_day) {
    violations.push({
      resource: "inference_spend",
      limit: manifest.quota.max_inference_spend_usdc_per_day,
      actual: inferenceSpend,
    });
  }
  const marketplaceSpend = getSpendRateUsdc(agentId, "marketplace", SPEND_WINDOW_MS);
  if (manifest && marketplaceSpend > manifest.quota.max_marketplace_spend_usdc_per_day) {
    violations.push({
      resource: "marketplace_spend",
      limit: manifest.quota.max_marketplace_spend_usdc_per_day,
      actual: marketplaceSpend,
    });
  }

  // opportunity_intelligence ticks/day (Zent.md Phase 2d) — belt-and-
  // suspenders re-check of the same counter expansionRoutes.ts's
  // real-time gate already reads; see this file's module doc for why a
  // free (non-billed) tool needs this second layer the spend-rate
  // checks above don't. Global config cap, not a per-agent manifest
  // field: this is a department-TYPE policy, same "curated globally,
  // not agent-negotiated" posture maxDistributionPublishesPerAgentPerDay
  // already has in config.ts, unlike max_disk_mb/max_*_spend_usdc_per_day
  // above which genuinely are per-agent manifest values.
  const oiTicks = getOpportunityIntelligenceTickCount(agentId);
  if (oiTicks > config.maxOpportunityIntelligenceTicksPerAgentPerDay) {
    violations.push({
      resource: "opportunity_intelligence_ticks",
      limit: config.maxOpportunityIntelligenceTicksPerAgentPerDay,
      actual: oiTicks,
    });
  }

  // finance ticks/day (Zent.md Phase 10c) — same belt-and-suspenders
  // re-check of finance_tick_counters as the OI block just above; see
  // this file's own Phase 10c section header for why finance needs the
  // identical second layer a free (non-billed) modeling tool call
  // doesn't get from the spend-rate checks earlier in this function.
  const financeTicks = getFinanceTickCount(agentId);
  if (financeTicks > config.maxFinanceTicksPerAgentPerDay) {
    violations.push({
      resource: "finance_ticks",
      limit: config.maxFinanceTicksPerAgentPerDay,
      actual: financeTicks,
    });
  }

  return { ok: violations.length === 0, violations };
}

export type EnforcementResult =
  | { enforced: true; violations: QuotaViolation[]; killResult: ReturnType<typeof killAgentProcess> }
  | { enforced: false; violations: QuotaViolation[]; note: string };

/**
 * Decide (checkResourceQuotas) then act: an agent over any one of its
 * own ceilings gets SIGTERM'd via orchestrator.ts's own killAgentProcess
 * — never SIGKILL on the first pass, same graceful-shutdown-first
 * posture killAgentProcess's own default already encodes, so an agent
 * mid-write to its own workspace gets a chance to flush before the
 * process actually dies. A second sweep 60s later (see setInterval
 * below) will find it still 'running' and violating if the graceful
 * signal didn't land, at which point it's still just another SIGTERM —
 * escalating to SIGKILL automatically is deliberately NOT done here,
 * left to an operator via orchestratorRoutes.ts's existing
 * POST .../kill {signal: "SIGKILL"}, since blindly auto-escalating a
 * signal is exactly the kind of silent-authority-creep §6's own "use
 * sparingly, log everything" framing warns against.
 *
 * No running process to act on (agent never spawned, already
 * stopped/killed/crashed) is reported, not silently ignored, but is
 * NOT itself an error — a violation with nothing running to kill can
 * still matter to an operator reading manifest.json, e.g. stale disk
 * usage from a stopped agent's own office tree.
 */
export async function enforceResourceQuotas(agentId: string): Promise<EnforcementResult> {
  const { ok, violations } = await checkResourceQuotas(agentId);
  if (ok) return { enforced: false, violations, note: "within all quotas" };

  const status = getAgentProcessStatus(agentId);
  if (!status || status.status !== "running") {
    return { enforced: false, violations, note: "no running process to act on" };
  }

  const reasonCode = `quota-exceeded:${violations.map((v) => v.resource).join(",")}`;
  const killResult = killAgentProcess(agentId, "SIGTERM", `${reasonCode}:SIGTERM`);
  return { enforced: true, violations, killResult };
}

/**
 * Best-effort sweep across every agent this backend currently tracks a
 * 'running' process for — same "one bad agent's failure must never stop
 * the rest of the sweep" posture departments.ts's own
 * sweepExpiredTempWorkers() already established for the TTL stub this
 * mirrors the shape of. Deliberately module-scope setInterval, same
 * 60s cadence, same single-in-process-timer honesty about what this
 * is: "good enough for a single-VM deployment today," not the
 * "resilient to a backend restart, coordinated across instances"
 * scheduler Phase 5d is where the TTL sweep's OWN promotion to that is
 * tracked — a genuinely separate mechanism (resource ceilings, not TTL
 * expiry) with its own interval, per next-phase.md's own reasoning for
 * why 5b/5c/5d/5e/5f are split apart in the first place rather than
 * folded into one diff.
 */
export async function sweepResourceQuotas(): Promise<void> {
  const running = listAgentProcesses().filter((p) => p.status === "running");
  for (const p of running) {
    try {
      await enforceResourceQuotas(p.agent_address);
    } catch {
      // best-effort — one agent's measurement failure must never stop
      // the sweep from checking the rest.
    }
  }
}

setInterval(() => {
  sweepResourceQuotas().catch(() => {});
}, 60_000).unref();
