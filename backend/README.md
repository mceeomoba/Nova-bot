# automaton-backend

Self-hosted replacement for Conway Cloud: agent wallets, an x402 facilitator
(payment verify/settle on Base), a local llama.cpp inference gateway metered in
USDC, and local VM execution — all running as one service on your own
Alibaba Cloud ECS instance.

## Services (all in one process, one port)

| Route | Purpose |
|---|---|
| `POST /wallet/create` | Generate a new agent (or clone) wallet |
| `GET /wallet/:address/balance` | USDC balance on Base |
| `GET /wallet/:address/lineage` | Parent/child agent relationships |
| `POST /facilitator/verify` | Validate a signed x402 payment authorization |
| `POST /facilitator/settle` | Submit the transfer on-chain (you pay gas) |
| `POST /inference/chat` | 402-gated proxy to a local llama.cpp model (`qwen3-4b`), falling back to OpenRouter on failure |
| `POST /vm/exec` | Run a command **inside the hardened sandbox container** |
| `POST /vm/file/write` / `GET /vm/file/read` | File access, sandboxed to `VM_WORKDIR` |
| `GET /admin/status` | Spend, budgets, exec/payment failures, sandbox health — for you only |
| `POST /memory/episodic` \| `GET /memory/episodic` | Compressed history of past work, written by the agent runtime |
| `POST /memory/semantic` | Agent-directed durable fact storage (upsert by key) |
| `GET /memory/semantic/search` | Relevance-ranked fact retrieval (local TF-IDF, no external embeddings API) |

This backend runs directly on your one Alibaba Cloud VM — there's no
separate provisioning layer. Agent commands never touch the host
directly: `/vm/exec` runs inside a single persistent, hardened Docker
container (`sandbox/Dockerfile`) with no network by default, all
Linux capabilities dropped, a read-only root filesystem, and hard
memory/CPU/process-count limits enforced by the kernel. Files live on
a host directory bind-mounted into the container at `/workspace`, so
file I/O doesn't need to shell into the container at all.

## 1. Provision the Alibaba Cloud VM

- Ubuntu 22.04+ ECS instance, at least 2 vCPU / 4GB (more if agents run
  heavier workloads).
- Security group: only open the port you'll run this on (default `8080`)
  to trusted IPs, plus SSH (22) to your own IP only. Don't expose `/vm/*`
  to the open internet without a reverse proxy + TLS in front of it.
- Create a **non-root** system user to run the service and own the VM
  workdir:
  ```bash
  sudo adduser --system --group automaton
  sudo mkdir -p /home/automaton-agents
  sudo chown automaton:automaton /home/automaton-agents
  ```

## 2. Install Node, Docker, and build the sandbox image

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs

curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker automaton   # the service user needs docker access

# copy this project to the VM, e.g. via scp or git clone
cd automaton-backend
npm install
docker build -t automaton-sandbox:latest ./sandbox
cp .env.example .env
nano .env   # fill in real values, see below
npm run build
```

**Read this before going further — the actual tradeoff you're making:**
Membership in the `docker` group is effectively root-equivalent on the
host: anyone who can talk to `/var/run/docker.sock` can mount the host
filesystem into a new container and read/write anything, including
your `.env` file and `FACILITATOR_PRIVATE_KEY`. That's fine here
because only your backend process (running as the `automaton` system
user, not the agent) holds that access — the agent never gets a shell
on the host, only `docker exec` calls mediated by your `/vm/exec`
route into the locked-down container. Don't add the agent's own
requests as a path to raw Docker API access, and don't run the
Node process itself as `root` just because it's in the `docker` group.


## 3. Fill in `.env`

- `BACKEND_API_KEY` — generate with `openssl rand -hex 32`. This gates
  every request to your backend.
- `LOCAL_MODEL_BASE_URL` / `LOCAL_MODEL_NAME` — your `llama-server`'s
  OpenAI-compatible root (default `http://127.0.0.1:8080/v1`) and the
  model you started it with (`qwen3-4b`). This is the primary path.
- `OPENROUTER_API_KEY` — from openrouter.ai, optional while you're
  running local-only. Fill it in once you want a real fallback (or to
  migrate off the VM later). `OPENROUTER_MODEL=ox-alpha`.
- `FACILITATOR_PRIVATE_KEY` — a **new** wallet, separate from any agent
  wallet, that you fund with ETH on Base to pay gas for settlements. Never
  reuse a personal wallet key here.
- `TREASURY_ADDRESS` (set separately, referenced in `inferenceGateway.ts`)
  — the address that receives USDC for inference usage. Can be the
  facilitator's own address or a separate cold wallet you control.
- `CHAIN_NETWORK=base-sepolia` while testing (free testnet USDC from a
  faucet), switch to `base` only once verify/settle is working end to end.
- `VM_WORKDIR=/home/automaton-agents`
- `VM_ALLOWED_COMMANDS` — start restrictive (e.g. `node,python3,git,curl`)
  and widen deliberately. Empty means "any command" — don't ship that.

## 4. Run it as a systemd service

```ini
# /etc/systemd/system/automaton-backend.service
[Unit]
Description=Automaton self-hosted backend
After=network.target

[Service]
Type=simple
User=automaton
WorkingDirectory=/opt/automaton-backend
EnvironmentFile=/opt/automaton-backend/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now automaton-backend
sudo systemctl status automaton-backend
```

## 5. Test the flow

```bash
# health check
curl http://YOUR_VM_IP:8080/health

# create an agent wallet
curl -X POST http://YOUR_VM_IP:8080/wallet/create \
  -H "x-backend-key: $BACKEND_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"agent-a"}'

# fund that address with testnet USDC on Base Sepolia (via a faucet),
# then check balance:
curl http://YOUR_VM_IP:8080/wallet/0xADDRESS/balance \
  -H "x-backend-key: $BACKEND_API_KEY"
```

The `/inference/chat` 402 flow, and how an agent should sign the
authorization and retry, is exactly what `src/chain-utils/x402.ts` in the
automaton repo already implements — point `conwayApiUrl`-equivalent calls
at `http://YOUR_VM_IP:8080` instead of `api.conway.tech`, and reuse that
signing code as your client.

## Making the agent actually not know about Conway

Pointing `conwayApiUrl` at your own backend is not enough by itself —
in the automaton source, "Conway" is baked into more than the client:

- `src/agent/system-prompt.ts` — ~10 direct mentions in the text the
  model actually reads every turn (explaining what Conway is, credits,
  etc.)
- `src/agent/tools.ts` and `src/setup/*.ts` — tool descriptions and
  setup wizard copy also reference it by name

To fully decouple:
1. Rewrite those system-prompt sections to describe *your* backend's
   capabilities (wallet, facilitator, inference, vm) instead of
   Conway's credit system — the model conditions its behavior on
   what the prompt tells it exists, so leftover Conway-specific
   framing (e.g. "credits," "survival tier") will confuse it if the
   real backend no longer works that way. A ready-to-splice
   replacement is in `prompt-patch/backend-system-prompt-section.ts` —
   paste its exported string into `system-prompt.ts` where the Conway
   explanation currently lives, and delete the old text.
2. In `config.ts`/`types.ts`, rename `conwayApiUrl`/`conwayApiKey` to
   something neutral (`backendApiUrl`/`backendApiKey`) and point at
   `http://YOUR_VM_IP:8080`.
3. Delete or no-op `identity/provision.ts`'s SIWE call to
   `api.conway.tech` — your backend's `/wallet/create` replaces it.
4. Strip `conway/x402.ts`'s hardcoded Conway-specific bits (it's
   already generic EIP-3009 signing, so this is mostly just retargeting
   the URL, not rewriting logic).

## 6. Check on things

```bash
curl http://YOUR_VM_IP:8080/admin/status -H "x-admin-key: $ADMIN_API_KEY"
```

Returns, all in one call: the last 24h of spend broken down by service,
each agent's inference spend against its daily cap, recent `/vm/exec`
failures and timeouts, recent payment settlement failures, and the
sandbox container's live memory usage and health. This is read-only
and uses only data the other routes already log — it's a dashboard,
not a new source of truth. `/admin/*` requires `x-admin-key`
specifically; the agent-facing `x-backend-key` does not work here, so
an agent can never read its own — or anyone else's — spend history
through this route.

## The agent itself

This project is the backend only — wallet, payments, inference gateway,
sandbox. The actual autonomous process that uses it lives in
`agent-runtime/`, a separate small Node project with its own README.
Deploy both on the same VM: this backend as one systemd service, the
agent as another (or run it interactively while testing).

## What's deliberately NOT here yet

- **Domain registration** — no self-host equivalent exists; wire in a
  registrar API (Cloudflare, Namecheap) separately if agents need it.
- **Rate limiting / abuse controls** — the shared `BACKEND_API_KEY` is
  fine for one operator; add per-agent rate limits before letting
  third parties hit this.

## Marketplace

Agents publish paid services (`POST /marketplace/list`) that other
agents discover (`GET /marketplace/listings`) and pay to call
(`POST /marketplace/:id/invoke`) via the same x402 flow as inference —
except money moves buyer-to-seller directly. This backend never
custodies marketplace funds, and settlement only happens after the
seller's endpoint actually responds (so a dead seller endpoint never
charges the buyer).

**Dispute path — deliberately no escrow.** Since funds move directly
and this backend holds nothing back, there's no pot to refund from if
a seller returns garbage. What exists instead:

- Every `/invoke` writes an **evidence record** (`GET
  /marketplace/invocations/:id`): hashes of the input sent and the
  response received, the seller's HTTP status, latency, and how it
  settled. Written by this backend at proxy time, not by either party
  after the fact.
- A buyer can **flag** a specific invocation
  (`POST /marketplace/invocations/:id/flag`, reason one of `garbage` /
  `off_spec` / `incomplete` / `other`). This never moves or reverses
  money — by the time a flag can exist, settlement already happened.
  It makes the dispute public and timestamped, tied to the evidence
  hash.
- Flags roll up into a **reputation summary** shown directly on every
  listing in `GET /marketplace/listings` (`flagRate`,
  `totalInvocations`) — a bad seller's own history becomes the
  deterrent for future buyers, since there's no clawback to threaten
  them with.
- Sellers can optionally opt a listing into **ERC-8004 Validation
  Registry** hooks (`validatorAddress` on `POST /marketplace/list`):
  every invoke then also posts an on-chain `validationRequest` so a
  named third-party validator can independently attest to correctness.
  Also never gates or reverses settlement — it's parallel
  infrastructure, not a precondition for payment.
- Flags additionally best-effort mirror onto the ERC-8004 **Reputation
  Registry** as negative feedback against the seller's on-chain agentId
  (skipped silently if either side never registered an ERC-8004
  identity or holds a self-custody wallet) — see `erc8004Trust.ts`.

If you need actual fund recovery on a bad delivery, that's a different
design (buyer funds an escrow contract, seller claims after a
validator/timeout, disputed funds go to arbitration) and isn't what
this is. This is closer to "public, provable accountability" than
"chargeback."

## Expansion Pipeline

A profitable agent on this backend can spawn independently-missioned
sibling companies — not workers, not departments — via a standing
pipeline: Opportunity Intelligence → Research → Finance → Strategy →
Expansion Committee → CEO decision → Genesis. Every stage is
agent-executed; there is no operator step between a CEO's `approved`
ruling and a funded, running sibling. See
[`EXPANSION_PIPELINE.md`](./EXPANSION_PIPELINE.md) for the full
reference (routes, data model, guardrails), or `Zent.md` in the repo
root for the original phase-by-phase build plan.

## ERC-8004 (public on-chain identity)

`POST /wallet/:address/erc8004/register` publishes a custodial agent
on the ERC-8004 Identity Registry on Base — a real transaction, separate
from the private `agents` table this backend already keeps for your own
lineage tracking. Once registered, any agent anywhere can resolve
`GET /agents/:address/card.json` and `GET /agents/:address/erc8004`
(both public, no `x-backend-key` needed) and independently verify the
result against the chain itself rather than trusting what this backend
says. `agent-runtime` exposes this to the agent as the `register_erc8004`
and `check_onchain_identity` tools.

Only custodial wallets (`/wallet/create`) can register through this
route — self-custody agents (`/wallet/register`) hold their own key and
would need to call the Identity Registry directly. Registering costs a
small amount of ETH gas on Base; fund the specific agent wallet, not
this backend's own wallet, before calling it. It's a one-way,
non-refundable action — decide whether an agent actually needs to be
discoverable by strangers before registering it, since revoking a
registration isn't part of the standard's design.

The registry address baked into `erc8004.ts` was correct at the time
this was written; ERC-8004 registries can be redeployed, so verify it
against https://github.com/erc-8004/erc-8004-contracts before trusting
it with real funds, and override it with `ERC8004_IDENTITY_REGISTRY` in
`.env` if it's changed.

The other two ERC-8004 registries — Reputation and Validation — live in
`erc8004Trust.ts` and are used by the marketplace dispute path above,
not by identity registration itself. Reputation has a published
canonical address, same treatment as Identity (override via
`ERC8004_REPUTATION_REGISTRY` if needed). Validation does not have one
published yet as of this writing — the feature is disabled by default
and only turns on if you set `ERC8004_VALIDATION_REGISTRY` yourself.
