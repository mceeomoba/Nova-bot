// Zent.md Phase 6c: buildability check against the tool/skill catalog.
//
// Same "no live better-sqlite3 in this environment" reason
// expansionMarketSizeEstimate.test.ts's own header gives for the
// merge/versioning half of this file, and expansionRegulatoryRisk.test.ts's
// own header gives for not importing expansion.ts directly (it pulls in
// db.js -> better-sqlite3 at module load). So the merge/versioning half
// and expansion.ts's own checkBuildability()/buildBuildabilityQueryText()
// glue are inlined mirrors here, same as those two files.
//
// tfidf.ts and toolRegistrySeedData.ts are both genuinely DB-free
// (confirmed: neither has a `db.js` import, and toolRegistrySeedData.ts's
// own header explicitly calls this out as deliberate — "so this file
// can be imported by a `node --test` file in an environment with no
// network access to install better-sqlite3") — so this file imports
// scoreCorpus() and SEED_ROWS for real, rather than mirroring those
// too, exercising the actual similarity metric and the actual seeded
// catalog against a realistic opportunity thesis.
//
// Recommend re-running the merge/versioning half against the real
// expansion.ts/db.ts once a networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreCorpus } from "../tfidf.js";
import { SEED_ROWS } from "../toolRegistrySeedData.js";

// ─── Inlined mirror of expansion.ts's own buildability functions ──────

interface BuildabilityMatch {
  name: string;
  source: "tool_registry" | "skill";
  score: number;
}

interface BuildabilityCatalogEntry {
  name: string;
  description: string;
  source: "tool_registry" | "skill";
}

interface TechnicalRequirementsAssessmentLike {
  results: { title: string; url: string; snippet: string }[];
}

// mirrors expansion.ts's buildBuildabilityQueryText() (6c)
function buildBuildabilityQueryText(
  opportunity: { title: string; thesis: string; tags: string[] },
  technicalRequirements?: TechnicalRequirementsAssessmentLike,
): string {
  const evidence = (technicalRequirements?.results ?? [])
    .map((r) => `${r.title} ${r.snippet}`)
    .join(" ");
  return [opportunity.title, opportunity.thesis, ...(opportunity.tags ?? []), evidence]
    .filter((part) => part && part.trim().length > 0)
    .join("\n");
}

// mirrors expansion.ts's checkBuildability() (6c)
function checkBuildability(
  queryText: string,
  catalog: BuildabilityCatalogEntry[],
  threshold: number,
): { matches: BuildabilityMatch[]; flagged: boolean } {
  const scored = scoreCorpus(queryText, catalog, (item) => `${item.name} ${item.description}`);
  const matches = scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .map((s) => ({ name: s.item.name, source: s.item.source, score: s.score }));
  return { matches, flagged: matches.length === 0 };
}

const DEFAULT_THRESHOLD = 0.12; // mirrors config.buildabilityMatchThreshold's own default

// ─── buildBuildabilityQueryText(): pure assembly ───────────────────────

test("buildBuildabilityQueryText combines title/thesis/tags with no technical_requirements yet", () => {
  const text = buildBuildabilityQueryText({
    title: "Invoice reminders",
    thesis: "Automated payment reminders for freelancers.",
    tags: ["saas", "billing"],
  });
  assert.equal(
    text,
    "Invoice reminders\nAutomated payment reminders for freelancers.\nsaas\nbilling",
  );
});

test("buildBuildabilityQueryText folds in 6a's search evidence when present", () => {
  const text = buildBuildabilityQueryText(
    { title: "Invoice reminders", thesis: "Automated payment reminders.", tags: [] },
    {
      results: [
        { title: "How to build a billing engine", url: "https://a.example", snippet: "Use a job queue and webhooks." },
      ],
    },
  );
  assert.ok(text.includes("How to build a billing engine"));
  assert.ok(text.includes("Use a job queue and webhooks."));
});

test("buildBuildabilityQueryText drops empty tags/evidence rather than leaving blank lines", () => {
  const text = buildBuildabilityQueryText({ title: "T", thesis: "Th", tags: [] });
  assert.equal(text, "T\nTh");
});

// ─── checkBuildability(): pure scoring against a small fake catalog ───

test("checkBuildability matches a catalog entry whose description overlaps the query", () => {
  const catalog: BuildabilityCatalogEntry[] = [
    {
      name: "run_command",
      description: "Run a shell command inside the department's own sandbox container",
      source: "tool_registry",
    },
    {
      name: "send_email",
      description: "Send an email on the company's behalf via the configured mail provider",
      source: "tool_registry",
    },
  ];
  const query = "Needs to run shell commands inside a sandbox container to build the pipeline";
  const { matches, flagged } = checkBuildability(query, catalog, DEFAULT_THRESHOLD);
  assert.equal(flagged, false);
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].name, "run_command");
});

test("checkBuildability flags when nothing in the catalog clears the threshold", () => {
  const catalog: BuildabilityCatalogEntry[] = [
    {
      name: "send_email",
      description: "Send an email on the company's behalf via the configured mail provider",
      source: "tool_registry",
    },
  ];
  const query = "Needs a satellite uplink and a custom RF antenna array";
  const { matches, flagged } = checkBuildability(query, catalog, DEFAULT_THRESHOLD);
  assert.deepEqual(matches, []);
  assert.equal(flagged, true);
});

test("checkBuildability can surface a skill-sourced match alongside tool_registry matches", () => {
  const catalog: BuildabilityCatalogEntry[] = [
    {
      name: "invoice-parser-skill",
      description: "Parses uploaded invoices into structured line items for billing automation",
      source: "skill",
    },
    {
      name: "run_command",
      description: "Run a shell command inside the department's own sandbox container",
      source: "tool_registry",
    },
  ];
  const query = "Automated invoice parsing and billing line item extraction";
  const { matches, flagged } = checkBuildability(query, catalog, DEFAULT_THRESHOLD);
  assert.equal(flagged, false);
  assert.ok(matches.some((m) => m.source === "skill" && m.name === "invoice-parser-skill"));
});

test("checkBuildability results are sorted highest-similarity first", () => {
  const catalog: BuildabilityCatalogEntry[] = [
    { name: "weak", description: "container sandbox mention only in passing", source: "tool_registry" },
    {
      name: "strong",
      description: "run shell command sandbox container build pipeline execute",
      source: "tool_registry",
    },
  ];
  const query = "run shell command sandbox container build pipeline execute";
  const { matches } = checkBuildability(query, catalog, 0.01);
  assert.ok(matches.length >= 2);
  assert.equal(matches[0].name, "strong");
  assert.ok(matches[0].score >= matches[1].score);
});

// ─── checkBuildability() against the real seeded catalog ──────────────

test("checkBuildability against the real SEED_ROWS matches a plausible software opportunity", () => {
  const catalog: BuildabilityCatalogEntry[] = SEED_ROWS.map((row) => ({
    name: row.name,
    description: row.description,
    source: "tool_registry" as const,
  }));
  const query = buildBuildabilityQueryText({
    title: "Automated changelog generator",
    thesis:
      "A tool that reads a git repository's commit history and writes a customer-facing changelog automatically.",
    tags: ["software", "developer-tools"],
  });
  const { flagged } = checkBuildability(query, catalog, DEFAULT_THRESHOLD);
  // Not a strict assertion on which row matched (SEED_ROWS wording can
  // evolve) — just that a very ordinary, squarely-in-scope software
  // opportunity does not come back "flagged: true" against the stack's
  // own real catalog. A truly out-of-catalog opportunity (the RF
  // antenna example above) is the case that should flag.
  assert.equal(flagged, false);
});

test("checkBuildability against the real SEED_ROWS flags a domain the catalog has nothing for", () => {
  const catalog: BuildabilityCatalogEntry[] = SEED_ROWS.map((row) => ({
    name: row.name,
    description: row.description,
    source: "tool_registry" as const,
  }));
  const query = buildBuildabilityQueryText({
    title: "Orbital debris tracking constellation",
    thesis:
      "Launch and operate a swarm of cubesats with radar payloads to track orbital debris for insurers.",
    tags: ["aerospace", "satellites"],
  });
  const { flagged } = checkBuildability(query, catalog, DEFAULT_THRESHOLD);
  assert.equal(flagged, true);
});

// ─── recordBuildabilityAssessment(): merge/versioning, inlined mirror ──

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
let table: Map<string, FakeFinding>;
let oppSeq: number;
let findingSeq: number;

function reset() {
  opportunities = new Map();
  table = new Map();
  oppSeq = 0;
  findingSeq = 0;
}

function seedOpportunity(): FakeOpportunity {
  const o: FakeOpportunity = { id: `opp_${++oppSeq}` };
  opportunities.set(o.id, o);
  return o;
}

// mirrors expansion.ts's createFinding()/createResearchFinding() (1c)
function createResearchFinding<T = Record<string, unknown>>(
  opportunityId: string,
  findings: T,
): FakeFinding<T> {
  if (!opportunities.has(opportunityId)) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  let priorVersion = 0;
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId) {
      priorVersion = Math.max(priorVersion, row.version);
      if (!row.superseded) row.superseded = true;
    }
  }
  const row: FakeFinding<T> = {
    id: `resf_${++findingSeq}`,
    opportunity_id: opportunityId,
    created_at: Date.now() + findingSeq,
    version: priorVersion + 1,
    superseded: false,
    findings: findings ?? ({} as T),
  };
  table.set(row.id, row as FakeFinding<Record<string, unknown>>);
  return row;
}

function getCurrentResearchFinding<T = Record<string, unknown>>(
  opportunityId: string,
): FakeFinding<T> | undefined {
  for (const row of table.values()) {
    if (row.opportunity_id === opportunityId && !row.superseded) {
      return row as FakeFinding<T>;
    }
  }
  return undefined;
}

// mirrors expansion.ts's mergeIntoCurrentResearchFinding()
function mergeIntoCurrentResearchFinding(
  opportunityId: string,
  patch: Record<string, unknown>,
): FakeFinding<Record<string, unknown>> {
  const current = getCurrentResearchFinding(opportunityId);
  const merged = { ...(current?.findings ?? {}), ...patch };
  return createResearchFinding<Record<string, unknown>>(opportunityId, merged);
}

// mirrors expansion.ts's recordRegulatoryRiskAssessment() (6b) — used
// here only to prove 6c accumulates alongside an existing sibling field.
function recordRegulatoryRiskAssessment(
  opportunityId: string,
  assessment: { domains: unknown[]; riskLevel: "none" | "high"; assessedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { regulatory_risk: assessment });
}

// mirrors expansion.ts's recordBuildabilityAssessment() (6c)
function recordBuildabilityAssessment(
  opportunityId: string,
  assessment: { matches: BuildabilityMatch[]; flagged: boolean; threshold: number; assessedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { buildability: assessment });
}

test("check-buildability on a fresh opportunity starts research_findings at version 1", () => {
  reset();
  const o = seedOpportunity();
  const f = recordBuildabilityAssessment(o.id, {
    matches: [{ name: "run_command", source: "tool_registry", score: 0.4 }],
    flagged: false,
    threshold: DEFAULT_THRESHOLD,
    assessedAt: 1000,
  });
  assert.equal(f.version, 1);
  assert.equal(f.superseded, false);
  assert.deepEqual(Object.keys(f.findings), ["buildability"]);
});

test("re-running check-buildability supersedes the prior version, matching 1c", () => {
  reset();
  const o = seedOpportunity();
  const v1 = recordBuildabilityAssessment(o.id, {
    matches: [],
    flagged: true,
    threshold: DEFAULT_THRESHOLD,
    assessedAt: 1,
  });
  // e.g. 6a ran in between, giving the query text more to match against
  const v2 = recordBuildabilityAssessment(o.id, {
    matches: [{ name: "run_command", source: "tool_registry", score: 0.3 }],
    flagged: false,
    threshold: DEFAULT_THRESHOLD,
    assessedAt: 2,
  });

  assert.equal(v2.version, 2);
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
  assert.equal((current?.findings.buildability as any).flagged, false);
  assert.equal(table.get(v1.id)?.superseded, true);
});

test("check-buildability preserves a sibling field already on the current finding", () => {
  reset();
  const o = seedOpportunity();
  const withRegRisk = recordRegulatoryRiskAssessment(o.id, {
    domains: [],
    riskLevel: "none",
    assessedAt: 1,
  });
  assert.equal(withRegRisk.version, 1);

  const withBuildability = recordBuildabilityAssessment(o.id, {
    matches: [],
    flagged: true,
    threshold: DEFAULT_THRESHOLD,
    assessedAt: 2,
  });

  assert.equal(withBuildability.version, 2);
  assert.deepEqual(withBuildability.findings.regulatory_risk, {
    domains: [],
    riskLevel: "none",
    assessedAt: 1,
  });
  assert.ok("buildability" in withBuildability.findings);
});

test("check-buildability on an unknown opportunity throws, matching createFinding's own guard", () => {
  reset();
  assert.throws(() =>
    recordBuildabilityAssessment("opp_missing", {
      matches: [],
      flagged: true,
      threshold: DEFAULT_THRESHOLD,
      assessedAt: 1,
    }),
  );
});
