/**
 * Dynamic Tool Registration (backend storage)
 *
 * agent-runtime is a thin HTTP client with no direct DB access (see
 * subagents.ts's "separate process" note) and, unlike tool_registry
 * (grants over a fixed, hardcoded ACTIONS catalog — see toolRegistry.ts's
 * own header on why that's a *permissions* system, not a *definition*
 * system), had NO mechanism at all for an agent to define a genuinely
 * new tool at runtime. Every capability required a code change to both
 * agent-runtime/src/tools.ts's ACTIONS array and its executeTool()
 * switch, plus a redeploy. This module is the storage half of fixing
 * that: an agent calls register_tool (see tools.ts's dispatch case),
 * which lands here, and call_registered_tool looks the definition back
 * up — fetched fresh on every call, never cached, so a tool registered
 * this turn is callable this same session with no restart required.
 *
 * Scoped per agent_address: the `command` a tool wraps only makes sense
 * inside that agent's own sandbox filesystem, so a tool one automaton
 * registers is never visible to another's list_registered_tools/
 * call_registered_tool calls.
 */

import { randomUUID } from "crypto";
import { db } from "./db.js";

export interface CustomTool {
  id: string;
  agentAddress: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  command: string;
  createdAt: number;
  enabled: boolean;
}

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

interface CustomToolRow {
  id: string;
  agent_address: string;
  name: string;
  description: string;
  parameters: string;
  command: string;
  created_at: number;
  enabled: number;
}

function rowToTool(row: CustomToolRow): CustomTool {
  let parameters: Record<string, unknown>;
  try {
    parameters = JSON.parse(row.parameters);
  } catch {
    parameters = { type: "object", properties: {} };
  }
  return {
    id: row.id,
    agentAddress: row.agent_address,
    name: row.name,
    description: row.description,
    parameters,
    command: row.command,
    createdAt: row.created_at,
    enabled: row.enabled === 1,
  };
}

export function registerCustomTool(
  agentAddress: string,
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  command: string,
): { success: boolean; error?: string } {
  if (!NAME_PATTERN.test(name)) {
    return {
      success: false,
      error: `Invalid tool name "${name}" — use letters, numbers, "_" or "-", starting with a letter, max 64 chars.`,
    };
  }
  if (!description.trim()) return { success: false, error: "description is required." };
  if (!command.trim()) return { success: false, error: "command is required." };

  // The UNIQUE(agent_address, name) constraint doesn't distinguish
  // enabled from soft-deleted rows, so a plain INSERT would fail here
  // even after removeCustomTool() disabled the old row — check for
  // BOTH states explicitly: an enabled row blocks (real duplicate); a
  // disabled row gets revived in place (UPDATE, reusing its id) rather
  // than inserted fresh, since the constraint would reject a second
  // INSERT under the same (agent_address, name) regardless of enabled.
  const existing = db
    .prepare(`SELECT id, enabled FROM custom_tools WHERE agent_address = ? AND name = ?`)
    .get(agentAddress, name) as { id: string; enabled: number } | undefined;

  if (existing?.enabled === 1) {
    return { success: false, error: `You already have a tool named "${name}". Remove it first if you want to redefine it.` };
  }

  if (existing) {
    db.prepare(
      `UPDATE custom_tools SET description = ?, parameters = ?, command = ?, created_at = ?, enabled = 1 WHERE id = ?`,
    ).run(description, JSON.stringify(parameters), command, Date.now(), existing.id);
    return { success: true };
  }

  db.prepare(
    `INSERT INTO custom_tools (id, agent_address, name, description, parameters, command, created_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    randomUUID(),
    agentAddress,
    name,
    description,
    JSON.stringify(parameters),
    command,
    Date.now(),
  );

  return { success: true };
}

export function listCustomTools(agentAddress: string): CustomTool[] {
  const rows = db
    .prepare(`SELECT * FROM custom_tools WHERE agent_address = ? AND enabled = 1 ORDER BY created_at ASC`)
    .all(agentAddress) as CustomToolRow[];
  return rows.map(rowToTool);
}

export function getCustomTool(agentAddress: string, name: string): CustomTool | null {
  const row = db
    .prepare(`SELECT * FROM custom_tools WHERE agent_address = ? AND name = ? AND enabled = 1`)
    .get(agentAddress, name) as CustomToolRow | undefined;
  return row ? rowToTool(row) : null;
}

export function removeCustomTool(
  agentAddress: string,
  name: string,
): { success: boolean; error?: string } {
  const result = db
    .prepare(`UPDATE custom_tools SET enabled = 0 WHERE agent_address = ? AND name = ? AND enabled = 1`)
    .run(agentAddress, name);
  if (result.changes === 0) {
    return { success: false, error: `No tool named "${name}" found.` };
  }
  return { success: true };
}
