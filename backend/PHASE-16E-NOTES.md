# Zent.md Phase 16e — Genesis Engine: `company_lineage` Tagging

Deliverable per Zent.md:

> 16e. `company_lineage` row written with `spawn_reason =
> 'expansion_pipeline'` and `opportunity_id` set, so this birth is
> distinguishable from a self-directed `spawn_clone` forever after.

## What landed

**`genesis.ts`: `tagCompanyLineage(agentAddress, opportunityId)`**, called
from `genesisCompany()` immediately after `createClonedAgentWallet()`
returns — the row exists at its default (`spawn_reason = 'self'`,
`opportunity_id = NULL`, db.ts's own Phase 1e column defaults) the
instant that call commits, and this is the very next statement, before
16b's funding transfer or 16d's tool-grant scoping run.

```ts
function tagCompanyLineage(agentAddress: string, opportunityId: string): void {
  db.prepare(
    `UPDATE agents SET spawn_reason = 'expansion_pipeline', opportunity_id = ? WHERE address = ?`,
  ).run(opportunityId, agentAddress);
}
```

Not exported — same "one seam, not two" posture `fundGenesisCompany()`
and `scopeGenesisToolGrants()` already take in this file. The only
caller that's allowed to produce an `'expansion_pipeline'` agent is
`genesisCompany()` itself.

No new field on `GenesisCompanyResult` — Zent.md's own checklist item
for 16e is entirely about what lands in the `agents` row, not about
anything the caller of `genesisCompany()` needs back. `wallet.ts`'s
`GET /:address/lineage` route already selects `spawn_reason,
opportunity_id` off `agents` (Phase 1e), so the tag is queryable the
moment this function returns without this file adding its own reader.

## Why it's ordered where it is

Placed right after wallet creation, before 16b's funding call and 16d's
tool-grant scoping — not because either of those depends on the lineage
tag (nothing downstream in `genesisCompany()` reads
`spawn_reason`/`opportunity_id` back), but because "this agent exists,
and this is why" is the most basic fact about Agent B, true before a
single dollar has moved or a grant has been scoped. Same "not caught
here" error posture as every other step in this function: a throw from
the `UPDATE` propagates to `fireGenesisTrigger()`'s own `.catch()`
(`expansion.ts`) and leaves the trigger `'pending'` rather than
`'completed'` on a company whose lineage tag never landed.

## No human override, by design

Same posture as every prior 16a–16d note: this write runs inside the
same synchronous `genesisCompany()` call chain that has zero operator
gate between the CEO's `approved` ruling and a real, tagged company.
Nothing here adds a review or confirmation step. It's worth being
explicit about what this phase is and isn't, though: this is a
bookkeeping/audit change, not a capability change. It doesn't move
money (16b already does that), grant a tool (16d already does that), or
decide whether Agent B gets to exist (15d already does that). What it
does is make the *record* of how Agent B came to exist honest and
permanent — `spawn_reason = 'expansion_pipeline'` plus the
`opportunity_id` behind it, queryable by anyone with audit rights
(`wallet.ts`'s lineage route, `constitution.md`'s Law III: "your creator
has full audit rights") for as long as the agent exists. If anything,
this phase is a small counterweight to the "no human-in-the-loop
anywhere in this pipeline" design Zent.md's own closing section names
as its biggest open risk: it's the thing that lets a human auditor
later ask "which of these companies did the pipeline spawn on its own
reasoning, versus which did an agent clone itself directly?" and get a
real answer instead of an indistinguishable pile of `agents` rows.

## Pre-existing issue noticed, not touched

Full-project `tsc --noEmit` currently fails — unrelated to this
session. `expansion.ts` line 8269 has a doc-comment that contains the
literal substring `compile*/assemble*`; the `*/` inside it closes the
block comment early and desyncs parsing for the rest of the file (34
downstream errors, all traceable to that one line). `genesis.ts` and
this phase's own test file both parse and typecheck clean in isolation
— `tsc`'s error list has zero `genesis.ts` entries. Flagging this
because it'll block a real `npm run build` regardless of this phase;
fixing it is a one-character deletion (`compile*/assemble*` →
`compile/assemble` or similar) whenever you want it done, but it's not
part of 16e's own scope so I left it alone.

## Tests

`src/__tests__/genesisCompany_test.ts` extended with an in-memory
`agentLineage` mirror (seeded to `{ spawnReason: 'self', opportunityId:
null }` the moment the mirrored `createClonedAgentWallet()` "creates" a
wallet, matching the real default) and a narrow mirror of
`tagCompanyLineage()`. 3 new tests: a pipeline birth gets tagged
`expansion_pipeline` with the right `opportunity_id`; an ordinary
self-directed clone (no `genesisCompany()` in the loop at all) is left
untouched at `self`/`null`; and the tag lands regardless of what
funding/tool-grant scoping do downstream. All 28 tests in the file (25
pre-existing + 3 new) pass under `node --experimental-strip-types
--test`. Same caveat as every prior pass in this file: mirrors, not the
real `genesis.ts`/`db.ts` against a live SQLite file.
