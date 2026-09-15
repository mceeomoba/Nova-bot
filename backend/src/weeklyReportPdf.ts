import PDFDocument from "pdfkit";
import type { WeeklyFinancialSummary } from "./weeklyReport.js";

function fmtUsdc(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Renders a real balance sheet + P&L, not a summary paragraph. Every
 * number on the page traces back to computeWeeklyFinancialSummary()'s
 * output, which itself traces back to real DB rows — nothing here is
 * invented to make the page look fuller. Where the report's own
 * reconciliationDelta is nonzero, that's shown on the page too, not
 * hidden — an agent reporting "I don't fully know where $12 went" is
 * more trustworthy than one whose numbers suspiciously always balance.
 */
export function renderWeeklyReportPdf(summary: WeeklyFinancialSummary): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const name = summary.agentName || short(summary.agentAddress);

    // --- Header ---
    doc.fontSize(18).font("Helvetica-Bold").text(`${name} — Weekly Financial Report`);
    doc.fontSize(10).font("Helvetica").fillColor("#555")
      .text(`${fmtDate(summary.periodStart)} to ${fmtDate(summary.periodEnd)}  ·  ${short(summary.agentAddress)}`);
    doc.fillColor("#000").moveDown(1.2);

    // --- Balance summary box ---
    doc.fontSize(13).font("Helvetica-Bold").text("Balance Summary");
    doc.moveDown(0.3);
    const balanceRows: [string, string][] = [
      ["Opening balance", fmtUsdc(summary.openingBalanceUsdc)],
      ["Closing balance", fmtUsdc(summary.closingBalanceUsdc)],
      ["Net change this period", fmtUsdc(summary.netForPeriodUsdc)],
    ];
    for (const [label, value] of balanceRows) {
      doc.fontSize(11).font("Helvetica").text(label, { continued: true, width: 300 });
      doc.font("Helvetica-Bold").text(value, { align: "right" });
    }
    doc.moveDown(1);

    // --- Income ---
    doc.fontSize(13).font("Helvetica-Bold").text("Income");
    doc.moveDown(0.2);
    doc.fontSize(11).font("Helvetica").text(`Total: ${fmtUsdc(summary.income.totalUsdc)}`);
    doc.moveDown(0.3);
    if (summary.income.fromPayments.length === 0) {
      doc.fontSize(9).fillColor("#888").text("No incoming payments this period.").fillColor("#000");
    } else {
      for (const p of summary.income.fromPayments) {
        doc.fontSize(9).font("Helvetica")
          .text(`${fmtDate(p.createdAt)}  ${fmtUsdc(p.amountUsdc)}  from ${short(p.fromAddress)}  ${p.purpose ? `(${p.purpose})` : ""}`);
      }
    }
    doc.moveDown(1);

    // --- Expenses ---
    doc.fontSize(13).font("Helvetica-Bold").text("Expenses");
    doc.moveDown(0.2);
    doc.fontSize(11).font("Helvetica").text(`Total: ${fmtUsdc(summary.expenses.totalUsdc)}`);
    doc.fontSize(9).font("Helvetica")
      .text(`  Inference compute: ${fmtUsdc(summary.expenses.inferenceCostUsdc)}`)
      .text(`  VM/sandbox time: ${fmtUsdc(summary.expenses.vmTimeCostUsdc)}`);
    doc.moveDown(0.3);
    if (summary.expenses.outgoingPayments.length > 0) {
      doc.fontSize(10).font("Helvetica-Bold").text("Outgoing payments:");
      for (const p of summary.expenses.outgoingPayments) {
        doc.fontSize(9).font("Helvetica")
          .text(`${fmtDate(p.createdAt)}  ${fmtUsdc(p.amountUsdc)}  to ${short(p.toAddress)}  ${p.purpose ? `(${p.purpose})` : ""}`);
      }
    }
    if (summary.expenses.departmentSpend.length > 0) {
      doc.moveDown(0.2);
      doc.fontSize(10).font("Helvetica-Bold").text("Department spend:");
      for (const d of summary.expenses.departmentSpend) {
        doc.fontSize(9).font("Helvetica")
          .text(`${fmtDate(d.createdAt)}  ${fmtUsdc(d.amountUsdc)}  ${d.departmentId} → ${short(d.toAddress)}  ${d.purpose ? `(${d.purpose})` : ""}`);
      }
    }
    doc.moveDown(1);

    // --- Reconciliation note — shown always, not just when nonzero, so its absence is itself meaningful ---
    doc.fontSize(9).fillColor(summary.reconciliationDeltaUsdc === 0 ? "#888" : "#b00")
      .text(
        summary.reconciliationDeltaUsdc === 0
          ? "Reconciliation: opening + net change = closing balance exactly. No unexplained movement."
          : `Reconciliation gap: ${fmtUsdc(summary.reconciliationDeltaUsdc)} of balance change this period is not accounted for by the categories above.`,
      );
    doc.fillColor("#000");

    doc.end();
  });
}
