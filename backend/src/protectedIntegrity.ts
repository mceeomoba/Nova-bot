import crypto from "crypto";
import { existsSync } from "fs";
import fs from "fs/promises";
import path from "path";

/** Relative paths that must never be writable from a command sandbox. */
export const protectedMountPaths = Object.freeze([
  "agent/src/security/injection-defense.ts",
  "agent/src/security/injection-defense.js",
  "agent/src/security/injection-defense.d.ts",
  "agent/src/self-mod/code.ts",
  "agent/src/self-mod/code.js",
  "agent/src/self-mod/code.d.ts",
  "agent/src/self-mod/audit-log.ts",
  "agent/src/self-mod/audit-log.js",
  "agent/src/agent/tools.ts",
  "agent/src/agent/tools.js",
  "agent/src/agent/policy-engine.ts",
  "agent/src/agent/policy-engine.js",
  "agent/src/agent/policy-rules/index.ts",
  "agent/src/agent/policy-rules/index.js",
  "agent/src/self-mod/upstream.ts",
  "agent/src/self-mod/upstream.js",
  "agent/src/self-mod/tools-manager.ts",
  "agent/src/self-mod/tools-manager.js",
  "agent/src/skills/loader.ts",
  "agent/src/skills/loader.js",
  "agent/src/skills/registry.ts",
  "agent/src/skills/registry.js",
  "constitution.md",
  "wallet.json",
  "config.json",
  "automaton.json",
  "package.json",
  "SOUL.md",
  "state.db",
  "state.db-wal",
  "state.db-shm",
] as const);

export function protectedBindSpecs(root: string): string[] {
  return protectedMountPaths
    .filter((relative) => existsSync(path.join(root, relative)))
    .map((relative) => `${path.join(root, relative)}:/workspace/${relative}:ro`);
}

export type IntegritySnapshot = ReadonlyMap<string, string>;

async function digest(file: string): Promise<string | null> {
  try {
    const data = await fs.readFile(file);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch { return null; }
}

export async function assertProtectedIntegrity(root: string, previous?: IntegritySnapshot): Promise<IntegritySnapshot> {
  const current = new Map<string, string>();
  for (const relative of protectedMountPaths) {
    const hash = await digest(path.join(root, relative));
    if (hash !== null) current.set(relative, hash);
  }
  if (previous) {
    for (const [relative, hash] of previous) {
      if (current.get(relative) !== hash) throw new Error(`Protected file integrity violation: ${relative}`);
    }
    for (const relative of current.keys()) {
      if (!previous.has(relative)) throw new Error(`Protected file integrity violation: ${relative}`);
    }
  }
  return current;
}
