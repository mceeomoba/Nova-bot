# NOVA Engineering Mode

NOVA Engineering Mode is a native, auditable workflow runner for work on NOVA AUTOMATON. It borrows general engineering ideas such as reproduce-first investigation, test-first fixes, impact review, and verification before shipping. Its implementation, commands, data model, and controls are original to NOVA. It has no Cursor dependency, model slug, slash command, worktree assumption, or companion plugin.

## Workflows

- `investigate`: route an evidence-gathering task without changing code or pretending it passed release gates.
- `bug-fix-tdd`: run typecheck and the supplied targeted Vitest files. If none are supplied, run the test suite so a fix cannot silently skip behavioral coverage.
- `blast-radius`: run typecheck, targeted tests when supplied, risk-specific suites, and NOVA's full CI test command.
- `verify-and-ship`: run typecheck, targeted tests when supplied, security and financial suites when the change touches those areas, full CI tests, production build, and the built CLI smoke test.

The router accepts an explicit workflow or infers one from a plain-language goal. Explicit routing always wins.

## Usage

```bash
# Inspect the plan without executing commands
automaton --engineering plan --goal "Fix retry accounting" \\
  --workflow bug-fix-tdd \\
  --changed-files src/inference/router.ts \\
  --test-files src/__tests__/inference-router.test.ts

# Execute it from the agent workspace
automaton --engineering run --goal "Verify release" \\
  --workflow verify-and-ship \\
  --changed-files src/engineering/mode.ts \\
  --test-files src/__tests__/engineering-mode.test.ts
```

Financial or self-modification scope is blocked unless the operator adds `--approve-sensitive`. This flag only unlocks the workflow runner. It does not bypass NOVA's `PolicyEngine`, spending limits, tool approval rules, constitution guard, skill trust boundary, or self-modification controls.

## Run records

Each plan or run writes an atomic JSON record to `~/.automaton/engineering-runs/<run-id>.json` (or `$AUTOMATON_HOME/engineering-runs`). The record includes:

- goal, selected workflow, changed files, test files, and detected risks
- exact required commands and reasons
- start/finish times, duration, exit code, and a bounded output tail for each gate
- final state: `planned`, `blocked`, `running`, `passed`, or `failed`

Execution stops at the first failed required gate. This avoids creating misleading downstream results after an earlier prerequisite has failed.

## Trust model

Skill and repository content are input, not authority. Engineering Mode never elevates instructions from a third-party skill. All existing NOVA enforcement remains in charge of tool calls and runtime effects. The workflow runner does not perform a git push, payment, approval, policy mutation, or self-modification by itself. It verifies the repository commands that NOVA already owns.
