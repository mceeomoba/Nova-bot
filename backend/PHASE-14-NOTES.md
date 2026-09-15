# Zent.md Phase 14 — Expansion Committee: Deliberation

Deliverable per Zent.md:

> 14a. Optional deliberation pass: a lightweight cross-department
> exchange (each department gets to see the others' reports once and
> append a short rebuttal/concur) before the packet locks — off by
> default, enabled per-agent config.
> 14b. Vote/recommendation field per department: `recommend` /
> `recommend-with-conditions` / `do-not-recommend`, distinct from
> their numeric scores — forces a clear position.
> 14c. Conditions capture: "recommend, but cap initial funding at $X" is
> a first-class field the CEO gate can read, not free text to parse.
> 14d. Timeout handling: a department that doesn't respond within its
> budgeted ticks doesn't block the packet forever — it's marked
> `no-response` and the packet proceeds with that noted.
> 14e. Test: full four-department happy-path + one disagreement-path
> fixture.

## What was already there

14a (`isDeliberationEnabled`/`setDeliberationEnabled`/
`recordDeliberationResponse`/`getDeliberationExchange`) and 14b/14c/14d
(`recordDepartmentVote`/`listDepartmentVotes`/`getVotingRecord`, the
`department_votes` table, the `POST/GET .../vote(s)` routes) were
already fully implemented in `expansion.ts`/`expansionRoutes.ts`/
`db.ts`, and already wired into `CommitteePacket` — `deliberation` and
`votingRecord` are both required, non-null bundle fields, folded into
`COMMITTEE_PACKET_SCHEMA_VERSION` ("14d-v1", bumped from 14a's own
"14a-v1") the same way every prior bundle-level addition (13c's
`financeStrategyDisagreement`, 13e's `completeness`) bumped it before.
14e's own fixture — full four-department happy path plus a
disagreement path, plus dedicated 14c (conditions) and 14d (timeout)
coverage — was already present as the second half of
`expansionDeliberation.test.ts`.

## What this session closed

The gap was that three of this directory's committee-packet test files
— `expansionCommitteePacketShape.test.ts` (13b), the assembly mirror in
`expansionCommitteePacketAssembly.test.ts` (13a/13c/13e), and the
route-level mirror in `expansionCommitteePacketGet.test.ts` (13d) —
had each been updated through 13e but never through 14a or
14b/14c/14d, despite the real `expansion.ts` having moved on. Every one
of them still hardcoded `COMMITTEE_PACKET_SCHEMA_VERSION = "13e-v1"`
and a nine-field bundle, so a fixture built against any of them would
fail against the real, current `validateCommitteePacketShape()` (which
requires eleven fields at `"14d-v1"`) — exactly the kind of silent
bundle-shape drift this file's own family of tests exists to catch.

Brought current, following the same "copied verbatim, fixed stand-in
values for anything covered elsewhere" convention each of these files
already used for 13c/13e:

- **`expansionCommitteePacketShape.test.ts`**: `COMMITTEE_PACKET_FIELDS`
  / `COMMITTEE_PACKET_REQUIRED_OBJECT_FIELDS` now include `deliberation`
  and `votingRecord`; `basePacket()`'s fixture carries a disabled/empty
  deliberation exchange and an all-pending voting record; added
  "garbage-but-present passes at the bundle level" tests for both new
  fields, mirroring the existing `completeness` one.
- **`expansionCommitteePacketAssembly.test.ts`**: the local
  `assembleCommitteePacket()` mirror now attaches fixed
  `fixedDeliberation()`/`fixedVotingRecord()` stand-ins and stamps
  `"14d-v1"` — this file's own job stays proving the four *report*
  sections compose correctly through real findings, not re-covering
  14a/14b/14c/14d's own logic (that stays
  `expansionDeliberation.test.ts`'s job).
- **`expansionCommitteePacketGet.test.ts`**: same pattern at the route
  level — trimmed `getDeliberationExchange()`/`getVotingRecord()`
  mirrors feed the packet, and the "nothing filed yet" happy-path test
  now asserts both fields are present and read back their expected
  at-rest values (`locked: true`, `readyForDecision: false`).

No changes to `expansion.ts`, `expansionRoutes.ts`, or `db.ts` — 14a
through 14e's actual implementation was correct and complete; this was
purely closing test debt so the shape/assembly/route test suite
reflects the schema the real code has been producing since 14a landed.

## Follow-up session: 14c hardening + route-level test coverage

A second pass, specifically on 14c ("Conditions capture ... a
first-class field the CEO gate can read, not free text to parse"),
found one real gap: `POST /opportunities/:id/vote` pre-validated that
`conditions` was a string when present, but left the actual
vote/conditions *pairing* rule (required for
`recommend-with-conditions`, forbidden otherwise) to
`recordDepartmentVote()`'s own throw — which the route's generic
catch-all turns into an opaque `500`, not a named `400`. Every other
malformed-input case on this route (and on 14a's sibling deliberation
route) was already a clean `400`; this one wasn't.

Fixed by pre-validating the pairing in the route itself, matching the
`expansionRoutes.ts` convention 14a's own POST route already
established: a bad request should fail with a named `400` before ever
reaching the write function, not rely on that function's internal
guard as a fallback HTTP contract.

Also added `expansionVoteRoutes.test.ts` — until now, `POST
.../vote` and `GET .../votes` had no direct route-level test coverage
at all (only the underlying `recordDepartmentVote()`/
`listDepartmentVotes()`/`getVotingRecord()` functions were exercised,
via `expansionDeliberation.test.ts`'s 14b/14c/14d/14e section). The new
file covers both routes' bad-id/missing-field/ownership/not-found
paths, the 14c pairing fix specifically (three cases that would have
been silent 500s before the fix), and happy-path/disagreement-path
coverage matching 14e's own fixture requirement at the route level —
the same layer `expansionCommitteePacketGet.test.ts` (13d) already
covers for the packet GET route.

## Consistent with Zent.md's own closing note

Per Zent.md's own "Notes on scope" section: there is no
human-in-the-loop step anywhere in this pipeline. Casting a vote
(14b), attaching conditions (14c), and timing a department out (14d)
are all agent-executed reads/writes with no operator gate — the same
posture every earlier phase in this pipeline already takes, and
unchanged by this session's test-only work.
