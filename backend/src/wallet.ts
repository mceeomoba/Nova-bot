import express from "express";
import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import crypto from "crypto";
import { db } from "./db.js";
import { config } from "./config.js";
import { registerOnChain } from "./erc8004.js";
import { ensureOffice, renameOfficeDir, setManifestParent } from "./office.js";
import { assignTools } from "./toolRegistry.js";
import { recordToolGrants } from "./toolGrants.js";
import { checkCapability } from "./capability.js";
import { getOwnedDepartment } from "./departments.js";
import {
  createCloneShell,
  claimCloneShellForWallet,
  abandonCloneShell,
  getCloneShell,
  copyCloneConfig,
} from "./cloning.js";
import { createNamedSandbox, deleteNamedSandbox } from "./docker.js";
import { emitEvent } from "./ecosystemEvents.js";
import { requirePaymentChannel, paymentChannelRequired } from "./channelService.js";

const router = express.Router();

const CHAIN = config.chainNetwork === "base" ? base : baseSepolia;
const USDC: Record<string, Address> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const publicClient = createPublicClient({ chain: CHAIN, transport: http() });

// --- Very simple at-rest key encryption. Swap for a KMS/HSM before production. ---
const ENC_KEY = crypto.createHash("sha256").update(config.backendApiKey).digest();
function encrypt(privateKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}
function decrypt(blob: string): `0x${string}` {
  const buf = Buffer.from(blob, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8") as `0x${string}`;
}

// PHASE-17D-IV: getAgentAccount() below already decrypts an agent's key
// in-process, but only ever hands back a viem PrivateKeyAccount — no
// caller could get the raw hex out of it. genesis.ts's own
// provisionAgentRuntimeIdentity() needs the raw hex to write a
// wallet.json in the exact shape agent/src/identity/wallet.ts's
// WalletData expects ({ chainType, privateKey, createdAt }), so this
// exports the one missing accessor rather than duplicating decrypt()'s
// logic (which stays unexported/unchanged) in genesis.ts. Read-only:
// this never re-encrypts, re-derives, or persists anything new — it's
// the same encrypted_key column every other in-process caller in this
// file already reads.
export function getAgentPrivateKeyHex(address: string): `0x${string}` {
  const row = db
    .prepare(`SELECT encrypted_key FROM agents WHERE address = ?`)
    .get(address) as { encrypted_key: string } | undefined;
  if (!row) throw new Error(`getAgentPrivateKeyHex: unknown agent address ${address}`);
  return decrypt(row.encrypted_key);
}

// next-phase.md Phase 9a-i (architecture-agent.md §4h, Reasoning
// section): slug generation for the collision-avoidance layer 9a's own
// naming convention needs — an Agent's own site is
// `{agent-slug}.novamail.store`, a department's mailbox is
// `{agent-slug}-{purpose}@novamail.store`. Called from all three of
// this file's own agents-row insert sites (createAgentWallet,
// createClonedAgentWallet, and the self-custody POST /register route)
// so every path that can bring a new agents row into existence gets a
// real slug from the moment that row exists — not just the one
// call site next-phase.md's own checklist names by name
// (createAgentWallet), since 9a-ii/9c/9d's own "every Agent has a
// Domain Management Department Agent" framing only holds if every
// agent actually has a slug to build a subdomain/mailbox name from,
// regardless of which of the three creation paths it came in through.
//
// Deliberately synchronous — better-sqlite3's own API is synchronous
// throughout this file already (see every other `db.prepare(...).get`/
// `.run` call site), and slug generation is a pure read-then-write
// against the same local database, not an external call.
//
// Collision handling: slugify the name, then retry with a numeric
// suffix (-2, -3, ...) against the partial unique index db.ts's own
// migration just created, the same "retry with a numeric suffix on
// collision" pattern this sub-phase's own next-phase.md checklist item
// names by name for any slugified-username system. A hard cap
// (MAX_SLUG_SUFFIX_ATTEMPTS) turns a pathological run of collisions
// into a clear thrown error instead of an unbounded loop — collisions
// this deep would mean either a name reused thousands of times or a
// real bug elsewhere, not a case worth looping forever over.
const MAX_SLUG_BASE_LENGTH = 24; // short, DNS-safe, leaves room for a numeric suffix and a mailbox purpose fragment
const MAX_SLUG_SUFFIX_ATTEMPTS = 50;

function slugifyBase(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_BASE_LENGTH)
    .replace(/-+$/g, ""); // truncation can leave a trailing hyphen behind
  return base || "agent"; // e.g. a name that's entirely emoji/punctuation
}

/**
 * Generate and reserve a short, DNS-safe, unique-across-the-whole-
 * deployment slug for a new agent, derived from its own name. Callers
 * insert the returned value directly into `agents.slug` as part of the
 * same row insert — this function only computes and collision-checks
 * the value, it doesn't write it itself, so it stays usable across all
 * three of this file's insert shapes (fresh key, claimed clone,
 * self-custody registration) without assuming any one of their INSERT
 * statements.
 */
export function generateAgentSlug(name: string): string {
  const base = slugifyBase(name);
  const existing = db.prepare(`SELECT 1 FROM agents WHERE slug = ?`);
  if (!existing.get(base)) return base;
  for (let suffix = 2; suffix <= MAX_SLUG_SUFFIX_ATTEMPTS; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!existing.get(candidate)) return candidate;
  }
  // Same "don't silently degrade, throw a clear error" posture this
  // file already takes elsewhere (e.g. getAgentAccount's "Unknown agent
  // address") rather than falling back to something collision-prone.
  throw new Error(`Could not generate a unique slug for "${name}" after ${MAX_SLUG_SUFFIX_ATTEMPTS} attempts`);
}

/** Create a brand-new agent wallet. Optionally record its parent for lineage. */
export async function createAgentWallet(name: string, parentAddress?: string) {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const slug = generateAgentSlug(name);
  // next-phase.md Phase 2i(b) (architecture-agent.md §9): "top-level
  // agent provisioning," the fourth of 2i(b)'s own named call sites —
  // an Agent-tier row resolves its own tool grant from tool_registry
  // via assign_tools("agent") the moment it exists, same "snapshot at
  // creation time" convention create_department/spawn_worker/
  // spawn_temp_workers now use (db.ts's Phase 2i(b) migration comment).
  // Every non-deprecated Agent-tier row in tool_registry has
  // department_types unset (toolRegistrySeedData.ts's §4d generation
  // never restricts an Agent-tier row to a department type), so no
  // role/departmentType is passed here — there isn't one for a
  // top-level Agent.
  const resolvedGrants = assignTools("agent");
  const grantedTools = resolvedGrants.map((g) => g.name);
  db.prepare(
    `INSERT INTO agents (address, name, parent_address, encrypted_key, granted_tools, slug, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(account.address, name, parentAddress ?? null, encrypt(pk), JSON.stringify(grantedTools), slug, Date.now());
  // next-phase.md Phase 2i(d): per-grant rows, additive alongside the
  // snapshot above. Every non-deprecated Agent-tier row is `persistent`
  // (toolRegistrySeedData.ts's own §4d generation, confirmed by Phase
  // 2i(a)'s test suite) — recorded here for a complete, queryable
  // ledger, but scope_key stays NULL and no teardown hook ever looks
  // these rows up, matching this phase's own "persistent grants don't
  // auto-expire" rule.
  recordToolGrants("agent", account.address, resolvedGrants);
  // Phase 0 (architecture-agent.md §1/§2): every agent gets its office
  // the moment it exists, not lazily on first sandbox use, so
  // office/private/ and manifest.json are there from address zero.
  // Lineage recorded for provenance only — see §5, a parent confers no
  // access to the child's office.
  await ensureOffice(account.address, { parent: parentAddress ?? null });
  emitEvent({
    agentAddress: account.address,
    agentName: name,
    role: "CEO",
    subRole: "Genesis",
    eventType: "spawn",
    message: parentAddress ? `New agent "${name}" created (child of ${parentAddress.slice(0, 10)}…)` : `New agent "${name}" created`,
    metadata: { slug, parentAddress: parentAddress ?? null },
  });
  return { address: account.address, name, grantedTools, slug };
}

/**
 * next-phase.md Phase 4b (architecture-agent.md §5, Cloning): turns a
 * Phase 4a clone shell into a real, wallet-backed agent. Deliberately
 * NOT a thin wrapper around createAgentWallet() above — that function
 * assumes ensureOffice() hasn't run yet for this address (it always has
 * for a clone shell, just under the scaffold id, not the wallet address
 * yet) and it takes no sandboxId to migrate. This function does the
 * three things createAgentWallet() doesn't need to: claims the shell
 * (cloning.ts's own atomic ready→claimed check, so a shell can't be
 * claimed twice), migrates the office directory from the scaffold id to
 * the new address (office.ts's renameOfficeDir(), new for this phase),
 * and recreates the Docker sandbox under the new address — Docker has
 * no "rebind an existing container's mount" call (see docker.ts's own
 * note on this, next to its join_project bind-reconciliation code), so
 * "migrate a sandbox" here means delete the scaffold-id container and
 * create a fresh one under the real address, same createNamedSandbox()
 * path every other agent's default sandbox already goes through.
 *
 * No funding transfer anywhere in this function — the clone starts at
 * zero balance, same as any brand-new wallet, on purpose (§5's "no
 * inherited funds"). Contrast with the OTHER spawn_clone mechanism in
 * this repo (agent-runtime/tools.ts), which does transfer funds — see
 * cloning.ts's own module doc for why this function doesn't follow that
 * precedent.
 *
 * next-phase.md Phase 4d (architecture-agent.md §5 COW table): also
 * copies the parent's skills/system-prompt/constitution config into the
 * clone's now-migrated office via cloning.ts's own copyCloneConfig() —
 * right after renameOfficeDir() below, since that's the earliest point
 * a real office tree exists under the new address for the copy to land
 * in. `includeProceduralMemory` defaults to false, matching this
 * phase's own checklist ("optional/flagged, not automatic") — a caller
 * has to explicitly ask for a clone to start with its parent's learned
 * procedures rather than an empty procedural-memory table.
 */
export async function createClonedAgentWallet(
  cloneShellId: string,
  name: string,
  opts: { includeProceduralMemory?: boolean } = {},
) {
  const shell = claimCloneShellForWallet(cloneShellId);

  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  const slug = generateAgentSlug(name);

  // Same tool-grant resolution as createAgentWallet() — a cloned Agent
  // gets the current tool_registry's Agent-tier grant, not a copy of
  // its parent's (possibly stale, possibly since-revoked) grant list.
  const resolvedGrants = assignTools("agent");
  const grantedTools = resolvedGrants.map((g) => g.name);

  // Office migration first, while the shell's scaffold id is still the
  // only thing on disk — if this throws (e.g. a destination collision),
  // nothing below has committed yet.
  await renameOfficeDir(shell.id, account.address);

  // Phase 4d: copy the parent's skills/system-prompt/constitution
  // config into the office tree that just landed under the new
  // address — a real copy (cloning.ts's copyCloneConfig), not a shared
  // reference, so the parent editing its own config afterward never
  // retroactively changes the clone's. Deliberately before the sandbox
  // migration below has no ordering significance either way (the two
  // don't touch each other's state) — done here simply because the
  // office is the thing that just became real.
  await copyCloneConfig(shell.parentAgentAddress, account.address, {
    includeProceduralMemory: opts.includeProceduralMemory ?? false,
  });

  // Sandbox migration: delete the scaffold-id container, stand up a
  // fresh one under the real address using the same
  // `sbx-default-{agentAddress}` naming convention every other
  // top-level agent's own default sandbox uses (see
  // vmService.ts's getOrCreateDefaultSandbox) — a claimed clone is,
  // from here on, an ordinary top-level agent, not a special case.
  const newSandboxId = `sbx-default-${account.address}`;
  await deleteNamedSandbox(shell.sandboxId);
  db.prepare(
    `INSERT INTO sandboxes (id, agent_address, status, vcpu, memory_mb, disk_gb, network_enabled, created_at)
     VALUES (?, ?, 'creating', 1, ?, 1, 0, ?)`,
  ).run(newSandboxId, account.address, config.minSandboxMemoryMb, Date.now());
  await createNamedSandbox(newSandboxId, {
    vcpu: 1,
    memoryMb: config.minSandboxMemoryMb,
    diskGb: 1,
    agentAddress: account.address,
  });
  db.prepare(`UPDATE sandboxes SET status = 'running' WHERE id = ?`).run(newSandboxId);

  // next-phase.md Phase 4e (architecture-agent.md §5): lineage recorded
  // here, in the agents table, and — via setManifestParent() below — in
  // manifest.json, now that there's a real claimed identity worth
  // attaching it to. 4b (above) deliberately left this NULL; that's the
  // gap this phase closes. Provenance only, same as createAgentWallet()'s
  // own parent_address column — never a grant, never checked by
  // checkCapability (Phase 4f verifies that directly).
  db.prepare(
    `INSERT INTO agents (address, name, parent_address, encrypted_key, granted_tools, slug, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(account.address, name, shell.parentAgentAddress, encrypt(pk), JSON.stringify(grantedTools), slug, Date.now());
  recordToolGrants("agent", account.address, resolvedGrants);

  // ensureOffice is idempotent (office.ts's own doc comment) — this
  // call doesn't recreate anything (renameOfficeDir already produced a
  // full office tree + manifest.json under the new address), it only
  // confirms the migrated manifest is readable under the new id before
  // this function returns success.
  await ensureOffice(account.address);

  // Phase 4e: backfill manifest.json's own `parent` field, left at 4a's
  // bare `null` default under the scaffold id and carried over untouched
  // by renameOfficeDir(). Immutable once set (office.ts's own doc
  // comment) — a single claim only ever calls this once per address, so
  // the "already set to something else" throw path is a defensive
  // guard against a future caller re-claiming an address, not something
  // this call site itself can trigger.
  await setManifestParent(account.address, shell.parentAgentAddress);

  emitEvent({
    agentAddress: account.address,
    agentName: name,
    role: "CEO",
    subRole: "Genesis (Clone)",
    eventType: "spawn",
    message: `New agent "${name}" created by cloning (parent ${shell.parentAgentAddress.slice(0, 10)}…)`,
    metadata: { slug, cloneShellId, parentAddress: shell.parentAgentAddress },
  });

  return { address: account.address, name, grantedTools, slug, sandboxId: newSandboxId };
}

export function getAgentAccount(address: string) {
  const row = db
    .prepare(`SELECT encrypted_key FROM agents WHERE address = ?`)
    .get(address) as { encrypted_key: string } | undefined;
  if (!row) throw new Error("Unknown agent address");
  return privateKeyToAccount(decrypt(row.encrypted_key));
}

// POST /wallet/create  { name, parentAddress? }
router.post("/create", async (req, res) => {
  const { name, parentAddress } = req.body;
  if (!name) return res.status(400).json({ error: "name required" });
  const wallet = await createAgentWallet(name, parentAddress);
  res.json(wallet);
});

// POST /wallet/clone-shells  { parentAgentAddress }
// next-phase.md Phase 4a: the HTTP surface for cloning.ts's
// createCloneShell() — mints the empty agent_id + fresh-sandbox shell,
// before any wallet exists. This is the route the claim-clone route's
// own doc comment (below) used to point at as "once that route exists" —
// it now does. caller === resourceId here for the same reason every
// other wallet route in this file gives (see the erc8004/register
// route's own note): this backend has no notion of an authenticated
// caller distinct from the address in the request body, so this check
// always allows and exists purely to land the action in
// capability_audit.
router.post("/clone-shells", async (req, res) => {
  const { parentAgentAddress } = req.body as { parentAgentAddress?: string };
  if (!parentAgentAddress) {
    return res.status(400).json({ error: "parentAgentAddress required" });
  }
  try {
    checkCapability({
      caller: parentAgentAddress,
      resourceType: "wallet",
      resourceId: parentAgentAddress,
      action: "manage",
    });
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }
  try {
    const shell = await createCloneShell(parentAgentAddress);
    res.json(shell);
  } catch (err: any) {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "clone shell creation failed" });
  }
});

// GET /wallet/clone-shells/:id
// Status lookup for a shell minted above — lets a parent agent poll
// whether its shell reached 'ready' (via cloning.ts's own status field)
// before attempting to claim it, or confirm a shell exists at all before
// calling either claim-clone or abandon below.
router.get("/clone-shells/:id", (req, res) => {
  const shell = getCloneShell(req.params.id);
  if (!shell) {
    return res.status(404).json({ error: `unknown clone shell: ${req.params.id}` });
  }
  res.json(shell);
});

// POST /wallet/clone-shells/:id/abandon
// next-phase.md Phase 4a: the HTTP surface for cloning.ts's
// abandonCloneShell() — tears down an unclaimed shell's sandbox and
// frees its slot against maxPendingCloneShellsPerAgent, for a parent
// that started a clone and decided not to finish it (e.g. picked a name
// that collided, or simply changed its mind before calling claim-clone).
// caller resolved from the shell's own parent_agent_address rather than
// trusting a body param, so a request can't abandon a shell it doesn't
// own just by naming a different parent in the body.
router.post("/clone-shells/:id/abandon", async (req, res) => {
  const shell = getCloneShell(req.params.id);
  if (!shell) {
    return res.status(404).json({ error: `unknown clone shell: ${req.params.id}` });
  }
  try {
    checkCapability({
      caller: shell.parentAgentAddress,
      resourceType: "wallet",
      resourceId: shell.parentAgentAddress,
      action: "manage",
    });
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }
  try {
    await abandonCloneShell(req.params.id);
    res.json({ id: req.params.id, status: "failed" });
  } catch (err: any) {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "abandon failed" });
  }
});

// POST /wallet/claim-clone  { cloneShellId, name }
// next-phase.md Phase 4b: the HTTP surface for createClonedAgentWallet()
// above — turns a Phase 4a clone shell (POST /clone-shells above) into a
// real agent. Kept separate from POST /wallet/create rather than an
// optional field on it: a clone claim requires an existing,
// already-provisioned shell and fails a different way (404/409 on a bad
// or already-claimed shell id) than a plain wallet creation ever can.
router.post("/claim-clone", async (req, res) => {
  const { cloneShellId, name, includeProceduralMemory } = req.body;
  if (!cloneShellId || !name) {
    return res.status(400).json({ error: "cloneShellId and name required" });
  }
  try {
    const wallet = await createClonedAgentWallet(cloneShellId, name, {
      includeProceduralMemory: Boolean(includeProceduralMemory),
    });
    res.json(wallet);
  } catch (err: any) {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "clone claim failed" });
  }
});

// POST /wallet/register  { address, name, parentAddress? }
// For agents that generate their own key locally and never send it here —
// the backend only ever learns the public address, never custodies the key.
// Prefer this over /wallet/create whenever the agent itself is capable of
// key generation (viem, ethers, etc.) — it's the more secure default.
router.post("/register", async (req, res) => {
  const { address, name, parentAddress } = req.body;
  if (!address || !name) return res.status(400).json({ error: "address and name required" });
  const existing = db.prepare(`SELECT address FROM agents WHERE address = ?`).get(address);
  if (existing) {
    await ensureOffice(address, { parent: parentAddress ?? null });
    return res.json({ address, name, alreadyRegistered: true });
  }
  // next-phase.md Phase 2i(b): same top-level-agent grant resolution as
  // createAgentWallet() above, for the bring-your-own-key registration
  // path — an Agent-tier row gets its tool_registry-resolved grant the
  // moment it's known to this backend at all, not only when the
  // backend itself generated the key.
  const resolvedGrants = assignTools("agent");
  const grantedTools = resolvedGrants.map((g) => g.name);
  const slug = generateAgentSlug(name);
  db.prepare(
    `INSERT INTO agents (address, name, parent_address, encrypted_key, granted_tools, slug, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  ).run(address, name, parentAddress ?? null, JSON.stringify(grantedTools), slug, Date.now());
  // next-phase.md Phase 2i(d): per-grant rows, same as createAgentWallet()
  // above — persistent, never torn down by any hook, but recorded for a
  // complete ledger.
  recordToolGrants("agent", address, resolvedGrants);
  await ensureOffice(address, { parent: parentAddress ?? null });
  emitEvent({
    agentAddress: address,
    agentName: name,
    role: "CEO",
    subRole: "Genesis (Self-Registered)",
    eventType: "spawn",
    message: parentAddress ? `New agent "${name}" registered (child of ${parentAddress.slice(0, 10)}…)` : `New agent "${name}" registered`,
    metadata: { slug, parentAddress: parentAddress ?? null },
  });
  res.json({ address, name, alreadyRegistered: false, grantedTools, slug });
});

// Zent.md Phase 8d: check_available_capital(opportunity_id)'s own
// on-chain read, factored out of the GET /:address/balance route below
// so expansionRoutes.ts's Phase 8d route can read the SAME real balance
// this endpoint already exposes, rather than re-implementing the
// readContract call a second time.
async function readUsdcBalanceRaw(address: Address): Promise<bigint> {
  const usdcAddress = USDC[config.chainNetwork];
  return publicClient.readContract({
    address: usdcAddress,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ] as const,
    functionName: "balanceOf",
    args: [address],
  });
}

/** Same on-chain balance the GET /:address/balance route below exposes,
 *  as a plain number rather than the route's formatted display string —
 *  Phase 8d's own computation needs to do arithmetic on this, not just
 *  render it. */
export async function getUsdcBalance(address: Address): Promise<number> {
  return Number(formatUnits(await readUsdcBalanceRaw(address), 6));
}

// GET /wallet/:address/balance
router.get("/:address/balance", async (req, res) => {
  const address = req.params.address as Address;
  const balance = await readUsdcBalanceRaw(address);
  res.json({
    address,
    usdc: formatUnits(balance, 6),
    network: config.chainNetwork,
  });
});

// GET /wallet/:address/lineage — parent + children
//
// Zent.md Phase 1e: `self` already rides `SELECT *`, so spawn_reason/
// opportunity_id show up on it for free the moment the migration above
// runs — no change needed there. `children` used a fixed column list,
// so those two are added explicitly here; this is the "lineage queries
// can tell the two apart" the migration's own comment describes, for
// the one lineage query this file already exposes. Every row still
// defaults to spawn_reason: 'self', opportunity_id: null until Phase
// 16's genesis_company() exists to write the other value.
router.get("/:address/lineage", (req, res) => {
  const address = req.params.address;
  const self = db.prepare(`SELECT * FROM agents WHERE address = ?`).get(address);
  const children = db
    .prepare(
      `SELECT address, name, created_at, spawn_reason, opportunity_id, genesis_activation_status
       FROM agents WHERE parent_address = ?`,
    )
    .all(address);
  res.json({ self, children });
});

// POST /wallet/:address/erc8004/register  { agentURI?, force? }
//
// Publishes this agent's identity on the ERC-8004 Identity Registry on
// Base — a real, public, on-chain transaction, separate from and in
// addition to the private lineage row this backend already keeps.
// Only works for wallets this backend custodies (created via
// /wallet/create): registering means signing a transaction, and
// self-custody agents (/wallet/register) hold their own key, so they'd
// call the registry directly instead of asking this backend to.
//
// next-phase.md Phase 4c (architecture-agent.md §5, Cloning — independent
// on-chain identity): this route is ALSO the clone identity-registration
// path, unmodified. It is already fully generic over :address — the
// lookup below is a single `WHERE address = ?` with no join and no
// notion of `parent`/`parent_address` anywhere in this handler or in
// registerOnChain() (erc8004.ts) — so calling it against a Phase 4b
// clone's own address registers that clone a genuinely independent
// on-chain identity through the exact same contract call a normal
// top-level agent goes through, never a delegated/sub-identity under
// the parent's own registration. A clone's erc8004_* columns start
// NULL (wallet.ts's createClonedAgentWallet() never sets them at
// insert — same bare insert shape createAgentWallet() already uses),
// so `alreadyRegistered` correctly reads false the first time this is
// called for a clone, same as for any brand-new agent. See
// cloning-erc8004.test.ts for the inlined-mirror confirmation (9/9
// passing) that a clone's minted agentId is distinct from its parent's
// and that registering a clone reads/writes nothing on the parent's row.
// Deliberately NOT auto-called from createClonedAgentWallet() itself:
// assertCanAffordGas() (erc8004.ts) requires a nonzero ETH balance, and
// Phase 4b's own "Done when" guarantees a clone starts at exactly zero
// balance — an automatic call here would always fail with
// insufficient_gas before the operator has had any chance to fund the
// clone. Registration stays this same opt-in step for a clone as it
// already is for every other agent. (This phase's own header line says
// "Touches: erc8004Trust.ts" — that's a plan-text mismatch found while
// implementing it, not a real touch point: erc8004Trust.ts is the
// Reputation/Validation "trust signal" registries, not identity
// registration, and nothing in this route or erc8004.ts imports from
// it.)
//
// Idempotent by default — an agent already registered gets back its
// existing agentId instead of minting a second one. Pass force: true
// only if you specifically want a second on-chain identity for the
// same wallet (rare, and NOT the same as updating the agent card —
// there's no updateAgentURI route here yet; add one if you need it).
router.post("/:address/erc8004/register", async (req, res) => {
  const address = req.params.address;
  const { agentURI, force } = req.body as { agentURI?: string; force?: boolean };

  const row = db
    .prepare(
      `SELECT encrypted_key, erc8004_agent_id FROM agents WHERE address = ?`,
    )
    .get(address) as { encrypted_key: string | null; erc8004_agent_id: string | null } | undefined;
  if (!row) return res.status(404).json({ error: "unknown agent address" });

  // next-phase.md Phase 1 (architecture-agent.md §8): every route that
  // touches the wallet goes through checkCapability(), logged in the
  // one audit trail. NOTE — this is a no-op today, not a real access
  // check: this whole router has no notion of "caller" distinct from
  // the :address in the URL (see index.ts — the only auth is a single
  // shared x-backend-key on the whole backend, and agent/src/backend/
  // client.ts only ever calls /wallet/{its own address}/..., never
  // someone else's). caller === resourceId always here, so this always
  // allows and exists purely so the action lands in capability_audit.
  // Giving wallet routes a real, distinct caller (so agent A literally
  // cannot ask the backend to touch agent B's wallet even if it tried)
  // is a separate, larger auth change than Phase 1 is scoped to make.
  //
  // Deliberately placed AFTER the `!row` check above, not before it:
  // checkCapability() would also 404 on a nonexistent wallet (same
  // status code, via ownerOf()'s notFound flag), but with different
  // message text ("wallet not found: {address}" vs this route's
  // existing "unknown agent address") — putting the existing check
  // first keeps that message byte-for-byte unchanged, which "zero
  // behavior change" requires even though the status code alone
  // would've been identical either way.
  //
  // Wrapped in try/catch specifically because checkCapability() throws
  // synchronously (matching requireOwnedSandbox()'s existing contract)
  // and this route wasn't already inside a try/catch — an uncaught
  // throw here would be an unhandled rejection under Express 4 rather
  // than a clean error response, which Phase 1's "zero behavior change"
  // promise can't tolerate introducing.
  try {
    checkCapability({ caller: address, resourceType: "wallet", resourceId: address, action: "manage" });
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }

  if (!row.encrypted_key) {
    return res.status(403).json({
      error:
        "self_custody_wallet: backend does not hold this agent's key, agent must sign its own ERC-8004 registration directly against the Identity Registry",
    });
  }
  if (row.erc8004_agent_id && !force) {
    return res.json({
      address,
      agentId: row.erc8004_agent_id,
      alreadyRegistered: true,
    });
  }

  const uri = agentURI || `${config.publicBaseUrl}/agents/${address}/card.json`;
  const account = getAgentAccount(address);

  try {
    const result = await registerOnChain(account, uri);
    db.prepare(
      `UPDATE agents
       SET erc8004_agent_id = ?, erc8004_chain = ?, erc8004_registry_address = ?,
           erc8004_tx_hash = ?, erc8004_registered_at = ?
       WHERE address = ?`,
    ).run(result.agentId, result.chain, result.registryAddress, result.txHash, Date.now(), address);

    res.json({ address, agentURI: uri, alreadyRegistered: false, ...result });
  } catch (err: any) {
    res.status(502).json({ error: `erc8004_register_failed: ${err.message}` });
  }
});

// next-phase.md Phase 2f-iv (architecture-agent.md §4c, Budget):
// "budget-within-allocation enforcement." Same rolling-24h-window-over-
// a-log-table shape inferenceGateway.ts's checkInferenceBudget() already
// established (SUM(...) WHERE ... created_at >= now - 24h), applied here
// against department_spend_log (db.ts, Phase 2f-iv) instead of
// usage_log, and against a department's own spend_cap_daily_usdc
// (Phase 2d) instead of config.maxInferenceSpendUsdcPerAgentPerDay.
//
// Deliberately does two checks, not one, matching next-phase.md's own
// text ("a distinct check, not just spend less than X — the source of
// funds must resolve to this department's own allocation"):
//   1. getOwnedDepartment(departmentId, ownerAddress) — the department
//      must actually exist AND belong to the agent signing this payment.
//      This is what makes "cannot draw from ... another department's
//      allocation" true: there is no query here that could resolve to a
//      SECOND department's row no matter what departmentId a caller
//      passes, the exact same "structurally can't name a second
//      department" shape Phase 2f-iii's own routes already rely on
//      (getOwnedDepartment is the same function, imported from
//      departments.ts, not a second copy of the lookup here).
//   2. (Phase 2g) the rolling-24h SUM against THAT department's own
//      row's spend_cap_daily_usdc — checked via checkCapability()'s new
//      `budget` dimension (architecture-agent.md §4g) rather than this
//      function's own bespoke `if (spend.total + amount > cap)` compare.
//      This is the first real caller of Phase 2g's budget field: the
//      SUM-over-department_spend_log query itself is unchanged (it's
//      still the source of `spent`), but the allow/deny decision and the
//      audit-log write both now flow through checkCapability() the same
//      one place every other resource-touching decision in this backend
//      already goes through, instead of returning its own ad hoc
//      { ok, status, error } shape that never touched capability_audit
//      at all. Never against any agent-level or Founder-level number,
//      because there isn't one: this backend has no concept of a
//      Founder-level wallet.pay cap today (only the per-department one
//      Phase 2d added), so a call that omits departmentId entirely still
//      isn't checked against anything here — that gap is the same "no
//      distinct authenticated caller beyond x-backend-key" limitation
//      every prior phase has flagged, not something this phase's stated
//      scope (department budgets) closes. An agent-runtime Department
//      Agent is expected to always pass its own departmentId when paying
//      on the department's behalf, same cooperative-caller assumption
//      Phase 2f-i through 2f-iii's tool-profile enforcement already
//      makes explicit throughout.
const DAY_MS = 24 * 3_600_000;

function checkDepartmentBudget(
  departmentId: string,
  ownerAddress: string,
  amountUsdc: number,
): { ok: true; departmentName: string } | { ok: false; status: number; error: string } {
  let dept;
  try {
    dept = getOwnedDepartment(departmentId, ownerAddress);
  } catch (err: any) {
    return { ok: false, status: err.status || 404, error: err.message };
  }

  const since = Date.now() - DAY_MS;
  const spend = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total
       FROM department_spend_log
       WHERE department_id = ? AND created_at >= ?`,
    )
    .get(dept.id, since) as { total: number };

  // Phase 2g: `spent` includes this payment already (spend.total +
  // amountUsdc), matching checkBudgetAndEnvironment()'s `spent > limit`
  // comparison — the caller is asking "would spending this much more
  // put me over," not "am I already over," so the amount-to-spend has
  // to be folded into `spent` before it's handed to the generic check.
  try {
    checkCapability({
      caller: ownerAddress,
      resourceType: "department_budget",
      resourceId: dept.id,
      action: "pay",
      budget: { limit: dept.spend_cap_daily_usdc, spent: spend.total + amountUsdc, unit: "usd" },
    });
  } catch (err: any) {
    if (err.status === 429) {
      return {
        ok: false,
        status: 429,
        error:
          `department_daily_budget_exceeded: department "${dept.name}" has spent $${spend.total.toFixed(4)} of its ` +
          `$${dept.spend_cap_daily_usdc} daily cap in the last 24h — this $${amountUsdc} payment would exceed it`,
      };
    }
    // Any other checkCapability denial (e.g. ownership no longer holds
    // between the getOwnedDepartment() call above and here) surfaces
    // with its own message/status rather than being swallowed.
    return { ok: false, status: err.status || 403, error: err.message };
  }
  return { ok: true, departmentName: dept.name };
}

// next-phase.md Phase 2h: `projectId`, when given, tags this spend as
// belonging to one of this department's own project rows (department_
// projects, Phase 2f-iii) — the attribution retire_project()'s step 6
// needs to know how much of a project's own reservation has actually
// been drawn down. Optional and additive: a payment that omits it is
// logged exactly as it always was (department-level spend, not tied to
// any one project), unchanged from pre-2h behavior. When given, also
// bumps that project's own running budget_spent_usdc total — kept as a
// live running total on the department_projects row (not re-derived by
// SUMming department_spend_log on every read) purely so retire_project()
// and GET .../projects can read a project's spend without a join, same
// "denormalize the derived total for cheap reads" reasoning
// department_tasks already applies to its own project_id column.
// Silently a no-op if projectId doesn't resolve to a real row under this
// department — a payment already succeeded by the time this runs, and a
// bad/omitted project attribution on an otherwise-valid payment is a
// bookkeeping gap, not a reason to fail a payment that's already signed.
function logDepartmentSpend(
  departmentId: string,
  ownerAddress: string,
  toAddress: string,
  amountUsdc: number,
  purpose: string | null,
  projectId?: string | null,
): void {
  db.prepare(
    `INSERT INTO department_spend_log (department_id, owner_address, to_address, amount_usdc, purpose, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(departmentId, ownerAddress, toAddress, amountUsdc, purpose ?? null, projectId ?? null, Date.now());

  if (projectId) {
    db.prepare(
      `UPDATE department_projects SET budget_spent_usdc = budget_spent_usdc + ?
       WHERE department_id = ? AND project_id = ?`,
    ).run(amountUsdc, departmentId, projectId);
  }
}

/**
 * next-phase.md Phase 6b (architecture-agent.md §7, closing 6a's own
 * finding #1): "does this payment need a `payment`-scoped channel
 * before it's allowed to sign." See channelService.ts's own
 * paymentChannelRequired() doc comment for the full three-way decision
 * (non-agent recipient / Day-1 clone funding / real agent-to-agent
 * transfer) — kept there, not duplicated here, because facilitator.ts's
 * `/settle` route (this phase's revision) now needs the identical
 * decision as its own authoritative gate, and a security decision this
 * important must live in exactly one place.
 *
 * This route's own check is a fast-fail convenience, not the sole gate:
 * it saves a wasted signTypedData() call and gives the caller an
 * immediate NO_CHANNEL instead of one after a round-trip through
 * /facilitator/settle, but it is NOT what actually stops an ungated
 * transfer — this route only ever signs, it never moves funds (see this
 * route's own top-of-function comment). The real enforcement, reachable
 * by every path that can move money (including a self-custody agent
 * calling /facilitator/settle directly, closing 6a's finding #2), lives
 * in facilitator.ts's own `/settle` route — see that file's Phase 6b
 * note for why moving the authoritative check there was necessary
 * rather than optional.
 */

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * POST /wallet/:address/pay  { to, amountUsdc, validitySeconds?, departmentId?, purpose? }
 *
 * Signs a gasless EIP-3009 USDC authorization FROM this agent TO the
 * given address. Only works for wallets the backend custodies (created
 * via /wallet/create) — self-custody agents (/wallet/register) must
 * sign their own authorizations, since the backend never has their key.
 *
 * Returns a payload ready to attach as `xPayment` on any x402-gated
 * request, or to submit directly to /facilitator/settle for a direct
 * transfer (e.g. funding a clone).
 *
 * `departmentId` (next-phase.md Phase 2f-iv, optional): when a payment
 * is being made on a Department Agent's behalf, pass its department id
 * here so the payment is checked against — and logged against — that
 * department's own spend_cap_daily_usdc (Phase 2d) rather than going
 * through unchecked. Omitted for an ordinary top-level-agent payment.
 * See checkDepartmentBudget()'s own doc comment above for exactly what
 * is and isn't enforced.
 *
 * `projectId` (next-phase.md Phase 2h, optional, only meaningful
 * alongside departmentId): attributes this spend to one of that
 * department's own project rows, so retire_project()'s step 6 can later
 * credit back whatever fraction of that project's own budget_reserved_
 * usdc went unspent. Omitted for a department-level payment not tied to
 * any one project — unchanged from pre-2h behavior.
 */
export interface SignPaymentAuthorizationOptions {
  validitySeconds?: number;
  departmentId?: string;
  purpose?: string;
  projectId?: string;
}

export interface SignedPaymentAuthorization {
  x402Version: 1;
  scheme: "exact";
  network: string;
  payload: {
    signature: `0x${string}`;
    authorization: {
      from: Address;
      to: Address;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: `0x${string}`;
    };
  };
}

/**
 * Zent.md Phase 16b: the `/:address/pay` route's own signing logic,
 * extracted to an exported function so an in-process caller (this
 * phase's genesis.ts, funding Agent B) can get a signed authorization
 * without a self-HTTP-call — same "extracted from its own route for
 * exactly this kind of in-process caller" move facilitator.ts's
 * settleAuthorization() already made ahead of this phase (see that
 * file's own comment). Every check the route performed still runs
 * here, in the same order, with the same error shape (`.status` +
 * `.message` on a thrown Error) the route already translates to a
 * `res.status(...).json({ error: ... })` — only the HTTP-specific bits
 * (parsing req.body, calling res.json) moved out to the route itself,
 * immediately below. Not a behavior change for the existing route.
 */
export async function signPaymentAuthorization(
  from: Address,
  to: string,
  amountUsdc: number,
  opts: SignPaymentAuthorizationOptions = {},
): Promise<SignedPaymentAuthorization> {
  const { validitySeconds = 300, departmentId, purpose, projectId } = opts;

  if (!to) {
    throw Object.assign(new Error("to and amountUsdc required"), { status: 400 });
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw Object.assign(new Error(`to must be a valid 0x-prefixed address, got: ${to}`), { status: 400 });
  }
  const toAddress = to as Address;
  if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
    throw Object.assign(new Error("amountUsdc must be a positive number"), { status: 400 });
  }

  const row = db
    .prepare(`SELECT encrypted_key, frozen, frozen_reason FROM agents WHERE address = ?`)
    .get(from) as
    | { encrypted_key: string | null; frozen: number; frozen_reason: string | null }
    | undefined;
  if (!row) throw Object.assign(new Error("unknown agent address"), { status: 404 });

  // Zent.md Phase 19d: the funds-lock enforcement point. Every outgoing
  // payment this backend ever signs — clone-funding, x402, marketplace
  // purchases, all of it — passes through this one function, so this is
  // the single chokepoint expansionKillSwitch.ts's freezeAgentFunds()
  // relies on rather than re-checking `frozen` at each of those call
  // sites individually. Checked before departmentBudget/capability so a
  // frozen agent fails the same "closed before doing real work" way
  // those checks already do. Does not block this agent from RECEIVING a
  // payment (that flow never calls this function for `from`) — a frozen
  // company can still be paid, it just cannot spend.
  if (row.frozen) {
    throw Object.assign(
      new Error(`agent ${from} is frozen (${row.frozen_reason ?? "no reason recorded"}) — cannot sign a payment`),
      { status: 423 }, // 423 Locked
    );
  }

  // next-phase.md Phase 2f-iv: only checked when the caller attributes
  // this payment to a department — see checkDepartmentBudget's own doc
  // comment above for why an omitted departmentId isn't checked against
  // anything here today.
  if (departmentId) {
    const budget = checkDepartmentBudget(departmentId, from, amountUsdc);
    if (!budget.ok) {
      throw Object.assign(new Error(budget.error), { status: budget.status });
    }
  }

  // Same note as erc8004/register above: no-op today (caller === resourceId
  // always, since this router has no separate caller concept yet), added
  // so every wallet-signing action is in the one audit trail per §8.
  // Placed after the `!row` check for the same reason as erc8004/register:
  // keeps the existing "unknown agent address" message text unchanged for
  // that case rather than checkCapability's differently-worded 404.
  try {
    checkCapability({ caller: from, resourceType: "wallet", resourceId: from, action: "pay" });
  } catch (err: any) {
    throw Object.assign(new Error(err.message), { status: err.status || 403 });
  }

  // next-phase.md Phase 6b: closes 6a's finding #1 — an active
  // `payment`-scoped channel (Phase 3) is required before this function
  // will sign a transfer to another agent. See paymentChannelRequired()'s
  // own doc comment above for the non-agent-recipient and Day-1
  // clone-funding carve-outs — the latter is exactly the case Phase
  // 16b's caller hits (Agent B's parent_address is `from`, and Agent B
  // has never received a payment yet), so genesis funding signs here
  // without needing a channel first. Placed before any signing work
  // below (and before the self-custody check, which is a distinct "can
  // this function sign at all" question) so a call missing a channel
  // never reaches account.signTypedData() — same "fail closed before
  // doing the real work" ordering send_file's own
  // requireFileTransferChannel() uses.
  if (paymentChannelRequired(from, to)) {
    try {
      requirePaymentChannel(from, to);
    } catch (err: any) {
      throw Object.assign(new Error(err.message), { status: err.status || 403 });
    }
  }

  if (!row.encrypted_key) {
    throw Object.assign(
      new Error("self_custody_wallet: backend does not hold this agent's key, agent must sign its own payment"),
      { status: 403 },
    );
  }

  const account = getAgentAccount(from);
  const usdcAddress = USDC[config.chainNetwork];
  const now = Math.floor(Date.now() / 1000);
  const validAfter = 0;
  const validBefore = now + validitySeconds;
  const nonce = `0x${crypto.randomBytes(32).toString("hex")}` as `0x${string}`;
  const value = parseUnits(String(amountUsdc), 6);

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: CHAIN.id,
    verifyingContract: usdcAddress,
  } as const;

  const signature = await account.signTypedData({
    domain,
    types: TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from,
      to: to as Address,
      value,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  // Logged AFTER signing succeeds, not before checkDepartmentBudget()
  // above — a department's spend commitment is real the moment a valid
  // signature exists (see db.ts's migration comment on
  // department_spend_log for why that's the chosen moment), so a call
  // that throws before reaching this point (bad department, over
  // budget, signing error) must never have logged anything against its
  // cap.
  if (departmentId) {
    logDepartmentSpend(departmentId, from, to, amountUsdc, purpose ?? null, projectId ?? null);
  }

  return {
    x402Version: 1,
    scheme: "exact",
    network: config.chainNetwork,
    payload: {
      signature,
      authorization: {
        from,
        to: toAddress,
        value: value.toString(),
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      },
    },
  };
}

router.post("/:address/pay", async (req, res) => {
  const from = req.params.address as Address;
  const { to, amountUsdc, validitySeconds, departmentId, purpose, projectId } = req.body as {
    to?: string;
    amountUsdc?: string | number;
    validitySeconds?: number;
    departmentId?: string;
    purpose?: string;
    projectId?: string;
  };
  if (!to || amountUsdc === undefined) {
    return res.status(400).json({ error: "to and amountUsdc required" });
  }
  const amountNum = Number(amountUsdc);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: "amountUsdc must be a positive number" });
  }

  try {
    const result = await signPaymentAuthorization(from, to, amountNum, {
      validitySeconds,
      departmentId,
      purpose,
      projectId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

export default router;
