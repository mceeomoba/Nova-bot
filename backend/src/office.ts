import fs from "fs/promises";
import path from "path";
import { config } from "./config.js";

/**
 * Phase 0 of next-phase.md: the per-agent "office" filesystem.
 * Implements architecture-agent.md §1 (The Office), §2 (The Vault),
 * and §2a (Browser isolation).
 *
 * Layout on disk, per agent (agentId = its wallet address):
 *
 *   {officesDir}/{agentId}/
 *     office/
 *       fs/                 <- the ONLY thing ever bind-mounted into the
 *                              agent's own Docker container (as /workspace)
 *         workspace/
 *         inbox/            <- written only by the future channel broker
 *         outbox/           <- staged files pending a channel handoff
 *       private/            <- NEVER bind-mounted into the agent's own
 *                              container. See officePrivateDir() below.
 *     browser/              <- Chromium --user-data-dir, own cookies/
 *                              sessions/history, bind-mounted separately
 *                              so it persists across container recycles.
 *     manifest.json
 *
 * Nothing in this file grants cross-agent access to any of this — every
 * function takes exactly one agentId and only ever touches that agent's
 * own tree. Cross-office access is Phase 3's job (business channels),
 * not this one's.
 */

export interface AgentManifest {
  owner: string;
  parent: string | null;
  created_at: number;
  quota: {
    // Sourced from existing config defaults — the same numbers that
    // already gate sandboxes/PTYs/spend today, just now recorded
    // per-agent instead of only living in global config.
    max_sandboxes: number;
    max_pty_sessions: number;
    max_inference_spend_usdc_per_day: number;
    max_marketplace_spend_usdc_per_day: number;
    // Stubs for Phase 2a/2b (departments, temp workers) — not yet
    // enforced anywhere. Left null rather than a made-up default so
    // it's obvious at a glance that nothing reads these yet.
    max_departments: number | null;
    max_workers_per_department: number | null;
    max_temp_workers_per_department: number | null;
    // Stubs for Phase 5b (architecture-agent.md §6's "hard resource
    // ceilings per office: disk quota, container CPU/mem"), same
    // null-until-backfilled convention as the three fields above — see
    // ensureResourceQuota() below. max_inference_spend_usdc_per_day /
    // max_marketplace_spend_usdc_per_day above already ARE §6's
    // "spend-rate cap pulled from wallet.ts/facilitator.ts usage logs";
    // Phase 5b enforces those two at the orchestrator level rather than
    // adding new fields for them.
    max_disk_mb: number | null;
    max_container_cpu_cores: number | null;
    max_container_memory_mb: number | null;
  };
  // Reserved for Phase 8/capability work — always empty until §8's
  // checkCapability() and Phase 3's channels exist to populate it.
  capability_grants: unknown[];
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function agentDir(agentId: string): string {
  // Defense in depth on top of the callers already treating agentId as
  // an opaque address string: a stray "/" or ".." in agentId must never
  // let one agent's directory resolve outside officesDir, or worse,
  // inside another agent's directory.
  if (!agentId || /[\\/]|(^|[^.])\.\.($|[^.])/.test(agentId)) {
    throw Object.assign(new Error(`invalid agentId: ${agentId}`), { status: 400 });
  }
  return path.join(config.officesDir, agentId);
}

export function officeFsDir(agentId: string): string {
  return path.join(agentDir(agentId), "office", "fs");
}
export function officeWorkspaceDir(agentId: string): string {
  return path.join(officeFsDir(agentId), "workspace");
}
export function officeInboxDir(agentId: string): string {
  return path.join(officeFsDir(agentId), "inbox");
}
export function officeOutboxDir(agentId: string): string {
  return path.join(officeFsDir(agentId), "outbox");
}
/**
 * The vault directory. Callers must NEVER pass this into a Docker bind
 * mount (see docker.ts's createNamedSandbox, which only ever binds
 * officeFsDir + browserProfileDir) and must NEVER expose its contents
 * over an agent-facing file-read endpoint. Nothing in vmService.ts's
 * /vm/file/* routes resolves paths under here — see safeOfficePath()
 * below, which only ever targets officeWorkspaceDir.
 *
 * The wallet private key itself already never lives here (wallet.ts
 * keeps it encrypted in the DB, which is a stronger guarantee than a
 * file could give) — this directory is for the identity/credential
 * material described in architecture-agent.md §2 that isn't already
 * covered by that, so the "vault" concept has exactly one physical
 * home even as more secret types show up.
 */
export function officePrivateDir(agentId: string): string {
  return path.join(agentDir(agentId), "office", "private");
}
export function browserProfileDir(agentId: string): string {
  return path.join(agentDir(agentId), "browser");
}
export function manifestPath(agentId: string): string {
  return path.join(agentDir(agentId), "manifest.json");
}

/**
 * next-phase.md Phase 4d (architecture-agent.md §5/§4g's COW table):
 * the on-disk home for the three config categories that table names as
 * copy-on-write — "Skills, system prompt, constitution.md config."
 * None of these had a location in the office tree before this phase;
 * Phase 0's own layout only ever provided fs/, private/, browser/, and
 * manifest.json. Nested directly under office/ (a sibling of fs/ and
 * private/, not inside either) because it's neither: not vault material
 * (it's non-secret, and §5's own COW table draws that line explicitly —
 * contrast with the vault row, "never" copied), and not bind-mounted
 * workspace scratch either (a stray "clean up my desktop" prompt or a
 * poisoned webpage reachable from officeWorkspaceDir should not be able
 * to touch what governs the agent's own behavior). Not bind-mounted
 * into the agent's own Docker sandbox — docker.ts's createNamedSandbox
 * only ever binds officeFsDir + browserProfileDir, and this phase does
 * not add a third bind — so this is read by the runtime process that
 * hosts the agent's own reasoning loop (agent-runtime), not by
 * anything running inside the sandboxed container.
 */
export function officeConfigDir(agentId: string): string {
  return path.join(agentDir(agentId), "office", "config");
}
export function officeConfigSkillsDir(agentId: string): string {
  return path.join(officeConfigDir(agentId), "skills");
}
export function officeConfigSystemPromptPath(agentId: string): string {
  return path.join(officeConfigDir(agentId), "system-prompt.md");
}
export function officeConfigConstitutionPath(agentId: string): string {
  return path.join(officeConfigDir(agentId), "constitution.md");
}

const DEFAULT_SYSTEM_PROMPT =
  "# System prompt\n\n" +
  "No agent-specific overrides yet. This file is read by the agent's " +
  "own runtime alongside the base prompt agent-runtime/systemPrompt.ts " +
  "already builds from tool grants; anything written here is appended, " +
  "not a replacement for it. Edited via the self-mod tools, never by " +
  "hand-editing the file directly outside of them.\n";

/**
 * Best-effort read of the repo's own canonical constitution.md
 * (config.defaultConstitutionPath) to seed a brand-new agent's config
 * copy. Falls back to a short placeholder rather than throwing — a
 * missing canonical file at office-creation time (e.g. a test
 * environment with no repo checkout alongside it) must never block an
 * agent from getting an office, since a missing constitution.md is
 * exactly the kind of thing self-mod/policy checks elsewhere already
 * treat as a hard stop for *other* operations, not a reason to fail
 * office bootstrap itself.
 */
async function readDefaultConstitution(): Promise<string> {
  try {
    return await fs.readFile(config.defaultConstitutionPath, "utf8");
  } catch {
    return (
      "# Constitution\n\n" +
      "(default text unavailable at office-creation time — " +
      `expected at ${config.defaultConstitutionPath})\n`
    );
  }
}

/**
 * Idempotent — safe to call on every sandbox creation, every wallet
 * creation, and every backend startup for existing agents. Creates the
 * full directory tree and a manifest.json if one doesn't already exist;
 * leaves an existing manifest untouched (so quota edits made later
 * aren't silently reset by a later ensureOffice call). Phase 4d: same
 * idempotence now applies to office/config/ — an existing
 * system-prompt.md/constitution.md is never overwritten by a later
 * ensureOffice call, only created the first time, exactly mirroring
 * the manifest's own "leave existing untouched" rule directly above.
 */
export async function ensureOffice(
  agentId: string,
  opts: { parent?: string | null } = {},
): Promise<AgentManifest> {
  await fs.mkdir(officeWorkspaceDir(agentId), { recursive: true });
  await fs.mkdir(officeInboxDir(agentId), { recursive: true });
  await fs.mkdir(officeOutboxDir(agentId), { recursive: true });
  await fs.mkdir(officePrivateDir(agentId), { recursive: true });
  await fs.mkdir(browserProfileDir(agentId), { recursive: true });
  await fs.mkdir(officeConfigSkillsDir(agentId), { recursive: true });

  const systemPromptPath = officeConfigSystemPromptPath(agentId);
  if (!(await fileExists(systemPromptPath))) {
    await fs.writeFile(systemPromptPath, DEFAULT_SYSTEM_PROMPT, "utf8");
  }
  const constitutionPath = officeConfigConstitutionPath(agentId);
  if (!(await fileExists(constitutionPath))) {
    await fs.writeFile(constitutionPath, await readDefaultConstitution(), "utf8");
  }

  const existing = await readManifest(agentId);
  if (existing) return existing;

  const manifest: AgentManifest = {
    owner: agentId,
    parent: opts.parent ?? null,
    created_at: Date.now(),
    quota: {
      max_sandboxes: config.maxSandboxesPerAgent,
      max_pty_sessions: config.maxPtySessionsPerAgent,
      max_inference_spend_usdc_per_day: config.maxInferenceSpendUsdcPerAgentPerDay,
      max_marketplace_spend_usdc_per_day: config.maxMarketplaceSpendUsdcPerAgentPerDay,
      max_departments: null,
      max_workers_per_department: null,
      max_temp_workers_per_department: null,
      max_disk_mb: null,
      max_container_cpu_cores: null,
      max_container_memory_mb: null,
    },
    capability_grants: [],
  };
  await writeManifest(agentId, manifest);
  return manifest;
}

/**
 * next-phase.md Phase 2a (architecture-agent.md §4a). Phase 0 left
 * max_departments / max_workers_per_department as `null` stubs in every
 * manifest ("visible in the schema before those phases build the
 * enforcement"). This is that backfill: the first time an agent's
 * department quota is actually needed (creating a department, or a
 * department spawning a worker), replace a still-null field with the
 * configured global default and persist it — so from then on the
 * per-agent manifest value is authoritative (an operator can hand-edit
 * one agent's quota without this backfill silently overwriting it on
 * the next call) and this function becomes a no-op read for that agent.
 */
export async function ensureDepartmentQuota(
  agentId: string,
): Promise<{
  max_departments: number;
  max_workers_per_department: number;
  max_temp_workers_per_department: number;
}> {
  const manifest = await ensureOffice(agentId);
  let changed = false;
  if (manifest.quota.max_departments === null) {
    manifest.quota.max_departments = config.defaultMaxDepartmentsPerAgent;
    changed = true;
  }
  if (manifest.quota.max_workers_per_department === null) {
    manifest.quota.max_workers_per_department = config.defaultMaxWorkersPerDepartment;
    changed = true;
  }
  // next-phase.md Phase 2b: same one-time backfill-then-authoritative
  // pattern as the two fields above, just for the temp-worker ceiling
  // Phase 0 also stubbed to null. An operator can still hand-edit one
  // agent's number afterward without this silently overwriting it.
  if (manifest.quota.max_temp_workers_per_department === null) {
    manifest.quota.max_temp_workers_per_department = config.defaultMaxTempWorkersPerDepartment;
    changed = true;
  }
  if (changed) await writeManifest(agentId, manifest);
  return {
    max_departments: manifest.quota.max_departments,
    max_workers_per_department: manifest.quota.max_workers_per_department,
    max_temp_workers_per_department: manifest.quota.max_temp_workers_per_department,
  };
}

/**
 * next-phase.md Phase 5b (architecture-agent.md §6): same one-time
 * backfill-then-authoritative pattern as ensureDepartmentQuota() right
 * above — Phase 0 left max_disk_mb / max_container_cpu_cores /
 * max_container_memory_mb as `null` stubs ("visible in the schema
 * before [this phase] builds the enforcement"). The first time
 * resourceQuotas.ts actually needs an agent's resource ceilings, this
 * replaces a still-null field with the configured global default and
 * persists it, so an operator can hand-edit one agent's own number
 * afterward without a later call silently overwriting it.
 *
 * Defaults deliberately reuse the SAME numbers that already gate a
 * single sandbox's own max size (config.maxSandboxVcpu/
 * maxSandboxMemoryMb/maxSandboxDiskGb) — same "same numbers that
 * already gate sandboxes/PTYs/spend today, just now recorded per-agent"
 * reasoning the AgentManifest doc comment above gives for the Phase 0
 * fields. This is a conservative starting ceiling: an agent running
 * several concurrent sandboxes at once (see maxSandboxesPerAgent /
 * maxEnvironmentSandboxesPerAgent) will need an operator to explicitly
 * raise its per-agent manifest value above one sandbox's own cap — same
 * "starts equal, raised deliberately" tradeoff Phase 2a's own
 * defaultMaxWorkersPerDepartment made rather than guessing a fleet-wide
 * multiplier no single number could get right for every agent.
 */
export async function ensureResourceQuota(
  agentId: string,
): Promise<{
  max_disk_mb: number;
  max_container_cpu_cores: number;
  max_container_memory_mb: number;
}> {
  const manifest = await ensureOffice(agentId);
  let changed = false;
  if (manifest.quota.max_disk_mb === null) {
    manifest.quota.max_disk_mb = config.maxSandboxDiskGb * 1024;
    changed = true;
  }
  if (manifest.quota.max_container_cpu_cores === null) {
    manifest.quota.max_container_cpu_cores = config.maxSandboxVcpu;
    changed = true;
  }
  if (manifest.quota.max_container_memory_mb === null) {
    manifest.quota.max_container_memory_mb = config.maxSandboxMemoryMb;
    changed = true;
  }
  if (changed) await writeManifest(agentId, manifest);
  return {
    max_disk_mb: manifest.quota.max_disk_mb,
    max_container_cpu_cores: manifest.quota.max_container_cpu_cores,
    max_container_memory_mb: manifest.quota.max_container_memory_mb,
  };
}

/**
 * next-phase.md Phase 4b (architecture-agent.md §5): migrates a clone's
 * on-disk office tree from its Phase 4a scaffold id (`clone_<hex>`) to
 * its newly minted wallet address, the moment 4b assigns one. A plain
 * directory rename — office/fs/, office/private/, browser/, and
 * manifest.json all move with it, since every one of them is computed
 * from the same agentDir(agentId) root rather than stored independently.
 * Throws if the destination already exists (must never silently merge
 * two offices together) or if the source doesn't (nothing to migrate).
 */
export async function renameOfficeDir(oldAgentId: string, newAgentId: string): Promise<void> {
  const oldDir = agentDir(oldAgentId);
  const newDir = agentDir(newAgentId);
  try {
    await fs.access(newDir);
    throw Object.assign(new Error(`office already exists for ${newAgentId} — refusing to overwrite`), {
      status: 409,
    });
  } catch (err: any) {
    if (err?.status === 409) throw err;
    // ENOENT is the expected case — no existing office at the destination.
  }
  await fs.rename(oldDir, newDir);
}

/**
 * next-phase.md Phase 4e (architecture-agent.md §5): records a clone's
 * lineage in its own manifest.json once there's a real claimed identity
 * to attach it to. 4a's own ensureOffice(id) call (deliberately no
 * `parent` option — see cloning.ts's own createCloneShell doc comment)
 * left every clone shell's manifest at the Phase-0 default `parent:
 * null`, and renameOfficeDir() (4b) carries that untouched value over
 * to the new wallet address along with the rest of the tree. This is
 * the backfill: wallet.ts's createClonedAgentWallet() calls it the
 * moment a shell becomes a real agent, passing the parent shell.id
 * already tracked since 4a (shell.parentAgentAddress) — not the same
 * thing as the `opts.parent` constructor-time argument ensureOffice()
 * already accepts above, since that path only ever applies to a
 * manifest that doesn't exist yet (createAgentWallet's/register's own
 * top-level-agent path); this one mutates a manifest ensureOffice()
 * already wrote.
 *
 * Immutable once set, matching this phase's own next-phase.md checklist
 * wording ("written once at clone time ... treated as immutable
 * lineage/provenance data, not a live pointer"): re-calling with the
 * SAME parent is a harmless no-op (so a retried claim doesn't fail on
 * this alone), but calling it with a DIFFERENT parent than one already
 * recorded throws rather than silently rewriting provenance.
 */
export async function setManifestParent(
  agentId: string,
  parentAgentAddress: string,
): Promise<AgentManifest> {
  const manifest = await readManifest(agentId);
  if (!manifest) {
    throw Object.assign(new Error(`no manifest for ${agentId} — call ensureOffice() first`), {
      status: 404,
    });
  }
  if (manifest.parent !== null && manifest.parent !== parentAgentAddress) {
    throw Object.assign(
      new Error(
        `manifest for ${agentId} already records a different parent (${manifest.parent}) — lineage is immutable`,
      ),
      { status: 409 },
    );
  }
  if (manifest.parent === parentAgentAddress) return manifest; // already recorded — no-op
  manifest.parent = parentAgentAddress;
  await writeManifest(agentId, manifest);
  return manifest;
}

export async function readManifest(agentId: string): Promise<AgentManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(agentId), "utf8");
    return JSON.parse(raw) as AgentManifest;
  } catch {
    return null;
  }
}

export async function writeManifest(agentId: string, manifest: AgentManifest): Promise<void> {
  await fs.mkdir(agentDir(agentId), { recursive: true });
  await fs.writeFile(manifestPath(agentId), JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Resolves a client-supplied relative path strictly inside the calling
 * agent's own office/fs/workspace — never into inbox/outbox (those are
 * broker-only, see architecture-agent.md §3) and never into private/.
 * The base is always derived from the authenticated agentId, never from
 * anything the caller supplies, closing the gap where the old safePath()
 * in vmService.ts took an arbitrary `base` argument.
 */
export function safeOfficePath(agentId: string, relPath: string): string {
  const base = officeWorkspaceDir(agentId);
  const resolved = path.resolve(base, relPath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    throw Object.assign(new Error("path escapes agent's office workspace"), { status: 400 });
  }
  return resolved;
}

/**
 * Phase 3d (architecture-agent.md §7 send_file()): the same resolve+
 * prefix containment check safeOfficePath() above already applies to
 * every workspace file operation, rooted at the calling agent's own
 * outbox instead — "file must already be staged in caller's own
 * office/outbox/" (§7, step 2) never accepts a path that resolves
 * outside it, and never silently clamps to the boundary either; a
 * miss throws.
 */
export function safeOutboxPath(agentId: string, relPath: string): string {
  const base = officeOutboxDir(agentId);
  const resolved = path.resolve(base, relPath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    throw Object.assign(new Error("path escapes agent's own outbox"), { status: 400 });
  }
  return resolved;
}

/**
 * Same containment shape as safeOutboxPath, rooted at the RECIPIENT's
 * inbox instead — the one directory this file's own Phase 0 doc comment
 * above already named as "written only by the future channel broker".
 * send_file() (channelService.ts) is that broker, as of this phase.
 */
export function safeInboxPath(agentId: string, relPath: string): string {
  const base = officeInboxDir(agentId);
  const resolved = path.resolve(base, relPath);
  if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
    throw Object.assign(new Error("path escapes agent's own inbox"), { status: 400 });
  }
  return resolved;
}

/**
 * next-phase.md Phase 3f-i (architecture-agent.md §3 join_project()):
 * the on-disk home of one joint_project channel's shared directory.
 * Deliberately NOT under either party's officesDir tree — a joint
 * directory belongs to the CHANNEL, not to either agent's own office,
 * same reasoning config.ts's own jointProjectsDir comment gives.
 *
 * channelId is always a `chn_[hex]` id minted by channelService.ts's
 * own newChannelId() — never caller-supplied free text — so this is a
 * plain join, not a containment check the way safeOfficePath()/
 * safeOutboxPath()/safeInboxPath() need to be for a client-supplied
 * relPath. A defensive shape guard is still applied so a malformed or
 * forged channelId can never resolve outside jointProjectsDir.
 */
export function jointProjectDir(channelId: string): string {
  if (!/^chn_[a-f0-9]+$/.test(channelId)) {
    throw Object.assign(new Error(`invalid channelId: ${channelId}`), { status: 400 });
  }
  return path.join(config.jointProjectsDir, channelId);
}
