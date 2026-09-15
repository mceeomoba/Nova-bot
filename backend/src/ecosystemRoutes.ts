import express from "express";
import { buildEcosystemTree } from "./ecosystem.js";

/**
 * Zent.md Phase 18b — the one route this phase adds.
 *
 * Mounted the same tier as expansionRouter (see index.ts: behind the
 * shared x-backend-key check, not the public tier expansionUiRouter/
 * agentCardRouter sit at) — this returns private lineage/status detail
 * (genesis_activation_status, erc8004 registration outcome, mission
 * text) for every company in a root's pipeline-spawned family, which is
 * exactly the kind of detail wallet.ts's own GET /:address/lineage
 * already keeps behind that same key for a single agent. There is
 * still no operator/approval action anywhere on this route — it is
 * read-only, like every other view surface this pipeline exposes — the
 * auth tier is about who may look, not a control this pipeline lacks.
 */

const router = express.Router();

// GET /ecosystem/:rootAgentAddress
router.get("/:rootAgentAddress", (req, res) => {
  const { rootAgentAddress } = req.params;
  if (!rootAgentAddress) {
    return res.status(400).json({ error: "rootAgentAddress is required" });
  }

  const tree = buildEcosystemTree(rootAgentAddress);
  if (!tree) {
    return res.status(404).json({ error: `unknown agent address: ${rootAgentAddress}` });
  }

  res.json({ root: tree });
});

export default router;
