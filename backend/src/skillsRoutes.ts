/**
 * Skills — HTTP surface
 *
 * Same shape as customToolRoutes.ts: agent-runtime (separate process,
 * no direct DB access) reaches skills.ts's storage through this thin
 * route file. Mounted at `/skills` in index.ts, behind the same
 * shared-secret `x-backend-key` middleware every other agent-facing
 * route sits behind. Every route is ownership-scoped by agentAddress —
 * a skill one agent authors or installs is never visible to another's
 * list_skills/get_skill/call.
 */

import express from "express";
import {
  installSkillFromGit,
  installSkillFromUrl,
  createSkill,
  listSkills,
  getSkill,
  removeSkill,
} from "./skills.js";

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

// POST /skills/install-git   body: { agentAddress, repoUrl, name }
router.post("/install-git", async (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const { repoUrl, name } = req.body || {};
    if (typeof repoUrl !== "string" || typeof name !== "string") {
      return res.status(400).json({ error: "repoUrl and name are both required strings" });
    }
    const result = await installSkillFromGit(agentAddress, repoUrl, name);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, skill: result.skill });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// POST /skills/install-url   body: { agentAddress, url, name }
router.post("/install-url", async (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const { url, name } = req.body || {};
    if (typeof url !== "string" || typeof name !== "string") {
      return res.status(400).json({ error: "url and name are both required strings" });
    }
    const result = await installSkillFromUrl(agentAddress, url, name);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, skill: result.skill });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// POST /skills/create   body: { agentAddress, name, description, instructions }
router.post("/create", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const { name, description, instructions } = req.body || {};
    if (typeof name !== "string" || typeof description !== "string" || typeof instructions !== "string") {
      return res.status(400).json({ error: "name, description, and instructions are all required strings" });
    }
    const result = createSkill(agentAddress, name, description, instructions);
    if (!result.success) return res.status(400).json({ error: result.error });
    res.json({ success: true, skill: result.skill });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// GET /skills/list?agentAddress=0x...
router.get("/list", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const skills = listSkills(agentAddress);
    res.json({
      count: skills.length,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        autoActivate: s.autoActivate,
        source: s.source,
        createdAt: s.createdAt,
      })),
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// GET /skills/get?agentAddress=0x...&name=my_skill
router.get("/get", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    const skill = getSkill(agentAddress, name);
    if (!skill) return res.status(404).json({ error: `No skill named "${name}" found.` });
    res.json({
      name: skill.name,
      description: skill.description,
      autoActivate: skill.autoActivate,
      instructions: skill.instructions,
      source: skill.source,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

// DELETE /skills/remove?agentAddress=0x...&name=my_skill
router.delete("/remove", (req, res) => {
  try {
    const agentAddress = requireAgentAddress(req, res);
    if (!agentAddress) return;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    const result = removeSkill(agentAddress, name);
    if (!result.success) return res.status(404).json({ error: result.error });
    res.json({ success: true, name });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message || "internal_error" });
  }
});

export default router;
