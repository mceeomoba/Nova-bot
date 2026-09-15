import crypto from "crypto";
import { db } from "./db.js";

/**
 * Adapted from automaton-main's memory/procedural.ts. Same shape and
 * behavior (upsert-by-name, success/failure tracking, LIKE search) —
 * changed only to: use crypto.randomUUID instead of the ulid package
 * (one less dependency), log to console instead of an external logger,
 * and scope every row to `agent_address` since one backend here serves
 * every agent + clone, not a single Conway-provisioned agent.
 */

export interface ProceduralStep {
  order: number;
  action: string;
  notes?: string;
}

export interface ProceduralMemoryEntry {
  id: string;
  name: string;
  description: string;
  steps: ProceduralStep[];
  successCount: number;
  failureCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function deserialize(row: any): ProceduralMemoryEntry {
  let steps: ProceduralStep[] = [];
  try {
    steps = JSON.parse(row.steps || "[]");
  } catch {
    console.error(`[procedural] failed to parse steps for "${row.name}"`);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    steps,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveProcedure(
  agentAddress: string,
  entry: { name: string; description: string; steps: ProceduralStep[] },
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    db.prepare(
      `INSERT INTO procedural_memory (id, agent_address, name, description, steps, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_address, name) DO UPDATE SET
         description = excluded.description,
         steps = excluded.steps,
         updated_at = excluded.updated_at`,
    ).run(id, agentAddress, entry.name, entry.description, JSON.stringify(entry.steps), now, now);
  } catch (error) {
    console.error("[procedural] save failed:", error);
  }
  return id;
}

export function getProcedure(agentAddress: string, name: string): ProceduralMemoryEntry | undefined {
  const row = db
    .prepare(`SELECT * FROM procedural_memory WHERE agent_address = ? AND name = ?`)
    .get(agentAddress, name) as any | undefined;
  return row ? deserialize(row) : undefined;
}

export function recordProcedureOutcome(agentAddress: string, name: string, success: boolean): void {
  const column = success ? "success_count" : "failure_count";
  db.prepare(
    `UPDATE procedural_memory SET ${column} = ${column} + 1, last_used_at = ?, updated_at = ? WHERE agent_address = ? AND name = ?`,
  ).run(Date.now(), Date.now(), agentAddress, name);
}

export function listProcedures(agentAddress: string): ProceduralMemoryEntry[] {
  const rows = db
    .prepare(`SELECT * FROM procedural_memory WHERE agent_address = ? ORDER BY name`)
    .all(agentAddress) as any[];
  return rows.map(deserialize);
}

/**
 * next-phase.md Phase 4d (architecture-agent.md §5 COW table): "Learned
 * procedural memory, if you want lineage" — the one memory category the
 * COW table lists as copyable, in contrast to episodic/semantic memory
 * and knowledge_store, which this phase leaves untouched. A real copy —
 * fresh rows with fresh ids under the clone's own agent_address, not a
 * shared reference or a foreign-key pointer back to the parent's rows —
 * so the parent recording a new outcome afterward never changes what
 * the clone sees. success_count/failure_count/last_used_at are carried
 * over as-is rather than reset to zero: this is a *copy* of what the
 * parent had learned, not a fresh start with the procedure names
 * pre-registered, so the clone's copy should read the same as the
 * parent's did at the moment of cloning. Called only when the caller
 * (cloning.ts's copyCloneConfig) opts in — never automatic, per §5's
 * own "if you want lineage" phrasing and next-phase.md Phase 4d's own
 * checklist ("Procedural memory copy is optional/flagged, not
 * automatic").
 */
export function copyProceduresToAgent(fromAgentAddress: string, toAgentAddress: string): number {
  const source = listProcedures(fromAgentAddress);
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO procedural_memory
       (id, agent_address, name, description, steps, success_count, failure_count, last_used_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_address, name) DO NOTHING`,
  );
  let copied = 0;
  for (const entry of source) {
    const result = insert.run(
      crypto.randomUUID(),
      toAgentAddress,
      entry.name,
      entry.description,
      JSON.stringify(entry.steps),
      entry.successCount,
      entry.failureCount,
      entry.lastUsedAt,
      now,
      now,
    );
    if (result.changes > 0) copied++;
  }
  return copied;
}

export function searchProcedures(agentAddress: string, query: string): ProceduralMemoryEntry[] {
  const escaped = query.replace(/[%_]/g, (ch) => `\\${ch}`);
  const rows = db
    .prepare(
      `SELECT * FROM procedural_memory
       WHERE agent_address = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
       ORDER BY success_count DESC, updated_at DESC
       LIMIT 20`,
    )
    .all(agentAddress, `%${escaped}%`, `%${escaped}%`) as any[];
  return rows.map(deserialize);
}
