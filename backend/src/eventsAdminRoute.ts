import express from "express";
import { pullUndeliveredEvents, markDelivered } from "./ecosystemEvents.js";

/**
 * Mount as: app.use("/admin/control", eventsAdminRoute)
 * Same x-admin-key tier as rootKillRoutes.ts — this is operator
 * tooling (the Telegram notifier bot), not an agent-facing surface.
 */
const router = express.Router();

router.get("/events", (req, res) => {
  const limit = Number(req.query.limit) || 200;
  res.json({ events: pullUndeliveredEvents(limit) });
});

router.post("/events/ack", (req, res) => {
  const ids: string[] = req.body?.ids || [];
  markDelivered(ids);
  res.json({ ok: true });
});

export default router;
