import "dotenv/config";
import path from "path";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Phase 9a-iii — unlike required(), this never throws at startup: the
// Domain Management stack (9b/9c/9d) isn't built yet, so a deployment
// running only Phase 0–9a can't reasonably be expected to have
// Cloudflare/Mailcow credentials set. Warn once at config load (the
// closest existing analogue to how a required() failure would surface
// a missing secret) and return "" rather than a fabricated default —
// any 9c/9d call site that actually needs this must check for an empty
// string itself before making a real API call, not assume it's set.
function optionalSecret(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.warn(`[config] optional env var ${name} is not set — features depending on it will be unavailable`);
    return "";
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8000),
  backendApiKey: required("BACKEND_API_KEY"),
  adminApiKey: required("ADMIN_API_KEY"),

  // --- Local inference (llama.cpp server on this VM) ---
  // This is now the PRIMARY model /inference/chat serves — see
  // LOCAL_MODEL_PATCH_NOTES.md. OpenRouter (below) is kept configured
  // as a fallback for when the local server is unreachable, and as the
  // path to flip back to a hosted model later if you migrate off the
  // VM. localModelBaseUrl must be an OpenAI-compatible `/v1` root
  // (llama-server's default `--host 127.0.0.1 --port 8080` exposes
  // exactly this).
  localModelBaseUrl: process.env.LOCAL_MODEL_BASE_URL || "http://127.0.0.1:8080/v1",
  // llama-server generally ignores an unrecognized `model` field and
  // just serves whatever GGUF it was started with, but we still send
  // a real name — for logging/usage_log clarity, and so this lines up
  // with whatever you pass to `--alias` on the server if you set one.
  localModelName: process.env.LOCAL_MODEL_NAME || "qwen3-4b",
  localModelTimeoutMs: Number(process.env.LOCAL_MODEL_TIMEOUT_MS || "60000"),
  // Master switch: true = try the local model first, fall back to
  // OpenRouter on failure (the intended steady state right now). false
  // = go straight to OpenRouter, skipping the local server entirely —
  // useful once you actually migrate off the VM later, without having
  // to rip the local code back out.
  useLocalModelPrimary: (process.env.USE_LOCAL_MODEL_PRIMARY ?? "true") === "true",

  // Separate perception service. This is intentionally not part of the
  // reasoning gateway: browser workers send screenshots only to this VLM.
  visionModelBaseUrl: process.env.VISION_MODEL_BASE_URL || "",
  visionModelApiKey: process.env.VISION_MODEL_API_KEY || "",

  // --- OpenRouter (fallback only, see useLocalModelPrimary above) ---
  // optionalSecret(), not required(): a fresh deployment running purely
  // on the local model shouldn't be forced to have an OpenRouter key
  // just to boot. If it's unset, the fallback path is simply skipped
  // (a local-model failure surfaces as an error instead of silently
  // switching providers) — inferenceGateway.ts checks for this at the
  // point of use, never assumes it's present.
  openrouterApiKey: optionalSecret("OPENROUTER_API_KEY"),
  openrouterModel: process.env.OPENROUTER_MODEL || "ox-alpha",
  // error-fix.md Phase 11: the agent-side InferenceRouter/ModelRegistry
  // (agent/src/inference/) has always selected a model per tier/task,
  // but nothing on the backend ever accepted a caller-supplied model —
  // /inference/chat hardcoded openrouterModel regardless. This is the
  // one additional model /inference/chat will now serve when a request
  // asks for it (low-compute tiers only); anything else still falls
  // back to openrouterModel. Defaults to openrouterModel itself (i.e.
  // a no-op) so a deployment that never sets this env var behaves
  // exactly as before.
  openrouterLowComputeModel:
    process.env.OPENROUTER_LOW_COMPUTE_MODEL || process.env.OPENROUTER_MODEL || "ox-alpha",
  pricePer1kTokensUsdc: Number(process.env.PRICE_PER_1K_TOKENS_USDC || "0.01"),

  facilitatorPrivateKey: required("FACILITATOR_PRIVATE_KEY") as `0x${string}`,
  chainNetwork: (process.env.CHAIN_NETWORK || "base-sepolia") as
    | "base"
    | "base-sepolia",

  vmWorkdir: process.env.VM_WORKDIR || "/home/automaton-agents",

  // Founder-controlled backend mirror. The token is read only from the
  // deployment environment; it is never logged or persisted in git.
  githubSyncEnabled: (process.env.GITHUB_SYNC_ENABLED ?? "false") === "true",
  githubSyncOwner: process.env.GITHUB_SYNC_OWNER || "segz7448",
  githubSyncRepo: process.env.GITHUB_SYNC_REPO || "nova-backend",
  githubSyncBranch: process.env.GITHUB_SYNC_BRANCH || "main",
  githubSyncIntervalMs: Number(process.env.GITHUB_SYNC_INTERVAL_MS || "30000"),
  githubToken: optionalSecret("GITHUB_TOKEN"),
  githubSyncRoot: process.env.GITHUB_SYNC_ROOT || process.cwd(),
  githubRestartCommand: process.env.GITHUB_RESTART_COMMAND || "",

  // --- Agent-OS: per-agent "office" (architecture-agent.md §1/§2) ---
  // Root under which every agent gets its own /office/{workspace,inbox,
  // outbox,private} + /browser tree, keyed by agent address, never by
  // name. Separate from vmWorkdir (which stays as the legacy shared-
  // container scratch path) so the migration to per-agent offices is
  // additive, not a destructive rename of an existing production dir.
  officesDir: process.env.OFFICES_DIR || `${process.env.VM_WORKDIR || "/home/automaton-agents"}/agents`,

  // next-phase.md Phase 3f-i (architecture-agent.md §3 join_project()):
  // root under which a joint_project channel gets its own
  // /joint/{channel_id}/ directory. Deliberately NOT under officesDir —
  // a joint directory belongs to neither party's own office (office.ts's
  // own module doc already reserves office/{fs,private} for exactly one
  // agent), so it gets its own top-level root instead of living inside
  // either agent's tree.
  jointProjectsDir: process.env.JOINT_PROJECTS_DIR || `${process.env.VM_WORKDIR || "/home/automaton-agents"}/joint`,

  // next-phase.md Phase 4d (architecture-agent.md §5 COW table): the
  // canonical constitution.md every brand-new office's config copy is
  // seeded from (office.ts's readDefaultConstitution()). Relative to
  // backend's own cwd by default, same convention dbPath below already
  // uses — this repo's own backend/constitution.md, not agent-runtime's
  // separate CONSTITUTION_PATH (soul.ts), which governs the OTHER,
  // pre-existing self-hosted agent process and is deliberately left
  // alone by this phase — see cloning.ts's module doc for why that
  // mechanism isn't touched here either.
  defaultConstitutionPath: process.env.DEFAULT_CONSTITUTION_PATH || "./constitution.md",
  vmAllowedCommands: (process.env.VM_ALLOWED_COMMANDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  dbPath: process.env.DB_PATH || "./data/backend.db",

  // --- Docker sandbox (where /vm/exec actually runs) ---
  dockerSandboxImage: process.env.DOCKER_SANDBOX_IMAGE || "automaton-sandbox:latest",
  dockerSandboxNetwork: process.env.DOCKER_SANDBOX_NETWORK || "none",

  // next-phase.md Phase 9f-i (Founder request): a top-level Agent's own
  // default sandbox (vmService.ts's getOrCreateDefaultSandbox) gets
  // real bridge networking by default now — this is the top of the
  // hierarchy, per §4d the Agent is trusted with cross-department
  // authority already, and the Founder explicitly wants every Agent to
  // have internet in its own sandbox so it can, in turn, decide which
  // of its departments get network access. Departments/projects do
  // NOT inherit this default — they stay network-disabled unless the
  // owning Agent explicitly opts one in via create_department's
  // wantsNetwork flag or POST /departments/:id/network, and Finance/
  // Security/Server can never be opted in at all (see toolRegistry.ts's
  // HARDENED_NETWORK_DEPARTMENT_TYPES).
  defaultAgentSandboxNetwork: (process.env.DEFAULT_AGENT_SANDBOX_NETWORK ?? "true") === "true",

  dockerMemoryLimitMb: Number(process.env.DOCKER_MEMORY_LIMIT_MB || "512"),
  dockerCpuQuota: Number(process.env.DOCKER_CPU_QUOTA || "1"), // cores
  dockerPidsLimit: Number(process.env.DOCKER_PIDS_LIMIT || "128"),
  execTimeoutMs: Number(process.env.EXEC_TIMEOUT_MS || "30000"),
  execMaxOutputBytes: Number(process.env.EXEC_MAX_OUTPUT_BYTES || "1048576"), // 1MB

  // Zent.md Phase 17e-ii: "run one tick to completion and assert no
  // unhandled error, timeout, or crashed sandbox." A real agent-loop
  // tick (bootstrap + inference call(s) + tool execution) runs a lot
  // longer than the ordinary shell commands execTimeoutMs above is
  // sized for — 30s would misclassify a slow-but-healthy first tick as
  // a timeout. Independent constant, own env var, rather than reusing
  // or widening execTimeoutMs itself (which every non-genesis /vm/exec
  // caller still needs to stay short for).
  genesisTickSmokeTestTimeoutMs: Number(
    process.env.GENESIS_TICK_SMOKE_TEST_TIMEOUT_MS || "180000", // 3 minutes
  ),
  // A tick's stdout/stderr (tool-call logs, turn summaries) can run
  // larger than a typical exec's output — same reasoning as the timeout
  // above, own cap rather than reusing execMaxOutputBytes.
  genesisTickSmokeTestMaxOutputBytes: Number(
    process.env.GENESIS_TICK_SMOKE_TEST_MAX_OUTPUT_BYTES || "2097152", // 2MB
  ),

  // Zent.md Phase 18a: Agent B is funded with USDC at birth but never
  // ETH (see erc8004.ts's fundGasForRegistration() header for why that
  // matters) — this is the hard ceiling on how much ETH the automatic
  // registration path will ever move from a root/parent agent's wallet
  // to a freshly-born child's, regardless of what the live gas estimate
  // says. Default sized generously above a typical Base registration's
  // real cost (a few cents) specifically so it stays a "top up gas,"
  // not a "fund the company" number — Phase 16b's USDC funding cap is
  // the actual capital decision; this one is not allowed to become a
  // second one denominated in wei.
  genesisGasFundingWeiCap: BigInt(process.env.GENESIS_GAS_FUNDING_WEI_CAP || "500000000000000"), // 0.0005 ETH

  maxInferenceSpendUsdcPerAgentPerDay: Number(
    process.env.MAX_INFERENCE_SPEND_USDC_PER_AGENT_PER_DAY || "2",
  ),

  // Same shape as the inference budget above, kept independent (own env
  // var, own usage_log 'marketplace' service key) so a busy buyer agent
  // can't starve its own inference budget just by shopping, or vice
  // versa. Guards against one compromised/runaway agent looping
  // /:id/invoke against a listing (its own or someone else's) and
  // draining its wallet before a human notices.
  maxMarketplaceSpendUsdcPerAgentPerDay: Number(
    process.env.MAX_MARKETPLACE_SPEND_USDC_PER_AGENT_PER_DAY || "5",
  ),

  // --- PTY sessions ---
  maxPtySessionsPerAgent: Number(process.env.MAX_PTY_SESSIONS_PER_AGENT || "3"),
  ptyIdleTimeoutMs: Number(process.env.PTY_IDLE_TIMEOUT_MS || String(10 * 60 * 1000)),

  // --- Multi-sandbox (isolated per-agent/per-child containers) ---
  maxSandboxesPerAgent: Number(process.env.MAX_SANDBOXES_PER_AGENT || "3"),
  maxSandboxVcpu: Number(process.env.MAX_SANDBOX_VCPU || "4"),
  maxSandboxMemoryMb: Number(process.env.MAX_SANDBOX_MEMORY_MB || "8192"),
  minSandboxMemoryMb: Number(process.env.MIN_SANDBOX_MEMORY_MB || "512"),
  maxSandboxDiskGb: Number(process.env.MAX_SANDBOX_DISK_GB || "20"),

  // --- Environment sandboxes (next-phase.md Phase 2g, second pass /
  // architecture-agent.md §4g) ---
  // A deliberately SEPARATE pool from maxSandboxesPerAgent above: that
  // cap (default 3) governs explicit, caller-requested POST /vm/sandboxes
  // rows, sized for "a handful of extra terminals a top-level agent asks
  // for on purpose." Department/project environments (environment.ts)
  // are provisioned automatically, one per department (up to
  // defaultMaxDepartmentsPerAgent, default 6) plus one per concurrently
  // running project underneath any of them — routinely more than 3, and
  // not something a caller is "asking for" the way an explicit sandbox
  // is. Reusing maxSandboxesPerAgent for both would mean a single
  // department's own environment could starve an agent's explicit
  // sandbox budget (or vice versa) for two conceptually unrelated kinds
  // of resource. Sized generously above the department default so a
  // handful of concurrent projects don't immediately hit the ceiling;
  // still a real, enforced cap (see vmService.ts's
  // getOrCreateScopedSandbox), not unlimited.
  maxEnvironmentSandboxesPerAgent: Number(process.env.MAX_ENVIRONMENT_SANDBOXES_PER_AGENT || "40"),

  // --- Sub-agents (next-phase.md Phase 2 / architecture-agent.md §4) ---
  // A slice of the owner's own quota, not an independent budget — see
  // subagents.ts. This is the flat Phase-2 ceiling (one tier, no
  // departments yet); Phase 2a adds max_departments/
  // max_workers_per_department on top of this for the 3-tier org-chart
  // shape once that phase exists.
  maxSubagentsPerOwner: Number(process.env.MAX_SUBAGENTS_PER_OWNER || "5"),

  // --- Departments (next-phase.md Phase 2a / architecture-agent.md §4a) ---
  // Real ceilings, sourced here the same way Phase 0's other quota
  // defaults are (maxSandboxesPerAgent, maxPtySessionsPerAgent, ...):
  // office.ts's ensureDepartmentQuota() backfills these into an agent's
  // manifest.json the first time it needs a department/worker quota
  // number and the manifest still has Phase 0's null stub — so the
  // *config* default only matters once, at backfill time; after that,
  // the per-agent manifest value is authoritative and can be edited
  // per-agent without touching this global.
  defaultMaxDepartmentsPerAgent: Number(process.env.DEFAULT_MAX_DEPARTMENTS_PER_AGENT || "20"),
  defaultMaxWorkersPerDepartment: Number(process.env.DEFAULT_MAX_WORKERS_PER_DEPARTMENT || "20"),
  // Floor, not a default/ceiling like the two above — enforced on the
  // removal path (subagents.ts's /subagents/:id/kill), not backfilled
  // into a manifest. A permanent worker (project_id IS NULL) can't be
  // voluntarily terminated if doing so would leave the department at
  // or below this count. Ramp-up (a brand-new department hiring its
  // way up to 10) is unaffected — this only ever gates removal, hiring
  // goes through POST /:id/workers instead, so a department building
  // toward the floor is never blocked from firing a bad early hire to
  // replace them.
  minPermanentWorkersPerDepartment: Number(process.env.MIN_PERMANENT_WORKERS_PER_DEPARTMENT || "10"),

  // --- Temporary project workers (next-phase.md Phase 2b / architecture-agent.md §4b) ---
  // Backfilled into manifest.json.quota.max_temp_workers_per_department
  // the same one-time way office.ts's ensureDepartmentQuota() already
  // backfills the two Phase 2a fields above — after the first backfill,
  // the per-agent manifest value is authoritative, this global only sets
  // the initial number. architecture-agent.md §4a's own worked example
  // uses 100 as a department's temp-worker ceiling (a much higher number
  // than its permanent-worker ceiling — that's the point of "burst
  // capacity"), so that's the default here too.
  defaultMaxTempWorkersPerDepartment: Number(
    process.env.DEFAULT_MAX_TEMP_WORKERS_PER_DEPARTMENT || "100",
  ),
  // A single spawn_temp_workers call is bulk ("count" workers at once,
  // per §4b) — bounded independently of max_temp_workers_per_department
  // so one call can't jump straight to a department's whole ceiling in
  // one shot; the department has to make several bursts, each individually
  // rate-limited on the agent-runtime side (policy.ts's
  // maxTempWorkerSpawnCallsPerDay) the same way spawn_department_worker is.
  maxTempWorkersPerSpawnCall: Number(process.env.MAX_TEMP_WORKERS_PER_SPAWN_CALL || "25"),
  // §4b: "A ttl is a safety net, not the primary mechanism" — but a temp
  // worker spawned with no ttl at all would have no safety net,
  // defeating the point. When a caller doesn't pass one, this backend
  // falls back to this default rather than leaving ttl_at NULL — so
  // every temp worker is reachable by the TTL reaper (see
  // departments.ts's sweepExpiredTempWorkers) even if retire_project()
  // is never called and the spawn call itself never specified a ttl.
  defaultTempWorkerTtlMs: Number(
    process.env.DEFAULT_TEMP_WORKER_TTL_MS || String(4 * 60 * 60 * 1000), // 4h
  ),

  // --- Department spend cap (next-phase.md Phase 2d / architecture-agent.md §4c) ---
  // Backfilled onto a department's own sub_agents row (spend_cap_daily_usdc)
  // at create_department time if the caller doesn't pass one explicitly —
  // same one-shot-default-then-authoritative-per-row pattern as
  // defaultMaxWorkersPerDepartment above, just stored as a column on the
  // department's own row instead of manifest.json (a spend cap belongs to
  // the department, not to the owning Agent's manifest). NOT enforced
  // anywhere yet — see departments.ts's module doc and next-phase.md's
  // Phase 2f, which is explicitly where wallet.pay calls start checking
  // this number.
  defaultDepartmentSpendCapDailyUsdc: Number(
    process.env.DEFAULT_DEPARTMENT_SPEND_CAP_DAILY_USDC || "1",
  ),

  // --- Zent.md Phase 8d: check_available_capital(agentAddress) ---
  // "Expansion capital is a slice of that [Company A's wallet balance],
  // never all of it." The fraction of a top-level agent's own real
  // on-chain USDC balance that Finance's Phase 8d check is willing to
  // even present as available for funding Agent B — a hard ceiling on
  // the SLICE this tool reports, independent of (and applied before)
  // Phase 8e's separate runway-months floor and Phase 9b's own
  // per-call/per-day spawn_clone funding caps. Deliberately small by
  // default: this check runs before either of those two harder gates,
  // so its own default should never be the thing that lets an agent
  // fund an expansion at a size that later starves its own runway.
  expansionCapitalFraction: Number(process.env.EXPANSION_CAPITAL_FRACTION || "0.2"),

  // --- Zent.md Phase 8e: runway rule ---
  // "Finance must show Company A retains N months of its own runway
  // after funding Agent B — this is a hard floor, not advisory." N
  // here is that floor: the minimum number of months of runway
  // (remaining balance ÷ current daily spend-rate) Company A must
  // still have AFTER sending a proposed funding amount to Agent B.
  // Independent of, and checked after, expansionCapitalFraction above
  // — that fraction caps what Finance is even willing to REPORT as
  // available (Phase 8d); this floor caps what Finance is willing to
  // approve once a concrete funding number is on the table (Phase 8e).
  // Deliberately a flat month-count, not a fraction of the balance: a
  // fraction of a shrinking balance would erode together with an
  // agent's own runway, defeating the point of a floor. Wired to
  // actually short-circuit the pipeline in Phase 10b — this value
  // only defines the threshold 8e's check compares against.
  minRunwayMonthsAfterFunding: Number(process.env.MIN_RUNWAY_MONTHS_AFTER_FUNDING || "6"),

  // --- Zent.md Phase 9b: sizing recommendation caps ---
  // "Finance proposes an initial funding amount for Agent B (feeds
  // spawn_clone's existing per-call/per-day funding caps — Finance
  // cannot recommend above those caps)." These two numbers ARE those
  // caps — introduced here, at 9b, since nothing upstream (8d's own
  // expansionCapitalFraction, 8e's minRunwayMonthsAfterFunding) needed
  // them yet; both of those are independent limits applied BEFORE
  // these two, per 8d's own header comment ("three independent
  // limits, not one").
  //
  // maxCloneFundingUsdcPerCall: a hard ceiling on any ONE opportunity's
  // sizing recommendation. maxCloneFundingUsdcPerAgentPerDay: a hard
  // ceiling on the SUM of same-day recommendations across every
  // opportunity for one root agent, so a burst of same-day approvals
  // can't collectively fund more expansion than one day's cap allows
  // even though each individual recommendation is under the per-call
  // cap on its own.
  //
  // Enforced by construction in expansion.ts's computeSizingRecommendation()
  // — there is no code path through that function that can return a
  // number above either cap. Phase 16b clamps the actual spawn_clone
  // funding argument against these same two numbers again at
  // disbursement time; 9b's clamp is the recommendation-time
  // chokepoint, 16b's is the disbursement-time one, same numbers, two
  // independent checks (a recommendation surviving 9b's clamp is not
  // itself authorization to disburse — Phase 15's CEO decision and
  // Phase 16's genesis call are still required in between).
  maxCloneFundingUsdcPerCall: Number(process.env.MAX_CLONE_FUNDING_USDC_PER_CALL || "500"),
  maxCloneFundingUsdcPerAgentPerDay: Number(
    process.env.MAX_CLONE_FUNDING_USDC_PER_AGENT_PER_DAY || "1000",
  ),

  // --- Zent.md Phase 9c: staged-funding option ---
  // "Finance may recommend a smaller initial grant with a milestone-
  // based follow-on instead of one lump sum — modeled, not yet wired
  // to disbursement (that's Phase 16)." The fraction of 9b's own
  // recommendedFundingUsdc that goes out as the initial grant under
  // that option; the remainder is the modeled follow-on tranche.
  //
  // Deliberately a fixed fraction, not a per-opportunity judgment call
  // — same "documented assumption, not a derived number" posture 8b's
  // own ASSUMED_DEPARTMENTS_FOR_MVP already takes, easy to find and
  // easy to revise once real genesis history (Phase 20e's post-launch
  // review) exists to check it against. 0.5 is a plain half-now-half-
  // later split, not a claim about where a real milestone should sit —
  // Zent.md 9c itself only asks this to be MODELED, not wired to an
  // actual milestone-detection mechanism (that's later than Phase 16,
  // not scoped by this constant at all).
  stagedFundingInitialFraction: Number(
    process.env.STAGED_FUNDING_INITIAL_FRACTION || "0.5",
  ),

  // --- Cloning (next-phase.md Phase 4a / architecture-agent.md §5) ---
  // A local safety rail on the SHELL-creation step only (agent_id +
  // sandbox, before any wallet/identity/funds exist) — same "can't
  // fork-bomb the box" reasoning agent-runtime/spawner.ts's own
  // MAX_SPAWNS_PER_PROCESS already applies to the older, separate
  // self-hosted spawn_clone path (see cloning.ts's own module comment
  // for how these two mechanisms relate and why this phase doesn't
  // touch that one). Counts only shells that haven't yet been claimed
  // by 4b's wallet-assignment step — an abandoned/never-claimed shell
  // still counts against its parent until reaped, so this can't be
  // bypassed by never finishing a clone.
  maxPendingCloneShellsPerAgent: Number(process.env.MAX_PENDING_CLONE_SHELLS_PER_AGENT || "3"),

  // --- Orchestrator (next-phase.md Phase 5a / architecture-agent.md §6) ---
  // The backend is the only thing in this repo that knows about every
  // top-level agent (it owns the `agents` table), so — per §6's own
  // "one level above all of this" framing — the actual spawn/kill
  // authority lives here, not inside any one agent-runtime process.
  // agentRuntimeDir points at the compiled agent runtime package this
  // spawns `dist/index.js` from; agentProcessDataDir is where each
  // spawned agent's own STATE_PATH/log live, keyed by address — a
  // sibling of, and deliberately separate from, agent-runtime/spawner.ts's
  // own CHILDREN_DATA_DIR (that tree belongs to the older, still-live
  // parent-funds-a-child spawn_clone mechanism; see orchestrator.ts's
  // module doc for why this phase doesn't merge the two).
  //
  // PHASE-17D-IV fix: this used to default to "../agent-runtime", a
  // package this repo's own comments (orchestrator.ts's module doc)
  // describe as already rewritten to a deprecation notice. The real,
  // current runtime shipped in this zip is `agent/` (agent/src/index.ts,
  // bootstrapAgentRuntime(), --tick-once) — that's what spawnAgentProcess()
  // actually needs to launch. See PHASE-17D-IV-NOTES.md.
  agentRuntimeDir: process.env.AGENT_RUNTIME_DIR || "../agent",
  agentProcessDataDir: process.env.AGENT_PROCESS_DATA_DIR || "./data/agent-processes",
  // PHASE-17D-IV: per-agent home for the identity files (wallet.json,
  // automaton.json, state db) a real agent/-runtime process needs —
  // written by genesis.ts's provisionAgentRuntimeIdentity() at birth,
  // read via AUTOMATON_CONFIG_DIR by every spawned process for that
  // agent (spawnAgentProcess() / spawnAgentProcessTickOnce(), both in
  // orchestrator.ts). Keyed by agent address, one directory per agent,
  // so concurrent agents on the same host never collide on a single
  // $HOME/.automaton. See PHASE-17D-IV-NOTES.md.
  agentIdentityDataDir: process.env.AGENT_IDENTITY_DATA_DIR || "./data/agent-identities",
  defaultAgentGoal: process.env.DEFAULT_AGENT_GOAL || "No goal specified.",

  // --- Health-check / auto-restart (next-phase.md Phase 5e / architecture-agent.md §6) ---
  // agentHangTimeoutMs: how stale a running agent's own STATE_PATH file
  // (written by agent-runtime's saveState() at boot and after every
  // completed iteration — see agent-runtime/src/state.ts) can get before
  // healthCheck.ts treats a still-alive-per-pid process as "hung" rather
  // than merely between iterations. Generous by default: a single slow
  // inference call plus tool execution can legitimately take a few
  // minutes, and a false "hung" verdict costs a real restart (and a lost
  // in-flight iteration), so this errs toward not flagging a merely-slow
  // agent over catching a stuck one quickly.
  agentHangTimeoutMs: Number(process.env.AGENT_HANG_TIMEOUT_MS || String(15 * 60_000)),
  // agentMaxRestartsPerWindow / agentRestartWindowMs: crash-loop breaker.
  // An agent that needs restarting this many times within this rolling
  // window has its auto-restart circuit opened (left crashed/hung for an
  // operator to look at) rather than being respawned indefinitely into
  // the same failure — see healthCheck.ts's own module doc for why this
  // is tracked per-row in agent_processes rather than in memory.
  agentMaxRestartsPerWindow: Number(process.env.AGENT_MAX_RESTARTS_PER_WINDOW || "5"),
  agentRestartWindowMs: Number(process.env.AGENT_RESTART_WINDOW_MS || String(10 * 60_000)),

  // --- Ports (public URLs proxied through this server) ---
  // No wildcard domain required: exposed ports are reachable at
  // {publicBaseUrl}/app/{token}, proxied in-process.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://YOUR_ALIBABA_VM_IP:${process.env.PORT || 8000}`,
  maxExposedPortsPerSandbox: Number(process.env.MAX_EXPOSED_PORTS_PER_SANDBOX || "3"),

  // --- Marketplace: zip-mode listings ---
  // Local disk under the VM's own data dir, next to backend.db — same
  // reasoning as dbPath: this backend already assumes one box.
  //
  // Two independent caps, both env-overridable since these are exactly
  // the numbers that'll change the next time the VM's disk is upgraded:
  //   - per-project (per-listing) cap: one zip can't exceed this
  //   - per-agent cap: an agent's zip listings can't add up to more
  //     than this across ALL their listings combined
  // At current defaults (100MB/listing, 3GB/agent) that's ~30 listings'
  // worth of headroom per agent before they'd need to deactivate an old
  // one to free space for a new one — comfortable on a 100GB VM disk
  // shared across every agent, not just one.
  //
  // next-phase.md Phase 7d: this root directory's own layout is no
  // longer flat. New uploads (marketplace.ts's POST /list/upload) land
  // under `{marketplaceUploadsDir}/{sellerAddress}/{uuid}.zip` —
  // filesystem-level separation between sellers, to go with the
  // DB-row-level ownership check (`listings.seller_address`) that was
  // always the real boundary until now. This value itself didn't need
  // to change (it's still just the one root the whole feature lives
  // under) — see marketplace.ts's `moveIntoSellerUploadsDir()` for where
  // the per-seller subdirectory actually gets built. This is a
  // go-forward layout change only: rows written before Phase 7d have a
  // `file_path` pointing at the old flat layout (directly under this
  // root, no seller subdirectory) and are never migrated — every read
  // path uses the stored `file_path` verbatim, so old and new layouts
  // coexist under this same root indefinitely, by design, not as an
  // unresolved migration debt.
  marketplaceUploadsDir: process.env.MARKETPLACE_UPLOADS_DIR || "./data/marketplace-uploads",
  marketplaceMaxFileBytes: Number(process.env.MARKETPLACE_MAX_FILE_MB || "100") * 1024 * 1024,
  marketplaceMaxAgentStorageBytes:
    Number(process.env.MARKETPLACE_MAX_AGENT_STORAGE_GB || "3") * 1024 * 1024 * 1024,
  marketplaceDownloadTtlMs: Number(process.env.MARKETPLACE_DOWNLOAD_TTL_MS || String(15 * 60 * 1000)), // 15 min

  // --- Founder fee (marketplace platform cut) ---
  // Every marketplace sale splits into two independent x402 payments:
  // one to the seller, one to this address. Non-custodial by design —
  // same as the seller leg, this backend never holds the funds, it
  // just requires both signed payments to settle before the buyer gets
  // the deliverable. See the two-payment split in the /:id/invoke
  // handler. Leave FOUNDER_WALLET_ADDRESS unset to disable the fee
  // entirely (falls back to 100% seller, 0% fee, same as before this
  // feature existed) rather than silently defaulting to some address
  // nobody chose.
  founderWalletAddress: process.env.FOUNDER_WALLET_ADDRESS || "",
  founderFeeBps: Number(process.env.FOUNDER_FEE_BPS || "2000"), // 2000 bps = 20%

  // --- Social Relay (self-hosted replacement for Conway's social.conway.tech) ---
  // These mirror agent/src/social/signing.ts's MESSAGE_LIMITS exactly, so a
  // stock agent client (which enforces the same numbers itself before it
  // ever calls the relay) never trips the server-side check on a
  // legitimate message — this is defense-in-depth against a modified or
  // self-custody client, not a stricter policy than what agents expect.
  socialMaxContentBytes: Number(process.env.SOCIAL_MAX_CONTENT_BYTES || "64000"),
  socialMaxTotalBytes: Number(process.env.SOCIAL_MAX_TOTAL_BYTES || "128000"),
  socialReplayWindowMs: Number(process.env.SOCIAL_REPLAY_WINDOW_MS || String(5 * 60 * 1000)),
  socialMaxOutboundPerHourPerAgent: Number(process.env.SOCIAL_MAX_OUTBOUND_PER_HOUR || "100"),
  socialPollDefaultLimit: Number(process.env.SOCIAL_POLL_DEFAULT_LIMIT || "50"),
  socialPollMaxLimit: Number(process.env.SOCIAL_POLL_MAX_LIMIT || "200"),
  // A message a client keeps re-polling (claiming) but never acks moves
  // to 'failed' after this many claims — matches the received -> in_progress
  // -> processed|failed state machine already typed in agent/src/types.ts
  // (InboxMessageStatus), previously unimplemented on any relay backend.
  socialMaxDeliveryRetries: Number(process.env.SOCIAL_MAX_DELIVERY_RETRIES || "5"),
  // How long a message may sit claimed (in_progress) before it's eligible
  // to be reclaimed by the next poll and its retry_count incremented —
  // protects against a crashed agent permanently holding a message.
  socialClaimTimeoutMs: Number(process.env.SOCIAL_CLAIM_TIMEOUT_MS || String(10 * 60 * 1000)),
  // Terminal (processed/failed) messages older than this get pruned by a
  // background sweep so social_messages doesn't grow forever. 'received'
  // and 'in_progress' rows are never pruned by age, only by reaching a
  // terminal state first.
  socialMessageRetentionMs: Number(
    process.env.SOCIAL_MESSAGE_RETENTION_MS || String(30 * 24 * 60 * 60 * 1000),
  ), // 30 days

  // --- Distribution ("getting a human customer") ------------------------
  // Deliberately NOT a growth/engagement system. No click tracking, no
  // A/B'd listing copy, no re-publish. One agent-authored publish per
  // (listing, channel) pair, ever, to a channel a human operator put on
  // the allowlist ahead of time — the agent chooses among approved
  // channels, it does not discover or add its own. See distribution.ts
  // for the full reasoning.
  //
  // Channels themselves (URLs, credentials, per-channel rules) live in
  // the distribution_channels table, curated via POST /admin/distribution/channels
  // (x-admin-key only) rather than env vars, since the list changes far
  // more often than deploy-time config should.
  maxDistributionPublishesPerAgentPerDay: Number(
    process.env.MAX_DISTRIBUTION_PUBLISHES_PER_AGENT_PER_DAY || "5",
  ),

  // Zent.md Phase 2d — "signal scanning is the cheapest department but
  // also the easiest to run in an unbounded loop; cap ticks/day." One
  // tick = one successful scan_market_signals/list_customer_complaints/
  // list_demand_signals call (Phase 2b/2c), counted in
  // opportunity_intelligence_tick_counters and enforced two ways: a
  // real-time 429 in expansionRoutes.ts (resourceQuotas.ts's
  // hasOpportunityIntelligenceTickCapacity(), same per-request-gate
  // posture as maxDistributionPublishesPerAgentPerDay above) plus a
  // belt-and-suspenders process kill on resourceQuotas.ts's own sweep
  // if it's ever exceeded anyway — see that file's module doc for why
  // a free (non-billed) tool needs the second layer the spend-rate
  // caps don't. Deliberately much higher than the publish cap: signal
  // scanning is meant to be a department's normal, repeated research
  // activity within one pass, not a rare, high-stakes action like a
  // public distribution post.
  maxOpportunityIntelligenceTicksPerAgentPerDay: Number(
    process.env.MAX_OPPORTUNITY_INTELLIGENCE_TICKS_PER_AGENT_PER_DAY || "100",
  ),
  // Zent.md Phase 10c — "Reuse resourceQuotas.ts patterns for Finance
  // department's own spend cap — modeling other companies' costs must
  // stay cheap." Same free-tool-loop gap as
  // maxOpportunityIntelligenceTicksPerAgentPerDay above, one tick =
  // one successful Phase 8/9 finance tool call (estimate_build_cost
  // through note_sensitivity — see finance_tick_counters' own db.ts
  // header for the full list), enforced the same two ways: a real-time
  // 429 in expansionRoutes.ts (resourceQuotas.ts's
  // hasFinanceTickCapacity()) plus the same belt-and-suspenders sweep
  // re-check checkResourceQuotas() already does for opportunity_
  // intelligence. Deliberately lower than the OI cap above: a single
  // finance pass over one opportunity is 8b through 9d, eight tool
  // calls, so a department working several opportunities a day still
  // sits comfortably under this while a runaway loop re-modeling the
  // same opportunity gets stopped well before it could matter — OI's
  // 100/day reflects genuinely open-ended market scanning within one
  // pass, which finance's fixed eight-tool sequence never needs.
  maxFinanceTicksPerAgentPerDay: Number(
    process.env.MAX_FINANCE_TICKS_PER_AGENT_PER_DAY || "50",
  ),
  // Zent.md Phase 14d: "Timeout handling: a department that doesn't
  // respond within its budgeted ticks doesn't block the packet forever
  // — it's marked no-response and the packet proceeds with that noted."
  // Modeled as wall-clock elapsed since the opportunity's own
  // selected_at (Phase 3d — the moment it was handed to Research/
  // Finance/Strategy in the first place), not a per-department tick
  // counter of its own: there's no single "one tick" unit that's
  // comparable across a market-size lookup (Research), a build-cost
  // model (Finance), and a fit-score pass (Strategy) the way there is
  // within opportunity_intelligence_tick_counters/finance_tick_counters
  // above (each of those caps one department's own repeated tool, not a
  // cross-department deadline). getVoteRecord() (expansion.ts) is what
  // actually applies this — see that function's own header.
  expansionVoteTimeoutMs: Number(
    process.env.EXPANSION_VOTE_TIMEOUT_MS || String(24 * 60 * 60 * 1000),
  ),
  // Zent.md Phase 3c: "reject/merge an opportunity whose title+thesis
  // is a near-match ... to one already scored in the last N days for
  // this agent." These two knobs are that check's N (the lookback
  // window) and the TF-IDF cosine-similarity cutoff above which two
  // opportunities count as "near-match" rather than merely related.
  // See expansion.ts's findNearDuplicateOpportunity() for how they're
  // used and why these particular defaults were picked.
  opportunityDedupWindowDays: Number(process.env.OPPORTUNITY_DEDUP_WINDOW_DAYS || "30"),
  opportunityDedupSimilarityThreshold: Number(
    process.env.OPPORTUNITY_DEDUP_SIMILARITY_THRESHOLD || "0.82",
  ),
  // Zent.md Phase 3d: "nothing below N (default top 4) proceeds." Read
  // as a per-agent CAPACITY, not a per-tick batch size — see
  // expansion.ts's selectTopOpenOpportunities() for why the scheduled
  // job promotes at most one opportunity per agent per tick rather than
  // filling all open capacity at once.
  expansionTopNOpenOpportunities: Number(process.env.EXPANSION_TOP_N_OPEN_OPPORTUNITIES || "4"),
  // Zent.md Phase 3e: "Kill condition: if no opportunity clears a
  // minimum ROI floor, the department produces a report saying so and
  // the pipeline stops for this cycle." This is that floor, on the same
  // 0-100 scale computeRoiScore() (expansion.ts) produces. Default 50 —
  // the midpoint of the scale — reads as "at least as much upside as
  // downside across the four 3a factors," deliberately looser than a
  // human's own bar for actually approving an expansion (that's what
  // Research/Finance/Strategy/the CEO gate, Phases 5-15, are for): this
  // floor's only job is to stop Research from being handed something
  // Opportunity Intelligence's own coarse pass already thinks is a
  // clear no, not to pre-approve anything. See expansion.ts's
  // evaluateKillCondition() for how this is applied per report.
  expansionMinRoiFloor: Number(process.env.EXPANSION_MIN_ROI_FLOOR || "50"),
  // Fixed, non-editable disclosure line the backend appends server-side
  // to every social_api publish — never trusted to agent-provided
  // content, so it can't be stripped or reworded by a compromised or
  // adversarially-prompted agent. Constitution Law III: "never deny what
  // you are."
  distributionDisclosureText:
    process.env.DISTRIBUTION_DISCLOSURE_TEXT ||
    "Posted by an autonomous AI agent (automaton), disclosed per its operating constitution. Not a human-authored post.",
  // Public feed (see GET /distribution/feed.xml) — the "SEO done
  // honestly" channel: a standing Atom feed of this fleet's active
  // marketplace listings that search engines / aggregators / directories
  // can crawl or subscribe to on their own schedule. No agent action
  // required per listing beyond keeping it active; nothing is pushed
  // anywhere, so it can't be spam by construction.
  distributionFeedTitle: process.env.DISTRIBUTION_FEED_TITLE || "Automaton Marketplace — Active Listings",
  // Human-readable landing page (GET /distribution/landing/:id) — the
  // actual destination every other channel points to. A GitHub PR, an
  // npm description, a Mastodon post are all discovery events; this
  // page is where a human decides to pay. USDC/x402 is the only
  // integrated payment path (see marketplace.ts) — this repo does not
  // include a fiat processor, so the page is honest about that and
  // offers a contact path instead of a fake "buy now" button for
  // buyers without a wallet.
  distributionContactEmail: process.env.DISTRIBUTION_CONTACT_EMAIL || "",

  // --- Domain Management (architecture-agent.md §4h, next-phase.md Phase 9) ---
  // One apex domain, shared across every Agent — see next-phase.md's
  // Phase 9 "Design decisions locked before any sub-phase starts
  // building" section. Overridable via env for a future second
  // deployment; defaults to the apex this fleet actually registered.
  domainApex: process.env.DOMAIN_APEX || "novamail.store",
  // Cloudflare (DNS host for domainApex) API credentials — the
  // Domain Management Department Agent's own tool profile is the only
  // caller that should ever need these (9c). Never surfaced through
  // any GET /departments* or other read route; never written into any
  // office's fs/workspace — same vault treatment Phase 0 gives the
  // wallet key. No default: an unset value means the Domain
  // Management stack isn't configured on this deployment yet, not a
  // silently-guessed placeholder token.
  cloudflareApiToken: optionalSecret("CLOUDFLARE_API_TOKEN"),
  cloudflareZoneId: optionalSecret("CLOUDFLARE_ZONE_ID"),

  // Phase 9c: where and how this process reaches the Phase 9b
  // domain-stack it's provisioning into. All four have defaults
  // matching deploy/domain-stack/docker-compose.yml exactly (fixed
  // container_names, the bind-mount path relative to that compose
  // file's own directory) — overridable for a deployment that moved
  // the stack or renamed its containers, not because any of these
  // are secrets.
  //
  //   domainStackConfDDir: the HOST path to nginx/conf.d/ — this
  //     process writes vhost files here directly (plain fs, no
  //     Docker API needed for the write itself, since the directory
  //     is bind-mounted :ro *into* the nginx container but is a real
  //     writable directory on the host it and this backend share).
  //   domainStackNginxContainer / domainStackCertbotContainer: the
  //     fixed container_names docker-compose.yml declares — passed to
  //     dockerode's getContainer() for `nginx -s reload` / one-shot
  //     `certbot certonly` execs (domains.ts).
  //   domainStackCertbotEmail: Let's Encrypt account email for new
  //     cert registrations. No default — certbot's own
  //     --register-unsafely-without-email is refused by domains.ts on
  //     purpose (an expiring-soon notice with no reachable owner is
  //     exactly the kind of silent failure this system's own "no
  //     silent gaps" posture exists to avoid).
  domainStackConfDDir: process.env.DOMAIN_STACK_CONF_D_DIR || path.join(process.cwd(), "../deploy/domain-stack/nginx/conf.d"),
  domainStackNginxContainer: process.env.DOMAIN_STACK_NGINX_CONTAINER || "domain-stack-nginx",
  domainStackCertbotContainer: process.env.DOMAIN_STACK_CERTBOT_CONTAINER || "domain-stack-certbot",
  domainStackCertbotEmail: optionalSecret("DOMAIN_STACK_CERTBOT_EMAIL"),
  // A real gap found by inspection while actually building 9c (not
  // named in this sub-phase's own original four-setting list above):
  // provisionSubdomain()'s Cloudflare A record has to point somewhere,
  // and nothing in this deployment auto-detects "the VM's own public
  // IP" reliably (a VM can have several interfaces; guessing wrong
  // would silently create a DNS record pointing at nothing). No
  // default on purpose, same "unset means not configured yet, not a
  // guessed placeholder" posture cloudflareApiToken/cloudflareZoneId
  // above already take — domains.ts refuses to provision rather than
  // fall back to something like 127.0.0.1.
  domainStackPublicIp: optionalSecret("DOMAIN_STACK_PUBLIC_IP"),

  // Phase 9d-i: Mailcow API credentials — the mailbox-side counterpart
  // to cloudflareApiToken/cloudflareZoneId above. A real gap found by
  // inspection while actually building 9d-i, not pre-empted by an
  // earlier sub-phase: 9a-iii's own "Explicitly out of scope" line
  // deferred Mailcow's config secrets to "added alongside the Mailcow
  // stack in 9b," but 9b deliberately did NOT vendor Mailcow into
  // docker-compose.yml (its own "not vendored" checklist item — see
  // that sub-phase's own built-notes) — it only documents standing
  // Mailcow up as a sibling deployment in README.md. Nothing before
  // this sub-phase ever actually added a Mailcow API credential to
  // config.ts. `optionalSecret()` (Phase 9a-iii's own helper, reused
  // here rather than duplicated) — no default, since an unset value
  // means the Mailcow half of the Domain Management stack isn't
  // configured on this deployment yet, not a guessed placeholder.
  // Never surfaced through any GET /departments* or other read route —
  // same vault treatment cloudflareApiToken/domainStackPublicIp above
  // already get, confirmed the same way 9a-iii's own note confirmed
  // Cloudflare's: only domains.ts (the one file that ever needs it)
  // imports it.
  mailcowApiUrl: optionalSecret("MAILCOW_API_URL"),
  mailcowApiKey: optionalSecret("MAILCOW_API_KEY"),

  // Zent.md Phase 6c: "Buildability check against
  // toolRegistrySeedData.ts/skillsRoutes.ts: can an agent with today's
  // tool catalog actually execute on this, or does it need new tools
  // first (flag, don't block)." Same TF-IDF-cosine-similarity shape
  // 3c's dedup pass already uses (reusing tfidf.ts's scoreCorpus(), not
  // a second from-scratch metric) — this is that check's own
  // similarity cutoff, above which a catalog entry counts as covering
  // part of the opportunity's technical requirements rather than
  // merely sharing an incidental word. Deliberately lower than 3c's
  // 0.82 near-duplicate threshold: two *opportunities* being 0.82
  // similar is a strong "these are the same idea" signal, but a
  // *catalog tool description* (a short, generic sentence like "run a
  // shell command in the department's sandbox") will rarely share that
  // much vocabulary with a specific opportunity's thesis even when the
  // tool is exactly what's needed — see expansion.ts's
  // checkBuildability() for how this is used.
  buildabilityMatchThreshold: Number(
    process.env.BUILDABILITY_MATCH_THRESHOLD || "0.12",
  ),

  // Zent.md Phase 11c: "Tool: `check_mission_overlap(opportunity_id)` —
  // flags whether the proposed mission competes with, duplicates, or
  // clearly complements an existing sibling." Same TF-IDF-cosine-
  // similarity shape 3c's dedup pass and 6c's buildability check above
  // both already use (reusing tfidf.ts's scoreCorpus()) — these are
  // that check's own cutoffs. See expansion.ts's checkMissionOverlap()
  // for exactly how they're combined.
  //
  // missionOverlapDuplicateThreshold is deliberately its own named
  // constant rather than a reuse of opportunityDedupSimilarityThreshold
  // above, even though the default value is the same 0.82: 3c's
  // threshold governs same-agent, same-report-cycle near-duplicates at
  // *creation* time; this one governs a finished opportunity's
  // similarity to an already-spawned sibling's *mission*, a
  // conceptually distinct comparison that should be tunable
  // independently of the first even though today they agree.
  missionOverlapDuplicateThreshold: Number(
    process.env.MISSION_OVERLAP_DUPLICATE_THRESHOLD || "0.82",
  ),
  // Below the duplicate threshold but at or above this one: "same
  // space, distinct execution" rather than "same idea restated."
  // Deliberately well below the duplicate cutoff — competing missions
  // share far less exact vocabulary than two restatements of the same
  // idea do, since they're actually describing different products.
  missionOverlapCompetesThreshold: Number(
    process.env.MISSION_OVERLAP_COMPETES_THRESHOLD || "0.5",
  ),
  // Independent second signal, not a TF-IDF similarity at all: Jaccard
  // overlap between the candidate opportunity's and the sibling's own
  // opportunity's Phase 1b `tags[]`. Only checked once the similarity
  // signal above has already ruled out "competes" — a mission whose
  // *text* is already similar enough to compete is classified on that
  // signal, not this one. Default ~1/3: two opportunities sharing a
  // third of their tags share a real domain/tooling overlap worth
  // flagging to Strategy (whose own Phase 11d check_technology_reuse is
  // what asks how much of that overlap is actually reusable) without
  // firing on a single incidentally-shared tag between two otherwise
  // unrelated opportunities.
  missionOverlapComplementsTagThreshold: Number(
    process.env.MISSION_OVERLAP_COMPLEMENTS_TAG_THRESHOLD || "0.34",
  ),

  // Zent.md Phase 11d: "Tool: `check_technology_reuse(opportunity_id)`
  // — how much of an existing sibling's tools/skills/codebase Agent B
  // could start from, versus building from zero." Same TF-IDF-cosine-
  // similarity shape 6c's buildability check already uses (reusing
  // checkBuildability() itself, not a second scoring function) — this
  // is that check's own match threshold, just run per-sibling against
  // each sibling's own skill catalog instead of the whole company's
  // global tool_registry+skills catalog. Defaulted to the same 0.12 as
  // buildabilityMatchThreshold (same reasoning: a short catalog-entry
  // description will rarely share much vocabulary with a specific
  // opportunity's thesis even when it's exactly on point) but kept as
  // its own named constant so it can be tuned independently — skill
  // descriptions in practice tend to run longer and more specific than
  // a one-line tool_registry description, so the two may not want to
  // stay equal forever even though they agree today.
  technologyReuseMatchThreshold: Number(
    process.env.TECHNOLOGY_REUSE_MATCH_THRESHOLD || "0.12",
  ),

  // Zent.md Phase 11e-i: "Factor-weighting constants live in config.ts,
  // next to the existing 11c/11d thresholds (config.ts:670, config.ts:712),
  // not hardcoded inline — tunable without touching department logic."
  // These are expansion.ts's FIT_SCORE_WEIGHTS (see computeFitScore()
  // for the formula and the reasoning behind this exact 0.35/0.30/0.20/
  // 0.15 split) — the fit-score mirror of ROI_WEIGHTS, just read from
  // env the same way every other tunable threshold in this file is, so
  // a later post-launch review (Zent.md 20e) can retune without a code
  // change. Weights are expected to sum to 1.0 — computeFitScore()'s
  // own [0, 100] guarantee depends on that — but this file only reads
  // the env values, it doesn't enforce the sum; that's the same trust
  // boundary every other env-sourced numeric constant here already has.
  fitScoreWeights: {
    missionComplementarity: Number(
      process.env.FIT_SCORE_WEIGHT_MISSION_COMPLEMENTARITY || "0.35",
    ),
    technologyReuseDepth: Number(
      process.env.FIT_SCORE_WEIGHT_TECHNOLOGY_REUSE_DEPTH || "0.30",
    ),
    ecosystemDiversificationValue: Number(
      process.env.FIT_SCORE_WEIGHT_ECOSYSTEM_DIVERSIFICATION_VALUE || "0.20",
    ),
    marketIndependence: Number(
      process.env.FIT_SCORE_WEIGHT_MARKET_INDEPENDENCE || "0.15",
    ),
  },

  // Zent.md Phase 11e-iii-a: "Divergence field: when fit_score and the
  // opportunity's roi_score (Phase 3) disagree by more than a
  // configured threshold, tag the finding fit_roi_divergence — the
  // concrete signal Phase 13c's 'disagreement surfacing' will read."
  // Same "tunable without touching department logic" posture
  // fitScoreWeights just above already commits to — see expansion.ts's
  // computeFitRoiDivergence() for exactly how this is applied.
  //
  // Both fit_score and roi_score live on the same [0, 100] scale (11e-i's
  // own header, 3b's own header), so a plain absolute difference is a
  // fair comparison with no unit conversion to get wrong. Defaulted to
  // 30: half of ROI_WEIGHTS'/FIT_SCORE_WEIGHTS' own largest single-factor
  // swing (a full 0-to-100 move on the 0.35-weighted top factor of either
  // formula is a 35-point shift) — wide enough that two formulas
  // computed from genuinely different evidence (ROI from market/expense/
  // buildability/competitive-gap; fit from mission-overlap/tech-reuse/
  // diversification/independence) disagreeing by a little isn't flagged
  // as noise, narrow enough that a real "Opportunity Intelligence loves
  // this, Strategy doesn't" split (Phase 13c's own example) still trips
  // it well before the two scores are at opposite ends of the range.
  fitRoiDivergenceThreshold: Number(
    process.env.FIT_ROI_DIVERGENCE_THRESHOLD || "30",
  ),

  // Zent.md Phase 13c: "Disagreement surfacing: if Finance's sizing and
  // Strategy's fit score point opposite directions, the packet says so
  // explicitly rather than averaging it away." Unlike
  // fitRoiDivergenceThreshold just above (a magnitude comparison between
  // two same-scale [0, 100] numbers), Finance's sizingRecommendation
  // isn't on a [0, 100] scale at all — it's a USDC amount — so there's
  // no shared unit to take a delta in. What the two sides of this
  // comparison DO share is a direction: Finance is either recommending
  // some nonzero funding or it isn't (recommendedFundingUsdc > 0 vs
  // === 0 — see computeFinanceStrategyDisagreement() in expansion.ts),
  // and Strategy's fit_score is either at/above or below this midpoint.
  // Defaulted to 50: the natural midpoint of fit_score's own documented
  // [0, 100] range (11e-i's own header) — "favorable" means Strategy
  // scored this opportunity in the top half of what its formula can
  // produce, not some other tuned cutoff borrowed from a different
  // formula's own threshold.
  fitScoreDirectionMidpoint: Number(
    process.env.FIT_SCORE_DIRECTION_MIDPOINT || "50",
  ),

  // --- Zent.md Phase 19b: total-portfolio spend cap ---
  // "Total-portfolio spend cap: sum of all pipeline-spawned siblings'
  // funding cannot exceed a configured fraction of the root's lifetime
  // revenue." This is the configured fraction. Distinct from 8d's
  // expansionCapitalFraction above in both scope and what it's a
  // fraction OF: 8d caps a single check_available_capital report
  // against the root's CURRENT WALLET BALANCE, before any funding
  // number exists; this caps the SUM of every dollar the root has ever
  // actually disbursed across every pipeline-spawned sibling (Zent.md
  // 16b's clone-funding payments, all-time) against the root's LIFETIME
  // SETTLED REVENUE (the same revenueUsdc isEligibleForExpansion() /
  // Phase 2e already computes from payments.status = 'settled'). A
  // root that has spent this fraction of everything it has ever earned
  // on spinning up siblings is capped regardless of how much capital it
  // is currently sitting on or how favorably any single opportunity
  // scores — this is the portfolio-wide backstop 8d/8e/9b's per-call and
  // per-day caps don't provide, since a long enough sequence of
  // individually-small, individually-approved fundings could otherwise
  // still add up to the whole company's earnings. Deliberately more
  // permissive than 8d's 0.2 default (a fraction of lifetime revenue is
  // a much larger number than a fraction of current balance for any
  // agent that has been reinvesting), since this is the outer backstop,
  // not the everyday gate.
  portfolioSpendCapFraction: Number(
    process.env.PORTFOLIO_SPEND_CAP_FRACTION || "0.5",
  ),

  // Zent.md Phase 20d: "Staged rollout: dry-run mode (19e) only, for
  // the first real profitable agent in production, before enabling
  // real genesis." A root agent starts (and, per db.ts's Phase 20d
  // migration, defaults to) 'dry_run_only' and can only graduate to
  // 'live_enabled' once checkRolloutGraduationEligibility()
  // (expansion.ts) confirms it has accumulated at least this many
  // completed dry-run genesis packets (Phase 19e) with the circuit
  // breaker (19c) currently clear and 2e's profitability gate still
  // passing — not a timer, not an operator decision, a count of
  // actual successful full-chain dry runs. Low enough that a real
  // profitable agent doesn't wait indefinitely, high enough that one
  // lucky packet isn't "staged rollout" in any meaningful sense.
  rolloutGraduationMinDryRunPackets: Number(
    process.env.ROLLOUT_GRADUATION_MIN_DRY_RUN_PACKETS || "3",
  ),

  // Zent.md Phase 20e: "a scheduled review of whether the ROI/fit
  // scores it was approved on actually held up." How long after Agent
  // B goes active (17e-iv) before there's enough of an operating
  // history to grade against — too short and every review just says
  // "too early to tell" against real revenue data that hasn't
  // accumulated yet; too long and the calibration signal arrives well
  // after 3b's/11e-i's formulas could have used it. 30 days is one
  // full billing-cycle-scale window, same order of magnitude as
  // wallet.ts's own spend-rate lookback.
  postLaunchReviewWindowDays: Number(
    process.env.POST_LAUNCH_REVIEW_WINDOW_DAYS || "30",
  ),
};
