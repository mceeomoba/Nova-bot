# Zent.md Phase 13d — Expansion Committee: Route

Deliverable per Zent.md:

> 13d. `GET /expansion/opportunities/:id/committee-packet`.

## How it's built

Same "plain read, no request body, no agentAddress, no ownership check
beyond the shared `BACKEND_API_KEY` middleware" posture every other
opportunity-scoped GET route in this router already takes (7c's GET
`/research`, 10a's GET `/finance`, 12e's GET `/strategy`) — this route
is the thinnest possible wrapper around 13a/13c's `assembleCommitteePacket()`
and 13b/13c's `validateCommitteePacketShape()`, both already fully
built and already self-checking internally.

- `backend/src/expansionRoutes.ts`:
  - Imports `assembleCommitteePacket`, `validateCommitteePacketShape`,
    `COMMITTEE_PACKET_SCHEMA_VERSION` from `expansion.ts`.
  - `router.get("/opportunities/:id/committee-packet", ...)` — same
    bad-id (400) / not-found (404) checks every other GET route in this
    file already runs before delegating to its own `sendCompiled*`
    helper, here `sendCommitteePacket()`.
  - `sendCommitteePacket(id, res)` — assembles the packet, re-verifies
    it against its own locked shape a second time at the HTTP boundary
    (belt-and-braces, same as `sendCompiledResearchReport()`/
    `sendCompiledFinanceReport()`/`sendCompiledStrategyReport()` already
    do toward their own compile calls — `assembleCommitteePacket()`
    already self-checks once internally too), and responds with
    `{ opportunityId, schemaVersion, packet }`.
  - No new route is needed in `index.ts` — this router was already
    mounted at `/expansion` back in Phase 2b; the new route is reachable
    the moment it's added to this file.
- `backend/src/__tests__/expansionCommitteePacketGet.test.ts` — new
  file, the committee-packet counterpart to
  `expansionResearchReportGet.test.ts` (7c) /
  `expansionStrategyReportGet.test.ts` (12e). Covers: unknown id → 404;
  malformed id → 400 before any lookup; a freshly-scored opportunity
  with nothing filed by any department still returns 200 with all
  sections present (including 13c's `financeStrategyDisagreement`,
  non-diverging with null directions); no completeness gate (a partial
  pass still returns 200, matching `assembleCommitteePacket()`'s own
  no-gate posture — 13e's job, not this route's); a real Finance-vs-
  Strategy disagreement and a real agreement both flow through the
  route correctly; no `agentAddress`/ownership gate on this read, same
  as every other GET route in the file; and the shape re-check at the
  HTTP boundary 500s with a named reason rather than silently accepting
  drift.

## What's deliberately NOT here yet

- **No completeness gate.** 13e's own job — a packet with one or more
  of Research/Finance/Strategy not yet filed still 200s through this
  route, exactly as `assembleCommitteePacket()` itself already tolerates.
- **No ownership/agentAddress check.** Deliberate, not an oversight —
  see this route's own header in `expansionRoutes.ts`: reading a report
  isn't gated the way writing one is anywhere in this file, and
  ownership enforcement for the *decision* that reads this packet lives
  at Phase 15's `decide_expansion` write route, not here.

No human-in-the-loop step anywhere in this path, same as every other
phase in this pipeline — this route only makes the packet (already
assembled by 13a/13c) reachable over HTTP; it doesn't add or remove who
gets to act on it.
