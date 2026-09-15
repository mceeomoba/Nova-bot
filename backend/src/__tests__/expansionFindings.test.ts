// Zent.md Phase 1c: research_findings / finance_findings / strategy_findings
// data model.
// Inlined mirror of expansion.ts's own logic against plain in-memory
// data, standing in for the three finding tables and their parent
// `opportunities` — same "no live better-sqlite3 in this environment"
// reason expansionPipeline.test.ts's and expansionOpportunities.test.ts's
// own headers already document. Recommend re-running against the real
// createFinding()/expansion.ts/db.ts once a networked environment is
// available.

import { test } from "node:test";
import assert from "node:assert/strict";

type FindingKind = "research" | "finance" | "strategy";

interface FakeOpportunity {
  id: string;
}

interface FakeFinding<T = Record<string, unknown>> {
  id: string;
  opportunity_id: string;
  created_at: number;
  version: number;
  superseded: boolean;
  findings: T;
}

let opportunities: Map<string, FakeOpportunity>;
let tables: Record<FindingKind, Map<string, FakeFinding>>;
let oppSeq: number;
let findingSeq: number;

function reset() {
  opportunities = new Map();
  tables = { research: new Map(), finance: new Map(), strategy: new Map() };
  oppSeq = 0;
  findingSeq = 0;
}

function seedOpportunity(): FakeOpportunity {
  const o: FakeOpportunity = { id: `opp_${++oppSeq}` };
  opportunities.set(o.id, o);
  return o;
}

// ─── Inlined mirror of expansion.ts's own exported functions ──────────

function createFinding<T = Record<string, unknown>>(
  kind: FindingKind,
  opportunityId: string,
  findings: T,
): FakeFinding<T> {
  if (!opportunityId) throw new Error("opportunityId is required");
  if (!opportunities.has(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const table = tables[kind];
  // supersede the current row for this opportunity, if any
  let priorVersion = 0;
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId) {
      priorVersion = Math.max(priorVersion, row.version);
      if (!row.superseded) row.superseded = true;
    }
  }
  const row: FakeFinding<T> = {
    id: `${kind}f_${++findingSeq}`,
    opportunity_id: opportunityId,
    created_at: Date.now() + findingSeq,
    version: priorVersion + 1,
    superseded: false,
    findings: findings ?? ({} as T),
  };
  table.set(row.id, row as FakeFinding<Record<string, unknown>>);
  return row;
}

function getCurrentFinding<T = Record<string, unknown>>(
  kind: FindingKind,
  opportunityId: string,
): FakeFinding<T> | undefined {
  for (const row of tables[kind].values()) {
    if (row.opportunity_id === opportunityId && !row.superseded) {
      return row as FakeFinding<T>;
    }
  }
  return undefined;
}

function listFindingVersions<T = Record<string, unknown>>(
  kind: FindingKind,
  opportunityId: string,
): FakeFinding<T>[] {
  return [...tables[kind].values()]
    .filter((r) => r.opportunity_id === opportunityId)
    .sort((a, b) => b.version - a.version) as FakeFinding<T>[];
}

// ─── Tests ──────────────────────────────────────────────────────────

test("createFinding requires an existing opportunity", () => {
  reset();
  assert.throws(() => createFinding("research", "opp_missing", { market_size: "big" }));
});

test("createFinding starts a fresh opportunity at version 1, not superseded", () => {
  reset();
  const o = seedOpportunity();
  const f = createFinding("research", o.id, { market_size: "big" });
  assert.equal(f.version, 1);
  assert.equal(f.superseded, false);
  assert.deepEqual(f.findings, { market_size: "big" });
});

test("re-running a department supersedes its own prior finding and increments version", () => {
  reset();
  const o = seedOpportunity();
  const v1 = createFinding("research", o.id, { market_size: "small" });
  const v2 = createFinding("research", o.id, { market_size: "actually big" });

  assert.equal(v2.version, 2);
  assert.equal(v2.superseded, false);

  const current = getCurrentFinding("research", o.id);
  assert.equal(current?.id, v2.id);
  assert.deepEqual(current?.findings, { market_size: "actually big" });

  const history = listFindingVersions("research", o.id);
  assert.deepEqual(
    history.map((f) => f.id),
    [v2.id, v1.id],
  );
  assert.equal(history.find((f) => f.id === v1.id)?.superseded, true);
});

test("getCurrentFinding returns undefined before any pass has run", () => {
  reset();
  const o = seedOpportunity();
  assert.equal(getCurrentFinding("research", o.id), undefined);
  assert.deepEqual(listFindingVersions("research", o.id), []);
});

test("research, finance, and strategy findings are independent per opportunity", () => {
  reset();
  const o = seedOpportunity();
  createFinding("research", o.id, { market_size: "big" });
  createFinding("finance", o.id, { build_cost_usdc: 500 });
  createFinding("strategy", o.id, { fit_score: 80 });

  assert.equal(getCurrentFinding("research", o.id)?.version, 1);
  assert.equal(getCurrentFinding("finance", o.id)?.version, 1);
  assert.equal(getCurrentFinding("strategy", o.id)?.version, 1);

  // re-running Finance doesn't touch Research's or Strategy's rows
  createFinding("finance", o.id, { build_cost_usdc: 350 });
  assert.equal(getCurrentFinding("research", o.id)?.version, 1);
  assert.equal(getCurrentFinding("finance", o.id)?.version, 2);
  assert.equal(getCurrentFinding("strategy", o.id)?.version, 1);
});

test("findings are scoped per opportunity, not shared across opportunities", () => {
  reset();
  const o1 = seedOpportunity();
  const o2 = seedOpportunity();
  createFinding("research", o1.id, { market_size: "o1 finding" });

  assert.equal(getCurrentFinding("research", o2.id), undefined);
  assert.deepEqual(listFindingVersions("research", o2.id), []);
});

test("exactly one non-superseded row exists per opportunity after several re-runs", () => {
  reset();
  const o = seedOpportunity();
  createFinding("strategy", o.id, { fit_score: 10 });
  createFinding("strategy", o.id, { fit_score: 40 });
  createFinding("strategy", o.id, { fit_score: 70 });

  const history = listFindingVersions("strategy", o.id);
  const current = history.filter((f) => !f.superseded);
  assert.equal(current.length, 1);
  assert.equal(current[0].version, 3);
  assert.deepEqual(
    history.map((f) => f.version),
    [3, 2, 1],
  );
});
