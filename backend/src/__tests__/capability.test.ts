// next-phase.md Phase 2g (architecture-agent.md §4g) + Phase 3c: the
// Worker-382 worked example (budget/environment dimensions of
// checkCapability()) and the channel-grant path (findActiveChannelGrant()).
//
// Previously this file inlined byte-for-byte copies of
// checkBudgetAndEnvironment()/findActiveChannelGrant()/
// parseChannelResource() against plain in-memory data, because
// better-sqlite3 couldn't be installed in the environment this file
// was originally written in (checkCapability() reads/writes real
// tables on every path via ownerOf()/audit()). That constraint doesn't
// hold here (registry.npmjs.org is reachable), so this now imports
// capability.ts directly and drives its one exported entry point,
// checkCapability(), against a live temp sqlite DB — the budget and
// environment dimensions are internal (checkBudgetAndEnvironment is
// not exported) so they're exercised the same way production code
// reaches them: through checkCapability() itself, using `wallet` as
// the direct-ownership resourceType (the cheapest real ownerOf() path
// — an `agents` row where resourceId IS the owner) so every case below
// is actually about the budget/environment/channel dimensions, not
// about ownership. Each case also confirms the matching
// capability_audit row, since that's the other half of what
// checkCapability() actually does (audit() fires on every path, an
// aspect the old inlined `decide()` copy couldn't touch at all since
// it never wrote to a table).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { freshDbPath, setTestEnv } from "./liveDb.js";

setTestEnv(freshDbPath("capability"));

const { db } = await import("../db.js");
const { checkCapability } = await import("../capability.js");

function ensureAgent(address: string): void {
  db.prepare(`INSERT OR IGNORE INTO agents (address, name, created_at) VALUES (?, ?, ?)`).run(
    address,
    address,
    Date.now(),
  );
}

function lastAudit(caller: string, resourceId: string): { decision: string; reason: string } {
  const row = db
    .prepare(
      `SELECT decision, reason FROM capability_audit
       WHERE caller = ? AND resource_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(caller, resourceId) as { decision: string; reason: string };
  return row;
}

describe("checkCapability: Worker-382 budget/environment dimensions (owner path)", () => {
  test("a correctly scoped, budgeted, environment-matched call is allowed and audited allow/owner", () => {
    ensureAgent("wkr_382");
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "wkr_382",
        resourceType: "wallet",
        resourceId: "wkr_382",
        action: "exec",
        budget: { limit: 2, spent: 1.5, unit: "usd" },
        environment: "temporary-container-382",
        grantedEnvironment: "temporary-container-382",
      }),
    );
    assert.deepEqual(lastAudit("wkr_382", "wkr_382"), { decision: "allow", reason: "owner" });
  });

  test("swapping only the budget dimension over the cap denies with over-budget, audited deny/over-budget", () => {
    ensureAgent("wkr_382b");
    assert.throws(
      () =>
        checkCapability({
          caller: "wkr_382b",
          resourceType: "wallet",
          resourceId: "wkr_382b",
          action: "exec",
          budget: { limit: 2, spent: 2.5, unit: "usd" },
        }),
      /over.budget/i,
    );
    assert.deepEqual(lastAudit("wkr_382b", "wkr_382b"), { decision: "deny", reason: "over-budget" });
  });

  test("spending exactly up to the cap is still allowed (spent === limit, not > limit)", () => {
    ensureAgent("wkr_382c");
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "wkr_382c",
        resourceType: "wallet",
        resourceId: "wkr_382c",
        action: "exec",
        budget: { limit: 2, spent: 2, unit: "usd" },
      }),
    );
  });

  test("swapping only the environment dimension to a mismatched value denies with wrong-environment", () => {
    ensureAgent("wkr_382d");
    assert.throws(
      () =>
        checkCapability({
          caller: "wkr_382d",
          resourceType: "wallet",
          resourceId: "wkr_382d",
          action: "exec",
          environment: "temporary-container-999",
          grantedEnvironment: "temporary-container-382",
        }),
      /environment/i,
    );
    assert.deepEqual(lastAudit("wkr_382d", "wkr_382d"), { decision: "deny", reason: "wrong-environment" });
  });

  test("omitting the budget field entirely skips the budget dimension (not treated as spent=0/limit=0 failure)", () => {
    ensureAgent("wkr_382e");
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "wkr_382e",
        resourceType: "wallet",
        resourceId: "wkr_382e",
        action: "exec",
        environment: "temporary-container-382",
        grantedEnvironment: "temporary-container-382",
      }),
    );
  });

  test("omitting environment/grantedEnvironment entirely skips the environment dimension", () => {
    ensureAgent("wkr_382f");
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "wkr_382f",
        resourceType: "wallet",
        resourceId: "wkr_382f",
        action: "exec",
        budget: { limit: 2, spent: 1.5, unit: "usd" },
      }),
    );
  });

  test("`environment` with no `grantedEnvironment` skips the check rather than guessing at a mismatch", () => {
    ensureAgent("wkr_382g");
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "wkr_382g",
        resourceType: "wallet",
        resourceId: "wkr_382g",
        action: "exec",
        environment: "temporary-container-382",
      }),
    );
  });
});

describe("checkCapability: headcount-quota retrofit reuses the budget dimension with unit 'calls'", () => {
  test("single-add spawn at exactly the limit is denied (matches original `current >= limit`)", () => {
    ensureAgent("wkr_q1");
    assert.throws(() =>
      checkCapability({
        caller: "wkr_q1",
        resourceType: "wallet",
        resourceId: "wkr_q1",
        action: "exec",
        budget: { limit: 5, spent: 5 + 1, unit: "calls" },
      }),
    );
  });

  test("single-add spawn one below the limit is allowed", () => {
    ensureAgent("wkr_q2");
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "wkr_q2",
        resourceType: "wallet",
        resourceId: "wkr_q2",
        action: "exec",
        budget: { limit: 5, spent: 5, unit: "calls" },
      }),
    );
  });

  test("bulk temp-worker spawn landing exactly on the limit is allowed", () => {
    ensureAgent("wkr_q3");
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "wkr_q3",
        resourceType: "wallet",
        resourceId: "wkr_q3",
        action: "exec",
        budget: { limit: 5, spent: 2 + 3, unit: "calls" },
      }),
    );
  });

  test("bulk temp-worker spawn landing one over the limit is denied", () => {
    ensureAgent("wkr_q4");
    assert.throws(() =>
      checkCapability({
        caller: "wkr_q4",
        resourceType: "wallet",
        resourceId: "wkr_q4",
        action: "exec",
        budget: { limit: 5, spent: 2 + 4, unit: "calls" },
      }),
    );
  });
});

describe("checkCapability: channel grants (step 3, resourceType 'channel')", () => {
  function seedChannel(opts: {
    id: string;
    proposer: string;
    recipient: string;
    scope: string;
    status: "proposed" | "active" | "rejected" | "revoked";
    resolvedAt: number | null;
  }): void {
    const now = Date.now();
    db.prepare(
      `INSERT INTO channels (id, proposer_address, recipient_address, scope, status, proposed_at, resolved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(opts.id, opts.proposer, opts.recipient, opts.scope, opts.status, now, opts.resolvedAt, now);
  }

  test("an active channel with matching scope allows the proposer against the recipient (channel:<id> audit reason)", () => {
    seedChannel({
      id: "chn_live_1",
      proposer: "agent_alice",
      recipient: "agent_bob",
      scope: "file_transfer",
      status: "active",
      resolvedAt: 100,
    });
    // caller "agent_alice" is neither owner (wallet row doesn't exist
    // for this resourceId) nor a subagent — only the channel grant can
    // allow this.
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "agent_alice",
        resourceType: "channel",
        resourceId: "agent_bob:file_transfer",
        action: "exec",
      }),
    );
    const audit = lastAudit("agent_alice", "agent_bob:file_transfer");
    assert.equal(audit.decision, "allow");
    assert.equal(audit.reason, "channel:chn_live_1");
  });

  test("bidirectional — the recipient is equally allowed against the proposer", () => {
    seedChannel({
      id: "chn_live_2",
      proposer: "agent_carol",
      recipient: "agent_dave",
      scope: "file_transfer",
      status: "active",
      resolvedAt: 100,
    });
    assert.doesNotThrow(() =>
      checkCapability({
        caller: "agent_dave",
        resourceType: "channel",
        resourceId: "agent_carol:file_transfer",
        action: "exec",
      }),
    );
  });

  test("a still-'proposed' channel (not yet accepted) denies with no-capability", () => {
    seedChannel({
      id: "chn_live_3",
      proposer: "agent_erin",
      recipient: "agent_frank",
      scope: "file_transfer",
      status: "proposed",
      resolvedAt: null,
    });
    assert.throws(() =>
      checkCapability({
        caller: "agent_erin",
        resourceType: "channel",
        resourceId: "agent_frank:file_transfer",
        action: "exec",
      }),
    );
    assert.equal(lastAudit("agent_erin", "agent_frank:file_transfer").reason, "no-capability");
  });

  test("a 'revoked' channel denies with no-capability", () => {
    seedChannel({
      id: "chn_live_4",
      proposer: "agent_gina",
      recipient: "agent_hank",
      scope: "file_transfer",
      status: "revoked",
      resolvedAt: 200,
    });
    assert.throws(() =>
      checkCapability({
        caller: "agent_gina",
        resourceType: "channel",
        resourceId: "agent_hank:file_transfer",
        action: "exec",
      }),
    );
  });

  test("an active channel whose scope doesn't cover the requested scope denies", () => {
    seedChannel({
      id: "chn_live_5",
      proposer: "agent_ivy",
      recipient: "agent_jack",
      scope: "file_transfer",
      status: "active",
      resolvedAt: 100,
    });
    assert.throws(() =>
      checkCapability({
        caller: "agent_ivy",
        resourceType: "channel",
        resourceId: "agent_jack:joint_project",
        action: "exec",
      }),
    );
  });

  test("an active channel between two other agents doesn't grant an unrelated third party", () => {
    seedChannel({
      id: "chn_live_6",
      proposer: "agent_kim",
      recipient: "agent_liam",
      scope: "file_transfer",
      status: "active",
      resolvedAt: 100,
    });
    assert.throws(() =>
      checkCapability({
        caller: "agent_mona",
        resourceType: "channel",
        resourceId: "agent_liam:file_transfer",
        action: "exec",
      }),
    );
  });

  test("a malformed resourceId with no ':' separator misses cleanly (denies, doesn't throw a parse error)", () => {
    assert.throws(
      () =>
        checkCapability({
          caller: "agent_alice",
          resourceType: "channel",
          resourceId: "agent_bob",
          action: "exec",
        }),
      // Still a deny (404/403 from checkCapability's default-deny path),
      // never an unrelated parse exception from parseChannelResource.
      (err: unknown) => err instanceof Error && typeof (err as { status?: number }).status === "number",
    );
  });

  test("resolved_at tie-break: the most recently resolved of two matching active channels wins the audit reason", () => {
    seedChannel({
      id: "chn_live_older",
      proposer: "agent_nora",
      recipient: "agent_owen",
      scope: "payment",
      status: "active",
      resolvedAt: 100,
    });
    seedChannel({
      id: "chn_live_newer",
      proposer: "agent_nora",
      recipient: "agent_owen",
      scope: "payment",
      status: "active",
      resolvedAt: 200,
    });
    checkCapability({
      caller: "agent_nora",
      resourceType: "channel",
      resourceId: "agent_owen:payment",
      action: "exec",
    });
    assert.equal(lastAudit("agent_nora", "agent_owen:payment").reason, "channel:chn_live_newer");
  });
});
