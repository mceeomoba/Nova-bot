# Zent.md Phase 13b — Expansion Committee: Packet Schema

Deliverable per Zent.md:

> 13b. Committee packet schema: the exact four-report bundle the CEO
> will see, versioned so later CEO models don't need every department
> to re-run when the packet format changes.

## How it's built

Same "exact field set, versioned, runtime-checked" contract every other
compiled report in this pipeline already gets
(`RESEARCH_REPORT_FIELDS`/`RESEARCH_REPORT_SCHEMA_VERSION`,
`FINANCE_REPORT_FIELDS`/`FINANCE_REPORT_SCHEMA_VERSION`,
`STRATEGY_REPORT_FIELDS`/`STRATEGY_REPORT_SCHEMA_VERSION`), applied to
13a's `CommitteePacket` bundle:

- **`COMMITTEE_PACKET_SCHEMA_VERSION = "13b-v1"`** — a new, independent
  version tag. Independent deliberately: bumping any one department's
  own report schema in the future (say, a new `ResearchReport` field)
  does not require bumping this constant. This version only tracks the
  bundle's own shape — which four top-level keys it has, in what order,
  each required or nullable — not what's inside each nested report.
  Each nested report keeps versioning itself via its own
  `schemaVersion` field; a CEO model can tell "packet format changed"
  apart from "one department's report format changed" by checking the
  right field at the right layer.
- **`COMMITTEE_PACKET_FIELDS`** — the locked seven-key list:
  `opportunityId`, `assembledAt`, `schemaVersion`,
  `opportunityIntelligence`, `researchReport`, `financeReport`,
  `strategyReport`.
- **`validateCommitteePacketShape()`** — checks the object has exactly
  those seven keys (no more, no fewer), `opportunityId` is a non-empty
  string, `assembledAt` is a number, `schemaVersion` matches exactly,
  and — this is where CommitteePacket's own contract genuinely differs
  from Strategy's/Finance's/Research's — the four report sections are
  each **required objects, never null**, not "object or null" the way
  each nested report's own internal sections are. That distinction is
  real, not cosmetic: `assembleCommitteePacket()` always calls
  `getOpportunity()` plus all three `compile*Report()` functions, and
  each of those either returns a populated object or throws — there is
  no legitimate "hasn't run yet, so this whole section is absent" state
  at the packet level the way there is at the finding level inside each
  report.
- **Deliberately does NOT recurse.** `validateCommitteePacketShape()`
  checks the bundle's own contract only — it does not re-validate
  `researchReport` against `RESEARCH_REPORT_FIELDS`, etc. Each nested
  report already self-checks inside its own `compile*Report()` (and
  throws there, before `assembleCommitteePacket()` ever sees a bad one)
  — re-checking a second time here would just re-prove something
  already guaranteed by the time this function runs. This mirrors the
  "trust the one chokepoint" reasoning `assembleCommitteePacket()`'s
  own header already gives for not re-validating those three calls.
- **`assembleCommitteePacket()` now self-checks** before returning,
  same "enforcement, not decoration" posture
  `compileResearchReport()`/`compileFinanceReport()`/
  `compileStrategyReport()` each already take toward their own locked
  shape — can never fail today (the packet is built from
  `COMMITTEE_PACKET_FIELDS` by construction), exists so a future drift
  fails loud at the one chokepoint every caller already goes through.

## What shipped

- **`backend/src/expansion.ts`** — `CommitteePacket` gained a
  `schemaVersion` field; new `COMMITTEE_PACKET_SCHEMA_VERSION`,
  `COMMITTEE_PACKET_FIELDS`, `COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS`,
  and `validateCommitteePacketShape()`; `assembleCommitteePacket()`
  stamps the new field and self-checks its own output before returning.
- **`backend/src/__tests__/expansionCommitteePacketShape.test.ts`** —
  new file, the CommitteePacket counterpart to
  `expansionResearchReportShape.test.ts`/`expansionFinanceReportShape.test.ts`/
  `expansionStrategyReportShape.test.ts`. Same inlined-mirror, no-live-DB
  convention; 13 tests covering the happy path (both minimal and
  fully-populated nested reports), the four report sections being
  required-never-null (the packet-level contrast with each nested
  report's own nullable sections), exact field-set enforcement
  (missing/extra/renamed fields), scalar type checks, exact
  `schemaVersion` matching, and — explicitly — that this validator does
  NOT recurse into validating each nested report's own internal
  contract (a garbage-but-present `researchReport` object still passes
  at the bundle level, by design).
- **`backend/src/__tests__/expansionCommitteePacketAssembly.test.ts`**
  (13a's own file) — updated so its `assembleCommitteePacket()` mirror
  also stamps `schemaVersion: "13b-v1"`, matching the real function's
  new output; that file's own assertions were never field-set-exact
  (see its own header), so this is the only change it needed.

## What's deliberately NOT here yet

- **No disagreement surfacing** (Finance's sizing vs. Strategy's fit
  score pointing opposite directions). 13c's job.
- **No `GET /expansion/opportunities/:id/committee-packet` route.**
  13d's job, same "lock the shape, then expose it" ordering
  7a/7b→7c and 12d→12e already took.
- **No completeness gate.** 13e's job — a packet with one or more
  nested reports still all-null is still `13b-v1`-shape-valid; whether
  it's *fit for the CEO to rule on* is a separate question 13e answers.

No human-in-the-loop step anywhere in this path, same as every other
phase in this pipeline.
