# Zent.md Phase 18b — Ecosystem Registry & Identity: Tree View

Deliverable per Zent.md:

> 18b. `GET /ecosystem/:rootAgentAddress` — full tree view: root
> company, every pipeline-spawned sibling, mission, status, spawn date.

## What landed

**`backend/src/expansion.ts`**: `resolveCompanyMission()` split out of
`listExistingCompanies()`'s own `.map()` — same structural-then-
opportunity-derived resolution (Phase 17c / pre-17c fallback),
unchanged, now callable against a single row instead of only inline.
`listExistingCompanies()` itself has zero behavior change — same rows,
same order, same shape back. Needed because Phase 18b's root node can
itself be a pipeline-spawned company (see below) and has to resolve its
own mission the same way a child would, without a second copy of the
fallback logic to keep in sync.

**`backend/src/ecosystem.ts`** (new file): `buildEcosystemTree(rootAgentAddress)`
— recursive tree builder. For each node: `listExistingCompanies()` (11b)
for one level of children, filtered to `spawnReason === 'expansion_pipeline'`
only (an ordinary `spawn_clone` worker sharing the same `parent_address`
is not part of "the ecosystem" Zent.md means — see the file's own header
for the reasoning); `agents.genesis_activation_status` (17e-iv) for
whether the company is actually alive yet; `getLatestGenesisErc8004Registration()`
(18a, which already named this file by number as its intended reader)
for on-chain identity, if any was ever attempted. Returns `undefined`
for an unknown address (route turns that into 404), never throws for a
company that simply hasn't spawned anything yet (empty `children`).

**Root can be a pipeline-spawned company itself** — Phase 18e's own
"done when" names the case explicitly ("B's own eventual child, if B
itself becomes profitable and repeats the cycle"), which only makes
sense if calling this with B as `:rootAgentAddress` gives back B's real
mission/status, not just an anonymous container for B's children. Tested
directly (`ecosystemTree_test.ts`'s "pipeline-spawned company as ROOT"
case).

**Recursion depth guard**: `MAX_ECOSYSTEM_DEPTH = 25`, a plain safety
cap on this one read endpoint — NOT a stand-in for Phase 19a/19b's real
growth-rate and portfolio-spend guardrails, which don't exist yet
(Phase 19 is still ahead of 18 in the plan) and are the actual checks
against a runaway-*wide* ecosystem. This constant only stops a
pathological or cyclic `parent_address` chain from turning one GET into
an unbounded walk; hitting it marks the node `truncated: true` and
stops recursing there rather than 500ing.

**`backend/src/ecosystemRoutes.ts`** (new file): the one route,
`GET /ecosystem/:rootAgentAddress` -> `{ root: EcosystemNode }`, 404 on
unknown address. Read-only, no side effects, no write path at all —
same posture `expansionUiRoutes.ts`'s own header already documents for
this pipeline's other view surface, restated here because this one
carries private detail (mission text, genesis status, erc8004 outcome)
and so is mounted behind the shared `x-backend-key` check rather than
that file's public tier.

**`backend/src/index.ts`**: `ecosystemRouter` imported and mounted at
`/ecosystem`, directly after `expansionRouter` — behind the same
shared-secret middleware every route above that line already sits
behind.

**`backend/src/__tests__/ecosystemTree_test.ts`** (new file): mirrors
`buildEcosystemTree()`/`buildNode()`/`resolveCompanyMission()` against
in-memory stand-ins (same "no live better-sqlite3" constraint every
other `*_test.ts` file in this directory documents). Nine cases: unknown
root, empty-children root, a real three-generation tree (A -> B -> C,
Phase 18e's own case), ordinary clones excluded, both mission-resolution
paths, erc8004 present/absent, pipeline-spawned root resolving its own
mission/status, and depth-guard truncation (against a small test-local
cap, not the real 25). All nine pass under `node --experimental-strip-types --test`.

## What did *not* land (explicitly out of scope, left for later phases)

- No lineage-aware marketplace listing (18c) and no sibling-discovery
  tool for Agent B's own use at boot (18d) — this phase is the read-only
  external view only.
- No multi-generation registry *test against the real endpoint*
  (18e) — this phase's own test file covers the tree-building logic the
  route calls, but 18e as Zent.md names it is its own phase, presumably
  wired against the real HTTP surface once a live-db test harness exists
  for this repo (none of the existing `genesis*_test.ts`/this file's own
  test have one — see each one's header).
- No caching or pagination — a real portfolio deep or wide enough to
  need either is also deep/wide enough that Phase 19a/19b's guardrails
  (not yet built) should have stopped it from getting there in the first
  place; adding either here now would be optimizing for a shape of data
  this pipeline isn't supposed to be able to produce yet.

## No human override

Same posture as every other phase note in this pipeline: this is a
read-only view, so there was never a human-in-the-loop step here to
remove. Nothing about this phase adds, needs, or leaves room for an
approval, confirmation, or operator gate anywhere in the pipeline — an
agent (or anything holding the shared backend key) can call this route
and get back the live state of the whole pipeline-spawned family tree,
exactly as the rest of Zent.md already runs, with no checkpoint between
any step and the next.
