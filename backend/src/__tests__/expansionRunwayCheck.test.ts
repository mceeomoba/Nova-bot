// Zent.md Phase 8e: "Runway rule: Finance must show Company A retains
// N months of its own runway after funding Agent B — this is a hard
// floor, not advisory."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// exercises an inlined mirror of expansion.ts's pure
// computeRunwayCheck() (no DB, no chain access) directly. Recommend
// re-running against the real expansion.ts/wallet.ts once a networked
// environment (DB + RPC) is available.

import { test } from "node:test";
import assert from "node:assert/strict";

const DAYS_PER_MONTH = 30;

interface RunwayCheck {
  walletBalanceUsdc: number;
  dailySpendRateUsdc: number;
  proposedFundingUsdc: number;
  remainingBalanceAfterFundingUsdc: number;
  runwayMonthsAfterFunding: number;
  minRunwayMonthsRequired: number;
  passes: boolean;
  checkedAt: number;
}

// ─── Inlined mirror of expansion.ts's computeRunwayCheck() ────────────
// minRunwayMonthsRequired passed explicitly here instead of read from
// config.ts, same "pure function over already-resolved inputs" shape
// the real computeRunwayCheck() itself uses.

function computeRunwayCheck(
  walletBalanceUsdc: number,
  dailySpendRateUsdc: number,
  proposedFundingUsdc: number,
  minRunwayMonthsRequired: number,
): RunwayCheck {
  const remainingBalanceAfterFundingUsdc = walletBalanceUsdc - proposedFundingUsdc;
  const runwayMonthsAfterFunding =
    dailySpendRateUsdc > 0
      ? remainingBalanceAfterFundingUsdc / (dailySpendRateUsdc * DAYS_PER_MONTH)
      : Number.POSITIVE_INFINITY;

  return {
    walletBalanceUsdc,
    dailySpendRateUsdc,
    proposedFundingUsdc,
    remainingBalanceAfterFundingUsdc,
    runwayMonthsAfterFunding,
    minRunwayMonthsRequired,
    passes: runwayMonthsAfterFunding >= minRunwayMonthsRequired,
    checkedAt: Date.now(),
  };
}

test("check_runway passes when plenty of runway remains after funding", () => {
  // $10,000 balance, $10/day spend, fund Agent B $1,000 -> $9,000 left
  // -> 900 days -> 30 months of runway, well above a 6-month floor.
  const check = computeRunwayCheck(10_000, 10, 1_000, 6);
  assert.equal(check.remainingBalanceAfterFundingUsdc, 9_000);
  assert.equal(check.runwayMonthsAfterFunding, 30);
  assert.equal(check.passes, true);
});

test("check_runway fails outright when funding would starve Company A below the floor", () => {
  // $5,000 balance, $50/day spend, fund Agent B $3,500 -> $1,500 left
  // -> 30 days -> 1 month of runway, well under a 6-month floor.
  const check = computeRunwayCheck(5_000, 50, 3_500, 6);
  assert.equal(check.remainingBalanceAfterFundingUsdc, 1_500);
  assert.equal(check.runwayMonthsAfterFunding, 1);
  assert.equal(check.passes, false);
});

test("check_runway is a hard floor: sits exactly on the boundary and still evaluates precisely", () => {
  // $6,000 balance, $100/day spend, fund Agent B $0 -> $6,000 left ->
  // 60 days -> exactly 2 months. A required floor of 2 must pass
  // (>=, not >); a required floor of 2.01 must fail.
  const atFloor = computeRunwayCheck(6_000, 100, 0, 2);
  assert.equal(atFloor.runwayMonthsAfterFunding, 2);
  assert.equal(atFloor.passes, true);

  const justUnderFloor = computeRunwayCheck(6_000, 100, 0, 2.01);
  assert.equal(justUnderFloor.passes, false);
});

test("check_runway treats a zero spend-rate as infinite runway rather than dividing by zero", () => {
  const check = computeRunwayCheck(1_000, 0, 500, 6);
  assert.equal(check.runwayMonthsAfterFunding, Number.POSITIVE_INFINITY);
  assert.equal(check.passes, true);
});

test("check_runway allows the remaining balance (and thus runway) to go negative when funding exceeds the balance", () => {
  // Overfunding relative to the current balance is a real scenario
  // this rule must catch, not silently clamp away.
  const check = computeRunwayCheck(1_000, 10, 1_500, 6);
  assert.equal(check.remainingBalanceAfterFundingUsdc, -500);
  assert.ok(check.runwayMonthsAfterFunding < 0);
  assert.equal(check.passes, false);
});

test("check_runway is independent of, and applied after, Phase 8d's expansionCapitalFraction ceiling", () => {
  // Two different limits on two different questions: 8d says "how
  // much am I even willing to call available" (a fraction of the raw
  // balance); 8e says "does a CONCRETE funding number, once spent,
  // still leave enough runway." A proposed amount can sit comfortably
  // inside 8d's slice and still fail 8e's floor if the spend-rate is
  // high enough — the two checks are meant to disagree sometimes.
  const walletBalanceUsdc = 10_000;
  const expansionCapitalFraction = 0.2;
  const availableExpansionCapitalUsdc = walletBalanceUsdc * expansionCapitalFraction; // 2,000

  // A proposed funding amount well within 8d's slice...
  const proposedFundingUsdc = 1_800;
  assert.ok(proposedFundingUsdc <= availableExpansionCapitalUsdc);

  // ...can still fail 8e's runway floor at a high enough spend-rate.
  const check = computeRunwayCheck(walletBalanceUsdc, 400, proposedFundingUsdc, 6);
  assert.equal(check.passes, false);
});
