# Zent.md Phase 18e — Ecosystem Registry & Identity: Registry Test

Deliverable per Zent.md:

> 18e. Registry test: multi-generation tree (Company A → B → and B's own
> eventual child, if B itself becomes profitable and repeats the cycle)
> resolves correctly.

## What this session found

No new code. `backend/src/__tests__/ecosystemTree_test.ts` — written as
part of Phase 18b's own delivery — already covers this phase's entire
"done when" and then some. That file's own header says so explicitly:
its multi-generation case (`A -> B -> C`) is *"the exact case Phase 18e's
own 'done when' names."* 18b was built with 18e's requirement already in
mind, rather than deferring the multi-generation case to a later phase.

Verified by actually running it (`node --experimental-strip-types --test
ecosystemTree_test.ts`, no `node_modules` needed — this file's only
imports are `node:test`/`node:assert`, same "no live better-sqlite3,
in-memory mirror" convention every other `*_test.ts` file in this
directory uses):

```
# tests 9
# pass 9
# fail 0
```

Cases covered, cross-checked against 18e's own wording and against the
real `ecosystem.ts` (`buildEcosystemTree`/`buildNode`, unchanged since
18b/18c landed — diffed by hand, not just assumed):

- Unknown root address -> `undefined` (route's own 404 case).
- A root with no pipeline-spawned children -> empty `children: []`.
- **Multi-generation tree, `A -> B -> C`** -- 18e's named case. Each
  generation's mission, `genesisActivation` status, and children resolve
  independently and correctly nested.
- Ordinary `spawn_clone` children (`spawn_reason = 'self'`) sharing a
  parent with a pipeline-spawned sibling are excluded from the tree --
  "the ecosystem" is pipeline lineage only, not every clone.
- Mission resolution's three-way fallback (structural column -> pruned
  opportunity's opportunity-derived reconstruction -> `null`).
- `status.erc8004`: `null` when never attempted, populated when a real
  registration exists -- per-node, not inherited from a parent.
- **B itself as root** -- the case Zent.md's own wording calls out
  ("B's own eventual child, if B itself becomes profitable and repeats
  the cycle"): a pipeline-spawned company queried as the root resolves
  its *own* mission/status correctly, not just its children's.
- Depth-guard truncation (`MAX_ECOSYSTEM_DEPTH`, tested against a
  small local cap rather than constructing 25 real generations) marks
  `truncated: true` and stops recursing rather than looping forever.

## No human override

Nothing here to override -- 18e is a test, not a runtime decision point.
It verifies that a read-only registry view resolves correctly; it adds
no gate, no approval step, and no operator-facing surface of its own.
Same posture as every other phase in this pipeline.

## Phase 18 status

With this, Phase 18 (Ecosystem Registry & Identity) is complete end to
end: 18a (ERC-8004 registration), 18b (tree view route), 18c
(lineage-aware marketplace listing), 18d (sibling discovery tool, this
session's prior build), 18e (this note). Phase 19 (Guardrails, Limits &
Kill-Switches) is the next real gap: 19a/19c are pulled forward and
working; 19b (portfolio spend cap), 19d (kill/recall + the funding-
failure orphan cleanup + transaction lock flagged earlier this session),
and 19e (dry-run mode) are still open.
