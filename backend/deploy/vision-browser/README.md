# Shared local browser perception

Start exactly two long-lived `llama-server` processes with `start-local-models.sh`:

- `qwen3-4b` at `127.0.0.1:8080/v1` is the shared reasoning model.
- `smolvlm2-500m` at `127.0.0.1:8081/v1` is the shared perception model.

Do not start either process per agent or department. `--parallel` queues concurrent
requests in one process; size it to VM RAM/VRAM after measuring real latency.

The vision server needs its matching `--mmproj`; without it, image requests are
not valid vision inference. It has an API key and no Web UI. Keep its listener on
loopback. If Docker browser sandboxes must reach it, expose it only through a
private authenticated proxy or a dedicated internal network; do not publish port
8081 to the public Internet.

Set `LOCAL_MODEL_NAME=qwen3-4b` and the actual `LOCAL_MODEL_BASE_URL` in the
backend environment. `VISION_MODEL_*` is configuration for the browser-perception
bridge; it must be injected into the browser sandbox only through a secret-aware
deployment mechanism, never committed into this repository.

Smoke checks from the VM:

```bash
curl -fsS http://127.0.0.1:8080/v1/models
curl -fsS -H "Authorization: Bearer $(cat /etc/automaton/vision-api-key)" http://127.0.0.1:8081/v1/models
```

The browser execution sequence is: screenshot → SmolVLM2 perception → Qwen
planning → deterministic safety validator → controller action → screenshot and
filesystem verification. CAPTCHA bypassing is not implemented or permitted.
