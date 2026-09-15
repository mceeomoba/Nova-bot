import Docker from "dockerode";
import fs from "fs/promises";
import { config } from "./config.js";
import { officeFsDir, browserProfileDir } from "./office.js";
import { assertProtectedIntegrity, protectedBindSpecs } from "./protectedIntegrity.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const CONTAINER_NAME = "automaton-sandbox";

/**
 * Ensures the hardened sandbox container exists and is running, creating
 * it if necessary. Idempotent — safe to call on every backend startup.
 *
 * NOTE (Agent-OS Phase 0): this is the pre-office-model shared container
 * — every agent that calls /vm/exec without a sandboxId still lands
 * here, in ONE container bound to the flat `vmWorkdir` scratch dir, not
 * an isolated office. That's a real gap against "every agent owns its
 * own world" (architecture-agent.md §1) for any agent still on this
 * path. File I/O is already closed for this gap as of Phase 0 (see
 * vmService.ts's /vm/file/* routes, which now always scope to the
 * calling agent's own office/workspace regardless of which container
 * ran the command) — but `exec` on the shared container still runs
 * every such agent's commands in the same container. Tracked follow-up:
 * migrate every caller to a named per-agent sandbox (createNamedSandbox
 * below) and retire this function; see next-phase.md.
 *
 * Hardening applied at the container level (not per-exec, since these
 * are immutable for the container's lifetime):
 *  - No new privileges, all Linux capabilities dropped
 *  - Read-only root filesystem; only /workspace and /tmp are writable
 *  - Memory / CPU / PID limits enforced by the kernel via cgroups
 *  - Network disabled by default (agents that need network are a
 *    conscious opt-in via DOCKER_SANDBOX_NETWORK, not a default)
 *  - Runs as a fixed non-root UID, never root
 */
export async function ensureSandboxContainer(): Promise<Docker.Container> {
  const existing = docker.getContainer(CONTAINER_NAME);
  try {
    const info = await existing.inspect();
    const required = protectedBindSpecs(config.vmWorkdir);
    const binds = info.HostConfig?.Binds ?? [];
    if (required.some((mount) => !binds.includes(mount))) {
      await existing.stop({ t: 1 }).catch(() => undefined);
      await existing.remove({ force: true });
      throw new Error("sandbox protection mounts missing; recreating");
    }
    if (!info.State.Running) {
      await existing.start();
    }
    return existing;
  } catch {
    // Doesn't exist yet — fall through to create it.
  }

  const container = await docker.createContainer({
    name: CONTAINER_NAME,
    Image: config.dockerSandboxImage,
    // Keep the container alive; individual commands are injected via exec.
    Cmd: ["tail", "-f", "/dev/null"],
    User: "10001:10001",
    WorkingDir: "/workspace",
    HostConfig: {
      Binds: [`${config.vmWorkdir}:/workspace`, ...protectedBindSpecs(config.vmWorkdir)],
      NetworkMode: config.dockerSandboxNetwork, // "none" by default
      Memory: config.dockerMemoryLimitMb * 1024 * 1024,
      MemorySwap: config.dockerMemoryLimitMb * 1024 * 1024, // no swap beyond limit
      NanoCpus: config.dockerCpuQuota * 1_000_000_000,
      PidsLimit: config.dockerPidsLimit,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "size=64m,mode=1777" },
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      RestartPolicy: { Name: "unless-stopped" },
    },
  });

  await container.start();
  return container;
}

/**
 * Runs a command inside the sandbox container via `docker exec`, with a
 * hard wall-clock timeout and output size cap enforced here (cgroups
 * handle memory/CPU/pids; this handles runaway output and hangs, which
 * cgroups don't).
 */
export async function execInSandbox(
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const container = await ensureSandboxContainer();
  return execInContainer(container, cmd, args, timeoutMs, maxOutputBytes, config.vmWorkdir);
}

// ─────────────────────────────────────────────────────────────────
// Multi-sandbox support (Phase 4): named, isolated containers, one
// per agent/child, separate from the shared CONTAINER_NAME above.
// Same hardening profile; the only differences are per-sandbox
// resource limits and (optionally) a bridge network with published
// ports, which the shared sandbox intentionally never gets.
// ─────────────────────────────────────────────────────────────────

const SANDBOX_LABEL = "automaton-managed-sandbox";

export interface NamedSandboxOptions {
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  /** The agent this sandbox belongs to. Determines which office's fs/
   *  and browser/ dirs get bind-mounted in — every sandbox for a given
   *  agent binds the SAME office/fs, since they're one agent's multiple
   *  "terminal windows" into one office, not separate offices. See
   *  architecture-agent.md §1 and §4 ("sub-resources of A's office, not
   *  new offices"). */
  agentAddress: string;
  /** If non-empty, the container gets a bridge network with these
   *  container ports each published to a host-assigned free port. */
  exposedContainerPorts?: number[];
  /** next-phase.md Phase 9f-i: explicit network opt-in, independent of
   *  exposedContainerPorts (which forces network on for a different
   *  reason — a published port). Defaults to false when omitted, same
   *  "network disabled by default" posture this file has had since
   *  Phase 0. Callers (vmService.ts) decide the actual default per
   *  sandbox kind — true for a top-level Agent's own default sandbox,
   *  false for department/project environments unless the owning Agent
   *  explicitly opts one in. */
  network?: boolean;
}

/** Creates a fresh isolated container. Caller is responsible for
 *  picking a unique `id` (used as both DB primary key and container name).
 *  Binds ONLY the agent's office/fs (workspace+inbox+outbox) and browser
 *  profile — never office/private (see office.ts's officePrivateDir),
 *  which must remain physically unreachable from inside this container. */
export async function createNamedSandbox(
  id: string,
  opts: NamedSandboxOptions,
): Promise<void> {
  const wantsNetwork = opts.network === true || (opts.exposedContainerPorts?.length ?? 0) > 0;

  const exposedPorts: Record<string, {}> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};
  for (const p of opts.exposedContainerPorts ?? []) {
    exposedPorts[`${p}/tcp`] = {};
    portBindings[`${p}/tcp`] = [{ HostPort: "" }]; // "" = docker picks a free host port
  }

  const fsDir = officeFsDir(opts.agentAddress);
  const browserDir = browserProfileDir(opts.agentAddress);
  await fs.mkdir(fsDir, { recursive: true });
  await fs.mkdir(browserDir, { recursive: true });

  const container = await docker.createContainer({
    name: id,
    Image: config.dockerSandboxImage,
    Cmd: ["tail", "-f", "/dev/null"],
    User: "10001:10001",
    WorkingDir: "/workspace",
    Labels: { [SANDBOX_LABEL]: "true", "automaton-agent-address": opts.agentAddress },
    ExposedPorts: wantsNetwork ? exposedPorts : undefined,
    HostConfig: {
      Binds: [
        `${fsDir}:/workspace`,
        ...protectedBindSpecs(fsDir),
        // Separate mount, own container path — this is the persistent
        // Chromium --user-data-dir (architecture-agent.md §2a). Kept
        // outside /workspace so a workspace wipe never takes browser
        // sessions with it, and vice versa.
        `${browserDir}:/home/agent/.browser-profile`,
      ],
      NetworkMode: wantsNetwork ? "bridge" : "none",
      PortBindings: wantsNetwork ? portBindings : undefined,
      Memory: opts.memoryMb * 1024 * 1024,
      MemorySwap: opts.memoryMb * 1024 * 1024,
      NanoCpus: opts.vcpu * 1_000_000_000,
      PidsLimit: config.dockerPidsLimit,
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "size=64m,mode=1777" },
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      RestartPolicy: { Name: "unless-stopped" },
    },
  });

  await container.start();
}

export async function deleteNamedSandbox(id: string): Promise<void> {
  const container = docker.getContainer(id);
  try {
    await container.stop({ t: 5 });
  } catch {
    // already stopped
  }
  await container.remove({ force: true });
}

/** Returns the host port (on 127.0.0.1) that a given container port was
 *  published to, or null if that port isn't published on this sandbox. */
export async function getPublishedHostPort(
  sandboxId: string,
  containerPort: number,
): Promise<number | null> {
  const container = docker.getContainer(sandboxId);
  const info = await container.inspect();
  const bindings = info.NetworkSettings?.Ports?.[`${containerPort}/tcp`];
  if (!bindings || bindings.length === 0) return null;
  return Number(bindings[0].HostPort);
}

export async function execInNamedSandbox(
  sandboxId: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const container = docker.getContainer(sandboxId);
  const info = await container.inspect();
  const address = info.Config?.Labels?.["automaton-agent-address"];
  const root = address ? officeFsDir(address) : undefined;
  if (root) {
    const required = protectedBindSpecs(root);
    const binds = info.HostConfig?.Binds ?? [];
    if (required.some((mount) => !binds.includes(mount))) {
      await container.stop({ t: 1 }).catch(() => undefined);
      await container.remove({ force: true });
      throw new Error("sandbox protection mounts missing; sandbox was stopped");
    }
  }
  return execInContainer(container, cmd, args, timeoutMs, maxOutputBytes, root);
}

/**
 * next-phase.md Phase 9c: exec against an arbitrary, already-running
 * container by name — NOT one of this file's own managed sandboxes
 * (no SANDBOX_LABEL, no hardening profile applied/assumed here, no
 * lifecycle management). Used by domains.ts for the fixed
 * `domain-stack-nginx`/`domain-stack-certbot` container_names Phase
 * 9b's own docker-compose.yml declares and already runs with its own
 * hardening — this function only reuses execInContainer's shared
 * exec/timeout/output-cap plumbing, the same way execInSandbox and
 * execInNamedSandbox above already do for their own container sets.
 */
export async function execInNamedContainer(
  containerName: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const container = docker.getContainer(containerName);
  return execInContainer(container, cmd, args, timeoutMs, maxOutputBytes);
}

// ─────────────────────────────────────────────────────────────────
// Post-creation bind reconciliation (Phase 3f-i, join_project()):
// dockerode/the Docker Engine API has no "add a bind mount to an
// already-running container" call — Binds are fixed at container
// creation. Every prior HostConfig in this file (the shared container,
// createNamedSandbox) has therefore only ever set Binds once, at create
// time. join_project is the first capability in this codebase that
// needs to add a mount to a sandbox that may already exist and already
// be running an agent's session.
//
// The safe way to do that, given the constraint above, is to recreate
// the container: stop it, remove it, create a new one under the SAME
// name with the SAME image/user/resource limits/hardening profile,
// plus the one additional (or minus the one removed) bind. This is a
// real behavior change from every prior sandbox operation in this file
// (which never destroys a container to modify it) — but it's also safe
// specifically because of how this codebase already builds every
// sandbox: ReadonlyRootfs + a scratch Tmpfs /tmp mean nothing durable
// ever lives outside an explicit bind mount, so a stop+remove+recreate
// loses nothing a caller could have been depending on. A running
// process inside the container (e.g. mid pty session) IS lost — same
// as any other container restart — which is why this is only ever
// called from join_project's own explicit, caller-initiated path, not
// from anything automatic.
// ─────────────────────────────────────────────────────────────────

/**
 * Recreates `sandboxId`'s container with `mutate(currentBinds)` as its
 * new Binds array, preserving every other piece of its existing
 * HostConfig (hardening flags, resource limits, network mode/port
 * bindings) plus its Image/Cmd/User/WorkingDir/Labels/ExposedPorts. A
 * no-op (no stop/remove/recreate at all) if `mutate` doesn't actually
 * change the bind set — join_project's own idempotent-repeat-call case
 * should never pay for a container restart it doesn't need.
 */
async function reconcileSandboxBinds(
  sandboxId: string,
  mutate: (currentBinds: string[]) => string[],
): Promise<void> {
  const container = docker.getContainer(sandboxId);
  const info = await container.inspect();
  const currentBinds: string[] = info.HostConfig?.Binds ?? [];
  const nextBinds = mutate(currentBinds);

  const same =
    currentBinds.length === nextBinds.length &&
    [...currentBinds].sort().every((b, i) => b === [...nextBinds].sort()[i]);
  if (same) return;

  const wasRunning = info.State?.Running ?? false;
  try {
    await container.stop({ t: 5 });
  } catch {
    // already stopped
  }
  await container.remove({ force: true });

  const hc = info.HostConfig ?? {};
  const created = await docker.createContainer({
    name: sandboxId,
    Image: info.Config?.Image,
    Cmd: info.Config?.Cmd,
    User: info.Config?.User,
    WorkingDir: info.Config?.WorkingDir,
    Labels: info.Config?.Labels,
    ExposedPorts: info.Config?.ExposedPorts,
    HostConfig: {
      Binds: nextBinds,
      NetworkMode: hc.NetworkMode,
      PortBindings: hc.PortBindings,
      Memory: hc.Memory,
      MemorySwap: hc.MemorySwap,
      NanoCpus: hc.NanoCpus,
      PidsLimit: hc.PidsLimit,
      ReadonlyRootfs: hc.ReadonlyRootfs,
      Tmpfs: hc.Tmpfs,
      SecurityOpt: hc.SecurityOpt,
      CapDrop: hc.CapDrop,
      RestartPolicy: hc.RestartPolicy,
    },
  });

  if (wasRunning) await created.start();
}

/**
 * Idempotent: mounts `hostPath` at `/joint/{channelId}` read-write
 * inside `sandboxId`'s container, unless it's already mounted there
 * (checked by suffix match on the container-path half of the bind
 * spec — same "the bind already reflects the desired state, skip the
 * recreate" reasoning `reconcileSandboxBinds`'s own same-set check
 * uses at the whole-array level).
 */
export async function mountJointDirIntoSandbox(
  sandboxId: string,
  hostPath: string,
  channelId: string,
): Promise<void> {
  const containerPath = `/joint/${channelId}`;
  await reconcileSandboxBinds(sandboxId, (binds) => {
    if (binds.some((b) => b.split(":")[1] === containerPath)) return binds;
    return [...binds, `${hostPath}:${containerPath}`];
  });
}

/**
 * The Phase 3f-ii counterpart (teardown on revoke) — included here now
 * since it's the natural mirror of mountJointDirIntoSandbox above, not
 * because 3f-ii's own caller (channelService.ts's revoke-triggered
 * unmount) is wired up yet. A no-op if the bind was never present.
 */
export async function unmountJointDirFromSandbox(
  sandboxId: string,
  channelId: string,
): Promise<void> {
  const containerPath = `/joint/${channelId}`;
  await reconcileSandboxBinds(sandboxId, (binds) =>
    binds.filter((b) => b.split(":")[1] !== containerPath),
  );
}

/**
 * next-phase.md Phase 9f-i: same "Docker can't hot-change this on a
 * running container" constraint reconcileSandboxBinds() above already
 * documents for Binds — NetworkMode is exactly as fixed-at-create-time
 * as Binds is, so toggling a sandbox's network access after the fact
 * means the identical stop/remove/recreate dance, just mutating
 * NetworkMode instead of the Binds array. Idempotent: a no-op if the
 * container's current NetworkMode already matches the requested state,
 * same "don't pay for a restart you don't need" reasoning
 * mountJointDirIntoSandbox's own same-bind check already uses.
 *
 * Deliberately does NOT touch ExposedPorts/PortBindings — a sandbox
 * that already has published ports (the exposedContainerPorts case)
 * keeps them exactly as they are; this only flips plain bridge-vs-none
 * for a sandbox that has no ports of its own to publish, which is
 * every department/project/default-agent sandbox this function is
 * actually used for.
 */
export async function setSandboxNetwork(sandboxId: string, wantsNetwork: boolean): Promise<void> {
  const container = docker.getContainer(sandboxId);
  const info = await container.inspect();
  const hc = info.HostConfig ?? {};
  const currentlyOn = hc.NetworkMode === "bridge";
  if (currentlyOn === wantsNetwork) return;

  const wasRunning = info.State?.Running ?? false;
  try {
    await container.stop({ t: 5 });
  } catch {
    // already stopped
  }
  await container.remove({ force: true });

  const created = await docker.createContainer({
    name: sandboxId,
    Image: info.Config?.Image,
    Cmd: info.Config?.Cmd,
    User: info.Config?.User,
    WorkingDir: info.Config?.WorkingDir,
    Labels: info.Config?.Labels,
    ExposedPorts: info.Config?.ExposedPorts,
    HostConfig: {
      Binds: hc.Binds,
      NetworkMode: wantsNetwork ? "bridge" : "none",
      PortBindings: hc.PortBindings,
      Memory: hc.Memory,
      MemorySwap: hc.MemorySwap,
      NanoCpus: hc.NanoCpus,
      PidsLimit: hc.PidsLimit,
      ReadonlyRootfs: hc.ReadonlyRootfs,
      Tmpfs: hc.Tmpfs,
      SecurityOpt: hc.SecurityOpt,
      CapDrop: hc.CapDrop,
      RestartPolicy: hc.RestartPolicy,
    },
  });

  if (wasRunning) await created.start();
}

/** Shared exec logic, factored out so both the default shared sandbox
 *  and named isolated sandboxes use identical behavior. */
async function execInContainer(
  container: Docker.Container,
  cmd: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  integrityRoot?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  const integrity = integrityRoot ? await assertProtectedIntegrity(integrityRoot) : undefined;
  const exec = await container.exec({
    Cmd: [cmd, ...args],
    AttachStdout: true,
    AttachStderr: true,
    WorkingDir: "/workspace",
  });

  const stream = await exec.start({ hijack: true, stdin: false });

  let stdout = "";
  let stderr = "";
  let truncated = false;

  const collect = new Promise<void>((resolve) => {
    container.modem.demuxStream(
      stream,
      {
        write: (chunk: Buffer) => {
          if (stdout.length < maxOutputBytes) stdout += chunk.toString("utf8");
          else truncated = true;
        },
      } as any,
      {
        write: (chunk: Buffer) => {
          if (stderr.length < maxOutputBytes) stderr += chunk.toString("utf8");
          else truncated = true;
        },
      } as any,
    );
    stream.on("end", resolve);
  });

  let timedOut = false;
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
  });

  await Promise.race([collect, timeout]);

  const inspectResult = await exec.inspect();
  if (integrity && integrityRoot) {
    try { await assertProtectedIntegrity(integrityRoot, integrity); }
    catch (error) {
      await container.stop({ t: 1 }).catch(() => undefined);
      throw error;
    }
  }

  if (truncated) {
    stdout += "\n[output truncated: exceeded max output size]";
  }
  if (timedOut) {
    stderr += "\n[execution timed out and was abandoned — process may still be running in sandbox]";
  }

  return {
    stdout,
    stderr,
    exitCode: inspectResult.ExitCode ?? -1,
    timedOut,
  };
}
