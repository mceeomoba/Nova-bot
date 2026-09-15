import path from "node:path";
import { buildEngineeringPlan, runEngineeringWorkflow, type EngineeringRequest, type EngineeringWorkflow } from "./mode.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
function csv(value?: string): string[] { return value ? value.split(",").map((part) => part.trim()).filter(Boolean) : []; }

export function engineeringHelp(): string {
  return `NOVA Engineering Mode\n\nUsage:\n  automaton --engineering plan --goal "..." [--workflow auto|investigate|bug-fix-tdd|blast-radius|verify-and-ship]\n  automaton --engineering run --goal "..." [--changed-files a.ts,b.ts] [--test-files test.ts] [--approve-sensitive]\n\nRuns use NOVA's repository gates and save an audit record under ~/.automaton/engineering-runs. Security, spending, approval, policy, and self-modification controls remain authoritative.`;
}

export function runEngineeringCli(args: string[], cwd = process.cwd()): number {
  const marker = args.indexOf("--engineering");
  const action = args[marker + 1] ?? "help";
  if (action === "help") { console.log(engineeringHelp()); return 0; }
  const goal = valueAfter(args, "--goal");
  if (!goal) { console.error("NOVA Engineering Mode: --goal is required"); return 2; }
  const workflow = (valueAfter(args, "--workflow") ?? "auto") as EngineeringWorkflow | "auto";
  const request: EngineeringRequest = {
    goal, workflow, changedFiles: csv(valueAfter(args, "--changed-files")), testFiles: csv(valueAfter(args, "--test-files")), approvedSensitive: args.includes("--approve-sensitive"),
  };
  if (action === "plan") { console.log(JSON.stringify(buildEngineeringPlan(request), null, 2)); return 0; }
  if (action !== "run") { console.error(`NOVA Engineering Mode: unknown action ${action}`); return 2; }
  const run = runEngineeringWorkflow(request, { cwd: path.resolve(cwd) });
  console.log(JSON.stringify(run, null, 2));
  return run.status === "passed" || run.status === "planned" ? 0 : 1;
}
