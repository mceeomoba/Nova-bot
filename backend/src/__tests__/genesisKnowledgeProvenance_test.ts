// Zent.md Phase 17d-iii-c: "Provenance verification test: test that
// 17d-iii-a's tags round-trip correctly and that 17d-iii-b's write
// check passes, gating 17e's smoke test — mirrors the tool/guard/test
// discipline already used to split Phase 11e-ii." (Filed as
// genesisKnowledgeProvenance.test.ts, matching this directory's own
// genesis<Thing>_test.ts / expansion<Thing>.test.ts naming — see
// expansionFitScore.test.ts's own header for the same naming departure
// from Zent.md's literal filename.)
//
// Same "no live better-sqlite3 in this environment" reason every other
// expansion*.test.ts / genesisCompany_test.ts file in this directory
// already gives — this inlines a mirror of:
//   - knowledgeStore.ts's KnowledgeProvenance, parseProvenance(),
//     addKnowledge(), getKnowledgeById() (17d-iii-a's tag shape + the
//     write/read path it round-trips through)
//   - genesis.ts's buildSeedProvenance() and verifyPrebirthKnowledgeWrites()
//     (17d-iii-a's shared tag builder and 17d-iii-b's acceptance check)
// against a plain in-memory map standing in for the knowledge_store
// table, the same posture genesisCompany_test.ts already takes for
// cloning.ts/wallet.ts/facilitator.ts. Recommend re-running against the
// real knowledgeStore.ts/genesis.ts once a networked environment with a
// live better-sqlite3 build is available.
//
// What this covers:
//   17d-iii-a — buildSeedProvenance() returns exactly
//            {opportunityId, reportId, department, seededAt}, no more,
//            no less, for both departments the union allows.
//   17d-iii-a — a provenance tag survives a JSON.stringify/parse round
//            trip (the same serialize-on-write, deserialize-on-read
//            path addKnowledge()/getKnowledgeById() actually use)
//            field-for-field, for both "research" and "strategy".
//   17d-iii-a — an ordinary, non-seed addKnowledge() call (no provenance
//            argument — every self-learned write after birth) reads
//            back with provenance === null, not a default/empty object.
//   17d-iii-a — parseProvenance()'s defensive read: malformed JSON, a
//            non-object payload, and an object missing/mistyping any of
//            the four required fields all read back as null rather than
//            throwing — same "absent, not corrupt" contract
//            knowledgeStore.ts's own header documents.
//   17d-iii-b — verifyPrebirthKnowledgeWrites() passes silently (no
//            throw) when every seed id resolves to a row whose
//            provenance matches the opportunityId/seededAt/department
//            it was asked to check.
//   17d-iii-b — a null seed id (the seed function's own "Research/
//            Strategy never ran this pass" outcome) is skipped, not
//            treated as a failure.
//   17d-iii-b — throws, naming the specific failing seed's label, when
//            an id resolves to no row at all under that agent address.
//   17d-iii-b — throws when a row exists but under a *different* agent
//            address than the one being checked (wrong-agent lookup is
//            the same as "no such row" from the checking agent's side).
//   17d-iii-b — throws when a row's provenance failed to round-trip
//            (reads back null — the corrupt-JSON case above surfacing
//            as a birth-blocking problem, not a silently degraded read).
//   17d-iii-b — throws when a row's provenance round-tripped but
//            doesn't match the expected opportunityId, seededAt, or
//            department — each field checked, any one mismatch fails.
//   17d-iii-b — checks every seed independently: one bad seed's error
//            names that seed specifically, not a generic "something
//            failed" message covering the whole batch.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ─── Mirror of knowledgeStore.ts's KnowledgeProvenance + parseProvenance
//     (Phase 17d-iii-a) ──────────────────────────────────────────────────

type ProvenanceDepartment = "research" | "strategy";

interface KnowledgeProvenance {
  opportunityId: string;
  reportId: string;
  department: ProvenanceDepartment;
  seededAt: number;
}

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

// ─── Mirror of knowledgeStore.ts's knowledge_store table + addKnowledge()/
//     getKnowledgeById() (the write/read path 17d-iii-a's tags round-trip
//     through) ────────────────────────────────────────────────────────────

interface KnowledgeRow {
  id: string;
  agentAddress: string;
  category: string;
  key: string;
  content: string;
  source: string | null;
  provenance: string | null; // stored exactly as addKnowledge() stores it: JSON text or null
}

interface KnowledgeEntry {
  id: string;
  agentAddress: string;
  provenance: KnowledgeProvenance | null;
}

let knowledgeStore: KnowledgeRow[];
let nextRowId: number;

function reset() {
  knowledgeStore = [];
  nextRowId = 1;
}

function addKnowledge(
  agentAddress: string,
  entry: {
    category: string;
    key: string;
    content: string;
    source?: string;
    provenance?: KnowledgeProvenance;
  },
): string {
  const id = `kn_${nextRowId++}`;
  knowledgeStore.push({
    id,
    agentAddress,
    category: entry.category,
    key: entry.key,
    content: entry.content,
    source: entry.source ?? null,
    // Same "JSON.stringify on the way in, parseProvenance() on the way
    // out" path the real addKnowledge()/toEntry() take — no shortcut
    // that would make a round-trip test vacuous.
    provenance: entry.provenance ? JSON.stringify(entry.provenance) : null,
  });
  return id;
}

function getKnowledgeById(agentAddress: string, id: string): KnowledgeEntry | undefined {
  const row = knowledgeStore.find((r) => r.agentAddress === agentAddress && r.id === id);
  if (!row) return undefined;
  return { id: row.id, agentAddress: row.agentAddress, provenance: parseProvenance(row.provenance) };
}

// ─── Mirror of genesis.ts's buildSeedProvenance() (17d-iii-a) ───────────

function buildSeedProvenance(
  opportunityId: string,
  reportId: string,
  department: ProvenanceDepartment,
  seededAt: number,
): KnowledgeProvenance {
  return { opportunityId, reportId, department, seededAt };
}

// ─── Mirror of genesis.ts's SeedAcceptanceSpec + verifyPrebirthKnowledgeWrites()
//     (17d-iii-b) ─────────────────────────────────────────────────────────

interface SeedAcceptanceSpec {
  label: string;
  id: string | null;
  expectedDepartment: ProvenanceDepartment;
}

function verifyPrebirthKnowledgeWrites(
  agentAddress: string,
  opportunityId: string,
  seededAt: number,
  seeds: SeedAcceptanceSpec[],
): void {
  for (const seed of seeds) {
    if (seed.id === null) continue; // best-effort miss upstream — not this check's problem

    const entry = getKnowledgeById(agentAddress, seed.id);
    if (!entry) {
      throw new Error(
        `genesis_company: pre-birth write acceptance check failed for ${seed.label} — ` +
          `addKnowledge() returned id ${seed.id} but no such row exists for agent ${agentAddress}`,
      );
    }
    if (!entry.provenance) {
      throw new Error(
        `genesis_company: pre-birth write acceptance check failed for ${seed.label} — ` +
          `row ${seed.id} exists but its provenance did not round-trip (read back null)`,
      );
    }
    if (
      entry.provenance.opportunityId !== opportunityId ||
      entry.provenance.seededAt !== seededAt ||
      entry.provenance.department !== seed.expectedDepartment
    ) {
      throw new Error(
        `genesis_company: pre-birth write acceptance check failed for ${seed.label} — ` +
          `row ${seed.id} provenance ${JSON.stringify(entry.provenance)} does not match ` +
          `expected {opportunityId: ${opportunityId}, seededAt: ${seededAt}, department: ${seed.expectedDepartment}}`,
      );
    }
  }
}

// ─── 17d-iii-a: buildSeedProvenance() shape ──────────────────────────────

describe("17d-iii-a: buildSeedProvenance", () => {
  test("returns exactly the four documented fields, for department 'research'", () => {
    const tag = buildSeedProvenance("opp_1", "rf_1", "research", 1000);
    assert.deepEqual(tag, {
      opportunityId: "opp_1",
      reportId: "rf_1",
      department: "research",
      seededAt: 1000,
    });
    assert.equal(Object.keys(tag).length, 4);
  });

  test("returns exactly the four documented fields, for department 'strategy'", () => {
    const tag = buildSeedProvenance("opp_2", "sf_1", "strategy", 2000);
    assert.deepEqual(tag, {
      opportunityId: "opp_2",
      reportId: "sf_1",
      department: "strategy",
      seededAt: 2000,
    });
  });
});

// ─── 17d-iii-a: round-trip through addKnowledge()/getKnowledgeById() ────

describe("17d-iii-a: provenance round-trips through the write/read path", () => {
  test.beforeEach(reset);

  test("a research-department seed's tag comes back byte-identical", () => {
    const tag = buildSeedProvenance("opp_1", "rf_42", "research", 555_000);
    const id = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:market_size:opp_1",
      content: "some market-size content",
      source: "research_finding:rf_42",
      provenance: tag,
    });

    const entry = getKnowledgeById("0xagentb1", id);
    assert.ok(entry);
    assert.deepEqual(entry!.provenance, tag);
  });

  test("a strategy-department seed's tag comes back byte-identical", () => {
    const tag = buildSeedProvenance("opp_1", "sf_7", "strategy", 555_000);
    const id = addKnowledge("0xagentb1", {
      category: "technical",
      key: "strategy:technology_reuse:opp_1",
      content: "some technology-reuse content",
      source: "strategy_finding:sf_7",
      provenance: tag,
    });

    const entry = getKnowledgeById("0xagentb1", id);
    assert.ok(entry);
    assert.deepEqual(entry!.provenance, tag);
  });

  test("four seeds sharing one seededAt (genesisCompany()'s own posture) all round-trip that same instant", () => {
    const seededAt = 999_000;
    const ids = [
      addKnowledge("0xagentb1", {
        category: "market",
        key: "research:market_size:opp_1",
        content: "x",
        provenance: buildSeedProvenance("opp_1", "rf_1", "research", seededAt),
      }),
      addKnowledge("0xagentb1", {
        category: "market",
        key: "research:competition:opp_1",
        content: "x",
        provenance: buildSeedProvenance("opp_1", "rf_1", "research", seededAt),
      }),
      addKnowledge("0xagentb1", {
        category: "market",
        key: "research:customer_segments:opp_1",
        content: "x",
        provenance: buildSeedProvenance("opp_1", "rf_1", "research", seededAt),
      }),
      addKnowledge("0xagentb1", {
        category: "technical",
        key: "strategy:technology_reuse:opp_1",
        content: "x",
        provenance: buildSeedProvenance("opp_1", "sf_1", "strategy", seededAt),
      }),
    ];

    for (const id of ids) {
      const entry = getKnowledgeById("0xagentb1", id);
      assert.equal(entry!.provenance!.seededAt, seededAt);
    }
  });

  test("an ordinary self-learned write (no provenance argument) reads back with provenance === null", () => {
    const id = addKnowledge("0xagentb1", {
      category: "operational",
      key: "self-learned:whatever",
      content: "learned after birth, not a genesis seed",
    });

    const entry = getKnowledgeById("0xagentb1", id);
    assert.ok(entry);
    assert.equal(entry!.provenance, null);
  });
});

// ─── 17d-iii-a: parseProvenance()'s defensive read ──────────────────────

describe("17d-iii-a: parseProvenance defensive parsing", () => {
  test("malformed JSON reads back as null, not a thrown error", () => {
    assert.equal(parseProvenance("{not valid json"), null);
  });

  test("well-formed JSON that isn't an object reads back as null", () => {
    assert.equal(parseProvenance("42"), null);
    assert.equal(parseProvenance('"a string"'), null);
    assert.equal(parseProvenance("null"), null);
  });

  test("an object missing any one required field reads back as null", () => {
    const base = { opportunityId: "opp_1", reportId: "rf_1", department: "research", seededAt: 1 };
    for (const missing of ["opportunityId", "reportId", "department", "seededAt"] as const) {
      const { [missing]: _drop, ...rest } = base;
      assert.equal(parseProvenance(JSON.stringify(rest)), null, `missing ${missing} should read back null`);
    }
  });

  test("an object with department outside the two-value union reads back as null", () => {
    const bad = { opportunityId: "opp_1", reportId: "rf_1", department: "finance", seededAt: 1 };
    assert.equal(parseProvenance(JSON.stringify(bad)), null);
  });

  test("null and empty-string columns both read back as null (the pre-migration / self-learned-write states)", () => {
    assert.equal(parseProvenance(null), null);
    assert.equal(parseProvenance(""), null);
    assert.equal(parseProvenance(undefined), null);
  });
});

// ─── 17d-iii-b: verifyPrebirthKnowledgeWrites() happy path ──────────────

describe("17d-iii-b: verifyPrebirthKnowledgeWrites — happy path", () => {
  test.beforeEach(reset);

  function seedFourForAgent(agentAddress: string, opportunityId: string, seededAt: number) {
    return {
      marketSizeId: addKnowledge(agentAddress, {
        category: "market",
        key: `research:market_size:${opportunityId}`,
        content: "x",
        provenance: buildSeedProvenance(opportunityId, "rf_1", "research", seededAt),
      }),
      competitionId: addKnowledge(agentAddress, {
        category: "market",
        key: `research:competition:${opportunityId}`,
        content: "x",
        provenance: buildSeedProvenance(opportunityId, "rf_1", "research", seededAt),
      }),
      customerSegmentsId: addKnowledge(agentAddress, {
        category: "market",
        key: `research:customer_segments:${opportunityId}`,
        content: "x",
        provenance: buildSeedProvenance(opportunityId, "rf_1", "research", seededAt),
      }),
      technologyReuseId: addKnowledge(agentAddress, {
        category: "technical",
        key: `strategy:technology_reuse:${opportunityId}`,
        content: "x",
        provenance: buildSeedProvenance(opportunityId, "sf_1", "strategy", seededAt),
      }),
    };
  }

  test("does not throw when all four real 17d seeds are consistent", () => {
    const seededAt = 12_345;
    const { marketSizeId, competitionId, customerSegmentsId, technologyReuseId } = seedFourForAgent(
      "0xagentb1",
      "opp_1",
      seededAt,
    );

    assert.doesNotThrow(() =>
      verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", seededAt, [
        { label: "17d-i-a market-size", id: marketSizeId, expectedDepartment: "research" },
        { label: "17d-i-b competition", id: competitionId, expectedDepartment: "research" },
        { label: "17d-i-c customer-segments", id: customerSegmentsId, expectedDepartment: "research" },
        { label: "17d-II technology-reuse", id: technologyReuseId, expectedDepartment: "strategy" },
      ]),
    );
  });

  test("a null seed id (Research/Strategy never ran that pass) is skipped, not a failure", () => {
    const seededAt = 12_345;
    const { marketSizeId } = seedFourForAgent("0xagentb1", "opp_1", seededAt);

    assert.doesNotThrow(() =>
      verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", seededAt, [
        { label: "17d-i-a market-size", id: marketSizeId, expectedDepartment: "research" },
        { label: "17d-i-b competition", id: null, expectedDepartment: "research" },
        { label: "17d-i-c customer-segments", id: null, expectedDepartment: "research" },
        { label: "17d-II technology-reuse", id: null, expectedDepartment: "strategy" },
      ]),
    );
  });

  test("all-null seeds (Research and Strategy both never ran) is a no-op, not a failure", () => {
    assert.doesNotThrow(() =>
      verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", 1, [
        { label: "17d-i-a market-size", id: null, expectedDepartment: "research" },
        { label: "17d-II technology-reuse", id: null, expectedDepartment: "strategy" },
      ]),
    );
  });
});

// ─── 17d-iii-b: verifyPrebirthKnowledgeWrites() failure modes ───────────

describe("17d-iii-b: verifyPrebirthKnowledgeWrites — failure modes", () => {
  test.beforeEach(reset);

  test("throws, naming the label, when the id resolves to no row at all", () => {
    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", 1, [
          { label: "17d-i-a market-size", id: "kn_does_not_exist", expectedDepartment: "research" },
        ]),
      /17d-i-a market-size.*no such row exists for agent 0xagentb1/s,
    );
  });

  test("throws when the row exists but under a different agent address", () => {
    const id = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:market_size:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_1", "rf_1", "research", 1),
    });

    // Checking as a different agent than the one the row was written
    // for — same "no such row" outcome from that agent's own side.
    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb2_wrong_agent", "opp_1", 1, [
          { label: "17d-i-a market-size", id, expectedDepartment: "research" },
        ]),
      /no such row exists for agent 0xagentb2_wrong_agent/,
    );
  });

  test("throws when the row's provenance did not round-trip (reads back null)", () => {
    // Simulates the corrupt-JSON case from the parseProvenance() suite
    // above surfacing at the acceptance-check layer: the row exists,
    // addKnowledge() returned a real id, but whatever is in the
    // provenance column doesn't parse back to a KnowledgeProvenance.
    const id = `kn_${nextRowId++}`;
    knowledgeStore.push({
      id,
      agentAddress: "0xagentb1",
      category: "market",
      key: "research:market_size:opp_1",
      content: "x",
      source: null,
      provenance: "{not valid json",
    });

    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", 1, [
          { label: "17d-i-a market-size", id, expectedDepartment: "research" },
        ]),
      /did not round-trip \(read back null\)/,
    );
  });

  test("throws when provenance round-tripped but opportunityId doesn't match", () => {
    const id = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:market_size:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_WRONG", "rf_1", "research", 1),
    });

    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", 1, [
          { label: "17d-i-a market-size", id, expectedDepartment: "research" },
        ]),
      /does not match expected \{opportunityId: opp_1/,
    );
  });

  test("throws when provenance round-tripped but seededAt doesn't match", () => {
    const id = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:market_size:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_1", "rf_1", "research", 111),
    });

    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", 222, [
          { label: "17d-i-a market-size", id, expectedDepartment: "research" },
        ]),
      /does not match expected .*seededAt: 222/,
    );
  });

  test("throws when provenance round-tripped but department doesn't match what was expected", () => {
    const id = addKnowledge("0xagentb1", {
      category: "technical",
      key: "strategy:technology_reuse:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_1", "sf_1", "strategy", 1),
    });

    // Checking it under the wrong expectedDepartment — e.g. a future
    // sub-phase's seed wired to the wrong slot in genesisCompany()'s
    // own verification call.
    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", 1, [
          { label: "17d-II technology-reuse", id, expectedDepartment: "research" },
        ]),
      /does not match expected .*department: research/,
    );
  });

  test("each seed is checked independently — one bad seed's error names only that seed", () => {
    const seededAt = 1;
    const goodId = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:market_size:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_1", "rf_1", "research", seededAt),
    });
    const badId = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:competition:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_WRONG", "rf_1", "research", seededAt),
    });

    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", seededAt, [
          { label: "17d-i-a market-size", id: goodId, expectedDepartment: "research" },
          { label: "17d-i-b competition", id: badId, expectedDepartment: "research" },
        ]),
      /17d-i-b competition/,
    );
  });

  test("fails on the first bad seed in list order, matching the real function's for-loop (no batch-then-report)", () => {
    const seededAt = 1;
    const firstBadId = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:market_size:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_WRONG_FIRST", "rf_1", "research", seededAt),
    });
    const secondBadId = addKnowledge("0xagentb1", {
      category: "market",
      key: "research:competition:opp_1",
      content: "x",
      provenance: buildSeedProvenance("opp_WRONG_SECOND", "rf_1", "research", seededAt),
    });

    assert.throws(
      () =>
        verifyPrebirthKnowledgeWrites("0xagentb1", "opp_1", seededAt, [
          { label: "17d-i-a market-size", id: firstBadId, expectedDepartment: "research" },
          { label: "17d-i-b competition", id: secondBadId, expectedDepartment: "research" },
        ]),
      /17d-i-a market-size/,
    );
  });
});
