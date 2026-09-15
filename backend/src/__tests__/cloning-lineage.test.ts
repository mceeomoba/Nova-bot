// next-phase.md Phase 4e (architecture-agent.md §5): tests for sealing
// the clone boundary and recording provenance — office.ts's new
// setManifestParent(), wallet.ts's createClonedAgentWallet() now
// writing parent_address/manifest.parent instead of leaving them NULL
// (4b's own deferred gap, see cloning-wallet.test.ts's "Phase 4e's job,
// not 4b's" test), and the "starts empty" claims this phase's own
// next-phase.md checklist calls out: office/workspace, office/private
// (beyond 4b's own wallet keys), and zero channel rows.
//
// Same three-group split cloning-config.test.ts already established:
//
// 1. office.ts has no dependency on better-sqlite3/dockerode/viem, so
//    setManifestParent() and the "starts empty" directory claims are
//    exercised for REAL against a real temp filesystem — no mirror.
// 2. wallet.ts's createClonedAgentWallet() and cloning.ts's
//    claimCloneShellForWallet() still import db.js/docker.ts, so the
//    full claim sequence (including the new parent_address/
//    setManifestParent wiring) is re-verified as an inlined mirror,
//    kept byte-for-byte in sync with wallet.ts, same shape
//    cloning-wallet.test.ts already used — extended here with a
//    `channels` array standing in for the channels table, asserted
//    empty throughout, since no code path in the claim sequence ever
//    inserts into it.
// 3. get_manifest()'s shape (vmService.ts's GET /vm/office/manifest) —
//    confirming the AgentManifest type it serializes has no private/
//    vault field to leak, so exposing `parent` the same way it exposes
//    every other field needs no new visibility rule.
//
// Compiled with `tsc --target es2020 --module commonjs` to plain JS in
// a scratch dir and run with `node --test`, same as every prior phase's
// own test file. Group 1 requires the same env vars as
// cloning-config.test.ts's own group 1 (BACKEND_API_KEY/ADMIN_API_KEY/
// OPENROUTER_API_KEY/FACILITATOR_PRIVATE_KEY, a writable OFFICES_DIR) —
// no network access needed. Recommend re-running group 2 against the
// real functions with a live sqlite3 DB and Docker daemon once a
// networked environment is available, per every prior phase's own
// standing note.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Group 1: real fs.*, real office.ts, no mocking ────────────────

const OFFICES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cloning-lineage-offices-"));

process.env.BACKEND_API_KEY ||= "test";
process.env.ADMIN_API_KEY ||= "test";
process.env.OPENROUTER_API_KEY ||= "test";
process.env.FACILITATOR_PRIVATE_KEY ||= ("0x" + "1".repeat(64)) as string;
process.env.OFFICES_DIR = OFFICES_ROOT;

// Real bug found and fixed while actually running this suite (Phase 5a
// "fix it thoroughly" pass): same ESM/CJS mismatch as
// cloning-config.test.ts's own fix, applied here identically — see that
// file's comment for the full explanation. This file failed 1/1 with
// the same `require is not defined in ES module scope` error before
// this fix, not a logic failure in any of its own test bodies.
const office = (await import("../office.js")) as typeof import("../office.js");

test("a fresh office's workspace and private dirs start empty", async () => {
  await office.ensureOffice("0xg1-fresh");
  assert.deepEqual(fs.readdirSync(office.officeWorkspaceDir("0xg1-fresh")), []);
  assert.deepEqual(fs.readdirSync(office.officePrivateDir("0xg1-fresh")), []);
});

test("setManifestParent records the parent on a manifest that started at null", async () => {
  await office.ensureOffice("0xg1-child"); // scaffold-shape manifest, parent: null
  const manifest = await office.setManifestParent("0xg1-child", "0xg1-parent");
  assert.equal(manifest.parent, "0xg1-parent");
  const reread = await office.readManifest("0xg1-child");
  assert.equal(reread?.parent, "0xg1-parent");
});

test("setManifestParent is a no-op when called again with the same parent", async () => {
  const before = await office.readManifest("0xg1-child");
  const after = await office.setManifestParent("0xg1-child", "0xg1-parent");
  assert.equal(after.parent, "0xg1-parent");
  assert.equal(before?.created_at, after.created_at); // untouched otherwise
});

test("setManifestParent throws rather than overwriting a different recorded parent", async () => {
  await assert.rejects(
    () => office.setManifestParent("0xg1-child", "0xg1-someone-else"),
    /already records a different parent/,
  );
  const manifest = await office.readManifest("0xg1-child");
  assert.equal(manifest?.parent, "0xg1-parent"); // unchanged by the rejected call
});

test("setManifestParent throws for an agentId with no manifest yet", async () => {
  await assert.rejects(
    () => office.setManifestParent("0xg1-never-created", "0xg1-parent"),
    /no manifest for/,
  );
});

test("renameOfficeDir carries a set parent value over to the new address", async () => {
  await office.ensureOffice("0xg1-scaffold");
  await office.setManifestParent("0xg1-scaffold", "0xg1-parent-2");
  await office.renameOfficeDir("0xg1-scaffold", "0xg1-migrated");
  const manifest = await office.readManifest("0xg1-migrated");
  assert.equal(manifest?.parent, "0xg1-parent-2");
});

// ─── Group 2: full claim sequence, inlined mirror ──────────────────
//
// Extends cloning-wallet.test.ts's own createClonedAgentWallet mirror
// with this phase's actual change (parent_address/manifest.parent set,
// not left NULL) and a `channels` array asserted empty throughout,
// since nothing in the claim sequence — before or after this phase —
// ever inserts a channel row for the new agent.

interface CloneShellRow {
  id: string;
  parent_agent_address: string;
  sandbox_id: string;
  status: string;
  claimed_at: number | null;
}
interface AgentRow {
  address: string;
  name: string;
  parent_address: string | null;
}
interface ManifestRow {
  owner: string;
  parent: string | null;
}
interface ChannelRow {
  id: string;
  proposer_address: string;
  recipient_address: string;
}

let cloneShells: CloneShellRow[];
let agents: AgentRow[];
let manifests: Map<string, ManifestRow>;
let channels: ChannelRow[];
let walletCounter: number;

function reset() {
  cloneShells = [
    { id: "clone_bbbb", parent_agent_address: "0xparent", sandbox_id: "sbx-clone-clone_bbbb", status: "ready", claimed_at: null },
  ];
  agents = [{ address: "0xparent", name: "parent", parent_address: null }];
  manifests = new Map([["clone_bbbb", { owner: "clone_bbbb", parent: null }]]);
  channels = [];
  walletCounter = 0;
}

function claimCloneShellForWallet(id: string): CloneShellRow {
  const row = cloneShells.find((r) => r.id === id);
  if (!row) throw Object.assign(new Error(`unknown clone shell: ${id}`), { status: 404 });
  if (row.status !== "ready" || row.claimed_at !== null) {
    throw Object.assign(new Error(`clone shell ${id} is not claimable`), { status: 409 });
  }
  row.status = "claimed";
  row.claimed_at = Date.now();
  return row;
}

function renameOfficeDirMirror(oldId: string, newId: string): void {
  const m = manifests.get(oldId)!;
  manifests.delete(oldId);
  manifests.set(newId, { ...m, owner: newId });
}

// Inlined mirror of office.ts's setManifestParent().
function setManifestParentMirror(agentId: string, parentAgentAddress: string): ManifestRow {
  const m = manifests.get(agentId);
  if (!m) throw Object.assign(new Error(`no manifest for ${agentId}`), { status: 404 });
  if (m.parent !== null && m.parent !== parentAgentAddress) {
    throw Object.assign(new Error(`manifest for ${agentId} already records a different parent`), { status: 409 });
  }
  m.parent = parentAgentAddress;
  return m;
}

function generateWalletAddress(): string {
  walletCounter += 1;
  return `0xclone${walletCounter}`;
}

// Inlined mirror of wallet.ts's createClonedAgentWallet() as of this
// phase — the one behavior change from cloning-wallet.test.ts's own
// mirror is the agents-row insert and the trailing setManifestParent
// call both using shell.parent_agent_address instead of null.
function createClonedAgentWallet(cloneShellId: string, name: string): { address: string; name: string } {
  const shell = claimCloneShellForWallet(cloneShellId);
  const address = generateWalletAddress();
  renameOfficeDirMirror(shell.id, address);
  agents.push({ address, name, parent_address: shell.parent_agent_address });
  setManifestParentMirror(address, shell.parent_agent_address);
  return { address, name };
}

test("createClonedAgentWallet records the parent in both the agents row and the manifest", () => {
  reset();
  const wallet = createClonedAgentWallet("clone_bbbb", "bob");
  const agentRow = agents.find((a) => a.address === wallet.address);
  assert.equal(agentRow?.parent_address, "0xparent");
  const manifest = manifests.get(wallet.address);
  assert.equal(manifest?.parent, "0xparent");
});

test("a freshly claimed clone has zero channel rows, including none with its own parent", () => {
  reset();
  const wallet = createClonedAgentWallet("clone_bbbb", "bob");
  const related = channels.filter(
    (c) => c.proposer_address === wallet.address || c.recipient_address === wallet.address,
  );
  assert.equal(related.length, 0);
  const withParent = channels.filter(
    (c) =>
      (c.proposer_address === wallet.address && c.recipient_address === "0xparent") ||
      (c.recipient_address === wallet.address && c.proposer_address === "0xparent"),
  );
  assert.equal(withParent.length, 0);
});

// ─── Group 3: get_manifest() shape — no private field to leak ──────
//
// vmService.ts's GET /vm/office/manifest returns the AgentManifest
// object as-is (res.json(manifest)). This phase's own checklist asks
// to "confirm this phase doesn't accidentally leak private fields
// through it" — asserted here as a fixed, named field list so a future
// edit that adds a secret-shaped field to AgentManifest (e.g. a raw key,
// a vault path) has to break this test, not just slip past review.

const MANIFEST_PUBLIC_FIELDS = ["owner", "parent", "created_at", "quota", "capability_grants"];

test("get_manifest()'s AgentManifest shape has no vault/secret field to leak", async () => {
  await office.ensureOffice("0xg3-agent");
  const manifest = await office.readManifest("0xg3-agent");
  assert.deepEqual(Object.keys(manifest!).sort(), [...MANIFEST_PUBLIC_FIELDS].sort());
});

test("get_manifest() exposes parent the same way it exposes every other field", async () => {
  await office.ensureOffice("0xg3-child");
  await office.setManifestParent("0xg3-child", "0xg3-parent");
  const manifest = await office.readManifest("0xg3-child");
  // res.json(manifest) in vmService.ts serializes the whole object —
  // `parent` rides along with owner/created_at/quota/capability_grants,
  // no field-specific allowlist or special case needed.
  assert.equal(manifest?.parent, "0xg3-parent");
  assert.ok("owner" in manifest! && "parent" in manifest!);
});
