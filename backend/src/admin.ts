import express from "express";
import Docker from "dockerode";
import { db } from "./db.js";
import { config } from "./config.js";

const router = express.Router();
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

/**
 * GET /admin/status
 * One-shot operational snapshot: spend today, per-agent budget usage
 * against your configured caps, recent exec/payment failures, and
 * sandbox container health. Everything here is read from data the
 * other routers already log — this adds no new tracking, just surfaces it.
 */
router.get("/status", async (_req, res) => {
  const since24h = Date.now() - 24 * 3_600_000;

  // --- Spend today, broken down by service ---
  const spendByService = db
    .prepare(
      `SELECT service, COUNT(*) AS calls, COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) AS total_usdc
       FROM usage_log
       WHERE created_at >= ?
       GROUP BY service`,
    )
    .all(since24h);

  // --- Per-agent inference spend vs their daily cap ---
  const inferenceByAgent = db
    .prepare(
      `SELECT agent_address, COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) AS spent_usdc
       FROM usage_log
       WHERE service = 'inference' AND created_at >= ?
       GROUP BY agent_address
       ORDER BY spent_usdc DESC`,
    )
    .all(since24h) as { agent_address: string; spent_usdc: number }[];

  const agentBudgets = inferenceByAgent.map((row) => ({
    agentAddress: row.agent_address,
    spentUsdc: Number(row.spent_usdc.toFixed(6)),
    dailyCapUsdc: config.maxInferenceSpendUsdcPerAgentPerDay,
    percentOfCap: Math.min(
      100,
      Math.round((row.spent_usdc / config.maxInferenceSpendUsdcPerAgentPerDay) * 100),
    ),
  }));

  // --- Recent exec activity: failures and timeouts worth a human's attention ---
  const recentExecFailures = db
    .prepare(
      `SELECT agent_address, command, args, exit_code, timed_out, seconds, created_at
       FROM exec_log
       WHERE timed_out = 1 OR exit_code != 0
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all();

  const execTotals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN timed_out = 1 THEN 1 ELSE 0 END) AS timeouts,
              SUM(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END) AS non_zero_exits
       FROM exec_log
       WHERE created_at >= ?`,
    )
    .get(since24h);

  // --- Payments: anything that failed to settle needs a human look ---
  const recentPaymentFailures = db
    .prepare(
      `SELECT id, from_address, to_address, value_usdc, purpose, created_at
       FROM payments
       WHERE status = 'failed'
       ORDER BY created_at DESC
       LIMIT 20`,
    )
    .all();

  const paymentTotals = db
    .prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(CAST(value_usdc AS REAL)), 0) AS total_usdc
       FROM payments
       WHERE created_at >= ?
       GROUP BY status`,
    )
    .all(since24h);

  // --- Sandbox container health ---
  let sandboxHealth: Record<string, unknown> = { reachable: false };
  try {
    const container = docker.getContainer("automaton-sandbox");
    const info = await container.inspect();
    const stats = await container.stats({ stream: false });
    sandboxHealth = {
      reachable: true,
      running: info.State.Running,
      startedAt: info.State.StartedAt,
      memoryUsageMb: Math.round((stats.memory_stats.usage ?? 0) / 1024 / 1024),
      memoryLimitMb: Math.round((stats.memory_stats.limit ?? 0) / 1024 / 1024),
    };
  } catch (err: any) {
    sandboxHealth = { reachable: false, error: err.message };
  }

  // --- Agent roster ---
  const agentCount = db.prepare(`SELECT COUNT(*) AS n FROM agents`).get() as { n: number };

  res.json({
    generatedAt: new Date().toISOString(),
    window: "24h",
    agents: { total: agentCount.n },
    spendByService,
    inferenceBudgets: agentBudgets,
    exec: { totals: execTotals, recentFailures: recentExecFailures },
    payments: { totals: paymentTotals, recentFailures: recentPaymentFailures },
    sandbox: sandboxHealth,
  });
});

export default router;
