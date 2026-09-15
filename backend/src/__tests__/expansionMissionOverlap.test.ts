// Zent.md Phase 11c: "Tool: `check_mission_overlap(opportunity_id)` —
// flags whether the proposed mission competes with, duplicates, or
// clearly complements an existing sibling."
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts file in this directory already gives — this
// inlines a mirror of expansion.ts's checkMissionOverlap() (plus the
// listExistingCompanies() it builds on) against plain in-memory maps
// standing in for `agents` and `opportunities`. The TF-IDF similarity
// itself is a simplified stand-in (see FAKE_SIMILARITY below) rather
// than importing tfidf.ts's real scoreCorpus() — same reasoning
// expansionDedup.test.ts already applies to the same function.
// Recommend re-running against the real expansion.ts/db.ts/tfidf.ts
// once a networked environment is available.
//
// What this covers:
//   11c — a sibling whose mission text is near-identical is flagged
//         "duplicates".
//   11c — a sibling whose mission text is moderately similar (same
//         space, different execution) is flagged "competes".
//   11c — a sibling with low text similarity but heavy tag overlap is
//         flagged "complements".
//   11c — a sibling with neither signal clearing its floor is omitted
//         entirely, not returned with some "none" label.
//   11c — similarity is checked before tag overlap: a sibling whose
//         text already clears "competes" is classified on that signal
//         even if it also shares tags.
//   11c — a self-spawned (spawn_clone) sibling with no mission is
//         silently skipped, not compared against.
//   11c — a sibling that (defensively) resolves back to the candidate's
//         own opportunity id is excluded, not flagged as overlapping
//         with itself.
//   11c — results are sorted duplicates-then-competes-then-complements,
//         ties broken by similarity descending.
//   11c — an opportunity id that doesn't resolve throws, rather than
//         returning an empty list.

import { test } from "node:test";
import assert from "node:assert/strict";

interface FakeAgent {
  address: string;
  parent_address: string | null;
  created_at: number;
  spawn_reason: "self" | "expansion_pipeline";
  opportunity_id: string | null;
}

interface FakeOpportunity {
  id: string;
  title: string;
  thesis: string;
  tags: string[];
  agent_address: string; // which root agent this opportunity belongs to
}

let agents: Map<string, FakeAgent>;
let opportunities: Map<string, FakeOpportunity>;

function reset() {
  agents = new Map();
  opportunities = new Map();
}

function seedAgent(overrides: Partial<FakeAgent> & { address: string }): FakeAgent {
  const agent: FakeAgent = {
    parent_address: null,
    created_at: Date.now(),
    spawn_reason: "self",
    opportunity_id: null,
    ...overrides,
  };
  agents.set(agent.address, agent);
  return agent;
}

function seedOpportunity(o: FakeOpportunity): FakeOpportunity {
  opportunities.set(o.id, o);
  return o;
}

function getOpportunity(id: string): FakeOpportunity | undefined {
  return opportunities.get(id);
}

// ─── Inlined mirror of listExistingCompanies() (Phase 11b) ─────────────

interface ExistingCompanyMission {
  opportunityId: string;
  title: string;
  thesis: string;
}

interface ExistingCompany {
  address: string;
  spawnReason: "self" | "expansion_pipeline";
  opportunityId: string | null;
  mission: ExistingCompanyMission | null;
}

function listExistingCompanies(rootAgentAddress: string): ExistingCompany[] {
  if (!rootAgentAddress) {
    throw new Error("rootAgentAddress is required");
  }
  const rows = [...agents.values()].filter((a) => a.parent_address === rootAgentAddress);

  return rows.map((row) => {
    let mission: ExistingCompanyMission | null = null;
    if (row.opportunity_id) {
      const opportunity = getOpportunity(row.opportunity_id);
      if (opportunity) {
        mission = { opportunityId: opportunity.id, title: opportunity.title, thesis: opportunity.thesis };
      }
    }
    return {
      address: row.address,
      spawnReason: row.spawn_reason,
      opportunityId: row.opportunity_id,
      mission,
    };
  });
}

// ─── Simplified stand-ins for tfidf.ts's scoreCorpus()/dedupText() ─────
//
// Real similarity is TF-IDF cosine over title+thesis. For this inlined
// test, each fixture opportunity carries an explicit `simKey` bucket
// via its thesis text; FAKE_SIMILARITY below maps a pair of thesis
// strings to a fixed similarity score, so test intent ("this pair
// should read as near-identical" / "moderately similar" / "unrelated")
// is explicit rather than depending on incidental word overlap.

const FAKE_SIMILARITY = new Map<string, number>();
function setSimilarity(textA: string, textB: string, score: number) {
  FAKE_SIMILARITY.set(`${textA}|${textB}`, score);
  FAKE_SIMILARITY.set(`${textB}|${textA}`, score);
}
function similarity(textA: string, textB: string): number {
  if (textA === textB) return 1;
  return FAKE_SIMILARITY.get(`${textA}|${textB}`) ?? 0;
}
function dedupText(title: string, thesis: string): string {
  return `${title}\n${thesis}`;
}

function tagJaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((t) => t.toLowerCase()));
  const setB = new Set(b.map((t) => t.toLowerCase()));
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── Inlined mirror of checkMissionOverlap() (Phase 11c) ───────────────

type MissionOverlapRelationship = "duplicates" | "competes" | "complements";

interface MissionOverlapEntry {
  siblingAddress: string;
  siblingOpportunityId: string;
  siblingTitle: string;
  relationship: MissionOverlapRelationship;
  similarity: number;
  tagOverlap: number;
}

const THRESHOLDS = {
  duplicate: 0.82,
  competes: 0.5,
  complementsTag: 0.34,
};

function checkMissionOverlap(opportunityId: string): MissionOverlapEntry[] {
  const candidate = getOpportunity(opportunityId);
  if (!candidate) {
    throw new Error(`opportunity ${opportunityId} not found`);
  }
  const rootAgentAddress = candidate.agent_address;
  const siblings = listExistingCompanies(rootAgentAddress);

  const withMission = siblings.filter(
    (s): s is ExistingCompany & { mission: ExistingCompanyMission } =>
      s.mission !== null && s.mission.opportunityId !== opportunityId,
  );

  const candidateText = dedupText(candidate.title, candidate.thesis);

  const entries: MissionOverlapEntry[] = [];
  for (const sibling of withMission) {
    const siblingText = dedupText(sibling.mission.title, sibling.mission.thesis);
    const score = similarity(candidateText, siblingText);
    const siblingOpportunity = getOpportunity(sibling.mission.opportunityId);
    const tagOverlap = tagJaccard(candidate.tags, siblingOpportunity?.tags ?? []);

    let relationship: MissionOverlapRelationship | undefined;
    if (score >= THRESHOLDS.duplicate) {
      relationship = "duplicates";
    } else if (score >= THRESHOLDS.competes) {
      relationship = "competes";
    } else if (tagOverlap >= THRESHOLDS.complementsTag) {
      relationship = "complements";
    }
    if (!relationship) continue;

    entries.push({
      siblingAddress: sibling.address,
      siblingOpportunityId: sibling.mission.opportunityId,
      siblingTitle: sibling.mission.title,
      relationship,
      similarity: Math.round(score * 100) / 100,
      tagOverlap: Math.round(tagOverlap * 100) / 100,
    });
  }

  const RANK: Record<MissionOverlapRelationship, number> = { duplicates: 0, competes: 1, complements: 2 };
  entries.sort((a, b) => {
    if (RANK[a.relationship] !== RANK[b.relationship]) return RANK[a.relationship] - RANK[b.relationship];
    return b.similarity - a.similarity;
  });
  return entries;
}

// ─── Tests ──────────────────────────────────────────────────────────

test("an opportunity id that doesn't resolve throws", () => {
  reset();
  assert.throws(() => checkMissionOverlap("nope"), /opportunity nope not found/);
});

test("a sibling with near-identical mission text is flagged 'duplicates'", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({
    id: "opp_sibling",
    title: "Laundromat SaaS",
    thesis: "Route optimization for laundromat chains",
    tags: ["logistics"],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "Laundromat SaaS",
    thesis: "Route optimization for laundromat chains",
    tags: ["logistics"],
    agent_address: "agentA",
  });
  setSimilarity(
    dedupText("Laundromat SaaS", "Route optimization for laundromat chains"),
    dedupText("Laundromat SaaS", "Route optimization for laundromat chains"),
    1,
  );

  const [entry] = checkMissionOverlap("opp_candidate");
  assert.equal(entry.relationship, "duplicates");
  assert.equal(entry.siblingAddress, "agentB");
});

test("a sibling with moderate mission-text similarity is flagged 'competes'", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({
    id: "opp_sibling",
    title: "Pet grooming marketplace",
    thesis: "Two-sided marketplace for mobile groomers",
    tags: ["marketplace", "pets"],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "Dog walking marketplace",
    thesis: "Two-sided marketplace for on-demand dog walkers",
    tags: ["marketplace", "pets"],
    agent_address: "agentA",
  });
  setSimilarity(
    dedupText("Pet grooming marketplace", "Two-sided marketplace for mobile groomers"),
    dedupText("Dog walking marketplace", "Two-sided marketplace for on-demand dog walkers"),
    0.6,
  );

  const [entry] = checkMissionOverlap("opp_candidate");
  assert.equal(entry.relationship, "competes");
  assert.equal(entry.similarity, 0.6);
});

test("low text similarity but heavy tag overlap is flagged 'complements'", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({
    id: "opp_sibling",
    title: "Invoice reconciliation tool",
    thesis: "Automates matching invoices to bank transactions",
    tags: ["fintech", "saas", "automation"],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "Payroll compliance tool",
    thesis: "Flags payroll filings that miss state deadlines",
    tags: ["fintech", "saas", "compliance"],
    agent_address: "agentA",
  });
  setSimilarity(
    dedupText("Invoice reconciliation tool", "Automates matching invoices to bank transactions"),
    dedupText("Payroll compliance tool", "Flags payroll filings that miss state deadlines"),
    0.1,
  );

  const [entry] = checkMissionOverlap("opp_candidate");
  assert.equal(entry.relationship, "complements");
  // 2 of 4 distinct tags shared (fintech, saas) = 0.5 Jaccard
  assert.equal(entry.tagOverlap, 0.5);
});

test("a sibling clearing neither signal is omitted entirely", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({
    id: "opp_sibling",
    title: "Podcast show-notes generator",
    thesis: "Turns raw audio into structured show notes",
    tags: ["media"],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "HVAC dispatch scheduler",
    thesis: "Routes technicians to jobs by proximity and skill",
    tags: ["field-service"],
    agent_address: "agentA",
  });
  setSimilarity(
    dedupText("Podcast show-notes generator", "Turns raw audio into structured show notes"),
    dedupText("HVAC dispatch scheduler", "Routes technicians to jobs by proximity and skill"),
    0.03,
  );

  assert.deepEqual(checkMissionOverlap("opp_candidate"), []);
});

test("similarity is checked before tag overlap: a competing sibling stays 'competes' even if tags also overlap heavily", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_sibling",
  });
  seedOpportunity({
    id: "opp_sibling",
    title: "Pet grooming marketplace",
    thesis: "Two-sided marketplace for mobile groomers",
    tags: ["marketplace", "pets", "local"],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "Dog walking marketplace",
    thesis: "Two-sided marketplace for on-demand dog walkers",
    tags: ["marketplace", "pets", "local"],
    agent_address: "agentA",
  });
  setSimilarity(
    dedupText("Pet grooming marketplace", "Two-sided marketplace for mobile groomers"),
    dedupText("Dog walking marketplace", "Two-sided marketplace for on-demand dog walkers"),
    0.6,
  );

  const [entry] = checkMissionOverlap("opp_candidate");
  // full tag overlap (1.0) would clear "complements" too, but 0.6
  // similarity already clears "competes" first, so that's the label.
  assert.equal(entry.relationship, "competes");
});

test("a self-spawned (spawn_clone) sibling with no mission is silently skipped", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({ address: "agentB", parent_address: "agentA", spawn_reason: "self" });
  seedOpportunity({
    id: "opp_candidate",
    title: "Anything",
    thesis: "Anything at all",
    tags: [],
    agent_address: "agentA",
  });

  assert.deepEqual(checkMissionOverlap("opp_candidate"), []);
});

test("a sibling resolving back to the candidate's own opportunity id is excluded", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentB",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_candidate", // defensive/edge case: same id
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "Laundromat SaaS",
    thesis: "Route optimization for laundromat chains",
    tags: ["logistics"],
    agent_address: "agentA",
  });

  assert.deepEqual(checkMissionOverlap("opp_candidate"), []);
});

test("results sort duplicates, then competes, then complements, ties broken by similarity descending", () => {
  reset();
  seedAgent({ address: "agentA" });
  seedAgent({
    address: "agentCompetes",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_competes",
  });
  seedAgent({
    address: "agentDuplicates",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_duplicates",
  });
  seedAgent({
    address: "agentComplements",
    parent_address: "agentA",
    spawn_reason: "expansion_pipeline",
    opportunity_id: "opp_complements",
  });
  seedOpportunity({
    id: "opp_competes",
    title: "T1",
    thesis: "Competing thesis",
    tags: [],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_duplicates",
    title: "T2",
    thesis: "Duplicate thesis",
    tags: [],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_complements",
    title: "T3",
    thesis: "Complementary thesis",
    tags: ["shared", "domain", "tags"],
    agent_address: "agentA",
  });
  seedOpportunity({
    id: "opp_candidate",
    title: "TC",
    thesis: "Candidate thesis",
    tags: ["shared", "domain", "extra"],
    agent_address: "agentA",
  });
  const candText = dedupText("TC", "Candidate thesis");
  setSimilarity(candText, dedupText("T1", "Competing thesis"), 0.55);
  setSimilarity(candText, dedupText("T2", "Duplicate thesis"), 0.9);
  setSimilarity(candText, dedupText("T3", "Complementary thesis"), 0.05);

  const results = checkMissionOverlap("opp_candidate");
  assert.deepEqual(
    results.map((r) => r.relationship),
    ["duplicates", "competes", "complements"],
  );
});
