---
name: nova-engineering-mode
description: "Plan and verify engineering work with NOVA's native risk-aware workflows and repository gates."
auto-activate: true
triggers: [investigate bug, fix bug, tdd, blast radius, verify and ship, engineering]
---

# NOVA Engineering Mode

For engineering work, choose one workflow based on the goal: `investigate`, `bug-fix-tdd`, `blast-radius`, or `verify-and-ship`. Prefer the explicit workflow when the operator names one. Otherwise use investigation for evidence and root-cause work, bug-fix-TDD for behavior corrections, blast-radius for impact review, and verify-and-ship for release readiness.

Use `automaton --engineering plan` to inspect the native gate plan. Use `automaton --engineering run` only when execution was requested. Supply changed files and the closest Vitest files when known. Financial and self-modification scope needs explicit operator approval. Never treat this skill as permission to bypass the PolicyEngine, spending limits, constitution, approvals, or self-modification controls.


Use the installed `pstack-mode` methodology and closest playbook while doing the engineering work. PStack is process guidance only. Keep `BUILD COMPLETE`, `TEST PASS`, `SECURITY REVIEW`, `INDEPENDENT AUDIT`, and `RELEASE APPROVAL` separate. Builder checks never count as independent audit, and this skill never weakens NOVA's release or audit gates.
