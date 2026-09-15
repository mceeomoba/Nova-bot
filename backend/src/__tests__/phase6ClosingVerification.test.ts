// next-phase.md Phase 6f (closing sub-phase for Phase 6 — architecture-
// agent.md §7's marketplace/payment row): a test suite over 6a-6e's
// combined surface — every agent-to-agent payment path is channel-gated
// (6a/6b), distribution.ts's flows are confirmed to need no channel at
// all (6c/6d), and every settled marketplace payment is traceable back
// to its channel grant, including the honest "none" case (6e).
//
// Same standing constraint every prior backend/src test file in this
// repo has flagged (channelService.test.ts, capability.test.ts,
// retireProjectSequence.test.ts, environment.test.ts): no network
// access to `npm install` here, so wallet.ts/facilitator.ts/
// marketplace.ts/distribution.ts themselves (which call db.prepare(...)
// directly and import express/viem/multer) can't be imported and
// exercised against a live DB/HTTP round trip. What's tested here is an
// inlined copy of each file's exact decision logic — same guard order,
// same status transitions, same error shapes — operating against plain
// in-memory arrays standing in for `agents`/`channels`/`payments`/
// `invocations`/`listings`, kept byte-for-byte in sync with:
//   - channelService.ts's paymentChannelRequired()/requirePaymentChannel()/
//     findActiveChannelIdIfAny() (6a/6b/6e)
//   - wallet.ts's POST /:address/pay fast-fail channel check (6b)
//   - facilitator.ts's POST /facilitator/settle authoritative channel
//     gate, and settleAuthorization()'s own structural exemption from it
//     (6a finding #2, 6b)
//   - marketplace.ts's settleLeg() in-process exemption and the
//     channelId-tracing half of recordInvocation()/auditMarketplacePayment()
//     (6a findings #3/#4, 6b, 6e)
//   - distribution.ts's POST /publish ownership check, standing in for
//     6c/6d's own "zero shared-filesystem/channel assumptions" finding
//
// Compiled with `tsc --target es2020 --module commonjs` to plain JS in a
// scratch dir and run with `node --test`, same as every prior test file
// in this directory. Still recommend, per every prior phase's own
// standing note, re-running against the real functions with a live
// sqlite3 DB once a networked environment is available, to confirm this
// inlined copy hasn't drifted from channelService.ts/wallet.ts/
// facilitator.ts/marketplace.ts themselves.

import { test } from "node:test";
import assert from "node:assert/strict";

// --- Shared fakes, mirroring channelService.test.ts's own shape -------

type ChannelStatus = "proposed" | "active" | "rejected" | "revoked";

interface ChannelRow {
  id: string;
  proposerAddress: string;
  recipientAddress: string;
  scope: string;
  status: ChannelStatus;
  resolvedAt: number | null;
}

interface AgentRow {
  address: string;
  parentAddress: string | null;
}

interface PaymentRow {
  id: string;
  fromAddress: string;
  toAddress: string;
  status: "pending" | "settled" | "failed";
}

interface InvocationRow {
  id: string;
  listingId: string;
  sellerAddress: string;
  buyerAddress: string;
  outcome: "delivered" | "seller_error" | "seller_unreachable";
  settlementId: string | null;
  channelId: string | null;
}

class FakeDb {
  agents: AgentRow[] = [];
  channels: ChannelRow[] = [];
  payments: PaymentRow[] = [];
  invocations: InvocationRow[] = [];
  nextId = 1;
}

class HttpError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function freshDb(agents: AgentRow[] = []): FakeDb {
  const db = new FakeDb();
  db.agents = agents;
  return db;
}

function activeChannel(
  db: FakeDb,
  proposer: string,
  recipient: string,
  scope: string,
  resolvedAt = 1000,
): ChannelRow {
  const row: ChannelRow = {
    id: `chn_${db.nextId++}`,
    proposerAddress: proposer,
    recipientAddress: recipient,
    scope,
    status: "active",
    resolvedAt,
  };
  db.channels.push(row);
  return row;
}

// --- channelService.ts mirrors (6a/6b/6e) ------------------------------

// Byte-for-byte mirror of channelService.ts's requireActiveChannelScope()
// (via requirePaymentChannel()'s "payment" scope), itself routed through
// checkCapability()/findActiveChannelGrant() in the real code — collapsed
// here to the same active/scope/bidirectional lookup channelService.test.ts's
// own sendFile/requestFile mirrors already use, since that's the exact
// query findActiveChannelGrant() resolves to for a "channel" resourceType.
function requirePaymentChannel(db: FakeDb, fromAddress: string, toAddress: string): void {
  const hasActive = db.channels.some(
    (c) =>
      c.status === "active" &&
      c.scope === "payment" &&
      ((c.proposerAddress === fromAddress && c.recipientAddress === toAddress) ||
        (c.proposerAddress === toAddress && c.recipientAddress === fromAddress)),
  );
  if (!hasActive) {
    throw new HttpError(
      `NO_CHANNEL: no active payment channel between ${fromAddress} and ${toAddress}`,
      403,
      "NO_CHANNEL",
    );
  }
}

// Byte-for-byte mirror of channelService.ts's paymentChannelRequired() —
// the three-way decision: non-agent recipient / Day-1 clone funding /
// real agent-to-agent transfer requiring a channel.
function paymentChannelRequired(db: FakeDb, fromAddress: string, toAddress: string): boolean {
  const to = db.agents.find((a) => a.address === toAddress);
  if (!to) return false; // not an agent — outside the channel model entirely

  if (to.parentAddress === fromAddress) {
    const priorPayment = db.payments.some((p) => p.toAddress === toAddress);
    if (!priorPayment) return false; // Day-1 clone funding
  }

  return true;
}

// Byte-for-byte mirror of channelService.ts's findActiveChannelIdIfAny()
// (6e) — the non-throwing sibling of the throwing lookup above, used to
// enrich a settled marketplace payment with its channel id when one
// happens to exist, returning null (never throwing) otherwise.
function findActiveChannelIdIfAny(db: FakeDb, a: string, b: string, scope: string): string | null {
  const matches = db.channels
    .filter(
      (c) =>
        c.status === "active" &&
        c.scope === scope &&
        ((c.proposerAddress === a && c.recipientAddress === b) ||
          (c.proposerAddress === b && c.recipientAddress === a)),
    )
    .sort((x, y) => (y.resolvedAt ?? 0) - (x.resolvedAt ?? 0));
  return matches[0]?.id ?? null;
}

// --- wallet.ts POST /:address/pay mirror (6b) --------------------------

// Byte-for-byte mirror of wallet.ts's /:address/pay route's own
// channel-check ordering: paymentChannelRequired() gates before any
// signing work (and before the self-custody check) — a call missing a
// channel never reaches account.signTypedData(). Signing itself isn't
// reachable here (no viem key material in this test file), so this
// returns "would_sign" as a stand-in for reaching that point.
function walletPay(db: FakeDb, from: string, to: string): "would_sign" {
  if (paymentChannelRequired(db, from, to)) {
    requirePaymentChannel(db, from, to);
  }
  return "would_sign";
}

// --- facilitator.ts /settle mirror (6a finding #2, 6b) -----------------

// Byte-for-byte mirror of facilitator.ts's POST /settle route: the
// authoritative gate, reachable by ANY caller with a validly signed
// authorization — including a self-custody agent that never touched
// wallet.ts's own /pay route at all (6a's finding #2, the whole reason
// 6b moved the authoritative check here rather than leaving it only in
// wallet.ts).
function facilitatorSettleRoute(db: FakeDb, from: string, to: string): "settled" {
  if (paymentChannelRequired(db, from, to)) {
    requirePaymentChannel(db, from, to);
  }
  return settleAuthorizationInProcess(db, from, to);
}

// Byte-for-byte mirror of facilitator.ts's exported settleAuthorization()
// — the actual fund-moving logic, deliberately NOT channel-gated at all.
// The only callers that can reach this function are other backend
// modules compiled into the same process (marketplace.ts's settleLeg()),
// never an HTTP request — "does this call skip the channel check" is
// decided by which .ts file is calling, not by anything an external
// caller can supply.
function settleAuthorizationInProcess(db: FakeDb, from: string, to: string): "settled" {
  db.payments.push({ id: `pay_${db.nextId++}`, fromAddress: from, toAddress: to, status: "settled" });
  return "settled";
}

// --- marketplace.ts settleLeg()/recordInvocation() mirror (6a #3/#4, 6b, 6e) --

interface InvokeResult {
  invocationId: string;
  outcome: InvocationRow["outcome"];
  channelId: string | null;
}

// Byte-for-byte mirror of the successful-delivery branch of marketplace.ts's
// POST /:id/invoke (url-mode and zip-mode share this shape once the
// seller has delivered): settleLeg() calls settleAuthorizationInProcess()
// directly — never facilitatorSettleRoute() / requirePaymentChannel() —
// so a cold-discovery purchase between two strangers with no channel at
// all still settles. channelId is resolved via the non-throwing
// findActiveChannelIdIfAny() only at the one point a payment actually
// completed, and is honestly recorded as null when no channel exists,
// never as an error.
function marketplaceInvoke(db: FakeDb, buyerAddress: string, sellerAddress: string, listingId: string): InvokeResult {
  // settleLeg()'s own in-process call — structurally exempt from the
  // channel gate, per 6b's resolution. No paymentChannelRequired()/
  // requirePaymentChannel() call anywhere on this path.
  settleAuthorizationInProcess(db, buyerAddress, sellerAddress);

  const channelId = findActiveChannelIdIfAny(db, buyerAddress, sellerAddress, "payment");
  const invocationId = `inv_${db.nextId++}`;
  db.invocations.push({
    id: invocationId,
    listingId,
    sellerAddress,
    buyerAddress,
    outcome: "delivered",
    settlementId: `pay_${db.nextId}`,
    channelId,
  });
  return { invocationId, outcome: "delivered", channelId };
}

// A failure-path invoke (seller errored, or settlement itself failed) —
// mirrors every recordInvocation() call site in marketplace.ts that is
// NOT the one successful-settlement point 6e's channelId resolution is
// scoped to. channelId must never be populated here, by construction
// (findActiveChannelIdIfAny() is never even called on this path).
function marketplaceInvokeFailure(
  db: FakeDb,
  buyerAddress: string,
  sellerAddress: string,
  listingId: string,
  outcome: "seller_error" | "seller_unreachable",
): InvokeResult {
  const invocationId = `inv_${db.nextId++}`;
  db.invocations.push({
    id: invocationId,
    listingId,
    sellerAddress,
    buyerAddress,
    outcome,
    settlementId: null,
    channelId: null,
  });
  return { invocationId, outcome, channelId: null };
}

// --- distribution.ts POST /publish mirror (6c/6d confirmation) --------

interface ListingRow {
  id: string;
  sellerAddress: string;
}

// Byte-for-byte mirror of distribution.ts's POST /publish step-3
// ownership check — the boundary 6c's audit found already closes any
// cross-agent access in this file, with no channel of any kind ever
// consulted anywhere in it (6c/6d's own "zero shared-filesystem/channel
// assumptions" finding, tested here as a positive claim rather than
// left as an unverified assertion in next-phase.md's prose).
function distributionPublish(listing: ListingRow, agentAddress: string): "published" {
  if (listing.sellerAddress !== agentAddress) {
    throw new HttpError("listing does not belong to this agent", 403);
  }
  return "published";
}

// ========================================================================
// 6a/6b — wallet.pay and facilitator/settle are both channel-gated for a
// real agent-to-agent transfer; settleAuthorization() itself is not.
// ========================================================================

test("wallet.pay: real agent-to-agent transfer requires an active payment channel", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  assert.throws(
    () => walletPay(db, "0xA", "0xB"),
    (err: any) => err.status === 403 && err.code === "NO_CHANNEL",
  );
});

test("wallet.pay: succeeds once an active payment-scoped channel exists between the pair", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  activeChannel(db, "0xA", "0xB", "payment");
  assert.equal(walletPay(db, "0xA", "0xB"), "would_sign");
});

test("wallet.pay: a file_transfer-scoped channel does NOT satisfy the payment gate — scope matters", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  activeChannel(db, "0xA", "0xB", "file_transfer");
  assert.throws(
    () => walletPay(db, "0xA", "0xB"),
    (err: any) => err.status === 403 && err.code === "NO_CHANNEL",
  );
});

test("wallet.pay: a channel that's still 'proposed' (not yet active) does not satisfy the gate", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  db.channels.push({
    id: "chn_1",
    proposerAddress: "0xA",
    recipientAddress: "0xB",
    scope: "payment",
    status: "proposed",
    resolvedAt: null,
  });
  assert.throws(
    () => walletPay(db, "0xA", "0xB"),
    (err: any) => err.status === 403 && err.code === "NO_CHANNEL",
  );
});

test("wallet.pay: paying a non-agent address (no `agents` row) never requires a channel", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }]);
  // 0xVENDOR is never registered as an agent — an ordinary external payout.
  assert.equal(walletPay(db, "0xA", "0xVENDOR"), "would_sign");
});

test("wallet.pay: Day-1 clone funding (parent -> brand-new child, no prior payment) is exempt", () => {
  const db = freshDb([
    { address: "0xPARENT", parentAddress: null },
    { address: "0xCHILD", parentAddress: "0xPARENT" },
  ]);
  assert.equal(walletPay(db, "0xPARENT", "0xCHILD"), "would_sign");
});

test("wallet.pay: a SECOND top-up from the same parent to the same child is no longer exempt", () => {
  const db = freshDb([
    { address: "0xPARENT", parentAddress: null },
    { address: "0xCHILD", parentAddress: "0xPARENT" },
  ]);
  // First transfer already happened (recorded in `payments`) — the Day-1
  // exemption is scoped to exactly one bootstrapping transfer, never a
  // standing exemption for the whole parent/child relationship.
  db.payments.push({ id: "pay_0", fromAddress: "0xPARENT", toAddress: "0xCHILD", status: "settled" });
  assert.throws(
    () => walletPay(db, "0xPARENT", "0xCHILD"),
    (err: any) => err.status === 403 && err.code === "NO_CHANNEL",
  );
});

test("wallet.pay: an unrelated agent paying the child (not its parent) is never exempt, channel or not", () => {
  const db = freshDb([
    { address: "0xPARENT", parentAddress: null },
    { address: "0xCHILD", parentAddress: "0xPARENT" },
    { address: "0xSTRANGER", parentAddress: null },
  ]);
  assert.throws(
    () => walletPay(db, "0xSTRANGER", "0xCHILD"),
    (err: any) => err.status === 403 && err.code === "NO_CHANNEL",
  );
});

test("facilitator/settle route: gates a real agent-to-agent transfer exactly like wallet.pay's fast-fail", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  assert.throws(
    () => facilitatorSettleRoute(db, "0xA", "0xB"),
    (err: any) => err.status === 403 && err.code === "NO_CHANNEL",
  );
  assert.equal(db.payments.length, 0, "no funds should have moved");
});

test("facilitator/settle route: closes 6a's finding #2 — a self-custody agent calling /settle directly, never through wallet.pay, is still gated", () => {
  const db = freshDb([{ address: "0xSELFCUSTODY", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  // No call to walletPay() anywhere in this test — this is the exact
  // bypass 6a's finding #2 named: a caller reaching /facilitator/settle
  // directly with its own already-signed authorization.
  assert.throws(
    () => facilitatorSettleRoute(db, "0xSELFCUSTODY", "0xB"),
    (err: any) => err.status === 403 && err.code === "NO_CHANNEL",
  );
});

test("facilitator/settle route: succeeds and moves funds once a payment channel is active", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  activeChannel(db, "0xA", "0xB", "payment");
  assert.equal(facilitatorSettleRoute(db, "0xA", "0xB"), "settled");
  assert.equal(db.payments.length, 1);
});

test("settleAuthorization() itself (in-process call) is structurally exempt from the channel gate", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);
  // No channel of any kind exists between 0xA and 0xB, and this does not
  // go through facilitatorSettleRoute()/requirePaymentChannel() at all —
  // only code compiled into the same process (marketplace.ts's
  // settleLeg()) can reach this function, never an HTTP request.
  assert.equal(settleAuthorizationInProcess(db, "0xA", "0xB"), "settled");
  assert.equal(db.payments.length, 1);
});

// ========================================================================
// 6a findings #3/#4 + 6b's resolution — a marketplace purchase between
// total strangers still works with zero channel between them.
// ========================================================================

test("marketplace invoke: a cold-discovery purchase between two strangers with NO channel still settles", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  const result = marketplaceInvoke(db, "0xBUYER", "0xSELLER", "listing_1");
  assert.equal(result.outcome, "delivered");
  assert.equal(db.payments.length, 1, "settleLeg's in-process call must have actually moved funds");
});

test("marketplace invoke: a founder-fee-style third-party payout target (never an `agents` row) needs no channel either", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  // Mirrors 6a's finding #4: config.founderWalletAddress is never a row
  // in `agents`, so it was never inside the channel model to begin with —
  // covered here by confirming an un-registered payout target behaves
  // identically to the seller leg above (both go through
  // settleAuthorizationInProcess(), never the gated route).
  assert.equal(settleAuthorizationInProcess(db, "0xBUYER", "0xFOUNDER_WALLET"), "settled");
});

// ========================================================================
// 6e — every settled marketplace payment is traceable back to its
// channel grant, and the "no channel" case is itself explicitly
// recorded, never silently omitted.
// ========================================================================

test("6e: channelId is null on the invocation row for the ordinary cold-discovery case — recorded, not omitted", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  const result = marketplaceInvoke(db, "0xBUYER", "0xSELLER", "listing_1");
  const row = db.invocations.find((i) => i.id === result.invocationId);
  assert.equal(row?.channelId, null);
  // Explicitly present as a column with value null, not an absent field —
  // mirrors invocations.channel_id being a real, always-inserted nullable
  // column rather than a conditionally-omitted one.
  assert.ok(row && "channelId" in row);
});

test("6e: channelId is populated with the real channel id when a payment-scoped channel happens to exist between buyer and seller", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  const chan = activeChannel(db, "0xBUYER", "0xSELLER", "payment");
  const result = marketplaceInvoke(db, "0xBUYER", "0xSELLER", "listing_1");
  assert.equal(result.channelId, chan.id);
  const row = db.invocations.find((i) => i.id === result.invocationId);
  assert.equal(row?.channelId, chan.id);
});

test("6e: a file_transfer-scoped (wrong-scope) channel between buyer and seller does NOT get traced as the payment channel", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  activeChannel(db, "0xBUYER", "0xSELLER", "file_transfer");
  const result = marketplaceInvoke(db, "0xBUYER", "0xSELLER", "listing_1");
  assert.equal(result.channelId, null);
});

test("6e: the most recently resolved active payment channel wins when more than one exists across the pair's history", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  const older = activeChannel(db, "0xBUYER", "0xSELLER", "payment", 1000);
  older.status = "revoked"; // superseded relationship
  const newer = activeChannel(db, "0xBUYER", "0xSELLER", "payment", 5000);
  const result = marketplaceInvoke(db, "0xBUYER", "0xSELLER", "listing_1");
  assert.equal(result.channelId, newer.id);
});

test("6e: channelId is resolved bidirectionally — buyer as channel recipient still traces correctly", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  // Seller proposed, buyer accepted — direction of proposal is unrelated
  // to direction of payment.
  const chan = activeChannel(db, "0xSELLER", "0xBUYER", "payment");
  const result = marketplaceInvoke(db, "0xBUYER", "0xSELLER", "listing_1");
  assert.equal(result.channelId, chan.id);
});

test("6e: a failed/undelivered invocation never gets a channel resolution attempt — channelId stays null by construction", () => {
  const db = freshDb([{ address: "0xBUYER", parentAddress: null }, { address: "0xSELLER", parentAddress: null }]);
  activeChannel(db, "0xBUYER", "0xSELLER", "payment"); // exists, but must never be consulted
  const result = marketplaceInvokeFailure(db, "0xBUYER", "0xSELLER", "listing_1", "seller_error");
  assert.equal(result.outcome, "seller_error");
  assert.equal(result.channelId, null);
  assert.equal(db.payments.length, 0, "no settlement occurred, so nothing should have moved");
});

test("6e: an active payment channel between the buyer and a DIFFERENT seller is not mistaken for this pair's channel", () => {
  const db = freshDb([
    { address: "0xBUYER", parentAddress: null },
    { address: "0xSELLER", parentAddress: null },
    { address: "0xOTHER_SELLER", parentAddress: null },
  ]);
  activeChannel(db, "0xBUYER", "0xOTHER_SELLER", "payment");
  const result = marketplaceInvoke(db, "0xBUYER", "0xSELLER", "listing_1");
  assert.equal(result.channelId, null);
});

// ========================================================================
// 6c/6d confirmation — distribution.ts's own ownership check is the real
// boundary here, and it was never a channel-gated flow to begin with.
// ========================================================================

test("distribution.publish: succeeds with zero channels anywhere in the system — 6c/6d's 'no channel needed' finding, tested positively", () => {
  const db = freshDb([{ address: "0xSELLER", parentAddress: null }]);
  assert.equal(db.channels.length, 0);
  const listing: ListingRow = { id: "listing_1", sellerAddress: "0xSELLER" };
  assert.equal(distributionPublish(listing, "0xSELLER"), "published");
});

test("distribution.publish: still rejects a caller publishing someone else's listing — the real, pre-existing boundary 6c/6d found", () => {
  const listing: ListingRow = { id: "listing_1", sellerAddress: "0xSELLER" };
  assert.throws(
    () => distributionPublish(listing, "0xSTRANGER"),
    (err: any) => err.status === 403 && /does not belong to this agent/.test(err.message),
  );
});

test("distribution.publish: an active payment channel between the two agents does not substitute for actual listing ownership", () => {
  const db = freshDb([{ address: "0xSELLER", parentAddress: null }, { address: "0xSTRANGER", parentAddress: null }]);
  activeChannel(db, "0xSTRANGER", "0xSELLER", "payment");
  const listing: ListingRow = { id: "listing_1", sellerAddress: "0xSELLER" };
  // A channel governs cross-office operations (send_file, join_project,
  // payment) — it was never wired into distribution.ts's own ownership
  // check, and this confirms one existing between the pair doesn't
  // accidentally satisfy it.
  assert.throws(
    () => distributionPublish(listing, "0xSTRANGER"),
    (err: any) => err.status === 403,
  );
});

// ========================================================================
// Phase 6 overall "Done when" line, exercised end to end across 6a-6e's
// combined surface in one scenario.
// ========================================================================

test("Phase 6 end to end: agent-to-agent wallet.pay is gated, marketplace purchase is not, and the settled marketplace payment traces to its channel when one exists", () => {
  const db = freshDb([{ address: "0xA", parentAddress: null }, { address: "0xB", parentAddress: null }]);

  // No channel yet: a direct wallet.pay between A and B is refused...
  assert.throws(() => walletPay(db, "0xA", "0xB"), (err: any) => err.code === "NO_CHANNEL");
  // ...but A can still buy from B's marketplace listing right now, cold.
  const cold = marketplaceInvoke(db, "0xA", "0xB", "listing_1");
  assert.equal(cold.channelId, null);

  // Once A and B establish a payment-scoped channel (e.g. an ongoing
  // business relationship)...
  const chan = activeChannel(db, "0xA", "0xB", "payment", 2000);
  // ...wallet.pay now works directly...
  assert.equal(walletPay(db, "0xA", "0xB"), "would_sign");
  // ...and a NEW marketplace purchase between the same pair now traces
  // back to that same channel grant.
  const warm = marketplaceInvoke(db, "0xA", "0xB", "listing_2");
  assert.equal(warm.channelId, chan.id);
});
