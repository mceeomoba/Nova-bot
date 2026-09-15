# Zent.md Phase 12a — Strategy Department: Ecosystem Health

Deliverable per Zent.md:

> 12a. Tool: `assess_ecosystem_strengthening(opportunity_id)` — does this
> new company make the existing portfolio more resilient (shared
> customers, shared infra) or just add headcount.

## How it's built

Rather than invent a third similarity metric, this reads the two
signals Strategy already produces per-sibling (11c's `checkMissionOverlap()`,
11d's `checkTechnologyReuse()`) and asks a narrower question of each:

- **shared customers** — a sibling in 11c's `"complements"` bucket.
  `"duplicates"`/`"competes"` entries are deliberately **not** counted:
  a sibling this opportunity would cannibalize isn't evidence of a
  stronger portfolio, it's 12b's future cannibalization question, kept
  separate rather than folded into this one.
- **shared infra** — any sibling present in 11d's `checkTechnologyReuse()`
  results (i.e. it has at least one skill clearing
  `config.technologyReuseMatchThreshold` against this opportunity).

Per Zent.md's own closing "Notes on scope" — *"an agent scoring its own
expansion opportunities has a structural reason to find reasons to
expand"* — this defaults to the unflattering answer when evidence is
thin: zero existing siblings, or siblings that clear neither signal,
both read `strengthensEcosystem: false`, not a hopeful `true`. This is
a deliberate asymmetry with 11e-i's `deriveMissionComplementarityFactor()`
(which reads "no siblings yet" as a neutral 50): that function feeds a
continuous score where "unknown" and "weak" both belong in the middle;
this one feeds a boolean the CEO gate will read at face value, so an
unproven "yes" would be exactly the structural bias the doc warns
against.

## What shipped

- **`backend/src/expansion.ts`**, new Phase 12a section:
  - `EcosystemStrengtheningSignal` / `EcosystemStrengtheningResult` —
    the locked result shape: a boolean verdict, a human-readable
    `reasoning` string (same "auditable, not a bare boolean" discipline
    3b's `roi_score`/11e-i's `fit_score` already commit to), the titles
    of siblings contributing each kind of evidence, and the full
    per-sibling `signals` breakdown (only siblings with at least one
    true flag — same "no signal, not included" posture 11c/11d already
    take).
  - `assessEcosystemStrengthening(opportunityId)` — the pure tool
    function itself. Same portfolio source and "only a sibling 11b can
    resolve a mission for" filter 11c/11d already use; throws only on
    an unknown `opportunity_id`.
  - `EcosystemStrengtheningCheckRecord` / `recordEcosystemStrengtheningAssessment()`
    — the persisting wrapper, filing the result onto the opportunity's
    current `strategy_findings` row under `ecosystem_strengthening`,
    same `{ result, checkedAt }` envelope and read-merge-write discipline
    `recordMissionOverlapCheck()`/`recordTechnologyReuseCheck()` (11e-ii-b)
    already use via `mergeIntoCurrentStrategyFinding()`. Built and wired
    in this same session (unlike 11c/11d, whose persisting wrappers
    landed a phase later in 11e-ii-b) since Zent.md doesn't split 12a
    into a separate "add a record of this" sub-phase the way it did for
    11e.
- **`backend/src/expansionRoutes.ts`** — two new routes:
  - `GET /expansion/opportunities/:id/ecosystem-strengthening` — plain
    read, no persistence, mirrors the `GET /mission-overlap` and
    `GET /technology-reuse` routes exactly.
  - `POST /expansion/opportunities/:id/strategy/assess-ecosystem-strengthening`
    — the write route an autonomous Strategy department actually calls.
    Same ownership chain every Phase 5/8/11e-ii-b write route in this
    file enforces (`agentAddress` must match the top-level agent that
    owns the opportunity's report) — **no operator/human step anywhere
    in this path**, consistent with Zent.md's own "no human-in-the-loop"
    design for the whole pipeline.
- **`backend/src/toolRegistrySeedData.ts`** — new capability row,
  `"ecosystem health assessment": ["assess_ecosystem_strengthening"]`,
  kept separate from `"strategy fit scoring"` per this table's own
  one-capability-per-distinct-kind-of-access convention. `strategy`'s
  department capability list now grants both: `["strategy fit scoring",
  "ecosystem health assessment"]` — a Strategy department can call this
  tool on its own, nothing gates it behind a human approval step.
- **`backend/src/__tests__/expansionEcosystemStrengthening.test.ts`** —
  inlined mirror (same "no live better-sqlite3 in this environment"
  convention every other `expansion*.test.ts` file here uses), covering:
  complements-only counts as shared-customers, duplicates/competes do
  not; technology-reuse presence counts as shared-infra; a sibling with
  no signal is omitted; a sibling with both signals sorts first; zero
  siblings and signal-free siblings both read `false` with the right
  reasoning text; an unknown opportunity id throws.

## What's deliberately NOT here yet

- **`StrategyReport`/`compileStrategyReport()`/`STRATEGY_REPORT_SCHEMA_VERSION`
  are untouched.** `compileStrategyReport()`'s own header is explicit
  that it "adds their fields to `StrategyReport` and bumps this to a
  `12d-v1`... when Phase 12 ships `assess_ecosystem_strengthening` **et
  al.**" — i.e. once 12b (cannibalization) and 12c (relationship type)
  have also shipped, as part of 12d's own compile-report session. This
  session only adds the `ecosystem_strengthening` key onto
  `strategy_findings`; nothing reads it back out into a report yet.
- **12b's explicit cannibalization yes/no field** is not this tool.
  `assessEcosystemStrengthening()` reads mission-overlap `"complements"`
  for a positive signal and simply excludes `"duplicates"`/`"competes"`
  from that signal — it does not itself produce a cannibalization
  verdict. That's 12b's own deliverable.
- **12c's relationship-type recommendation** (independent /
  supplier-to-sibling / shared-customer-base) is not derived here
  either — this tool answers "does it strengthen," not "what
  relationship should it have if approved."
