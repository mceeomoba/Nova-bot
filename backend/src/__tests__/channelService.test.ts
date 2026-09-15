// next-phase.md Phase 3a/3b/3d/3e (architecture-agent.md §3/§7):
// channelService.ts's propose_channel/accept_channel/reject_channel
// state machine, revoke_channel, sendFile, and requestFile.
//
// Previously this file inlined a byte-for-byte copy of all six
// functions against a plain in-memory array, citing no network access
// for `npm install` (better-sqlite3/express). That no longer holds
// here, so this imports channelService.ts directly against a live
// temp sqlite DB and a real temp office filesystem (sendFile/
// requestFile touch real outbox/inbox files via office.ts — no Docker
// involved anywhere in either function).
//
// One real gap remains, precisely scoped: teardownJointProjectOnRevoke()'s
// unmount call (unmountJointDirFromSandbox) is a real Docker call. It's
// wrapped in its own try/catch that only logs and continues, though, so
// the rest of the teardown (the atomic torn_down_at claim, the real
// fs.cp archive-copy into each party's office inbox, the real fs.rm of
// the joint dir) can still be exercised for real by seeding a
// joint_projects row directly — bypassing only join_project()'s own
// Docker-dependent *provisioning* step, which still needs a real
// Docker daemon to cover end-to-end (same gap channels.test.ts already
// notes for join_project() itself).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { freshDbPath, setTestEnv } from "./liveDb.js";

const OFFICES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "channel-service-offices-"));
const JOINT_PROJECTS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "channel-service-joint-"));

setTestEnv(freshDbPath("channel-service"));
process.env.OFFICES_DIR = OFFICES_ROOT;
process.env.JOINT_PROJECTS_DIR = JOINT_PROJECTS_ROOT;
process.env.DEFAULT_CONSTITUTION_PATH = path.join(OFFICES_ROOT, "canonical-constitution.md");

const { db } = await import("../db.js");
const office = (await import("../office.js")) as typeof import("../office.js");
const {
  proposeChannel,
  acceptChannel,
  rejectChannel,
  revokeChannel,
  sendFile,
  requestFile,
} = await import("../channelService.js");

let agentCounter = 0;
async function freshAgent(label: string): Promise<string> {
  agentCounter += 1;
  const address = `0x${label}_${agentCounter}`;
  db.prepare(`INSERT INTO agents (address, name, created_at) VALUES (?, ?, ?)`).run(address, address, Date.now());
  await office.ensureOffice(address);
  return address;
}

function channelStatus(id: string): string {
  return (db.prepare(`SELECT status FROM channels WHERE id = ?`).get(id) as { status: string }).status;
}

describe("proposeChannel()", () => {
  test("creates a proposed row with the given scope and note", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer", "let's swap logs");
    assert.equal(channel.status, "proposed");
    assert.equal(channel.scope, "file_transfer");
    assert.equal(channel.note, "let's swap logs");
    assert.equal(channel.proposer_address, a);
    assert.equal(channel.recipient_address, b);
    assert.equal(channel.resolved_at, null);
  });

  test("defaults note to null when omitted", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    assert.equal(channel.note, null);
  });

  test("rejects a self-channel (proposer === recipient)", async () => {
    const a = await freshAgent("self");
    assert.throws(() => proposeChannel(a, a, "file_transfer"), (err: any) => err.status === 400);
  });

  test("rejects an invalid scope", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    assert.throws(
      () => proposeChannel(a, b, "not_a_real_scope"),
      (err: any) => err.status === 400 && /scope must be one of/.test(err.message),
    );
  });

  test("rejects a recipient that isn't a known agent", async () => {
    const a = await freshAgent("proposer");
    assert.throws(
      () => proposeChannel(a, "0xnobody", "file_transfer"),
      (err: any) => err.status === 404,
    );
  });

  test("places no cap on concurrent proposals from one agent", async () => {
    const a = await freshAgent("prolific-proposer");
    const targets = await Promise.all([freshAgent("t1"), freshAgent("t2"), freshAgent("t3")]);
    for (const t of targets) {
      assert.doesNotThrow(() => proposeChannel(a, t, "file_transfer"));
    }
  });
});

describe("acceptChannel()", () => {
  test("flips proposed -> active when called by the named recipient", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    const accepted = acceptChannel(channel.id, b);
    assert.equal(accepted.status, "active");
    assert.ok(accepted.resolved_at);
  });

  test("refuses the proposer attempting to accept their own proposal", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    assert.throws(() => acceptChannel(channel.id, a), (err: any) => err.status === 403);
  });

  test("refuses a third agent who is neither proposer nor recipient", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const c = await freshAgent("stranger");
    const channel = proposeChannel(a, b, "file_transfer");
    assert.throws(() => acceptChannel(channel.id, c), (err: any) => err.status === 403);
  });

  test("is idempotent on an already-active channel", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    const second = acceptChannel(channel.id, b);
    assert.equal(second.status, "active");
  });

  test("refuses to resurrect a rejected channel", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    rejectChannel(channel.id, b);
    assert.throws(() => acceptChannel(channel.id, b), (err: any) => err.status === 409);
  });

  test("refuses to resurrect a revoked channel", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    await revokeChannel(channel.id, a);
    assert.throws(() => acceptChannel(channel.id, b), (err: any) => err.status === 409);
  });
});

describe("rejectChannel()", () => {
  test("flips proposed -> rejected when called by the named recipient", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    const rejected = rejectChannel(channel.id, b);
    assert.equal(rejected.status, "rejected");
  });

  test("refuses the proposer attempting to reject their own proposal", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    assert.throws(() => rejectChannel(channel.id, a), (err: any) => err.status === 403);
  });

  test("refuses a third agent who is neither proposer nor recipient", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const c = await freshAgent("stranger");
    const channel = proposeChannel(a, b, "file_transfer");
    assert.throws(() => rejectChannel(channel.id, c), (err: any) => err.status === 403);
  });

  test("is terminal — a rejected channel cannot later be accepted", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    rejectChannel(channel.id, b);
    assert.throws(() => acceptChannel(channel.id, b));
    assert.equal(channelStatus(channel.id), "rejected");
  });

  test("refuses to re-reject an already-active channel", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    assert.throws(() => rejectChannel(channel.id, b), (err: any) => err.status === 409);
  });
});

describe("revokeChannel()", () => {
  test("flips an active channel to revoked when called by the proposer", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    const revoked = await revokeChannel(channel.id, a);
    assert.equal(revoked.status, "revoked");
  });

  test("flips an active channel to revoked when called by the recipient", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    const revoked = await revokeChannel(channel.id, b);
    assert.equal(revoked.status, "revoked");
  });

  test("on a still-proposed channel is treated as an implicit reject (no fourth state)", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    const result = await revokeChannel(channel.id, b);
    assert.equal(result.status, "rejected");
  });

  test("on a still-proposed channel is callable by the proposer, unlike rejectChannel", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    const result = await revokeChannel(channel.id, a);
    assert.equal(result.status, "rejected");
  });

  test("refuses a third agent who is neither proposer nor recipient (active channel)", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const c = await freshAgent("stranger");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    await assert.rejects(() => revokeChannel(channel.id, c), (err: any) => err.status === 403);
  });

  test("refuses a third agent on a still-proposed channel too", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const c = await freshAgent("stranger");
    const channel = proposeChannel(a, b, "file_transfer");
    await assert.rejects(() => revokeChannel(channel.id, c), (err: any) => err.status === 403);
  });

  test("is idempotent on an already-revoked channel", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    await revokeChannel(channel.id, a);
    const second = await revokeChannel(channel.id, a);
    assert.equal(second.status, "revoked");
  });

  test("is idempotent on an already-rejected channel (no separate code path)", async () => {
    const a = await freshAgent("proposer");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    rejectChannel(channel.id, b);
    const result = await revokeChannel(channel.id, a);
    assert.equal(result.status, "rejected");
  });

  test("404s on an unknown channel id", async () => {
    await assert.rejects(() => revokeChannel("chn_doesnotexist", "0xanyone"), (err: any) => err.status === 404);
  });

  describe("join_project teardown hook (real atomic claim + real fs archive/cleanup; Docker unmount is a real call but fails silently, caught)", () => {
    function seedJointProject(channelId: string, proposer: string, recipient: string): string {
      const hostPath = path.join(JOINT_PROJECTS_ROOT, channelId);
      fs.mkdirSync(hostPath, { recursive: true });
      fs.writeFileSync(path.join(hostPath, "shared-note.txt"), "joint work in progress\n");
      db.prepare(
        `INSERT INTO joint_projects (channel_id, path, proposer_sandbox_id, recipient_sandbox_id, provisioned_at, torn_down_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      ).run(channelId, hostPath, `sbx-${proposer}`, `sbx-${recipient}`, Date.now());
      return hostPath;
    }

    test("triggers real teardown (claim + archive-copy + dir removal) when an active->revoked channel has a joint_projects row", async () => {
      const a = await freshAgent("jp-proposer");
      const b = await freshAgent("jp-recipient");
      const channel = proposeChannel(a, b, "joint_project");
      acceptChannel(channel.id, b);
      const hostPath = seedJointProject(channel.id, a, b);

      await revokeChannel(channel.id, a);

      const row = db.prepare(`SELECT torn_down_at FROM joint_projects WHERE channel_id = ?`).get(channel.id) as {
        torn_down_at: number | null;
      };
      assert.ok(row.torn_down_at, "torn_down_at should be set by the atomic claim");
      assert.ok(!fs.existsSync(hostPath), "the joint dir itself should be removed");
      const archivedA = path.join(office.officeInboxDir(a), `joint_${channel.id}`, "shared-note.txt");
      const archivedB = path.join(office.officeInboxDir(b), `joint_${channel.id}`, "shared-note.txt");
      assert.ok(fs.existsSync(archivedA), "proposer's inbox should have the archived copy");
      assert.ok(fs.existsSync(archivedB), "recipient's inbox should have the archived copy");
    });

    test("implicit-reject branch (still-proposed) never triggers teardown", async () => {
      const a = await freshAgent("jp-proposer");
      const b = await freshAgent("jp-recipient");
      const channel = proposeChannel(a, b, "joint_project");
      const hostPath = seedJointProject(channel.id, a, b);

      await revokeChannel(channel.id, a); // still 'proposed' -> implicit reject

      const row = db.prepare(`SELECT torn_down_at FROM joint_projects WHERE channel_id = ?`).get(channel.id) as {
        torn_down_at: number | null;
      };
      assert.equal(row.torn_down_at, null);
      assert.ok(fs.existsSync(hostPath), "an implicit-reject revoke must not touch the joint dir at all");
    });

    test("is a safe no-op when join_project was never called (no joint_projects row)", async () => {
      const a = await freshAgent("jp-proposer");
      const b = await freshAgent("jp-recipient");
      const channel = proposeChannel(a, b, "joint_project");
      acceptChannel(channel.id, b);
      await assert.doesNotReject(() => revokeChannel(channel.id, a));
    });

    test("the atomic claim only ever fires once — a second teardown attempt on the same row is a no-op", async () => {
      const a = await freshAgent("jp-proposer");
      const b = await freshAgent("jp-recipient");
      const channel = proposeChannel(a, b, "joint_project");
      acceptChannel(channel.id, b);
      seedJointProject(channel.id, a, b);

      await revokeChannel(channel.id, a); // first revoke does the real teardown
      const firstTornDownAt = (
        db.prepare(`SELECT torn_down_at FROM joint_projects WHERE channel_id = ?`).get(channel.id) as {
          torn_down_at: number;
        }
      ).torn_down_at;

      await revokeChannel(channel.id, a); // idempotent revoke — already 'revoked', but exercises teardown's own no-op guard too
      const secondTornDownAt = (
        db.prepare(`SELECT torn_down_at FROM joint_projects WHERE channel_id = ?`).get(channel.id) as {
          torn_down_at: number;
        }
      ).torn_down_at;

      assert.equal(secondTornDownAt, firstTornDownAt, "torn_down_at must not be overwritten by a repeat call");
    });
  });
});

describe("sendFile()", () => {
  async function activeFileTransferChannel(): Promise<{ a: string; b: string; channelId: string }> {
    const a = await freshAgent("sender");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    return { a, b, channelId: channel.id };
  }

  function stageOutboxFile(agentAddress: string, filename: string, contents: string): void {
    const p = path.join(office.officeOutboxDir(agentAddress), filename);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, contents);
  }

  test("succeeds with an active file_transfer channel and a staged file", async () => {
    const { a, b } = await activeFileTransferChannel();
    stageOutboxFile(a, "report.txt", "quarterly numbers\n");
    const transfer = await sendFile(a, b, "report.txt", "here you go");
    assert.equal(transfer.sender_address, a);
    assert.equal(transfer.recipient_address, b);
    assert.equal(transfer.note, "here you go");
    const landed = path.join(office.officeInboxDir(b), "report.txt");
    assert.equal(fs.readFileSync(landed, "utf8"), "quarterly numbers\n");
  });

  test("defaults note to null when omitted", async () => {
    const { a, b } = await activeFileTransferChannel();
    stageOutboxFile(a, "report.txt", "data\n");
    const transfer = await sendFile(a, b, "report.txt");
    assert.equal(transfer.note, null);
  });

  test("is bidirectional — the channel's recipient can equally send back to the proposer", async () => {
    const { a, b } = await activeFileTransferChannel();
    stageOutboxFile(b, "reply.txt", "ack\n");
    const transfer = await sendFile(b, a, "reply.txt");
    assert.equal(transfer.sender_address, b);
    assert.equal(transfer.recipient_address, a);
  });

  test("fails NO_CHANNEL when no channel exists between the two agents at all", async () => {
    const a = await freshAgent("sender");
    const b = await freshAgent("recipient");
    stageOutboxFile(a, "f.txt", "x\n");
    await assert.rejects(() => sendFile(a, b, "f.txt"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("fails NO_CHANNEL when the only channel between them is still 'proposed' (not yet active)", async () => {
    const a = await freshAgent("sender");
    const b = await freshAgent("recipient");
    proposeChannel(a, b, "file_transfer");
    stageOutboxFile(a, "f.txt", "x\n");
    await assert.rejects(() => sendFile(a, b, "f.txt"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("fails NO_CHANNEL when the active channel between them was revoked", async () => {
    const { a, b, channelId } = await activeFileTransferChannel();
    await revokeChannel(channelId, a);
    stageOutboxFile(a, "f.txt", "x\n");
    await assert.rejects(() => sendFile(a, b, "f.txt"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("fails NO_CHANNEL when the only active channel between them has the wrong scope", async () => {
    const a = await freshAgent("sender");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "payment");
    acceptChannel(channel.id, b);
    stageOutboxFile(a, "f.txt", "x\n");
    await assert.rejects(() => sendFile(a, b, "f.txt"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("fails (404) when the channel is fine but the file was never staged in the sender's outbox", async () => {
    const { a, b } = await activeFileTransferChannel();
    await assert.rejects(() => sendFile(a, b, "never-staged.txt"), (err: any) => err.status === 404);
  });

  test("404s on an unknown recipient the same way proposeChannel does", async () => {
    const a = await freshAgent("sender");
    stageOutboxFile(a, "f.txt", "x\n");
    await assert.rejects(() => sendFile(a, "0xnobody", "f.txt"), (err: any) => err.status === 404);
  });

  test("repeated calls on the same active channel all go through without re-approval each time", async () => {
    const { a, b } = await activeFileTransferChannel();
    stageOutboxFile(a, "one.txt", "1\n");
    stageOutboxFile(a, "two.txt", "2\n");
    await sendFile(a, b, "one.txt");
    await assert.doesNotReject(() => sendFile(a, b, "two.txt"));
  });
});

describe("requestFile()", () => {
  async function activeFileTransferChannel(): Promise<{ a: string; b: string; channelId: string }> {
    const a = await freshAgent("requester");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "file_transfer");
    acceptChannel(channel.id, b);
    return { a, b, channelId: channel.id };
  }

  test("creates a pending, channel-scoped request over an active file_transfer channel", async () => {
    const { a, b } = await activeFileTransferChannel();
    const request = requestFile(a, b, "please send the Q3 report");
    assert.equal(request.status, "pending");
    assert.equal(request.requester_address, a);
    assert.equal(request.recipient_address, b);
    assert.equal(request.fulfilled_at, null);
  });

  test("is bidirectional — the channel's recipient can equally request from the proposer", async () => {
    const { a, b } = await activeFileTransferChannel();
    const request = requestFile(b, a, "send me the spec");
    assert.equal(request.requester_address, b);
    assert.equal(request.recipient_address, a);
  });

  test("fails NO_CHANNEL when no channel exists between the two agents at all", async () => {
    const a = await freshAgent("requester");
    const b = await freshAgent("recipient");
    assert.throws(() => requestFile(a, b, "x"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("fails NO_CHANNEL when the only channel between them is still 'proposed' (not yet active)", async () => {
    const a = await freshAgent("requester");
    const b = await freshAgent("recipient");
    proposeChannel(a, b, "file_transfer");
    assert.throws(() => requestFile(a, b, "x"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("fails NO_CHANNEL when the active channel between them was revoked", async () => {
    const { a, b, channelId } = await activeFileTransferChannel();
    await revokeChannel(channelId, a);
    assert.throws(() => requestFile(a, b, "x"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("fails NO_CHANNEL when the only active channel between them has the wrong scope", async () => {
    const a = await freshAgent("requester");
    const b = await freshAgent("recipient");
    const channel = proposeChannel(a, b, "payment");
    acceptChannel(channel.id, b);
    assert.throws(() => requestFile(a, b, "x"), (err: any) => err.code === "NO_CHANNEL");
  });

  test("404s on an unknown recipient the same way proposeChannel does", async () => {
    const a = await freshAgent("requester");
    assert.throws(() => requestFile(a, "0xnobody", "x"), (err: any) => err.status === 404);
  });

  test("does not itself move a file or touch inbox/outbox", async () => {
    const { a, b } = await activeFileTransferChannel();
    const before = fs.readdirSync(office.officeInboxDir(b)).length;
    requestFile(a, b, "please send it");
    const after = fs.readdirSync(office.officeInboxDir(b)).length;
    assert.equal(after, before);
  });

  test("a later matching send_file call flips the request to fulfilled", async () => {
    const { a, b } = await activeFileTransferChannel();
    const request = requestFile(a, b, "please send the report");
    const p = path.join(office.officeOutboxDir(b), "report.txt");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "here it is\n");
    await sendFile(b, a, "report.txt");
    const updated = db.prepare(`SELECT status, fulfilled_at FROM file_requests WHERE id = ?`).get(request.id) as {
      status: string;
      fulfilled_at: number | null;
    };
    assert.equal(updated.status, "fulfilled");
    assert.ok(updated.fulfilled_at);
  });

  test("an unrelated send_file call (wrong direction) does not fulfill a pending request", async () => {
    const { a, b } = await activeFileTransferChannel();
    const request = requestFile(a, b, "please send the report");
    // a sends TO b (same direction as the request, not the fulfilling direction)
    const p = path.join(office.officeOutboxDir(a), "unrelated.txt");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "irrelevant\n");
    await sendFile(a, b, "unrelated.txt");
    const stillPending = db.prepare(`SELECT status FROM file_requests WHERE id = ?`).get(request.id) as {
      status: string;
    };
    assert.equal(stillPending.status, "pending");
  });

  test("send_file still succeeds with zero open requests against it", async () => {
    const { a, b } = await activeFileTransferChannel();
    const p = path.join(office.officeOutboxDir(a), "no-request-needed.txt");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "sent unprompted\n");
    await assert.doesNotReject(() => sendFile(a, b, "no-request-needed.txt"));
  });
});
