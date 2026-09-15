import express from "express";
import { adminKillAgent, adminUnfreeze, getAgentStatus, listActiveAgents } from "./rootKillSwitch.js";

/**
 * Mount as: app.use("/admin/control", rootKillRoutes)
 * Inherits x-admin-key check from the existing /admin middleware in
 * index.ts — do not mount this anywhere else, and do not give this
 * key to any agent process (same separation index.ts already
 * documents for /admin vs the agent-facing x-backend-key).
 */
const router = express.Router();

router.get("/agents", (_req, res) => {
  res.json({ agents: listActiveAgents() });
});

router.get("/status/:address", (req, res) => {
  const address = req.params.address;
  try {
    const status = getAgentStatus(address);
    res.json(status);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/kill/:address", (req, res) => {
  const address = req.params.address;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "admin kill switch";
  try {
    const result = adminKillAgent(address, reason);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/unfreeze/:address", (req, res) => {
  const address = req.params.address;
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "admin unfreeze";
  try {
    const result = adminUnfreeze(address, reason);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;

// In backend/src/index.ts, alongside the existing admin mounts:
//
//   import rootKillRoutes from "./rootKillRoutes.js";
//   app.use("/admin/control", rootKillRoutes);
//
// (goes next to the existing `app.use("/admin/orchestrator", orchestratorRouter);` line)
