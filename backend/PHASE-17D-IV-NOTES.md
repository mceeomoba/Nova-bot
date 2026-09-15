# Zent.md Phase 17d-iv — Real Agent-Runtime Identity Provisioning

Not a phase Zent.md's own text named — inserted here because 17e-ii's
own smoke test (`genesisSmokeTest.ts`) could never actually pass
without it. Two independent, compounding gaps, both confirmed against
the code (not assumed):

1. **No `~/.automaton` for Agent B, ever.** `genesisCompany()`
   (`genesis.ts`) has always provisioned a wallet
   (`createClonedAgentWallet()`, 16a) and an `office/config/` tree
   (`copyCloneConfig()`, 17b) — neither is where `agent/`'s own runtime
   looks. `agent/src/identity/wallet.ts`'s `getAutomatonDir()` was
   hardcoded to `$HOME/.automaton` with no override point anywhere in
   this codebase (confirmed by grep before this session — zero hits for
   any config-dir env var).
2. **Even if something had written one, the sandbox couldn't hold it.**
   `docker.ts`'s `createNamedSandbox()` runs Agent B's container with
   `ReadonlyRootfs: true`, `User: "10001:10001"`, and exactly two
   writable mounts: `office/fs` → `/workspace`, `browser/` →
   `/home/agent/.browser-profile`. `office/config/` itself is
   documented (`office.ts`'s own comment on `officeConfigDir()`) as
   **not** bind-mounted into that container at all — invisible from
   inside it, by design.

`genesisSmokeTest.ts` ran `automaton --tick-once` inside exactly that
container via `execInNamedSandbox()`. Every genesis's first tick could
only time out (hung on the interactive setup wizard's stdin prompts,
which never resolve under a non-interactive `docker exec`) or exit
non-zero (no backend API key on disk) — the `genesis_tick_smoke_tests`
table this wrote to has never recorded a real `passed` outcome.

Separately, `orchestrator.ts` (Phase 5a) already exists as a *real*
answer to "give an agent an OS process" — but its own `config.agentRuntimeDir`
defaulted to `../agent-runtime`, a package that file's own module doc
says was "rewritten to a deprecation notice." The actual current
runtime in this repo is `agent/`, never pointed at. Its doc comment
also claimed an `AGENT_ADDRESS`-driven "resume path" in
`agent-runtime/src/index.ts` that does not exist anywhere in this zip —
`agent/src/index.ts` had zero references to `AGENT_ADDRESS` before this
session.

## What landed

**`agent/src/identity/wallet.ts`**: `AUTOMATON_DIR` now resolves
`AUTOMATON_CONFIG_DIR` when set, falling back to the original
`$HOME/.automaton` default otherwise — the one change every other fix
below depends on.

**`agent/src/index.ts`** (`bootstrapAgentRuntime()`):
- A missing/invalid `automaton.json` now throws immediately instead of
  falling through to the interactive setup wizard when
  `AUTOMATON_NON_INTERACTIVE=1` or there's no TTY — turns a silent hang
  (previously: wait for `genesisTickSmokeTestTimeoutMs`, then report
  `timeout`) into an immediate, legible `unhandled_error`.
- A cheap resume-verification check: if the caller set `AGENT_ADDRESS`
  and the wallet actually loaded from `AUTOMATON_CONFIG_DIR` doesn't
  match, throws rather than booting under a mismatched identity. This
  is the "resume path" `orchestrator.ts`'s doc comment always claimed
  existed — it didn't, until now.

**`backend/src/wallet.ts`**: new exported `getAgentPrivateKeyHex(address)`
— `getAgentAccount()` already decrypted an agent's key in-process but
only ever returned a viem `PrivateKeyAccount`, no raw hex. `decrypt()`
itself stays unexported/unchanged.

**`backend/src/config.ts`**: `agentRuntimeDir` now defaults to
`../agent` (was `../agent-runtime`). New `agentIdentityDataDir` — a
host-side, per-agent-address directory for wallet.json/automaton.json/
state.db, separate from `agentProcessDataDir` (which only ever held
logs/STATE_PATH, never identity).

**`backend/src/genesis.ts`**: new `provisionAgentRuntimeIdentity()`,
called from `genesisCompany()` right after 16e's `tagCompanyLineage()`.
Writes `wallet.json` (reusing the exact key `createClonedAgentWallet()`
already minted, via `getAgentPrivateKeyHex()` — never a second, orphaned
key) and `automaton.json` (with a real `backendApiKey`: this backend
authenticates every agent with one shared secret,
`config.backendApiKey`, checked in `index.ts`'s `x-backend-key`
middleware — there is no per-agent key issuance mechanism anywhere in
this codebase to build, so Agent B's config just gets that same shared
secret directly) to `config.agentIdentityDataDir/{agentAddress}`. Guards
against double-provisioning the same address (refuses if `wallet.json`
already exists — a real private key file, never silently overwritten).
`GenesisCompanyResult` gained one field: `agentIdentityDir`.

**`backend/src/orchestrator.ts`**:
- `spawnAgentProcess()` now sets `AUTOMATON_CONFIG_DIR` (derived from
  `config.agentIdentityDataDir` + agent address) and
  `AUTOMATON_NON_INTERACTIVE=1` on every spawned child — previously set
  neither, so every agent process this backend ever spawned on one host
  would have collided on the same `$HOME/.automaton`.
- New `spawnAgentProcessTickOnce()` — a one-shot, awaitable variant
  (not `detached`/`unref()`'d like `spawnAgentProcess()`; this one
  needs to be awaited synchronously by its caller) that runs `automaton
  --tick-once` for one agent and resolves with exit code / timeout /
  crashed status. Deliberately not folded into `spawnAgentProcess()`
  itself — that function's whole shape (detached, tracked in
  `agent_processes`, audited) is wrong for a transient smoke-test tick,
  same as the `execInNamedSandbox()` call this replaces never touched
  `agent_processes` either.

**`backend/src/genesisSmokeTest.ts`**: `runFirstTickSmokeTest()` now
calls `spawnAgentProcessTickOnce()` instead of `execInNamedSandbox()`.
The `crashed_sandbox` outcome category is renamed `crashed_process` —
its meaning shifts from "the docker exec call itself threw" to "spawn()
itself never produced a running process." `sandboxId` stays in the
function's signature (existing callers already pass it, and the DB row
never stored it in the first place) but no longer selects where the
tick runs.

## What this deliberately does NOT do

- **Does not touch 17e-iii/17e-iv.** Constitution/guard compliance on
  the tick, and the active-status transition, are unchanged — this
  phase only makes it possible for a tick to run and be honestly
  classified at all.
- **Does not add per-agent backend API keys.** This backend's
  authentication model (one shared `x-backend-key` secret) is unchanged
  by this phase; `provisionAgentRuntimeIdentity()` reuses the existing
  shared secret rather than building new issuance machinery Zent.md
  never asked for.
- **Does not remove or rename `office/config/`, `createCloneShell()`,
  or `createClonedAgentWallet()`.** All three are reused exactly as
  16a/16c/17b already documented; this phase only adds the missing
  fourth piece (a runtime-readable identity) alongside them.
- **Does not migrate the old `execInNamedSandbox()`/Docker-sandbox tick
  path anywhere else in the codebase**, if one exists outside
  `genesisSmokeTest.ts` — not audited in this session; grep for
  `execInNamedSandbox.*"automaton"` before assuming this is the only
  call site.

## Sanity checks

No `node_modules`/live environment here — same caveat every
genesis-family change in this repo already carries; no real `tsc`/live
spawn test. Checked instead:

- Every new/edited file's imports resolve to functions that actually
  exist and are actually exported at their current signatures
  (`getAgentPrivateKeyHex` in `wallet.ts`, `spawnAgentProcessTickOnce`
  in `orchestrator.ts`, `getAutomatonDir` in
  `agent/src/identity/wallet.ts`) — read each definition directly
  rather than assuming from the call site.
- Confirmed `agent/package.json`'s `main`/`tsconfig.json`'s
  `outDir`/`rootDir` (`dist/index.js`, `src` → `dist`) actually produce
  `agent/dist/index.js` — the exact path `orchestrator.ts`'s
  `spawnAgentProcess()`/`spawnAgentProcessTickOnce()` join, once
  `agentRuntimeDir` points at `agent/` instead of the deprecated
  `agent-runtime` sibling.
- Confirmed this backend's agent authentication really is one shared
  secret (`backend/src/index.ts`'s `x-backend-key` middleware, `key !==
  config.backendApiKey`) before writing `provisionAgentRuntimeIdentity()`
  around that assumption, rather than inventing a per-agent key scheme
  that doesn't match how anything else in this backend actually
  authenticates.
- Confirmed `automaton.json` (not `config.json`) is the real filename
  `agent/src/config.ts`'s `CONFIG_FILENAME` expects.

Next real step, same as every other genesis-family file here: run this
against a live Docker/Node environment, including at least one real
`genesisCompany()` call followed by `genesisExecutorAdapter()`'s
automatic first tick, to confirm `passed` is now a reachable outcome —
not just, as before this phase, structurally guaranteed to never be.
