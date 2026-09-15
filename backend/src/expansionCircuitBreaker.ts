import { db } from "./db.js";
import { config } from "./config.js";
import { isEligibleForExpansion, demoteToDryRunOnly } from "./expansion.js";

/**
 * Zent.md Phase 19a/19c, pulled forward to land before Phase 17e-i wires
 * the first real tick.
 *
 * 19a: "Global expansion rate limit per root agent: max N companies
 * spawned per time window, independent of how many opportunities clear
 * the ROI floor — prevents runaway compounding."
 *
 * 19c: "Circuit breaker: if any pipeline-spawned Agent B fails its
 * first-tick smoke test (17e-ii-iv) or violates its constitution within
 * its first N ticks, the pipeline auto-halts new genesis events for
 * that root agent and logs the failure."
 *
 * The rate-limit half of 19a and the halt/resume mechanics of 19c are
 * built here (`haltExpansionPipeline()` / `resumeExpansionPipeline()` /
 * `getHaltedState()`, all below). Both of 19c's documented triggers —
 * "fails its first-tick smoke test (17e-ii-iv)" and "violates its
 * constitution within its first N ticks" — are now wired to call
 * `haltExpansionPipeline()`, from genesis.ts's `genesisExecutorAdapter()`
 * (TickSmokeTestFailure and ConstitutionComplianceFailure respectively;
 * see that function's own header). This file does not add anything
 * resembling a human approval step: every check below is read by
 * genesis.ts itself, before it acts, the same way it already reads
 * trigger/decision state — there is no operator in this path, only
 * whether the agent hierarchy's own prior spawns and failures earn it
 * the next one.
 *
 * 19b: "Total-portfolio spend cap: sum of all pipeline-spawned siblings'
 * funding cannot exceed a configured fraction of the root's lifetime
 * revenue." Built below, alongside 19a/19c. The earlier header note on
 * this file (see prior revisions) said lifetime revenue "needs
 * distribution.ts's own accounting" — that was wrong: distribution.ts
 * is Economy 2 (publishing a listing to a human-facing channel), not
 * payments. The real lifetime-revenue figure already exists as
 * isEligibleForExpansion()'s revenueUsdc (expansion.ts, Phase 2e) — sum
 * of settled payments.value_usdc where to_address = rootAgentAddress,
 * all-time. Reused here rather than duplicated.
 */

const MAX_GENESIS_SPAWNS_PER_WINDOW = 3;
const GENESIS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h, matches spawn_clone's own daily-cap convention (genesis.ts todayUtc()-scoped funding caps)

export interface CircuitBreakerCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * 19a — call at the very top of genesisCompany(), before createCloneShell(),
 * same "fail before anything is provisioned" posture genesis.ts already
 * uses for its trigger/decision/opportunity guards.
 */
export function checkGenesisSpawnCapacity(rootAgentAddress: string): CircuitBreakerCheck {
  const halted = getHaltedState(rootAgentAddress);
  if (halted) {
    return {
      allowed: false,
      reason: `expansion pipeline is halted for ${rootAgentAddress}: ${halted.reason} (halted_at=${halted.haltedAt})`,
    };
  }

  // No separate company_lineage table exists (db.ts Phase 1e's own
  // comment: "the `agents` table IS the lineage record") — spawn_reason
  // and opportunity_id (1e) live on `agents` alongside parent_address,
  // same table tagCompanyLineage() (genesis.ts) writes to.
  const windowStart = Date.now() - GENESIS_WINDOW_MS;
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM agents
       WHERE parent_address = ? AND spawn_reason = 'expansion_pipeline' AND created_at >= ?`,
    )
    .get(rootAgentAddress, windowStart) as { n: number } | undefined;
  const spawnedInWindow = row?.n ?? 0;

  if (spawnedInWindow >= MAX_GENESIS_SPAWNS_PER_WINDOW) {
    return {
      allowed: false,
      reason:
        `root agent ${rootAgentAddress} has already spawned ${spawnedInWindow} ` +
        `expansion-pipeline companies in the last ${GENESIS_WINDOW_MS / 3_600_000}h ` +
        `(cap ${MAX_GENESIS_SPAWNS_PER_WINDOW}) — this cycle's Opportunity Intelligence ` +
        `pass can re-evaluate once the window rolls, per Zent.md 19a`,
    };
  }

  return { allowed: true };
}

/**
 * 19b — sum of every clone-funding disbursement this root agent has
 * ever sent to a pipeline-spawned sibling (Zent.md 16b's
 * fundGenesisCompany() in genesis.ts, the only place `purpose =
 * 'clone-funding'` payments are ever created — see that file's own
 * comment on the constant). All-time, not a rolling window: 19b's own
 * wording is "total-portfolio," the same all-time posture
 * isEligibleForExpansion() (2e) already uses for revenueUsdc, for the
 * identical reason — a portfolio-wide backstop that resets on a rolling
 * window would let an agent simply wait out the window rather than
 * genuinely staying under the cap.
 *
 * 'pending' statuses count alongside 'settled', same as
 * cloneFundingDisbursedTodayUsdc() in genesis.ts — an authorized
 * transfer that hasn't cleared yet is still capital this root agent has
 * committed to spend, not capital still available to commit again.
 */
export function getTotalPipelineFundingDisbursedUsdc(rootAgentAddress: string): number {
  const rows = db
    .prepare(
      `SELECT value_usdc FROM payments
       WHERE from_address = ? AND purpose = 'clone-funding' AND status IN ('pending', 'settled')`,
    )
    .all(rootAgentAddress) as { value_usdc: string }[];
  return rows.reduce((sum, row) => sum + Number(row.value_usdc) / 1_000_000, 0);
}

export interface PortfolioSpendCapCheck {
  allowed: boolean;
  reason?: string;
  capUsdc: number;
  disbursedUsdc: number;
  revenueUsdc: number;
}

/**
 * 19b — call alongside 19a at the top of genesisCompany(), before
 * createCloneShell() does anything real. Blocks a new genesis event
 * outright once the root's total lifetime pipeline funding has already
 * reached its cap, independent of what this specific opportunity's
 * Finance sizing recommendation is — that number-specific clamp is
 * checkPortfolioFundingRoom() below, applied at disbursement time
 * (16b), same two-checkpoint shape 9b/16b already use for the per-call
 * and per-day caps (a recommendation-time chokepoint and a separate
 * disbursement-time one, same numbers).
 *
 * A root agent with zero lifetime revenue (revenueUsdc === 0) has a
 * cap of $0 — this is correct, not a bug: isEligibleForExpansion() (2e)
 * already prevents a department from spawning at all without a
 * demonstrated profit, so a root reaching this check with $0 lifetime
 * revenue would mean that gate was bypassed. checkGenesisSpawnCapacity()
 * (19a) does not depend on 2e's gate remaining true for the life of the
 * agent, so this function doesn't assume it either — it just computes
 * the honest number.
 */
export function checkPortfolioSpendCapacity(rootAgentAddress: string): PortfolioSpendCapCheck {
  const { revenueUsdc } = isEligibleForExpansion(rootAgentAddress);
  const capUsdc = revenueUsdc * config.portfolioSpendCapFraction;
  const disbursedUsdc = getTotalPipelineFundingDisbursedUsdc(rootAgentAddress);

  if (disbursedUsdc >= capUsdc) {
    return {
      allowed: false,
      reason:
        `root agent ${rootAgentAddress} has already disbursed $${disbursedUsdc.toFixed(2)} ` +
        `to pipeline-spawned siblings, at or above its portfolio cap of $${capUsdc.toFixed(2)} ` +
        `(${config.portfolioSpendCapFraction * 100}% of lifetime settled revenue of ` +
        `$${revenueUsdc.toFixed(2)}) — no further genesis funding until lifetime revenue grows, ` +
        `per Zent.md 19b`,
      capUsdc,
      disbursedUsdc,
      revenueUsdc,
    };
  }

  return { allowed: true, capUsdc, disbursedUsdc, revenueUsdc };
}

/**
 * 19b, disbursement-time half — the room actually left under the
 * portfolio cap, for fundGenesisCompany() (genesis.ts, 16b) to clamp
 * against as a third ceiling alongside its existing per-call
 * (maxCloneFundingUsdcPerCall) and per-day (maxCloneFundingUsdcPerAgentPerDay)
 * clamps. Returns 0 (never negative) once disbursedUsdc has met or
 * passed capUsdc, same "clamp to what's left, don't error" posture
 * 16b's own day-cap clamp already uses.
 */
export function checkPortfolioFundingRoom(rootAgentAddress: string): number {
  const { capUsdc, disbursedUsdc } = checkPortfolioSpendCapacity(rootAgentAddress);
  return Math.max(0, capUsdc - disbursedUsdc);
}

/**
 * 19c. Called from genesis.ts's genesisExecutorAdapter() on both of
 * 19c's documented triggers: a spawned Agent B failing its first-tick
 * smoke test (TickSmokeTestFailure, 17e-ii) or violating its
 * constitution within its first tick (ConstitutionComplianceFailure,
 * 17e-iii) — see that function's own header for the exact wiring.
 * Idempotent/upsert (ON CONFLICT below): a root already halted for one
 * trigger that then hits the other just updates the reason/timestamp
 * rather than erroring or stacking a second row.
 */
export function haltExpansionPipeline(rootAgentAddress: string, reason: string): void {
  db.prepare(
    `INSERT INTO expansion_circuit_breaker (root_agent_address, reason, halted_at)
     VALUES (?, ?, ?)
     ON CONFLICT(root_agent_address) DO UPDATE SET reason = excluded.reason, halted_at = excluded.halted_at`,
  ).run(rootAgentAddress, reason, Date.now());
  // Phase 20d defense-in-depth: a halt after graduation doesn't just
  // pause new spawns, it also revokes the live-genesis privilege — see
  // demoteToDryRunOnly()'s own header (expansion.ts) for the full
  // reasoning. No-op if the root was never graduated in the first
  // place (the common case).
  demoteToDryRunOnly(rootAgentAddress, `19c circuit breaker tripped: ${reason}`);
}

/**
 * Resume path — deliberately not exposed as an HTTP route in this
 * phase. Per Zent.md 19c, resumption is "the root agent's own next
 * Opportunity Intelligence cycle," i.e. called from wherever that cycle
 * lives (Phase 3's scheduler job), not from an operator-facing endpoint.
 */
export function resumeExpansionPipeline(rootAgentAddress: string): void {
  db.prepare(`DELETE FROM expansion_circuit_breaker WHERE root_agent_address = ?`).run(rootAgentAddress);
}

function getHaltedState(
  rootAgentAddress: string,
): { reason: string; haltedAt: number } | undefined {
  return db
    .prepare(
      `SELECT reason, halted_at as haltedAt FROM expansion_circuit_breaker WHERE root_agent_address = ?`,
    )
    .get(rootAgentAddress) as { reason: string; haltedAt: number } | undefined;
}

/**
 * Idempotent, safe to call every startup — mirrors index.ts's own
 * initInfraSchema() convention rather than requiring a separate
 * migration step for this pulled-forward table.
 */
export function ensureExpansionCircuitBreakerSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS expansion_circuit_breaker (
      root_agent_address TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      halted_at INTEGER NOT NULL
    )
  `);
}
