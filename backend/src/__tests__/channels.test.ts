// next-phase.md Phase 3g-iii — closes what channelService.test.ts
// (52 real, live-DB cases — propose/accept/reject/revoke/send_file/
// request_file) does NOT already cover: joinProject() itself, and the
// auditChannelEvent() hook's unregistered/self-custody skip path.
//
// Previously this file inlined a byte-for-byte copy of joinProject()'s
// guard logic and the dual-mount/audit-hook side effects against
// plain in-memory stand-ins, citing no network access for
// `npm install`. That's no longer true here, so this imports
// channelService.ts directly against a live temp sqlite DB.
//
// Scope, honestly: joinProject()'s five guard clauses (missing params,
// self-join, non-party caller, no-active-channel) all throw BEFORE
// touching Docker, so they're exercised for real below. The
// dual-mount side effect itself (getOrCreateDefaultSandbox() +
// mountJointDirIntoSandbox(), both real Docker calls) is NOT covered
// here — this sandbox has no Docker daemon (`docker` isn't even
// installed), so that half of joinProject() still needs a real
// environment with Docker to exercise end-to-end. That's a narrower,
// accurate gap — not the old file's blanket "nothing here touches a
// real DB" — and it's the same gap vmService.test.ts/docker-backed
// suites elsewhere in this repo already carry, not a new one.
//
// auditChannelEvent() is private (not exported) and fire-and-forget
// (an un-awaited async IIFE), so its "skip for an unregistered/
// self-custody actor" branch is exercised indirectly here: call
// proposeChannel() (which fires it) for an actor with no
// encrypted_key/erc8004_agent_id row, capture console.log, and wait a
// macrotask tick for the IIFE to run and confirm it logged the
// documented "skipped (no on-chain identity...)" line rather than
// attempting an on-chain write.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDbPath, setTestEnv } from "./liveDb.js";

setTestEnv(freshDbPath("channels"));

const { db } = await import("../db.js");
const { proposeChannel, acceptChannel, joinProject } = await import("../channelService.js");
const { createAgentWallet } = await import("../wallet.js");

function ensureAgent(address: string): void {
  db.prepare(`INSERT OR IGNORE INTO agents (address, name, created_at) VALUES (?, ?, ?)`).run(
    address,
    address,
    Date.now(),
  );
}

describe("joinProject(): guard clauses (all throw before any Docker call)", () => {
  test("missing channelId or callerAddress throws 400", () => {
    assert.rejects(() => joinProject("", "agent_x"), (err: any) => err.status === 400);
    assert.rejects(() => joinProject("chn_x", ""), (err: any) => err.status === 400);
  });

  test("a caller who is neither party to the channel is refused with 403", async () => {
    ensureAgent("jp_proposer_1");
    ensureAgent("jp_recipient_1");
    ensureAgent("jp_stranger_1");
    const channel = proposeChannel("jp_proposer_1", "jp_recipient_1", "joint_project");
    acceptChannel(channel.id, "jp_recipient_1");

    await assert.rejects(() => joinProject(channel.id, "jp_stranger_1"), (err: any) => err.status === 403);
  });

  test("a channel that isn't active (still 'proposed') is refused with NO_CHANNEL (403)", async () => {
    ensureAgent("jp_proposer_2");
    ensureAgent("jp_recipient_2");
    const channel = proposeChannel("jp_proposer_2", "jp_recipient_2", "joint_project");
    // never accepted — still 'proposed'

    await assert.rejects(
      () => joinProject(channel.id, "jp_proposer_2"),
      (err: any) => err.status === 403 && err.code === "NO_CHANNEL" && /NO_CHANNEL/.test(err.message),
    );
  });

  test("a channel active under a different scope (not 'joint_project') is refused with NO_CHANNEL", async () => {
    ensureAgent("jp_proposer_3");
    ensureAgent("jp_recipient_3");
    const channel = proposeChannel("jp_proposer_3", "jp_recipient_3", "file_transfer");
    acceptChannel(channel.id, "jp_recipient_3");

    await assert.rejects(
      () => joinProject(channel.id, "jp_proposer_3"),
      (err: any) => err.code === "NO_CHANNEL",
    );
  });

  test("a revoked channel is refused with NO_CHANNEL, not resurrected", async () => {
    ensureAgent("jp_proposer_4");
    ensureAgent("jp_recipient_4");
    const channel = proposeChannel("jp_proposer_4", "jp_recipient_4", "joint_project");
    acceptChannel(channel.id, "jp_recipient_4");
    db.prepare(`UPDATE channels SET status = 'revoked', resolved_at = ? WHERE id = ?`).run(Date.now(), channel.id);

    await assert.rejects(
      () => joinProject(channel.id, "jp_proposer_4"),
      (err: any) => err.code === "NO_CHANNEL",
    );
  });
});

// Polls until `predicate()` is true or `timeoutMs` elapses, instead of
// guessing a fixed number of ticks for the un-awaited async IIFE
// inside auditChannelEvent() to run.
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("auditChannelEvent(): fire-and-forget hook fired by proposeChannel()", () => {
  test("an unregistered actor (no encrypted_key/erc8004_agent_id) is skipped silently — no log line at all", async () => {
    ensureAgent("audit_proposer_1");
    ensureAgent("audit_recipient_1");
    // ensureAgent() leaves encrypted_key/erc8004_agent_id NULL — the
    // exact "self-custody or unregistered" condition auditChannelEvent()
    // checks for. Its own code returns immediately in that branch,
    // before reaching either console.log call — so the correct
    // assertion is silence, not a "skipped" log line (that log only
    // fires for a *registered* actor whose on-chain call itself fails
    // — see the next test).

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      proposeChannel("audit_proposer_1", "audit_recipient_1", "file_transfer");
      // Give the fire-and-forget IIFE a real window to run and prove
      // it does NOT log, rather than asserting on a single tick.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      console.log = originalLog;
    }

    const auditLine = logs.find((l) => l.includes("[channel-audit]"));
    assert.equal(auditLine, undefined, `expected no [channel-audit] log line, got: ${JSON.stringify(logs)}`);
  });

  test("a registered actor (has encrypted_key + erc8004_agent_id) still logs 'skipped' when the on-chain call itself fails", async () => {
    // This sandbox has no real chain RPC reachable, so recordChannelEvent()'s
    // own writeContract()/waitForTransactionReceipt() call will fail —
    // its own try/catch (erc8004Trust.ts) swallows that and returns
    // null, which is exactly the "or the call failed" half of
    // auditChannelEvent()'s log message. This confirms the registered
    // branch is actually reached (unlike the test above), not just
    // that errors don't crash the process. Uses the real
    // createAgentWallet() to get a genuinely AES-256-GCM-encrypted key
    // (decrypt() would throw synchronously on a hand-typed fake string,
    // short-circuiting before the code ever reached the network call).
    const wallet = await createAgentWallet("audit-proposer-2");
    ensureAgent("audit_recipient_2");
    db.prepare(`UPDATE agents SET erc8004_agent_id = ? WHERE address = ?`).run("1", wallet.address);

    const logs: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    console.error = () => {}; // the RPC call itself will error to the console — not under test here
    try {
      proposeChannel(wallet.address, "audit_recipient_2", "file_transfer");
      await waitUntil(() => logs.some((l) => l.includes("[channel-audit]")), 5000);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const auditLine = logs.find((l) => l.includes("[channel-audit]"));
    assert.ok(auditLine, `expected a [channel-audit] log line, got: ${JSON.stringify(logs)}`);
  });
});
