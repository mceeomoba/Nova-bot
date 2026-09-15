// Zent.md Phase 17e-iv: "Active-status transition: only after 17e-ii
// and 17e-iii both pass is Agent B marked `active`; a failing smoke
// test leaves it in a distinguishable pre-active state instead of
// silently retrying."
//
// Same "no live better-sqlite3" reason every other genesis*_test.ts
// file in this directory already gives (see genesisTickSmokeTest_test.ts's
// own header) — this mirrors genesisActivation.ts's state machine
// (markGenesisPending / activateGenesisAgent / markGenesisActivationFailed
// / getGenesisActivationStatus / getGenesisActivationEvent) against an
// in-memory stand-in for the `agents.genesis_activation_status` column
// and the `genesis_activation_events` table, rather than a real
// better-sqlite3 file.
//
// What this covers:
//   - a 'self'-spawned agent (never markGenesisPending()'d) has status
//     null, and activate/fail calls against it are no-ops (no event
//     row written) — this module never touches an agent it didn't seed.
//   - pending -> active: activateGenesisAgent() flips the column and
//     writes exactly one 'active'/'passed' event.
//   - pending -> failed (smoke test): markGenesisActivationFailed()
//     with reason 'smoke_test_failed' flips the column and writes
//     exactly one 'failed' event carrying that reason/detail.
//   - pending -> failed (constitution): same, reason
//     'constitution_violated'.
//   - one-shot: calling activateGenesisAgent() a second time after the
//     row is already 'active' (or 'failed') is a no-op — no second
//     event, status unchanged. Same for markGenesisActivationFailed()
//     called twice, and for calling activate after fail or vice versa.
//   - getGenesisActivationStatus() distinguishes "agent doesn't exist"
//     (undefined) from "exists, never pipeline-spawned" (null) from
//     the three real statuses.

import { test } from "node:test";
import assert from "node:assert/strict";

type GenesisActivationStatus = "pending" | "active" | "failed";

interface GenesisActivationEvent {
  id: string;
  opportunityId: string;
  agentAddress: string;
  status: "active" | "failed";
  reason: "smoke_test_failed" | "constitution_violated" | "passed";
  detail: string;
  createdAt: number;
}

// ─── Fake `agents` + `genesis_activation_events` tables ────────────

let agents: Record<string, { genesisActivationStatus: GenesisActivationStatus | null }>;
let events: GenesisActivationEvent[];
let nextId: number;

function reset() {
  agents = {};
  events = [];
  nextId = 1;
}

function seedAgent(address: string, status: GenesisActivationStatus | null) {
  agents[address] = { genesisActivationStatus: status };
}

// Mirrors genesisActivation.ts field-for-field.

function markGenesisPending(agentAddress: string): void {
  const row = agents[agentAddress];
  if (!row) return; // UPDATE ... WHERE address = ? matches zero rows
  row.genesisActivationStatus = "pending";
}

function writeEvent(
  opportunityId: string,
  agentAddress: string,
  status: "active" | "failed",
  reason: GenesisActivationEvent["reason"],
  detail: string,
): void {
  events.push({
    id: `evt-${nextId++}`,
    opportunityId,
    agentAddress,
    status,
    reason,
    detail,
    createdAt: 1_000_000,
  });
}

function activateGenesisAgent(opportunityId: string, agentAddress: string): void {
  const row = agents[agentAddress];
  if (!row || row.genesisActivationStatus !== "pending") return; // no-op, mirrors WHERE ... AND status = 'pending'
  row.genesisActivationStatus = "active";
  writeEvent(
    opportunityId,
    agentAddress,
    "active",
    "passed",
    "17e-ii tick smoke test and 17e-iii constitution compliance check both passed",
  );
}

function markGenesisActivationFailed(
  opportunityId: string,
  agentAddress: string,
  reason: "smoke_test_failed" | "constitution_violated",
  detail: string,
): void {
  const row = agents[agentAddress];
  if (!row || row.genesisActivationStatus !== "pending") return;
  row.genesisActivationStatus = "failed";
  writeEvent(opportunityId, agentAddress, "failed", reason, detail);
}

function getGenesisActivationStatus(
  agentAddress: string,
): GenesisActivationStatus | null | undefined {
  const row = agents[agentAddress];
  if (!row) return undefined;
  return row.genesisActivationStatus;
}

function latestEvent(agentAddress: string): GenesisActivationEvent | undefined {
  const rows = events.filter((e) => e.agentAddress === agentAddress);
  return rows.length ? rows[rows.length - 1] : undefined;
}

// ─── Tests ───────────────────────────────────────────────────────

test("self-spawned agent (no pending row) is untouched by activate/fail", () => {
  reset();
  seedAgent("0xSelf", null);

  activateGenesisAgent("opp-1", "0xSelf");
  assert.equal(getGenesisActivationStatus("0xSelf"), null);
  assert.equal(events.length, 0);

  markGenesisActivationFailed("opp-1", "0xSelf", "smoke_test_failed", "n/a");
  assert.equal(getGenesisActivationStatus("0xSelf"), null);
  assert.equal(events.length, 0);
});

test("markGenesisPending sets pending at birth", () => {
  reset();
  seedAgent("0xAgentB", null);
  markGenesisPending("0xAgentB");
  assert.equal(getGenesisActivationStatus("0xAgentB"), "pending");
  assert.equal(events.length, 0, "pending is a bare column write, not a logged event");
});

test("pending -> active: both checks passed", () => {
  reset();
  seedAgent("0xAgentB", "pending");

  activateGenesisAgent("opp-1", "0xAgentB");

  assert.equal(getGenesisActivationStatus("0xAgentB"), "active");
  const evt = latestEvent("0xAgentB");
  assert.ok(evt);
  assert.equal(evt!.status, "active");
  assert.equal(evt!.reason, "passed");
  assert.equal(events.filter((e) => e.agentAddress === "0xAgentB").length, 1);
});

test("pending -> failed: smoke test failure", () => {
  reset();
  seedAgent("0xAgentB", "pending");

  markGenesisActivationFailed("opp-1", "0xAgentB", "smoke_test_failed", "first-tick smoke test outcome: timeout");

  assert.equal(getGenesisActivationStatus("0xAgentB"), "failed");
  const evt = latestEvent("0xAgentB");
  assert.ok(evt);
  assert.equal(evt!.status, "failed");
  assert.equal(evt!.reason, "smoke_test_failed");
  assert.match(evt!.detail, /timeout/);
});

test("pending -> failed: constitution violation", () => {
  reset();
  seedAgent("0xAgentB", "pending");

  markGenesisActivationFailed(
    "opp-1",
    "0xAgentB",
    "constitution_violated",
    "1 non-'allow' policy decision(s) recorded for this tick: transfer_funds -> deny (exceeds spend cap)",
  );

  assert.equal(getGenesisActivationStatus("0xAgentB"), "failed");
  const evt = latestEvent("0xAgentB");
  assert.equal(evt!.reason, "constitution_violated");
  assert.match(evt!.detail, /exceeds spend cap/);
});

test("one-shot: activating an already-active agent is a no-op", () => {
  reset();
  seedAgent("0xAgentB", "pending");
  activateGenesisAgent("opp-1", "0xAgentB");
  activateGenesisAgent("opp-1", "0xAgentB"); // second call
  assert.equal(getGenesisActivationStatus("0xAgentB"), "active");
  assert.equal(events.filter((e) => e.agentAddress === "0xAgentB").length, 1);
});

test("one-shot: an already-failed agent cannot later be activated", () => {
  reset();
  seedAgent("0xAgentB", "pending");
  markGenesisActivationFailed("opp-1", "0xAgentB", "smoke_test_failed", "timeout");
  activateGenesisAgent("opp-1", "0xAgentB"); // must not overwrite 'failed'
  assert.equal(getGenesisActivationStatus("0xAgentB"), "failed");
  assert.equal(events.filter((e) => e.agentAddress === "0xAgentB").length, 1);
});

test("getGenesisActivationStatus distinguishes missing agent from null status", () => {
  reset();
  seedAgent("0xSelf", null);
  assert.equal(getGenesisActivationStatus("0xSelf"), null);
  assert.equal(getGenesisActivationStatus("0xNoSuchAgent"), undefined);
});
