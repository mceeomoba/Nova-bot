import crypto from "crypto";
import { db } from "./db.js";

/**
 * next-phase.md Phase 5d (architecture-agent.md §6, The Orchestrator):
 * "Promote Phase 2b's TTL stub into a proper scheduled reaper ... a
 * first-class, orchestrator-scheduled job — resilient to a backend
 * process restart mid-sweep and, if this is ever deployed as more than
 * one process, coordinated across instances — rather than the single
 * in-process `setInterval` Phase 2b's own stub left it as."
 *
 * This file is that promotion, applied narrowly to the one job this
 * phase's own header actually names (`departments.ts`'s TTL sweep).
 * `resourceQuotas.ts`'s and `orgChartQuotas.ts`'s own 60s
 * `setInterval` sweeps are deliberately left untouched here — both of
 * their own module docs already flag Phase 5d as being about the TTL
 * sweep specifically ("a genuinely separate mechanism ... with its own
 * interval"), not a blanket replacement of every background sweep in
 * this codebase. Nothing about this module is TTL-specific, though —
 * `runOnScheduleWithLease()` below is the general primitive; migrating
 * those other two sweeps onto it is a mechanical follow-up if a later
 * phase ever wants that, not something this phase's own scope asks for.
 *
 * Two distinct properties, both required by this phase's own "Done
 * when" line, both delivered by the same mechanism (a lease row in the
 * new `scheduled_jobs` table, acquired via one atomic SQL UPDATE):
 *
 * 1. "Coordinated across instances" — if this backend is ever run as
 *    more than one OS process against the same sqlite file (WAL mode,
 *    already enabled in db.ts), `tryAcquireJobLease()`'s single UPDATE
 *    ... WHERE is what SQLite itself serializes across those
 *    processes' connections — there is no separate distributed-lock
 *    service to stand up, and no window where two processes can both
 *    read "unlocked" and both proceed, because the read (WHERE) and the
 *    write (SET) are the same statement, not two.
 *
 * 2. "Resilient to a backend process restart mid-sweep" — two separate
 *    halves:
 *      a. If THIS process dies before finishing a run it holds the
 *         lease for, `releaseJobLease()` never runs, so the row is left
 *         with a stale `locked_by` and a `lease_expires_at` that will
 *         pass. `tryAcquireJobLease()`'s own WHERE clause treats an
 *         expired lease exactly like an unlocked one — this is the
 *         reclaim path, and it needs no separate cleanup job (see this
 *         module's own db.ts table comment for why a cleanup pass would
 *         just reintroduce the race this design avoids).
 *      b. Downtime itself: a bare `setInterval` only ever fires
 *         `intervalMs` after the process comes back up, so an outage
 *         plus the wait for the next tick can add up to two full
 *         intervals of extra delay before anything that expired during
 *         the outage gets caught. `runOnScheduleWithLease()` runs once
 *         immediately at registration (i.e. at process boot, since
 *         every sweep module registers its job at module load) instead
 *         of waiting for the first tick — the only delay after a
 *         restart is however long that first run itself takes.
 */

/**
 * One id per process lifetime, not per call — regenerated every time
 * this module is loaded (i.e. every process boot), so a lease acquired
 * before a crash is never mistakenly "still ours" after a restart. Not
 * persisted anywhere; its only job is to disambiguate concurrent
 * holders of the same named lease, and a restarted process holding the
 * OLD id would defeat the "restart lets a fresh run reclaim an
 * abandoned lease" property above.
 */
export const instanceId = `${process.pid}-${crypto.randomUUID()}`;

interface ScheduledJobRow {
  name: string;
  locked_by: string | null;
  locked_at: number | null;
  lease_expires_at: number | null;
}

/**
 * Pure mirror of `tryAcquireJobLease()`'s own SQL WHERE clause below —
 * kept byte-for-byte in sync with it, same split every other db.js-
 * dependent module in this codebase already uses so its real decision
 * logic can be tested against a plain in-memory row without needing
 * better-sqlite3 (see `__tests__/scheduler.test.ts`'s own header). A
 * lease is acquirable when nobody holds it, or when whoever last held
 * it never released it and its lease has since expired.
 */
export function leaseIsAcquirable(row: ScheduledJobRow | undefined, now: number): boolean {
  if (!row) return true;
  if (row.locked_by === null) return true;
  return row.lease_expires_at !== null && row.lease_expires_at <= now;
}

/**
 * Attempts to acquire `name`'s lease for `owner`, valid for `leaseMs`
 * from now. Returns whether the caller now holds it. The row is
 * created (unlocked) on first use if it doesn't exist yet — a job
 * being registered for the very first time is exactly the "nobody
 * holds it" case `leaseIsAcquirable()` already treats as acquirable,
 * so this is just making sure the UPDATE below has a row to match
 * against rather than a special case of its own.
 *
 * The UPDATE's WHERE clause is `leaseIsAcquirable()` written as SQL
 * rather than read-then-branch-then-write, which is what makes the
 * acquire atomic across processes: SQLite evaluates and applies a
 * single statement as one unit against the shared file, so there is no
 * gap between "check" and "claim" for a second process to land in.
 */
export function tryAcquireJobLease(name: string, owner: string, leaseMs: number): boolean {
  const now = Date.now();
  db.prepare(
    `INSERT INTO scheduled_jobs (name, locked_by, locked_at, lease_expires_at, run_count)
     VALUES (?, NULL, NULL, NULL, 0)
     ON CONFLICT(name) DO NOTHING`,
  ).run(name);

  const result = db
    .prepare(
      `UPDATE scheduled_jobs
       SET locked_by = ?, locked_at = ?, lease_expires_at = ?
       WHERE name = ? AND (locked_by IS NULL OR lease_expires_at <= ?)`,
    )
    .run(owner, now, now + leaseMs, name, now);

  return result.changes === 1;
}

/**
 * Releases `name`'s lease, but ONLY if `owner` still holds it — the
 * `AND locked_by = ?` guard is what stops a very-late release (this
 * process finally finishing a run well past its own lease's expiry,
 * after some other instance has already reclaimed and possibly
 * re-released or re-acquired the same lease) from clearing a lock that
 * isn't this call's to clear. Losing a race to release is not an
 * error — it just means the run's own bookkeeping (last_run_at/
 * last_run_ok/run_count) is skipped for this attempt, same as any
 * other best-effort sweep outcome in this codebase.
 */
export function releaseJobLease(name: string, owner: string, ok: boolean): void {
  const now = Date.now();
  db.prepare(
    `UPDATE scheduled_jobs
     SET locked_by = NULL, locked_at = NULL, lease_expires_at = NULL,
         last_run_at = ?, last_run_ok = ?, run_count = run_count + 1
     WHERE name = ? AND locked_by = ?`,
  ).run(now, ok ? 1 : 0, name, owner);
}

export interface ScheduledJobParams {
  /** Primary key into `scheduled_jobs` — must be unique per job. */
  name: string;
  /** How often this process attempts a tick. */
  intervalMs: number;
  /**
   * How long a held lease is valid before another instance (or this
   * same process, after a crash-and-restart under a new instanceId) may
   * reclaim it. Should comfortably exceed how long `fn` is expected to
   * take — too short and a still-legitimately-running instance can get
   * its lease stolen out from under it; too long and a genuine crash
   * takes that much longer to be noticed and reaped by someone else.
   */
  leaseMs: number;
  fn: () => Promise<void>;
}

/**
 * Registers `fn` to run on a lease-guarded schedule: on every tick
 * (starting immediately, then every `intervalMs`), this process tries
 * to acquire `name`'s lease; if it does, it runs `fn` and releases the
 * lease (recording success/failure) when done; if it doesn't (another
 * instance already holds a live lease), this tick is a silent no-op —
 * exactly the outcome wanted, since some OTHER instance is the one
 * actually doing the work this tick.
 *
 * One `fn` failure is recorded (`last_run_ok = 0`) but never thrown
 * out of this function — same "one bad run must never stop future
 * runs" posture every sweep this repo already has takes toward its own
 * setInterval.
 */
export function runOnScheduleWithLease(params: ScheduledJobParams): void {
  const { name, intervalMs, leaseMs, fn } = params;

  const tick = async () => {
    if (!tryAcquireJobLease(name, instanceId, leaseMs)) return;
    let ok = true;
    try {
      await fn();
    } catch {
      ok = false;
    } finally {
      releaseJobLease(name, instanceId, ok);
    }
  };

  // Immediate first run — see this file's own module doc, point 2b,
  // for why this (rather than waiting for the first setInterval tick)
  // is half of what "resilient to a backend process restart" means
  // here.
  tick().catch(() => {});
  setInterval(() => {
    tick().catch(() => {});
  }, intervalMs).unref();
}
