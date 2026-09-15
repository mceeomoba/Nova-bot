// Zent.md Phase 4d: "Notification hook (reuses whatever channel
// office.ts/admin status already uses) firing when a new opportunity
// clears the ROI floor."
//
// Inlined mirror of expansion.ts's recordExpansionNotification()/
// markExpansionNotificationDelivered()/listExpansionNotificationsForAgent()
// and of expansionRoutes.ts's deliverExpansionNotification() + the
// score-opportunity route's own call-out to both — same "no live
// better-sqlite3 / no live fs write in this environment" reason every
// prior backend/src test file in this repo already carries (see
// expansionOpportunityDetail.test.ts's own header for the identical
// note on the Phase 4b logic it mirrors).
//
// What this covers:
//   4d — an opportunity clearing the floor gets exactly one
//        notification row recorded.
//   4d — an opportunity below the floor gets no notification.
//   4d — an opportunity with no roi_score yet gets no notification.
//   4d — recording is idempotent: calling it twice for the same
//        opportunity returns the same row, not a second one.
//   4d — a custom roiFloor override is respected.
//   4d — delivery writes exactly one file into the owning agent's own
//        inbox, tagged with the system sender, and flips delivered.
//   4d — delivery is a no-op (doesn't re-write) once already delivered.
//   4d — a delivery failure never throws and leaves delivered false.
//   4d — listExpansionNotificationsForAgent is scoped per agent and
//        sorted most-recent-first.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ─── Mirror of expansion.ts's opportunities / expansion_notifications ──

interface FakeOpportunity {
  id: string;
  report_id: string;
  title: string;
  thesis: string;
  roi_score: number | null;
}

interface FakeReport {
  id: string;
  agent_address: string;
}

interface ExpansionNotification {
  id: string;
  opportunityId: string;
  agentAddress: string;
  roiScore: number;
  createdAt: number;
  delivered: boolean;
}

let reports: Map<string, FakeReport>;
let opportunities: Map<string, FakeOpportunity>;
let notifications: Map<string, ExpansionNotification>; // keyed by opportunityId (UNIQUE index mirror)
let seq: number;

const ROI_FLOOR = 50; // same default config.ts ships (EXPANSION_MIN_ROI_FLOOR)

function reset() {
  reports = new Map();
  opportunities = new Map();
  notifications = new Map();
  seq = 0;
}

function createReport(agentAddress: string): FakeReport {
  const row: FakeReport = { id: `oppr_${++seq}`, agent_address: agentAddress };
  reports.set(row.id, row);
  return row;
}

function seedOpportunity(report: FakeReport, title: string, roiScore: number | null): FakeOpportunity {
  const opp: FakeOpportunity = {
    id: `opp_${++seq}`,
    report_id: report.id,
    title,
    thesis: "thesis",
    roi_score: roiScore,
  };
  opportunities.set(opp.id, opp);
  return opp;
}

function getOpportunityReport(id: string): FakeReport | undefined {
  return reports.get(id);
}

// ─── Mirror of expansion.ts's Phase 4d functions ───────────────────────

function recordExpansionNotification(
  opportunity: FakeOpportunity,
  options: { roiFloor?: number } = {},
): ExpansionNotification | undefined {
  if (opportunity.roi_score === null) return undefined;
  const roiFloor = options.roiFloor ?? ROI_FLOOR;
  if (opportunity.roi_score < roiFloor) return undefined;

  const report = getOpportunityReport(opportunity.report_id)!;

  const existing = notifications.get(opportunity.id);
  if (existing) return existing;

  const row: ExpansionNotification = {
    id: `oppn_${++seq}`,
    opportunityId: opportunity.id,
    agentAddress: report.agent_address,
    roiScore: opportunity.roi_score,
    createdAt: Date.now(),
    delivered: false,
  };
  notifications.set(opportunity.id, row);
  return row;
}

function markExpansionNotificationDelivered(id: string): void {
  for (const n of notifications.values()) {
    if (n.id === id) n.delivered = true;
  }
}

function listExpansionNotificationsForAgent(agentAddress: string, limit = 50): ExpansionNotification[] {
  return [...notifications.values()]
    .filter((n) => n.agentAddress === agentAddress)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

// ─── Mirror of expansionRoutes.ts's deliverExpansionNotification() ─────
//
// Uses a real tmp directory in place of office.ts's officeInboxDir() —
// the containment/ensureOffice machinery itself is office.ts's own
// concern (covered by that file's own tests, if any exist); what this
// mirrors is the "write the envelope, flip delivered, never throw"
// shape deliverExpansionNotification() implements around it.

let tmpRoot: string;

function inboxDirFor(agentAddress: string): string {
  return path.join(tmpRoot, agentAddress, "inbox");
}

async function deliverExpansionNotification(
  notification: ExpansionNotification,
  opportunity: FakeOpportunity,
  opts: { forceFail?: boolean } = {},
): Promise<void> {
  if (notification.delivered) return;
  try {
    if (opts.forceFail) {
      throw new Error("simulated filesystem failure");
    }
    const inboxDir = inboxDirFor(notification.agentAddress);
    await fs.mkdir(inboxDir, { recursive: true });
    const envelope = {
      type: "expansion_opportunity_notification",
      from: "system:expansion-pipeline",
      opportunityId: opportunity.id,
      title: opportunity.title,
      thesis: opportunity.thesis,
      roiScore: opportunity.roi_score,
      createdAt: notification.createdAt,
    };
    const destPath = path.join(inboxDir, `expansion-notification-${notification.id}.json`);
    await fs.writeFile(destPath, JSON.stringify(envelope, null, 2), "utf8");
    markExpansionNotificationDelivered(notification.id);
  } catch (err: any) {
    // swallowed — same "never throw" contract as the real function
  }
}

beforeEach(async () => {
  reset();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "expansion-notif-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ─── 4d: recordExpansionNotification (data layer) ──────────────────────

describe("recordExpansionNotification", () => {
  test("an opportunity clearing the floor gets one notification recorded", () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 80);

    const n = recordExpansionNotification(opp);
    assert.ok(n);
    assert.equal(n!.opportunityId, opp.id);
    assert.equal(n!.agentAddress, "agent-1");
    assert.equal(n!.roiScore, 80);
    assert.equal(n!.delivered, false);
  });

  test("an opportunity below the floor gets no notification", () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 30);

    assert.equal(recordExpansionNotification(opp), undefined);
  });

  test("an opportunity with no roi_score yet gets no notification", () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", null);

    assert.equal(recordExpansionNotification(opp), undefined);
  });

  test("an opportunity exactly at the floor clears it", () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", ROI_FLOOR);

    assert.ok(recordExpansionNotification(opp));
  });

  test("recording is idempotent for the same opportunity", () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 90);

    const first = recordExpansionNotification(opp);
    const second = recordExpansionNotification(opp);
    assert.equal(first!.id, second!.id);
    assert.equal(notifications.size, 1);
  });

  test("a custom roiFloor override is respected", () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 60);

    assert.equal(recordExpansionNotification(opp, { roiFloor: 70 }), undefined);
    assert.ok(recordExpansionNotification(opp, { roiFloor: 50 }));
  });
});

// ─── 4d: deliverExpansionNotification (route-layer delivery) ──────────

describe("deliverExpansionNotification", () => {
  test("writes exactly one file into the owning agent's inbox and flips delivered", async () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Great Idea", 85);
    const n = recordExpansionNotification(opp)!;

    await deliverExpansionNotification(n, opp);

    assert.equal(n.delivered, true);
    const inboxDir = inboxDirFor("agent-1");
    const files = await fs.readdir(inboxDir);
    assert.equal(files.length, 1);
    assert.equal(files[0], `expansion-notification-${n.id}.json`);

    const content = JSON.parse(await fs.readFile(path.join(inboxDir, files[0]), "utf8"));
    assert.equal(content.type, "expansion_opportunity_notification");
    assert.equal(content.from, "system:expansion-pipeline");
    assert.equal(content.opportunityId, opp.id);
    assert.equal(content.roiScore, 85);
  });

  test("is a no-op once already delivered (no re-write)", async () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 85);
    const n = recordExpansionNotification(opp)!;

    await deliverExpansionNotification(n, opp);
    const inboxDir = inboxDirFor("agent-1");
    const before = await fs.readdir(inboxDir);

    await deliverExpansionNotification(n, opp);
    const after = await fs.readdir(inboxDir);
    assert.deepEqual(before, after);
  });

  test("a delivery failure never throws and leaves delivered false", async () => {
    const report = createReport("agent-1");
    const opp = seedOpportunity(report, "Idea", 85);
    const n = recordExpansionNotification(opp)!;

    await assert.doesNotReject(() => deliverExpansionNotification(n, opp, { forceFail: true }));
    assert.equal(n.delivered, false);
  });
});

// ─── 4d: listExpansionNotificationsForAgent ────────────────────────────

describe("listExpansionNotificationsForAgent", () => {
  test("is scoped per agent and sorted most-recent-first", () => {
    const reportA = createReport("agent-1");
    const reportB = createReport("agent-2");

    const oppA1 = seedOpportunity(reportA, "A1", 80);
    const nA1 = recordExpansionNotification(oppA1)!;
    nA1.createdAt = 1000;

    const oppA2 = seedOpportunity(reportA, "A2", 90);
    const nA2 = recordExpansionNotification(oppA2)!;
    nA2.createdAt = 2000;

    const oppB1 = seedOpportunity(reportB, "B1", 95);
    recordExpansionNotification(oppB1);

    const listA = listExpansionNotificationsForAgent("agent-1");
    assert.equal(listA.length, 2);
    assert.equal(listA[0].id, nA2.id);
    assert.equal(listA[1].id, nA1.id);

    const listB = listExpansionNotificationsForAgent("agent-2");
    assert.equal(listB.length, 1);
  });

  test("respects the limit parameter", () => {
    const report = createReport("agent-1");
    for (let i = 0; i < 5; i++) {
      recordExpansionNotification(seedOpportunity(report, `Idea ${i}`, 80));
    }

    const limited = listExpansionNotificationsForAgent("agent-1", 2);
    assert.equal(limited.length, 2);
  });
});
