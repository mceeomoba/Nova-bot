# Zent.md Phase 13e — Expansion Committee: Packet Completeness Gate

Deliverable per Zent.md:

> 13e. Packet completeness gate: cannot assemble until all three reports
> exist; a `high_regulatory_risk` tag is surfaced prominently in the
> packet rather than blocking assembly.

## Reading this against what already existed

Taken completely literally, "cannot assemble until all three reports
exist" would mean `assembleCommitteePacket()` (13a) itself should start
throwing on a partial packet. It doesn't, on purpose. That function's
own header has said since 13a that whether a packet is fit for a
decision is "13e's completeness gate's question, not this function's,"
and the 13d GET route's own header says the same about itself. Both of
those postures are load-bearing for existing callers — a caller (a
dashboard, a human glancing at an in-flight opportunity) can inspect a
partial packet at any point in the pipeline, not only once all three
departments have filed. Reinterpreting either primitive now would break
that for everyone already relying on it.

So this phase splits into two pieces instead of one:

1. **A completeness verdict, attached to every packet.** Every
   `CommitteePacket` now carries a `completeness` field
   (`CommitteePacketCompleteness`) computed fresh on every
   `assembleCommitteePacket()` call, the same "recomputed from current
   state on every call" posture 13c's `financeStrategyDisagreement`
   already has. This is informative on a plain read (13d's GET route
   picks it up automatically, no route changes needed) and is the input
   the actual gate below is built on.

2. **A gate that actually enforces it.** `requireCompleteCommitteePacket()`
   is a new, separate, narrower function: it calls the unchanged
   `assembleCommitteePacket()` and throws — naming exactly which
   department(s) are still outstanding — when `completeness.complete` is
   false. This is the thing that actually delivers "cannot [proceed]
   until all three reports exist." Its intended caller is Phase 15's
   `decide_expansion` route, which doesn't exist yet; nothing in this
   pipeline calls it today, the same "built ahead of its own caller"
   posture other not-yet-wired Phase 13 primitives already follow.
   `assembleCommitteePacket()` and the 13d GET route are both
   unchanged — they keep calling the primitive directly, not this new
   gate.

Regulatory risk is answered by the same `completeness` object, not by
blocking anything: `highRegulatoryRisk` mirrors whether
`HIGH_REGULATORY_RISK_TAG` (6e) is present on the opportunity's own
tags. It's read here, not recomputed — 6e's own
`applyRegulatoryRiskEscalation()` is the one place that tag is ever
written. It has no bearing on `complete` or `missingReports` in either
direction: a fully-reported opportunity that's also tagged
`high_regulatory_risk` is `complete: true` with `highRegulatoryRisk:
true`, and an under-reported one is `complete: false` whether or not
it's high-risk. "Surfaced prominently" is delivered by lifting the flag
out of the two places a reader would otherwise have to know to dig
(`opportunityIntelligence.tags`, or
`researchReport.regulatoryRisk.riskLevel`) onto one top-level boolean —
the same "top-level, not buried" treatment `financeStrategyDisagreement`
(13c) already gives Finance/Strategy's own tension.

## How it's built

- **`expansion.ts`**:
  - `CommitteePacketCompleteness` interface — `complete: boolean`,
    `missingReports: readonly ("research" | "finance" | "strategy")[]`,
    `highRegulatoryRisk: boolean`.
  - `computeCommitteePacketCompleteness(packet)` — pure function reading
    `researchReport.findingId` / `financeReport.findingId` /
    `strategyReport.findingId` (each `null` exactly when that
    department hasn't filed anything yet, per those reports' own
    existing contracts) plus `opportunityIntelligence.tags`. No DB
    access, same posture `computeFinanceStrategyDisagreement()` (13c)
    already takes toward its own two report inputs.
  - `requireCompleteCommitteePacket(opportunityId)` — calls
    `assembleCommitteePacket()`, throws a named-missing-department error
    when incomplete, otherwise returns the packet unchanged.
  - `CommitteePacket` gains a `completeness` field (required object,
    never null — same contract every other bundle-level section
    already has). `COMMITTEE_PACKET_FIELDS` and
    `COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS` both updated to include
    it.
  - `COMMITTEE_PACKET_SCHEMA_VERSION` bumped `"13c-v1"` → `"13e-v1"` — a
    real bundle-shape change (new top-level key), same trigger 13c's own
    bump used.
  - `assembleCommitteePacket()` now also computes and attaches
    `completeness`, same "recomputed fresh, never stored" posture as
    `financeStrategyDisagreement`. Everything else about that function
    (its own unknown-opportunity throw, its own tolerance for partial
    reports, its own internal shape self-check) is unchanged.
  - `validateCommitteePacketShape()` unchanged in logic — it already
    drives its required-object check off
    `COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS`, so adding `completeness`
    to that list was sufficient; no new branches needed.
- **`expansionRoutes.ts`** — no behavior change. The 13d GET route's own
  header comment updated to say explicitly that it keeps calling
  `assembleCommitteePacket()` directly rather than this phase's new
  gate, and that a partial packet's `completeness.complete` will now
  read back `false` (naming what's missing) rather than the reader
  having to infer it from null sections.
- **Tests**:
  - `expansionCommitteePacketShape.test.ts` (13b/13c → 13e) — adds
    `completeness` to the locked field list and the required-object
    list, bumps the schema-version literal, adds a fixture default, and
    adds coverage that a garbage-but-present `completeness` object still
    passes at the bundle level (this function doesn't recurse into it,
    same boundary already drawn for the other four sections).
  - `expansionCommitteePacketAssembly.test.ts` (13a/13b/13c → 13e) —
    mirror's `assembleCommitteePacket()` now also computes and attaches
    `completeness`; mirror's `FakeOpportunity` gains `tags: string[]`.
    New coverage: nothing filed → all three missing; partial fill →
    only the outstanding ones named; full fill → complete with no
    missing reports; a `high_regulatory_risk` tag surfaces on
    `completeness` without changing `complete`/`missingReports` either
    way (both a complete-and-high-risk and an incomplete-and-high-risk
    opportunity are exercised); `requireCompleteCommitteePacket()`
    itself — throws naming the missing department(s), returns the
    packet once complete, doesn't throw on regulatory risk alone, still
    throws on regulatory risk plus a real gap, and propagates the
    unknown-opportunity error un-caught.
  - `expansionCommitteePacketGet.test.ts` — mirror's constants/schema
    version updated to match; route behavior itself untouched, so no
    new route-level test cases were needed (13e adds no new HTTP
    surface).
  - `expansionCommitteePacketCompleteness.test.ts` — new file, the
    completeness counterpart to `expansionFinanceStrategyDisagreement.test.ts`
    (13c). Exercises `computeCommitteePacketCompleteness()`'s own
    arithmetic and `requireCompleteCommitteePacket()`'s own gating logic
    directly against hand-built fixtures, independent of real assembly
    (which is `expansionCommitteePacketAssembly.test.ts`'s job).

## What's deliberately NOT here yet

- **Nothing calls `requireCompleteCommitteePacket()` yet.** Its caller
  is Phase 15's `decide_expansion` route, which hasn't been built. This
  phase delivers the gate; wiring it into a decision path is Phase 15's
  own job.
- **The 13d GET route is unchanged.** It keeps returning a packet for
  any known opportunity regardless of `completeness.complete`, exactly
  as before — a reader now sees a `completeness` field telling them
  what's missing, but nothing about the route's status codes or
  ownership checks changed.
- **No new config.** Unlike 13c's `fitScoreDirectionMidpoint`, this
  phase has no tunable threshold — completeness is a strict
  all-three-or-not check with no midpoint to configure.
