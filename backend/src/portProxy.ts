/**
 * Port Exposure Proxy
 *
 * Gives agents a public URL for something they're running inside an
 * isolated sandbox, without needing a wildcard domain or an Nginx/Caddy
 * config step on your VM. Every exposed port gets an unguessable path
 * token; this Express router forwards {publicBaseUrl}/app/{token}/*
 * to the container's published host port using only Node's built-in
 * http module — no new dependency.
 *
 * Mounted BEFORE the shared-secret auth middleware in index.ts, since
 * these URLs are meant to be reachable by anyone the agent shares them
 * with — the same trust model as Conway's life.conway.tech links.
 */

import express from "express";
import http from "http";
import crypto from "crypto";
import { db } from "./db.js";
import { getPublishedHostPort } from "./docker.js";
import { config } from "./config.js";

const router = express.Router();

export function generatePortToken(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Register a sandbox's container port as exposed. Looks up the actual
 * host port Docker published it to, stores the mapping, and returns
 * the public URL. Called from vmService.ts's POST /vm/sandboxes/:id/ports.
 */
export async function exposePort(
  sandboxId: string,
  agentAddress: string,
  containerPort: number,
): Promise<{ token: string; url: string }> {
  const hostPort = await getPublishedHostPort(sandboxId, containerPort);
  if (hostPort === null) {
    throw new Error(
      `container port ${containerPort} is not published on sandbox ${sandboxId} — ` +
        `it must be included in exposedContainerPorts when the sandbox was created`,
    );
  }

  const existing = db
    .prepare(
      `SELECT token FROM exposed_ports WHERE sandbox_id = ? AND container_port = ?`,
    )
    .get(sandboxId, containerPort) as { token: string } | undefined;
  if (existing) {
    return { token: existing.token, url: `${config.publicBaseUrl}/app/${existing.token}` };
  }

  const token = generatePortToken();
  db.prepare(
    `INSERT INTO exposed_ports (token, sandbox_id, agent_address, container_port, host_port, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(token, sandboxId, agentAddress, containerPort, hostPort, Date.now());

  return { token, url: `${config.publicBaseUrl}/app/${token}` };
}

export function removePort(sandboxId: string, containerPort: number): void {
  db.prepare(`DELETE FROM exposed_ports WHERE sandbox_id = ? AND container_port = ?`).run(
    sandboxId,
    containerPort,
  );
}

export function listExposedPorts(
  agentAddress: string,
): Array<{ token: string; sandboxId: string; containerPort: number; url: string }> {
  const rows = db
    .prepare(`SELECT * FROM exposed_ports WHERE agent_address = ?`)
    .all(agentAddress) as Array<{ token: string; sandbox_id: string; container_port: number }>;
  return rows.map((r) => ({
    token: r.token,
    sandboxId: r.sandbox_id,
    containerPort: r.container_port,
    url: `${config.publicBaseUrl}/app/${r.token}`,
  }));
}

// GET/POST/PUT/DELETE {publicBaseUrl}/app/:token/*  -> http://127.0.0.1:{hostPort}/*
router.all("/:token/*", (req, res) => {
  const row = db
    .prepare(`SELECT host_port FROM exposed_ports WHERE token = ?`)
    .get(req.params.token) as { host_port: number } | undefined;

  if (!row) {
    res.status(404).send("Not found — this exposed port no longer exists.");
    return;
  }

  // req.url here is relative to this router's mount point, e.g.
  // "/a1b2c3.../foo/bar?x=1" — strip the token segment, keep the rest
  // (path + query string) exactly as received.
  const tokenPrefix = `/${req.params.token}`;
  const forwardPath = req.url.startsWith(tokenPrefix)
    ? req.url.slice(tokenPrefix.length) || "/"
    : "/";

  const proxyReq = http.request(
    {
      host: "127.0.0.1",
      port: row.host_port,
      path: forwardPath,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${row.host_port}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (err) => {
    res.status(502).send(`Bad gateway: sandbox app unreachable (${err.message})`);
  });

  req.pipe(proxyReq);
});

export default router;
