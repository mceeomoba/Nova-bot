# Zent.md Phase 12b — Strategy Department: Cannibalization Check

Deliverable per Zent.md:

> 12b. Cannibalization check output: explicit yes/no + reasoning field,
> not buried in prose.

## Reading this against 12a

Zent.md doesn't hand this sub-phase a function signature the way 12a's
own line does (`"Tool: assess_ecosystem_strengthening(opportunity_id)"`)
— it names an output shape, not a tool. But 12a's own header (this
repo's `expansion.ts`) already committed to where this lives: it
explicitly excludes `checkMissionOverlap()`'s `"duplicates"`/`"competes"`
labels from its own strengthening signal, calling that out as *"12b's
future cannibalization question, kept separate rather than folded into
this one."* This session is that separate question, shipped as its own
tool: `check_cannibalization(opportunity_id)`.

Named `check_*` (matching 11c/11d) rather than `assess_*` (12a): this
tool reads an existing signal and classifies it, where 12a's `assess_*`
synthesizes a verdict across two independent signals.

## How it's built

No new similarity computation — the signal is already sitting in 11c's
`checkMissionOverlap()`. A sibling classified `"duplicates"` or
`"competes"` is, by that function's own definition of those two labels,
exactly a sibling this opportunity would cannibalize. `"complements"`
entries are excluded, for the mirror-image reason 12a excludes
`"duplicates"`/`"competes"`: the three relationship labels partition
cleanly across the two Phase 12 tools — `complements` → 12a's
strengthening signal, `duplicates`/`competes` → this tool's
cannibalization signal. A given sibling relationship never contributes
to both tools, and never to neither.

Same bias-resistant default posture 12a's own header lays out, applied
the other way: zero existing siblings, or siblings that clear neither
`"duplicates"` nor `"competes"`, both read `cannibalizes: false`. There's
no symmetric bias risk to correct for here (an agent minimizing scrutiny
of its own opportunity would *prefer* to see `false`, so defaulting to
`false` is the conservative floor, not a self-serving one) — but the
same "don't fabricate a verdict from an absence of evidence" discipline
still applies: zero siblings is reported as "nothing to cannibalize,"
worded distinctly from "checked, and it's clean," so a reader can tell
the two apart.

## What shipped

- **`backend/src/expansion.ts`**, new Phase 12b section:
  - `CannibalizationSignal` / `CannibalizationCheckResult` — locked
    result shape: explicit `cannibalizes: boolean`, a `reasoning` string
    that IS the justification rather than a summary of it (Zent.md's own
    "not buried in prose" wording), the titles of cannibalized siblings,
    and the full `signals` breakdown (worst-first order, inherited from
    `checkMissionOverlap()`'s own sort).
  - `checkCannibalization(opportunityId)` — the pure tool function.
    Same portfolio source and "only a sibling 11b can resolve a mission
    for" filter 11c/11d/12a already use; throws only on an unknown
    `opportunity_id`.
  - `CannibalizationCheckRecord` / `recordCannibalizationCheck()` — the
    persisting wrapper, filing the result onto the opportunity's current
    `strategy_findings` row under `cannibalization_check`, same
    `{ result, checkedAt }` envelope 12a's own
    `EcosystemStrengtheningCheckRecord` uses, via the same
    `mergeIntoCurrentStrategyFinding()` read-merge-write helper.
- **`backend/src/expansionRoutes.ts`** — two new routes:
  - `GET /expansion/opportunities/:id/cannibalization` — plain read, no
    persistence, mirrors 12a's own `GET .../ecosystem-strengthening`.
  - `POST /expansion/opportunities/:id/strategy/check-cannibalization` —
    the write route an autonomous Strategy department calls. Same
    ownership chain every write route in this file enforces
    (`agentAddress` must match the top-level agent that owns the
    opportunity's report) — **no operator/human step anywhere in this
    path**, same as every other route in this pipeline.
- **`backend/src/toolRegistrySeedData.ts`** — new capability row,
  `"cannibalization risk check": ["check_cannibalization"]`, kept
  separate from `"strategy fit scoring"` and `"ecosystem health
  assessment"` per this table's own one-capability-per-distinct-kind-
  of-access convention. `strategy`'s department capability list now
  grants all three: `["strategy fit scoring", "ecosystem health
  assessment", "cannibalization risk check"]` — a Strategy department
  calls this on its own; nothing gates it behind approval.
- **`backend/src/__tests__/expansionCannibalization.test.ts`** —
  inlined mirror (same no-live-DB convention as every other
  `expansion*.test.ts` file here), covering: duplicates/competes both
  count as cannibalizing, complements does not; zero siblings and
  signal-free siblings both read `false` with distinct reasoning text;
  reasoning names duplicated and competing siblings separately when
  both are present; worst-first order is preserved; unknown opportunity
  id throws.

## What's deliberately NOT here yet

- **`StrategyReport`/`compileStrategyReport()`/`STRATEGY_REPORT_SCHEMA_VERSION`
  are still untouched.** Same reasoning as 12a's own notes: that bump is
  12d's own deliverable, once 12c (relationship type) has also shipped.
  This session only adds the `cannibalization_check` key onto
  `strategy_findings`.
- **12c's relationship-type recommendation** is not derived here. A
  `cannibalizes: true` verdict is a strong signal against
  `"shared-customer-base"` as the eventual relationship type, but this
  tool doesn't make that recommendation itself — that's 12c's job,
  reading this tool's persisted record as one of its own inputs.
