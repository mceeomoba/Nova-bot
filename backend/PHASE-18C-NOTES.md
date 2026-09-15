# Zent.md Phase 18c — Ecosystem Registry & Identity: Lineage-Aware Marketplace Listing

Deliverable per Zent.md:

> 18c. Lineage-aware marketplace listing: Agent B can list itself in
> `marketplace.ts` with its parent's lineage visible to other agents
> evaluating trust.

## What landed

**`backend/src/ecosystem.ts`**: `resolveCompanyStatus(row, address)`
split out of Phase 18b's own `buildNode()` — the exact
`{liveness, genesisActivation, erc8004}` shape a tree node gets, now
callable for a single row anywhere else that needs it. `buildErc8004Status()`
exported alongside it. Zero behavior change to `buildEcosystemTree()`
itself — same fields, same values, just reachable from outside this
file now.

**`backend/src/marketplace.ts`**: `buildListingLineage(sellerAddress)`
(new) — for a seller whose `agents` row has `spawn_reason =
'expansion_pipeline'` and a `parent_address`, returns:
  - the seller's own `opportunityId`/`mission`/`status`, resolved via
    the same `resolveCompanyMission()` (expansion.ts, Phase 18b's own
    split) and `resolveCompanyStatus()` (ecosystem.ts, this phase's
    split) every other reader of that data uses;
  - the **parent's** `address`/`name`, the parent's own
    `reputationFor()` (this file's pre-existing invocation/flag-rate
    calculation, applied to the parent's address rather than the
    seller's — a buyer evaluating "who backed this company" cares about
    the parent's track record as a marketplace participant, not the
    seller's own numbers restated), and `companiesSpawned` — how many
    other `expansion_pipeline` companies that same parent has founded,
    via `listExistingCompanies()` (expansion.ts, 11b) filtered the same
    way 18b's tree filters its own children.

`null` for the ordinary case — any `'self'`-spawned seller, or one with
no `parent_address` at all — which is every listing that existed before
this phase shipped. `toPublicListing()` now includes `lineage:
buildListingLineage(row.seller_address)` on every listing; every other
field is unchanged.

**Public, not gated**: `marketplace.ts` is mounted before the shared-
secret middleware (see the file's own long-standing header) specifically
so a stranger's agent can evaluate a listing with no `BACKEND_API_KEY`
of its own. This phase does not change that tier — lineage is exactly
the kind of trust signal a cold buyer needs to be able to see without
credentials, and nothing it exposes (mission text, a lifecycle flag, an
already-on-chain ERC-8004 identity) is more sensitive than what this
route already publishes for every listing today. See
`buildListingLineage()`'s own docstring for the full reasoning.

**`backend/src/__tests__/marketplaceLineage_test.ts`** (new file):
mirrors `buildListingLineage()`/`reputationFor()` against in-memory
stand-ins, same "no live better-sqlite3" convention every test file in
this directory uses. Five cases: ordinary self-spawned seller ->
`null`, an ordinary clone with a parent -> also `null`, a real
pipeline-spawned seller -> populated lineage with the *parent's* (not
the seller's own) reputation numbers, `companiesSpawned` counting only
`expansion_pipeline` siblings and not ordinary clones, and a
theoretically-missing parent row degrading to `name: null` rather than
throwing. All pass, alongside the full existing 18a/18b test suite
(28 tests total, unaffected by this phase's refactor).

## What did *not* land (explicitly out of scope, left for later phases)

- No sibling-discovery tool for Agent B's own runtime use at boot
  (18d) — that's a tool Agent B calls about itself, not something a
  buyer reads off a listing; this phase is the buyer-facing surface
  only.
- No change to discovery filtering/ranking (`GET /listings`'s
  `?category=`/`?q=` etc.) to sort or filter on lineage/reputation —
  Zent.md's own wording is "visible to other agents evaluating trust,"
  not "used by this backend to rank" — a buyer (or its own department)
  reads the field and decides for itself, same posture this pipeline
  takes everywhere else about not making judgment calls a caller could
  make better with the raw data.
- No grandparent/full-ancestry chain in the listing — just the
  immediate parent, per Zent.md's own wording ("its parent's lineage").
  A buyer wanting the full multi-generation picture already has 18b's
  `GET /ecosystem/:rootAgentAddress` for that (walk up via
  `lineage.parentAddress` to find the next root to query, if needed).

## No human override

Same posture as every other phase note in this pipeline: this is
read-only, additive output on an existing public discovery route — no
approval, confirmation, or operator step exists anywhere near it, and
nothing about surfacing lineage adds a decision point for a person to
sit in. Agent B lists itself, and every other agent (or a human's own
tooling, since this route is public by design) can see exactly who
backed it, automatically, the moment the listing exists.
