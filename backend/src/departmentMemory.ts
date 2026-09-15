import { db } from "./db.js";

/**
 * next-phase.md Phase 2d (architecture-agent.md §4c, Memory section):
 * "Department Agent gets its own namespace in that same [memory] store,
 * keyed by department id — not merely a filtered view of Agent's
 * memory, because a Department Agent's own history needs to survive
 * and stay queryable even after it's aged out of Agent's own working
 * context."
 *
 * Where this actually landed, vs. next-phase.md's own "Touches" line
 * for Phase 2d (which named `agent/src/memory/*`): a Department Agent
 * has no runtime process of its own yet — Phase 2/2a established
 * sub-agents (departments and workers alike) as threads driven by the
 * owning top-level Agent's own runtime, and Phase 2c's system-prompt
 * work confirmed there is still no per-Department-Agent process to
 * feed a prompt to. `agent/src/memory/*` is the Tier-1-only stack a
 * real Agent process's own runtime calls directly (episodic/semantic/
 * procedural, keyed by that Agent's own address) — there is no
 * Department-Agent-side code that could ever call it. The namespace
 * therefore lives here, on the backend, keyed by department_id, next
 * to the rest of a department's state (sub_agents, project_burns) —
 * same reasoning departments.ts itself already gives for why a
 * department's state lives in the backend's own tables rather than a
 * runtime-process file. Updated here rather than silently building it
 * in the wrong place and leaving next-phase.md stale, matching the
 * pattern every prior phase's "where this actually landed" note
 * already established.
 *
 * This is deliberately NOT Phase 2f's full department-memory feature.
 * §4e's category taxonomy (previous_projects / worker_history /
 * technical_knowledge / decisions / lessons_learned / customer_feedback
 * / department_strategy) is that phase's job to make concrete and
 * queryable per-category. Phase 2d needs exactly one thing to be real:
 * a Temporary Worker's output must be written into its Department
 * Agent's namespace *before* the worker is burned (§4c: "this is what
 * makes 'archived,' not merely 'logged,' true") — so this file exposes
 * the minimum needed for that, plus a generic read path, not the full
 * taxonomy.
 */

/**
 * next-phase.md Phase 2f-iv (architecture-agent.md §4e, Memory):
 * "department memory namespace gets its concrete content" — the seven
 * categories §4e's own text names, as an actual list instead of only
 * existing in next-phase.md's prose. 'archived_project_output' (Phase
 * 2d, written automatically by archiveWorkerOutput() below) plus
 * six more a Department Agent can write to directly via
 * recordDepartmentKnowledge() / POST /departments/:id/knowledge.
 *
 * Kept as a plain string-literal union, not a DB CHECK constraint or an
 * enum column — same "this codebase doesn't constrain judgment calls to
 * a fixed vocabulary" reasoning next-phase.md's own Phase 2f-iii text
 * already gave for evaluate_worker's free-text `rating` field. A
 * category outside this list is still accepted by the DB (the column
 * has no CHECK) and by queryDepartmentKnowledge()'s `?category=` filter
 * (a plain string match) — this list is what recordDepartmentKnowledge()
 * validates against and what the POST route's request-body validation
 * uses, not a hard schema-level fence. Widening it later is a one-line
 * change here, not a migration.
 */
export const DEPARTMENT_KNOWLEDGE_CATEGORIES = [
  "archived_project_output", // Phase 2d — written only by archiveWorkerOutput(), not a valid input to recordDepartmentKnowledge()
  "previous_projects",
  "worker_history",
  "technical_knowledge",
  "decisions",
  "lessons_learned",
  "customer_feedback",
  "department_strategy",
] as const;

export type DepartmentKnowledgeCategory = (typeof DEPARTMENT_KNOWLEDGE_CATEGORIES)[number];

// Categories a Department Agent can write to directly via
// recordDepartmentKnowledge() — everything in the taxonomy EXCEPT
// 'archived_project_output', which stays the exclusive, automatic
// output of archiveWorkerOutput()'s own worker-teardown path (Phase
// 2d). Keeping that one category machine-written-only preserves its
// existing meaning ("this is what a burned worker actually produced,"
// verbatim, not a department's own summary of it) — a department's
// *evaluated* take on a project's output belongs in 'lessons_learned'
// or 'previous_projects' instead, written separately.
const WRITABLE_CATEGORIES = DEPARTMENT_KNOWLEDGE_CATEGORIES.filter(
  (c) => c !== "archived_project_output",
) as Exclude<DepartmentKnowledgeCategory, "archived_project_output">[];

export interface DepartmentKnowledgeRow {
  id: number;
  department_id: string;
  category: string;
  source_worker_id: string | null;
  source_project_id: string | null;
  content: string;
  created_at: number;
}

/**
 * Writes a burned worker's raw output into its department's memory
 * namespace. Called from departments.ts's retire-project route and its
 * TTL-reaper sweep — the two places a Temporary Worker's row is about
 * to be deleted/killed and would otherwise take its `result`/`error`
 * with it into nothing but a `project_burns` duration/reason row.
 *
 * Deliberately archives even a worker that produced no useful result
 * (empty/failed) — a Department Agent evaluating "did project X work"
 * needs the failures in its namespace too, not just the successes;
 * filtering for "useful" is a judgment call this function doesn't make
 * (that's the Department Agent's own reasoning, once a later phase
 * gives it a process to do that reasoning in — see the module doc
 * above), it just makes the raw material available to query.
 *
 * Kept as a plain insert, not a transaction with the caller's own
 * kill/log-burn statements — departments.ts already wraps its own
 * burn loop, and a knowledge-write failing shouldn't block the actual
 * teardown (a worker not being archived is a lesser failure than a
 * worker never being killed) — so callers are expected to wrap this in
 * their own best-effort try/catch, same as they already do for PTY
 * session cleanup.
 */
export function archiveWorkerOutput(args: {
  departmentId: string;
  workerId: string;
  projectId: string | null;
  role: string;
  result: string | null;
  error: string | null;
}): void {
  const { departmentId, workerId, projectId, role, result, error } = args;

  // Nothing to archive if the worker never produced or failed with
  // anything at all (e.g. killed before it ever ran) — an empty insert
  // would just be noise in the department's namespace.
  if (!result && !error) return;

  const content = JSON.stringify({
    workerId,
    role,
    result: result ?? null,
    error: error ?? null,
  });

  db.prepare(
    `INSERT INTO department_knowledge (department_id, category, source_worker_id, source_project_id, content, created_at)
     VALUES (?, 'archived_project_output', ?, ?, ?, ?)`,
  ).run(departmentId, workerId, projectId, content, Date.now());
}

/**
 * Writes a Department Agent's own entry into its memory namespace —
 * next-phase.md Phase 2f-iv's write path for the six categories
 * archiveWorkerOutput() doesn't cover (decisions, lessons_learned,
 * department_strategy, customer_feedback, technical_knowledge,
 * previous_projects). Called from POST /departments/:id/knowledge.
 *
 * `content` is caller-supplied free text (a Department Agent's own
 * reasoning about what's worth remembering), stored as-is — unlike
 * archiveWorkerOutput()'s content, which is always a JSON-stringified
 * {workerId, role, result, error} shape this function does NOT impose,
 * since a department-authored entry has no fixed fields to preserve.
 * `sourceWorkerId`/`sourceProjectId` stay optional here (a decision or a
 * strategy note isn't always about one specific worker or project) —
 * archiveWorkerOutput()'s are effectively required by its own call
 * sites, but that's a caller convention, not something this shared
 * table enforces either way.
 */
export function recordDepartmentKnowledge(args: {
  departmentId: string;
  category: DepartmentKnowledgeCategory;
  content: string;
  sourceWorkerId?: string | null;
  sourceProjectId?: string | null;
}): DepartmentKnowledgeRow {
  const { departmentId, category, content, sourceWorkerId, sourceProjectId } = args;
  if (!(WRITABLE_CATEGORIES as string[]).includes(category)) {
    throw Object.assign(
      new Error(
        `invalid category "${category}" — must be one of: ${WRITABLE_CATEGORIES.join(", ")} (archived_project_output is written automatically, not a valid input here)`,
      ),
      { status: 400 },
    );
  }
  if (!content || !content.trim()) {
    throw Object.assign(new Error("content is required"), { status: 400 });
  }

  const created_at = Date.now();
  const result = db
    .prepare(
      `INSERT INTO department_knowledge (department_id, category, source_worker_id, source_project_id, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(departmentId, category, sourceWorkerId ?? null, sourceProjectId ?? null, content, created_at);

  return {
    id: Number(result.lastInsertRowid),
    department_id: departmentId,
    category,
    source_worker_id: sourceWorkerId ?? null,
    source_project_id: sourceProjectId ?? null,
    content,
    created_at,
  };
}

/**
 * Read path for a department's own namespace — introspection only
 * (GET /departments/:id/knowledge in departments.ts), no write access
 * beyond archiveWorkerOutput() above. `category`/`projectId` are
 * optional filters; omitting both returns the department's whole
 * namespace, most recent first, capped at `limit`.
 */
export function queryDepartmentKnowledge(
  departmentId: string,
  opts: { category?: string; projectId?: string; limit?: number } = {},
): DepartmentKnowledgeRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const clauses: string[] = ["department_id = ?"];
  const params: any[] = [departmentId];
  if (opts.category) {
    clauses.push("category = ?");
    params.push(opts.category);
  }
  if (opts.projectId) {
    clauses.push("source_project_id = ?");
    params.push(opts.projectId);
  }
  params.push(limit);

  return db
    .prepare(
      `SELECT * FROM department_knowledge WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params) as DepartmentKnowledgeRow[];
}
