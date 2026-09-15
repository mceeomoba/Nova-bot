# Zent.md Phase 17d-II — Genesis Engine: Strategy Technology-Reuse Knowledge Seed

Deliverable per Zent.md:

> 17d-II. Strategy technology-reuse seed: Strategy's Phase 11 reuse notes
> (which of Company A's existing components/skills apply to this
> opportunity) are copied into the same `knowledgeStore.ts`, kept as a
> distinct section from 17d-i-a–c so Agent B can tell "what the market
> looks like" from "what I can reuse to build this."

## What landed

`backend/src/genesis.ts`:

- `formatTechnologyReuse(record: TechnologyReuseCheckRecord): string` —
  a dedicated formatter, not a reuse of `formatMarketSignalEntry()`
  (Phase 2b). Unlike 17d-i-a/b/c's inputs, `checkTechnologyReuse()`'s
  (Phase 11d, `expansion.ts`) output has no query/results/timestamp
  triple — it's a list of per-sibling skill matches
  (`{siblingAddress, siblingOpportunityId, siblingTitle, matches,
  reuseScore}`) plus a `checkedAt` timestamp. The formatter mirrors
  `formatMarketSignalEntry()`'s header/no-results block style
  (`[timestamp] label: ...` / `: no results`) purely for a consistent
  reading experience across every `17d-*` seed in Agent B's
  `knowledgeStore.ts`, not because the underlying shape matches.
- `seedTechnologyReuseKnowledge(agentAddress, opportunityId): string | null`
  — reads the opportunity's current **strategy** finding
  (`getCurrentStrategyFinding`, not `getCurrentResearchFinding` —
  this is the one 17d seed sourced from Strategy rather than
  Research), and if 11d actually ran (`technology_reuse` is present
  on the finding), writes one `knowledge_store` row for Agent B under
  category `"technical"` — deliberately **not** `"market"`, the
  category 17d-i-a/b/c share — key
  `strategy:technology_reuse:${opportunityId}`, source
  `strategy_finding:<finding.id>` (distinct prefix from the three
  Research seeds' `research_finding:<finding.id>`, since this traces
  back to a `strategy_findings` row). Confidence is
  `entries[0]?.reuseScore` (11d's own 0–1 TF-IDF headline number) —
  Research's low/med/high vocabulary (5e) has no strategy_findings
  equivalent, so this reuses 11d's own signal instead of inventing a
  new one. No check yet (11d never ran) returns `null`; a completed
  check with zero matches still writes a row saying so — see the
  in-file comment block for why those two are different states.
- `genesisCompany()` calls `seedTechnologyReuseKnowledge()` right after
  17d-i-c's `seedCustomerSegmentsKnowledge()`, same "basic fact about
  Agent B, filed before funding/grants, no ordering dependency either
  way" posture its three siblings already use. A thrown DB error is
  **not** swallowed here — same "not caught here" posture the rest of
  this function already uses — it propagates to `fireGenesisTrigger()`'s
  own catch and leaves the trigger `'pending'`.
- `GenesisResult.technologyReuseKnowledgeId: string | null` added
  alongside `marketSizeKnowledgeId`/`competitionKnowledgeId`/
  `customerSegmentsKnowledgeId`, for the same "caller shouldn't have to
  re-query" reason those three fields exist.

This completes Zent.md 17d's knowledge-seeding surface: 17d-i's
three-part Research handoff (market size, competition, customer
segments — all category `"market"`) plus 17d-II's Strategy
technology-reuse note (category `"technical"`) now all land in Agent
B's `knowledgeStore.ts` before its first tick, each independently
present-or-absent depending on which departments actually ran for this
opportunity. 17d-III (seed provenance & write-verification smoke test)
is a separate sub-phase and intentionally untouched here.

## Why category "technical", not "market"

Zent.md's own wording for this sub-phase is the reason: 17d-i-a–c
together answer "what does the market look like" (size, competitors,
customers); 17d-II answers "what can I reuse to build this" — a fact
about Agent B's own buildable surface, not another slice of market
context. Filing it under `"market"` alongside the other three would
make `searchKnowledgeStore(agentAddress, q, "market")` return
build-reuse notes mixed in with market sizing, which is exactly the
"kept as a distinct section" Zent.md asks for. `knowledgeStore.ts`
already has a `"technical"` category with no other writer yet, so this
is the first seed to use it, not a new category being added.

## No human override, by design — same posture as every prior phase

Nothing in this write path has an operator gate, matching Zent.md's
own "no human-in-the-loop step anywhere in this pipeline" scope note
and every genesis sub-phase before it. `seedTechnologyReuseKnowledge()`
is called unconditionally once the CEO's `approved` decision (Phase 15d)
has already fired genesis — there is no additional approval step
between "Strategy found reusable technology in a sibling" and "that
finding is now in Agent B's knowledge base." Same caveat as every prior
17d-* phase's notes: this is true *of this pipeline specifically*; it
does not touch, weaken, or route around the separate, already-built,
operator-only `constitution-guard.ts` mechanism Agent B still inherits
unmodified via 17b, nor any other genuinely operator-gated control
elsewhere in this codebase.

## Sanity checks

No `node_modules` in this environment (no network), so no real
project-wide `tsc`, but real `tsc` itself is present standalone here
(v22 node bundled):

- Brace/paren/bracket balance on the edited file:
  `genesis.ts` — 137/137 braces, 495/495 parens, 13/13 brackets
  (whole-file counts, post-edit).
- Cross-checked `addKnowledge()`'s signature (`knowledgeStore.ts`)
  field-for-field against the call site: `category`, `key`, `content`,
  `source`, `confidence` — no mismatches; `"technical"` confirmed a
  valid `KnowledgeCategory` member.
- Cross-checked `getCurrentStrategyFinding()`'s signature
  (`expansion.ts`, `<T = Record<string, unknown>>(opportunityId:
  string) => Finding<T> | undefined`, same `createFinding`/
  `getCurrentFinding` wrapper `getCurrentResearchFinding()` uses) —
  matches the call here field-for-field (`finding.id`,
  `finding.findings.technology_reuse`).
- Confirmed `TechnologyReuseCheckRecord` (`{entries:
  TechnologyReuseEntry[], checkedAt: number}`) and `TechnologyReuseEntry`
  (`{siblingAddress, siblingOpportunityId, siblingTitle, matches:
  TechnologyReuseMatch[], reuseScore}`) are already exported from
  `expansion.ts` (Phase 11d/11e-ii-b) — added `TechnologyReuseCheckRecord`
  to this file's existing `expansion.js` type import; `TechnologyReuseEntry`
  and `TechnologyReuseMatch` are only referenced structurally inside
  `formatTechnologyReuse()`, no separate import needed since the record
  parameter's own type carries them.
- Confirmed no `knowledge_store` key collision with the three Research
  seeds: `market:research:market_size:*`, `market:research:competition:*`,
  and `market:research:customer_segments:*` (17d-i-a/b/c) vs.
  `technical:strategy:technology_reuse:*` (this phase) — different
  category *and* different key prefix, so none can overwrite another,
  and a `"technical"`-scoped search never picks up the three `"market"`
  rows or vice versa.

Same caveat as every prior pass in this file: this is a scratch/manual
check, not a real build in this repo's own toolchain — worth a real
`npm install && tsc --noEmit` once this is pulled down somewhere with
network.
