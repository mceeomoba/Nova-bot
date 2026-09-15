/**
 * Telegram Notifier Bot
 *
 * Reads from backend's ecosystem_events table (via a small read-only
 * HTTP endpoint you add — see bottom of this file for the route),
 * groups by department, and sends to ONE Telegram supergroup using
 * Topics (one topic thread per department). This is the "everything
 * going on in the ecosystem" view, but pre-filtered and pre-formatted
 * — never raw relay traffic.
 *
 * Rate-limit strategy:
 *   - CRITICAL events (kill, freeze, error_critical) send immediately,
 *     one message each — these are rare enough this never hits limits.
 *   - Everything else batches into one digest message per department
 *     every DIGEST_INTERVAL_MS (default 45s). One message with N lines
 *     costs Telegram the same as one message with 1 line — this is
 *     what actually keeps you under the ~20/min-per-chat ceiling as
 *     agent count grows, instead of 1 message per event.
 *   - If a digest would exceed Telegram's ~4096 char message limit,
 *     it's split into multiple messages, still batched, never one-per-event.
 *
 * Setup: create a Telegram supergroup, enable Topics (group settings
 * -> Topics -> on), create 5 topics named Finance/CEO/Security/
 * Marketing/Opportunity, and note each topic's message_thread_id
 * (right-click the topic -> Copy Link, the number at the end).
 */

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN!;
const CHAT_ID = process.env.TG_CHAT_ID!; // the supergroup's chat id (negative number)
const BACKEND_EVENTS_URL = process.env.BACKEND_EVENTS_URL!; // e.g. https://your-backend/admin/control/events
const ADMIN_API_KEY = process.env.ADMIN_API_KEY!;
const DIGEST_INTERVAL_MS = Number(process.env.DIGEST_INTERVAL_MS || 45_000);

const TOPIC_IDS: Record<string, number> = {
  finance: Number(process.env.TOPIC_FINANCE),
  ceo: Number(process.env.TOPIC_CEO),
  security: Number(process.env.TOPIC_SECURITY),
  marketing: Number(process.env.TOPIC_MARKETING),
  opportunity: Number(process.env.TOPIC_OPPORTUNITY),
};

const CRITICAL_EVENT_TYPES = new Set(["kill", "freeze", "error_critical"]);

const TG_API = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;

interface EcosystemEvent {
  id: string;
  agentAddress: string;
  agentName: string | null;
  role: string | null;
  subRole: string | null;
  department: string;
  eventType: string;
  message: string;
  createdAt: number;
}

async function fetchUndelivered(): Promise<EcosystemEvent[]> {
  const resp = await fetch(`${BACKEND_EVENTS_URL}?limit=200`, {
    headers: { "x-admin-key": ADMIN_API_KEY },
  });
  if (!resp.ok) throw new Error(`events fetch failed: ${resp.status}`);
  return (await resp.json()).events;
}

async function markDelivered(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await fetch(`${BACKEND_EVENTS_URL}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_API_KEY },
    body: JSON.stringify({ ids }),
  });
}

// Simple per-chat throttle: Telegram allows ~1 msg/sec to the same chat.
let lastSendAt = 0;
async function tgSend(threadId: number, text: string): Promise<void> {
  const wait = Math.max(0, lastSendAt + 1100 - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendAt = Date.now();

  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      message_thread_id: threadId,
      text,
      parse_mode: "Markdown",
    }),
  });
}

function formatLine(e: EcosystemEvent): string {
  // "company / position / sub-position -> message", matching what you described.
  const who = [e.agentName || e.agentAddress.slice(0, 10), e.role, e.subRole].filter(Boolean).join(" / ");
  return `• *${who}*: ${e.message}`;
}

function chunkForTelegram(lines: string[], header: string): string[] {
  const messages: string[] = [];
  let current = header;
  for (const line of lines) {
    if (current.length + line.length + 1 > 3800) {
      messages.push(current);
      current = header;
    }
    current += "\n" + line;
  }
  if (current !== header) messages.push(current);
  return messages;
}

async function runOnce(): Promise<void> {
  const events = await fetchUndelivered();
  if (events.length === 0) return;

  const critical = events.filter((e) => CRITICAL_EVENT_TYPES.has(e.eventType));
  const routine = events.filter((e) => !CRITICAL_EVENT_TYPES.has(e.eventType));

  const delivered: string[] = [];

  // Critical: one message each, immediately, regardless of department batching.
  for (const e of critical) {
    const threadId = TOPIC_IDS[e.department];
    await tgSend(threadId, `🚨 ${formatLine(e)}`);
    delivered.push(e.id);
  }

  // Routine: batched digest per department.
  const byDept = new Map<string, EcosystemEvent[]>();
  for (const e of routine) {
    if (!byDept.has(e.department)) byDept.set(e.department, []);
    byDept.get(e.department)!.push(e);
  }

  for (const [dept, deptEvents] of byDept) {
    const threadId = TOPIC_IDS[dept];
    const header = `*${dept.toUpperCase()} — ${deptEvents.length} update(s)*`;
    const lines = deptEvents.map(formatLine);
    for (const chunk of chunkForTelegram(lines, header)) {
      await tgSend(threadId, chunk);
    }
    delivered.push(...deptEvents.map((e) => e.id));
  }

  await markDelivered(delivered);
}

async function main() {
  console.log("notifier-bot: running digest loop every", DIGEST_INTERVAL_MS, "ms");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce();
    } catch (err) {
      console.error("digest cycle failed", err);
    }
    await new Promise((r) => setTimeout(r, DIGEST_INTERVAL_MS));
  }
}

main();

/**
 * Weekly report delivery — separate poll loop, same bot/token, since PDFs
 * arrive on a totally different cadence (weekly) than events (near-realtime).
 * Reads from BACKEND_REPORTS_URL (backend/src/weeklyReportRoutes.ts's
 * GET /admin/control/reports/pending, already mounted in index.ts), sends
 * each as a real Telegram document via sendDocument (multipart, not JSON —
 * Telegram's Bot API requires actual multipart/form-data for file uploads),
 * then acks so it isn't resent.
 */
const BACKEND_REPORTS_URL = process.env.BACKEND_REPORTS_URL!; // e.g. https://your-backend/admin/control/reports
const REPORTS_POLL_INTERVAL_MS = Number(process.env.REPORTS_POLL_INTERVAL_MS || 5 * 60_000); // 5 min is plenty for a weekly artifact
const REPORTS_CHAT_ID = process.env.TG_REPORTS_CHAT_ID || CHAT_ID; // defaults to the same ecosystem group; set separately if you want reports in their own chat/topic
const REPORTS_THREAD_ID = process.env.TOPIC_FINANCE ? Number(process.env.TOPIC_FINANCE) : undefined; // reports are financial documents — same topic as routine finance digests by default

interface PendingReport {
  id: string;
  agent_address: string;
  agent_name: string | null;
  period_start: number;
  period_end: number;
  pdf_base64: string;
  created_at: number;
}

async function fetchPendingReports(): Promise<PendingReport[]> {
  const resp = await fetch(`${BACKEND_REPORTS_URL}/pending`, {
    headers: { "x-admin-key": ADMIN_API_KEY },
  });
  if (!resp.ok) throw new Error(`reports fetch failed: ${resp.status}`);
  return (await resp.json()).reports;
}

async function ackReports(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await fetch(`${BACKEND_REPORTS_URL}/pending/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_API_KEY },
    body: JSON.stringify({ ids }),
  });
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Real multipart upload — Telegram rejects a JSON body for sendDocument. */
async function tgSendDocument(threadId: number | undefined, filename: string, pdfBytes: Buffer, caption: string): Promise<void> {
  const wait = Math.max(0, lastSendAt + 1100 - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendAt = Date.now();

  const form = new FormData();
  form.append("chat_id", String(REPORTS_CHAT_ID));
  if (threadId) form.append("message_thread_id", String(threadId));
  form.append("caption", caption);
  form.append("document", new Blob([new Uint8Array(pdfBytes)], { type: "application/pdf" }), filename);

  const resp = await fetch(`${TG_API}/sendDocument`, { method: "POST", body: form });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`sendDocument failed: ${resp.status} ${body}`);
  }
}

async function runReportsOnce(): Promise<void> {
  const reports = await fetchPendingReports();
  if (reports.length === 0) return;

  const delivered: string[] = [];
  for (const r of reports) {
    const name = r.agent_name || r.agent_address.slice(0, 10);
    const filename = `weekly-report-${name.replace(/[^a-z0-9]/gi, "_")}-${fmtDate(r.period_end)}.pdf`;
    const caption = `📊 *${name}* — weekly report, ${fmtDate(r.period_start)} to ${fmtDate(r.period_end)}`;
    try {
      await tgSendDocument(REPORTS_THREAD_ID, filename, Buffer.from(r.pdf_base64, "base64"), caption);
      delivered.push(r.id);
    } catch (err) {
      // Don't ack a report that failed to send — leave it pending so
      // the next poll cycle retries it, same failure-handling shape
      // as the event digest loop above.
      console.error(`failed to deliver report ${r.id}`, err);
    }
  }
  await ackReports(delivered);
}

async function reportsMain() {
  console.log("notifier-bot: reports poll loop every", REPORTS_POLL_INTERVAL_MS, "ms");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runReportsOnce();
    } catch (err) {
      console.error("reports cycle failed", err);
    }
    await new Promise((r) => setTimeout(r, REPORTS_POLL_INTERVAL_MS));
  }
}

reportsMain();
