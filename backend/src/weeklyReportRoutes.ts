import express from "express";
import { db } from "./db.js";
import { computeWeeklyFinancialSummary, listAllAgentAddresses } from "./weeklyReport.js";
import { renderWeeklyReportPdf } from "./weeklyReportPdf.js";
import { emitEvent } from "./ecosystemEvents.js";

/**
 * Mount as: app.use("/admin/control/reports", weeklyReportRoutes)
 * Same x-admin-key tier as rootKillRoutes.ts / eventsAdminRoute.
 */
const router = express.Router();

function ensurePendingReportsTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_reports (
      id TEXT PRIMARY KEY,
      agent_address TEXT NOT NULL,
      agent_name TEXT,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      pdf_base64 TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_pending_reports_undelivered ON pending_reports (delivered, created_at);
  `);
}

/** On-demand: generate one agent's report right now and return the PDF bytes directly. */
router.get("/weekly/:address", async (req, res) => {
  try {
    const summary = await computeWeeklyFinancialSummary(req.params.address);
    const pdf = await renderWeeklyReportPdf(summary);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="weekly-report-${req.params.address}.pdf"`);
    res.send(pdf);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Run this once a week (see scripts/run-weekly-reports.mjs below, or wire
 * it into whatever cron/scheduler already exists on the backend host —
 * this file doesn't assume one). Generates every agent's report and
 * queues it in pending_reports rather than trying to talk to Telegram
 * directly from here: this keeps the backend from needing a Telegram
 * bot token at all, and lets the notifier bot's existing poll loop
 * (same one already pulling from ecosystem_events) pick up documents
 * the same way it already picks up event digests.
 */
export async function generateAllWeeklyReports(): Promise<{ generated: number; failed: { address: string; error: string }[] }> {
  ensurePendingReportsTable();
  const addresses = listAllAgentAddresses();
  const failed: { address: string; error: string }[] = [];
  let generated = 0;

  for (const address of addresses) {
    try {
      const summary = await computeWeeklyFinancialSummary(address);
      const pdf = await renderWeeklyReportPdf(summary);
      db.prepare(
        `INSERT INTO pending_reports (id, agent_address, agent_name, period_start, period_end, pdf_base64, created_at, delivered)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        `${address}-${summary.periodEnd}`,
        address,
        summary.agentName,
        summary.periodStart,
        summary.periodEnd,
        pdf.toString("base64"),
        Date.now(),
      );
      emitEvent({
        agentAddress: address,
        agentName: summary.agentName ?? undefined,
        role: "CEO",
        subRole: "Weekly Accounting",
        eventType: "deal_closed", // closest existing CEO-department event type; add a dedicated "weekly_report" EventType if you want it visually distinct in the digest
        message: `Weekly report ready: net ${summary.netForPeriodUsdc >= 0 ? "+" : ""}$${summary.netForPeriodUsdc.toFixed(2)}, closing balance $${summary.closingBalanceUsdc.toFixed(2)}`,
      });
      generated++;
    } catch (err: any) {
      failed.push({ address, error: err.message });
    }
  }

  return { generated, failed };
}

/** Admin-triggerable version of the above, for testing the pipeline without waiting a week. */
router.post("/weekly/generate-all", async (_req, res) => {
  const result = await generateAllWeeklyReports();
  res.json(result);
});

/** Read-only: notifier bot polls this for undelivered PDFs, same shape as /admin/control/events. */
router.get("/pending", (_req, res) => {
  ensurePendingReportsTable();
  const rows = db
    .prepare(`SELECT id, agent_address, agent_name, period_start, period_end, pdf_base64, created_at
               FROM pending_reports WHERE delivered = 0 ORDER BY created_at ASC LIMIT 20`)
    .all();
  res.json({ reports: rows });
});

router.post("/pending/ack", (req, res) => {
  ensurePendingReportsTable();
  const ids: string[] = req.body?.ids || [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE pending_reports SET delivered = 1 WHERE id IN (${placeholders})`).run(...ids);
  }
  res.json({ ok: true });
});

export default router;

// In backend/src/index.ts:
//   import weeklyReportRoutes from "./weeklyReportRoutes.js";
//   app.use("/admin/control/reports", weeklyReportRoutes);
