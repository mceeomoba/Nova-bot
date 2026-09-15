import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InferenceTaskType } from "../types.js";

export type EngineeringWorkflow = "investigate" | "bug-fix-tdd" | "blast-radius" | "verify-and-ship";
export type EngineeringRisk = "standard" | "security" | "financial" | "self-modification";
export type GateKind = "typecheck" | "targeted-vitest" | "security" | "financial" | "full-ci" | "build" | "cli-smoke";

export interface EngineeringRequest {
  goal: string;
  workflow?: EngineeringWorkflow | "auto";
  changedFiles?: string[];
  testFiles?: string[];
  approvedSensitive?: boolean;
}

export interface EngineeringGate {
  kind: GateKind;
  command: string;
  args: string[];
  required: boolean;
  reason: string;
}

export interface EngineeringPlan {
  workflow: EngineeringWorkflow;
  inferenceTask: InferenceTaskType;
  risks: EngineeringRisk[];
  changedFiles: string[];
  testFiles: string[];
  requiresApproval: boolean;
  gates: EngineeringGate[];
}

export interface GateResult extends EngineeringGate {
  status: "passed" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  outputTail: string;
}

export interface EngineeringRun {
  id: string;
  goal: string;
  status: "planned" | "blocked" | "running" | "passed" | "failed";
  createdAt: string;
  finishedAt?: string;
  plan: EngineeringPlan;
  results: GateResult[];
  statePath?: string;
  blocker?: string;
}

export interface CommandResult { status: number | null; stdout?: string; stderr?: string; }
export type CommandRunner = (command: string, args: string[], cwd: string) => CommandResult;

const SECURITY_RE = /(^|\/)(security|policy-rules|soul)(\/|$)|injection|auth|credential|constitution/i;
const FINANCIAL_RE = /financial|spend|treasury|wallet|payment|x402|credits/i;
const SELF_MOD_RE = /self-mod|skills\/|policy-engine|agent\/tools|constitution/i;
const BUG_RE = /\b(bug|fix|regression|broken|failure|error|crash)\b/i;
const REVIEW_RE = /blast.?radius|impact|review|changed files?|risk/i;
const INVESTIGATE_RE = /investigat|diagnos|reproduc|root cause|explor/i;

function normalizeFiles(files: string[] = []): string[] {
  return [...new Set(files.map((file) => file.trim().replace(/^\.\//, "")).filter(Boolean))].sort();
}

export function classifyEngineeringRisks(goal: string, changedFiles: string[] = []): EngineeringRisk[] {
  const evidence = `${goal}\n${changedFiles.join("\n")}`;
  const risks: EngineeringRisk[] = [];
  if (SECURITY_RE.test(evidence)) risks.push("security");
  if (FINANCIAL_RE.test(evidence)) risks.push("financial");
  if (SELF_MOD_RE.test(evidence)) risks.push("self-modification");
  return risks.length ? risks : ["standard"];
}

export function routeEngineeringTask(request: EngineeringRequest): EngineeringWorkflow {
  if (request.workflow && request.workflow !== "auto") return request.workflow;
  const goal = request.goal;
  if (INVESTIGATE_RE.test(goal)) return "investigate";
  if (REVIEW_RE.test(goal)) return "blast-radius";
  if (BUG_RE.test(goal)) return "bug-fix-tdd";
  return "verify-and-ship";
}

function gate(kind: GateKind, reason: string, args: string[]): EngineeringGate {
  return { kind, command: "pnpm", args, required: true, reason };
}

export function buildEngineeringPlan(request: EngineeringRequest): EngineeringPlan {
  const changedFiles = normalizeFiles(request.changedFiles);
  const testFiles = normalizeFiles(request.testFiles);
  const workflow = routeEngineeringTask(request);
  const risks = classifyEngineeringRisks(request.goal, changedFiles);
  const gates: EngineeringGate[] = [];
  const add = (candidate: EngineeringGate) => {
    if (!gates.some((existing) => existing.kind === candidate.kind)) gates.push(candidate);
  };

  if (workflow !== "investigate") add(gate("typecheck", "Changed code must typecheck", ["run", "typecheck"]));
  if (testFiles.length) add(gate("targeted-vitest", "Run the tests closest to the change first", ["exec", "vitest", "run", ...testFiles]));
  if (risks.includes("security")) add(gate("security", "Security-sensitive changes require the security suite", ["run", "test:security"]));
  if (risks.includes("financial")) add(gate("financial", "Money-sensitive changes require the financial suite", ["run", "test:financial"]));

  if (workflow === "bug-fix-tdd" && !testFiles.length) {
    add(gate("targeted-vitest", "A bug fix needs behavioral regression coverage", ["run", "test"]));
  }
  if (workflow === "blast-radius") {
    add(gate("full-ci", "Blast-radius review validates the full test surface", ["run", "test:ci"]));
  }
  if (workflow === "verify-and-ship") {
    add(gate("full-ci", "Shipping requires the full test surface", ["run", "test:ci"]));
    add(gate("build", "Shipping requires production artifacts", ["run", "build"]));
    add({ kind: "cli-smoke", command: "node", args: ["packages/cli/dist/index.js"], required: true, reason: "Exercise the built user-facing CLI" });
  }

  return {
    workflow,
    inferenceTask: workflow === "investigate" || workflow === "blast-radius" ? "planning" : "agent_turn",
    risks,
    changedFiles,
    testFiles,
    requiresApproval: risks.includes("financial") || risks.includes("self-modification"),
    gates,
  };
}

function defaultRunner(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env, maxBuffer: 10 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function stateDirectory(): string {
  const home = process.env.AUTOMATON_HOME || path.join(os.homedir(), ".automaton");
  return path.join(home, "engineering-runs");
}

export function persistEngineeringRun(run: EngineeringRun, directory = stateDirectory()): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${run.id}.json`);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...run, statePath: destination }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
  run.statePath = destination;
  return destination;
}

export function runEngineeringWorkflow(
  request: EngineeringRequest,
  options: { cwd?: string; stateDir?: string; runner?: CommandRunner } = {},
): EngineeringRun {
  const now = new Date().toISOString();
  const plan = buildEngineeringPlan(request);
  const run: EngineeringRun = {
    id: randomUUID(), goal: request.goal, status: "planned", createdAt: now, plan, results: [],
  };
  const save = () => persistEngineeringRun(run, options.stateDir);

  if (plan.requiresApproval && !request.approvedSensitive) {
    run.status = "blocked";
    run.blocker = "Sensitive financial or self-modification scope requires explicit operator approval";
    run.finishedAt = new Date().toISOString();
    save();
    return run;
  }

  if (plan.gates.length === 0) { save(); return run; }
  run.status = "running";
  save();
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? defaultRunner;

  for (const item of plan.gates) {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const result = runner(item.command, item.args, cwd);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const passed = result.status === 0;
    run.results.push({ ...item, status: passed ? "passed" : "failed", startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, exitCode: result.status, outputTail: output.slice(-4000) });
    save();
    if (!passed && item.required) {
      run.status = "failed";
      run.finishedAt = new Date().toISOString();
      save();
      return run;
    }
  }
  run.status = "passed";
  run.finishedAt = new Date().toISOString();
  save();
  return run;
}
