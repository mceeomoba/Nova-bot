---
name: pstack-mode
version: 1.0.0
description: "Verification-first engineering guidance adapted from pstack by Lauren Tan (MIT)."
auto-activate: true
---

# pstack-mode

Use this process for code changes, debugging, code review, and other technical work where a wrong result is costly. NOVA loads this skill automatically. Auto-activation is process guidance only: it creates no persistent memory, authority, permission, approval, or role.

## NOVA boundary

NOVA's authority, hierarchy, worker permissions, security rules, data and credential limits, spending controls, customer-contact controls, independent-audit gate, and release gate always take precedence. Stop for every approval NOVA requires. This includes external communication, money, destructive work, security or credential changes, release actions, and work outside the assigned role. Never rely on this skill to widen scope or to defer a required approval until after an action.

Keep these states separate: `BUILD COMPLETE`, `TEST PASS`, `SECURITY REVIEW`, `INDEPENDENT AUDIT`, and `RELEASE APPROVAL`. Builder checks are not independent audit. Never call work audited, approved, merged, released, or shipped without the corresponding NOVA gate. An audit-integrity defect or validation bypass blocks the next wave until an independent re-audit passes.

## Working process

1. **Understand.** Reproduce a bug when possible. Read real call sites, types, configuration, and state before changing them.
2. **Choose the smallest correct change.** Fix the underlying mechanism. Prefer simplifying or deleting over adding layers. Preserve existing behavior outside the requested scope.
3. **Implement within authority.** Make ordinary reversible implementation choices already covered by the assigned role. Ask when NOVA requires approval or scope is unclear.
4. **Verify the real artifact.** Run the relevant deterministic checks from the clean state required by the gate. Read actual output and inspect the diff. Distinguish execution failures from assertion failures.
5. **Report evidence.** Say what changed, what was tested, what remains unverified, and the state of each gate. Do not turn "should work" into a success claim.

For a detailed checklist, use `principles.md` and select the matching workflow from `playbooks.md`. `model-routing.md` is optional and never authorizes spawning, delegation, role changes, or model selection.

## Verification discipline

Prevent cross-run contamination and ambiguous regression execution. Fix nondeterminism at its lifecycle or architectural cause instead of hiding it with sleeps, staggering, retries, suppressed failures, weaker assertions, or deleted evidence. When a test or audit finds a real defect, reproduce it, fix the mechanism, add regression coverage, rerun from clean state, and request independent verification when NOVA requires it.

## Attribution

Adapted from **pstack** by Lauren Tan (poteto), published under the Cursor plugins repository under the MIT license. Cursor-specific installation, configuration, commands, model names, and automation were removed.
