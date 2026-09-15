import express from "express";
import fetch from "node-fetch";
import { config } from "./config.js";
import { db } from "./db.js";
import { settleAuthorization, type Authorization } from "./facilitator.js";
import { runOnScheduleWithLease } from "./scheduler.js";
import { parseMaxTokens } from "./inferenceValidation.js";
import { validateInferencePayment } from "./inferencePaymentValidation.js";

const router = express.Router();

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const LOCAL_MODEL_URL = `${config.localModelBaseUrl.replace(/\/$/, "")}/chat/completions`;
const LOCAL_MODELS_URL = `${config.localModelBaseUrl.replace(/\/$/, "")}/models`;

// You launch llama-server with `-hf org/repo:QUANT` (e.g.
// `Qwen/Qwen3-4B-GGUF:Q8_0`) — llama.cpp resolves that to whatever
// it actually downloaded/loaded, and there's no reliable way for this
// backend to guess that string from the outside. So it doesn't try:
// it asks the running server via GET /v1/models instead. Cached for
// LOCAL_MODEL_DISCOVERY_TTL_MS so a normal request doesn't pay for an
// extra round trip every time — re-checked periodically so swapping
// which GGUF is loaded (without restarting this backend) is picked up
// on its own within a few minutes, not stuck on a stale id forever.
let discoveredLocalModelId: string | null = null;
let discoveredLocalModelIdAt = 0;
const LOCAL_MODEL_DISCOVERY_TTL_MS = 5 * 60_000;

/**
 * Ask llama-server what it's actually serving. Falls back to
 * config.localModelName (a human-set label, not necessarily what
 * llama.cpp actually calls it) if the server can't be reached — the
 * chat call below will still work even if this returns the fallback,
 * since llama-server ignores an unrecognized `model` field in
 * single-model mode; this is purely for accurate `usage_log`/response
 * labeling.
 */
async function discoverLocalModelId(): Promise<string> {
  const now = Date.now();
  if (discoveredLocalModelId && now - discoveredLocalModelIdAt < LOCAL_MODEL_DISCOVERY_TTL_MS) {
    return discoveredLocalModelId;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const resp = await fetch(LOCAL_MODELS_URL, { signal: controller.signal as any });
    if (resp.ok) {
      const data: any = await resp.json();
      const id = data?.data?.[0]?.id;
      if (typeof id === "string" && id.length > 0) {
        discoveredLocalModelId = id;
        discoveredLocalModelIdAt = now;
        return id;
      }
    }
  } catch {
    // llama-server unreachable right now — fall through to the label below.
    // callLocalModel() will hit the same unreachable server right after
    // this and surface the real error there; this function never throws.
  } finally {
    clearTimeout(timer);
  }
  return config.localModelName;
}

// error-fix.md Phase 11, extended by LOCAL_MODEL_PATCH_NOTES.md: the
// only models /inference/chat will ever actually serve. A caller-
// supplied `model` is validated against this allowlist rather than
// passed through raw — letting an agent request an arbitrary model
// string would let it pick something far more expensive than what
// checkInferenceBudget/estimateCostUsdc were computed against. Anything
// not in this list (including no model at all) falls back to the
// primary model — the local model when useLocalModelPrimary is true,
// otherwise config.openrouterModel.
const ALLOWED_MODELS = new Set([
  config.localModelName,
  config.openrouterModel,
  config.openrouterLowComputeModel,
]);

function primaryModel(): string {
  return config.useLocalModelPrimary ? config.localModelName : config.openrouterModel;
}

function resolveModel(requested: unknown): string {
  if (typeof requested === "string" && ALLOWED_MODELS.has(requested)) {
    return requested;
  }
  return primaryModel();
}

interface ProviderCallResult {
  completion: any;
  servedBy: "local" | "openrouter";
  modelUsed: string;
}

/**
 * Call the local llama.cpp server (OpenAI-compatible /v1/chat/completions
 * on this same VM). Throws on any failure — network error, timeout, or a
 * non-2xx response — so the caller can decide whether to fall back.
 */
async function callLocalModel(model: string, messages: unknown, maxTokens: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.localModelTimeoutMs);
  try {
    const resp = await fetch(LOCAL_MODEL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
      }),
      signal: controller.signal as any,
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`local_model_error ${resp.status}: ${text}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Call OpenRouter directly. Throws on any failure, same contract as callLocalModel. */
async function callOpenRouter(model: string, messages: unknown, maxTokens: number): Promise<any> {
  if (!config.openrouterApiKey) {
    throw new Error("openrouter_not_configured: OPENROUTER_API_KEY is unset, no fallback available");
  }
  const resp = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.openrouterApiKey}`,
      "HTTP-Referer": "https://your-platform.example",
      "X-Title": "automaton-backend",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`openrouter_error ${resp.status}: ${text}`);
  }
  return await resp.json();
}

/**
 * Serve the completion. Local model first (unless the caller explicitly
 * asked for an OpenRouter model, or useLocalModelPrimary is off), falling
 * back to OpenRouter only if the local call fails. LOCAL_MODEL_PATCH_NOTES.md.
 */
async function runInference(
  requestedModel: string,
  messages: unknown,
  maxTokens: number,
): Promise<ProviderCallResult> {
  const wantsOpenRouterExplicitly =
    requestedModel === config.openrouterModel || requestedModel === config.openrouterLowComputeModel;

  if (wantsOpenRouterExplicitly || !config.useLocalModelPrimary) {
    const completion = await callOpenRouter(requestedModel, messages, maxTokens);
    return { completion, servedBy: "openrouter", modelUsed: requestedModel };
  }

  try {
    const localModelId = await discoverLocalModelId();
    const completion = await callLocalModel(localModelId, messages, maxTokens);
    return { completion, servedBy: "local", modelUsed: localModelId };
  } catch (localErr: any) {
    console.warn(`[inferenceGateway] local model call failed, falling back to OpenRouter: ${localErr?.message}`);
    const completion = await callOpenRouter(config.openrouterModel, messages, maxTokens);
    return { completion, servedBy: "openrouter", modelUsed: config.openrouterModel };
  }
}

// The wallet address that receives payment for inference (yours — the platform's treasury).
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS as `0x${string}`;

function estimateCostUsdc(estimatedTokens: number): string {
  const cost = (estimatedTokens / 1000) * config.pricePer1kTokensUsdc;
  return cost.toFixed(6);
}

/**
 * Rolling 24h spend check against usage_log. Enforced server-side, before
 * any inference call is made (local or OpenRouter) — an agent cannot
 * spend past this by any combination of tool calls, since the check
 * happens on every request, paid or not.
 */
function checkInferenceBudget(agentAddress: string): { ok: true } | { ok: false; reason: string } {
  const since = Date.now() - 24 * 3_600_000;
  const spend = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(cost_usdc AS REAL)), 0) AS total
       FROM usage_log
       WHERE agent_address = ? AND service = 'inference' AND created_at >= ?`,
    )
    .get(agentAddress, since) as { total: number };

  if (spend.total >= config.maxInferenceSpendUsdcPerAgentPerDay) {
    return {
      ok: false,
      reason: `daily_inference_budget_exceeded: spent $${spend.total.toFixed(4)} of $${config.maxInferenceSpendUsdcPerAgentPerDay} allowed per 24h`,
    };
  }
  return { ok: true };
}

/**
 * Atomically claim an authorization's nonce before doing any expensive
 * work. Returns false if it's already claimed (a concurrent request for
 * the same signed authorization got there first, or this exact
 * authorization was already used). See db.ts's own note on
 * inference_nonce_reservations for why this can't just reuse the
 * `payments` table. error-fix.md Phase 10b.
 */
function claimNonce(nonce: string, agentAddress: string): boolean {
  try {
    db.prepare(
      `INSERT INTO inference_nonce_reservations (nonce, agent_address, reserved_at)
       VALUES (?, ?, ?)`,
    ).run(nonce, agentAddress, Date.now());
    return true;
  } catch {
    // UNIQUE constraint violation -> already claimed.
    return false;
  }
}

function releaseNonce(nonce: string): void {
  db.prepare(`DELETE FROM inference_nonce_reservations WHERE nonce = ?`).run(nonce);
}

interface OrphanRecordInput {
  nonce: string;
  agentAddress: string;
  authorization: Authorization;
  signature: string;
  completion: any;
  servedBy: "local" | "openrouter";
  modelUsed: string;
  usedTokens: number;
  actualCost: string;
}

/**
 * Durably record a completion whose settlement just failed. See this
 * table's own comment in db.ts and INFERENCE-SETTLEMENT-RECONCILIATION-NOTES.md.
 * `INSERT OR REPLACE` is intentional and safe here even though a row
 * for this nonce can only be created once from this call site (the
 * nonce reservation itself already guarantees only one /chat request
 * ever reaches this far for a given nonce) -- it just means a re-run
 * of this exact code path (there isn't one today) wouldn't need extra
 * handling later.
 */
function recordOrphanedSettlement(input: OrphanRecordInput): void {
  const now = Date.now();
  db.prepare(
    `INSERT OR REPLACE INTO orphaned_inference_settlements
       (nonce, agent_address, authorization_json, signature, completion_json,
        served_by, model_used, used_tokens, cost_usdc, status, attempt_count,
        created_at, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', 0, ?, ?)`,
  ).run(
    input.nonce,
    input.agentAddress,
    JSON.stringify(input.authorization),
    input.signature,
    JSON.stringify(input.completion),
    input.servedBy,
    input.modelUsed,
    input.usedTokens,
    input.actualCost,
    now,
    now,
  );
}

interface OrphanRow {
  nonce: string;
  agent_address: string;
  authorization_json: string;
  signature: string;
  completion_json: string;
  served_by: string;
  model_used: string;
  used_tokens: number;
  cost_usdc: string;
  status: string;
  attempt_count: number;
  last_error: string | null;
  tx_hash: string | null;
  created_at: number;
  last_attempt_at: number | null;
  resolved_at: number | null;
}

/**
 * Background reconciliation sweep. For every unresolved orphaned
 * settlement: retry settleAuthorization() against the exact same
 * authorization+signature (no provider call, no new inference) if it
 * hasn't expired yet; if it has, write it off and release its nonce
 * reservation -- safe at that point because verifyAuthorization()'s own
 * expiry check means this authorization can never pass verification
 * again, so the reservation is no longer doing any replay-prevention
 * work by staying claimed.
 *
 * Registered below via runOnScheduleWithLease() (scheduler.ts) rather
 * than a bare setInterval, matching every other periodic sweep in this
 * codebase (see departments.ts's ttl_reaper) -- so a slow reconciliation
 * pass can't overlap itself across a restart or a second process, and a
 * crashed process's in-progress sweep gets reclaimed rather than stuck.
 */
async function reconcileOrphanedSettlements(): Promise<void> {
  const rows = db
    .prepare(`SELECT * FROM orphaned_inference_settlements WHERE status = 'unresolved'`)
    .all() as OrphanRow[];

  for (const row of rows) {
    const authorization: Authorization = JSON.parse(row.authorization_json);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (nowSeconds > Number(authorization.validBefore)) {
      // This authorization can never settle again -- verifyAuthorization()
      // rejects on expiry before it even checks the signature. Write it
      // off and free the nonce so a *new* signed authorization from this
      // agent isn't gated by anything left over from this one.
      db.prepare(
        `UPDATE orphaned_inference_settlements
         SET status = 'expired_writeoff', last_error = 'authorization_expired_before_settlement', last_attempt_at = ?
         WHERE nonce = ?`,
      ).run(Date.now(), row.nonce);
      releaseNonce(row.nonce);
      continue;
    }

    let settlement: Awaited<ReturnType<typeof settleAuthorization>>;
    try {
      settlement = await settleAuthorization(authorization, row.signature as `0x${string}`, "inference-reconciliation");
    } catch (err: any) {
      db.prepare(
        `UPDATE orphaned_inference_settlements
         SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ?
         WHERE nonce = ?`,
      ).run(Date.now(), err?.message ?? "reconciliation_call_threw", row.nonce);
      continue;
    }

    if (!settlement.success) {
      db.prepare(
        `UPDATE orphaned_inference_settlements
         SET attempt_count = attempt_count + 1, last_attempt_at = ?, last_error = ?
         WHERE nonce = ?`,
      ).run(Date.now(), JSON.stringify(settlement.body), row.nonce);
      continue;
    }

    // Settlement succeeded on retry -- this is the moment usage_log
    // finally gets its entry for a completion that was actually served
    // and now actually paid for, closing the gap the original request
    // left open. Cost/units are the ones computed at original request
    // time, not re-estimated now, since that's what the agent's budget
    // actually consumed.
    db.prepare(
      `INSERT INTO usage_log (agent_address, service, units, cost_usdc, created_at)
       VALUES (?, 'inference', ?, ?, ?)`,
    ).run(row.agent_address, row.used_tokens, row.cost_usdc, Date.now());

    db.prepare(
      `UPDATE orphaned_inference_settlements
       SET status = 'resolved', attempt_count = attempt_count + 1, last_attempt_at = ?,
           resolved_at = ?, tx_hash = ?, last_error = NULL
       WHERE nonce = ?`,
    ).run(Date.now(), Date.now(), (settlement.body as any).txHash ?? null, row.nonce);
  }
}

// 90s cadence: frequent enough that a transient settlement failure
// (the common case -- an RPC hiccup, a momentarily-stale nonce on the
// facilitator's own wallet) gets retried well within an authorization's
// typical validity window, but cheap enough that an idle system with no
// orphaned rows costs one no-op SELECT per tick. leaseMs generously
// covers a sweep that has to make several real on-chain calls in one
// pass without mistaking "still working" for "crashed".
runOnScheduleWithLease({
  name: "inference_settlement_reconciler",
  intervalMs: 90_000,
  leaseMs: 5 * 60_000,
  fn: reconcileOrphanedSettlements,
});

/**
 * POST /inference/chat
 * Body: { agentAddress, messages: [...], model?, maxTokens?, xPayment? }
 *
 * Flow:
 *  1. No xPayment attached -> respond 402 with price + facilitator payTo details.
 *  2. xPayment attached -> verify signature/balance, atomically claim the
 *     nonce, proxy to the local llama.cpp model (falling back to
 *     OpenRouter on failure — see runInference() above), then AWAIT
 *     settlement in-process before
 *     responding (same settleAuthorization() call marketplace.ts uses —
 *     see that file's own note on why fire-and-forget was the weaker
 *     pattern). usage_log is only written once settlement actually
 *     succeeds, so a failed settlement never debits the agent's budget
 *     for a completion the platform wasn't paid for.
 *     error-fix.md Phase 10b/10c.
 */
router.post("/chat", async (req, res) => {
  const { agentAddress, messages, model: requestedModel, maxTokens = 1024, xPayment } = req.body;

  if (!agentAddress || !Array.isArray(messages)) {
    return res.status(400).json({ error: "agentAddress and messages[] required" });
  }

  const validatedMaxTokens = parseMaxTokens(maxTokens);
  if (validatedMaxTokens === null) {
    return res.status(400).json({ error: "maxTokens must be an integer between 1 and 8192" });
  }

  const model = resolveModel(requestedModel);

  const budget = checkInferenceBudget(agentAddress);
  if (!budget.ok) {
    return res.status(429).json({ error: "budget_exceeded", reason: budget.reason });
  }

  const estimatedCost = estimateCostUsdc(validatedMaxTokens);

  if (!xPayment) {
    return res.status(402).json({
      x402Version: 1,
      accepts: [
        {
          scheme: "exact",
          network: config.chainNetwork,
          maxAmountRequired: estimatedCost,
          payToAddress: TREASURY_ADDRESS,
          requiredDeadlineSeconds: 300,
          resource: "/inference/chat",
          description: `${config.useLocalModelPrimary ? "Local" : "OpenRouter"} (${model}) inference, up to ${validatedMaxTokens} tokens`,
        },
      ],
    });
  }

  const quoteError = validateInferencePayment(xPayment, {
    agentAddress,
    treasuryAddress: TREASURY_ADDRESS,
    chainNetwork: config.chainNetwork,
    requiredAmountUsdc: estimatedCost,
    maxTokens: validatedMaxTokens,
  });
  if (quoteError) {
    return res.status(402).json({ error: "payment_quote_mismatch", reason: quoteError });
  }

  // Verify the attached payment authorization's signature/balance before
  // doing any inference work. This alone does NOT claim the nonce — see
  // claimNonce() below for why that's a separate step.
  const verifyRes = await fetch(`http://localhost:${config.port}/facilitator/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(xPayment),
  });
  const verification = (await verifyRes.json()) as { isValid: boolean; invalidReason?: string };
  if (!verification.isValid) {
    return res.status(402).json({ error: "payment_invalid", reason: verification.invalidReason });
  }

  const nonce: string | undefined = xPayment?.authorization?.nonce;
  if (!nonce) {
    return res.status(400).json({ error: "payment_missing_nonce" });
  }

  // Atomic claim: the DB's UNIQUE constraint on nonce is what actually
  // closes the race — two concurrent requests for the same authorization
  // can both pass the verify call above (balance hasn't moved yet), but
  // only one can win this INSERT.
  if (!claimNonce(nonce, agentAddress)) {
    return res.status(409).json({ error: "authorization_already_used" });
  }

  let servedBy: "local" | "openrouter";
  let modelUsed: string;
  let completion: any;
  try {
    const result = await runInference(model, messages, validatedMaxTokens);
    completion = result.completion;
    servedBy = result.servedBy;
    modelUsed = result.modelUsed;
  } catch (err: any) {
    // Neither the local model nor (if attempted) the OpenRouter fallback
    // produced a completion — release the nonce so a legitimate retry of
    // the same authorization isn't permanently blocked by a transient
    // failure on our side.
    releaseNonce(nonce);
    return res.status(502).json({ error: "inference_unreachable", detail: err?.message });
  }

  const usedTokens =
    completion.usage?.total_tokens ?? validatedMaxTokens; // fall back if the provider omits usage
  const actualCost = estimateCostUsdc(usedTokens);

  // Settle on-chain and AWAIT it — the old fire-and-forget version
  // responded to the caller before this ever ran, which is what made
  // the double-completion race (10b) possible in the first place. This
  // is the identical settleAuthorization() call marketplace.ts's
  // settleLeg() uses, just called directly instead of over HTTP.
  const settlement = await settleAuthorization(
    xPayment.authorization as Authorization,
    xPayment.signature,
    "inference",
  );

  if (!settlement.success) {
    // The nonce reservation stays in place here on purpose: settlement
    // failing after a valid signed authorization was already consumed
    // against a real completion means this exact authorization must not
    // be retried by a fresh /chat call (that would let it be replayed
    // for a second free completion). But that's not the end of the
    // road for this authorization or this completion -- see
    // INFERENCE-SETTLEMENT-RECONCILIATION-NOTES.md. Persist everything
    // needed to retry settlement against this exact authorization
    // (without re-calling the provider) and to hand back the completion
    // once that retry succeeds, or to safely release the nonce once the
    // authorization itself expires and can never settle at all.
    recordOrphanedSettlement({
      nonce,
      agentAddress,
      authorization: xPayment.authorization as Authorization,
      signature: xPayment.signature,
      completion,
      servedBy,
      modelUsed,
      usedTokens,
      actualCost,
    });
    return res.status(402).json({
      error: "settlement_failed",
      detail: settlement.body,
      // The completion itself wasn't lost -- it's held under this nonce
      // and will be handed back once background reconciliation settles
      // this authorization (or, failing that, once it expires and a
      // fresh authorization becomes usable). See reconciliationHint.
      orphanedNonce: nonce,
      reconciliationHint: `GET /inference/orphaned/${nonce}?agentAddress=${encodeURIComponent(agentAddress)}`,
    });
  }

  // usage_log is only written on confirmed settlement — this closes
  // 10c (the daily inference budget was previously debited even when
  // the async settle call later failed).
  db.prepare(
    `INSERT INTO usage_log (agent_address, service, units, cost_usdc, created_at)
     VALUES (?, 'inference', ?, ?, ?)`,
  ).run(agentAddress, usedTokens, actualCost, Date.now());

  res.json({
    completion,
    usedTokens,
    chargedUsdc: actualCost,
    txHash: settlement.body.txHash,
    servedBy,
    model: modelUsed,
  });
});

/**
 * GET /inference/orphaned/:nonce?agentAddress=0x...
 *
 * Lets a caller whose /chat request got a `settlement_failed` 402 come
 * back later and find out what happened to the completion it already
 * paid the provider for. `agentAddress` is required and checked against
 * the row's own agent_address -- this route hands back a full
 * completion body once resolved, so it must not be fetchable by
 * anyone who merely learned the nonce.
 */
router.get("/orphaned/:nonce", (req, res) => {
  const { nonce } = req.params;
  const { agentAddress } = req.query as { agentAddress?: string };

  if (!agentAddress) {
    return res.status(400).json({ error: "agentAddress_query_param_required" });
  }

  const row = db
    .prepare(`SELECT * FROM orphaned_inference_settlements WHERE nonce = ?`)
    .get(nonce) as OrphanRow | undefined;

  if (!row) {
    return res.status(404).json({ error: "not_found" });
  }
  if (row.agent_address !== agentAddress) {
    return res.status(403).json({ error: "agent_address_mismatch" });
  }

  const base = {
    nonce: row.nonce,
    status: row.status,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    lastAttemptAt: row.last_attempt_at,
  };

  if (row.status === "unresolved") {
    return res.json({ ...base, lastError: row.last_error, message: "settlement retry still pending" });
  }
  if (row.status === "expired_writeoff") {
    return res.json({
      ...base,
      lastError: row.last_error,
      message: "authorization expired before settlement succeeded; nonce released, use a new authorization",
    });
  }

  // resolved
  return res.json({
    ...base,
    completion: JSON.parse(row.completion_json),
    usedTokens: row.used_tokens,
    chargedUsdc: row.cost_usdc,
    txHash: row.tx_hash,
    servedBy: row.served_by,
    model: row.model_used,
    resolvedAt: row.resolved_at,
  });
});

/**
 * GET /inference/orphaned?agentAddress=0x...&status=unresolved
 * Operational visibility into the reconciliation queue -- unscoped by
 * agentAddress this would leak completions across agents like the
 * per-nonce route above, so it's required here too.
 */
router.get("/orphaned", (req, res) => {
  const { agentAddress, status } = req.query as { agentAddress?: string; status?: string };
  if (!agentAddress) {
    return res.status(400).json({ error: "agentAddress_query_param_required" });
  }

  const rows = status
    ? db
        .prepare(
          `SELECT nonce, status, attempt_count, last_error, tx_hash, created_at, last_attempt_at, resolved_at
           FROM orphaned_inference_settlements WHERE agent_address = ? AND status = ?
           ORDER BY created_at DESC`,
        )
        .all(agentAddress, status)
    : db
        .prepare(
          `SELECT nonce, status, attempt_count, last_error, tx_hash, created_at, last_attempt_at, resolved_at
           FROM orphaned_inference_settlements WHERE agent_address = ?
           ORDER BY created_at DESC`,
        )
        .all(agentAddress);

  res.json({ orphaned: rows });
});

export default router;
