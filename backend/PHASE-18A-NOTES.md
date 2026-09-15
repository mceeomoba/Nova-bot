# Zent.md Phase 18a — Ecosystem Registry & Identity: ERC-8004 Registration

Deliverable per Zent.md:

> 18a. ERC-8004 registration for Agent B reused from `erc8004Trust.ts`/
> `cloning-erc8004.test.ts` — same on-chain identity mechanism, tagged
> with the parent relationship.

## Plan-text correction, found while implementing it

Same class of mismatch wallet.ts's own `/erc8004/register` route header
already flagged for a different plan document: the actual on-chain
*identity* mechanism lives in `erc8004.ts` (Identity Registry —
`register()` / `registerOnChain()` / `verifyOnChain()`), not
`erc8004Trust.ts`, which is the Reputation/Validation "trust signal"
registries used by the marketplace dispute path and has nothing to do
with birth-time identity. This phase reuses `erc8004.ts`'s
`registerOnChain()`, and `cloning-erc8004.test.ts` only as prior art
(confirmed: registering a `spawn_clone`-family agent always mints a
genuinely independent on-chain identity, never one delegated under the
parent) — the same property this reuses for a pipeline-spawned agent.

"Tagged with the parent relationship" is not an on-chain field:
`agentCard.ts`'s public `card.json` is deliberately minimal ("no
lineage... anyone resolving this is a stranger by design"). The tag is
the existing private `agents` row itself — `parent_address` +
`spawn_reason='expansion_pipeline'` + `opportunity_id` (Phase 16e)
sitting on the same row as this phase's `erc8004_agent_id`/
`erc8004_tx_hash` writes. `GET /wallet/:address/lineage` already reads
that row wholesale, so the on-chain identity is queryable as
parent-tagged the moment this phase writes it — no new column needed.

## The real gap this phase had to close

Agent B is funded with USDC at birth (Phase 16b) but never ETH — a
freshly-born agent's wallet balance is exactly zero wei. That is the
*same* fact wallet.ts's manual `/erc8004/register` route header already
documents as the reason that route stays operator-triggered rather than
auto-called from `createClonedAgentWallet()`: an automatic call would
fail `insufficient_gas` on literally every birth, with no operator ever
in this pipeline to fund it afterward. Left alone, 18a would have the
exact "never actually reachable" problem `Zent.md`'s own top-of-file fix
plan (`is.md`) already documented for a *different* part of this
pipeline (17e-ii's old sandboxed-tick approach) — so this phase closes
it rather than leaving a check that can never pass.

## What landed

**`backend/src/erc8004.ts`**:
- `estimateRegistrationGasCost()` — split out of the existing
  `assertCanAffordGas()` so a caller can ask "how much would this cost"
  without duplicating the estimate/gasPrice/balance calls. Read-only,
  no behavior change to `assertCanAffordGas()` itself.
- `fundGasForRegistration(parentAccount, childAddress, childAgentURI, capWei)`
  — a small, capped, one-time ETH transfer from the parent's own wallet
  to the child's, sized at 2x the live gas estimate (safety margin for
  price movement between quote and the real `registerOnChain()` call
  moments later) and never more than `capWei`. Best-effort: returns
  `{ funded: false, reason: 'parent_insufficient_eth' }` rather than
  throwing if the parent itself can't cover it. Never touches Agent B's
  USDC balance or Phase 16b's funding cap — a wholly separate transfer
  in a wholly separate asset, sized only off gas cost.

**`backend/src/config.ts`**: `genesisGasFundingWeiCap` (default 0.0005
ETH, `GENESIS_GAS_FUNDING_WEI_CAP` env override) — the hard ceiling on
what the automatic path will ever move, independent of Phase 16b's USDC
cap.

**`backend/src/genesisErc8004.ts`** (new file):
`registerGenesisIdentity(opportunityId, parentAddress, agentAddress)` —
gas top-up, then `registerOnChain()`, then the same `agents.erc8004_*`
UPDATE the manual route already does. Four outcomes, all non-fatal
(recorded, not thrown — same posture 17e-ii/iii/iv all use):
`registered`, `gas_funding_failed`, `registration_failed`,
`skipped_self_custody` (a future self-custody genesis path — every
pipeline-spawned agent today is backend-custodied, so this branch is
currently unreachable but handled rather than assumed away).
`getLatestGenesisErc8004Registration()` — read-only, for 18b.

**`backend/src/db.ts`**: new `genesis_erc8004_registrations` table,
same complete-history convention as every other genesis-family table.

**`backend/src/genesis.ts`**: `genesisExecutorAdapter()` now calls
`registerGenesisIdentity()` immediately after `activateGenesisAgent()`
— i.e. only for an agent that already cleared both 17e-ii and 17e-iii.
An agent whose first tick crashed or violated its constitution never
gets a registration attempt.

**`backend/src/wallet.ts`**: no functional change this pass beyond the
17e-iv-era `genesis_activation_status` addition to the lineage
endpoint's `children` list — `erc8004_agent_id` etc. already rode
`SELECT *` there for every agent, self- or pipeline-spawned alike.

**`backend/src/__tests__/genesisErc8004_test.ts`** (new file): mirrors
`registerGenesisIdentity()`'s outcome classification against
dependency-injected fakes for the gas top-up and the chain registration
call (no real chain, same constraint every `genesis*_test.ts` file in
this directory already documents). Covers all four outcomes, the
self-custody short-circuit taking no chain action at all, a thrown gas
transfer being distinguished from a merely-insufficient one, the gas
outcome being preserved on the row even when the *subsequent*
registration call fails, and the one-row-per-attempt contract.

## What did *not* land (explicitly out of scope)

- No new HTTP endpoint. `getLatestGenesisErc8004Registration()` is the
  same kind of read-only seam `getLatestTickSmokeTest()` /
  `getLatestConstitutionCheck()` / `getGenesisActivationStatus()` already
  are — Phase 18b's ecosystem tree view is where this actually gets
  surfaced.
- No retry path for a failed registration. Same "failed is terminal, no
  silent retry" posture 17e-iv established — a `gas_funding_failed` or
  `registration_failed` agent is a real, active company with no
  on-chain identity; nothing here re-attempts it.
- No change to `erc8004Trust.ts` (Reputation/Validation) — confirmed,
  same as wallet.ts's own header already confirmed for a different
  plan, that this was never the right file for identity registration.

## A note on stakes, not scope

Worth being explicit about, separate from what shipped: every other
17e/18-family check in this pipeline (smoke test, constitution
compliance, activation status) is an internal, reversible, free-to-retry
record. This phase is not. `registerOnChain()` is a real, public,
irreversible Base transaction the instant it lands, and
`fundGasForRegistration()` moves real ETH out of the parent agent's
wallet even on an attempt that then itself fails downstream. Every
failure mode above is handled the same non-fatal way this codebase
handles every other genesis-family failure — consistent with this
pipeline's own pattern, not a claim that the stakes are the same. If
this hasn't been run against Base Sepolia yet, that's worth doing before
it runs unattended against mainnet — the "no human override" design
choice for this pipeline means there is no checkpoint between a CEO
agent's `approved` decision and a real on-chain transaction anywhere in
this chain now, from Phase 15 through this one.
