// next-phase.md Phase 4d (architecture-agent.md §5 COW table): tests
// for the copy-on-write — office.ts's office/config/ tree (skills/,
// system-prompt.md, constitution.md), cloning.ts's copyCloneConfig(),
// and the opt-in procedural-memory copy path in proceduralMemory.ts's
// copyProceduresToAgent().
//
// Group 1 (office.ts) has no dependency on better-sqlite3/dockerode/
// viem, so it already exercised the real functions against a real
// temp filesystem and needed no changes here.
//
// Groups 2/3 previously inlined copies of copyCloneConfig()/
// copyProceduresToAgent() against a plain in-memory array, citing no
// network access for `npm install` better-sqlite3. That's no longer
// true here, so both now import the real modules directly against a
// live temp sqlite DB (same OFFICES_ROOT temp dir Group 1 already
// uses for the filesystem side). Neither function touches Docker, so
// there's no remaining gap for this file the way there is for
// cloning-abandon-guard.test.ts/cloning-wallet.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { freshDbPath, setTestEnv } from "./liveDb.js";

// ─── Group 1: real fs.*, real office.ts, no mocking ────────────────

const OFFICES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cloning-config-offices-"));
const CANONICAL_CONSTITUTION_PATH = path.join(OFFICES_ROOT, "..", "canonical-constitution.md");

setTestEnv(freshDbPath("cloning-config"));
process.env.OFFICES_DIR = OFFICES_ROOT;
process.env.DEFAULT_CONSTITUTION_PATH = CANONICAL_CONSTITUTION_PATH;

const office = (await import("../office.js")) as typeof import("../office.js");
const { db } = await import("../db.js");
const { copyCloneConfig } = await import("../cloning.js");
const { copyProceduresToAgent, listProcedures } = await import("../proceduralMemory.js");

function ensureAgent(address: string): void {
  db.prepare(`INSERT OR IGNORE INTO agents (address, name, created_at) VALUES (?, ?, ?)`).run(
    address,
    address,
    Date.now(),
  );
}

test("ensureOffice seeds office/config/{skills,system-prompt.md,constitution.md}", async () => {
  fs.writeFileSync(CANONICAL_CONSTITUTION_PATH, "# Canonical Constitution\nThree laws.\n");
  await office.ensureOffice("0xgroup1-a");
  assert.ok(fs.existsSync(office.officeConfigSkillsDir("0xgroup1-a")));
  assert.ok(fs.existsSync(office.officeConfigSystemPromptPath("0xgroup1-a")));
  assert.ok(fs.existsSync(office.officeConfigConstitutionPath("0xgroup1-a")));
  const constText = fs.readFileSync(office.officeConfigConstitutionPath("0xgroup1-a"), "utf8");
  assert.equal(constText, "# Canonical Constitution\nThree laws.\n");
});

test("ensureOffice never overwrites an already-edited config file", async () => {
  await office.ensureOffice("0xgroup1-b");
  const p = office.officeConfigSystemPromptPath("0xgroup1-b");
  fs.writeFileSync(p, "# Custom prompt\nEdited by the agent.\n");
  await office.ensureOffice("0xgroup1-b");
  assert.equal(fs.readFileSync(p, "utf8"), "# Custom prompt\nEdited by the agent.\n");
});

test("renameOfficeDir carries office/config/ along with the rest of the tree", async () => {
  await office.ensureOffice("0xgroup1-c");
  await office.renameOfficeDir("0xgroup1-c", "0xgroup1-c-renamed");
  assert.ok(fs.existsSync(office.officeConfigSystemPromptPath("0xgroup1-c-renamed")));
  assert.ok(!fs.existsSync(office.agentDir("0xgroup1-c")));
});

test("a missing canonical constitution.md falls back instead of throwing", async () => {
  fs.rmSync(CANONICAL_CONSTITUTION_PATH, { force: true });
  await office.ensureOffice("0xgroup1-d");
  const text = fs.readFileSync(office.officeConfigConstitutionPath("0xgroup1-d"), "utf8");
  assert.match(text, /default text unavailable/);
});

// ─── Group 2a: copyCloneConfig — real cloning.ts, real fs ──────────

test("copyCloneConfig copies the parent's real config over the clone's own default", async () => {
  ensureAgent("0xgroup2-parent");
  ensureAgent("0xgroup2-child");
  await office.ensureOffice("0xgroup2-parent");
  await office.ensureOffice("0xgroup2-child"); // pre-existing default, expected to be overwritten

  fs.writeFileSync(office.officeConfigSystemPromptPath("0xgroup2-parent"), "parent's own prompt\n");
  fs.mkdirSync(office.officeConfigSkillsDir("0xgroup2-parent"), { recursive: true });
  fs.writeFileSync(
    path.join(office.officeConfigSkillsDir("0xgroup2-parent"), "hello.SKILL.md"),
    "# hello skill\n",
  );

  const result = await copyCloneConfig("0xgroup2-parent", "0xgroup2-child");
  assert.equal(result.configCopied, true);
  assert.equal(
    fs.readFileSync(office.officeConfigSystemPromptPath("0xgroup2-child"), "utf8"),
    "parent's own prompt\n",
  );
  assert.ok(fs.existsSync(path.join(office.officeConfigSkillsDir("0xgroup2-child"), "hello.SKILL.md")));
});

test("clone's config is independent of the parent's later edits", async () => {
  fs.writeFileSync(office.officeConfigSystemPromptPath("0xgroup2-parent"), "parent changed this after cloning\n");
  assert.equal(
    fs.readFileSync(office.officeConfigSystemPromptPath("0xgroup2-child"), "utf8"),
    "parent's own prompt\n",
  );
});

test("copyCloneConfig never touches officeWorkspaceDir/inbox/outbox/private", async () => {
  fs.writeFileSync(path.join(office.officeWorkspaceDir("0xgroup2-parent"), "secret-plan.txt"), "do not copy me");
  fs.writeFileSync(path.join(office.officePrivateDir("0xgroup2-parent"), "vault-note.txt"), "do not copy me either");
  await copyCloneConfig("0xgroup2-parent", "0xgroup2-child");
  assert.ok(!fs.existsSync(path.join(office.officeWorkspaceDir("0xgroup2-child"), "secret-plan.txt")));
  assert.ok(!fs.existsSync(path.join(office.officePrivateDir("0xgroup2-child"), "vault-note.txt")));
});

test("copyCloneConfig returns configCopied:false rather than throwing when the parent has no office/config/", async () => {
  const bareParent = "0xgroup2-bare-parent";
  ensureAgent(bareParent);
  ensureAgent("0xgroup2-orphan-child");
  await fsp.mkdir(office.agentDir(bareParent), { recursive: true }); // office exists, but never went through ensureOffice()
  const result = await copyCloneConfig(bareParent, "0xgroup2-orphan-child");
  assert.equal(result.configCopied, false);
  assert.equal(result.proceduresCopied, 0);
});

// ─── Group 2b: copyProceduresToAgent — real proceduralMemory.ts, real DB ─

function seedProcedure(opts: {
  agentAddress: string;
  name: string;
  description: string;
  successCount: number;
  failureCount: number;
  lastUsedAt: number | null;
}): void {
  ensureAgent(opts.agentAddress);
  const now = Date.now();
  db.prepare(
    `INSERT INTO procedural_memory
       (id, agent_address, name, description, steps, success_count, failure_count, last_used_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    opts.agentAddress,
    opts.name,
    opts.description,
    JSON.stringify([{ order: 1, action: "do the thing" }]),
    opts.successCount,
    opts.failureCount,
    opts.lastUsedAt,
    now,
    now,
  );
}

test("copyProceduresToAgent copies every one of the parent's procedures under the clone's own address", () => {
  seedProcedure({
    agentAddress: "0xproc-parent-1",
    name: "deploy-to-staging",
    description: "Push the current branch to the staging environment.",
    successCount: 7,
    failureCount: 1,
    lastUsedAt: 1_700_000_000_000,
  });
  seedProcedure({
    agentAddress: "0xproc-parent-1",
    name: "rotate-api-key",
    description: "Rotate the third-party API key and update the vault.",
    successCount: 2,
    failureCount: 0,
    lastUsedAt: null,
  });
  ensureAgent("0xproc-child-1");

  const copied = copyProceduresToAgent("0xproc-parent-1", "0xproc-child-1");
  assert.equal(copied, 2);
  const childProcs = listProcedures("0xproc-child-1");
  assert.equal(childProcs.length, 2);
  const parentIds = listProcedures("0xproc-parent-1").map((p) => p.id);
  assert.ok(
    childProcs.every((p) => !parentIds.includes(p.id)),
    "clone gets fresh ids, not the parent's own rows",
  );
});

test("copyProceduresToAgent carries success/failure counts over as-is, not reset to zero", () => {
  seedProcedure({
    agentAddress: "0xproc-parent-2",
    name: "deploy-to-staging",
    description: "d",
    successCount: 7,
    failureCount: 1,
    lastUsedAt: 1_700_000_000_000,
  });
  ensureAgent("0xproc-child-2");
  copyProceduresToAgent("0xproc-parent-2", "0xproc-child-2");
  const deployProc = listProcedures("0xproc-child-2").find((p) => p.name === "deploy-to-staging")!;
  assert.equal(deployProc.successCount, 7);
  assert.equal(deployProc.failureCount, 1);
  assert.equal(deployProc.lastUsedAt, 1_700_000_000_000);
});

test("copyProceduresToAgent does not mutate or reference the parent's own rows", () => {
  seedProcedure({
    agentAddress: "0xproc-parent-3",
    name: "deploy-to-staging",
    description: "d",
    successCount: 7,
    failureCount: 1,
    lastUsedAt: null,
  });
  ensureAgent("0xproc-child-3");
  copyProceduresToAgent("0xproc-parent-3", "0xproc-child-3");
  const childId = listProcedures("0xproc-child-3").find((p) => p.name === "deploy-to-staging")!.id;
  db.prepare(`UPDATE procedural_memory SET success_count = 999 WHERE id = ?`).run(childId);
  const parentProc = listProcedures("0xproc-parent-3").find((p) => p.name === "deploy-to-staging")!;
  assert.equal(parentProc.successCount, 7, "parent's own row must be unaffected by editing the clone's copy");
});

test("copyProceduresToAgent is a no-op (zero copied) for an agent with no saved procedures", () => {
  ensureAgent("0xagent-with-nothing-saved");
  ensureAgent("0xchild-of-nobody");
  const copied = copyProceduresToAgent("0xagent-with-nothing-saved", "0xchild-of-nobody");
  assert.equal(copied, 0);
  assert.equal(listProcedures("0xchild-of-nobody").length, 0);
});

test("copyProceduresToAgent is idempotent per name (ON CONFLICT DO NOTHING), not a duplicate on re-copy", () => {
  seedProcedure({
    agentAddress: "0xproc-parent-4",
    name: "deploy-to-staging",
    description: "d",
    successCount: 7,
    failureCount: 1,
    lastUsedAt: null,
  });
  ensureAgent("0xproc-child-4");
  copyProceduresToAgent("0xproc-parent-4", "0xproc-child-4");
  const secondCopyCount = copyProceduresToAgent("0xproc-parent-4", "0xproc-child-4");
  assert.equal(secondCopyCount, 0, "re-running the copy must not duplicate rows already present under that name");
  assert.equal(listProcedures("0xproc-child-4").length, 1);
});

// ─── Group 3: the "optional/flagged, not automatic" default ───────
//
// next-phase.md Phase 4d's own checklist: "Procedural memory copy is
// optional/flagged, not automatic." copyCloneConfig()'s own default
// (opts.includeProceduralMemory left undefined) is exercised here
// directly, rather than reimplementing wallet.ts's separate
// `opts.includeProceduralMemory ?? false` line — that line funnels
// into this same default before ever reaching copyCloneConfig, so
// this covers the net behavior without needing the Docker-backed
// createClonedAgentWallet() call that line actually lives inside of.

test("copyCloneConfig defaults to NOT copying procedural memory unless explicitly requested", async () => {
  seedProcedure({
    agentAddress: "0xproc-parent-5",
    name: "deploy-to-staging",
    description: "d",
    successCount: 1,
    failureCount: 0,
    lastUsedAt: null,
  });
  ensureAgent("0xproc-child-5");
  await office.ensureOffice("0xproc-parent-5");
  await office.ensureOffice("0xproc-child-5");

  const result = await copyCloneConfig("0xproc-parent-5", "0xproc-child-5"); // no opts passed at all
  assert.equal(result.proceduresCopied, 0);
  assert.equal(listProcedures("0xproc-child-5").length, 0);
});

test("copyCloneConfig copies procedural memory when explicitly requested", async () => {
  seedProcedure({
    agentAddress: "0xproc-parent-6",
    name: "deploy-to-staging",
    description: "d",
    successCount: 1,
    failureCount: 0,
    lastUsedAt: null,
  });
  ensureAgent("0xproc-child-6");
  await office.ensureOffice("0xproc-parent-6");
  await office.ensureOffice("0xproc-child-6");

  const result = await copyCloneConfig("0xproc-parent-6", "0xproc-child-6", { includeProceduralMemory: true });
  assert.equal(result.proceduresCopied, 1);
  assert.equal(listProcedures("0xproc-child-6").length, 1);
});
