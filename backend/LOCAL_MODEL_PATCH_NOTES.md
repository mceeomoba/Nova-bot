# Local Model Patch Notes

## What changed

`/inference/chat` now serves completions from a local `llama-server`
instance (`qwen3-4b`) running on the same Alibaba Cloud VM as this
backend, instead of OpenRouter's `ox-alpha`. OpenRouter is kept as an
automatic fallback — used only when the local call fails — and as the
path to migrate to a hosted model later without touching this code
again.

**`config.ts`**
- Added `localModelBaseUrl`, `localModelName`, `localModelTimeoutMs`,
  `useLocalModelPrimary`.
- `openrouterApiKey` changed from `required()` to `optionalSecret()` —
  a deployment running local-only shouldn't be forced to have an
  OpenRouter key just to boot. The fallback path checks for its
  presence at the point of use and is simply skipped if unset.

**`inferenceGateway.ts`**
- `ALLOWED_MODELS` now also includes `localModelName`.
- `resolveModel()` defaults to the local model (or OpenRouter, if
  `USE_LOCAL_MODEL_PRIMARY=false`) instead of always defaulting to
  `openrouterModel`.
- The old inline OpenRouter-only `fetch` block was split into
  `callLocalModel()` / `callOpenRouter()` / `runInference()`.
  `runInference()` tries the local model first, falls back to
  OpenRouter on any failure (network error, timeout, non-2xx), and
  goes straight to OpenRouter if the caller explicitly requested an
  OpenRouter model by name.
- The response now includes `servedBy: "local" | "openrouter"` and
  `model` (the model actually used) so callers — and you, watching
  logs — can tell which one served a given request.

**`.env.example` / `README.md`** — updated to document the new env
vars and the local-first, OpenRouter-fallback setup.

**`agent/src/types.ts`** — `DEFAULT_CONFIG.inferenceModel` changed
from `"gpt-5.2"` to `"qwen3-4b"`, matching what the backend now
actually serves by default. This is only the label an agent sends
along with each request — the backend's own allowlist is what
actually decides what gets served, so this change is cosmetic/
logging-accuracy only, not load-bearing.

## What did NOT change

- The x402 payment/budget system (`checkInferenceBudget`,
  `PRICE_PER_1K_TOKENS_USDC`, settlement) is untouched — agents still
  pay the same way for inference regardless of which model serves it.
  That's a deliberate choice: your platform's usage pricing isn't a
  pass-through of provider cost, and ripping out billing wasn't part
  of this request. Worth a conscious decision on your end later if you
  want local-served requests priced differently (or free).
- `agent/src/inference/provider-registry.ts` (the separate
  OpenAI/Groq/Together/local `UnifiedInferenceClient` framework) was
  **not** touched. Per `MIGRATION-NOTES.md`, the agent's live path to
  this backend goes through `agent/src/backend/inference.ts` →
  `POST /inference/chat`, not through that framework — so that's where
  this change belongs. If you're also using `provider-registry.ts`
  directly somewhere, its own `"local"` provider entry (pointed at
  Ollama's port 11434, not llama.cpp's 8080) is unrelated and still
  disabled by default.

## Before you deploy

1. Start `llama-server` on the VM serving Qwen3-4B, bound to
   `127.0.0.1:8080` (or set `LOCAL_MODEL_BASE_URL` to match wherever
   you actually run it).
2. Set `LOCAL_MODEL_NAME` to whatever `--alias` (if any) you started
   the server with — purely cosmetic (llama.cpp ignores an unknown
   `model` field and serves whatever GGUF it loaded), but keeps
   `usage_log`/response labels honest.
3. `OPENROUTER_API_KEY` is now optional. Leave it unset if you don't
   want a fallback yet; a local-model failure will surface as a
   `502 inference_unreachable` instead of silently switching
   providers. Set it whenever you want the fallback live.
4. `npm run build` and restart the backend service.
