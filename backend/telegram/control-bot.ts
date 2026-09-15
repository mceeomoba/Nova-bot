/**
 * Telegram Control Bot
 *
 * Commands (all take an agent address as argument — nothing is
 * hardcoded per-agent, so this never needs redeploying as your
 * ecosystem grows):
 *
 *   /agents                 list all known agents + frozen status
 *   /status <address>       quick status for one agent
 *   /kill <address> [reason]     freeze funds + request shutdown
 *   /unfreeze <address> [reason] undo a freeze (does NOT un-request shutdown history, just unblocks funds)
 *
 * Auth model: ADMIN_TELEGRAM_USER_IDS is a hardcoded allowlist of
 * Telegram numeric user IDs (yours, and anyone else you explicitly
 * trust with a kill switch over real money). Every command checks the
 * sender against this list BEFORE doing anything — this bot talks to
 * your backend's /admin/control/* routes using ADMIN_API_KEY, so a
 * leaked bot token without this allowlist would be a leaked kill switch.
 *
 * Run: node control-bot.js  (env: TG_BOT_TOKEN, BACKEND_ADMIN_URL, ADMIN_API_KEY, ADMIN_TELEGRAM_USER_IDS)
 */

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN!;
const BACKEND_ADMIN_URL = process.env.BACKEND_ADMIN_URL!; // e.g. https://your-backend.example.com/admin/control
const ADMIN_API_KEY = process.env.ADMIN_API_KEY!;
const ADMIN_TELEGRAM_USER_IDS = new Set(
  (process.env.ADMIN_TELEGRAM_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean),
);

const TG_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

async function tgSend(chatId: number, text: string): Promise<void> {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
}

async function backendCall(path: string, body?: unknown): Promise<any> {
  const resp = await fetch(`${BACKEND_ADMIN_URL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json?.error || `backend returned ${resp.status}`);
  return json;
}

async function handleCommand(chatId: number, userId: number, text: string): Promise<void> {
  if (!ADMIN_TELEGRAM_USER_IDS.has(String(userId))) {
    await tgSend(chatId, "Not authorized for control commands.");
    return;
  }

  const [cmd, ...args] = text.trim().split(/\s+/);

  try {
    if (cmd === "/agents") {
      const { agents } = await backendCall("/agents");
      if (agents.length === 0) return void (await tgSend(chatId, "No agents registered."));
      const lines = agents
        .slice(0, 30)
        .map((a: any) => `${a.frozen ? "🧊" : "🟢"} \`${a.address}\` (${a.spawn_reason || "root"})`);
      await tgSend(chatId, lines.join("\n"));
      return;
    }

    if (cmd === "/kill") {
      const address = args[0];
      const reason = args.slice(1).join(" ") || "manual kill via Telegram";
      if (!address) return void (await tgSend(chatId, "Usage: /kill <address> [reason]"));
      const result = await backendCall(`/kill/${address}`, { reason });
      await tgSend(
        chatId,
        `🛑 *KILL* \`${address}\`\n` +
          `Funds: ${result.frozen.detail}\n` +
          `Shutdown flag: ${result.shutdownRequested.detail}\n` +
          `Direct signal: ${result.processSignal.detail}`,
      );
      return;
    }

    if (cmd === "/status") {
      const address = args[0];
      if (!address) return void (await tgSend(chatId, "Usage: /status <address>"));
      const s = await backendCall(`/status/${address}`);
      const lines = [
        `${s.frozen ? "🧊 FROZEN" : "🟢 active"} \`${s.address}\`${s.name ? ` (${s.name})` : ""}`,
        `Spawn reason: ${s.spawnReason || "root"}`,
      ];
      if (s.frozen) lines.push(`Frozen reason: ${s.frozenReason || "unknown"}`);
      lines.push(`Shutdown requested: ${s.shutdownRequested ? `yes (${s.shutdownReason || "no reason given"})` : "no"}`);
      lines.push(
        s.process
          ? `Process: ${s.process.status}${s.process.pid ? ` (pid ${s.process.pid})` : ""}`
          : "Process: not tracked by this backend (expected for an operator-run root agent)",
      );
      await tgSend(chatId, lines.join("\n"));
      return;
    }

    if (cmd === "/unfreeze") {
      const address = args[0];
      const reason = args.slice(1).join(" ") || "manual unfreeze via Telegram";
      if (!address) return void (await tgSend(chatId, "Usage: /unfreeze <address> [reason]"));
      await backendCall(`/unfreeze/${address}`, { reason });
      await tgSend(chatId, `✅ Unfrozen \`${address}\``);
      return;
    }

    await tgSend(chatId, "Commands: /agents, /status <addr>, /kill <addr> [reason], /unfreeze <addr> [reason]");
  } catch (err: any) {
    await tgSend(chatId, `⚠️ ${err.message}`);
  }
}

// --- Minimal long-polling loop (swap for a webhook once you have a public URL) ---
let offset = 0;
async function poll(): Promise<void> {
  const resp = await fetch(`${TG_API}/getUpdates?timeout=30&offset=${offset}`);
  const data = await resp.json();
  for (const update of data.result || []) {
    offset = update.update_id + 1;
    const msg = update.message;
    if (!msg?.text) continue;
    await handleCommand(msg.chat.id, msg.from.id, msg.text);
  }
}

async function main() {
  console.log("control-bot: polling...");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await poll();
    } catch (err) {
      console.error("poll error", err);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main();
