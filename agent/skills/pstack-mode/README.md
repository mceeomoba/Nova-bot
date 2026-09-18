# pstack-mode (generic-agent port)

A cursor-free, model-agnostic port of the "core" of
[pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren
Tan (MIT license, "fork it, improve it, make it yours"): the always-on
engineering process (`SKILL.md`) plus the 21 underlying principles
(`principles.md`). No IDE, plugin marketplace, or specific model
required — just a text file an agent reads and follows.

**What's included:**
- `SKILL.md` — the standing mode/process. This is the file that "sticks"
  — once an agent has read it, it applies the process automatically for
  the rest of the session without being re-invoked.
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

## Why this works as "install once, sticks forever"

`SKILL.md` is written as a standing mode, not a one-shot command — it
explicitly tells the agent to keep applying itself on future turns
without being re-invoked by name, and to only stop if you tell it to.
That's the mechanism that makes "install it and it always follows the
process" work, independent of which model or tool is running it.

## Attribution

Original: pstack by Lauren Tan (poteto),
github.com/cursor/plugins/tree/main/pstack, MIT licensed. This port
strips every Cursor-specific mechanic (the `.cursor-plugin/plugin.json`
manifest, the `~/.cursor/rules/pstack-models.mdc` config path, the
`/add-plugin` install flow, Cursor built-in command references, and
Cursor-specific model slugs) and replaces them with generic equivalents
so it runs anywhere.
