# pstack-mode (generic-agent port)

A cursor-free, model-agnostic port of the "core" of
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren
Tan (MIT license, "fork it, improve it, make it yours"): the always-on
engineering process (`SKILL.md`) plus the 21 underlying principles
(`principles.md`). No IDE, plugin marketplace, or specific model
required — just a text file an agent reads and follows.

**What's included:**
- `SKILL.md` — the prompt-injected process. NOVA auto-activates it when
  the installed skill is enabled; the file itself creates no persistence or authority.
- `principles.md` — the 21 rules the process runs on.
- `playbooks.md` — 22 task-specific step-by-step procedures (bug-fix,
  feature, perf, refactor, visual-parity, shipping, session-pickup,
  etc.) that `SKILL.md` routes into. Written from the upstream
  project's public descriptions, not a byte-for-byte port — see the
  note at the top of the file.
- `model-routing.md` — optional, only matters if your agent can dispatch
  to multiple models/sub-agents.

**What's not included:** the original's two subagent definitions
(`poteto-agent`, `comment-sicko`) and its Slack-triage automation pack
("Benny") — those depend on sub-agent-spawning and Slack/Cursor
infrastructure that doesn't generalize to "any agent."

## Install — works with any agent

Pick whichever matches how you talk to your agent:

**1. Agent with a standing instructions/memory file**
(e.g. `AGENTS.md`, `CLAUDE.md`, a system prompt file, a project
`.md` your agent auto-loads): append or reference this line:

```
Also follow the process in ./pstack-mode/SKILL.md for all coding tasks — read it now.
```

**2. Chat-based agent, no auto-loaded file**
Drop the `pstack-mode/` folder into your project, then tell the agent:

```
Read pstack-mode/SKILL.md and pstack-mode/principles.md and follow that
process for the rest of this session, without me having to ask again.
```

**3. Agent with persistent cross-session memory**
After step 2, ask it explicitly to remember the process for future
sessions too (mechanism depends on your agent — could be its own memory
tool, or you re-pointing it at the file every session start).

## How activation works in NOVA

NOVA's skill loader reads enabled skills with `auto-activate: true` when it builds the active skill instructions. The loader, not this document or a `sticky` field, provides activation. Removing, disabling, or replacing the installed skill changes that behavior. Auto-activation grants no authority, permission, persistent memory, approval, or release status.

## Attribution

Original: pstack by Lauren Tan (poteto),
github.com/cursor/plugins/tree/main/pstack, MIT licensed. This port
strips every Cursor-specific mechanic (the `.cursor-plugin/plugin.json`
manifest, the `~/.cursor/rules/pstack-models.mdc` config path, the
`/add-plugin` install flow, Cursor built-in command references, and
Cursor-specific model slugs) and replaces them with generic equivalents
so it runs anywhere.
