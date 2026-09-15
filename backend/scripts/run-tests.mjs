import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const testDir = join(process.cwd(), "src", "__tests__");
const files = (await readdir(testDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /(?:\.test|_test)\.ts$/.test(entry.name))
  .map((entry) => join(testDir, entry.name))
  .sort();

if (files.length === 0) {
  console.error("No TypeScript tests found");
  process.exitCode = 1;
} else {
  // Run every file to completion before deciding pass/fail. A single
  // broken or misconfigured test file must never hide whether the
  // other N files pass — that was the previous bug: this loop used to
  // process.exit() on the first non-zero code, so anything after the
  // first failing file (alphabetically) silently never ran, and a run
  // that looked like "1 test failed" could actually mean "29 tests
  // never executed." Now every file always runs, and the summary at
  // the end is the only source of truth for exit status.
  const results = [];
  for (const file of files) {
    const relPath = file.slice(join(process.cwd(), "src", "__tests__").length + 1);
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "--test", file],
      { stdio: "inherit" },
    );
    const code = await new Promise((resolve) => child.on("close", resolve));
    results.push({ file: relPath, code: code ?? 1, passed: code === 0 });
  }

  const failed = results.filter((r) => !r.passed);
  const passed = results.filter((r) => r.passed);

  console.log("\n" + "=".repeat(60));
  console.log(`TEST SUMMARY: ${passed.length}/${results.length} files passed`);
  console.log("=".repeat(60));
  if (failed.length > 0) {
    console.log("\nFAILED FILES:");
    for (const r of failed) {
      console.log(`  ✗ ${r.file} (exit code ${r.code})`);
    }
  }
  console.log("");

  process.exitCode = failed.length > 0 ? 1 : 0;
}
