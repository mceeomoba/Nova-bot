# Zent.md Phase 18d — Ecosystem Registry & Identity: Sibling Discovery Tool

Deliverable per Zent.md:

> 18d. Sibling discovery tool for Agent B itself: on first boot it can
> query its own lineage to learn who its siblings are (supports the
> "reuse our technology" case from Strategy).

This was genuinely untouched going into this session — unlike 16d/16e
(already built, just missing their own notes files at the time I last
reported on them), there was no sibling-facing code anywhere in either
repo. Confirmed by grep across both `backend/src` and `agent/src`
before writing anything.

## What landed

No new backend route. 18b's existing `GET /ecosystem/:rootAgentAddress`
(`ecosystemRoutes.ts`) already returns exactly the tree this phase
needs — same "reused as-is" posture 16a/16c/17b already take for
`spawn_clone`/the clone-shell path. The only backend-adjacent change is
wiring the agent runtime to actually call that route for itself.

**`agent/src/types.ts`**: `EcosystemNode`/`EcosystemNodeStatus`/
`EcosystemErc8004Status`/`EcosystemCompanyMission` — mirrors
`backend/src/ecosystem.ts`'s own shapes field-for-field, since it's the
same JSON crossing the wire. `getEcosystemTree(rootAgentAddress):
Promise<EcosystemNode | null>` added to the `BackendClient` interface.

**`agent/src/backend/client.ts`**: `getEcosystemTree()` implemented as
`GET /ecosystem/:address` through the same `request()` helper every
other agent-facing call already uses (shared `x-backend-key`, no new
auth tier needed — this backend has one shared secret per deployment,
not per-agent, so an automaton calling its own office can already reach
this route). A 404 (unknown address) is turned into `null` rather than
thrown, matching that route's own documented "no agent there" outcome.

**`agent/src/agent/tools.ts`**: new tool, `list_siblings` — category
`replication`, riskLevel `safe`, no parameters (self-scoped, same shape
as `list_children` just above it, which it's intentionally adjacent
to). Logic:

1. Reads `ctx.config.parentAddress` — already set at genesis via the
   same config the ordinary `spawn_clone` path writes (16a/16c reuse
   it unmodified), so no extra round trip is needed to learn who
   spawned this automaton before asking who else that parent spawned.
   Missing entirely → "you're a root company, no sibling family."
2. Calls `getEcosystemTree(parentAddress)` — **the parent's** tree, not
   the automaton's own. Siblings are the *other* children of the same
   parent; this automaton's own descendants (if it later spawns its
   own children as `parentAddress` for some C) are a different tree
   `list_children` already covers, not this one. This is what makes
   18e's multi-generation case ("B's own eventual child") resolve
   correctly for whichever generation is asking — every automaton
   always looks at its own immediate parent's tree, never assumes it's
   ultimate root Company A.
3. Filters `parentTree.children` to exclude its own address, then
   formats name, mission (title + thesis), `relationshipType`, and
   genesis/liveness status per sibling. `relationshipType ===
   'supplier-to-sibling'` gets a specific callout that the automaton
   may already hold a `buy_from_marketplace` grant scoped to that
   sibling's listing (16d) — this is the direct mechanical support for
   "reuse our technology" the phase text names, not just a status
   readout.

**`agent/src/__tests__/mocks.ts`**: `MockBackendClient.ecosystemTrees`
(settable `Record<string, EcosystemNode>` fixture) + `getEcosystemTree()`
reading from it, `undefined` → `null` matching the real 404 path.

**`agent/src/__tests__/list-siblings.test.ts`** (new): seven cases —
tool registered once/read-only/no-params; no-parent → root-company
message; unresolvable parent → distinct message from zero-siblings;
zero-siblings (only child) → distinct message; real siblings excluded-
self + mission/relationship-type formatting; independent relationship
type omits the marketplace-access hint; a sibling with no recorded
mission degrades gracefully instead of throwing.

**`agent/src/__tests__/tools-security.test.ts`**: added `list_siblings:
"safe"` to `EXPECTED_RISK_LEVELS` alongside `list_children`.

## What did *not* land

- **No automatic call at genesis/first-boot.** Zent.md's own wording
  is "on first boot it *can* query" — a capability, not a forced
  action. Every other tool in this system is agent-invoked at its own
  discretion during its own tick; auto-firing this one specific tool
  the instant an automaton boots would be the one place in this whole
  pipeline where something other than the automaton itself decides
  when a capability gets used. Left as an ordinary tool call, same as
  `list_children`, `check_reputation`, etc.
- **`__tests__/mocks.ts`'s `MockBackendClient implements BackendClient`
  claim was already broken before this session** — it's missing all
  eleven marketplace/distribution methods the interface has required
  since Phase 16d-era work landed. Not fixed here; out of scope for
  18d, and not a regression this phase introduced (`getEcosystemTree`
  is the one method this session added to the mock, and it's real).
- **No grandparent/full-ancestry walk.** A sibling list is one level —
  other children of *this automaton's own* parent. An automaton
  curious about the wider ecosystem beyond its own immediate family
  already has 18b's `GET /ecosystem/:rootAgentAddress` directly, which
  `list_siblings` itself is just a self-scoped one-hop read over.

## No human override

Same posture as every other Zent.md phase in this codebase: this is a
read-only tool an automaton calls about its own family on its own
initiative, with no approval, confirmation, or operator step anywhere
near it. Nothing about knowing who your siblings are is gated behind a
person — it's exactly as available to Agent B on its first tick as
`list_children` or `check_credits` are.
