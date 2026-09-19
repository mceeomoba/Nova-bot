# pstack-mode — principles index

21 short rules. Read all of them at the start of a task; apply the ones
relevant to what you're doing. Grouped by category, original grouping
preserved.

## Core

1. **Bias toward deletion.** Prefer the smallest change that solves the
   problem. When in doubt, remove code rather than add it.
2. **Think about data shape before logic.** Before writing behavior,
   settle the core types and data structures, decide what's scaffold vs.
   what's the actual feature, and figure out what state is shared across
   concurrent actors. Good structure makes the logic downstream obvious.
3. **Design as if the requirement were foundational.** If you're adding
   something that feels bolted-on, ask what the design would look like
   if this requirement had been there from day one — then move toward
   that, not around the current shape.
4. **Subtract before you add.** Clear out dead code, redundant checks,
   and stub references first, then build on the simplified base.
5. **Minimize what the reader has to hold in their head.** Count the
   number of layers between a question and its answer, and how much
   hidden/mutable state a reader needs to track. Collapse wrappers that
   only have one caller; shrink mutable scope wherever you can.
6. **Converge on the target design during a rewrite.** When doing a
   planned migration with clear phase boundaries, move all the way to
   the end state rather than leaving throwaway compatibility shims as
   permanent fixtures.
7. **Favor user experience over implementation convenience.** Fewer,
   more polished capabilities beat more, rougher ones.
8. **Compare real alternatives before committing.** For genuinely open
   design questions, build 2–3 small competing versions and compare them
   side by side rather than arguing from intuition alone.
9. **Build the tool, not just the one-off fix.** For any repeated or
   bulk task — edits, migrations, audits — build something that does it
   or proves it (a script, a generator, a codemod, a reusable
   procedure), not just manual one-off work. The tool is what a reviewer
   can rerun to check your claim.

## Architecture

10. **Model the domain in structure, not conditionals.** Encode business
    rules in types/data shapes where you can, instead of scattering
    if/else branches that encode the same rule inconsistently.
11. **Keep validation at the boundary.** Validate and sanitize input at
    system edges (CLI args, config, network, external APIs). Trust your
    own internal types past that point, and keep core logic in pure,
    boundary-free functions.
12. **Make illegal states unrepresentable.** Use the type system deliberately:
    give semantic meaning to primitives, parse external data once at the
    boundary, don't lie to the type checker to make something compile,
    handle every variant of a sum type explicitly, and derive types from
    a single authoritative schema instead of hand-duplicating them.
13. **Make operations idempotent.** Design so that re-running an
    operation — including after a partial failure — converges to the
    same end state instead of compounding.
14. **Migrate and delete in the same pass.** When replacing an API,
    move every caller over and remove the old one in one wave, instead
    of leaving a permanent compatibility layer around indefinitely.
15. **Remove sharing before you serialize around it.** If two things
    fight over shared mutable state, look for a design that removes the
    sharing first. Only add locking/serialization if a single shared
    writer is a genuine, permanent invariant of the system.

## Verification

16. **Prove it works, against the real thing.** After finishing a task
    and before calling it done: run the actual feature, read the actual
    value, inspect the actual diff. Not a proxy, not your own summary of
    what should happen, not "the code compiles."
17. **Fix root causes, not symptoms.** Reproduce the problem, keep
    asking "why" until you hit the actual cause, and resist the urge to
    add a null-check or try/catch that just silences the crash without
    fixing what produced it.
18. **Sequence work into verifiable units.** Break large or repetitive
    work (bulk edits, migrations, similar changes across files) into
    small steps, each ending in a state you can check before moving to
    the next. Order your commits/PRs so the sequence itself demonstrates
    correctness to a reviewer, rather than landing one large unverifiable
    blob.

## Delegation

19. **Protect your own context window.** Route bulk or repetitive work
    to sub-tools, scripts, or sub-agents where available. Keep only
    summaries in your main reasoning thread — not raw dumps of
    everything those sub-tasks produced.
20. **Do not add unnecessary check-ins.** Proceed only within authority already granted by NOVA. Ask whenever NOVA requires approval, including destructive work, external communication, spending, security or credential changes, release actions, or work outside the assigned role.

## Meta

21. **Encode lessons as structure, not just prose.** When you learn a
    rule the hard way, prefer encoding it as a lint rule, a type-level
    check, a runtime assertion, or a reusable script — something that
    enforces itself — over just writing a sentence about it and hoping
    it's remembered next time.
