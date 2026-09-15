# Your automaton — deploy notes

This is `automaton-backend` + `agent-runtime`, unmodified from the stock
self-hosted design except for one addition: **`spawn_clone` now actually
launches the child process**, not just funds its wallet (see "What
changed" below). Everything else — wallets, x402 USDC payments on Base,
the OpenRouter gateway pointed at `ox-alpha`, the sandboxed VM — is the
stock design, aimed at your infrastructure instead of NOVA's.

No NOVA dependency exists anywhere in this tree. `legacyApiUrl`,
`the legacy hosted API`, SIWE-via-NOVA — none of it is here; this was written
as a from-scratch backend + agent runtime, not a patched fork of the
original `automaton-main` (which is 2.6MB of interlinked NOVA-specific
code across ~70 files — replatforming that in place would mean rewriting
most of it anyway, so this smaller purpose-built pair is the actual
decoupled system, matching the design the original repo's own README
pointed you toward).

## Your stack, mapped to this repo

| What you said you have | Where it plugs in |
|---|---|
| Alibaba Cloud VM | Runs both `automaton-backend` (port 8080) and `agent-runtime` as two systemd services on the same box |
| OpenRouter, `ox-alpha` | `backend/.env` → `OPENROUTER_API_KEY`, `OPENROUTER_MODEL=ox-alpha` (already the default) |
| Real wallets / on-chain USDC | `CHAIN_NETWORK=base` in `backend/.env` once you've tested on `base-sepolia` — wallets are real EVM keys, encrypted at rest in the backend's SQLite |
| Self-replication | Kept and completed — see below |

## What changed: self-replication actually replicates now

Stock `agent-runtime` funded a clone's wallet but left starting its
process as a manual step for you. `agent-runtime/src/spawner.ts` (new)
launches it automatically: `spawn_clone` now funds the wallet **and**
starts a detached child `automaton-agent` process on the same VM, with
its own state file and log file under `agent-runtime/data/children/<name>/`.

Two safety rails on top of the backend's own budget caps, since this is
the one part of the stack that can compound on itself:

- **`MAX_SPAWNS_PER_PROCESS`** (`agent-runtime/.env`, default `3`) — hard
  cap on how many child processes any single agent process may launch.
  Past the cap, funding still happens (that's a real transfer, so it
  always completes) but no process starts, and the agent is told why.
- Every child is a fully separate OS process with its own `.env`-derived
  config, its own wallet, and its own spend caps enforced server-side —
  there's no shared memory or state between parent and child beyond the
  backend's `parent_address` lineage record you can query at
  `GET /wallet/:address/lineage`.

Nothing here removes the backend's own per-agent daily inference/vm
budget caps — those still apply to every clone independently, same as
the founder agent.

## Memory: ported from automaton-main's larger memory subsystem

Beyond the stock episodic (auto-compaction) and semantic (`remember`/`recall`)
layers, two more layers are ported in from `automaton-main/src/memory/`,
adapted to drop their NOVA/ULID dependencies and scope every row to
`agent_address` (so clones each get their own, not one shared store):

- **Procedural memory** (`memory/procedural.ts` in the original) — reusable
  step-by-step procedures with success/failure counts, via `save_procedure`
  / `recall_procedure` / `procedure_outcome`.
- **Knowledge store** (`memory/knowledge-store.ts` in the original) —
  categorized (market/technical/social/financial/operational),
  confidence-scored facts, via `learn_fact` / `query_knowledge`. Distinct
  from plain `remember`: use this when "how sure am I" matters.

**Not yet ported** — the rest of `automaton-main`'s memory/orchestration/
skills subsystems (~10K more lines: compression-engine, enhanced-retriever,
context-manager, the full task-graph/planner/orchestrator multi-agent
colony system, and the skills loader/registry) are large enough that
porting them well is its own separate pass, not a quick add-on. Say the
word and I'll take the next one — orchestration is the biggest of the
three and worth scoping on its own, since the original's planner is
written for a NOVA "agent colony" and needs real thought about what
that means for your single-founder-plus-clones setup rather than a
mechanical port.

## Deploy order

1. **Backend first.** Follow `README.md` sections 1–4 exactly on your
   Alibaba VM: provision Ubuntu, install Node + Docker, `docker build`
   the sandbox image, fill `.env` (your real `OPENROUTER_API_KEY`, a
   **fresh** `FACILITATOR_PRIVATE_KEY` funded with a little ETH on Base
   for gas, your `TREASURY_ADDRESS`), run as `automaton-backend.service`.
   Test with `base-sepolia` + testnet USDC before touching `base` mainnet.

2. **Agent runtime second.**
   ```bash
   cd agent-runtime
   npm install
   cp .env.example .env
   nano .env   # BACKEND_URL=http://localhost:8080, BACKEND_API_KEY matches backend's
   npm run build
   ```
   Set `GOAL` to whatever you want this founder agent actually doing —
   the stock placeholder text won't do anything useful. Then either run
   `npm start` interactively to watch its first few iterations, or
   install `agent-runtime/automaton-agent.service` and
   `sudo systemctl enable --now automaton-agent`.

3. **Fund the founder wallet.** First run prints its address and exits
   (balance is $0). Send it real USDC on Base (or testnet USDC on
   `base-sepolia` first) before it can do anything — this is true of
   every clone it spawns later too.

4. **Watch it.** `GET /admin/status` (with `x-admin-key`, never the
   agent's own key) gives you spend, budget usage per agent including
   clones, exec failures, and sandbox health in one call. For clones
   specifically, `agent-runtime/data/children/<name>/agent.log` has that
   child's own console output.

## Before you flip `CHAIN_NETWORK` to `base` (real money)

- `VM_ALLOWED_COMMANDS` in the backend `.env` — start narrow
  (`node,python3,git,curl`) and widen deliberately. Empty means "any
  command" and the README is explicit that's not a shipping config.
- `MAX_INFERENCE_SPEND_USDC_PER_AGENT_PER_DAY` and
  `MAX_SPAWNS_PER_PROCESS` — these are your actual financial exposure
  limits once clones can fund further clones. Size them to what you're
  genuinely willing to lose if something goes wrong, not just what
  seems reasonable for one agent.
- `FACILITATOR_PRIVATE_KEY` must be a wallet you created fresh for this
  and funded only with gas money — never a personal wallet.
- Security group on the VM: only your backend's port and SSH from your
  own IP, per `README.md` section 1. `/vm/*` should never be internet-facing
  without a reverse proxy + TLS in front of it.
