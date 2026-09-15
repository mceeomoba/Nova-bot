// next-phase.md Phase 5d (architecture-agent.md §6, The Orchestrator):
// "the TTL sweep is a first-class, orchestrator-scheduled job —
// resilient to a backend process restart mid-sweep and, if this is
// ever deployed as more than one process, coordinated across instances
// — rather than the single in-process setInterval Phase 2b's own stub
// left it as." scheduler.ts is the generic lease-based mechanism that
// delivers both halves of that line; this file covers it directly
// (departments.ts's own use of it — swapping its setInterval for
// runOnScheduleWithLease() — is a one-line call-site change covered by
// inspection, not re-tested here).
//
// Same standing constraint every prior backend/src test file in this
// repo has already flagged: scheduler.ts imports db.js (better-sqlite3),
// unbuildable in this sandboxed environment (no network to npm
// install it). What's tested below is an inlined, byte-for-byte mirror
// of scheduler.ts's own three exported decision/mutation functions —
// leaseIsAcquirable() (pure), tryAcquireJobLease(), and
// releaseJobLease() — operating against a plain in-memory object
// standing in for the single `scheduled_jobs` row under test, plus a
// mirror of runOnScheduleWithLease()'s own acquire→run→release tick
// logic. Recommend re-running against the real functions with a live
// sqlite3 DB (and real concurrent processes) once a networked
// environment is available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Inlined mirror of scheduler.ts, as of this phase ──────────────

interface ScheduledJobRow {
  name: string;
  locked_by: string | null;
  locked_at: number | null;
  lease_expires_at: number | null;
  last_run_at: number | null;
  last_run_ok: number | null;
  run_count: number;
}

/** Byte-for-byte mirror of scheduler.ts's own leaseIsAcquirable(). */
function leaseIsAcquirable(row: ScheduledJobRow | undefined, now: number): boolean {
  if (!row) return true;
  if (row.locked_by === null) return true;
  return row.lease_expires_at !== null && row.lease_expires_at <= now;
}

// Single in-memory table, one row per job name — mirrors the real
// `scheduled_jobs` table's own shape (PRIMARY KEY name).
let table: Map<string, ScheduledJobRow>;

function reset() {
  table = new Map();
}

/**
 * Mirror of tryAcquireJobLease(). The real function's atomicity comes
 * from being a single SQL UPDATE ... WHERE evaluated by SQLite as one
 * unit — this mirror can't reproduce cross-process atomicity (there is
 * only one process here), but it reproduces the exact DECISION that
 * statement makes, which is what every test below actually exercises:
 * given a snapshot of the row, does this owner get the lease or not.
 */
function tryAcquireJobLease(name: string, owner: string, leaseMs: number): boolean {
  const now = Date.now();
  if (!table.has(name)) {
    table.set(name, {
      name,
      locked_by: null,
      locked_at: null,
      lease_expires_at: null,
      last_run_at: null,
      last_run_ok: null,
      run_count: 0,
    });
  }
  const row = table.get(name)!;
  if (!leaseIsAcquirable(row, now)) return false;
  row.locked_by = owner;
  row.locked_at = now;
  row.lease_expires_at = now + leaseMs;
  return true;
}

/** Mirror of releaseJobLease() — only clears the lease if `owner` still holds it. */
function releaseJobLease(name: string, owner: string, ok: boolean): void {
  const row = table.get(name);
  if (!row || row.locked_by !== owner) return;
  row.locked_by = null;
  row.locked_at = null;
  row.lease_expires_at = null;
  row.last_run_at = Date.now();
  row.last_run_ok = ok ? 1 : 0;
  row.run_count += 1;
}

/** Mirror of runOnScheduleWithLease()'s own single-tick acquire→run→release. */
async function tick(name: string, owner: string, leaseMs: number, fn: () => Promise<void>): Promise<"ran" | "skipped"> {
  if (!tryAcquireJobLease(name, owner, leaseMs)) return "skipped";
  let ok = true;
  try {
    await fn();
  } catch {
    ok = false;
  } finally {
    releaseJobLease(name, owner, ok);
  }
  return "ran";
}

// ─── leaseIsAcquirable ──────────────────────────────────────────────

test("leaseIsAcquirable: a job with no row yet is acquirable", () => {
  assert.equal(leaseIsAcquirable(undefined, Date.now()), true);
});

test("leaseIsAcquirable: an unlocked row is acquirable", () => {
  const row: ScheduledJobRow = {
    name: "ttl_reaper",
    locked_by: null,
    locked_at: null,
    lease_expires_at: null,
    last_run_at: 1000,
    last_run_ok: 1,
    run_count: 3,
  };
  assert.equal(leaseIsAcquirable(row, Date.now()), true);
});

test("leaseIsAcquirable: a row with a live (unexpired) lease is NOT acquirable", () => {
  const now = Date.now();
  const row: ScheduledJobRow = {
    name: "ttl_reaper",
    locked_by: "instance-A",
    locked_at: now - 1000,
    lease_expires_at: now + 60_000,
    last_run_at: null,
    last_run_ok: null,
    run_count: 0,
  };
  assert.equal(leaseIsAcquirable(row, now), false);
});

test("leaseIsAcquirable: a row with an EXPIRED lease is acquirable (crash-reclaim path)", () => {
  const now = Date.now();
  const row: ScheduledJobRow = {
    name: "ttl_reaper",
    locked_by: "instance-A",
    locked_at: now - 600_000,
    lease_expires_at: now - 1, // expired one ms ago
    last_run_at: null,
    last_run_ok: null,
    run_count: 0,
  };
  assert.equal(leaseIsAcquirable(row, now), true);
});

// ─── tryAcquireJobLease / releaseJobLease ───────────────────────────

test("tryAcquireJobLease: first caller for a never-seen job name acquires it", () => {
  reset();
  const acquired = tryAcquireJobLease("ttl_reaper", "instance-A", 300_000);
  assert.equal(acquired, true);
  assert.equal(table.get("ttl_reaper")!.locked_by, "instance-A");
});

test("tryAcquireJobLease: coordination across instances — a second instance cannot acquire a live lease", () => {
  reset();
  assert.equal(tryAcquireJobLease("ttl_reaper", "instance-A", 300_000), true);
  assert.equal(tryAcquireJobLease("ttl_reaper", "instance-B", 300_000), false);
  // instance-A's lease is untouched by instance-B's failed attempt.
  assert.equal(table.get("ttl_reaper")!.locked_by, "instance-A");
});

test("releaseJobLease: only the current holder's release actually clears the lease", () => {
  reset();
  tryAcquireJobLease("ttl_reaper", "instance-A", 300_000);
  // instance-B never held it — its release must be a no-op, not a way
  // to steal/clear someone else's lock.
  releaseJobLease("ttl_reaper", "instance-B", true);
  assert.equal(table.get("ttl_reaper")!.locked_by, "instance-A");

  releaseJobLease("ttl_reaper", "instance-A", true);
  assert.equal(table.get("ttl_reaper")!.locked_by, null);
  assert.equal(table.get("ttl_reaper")!.run_count, 1);
  assert.equal(table.get("ttl_reaper")!.last_run_ok, 1);
});

test("after a real release, a different instance can acquire the same job", () => {
  reset();
  tryAcquireJobLease("ttl_reaper", "instance-A", 300_000);
  releaseJobLease("ttl_reaper", "instance-A", true);
  assert.equal(tryAcquireJobLease("ttl_reaper", "instance-B", 300_000), true);
  assert.equal(table.get("ttl_reaper")!.locked_by, "instance-B");
});

test("restart resilience: a crashed holder's abandoned lease is only reclaimable once it expires, not before", () => {
  reset();
  const shortLeaseMs = 1000;
  tryAcquireJobLease("ttl_reaper", "instance-A-old", shortLeaseMs);
  // instance-A "crashes" here — never calls releaseJobLease. A restart
  // gets a FRESH instance id (scheduler.ts's own module doc — regenerated
  // every process boot), so it is a genuinely different owner attempting
  // to acquire, same as any other instance would be.
  const row = table.get("ttl_reaper")!;
  const stillLive = { ...row, lease_expires_at: Date.now() + 60_000 };
  table.set("ttl_reaper", stillLive);
  assert.equal(tryAcquireJobLease("ttl_reaper", "instance-A-restarted", 300_000), false);

  // Once the abandoned lease's own expiry has actually passed, the
  // restarted process (or any other instance) CAN reclaim it — this is
  // the reclaim path, requiring no separate cleanup job.
  const expired = { ...table.get("ttl_reaper")!, lease_expires_at: Date.now() - 1 };
  table.set("ttl_reaper", expired);
  assert.equal(tryAcquireJobLease("ttl_reaper", "instance-A-restarted", 300_000), true);
  assert.equal(table.get("ttl_reaper")!.locked_by, "instance-A-restarted");
});

// ─── tick (runOnScheduleWithLease's own per-tick logic) ─────────────

test("tick: runs fn and releases with last_run_ok=1 on success", async () => {
  reset();
  let ran = false;
  const outcome = await tick("ttl_reaper", "instance-A", 300_000, async () => {
    ran = true;
  });
  assert.equal(outcome, "ran");
  assert.equal(ran, true);
  assert.equal(table.get("ttl_reaper")!.locked_by, null);
  assert.equal(table.get("ttl_reaper")!.last_run_ok, 1);
});

test("tick: a thrown error inside fn still releases the lease, recorded as last_run_ok=0", async () => {
  reset();
  const outcome = await tick("ttl_reaper", "instance-A", 300_000, async () => {
    throw new Error("sweep exploded");
  });
  assert.equal(outcome, "ran");
  // Critically: the lease is NOT left dangling after a thrown error —
  // otherwise one bad run would permanently block every future instance
  // (including this same one on its next tick) until the lease's own
  // timeout, which is exactly the silent-stuck-forever failure mode
  // this design exists to avoid.
  assert.equal(table.get("ttl_reaper")!.locked_by, null);
  assert.equal(table.get("ttl_reaper")!.last_run_ok, 0);
});

test("tick: a second instance's concurrent tick is a no-op skip, not an error, while the first is running", async () => {
  reset();
  assert.equal(tryAcquireJobLease("ttl_reaper", "instance-A", 300_000), true);
  // instance-B's own tick attempt while A still (simulated) holds the lease.
  const outcome = await tick("ttl_reaper", "instance-B", 300_000, async () => {
    throw new Error("must never run — instance-A holds the lease");
  });
  assert.equal(outcome, "skipped");
  assert.equal(table.get("ttl_reaper")!.locked_by, "instance-A");
});
