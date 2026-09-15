# Zent.md Phase 15a — CEO Decision Layer: decide_expansion

Deliverable per Zent.md:

> 15a. CEO role clarified in code as the top-level agent itself (not a
> new department) acting on a specific tool call,
> decide_expansion(opportunity_id, decision, notes) — the CEO does not
> invent opportunities, only rules on packets, matching the chat spec
> exactly.

## What was already there

`recordExpansionDecision()`/`getExpansionDecision()`/`listExpansionDecisions()`/
`getLatestExpansionDecision()` (Phase 1d) and the `expansion_decisions`
table already existed, explicitly documented as "the data-access
primitive, not Phase 15's decide_expansion() tool." `requireCompleteCommitteePacket()`
(13e) and `requireLockedCommitteePacket()` (14a) were both built ahead
of their own caller, each naming this not-yet-built decide_expansion
route as that intended caller in their own header comments.

## What this session built

`decideExpansion(opportunityId, decision, decidedBy, notes)` in
`expansion.ts` — the actual tool. It:

- Validates `decision` against the same `VALID_DECISIONS` (1d) already
  used by `recordExpansionDecision()`.
- Requires a non-empty `decidedBy` — the CEO is the top-level agent
  acting on a tool call, not an anonymous ruling.
- Gates on a new `requireDecidableCommitteePacket()`, which composes
  `requireLockedCommitteePacket()` (13e completeness + 14a deliberation
  lock) with one further condition this session added: Phase 14d's own
  `votingRecord.readyForDecision`. A packet can be complete and locked
  while a department's 14b vote is still outstanding and hasn't timed
  out — those are three independent gates, and decide_expansion is
  where Zent.md's "the CEO does not invent opportunities, only rules on
  packets" finally requires all three to hold at once. 14d's own
  timeout logic is what keeps this from stalling a packet forever —
  once the deadline passes, an unresponsive department reads back
  `no-response` and the gate clears.
- Snapshots the packet's own bundle-level verdicts
  (`financeStrategyDisagreement`, `completeness`, `deliberation`,
  `votingRecord`) plus the `notes` argument into `expansion_decisions.
  committee_votes` — that column's shape was deliberately left unlocked
  back in Phase 1d for exactly this kind of later addition, so `notes`
  (which has no column of its own) rides inside the same JSON blob
  rather than requiring a schema migration.
- Records exactly one `ExpansionDecision` row via the existing
  `recordExpansionDecision()`, unchanged.

Deliberately NOT in this session's scope (each is its own later
sub-phase, same one-focused-deliverable-per-letter discipline this
pipeline has followed since Phase 1):

- **15b** — the calling `agent_address` must match the top-level agent
  that owns this opportunity's pipeline. That's an HTTP-route
  authorization check (`expansionRoutes.ts`'s `POST
  /expansion/opportunities/:id/decide`), not this function's — same
  split every other write in this file draws between a data/tool-layer
  function and the route in front of it (`setOpportunityStatus` (4c),
  `recordDepartmentVote` (14b)).
- **15c** — `deferred`'s re-queue semantics. Nothing special happens
  here beyond recording `deferred` as the newest ruling; calling
  `decideExpansion()` again later for the same `opportunityId`, without
  anything upstream re-running, is what a re-queued ruling looks like
  at this layer.
- **15d** — `approved` firing genesis (spawning Agent B). This
  function's job stops at recording the ruling.
- **15e** — the full audit-trail bundle endpoint. `listExpansionDecisions()`/
  `getExpansionDecision()` (1d) already expose the raw history this
  function writes into; presenting it as one bundle is 15e's own job.

No changes to `db.ts` (the `expansion_decisions` table already had
everything this needed) or to `expansionRoutes.ts` (no route yet — that
is 15b).

## Tests

`expansionCeoDecision.test.ts` — new file, same "no live better-sqlite3
in this environment" in-memory-mirror convention every other
`expansion*.test.ts` file in this directory already uses. Covers:
unknown-opportunity (never invents one), each of the three composed
gates failing independently (missing reports / unlocked deliberation /
pending vote), a timed-out vote NOT blocking the ruling, the
happy-path snapshot (notes trimmed, voting record attached), notes
being optional, `deferred` followed by a later `approved` recording as
two history rows, an invalid decision value, a missing `decidedBy`, and
a disagreement-path vote still deciding cleanly.

## Phase 15b — POST /expansion/opportunities/:id/decide

Deliverable per Zent.md:

> 15b. `POST /expansion/opportunities/:id/decide` — writes
> `expansion_decisions`, requires the calling agent_address to match
> the top-level agent that owns the whole pipeline (no other agent can
> approve another's expansion).

This session added the route itself in `expansionRoutes.ts`, plus two
small exported helpers in `expansion.ts` the route needed to
pre-validate `decision` the same way 14c's own fix pre-validates
`vote`/`conditions`: `CEO_DECISIONS` (the public form of 1d's private
`VALID_DECISIONS`) and `isValidCeoDecision()` — same "readonly array +
type + isValid*() guard" shape `VOTE_DEPARTMENTS`/`VOTE_VALUES` and
`isValidVoteDepartment()`/`isValidVoteValue()` already give 14b's own
fields.

The route:

- Pre-validates `agentAddress`, `decision`, and `notes` into named
  400s, so a malformed request never reaches `decideExpansion()`'s own
  throw.
- Resolves `opportunity -> its report -> report.agent_address`, the
  same ownership chain every other write route in this file already
  enforces, and 403s when the caller's `agentAddress` doesn't match —
  this IS Zent.md 15b's "requires the calling agent_address to match
  the top-level agent that owns the whole pipeline (no other agent can
  approve another's expansion)": that report row, created back in
  Phase 1a/2a, is what "the top-level agent that owns the whole
  pipeline" means at the data layer, since every department report and
  finding hanging off this opportunity traces back to that same
  report.
- Calls `decideExpansion()` (15a) only once ownership is confirmed, and
  maps a gate failure (13e incomplete / 14a not locked / 14d vote still
  pending) to a 409 — a real state precondition, not a malformed
  request or a server fault — matching `setOpportunityStatus()`'s own
  invalid-transition 409 on `/opportunities/:id/status`.
- Returns `{ opportunityId, decision, packet }` on success — the
  recorded `ExpansionDecision` row plus the exact `CommitteePacket` it
  was ruled against, same "hand back what was actually acted on"
  posture the vote route already gives its own caller.

No changes to `db.ts` — nothing about the schema needed to change for
the route itself.

### Tests

`expansionCeoDecisionRoute.test.ts` — new file, route-level counterpart
to `expansionCeoDecision.test.ts` the same way `expansionVoteRoutes.test.ts`
(14b/14c/14d) is the route-level counterpart to
`expansionDeliberation.test.ts`'s function-level mirror. Covers: bad
opportunity id, missing `agentAddress`, invalid `decision`, non-string
`notes`, unknown opportunity (404), a non-owning agent rejected with
403 (Zent.md 15b's own "no other agent can approve another's
expansion" — asserted by name, and asserted that nothing was recorded
for the rejected caller), a not-ready packet surfacing as a named 409
rather than a 500, and the happy path for both `approved` (with notes)
and `deferred`.

## Consistent with Zent.md's own closing note

Per Zent.md's own "Notes on scope" section: there is no
human-in-the-loop step anywhere in this pipeline. `decide_expansion` is
called by the top-level agent itself, ruling on a packet its own
departments assembled — no operator gate sits between the packet and
the ruling, and none is added here.
