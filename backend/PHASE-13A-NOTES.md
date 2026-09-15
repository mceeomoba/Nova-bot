# Zent.md Phase 13a — Expansion Committee: Assembly

Deliverable per Zent.md:

> 13a. `expansion_committee` construct: not a new department type at
> the data layer — a scheduled read that pulls Research + Finance +
> Strategy reports for one `opportunity_id` into a single packet.

## Reading this against Zent.md's own closing note

> The "Expansion Committee" is intentionally not a new agent kind —
> it's a read-only assembly step (Phase 13) plus a decision endpoint
> the CEO agent itself calls (Phase 15). Keeping it that way avoids
> inventing a fifth tier in the org chart that `orgChartQuotas.ts`
> would then need to learn about.

Taken literally, this session adds nothing to `departments.ts`,
`orgChartQuotas.ts`, `resourceQuotas.ts`, or `toolRegistrySeedData.ts`.
There is no `expansion_committee` department type, no spawn path, no
teardown, no quota row, no tool grant. The Committee is a function, not
an agent.

## What "packet" means here

By Phase 12d, three of the four departments in this pipeline already
compile a locked, versioned report on demand:
`compileResearchReport()` (7a/7b), `compileFinanceReport()` (9e), and
`compileStrategyReport()` (12d). The fourth — Opportunity Intelligence
— never got its own `compile*Report()` because it never needed one:
its structured output already lives directly on the `opportunities` row
itself (`title`, `thesis`, `roi_score`, `factors`, `tags` — Phase 3),
read via the same `getOpportunity()` every other route in this file
already calls. 13b's own "four-report bundle" wording is read literally
here: Opportunity Intelligence's report *is* the opportunity row, and
this session's packet treats it as a first-class fourth section
alongside the other three, not as separate framing metadata.

## How it's built

`assembleCommitteePacket(opportunityId)` does exactly what 13a's own
line says and nothing more:

1. Look up the opportunity. Unknown id → throw, same "fail fast with a
   clear message" posture every `compile*Report()` function in this
   file already uses.
2. Call `compileResearchReport()`, `compileFinanceReport()`, and
   `compileStrategyReport()` for that same id.
3. Bundle all four into one object with an `assembledAt` timestamp.

Nothing is written. Nothing is persisted — there is no
`committee_packets` table; a packet is recomputed fresh on every call
from whatever the four source tables (`opportunities`,
`research_findings`, `finance_findings`, `strategy_findings`)
currently hold, the same "current state, not a stored snapshot" posture
each of the three `compile*Report()` functions it delegates to already
takes toward its own findings table. Calling this function twice in a
row with nothing written in between returns two packets identical
except for `assembledAt`.

No completeness gate. A known opportunity where Research, Finance, and
Strategy have all run zero tools still assembles into a packet — every
section reads back its own all-null report, exactly as if a caller had
hit that department's GET route directly today. Whether an incomplete
packet is fit for the CEO to actually rule on is explicitly 13e's own
future job, not this function's; 13a's own line describes assembly, not
gating.

## What shipped

- **`backend/src/expansion.ts`**, new Phase 13a section (end of file):
  - `CommitteePacket` — `{ opportunityId, assembledAt,
    opportunityIntelligence, researchReport, financeReport,
    strategyReport }`. Not yet a locked/versioned contract the way
    `StrategyReport`/`FinanceReport`/`ResearchReport` are — no
    `COMMITTEE_PACKET_SCHEMA_VERSION`, no
    `validateCommitteePacketShape()`. That lock-down is 13b's own
    deliverable ("Committee packet schema: the exact four-report
    bundle the CEO will see, versioned...").
  - `assembleCommitteePacket(opportunityId)` — the pure read described
    above.
- **`backend/src/__tests__/expansionCommitteePacketAssembly.test.ts`**
  — new file, same inlined-mirror convention every other
  `expansion*.test.ts` file here uses (no live better-sqlite3 in this
  environment). Covers: unknown opportunity id throws; all four
  sections present on a freshly-scored opportunity with nothing
  researched/financed/strategized yet; no completeness gate (a
  partial pass with only one department filed still assembles); a
  fully-worked opportunity's packet reflects all three departments'
  latest findings together; the assembly is a pure read (no rows
  written, same content on repeat calls apart from `assembledAt`); one
  department being unfiled doesn't blank out another's already-filed
  section.

## What's deliberately NOT here yet

- **No versioned packet schema / shape validator.** 13b's job.
- **No disagreement surfacing** (Finance's sizing vs. Strategy's fit
  score pointing opposite directions). 13c's job — reads this packet's
  `financeReport`/`strategyReport` sections once they exist, not
  computed by this function.
- **No `GET /expansion/opportunities/:id/committee-packet` route.**
  13d's job, same "assembly now, HTTP surface once the shape is locked"
  ordering 7a→7c and 12d→12e already took.
- **No completeness gate.** 13e's job, explicitly deferred above.
- **No scheduler.ts registration.** 13a's own wording calls this "a
  scheduled read," but nothing in Zent.md's Phase 13 gives it its own
  cadence line the way 3d's Top-N selection got
  (`expansion_top_n_selection`, 2-minute interval via
  `runOnScheduleWithLease()`). Reading this the same way 7a/9e/12d's
  own compile functions are read — as on-demand reads a caller (a
  route, the CEO's own tool call) invokes when it needs a packet,
  not a background job that runs unprompted — is the more literal fit:
  nothing in this pipeline needs a *stale* committee packet sitting
  around, and the CEO gate (Phase 15) is what actually decides when a
  packet is worth assembling. If a later phase wants a
  proactively-refreshed packet cache, that's a new decision to make
  then, not one this session makes on 13a's behalf.

No human-in-the-loop step anywhere in this path, same as every other
phase in this pipeline: assembly is a plain function call any part of
the agent-executed pipeline (a department, the CEO's own tool
call, the eventual committee-packet route) can invoke on its own,
with no operator gate in front of it.
