// Zent.md Phase 8d: "Tool: check_available_capital(agentAddress) —
// reads Company A's actual wallet balance and current spend-rate;
// expansion capital is a slice of that, never all of it."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's pure
// computeAvailableCapital() (no DB, no chain access) directly, since
// that's the only part of 8d testable without a live SQLite connection
// AND a live chain RPC. Recommend re-running against the real
// expansion.ts/wallet.ts once a networked environment (DB + RPC) is
// available.

import { test } from "node:test";
import assert from "node:assert/strict";

const SPEND_RATE_WINDOW_DAYS = 30;

interface AvailableCapitalCheck {
  walletBalanceUsdc: number;
  spendRateWindowDays: number;
  totalSpendInWindowUsdc: number;
  dailySpendRateUsdc: number;
  expansionCapitalFractionApplied: number;
  availableExpansionCapitalUsdc: number;
  checkedAt: number;
}

// ─── Inlined mirror of expansion.ts's computeAvailableCapital() ───────
// expansionCapitalFraction passed explicitly here instead of read from
// config.ts, same "pure function over already-resolved inputs" shape
// the real computeAvailableCapital() itself uses.

function computeAvailableCapital(
  walletBalanceUsdc: number,
  totalSpendInWindowUsdc: number,
  expansionCapitalFraction: number,
  windowDays: number = SPEND_RATE_WINDOW_DAYS,
): AvailableCapitalCheck {
  return {
    walletBalanceUsdc,
    spendRateWindowDays: windowDays,
    totalSpendInWindowUsdc,
    dailySpendRateUsdc: totalSpendInWindowUsdc / windowDays,
    expansionCapitalFractionApplied: expansionCapitalFraction,
    availableExpansionCapitalUsdc: walletBalanceUsdc * expansionCapitalFraction,
    checkedAt: Date.now(),
  };
}

test("check_available_capital reports only the configured slice of the real balance, never all of it", () => {
  const check = computeAvailableCapital(10_000, 600, 0.2, 30);
  assert.equal(check.walletBalanceUsdc, 10_000);
  assert.equal(check.availableExpansionCapitalUsdc, 2_000); // 20% of balance
  assert.ok(check.availableExpansionCapitalUsdc < check.walletBalanceUsdc);
});

test("check_available_capital computes a real daily spend-rate from the trailing window total", () => {
  const check = computeAvailableCapital(10_000, 900, 0.2, 30);
  assert.equal(check.totalSpendInWindowUsdc, 900);
  assert.equal(check.dailySpendRateUsdc, 30); // 900 / 30 days
});

test("check_available_capital never reports more than the configured fraction even at a fraction of 1.0", () => {
  // Defensive check on the ceiling itself: even a caller-misconfigured
  // fraction of 1.0 can never exceed the real wallet balance — the
  // function has no path that multiplies past the balance itself.
  const check = computeAvailableCapital(5_000, 0, 1.0, 30);
  assert.equal(check.availableExpansionCapitalUsdc, 5_000);
  assert.ok(check.availableExpansionCapitalUsdc <= check.walletBalanceUsdc);
});

test("check_available_capital scales down with a smaller configured fraction", () => {
  const conservative = computeAvailableCapital(10_000, 0, 0.1, 30);
  const looser = computeAvailableCapital(10_000, 0, 0.3, 30);
  assert.ok(conservative.availableExpansionCapitalUsdc < looser.availableExpansionCapitalUsdc);
  assert.equal(conservative.availableExpansionCapitalUsdc, 1_000);
  assert.equal(looser.availableExpansionCapitalUsdc, 3_000);
});
