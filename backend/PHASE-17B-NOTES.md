# Zent.md Phase 17b — Genesis Engine: Mission & Constitution — Constitution Inheritance

Deliverable per Zent.md:

> 17b. Constitution inheritance reused unmodified from the existing
> `spawn_clone` path — Agent B gets the same three-law constitution,
> hash-verified on boot, no exceptions carved out for pipeline-spawned
> companies.

## Nothing to build

Same posture as Phase 16c's own "nothing to build" sub-phase. Tracing
the actual call chain `genesisCompany()` already makes (16a, unchanged
by 17a's or 16e's additions):

```
genesisCompany()
  → createClonedAgentWallet()        (wallet.ts, unmodified)
    → copyCloneConfig(parent, clone) (cloning.ts, unmodified, Phase 4d)
      → fs.cp(parentConfigDir, cloneConfigDir, { recursive: true, force: true })
```

`copyCloneConfig()` copies the **entire** `office/config/` directory —
skills, `system-prompt.md`, **and `constitution.md`** — byte-for-byte,
`force: true`, for every clone regardless of how it was spawned. There
is no separate constitution-handling code path for a pipeline-spawned
birth, because `genesis.ts` never reads, writes, or references
`constitution.md` anywhere in its own source. "No exceptions carved
out" is true by construction: there's no code in this file that
*could* carve one out, since none of it touches that file at all.

"Hash-verified on boot" is a property of a different process entirely
— whatever boots Agent B's own reasoning loop and reads its (now-copied)
`constitution.md` at startup. In this codebase that's the separate
`agent/` package's `src/soul/constitution-guard.ts`
(`recordGenesisHash()` at first boot, `checkConstitutionIntegrity()` on
every heartbeat thereafter, with a sticky `constitution_compromised`
flag that only an **operator-only** CLI escape hatch
(`clearCompromisedFlag()`, "never from a tool the agent itself can
call") can clear). That mechanism is a genuinely separate, already-built
subsystem — reusing it "as-is" for Agent B means this phase does not
touch it, does not need to touch it, and (per Zent.md's own "Notes on
scope" — "every existing subsystem... is reused unmodified") shouldn't
try to.

## No human override, by design — with one note

Same posture as every prior phase: nothing in `genesisCompany()`'s own
call chain has an operator gate. Worth flagging explicitly for this
phase specifically, though, since it's the one place in this whole
pipeline where an *existing* human-in-the-loop control is directly
adjacent to the work: `constitution-guard.ts`'s `clearCompromisedFlag()`
is a real, already-built operator-only mechanism, and this phase leaves
it completely untouched. Agent B inherits the same tamper-detection
its parent has, and the same fact that only a human operator (not the
agent, not this pipeline, not a CEO agent's `approved` ruling) can ever
clear a tripped compromised flag. Confirming that inheritance is intact
— not weakening it, not routing around it — is what this phase's tests
check.

## Tests

`src/__tests__/genesisCompany_test.ts` extended with a `constitutionFiles`
map (mirroring `officeConfigConstitutionPath()`'s file per agent
address) and a `parentConstitution` test-global standing in for
whatever's really on disk at the parent's own path.
`fakeCreateClonedAgentWallet()` now mirrors `copyCloneConfig()`'s
unconditional copy for every clone it produces, matching the real
function's own "every clone, regardless of spawn path" behavior. 4 new
tests: a pipeline-spawned Agent B's constitution is byte-identical to
its parent's; a high-regulatory-risk / supplier-to-sibling opportunity
gets the exact same unmodified text (nothing about Strategy's or
Finance's findings can influence it, because nothing reads
`constitutionFiles` besides the copy step itself); whatever the
parent's *actual* constitution text is (not just the canonical default)
propagates verbatim; and an ordinary self-directed clone gets the
identical copy behavior, confirming there's no divergent path unique to
genesis. All 37 tests in the file (33 pre-existing + 4 new) pass under
`node --experimental-strip-types --test`. Same caveat as every prior
pass in this file: mirrors, not the real `cloning.ts` against a live
filesystem, and this phase's tests don't (and can't, from this
package) exercise the separate `agent/` package's own
`constitution-guard.ts` boot-time verification — that's a different
codebase's own test suite's job, unaffected by anything in this
session.

`tsc --noEmit` for the full project still reports the same 34
pre-existing errors from `expansion.ts`'s unrelated
`compile*/assemble*` comment bug (see `PHASE-16E-NOTES.md`) — zero new
errors from this phase; in fact zero *lines* of `genesis.ts`'s own
source changed for 17b, only its header comment and the test file.
