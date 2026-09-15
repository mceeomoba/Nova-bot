# Zent.md Phase 12e — Strategy Department: Reporting Interface

Deliverable per Zent.md:

> 12e. `GET /expansion/opportunities/:id/strategy` endpoint + shape test.

## Reading this against what's already shipped

Unlike 12a–12d, this line was already half-built before this session
started. 11e-iii-c pulled the GET route itself forward early ("shape
now, fields as their sources land" — same posture
`compileResearchReport()`/`compileFinanceReport()` took toward their
own sections before every one of them existed) so that Finance,
Strategy's own fit-score tool, and the future committee packet would
have somewhere to read a strategy report from well before Phase 12's
ecosystem-health tools existed. 12d then filled in the three sections
12a–12c had been leaving null (`ecosystemStrengthening`,
`cannibalizationCheck`, `relationshipTypeRecommendation`), bumping
`STRATEGY_REPORT_SCHEMA_VERSION` to `"12d-v1"`.

So by the time this session started:

- `GET /opportunities/:id/strategy` (`expansionRoutes.ts`) already
  existed, already called `compileStrategyReport()` +
  `validateStrategyReportShape()`, and already returned all twelve
  `12d-v1` fields — no route or handler code needed to change.
- `expansionStrategyReportShape.test.ts` already existed and already
  covered the full `12d-v1` field set at the `validateStrategyReportShape()`
  level (the schema/shape half of 12e's own checklist line).

What was missing was the other half every prior GET endpoint in this
pipeline got its own dedicated coverage for:
`expansionResearchReportGet.test.ts` (7c) exercises the *route
handler* itself — bad-id/not-found/happy-path/no-ownership-gate — as a
file distinct from `expansionResearchReportShape.test.ts` (7b/7e)'s
pure-validator coverage. Strategy had the validator-level file but not
the handler-level one. This session is that missing file.

## What shipped

- **`backend/src/__tests__/expansionStrategyReportGet.test.ts`** — new
  file, the Strategy counterpart to `expansionResearchReportGet.test.ts`.
  Same "no live better-sqlite3/express in this environment" convention
  every other `expansion*.test.ts` file in this directory already uses:
  an inlined mirror of `compileStrategyReport()`,
  `validateStrategyReportShape()`, `sendCompiledStrategyReport()`, and
  the `GET /opportunities/:id/strategy` handler's own existence check,
  exercised against a fake Express response and in-memory
  opportunities/strategy-findings maps rather than a real router.
  Covers:
  - unknown opportunity id → 404 with a named error, not a thrown
    exception;
  - malformed id (doesn't start with `opp_`) → 400 before any lookup,
    mirroring `looksLikeOpportunityId()`'s own routing rule in
    `expansionRoutes.ts`;
  - a known opportunity with nothing strategized yet → 200, all twelve
    fields present, the seven nullable sections all `null`;
  - 11e-iii-c's own requirement restated concretely: `fitScore` and
    `fitRoiDivergence` come back as populated top-level fields once
    `score_strategy_fit` has run;
  - 12d's three added sections (`ecosystemStrengthening`,
    `cannibalizationCheck`, `relationshipTypeRecommendation`) come back
    populated once their respective tools have filed a finding,
    alongside a non-null `findingId` reflecting the latest version;
  - no `agentAddress` / ownership gate on this route at all — same
    plain-read posture 7c's own GET `/research` takes, unlike every
    Phase 5/6/11/12 *write* route in this file;
  - the HTTP-boundary shape re-check inside `sendCompiledStrategyReport()`
    would 500 with a named reason rather than silently 200 a
    schema-violating body.
- **No changes to `expansion.ts` or `expansionRoutes.ts`.** Both
  already matched 12e's own spec exactly; this session only closes the
  test-coverage gap 12e's checklist line asks for.

## What's deliberately NOT here

- No new endpoint, no new route. `GET /opportunities/:id/strategy`
  is 11e-iii-c's route, unmodified.
- No change to `STRATEGY_REPORT_SCHEMA_VERSION` or the field list —
  still `"12d-v1"`, still the twelve fields 12d locked in.
- No human/operator step introduced anywhere in this path. Per
  Zent.md's own closing note, every route in this pipeline —
  including this plain-read one — has no human-in-the-loop gate; this
  session doesn't change that posture, it just proves the read side of
  it behaves correctly under test.
