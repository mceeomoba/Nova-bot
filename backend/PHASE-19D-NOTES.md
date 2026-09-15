# Zent.md Phase 19d — Guardrails, Limits & Kill-Switches: Kill/Recall Path

Deliverable per Zent.md:

> 19d. Kill/recall path: the root agent (or Agent B's own failure
> detection) can freeze or wind down a specific pipeline-spawned
> company without touching the pipeline or any of its other
> siblings — an internal control, not an external operator action.

## What this session built

**`backend/src/expansionKillSwitch.ts`** (new) — the core logic, split
into the two authorities that can actually see a problem in a live
company, matching how this was scoped in chat:

- `shutdownAgentServer()` — security-department half. Wraps
  `orchestrator.ts`'s existing `killAgentProcess()` (already built for
  next-phase.md Phase 5a) with a company-scoped, audited call: SIGTERM
  first, SIGKILL retry if that fails, "already not running" treated as
  a successful no-op rather than an error.
- `freezeAgentFunds()` — finance-department half. Sets a new
  `agents.frozen` flag, enforced at `wallet.ts`'s
  `signPaymentAuthorization()` — the one chokepoint every outgoing
  payment this backend ever signs already passes through (clone-funding,
  x402, marketplace purchases, all of it), so freezing holds regardless
  of which process or department later tries to spend. Does not block
  *incoming* payments. Idempotent — freezing an already-frozen agent
  updates the reason/timestamp rather than erroring, same upsert
  posture `haltExpansionPipeline()` (19c) already uses.
- `killPipelineSpawnedCompany()` — composes both. Neither half is the
  other's precondition (each independently try/caught), so a process
  that's already dead never prevents the wallet from still being locked,
  and vice versa. Every call writes exactly one `kill_events` row
  recording what happened to each half, whichever path it came through.
- `securityShutdown()` / `financeLockFunds()` — the split, single-action
  entry points for the security-only and finance-only cases described
  in chat, both routed to their own endpoints below.
- Target validation (`loadKillableTarget()`): every action refuses a
  target that isn't `spawn_reason = 'expansion_pipeline'` — the root
  agent itself, or an ordinary `spawn_clone` worker, is never a valid
  target, matching Zent.md's own "a specific pipeline-spawned company"
  / "without touching the pipeline" scope.
- No unfreeze/resume export. Same posture `expansionCircuitBreaker.ts`
  already takes for `resumeExpansionPipeline()` (deliberately not an
  HTTP route) — recovery in this pipeline is the root agent's own next
  cycle acting again on changed conditions, never a flip-the-switch-back
  call on a specific kill.

**`backend/src/db.ts`** — `agents.frozen` / `frozen_reason` /
`frozen_at` (inline migration, same `PRAGMA table_info` + `ALTER TABLE`
convention every prior phase's columns use), plus a new `kill_events`
table: one append-only row per shutdown/freeze/kill action, covering
`initiator` (`self` | `parent` | `admin`) and a JSON `detail` blob with
both sub-action outcomes.

**`backend/src/wallet.ts`** — `signPaymentAuthorization()` now reads
`frozen`/`frozen_reason` alongside the existing `encrypted_key` lookup
and throws (423 Locked) before any department-budget/capability/channel
check runs, same "fail closed before doing real work" ordering those
existing checks already use.

**`backend/src/expansionKillRoutes.ts`** (new) — agent-facing routes,
mounted at `/expansion` in `index.ts` (a second router sharing that
prefix with `expansionRoutes.ts`, same shared-secret tier):

- `POST /expansion/:agentAddress/security/shutdown`
- `POST /expansion/:agentAddress/finance/lock-funds`
- `POST /expansion/:agentAddress/kill` (combined — the route Zent.md's
  own wording describes)
- `GET /expansion/:agentAddress/kill-events` (read-only)

Authorization is re-derived from the DB on every call, never trusted
from the request body: `callerAddress` must equal the target itself
(`self`) or match `agents.parent_address` for the target (`parent`) —
same "requires the calling agent_address to match" posture Phase 15b's
`decide_expansion` already uses for the CEO gate. An unrelated
`callerAddress` gets a 403, not a soft failure.

**`backend/src/orchestratorRoutes.ts`** — three additions, all under
the existing `/admin/orchestrator` prefix (x-admin-key only, never an
agent's own `BACKEND_API_KEY` — same tier as that router's pre-existing
`/:address/kill`):

- `POST /admin/orchestrator/:address/kill-company`
- `POST /admin/orchestrator/:address/freeze-funds`
- `GET /admin/orchestrator/kill-events`

## Why an admin backstop exists on top of Zent.md's own text

Flagged and discussed in chat before building: Zent.md 19d's own words
are "an internal control, not an external operator action," and every
earlier Phase 19 sub-phase's own notes are explicit that no human
approval step exists anywhere in this pipeline. This session adds
exactly one exception to that pattern, and only here, for a reason
specific to this sub-phase: 19d is the last available control over an
already-live company holding real funds (`GAZA_DEPLOY.md` — real EVM
wallets, real on-chain USDC on Base, not a simulated balance) that can
itself launch further child processes. The internal path — Security
department shutting down a corrupted Company B's process, Finance
department locking its wallet, or Company B/its parent self-triggering
a full kill — is the normal, first-line, fully autonomous mechanism and
is expected to handle the overwhelming majority of real failures; the
routes in `expansionKillRoutes.ts` are that path and nothing about them
is gated by a human.

The specific gap the admin routes cover: Company B, its Security
department, and its Finance department are all the same kind of
thing — LLM-driven agents, reasoning over the same infrastructure and
potentially the same manipulated context (e.g. a prompt-injected
research result Company B ingested and then reported upstream as
legitimate). A failure mode that fools one of them is not guaranteed to
spare the others, so "an internal department caught it" is not a
different failure-independent layer the way an operator holding a
separate credential, on separate infrastructure, is. The admin routes
never trigger anything on their own — they exist so the person who owns
the VM and the wallet is not locked out of their own infrastructure in
exactly that scenario. They reuse the same
`killPipelineSpawnedCompany()`/`financeLockFunds()` functions the
agent-triggered path calls (only `initiator: 'admin'` differs, recorded
in `kill_events` like any other field) — not a separately-shaped or
more powerful action, and still scoped to one company at a time, same
as every other guarantee in this phase.

## Error handling

Per this session's own request for "error management so that error
won't even occur": every exported action in `expansionKillSwitch.ts`
distinguishes *invalid target* (throws `KillSwitchTargetError`, caught
by the route layer and turned into a 4xx) from *live target, action
outcome* (never throws — a not-running process or an already-frozen
wallet is a successful no-op, not a failure). `shutdownAgentServer()`
retries once with SIGKILL if SIGTERM delivery fails before reporting
failure. The `kill_events` audit write itself is wrapped separately and
never allowed to undo or fail a freeze/kill that already happened — a
lost log row is logged to stderr and swallowed rather than reverting a
real action taken moments earlier.

## Test coverage

Not yet added this session — flagging rather than skipping silently.
Next real step: `expansionKillSwitch.test.ts` (inlined mirror,
`node --experimental-strip-types --test`, same convention every prior
Phase 19 test file uses) covering: target validation (root address and
`spawn_reason='self'` both rejected); idempotency of both freeze and
shutdown on an already-frozen/already-stopped target; the
independent-halves guarantee (one half failing doesn't block the
other); the self/parent authorization resolution in
`expansionKillRoutes.ts` (unrelated caller rejected, self and parent
both accepted); and the `signPaymentAuthorization()` frozen-agent
rejection in `wallet.ts`.

## Phase 19 status

19a, 19b, 19c, and now 19d are built and wired. Still open: 19e
(dry-run mode) and this session's own flagged test-coverage gap above.
