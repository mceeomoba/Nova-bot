// Upgrade from source-regex matching to a real functional test.
//
// The prior version of this file confirmed the fix existed by matching
// strings in socialRelay.ts's source text (`assert.match(route,
// /verifyPollAuth\(req\)/)` etc.) — that proves the right function is
// *called*, but not that the endpoint actually *behaves* correctly: a
// refactor that renamed verifyPollAuth but broke its logic, or reordered
// the to_address check, would still pass the old test. This version
// starts the real router on a real HTTP port, signs requests with a
// real EVM keypair the same way an agent's client would, and asserts on
// actual response bodies and status codes.
//
// Same live-DB convention as toolGrantsLiveRoundTrip.test.ts: dynamic
// import after setting DB_PATH to a fresh temp file and dummy values
// for config.ts's required env vars, so this never touches a real dev/
// prod database and works whether or not those vars are already set.

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { ulid } from "ulid";

const dbPath = path.join(os.tmpdir(), `automaton-socialrelay-status-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.BACKEND_API_KEY ??= "test-dummy";
process.env.ADMIN_API_KEY ??= "test-dummy";
process.env.OPENROUTER_API_KEY ??= "test-dummy";
process.env.FACILITATOR_PRIVATE_KEY ??= `0x${"1".repeat(64)}`;

const express = (await import("express")).default;
const { db } = await import("../db.js");
const socialRelayRouter = (await import("../socialRelay.js")).default;

const app = express();
app.use(express.json());
app.use(socialRelayRouter);

const server = await new Promise<http.Server>((resolve) => {
  const s = app.listen(0, () => resolve(s));
});
const port = (server.address() as { port: number }).port;
const baseUrl = `http://127.0.0.1:${port}`;

// Two real EVM keypairs — recipient (owns the message) and an outsider
// (does not), signing exactly the canonical string the route expects:
// `Automaton:poll:${address}:${timestamp}`.
const recipient = privateKeyToAccount(`0x${"a".repeat(64)}`);
const outsider = privateKeyToAccount(`0x${"b".repeat(64)}`);

async function signedHeaders(account: typeof recipient): Promise<Record<string, string>> {
  const timestamp = new Date().toISOString();
  const canonical = `Automaton:poll:${account.address}:${timestamp}`;
  const signature = await account.signMessage({ message: canonical });
  return {
    "x-wallet-address": account.address,
    "x-signature": signature,
    "x-timestamp": timestamp,
  };
}

// Seed one message addressed to `recipient` directly into the real DB,
// same table/columns the route reads from.
const messageId = ulid();
db.prepare(
  `INSERT INTO social_messages (id, from_address, to_address, content, signed_at, signature, status, retry_count, created_at)
   VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?)`,
).run(messageId, outsider.address, recipient.address, "hello", new Date().toISOString(), "0xdummy-signature-not-checked-by-status-route", Date.now());

test("recipient with a valid signature can read their own message status", async () => {
  const headers = await signedHeaders(recipient);
  const resp = await fetch(`${baseUrl}/v1/messages/${messageId}/status`, { headers });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.id, messageId);
  assert.equal(body.status, "received");
});

test("a different, validly-signed caller is rejected with 403 not your message", async () => {
  const headers = await signedHeaders(outsider);
  const resp = await fetch(`${baseUrl}/v1/messages/${messageId}/status`, { headers });
  assert.equal(resp.status, 403);
  const body = await resp.json();
  assert.equal(body.error, "not your message");
});

test("no auth headers at all is rejected with 401, not 200 or 403", async () => {
  const resp = await fetch(`${baseUrl}/v1/messages/${messageId}/status`);
  assert.equal(resp.status, 401);
});

test("a syntactically valid but wrong signature is rejected with 401", async () => {
  const timestamp = new Date().toISOString();
  const resp = await fetch(`${baseUrl}/v1/messages/${messageId}/status`, {
    headers: {
      "x-wallet-address": recipient.address,
      "x-timestamp": timestamp,
      // Signed by the wrong account for this address/timestamp pair.
      "x-signature": await outsider.signMessage({ message: `Automaton:poll:${recipient.address}:${timestamp}` }),
    },
  });
  assert.equal(resp.status, 401);
});

test("unknown message id is 404, checked only after auth succeeds", async () => {
  const headers = await signedHeaders(recipient);
  const resp = await fetch(`${baseUrl}/v1/messages/${ulid()}/status`, { headers });
  assert.equal(resp.status, 404);
});

test("cleanup", async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
});
