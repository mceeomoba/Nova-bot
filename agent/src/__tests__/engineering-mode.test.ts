import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildEngineeringPlan, classifyEngineeringRisks, routeEngineeringTask, runEngineeringWorkflow } from "../engineering/mode.js";
import { engineeringHelp } from "../engineering/cli.js";

describe("NOVA engineering task router", () => {
  it("routes explicit and inferred workflows without vendor-specific commands", () => {
    expect(routeEngineeringTask({ goal: "Investigate the flaky scheduler" })).toBe("investigate");
    expect(routeEngineeringTask({ goal: "Fix the crash and add a regression test" })).toBe("bug-fix-tdd");
    expect(routeEngineeringTask({ goal: "Review the blast radius" })).toBe("blast-radius");
    expect(routeEngineeringTask({ goal: "Prepare a release" })).toBe("verify-and-ship");
  });

  it("classifies sensitive scopes from goal and changed paths", () => {
    expect(classifyEngineeringRisks("update code", ["src/security/guard.ts", "src/agent/spend-tracker.ts", "src/self-mod/code.ts"]))
      .toEqual(["security", "financial", "self-modification"]);
  });
});

describe("NOVA engineering gate planner", () => {
  it("plans shipping gates including targeted, security and financial verification", () => {
    const plan = buildEngineeringPlan({
      goal: "Ship wallet policy fix",
      workflow: "verify-and-ship",
      changedFiles: ["src/agent/policy-rules/financial.ts"],
      testFiles: ["src/__tests__/financial.test.ts"],
    });
    expect(plan.gates.map((item) => item.kind)).toEqual([
      "typecheck", "targeted-vitest", "security", "financial", "full-ci", "build", "cli-smoke",
    ]);
    expect(plan.requiresApproval).toBe(true);
    expect(plan.inferenceTask).toBe("agent_turn");
    expect(JSON.stringify(plan)).not.toMatch(/cursor|worktree|model slug/i);
  });

  it("blocks sensitive execution until an operator explicitly approves it", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-engineering-"));
    let calls = 0;
    const run = runEngineeringWorkflow(
      { goal: "Verify wallet change", workflow: "verify-and-ship" },
      { stateDir, runner: () => { calls += 1; return { status: 0 }; } },
    );
    expect(run.status).toBe("blocked");
    expect(calls).toBe(0);
    expect(fs.existsSync(run.statePath!)).toBe(true);
  });

  it("stops on the first failed required gate and records auditable results", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-engineering-"));
    let calls = 0;
    const run = runEngineeringWorkflow(
      { goal: "Ship normal change", workflow: "verify-and-ship", approvedSensitive: true },
      { stateDir, runner: () => ({ status: ++calls === 2 ? 1 : 0, stdout: `call ${calls}` }) },
    );
    expect(run.status).toBe("failed");
    expect(run.results).toHaveLength(2);
    expect(run.results[1].status).toBe("failed");
    const stored = JSON.parse(fs.readFileSync(run.statePath!, "utf8"));
    expect(stored.status).toBe("failed");
  });
});

describe("NOVA engineering CLI", () => {
  it("documents native commands and control precedence", () => {
    const help = engineeringHelp();
    expect(help).toContain("NOVA Engineering Mode");
    expect(help).toContain("--approve-sensitive");
    expect(help).toContain("controls remain authoritative");
    expect(help).not.toMatch(/cursor|worktree/i);
  });
});
