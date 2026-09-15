import fs from "fs/promises";
import os from "os";
import path from "path";
import assert from "node:assert/strict";
import test from "node:test";
import { assertProtectedIntegrity, protectedMountPaths } from "../protectedIntegrity.js";

test("detects a protected file changed during execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "automaton-integrity-"));
  const target = path.join(root, "agent", "src", "security", "injection-defense.ts");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "original");
  const snapshot = await assertProtectedIntegrity(root);
  await fs.writeFile(target, "tampered");
  await assert.rejects(() => assertProtectedIntegrity(root, snapshot), /integrity/i);
});

test("exposes only relative, workspace-confined mount paths", () => {
  assert.ok(protectedMountPaths.every((entry) => !path.isAbsolute(entry)));
  assert.ok(protectedMountPaths.includes("agent/src/security/injection-defense.ts"));
});
