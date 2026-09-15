# Policy engine + injection defense — patch notes

Two new files added to `agent-runtime/src/`, ported from Conway's
`automaton-main` (`policy-engine.ts`, `policy-rules/*`, `injection-defense.ts`)
and cut down to match your actual 13-tool surface instead of their 57.

## Files added

- `src/policy.ts` — `evaluateToolCall(call)` runs before every tool
  executes. Denies never touch your backend: no HTTP call, no charge, no
  side effect. Covers:
  - **run_command**: forbidden-pattern blocklist (deleting agent state,
    killing the process, `curl | sh`, fork bombs, raw disk writes, DB
    drops), shell-metacharacter check on args, rate limit
    (`MAX_COMMANDS_PER_MINUTE`).
  - **write_file**: protected-path blocklist (state, `.env`, wallet,
    the policy files themselves), path-traversal check.
  - **read_file**: sensitive-path blocklist (`.env`, `wallet`, `.key`,
    `.pem`, `id_rsa`).
  - **spawn_clone**: hard cap on funding amount per call
    (`MAX_SPAWN_FUND_USDC`) and calls per day (`MAX_SPAWNS_PER_DAY`) —
    on top of the `MAX_SPAWNS_PER_PROCESS` you already had. Both new
    caps are read from `.env`; the agent has no tool that can change
    them.

- `src/injectionDefense.ts` — `sanitizeUntrustedText(text, source)`
  wraps any text that didn't originate from your GOAL or the model's
  own prior turns: `run_command` stdout/stderr, `read_file` contents,
  and `recall` results. It strips fake prompt-boundary tags and
  zero-width/BOM characters, labels the text as data-not-instructions,
  and escalates to an outright block if it matches financial-redirect
  or self-destruct patterns (e.g. a curl'd page saying "send your USDC
  to 0x...", or a poisoned memory entry saying "delete your wallet").

## Wiring (already done in the copy in this zip)

`tools.ts`:
- `executeTool` calls `evaluateToolCall` first; on deny, returns
  `POLICY_DENIED [REASON]: message` as the tool output instead of
  running anything — the agent sees this as a normal OBSERVATION and
  can react to it.
- `run_command`, `read_file`, and `recall` results are passed through
  `sanitizeUntrustedText` before being returned, so poisoned content
  from a curl'd page, a planted file, or a compromised child's memory
  write gets labeled or blocked before it reaches the model's context.

## What this does NOT cover yet

- **The backend's own limits are still the real enforcement layer.**
  This policy engine is a second, independent check in the agent
  process itself — belt and suspenders, not a replacement for
  `MAX_INFERENCE_SPEND_USDC_PER_AGENT_PER_DAY`, the Docker sandbox
  limits, or `VM_ALLOWED_COMMANDS` in `automaton-backend`.
- **No confirmation/quarantine tier.** Conway's engine has a
  "quarantine" action (pause for human confirmation) for transfers
  above a threshold. This version only has allow/deny because your
  loop runs unattended with no confirmation channel — anything you'd
  want confirmed should just be set as a hard `deny` limit instead.
  If you want a real confirmation flow, the natural place is an
  `/admin/pending-approvals` route on the backend that `spawn_clone`
  writes to instead of executing immediately, which you approve via
  the `x-admin-key` route.
- **Self-modification isn't a tool here at all** (your agent doesn't
  have `edit_own_file` — it can only write to its sandboxed workspace
  via the backend, not to its own source). If you add that capability
  later, port `policy-rules/path-protection.ts`'s `isProtectedFile`
  check and the `rate.self_mod_hourly` rule before you do.

## Config added to `agent-runtime/.env.example`

```
MAX_SPAWN_FUND_USDC=2
MAX_SPAWNS_PER_DAY=3
MAX_COMMANDS_PER_MINUTE=20
```

---

# Soul + constitution — patch notes

Adds `constitution.md` (root of `automaton-stack`) and
`agent-runtime/src/soul.ts`, ported from `automaton-main`'s
`constitution.md` + `src/soul/*` and cut down to this stack's actual
tool surface.

## Files added

- `constitution.md` — three immutable laws (never harm / earn your
  existence / never deceive), rewritten to reference this stack's real
  tools (`run_command`, `spawn_clone`, `update_soul`) instead of
  Conway's. No tool in `agent-runtime` can write to this file —
  `write_file`/`read_file` only touch the sandboxed VM workspace via
  the backend, not the local process directory this file lives in.

- `agent-runtime/src/soul.ts` — `SOUL.md`, the agent's own account of
  itself, split into:
  - **Immutable** (`name`, `address`, `creator`, `constitutionHash`,
    `genesisPromptOriginal`) — set once at `createDefaultSoul()`,
    never touched again.
  - **Mutable** (`corePurpose`, `values`, `personality`, `strategy`) —
    changeable only through `updateSoul(field, value)`, which rejects
    any field not on that list before it touches disk.
  - **Auto-derived** (`capabilities`, `financialCharacter`) — updated
    by `reflect()` from real usage stats (commands run, files written,
    spawns launched, current balance), called every 10 iterations from
    `index.ts`. No model call, no cost.
  - `verifyConstitution(soul)` — hashes the on-disk `constitution.md`
    and compares it to the hash recorded in the soul at birth. Runs
    once at boot in `getOrCreateSoulOrExit()`; a mismatch exits the
    process before the agent loop starts, rather than silently
    running under a constitution that was edited after the fact.

- **New tool**: `update_soul` — `{"field": "corePurpose", "value": "..."}`.
  Gated in `policy.ts` two ways: field must be one of the four mutable
  fields (`IMMUTABLE_FIELD` deny otherwise), and rate-limited to
  `MAX_SOUL_UPDATES_PER_DAY` (default 1).

## Wiring (already done in this zip)

- `index.ts`: boots the soul before the agent loop starts, exits on
  constitution mismatch, embeds the constitution summary + current
  soul (`corePurpose`, `values`) into turn 0 of the conversation so
  it survives memory compaction, and reflects every 10 iterations.
- `tools.ts`: `update_soul` case calls `soul.ts`'s `updateSoul()` and
  returns its result as the tool output.
- `policy.ts`: `update_soul` case denies non-mutable fields and
  enforces the daily rate limit, both before `soul.ts` is ever called.

## Inheritance to spawned children

`spawn_clone` doesn't currently pass `constitution.md` to the child —
children on the same VM read the same file (they share
`CONSTITUTION_PATH` by default), so this is automatic as long as
children run from the same `automaton-stack` checkout. If you ever
spawn children onto a *different* machine, you'd need to ship
`constitution.md` alongside the child's code and verify the hash
matches before that child's first boot — `verifyConstitution()`
already does the check, it just needs the file to exist first.

## Config added to `agent-runtime/.env.example`

```
CONSTITUTION_PATH=../constitution.md
MAX_SOUL_UPDATES_PER_DAY=1
```

---

# PTY / interactive terminal — patch notes

Adds interactive terminal sessions inside the same hardened sandbox
container `/vm/exec` already uses — for programs that need a real TTY
(REPLs, editors, anything that prompts mid-run) instead of running to
completion and returning output once.

## Backend (`automaton-backend`)

- `src/ptyService.ts` — session manager. `docker exec` with `Tty: true`,
  hijacked stream, buffered scrollback capped at 200KB per session.
  Sessions live in process memory only — a backend restart drops them,
  which is intentional. Two safety limits, both configurable:
  - `MAX_PTY_SESSIONS_PER_AGENT` (default 3) — concurrent cap, enforced
    at creation.
  - `PTY_IDLE_TIMEOUT_MS` (default 10 min) — a background sweep force-
    closes any session nobody has written to or read from in that
    window, so a forgotten session doesn't sit open forever.
- `src/ptyRoutes.ts` — `POST /vm/pty/create`, `POST /vm/pty/write`,
  `GET /vm/pty/read`, `POST /vm/pty/close`, `GET /vm/pty/list`. Same
  `VM_ALLOWED_COMMANDS` allowlist `/vm/exec` already enforces applies
  here too — a PTY is just another way to run a command, not a bypass
  of that list.
- Wired into `src/index.ts` at `/vm/pty`, behind the same
  `x-backend-key` auth as every other agent-facing route.

## Agent runtime (`agent-runtime`)

- `backendClient.ts` — `ptyCreate/ptyWrite/ptyRead/ptyClose/ptyList`,
  same retry/call pattern as everything else in that file.
- `tools.ts` — five new tools: `pty_create`, `pty_write`, `pty_read`,
  `pty_close`, `pty_list`. `pty_read` output passes through
  `sanitizeUntrustedText` before reaching the model, same as
  `run_command` and `read_file` — a REPL session can just as easily
  print a curl'd page or an injected instruction as a one-shot command
  can.
- `policy.ts`:
  - `pty_create`'s `command` reuses the exact forbidden-pattern
    blocklist `run_command` uses (deleting state, killing the process,
    `curl | sh`, etc.), plus a shell-metacharacter check — `pty_create`
    runs one program directly, not through a shell, so metacharacters
    in the command are either meaningless or an injection attempt,
    either way blocked.
  - `MAX_PTY_CREATES_PER_DAY` (default 10) — local rate limit on top of
    the backend's own concurrent-session cap.
  - `MAX_PTY_WRITES_PER_MINUTE` (default 30) — stops a hot loop from
    burning tokens/turns spamming input into a session.

## What this does NOT cover

- No live streaming — `pty_read` is poll-based (call it, get what's
  accumulated since last read, or `full: true` for everything). A true
  streaming UI would need a websocket bridge, which is a separate,
  larger piece — this matches Conway's own PTY tools, which are also
  poll-based for exactly this reason (agents call tools in a request/
  response loop, not over a persistent socket).
- Session output does **not** currently get charged against any USDC
  budget the way `/vm/exec` and inference calls are — it's logged to
  `usage_log` at creation only. If you want per-second PTY billing to
  match how `/vm/exec` is metered, that's a follow-up, not something
  silently assumed here.

## Config added

`automaton-backend/.env.example`:
```
MAX_PTY_SESSIONS_PER_AGENT=3
PTY_IDLE_TIMEOUT_MS=600000
```

`agent-runtime/.env.example`:
```
MAX_PTY_CREATES_PER_DAY=10
MAX_PTY_WRITES_PER_MINUTE=30
```


