/**
 * Dynamic Tool Registration — HTTP surface
 *
 * agent-runtime (a separate process, no direct DB access — see
 * subagents.ts's own "separate process" note) reaches customTools.ts's
 * storage through this thin route file, the same shape
 * toolRegistryRoutes.ts already established for GET /available.
 *
 * Mounted at `/custom-tools` in index.ts, behind the same shared-secret
 * `x-backend-key` middleware every other agent-facing route sits behind.
 *
 * Unlike GET /tool-registry/available (deliberately NOT ownership-scoped
 * — a resolved grant is a function of tier/role, not of any one agent),
 * every route here IS scoped by `agentAddress`: a custom tool's
 * `command` only makes sense inside the registering agent's own
 * sandbox, so one agent must never see or invoke another's.
 *
 * GET /definition is deliberately never cached anywhere in this call
 * path — agent-runtime's call_registered_tool ACTION fetches fresh on
 * every call, same "no restart needed" reasoning
 * toolRegistryRoutes.ts's own GET /grant-status comment gives for
 * isGrantRevoked(): a tool registered this turn must be callable this
 * same session, and a removed tool must stop working on the very next
 * call, not after some TTL window a caller might still be inside of.
 */

import express from "express";
import {
  registerCustomTool,
  listCustomTools,
  getCustomTool,
  removeCustomTool,
} from "./customTools.js";

const router = express.Router();

function requireAgentAddress(req: express.Request, res: express.Response): string | null {
  const agentAddress =
    typeof req.query.agentAddress === "string"
      ? req.query.agentAddress
      : typeof req.body?.agentAddress === "string"
        ? req.body.agentAddress
        : undefined;
  if (!agentAddress) {
    res.status(400).json({ error: "agentAddress is required" });
    return null;
  }
  return agentAddress;
}

// POST /custom-tools/register
// body: { agentAddress, name, description, parameters, command }
router.post("/register", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;

    const { name, description, parameters, command } = req.body || {};
    if (typeof name !== "string" || typeof description !== "string" || typeof command !== "string") {
      return res.status(400).json({ error: "name, description, and command are all required strings" });
    }

    const result = registerCustomTool(
      agentAddress,
      name,
      description,
      typeof parameters === "object" && parameters !== null ? parameters : { type: "object", properties: {} },
      command,
    );
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ success: true, name });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// GET /custom-tools/list?agentAddress=0x...
router.get("/list", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const tools = listCustomTools(agentAddress);
    res.json({
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        createdAt: t.createdAt,
      })),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// GET /custom-tools/definition?agentAddress=0x...&name=my_tool
// Used by agent-runtime's call_registered_tool dispatch — fetched fresh
// on every call, never cached (see header comment).
router.get("/definition", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) return res.status(400).json({ error: "name is required" });

    const tool = getCustomTool(agentAddress, name);
    if (!tool) {
      return res.status(404).json({ error: `No tool named "${name}" found for this agent.` });
    }
    res.json({ name: tool.name, description: tool.description, parameters: tool.parameters, command: tool.command });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// DELETE /custom-tools/remove?agentAddress=0x...&name=my_tool
router.delete("/remove", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) return res.status(400).json({ error: "name is required" });

    const result = removeCustomTool(agentAddress, name);
    if (!result.success) {
      return res.status(404).json({ error: result.error });
    }
    res.json({ success: true, name });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

export default router;
