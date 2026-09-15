// Shared setup for "live" test files — ones that import the real
// db.ts (and whatever real module they're covering) against an actual
// temp better-sqlite3 file, instead of inlining a copy of the logic.
//
// Usage (must be the first thing a live test file does, before any
// other import of db.ts or a module that imports db.ts):
//
//   import { freshDbPath, setTestEnv } from "./liveDb.js";
//   setTestEnv(freshDbPath("my-test-label"));
//   const { db } = await import("../db.js");
//
// setTestEnv() must run before db.ts is loaded (dynamic import, not a
// static top-level one) because db.ts does `new Database(config.dbPath)`
// at module-load time — a static import would be hoisted ahead of the
// env vars being set.

import os from "node:os";
import path from "node:path";

export function freshDbPath(label: string): string {
  return path.join(
    os.tmpdir(),
    `automaton-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

// Dummy values for whatever env vars config.ts requires at import time.
// None of these are read by the modules these live tests actually
// exercise — they exist only so importing config.ts doesn't throw.
export function setTestEnv(dbPath: string): void {
  process.env.DB_PATH = dbPath;
  process.env.BACKEND_API_KEY ??= "test-dummy";
  process.env.ADMIN_API_KEY ??= "test-dummy";
  process.env.OPENROUTER_API_KEY ??= "test-dummy";
  process.env.FACILITATOR_PRIVATE_KEY ??= `0x${"1".repeat(64)}`;
}
