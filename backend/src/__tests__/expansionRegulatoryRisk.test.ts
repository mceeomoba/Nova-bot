// Zent.md Phase 6b: assess_regulatory_risk(opportunity_id).
//
// Same "no live better-sqlite3 in this environment" reason
// expansionMarketSizeEstimate.test.ts's own header gives — importing
// expansion.ts directly pulls in db.js -> better-sqlite3 at module
// load and fails immediately in a no-network sandbox (the same
// constraint toolRegistrySeedData.ts's own header flags). So, like
// every other file in this directory, this is an inlined mirror of
// classifyRegulatoryRisk()/REGULATORY_DOMAIN_KEYWORDS (6b) plus
// createFinding()/getCurrentFinding() (1c) and
// mergeIntoCurrentResearchFinding()/recordRegulatoryRiskAssessment()
// (6b) against plain in-memory data, standing in for research_findings.
// Recommend re-running against the real expansion.ts/db.ts once a
// networked environment is available.

import { test } from "node:test";
import assert from "node:assert/strict";

// ─── Inlined mirror of expansion.ts's own classifyRegulatoryRisk() ────

type RegulatoryDomain = "healthcare" | "finance" | "legal";
type RegulatoryRiskLevel = "none" | "high";

const REGULATORY_DOMAIN_KEYWORDS: Record<RegulatoryDomain, string[]> = {
  healthcare: [
    "health",
    "healthcare",
    "medical",
    "medicine",
    "patient",
    "patients",
    "clinical",
    "clinic",
    "clinics",
    "hospital",
    "hospitals",
    "diagnosis",
    "diagnostic",
    "therapy",
    "therapist",
    "prescription",
    "pharma",
    "pharmacy",
    "hipaa",
    "telehealth",
    "ehr",
    "emr",
  ],
  finance: [
    "finance",
    "financial",
    "banking",
    "bank",
    "lending",
    "loan",
    "loans",
    "credit",
    "insurance",
    "insurer",
    "insurers",
    "securities",
    "investment",
    "investing",
    "brokerage",
    "trading",
    "payments",
    "payment",
    "custody",
    "aml",
    "kyc",
    "money transmitter",
    "money transmission",
  ],
  legal: [
    "legal",
    "law",
    "lawyer",
    "lawyers",
    "attorney",
    "litigation",
    "contract review",
    "compliance",
    "regulatory filing",
    "notary",
    "immigration",
    "custody dispute",
    "court filing",
  ],
};

function matchDomainKeywords(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  for (const keyword of keywords) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "i");
    if (pattern.test(lower)) matched.push(keyword);
  }
  return matched;
}

interface RegulatoryDomainMatch {
  domain: RegulatoryDomain;
  matchedKeywords: string[];
}

function classifyRegulatoryRisk(
  title: string,
  thesis: string,
  tags: string[],
): { domains: RegulatoryDomainMatch[]; riskLevel: RegulatoryRiskLevel } {
  const haystack = [title, thesis, ...(tags ?? [])].join(" ");
  const domains: RegulatoryDomainMatch[] = [];
  for (const domain of Object.keys(REGULATORY_DOMAIN_KEYWORDS) as RegulatoryDomain[]) {
    const matchedKeywords = matchDomainKeywords(haystack, REGULATORY_DOMAIN_KEYWORDS[domain]);
    if (matchedKeywords.length > 0) {
      domains.push({ domain, matchedKeywords });
    }
  }
  return { domains, riskLevel: domains.length > 0 ? "high" : "none" };
}

// ─── classifyRegulatoryRisk(): pure function, tested via the mirror ───

test("classifyRegulatoryRisk flags no domains for an ordinary opportunity", () => {
  const { domains, riskLevel } = classifyRegulatoryRisk(
    "Better invoicing for freelance designers",
    "A lightweight invoicing tool that reminds clients to pay on time.",
    ["saas", "productivity"],
  );
  assert.deepEqual(domains, []);
  assert.equal(riskLevel, "none");
});

test("classifyRegulatoryRisk flags healthcare from the thesis text", () => {
  const { domains, riskLevel } = classifyRegulatoryRisk(
    "Appointment scheduling for clinics",
    "Helps small clinics manage patient appointments and reduce no-shows.",
    [],
  );
  assert.equal(riskLevel, "high");
  assert.equal(domains.length, 1);
  assert.equal(domains[0].domain, "healthcare");
  assert.ok(domains[0].matchedKeywords.includes("clinics"));
  assert.ok(domains[0].matchedKeywords.includes("patient"));
});

test("classifyRegulatoryRisk flags finance from a tag even when title/thesis are silent", () => {
  const { domains, riskLevel } = classifyRegulatoryRisk(
    "Smarter expense reports",
    "Automates categorizing receipts for small business owners.",
    ["lending"],
  );
  assert.equal(riskLevel, "high");
  assert.equal(domains.length, 1);
  assert.equal(domains[0].domain, "finance");
  assert.deepEqual(domains[0].matchedKeywords, ["lending"]);
});

test("classifyRegulatoryRisk can flag multiple domains at once", () => {
  const { domains, riskLevel } = classifyRegulatoryRisk(
    "Compliance copilot for health insurers",
    "A legal and compliance assistant for insurance companies handling patient claims.",
    [],
  );
  assert.equal(riskLevel, "high");
  const flaggedDomains = new Set(domains.map((d) => d.domain));
  assert.ok(flaggedDomains.has("healthcare"));
  assert.ok(flaggedDomains.has("finance"));
  assert.ok(flaggedDomains.has("legal"));
});

test("classifyRegulatoryRisk matches whole words only, not substrings inside unrelated words", () => {
  // "lawnmower" contains "law" as a substring but is not the word "law";
  // \b-bounded matching must not flag it.
  const { domains, riskLevel } = classifyRegulatoryRisk(
    "Lawnmower rental marketplace",
    "Peer-to-peer lawnmower and yard-tool rentals for suburban neighborhoods.",
    [],
  );
  assert.deepEqual(domains, []);
  assert.equal(riskLevel, "none");
});

test("classifyRegulatoryRisk matching is case-insensitive", () => {
  const { riskLevel } = classifyRegulatoryRisk("HEALTHCARE Ops Tool", "For HOSPITAL billing teams.", []);
  assert.equal(riskLevel, "high");
});

test("classifyRegulatoryRisk matches a multi-word keyword as a literal phrase", () => {
  const { domains } = classifyRegulatoryRisk(
    "Compliance helper",
    "Automates money transmitter license filings for fintech startups.",
    [],
  );
  const finance = domains.find((d) => d.domain === "finance");
  assert.ok(finance);
  assert.ok(finance!.matchedKeywords.includes("money transmitter"));
});

test("REGULATORY_DOMAIN_KEYWORDS covers exactly the three domains Zent.md 6b names", () => {
  assert.deepEqual(new Set(Object.keys(REGULATORY_DOMAIN_KEYWORDS)), new Set(["healthcare", "finance", "legal"]));
  for (const domain of Object.keys(REGULATORY_DOMAIN_KEYWORDS) as RegulatoryDomain[]) {
    assert.ok(REGULATORY_DOMAIN_KEYWORDS[domain].length > 0, `${domain} keyword list should not be empty`);
  }
});

// ─── recordRegulatoryRiskAssessment(): merge/versioning, inlined mirror ─

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

// mirrors expansion.ts's recordTechnicalRequirements() (6a) — used here
// only to prove 6b accumulates alongside an existing sibling field.
function recordTechnicalRequirements(
  opportunityId: string,
  assessment: { query: string; results: unknown[]; assessedAt: number },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { technical_requirements: assessment });
}

// mirrors expansion.ts's recordRegulatoryRiskAssessment() (6b)
function recordRegulatoryRiskAssessment(
  opportunityId: string,
  assessment: {
    domains: { domain: string; matchedKeywords: string[] }[];
    riskLevel: "none" | "high";
    assessedAt: number;
  },
): FakeFinding<Record<string, unknown>> {
  return mergeIntoCurrentResearchFinding(opportunityId, { regulatory_risk: assessment });
}

test("assess_regulatory_risk on a fresh opportunity starts research_findings at version 1", () => {
  reset();
  const o = seedOpportunity();
  const f = recordRegulatoryRiskAssessment(o.id, {
    domains: [{ domain: "healthcare", matchedKeywords: ["patient"] }],
    riskLevel: "high",
    assessedAt: 1000,
  });
  assert.equal(f.version, 1);
  assert.equal(f.superseded, false);
  assert.deepEqual(Object.keys(f.findings), ["regulatory_risk"]);
});

test("re-running assess_regulatory_risk supersedes the prior version, matching 1c", () => {
  reset();
  const o = seedOpportunity();
  const v1 = recordRegulatoryRiskAssessment(o.id, {
    domains: [],
    riskLevel: "none",
    assessedAt: 1,
  });
  // Opportunity's own text changed upstream (e.g. re-scored) and a
  // re-run now flags finance — 6b, like 5b/5c/5d/6a, can re-run and
  // supersede its own prior finding (1c).
  const v2 = recordRegulatoryRiskAssessment(o.id, {
    domains: [{ domain: "finance", matchedKeywords: ["lending"] }],
    riskLevel: "high",
    assessedAt: 2,
  });

  assert.equal(v2.version, 2);
  const current = getCurrentResearchFinding(o.id);
  assert.equal(current?.id, v2.id);
  assert.equal((current?.findings.regulatory_risk as any).riskLevel, "high");
  assert.equal(table.get(v1.id)?.superseded, true);
});

test("assess_regulatory_risk preserves a sibling field already on the current finding", () => {
  reset();
  const o = seedOpportunity();
  const withTechReqs = recordTechnicalRequirements(o.id, {
    query: "q-tech",
    results: [],
    assessedAt: 1,
  });
  assert.equal(withTechReqs.version, 1);

  const withRegRisk = recordRegulatoryRiskAssessment(o.id, {
    domains: [],
    riskLevel: "none",
    assessedAt: 2,
  });

  assert.equal(withRegRisk.version, 2);
  assert.deepEqual(withRegRisk.findings.technical_requirements, {
    query: "q-tech",
    results: [],
    assessedAt: 1,
  });
  assert.ok("regulatory_risk" in withRegRisk.findings);
});

test("assess_regulatory_risk on an unknown opportunity throws, matching createFinding's own guard", () => {
  reset();
  assert.throws(() =>
    recordRegulatoryRiskAssessment("opp_missing", { domains: [], riskLevel: "none", assessedAt: 1 }),
  );
});
