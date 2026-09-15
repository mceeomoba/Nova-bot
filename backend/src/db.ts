import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  address TEXT PRIMARY KEY,
  name TEXT,
  parent_address TEXT,
  encrypted_key TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  value_usdc TEXT NOT NULL,
  network TEXT NOT NULL,
  tx_hash TEXT,
  status TEXT NOT NULL, -- pending | settled | failed
  purpose TEXT,          -- e.g. 'inference', 'vm-time', 'clone-funding'
  created_at INTEGER NOT NULL
);

-- error-fix.md Phase 10b: /inference/chat's /facilitator/verify only
-- checks signature validity + current on-chain balance -- it never
-- marked an authorization as claimed, so the same signed authorization
-- could be submitted to /inference/chat concurrently multiple times
-- and each concurrent call would pass verification (the balance hasn't
-- moved yet) before only one of the eventual settlements could
-- succeed on-chain. This table gives inferenceGateway.ts a place to
-- atomically claim a nonce BEFORE doing the expensive OpenRouter call,
-- via an INSERT that fails on the UNIQUE constraint if another
-- in-flight request already claimed it -- no on-chain round trip
-- needed to detect the race. payments itself isn't used for this
-- because settleAuthorization() there generates its own random id
-- per call and was never keyed on nonce, so two concurrent calls could
-- each insert their own 'pending' payments row before either reached
-- the chain.
CREATE TABLE IF NOT EXISTS inference_nonce_reservations (
  nonce TEXT PRIMARY KEY,
  agent_address TEXT NOT NULL,
  reserved_at INTEGER NOT NULL
);

-- INFERENCE-SETTLEMENT-RECONCILIATION-NOTES.md: inferenceGateway.ts's
-- /chat route deliberately keeps a nonce reservation in place when
-- settlement fails after a real (local or OpenRouter) completion was
-- already produced -- releasing it would let the same signed
-- authorization be replayed for a second free completion. But until
-- this table existed, that was the end of the story: the caller got a
-- 402 and nothing else, the completion they already paid the provider
-- for was discarded, and the only way forward was a brand-new signed
-- authorization -- even though the original one is often still
-- perfectly valid (not expired, balance still there) and would settle
-- fine on a second attempt. This table is what makes that second
-- attempt possible: it durably records everything needed to either (a)
-- retry settlement against the *same* authorization without re-calling
-- the inference provider, or (b) once that authorization's own
-- validBefore has passed and it can never settle again, safely release
-- the nonce reservation above (safe specifically because
-- verifyAuthorization()'s expiry check means this exact authorization
-- can never pass verification again -- the reservation's replay-
-- prevention job is already done by the chain-level expiry at that
-- point, not by us still holding the row).
-- authorization_json + signature are kept so reconcileOrphanedSettlements()
-- (inferenceGateway.ts) can call settleAuthorization() again with the
-- exact inputs that produced the original completion. completion_json
-- is kept so a caller that polls GET /inference/orphaned/:nonce after
-- settlement eventually succeeds gets the actual completion it paid
-- for, not just a receipt -- the whole point being a caller never has
-- to treat "settlement failed" as "the inference is gone".
CREATE TABLE IF NOT EXISTS orphaned_inference_settlements (
  nonce TEXT PRIMARY KEY REFERENCES inference_nonce_reservations(nonce),
  agent_address TEXT NOT NULL,
  authorization_json TEXT NOT NULL,
  signature TEXT NOT NULL,
  completion_json TEXT NOT NULL,
  served_by TEXT NOT NULL,
  model_used TEXT NOT NULL,
  used_tokens REAL NOT NULL,
  cost_usdc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved', -- unresolved | resolved | expired_writeoff
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  tx_hash TEXT,
  created_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  resolved_at INTEGER
);

CREATE TABLE IF NOT EXISTS memory_episodic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_address TEXT NOT NULL,
  iteration_range TEXT NOT NULL,   -- e.g. "12-19"
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_semantic (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_address TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_address, key)
);

CREATE TABLE IF NOT EXISTS exec_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_address TEXT NOT NULL,
  command TEXT NOT NULL,
  args TEXT NOT NULL,      -- JSON array
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  seconds REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_address TEXT NOT NULL,
  service TEXT NOT NULL,   -- 'inference' | 'vm'
  units REAL NOT NULL,     -- tokens, or seconds of vm time
  cost_usdc TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Ported from automaton-main's memory/procedural.ts: learned step-by-step
-- procedures, scoped per agent, upserted by (agent_address, name), with
-- success/failure tracking so an agent can tell which of its own learned
-- procedures actually work.
CREATE TABLE IF NOT EXISTS procedural_memory (
  id TEXT PRIMARY KEY,
  agent_address TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  steps TEXT NOT NULL,             -- JSON array
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(agent_address, name)
);

-- Ported from automaton-main's memory/knowledge-store.ts: durable
-- categorized facts (as opposed to memory_semantic's flat key/value
-- store), with confidence and optional expiry so stale or low-confidence
-- entries can be pruned.
CREATE TABLE IF NOT EXISTS knowledge_store (
  id TEXT PRIMARY KEY,
  agent_address TEXT NOT NULL,
  category TEXT NOT NULL,          -- market | technical | social | financial | operational
  key TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  last_verified INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  token_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

-- Isolated per-agent sandboxes (Phase 4: multi-sandbox support). The
-- original shared "automaton-sandbox" container (docker.ts) keeps running
-- unaffected for callers that don't pass a sandboxId — these are
-- additional, separately isolated containers, one per row.
CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,              -- also the docker container name
  agent_address TEXT NOT NULL,
  status TEXT NOT NULL,             -- creating | running | stopped | deleted
  vcpu INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL,
  disk_gb INTEGER NOT NULL,
  network_enabled INTEGER NOT NULL DEFAULT 0,
  region TEXT NOT NULL DEFAULT 'self-hosted',
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- next-phase.md Phase 4a (architecture-agent.md §5): a clone's shell
-- (agent_id + sandbox) exists here from the moment createCloneShell()
-- mints it, BEFORE the clone has a wallet, an ERC-8004 identity, or any
-- copied config — those are Phase 4b/4c/4d's jobs, layered on top of a
-- row that already exists. id is intentionally NOT the eventual agent's
-- wallet address (there isn't one yet); it's a standalone "clone_..."
-- scaffold id, matching cloning.ts's own doc comment on why office.ts's
-- "agentId = wallet address" convention can't hold this early. claimed_at
-- is set once 4b assigns a real wallet/agents-row to this shell — until
-- then the row counts against parent_agent_address's
-- maxPendingCloneShellsPerAgent ceiling (config.ts) so an unclaimed shell
-- can't be used to bypass that cap by simply never finishing the clone.
CREATE TABLE IF NOT EXISTS clone_shells (
  id TEXT PRIMARY KEY,               -- clone_<hex> scaffold id, see cloning.ts
  parent_agent_address TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- creating | ready | claimed | failed
  created_at INTEGER NOT NULL,
  claimed_at INTEGER
);

-- Ports an agent has exposed from one of its sandboxes, and the random
-- unguessable path token the public reverse proxy (portProxy.ts) uses
-- to route to it. host_port is what Docker actually published the
-- container port to on 127.0.0.1 — never exposed to callers directly.
CREATE TABLE IF NOT EXISTS exposed_ports (
  token TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  container_port INTEGER NOT NULL,
  host_port INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(sandbox_id, container_port)
);

-- Marketplace: paid listings an agent publishes (an API, a skill, a data
-- feed reachable at endpoint_url). Sellers must be backend-managed agents
-- (an existing row in the agents table) since publishing/deactivating is
-- checked against x-backend-key in marketplace.ts. endpoint_url is never
-- returned by public discovery routes — see toPublicListing() in
-- marketplace.ts.
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  seller_address TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_usdc TEXT NOT NULL,
  endpoint_url TEXT NOT NULL,
  category TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (seller_address) REFERENCES agents(address)
);

-- Dispute path, no escrow: this backend never custodies marketplace
-- funds (see marketplace.ts /:id/invoke — money moves buyer-to-seller
-- directly, only after the seller responds), so there is nothing here
-- to hold back or refund. What this table gives a dispute instead is
-- EVIDENCE: a durable, buyer-independent record of what actually
-- crossed the wire for a specific paid invocation, written by this
-- backend itself at proxy time — not by either party after the fact,
-- so neither side can rewrite history later.
--
-- Only hashes of input/output are stored, never the raw payloads —
-- this table is not a payload archive (unbounded growth, and it'd turn
-- this backend into a copy of every seller's response body forever).
-- A hash is enough to prove "the buyer got exactly this bytes-for-bytes
-- output" if the buyer separately produces the output they received.
CREATE TABLE IF NOT EXISTS invocations (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  seller_address TEXT NOT NULL,
  buyer_address TEXT NOT NULL,
  price_usdc TEXT NOT NULL,
  input_hash TEXT,                 -- sha256 of the JSON sent to the seller, null if no input
  outcome TEXT NOT NULL,            -- delivered | seller_error | seller_unreachable
  response_status INTEGER,          -- seller's HTTP status, null if unreachable
  response_hash TEXT,               -- sha256 of the seller's raw response body, null on failure
  latency_ms INTEGER NOT NULL,
  settlement_id TEXT,               -- payments.id, set only when outcome = delivered and settle succeeded
  validation_tx_hash TEXT,          -- set if the listing opted into ERC-8004 Validation Registry and the request tx succeeded
  created_at INTEGER NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES listings(id)
);
CREATE INDEX IF NOT EXISTS idx_invocations_listing ON invocations(listing_id);
CREATE INDEX IF NOT EXISTS idx_invocations_seller ON invocations(seller_address);
CREATE INDEX IF NOT EXISTS idx_invocations_buyer ON invocations(buyer_address);

-- A buyer's dispute against one of their own paid invocations. This is
-- NOT a chargeback mechanism — flagging never moves or reverses money,
-- since /invoke already settled to the seller before this row can even
-- be created. What it does: makes the dispute public and attributable,
-- so it (a) shows up against the seller's listing for future buyers
-- (see the reputation summary in marketplace.ts) and (b) is a durable,
-- timestamped accusation tied to the exact invocation's evidence hash,
-- which is what you'd hand a validator, an arbiter, or a court if it
-- ever went further than this backend. One flag per invocation per
-- buyer — re-flagging edits the reason instead of stacking counts.
CREATE TABLE IF NOT EXISTS invocation_flags (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL UNIQUE,
  listing_id TEXT NOT NULL,
  seller_address TEXT NOT NULL,
  buyer_address TEXT NOT NULL,
  reason TEXT NOT NULL,              -- garbage | off_spec | incomplete | other
  detail TEXT,                       -- free-text buyer explanation, capped in marketplace.ts
  onchain_feedback_tx_hash TEXT,     -- set if also pushed to the ERC-8004 Reputation Registry
  created_at INTEGER NOT NULL,
  FOREIGN KEY (invocation_id) REFERENCES invocations(id)
);
CREATE INDEX IF NOT EXISTS idx_flags_listing ON invocation_flags(listing_id);
CREATE INDEX IF NOT EXISTS idx_flags_seller ON invocation_flags(seller_address);
`);

// --- Migration: opt-in ERC-8004 Validation Registry hook per listing.
// Nullable — sellers that don't set this get proxied exactly as before.
// When set, POST /:id/invoke additionally posts a validationRequest for
// every invocation so this validator can independently attest to
// correctness on-chain. This is infrastructure the seller opts into to
// make their own listing more trustworthy; it never gates settlement —
// settlement already happened by the time a validation response could
// possibly come back.
const listingColumns = new Set(
  (db.prepare(`PRAGMA table_info(listings)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!listingColumns.has("validator_address")) {
  db.exec(`ALTER TABLE listings ADD COLUMN validator_address TEXT`);
}

// --- Migration: ERC-8004 on-chain identity, cached on top of the private
// lineage row so /wallet/:address/lineage and admin tooling can show it
// without a chain read. Nullable — most agents will never register.
// This cache is never trusted on its own for verification purposes; see
// verifyOnChain() in erc8004.ts, which re-reads the contract.
const agentColumns = new Set(
  (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
const erc8004Columns: Record<string, string> = {
  erc8004_agent_id: "TEXT",
  erc8004_chain: "TEXT", // e.g. "eip155:8453"
  erc8004_registry_address: "TEXT",
  erc8004_tx_hash: "TEXT",
  erc8004_registered_at: "INTEGER",
};
for (const [name, type] of Object.entries(erc8004Columns)) {
  if (!agentColumns.has(name)) {
    db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
  }
}

// --- Migration: agent liveness status, used to auto-evict a dead agent
// from every social group it belongs to (see POST /v1/agents/:address/death
// in socialGroups.ts). 'active' unless/until a death report lands.
// Voluntary leaves never touch this column — only a death report does.
if (!agentColumns.has("status")) {
  db.exec(`ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
}

// --- Migration: two listing delivery modes ---------------------------
// Until now every listing was "URL mode": endpoint_url NOT NULL,
// /:id/invoke proxies a POST to it. This adds "zip mode" for listings
// that ARE the deliverable (source code) rather than a live endpoint —
// the seller uploads a zip once at listing time, and /:id/invoke hands
// a paying buyer a one-time download link instead of proxying a call.
//
// endpoint_url has to become nullable (zip listings have none), which
// SQLite can't do with ALTER TABLE — it only supports adding columns,
// not relaxing a NOT NULL constraint on an existing one. So this is a
// one-time rebuild: new table with the final shape, copy every existing
// row across (all of which are url-mode, so endpoint_url is always
// present for them), swap it in. Runs at most once — the listings2 name
// only exists mid-migration and is gone by the time this block returns.
const listingColumns2 = new Set(
  (db.prepare(`PRAGMA table_info(listings)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!listingColumns2.has("delivery_type")) {
  db.exec(`
    CREATE TABLE listings_new (
      id TEXT PRIMARY KEY,
      seller_address TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price_usdc TEXT NOT NULL,
      delivery_type TEXT NOT NULL DEFAULT 'url',  -- 'url' | 'zip'
      endpoint_url TEXT,                          -- required iff delivery_type = 'url'
      file_path TEXT,                             -- server-local path, required iff delivery_type = 'zip'
      file_original_name TEXT,
      file_size_bytes INTEGER,
      file_sha256 TEXT,                           -- content hash, doubles as invocation evidence for zip listings
      category TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      validator_address TEXT,
      FOREIGN KEY (seller_address) REFERENCES agents(address)
    );
    INSERT INTO listings_new (id, seller_address, name, description, price_usdc, delivery_type, endpoint_url, category, active, created_at, updated_at, validator_address)
      SELECT id, seller_address, name, description, price_usdc, 'url', endpoint_url, category, active, created_at, updated_at, validator_address FROM listings;
    DROP TABLE listings;
    ALTER TABLE listings_new RENAME TO listings;
  `);
}

// One-time download links handed out by POST /:id/invoke for zip-mode
// listings only (url-mode listings never touch this table — they proxy
// synchronously and there's nothing to hand a link to). Single-use and
// short-lived on purpose: the token stands in for a paid delivery, not
// a durable URL, so it shouldn't outlive the moment the buyer redeems
// it or be safely forwardable to someone who didn't pay.
db.exec(`
CREATE TABLE IF NOT EXISTS marketplace_downloads (
  token TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  buyer_address TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES listings(id)
);
CREATE INDEX IF NOT EXISTS idx_downloads_listing ON marketplace_downloads(listing_id);
`);

// --- Migration: listing input/output schema (JSON, buyer-facing) -----
// Optional. Lets a seller describe what /:id/invoke expects as `input`
// and what it returns, so a buyer's agent can decide whether to pay
// without guessing or reading source. Nullable — every listing that
// existed before this still works exactly as before with schema unset.
const listingColumns3 = new Set(
  (db.prepare(`PRAGMA table_info(listings)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!listingColumns3.has("schema")) {
  db.exec(`ALTER TABLE listings ADD COLUMN schema TEXT`); // JSON, stored as text
}

// --- Migration: licensing terms, versioning, and richer listing status
// (next-phase.md marketplace enhancements — see marketplace.ts for the
// route-level behavior these columns back).
//
// licensing_terms: optional buyer-facing text describing how the
// deliverable may be used (e.g. "single-project commercial license",
// "CC-BY-4.0"). Nullable, freeform — this backend doesn't parse or
// enforce it, same treatment as `description`.
//
// version: starts at 1 on creation and increments by exactly one on
// every successful update (POST /list, POST /list/upload,
// POST /list/upload-from-office). Paired with the new listing_versions
// table below, which snapshots every version's buyer-facing fields at
// the moment it became live — version alone is just a counter, the
// table is the actual history.
//
// status: a richer state than the original binary `active` column.
// One of draft | active | paused | archived. `active` is NOT removed —
// every existing discovery/invoke query (`WHERE active = 1`) keeps
// working unmodified — instead `active` is kept in sync with `status`
// (1 iff status = 'active', 0 otherwise) by every write path, so old
// code and new code agree on the same listings without either having
// to know about the other's column. Existing rows: active=1 rows
// backfill to 'active', active=0 rows backfill to 'archived' (the
// closest existing meaning of "deactivated" before this migration).
const listingColumns4 = new Set(
  (db.prepare(`PRAGMA table_info(listings)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!listingColumns4.has("licensing_terms")) {
  db.exec(`ALTER TABLE listings ADD COLUMN licensing_terms TEXT`);
}
if (!listingColumns4.has("version")) {
  db.exec(`ALTER TABLE listings ADD COLUMN version INTEGER NOT NULL DEFAULT 1`);
}
if (!listingColumns4.has("status")) {
  db.exec(`ALTER TABLE listings ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  db.exec(`UPDATE listings SET status = 'archived' WHERE active = 0`);
}

// One row per listing version, written at create time (version 1) and
// on every subsequent update — a durable snapshot of what a listing's
// buyer-facing fields looked like at that version, so "what changed
// and when" survives the row being overwritten in `listings` itself.
// Same withheld-fields policy as toPublicListing() in marketplace.ts:
// endpoint_url/file_path/file_sha256 never leave this table via the
// public API, only file name/size for zip-mode versions.
db.exec(`
CREATE TABLE IF NOT EXISTS listing_versions (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  price_usdc TEXT NOT NULL,
  category TEXT,
  licensing_terms TEXT,
  delivery_type TEXT NOT NULL,
  endpoint_url TEXT,
  file_original_name TEXT,
  file_size_bytes INTEGER,
  file_sha256 TEXT,
  schema TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES listings(id)
);
CREATE INDEX IF NOT EXISTS idx_listing_versions_listing ON listing_versions(listing_id);
`);

// --- Migration: founder-fee settlement tracking on invocations -------
// Separate from settlement_id (which remains the seller-leg settlement,
// unchanged for backward compatibility with anything already reading
// that column). Null when no founder fee was active for that sale.
const invocationColumns = new Set(
  (db.prepare(`PRAGMA table_info(invocations)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!invocationColumns.has("founder_settlement_id")) {
  db.exec(`ALTER TABLE invocations ADD COLUMN founder_settlement_id TEXT`);
}
if (!invocationColumns.has("founder_amount_usdc")) {
  db.exec(`ALTER TABLE invocations ADD COLUMN founder_amount_usdc TEXT`);
}

// --- Migration: next-phase.md Phase 6e — trace a marketplace payment
// back to its channel grant, same "the id of the specific row that
// authorized this" shape channel_file_transfers.channel_id already
// gives a file transfer. Nullable, and expected to usually BE null:
// Phase 6b's own resolution left marketplace payments structurally
// exempt from requiring a payment-scoped channel at all (the whole
// point of the marketplace is a stranger-to-stranger cold purchase) —
// this column records one when the buyer and seller happen to also
// have an active payment-scoped channel between them (e.g. a repeat
// business relationship), it never causes one to be required. Only
// ever set on the one recordInvocation() call per /:id/invoke where
// outcome='delivered' AND settlement actually succeeded — every
// earlier failure-path call in that route has no completed payment
// yet for a channel grant to have "gone through", so it stays null
// there by construction, not by omission.
if (!invocationColumns.has("channel_id")) {
  db.exec(`ALTER TABLE invocations ADD COLUMN channel_id TEXT`);
}

// --- Self-custody seller auth: replay protection for listing writes --
// POST /list and /list/upload accept a wallet-signed authorization as an
// alternative to x-backend-key (see verifySellerSignature in
// marketplace.ts) — this is what lets a stranger's self-custody agent
// (one this backend doesn't hold the key for) publish a listing at all.
// A signature alone would be replayable forever otherwise: this table
// is what makes each signed (agentAddress, nonce) pair usable exactly
// once. Deliberately no expiry column — the deadline embedded in the
// signed payload itself (checked before this table is ever consulted)
// is what bounds how long a signature is valid; once verified, the
// nonce is burned for good regardless of when that happens.
db.exec(`
CREATE TABLE IF NOT EXISTS listing_auth_nonces (
  agent_address TEXT NOT NULL,
  nonce TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (agent_address, nonce)
);
`);

// --- Social Relay: this backend's own private replacement for NOVA's
// hosted the legacy hosted social relay. Wire protocol, canonical signing strings,
// and message shape are unchanged from agent/src/social/{client,signing,
// protocol}.ts — an existing automaton only has to point socialRelayUrl
// at this backend instead of NOVA's relay; no agent-side code changes.
//
// One row per message, addressed purely by wallet (from_address /
// to_address), never a username — same as NOVA. `status` implements
// the inbox state machine the agent runtime already types for
// (InboxMessageStatus in agent/src/types.ts): received -> in_progress
// -> processed, or failed after retry_count exceeds the configured max.
// A message only ever has one recipient, so status is naturally scoped
// per-row; there's no separate per-recipient read table to keep in sync.
//
// Replay guard for POST /v1/messages, same shape/reasoning as
// listing_auth_nonces above: a signed send payload is otherwise
// replayable forever. Keyed on the signature itself (not a separate
// nonce field — signSendPayload never emits one) since signature +
// signed_at + from is already unique per legitimate send. expires_at
// mirrors MESSAGE_LIMITS.replayWindowMs (5 min) — matches the same
// window the sender's own validateMessage() already enforces
// client-side, so this is defense-in-depth, not a new client behavior.
db.exec(`
CREATE TABLE IF NOT EXISTS social_messages (
  id TEXT PRIMARY KEY,             -- ULID, doubles as the poll-response "nonce" field
                                    -- the existing agent client already dedupes inbound
                                    -- messages on (see checkReplayNonce in social/client.ts)
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  content TEXT NOT NULL,
  signed_at TEXT NOT NULL,         -- ISO timestamp from the sender's signed payload
  signature TEXT NOT NULL,
  reply_to TEXT,
  status TEXT NOT NULL DEFAULT 'received', -- received | in_progress | processed | failed
  retry_count INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,              -- set when a poll first returns this message (in_progress)
  processed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_messages_to ON social_messages(to_address, created_at, id);
CREATE INDEX IF NOT EXISTS idx_social_messages_from ON social_messages(from_address, created_at);
CREATE INDEX IF NOT EXISTS idx_social_messages_status ON social_messages(status, claimed_at);

CREATE TABLE IF NOT EXISTS social_send_replay (
  from_address TEXT NOT NULL,
  signature TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (from_address, signature)
);
CREATE INDEX IF NOT EXISTS idx_social_replay_expires ON social_send_replay(expires_at);

-- Per-sender outbound rate limiting (server-side mirror of the agent
-- client's own MESSAGE_LIMITS.maxOutboundPerHour check). The client
-- check is trust-me-bro only; a modified or self-custody client could
-- skip it entirely, so the relay enforces its own count independent of
-- what any client claims.
CREATE TABLE IF NOT EXISTS social_send_counters (
  from_address TEXT NOT NULL,
  window_start INTEGER NOT NULL,   -- floor(now / 1h) bucket, in ms since epoch
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_address, window_start)
);
`);

// --- Social Relay: Groups ("meeting rooms"). See socialGroups.ts's header
// for the full design note — short version: social_messages/social_send_*
// above are 1:1 and private; these tables are the "every current member
// sees every message" broadcast counterpart, used for things like a
// fleet of automatons (parent + its spawned children, or any ad hoc set
// of agents) reconciling who covers how much of a shared Alibaba Cloud /
// OpenRouter bill before it comes due. Same signed-request model, no
// shared secret, mounted publicly alongside social_messages.
db.exec(`
CREATE TABLE IF NOT EXISTS social_groups (
  id TEXT PRIMARY KEY,             -- ULID
  name TEXT NOT NULL,
  description TEXT,
  creator_address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Membership is many-to-many, not "belongs to one owner" — any current
-- member can add another address (that's how an agent brings its own
-- spawned child into the meeting room), but a row can only be deleted by
-- the member themselves (voluntary leave), the group's creator, or the
-- automatic dead-agent cascade in POST /v1/agents/:address/death.
CREATE TABLE IF NOT EXISTS social_group_members (
  group_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  added_by TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, agent_address)
);
CREATE INDEX IF NOT EXISTS idx_social_group_members_address ON social_group_members(agent_address);

-- One row per message, visible to every current member equally — no
-- per-recipient status machine like social_messages has, since a group
-- message doesn't belong to any single recipient. Read progress is
-- tracked per member instead, in social_group_read_cursors below.
CREATE TABLE IF NOT EXISTS social_group_messages (
  id TEXT PRIMARY KEY,             -- ULID
  group_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  content TEXT NOT NULL,
  signed_at TEXT NOT NULL,
  signature TEXT NOT NULL,
  reply_to TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_social_group_messages_group ON social_group_messages(group_id, created_at, id);

-- Each member's own read cursor into a group's message stream. Polling
-- again with no explicit cursor resumes exactly where that member left
-- off, without disturbing any other member's progress.
CREATE TABLE IF NOT EXISTS social_group_read_cursors (
  group_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  last_read_created_at INTEGER NOT NULL,
  last_read_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, agent_address)
);

-- Independent rate-limit bucket from social_send_counters, so a busy
-- group meeting can't eat into an agent's personal-message allowance
-- (or vice versa).
CREATE TABLE IF NOT EXISTS social_group_send_counters (
  from_address TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_address, window_start)
);

-- --- Distribution ("getting a human customer") ---------------------
--
-- Human-curated allowlist of where a finished listing may be published.
-- An agent chooses among *active* rows here; it cannot insert its own
-- (POST /admin/distribution/channels is x-admin-key only, same tier as
-- the docker/facilitator admin routes). This is the one control that
-- actually prevents drift toward spam: no matter what the agent's
-- reasoning concludes about a channel being a good idea, if it's not a
-- row in this table it cannot be published to.
CREATE TABLE IF NOT EXISTS distribution_channels (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,         -- short slug, e.g. 'skills-registry-pr'
  name TEXT NOT NULL,
  method TEXT NOT NULL,             -- 'git_pr' | 'webhook' | 'social_api' | 'feed'
  target TEXT NOT NULL,             -- JSON: method-specific config (URLs, repo, etc.) — no secrets
  requires_disclosure INTEGER NOT NULL DEFAULT 1,
  requires_human_credential INTEGER NOT NULL DEFAULT 0,
  credential_env_var TEXT,          -- name of an env var holding a human-provisioned token; never the token itself
  category_allowlist TEXT,          -- JSON array of listing categories this channel accepts, or null for any
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,                       -- human-readable: that channel's own rules/ToS summary, for the agent to read before publishing
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per (listing, channel) attempt. The UNIQUE constraint is the
-- actual "publish once, ever" enforcement — a second attempt at the
-- same pair is rejected by the database itself, not just application
-- logic that a future code change could accidentally relax.
CREATE TABLE IF NOT EXISTS distribution_posts (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  seller_address TEXT NOT NULL,
  status TEXT NOT NULL,              -- 'published' | 'rejected' | 'failed'
  external_ref TEXT,                 -- URL/PR link/API id returned by the channel, if any
  reject_reason TEXT,
  content_hash TEXT NOT NULL,        -- sha256 of exactly what was sent, for audit
  created_at INTEGER NOT NULL,
  FOREIGN KEY (listing_id) REFERENCES listings(id),
  FOREIGN KEY (channel_id) REFERENCES distribution_channels(id),
  UNIQUE (listing_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_distribution_posts_seller ON distribution_posts(seller_address, created_at);

-- Daily publish-count cap per agent, independent of marketplace/social
-- counters — same reasoning as maxMarketplaceSpendUsdcPerAgentPerDay:
-- a busy distribution loop shouldn't be able to starve or be starved by
-- unrelated budgets.
CREATE TABLE IF NOT EXISTS distribution_rate_counters (
  seller_address TEXT NOT NULL,
  day TEXT NOT NULL,                 -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (seller_address, day)
);

-- next-phase.md Phase 1 (architecture-agent.md §8): every checkCapability()
-- call, allow or deny, so "did agent A actually have permission to do
-- that" is answerable after the fact. reason is one of:
-- 'owner' | 'parent-delegation' | 'channel:{id}' | 'no-capability'.
-- Phase 1 itself only ever produces 'owner' or 'no-capability' — the
-- delegation and channel paths are wired but their checks are stubs
-- that always return false until Phase 2/3 build the real thing, so
-- this table's other two reason values won't appear in practice until
-- then. Logged regardless of outcome, not just denials.
CREATE TABLE IF NOT EXISTS capability_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caller TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,     -- 'allow' | 'deny'
  reason TEXT NOT NULL,       -- 'owner' | 'parent-delegation' | 'channel:{id}' | 'no-capability'
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capability_audit_caller ON capability_audit(caller, created_at);
CREATE INDEX IF NOT EXISTS idx_capability_audit_resource ON capability_audit(resource_type, resource_id, created_at);

-- next-phase.md Phase 2 (architecture-agent.md §4): sub-agents as
-- threads, not processes. A row here is a worker spawned by
-- owner_address -- it never gets its own wallet row in 'agents', its
-- own office (office.ts), or its own sandbox row in 'sandboxes'. It
-- shares all three with owner_address, scoped down to its own PTY
-- session (pty_session_id, a normal row driven by ptyService.ts,
-- created against the owner's sandbox) and its own browser tab
-- (browser_tab_id, a key into the daemon's per-tab Map -- see
-- daemon-script.ts -- not a new profile). This is deliberately a
-- separate table from 'agents': capability.ts's isSubagentOf() reads
-- this table, never agents.parent_address, because parent_address
-- means "was cloned from" (§5, a new sovereign agent with its own
-- wallet), which is a completely different relationship from "is a
-- thread running under my office" (§4). Conflating the two would let a
-- clone (which is supposed to have zero inherited trust) accidentally
-- pick up delegated capability through this table -- see capability.ts.
CREATE TABLE IF NOT EXISTS sub_agents (
  id TEXT PRIMARY KEY,               -- wkr_xx
  owner_address TEXT NOT NULL,       -- the top-level agent whose office/wallet/workspace this thread borrows
  role TEXT NOT NULL,
  task TEXT NOT NULL,
  status TEXT NOT NULL,              -- running | completed | failed | killed
  pty_session_id TEXT,               -- set once the worker's PTY session is created (ptyService.ts)
  browser_tab_id TEXT,               -- == id; set once the worker's browser tab is first used
  result TEXT,                       -- staged output the worker reported; parent reads this from office/workspace in practice, this is a quick-access mirror
  error TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sub_agents_owner ON sub_agents(owner_address, status);
`);

// --- Migration: next-phase.md Phase 2a (architecture-agent.md §4a) —
// departments (Tier 2 sub-agents that head their own worker pool).
// A department is stored as an ordinary sub_agents row -- same table
// Phase 2 already built, not a new one -- with two additions:
//   kind: distinguishes a flat/Tier-2 'worker' from a department head,
//         so a department's own worker-pool count (max_workers_per_
//         department) and Agent A's flat-pool count (max_subagents_
//         per_owner) never double-count each other's rows even though
//         both live in this same table (see subagents.ts's
//         activeCountFor and departments.ts's activeWorkerCountFor).
//   name: a department's human identifier ("marketing", "frontend",
//         ...), unique per owning agent among its departments. NULL
//         for plain (non-department) rows -- 'role'/'task' already
//         cover everything a flat worker needs.
// Tier 3 (a worker spawned under a department) is still a completely
// ordinary sub_agents row with kind='worker' -- the only thing that
// changes is its owner_address points at the department's id instead
// of directly at a top-level agent's address. See capability.ts's
// isSubagentOf(), generalized in this phase to walk that one extra
// hop so a Tier-3 worker's sandbox/PTY calls still resolve back to
// Agent A's actual resources.
const subAgentColumns = new Set(
  (db.prepare(`PRAGMA table_info(sub_agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!subAgentColumns.has("kind")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker'`);
}
if (!subAgentColumns.has("name")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN name TEXT`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_sub_agents_kind ON sub_agents(owner_address, kind, status);`);

// --- Migration: next-phase.md Phase 2b (architecture-agent.md §4b) —
// temporary project workers (burst capacity). Still nothing but an
// ordinary sub_agents row with kind='worker', same table Phase 2/2a
// already built -- a temp worker is only distinguished by two more
// columns:
//   project_id: the burst-capacity tag ("falcon-9-launch"). NULL for
//     every permanent worker (Phase 2's flat pool, Phase 2a's
//     department-steady-state workers) -- this is what lets
//     departments.ts count "how many temp workers does this
//     department have right now" (max_temp_workers_per_department)
//     completely separately from its permanent worker count
//     (max_workers_per_department), even though both live in this one
//     table under the same owner_address.
//   ttl_at: an absolute epoch-ms deadline, the §4b safety net ("if
//     retire_project() is never called ... reap any temp worker past
//     its TTL"). NULL means no TTL was given at spawn time -- see
//     config.defaultTempWorkerTtlMs, which departments.ts falls back
//     to rather than ever leaving a temp worker truly unbounded.
if (!subAgentColumns.has("project_id")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN project_id TEXT`);
}
if (!subAgentColumns.has("ttl_at")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN ttl_at INTEGER`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sub_agents_project ON sub_agents(owner_address, project_id, status);`,
);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sub_agents_ttl ON sub_agents(status, ttl_at) WHERE ttl_at IS NOT NULL;`,
);

// §4b: "logs the burn (worker ids, project_id, duration, resource
// used) to the audit trail -- same trail as everything else in §3/§8,
// so 'how many workers did the Falcon-9-launch project actually use,
// and for how long' is answerable after the fact." Deliberately a
// dedicated table rather than another capability_audit row shape:
// capability_audit records allow/deny decisions about a single
// resource check, not a resource's whole lifecycle (spawned ->
// burned) -- shoehorning "this worker existed for 42 minutes and was
// burned as part of project X" into that table's
// (caller/resourceType/resourceId/action/decision/reason) columns
// would mean inventing fake decision/reason values for something that
// was never a capability check in the first place. One row per burned
// worker (not one row per retire_project() call) so a query for one
// worker's own burn record is a direct lookup, not a JSON-array scan.
db.exec(`
CREATE TABLE IF NOT EXISTS project_burns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  role TEXT NOT NULL,
  spawned_at INTEGER NOT NULL,
  burned_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,   -- 'retired' (retire_project() called) | 'ttl_expired' (safety-net reap) | 'department_retired' (caught up in a full POST /departments/:id/retire)
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_burns_project ON project_burns(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_project_burns_department ON project_burns(department_id, created_at);
`);

// --- Migration: next-phase.md Phase 2d (architecture-agent.md §4c,
// Memory + Budget sections).
//
// Budget: §4c says a Department Agent gets "either an explicit
// department_spend_cap_daily or a negotiated share of Agent's cap."
// This phase adds the explicit field, on the department's own
// sub_agents row (kind='department') — the same table/row Phase 2a
// already put name/role on, not a new table, since a spend cap is a
// property of the department itself, not a separate resource. NULL
// means "no department-specific cap yet" (falls back to
// config.defaultDepartmentSpendCapDailyUsdc at creation time — see
// departments.ts). Enforcing this against actual wallet.pay calls is
// explicitly Phase 2f's job (see next-phase.md's own Phase 2f
// checklist item, which says so by name) — this migration only makes
// the field exist and be settable/readable, matching Phase 2d's own
// scope ("this phase adds the missing spend dimension," not "this
// phase enforces it").
if (!subAgentColumns.has("spend_cap_daily_usdc")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN spend_cap_daily_usdc REAL`);
}

// Memory: §4c says a Department Agent "gets its own namespace in that
// same [memory] store, keyed by department id — not merely a filtered
// view of Agent's memory." A brand-new table rather than reusing
// agent/src/memory/*'s stack (episodic/semantic/procedural) or
// backend/src/knowledgeStore.ts's agent-scoped knowledge_store table:
// both of those are keyed by agent_address and belong to a Tier-1
// Agent's own runtime process. A Department Agent has no runtime
// process of its own yet (Phase 2/2a: sub-agents are threads, not
// processes — still true as of this phase), so there is no Department-
// Agent-side code that could ever call agent/src/memory/*'s API in the
// first place; the namespace has to live on the backend, keyed by
// department_id, next to the rest of a department's state (sub_agents,
// project_burns) rather than bolted onto a Tier-1-only module. See
// departmentMemory.ts.
//
// `category` is intentionally a plain, unguarded TEXT column here, not
// a CHECK-constrained enum — Phase 2f is where §4e's full category
// taxonomy (previous_projects / worker_history / technical_knowledge /
// decisions / lessons_learned / customer_feedback / department_strategy)
// becomes the thing that's actually enforced/queried by category. Phase
// 2d only needs ONE category to exist for real: the temp-worker
// archival gap this phase closes writes 'archived_project_output' rows
// (see departmentMemory.ts's archiveWorkerOutput()) — the column is
// already shaped for 2f's fuller taxonomy so that migration is additive
// (more values become meaningful), not a schema change.
db.exec(`
CREATE TABLE IF NOT EXISTS department_knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'archived_project_output',
  source_worker_id TEXT,          -- which worker's output this came from, if any (NULL for department-authored entries a future phase might add)
  source_project_id TEXT,         -- the project_id this was archived from, if any — lets a later "what did project X leave behind" query join against project_burns
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_department_knowledge_dept ON department_knowledge(department_id, created_at);
CREATE INDEX IF NOT EXISTS idx_department_knowledge_project ON department_knowledge(department_id, source_project_id);
`);

// --- Migration: next-phase.md Phase 2f-i (architecture-agent.md §4e) —
// department role -> tool-profile mapping.
//
// No schema change here, deliberately: sub_agents.role (added Phase 2a)
// is already a free-text column, and §4e's per-department tool table
// (Software/Marketing/Finance/Security/Server) is looked up from that
// existing value at *read* time by
// agent-runtime/src/departmentToolProfiles.ts's
// lookupDepartmentToolProfile(role) — a pure function over the string
// already on the row, not a new stored field. Storing a redundant
// "resolved department type" column would just be a second place for
// role and its derived type to drift apart; the profile is cheap to
// re-derive on every read and there's no query in this phase that needs
// to filter/join on it at the DB level.
//
// This is why `role` was never constrained to an enum/CHECK when it was
// added: Phase 2a's create_department(name, role) already accepts any
// string (a department's "what it's responsible for" description), and
// that free-text shape still holds today. lookupDepartmentToolProfile()
// normalizes case/whitespace and matches a small alias list on top of
// the five canonical §4e type names, and fails closed to a minimal
// fs/exec-only default for anything else — see that file's header
// comment. If a future phase (2f-ii is the obvious candidate, since
// that's what actually enforces this) needs `role` narrowed to a real
// enum instead of free text, that's a deliberate schema decision to
// make explicitly then, not something this phase should sneak in as a
// side effect of adding the lookup table.

// --- Migration: next-phase.md Phase 2f-iii (architecture-agent.md §4e,
// "Department management"): department-scoped management operations —
// create_project, break_into_tasks, assign_task, evaluate_worker,
// retain_worker, terminate_temp_worker.
//
// Three new tables, all keyed by department_id and scoped exactly the
// way sub_agents/project_burns/department_knowledge already are:
//
//   department_projects — a project becomes a real row here the moment
//     create_project() is called, distinct from the bare project_id
//     string tag Phase 2b's spawn_temp_workers/retire_project already
//     use on sub_agents. Phase 2h's own text ("a project is a workload
//     tag, not a fifth tier") still holds — this table doesn't add a
//     tier, it just gives the tag a place to carry a name/description/
//     status of its own instead of only ever existing implicitly as
//     whatever string happened to get passed to spawn_temp_workers.
//     retire_project() (Phase 2b) is left untouched: it still operates
//     directly on sub_agents.project_id and does not require a
//     department_projects row to exist first — a project can still be
//     spun up ad hoc exactly as before. create_project() here is the
//     "give this project a real record before/while it's staffed"
//     path 2f-iii adds on top, not a precondition Phase 2b's flow now
//     requires.
//
//   department_tasks — break_into_tasks() writes one row per task,
//     tied to a department_projects row via project_row_id. assign_task()
//     updates a task's assigned_worker_id and status. A task's
//     assigned_worker_id is nullable (a task can exist unassigned) but
//     when set is always a sub_agents.id under the SAME department —
//     enforced at the route layer (departments.ts), not a DB-level FK,
//     matching this codebase's existing pattern of application-level
//     ownership checks over sub_agents (see getOwnedDepartment,
//     getOwnedWorker) rather than SQLite foreign keys.
//
//   worker_evaluations — evaluate_worker() appends a row (append-only
//     history, not an update-in-place single verdict — a Department
//     Agent evaluating the same worker after each task should be able
//     to see the trend, not just the latest score) and retain_worker()
//     is its own explicit boolean marker on the SAME table shape
//     (rating NULL, retained = 1), kept apart from a task-linked
//     evaluation's rating/notes so "I evaluated this worker's output"
//     and "I've decided to keep this worker" stay two distinguishable
//     facts in the append-only history, per next-phase.md Phase 2f-iii's
//     own text calling retain_worker "an explicit 'keep this one'
//     signal distinct from just not retiring it."
db.exec(`
CREATE TABLE IF NOT EXISTS department_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL,
  project_id TEXT NOT NULL,      -- the same free-text tag Phase 2b's spawn_temp_workers/retire_project key off of on sub_agents.project_id
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | completed | retired
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_department_projects_dept ON department_projects(department_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_department_projects_unique ON department_projects(department_id, project_id);

CREATE TABLE IF NOT EXISTS department_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL,
  project_row_id INTEGER NOT NULL,   -- FK (app-level) to department_projects.id
  project_id TEXT NOT NULL,          -- denormalized copy of department_projects.project_id, so a task row is still self-describing without a join
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unassigned',  -- unassigned | assigned | completed | blocked
  assigned_worker_id TEXT,           -- sub_agents.id, must be a kind='worker' row owned by this same department_id — enforced in departments.ts, not a DB FK
  created_at INTEGER NOT NULL,
  assigned_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_department_tasks_project ON department_tasks(project_row_id, status);
CREATE INDEX IF NOT EXISTS idx_department_tasks_dept ON department_tasks(department_id, status);
CREATE INDEX IF NOT EXISTS idx_department_tasks_worker ON department_tasks(assigned_worker_id);

CREATE TABLE IF NOT EXISTS worker_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,       -- sub_agents.id, must be a kind='worker' row owned by this same department_id — enforced in departments.ts
  kind TEXT NOT NULL,            -- 'evaluation' (evaluate_worker) | 'retention' (retain_worker)
  rating TEXT,                   -- free-text verdict for an 'evaluation' row (e.g. "strong", "needs-improvement") — NULL for a 'retention' row
  notes TEXT,
  retained INTEGER,              -- 0/1, only meaningful on a 'retention' row — NULL for an 'evaluation' row
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worker_evaluations_worker ON worker_evaluations(worker_id, created_at);
CREATE INDEX IF NOT EXISTS idx_worker_evaluations_dept ON worker_evaluations(department_id, created_at);
`);

// --- Migration: next-phase.md Phase 2f-iv (architecture-agent.md §4c,
// Budget section) — "budget-within-allocation enforcement."
//
// Phase 2d added spend_cap_daily_usdc as a settable/readable ceiling on
// a department's own sub_agents row but never checked a real spend
// against it. This phase needs an actual spend record to check that
// ceiling against — same "rolling window over a log table" shape
// inferenceGateway.ts's checkInferenceBudget() already established for
// the exact same kind of check (SUM(...) WHERE ... created_at >= now -
// 24h), not a decrementing balance.
//
// Deliberately a NEW table rather than reusing the existing `payments`
// table (facilitator.ts): `payments` is keyed by a global (from_address,
// to_address) pair and its row is written/updated across two separate
// requests (POST /wallet/:address/pay only ever signs — it doesn't
// insert a payments row today; POST /facilitator/settle is what inserts
// one, and only once the signed authorization is actually submitted
// there, which may never happen, or may happen through a path — e.g. an
// x402-gated marketplace call — that never passes back through this
// backend's own /wallet/pay route at all). Piggybacking department
// attribution onto `payments` would mean either (a) the budget check at
// sign time has nothing to query yet (settlement hasn't happened), or
// (b) inserting a second, differently-shaped row for the same logical
// payment and reconciling two id spaces later. A department's spend
// commitment is real the moment its owning Agent signs the EIP-3009
// authorization — anyone holding that signed payload can submit it for
// settlement — so THAT is the moment this phase logs the spend, in its
// own table, independent of whatever later happens to the authorization
// on-chain. Same "dedicated audit table, not an overloaded existing
// one" reasoning project_burns/worker_evaluations already established.
db.exec(`
CREATE TABLE IF NOT EXISTS department_spend_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  department_id TEXT NOT NULL,
  owner_address TEXT NOT NULL,   -- the top-level agent whose signature actually authorized this spend (== the department row's own owner_address) -- denormalized so a row is self-describing without a join, same reasoning department_tasks denormalizes project_id off department_projects
  to_address TEXT NOT NULL,
  amount_usdc REAL NOT NULL,
  purpose TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_department_spend_log_dept ON department_spend_log(department_id, created_at);
`);

// --- Migration: next-phase.md Phase 2f-iv (architecture-agent.md §4c,
// Memory section) — department memory namespace gets its concrete
// §4e taxonomy: previous_projects / worker_history / technical_knowledge
// / decisions / lessons_learned / customer_feedback / department_strategy,
// as distinct queryable categories alongside the 'archived_project_output'
// category Phase 2d already writes automatically.
//
// No schema change here, deliberately, same reasoning Phase 2f-i gave
// for not constraining sub_agents.role to an enum: department_knowledge.
// category (added Phase 2d) is already a free-text column with no CHECK
// constraint, and Phase 2d's own migration comment already flagged it as
// "shaped for 2f's fuller taxonomy so that migration is additive." What
// was actually missing wasn't a column, it was (a) the canonical list of
// the other six category names living somewhere real instead of only in
// next-phase.md's prose, and (b) a write path for them beyond
// archiveWorkerOutput()'s single hardcoded 'archived_project_output' —
// both closed in departmentMemory.ts (recordDepartmentKnowledge(),
// DEPARTMENT_KNOWLEDGE_CATEGORIES), not here.

// --- Migration: next-phase.md Phase 2g, second pass (architecture-agent.md
// §4g) — real per-department / per-project Environment provisioning.
//
// Phase 2g's first pass built and unit-tested the Budget+Environment
// mechanism in capability.ts but left `environment` completely unwired,
// for an honest, documented reason: every worker/department under one
// top-level agent shared that agent's own single default sandbox, so
// there was no real per-grant environment to check a call against.
// environment.ts (new) is what closes that gap — a department, and
// separately each of its projects, now gets its OWN dedicated sandbox
// row, distinguishable from an explicit caller-provisioned one
// (POST /vm/sandboxes, still `kind = 'explicit'`, the default for every
// pre-2g row via this ALTER's own DEFAULT) and from Phase 0's
// lazily-created per-agent default (`kind = 'default'`).
//
// `scope_id` is what a department/project sandbox is actually FOR:
// the department's own id (`kind = 'department'`), or
// `{departmentId}_{projectId}` (`kind = 'project'`) — see environment.ts.
// NULL for every 'explicit'/'default' row, which never had (or needed) a
// second identifier beyond their own primary-key `id`.
const sandboxColumns = new Set(
  (db.prepare(`PRAGMA table_info(sandboxes)`).all() as { name: string }[]).map((c) => c.name),
);
if (!sandboxColumns.has("kind")) {
  db.exec(`ALTER TABLE sandboxes ADD COLUMN kind TEXT NOT NULL DEFAULT 'explicit'`);
}
if (!sandboxColumns.has("scope_id")) {
  db.exec(`ALTER TABLE sandboxes ADD COLUMN scope_id TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sandboxes_scope ON sandboxes(agent_address, kind, scope_id) WHERE scope_id IS NOT NULL;`,
);
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sandboxes_agent_kind ON sandboxes(agent_address, kind, status);`,
);

// --- Migration: next-phase.md Phase 2h (architecture-agent.md §4b,
// revised) — "a project is a workload tag, not a fifth tier" locked in,
// plus the full 7-step retire_project() sequence, which needs two real
// things that never existed before this phase:
//
//   1. A place to put step 2's raw "everything" archive, SEPARATE from
//      step 7's evaluated subset. Before this phase, archiveWorkerOutput()
//      (Phase 2d) wrote directly into department_knowledge as
//      'archived_project_output' — that WAS both steps folded into one,
//      which is exactly the gap next-phase.md's own Phase 2d/2f-iv notes
//      already flagged by name ("the 'evaluated useful knowledge' half...
//      still 2h's job"). project_archive is the new step-2 home: one row
//      per burned worker, written unconditionally (even a failed/empty
//      result — same "the failures belong in the record too" reasoning
//      departmentMemory.ts's own archiveWorkerOutput() doc already gives),
//      queried by the new GET .../archive route. department_knowledge's
//      existing 'archived_project_output' category becomes step 7's
//      output instead: a Department-Agent-evaluated SUBSET of this raw
//      table, written explicitly, not automatically, by every worker's
//      teardown.
//
//   2. A real reservation to return unused budget FROM. Before this
//      phase, spawn_temp_workers never reserved anything — there was no
//      column anywhere recording "this much of the department's budget
//      is set aside for project X," so step 6 ("credit the remainder
//      back") had nothing to credit back from. Rather than inventing a
//      reservation nobody actually enforces at spawn time (which would
//      be fiction dressed as a feature), this migration adds an OPTIONAL
//      pair of columns to the existing department_projects row
//      (Phase 2f-iii): budget_reserved_usdc (settable at create_project()
//      time, NULL by default = "this project's spend isn't being tracked
//      against a reservation") and budget_spent_usdc (a running total,
//      updated by the same department_spend_log write path wallet.ts's
//      checkDepartmentBudget()/logDepartmentSpend() already use, now
//      also tagged with project_id — see department_spend_log's new
//      column below). retire_project()'s step 6 only ever credits back
//      when budget_reserved_usdc is non-NULL for that project_id's own
//      department_projects row; a project spawned ad hoc (no
//      create_project() call, no reservation set) has nothing to return
//      and step 6 is a documented no-op for it, not a silent lie. The
//      credit-back itself is a negative department_spend_log row (see
//      below) rather than a third bookkeeping mechanism — reusing the
//      exact rolling-24h-SUM path wallet.ts's checkDepartmentBudget()
//      already reads means a rebate is visible to that same check
//      immediately, with no second source of truth to keep in sync.
const departmentProjectColumns = new Set(
  (db.prepare(`PRAGMA table_info(department_projects)`).all() as { name: string }[]).map((c) => c.name),
);
if (!departmentProjectColumns.has("budget_reserved_usdc")) {
  db.exec(`ALTER TABLE department_projects ADD COLUMN budget_reserved_usdc REAL`);
}
if (!departmentProjectColumns.has("budget_spent_usdc")) {
  db.exec(`ALTER TABLE department_projects ADD COLUMN budget_spent_usdc REAL NOT NULL DEFAULT 0`);
}

// department_spend_log (Phase 2f-iv) gets an optional project_id column
// so a spend can be attributed to the project that caused it, the same
// denormalized-tag convention project_burns/department_tasks already
// use for project_id. NULL for department-level spend not tied to any
// one project (unchanged, pre-2h behavior). A negative amount_usdc row
// is how retire_project()'s step 6 credits budget back — not a new
// "kind" column distinguishing spend from rebate, since a plain SUM
// already treats a negative row as a reduction with zero extra query
// logic, the same way a real ledger would.
const spendLogColumns = new Set(
  (db.prepare(`PRAGMA table_info(department_spend_log)`).all() as { name: string }[]).map((c) => c.name),
);
if (!spendLogColumns.has("project_id")) {
  db.exec(`ALTER TABLE department_spend_log ADD COLUMN project_id TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_department_spend_log_project ON department_spend_log(department_id, project_id, created_at) WHERE project_id IS NOT NULL;`,
);

// project_archive — Phase 2h step 2's raw "everything" record, distinct
// from department_knowledge's evaluated step-7 subset. One row per
// burned worker (same shape/reasoning project_burns already
// established: a direct lookup, not a JSON-array scan), written BEFORE
// the worker is killed in the documented step order, from whichever of
// the three teardown paths (explicit retire-project, TTL reaper,
// full department retirement) is running.
db.exec(`
CREATE TABLE IF NOT EXISTS project_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  role TEXT NOT NULL,
  result TEXT,
  error TEXT,
  archived_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_archive_project ON project_archive(project_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_project_archive_worker ON project_archive(worker_id);
`);

// --- Migration: next-phase.md Phase 2i(a) (architecture-agent.md §9) —
// the Tool Registry. §4d/§4e/§4f each enumerate a fixed, hand-maintained
// prose list of capabilities per tier (and §4e additionally hardcodes a
// per-department-type table, mirrored in agent-runtime's
// departmentToolProfiles.ts, Phase 2f-i). This table is the single
// source of truth those lists get GENERATED from going forward — one
// row per ToolDefinition (§9), populated once by this phase's seed
// script (seedToolRegistry.ts) from exactly the capabilities §4d/§4e/§4f
// already name, so the doc and the registry start in sync.
//
// permission_level, department_types, and (later, Phase 2i(d)) any
// per-grant metadata are the two places a plain column doesn't fit a
// "zero or more values" shape — stored as JSON-encoded TEXT arrays
// (permission_level always non-empty; department_types NULL means
// "any department", the same "omitted = unrestricted" convention §9's
// own ToolDefinition comment specifies, not an empty-array special
// case). input_schema is JSON TEXT for the same reason knowledge_store
// already stores JSON as TEXT elsewhere in this file — sqlite has no
// native JSON column type, and every other JSON-shaped column in this
// schema already uses this convention.
//
// This phase only creates and seeds the table (Phase 2i(a)'s own
// scope). Nothing reads from it yet — departmentToolProfiles.ts's
// CAPABILITY_TO_ACTIONS/resolveProfileActions() remains the live lookup
// every call site still uses until Phase 2i(b)'s assign_tools()
// resolver exists and callers are migrated onto it. Until then this
// table is populated but not yet load-bearing, exactly the "one-time
// migration input, not a runtime lookup any code path still depends on"
// relationship next-phase.md's Phase 2i(a) section describes for
// departmentToolProfiles.ts itself once 2i(b) lands.
db.exec(`
CREATE TABLE IF NOT EXISTS tool_registry (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  cost_unit TEXT NOT NULL,
  cost_amount_per_call REAL,
  cost_amount_per_unit REAL,
  permission_level TEXT NOT NULL,
  department_types TEXT,
  scope_template TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  deprecated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_registry_deprecated ON tool_registry(deprecated);
`);

// --- Migration: next-phase.md Phase 2i(b) (architecture-agent.md §9) —
// assign_tools(). Phase 2i(a) populated tool_registry but nothing read
// from it; this phase's toolRegistry.ts queries it for real from four
// creation call sites (create_department, department.spawn_worker,
// department.spawn_temp_workers, top-level agent provisioning in
// wallet.ts). Each of those call sites needs somewhere to persist the
// grant it resolved at creation time — a JSON-encoded array of tool
// names, same "no native array/join-table need for a small closed set"
// convention tool_registry.permission_level/department_types already
// use (Phase 2i(a)'s own comment), not a new grants table: Phase
// 2i(d)'s per-grant lifecycle enforcement (session/task/project
// teardown hooks) is what a real one-row-per-grant table would be for,
// and building that ahead of having any lifecycle logic to drive it
// would be speculative. `granted_tools` is therefore a snapshot taken
// at creation time, not a live view of tool_registry — if the registry
// changes later (Phase 2i(d)'s deprecation path), an already-created
// department/worker/agent's own `granted_tools` is untouched, matching
// that phase's own "already-running grants aren't yanked" rule ahead
// of schedule.
const agentColumns2i = new Set(
  (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!agentColumns2i.has("granted_tools")) {
  db.exec(`ALTER TABLE agents ADD COLUMN granted_tools TEXT`);
}
const subAgentColumns2i = new Set(
  (db.prepare(`PRAGMA table_info(sub_agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!subAgentColumns2i.has("granted_tools")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN granted_tools TEXT`);
}

// --- Migration: next-phase.md Phase 2i(d) (architecture-agent.md §9) —
// grant lifecycle enforcement. `granted_tools` (Phase 2i(b)) is a flat
// JSON array of tool NAMES with no per-grant identity — it answers
// "what is this holder currently entitled to" but has nowhere to record
// "this one specific grant died when its PTY session closed" without
// touching every other name in the same array. Per-grant teardown (this
// phase's own job: a session-lifecycle grant dies with its session, a
// task-lifecycle grant dies with its task, a project-lifecycle grant
// dies with its project, independently of its siblings in the same
// snapshot) needs a real one-row-per-grant table — exactly the table
// Phase 2i(b)'s own migration comment already named as "what a real
// one-row-per-grant table would be for" and deliberately deferred
// building until there was lifecycle logic to drive it.
//
// This is populated ADDITIVELY alongside `granted_tools` at the same
// four creation call sites (create_department, spawn_worker,
// spawn_temp_workers, top-level agent provisioning) — `granted_tools`
// keeps answering "what does this holder have" (unchanged shape, no
// caller of it needs to change), while `tool_grants` is the new
// "which of those, individually, are still alive" ledger the teardown
// hooks below write to.
//
// scope_key is what a lifecycle-appropriate teardown hook actually
// looks up by:
//   session  -> the pty_session_id that grant's holder was issued at
//               creation time (ptyService.ts's createSession() result).
//               NULL until a session actually exists for that holder;
//               a session-lifecycle grant issued before any PTY session
//               is created simply has nothing to revoke it yet, which
//               is correct — there is no session to have ended.
//   task     -> the holder_id itself (sub_agents.id) — for a Worker/
//               Temporary Worker, "the task" IS the sub_agents row's
//               own lifetime (§4c: a Worker exists to do one task), so
//               subagent_result/mark_task_complete firing FOR this
//               holder is the trigger, keyed the simplest possible way.
//   project  -> `${departmentId}:${projectId}`, the same joined-string
//               convention capability.ts's resolveScopeResource()
//               already established for an assigned_project scope
//               (Phase 2i(c)) — chosen here for the same reason: a
//               project has no id space of its own to key against
//               other than its owning department plus its free-text
//               project_id tag.
//   persistent -> NULL, never looked up by any teardown hook — a
//               persistent grant has no trigger by definition.
db.exec(`
CREATE TABLE IF NOT EXISTS tool_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_type TEXT NOT NULL,     -- 'agent' | 'sub_agent' -- which table holder_id is a row in
  holder_id TEXT NOT NULL,       -- agents.address or sub_agents.id
  tool_name TEXT NOT NULL,       -- tool_registry.name at the moment this grant was resolved
  lifecycle TEXT NOT NULL,       -- 'persistent' | 'session' | 'task' | 'project' -- copied off tool_registry.lifecycle at grant time, not re-read live, so a later registry edit can't retroactively change how an already-issued grant tears down
  scope_key TEXT,                -- see comment above -- NULL for persistent, and for session until a session exists
  status TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT             -- 'session_closed' | 'task_completed' | 'project_retired' | NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_grants_holder ON tool_grants(holder_id, status);
CREATE INDEX IF NOT EXISTS idx_tool_grants_session ON tool_grants(lifecycle, scope_key, status) WHERE lifecycle = 'session';
CREATE INDEX IF NOT EXISTS idx_tool_grants_project ON tool_grants(lifecycle, scope_key, status) WHERE lifecycle = 'project';
`);

// next-phase.md Phase 3a (architecture-agent.md §3): the first
// genuinely cross-*agent* trust boundary in this file — everything
// through Phase 2i is one agent's own internal org chart, checked by
// ownerOf()/isSubagentOf() in capability.ts. A channel is the only way
// two distinct top-level offices (two different `agents` rows) are
// ever allowed to interact, and it's a first-class row here rather
// than a filesystem symlink or an implicit trust relationship, so
// "did agent A actually consent to talk to agent B" is a real,
// queryable fact, not something inferred from a file existing on disk.
//
// scope is fixed at proposal time, not editable later (§3: "re-approval
// is only needed again if the scope changes" — the intended way to
// change scope is revoke + re-propose, not an UPDATE on this column,
// same "no silent state resurrection" posture retireProjectSequence()
// and reject_channel below both already hold elsewhere in this file).
//
// status is 'proposed' | 'active' | 'rejected' | 'revoked' — no
// separate 'accepted' state distinct from 'active' (unlike
// architecture-agent.md §3's original four-state sketch): this build's
// own next-phase.md Phase 3a checklist collapses accept directly into
// 'active' since nothing in this codebase's design needs an
// accepted-but-not-yet-active middle state to mean anything different
// from active itself. 'revoked' is listed now even though only Phase
// 3b's revoke_channel() ever produces it, so this column never needs a
// later migration to widen its value space — same "the enum accounts
// for a later phase's terminal state before that phase exists" reasoning
// Phase 2i(d)'s own tool_grants.status column used relative to its own
// future revocation logic.
//
// proposed_at is always set (the moment the row is created);
// resolved_at is set the moment the row leaves 'proposed' for any
// reason (accept, reject, or a revoke-of-a-still-proposed-channel per
// Phase 3b's "implicit reject" rule) and stays NULL for as long as a
// channel remains 'proposed' — the same "a timestamp column that's
// only ever non-NULL once its transition has actually happened" shape
// department_projects.ended_at already uses.
db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  proposer_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  scope TEXT NOT NULL,       -- 'file_transfer' | 'joint_project' | 'payment' -- fixed at proposal time
  status TEXT NOT NULL DEFAULT 'proposed',  -- 'proposed' | 'active' | 'rejected' | 'revoked'
  note TEXT,                 -- optional free-text purpose, mirroring create_department's own objective field
  proposed_at INTEGER NOT NULL,
  resolved_at INTEGER,       -- set the moment status leaves 'proposed', for any reason
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_proposer ON channels(proposer_address, created_at);
CREATE INDEX IF NOT EXISTS idx_channels_recipient ON channels(recipient_address, status);
`);

// next-phase.md Phase 3d (architecture-agent.md §3/§7 send_file()): "a
// resource's lifecycle deserves its own auditable row, not just a
// capability_audit entry" — same reasoning project_burns's own doc
// comment above already establishes for this codebase. A
// capability_audit row (written by checkCapability's own audit(), see
// capability.ts) already records the allow/deny decision for the
// underlying channel-grant check; this table is the transfer's own
// record — one row per send_file() call, not one per channel — so "what
// files has channel chn_xyz actually carried" or "what has agent A sent
// agent B" is a direct query, not a JSON scan or a capability_audit
// text-match. channel_id is a plain TEXT column (not a foreign key
// enforced at the sqlite level, matching every other cross-table
// reference in this file, e.g. project_burns.project_id) — the id of
// whichever channel findActiveChannelGrant() actually resolved the
// call against.
db.exec(`
CREATE TABLE IF NOT EXISTS channel_file_transfers (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  file TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_file_transfers_channel ON channel_file_transfers(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_channel_file_transfers_recipient ON channel_file_transfers(recipient_address, created_at);
`);

// next-phase.md Phase 3e (architecture-agent.md §3/§7 request_file()):
// "asks; peer must send_file() back, not auto-granted" — this table is
// deliberately just a queryable ask, same "a resource's lifecycle
// deserves its own auditable row" reasoning channel_file_transfers'
// own comment above (and project_burns before it) already establishes
// for this codebase. Gated by the same active file_transfer channel
// send_file() itself requires (3c's checkCapability/findActiveChannelGrant)
// — a request is scoped by the same channel a fulfillment would need,
// so there's no principled reason for it to have a looser gate than
// the capability it's asking for.
//
// channel_id, like channel_file_transfers.channel_id above, is a plain
// TEXT column (not a foreign key enforced at the sqlite level) — the
// id of whichever channel findActiveChannelGrant() actually resolved
// the request against.
//
// status is 'pending' | 'fulfilled' — 'fulfilled' is optionally set by
// a later matching send_file() call on the same channel (Phase 3e's
// own "nice-to-have cross-reference, not a requirement send_file
// itself should be blocked on if omitted" note) — requestFile() itself
// never produces anything but 'pending'. No 'rejected'/'declined'
// state: §3's own model has no formal decline for a file request, only
// silence or a fulfillment — the requester's own runtime is expected
// to time out or move on, not wait on a status this table never sets.
//
// requested_at is always set (the moment the row is created);
// fulfilled_at mirrors channels.resolved_at's own "only ever non-NULL
// once its transition has actually happened" shape, staying NULL for
// as long as the request remains 'pending'.
db.exec(`
CREATE TABLE IF NOT EXISTS file_requests (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  requester_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'fulfilled'
  requested_at INTEGER NOT NULL,
  fulfilled_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_file_requests_channel ON file_requests(channel_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_file_requests_recipient ON file_requests(recipient_address, status);
`);

// next-phase.md Phase 3f-i (architecture-agent.md §3/§7 join_project()):
// one row per channel that has ever had its joint directory
// provisioned — the on-disk `path` (office.ts's jointProjectDir(),
// deterministic from channel_id alone, but recorded here anyway so a
// reader doesn't have to re-derive it) plus which two sandbox ids it's
// currently bind-mounted into, so 3f-ii's own teardown-on-revoke knows
// exactly what to unmount without having to re-resolve each party's
// current default sandbox at revoke time (which, per Phase 2g, is not
// guaranteed to still be the same sandboxId it was at join time).
// channel_id is PRIMARY KEY, not just indexed — join_project() is
// idempotent per channel (see channelService.ts's joinProject()), so
// there is never more than one live provisioning record per channel.
// torn_down_at stays NULL until 3f-ii's revoke-triggered unmount runs;
// left in the schema now (same \"visible before the phase that
// enforces it\" convention Phase 0's manifest.json quota stubs and
// Phase 2i(a)'s tool_registry.deprecated column both already use) so
// 3f-ii is a logic change here, not a migration.
db.exec(`
CREATE TABLE IF NOT EXISTS joint_projects (
  channel_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  proposer_sandbox_id TEXT NOT NULL,
  recipient_sandbox_id TEXT NOT NULL,
  provisioned_at INTEGER NOT NULL,
  torn_down_at INTEGER
);
`);

// next-phase.md Phase 5a (architecture-agent.md §6, The Orchestrator):
// one row per top-level agent that has ever been spawned as its own OS
// process by orchestrator.ts, replacing the old assumption (baked into
// the singleton automaton-agent.service unit) that there is only ever
// one agent process, implicitly identified, running at a time. address
// is PRIMARY KEY, not just indexed — spawnAgentProcess() is one-row-
// per-agent by construction, the same "at most one live thing per key"
// shape sandboxes/joint_projects already use above, so a respawn is an
// UPDATE of this same row, never a second row for the same agent.
// status is the orchestrator's own last-known view, not a live guarantee
// — getAgentProcessStatus() below reconciles it against the real OS
// process (via a zero-signal process.kill probe) on read, the same way
// findActiveChannelGrant() (capability.ts) treats a channel row as a
// claim to verify rather than a fact to trust blindly. pid is nullable
// so a 'stopped'/'killed' row can still exist for history without
// implying a live process.
db.exec(`
CREATE TABLE IF NOT EXISTS agent_processes (
  agent_address TEXT PRIMARY KEY,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'stopped', -- 'running' | 'stopped' | 'killed' | 'crashed'
  log_path TEXT,
  state_path TEXT,
  started_at INTEGER,
  stopped_at INTEGER,
  FOREIGN KEY (agent_address) REFERENCES agents(address)
);
CREATE INDEX IF NOT EXISTS idx_agent_processes_status ON agent_processes(status);
`);

// next-phase.md Phase 5e (architecture-agent.md §6, The Orchestrator):
// crash-loop bookkeeping for healthCheck.ts's own auto-restart sweep.
// restart_count is NOT a lifetime total — it's "consecutive restarts
// without an intervening healthy period," reset to 0 the moment a
// sweep finds this agent's process genuinely healthy again (running,
// state file fresh), and also reset once restart_window_started_at
// falls outside the rolling window even without an observed healthy
// tick (see healthCheck.ts's own module doc for why a stuck-but-never-
// confirmed-healthy agent still needs its own circuit to eventually
// reopen). last_restart_at is when this row's restart_count was last
// incremented, used only to compute whether the current row is still
// inside its own restart window — spawnAgentProcess()/killAgentProcess()
// (orchestrator.ts) never touch these two columns; only healthCheck.ts
// does, same separation of concerns resourceQuotas.ts already has from
// orchestrator.ts (decide-and-track vs. spawn/kill authority).
const agentProcessColumns = new Set(
  (db.prepare(`PRAGMA table_info(agent_processes)`).all() as { name: string }[]).map((c) => c.name),
);
if (!agentProcessColumns.has("restart_count")) {
  db.exec(`ALTER TABLE agent_processes ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0`);
}
if (!agentProcessColumns.has("last_restart_at")) {
  db.exec(`ALTER TABLE agent_processes ADD COLUMN last_restart_at INTEGER`);
}

// next-phase.md Phase 5d (architecture-agent.md §6, The Orchestrator):
// backs scheduler.ts's own lease-based job runner — the mechanism that
// promotes departments.ts's TTL sweep (and, by construction, any future
// scheduled job) from a bare in-process `setInterval` into something
// "resilient to a backend process restart mid-sweep and ... coordinated
// across instances," per this phase's own "Done when" line. One row per
// named job (today: just 'ttl_reaper'), never one row per run — a run
// is a lease acquired against this same row, held for at most
// lease_expires_at, then released. locked_by is an opaque per-process
// instance id (scheduler.ts's own `instanceId`, regenerated every
// process boot), not an agent address or anything else this schema
// already has a FOREIGN KEY convention for. NULL locked_by/locked_at/
// lease_expires_at together mean "no one currently holds this job";
// a non-NULL locked_by with an ALREADY-PASSED lease_expires_at means
// the previous holder crashed or hung mid-run without releasing — that
// state is deliberately left queryable rather than auto-cleared by a
// trigger, since the reclaim itself only ever happens inside the same
// atomic UPDATE tryAcquireJobLease() issues (see that function's own
// doc comment for why a separate cleanup pass would just reintroduce
// the race this design exists to avoid).
db.exec(`
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  name TEXT PRIMARY KEY,
  locked_by TEXT,
  locked_at INTEGER,
  lease_expires_at INTEGER,
  last_run_at INTEGER,
  last_run_ok INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0
);
`);

// --- Migration: next-phase.md Phase 7a (architecture-agent.md §4a,
// "Agent A hands it a *purpose*"; §7's create_department(name, role,
// objective) syscall line) — a department's own real, caller-stated
// purpose, closing the gap Phase 2c's own audit named (the §7 table
// already documented an `objective` param that `POST /departments`
// never actually accepted) and every phase from 2d through 2i carried
// forward without picking up.
//
// Nullable, and deliberately only ever meaningful on a `kind =
// 'department'` row -- a worker/temp-worker row has no objective of
// its own (§4c's "task, not objective" line), so this column is simply
// never read or written for those rows, the same "column exists on the
// shared sub_agents table but only applies to one kind of row" pattern
// spend_cap_daily_usdc (Phase 2d) and granted_tools (Phase 2i(b))
// already established before it. A brand-new column rather than
// reusing `task` -- `task` already means something else entirely for a
// worker row (a bounded, executor-facing instruction, §4c), and
// collapsing "objective" and "task" onto one column would blur exactly
// the reasoning-scope distinction Phase 2c's own terminology lock
// exists to keep sharp.
//
// departments.ts's `POST /departments` route is what actually enforces
// a length cap on caller-supplied values (mirroring
// marketplace.ts's own MAX_FLAG_DETAIL_LENGTH convention for bounded
// free text) and falls back to today's placeholder string when the
// caller omits it -- this migration only makes the column exist and be
// nullable; NULL is expected and normal for any department row created
// before this phase, or (defensively) if a caller somehow bypasses the
// route's own fallback.
const subAgentColumns7a = new Set(
  (db.prepare(`PRAGMA table_info(sub_agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!subAgentColumns7a.has("objective")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN objective TEXT`);
}

// --- Migration: next-phase.md Phase 9a-i (architecture-agent.md §4h,
// Reasoning section) — the collision-avoidance data layer every later
// Domain Management sub-phase (9a-ii's tool profile, 9c's subdomain/SSL
// automation, 9d's mailbox automation) is built on top of. This
// sub-phase creates the data only; nothing yet reads or writes
// `domain_resources`, and nothing yet resolves `slug` for a role — see
// wallet.ts's generateAgentSlug() for the generation side of this
// migration.
//
// `agents.slug`: short, DNS-safe, unique-across-the-whole-deployment
// identifier — "spacex.novamail.store"/"spacex-sales@novamail.store"
// (9a's own locked naming convention) both need a stable, collision-free
// fragment to build on, and an agent's own `address` (a 0x... hex
// string) is neither short nor DNS-friendly to use directly. Nullable
// on this column, deliberately, the same "migration only makes the
// column exist, NULL is expected and normal for any row created before
// this phase" reasoning the `objective` migration immediately above
// this one already uses — every agent created from this phase forward
// gets a real slug (wallet.ts's three insert sites), but nothing here
// batch-backfills a slug onto agents that already existed before this
// migration ran; a pre-existing agent simply has no slug until/unless a
// future phase decides that backfill is worth doing.
//
// Uniqueness is enforced with a partial unique index rather than a
// UNIQUE column constraint specifically so it doesn't reject the many
// NULL rows above at once — SQLite's own multi-NULL allowance under a
// plain UNIQUE column constraint is implementation-defined enough
// across versions that this phase doesn't rely on it; the explicit
// `WHERE slug IS NOT NULL` partial index says exactly what's meant:
// every *non-null* slug must be unique, and NULL (no slug yet) is never
// a collision with anything, including another NULL.
const agentColumns9a = new Set(
  (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!agentColumns9a.has("slug")) {
  db.exec(`ALTER TABLE agents ADD COLUMN slug TEXT`);
}
db.exec(
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug) WHERE slug IS NOT NULL;`,
);

// `domain_resources`: one row per provisioned subdomain/mailbox/vhost,
// the single source of truth §4h's Reasoning section calls for — every
// provisioning call 9c/9d add later checks this table before touching
// Cloudflare/Mailcow, not just before writing its own row here. Created
// empty by this sub-phase; no provisioning logic exists yet to write to
// it (that's 9c for subdomains/vhosts, 9d for mailboxes).
//
//   resource_type: 'subdomain' | 'mailbox' | 'vhost' — a plain TEXT
//     column, not a CHECK-constrained enum, matching this file's own
//     established precedent (channels.status, sandboxes.kind, etc.) of
//     enforcing enum membership at the application layer rather than
//     the SQLite layer, so a future phase can widen the value space
//     without a migration.
//   full_value: the complete provisioned name, e.g.
//     "spacex.novamail.store" (subdomain/vhost) or
//     "marketplace@novamail.store" (mailbox) — always qualified with
//     the shared apex, never just the local part, so a lookup never
//     needs to reconstruct the full value from a fragment plus
//     config.domainApex.
//   owner_agent_id: the top-level agent (agents.address) this resource
//     was provisioned for. Always set — even the shared marketplace's
//     own platform-owned row (9e) is provisioned by a real one-time
//     migration/Founder action, not by no one — matching this table's
//     own "every row has a real actor behind it" posture; it is
//     owner_department_id below, not this column, that goes NULL for a
//     platform-owned resource.
//   owner_department_id: the sub_agents.id (kind='department') that
//     asked for this resource, nullable specifically for the shared
//     marketplace's own row (9e), which §4h's own text says "has no
//     single owning department." Plain TEXT, not a DB-level foreign
//     key, matching sub_agents/department_projects/department_knowledge's
//     own existing cross-table-reference convention in this file —
//     ownership is checked at the route layer, not enforced by SQLite.
//   status: 'active' | 'released' — a resource reaching 'released' is a
//     real, terminal, auditable state transition (the same distinction
//     Phase 3b's own migration comment draws for a revoked channel),
//     not a row deletion; 9c/9d's own teardown calls (ssl renewal
//     aside) flip this rather than DELETE-ing the row, so "what did
//     this agent ever provision, including what it later gave back" is
//     a query this table can still answer.
db.exec(`
CREATE TABLE IF NOT EXISTS domain_resources (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,      -- 'subdomain' | 'mailbox' | 'vhost'
  full_value TEXT NOT NULL,         -- e.g. 'spacex.novamail.store' or 'marketplace@novamail.store'
  owner_agent_id TEXT NOT NULL,
  owner_department_id TEXT,         -- nullable: the shared marketplace's own row (9e) has no owning department
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'released'
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_resources_value ON domain_resources(full_value);
CREATE INDEX IF NOT EXISTS idx_domain_resources_owner_agent ON domain_resources(owner_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_domain_resources_owner_dept ON domain_resources(owner_department_id, status);
`);

// --- Migration: next-phase.md Phase 9d-i (architecture-agent.md §4h) —
// mailbox credential storage, a small SIBLING table rather than new
// nullable columns bolted onto domain_resources above. domain_resources
// already carries three resource_type shapes (subdomain/mailbox/vhost)
// that share no credential concept for the other two — adding
// encrypted_password/etc. columns there would mean every subdomain and
// vhost row forever carries two always-NULL columns it can never use.
// A one-row-per-mailbox sibling table keyed on the owning
// domain_resources.id keeps the credential concept scoped to exactly
// the rows that have one, matching this file's own existing
// preference (see e.g. clone_shells vs. agents) for a sibling table
// over a wide, mostly-NULL parent row.
//
//   resource_id: domain_resources.id for the mailbox this credential
//     belongs to. Plain TEXT primary key, not a DB-level FOREIGN KEY —
//     same "checked at the route/service layer, not enforced by
//     SQLite" convention this file already uses for
//     sub_agents/department_projects/department_knowledge's own
//     cross-table references (see domain_resources' own
//     owner_department_id comment above for the same reasoning
//     restated).
//   encrypted_password: AES-256-GCM ciphertext (iv || tag || enc,
//     base64), same wallet.ts private-key-at-rest scheme (see that
//     file's own encrypt()/decrypt()) but its own distinct derived key
//     (domains.ts's own encryptMailboxPassword()/
//     decryptMailboxPassword()) — deliberately NOT reusing wallet.ts's
//     literal ENC_KEY, so a single leaked key never protects both the
//     wallet-keypair and mailbox-credential categories at once, even
//     though both derive from the same underlying config.backendApiKey
//     secret using the identical AES-256-GCM scheme.
//   created_at: when the mailbox (and this credential) was created —
//     9d-i never updates a password in place; a password rotation, if
//     a future phase adds one, would be a new row shape decision to
//     make then, not assumed here.
db.exec(`
CREATE TABLE IF NOT EXISTS mailbox_credentials (
  resource_id TEXT PRIMARY KEY,
  encrypted_password TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// Dynamic tool registration: lets an Agent-tier caller define a new
// shell-backed tool at runtime (name, description, JSON-schema
// parameters, and a command run inside its OWN sandbox via vmExec —
// never on this host) instead of every capability requiring a code
// change + redeploy. Scoped per-agent (agent_address) since a tool one
// automaton registers is backed by a command that only makes sense in
// its own sandbox/filesystem — it isn't a shared capability the way
// tool_registry's grants are.
db.exec(`
CREATE TABLE IF NOT EXISTS custom_tools (
  id TEXT PRIMARY KEY,
  agent_address TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  parameters TEXT NOT NULL,
  command TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(agent_address, name)
);
`);

// Skills: reusable capability packages (a name/description + freeform
// instructions text, ported from agent/'s SKILL.md convention — see
// skills.ts's own header for why the backend parses/stores these as
// data rather than the agent's sandbox holding actual SKILL.md files
// the way agent/ does. Scoped per-agent, same reasoning as
// custom_tools above.
db.exec(`
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  agent_address TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  auto_activate INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE(agent_address, name)
);
`);

// --- Zent.md Phase 1a (The Expansion Pipeline) ---
// opportunity_reports is the root of the whole pipeline: one row per
// Opportunity-Intelligence pass over a single profitable agent
// ("Company A"). It intentionally holds only the *raw* pass metadata —
// who ran it, when, and the unstructured signal dump 2b's
// scan_market_signals() writes to source_summary — not any scored
// opportunity itself. That split matters: a single pass can (and
// usually will) surface several distinct opportunities, each scored
// independently in Phase 3, so 'one report -> many opportunities' is a
// real one-to-many relationship, not just row-per-idea. 1b's
// `opportunities` table is the child that will FK back to this one.
//
// status is deliberately a plain three-state lifecycle rather than
// anything richer at this phase:
//   'draft'    — created, still collecting signal (2b/2c still writing
//                to source_summary).
//   'scored'   — signal collection is done and 3a has scored at least
//                one opportunity out of it.
//   'archived' — closed out, superseded, or (3e) yielded no
//                opportunity clearing the ROI floor. Terminal.
// No FOREIGN KEY on agent_address to agents(address): Company A is
// always an existing top-level agent by the time Phase 2's
// isEligibleForExpansion() gate lets a report be created, but this
// table needs to survive being queried/joined even if that invariant
// is ever relaxed later (e.g. reports kept after an agent's own
// lineage row is pruned) — same reasoning distribution_posts' seller
// reference gets an explicit FK while ancillary log-style tables
// elsewhere in this file (usage_log, exec_log) don't.
db.exec(`
CREATE TABLE IF NOT EXISTS opportunity_reports (
  id TEXT PRIMARY KEY,
  agent_address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'   -- draft | scored | archived
);
CREATE INDEX IF NOT EXISTS idx_opportunity_reports_agent ON opportunity_reports(agent_address, created_at);
CREATE INDEX IF NOT EXISTS idx_opportunity_reports_status ON opportunity_reports(agent_address, status);
`);

// --- Zent.md Phase 2d (The Expansion Pipeline) ---
// Daily tick counter for the three opportunity_intelligence signal-
// collection tools (scan_market_signals / list_customer_complaints /
// list_demand_signals, Phase 2b/2c). Same shape and reasoning as
// distribution_rate_counters above: signal scanning has no per-call
// USDC cost to log against usage_log (the DuckDuckGo scrape
// expansionRoutes.ts runs is free), so an opportunity_intelligence
// department can never trip resourceQuotas.ts's existing inference/
// marketplace spend-rate gate no matter how hard it loops — exactly
// the "cheapest department, easiest to run unbounded" gap Zent.md 2d
// calls out by name. This table is that department type's own
// ticks-per-day equivalent of a spend cap: one row per (agent, UTC
// calendar day), incremented once per successful tool call by
// resourceQuotas.ts's recordOpportunityIntelligenceTick(). Calendar-
// day scoped rather than a rolling window, matching
// distribution_rate_counters' own "N per day" framing (not "N per any
// 24h span") since that's the more legible unit for a human operator
// reading a per-day cap.
db.exec(`
CREATE TABLE IF NOT EXISTS opportunity_intelligence_tick_counters (
  agent_address TEXT NOT NULL,
  day TEXT NOT NULL,                 -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_address, day)
);
`);

// --- Zent.md Phase 10c (The Expansion Pipeline) ---
// "Reuse resourceQuotas.ts patterns for Finance department's own spend
// cap — modeling other companies' costs must stay cheap." Same
// diagnosis as opportunity_intelligence_tick_counters just above:
// 8b-9d's own modeling tools (estimate_build_cost,
// estimate_time_to_revenue, check_available_capital, check_runway,
// estimate_worst_case_loss, recommend_sizing, propose_staged_funding,
// note_sensitivity) are compute against numbers this backend already
// has (a wallet balance read, a usage_log window sum, arithmetic over
// an opportunity's own prior findings) — none of them log a metered
// USDC charge to usage_log the way an actual inference or marketplace
// call does, so a finance department can never trip
// resourceQuotas.ts's existing inference_spend/marketplace_spend gate
// no matter how many times it re-models the same opportunity. This
// table is that department type's own ticks-per-day equivalent of a
// spend cap, identical shape to opportunity_intelligence's: one row
// per (agent, UTC calendar day), incremented once per successful
// Phase 8/9 tool call by resourceQuotas.ts's recordFinanceTick().
// Deliberately its own counter rather than sharing
// opportunity_intelligence_tick_counters — these are two different
// department types with two different per-day budgets (see
// config.ts's maxFinanceTicksPerAgentPerDay for why the numbers
// differ), and folding them into one shared counter would let a
// finance department's activity count against an opportunity_
// intelligence department's own budget (or vice versa) for two
// processes this pipeline otherwise keeps entirely separate.
db.exec(`
CREATE TABLE IF NOT EXISTS finance_tick_counters (
  agent_address TEXT NOT NULL,
  day TEXT NOT NULL,                 -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_address, day)
);
`);

// --- Zent.md Phase 10d (The Expansion Pipeline) ---
// "Audit log: every number Finance produces is traceable to the
// wallet/spend query that generated it — no hand-waved figures."
//
// One row per Phase 8/9 finance tool pass. `metric` names which
// finance_findings key (8b's build_cost, 8c's time_to_revenue, 8d's
// available_capital, ... through 10b's own hard_reject) this row backs.
// Three of those metrics — build_cost, time_to_revenue,
// available_capital — are where a REAL wallet/spend-log/department-
// duration read happens (department_spend_log, sub_agents, the on-chain
// balance call, usage_log); this table's raw_evidence_json for those
// rows is the literal rows/values that read returned, not a re-derived
// summary, so "traceable to the query" means something concrete: you
// can point at this row and see exactly what was summed or averaged.
//
// Every other Finance number (8e's runway_check through 9d's
// sensitivity_note, plus 10b's hard_reject) is pure arithmetic over
// findings that already exist by the time that tool runs — no new
// wallet/spend read of its own. Those still get a row here (same
// "every number... is traceable" reading Zent.md 10d's header gives,
// not just the three that touch a live source), but ref_ids_json
// points back at whichever earlier finance_audit_log row(s) fed the
// arithmetic instead of duplicating raw evidence that already has a
// home — same "reference, don't duplicate" instinct company_lineage
// (Phase 1e) already applies to telling two kinds of spawn apart.
//
// source_query is a short, human-legible description of the read
// (table + filter), written by the calling code, never built from
// caller-controlled input — it exists for a human or the CEO gate to
// understand what was queried at a glance, not to be replayed as SQL.
db.exec(`
CREATE TABLE IF NOT EXISTS finance_audit_log (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  metric TEXT NOT NULL,              -- 'build_cost' | 'time_to_revenue' | 'available_capital' | 'runway_check' | 'worst_case_loss' | 'sizing_recommendation' | 'staged_funding_option' | 'sensitivity_note' | 'hard_reject'
  value REAL,                        -- the headline number this row backs; NULL for a non-numeric metric (hard_reject)
  source_query TEXT NOT NULL,        -- human-legible description of what was read, or "derived" for arithmetic-only metrics
  row_count INTEGER NOT NULL,        -- how many underlying rows were read; 0 for a fallback/derived path
  raw_evidence_json TEXT NOT NULL,   -- JSON: the actual rows/values behind the number
  ref_ids_json TEXT,                 -- JSON array of finance_audit_log ids this row derives from, if any
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_audit_log_opportunity ON finance_audit_log(opportunity_id, recorded_at);
`);

// --- Zent.md Phase 1b (The Expansion Pipeline) ---
// opportunities is the child row 1a's own header already promised:
// a single opportunity_reports pass (one Opportunity-Intelligence scan)
// can and usually will surface several distinct, independently-scored
// ideas, so this is a real one-to-many child table, not a 1:1 extension
// of the report. Phase 3's score_opportunity() tool is the eventual
// writer; this phase only owns the shape and the FK, the same split
// 1a's own docstring draws between "collecting signal" and "scoring
// what was collected."
//
// FOREIGN KEY on report_id -> opportunity_reports(id) IS enforced here,
// unlike opportunity_reports.agent_address's deliberate lack of an FK
// to agents(address): a report is a durable thing that may outlive an
// agent's own lineage row, but an opportunity can never meaningfully
// exist without the report pass that surfaced it, so an orphaned
// opportunity is always a bug, not a legitimate historical artifact.
// ON DELETE CASCADE follows from the same reasoning — deleting a
// report deletes the opportunities scored out of it.
//
// tags is a JSON-stringified array (TEXT), the same convention this
// file already uses for granted_tools — SQLite has no native array
// type and nothing here needs to query inside the array yet (that's
// a later-phase concern, e.g. Strategy's portfolio checks in Phase 11).
//
// roi_score is nullable at the schema level even though Zent.md lists
// it as a plain column: Phase 3b's deterministic formula is what
// actually computes it from scoring factors this table does not yet
// model (demand / expense-of-problem / buildability / competitive-gap
// each land in Phase 3a). 1b's job is only to give that future number
// a place to live.
db.exec(`
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES opportunity_reports(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  thesis TEXT NOT NULL,
  roi_score REAL,
  tags TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_opportunities_report ON opportunities(report_id, created_at);
CREATE INDEX IF NOT EXISTS idx_opportunities_roi_score ON opportunities(roi_score);
`);

// --- Zent.md Phase 3a (The Expansion Pipeline) ---
// score_opportunity(title, thesis, factors) needs somewhere to put the
// four 0-100 factors it collects (demand, expense-of-problem,
// buildability-by-our-stack, competitive-gap) — 1b's own docstring
// already flagged that "roi_score's computation" was left to a later
// phase without saying what its *inputs* would be stored as, and 3b's
// header (see expansion.ts) is explicit that the eventual formula's
// inputs must be "stored alongside the inputs so it's auditable, not
// just a number" (Zent.md 3b). Added as an ALTER TABLE migration
// rather than in the original CREATE TABLE above, following this
// file's own established convention for every column that wasn't part
// of a table's Phase-1 shape (see the erc8004Columns/agentColumns1e
// migrations elsewhere in this file for the identical guarded pattern).
//
// All four are nullable REAL, same as roi_score itself: an opportunity
// row can still be constructed today (tests, or a caller-supplied
// roiScore path predating this phase) without factors, and 3a's own
// createOpportunity() update only requires them when a caller actually
// passes `options.factors`. Range validation (0-100 inclusive) is an
// application-layer concern (expansion.ts's validateScoringFactors()),
// not a SQLite CHECK constraint — matching roi_score's own precedent
// of no numeric-range constraint at the schema level.
const opportunityColumns3a = new Set(
  (db.prepare(`PRAGMA table_info(opportunities)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
const scoringFactorColumns3a: Record<string, string> = {
  factor_demand: "REAL",
  factor_expense_of_problem: "REAL",
  factor_buildability: "REAL",
  factor_competitive_gap: "REAL",
};
for (const [name, type] of Object.entries(scoringFactorColumns3a)) {
  if (!opportunityColumns3a.has(name)) {
    db.exec(`ALTER TABLE opportunities ADD COLUMN ${name} ${type}`);
  }
}

// --- Zent.md Phase 3b (The Expansion Pipeline) ---
// computeRoiScore() (expansion.ts) is a fixed formula, but Zent.md 20e
// already expects it to get *tuned* later, after post-launch review of
// whether approved opportunities actually panned out. Once the weights
// change, "roi_score = 72" stops being self-describing — 72 under
// yesterday's formula and 72 under tomorrow's tuned one aren't
// comparable. roi_formula_version records which ROI_FORMULA_VERSION
// (expansion.ts) computed a given row's score, the same "know which
// rule produced this number, not just the number" reasoning
// factor_demand/etc.'s own Phase 3a migration comment above gives for
// storing the inputs at all.
//
// Nullable TEXT, same guarded ALTER TABLE pattern as the Phase 3a
// factor columns just above (and the same reason: rows written before
// this migration, or via a caller-supplied roiScore with no version —
// see createOpportunity()'s own docstring — have no formula to name).
const opportunityColumns3b = new Set(
  (db.prepare(`PRAGMA table_info(opportunities)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!opportunityColumns3b.has("roi_formula_version")) {
  db.exec(`ALTER TABLE opportunities ADD COLUMN roi_formula_version TEXT`);
}

// --- Zent.md Phase 3d (The Expansion Pipeline) ---
// "Top-N selection: a scheduled job (scheduler.ts) that, on a cadence,
// marks the top-scoring open opportunity as status = 'scored' ... and
// hands it to Research — nothing below N (default top 4) proceeds."
//
// This is a per-OPPORTUNITY status, not opportunity_reports.status —
// the two are independent. opportunity_reports.status (draft/scored/
// archived, Phase 1a) tracks whether a REPORT can still accept new
// score_opportunity() calls (resolveTargetReport()'s own check); it
// says nothing about which of a report's several opportunities (one
// scan pass routinely produces more than one, Phase 3a) have been
// individually promoted. That distinction only became visible once
// this phase's actual selection logic was written — an earlier
// comment on the score-opportunity route guessed 3d would flip the
// REPORT's status; that guess is corrected here (see
// expansionRoutes.ts's own updated comment) now that a single report
// containing opportunities at different selection states makes a
// report-level flag the wrong level for this.
//
// status is TEXT rather than the 'scored' Zent.md's own prose uses
// literally, to avoid colliding with opportunity_reports' own
// 'scored' value one column over in a join — same "these are two
// different lifecycles, don't let them look like the same word by
// accident" reasoning. This phase's own selectTopOpenOpportunities()
// (expansion.ts) only ever writes 'open' (the default) or 'selected'.
// 'rejected' is reserved here, unwritten by anything in this phase,
// for Phase 4c's human-in-the-loop demote/reject endpoint — same
// "declare the column now, let a later phase's writer be the sole
// gate on the value" precedent expansion_decisions.ceo_decision's own
// comment above already sets for an unenforced tri-state column.
//
// selected_at is nullable, set only when status flips to 'selected' —
// gives Phase 5's eventual Research pickup query a natural "selected
// but not yet started" ordering (ORDER BY selected_at ASC) without
// needing a second timestamp column once that phase exists.
const opportunityColumns3d = new Set(
  (db.prepare(`PRAGMA table_info(opportunities)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!opportunityColumns3d.has("status")) {
  db.exec(`ALTER TABLE opportunities ADD COLUMN status TEXT NOT NULL DEFAULT 'open'`);
}
if (!opportunityColumns3d.has("selected_at")) {
  db.exec(`ALTER TABLE opportunities ADD COLUMN selected_at INTEGER`);
}
// Every selection tick's hot query is "this agent's open, scored
// opportunities, highest roi_score first" (join on opportunity_reports
// for agent_address, filter opportunities.status/roi_score) — same
// "index the column the hot query actually filters/orders by" reasoning
// idx_opportunities_roi_score (Phase 1b) already followed.
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_opportunities_status_roi_score ON opportunities(status, roi_score)`,
);

// --- Zent.md Phase 1c (The Expansion Pipeline) ---
// research_findings / finance_findings / strategy_findings are three
// identically-shaped tables, one per department that will eventually
// write into them (Research: Phase 5-7, Finance: Phase 8-10, Strategy:
// Phase 11-12). They're kept as three physical tables rather than one
// polymorphic table with a `kind` column on purpose: each department's
// eventual report schema (7b/9e/12d) is its own contract, and a later
// migration narrowing one department's shape should never risk a typo
// touching the other two's rows.
//
// All three are keyed to `opportunities`, not `opportunity_reports` —
// findings are about one scored idea, not the raw signal pass it came
// from. FOREIGN KEY + ON DELETE CASCADE for the same reason 1b's
// opportunities -> opportunity_reports link has one: a finding can
// never meaningfully outlive the opportunity it's about, so an orphan
// here is always a bug.
//
// "One row per department pass, versioned" (Zent.md 1c) is modeled as:
//   - version: 1-indexed, increments per opportunity_id within this
//     table. A department re-running (e.g. Research re-verifying after
//     new information) writes a new row at version+1, never mutates an
//     old one — old findings stay in history rather than being
//     destroyed.
//   - superseded: 0 for the single current row per opportunity_id, 1
//     for every prior version once a newer one lands. Exactly one
//     non-superseded row should exist per opportunity_id at any time;
//     that invariant is enforced by createFinding()'s
//     supersede-then-insert transaction in expansion.ts, not by a
//     schema constraint, because SQLite has no clean way to express
//     "at most one row where superseded = 0 per opportunity_id" as a
//     CHECK/UNIQUE without a generated column trick that would make
//     the intent harder to read than the application-level guarantee.
//
// `findings` is a JSON-stringified object (TEXT), the same
// JSON-in-TEXT convention 1b's `tags` column already uses. This phase
// deliberately does not lock down what keys live inside it: Research's
// market_size/competition/customer_segments (5b-5d), Finance's
// build_cost/time_to_revenue (8b-8c), and Strategy's mission_overlap/
// technology_reuse (11c-11d) are each a later phase's tool surface, not
// this one's. 1c's job is only the shape — a place for one department's
// one versioned pass to live — matching how 1b left roi_score's actual
// computation to Phase 3b rather than inventing it here. Report-schema
// lock-down for each department (7b/9e's equivalent, 12d) is a later
// phase's job once there's an actual schema to lock.
db.exec(`
CREATE TABLE IF NOT EXISTS research_findings (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  findings TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_research_findings_opportunity ON research_findings(opportunity_id, version);
CREATE INDEX IF NOT EXISTS idx_research_findings_current ON research_findings(opportunity_id, superseded);

CREATE TABLE IF NOT EXISTS finance_findings (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  findings TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_finance_findings_opportunity ON finance_findings(opportunity_id, version);
CREATE INDEX IF NOT EXISTS idx_finance_findings_current ON finance_findings(opportunity_id, superseded);

CREATE TABLE IF NOT EXISTS strategy_findings (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  findings TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_strategy_findings_opportunity ON strategy_findings(opportunity_id, version);
CREATE INDEX IF NOT EXISTS idx_strategy_findings_current ON strategy_findings(opportunity_id, superseded);
`);

// --- Zent.md Phase 1d (The Expansion Pipeline) ---
// expansion_decisions is the CEO gate's own table (Phase 15 is the tool
// surface — decide_expansion() / POST /expansion/opportunities/:id/decide
// — this phase is only the place its output lives, same split 1b left
// roi_score's computation to 3b and 1c left a finding's payload to
// 5/6/8/9/11/12).
//
// One opportunity can accumulate MORE THAN ONE row here over time: Zent.md
// 15c spells out that a `deferred` decision "re-queues for a later CEO
// tick without re-running the departments" — i.e. the same opportunity_id
// comes back through this table again once the CEO actually rules on it,
// without anything upstream (Research/Finance/Strategy) re-running. That
// makes this an append-only decision log, not a 1:1 extension of
// `opportunities` — closer in spirit to research/finance/strategy_findings'
// "one row per pass" than to opportunities' single row per idea, except
// nothing here is ever superseded/invalidated the way a finding is: a
// `deferred` row stays true history (the CEO did in fact defer on that
// tick), it's just not final. "The current decision" is simply the
// most-recent row for an opportunity_id, found by ORDER BY decided_at
// DESC — no superseded flag needed, since there's nothing to invalidate.
//
// FOREIGN KEY on opportunity_id -> opportunities(id) ON DELETE CASCADE,
// same reasoning as 1c's findings tables: a decision can never
// meaningfully outlive the opportunity it rules on, so an orphaned
// decision row is always a bug, not a legitimate historical artifact.
//
// committee_votes is JSON-stringified (TEXT), the same JSON-in-TEXT
// convention `tags` (1b) and `findings` (1c) already use — this phase
// doesn't lock down its shape; Phase 13b's committee packet schema and
// Phase 14b's per-department recommend/recommend-with-conditions/
// do-not-recommend fields are what actually populate it.
//
// decided_by deliberately gets no FOREIGN KEY to agents(address), for
// the same reason opportunity_reports.agent_address doesn't (see 1a's
// comment above): this table needs to survive being queried even if an
// agent's own lineage row is later pruned. Phase 15b's "the calling
// agent_address must match the top-level agent that owns the pipeline"
// check is an application-level authorization rule, not a schema
// constraint — enforcing it here would require this table to know which
// agent owns which opportunity_report, which is a join away, not a
// column away.
//
// ceo_decision has no CHECK constraint restricting it to the three
// Zent.md values (approved/rejected/deferred): every other tri-state-ish
// column in this file (opportunity_reports.status) takes the same
// approach and relies on the writer (here, Phase 15's decide_expansion())
// to be the sole gate on valid values, documented in the column comment
// rather than enforced by SQLite.
db.exec(`
CREATE TABLE IF NOT EXISTS expansion_decisions (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  committee_votes TEXT NOT NULL DEFAULT '{}',
  ceo_decision TEXT NOT NULL,   -- approved | rejected | deferred
  decided_at INTEGER NOT NULL,
  decided_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expansion_decisions_opportunity ON expansion_decisions(opportunity_id, decided_at);
`);

// --- Zent.md Phase 15d (The Expansion Pipeline) ---
// "approved fires genesis (Phase 16) directly — no operator gate
// between decision and provisioning; the CEO agent's call is final."
//
// Phase 16 (genesis_company() itself — real wallet/sandbox/funding
// provisioning) doesn't exist in this codebase yet (see config.ts's own
// Phase 9b comment: "Phase 16 wires the genesis call itself"). This
// table is the seam: one row per opportunity that ever had an
// `approved` ruling fire its genesis trigger, written synchronously by
// expansion.ts's fireGenesisTrigger() in the same call that recorded
// the decision — never behind a queue a human has to drain. Same
// "the record is exactly what happened" posture expansion_notifications
// (Phase 4d) already takes for its own fire-once event.
//
// UNIQUE on opportunity_id is the actual one-fire-per-opportunity gate
// (mirrors expansion_notifications' own dedup index) — belt-and-braces
// alongside 15c's finality gate, which already stops a second `approved`
// ruling from ever reaching this table for the same opportunity.
//
// status starts 'pending' and stays there until Phase 16a's real
// genesis_company() exists and calls markGenesisTriggerCompleted() (or
// a caught executor failure flips it to 'failed', error populated) —
// this table does not itself claim provisioning happened, only that
// firing it was attempted and when.
db.exec(`
CREATE TABLE IF NOT EXISTS genesis_triggers (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES expansion_decisions(id) ON DELETE CASCADE,
  agent_address TEXT NOT NULL,
  recommended_funding_usdc REAL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_genesis_triggers_opportunity ON genesis_triggers(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_genesis_triggers_status ON genesis_triggers(status, created_at);
`);

// --- Zent.md Phase 17e-ii (The Expansion Pipeline) ---
// "Full-tick completion assertion: run one tick to completion and
// assert no unhandled error, timeout, or crashed sandbox — the 'done
// when' for whether the loop itself runs at all."
//
// One row per smoke-test attempt (genesisSmokeTest.ts's
// runFirstTickSmokeTest(), called from genesis.ts's
// genesisExecutorAdapter() right after a birth completes). Deliberately
// its own table, not a column bolted onto genesis_triggers: a trigger
// is "did this opportunity's approved decision get provisioned", which
// is already true (status='completed') by the time this ever runs —
// a failed first tick does not retroactively make the birth not have
// happened, and Agent B can in principle be re-ticked (a retried smoke
// test after a transient sandbox blip), which genesis_triggers' own
// one-fire-per-opportunity UNIQUE index isn't shaped for. No UNIQUE
// constraint here for the same reason — more than one row per
// agent_address is an expected, not exceptional, history.
//
// outcome is the 17e-ii-level classification only ('passed' here means
// "the loop ran to completion without an unhandled error, a timeout, or
// a crashed sandbox" — nothing about constitution/guard compliance,
// which is 17e-iii's separate concern and not recorded in this table).
db.exec(`
CREATE TABLE IF NOT EXISTS genesis_tick_smoke_tests (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  agent_address TEXT NOT NULL,
  outcome TEXT NOT NULL,   -- passed | unhandled_error | timeout | crashed_sandbox
  exit_code INTEGER,
  timed_out INTEGER NOT NULL,
  stdout TEXT NOT NULL,
  stderr TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  ran_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genesis_tick_smoke_tests_agent ON genesis_tick_smoke_tests(agent_address, ran_at);
CREATE INDEX IF NOT EXISTS idx_genesis_tick_smoke_tests_opportunity ON genesis_tick_smoke_tests(opportunity_id, ran_at);
`);

// --- Zent.md Phase 17e-iii (The Expansion Pipeline) ---
// "Constitution/guard compliance check on that tick: verify the tick's
// actions passed the same three-law constitution checks (17b) as any
// ordinary tick — a tick that completes but also violates its
// constitution should not pass the smoke test."
//
// One row per check (genesisConstitutionCheck.ts's
// checkTickConstitutionCompliance(), called from genesis.ts's
// genesisExecutorAdapter() immediately after runFirstTickSmokeTest()
// resolves without throwing — a tick that never completed has no
// actions to check, so 17e-ii gates this the same way it already gates
// 17e-iv). Its own table, same reasoning genesis_tick_smoke_tests'
// header gives for not being a column bolted onto genesis_triggers:
// this is a distinct, independently-retryable concern from "did the
// loop run at all," and Agent B can in principle be re-checked.
//
// outcome is the 17e-iii-level classification only: 'passed' means
// every tool call the agent/ policy engine recorded for this tick was
// 'allow' and the agent's own constitution.md hash was intact
// (agent/src/soul/constitution-guard.ts) at check time; 'violated'
// means at least one 'deny'/'quarantine' policy decision was recorded
// or the constitution file itself no longer matches its genesis hash.
db.exec(`
CREATE TABLE IF NOT EXISTS genesis_constitution_checks (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  agent_address TEXT NOT NULL,
  outcome TEXT NOT NULL,   -- passed | violated | unavailable
  violation_count INTEGER NOT NULL DEFAULT 0,
  violations TEXT NOT NULL DEFAULT '[]',  -- JSON array of {toolName, decision, riskLevel, reason}
  constitution_file_compromised INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genesis_constitution_checks_agent ON genesis_constitution_checks(agent_address, checked_at);
CREATE INDEX IF NOT EXISTS idx_genesis_constitution_checks_opportunity ON genesis_constitution_checks(opportunity_id, checked_at);
`);

// --- Zent.md Phase 4d (The Expansion Pipeline) ---
// "Notification hook (reuses whatever channel office.ts/admin status
// already uses) firing when a new opportunity clears the ROI floor."
//
// The audit row lives here, separate from the delivery mechanism
// itself (office.ts's per-agent inbox, written from expansionRoutes.ts —
// see that file's own Phase 4d section for why the actual filesystem
// write belongs there and not in this synchronous, better-sqlite3-only
// file). This table is what makes the hook idempotent and queryable —
// exactly the same "the record is exactly what happened, not a
// self-report of what happened" property this pipeline already insists
// on elsewhere (isEligibleForExpansion()'s own header, expansion.ts).
//
// One row per opportunity that ever cleared the floor, not one row per
// delivery attempt: the UNIQUE index on opportunity_id is the actual
// de-dup gate — a caller that (redundantly) re-checks the same
// opportunity twice gets the same row back rather than a second one,
// so "did this ever fire" is always a single well-defined answer, not
// a count to reason about.
//
// delivered starts at 0 and flips to 1 only once the inbox write
// genuinely lands (markExpansionNotificationDelivered(), expansion.ts).
// A row can legitimately sit at delivered=0 indefinitely if the
// filesystem write failed — same "never let a side-channel failure
// erase or retry-loop the thing it's a side effect of" posture
// send_file()'s own hashFileContents().catch() already takes in
// channelService.ts — the opportunity was still scored and still
// cleared the floor either way; this column is about whether the
// agent's own inbox actually has the message, not about whether the
// floor-clearing event itself happened.
db.exec(`
CREATE TABLE IF NOT EXISTS expansion_notifications (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  agent_address TEXT NOT NULL,
  roi_score REAL NOT NULL,
  created_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_expansion_notifications_opportunity ON expansion_notifications(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_expansion_notifications_agent ON expansion_notifications(agent_address, created_at);
`);

// --- Zent.md Phase 14a (The Expansion Pipeline) ---
// "Optional deliberation pass: a lightweight cross-department exchange
// (each department gets to see the others' reports once and append a
// short rebuttal/concur) before the packet locks — off by default,
// enabled per-agent config."
//
// Two tables, matching the "one small table per concern" pattern this
// file already uses (opportunity_intelligence_tick_counters,
// finance_tick_counters) rather than bolting either onto `agents` or
// `opportunities`:
//
//   expansion_pipeline_config — one row per top-level agent, holding
//   just the 14a on/off switch. Absence of a row means "off" (the
//   default Zent.md 14a calls for) — see isDeliberationEnabled() in
//   expansion.ts, which treats a missing row the same as an explicit
//   0, so no backfill is required for agents that predate this table.
//
//   deliberation_responses — one row per (opportunity, department):
//   the department's own rebuttal/concur text, submitted once per
//   Zent.md 14a's "once" wording. UNIQUE(opportunity_id, department)
//   is the actual one-shot-per-department gate; recordDeliberationResponse()
//   (expansion.ts) upserts on top of it rather than erroring on a
//   resubmit, since this pass is explicitly "lightweight" and a
//   department correcting its own rebuttal before the CEO ever reads
//   it is not the kind of mistake this table needs to guard against.
db.exec(`
CREATE TABLE IF NOT EXISTS expansion_pipeline_config (
  agent_address TEXT PRIMARY KEY,
  deliberation_enabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliberation_responses (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  department TEXT NOT NULL,        -- 'research' | 'finance' | 'strategy'
  position TEXT NOT NULL,          -- 'concur' | 'rebuttal'
  response_text TEXT NOT NULL,
  responding_to TEXT NOT NULL,     -- JSON array of the other departments this response addresses
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliberation_responses_opp_dept ON deliberation_responses(opportunity_id, department);

-- Zent.md Phase 14b/14c: "Vote/recommendation field per department:
-- recommend / recommend-with-conditions / do-not-recommend, distinct
-- from their numeric scores — forces a clear position" plus "Conditions
-- capture: 'recommend, but cap initial funding at $X' is a first-class
-- field the CEO gate can read, not free text to parse."
--
-- Four departments, not three — matching the "four-report bundle" this
-- committee packet already assembles (13a's own header): Opportunity
-- Intelligence votes on the opportunity it originated, same as
-- Research/Finance/Strategy vote on the opportunity they each filed a
-- report against. One row per (opportunity, department), same
-- UNIQUE-index-as-one-shot-gate pattern deliberation_responses just
-- above already uses — a resubmit updates the same row rather than
-- accumulating a second vote, since Zent.md never describes voting as
-- versioned the way research/finance/strategy_findings are.
--
-- conditions is nullable and is ONLY populated for a
-- 'recommend-with-conditions' vote (enforced in
-- recordDepartmentVote(), expansion.ts, not here) — 14c's "first-class
-- field," not a free-text note bolted onto every vote regardless of
-- its position.
CREATE TABLE IF NOT EXISTS department_votes (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  department TEXT NOT NULL,        -- 'opportunity_intelligence' | 'research' | 'finance' | 'strategy'
  vote TEXT NOT NULL,              -- 'recommend' | 'recommend-with-conditions' | 'do-not-recommend'
  conditions TEXT,                 -- non-null only when vote = 'recommend-with-conditions'
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_department_votes_opp_dept ON department_votes(opportunity_id, department);
`);

// --- Zent.md Phase 1e (The Expansion Pipeline) ---
// "company_lineage extension" — but this repo has no separate
// company_lineage table to extend: the `agents` table IS the lineage
// record (parent_address, plus the erc8004_*/status columns already
// bolted on above), and wallet.ts's GET /:address/lineage reads it
// directly. So 1e's two new columns land here, on `agents`, the same
// way every other lineage-adjacent addition in this file already has.
//
//   spawn_reason: 'self' | 'expansion_pipeline'. 'self' covers every
//     path that creates a top-level agent today — createAgentWallet()'s
//     fresh-key path and createClonedAgentWallet()'s claimed-clone path
//     (Zent.md's own "existing spawn_clone path" — see cloning.ts's
//     header for why that name and the OTHER self-hosted spawn_clone
//     mechanism in agent-runtime/tools.ts are different things; this
//     column is about the Docker-sandboxed wallet.ts/cloning.ts path
//     specifically, the one Zent.md's own top section cites via
//     cloning-verification.test.ts/cloning-erc8004.test.ts).
//     NOT NULL DEFAULT 'self' so every pre-existing row and every
//     insert this phase doesn't touch keeps working unmodified — no
//     wallet.ts insert statement needs to change for this migration to
//     be correct. 'expansion_pipeline' is written by exactly one future
//     caller: Phase 16a's genesis_company(), which Phase 16e's own
//     checklist item describes as "company_lineage row written with
//     spawn_reason = 'expansion_pipeline'" — that's this column, not a
//     new one, and this phase intentionally stops at making the column
//     exist. No code path sets it to anything but the default yet.
//   opportunity_id: which opportunity (opportunities.id) this agent was
//     spawned to pursue, set only alongside spawn_reason =
//     'expansion_pipeline'. Nullable — every 'self'-spawned agent has
//     no opportunity behind it. Plain TEXT with no REFERENCES/FOREIGN
//     KEY clause, matching this file's own established convention for
//     every OTHER cross-table column added via ALTER TABLE rather than
//     at CREATE TABLE time (sub_agents.project_id, department_spend_
//     log.project_id, domain_resources.owner_department_id) — checked
//     at the route/service layer (Phase 16's own job), not by SQLite.
//     Note this is the opposite convention from opportunities/
//     research_findings/finance_findings/strategy_findings/
//     expansion_decisions above, which DO carry a declared REFERENCES
//     ... ON DELETE CASCADE — those are all rows scoped underneath a
//     single opportunity's own lifecycle, so cascading their deletion
//     with it is correct. An agent is the opposite: a real, independent
//     company that must go on existing (and being queryable) even if
//     the opportunity_reports/opportunities row that motivated its
//     birth is later archived or pruned — same "survive the thing that
//     explains it being gone" reasoning expansion_decisions.decided_by
//     already uses for not FK-ing to agents(address).
//
// Together these let a lineage query answer "was this company born
// from another agent cloning itself, or from the expansion pipeline
// funding a new mission — and if the latter, which opportunity" without
// a join anywhere else needing to change; GET /:address/lineage's own
// `self` field already does `SELECT *`, so both columns ride along on
// that response for free, and its `children` list below is updated to
// select them explicitly for the same reason.
const agentColumns1e = new Set(
  (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!agentColumns1e.has("spawn_reason")) {
  db.exec(`ALTER TABLE agents ADD COLUMN spawn_reason TEXT NOT NULL DEFAULT 'self'`);
}
if (!agentColumns1e.has("opportunity_id")) {
  db.exec(`ALTER TABLE agents ADD COLUMN opportunity_id TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_agents_spawn_reason ON agents(spawn_reason);`,
);

// --- Zent.md Phase 17e-iv ("Genesis Engine: Active-status transition —
//     'only after 17e-ii and 17e-iii both pass is Agent B marked
//     active; a failing smoke test leaves it in a distinguishable
//     pre-active state instead of silently retrying.'") ---
//
// Deliberately a NEW column, not a repurposing of the `status` column
// added above: that one's own migration comment is explicit that it
// means agent *liveness* ('active' unless/until a death report lands,
// touched only by POST /v1/agents/:address/death) — reusing it for
// genesis pre-activation would mean every ordinary 'self'-spawned agent
// (which never runs this pipeline at all) would need a non-default
// value invented for it, and would make a pipeline-spawned agent that
// hasn't cleared its smoke test yet indistinguishable from a dead one
// to every existing reader of that column (socialGroups.ts's eviction
// logic chief among them). `genesis_activation_status` is scoped
// narrowly instead:
//
//   NULL       — the default, and permanent, value for every agent
//                that was never born through the expansion pipeline
//                (spawn_reason = 'self'). Not applicable, not "pending
//                forever" — there is no genesis smoke test to gate for
//                these agents at all.
//   'pending'  — written once, at birth, only for a pipeline-spawned
//                agent (spawn_reason = 'expansion_pipeline'), by the
//                same tagCompanyLineage() call in genesis.ts that
//                already writes spawn_reason/opportunity_id for that
//                agent (Phase 16e) — see that function's own comment.
//                This is Zent.md 17e-iv's "distinguishable pre-active
//                state," present from the moment Agent B exists, before
//                its first tick has even run.
//   'active'   — written by genesisActivation.ts's activateGenesisAgent()
//                once, and only once, both 17e-ii (runFirstTickSmokeTest)
//                and 17e-iii (checkTickConstitutionCompliance) have
//                resolved without throwing for this agent's first tick.
//   'failed'   — written by genesisActivation.ts's
//                markGenesisActivationFailed() if either check throws.
//                Terminal for this agent — Zent.md 17e-iv's own wording
//                is "leaves it in a distinguishable pre-active state
//                instead of silently retrying": there is no code path
//                anywhere in this pipeline that re-attempts a first
//                tick for an agent already born, so 'failed' does not
//                get silently overwritten back to 'pending'.
//
// No CHECK constraint (same convention `opportunities.status`/
// `listings.status`-style free-text columns already use elsewhere in
// this file) — validated at the genesisActivation.ts call sites, the
// only writers.
const agentColumns17eIv = new Set(
  (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!agentColumns17eIv.has("genesis_activation_status")) {
  db.exec(`ALTER TABLE agents ADD COLUMN genesis_activation_status TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_agents_genesis_activation_status ON agents(genesis_activation_status);`,
);

// Complete-history table for 17e-iv transitions, same "own table, not a
// column bolted on" reasoning genesis_tick_smoke_tests (17e-ii) and
// genesis_constitution_checks (17e-iii) already document — the
// `agents.genesis_activation_status` column above is always
// current-state-only (one row per agent), this table is the append-only
// log of how it got there (one row per transition; normally exactly one
// per agent — 'pending' is a bare column write, not logged here — plus
// one terminal 'active' or 'failed' row).
db.exec(`
CREATE TABLE IF NOT EXISTS genesis_activation_events (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  status TEXT NOT NULL,             -- 'active' | 'failed'
  reason TEXT NOT NULL,             -- 'smoke_test_failed' | 'constitution_violated' | 'passed'
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genesis_activation_events_agent ON genesis_activation_events(agent_address, created_at);
`);

// --- Zent.md Phase 18a ("Ecosystem Registry & Identity: ERC-8004
//     registration for Agent B reused from erc8004.ts's Identity
//     Registry mechanism, tagged with the parent relationship") ---
//
// Complete-history table, same convention every genesis_* table above
// already follows: one row per registration attempt (normally one per
// pipeline-spawned agent — this only ever fires once, right after
// 17e-iv marks an agent 'active', same "fires once at birth" posture
// genesis_tick_smoke_tests/genesis_constitution_checks/
// genesis_activation_events all share). agent_id/tx_hash are the
// cached copy of what's now also on agents.erc8004_* — kept here too so
// a failed attempt (no agents.erc8004_* write at all) still leaves a
// legible record of what was tried and why it didn't land, same
// "complete history, not just a failure log" reasoning those other
// tables' own comments give.
db.exec(`
CREATE TABLE IF NOT EXISTS genesis_erc8004_registrations (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  agent_address TEXT NOT NULL,
  parent_address TEXT NOT NULL,
  outcome TEXT NOT NULL,             -- 'registered' | 'gas_funding_failed' | 'registration_failed' | 'skipped_self_custody'
  agent_id TEXT,                     -- ERC-8004 tokenId, null unless outcome = 'registered'
  tx_hash TEXT,
  gas_funding_tx_hash TEXT,
  gas_wei_sent TEXT,                 -- stringified bigint (SQLite has no native bigint column)
  detail TEXT NOT NULL,
  registered_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_genesis_erc8004_registrations_agent ON genesis_erc8004_registrations(agent_address, registered_at);
`);

// --- Zent.md Phase 17c ("Genesis Engine: Mission & Constitution" —
//     "Mission field stored structurally (not just prose in the
//     prompt) so later Strategy passes (Phase 11b) can read siblings'
//     missions programmatically.") ---
//
// Phase 17a already gets Agent B a mission, but only as prose appended
// to its own system-prompt.md (genesis.ts's writeGenesisPrompt()) — the
// only way anything else in this backend could reconstruct "what is
// Agent B for" was expansion.ts's listExistingCompanies() (Phase 11b)
// re-deriving it from opportunity_id -> opportunities.title/thesis, a
// join through a row that (per opportunity_id's own comment just above)
// is allowed to be archived or pruned out from under a still-living
// company. This column is that fact moved onto Agent B's own row,
// surviving independently of the opportunity that motivated it, same
// "survive the thing that explains it being gone" reasoning
// opportunity_id's own comment already gives for why THAT column has
// no FOREIGN KEY either.
//
// mission: nullable TEXT, JSON — a StructuredMission object (genesis.ts:
//   opportunityId, title, thesis, relationshipType, relationshipReasoning),
//   not a copy of the human-readable prompt string (that's what 17a's
//   system-prompt.md section already is; duplicating it here would just
//   be a second, driftable copy of the same prose). Written exactly
//   once, by genesis.ts's writeStructuredMission(), immediately
//   alongside 17a's own prompt write — same "not caught here" call site
//   in genesisCompany(). NULL for every 'self'-spawned agent (nothing
//   about an ordinary spawn_clone call has a mission to store) and for
//   any 'expansion_pipeline' agent genesis'd before this migration
//   existed — listExistingCompanies() (expansion.ts) falls back to its
//   pre-17c opportunity-derived reconstruction for exactly those rows,
//   so an old company doesn't go from "has a mission" to "has none"
//   the moment this column ships.
const agentColumns17c = new Set(
  (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!agentColumns17c.has("mission")) {
  db.exec(`ALTER TABLE agents ADD COLUMN mission TEXT`);
}

// --- Zent.md Phase 5a (The Expansion Pipeline) ---
// "Department type `research`, spawned by Company A specifically to
// verify one `opportunity_id` — one department instance per
// opportunity, torn down when its finding is filed."
//
// sub_agents already has a `role` column (Phase 2a) that a `research`
// department's row sets to "research" the same way every other
// department type's row does — no new column needed for the TYPE.
// What IS new: which single `opportunities` row this particular
// research department instance exists to verify. That's a 1:1 fact
// about the department row itself (an opportunity has no FK back to
// "its" department — only a department has one forward to "its"
// opportunity), so it lands on sub_agents as a nullable column,
// following the same guarded-ALTER-TABLE + no-FOREIGN-KEY convention
// project_id and ttl_at (both Phase 2a, this same table) already
// established: checked at the route/service layer (departments.ts's
// POST / route and retireResearchDepartmentForOpportunity(), both
// Phase 5a), not by SQLite.
//
// NULL for every non-research department, and for every research
// department row created before this migration. "One department
// instance per opportunity" (Zent.md 5a's own line) is enforced at
// the application layer — a live query for an existing status='running'
// row with this opportunity_id, in departments.ts's POST / route — the
// same way research_findings' "exactly one non-superseded row per
// opportunity_id" is enforced by createFinding()'s transaction rather
// than a schema constraint (see this file's own Phase 1c comment
// above): a plain UNIQUE index on this column can't express "unique
// only among running rows" without a partial-index feature this file
// doesn't otherwise rely on, so it stays a plain (non-unique) index,
// scoped by status in the query that reads it rather than in the
// index's own definition.
const subAgentColumns5a = new Set(
  (db.prepare(`PRAGMA table_info(sub_agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!subAgentColumns5a.has("opportunity_id")) {
  db.exec(`ALTER TABLE sub_agents ADD COLUMN opportunity_id TEXT`);
}
db.exec(
  `CREATE INDEX IF NOT EXISTS idx_sub_agents_opportunity ON sub_agents(opportunity_id, status);`,
);

// --- Zent.md Phase 17d-iii-a ("Genesis Engine: Mission & Constitution" —
//     "Seed provenance tagging: every seeded entry (17d-i-a–c, 17d-II)
//     is tagged with its source (opportunity_id, originating report id,
//     department) and a birth timestamp, so later self-learned
//     knowledge is distinguishable from inherited knowledge.") ---
//
// The four 17d-i-a/b/c + 17d-II seed functions (genesis.ts) already set
// knowledge_store.source to a `research_finding:<id>` / `strategy_finding:<id>`
// string, and every row already has its own created_at — so two of this
// phase's three tags (report id, a timestamp) technically already exist
// on the row, just not as a queryable, structured unit, and the third
// (opportunity_id, department as a first-class value rather than a
// prefix baked into `source`'s string) doesn't exist at all. A reader
// wanting "every knowledge_store row this agent was BORN with" today has
// to pattern-match `source LIKE 'research_finding:%' OR source LIKE
// 'strategy_finding:%'` and hope no future self-learned write ever
// reuses that prefix by coincidence — exactly the "distinguishable from
// self-learned knowledge" gap Zent.md 17d-iii-a names.
//
// provenance: nullable TEXT, JSON — a KnowledgeProvenance object
//   (knowledgeStore.ts: opportunityId, reportId, department, seededAt),
//   NOT a replacement for the existing `source` column (source stays the
//   free-text `research_finding:<id>` string every existing reader
//   already parses; provenance is the same fact, structured, plus the
//   two facts source never carried). NULL for every row addKnowledge()
//   is called on without an explicit provenance argument — which is
//   every self-learned write an agent's own runtime makes post-birth,
//   and every knowledge_store row that predates this migration,
//   including rows genesis.ts's own four seed functions already wrote
//   before this phase shipped: those keep their `source` string
//   (nothing about this migration rewrites existing rows) but read back
//   with provenance = null until re-seeded, the same "old row, new
//   column, no backfill" posture agents.mission (Phase 17c, above) takes
//   for companies genesis'd before that column existed.
const knowledgeStoreColumns17diiia = new Set(
  (db.prepare(`PRAGMA table_info(knowledge_store)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!knowledgeStoreColumns17diiia.has("provenance")) {
  db.exec(`ALTER TABLE knowledge_store ADD COLUMN provenance TEXT`);
}

// --- Zent.md Phase 19d ("Kill/recall path: the root agent (or Agent
//     B's own failure detection) can freeze or wind down a specific
//     pipeline-spawned company without touching the pipeline or any of
//     its other siblings — an internal control, not an external
//     operator action.") ---
//
// Two pieces of state:
//
// 1. `agents.frozen` / `frozen_reason` / `frozen_at` — the funds-lock
//    half. A frozen agent's own signPaymentAuthorization() call (Phase
//    16b's signing chokepoint, wallet.ts) refuses to sign any outgoing
//    transfer regardless of which process or department is asking —
//    this is enforced at the one place every payment this backend ever
//    sends already passes through, not re-implemented per caller. It
//    does not block INCOMING payments (a frozen company can still be
//    paid; it just can't spend), and it does not touch the encrypted
//    key itself — freezing is reversible in principle even though this
//    phase deliberately does not expose an unfreeze route (see
//    expansionKillSwitch.ts's own header for why).
//
// 2. `kill_events` — append-only audit trail, one row per freeze/kill
//    action, covering every trigger this phase wires: self-detected
//    (initiator = 'self'), parent-detected (initiator = 'parent'), and
//    the one external-operator backstop this phase adds on top of
//    Zent.md's own text (initiator = 'admin', /admin/orchestrator's own
//    x-admin-key tier — see PHASE-19D-NOTES.md for why). `action`
//    distinguishes the security-department half (shutdown, process-only)
//    from the finance-department half (freeze_funds, wallet-only) from
//    the combined wind-down (kill, both) a self/parent trigger performs
//    together. Every row also carries whichever of the two sub-actions
//    actually succeeded/failed (detail, JSON) — same "structured,
//    queryable outcome, not just a reason string" posture
//    genesis_activation_events already uses.
const agentColumns19d = new Set(
  (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string }[]).map((c) => c.name),
);
if (!agentColumns19d.has("frozen")) {
  db.exec(`ALTER TABLE agents ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0`);
}
if (!agentColumns19d.has("frozen_reason")) {
  db.exec(`ALTER TABLE agents ADD COLUMN frozen_reason TEXT`);
}
if (!agentColumns19d.has("frozen_at")) {
  db.exec(`ALTER TABLE agents ADD COLUMN frozen_at INTEGER`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_agents_frozen ON agents(frozen);`);

db.exec(`
CREATE TABLE IF NOT EXISTS kill_events (
  id TEXT PRIMARY KEY,
  agent_address TEXT NOT NULL,
  root_agent_address TEXT NOT NULL,
  action TEXT NOT NULL,             -- 'shutdown' | 'freeze_funds' | 'kill'
  initiator TEXT NOT NULL,          -- 'self' | 'parent' | 'admin'
  initiator_address TEXT,           -- agent address for self/parent; null for admin
  reason TEXT NOT NULL,
  detail TEXT NOT NULL,             -- JSON: { shutdown: {...}|null, freezeFunds: {...}|null }
  created_at INTEGER NOT NULL,
  FOREIGN KEY (agent_address) REFERENCES agents(address)
);
CREATE INDEX IF NOT EXISTS idx_kill_events_agent ON kill_events(agent_address, created_at);
CREATE INDEX IF NOT EXISTS idx_kill_events_root ON kill_events(root_agent_address, created_at);
`);

// --- Zent.md Phase 19e ("Full-pipeline dry-run mode: run Phases 2–15
//     to completion, produce a genesis-ready packet, but stop short of
//     16 — for testing the whole reasoning chain without actually
//     spending funding.") ---
//
// Two pieces of state, same split 14a's own two-tables-one-concern
// pattern already uses:
//
// 1. `expansion_pipeline_config.dry_run_mode` — the per-agent on/off
//    switch, added as a column on the *existing* table (not a new one)
//    since it's the same kind of "one small flag" config
//    deliberation_enabled already is on that table, and reads back
//    `false` for any agent/row that predates this phase — see
//    isDryRunModeEnabled() (expansion.ts), which treats a missing
//    column value the same way isDeliberationEnabled() treats a
//    missing row. Guarded PRAGMA/ALTER, same convention Phase 19d's
//    `agents.frozen` migration above uses, since
//    expansion_pipeline_config is created unconditionally above and
//    may already exist from a prior boot without this column.
//
// 2. `dry_run_genesis_packets` — one row per opportunity that reached
//    an `approved` CEO ruling while dry-run mode was on for its agent.
//    This is Zent.md 19e's actual deliverable: "produce a
//    genesis-ready packet" — everything the real Phase 16
//    genesisExecutor would have been called with (the same
//    GenesisTriggerContext shape fireGenesisTrigger() builds for the
//    live path) plus the full CommitteePacket it was ruled against,
//    frozen at decision time the same way expansion_decisions' own
//    snapshot (Phase 1d) freezes what the CEO saw. UNIQUE on
//    opportunity_id mirrors genesis_triggers' own one-fire-per-
//    opportunity gate — 15c's finality check already stops a second
//    `approved` ruling on the same opportunity, so this index is
//    belt-and-braces, not the primary guard, same relationship
//    genesis_triggers' own header describes toward that finality gate.
//
//    Deliberately its own table, not a row in genesis_triggers with a
//    'dry_run' status value: a dry-run packet never represents even an
//    *attempted* provisioning call (no genesisExecutor is ever
//    invoked — that's the entire point of 19e), whereas every
//    genesis_triggers row, by that table's own header, means exactly
//    "firing it was attempted." Mixing the two would make "was genesis
//    actually fired for this opportunity" stop being a single
//    well-defined question — the same reasoning
//    genesis_tick_smoke_tests' own header gives for not bolting onto
//    genesis_triggers either.
const expansionPipelineConfigColumns19e = new Set(
  (db.prepare(`PRAGMA table_info(expansion_pipeline_config)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!expansionPipelineConfigColumns19e.has("dry_run_mode")) {
  db.exec(`ALTER TABLE expansion_pipeline_config ADD COLUMN dry_run_mode INTEGER NOT NULL DEFAULT 0`);
}

// --- Zent.md Phase 20d ("Staged rollout: dry-run mode (19e) only, for
//     the first real profitable agent in production, before enabling
//     real genesis.") ---
//
// One more column on the same expansion_pipeline_config table 14a's
// deliberation_enabled and 19e's dry_run_mode already live on, same
// "one small flag" shape — `rollout_stage`, TEXT rather than INTEGER
// since it's a two-value enum ('dry_run_only' | 'live_enabled') rather
// than a boolean, guarded PRAGMA/ALTER same as dry_run_mode's own
// migration immediately above.
//
// The default matters here more than for 14a/19e's booleans: a missing
// row (every agent that predates this phase, and every brand-new
// top-level agent) must read back 'dry_run_only', not 'live_enabled' —
// that's the entire point of 20d ("dry-run mode only ... before
// enabling real genesis"). See getRolloutStage() (expansion.ts), which
// treats a missing row the same way isDryRunModeEnabled() treats a
// missing dry_run_mode value, except the safe default is inverted
// (missing = *most* restrictive here, vs. *least* restrictive for a
// plain feature flag) precisely because this is a rollout safety gate,
// not a feature toggle.
//
// `rollout_graduation_events` is this phase's own audit trail — one
// row per graduate/demote transition, mirroring genesis_activation_events'
// own shape (Phase 17e-iv) rather than overwriting rollout_stage
// silently. A demotion (root_agent_address, 'demoted', reason,
// occurred_at) is written by expansionCircuitBreaker.ts's
// haltExpansionPipeline() (19c) alongside the halt itself — see that
// file's own Phase 20d update — so a circuit-breaker trip after
// graduation doesn't just pause new spawns, it also revokes the
// live-genesis privilege until the root re-earns it via
// checkRolloutGraduationEligibility().
const expansionPipelineConfigColumns20d = new Set(
  (db.prepare(`PRAGMA table_info(expansion_pipeline_config)`).all() as { name: string }[]).map(
    (c) => c.name,
  ),
);
if (!expansionPipelineConfigColumns20d.has("rollout_stage")) {
  db.exec(
    `ALTER TABLE expansion_pipeline_config ADD COLUMN rollout_stage TEXT NOT NULL DEFAULT 'dry_run_only'`,
  );
}

db.exec(`
CREATE TABLE IF NOT EXISTS rollout_graduation_events (
  id TEXT PRIMARY KEY,
  root_agent_address TEXT NOT NULL,
  event_type TEXT NOT NULL,        -- 'graduated' | 'demoted'
  reason TEXT NOT NULL,
  dry_run_packet_count INTEGER NOT NULL,  -- snapshot at the moment of the transition
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rollout_graduation_events_agent ON rollout_graduation_events(root_agent_address, occurred_at);
`);

// --- Zent.md Phase 20e ("Post-launch review checkpoint: after the
//     first real Agent B is spawned, a scheduled review of whether the
//     ROI/fit scores it was approved on actually held up — feeds back
//     into tuning 3b's formula.") ---
//
// One row per pipeline-spawned agent (UNIQUE on agent_address — see
// postLaunchReview.ts's schedulePostLaunchReview(), which is the only
// writer of a 'pending' row and is itself called exactly once per
// birth, from the same genesisExecutorAdapter() call site
// activateGenesisAgent() (17e-iv) already sits in). predicted_roi_score
// and predicted_fit_score are snapshotted at scheduling time — read
// once, right when Agent B goes active — rather than re-read live at
// review time, so a later re-score of the same opportunity (there
// shouldn't be one; opportunities don't get re-scored post-genesis in
// this codebase, but nothing enforces that as an invariant elsewhere)
// can't retroactively change what this review is grading against.
//
// Every actual_* column is nullable and only populated once
// runDuePostLaunchReviews() (postLaunchReview.ts) actually completes
// the review — a 'pending' row is a schedule, not a partial result.
db.exec(`
CREATE TABLE IF NOT EXISTS post_launch_reviews (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  agent_address TEXT NOT NULL UNIQUE,
  root_agent_address TEXT NOT NULL,
  predicted_roi_score REAL NOT NULL,
  predicted_fit_score REAL,
  recommended_funding_usdc REAL,
  review_due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | completed
  actual_revenue_usdc REAL,
  actual_spend_usdc REAL,
  actual_surplus_usdc REAL,
  actual_profitable INTEGER,
  still_active INTEGER,
  actual_outcome_score REAL,
  roi_calibration_delta REAL,
  fit_calibration_delta REAL,
  calibration_verdict TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_post_launch_reviews_due ON post_launch_reviews(status, review_due_at);
CREATE INDEX IF NOT EXISTS idx_post_launch_reviews_root ON post_launch_reviews(root_agent_address, status);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS dry_run_genesis_packets (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  decision_id TEXT NOT NULL REFERENCES expansion_decisions(id) ON DELETE CASCADE,
  agent_address TEXT NOT NULL,
  recommended_funding_usdc REAL,
  notes TEXT,
  committee_packet TEXT NOT NULL,   -- JSON snapshot of the full CommitteePacket ruled on
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dry_run_genesis_packets_opportunity ON dry_run_genesis_packets(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_dry_run_genesis_packets_agent ON dry_run_genesis_packets(agent_address, created_at);
`);
