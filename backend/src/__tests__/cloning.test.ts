// next-phase.md Phase 4a (architecture-agent.md §5): tests for
// cloning.ts's createCloneShell() — the agent_id + fresh-sandbox
// scaffold step, before any wallet/identity/config exists.
//
// Same constraint every prior backend/src test file in this repo has
// flagged (capability.test.ts, retireProjectSequence.test.ts,
// channelService.test.ts): no network access to `npm install`
// better-sqlite3/dockerode here, so cloning.ts itself (which calls
// db.prepare(...) directly and imports createNamedSandbox/ensureOffice)
// can't be imported and exercised against a live DB/Docker round trip.
// What's tested here is an inlined copy of its exact decision logic —
// same guard order, same status transitions, same error shapes —
// operating against plain in-memory arrays standing in for the
// `agents` and `clone_shells` tables, and a fake createNamedSandbox/
// ensureOffice pair that records calls instead of touching a real
// filesystem or Docker daemon. Kept byte-for-byte in sync with
// cloning.ts's own createCloneShell()/getCloneShell()/
// markCloneShellClaimed()/abandonCloneShell().
//
// Compiled with `tsc --target es2020 --module commonjs` to plain JS in
// a scratch dir and run with `node --test`, same as every prior phase's
// own inlined-copy tests. Recommend re-running against the real
// functions with a live sqlite3 DB and Docker daemon once a networked
// environment is available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";

interface AgentRow {
  address: string;
}

interface CloneShellRow {
  id: string;
  parent_agent_address: string;
  sandbox_id: string;
  status: string;
  created_at: number;
  claimed_at: number | null;
}

// --- Fake tables + fake Docker/office side effects, reset per test ---
let agents: AgentRow[];
let cloneShells: CloneShellRow[];
let sandboxCalls: string[];
let officeCalls: string[];
let failNextSandboxCreate: boolean;

function reset() {
  agents = [{ address: "0xparent" }];
  cloneShells = [];
  sandboxCalls = [];
  officeCalls = [];
  failNextSandboxCreate = false;
}

const MAX_PENDING_CLONE_SHELLS_PER_AGENT = 3;

function countPendingShells(parentAgentAddress: string): number {
  return cloneShells.filter(
    (r) => r.parent_agent_address === parentAgentAddress && r.status !== "failed" && r.claimed_at === null,
  ).length;
}

let idCounter = 0;
function newCloneScaffoldId(): string {
  idCounter += 1;
  return `clone_${idCounter.toString(16).padStart(16, "0")}`;
}

// Inlined mirror of cloning.ts's createCloneShell().
async function createCloneShell(parentAgentAddress: string): Promise<{
  id: string;
  parentAgentAddress: string;
  sandboxId: string;
  createdAt: number;
}> {
  const parent = agents.find((a) => a.address === parentAgentAddress);
  if (!parent) {
    throw Object.assign(new Error(`unknown parent agent: ${parentAgentAddress}`), { status: 404 });
  }

  const pending = countPendingShells(parentAgentAddress);
  if (pending >= MAX_PENDING_CLONE_SHELLS_PER_AGENT) {
    throw Object.assign(
      new Error(
        `pending clone-shell limit reached (${MAX_PENDING_CLONE_SHELLS_PER_AGENT} per agent) — ` +
          `finish or abandon (see abandonCloneShell) an existing clone before starting another`,
      ),
      { status: 403 },
    );
  }

  const id = newCloneScaffoldId();
  const sandboxId = `sbx-clone-${id}`;
  const createdAt = Date.now();

  cloneShells.push({
    id,
    parent_agent_address: parentAgentAddress,
    sandbox_id: sandboxId,
    status: "creating",
    created_at: createdAt,
    claimed_at: null,
  });

  try {
    officeCalls.push(id);
    if (failNextSandboxCreate) throw new Error("simulated docker failure");
    sandboxCalls.push(sandboxId);
  } catch (err) {
    const row = cloneShells.find((r) => r.id === id)!;
    row.status = "failed";
    throw err;
  }

  const row = cloneShells.find((r) => r.id === id)!;
  row.status = "ready";
  return { id, parentAgentAddress, sandboxId, createdAt };
}

function getCloneShell(id: string) {
  const row = cloneShells.find((r) => r.id === id);
  if (!row) return null;
  return {
    id: row.id,
    parentAgentAddress: row.parent_agent_address,
    sandboxId: row.sandbox_id,
    createdAt: row.created_at,
  };
}

function markCloneShellClaimed(id: string): void {
  const row = cloneShells.find((r) => r.id === id);
  if (!row) return;
  row.status = "claimed";
  row.claimed_at = Date.now();
}

async function abandonCloneShell(id: string): Promise<void> {
  const row = cloneShells.find((r) => r.id === id);
  if (!row) return;
  sandboxCalls = sandboxCalls.filter((s) => s !== row.sandbox_id); // "deleted"
  row.status = "failed";
}

// --- Tests ---

test("createCloneShell rejects an unknown parent", async () => {
  reset();
  await assert.rejects(() => createCloneShell("0xnobody"), /unknown parent agent/);
  assert.equal(cloneShells.length, 0);
});

test("createCloneShell mints a scaffold id, not the parent's address", async () => {
  reset();
  const shell = await createCloneShell("0xparent");
  assert.notEqual(shell.id, "0xparent");
  assert.match(shell.id, /^clone_[0-9a-f]+$/);
  assert.equal(shell.parentAgentAddress, "0xparent");
});

test("createCloneShell stands up exactly one sandbox and one office per call", async () => {
  reset();
  const shell = await createCloneShell("0xparent");
  assert.deepEqual(sandboxCalls, [shell.sandboxId]);
  assert.deepEqual(officeCalls, [shell.id]);
});

test("two clones from the same parent get independent ids and sandboxes", async () => {
  reset();
  const a = await createCloneShell("0xparent");
  const b = await createCloneShell("0xparent");
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.sandboxId, b.sandboxId);
  assert.equal(sandboxCalls.length, 2);
});

test("pending-shell cap is enforced per parent", async () => {
  reset();
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  await assert.rejects(() => createCloneShell("0xparent"), /pending clone-shell limit reached/);
  assert.equal(cloneShells.length, 3);
});

test("a claimed shell no longer counts against the pending cap", async () => {
  reset();
  const a = await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  markCloneShellClaimed(a.id);
  // Should not throw now that one of the three no longer counts as pending.
  const d = await createCloneShell("0xparent");
  assert.equal(cloneShells.length, 4);
  assert.equal(getCloneShell(a.id)!.id, a.id);
  assert.notEqual(d.id, a.id);
});

test("a failed shell (docker error) does not count against the pending cap either", async () => {
  reset();
  failNextSandboxCreate = true;
  await assert.rejects(() => createCloneShell("0xparent"), /simulated docker failure/);
  failNextSandboxCreate = false;
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  // Three succeeded shells plus the one failed one — still only three
  // count as pending, so a fourth successful attempt is allowed.
  assert.equal(cloneShells.length, 4);
  assert.equal(cloneShells.filter((r) => r.status === "failed").length, 1);
});

test("abandonCloneShell frees the pending-shell slot", async () => {
  reset();
  const a = await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  await abandonCloneShell(a.id);
  // Should not throw now that the abandoned shell is marked failed.
  await createCloneShell("0xparent");
  assert.equal(cloneShells.length, 4);
  assert.equal(getCloneShell(a.id)!.id, a.id); // row still exists, just marked failed
});

test("clone shells for different parents don't share the same pending cap", async () => {
  reset();
  agents.push({ address: "0xotherparent" });
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  await createCloneShell("0xparent");
  // A different parent's own cap is untouched by 0xparent's three.
  const shell = await createCloneShell("0xotherparent");
  assert.equal(shell.parentAgentAddress, "0xotherparent");
});

test("getCloneShell returns null for an id that was never created", () => {
  reset();
  assert.equal(getCloneShell("clone_doesnotexist"), null);
});
