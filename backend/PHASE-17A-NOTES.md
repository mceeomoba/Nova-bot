# Zent.md Phase 17a — Genesis Engine: Mission & Constitution — Genesis Prompt Builder

Deliverable per Zent.md:

> 17a. Genesis Prompt builder: assembles Agent B's mission text from the
> opportunity's title/thesis + Strategy's recommended direction —
> produces exactly the kind of prompt shown in chat ("You are Company
> B. Your mission is...").

## What landed

**`genesis.ts`: `buildGenesisPrompt(opportunityId)`** — pure function,
no DB writes, no side effects. Assembles:

- `opportunity.thesis` / `opportunity.title` (Phase 1b's own columns —
  the only mission-shaped text this pipeline has ever recorded for an
  opportunity; the same pair 11b's `listExistingCompanies()` already
  reads as its own mission stand-in until 17c exists).
- Strategy's 12c relationship-type recommendation
  (`compileStrategyReport().relationshipTypeRecommendation`), if one's
  been filed. Its `reasoning` field is "Strategy's recommended
  direction" in Zent.md's own words for this phase — 12c's own doc
  comment already frames the recommendation as informing Agent B's
  grants at birth (16d); this is that same finding also showing up in
  Agent B's own mission text. Omitted, not fabricated, when Strategy
  hasn't filed one yet for this opportunity.

**`genesis.ts`: `writeGenesisPrompt(agentAddress, opportunityId)`** —
this phase's own "wire it in" half. Reads `buildGenesisPrompt()`'s
text and files it into `officeConfigSystemPromptPath()` (office.ts) —
the one per-agent file `agent-runtime`'s own base-prompt builder
already appends to for every agent, pipeline-spawned or not. Prepended
under its own `## Mission (Zent.md Phase 17a — genesis prompt)`
heading, never overwriting: `createClonedAgentWallet()` has already
byte-for-byte copied the *parent's* `system-prompt.md` into Agent B's
config dir by the time this runs (`cloning.ts`'s `copyCloneConfig()`,
Phase 4d), and that content is kept, not discarded.

Called from `genesisCompany()` right after 16e's lineage tag, before
16b's funding transfer and 16d's tool-grant scoping — mission text is
the second most basic fact about Agent B (right after "where did I
come from"), and nothing downstream reads it back, so there's no
ordering dependency either way.

**`GenesisCompanyResult`** gets one new field, `genesisPrompt: string`
— the exact text that was filed, so a caller (a route, a test, an ops
log) doesn't have to re-derive it or re-read the file.

## No human override, by design

Same posture as every prior phase's own note: this write runs inside
the same synchronous `genesisCompany()` call chain with zero operator
gate between the CEO's `approved` ruling and Agent B's own runtime
picking up a real mission. Nothing here adds a review or confirmation
step — worth being plain about what that means concretely for this
phase specifically: the mission text Agent B receives is generated
entirely from what earlier agent-executed steps in this same pipeline
already produced (Opportunity Intelligence's thesis, Strategy's
reasoning) and is never reviewed by a person before an autonomous
agent, backed by real funds, starts acting on it.

## What this doesn't do

- **17b (constitution inheritance)** — untouched, already reused
  unmodified via `copyCloneConfig()` (Phase 4d). This phase doesn't
  touch `constitution.md` at all.
- **17c (mission field stored structurally)** — 17a's prose lives only
  in `system-prompt.md` after this session. There is still no
  queryable mission column/table a later Strategy pass can read
  programmatically; `listExistingCompanies()` (11b) is unchanged and
  still falls back to the opportunity's own title+thesis.
- **17d (knowledge-base seed)** and **17e (first-tick smoke test)** —
  not touched. Agent B gets a mission it can read at boot, but no
  research/technology-reuse notes copied into its own
  `knowledgeStore.ts`, and no verification that it actually completes
  one clean agent-loop tick before being marked active.
- **Phase 18 (ERC-8004 registration, ecosystem registry, marketplace
  listing)** — still fully untouched.

## Tests

`src/__tests__/genesisCompany_test.ts` extended with an in-memory
`systemPromptFiles` map (keyed by agent address, mirroring
`office.ts`'s per-agent file) and narrow mirrors of
`buildGenesisPrompt()`/`writeGenesisPrompt()`. The test `Opportunity`
fixture gained a `thesis` field (previously title-only, since nothing
before this phase read it). 5 new tests: mission prompt names the
opportunity's thesis and title; the relationship-direction paragraph
is omitted when Strategy hasn't filed a recommendation; it's included
(with reasoning) when 12c has filed one — independent of whether 16d's
own listing lookup would find a live listing; the mission is prepended
under its own heading with the parent's copied content preserved and
ordered after it; and an ordinary self-directed clone (no
`genesisCompany()` in the loop) never gets a genesis prompt written at
all. All 33 tests in the file (28 pre-existing + 5 new) pass under
`node --experimental-strip-types --test`. Same caveat as every prior
pass in this file: mirrors, not the real `genesis.ts`/`office.ts`
against a live filesystem.

`tsc --noEmit` for the full project still reports the same 34
pre-existing errors from `expansion.ts`'s unrelated
`compile*/assemble*` comment bug (see `PHASE-16E-NOTES.md`) — zero new
errors from this phase's own changes; `genesis.ts` and its test file
both have no entries in the error list.
