# Zent.md Phase 17d-i-c — Genesis Engine: Customer-Segments Knowledge Seed

Deliverable per Zent.md:

> 17d-i-c. Customer-segments seed: `identify_customer_segments` output
> (5d) is copied into Agent B's own `knowledgeStore.ts` at birth, under
> its own section, so market/competitor/customer context all exist
> before Agent B's first tick.

## What landed

`backend/src/genesis.ts`:

- `formatCustomerSegments(segments: CustomerSegmentsFinding): string` —
  wraps `formatMarketSignalEntry()` (Phase 2b) the same way 17d-i-a's
  `formatMarketSizeEstimate()` and 17d-i-b's `formatCompetitionSurvey()`
  already do. `CustomerSegmentsFinding`'s `{query, results,
  identifiedAt}` shape is structurally identical to
  `MarketSizeEstimate`/`CompetitionSurvey`, so this is the same
  formatter with `identify_customer_segments`'s own tool name/timestamp
  swapped in.
- `seedCustomerSegmentsKnowledge(agentAddress, opportunityId): string | null`
  — reads the opportunity's current research finding
  (`getCurrentResearchFinding`), and if 5d actually ran, writes one
  `knowledge_store` row for Agent B under category `"market"`, key
  `research:customer_segments:${opportunityId}`, source
  `research_finding:<finding.id>`, confidence mapped from Research's
  own 5e self-reported confidence via the same
  `researchConfidenceToScore()` table 17d-i-a/b already share. No
  finding, or a finding with no `customer_segments` section, is a
  normal outcome (Research never ran 5d, or filed its report with only
  5b/5c) — the function returns `null`, not an error.
- `genesisCompany()` calls `seedCustomerSegmentsKnowledge()` right after
  17d-i-b's `seedCompetitionKnowledge()`, same "basic fact about Agent
  B, filed before funding/grants, no ordering dependency either way"
  posture as its two siblings. A thrown DB error is **not** swallowed
  here — same "not caught here" posture the rest of this function
  already uses — it propagates to `fireGenesisTrigger()`'s own catch
  and leaves the trigger `'pending'`.
- `GenesisResult.customerSegmentsKnowledgeId: string | null` added
  alongside `marketSizeKnowledgeId`/`competitionKnowledgeId`, for the
  same "caller shouldn't have to re-query" reason those two fields
  exist.

This completes Zent.md 17d-i's three-part Research handoff: market
size (17d-i-a), competition (17d-i-b), and customer segments (17d-i-c)
now all land in Agent B's `knowledgeStore.ts`, under the shared
`"market"` category but three distinct keys, before its first tick.
17d-II (Strategy's technology-reuse seed) and 17d-III (seed provenance
& write-verification smoke test) are separate sub-phases and
intentionally untouched here.

## No human override, by design — same posture as every prior phase

Nothing in this write path has an operator gate, matching Zent.md's
own "no human-in-the-loop step anywhere in this pipeline" scope note
and every genesis sub-phase before it. `seedCustomerSegmentsKnowledge()`
is called unconditionally once the CEO's `approved` decision (Phase 15d)
has already fired genesis — there is no additional approval step
between "Research found a customer segment" and "that finding is now
in Agent B's knowledge base." Same caveat as Phase 17b's notes: this
is true *of this pipeline specifically*; it does not touch, weaken, or
route around the separate, already-built, operator-only
`constitution-guard.ts` mechanism Agent B still inherits unmodified via
17b, nor any other genuinely operator-gated control elsewhere in this
codebase.

## Sanity checks

No `node_modules` in this environment, so no real project-wide `tsc`,
but real `tsc` itself is present standalone here (v22 node bundled):
- Brace/paren/bracket balance on the edited file:
  `genesis.ts` — 113/113 braces, 441/441 parens, 8/8 brackets
  (whole-file counts, post-edit).
- Cross-checked `addKnowledge()`'s signature (`knowledgeStore.ts`)
  field-for-field against the call site: `category`, `key`, `content`,
  `source`, `confidence` — no mismatches.
- Cross-checked `formatMarketSignalEntry()`'s signature (`expansion.ts`)
  against the call in `formatCustomerSegments()`: `(query, results,
  timestampMs, callLabel)` — matches 17d-i-a/b's own calls exactly,
  just with `identifiedAt` in the timestamp slot instead of
  `estimatedAt`/`surveyedAt`.
- Confirmed `CustomerSegmentsFinding` is already exported from
  `expansion.ts` (Phase 5d) with the exact `{query, results,
  identifiedAt}` shape assumed here — added to this file's existing
  `expansion.js` import alongside `MarketSizeEstimate`/
  `CompetitionSurvey`.
- Confirmed no duplicate `knowledge_store` key collision: `market_size`,
  `competition`, and `customer_segments` are three distinct key
  prefixes under the same `opportunity_id`, so all three coexist under
  category `"market"` rather than any one overwriting another.

Same caveat as every prior pass in this file: this is a scratch/manual
check, not a real build in this repo's own toolchain — worth a real
`npm install && tsc --noEmit` once this is pulled down somewhere with
network.
