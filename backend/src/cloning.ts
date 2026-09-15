import crypto from "crypto";
import fs from "fs/promises";
import { db } from "./db.js";
import { config } from "./config.js";
import { createNamedSandbox, deleteNamedSandbox } from "./docker.js";
import { ensureOffice, officeConfigDir } from "./office.js";
import { copyProceduresToAgent } from "./proceduralMemory.js";

/**
 * next-phase.md Phase 4a/4b (architecture-agent.md §5, Cloning): the
 * first two of six sub-phases (4a-4f) splitting Phase 4 apart. 4a builds
 * ONLY the empty shell — a new agent_id with its own fresh Docker
 * sandbox. 4b (claimCloneShellForWallet, below) is the handoff point
 * where wallet.ts's new createClonedAgentWallet() turns that shell into
 * a real, wallet-backed agent. 4c (ERC-8004 identity), 4d (copy-on-write
 * config), and 4e (lineage/manifest) each attach further to what 4b
 * produces.
 *
 * Phase 4c (ERC-8004 identity) needed no code here: wallet.ts's
 * existing POST /:address/erc8004/register route is already generic
 * over any agent address, a claimed clone's address included, and
 * registerOnChain() (erc8004.ts) has no notion of `parent` to
 * accidentally inherit from. See that route's own Phase 4c doc
 * comment in wallet.ts and cloning-erc8004.test.ts for the confirming
 * tests. Left noted here since a reader landing on this file looking
 * for 4c's wiring should find a pointer, not a gap.
 *
 * Phase 4d (copy-on-write config) lives here too, as copyCloneConfig()
 * below, called from wallet.ts's createClonedAgentWallet() right after
 * renameOfficeDir() (4b) has produced a real office tree under the new
 * wallet address. This phase's own header line in next-phase.md said
 * "Touches: agent-runtime/spawner.ts" — that's the same class of
 * plan-text mismatch 4a/4b/4c's own doc comments each already caught
 * and corrected: agent-runtime/spawner.ts's spawnChildProcess() is the
 * OTHER, pre-existing self-hosted mechanism this file's own doc comment
 * already flags above (fork()-a-process, fund-transfer-at-spawn) — it
 * has no notion of the Docker-sandboxed office/config/ tree this phase
 * actually copies, and reaching into it to add COW config-copying would
 * mean half-reconciling the two mechanisms as a side effect of this
 * phase, which is explicitly out of scope (see the "Relationship to the
 * OTHER clone mechanism" paragraph above). The real copy-on-write
 * happens where the rest of this phase's own dependencies (4a's shell,
 * 4b's office migration) already live: here.
 *
 * Relationship to the OTHER clone mechanism already in this repo
 * (agent-runtime/spawner.ts's spawnChildProcess + agent-runtime/tools.ts's
 * spawn_clone case): that is a separate, self-hosted, single-machine
 * design — fund a wallet, then fork a plain Node child process running
 * this same repo's dist/index.js, no Docker sandbox at all. It predates
 * this phase (see GAZA_DEPLOY.md/POLICY_PATCH_NOTES.md) and it also
 * transfers real funds parent-to-child at spawn time, which conflicts
 * with this file's own "no inherited funds" requirement (§5, and this
 * phase's own parent "Done when"). This phase does NOT modify or route
 * through that mechanism — it builds the backend-hosted, Docker-sandboxed
 * clone() architecture-agent.md §5 actually describes, alongside it.
 * Reconciling or retiring the older path is out of this phase's scope;
 * flagged here so 4f's verification doesn't mistake the older
 * spawn_clone's fund transfer for this design's own behavior.
 *
 * Why the clone gets a standalone scaffold id instead of reusing
 * office.ts's "agentId = wallet address" convention: at this point in
 * the sequence there IS no wallet yet (4b hasn't run) — minting one here
 * would mean 4a secretly does 4b's job, or worse, mean this phase
 * invents a fake address that 4b then has to migrate the office
 * directory away from. A `clone_<hex>` scaffold id keeps 4a's own scope
 * (agent_id + sandbox only) honest. createNamedSandbox()'s `agentAddress`
 * field is typed for a wallet address but only ever used as an opaque
 * office-directory/Docker-label key (confirmed against docker.ts and
 * Phase 2g's own department/project sandboxes, which already pass
 * non-wallet scope ids through the same field) — so passing a scaffold
 * id through it is consistent with an existing pattern, not a new one.
 */

const CLONE_ID_PREFIX = "clone_";

export function newCloneScaffoldId(): string {
  return `${CLONE_ID_PREFIX}${crypto.randomBytes(8).toString("hex")}`;
}

export interface CloneShell {
  /** Scaffold id — NOT a wallet address. See module doc comment. */
  id: string;
  parentAgentAddress: string;
  sandboxId: string;
  createdAt: number;
  /** creating | ready | claimed | failed — see clone_shells table doc in db.ts. */
  status: string;
  claimedAt: number | null;
}

interface CloneShellRow {
  id: string;
  parent_agent_address: string;
  sandbox_id: string;
  status: string;
  created_at: number;
  claimed_at: number | null;
}

function countPendingShells(parentAgentAddress: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) as n FROM clone_shells
         WHERE parent_agent_address = ? AND status != 'failed' AND claimed_at IS NULL`,
      )
      .get(parentAgentAddress) as { n: number }
  ).n;
}

/**
 * Phase 4a's own function: mints a new agent_id and stands up a fresh
 * Docker sandbox for it, reusing Phase 0's office shape (ensureOffice
 * already creates fs/, private/, browser/ and a manifest.json — see
 * office.ts). No wallet, no chain identity, no copied config — those
 * are 4b/4c/4d. The manifest this call produces is a bare Phase-0
 * default: `parent` stays null (4e's job to set, once there's a real
 * lineage worth recording against a claimed identity, not a throwaway
 * scaffold id that might never get claimed).
 *
 * parentAgentAddress must be a real, already-registered agent — cloning
 * is something an existing agent does, not a way to create a first
 * agent from nothing.
 */
export async function createCloneShell(parentAgentAddress: string): Promise<CloneShell> {
  const parent = db
    .prepare(`SELECT address FROM agents WHERE address = ?`)
    .get(parentAgentAddress) as { address: string } | undefined;
  if (!parent) {
    throw Object.assign(new Error(`unknown parent agent: ${parentAgentAddress}`), { status: 404 });
  }

  const pending = countPendingShells(parentAgentAddress);
  if (pending >= config.maxPendingCloneShellsPerAgent) {
    throw Object.assign(
      new Error(
        `pending clone-shell limit reached (${config.maxPendingCloneShellsPerAgent} per agent) — ` +
          `finish or abandon (see abandonCloneShell) an existing clone before starting another`,
      ),
      { status: 403 },
    );
  }

  const id = newCloneScaffoldId();
  const sandboxId = `sbx-clone-${id}`;
  const createdAt = Date.now();

  db.prepare(
    `INSERT INTO clone_shells (id, parent_agent_address, sandbox_id, status, created_at)
     VALUES (?, ?, ?, 'creating', ?)`,
  ).run(id, parentAgentAddress, sandboxId, createdAt);

  try {
    // Phase 0 office shape — fs/, private/, browser/, manifest.json.
    // Deliberately called with no `parent` option: see module doc.
    await ensureOffice(id);
    await createNamedSandbox(sandboxId, {
      vcpu: 1,
      memoryMb: config.minSandboxMemoryMb,
      diskGb: 1,
      agentAddress: id,
    });
  } catch (err) {
    db.prepare(`UPDATE clone_shells SET status = 'failed' WHERE id = ?`).run(id);
    throw err;
  }

  db.prepare(`UPDATE clone_shells SET status = 'ready' WHERE id = ?`).run(id);
  return { id, parentAgentAddress, sandboxId, createdAt, status: "ready", claimedAt: null };
}

/**
 * next-phase.md Phase 4b (architecture-agent.md §5): the atomic
 * "reserve this shell for a wallet" step. Separated from
 * markCloneShellClaimed() (which just flips the row) so the
 * ready/not-already-claimed check and the state flip happen as one
 * unit — a caller in wallet.ts shouldn't have to re-check status
 * itself between reading and marking. Returns the shell so the caller
 * has sandboxId/parentAgentAddress on hand without a second lookup.
 */
export function claimCloneShellForWallet(id: string): CloneShell {
  const row = db.prepare(`SELECT * FROM clone_shells WHERE id = ?`).get(id) as
    | CloneShellRow
    | undefined;
  if (!row) {
    throw Object.assign(new Error(`unknown clone shell: ${id}`), { status: 404 });
  }
  if (row.status !== "ready" || row.claimed_at !== null) {
    throw Object.assign(
      new Error(`clone shell ${id} is not claimable (status: ${row.status})`),
      { status: 409 },
    );
  }
  markCloneShellClaimed(id);
  return getCloneShell(id)!;
}

export function getCloneShell(id: string): CloneShell | null {
  const row = db.prepare(`SELECT * FROM clone_shells WHERE id = ?`).get(id) as
    | CloneShellRow
    | undefined;
  if (!row) return null;
  return {
    id: row.id,
    parentAgentAddress: row.parent_agent_address,
    sandboxId: row.sandbox_id,
    createdAt: row.created_at,
    status: row.status,
    claimedAt: row.claimed_at,
  };
}

/**
 * Flips a shell's status to claimed. Called by claimCloneShellForWallet()
 * above as of Phase 4b (itself wired to POST /wallet/claim-clone in
 * wallet.ts) — kept as its own small function since abandonCloneShell()
 * below needs the same "just flip the row" shape for its own terminal
 * state, just to 'failed' instead of 'claimed'.
 */
export function markCloneShellClaimed(id: string): void {
  db.prepare(`UPDATE clone_shells SET status = 'claimed', claimed_at = ? WHERE id = ?`).run(
    Date.now(),
    id,
  );
}

/**
 * Tears down an unclaimed shell's sandbox and frees its pending-shell
 * slot. Wired to POST /wallet/clone-shells/:id/abandon (wallet.ts) —
 * a parent that started a clone via createCloneShell and decided not to
 * finish it (name collision, changed its mind, etc.) can release the
 * slot without waiting for something else to fail it, so a live shell
 * isn't a permanent, unrecoverable drain on
 * maxPendingCloneShellsPerAgent.
 *
 * Reads the raw row (not getCloneShell(), which drops status) so it can
 * refuse to touch a shell that's already claimed: once claimCloneShell-
 * ForWallet() has run, `sandbox_id` on this row refers to a container
 * createClonedAgentWallet() has already deleted and replaced under the
 * new wallet address (see wallet.ts) — calling deleteNamedSandbox()
 * again here would target the wrong container id, and flipping a
 * claimed row's status to 'failed' would corrupt the record of a real,
 * already-live agent for no reason. Unknown ids are still a silent
 * no-op, matching this function's original contract for a shell that
 * was never created or was already cleaned up.
 */
export async function abandonCloneShell(id: string): Promise<void> {
  const row = db.prepare(`SELECT * FROM clone_shells WHERE id = ?`).get(id) as
    | CloneShellRow
    | undefined;
  if (!row) return;
  if (row.status === "claimed" || row.claimed_at !== null) {
    throw Object.assign(
      new Error(`clone shell ${id} is already claimed and cannot be abandoned`),
      { status: 409 },
    );
  }
  try {
    await deleteNamedSandbox(row.sandbox_id);
  } catch {
    // already gone — fall through and mark it failed regardless
  }
  db.prepare(`UPDATE clone_shells SET status = 'failed' WHERE id = ?`).run(id);
}

/**
 * next-phase.md Phase 4d (architecture-agent.md §5 COW table): the
 * actual copy-on-write. Copies exactly the three config categories the
 * table names as copyable — skills, system prompt, constitution.md
 * config, all of which live under office.ts's officeConfigDir() as of
 * this phase — plus, only if the caller opts in, learned procedural
 * memory (the one memory category the same table lists as copyable
 * "if you want lineage").
 *
 * A real byte-for-byte copy (fs.cp with recursive: true), not a shared
 * reference or a symlink — the parent editing its own
 * office/config/system-prompt.md (or adding a new skill) after this
 * call runs must never retroactively change what the clone already
 * has. force: true so a destination file created by ensureOffice()'s
 * own default-seeding (office.ts, this same phase) is overwritten with
 * the parent's real config rather than left as the generic default —
 * ensureOffice() always runs before this function in the actual claim
 * path (createClonedAgentWallet() calls it via renameOfficeDir()'s
 * prerequisite office, then again at the end for its own idempotent
 * confirmation — see wallet.ts), so a destination collision here is
 * the expected case, not an error.
 *
 * Deliberately does NOT touch, and this is the specific thing 4e's own
 * "Done when" line and this phase's own next-phase.md checklist both
 * call out to confirm: officeWorkspaceDir/officeInboxDir/officeOutboxDir
 * (already empty for a fresh clone — 4a's own scaffold never wrote
 * anything there), memory_episodic, memory_semantic, knowledge_store,
 * or department_knowledge (all separate DB tables, all scoped by
 * agent_address, none referenced anywhere in this function's body).
 * officePrivateDir is untouched for the same reason cloning.ts's own
 * module doc gives for the wallet itself: vault contents are the one
 * row in the COW table's own "Fresh (never copied)" column this phase
 * must never cross.
 */
export async function copyCloneConfig(
  parentAgentAddress: string,
  cloneAgentAddress: string,
  opts: { includeProceduralMemory?: boolean } = {},
): Promise<{ configCopied: boolean; proceduresCopied: number }> {
  const src = officeConfigDir(parentAgentAddress);
  const dest = officeConfigDir(cloneAgentAddress);

  let configCopied = false;
  try {
    await fs.access(src);
  } catch {
    // Parent has no office/config/ yet (shouldn't happen for any agent
    // that's been through ensureOffice() — Phase 0 runs it at creation
    // — but a pre-Phase-4d agent row created before this phase existed
    // could lack it). Nothing to copy; the clone keeps whatever
    // ensureOffice() already seeded as its own default, rather than
    // this call throwing and aborting the whole claim.
    return { configCopied: false, proceduresCopied: 0 };
  }
  await fs.cp(src, dest, { recursive: true, force: true });
  configCopied = true;

  const proceduresCopied = opts.includeProceduralMemory
    ? copyProceduresToAgent(parentAgentAddress, cloneAgentAddress)
    : 0;

  return { configCopied, proceduresCopied };
}
