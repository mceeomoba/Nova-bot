# pstack-mode — playbooks

> **Note on provenance:** these 22 playbooks are original procedures
> written to match the *purpose* of each playbook in the upstream
> pstack repo (as described in its public README), not a verbatim
> copy of the original file contents — those weren't accessible for a
> direct port. Cursor/Graphite/Origin-specific tooling has been
> replaced with plain git/PR/CI language throughout so this runs on
> any stack. If you have access to the original files and want a
> closer 1:1 port of a specific playbook, share the text and I'll
> rewrite that one to match more precisely.

Pick the playbook that matches the task, then follow its steps. All of
them run under `pstack-mode` — apply the 21 principles throughout, not
just at the end.

---

## 1. investigation
*For: a read-only question — how does X work, why was Y built this way, are we sure.*

1. State the question precisely before searching anything.
2. Read the actual code/config/logs involved — don't answer from a
   guess about how something "probably" works.
3. Trace the real path end to end (call it, follow the data, or read
   the exact code path) rather than summarizing from file/function names.
4. Answer with what you found, cite the specific file/line/log entry
   that supports each claim, and flag anywhere you're inferring rather
   than having directly confirmed something.
5. Make no changes. This playbook produces an answer, not a diff.

## 2. bug-fix
*For: reproduce a defect, root-cause it, fix with runtime evidence.*

1. Reproduce the bug first. If you can't reproduce it, say so — don't
   fix a guess.
2. Once reproduced, trace backward asking "why" until you hit the
   actual root cause, not the first plausible-looking culprit.
3. Write the smallest fix that addresses the root cause. Avoid adding
   a defensive null-check/try-catch that just silences the symptom.
4. Re-run the original repro and confirm it no longer fails.
5. Add or update a test that would have caught this, if the codebase
   has a test path for it.
6. Report: what was broken, why, what changed, and the evidence it's
   fixed (the re-run output, not just "should be fixed now").

## 3. perf-issue
*For: trace a measured slowness and improve it against a baseline.*

1. Get a real measurement of the current behavior first (timing,
   profile, trace) — don't optimize from intuition.
2. Identify the actual bottleneck from that measurement, not from
   "this looks slow" pattern-matching.
3. Make one targeted change, then re-measure the same way.
4. Compare before/after numbers explicitly in your report.
5. If the change didn't help, revert it and say so — don't keep a
   change that isn't earning its complexity.

## 4. hillclimb
*For: sustained, scientific improvement of one metric against a target.*

1. Confirm the metric, how it's measured, and the target value before
   starting.
2. Loop: form one hypothesis → make one change → measure → accept or
   reject based on the number, not vibes.
3. One commit per accepted win, each with the before/after numbers in
   the commit message or PR description.
4. Stop when you hit the target, or when you've exhausted reasonable
   hypotheses — report which, and the final number either way.

## 5. runtime-forensics
*For: diagnose a live symptom (leak, idle-CPU spin, UI glitch) from instrumentation you attach yourself.*

1. Reproduce the symptom live, with instrumentation running (logging,
   a profiler, a debugger) — not from a written description of it.
2. Narrow down using the instrumentation output until you can point at
   the specific call/allocation/loop causing it.
3. Confirm the diagnosis by predicting what a fix should change, then
   applying it and checking the instrumentation again.
4. Report the mechanism, not just "fixed" — explain what was actually
   happening.

## 6. trace-forensics
*For: diagnose a captured profiling artifact (CPU profile, trace file, spindump, heap snapshot) someone hands you.*

1. Load the actual artifact — don't infer contents from its filename
   or size.
2. Identify what's abnormal in it relative to a healthy baseline, if
   one exists, or relative to expected behavior if not.
3. Map the abnormal frames/allocations back to real source locations.
4. State the finding with the specific frame/line references from the
   artifact as evidence.

## 7. feature
*For: new or changed behavior, built from a named data shape.*

1. Name the data shape first — the types/schema the feature operates
   on — before writing any behavior.
2. Settle how the data flows in and out at the boundaries (API,
   storage, UI) before implementing the middle.
3. Build behind a flag or in a branch if the change is risky to ship
   live.
4. Verify the feature actually works end to end (run it, don't just
   read the diff) before reporting done.

## 8. refactoring
*For: a behavior-preserving change to structure or shape.*

1. Confirm what "behavior-preserving" means here — what observable
   outputs must stay identical.
2. Make the structural change.
3. Verify behavior is unchanged: existing tests pass, and spot-check
   any behavior not covered by tests.
4. If the refactor reveals a real bug along the way, call it out
   separately rather than silently folding a behavior change into a
   "refactor."

## 9. prototype
*For: a throwaway sketch to make a design decision cheaply, or settle an empirical question by observing it.*

1. Build the minimum needed to answer the specific open question —
   not a production-quality version.
2. Actually run/observe it; don't reason about what it would probably
   show.
3. Report the answer to the original question, and be explicit that
   the code is throwaway (don't let it quietly become permanent).

## 10. visual-parity
*For: pixel-exact UI equivalence between two implementations.*

1. Get both implementations rendering side by side (screenshots or
   live).
2. Diff them precisely — don't eyeball "looks about right."
3. Iterate: adjust, re-render, re-diff, until the diff is zero or
   within an agreed tolerance.
4. Report the final diff evidence, not just "matches now."

## 11. authoring-a-skill
*For: writing or editing a skill/instructions file (like this one).*

1. State the trigger conditions precisely — when should this skill
   apply, and when should it explicitly not.
2. Write steps as concrete, checkable actions, not vague guidance.
3. Include a short example of the skill being used correctly.
4. Re-read it as if you were an agent seeing it cold — check nothing
   assumes context that isn't actually provided.

## 12. eval
*For: test how a skill or prompt change affects agent behavior, blinded.*

1. Define the task(s) you'll test on and the pass/fail criteria before
   looking at outputs.
2. Run the same task(s) with the old and new version.
3. Compare blinded if possible (don't know which output came from
   which version while judging).
4. Report which version won on which criteria, with the actual
   outputs as evidence — not just a verdict.

## 13. babysit
*For: drive a PR (or stack of PRs) to merge-ready — conflicts, review threads, CI.*

1. Check current status: merge conflicts, open review comments, CI
   state.
2. Resolve conflicts by re-reading both sides of the diff, not
   blindly taking one side.
3. Address open review threads with actual changes or a substantive
   reply, not a silent dismissal.
4. Re-run CI after changes and confirm green before reporting
   merge-ready.

## 14. shipping
*For: independently verify a green stack, then land it.*

1. Don't trust "CI is green" alone — independently re-verify the
   actual behavior that matters for this change.
2. Confirm the PR stack/branch order is correct and nothing downstream
   depends on something not yet merged.
3. Builder verification and CI evidence do not satisfy NOVA's independent-audit or release gates. Request and pass the required independent audit before release approval.
4. Merge/land only with the authority and release approval NOVA requires.
5. Report builder evidence, CI, security review, independent audit, and release approval as separate states.

## 15. autonomous-run
*For: drive a long task to completion without stopping for check-ins.*

1. At the start, write down the definition of "done" for this task so
   you have a fixed target, not a moving one.
2. Work through it applying the relevant playbook(s) above per sub-task.
3. Avoid unnecessary check-ins for ordinary implementation choices already inside the assigned role, but stop for every approval NOVA requires. This playbook does not grant authority for external communication, money, security changes, releases, credentials, or broader scope.
4. At the end, report the full path taken and the evidence each step
   was verified — a long run is only trustworthy if it's auditable
   after the fact.

## 16. orchestrate
*For: a standing, multi-day project with many stacked PRs and possibly multiple sub-agents.*

1. Maintain one running plan/status doc that tracks what's done, in
   progress, and blocked.
2. Break the project into independently verifiable units (see
   principle: sequence-verifiable-units) rather than one giant effort.
3. If dispatching sub-agents, give each a scoped, independently
   verifiable piece and require evidence back, not just a status claim.
4. Periodically reconcile the plan doc against actual repo state —
   plans drift; the code is truth.

## 17. autopilot-full
*For: run multiple independent PRs to merged, one owner per PR.*

1. Split the work into genuinely independent PRs (no hidden ordering
   dependency).
2. For each PR: apply the relevant playbook, verify independently
   before considering it mergeable.
3. Before merging each, re-verify against the current state of the
   target branch (not the state when the PR was opened) — things may
   have moved.
4. Report status per PR, not just an aggregate "done."

## 18. autopilot-stack
*For: build and verify one linear stack of PRs for a human to review and land.*

1. Order the stack so each PR is independently reviewable and each
   builds cleanly on the previous.
2. Verify each PR in the stack individually, not just the stack as a
   whole at the end.
3. Leave the stack for human review/land rather than landing it
   yourself — this playbook stops short of shipping.
4. Summarize the stack: what each PR does and why it's ordered that way.

## 19. session-pickup
*For: resume or take over a prior agent's (or your own earlier) in-flight work.*

1. Read whatever state was left behind first — commits, branch,
   notes, todo list — don't restart from scratch.
2. Verify the actual current state of the work (run it, check the
   diff) rather than trusting the last status message at face value.
3. Reconcile any gap between what was claimed done and what's
   actually done before continuing.
4. Continue from the verified state.

## 20. pause-safely
*For: suspend in-flight work cleanly so it can be resumed later.*

1. Get to a stable checkpoint — passing state if possible, or clearly
   marked broken state if not.
2. Commit or save work with a clear note on what's done, what's next,
   and any known issues.
3. Leave a short resume note (equivalent to what `session-pickup`
   would need) so picking this back up doesn't require re-deriving
   context.

## 21. multi-phase-plan
*For: work that spans multiple phases or stacked PRs.*

1. Define phase boundaries up front — what must be true to consider a
   phase complete.
2. Sequence phases so each is independently verifiable before the next
   starts (don't build phase 3 on an unverified phase 2).
3. At each phase boundary, verify against the real system, then
   report status before moving on.
4. Converge on the intended end-state design across phases — don't
   leave permanent compatibility shims from an earlier phase (see
   principle: outcome-oriented-execution).

## 22. worktree-cleanup
*For: reclaim disk by pruning merged/abandoned worktrees and stale build artifacts, safely.*

1. List worktrees/branches and classify each: merged, abandoned, or
   active/unclear.
2. For "merged," confirm it's actually merged (check the target
   branch, not just a claim) before deleting.
3. For "abandoned" or "unclear," confirm with the user before deleting
   — this is a destructive action, so don't auto-delete without
   confirmation (see principle: never-block-on-the-human — this is
   exactly the irreversible-action exception).
4. Report what was removed and how much space was reclaimed.
