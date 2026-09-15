# Zent.md Phase 15c — CEO Decision Layer: approved / rejected / deferred handling

Deliverable per Zent.md:

> 15c. `approved` / `rejected` / `deferred` handling: `deferred` re-queues
> for a later CEO tick without re-running the departments (cheap
> re-review, not a full re-run).

## What was already there

15a's `decideExpansion()` and 15b's `POST /expansion/opportunities/:id/decide`
recorded whichever `CeoDecision` the caller passed with no distinction
between the three values beyond validating it was one of them. 15a's own
header explicitly punted on this: "Nothing special happens here for
`deferred` beyond recording it as this opportunity's newest ruling —
calling decide_expansion again later for the same opportunityId, without
anything upstream re-running, IS what a re-queued ruling looks like at
this layer." That's true, but it was also true for `approved` and
`rejected` — nothing stopped a second `decideExpansion()` call from
recording a contradicting ruling on an opportunity the CEO had already
approved or rejected. Without a real distinction, `deferred`'s "stays
open for another ruling" and `approved`/`rejected`'s "this is final" were
the same code path.

## What this session built

**Finality gate.** `CEO_TERMINAL_DECISIONS` (`["approved", "rejected"]`)
and `isTerminalCeoDecision()`, exported alongside `CEO_DECISIONS`/
`isValidCeoDecision()` (15a/15b) with the same "readonly array + type +
`isValid*()` guard" shape. `decideExpansion()` now reads the opportunity's
latest ruling via `getLatestExpansionDecision()` (1d) before doing
anything else: if that ruling is terminal, it throws a named error
("opportunity ... already has a final CEO ruling (...) — decide_expansion
cannot rule on it again") instead of recording a second one. If the
latest ruling is `deferred` (or there isn't one yet), the call proceeds
into the existing `requireDecidableCommitteePacket()` gate exactly as
before — this *is* the "cheap re-review, not a full re-run" Zent.md
describes: it re-checks completeness/deliberation/voting-record state,
never re-runs Research/Finance/Strategy.

The finality check runs before the packet-readiness gate, so a re-ruling
attempt on an already-decided opportunity fails with a clear "already
decided" message rather than an incidental packet-shape complaint (and
avoids the (admittedly harmless) extra work of re-assembling a packet
that's about to be rejected anyway).

**`rejected` closes out the opportunity's own status.** Previously a
CEO-rejected opportunity kept whatever `OpportunityStatus` it already had
(almost always `'selected'`) forever — nothing but a row in
`expansion_decisions` showed it had been ruled on. `decideExpansion()` now
calls the existing `setOpportunityStatus(opportunityId, "reject")` (4c)
after recording a `rejected` ruling, so a CEO-rejected opportunity reads
identically downstream (`GET /opportunities`, 3d's scheduled sweep, any
other status-based read) to one an agent rejected directly through 4c's
own action endpoint. This call is always safe: `OPPORTUNITY_TRANSITIONS`
already allows both `open -> rejected` and `selected -> rejected`, and
`setOpportunityStatus()` is a same-status no-op if the opportunity is
somehow already `'rejected'`.

**`approved` deliberately does NOT touch status.** The opportunity stays
`'selected'` after an approved ruling — Phase 16's genesis path is what
actually retires it (spawning Agent B). Adding a fourth `OpportunityStatus`
value for "approved" was considered and rejected: the existing header
comment on `OpportunityAction`/`OPPORTUNITY_TRANSITIONS` (4c) is explicit
that the three-value status union is intentional, not a spot to bolt a
fourth state onto. Finality for `approved` lives entirely in the
decisions-table check above, not in `Opportunity.status`.

## Tests

Both `expansionCeoDecision.test.ts` (15a) and `expansionCeoDecisionRoute.test.ts`
(15b) got their in-memory mirrors updated with the same finality gate and
`rejected -> status` wiring, plus a new "Phase 15c" block of tests in
each:

- `expansionCeoDecision.test.ts`: approved-then-approved throws and
  records nothing on the second attempt; rejected-then-approved throws
  the same way; a `rejected` ruling flips the mirrored opportunity's
  status; an `approved` ruling leaves status untouched; `deferred` can
  repeat across multiple ticks before a terminal ruling closes it out,
  after which a further call is refused.
- `expansionCeoDecisionRoute.test.ts`: the route maps a re-decision
  attempt on an already-approved opportunity to a named 409 (not a 500),
  and the refused attempt records nothing; a `rejected` ruling through the
  route flips `FakeOpportunity.status`; `deferred` remains re-decidable
  through the route across several calls, and the eventual `approved`
  leaves status alone.

One pre-existing 15a test ("notes is optional — omitted or blank both
read back as null") called `decideExpansion(..., "rejected", ...)` twice
against the same opportunity purely to exercise the omitted-vs-blank
`notes` cases — that's now an illegal re-decision under 15c's finality
gate, so it was split across two separate opportunities (`opp_1`/`opp_2`)
rather than removed; the notes-handling behavior it tests is unchanged.

Both files were run directly (`node --experimental-strip-types --test
...`) against this environment's Node 22 runtime, same "no live
better-sqlite3 in this environment" reasoning every other
`expansion*.test.ts` file in this directory already gives for why they're
inlined mirrors rather than exercising the real `expansion.ts`/
`expansionRoutes.ts` against a live DB:

```
expansionCeoDecision.test.ts:      16 pass, 0 fail
expansionCeoDecisionRoute.test.ts: 12 pass, 0 fail
```

Recommend re-running against the real `expansion.ts`/`expansionRoutes.ts`
(e.g. supertest against the mounted router, real better-sqlite3) once a
networked environment with `npm install` available is on hand — this
session's `tsc --noEmit` pass against the actual source turned up no new
type errors beyond this repo's existing pre-`npm install` baseline
(missing `@types/node`, missing third-party module declarations).

## Deliberately NOT in this session's scope

- **15d** — `approved` firing genesis (`genesis_company()` / Phase 16).
  This session's `decideExpansion()` still stops at recording the ruling
  (and, for `rejected`, closing out status) — nothing here spawns Agent B.
- **15e** — the full audit-trail bundle endpoint.
  `listExpansionDecisions()`/`getExpansionDecision()` (1d) already expose
  the raw history `decideExpansion()` writes into (including every
  `deferred` tick along the way); presenting it as one retrievable bundle
  is 15e's own job, not this one's. No new HTTP routes were added this
  session for the same reason — decision history stays exposed only
  through the existing 1d data-access functions until 15e builds the
  route that presents it.

No changes to `db.ts` — nothing about `expansion_decisions` or
`opportunities`' schema needed to change; `setOpportunityStatus()` and
`getLatestExpansionDecision()` were both already exactly what this phase
needed.
