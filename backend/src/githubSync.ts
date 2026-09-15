import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

type Commit = { sha: string; files?: { filename: string; status: string; raw_url?: string }[] };
const forbidden = /(^|\/)(\.env[^/]*|node_modules|\.git)(\/|$)/i;

function safeTarget(root: string, name: string): string | null {
  if (!name || name.includes("\\") || forbidden.test(name)) return null;
  const target = path.resolve(root, name);
  return target === root || target.startsWith(root + path.sep) ? target : null;
}

async function github<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub sync request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

async function githubText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { ...(config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}) } });
  if (!response.ok) throw new Error(`GitHub file request failed: ${response.status}`);
  return response.text();
}

async function applyCommit(commit: Commit): Promise<boolean> {
  let changed = false;
  for (const file of commit.files ?? []) {
    const target = safeTarget(path.resolve(config.githubSyncRoot), file.filename);
    if (!target) continue;
    if (file.status === "removed") { await fs.rm(target, { force: true }); changed = true; continue; }
    if (!file.raw_url) continue;
    const body = await githubText(file.raw_url);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    changed = true;
  }
  return changed;
}

export function startGithubSync(): () => void {
  if (!config.githubSyncEnabled || !config.githubToken) return () => undefined;
  let stopped = false;
  let lastSha: string | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      const commits = await github<Commit[]>(`https://api.github.com/repos/${config.githubSyncOwner}/${config.githubSyncRepo}/commits?sha=${encodeURIComponent(config.githubSyncBranch)}&per_page=1`);
      const latest = commits[0];
      if (!latest || latest.sha === lastSha) return;
      const detail = lastSha
        ? await github<Commit>(`https://api.github.com/repos/${config.githubSyncOwner}/${config.githubSyncRepo}/compare/${lastSha}...${latest.sha}`)
        : await github<Commit>(`https://api.github.com/repos/${config.githubSyncOwner}/${config.githubSyncRepo}/commits/${latest.sha}`);
      const changed = await applyCommit(detail);
      if (lastSha && changed && config.githubRestartCommand) spawn(config.githubRestartCommand, { shell: true, detached: true, stdio: "ignore" }).unref();
      lastSha = latest.sha;
    } catch (error) { console.error(`[github-sync] ${error instanceof Error ? error.message : "update failed"}`); }
  };
  void tick();
  const timer = setInterval(() => void tick(), Math.max(5000, config.githubSyncIntervalMs));
  return () => { stopped = true; clearInterval(timer); };
}
