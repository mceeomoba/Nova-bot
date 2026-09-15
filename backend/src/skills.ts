/**
 * Skills (backend storage + install)
 *
 * Ports agent/'s skills system (agent/src/skills/{registry,format}.ts)
 * into agent-runtime's architecture. The two differ in where a skill's
 * content actually lives: agent/ runs directly on its own host, so it
 * `git clone`s a skill repo (or curls a SKILL.md) straight onto its own
 * filesystem via execFileSync, then reads it back with fs.*.
 * agent-runtime has no local filesystem of its own worth persisting
 * anything to (see state.ts's own "just a resume checkpoint" note) and
 * every real filesystem it touches is the agent's own isolated sandbox,
 * reached only through backend.vmExec()/fileRead()/fileWrite().
 *
 * Rather than route a git clone through vmExec (which would require the
 * sandbox image to have git, and would leave the clone taking up disk
 * in a container the agent might not even be running right now), this
 * fetches and parses skill content HERE, server-side, in a scratch temp
 * dir cleaned up immediately after — a skill really is just data (a
 * name/description/instructions text), never executed, so there's
 * nothing about installing one that actually needs sandbox isolation.
 * Only createSkill (self-authored) and installSkillFromGit/Url write
 * anything; both just parse text and store a DB row.
 *
 * parseSkillMd/parseYamlFrontmatter below are a direct port of
 * agent/src/skills/format.ts — same SKILL.md convention, same
 * intentionally-hand-rolled YAML subset (not a full parser) so a
 * skill authored for one runtime parses identically on the other.
 */

import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import YAML from "yaml";
import http from "http";
import https from "https";
import { db } from "./db.js";
import {
  assertSafeRemoteUrl,
  pinnedDnsLookup,
  GIT_GLOBAL_HARDENED_ARGS,
  GIT_CLONE_HARDENED_FLAGS,
  GIT_CLONE_HARDENED_ENV,
} from "./safeRemoteUrl.js";

export interface Skill {
  id: string;
  agentAddress: string;
  name: string;
  description: string;
  autoActivate: boolean;
  instructions: string;
  source: "git" | "url" | "self";
  createdAt: number;
  enabled: boolean;
}

interface SkillRow {
  id: string;
  agent_address: string;
  name: string;
  description: string;
  auto_activate: number;
  instructions: string;
  source: string;
  created_at: number;
  enabled: number;
}

const SKILL_NAME_RE = /^[a-zA-Z0-9-]+$/;
const SAFE_URL_RE = /^https?:\/\/[^\s;|&$`(){}<>]+$/;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 10_000;

function rowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    agentAddress: row.agent_address,
    name: row.name,
    description: row.description,
    autoActivate: row.auto_activate === 1,
    instructions: row.instructions,
    source: row.source as Skill["source"],
    createdAt: row.created_at,
    enabled: row.enabled === 1,
  };
}

/** Direct port of agent/src/skills/format.ts's parseYamlFrontmatter(). */
function parseYamlFrontmatter(raw: string): Record<string, any> | null {
  try {
    const result = YAML.parse(raw);
    return result && typeof result === "object" && !Array.isArray(result) ? result : null;
    /*
    const legacy: Record<string, any> = {};
    const lines = raw.split("\n");
    let currentKey = "";
    let listKey = "";

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith("#")) continue;
      if (trimmedLine.startsWith("- ") && currentKey === "requires" && listKey) {
        const nested = listKey.slice("requires.".length);
        if (result.requires?.[nested]) result.requires[nested].push(trimmedLine.slice(2).trim().replace(/^['"]|['"]$/g, ""));
        continue;
      }

      const colonIndex = trimmedLine.indexOf(":");
      if (colonIndex === -1) continue;

      const key = trimmedLine.slice(0, colonIndex).trim();
      const value = trimmedLine.slice(colonIndex + 1).trim();
      if (key === "requires") { result.requires = {}; currentKey = "requires"; continue; }
      if (currentKey === "requires" && line.startsWith("  ")) {
        listKey = `requires.${key}`;
        result.requires[key] = value.startsWith("[") ? value.slice(1, -1).split(",").map((v: string) => v.trim().replace(/^['"]|['"]$/g, "")) : [];
        continue;
      }
      currentKey = key;
      if (!value) continue;

      if (value === "true") {
        result[key] = true;
      } else if (value === "false") {
        result[key] = false;
      } else {
        result[key] = value.replace(/^["']|["']$/g, "");
      }
    }
    void currentKey;
    return legacy; */
  } catch {
    return null;
  }
}

/** Direct port of agent/src/skills/format.ts's parseSkillMd(). */
function parseSkillMd(
  content: string,
  fallbackName: string,
): { name: string; description: string; autoActivate: boolean; instructions: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return { name: fallbackName, description: "", autoActivate: true, instructions: trimmed };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) return null;

  const frontmatterRaw = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 3).trim();

  const frontmatter = parseYamlFrontmatter(frontmatterRaw);
  if (!frontmatter) return null;

  return {
    name: frontmatter.name || fallbackName,
    description: frontmatter.description || "",
    autoActivate: frontmatter["auto-activate"] !== false,
    instructions: body,
  };
}

function saveSkill(
  agentAddress: string,
  name: string,
  description: string,
  autoActivate: boolean,
  instructions: string,
  source: Skill["source"],
): { success: boolean; error?: string; skill?: Skill } {
  if (!SKILL_NAME_RE.test(name)) {
    return { success: false, error: `Invalid skill name "${name}" — letters, numbers, and "-" only.` };
  }

  const safeDescription = description.slice(0, MAX_DESCRIPTION_LENGTH);
  const safeInstructions = instructions.slice(0, MAX_INSTRUCTIONS_LENGTH);

  const existing = db
    .prepare(`SELECT id, enabled FROM skills WHERE agent_address = ? AND name = ?`)
    .get(agentAddress, name) as { id: string; enabled: number } | undefined;

  if (existing?.enabled === 1) {
    return { success: false, error: `You already have a skill named "${name}". Remove it first if you want to redefine it.` };
  }

  const id = existing ? existing.id : randomUUID();
  const now = Date.now();
  if (existing) {
    db.prepare(
      `UPDATE skills SET description = ?, auto_activate = ?, instructions = ?, source = ?, created_at = ?, enabled = 1 WHERE id = ?`,
    ).run(safeDescription, autoActivate ? 1 : 0, safeInstructions, source, now, id);
  } else {
    db.prepare(
      `INSERT INTO skills (id, agent_address, name, description, auto_activate, instructions, source, created_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    ).run(id, agentAddress, name, safeDescription, autoActivate ? 1 : 0, safeInstructions, source, now);
  }

  return {
    success: true,
    skill: { id, agentAddress, name, description: safeDescription, autoActivate, instructions: safeInstructions, source, createdAt: now, enabled: true },
  };
}

export async function installSkillFromGit(
  agentAddress: string,
  repoUrl: string,
  name: string,
): Promise<{ success: boolean; error?: string; skill?: Skill }> {
  if (!SKILL_NAME_RE.test(name)) {
    return { success: false, error: `Invalid skill name "${name}" — letters, numbers, and "-" only.` };
  }
  if (!SAFE_URL_RE.test(repoUrl)) {
    return { success: false, error: `Invalid repo URL "${repoUrl}" — must be an http(s) URL with no shell metacharacters.` };
  }
  // DNS check happens immediately before the clone (nothing else awaits
  // in between) to minimize — not eliminate — the DNS-rebinding TOCTOU
  // window; git's HTTP transport re-resolves the hostname itself with no
  // supported way to pin to the address validated here. See
  // safeRemoteUrl.ts for the full explanation and what IS closable.
  try { await assertSafeRemoteUrl(repoUrl); } catch (err: any) {
    return { success: false, error: err.message };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-install-"));
  try {
    try {
      // http.followRedirects=false blocks the redirect-based SSRF
      // variant (a hostile git host 3xx'ing the clone to an internal
      // endpoint); the env vars lock down credential prompts and ambient
      // system/global gitconfig for this untrusted-URL clone.
      execFileSync(
        "git",
        [
          ...GIT_GLOBAL_HARDENED_ARGS,
          "clone",
          "--depth",
          "1",
          ...GIT_CLONE_HARDENED_FLAGS,
          repoUrl,
          tmpDir,
        ],
        {
          encoding: "utf-8",
          timeout: 60_000,
          stdio: "pipe",
          env: { ...process.env, ...GIT_CLONE_HARDENED_ENV },
        },
      );
    } catch (err: any) {
      return { success: false, error: `Failed to clone skill repo: ${err.message}` };
    }

    const skillMdPath = path.join(tmpDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      return { success: false, error: `No SKILL.md found at the root of ${repoUrl}` };
    }

    const content = fs.readFileSync(skillMdPath, "utf-8");
    const parsed = parseSkillMd(content, name);
    if (!parsed) {
      return { success: false, error: "Failed to parse SKILL.md from cloned repo (malformed frontmatter)." };
    }

    return saveSkill(agentAddress, parsed.name, parsed.description, parsed.autoActivate, parsed.instructions, "git");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

interface PinnedFetchResult {
  status: number;
  contentType: string;
  text: string;
}

/**
 * GET a URL with DNS resolution pinned to `addresses` (see
 * safeRemoteUrl.ts's pinnedDnsLookup — this is the Gap A fix for this
 * call site), no automatic redirect following (a 3xx is returned to the
 * caller as-is, matching the previous `fetch(url, { redirect: "error" })`
 * behavior), and a hard cap on response size enforced both from
 * Content-Length (fails fast) and from actual bytes received (in case
 * Content-Length is absent or lies).
 */
function fetchPinnedText(
  url: URL,
  addresses: string[],
  maxBytes: number,
  timeoutMs: number,
): Promise<PinnedFetchResult> {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      { method: "GET", lookup: pinnedDnsLookup(addresses), timeout: timeoutMs },
      (res) => {
        const status = res.statusCode || 0;
        const contentType = res.headers["content-type"] || "";
        const declaredLength = Number(res.headers["content-length"] || 0);
        if (declaredLength > maxBytes) {
          res.destroy();
          reject(new Error(`response exceeds ${maxBytes} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            reject(new Error(`response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({ status, contentType, text: Buffer.concat(chunks).toString("utf-8") });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

export async function installSkillFromUrl(
  agentAddress: string,
  url: string,
  name: string,
): Promise<{ success: boolean; error?: string; skill?: Skill }> {
  if (!SKILL_NAME_RE.test(name)) {
    return { success: false, error: `Invalid skill name "${name}" — letters, numbers, and "-" only.` };
  }
  if (!SAFE_URL_RE.test(url)) {
    return { success: false, error: `Invalid URL "${url}" — must be an http(s) URL with no shell metacharacters.` };
  }
  let safeUrl: URL;
  let addresses: string[];
  try {
    ({ url: safeUrl, addresses } = await assertSafeRemoteUrl(url));
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  let content: string;
  try {
    // fetchPinnedText pins DNS resolution to the exact address(es) just
    // validated (Gap A fix — see safeRemoteUrl.ts): using the global
    // fetch() here, as before, would let the connection's own DNS
    // lookup diverge from the check above (DNS rebinding / TOCTOU).
    // redirect handling, content-type/length checks, and the 1 MiB cap
    // all preserve the same semantics the previous fetch()-based version
    // enforced.
    const res = await fetchPinnedText(safeUrl, addresses, 1_048_576, 30_000);
    if (res.status >= 300 && res.status < 400) {
      return { success: false, error: `Failed to fetch SKILL.md: HTTP ${res.status} redirect (not followed)` };
    }
    if (res.status < 200 || res.status >= 300) {
      return { success: false, error: `Failed to fetch SKILL.md: HTTP ${res.status}` };
    }
    const contentType = res.contentType;
    if (!contentType.includes("text/") && !contentType.includes("yaml") && !contentType.includes("markdown")) {
      return { success: false, error: "Skill URL must return text content smaller than 1 MiB." };
    }
    content = res.text;
  } catch (err: any) {
    return { success: false, error: `Failed to fetch SKILL.md from URL: ${err.message}` };
  }

  const parsed = parseSkillMd(content, name);
  if (!parsed) {
    return { success: false, error: "Failed to parse fetched SKILL.md (malformed frontmatter)." };
  }

  return saveSkill(agentAddress, parsed.name, parsed.description, parsed.autoActivate, parsed.instructions, "url");
}

export function createSkill(
  agentAddress: string,
  name: string,
  description: string,
  instructions: string,
): { success: boolean; error?: string; skill?: Skill } {
  return saveSkill(agentAddress, name, description, true, instructions, "self");
}

export function listSkills(agentAddress: string): Skill[] {
  const rows = db
    .prepare(`SELECT * FROM skills WHERE agent_address = ? AND enabled = 1 ORDER BY created_at ASC`)
    .all(agentAddress) as SkillRow[];
  return rows.map(rowToSkill);
}

export function getSkill(agentAddress: string, name: string): Skill | null {
  const row = db
    .prepare(`SELECT * FROM skills WHERE agent_address = ? AND name = ? AND enabled = 1`)
    .get(agentAddress, name) as SkillRow | undefined;
  return row ? rowToSkill(row) : null;
}

export function removeSkill(agentAddress: string, name: string): { success: boolean; error?: string } {
  const result = db
    .prepare(`UPDATE skills SET enabled = 0 WHERE agent_address = ? AND name = ? AND enabled = 1`)
    .run(agentAddress, name);
  if (result.changes === 0) {
    return { success: false, error: `No skill named "${name}" found.` };
  }
  return { success: true };
}
