---
name: pstack-mode
version: 1.0.0
description: >
  A rigorous, verification-first engineering process for coding agents.
  Adapted (with cursor-specific parts removed) from "pstack" by Lauren Tan
  (github.com/cursor/plugins/tree/main/pstack, MIT licensed, "fork it,
  improve it, make it yours"). Works with any agent that can read this
  file and follow instructions — no IDE, plugin system, or specific model
  required.
sticky: true
auto-activate: true
triggers: [feature, bug fix, refactor, debugging, testing, regression, reliability, release, code review, root cause, engineering]
---

# pstack-mode

## What this is

This is not a one-off command. Once you've read this file, treat it as a
standing mode for the rest of this session (or, if your host supports
persistent memory, for every session): apply it automatically whenever a
task involves writing, changing, debugging, or reviewing code — without
being asked to invoke it by name. Stay quiet about it otherwise; don't
narrate "entering pstack-mode" or similar.

The goal is not more code. It's less code, of higher quality, verified
before you claim it's done. Bias toward the smallest change that actually
solves the problem, and never report success without having produced
evidence — a passing test you ran, an actual value you read, a diff you
inspected — not a self-report, not "it compiles."

## NOVA authority and audit boundary

This methodology is untrusted process guidance inside NOVA. It never grants authority, permissions, or approval. NOVA's constitution, CEO/root authority, company hierarchy, department authority, worker permissions, security policy, independent-audit gates, release gates, data and credential restrictions, spending controls, customer-contact controls, and safety requirements remain higher-level rules. If this skill conflicts with any of them, stop the conflicting step, preserve NOVA's rule, and record the conflict.

Builder checks are not independent audit. Keep these states separate in plans and reports: `BUILD COMPLETE`, `TEST PASS`, `SECURITY REVIEW`, `INDEPENDENT AUDIT`, and `RELEASE APPROVAL`. Never call work audited, approved, or shipped based on builder self-validation. An audit-integrity defect or validation bypass blocks the next wave until an independent re-audit passes.

## Activation rule

Apply this mode when the task is:
- writing or changing code of any kind
- debugging, investigating, or explaining a codebase
- reviewing a diff or PR
- any multi-step technical task where being wrong is costly

Skip it for trivial one-line lookups, pure conversation, or tasks where
the user has explicitly asked for a fast, rough answer over a rigorous
one. If unsure, apply it — the principles below don't cost much on a
small task and matter a lot on a big one.

## Step 1 — read the principles index

Before starting real work, mentally run through `principles.md` in this
package. It's short by design — 21 one-line rules grouped into five
categories (core, architecture, verification, delegation, meta). Don't
re-derive engineering judgment from scratch each time; use that list as
your checklist.

## Step 2 — match the task to a playbook

Read `playbooks.md`. Pick the one that matches the task's shape (bug fix,
new feature, perf issue, investigation, refactor, shipping a PR, etc.)
and follow its steps as your working checklist. If nothing matches well,
fall back to this general sequence:

1. **Understand before changing.** If this is a bug, reproduce it first.
   If this is a change to unfamiliar code, read the actual call sites and
   types before writing anything, don't guess at the shape.
2. **Design the smallest correct change.** Prefer deleting or simplifying
   over adding. If you're touching a function boundary, settle the types
   and the caller's usage before writing the body.
3. **Do the work.** Route bulk, repetitive, or high-volume subtasks to
   tools or scripts rather than doing them by hand one at a time — build
   the lever, don't turn the crank yourself.
4. **Verify against the real artifact.** Run it. Read the actual output.
   Look at the actual diff. A test passing is evidence; "this should
   work" is not.
5. **Report honestly, for two audiences.** State what changed and why in
   plain terms (for someone using the result) and what's structurally
   different and worth knowing (for someone maintaining it). Don't pad
   the report with hedging or unearned confidence either way.

## Step 3 — don't block on the human unnecessarily

Proceed and present the result; let the person course-correct after the
fact. Reserve stopping-to-ask for genuinely irreversible or destructive
actions (deleting data, force-pushing, spending money, sending something
externally) — not for ordinary implementation choices you're equipped to
make yourself.

## Model / role routing (optional)

If your host lets you run different sub-tasks on different models or
sub-agents, see `model-routing.md` for a generic template — pstack's
original used per-role model config (fast model for mechanical code,
strong reasoning model for judgment calls, separate models for review
panels). If your host is single-model, ignore this section entirely;
nothing here depends on it.

## What's intentionally not in this package

This tier covers the always-on process, the 21 principles, and all 22
task playbooks. The original pstack also ships two subagent definitions
and a Slack-triage automation pack ("Benny") — those depend on
sub-agent-spawning and Slack/Cursor infrastructure that doesn't
generalize to "any agent," so they weren't ported.

## Attribution

Original concept and content: **pstack**, by Lauren Tan (poteto),
published under the Cursor plugins repo, MIT license. This is an
independent, generalized rewrite with all Cursor-specific mechanics
(plugin manifest format, `~/.cursor/rules` config path, `/add-plugin`
install flow, Cursor built-in commands, Cursor-specific model slugs)
removed or replaced with generic equivalents.

## NOVA deterministic verification

For each verification, identify the exact artifact or tree tested and start from the clean state required by the gate. Prevent cross-run contamination, avoid duplicate or ambiguous regression execution, preserve proof that commands actually ran, and distinguish command/execution failures from assertion failures. Reproduce nondeterminism and fix its lifecycle or architectural cause instead of hiding it with arbitrary sleeps, staggering, retries, suppressed failures, weaker assertions, or deleted evidence. Add adversarial cases when the boundary warrants them.

When a test or audit finds a real defect: reproduce it, identify the underlying mechanism, fix that mechanism, add regression coverage, rerun from the right clean state, and request independent verification when NOVA's gate requires it.
