import express from "express";
import { config } from "./config.js";
import { db } from "./db.js";
import * as pty from "./ptyService.js";
import { requireOwnedSandbox } from "./capability.js";

const router = express.Router();

/** Same allowlist /vm/exec already enforces — a PTY is just another way to run a command. */
function isCommandAllowed(command: string): boolean {
  if (config.vmAllowedCommands.length === 0) return true;
  const bin = command.trim().split(/\s+/)[0];
  return config.vmAllowedCommands.includes(bin);
}

// POST /vm/pty/create  { agentAddress, command, cols, rows, sandboxId? }
// Without sandboxId: that agent's own lazily-created default sandbox
// (same one /vm/exec falls back to — see vmService.ts's
// getOrCreateDefaultSandbox), not the old cross-agent shared container.
// With sandboxId: that agent's isolated sandbox, same ownership check
// /vm/exec uses.
router.post("/create", async (req, res) => {
  const { agentAddress, command, cols, rows, sandboxId } = req.body;
  if (!agentAddress || !command) {
    return res.status(400).json({ error: "agentAddress and command required" });
  }
  if (!isCommandAllowed(command)) {
    return res.status(403).json({ error: `command not allowed: ${command}` });
  }

  try {
    if (sandboxId) requireOwnedSandbox(sandboxId, agentAddress);
  } catch (err: any) {
    return res.status(err.status || 403).json({ error: err.message });
  }

  const result = await pty.createSession(agentAddress, command, cols, rows, sandboxId);
  if ("error" in result) return res.status(403).json(result);

  db.prepare(
    `INSERT INTO usage_log (agent_address, service, units, cost_usdc, created_at)
     VALUES (?, 'pty_create', 1, '0', ?)`,
  ).run(agentAddress, Date.now());

  res.json({ sessionId: result.id, command, cols: cols || 80, rows: rows || 24, state: "running" });
});

// POST /vm/pty/write  { agentAddress, sessionId, input }
router.post("/write", (req, res) => {
  const { agentAddress, sessionId, input } = req.body;
  if (!agentAddress || !sessionId || input === undefined) {
    return res.status(400).json({ error: "agentAddress, sessionId, input required" });
  }
  const result = pty.writeToSession(agentAddress, sessionId, input);
  if ("error" in result) return res.status(404).json(result);
  res.json({ ok: true, bytesWritten: Buffer.byteLength(input, "utf8") });
});

// GET /vm/pty/read?agentAddress=...&sessionId=...&full=true
router.get("/read", (req, res) => {
  const agentAddress = String(req.query.agentAddress || "");
  const sessionId = String(req.query.sessionId || "");
  const full = req.query.full === "true";
  if (!agentAddress || !sessionId) {
    return res.status(400).json({ error: "agentAddress and sessionId required" });
  }
  const result = pty.readFromSession(agentAddress, sessionId, full);
  if ("error" in result) return res.status(404).json(result);
  res.json(result);
});

// POST /vm/pty/close  { agentAddress, sessionId }
router.post("/close", async (req, res) => {
  const { agentAddress, sessionId } = req.body;
  if (!agentAddress || !sessionId) {
    return res.status(400).json({ error: "agentAddress and sessionId required" });
  }
  const result = await pty.closeSession(sessionId, agentAddress);
  if ("error" in result) return res.status(404).json(result);
  res.json({ ok: true, finalState: "closed" });
});

// GET /vm/pty/list?agentAddress=...
router.get("/list", (req, res) => {
  const agentAddress = String(req.query.agentAddress || "");
  if (!agentAddress) return res.status(400).json({ error: "agentAddress required" });
  res.json({ sessions: pty.listSessions(agentAddress) });
});

export default router;
