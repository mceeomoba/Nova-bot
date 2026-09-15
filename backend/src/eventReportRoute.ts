import express from "express";
import { emitEvent, type EventType } from "./ecosystemEvents.js";

/**
 * Mount as: app.use("/events", eventReportRoute)
 * Behind the normal x-backend-key middleware (same tier as /wallet,
 * /vm/exec, /control) — this is an agent reporting on itself. Same
 * trust model as every other agent-facing route in this codebase
 * (e.g. GET /wallet/:address/balance): x-backend-key is ONE shared
 * secret across every agent, not a per-agent credential, so the
 * calling agent identifies itself by address in the request body,
 * same as it would identify which wallet to check. This route adds
 * no new trust assumption beyond what already exists everywhere else
 * an agent's own address appears in a request.
 *
 * Deliberately restricted to a subset of EventType — the ones an agent
 * can actually know about itself without a backend-side witness
 * (its own low-compute state, an opportunity it found, a listing it
 * created, an error it caught). Financial transfers, kills, and
 * freezes are NOT reportable here: those are emitted directly by the
 * backend code that actually performs them (facilitator.ts,
 * rootKillSwitch.ts, expansionKillSwitch.ts), specifically so an agent
 * can never self-report a transfer that didn't really happen.
 */
const AGENT_REPORTABLE_TYPES: EventType[] = [
  "low_compute",
  "critical_compute",
  "error_minor",
  "error_critical",
  "deal_proposed",
  "listing_created",
  "opportunity_found",
];

const router = express.Router();

router.post("/report", (req, res) => {
  const { agentAddress, eventType, message, role, subRole, metadata } = req.body || {};
  if (typeof agentAddress !== "string" || agentAddress.length === 0) {
    return res.status(400).json({ error: "agentAddress is required" });
  }
  if (!AGENT_REPORTABLE_TYPES.includes(eventType)) {
    return res.status(400).json({ error: `eventType must be one of: ${AGENT_REPORTABLE_TYPES.join(", ")}` });
  }
  if (typeof message !== "string" || message.length === 0) {
    return res.status(400).json({ error: "message is required" });
  }

  emitEvent({
    agentAddress,
    role: typeof role === "string" ? role : undefined,
    subRole: typeof subRole === "string" ? subRole : undefined,
    eventType,
    message: message.slice(0, 2000), // same order-of-magnitude cap as socialRelay's content limit — this is a notification line, not a document
    metadata: metadata && typeof metadata === "object" ? metadata : undefined,
  });

  res.json({ ok: true });
});

export default router;
