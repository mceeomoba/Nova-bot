# Deploying to the VM (16GB RAM / 4-core / 100GB, CPU-only)

Everything below assumes:
- Agent repo cloned to `/root/nova`
- Backend repo cloned to `/root/nova-backend` (the Telegram bots live
  inside this repo now, at `backend/telegram/` — not a separate folder)
- Models already downloaded to `/root/Downloads/AI-VM/` (qwen3-4b/, vision/, llama.cpp/)

If any of those paths differ on your actual box, the placeholders are in
each `.service` file's `WorkingDirectory`/`ExecStart`/`EnvironmentFile`
lines — update them there before enabling anything.

## One-time setup, in order

1. **Swap** (do this first — everything else is more forgiving with it in place):
   ```
   sudo ./deploy/setup-swap.sh
   ```

2. **Env files** — copy each `.env.example` to `.env` and fill in real
   values (see the credentials walkthrough from earlier in this
   conversation for what goes where):
   ```
   cp agent/.env.example agent/.env
   cp backend/.env.example backend/.env
   ```
   Only two `.env` files now — the Telegram bots read `backend/.env`
   directly (no separate `telegram/.env` anymore; see the "Telegram
   bots" section near the bottom of `backend/.env.example`).
   `BACKEND_API_KEY` must match between `agent/.env` and `backend/.env`.
   The vision model's API key must match between `backend/.env`
   (`VISION_MODEL_API_KEY`) and the key file `llama-vision.service`
   reads from (`/etc/automaton/vision-api-key`).

3. **Build everything:**
   ```
   cd /root/nova && npm install -g pnpm@10.28.1 && pnpm install --frozen-lockfile && pnpm run build
   cd /root/nova-backend && npm install && npm run build
   ```
   (`deploy/build-llama-cpp.sh` builds llama.cpp itself — step 5 runs it
   automatically, no separate step needed here. The Telegram bots need
   no build step of their own — they're plain `.ts` files Node runs
   directly via its built-in type stripping, verified working.)

4. **Install the systemd units:**
   ```
   sudo cp deploy/*.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```

5. **Enable and start, in dependency order** (systemd resolves this
   automatically via each unit's `After=`/`Wants=`/`Requires=`, so
   `--now` on the last one is enough, but listing them explicitly here
   so you know what's actually coming up and in what order):
   ```
   sudo systemctl enable --now llama-cpp-build.service     # builds llama-server if needed, one-shot
   sudo systemctl enable --now llama-qwen3-4b.service       # primary inference, port 8080
   sudo systemctl enable --now llama-vision.service         # vision model, port 8081
   sudo systemctl enable --now automaton-backend.service    # port from PUBLIC_BASE_URL/.env
   sudo systemctl enable --now automaton-agent.service      # runs `node dist/index.js --run`
   sudo systemctl enable --now telegram-control-bot.service    # optional, requires automaton-backend
   sudo systemctl enable --now telegram-notifier-bot.service   # optional, requires automaton-backend
   ```

## What happens automatically after this

- The agent checks for upstream updates and runs a self-reflection pass
  **immediately on this first launch** (forced, not waiting for cron —
  see `agent/src/index.ts`), then **weekly** after that (Sundays,
  03:00/03:15 UTC — `agent/src/heartbeat/config.ts`). It reviews changes
  itself before applying anything; nothing here bypasses that.
- If the agent applies a self-mod change, it restarts itself via
  `systemctl restart automaton-agent` (`AGENT_RESTART_COMMAND` in
  `agent/.env`) — systemd's own `Restart=always` is a separate,
  unrelated safety net for actual crashes, not what triggers this.

## Checking it's actually working

```
sudo systemctl status automaton-backend automaton-agent llama-qwen3-4b llama-vision telegram-control-bot telegram-notifier-bot
sudo journalctl -u automaton-agent -f       # live agent logs
curl http://127.0.0.1:8080/health           # qwen3-4b llama-server
curl http://127.0.0.1:8081/health           # vision llama-server
free -h                                     # confirm swap is active, watch real usage under load
```

To test a Telegram bot manually without going through systemd first:
```
cd /root/nova-backend && npm run telegram:control-bot
# or: npm run telegram:notifier-bot
```

## Memory headroom

This box's real memory budget (backend + agent + both models) leaves
about 10GB of headroom for sandboxes on the actual 16GB this VM has
(an earlier pass through this setup assumed 8GB before the real spec
was confirmed — if you're reading an older copy of this README, the
numbers there are stale). `MAX_SANDBOX_MEMORY_MB` /
`MAX_SANDBOXES_PER_AGENT` / `MAX_ENVIRONMENT_SANDBOXES_PER_AGENT` in
`backend/.env.example` are tuned for this 16GB box specifically — all
6 default departments (`DEFAULT_MAX_DEPARTMENTS_PER_AGENT`) can run
persistent sandboxes concurrently with real headroom left over, no
scaling tension to worry about at launch.
