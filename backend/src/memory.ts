import express from "express";
import { db } from "./db.js";
import { rankByRelevance } from "./tfidf.js";
import { saveProcedure, getProcedure, recordProcedureOutcome, searchProcedures } from "./proceduralMemory.js";
import { addKnowledge, searchKnowledgeStore, knowledgeStats, type KnowledgeCategory } from "./knowledgeStore.js";

const router = express.Router();

/**
 * POST /memory/episodic  { agentAddress, iterationRange, summary }
 * Stores a compressed summary of a chunk of past work. The agent-runtime
 * calls this when its working memory (conversation history) grows past
 * a threshold — it summarizes the oldest chunk via its own inference
 * call, then persists the summary here and drops the raw messages from
 * its working set.
 */
router.post("/episodic", (req, res) => {
  const { agentAddress, iterationRange, summary } = req.body;
  if (!agentAddress || !iterationRange || !summary) {
    return res.status(400).json({ error: "agentAddress, iterationRange, summary required" });
  }
  db.prepare(
    `INSERT INTO memory_episodic (agent_address, iteration_range, summary, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(agentAddress, iterationRange, summary, Date.now());
  res.json({ ok: true });
});

/** GET /memory/episodic?agentAddress=&limit=10 — most recent summaries first. */
router.get("/episodic", (req, res) => {
  const { agentAddress, limit = "10" } = req.query;
  const rows = db
    .prepare(
      `SELECT iteration_range, summary, created_at FROM memory_episodic
       WHERE agent_address = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentAddress, Number(limit));
  res.json({ episodes: rows });
});

/**
 * POST /memory/semantic  { agentAddress, key, value }
 * Upserts a durable fact the agent explicitly chose to remember. Keyed
 * so re-remembering the same key updates it rather than accumulating
 * duplicates — an agent correcting its own earlier belief should
 * overwrite, not pile up contradictions.
 */
router.post("/semantic", (req, res) => {
  const { agentAddress, key, value } = req.body;
  if (!agentAddress || !key || value === undefined) {
    return res.status(400).json({ error: "agentAddress, key, value required" });
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_semantic (agent_address, key, value, access_count, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(agent_address, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(agentAddress, key, String(value), now, now);
  res.json({ ok: true });
});

/**
 * GET /memory/semantic/search?agentAddress=&query=&topK=5
 * Returns the most relevant remembered facts for the given query, via
 * local TF-IDF cosine similarity (see tfidf.ts) — no external embeddings
 * dependency. Bumps access_count on returned entries so you can later
 * see (via /admin/status if extended) which memories actually get used.
 */
router.get("/semantic/search", (req, res) => {
  const { agentAddress, query, topK = "5" } = req.query;
  if (!agentAddress || !query) {
    return res.status(400).json({ error: "agentAddress and query required" });
  }
  const rows = db
    .prepare(`SELECT id, key, value FROM memory_semantic WHERE agent_address = ?`)
    .all(agentAddress) as { id: number; key: string; value: string }[];

  const ranked = rankByRelevance(String(query), rows, (r) => `${r.key} ${r.value}`, Number(topK));

  if (ranked.length > 0) {
    const ids = ranked.map((r) => r.id);
    db.prepare(
      `UPDATE memory_semantic SET access_count = access_count + 1 WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids);
  }

  res.json({ facts: ranked.map(({ key, value }) => ({ key, value })) });
});

/** GET /memory/semantic/list?agentAddress= — full dump, mainly for debugging. */
router.get("/semantic/list", (req, res) => {
  const rows = db
    .prepare(
      `SELECT key, value, access_count, updated_at FROM memory_semantic
       WHERE agent_address = ? ORDER BY updated_at DESC`,
    )
    .all(req.query.agentAddress);
  res.json({ facts: rows });
});

/**
 * Procedural memory — ported from automaton-main's memory/procedural.ts.
 * Distinct from semantic memory: this stores step-by-step "how to do X"
 * procedures with success/failure tracking, not flat facts.
 */

// POST /memory/procedural  { agentAddress, name, description, steps }
router.post("/procedural", (req, res) => {
  const { agentAddress, name, description, steps } = req.body;
  if (!agentAddress || !name || !description || !Array.isArray(steps)) {
    return res.status(400).json({ error: "agentAddress, name, description, steps[] required" });
  }
  const id = saveProcedure(agentAddress, { name, description, steps });
  res.json({ ok: true, id });
});

// GET /memory/procedural/:name?agentAddress=
router.get("/procedural/:name", (req, res) => {
  const { agentAddress } = req.query;
  if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
  const entry = getProcedure(String(agentAddress), req.params.name);
  if (!entry) return res.status(404).json({ error: "not_found" });
  res.json(entry);
});

// GET /memory/procedural/search?agentAddress=&query=
router.get("/procedural/search", (req, res) => {
  const { agentAddress, query } = req.query;
  if (!agentAddress || !query) return res.status(400).json({ error: "agentAddress and query required" });
  res.json({ procedures: searchProcedures(String(agentAddress), String(query)) });
});

// POST /memory/procedural/outcome  { agentAddress, name, success }
router.post("/procedural/outcome", (req, res) => {
  const { agentAddress, name, success } = req.body;
  if (!agentAddress || !name || typeof success !== "boolean") {
    return res.status(400).json({ error: "agentAddress, name, success(boolean) required" });
  }
  recordProcedureOutcome(agentAddress, name, success);
  res.json({ ok: true });
});

/**
 * Knowledge store — ported from automaton-main's memory/knowledge-store.ts.
 * Categorized, confidence-scored, expirable facts — distinct from the flat
 * memory_semantic key/value store above.
 */

// POST /memory/knowledge  { agentAddress, category, key, content, source?, confidence?, expiresAt? }
router.post("/knowledge", (req, res) => {
  const { agentAddress, category, key, content, source, confidence, expiresAt } = req.body;
  if (!agentAddress || !category || !key || !content) {
    return res.status(400).json({ error: "agentAddress, category, key, content required" });
  }
  const id = addKnowledge(agentAddress, { category, key, content, source, confidence, expiresAt });
  res.json({ ok: true, id });
});

// GET /memory/knowledge/search?agentAddress=&query=&category=&limit=
router.get("/knowledge/search", (req, res) => {
  const { agentAddress, query, category, limit } = req.query;
  if (!agentAddress || !query) return res.status(400).json({ error: "agentAddress and query required" });
  const facts = searchKnowledgeStore(
    String(agentAddress),
    String(query),
    category as KnowledgeCategory | undefined,
    limit ? Number(limit) : undefined,
  );
  res.json({ facts });
});

// GET /memory/knowledge/stats?agentAddress=
router.get("/knowledge/stats", (req, res) => {
  const { agentAddress } = req.query;
  if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
  res.json(knowledgeStats(String(agentAddress)));
});

export default router;
