# Zent.md Phase 16c & 16d — Sandbox Reuse & Tool Grant Scoping

Deliverable per Zent.md:

> 16c. Sandbox/VM provisioning reused as-is from the existing clone
> path; no new infra code, just a new caller.
>
> 16d. Tool grant scoping from Strategy's Phase 12c relationship type:
> independent gets the default grant set, supplier-to-sibling gets an
> additional grant to call the sibling's marketplace listing.

## 16c: nothing to build

`genesisCompany()` (16a) already calls `createCloneShell()` then
`createClonedAgentWallet()` — the same two functions the self-directed
`spawn_clone` path calls, and the ones that actually stand up and
migrate the Docker sandbox (`cloning.ts`'s own `createNamedSandbox()`
call inside `createCloneShell()`). That sequence, called from
`genesisCompany()` instead of from an agent's own `spawn_clone` tool
call, **is** 16c's "new caller." No infra code changes; a named test
(`16c: genesis provisions the sandbox purely through 16a's own
createCloneShell()/createClonedAgentWallet() calls`) was added to
`genesisCompany_test.ts` so this phase has an assertion of its own
rather than being silently implied by 16a's suite.

## 16d: what landed

**`genesis.ts`: `scopeGenesisToolGrants()`**, called from
`genesisCompany()` right after `fundGenesisCompany()` (16b), before the
trigger is marked `completed`. Reads `compileStrategyReport(opportunityId)
.relationshipTypeRecommendation` — 12c's own persisted
`recommend_relationship_type` pass, whose doc comment in `expansion.ts`
already named this function as its reader — and:

- `"independent"` or `"shared-customer-base"` (12c's third label, which
  16d's own text never mentions) → no-op. Agent B keeps exactly the
  default grant set `createClonedAgentWallet()`'s own
  `assignTools("agent")` call already gave it.
- No recommendation filed yet (Strategy hasn't run 12c for this
  opportunity) → same no-op. Not an error — a missing recommendation
  just means "default grant set," identical in effect to
  `"independent"`.
- `"supplier-to-sibling"` → looks up the named sibling's current live
  marketplace listing (`findActiveListingForSeller()`, a local
  `active = 1 AND status = 'active'` query — no exported helper exists
  on `marketplace.ts` for this, every seller-scoped query there is
  inline in its own route). If found, records one additional
  `tool_grants` row: `buy_from_marketplace`, `lifecycle: "persistent"`,
  scoped (`scopeKey`) to that specific listing's id. If the sibling's
  recommendation-time listing has since been paused or archived, or
  never existed, this is *also* a no-op — 12c's recommendation can
  predate genesis by an arbitrary number of `decideExpansion()`
  `'deferred'` re-queue cycles, so a stale listing is expected, not a
  bug.

**`toolGrants.ts`: `recordToolGrants()` gets a new option,
`persistentScopeKeys`.** Before this phase, a `persistent`-lifecycle
grant's `scope_key` was unconditionally `NULL` (this file's own header:
"never looked up by any teardown hook") — true for every persistent
grant *except* 16d's, which needs to be scoped to one listing for as
long as Agent B exists. Rather than give `"persistent"` two meanings,
a caller now opts in per tool name via `persistentScopeKeys: { toolName:
scopeKey }`; every other persistent grant in the same call (no entry in
the map) is unaffected — still `NULL`, exactly as before this option
existed. `assignTools()`'s own default-grant-set call sites don't pass
this option, so nothing about the existing default grant flow changes.

**`GenesisCompanyResult`** gets one new field, `supplierToSiblingGrant:
SupplierToSiblingGrant | null` — the tool name, listing id/name, and
sibling address if a grant was recorded, or `null` for every other
case above. Never thrown on; same "a valid, unremarkable outcome"
posture 16b's own `fundingSkippedReason` already established for "no
money moved, still a real company."

## No human override, by design

Same posture as 16a/16b's own notes: `scopeGenesisToolGrants()` runs
inside the same synchronous `genesisCompany()` call chain those phases
already document as having zero operator gate between the CEO's
`approved` ruling and a real, granted capability. Nothing here adds a
review or confirmation step — the grant is filed automatically the
moment `genesisCompany()` reaches it, driven entirely by what Strategy
(itself an agent-executed department, 12c) already recommended.

**This grant does not currently do anything by itself.** `capability.ts`'s
`checkCapability()` for `marketplace_listing` `exec` is documented,
in `marketplace.ts`'s own comment on that check, as always-allow today
— any agent can already call any active listing regardless of this
row. 16d's grant is filed as an honest, auditable record of the
relationship (the "delegation/channel-check machinery future
per-listing restrictions would need," per that same comment) — it is
not an enforcement change, and `buy_from_marketplace` works exactly the
same for Agent B with or without it. Wiring `checkCapability()` to
actually consult `tool_grants` for a scoped resource like this is not
part of 16d's own text and isn't added here.

## What this doesn't do

- **No enforcement change**, per the note directly above — the grant
  is a record, not a gate, until/unless a later phase wires
  `checkCapability()` to read it.
- **`"shared-customer-base"` gets nothing extra.** Zent.md 16d's own
  text names only independent vs. supplier-to-sibling; the third label
  12c can produce is treated the same as independent here. Worth
  revisiting if a future phase decides shared-customer-base should
  carry its own grant (e.g. a cross-referral tool), but that's not
  something this session invents.
- **16e (`company_lineage` tagging)** is still untouched, exactly as
  16a/16b's own notes already flagged — the `agents` row still gets
  the default `spawn_reason = 'self'`.
- **Revocation.** If the sibling later deactivates its listing after
  Agent B was already granted access to it, the `tool_grants` row is
  not retroactively revoked — same "not this session's job" posture
  16b's own "no retry / no partial-provisioning cleanup" notes take for
  their own known gaps.

## Tests

`src/__tests__/genesisCompany_test.ts` extended with in-memory mirrors
of `compileStrategyReport()`'s relationship-type section, a `listings`
table stand-in, and a narrow mirror of `recordToolGrants()` scoped to
exactly the call shape `scopeGenesisToolGrants()` produces. 8 new
tests (1 for 16c, 7 for 16d): sandbox provisioning happens via 16a's
own calls; no recommendation filed; `"independent"`;
`"shared-customer-base"`; a live listing (grant recorded, scoped
correctly); a paused listing (no grant, no error, genesis still
completes); no listing at all; and most-recent-listing-wins when a
seller has more than one live listing. All 25 tests in the file
(17 pre-existing + 8 new) pass under `node --experimental-strip-types
--test`. Same caveat as every prior pass in this file: no live
better-sqlite3/Docker/chain RPC here — mirrors, not the real
`genesis.ts`/`toolGrants.ts`/`marketplace.ts` against a live
environment.
