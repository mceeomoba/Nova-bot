import crypto from "crypto";
import { db } from "./db.js";

/**
 * Adapted from automaton-main's memory/knowledge-store.ts. Same shape
 * (categorized, confidence-scored, expirable facts, distinct from the
 * flat memory_semantic key/value store) — inlined the insert/search/
 * update helpers that the original imported from its own state/database.ts,
 * and scoped every row to agent_address so clones each get their own
 * knowledge base rather than one shared across every agent on the box.
 */

export type KnowledgeCategory = "market" | "technical" | "social" | "financial" | "operational";
const CATEGORIES: KnowledgeCategory[] = ["market", "technical", "social", "financial", "operational"];
function isCategory(v: string): v is KnowledgeCategory {
  return (CATEGORIES as string[]).includes(v);
}

/**
 * Zent.md Phase 17d-iii-a: "every seeded entry (17d-i-a–c, 17d-II) is
 * tagged with its source (opportunity_id, originating report id,
 * department) and a birth timestamp, so later self-learned knowledge is
 * distinguishable from inherited knowledge."
 *
 * `department` is deliberately just the two values genesis.ts's own
 * four seed functions can ever produce today (Research for 17d-i-a/b/c,
 * Strategy for 17d-II) rather than a generic string — a seed function
 * for a department this union doesn't name is a new sub-phase's problem,
 * not something this type should silently accept. `reportId` is the
 * finding row's own id (research_findings.id / strategy_findings.id) —
 * the exact versioned pass this content came from, same row `source`
 * already points at via its `research_finding:<id>` / `strategy_finding:<id>`
 * string; this field is that same id, structured, not a second lookup.
 * `seededAt` is Agent B's birth-time write, independent of `created_at`
 * (that column already exists on every knowledge_store row, seeded or
 * not) so a provenance object stays self-contained and doesn't require
 * a caller to cross-reference the row's own column to know when the
 * seed happened.
 */
export interface KnowledgeProvenance {
  opportunityId: string;
  reportId: string;
  department: "research" | "strategy";
  seededAt: number;
}

export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  key: string;
  content: string;
  source: string | null;
  confidence: number;
  lastVerified: number;
  accessCount: number;
  tokenCount: number;
  createdAt: number;
  expiresAt: number | null;
  /** Zent.md 17d-iii-a. Null for every self-learned write (no caller-
   *  supplied provenance) and for any row written before this column
   *  existed — see this file's addKnowledge()/db.ts's own migration
   *  comment for why that's the expected, not a missing-data, state. */
  provenance: KnowledgeProvenance | null;
}

/** Defensive JSON.parse for the `provenance` column: a row this file's
 *  own addKnowledge() wrote is always well-formed JSON or NULL, but a
 *  hand-inserted or pre-migration row (see db.ts's own comment on this
 *  column) has no such guarantee — malformed JSON reads back as `null`
 *  rather than throwing and taking down every other read in the same
 *  searchKnowledgeStore()/knowledgeStats() call. */
function parseProvenance(raw: unknown): KnowledgeProvenance | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed.opportunityId === "string" &&
      typeof parsed.reportId === "string" &&
      (parsed.department === "research" || parsed.department === "strategy") &&
      typeof parsed.seededAt === "number"
    ) {
      return parsed as KnowledgeProvenance;
    }
    return null;
  } catch {
    return null;
  }
}

function toEntry(row: any): KnowledgeEntry {
  if (!isCategory(row.category)) throw new Error(`invalid knowledge category: ${row.category}`);
  return {
    id: row.id,
    category: row.category,
    key: row.key,
    content: row.content,
    source: row.source,
    confidence: row.confidence,
    lastVerified: row.last_verified,
    accessCount: row.access_count,
    tokenCount: row.token_count,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    provenance: parseProvenance(row.provenance),
  };
}

export function addKnowledge(
  agentAddress: string,
  entry: {
    category: KnowledgeCategory;
    key: string;
    content: string;
    source?: string;
    confidence?: number;
    expiresAt?: number | null;
    /** Zent.md 17d-iii-a. Omitted (the default) for every ordinary,
     *  self-learned addKnowledge() call an agent's own runtime makes —
     *  only genesis.ts's own 17d-i-a/b/c + 17d-II seed functions pass
     *  this, and only at Agent B's birth. */
    provenance?: KnowledgeProvenance;
  },
): string {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO knowledge_store
       (id, agent_address, category, key, content, source, confidence, last_verified, token_count, created_at, expires_at, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    agentAddress,
    entry.category,
    entry.key,
    entry.content,
    entry.source ?? null,
    entry.confidence ?? 0.5,
    now,
    Math.ceil(entry.content.length / 4), // rough token estimate, no tokenizer dependency
    now,
    entry.expiresAt ?? null,
    entry.provenance ? JSON.stringify(entry.provenance) : null,
  );
  return id;
}

/**
 * Zent.md Phase 17d-iii-b: "knowledgeStore.ts is verified to accept
 * these tagged pre-birth writes — the write path itself, exercised
 * before any smoke-test assertions run."
 *
 * A direct by-id, by-agent lookup, distinct from searchKnowledgeStore():
 * genesis.ts's four 17d-i-a/b/c + 17d-II seed functions each hand back
 * the exact id addKnowledge() returned, and the acceptance check needs
 * to confirm that *specific* row landed with its provenance intact —
 * not run a LIKE-based content/key search and hope the right row comes
 * back first. Deliberately does not bump access_count the way
 * searchKnowledgeStore() does: this read is genesis-engine bookkeeping,
 * not Agent B's own knowledge-retrieval activity, so it shouldn't look
 * like a self-directed access in later access-pattern analysis.
 * Returns undefined for a row that doesn't exist (or belongs to a
 * different agent_address) — same "absence, not a thrown error" shape
 * as every other not-found lookup in this file.
 */
export function getKnowledgeById(agentAddress: string, id: string): KnowledgeEntry | undefined {
  const row = db
    .prepare(`SELECT * FROM knowledge_store WHERE agent_address = ? AND id = ?`)
    .get(agentAddress, id) as any | undefined;
  return row ? toEntry(row) : undefined;
}

export function searchKnowledgeStore(
  agentAddress: string,
  query: string,
  category?: KnowledgeCategory,
  limit = 20,
): KnowledgeEntry[] {
  const now = Date.now();
  const escaped = query.replace(/[%_]/g, (ch) => `\\${ch}`);
  const rows = db
    .prepare(
      `SELECT * FROM knowledge_store
       WHERE agent_address = ?
         AND (expires_at IS NULL OR expires_at >= ?)
         AND (key LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
         ${category ? "AND category = ?" : ""}
       ORDER BY confidence DESC, last_verified DESC
       LIMIT ?`,
    )
    .all(
      ...[agentAddress, now, `%${escaped}%`, `%${escaped}%`, ...(category ? [category] : []), limit],
    ) as any[];

  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    db.prepare(
      `UPDATE knowledge_store SET access_count = access_count + 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids);
  }
  return rows.map(toEntry);
}

export function pruneKnowledge(agentAddress: string): number {
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 3600_000;
  const result = db
    .prepare(
      `DELETE FROM knowledge_store
       WHERE agent_address = ?
         AND ((expires_at IS NOT NULL AND expires_at < ?)
           OR (confidence < 0.3 AND last_verified < ?))`,
    )
    .run(agentAddress, now, sevenDaysAgo);
  return result.changes;
}

export function knowledgeStats(agentAddress: string) {
  const byCategory: Record<KnowledgeCategory, number> = {
    market: 0,
    technical: 0,
    social: 0,
    financial: 0,
    operational: 0,
  };
  const counts = db
    .prepare(`SELECT category, COUNT(*) AS count FROM knowledge_store WHERE agent_address = ? GROUP BY category`)
    .all(agentAddress) as { category: string; count: number }[];
  for (const row of counts) if (isCategory(row.category)) byCategory[row.category] = row.count;

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total, COALESCE(SUM(token_count), 0) AS totalTokens FROM knowledge_store WHERE agent_address = ?`,
    )
    .get(agentAddress) as { total: number; totalTokens: number };

  return { total: totals.total, byCategory, totalTokens: totals.totalTokens };
}
