import express from "express";
import { checkShutdownFlag } from "./rootKillSwitch.js";

/**
 * Mount as: app.use("/control", controlStatusRoute)
 * Behind the normal x-backend-key middleware (NOT /admin) — this is
 * the agent checking on itself, not an admin acting on it. Address is
 * whichever agent is asking, taken from its own identity, same as
 * every other agent-facing route (e.g. /wallet, /inference).
 */
const router = express.Router();

router.get("/kill-status/:address", (req, res) => {
  const status = checkShutdownFlag(req.params.address);
  res.json(status);
});

export default router;

// In backend/src/index.ts:
//   import controlStatusRoute from "./controlStatusRoute.js";
//   app.use("/control", controlStatusRoute);
// (mount it with the other agent-facing routers, e.g. next to app.use("/wallet", walletRouter))
