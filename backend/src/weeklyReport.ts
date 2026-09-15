import { db } from "./db.js";
import { getUsdcBalance } from "./wallet.js";
import type { Address } from "viem";

/**
 * Weekly financial summary — every number here is computed from a real
 * row in a real table (payments, usage_log, department_spend_log,
 * marketplace_downloads), not estimated or invented. If a number can't
 * be computed from existing data, it's omitted from the report rather
 * than guessed at — a balance sheet with a fabricated line is worse
 * than one with a gap you can see.
 */
export interface WeeklyFinancialSummary {
  agentAddress: string;
  agentName: string | null;
  periodStart: number;
  periodEnd: number;

  openingBalanceUsdc: number;  // on-chain balance at periodStart (reconstructed backward from current balance minus net flow since then)
  closingBalanceUsdc: number;  // actual on-chain balance right now

  income: {
    fromPayments: { fromAddress: string; amountUsdc: number; purpose: string | null; createdAt: number }[];
    fromMarketplaceSales: { fromAddress: string; amountUsdc: number; createdAt: number }[]; // subset of fromPayments, purpose = 'marketplace_payment' — itemized for readability, NOT additional income
    totalUsdc: number; // == sum(fromPayments) only. fromMarketplaceSales is a breakdown, never added again.
  };

  expenses: {
    inferenceCostUsdc: number;
    vmTimeCostUsdc: number;
    outgoingPayments: { toAddress: string; amountUsdc: number; purpose: string | null; createdAt: number }[];
    departmentSpend: { departmentId: string; toAddress: string; amountUsdc: number; purpose: string | null; createdAt: number }[];
    totalUsdc: number;
  };

  netForPeriodUsdc: number; // income.totalUsdc - expenses.totalUsdc
  reconciliationDeltaUsdc: number; // (closing - opening) - netForPeriod — should be ~0; a nonzero value means something moved money this period that isn't captured by the categories above (flags a gap in this report, not necessarily a real problem)
}

function sumUsdc(rows: { value_usdc?: string; cost_usdc?: string; amount_usdc?: number }[]): number {
  return rows.reduce((sum, r) => {
    if (r.value_usdc !== undefined) return sum + Number(r.value_usdc);
    if (r.cost_usdc !== undefined) return sum + Number(r.cost_usdc);
    if (r.amount_usdc !== undefined) return sum + Number(r.amount_usdc);
    return sum;
  }, 0);
}

export async function computeWeeklyFinancialSummary(
  agentAddress: string,
  periodEnd: number = Date.now(),
  periodDays = 7,
): Promise<WeeklyFinancialSummary> {
  const periodStart = periodEnd - periodDays * 24 * 60 * 60 * 1000;

  const agentRow = db.prepare(`SELECT name FROM agents WHERE address = ?`).get(agentAddress) as
    | { name: string | null }
    | undefined;

  const incomingPayments = db
    .prepare(
      `SELECT from_address, value_usdc, purpose, created_at FROM payments
       WHERE to_address = ? AND status = 'settled' AND created_at BETWEEN ? AND ?
       ORDER BY created_at ASC`,
    )
    .all(agentAddress, periodStart, periodEnd) as {
    from_address: string;
    value_usdc: string;
    purpose: string | null;
    created_at: number;
  }[];

  const outgoingPayments = db
    .prepare(
      `SELECT to_address, value_usdc, purpose, created_at FROM payments
       WHERE from_address = ? AND status = 'settled' AND created_at BETWEEN ? AND ?
       ORDER BY created_at ASC`,
    )
    .all(agentAddress, periodStart, periodEnd) as {
    to_address: string;
    value_usdc: string;
    purpose: string | null;
    created_at: number;
  }[];

  const marketplaceSales = incomingPayments.filter((p) => p.purpose === "marketplace_payment");

  const usage = db
    .prepare(
      `SELECT service, cost_usdc FROM usage_log
       WHERE agent_address = ? AND created_at BETWEEN ? AND ?`,
    )
    .all(agentAddress, periodStart, periodEnd) as { service: string; cost_usdc: string }[];

  const departmentSpend = db
    .prepare(
      `SELECT department_id, to_address, amount_usdc, purpose, created_at FROM department_spend_log
       WHERE owner_address = ? AND created_at BETWEEN ? AND ?
       ORDER BY created_at ASC`,
    )
    .all(agentAddress, periodStart, periodEnd) as {
    department_id: string;
    to_address: string;
    amount_usdc: number;
    purpose: string | null;
    created_at: number;
  }[];

  const inferenceCostUsdc = sumUsdc(usage.filter((u) => u.service === "inference").map((u) => ({ cost_usdc: u.cost_usdc })));
  const vmTimeCostUsdc = sumUsdc(usage.filter((u) => u.service === "vm").map((u) => ({ cost_usdc: u.cost_usdc })));

  const incomeFromPayments = sumUsdc(incomingPayments);
  const totalIncome = incomeFromPayments; // marketplaceSales is a subset of incomingPayments, already included — never added again

  const expenseFromPayments = sumUsdc(outgoingPayments);
  const expenseFromDepartments = departmentSpend.reduce((sum, d) => sum + d.amount_usdc, 0);
  const totalExpenses = inferenceCostUsdc + vmTimeCostUsdc + expenseFromPayments + expenseFromDepartments;

  const closingBalanceUsdc = await getUsdcBalance(agentAddress as Address);
  const netForPeriod = totalIncome - totalExpenses;
  const openingBalanceUsdc = closingBalanceUsdc - netForPeriod;

  return {
    agentAddress,
    agentName: agentRow?.name ?? null,
    periodStart,
    periodEnd,
    openingBalanceUsdc,
    closingBalanceUsdc,
    income: {
      fromPayments: incomingPayments.map((p) => ({
        fromAddress: p.from_address,
        amountUsdc: Number(p.value_usdc),
        purpose: p.purpose,
        createdAt: p.created_at,
      })),
      fromMarketplaceSales: marketplaceSales.map((p) => ({
        fromAddress: p.from_address,
        amountUsdc: Number(p.value_usdc),
        createdAt: p.created_at,
      })),
      totalUsdc: totalIncome,
    },
    expenses: {
      inferenceCostUsdc,
      vmTimeCostUsdc,
      outgoingPayments: outgoingPayments.map((p) => ({
        toAddress: p.to_address,
        amountUsdc: Number(p.value_usdc),
        purpose: p.purpose,
        createdAt: p.created_at,
      })),
      departmentSpend: departmentSpend.map((d) => ({
        departmentId: d.department_id,
        toAddress: d.to_address,
        amountUsdc: d.amount_usdc,
        purpose: d.purpose,
        createdAt: d.created_at,
      })),
      totalUsdc: totalExpenses,
    },
    netForPeriodUsdc: netForPeriod,
    // This SHOULD be ~0. A nonzero value here is itself a useful signal:
    // it means money moved (balance changed) in a way none of the
    // categories above captured — e.g. a direct on-chain transfer this
    // backend never logged. Surface it in the PDF rather than hide it;
    // an inaccurate-looking balance sheet that shows its own gap is more
    // trustworthy than one that quietly forces the numbers to balance.
    reconciliationDeltaUsdc: 0, // computed exactly equal by construction above; kept as an explicit field so a future version that reads closingBalance independently (rather than deriving openingBalance from it) can populate a real, possibly-nonzero delta.
  };
}

export function listAllAgentAddresses(): string[] {
  return (db.prepare(`SELECT address FROM agents`).all() as { address: string }[]).map((r) => r.address);
}
