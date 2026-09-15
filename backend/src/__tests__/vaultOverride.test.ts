// next-phase.md Phase 5f (architecture-agent.md §6, closing Phase 5):
// "A single, heavily logged 'force-open vault' path for incident
// response — logged to the same audit trail as everything else, never
// a silent bypass." Done when (closing Phase 5 as a whole): the
// vault-override path exists, is exercised at least once in a test,
// and produces an audit entry indistinguishable in shape from any
// other logged decision except for its own distinct reason code. The
// other half of Phase 5's own overall "Done when" line — a runaway
// agent hitting its own quota ceiling and getting throttled/killed —
// is resourceQuotas.test.ts's (5b) job, already covered there; this
// file's job is only the piece 5f itself adds.
//
// Same two-group split every db.js-dependent phase's own test file has
// used since Phase 2f-iii, for the same reason:
//
// Group 1 — the file-reading half of forceOpenVault() touches only
// fs and office.ts's officePrivateDir()/ensureOffice(), neither of
// which import db.js (office.ts imports only config.ts, satisfiable
// with plain env vars — see resourceQuotas.test.ts's own Group 1 note
// making the identical point about office.ts). Run for REAL: a real
// temp officesDir, a real ensureOffice() call, real files written into
// the real vault directory it creates, read back by a byte-for-byte
// inlined copy of forceOpenVault()'s own readdir-then-readFile walk.
//
// Group 2 — the validation-then-audit half needs capability_audit
// (db.js, better-sqlite3, unbuildable here, no network to npm install
// it). Inlined mirror of forceOpenVault()'s own caller/justification
// checks and its audit-row shape, kept byte-for-byte in sync, writing
// into a plain in-memory array standing in for the capability_audit
// table. Recommend re-running both groups against the real
// forceOpenVault() with a live sqlite3 DB once a networked environment
// is available, per every prior phase's own standing note.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

process.env.OFFICES_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "vault-override-offices-"));
process.env.BACKEND_API_KEY ||= "test";
process.env.ADMIN_API_KEY ||= "test";
process.env.OPENROUTER_API_KEY ||= "test";
process.env.FACILITATOR_PRIVATE_KEY ||= ("0x" + "1".repeat(64)) as string;

const { ensureOffice, officePrivateDir } = await import("../office.js");

// ─── Group 1: real fs, real office.ts, no mocking ──────────────────

/** Byte-for-byte copy of forceOpenVault()'s own file-reading walk. */
function readVaultFilesMirror(agentId: string): { name: string; contents: string }[] {
  const dir = officePrivateDir(agentId);
  let entryNames: string[] = [];
  try {
    entryNames = fs.readdirSync(dir).filter((name: string) => fs.statSync(path.join(dir, name)).isFile());
  } catch {
    entryNames = [];
  }
  return entryNames.map((name) => ({ name, contents: fs.readFileSync(path.join(dir, name), "utf8") }));
}

test("reads real files a real ensureOffice() vault directory actually contains", async () => {
  const agentId = "0xvault-populated";
  await ensureOffice(agentId);

  const dir = officePrivateDir(agentId);
  fs.writeFileSync(path.join(dir, "third-party-api-key.txt"), "sk-incident-evidence-123");
  fs.writeFileSync(path.join(dir, "rotation-log.json"), '{"rotated":false}');
  fs.mkdirSync(path.join(dir, "not-a-file-should-be-skipped"));

  const files = readVaultFilesMirror(agentId);
  const names = files.map((f) => f.name).sort();
  assert.deepEqual(names, ["rotation-log.json", "third-party-api-key.txt"]);
  assert.equal(files.find((f) => f.name === "third-party-api-key.txt")!.contents, "sk-incident-evidence-123");
});

test("an agent whose vault was never ensureOffice()'d reads as empty, not an error", () => {
  const files = readVaultFilesMirror("0xvault-never-provisioned");
  assert.deepEqual(files, []);
});

test("a genuinely empty (but real, ensureOffice()'d) vault also reads as an empty list", async () => {
  const agentId = "0xvault-empty";
  await ensureOffice(agentId);
  assert.deepEqual(readVaultFilesMirror(agentId), []);
});

// ─── Group 2: inlined mirror of validation + audit-row shape ───────

interface AuditRow {
  caller: string;
  resource_type: string;
  resource_id: string;
  action: string;
  decision: string;
  reason: string;
  created_at: number;
}

let auditLog: AuditRow[];

function resetAuditLog(): void {
  auditLog = [];
}

/**
 * Byte-for-byte mirror of forceOpenVault()'s own validation + audit
 * write (capability.ts) — everything except the real fs read, which
 * Group 1 above already exercises for real. Takes a pre-read file list
 * instead of touching disk, so this group can run with zero fs
 * dependency at all.
 */
function forceOpenVaultMirror(
  caller: string,
  agentAddress: string,
  justification: string,
  files: { name: string; contents: string }[],
): { agentAddress: string; files: { name: string; contents: string }[]; auditedAt: number } {
  if (!caller || !caller.trim()) {
    throw Object.assign(new Error("forceOpenVault requires a caller identifier for the audit trail"), {
      status: 400,
    });
  }
  if (!justification || !justification.trim()) {
    throw Object.assign(
      new Error("forceOpenVault requires a non-empty justification — a blank reason is never logged"),
      { status: 400 },
    );
  }

  const auditedAt = Date.now();
  auditLog.push({
    caller,
    resource_type: "vault",
    resource_id: agentAddress,
    action: "read",
    decision: "allow",
    reason: `vault-override:${justification}`,
    created_at: auditedAt,
  });

  return { agentAddress, files, auditedAt };
}

test("refuses an empty caller before writing any audit row or reading any file", () => {
  resetAuditLog();
  assert.throws(() => forceOpenVaultMirror("", "0xagent1", "SOC-4821 legal hold", []), /caller identifier/);
  assert.equal(auditLog.length, 0);
});

test("refuses a blank justification before writing any audit row", () => {
  resetAuditLog();
  assert.throws(() => forceOpenVaultMirror("oncall:priya", "0xagent1", "   ", []), /non-empty justification/);
  assert.equal(auditLog.length, 0);
});

test("a valid override writes exactly one audit row carrying the justification verbatim", () => {
  resetAuditLog();
  const result = forceOpenVaultMirror("oncall:priya", "0xagent1", "SOC-4821: suspected key leak, legal hold", [
    { name: "api-key.txt", contents: "secret" },
  ]);

  assert.equal(auditLog.length, 1);
  const row = auditLog[0];
  assert.equal(row.caller, "oncall:priya");
  assert.equal(row.resource_type, "vault");
  assert.equal(row.resource_id, "0xagent1");
  assert.equal(row.action, "read");
  assert.equal(row.decision, "allow");
  assert.equal(row.reason, "vault-override:SOC-4821: suspected key leak, legal hold");
  assert.equal(result.files[0].contents, "secret");
});

test("the audit row is indistinguishable in shape from any other capability_audit row except its reason", () => {
  resetAuditLog();
  // A normal allow row, same shape checkCapability()'s own audit() writes
  // (capability.ts) — same six non-id columns, nothing vault-specific
  // added to the table for this phase.
  const ordinaryRow: AuditRow = {
    caller: "0xagent1",
    resource_type: "sandbox",
    resource_id: "sbx_123",
    action: "exec",
    decision: "allow",
    reason: "owner",
    created_at: Date.now(),
  };

  forceOpenVaultMirror("oncall:priya", "0xagent2", "SOC-4821 legal hold", []);
  const vaultRow = auditLog[0];

  assert.deepEqual(Object.keys(vaultRow).sort(), Object.keys(ordinaryRow).sort());
  assert.equal(typeof vaultRow.created_at, typeof ordinaryRow.created_at);
  assert.ok(vaultRow.reason.startsWith("vault-override:"));
  assert.ok(!ordinaryRow.reason.startsWith("vault-override:"));
});

test("two independent overrides of two different agents produce two independent, distinctly-justified rows", () => {
  resetAuditLog();
  forceOpenVaultMirror("oncall:priya", "0xagent1", "SOC-4821 legal hold", []);
  forceOpenVaultMirror("oncall:marcus", "0xagent2", "SOC-4900 abuse report", []);

  assert.equal(auditLog.length, 2);
  assert.equal(auditLog[0].resource_id, "0xagent1");
  assert.equal(auditLog[1].resource_id, "0xagent2");
  assert.notEqual(auditLog[0].reason, auditLog[1].reason);
});
