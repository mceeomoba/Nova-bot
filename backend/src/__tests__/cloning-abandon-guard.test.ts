// next-phase.md Phase 4a (architecture-agent.md §5): abandonCloneShell()'s
// guard added alongside POST /wallet/clone-shells/:id/abandon —
// abandoning a shell that claimCloneShellForWallet() has already
// claimed must be rejected rather than silently corrupting a real,
// already-live agent's originating row.
//
// Previously this file inlined a byte-for-byte copy of
// abandonCloneShell() against a plain in-memory array and a fake
// deleteNamedSandbox, citing no network access for `npm install`
// (better-sqlite3/dockerode). The DB half of that no longer holds
// here, so this imports cloning.ts directly against a live temp
// sqlite DB. The Docker half still does — this sandbox has no Docker
// daemon — but both guard clauses below (already-claimed → 409,
// unknown id → silent no-op) return/throw BEFORE abandonCloneShell()
// ever calls deleteNamedSandbox(), so they're fully covered here. Only
// the "ready, unclaimed shell actually gets torn down" happy path
// still needs a real Docker daemon to exercise end-to-end.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDbPath, setTestEnv } from "./liveDb.js";

setTestEnv(freshDbPath("cloning-abandon-guard"));

const { db } = await import("../db.js");
const { abandonCloneShell } = await import("../cloning.js");

function ensureAgent(address: string): void {
  db.prepare(`INSERT OR IGNORE INTO agents (address, name, created_at) VALUES (?, ?, ?)`).run(
    address,
    address,
    Date.now(),
  );
}

function seedShell(opts: {
  id: string;
  status: string;
  claimedAt: number | null;
}): void {
  ensureAgent("0xparent_abandon_guard");
  db.prepare(
    `INSERT INTO clone_shells (id, parent_agent_address, sandbox_id, status, created_at, claimed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.id, "0xparent_abandon_guard", `sbx-${opts.id}`, opts.status, Date.now(), opts.claimedAt);
}

describe("abandonCloneShell(): guard clauses (both return/throw before touching Docker)", () => {
  test("refuses a claimed shell (status='claimed') and leaves it untouched, 409", async () => {
    seedShell({ id: "clone_claimed_1", status: "claimed", claimedAt: 12345 });

    await assert.rejects(
      () => abandonCloneShell("clone_claimed_1"),
      (err: any) => err.status === 409 && /already claimed and cannot be abandoned/.test(err.message),
    );

    const row = db.prepare(`SELECT status, claimed_at FROM clone_shells WHERE id = ?`).get("clone_claimed_1") as {
      status: string;
      claimed_at: number;
    };
    assert.equal(row.status, "claimed");
    assert.equal(row.claimed_at, 12345);
  });

  test("refuses a shell with a non-null claimed_at even if status somehow lags behind (belt-and-suspenders check)", async () => {
    // Exercises the `row.claimed_at !== null` half of the guard's `||`
    // independently of the `status === "claimed"` half — a row that's
    // been claimed but whose status column hasn't been updated to
    // match yet should still be refused.
    seedShell({ id: "clone_claimed_2", status: "ready", claimedAt: 999 });

    await assert.rejects(
      () => abandonCloneShell("clone_claimed_2"),
      (err: any) => err.status === 409,
    );
  });

  test("is a silent no-op for an unknown id — resolves, throws nothing", async () => {
    await assert.doesNotReject(() => abandonCloneShell("clone_does_not_exist_at_all"));
  });
});
