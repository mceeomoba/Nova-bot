import { randomUUID } from "crypto";
import { db } from "./db.js";

/**
 * Ecosystem event log — the ONE thing your notification bot reads from.
 *
 * Deliberately not the social relay. socialRelay.ts is agent-to-agent
 * mail with its own wire format (signed, replay-protected, addressed
 * by wallet) — repurposing it as an ops feed would mean either (a)
 * spoofing "messages" that were never actually sent by anyone, which
 * breaks the signature invariant the whole relay is built around, or
 * (b) reading raw relay traffic, which is complete and unfiltered by
 * definition (that's what a mail relay is) and isn't yours to reshape
 * without touching how it works for agents that depend on its format.
 *
 * This table is written to directly, by name, from the specific call
 * sites that already know something meaningful happened — the same
 * places that already log to usage_log / kill_events / audit logs.
 * Nothing here is inferred by watching relay traffic.
 */

export type EventDepartment = "finance" | "ceo" | "security" | "marketing" | "opportunity";

export type EventType =
  | "spawn"
  | "kill"
  | "freeze"
  | "unfreeze"
  | "transfer_in"
  | "transfer_out"
  | "low_compute"
  | "critical_compute"
  | "error_minor"
  | "error_critical"
  | "deal_proposed"
  | "deal_closed"
  | "listing_created"
  | "opportunity_found";

const DEPARTMENT_BY_EVENT_TYPE: Record<EventType, EventDepartment> = {
  spawn: "ceo",
  kill: "security",
  freeze: "security",
  unfreeze: "security",
  transfer_in: "finance",
  transfer_out: "finance",
  low_compute: "finance",
  critical_compute: "finance",
  error_minor: "security",
  error_critical: "security",
  deal_proposed: "ceo",
  deal_closed: "ceo",
  listing_created: "marketing",
  opportunity_found: "opportunity",
};

export interface EcosystemEvent {
  id: string;
  agentAddress: string;
  agentName: string | null;      // "company" in your example
  role: string | null;            // "position" — e.g. "CEO", "Finance Agent"
  subRole: string | null;         // "sub position" — e.g. "AP Clerk", "Incident Responder"
  department: EventDepartment;
  eventType: EventType;
  message: string;                // the human-readable line, e.g. "$50 credit from 0xabc..."
  metadata: Record<string, unknown> | null;
  createdAt: number;
  delivered: 0 | 1;               // has the notification worker sent this yet
}

function ensureTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ecosystem_events (
      id TEXT PRIMARY KEY,
      agent_address TEXT NOT NULL,
      agent_name TEXT,
      role TEXT,
      sub_role TEXT,
      department TEXT NOT NULL,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ecosystem_events_undelivered
      ON ecosystem_events (delivered, created_at);
  `);
}

/**
 * Call this from the actual action sites — e.g.:
 *   - transfer_credits tool success/failure -> emitEvent(..., "transfer_out", ...)
 *   - spawn_child success -> emitEvent(..., "spawn", ...)
 *   - adminKillAgent() -> emitEvent(..., "kill", ...)
 *   - survival/funding.ts's low_compute branch -> emitEvent(..., "low_compute", ...)
 *   - any caught top-level exception in the agent loop -> emitEvent(..., "error_critical", ...)
 * NOT from watching the relay. The caller already knows exactly what
 * happened; that's a stronger signal than re-deriving it from traffic.
 */
export function emitEvent(input: {
  agentAddress: string;
  agentName?: string;
  role?: string;
  subRole?: string;
  eventType: EventType;
  message: string;
  metadata?: Record<string, unknown>;
}): void {
  ensureTable();
  db.prepare(
    `INSERT INTO ecosystem_events
      (id, agent_address, agent_name, role, sub_role, department, event_type, message, metadata, created_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    randomUUID(),
    input.agentAddress,
    input.agentName ?? null,
    input.role ?? null,
    input.subRole ?? null,
    DEPARTMENT_BY_EVENT_TYPE[input.eventType],
    input.eventType,
    input.message,
    input.metadata ? JSON.stringify(input.metadata) : null,
    Date.now(),
  );
}

/** Used by the notification worker (see telegram/notifier.ts) to pull a batch and mark it sent. */
export function pullUndeliveredEvents(limit = 200): EcosystemEvent[] {
  ensureTable();
  const rows = db
    .prepare(`SELECT * FROM ecosystem_events WHERE delivered = 0 ORDER BY created_at ASC LIMIT ?`)
    .all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    agentAddress: r.agent_address,
    agentName: r.agent_name,
    role: r.role,
    subRole: r.sub_role,
    department: r.department,
    eventType: r.event_type,
    message: r.message,
    metadata: r.metadata ? JSON.parse(r.metadata) : null,
    createdAt: r.created_at,
    delivered: r.delivered,
  }));
}

export function isRegisteredAgent(address: string): boolean {
  const row = db.prepare(`SELECT 1 FROM agents WHERE address = ?`).get(address);
  return !!row;
}

export function markDelivered(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(`UPDATE ecosystem_events SET delivered = 1 WHERE id IN (${placeholders})`).run(...ids);
}
