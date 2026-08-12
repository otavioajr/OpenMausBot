// Docker provider — the bot's computer, running as a local container on the
// machine that hosts the harness. A free, self-hosted alternative to
// box.ascii.dev: same lifecycle shape (find-or-create, sleep to pause, wake on
// use, destroy on bot delete), no per-VM billing, no external service.
//
// Design mirrors box.ts on purpose so both can sit behind one call site:
//   - deterministic per-bot names (a bot always re-finds its own container)
//   - stop/start instead of create/destroy: stopping frees CPU+RAM while the
//     capped writable layer (/workspace + Codex sessions) survives
//   - destroy() is the only path that deletes state, and it is wired to bot
//     deletion so an environment never outlives its bot
//
// Isolation notes (why these flags):
//   - no Docker socket is ever mounted: a bot must not be able to reach the
//     host's other containers (this host also runs unrelated production ones)
//   - --pids-limit and memory/cpu caps stop one bot starving the host
//   - --cap-drop=ALL: nothing here needs raw capabilities
//   - runs as uid 1000 (`ubuntu`), never root
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const IMAGE = process.env.OMB_DOCKER_IMAGE || "openmausbot-box:latest";
export const PROXY_IMAGE = process.env.OMB_DOCKER_PROXY_IMAGE || "openmausbot-router-proxy:latest";
export const DESKTOP_IMAGE = process.env.OMB_DOCKER_DESKTOP_IMAGE || "openmausbot-desktop:latest";
const LABEL = "openmausbot.bot-id";

/** Graphical desktops are opt-in: without the image built, isolated bots stay
 * terminal-only and every desktop route degrades to "unavailable". */
export function desktopEnabled(): boolean {
  return (process.env.OMB_DOCKER_DESKTOP ?? "true") !== "false";
}

/** A desktop needs more headroom than a terminal (X + WM + browser). Kept as
 * a separate ceiling so terminal bots stay cheap. */
const DESKTOP_LIMITS = {
  cpus: process.env.OMB_DOCKER_DESKTOP_CPUS || "1.5",
  memory: process.env.OMB_DOCKER_DESKTOP_MEMORY || "3g",
  pids: process.env.OMB_DOCKER_DESKTOP_PIDS || "1024",
  shm: process.env.OMB_DOCKER_DESKTOP_SHM || "512m",
};

/** Per-bot resource ceiling. Containers are idle most of the time; these caps
 * exist so one runaway bot cannot take the host down with it. */
const LIMITS = {
  cpus: process.env.OMB_DOCKER_CPUS || "1",
  memory: process.env.OMB_DOCKER_MEMORY || "2g",
  pids: process.env.OMB_DOCKER_PIDS || "512",
  storage: process.env.OMB_DOCKER_STORAGE || "10G",
};

export type BoxState = "running" | "stopped" | "missing";

export interface DockerBox {
  name: string;
  state: BoxState;
  containerId: string | null;
  /** True when this container was created from the graphical image. Existing
   * terminal containers keep working; upgrading is an explicit user action
   * because it recreates the container and wipes its filesystem. */
  hasDesktop: boolean;
}

/** Container/volume name for a bot. Docker names allow [a-zA-Z0-9_.-], and bot
 * ids are uuids, so a plain prefix is enough — no hashing needed. */
export function containerNameFor(botId: string): string {
  return `omb-bot-${botId.toLowerCase().replace(/[^a-z0-9_.-]/g, "")}`;
}

function networkNameFor(botId: string): string {
  return `${containerNameFor(botId)}-net`;
}

function egressNetworkNameFor(botId: string): string {
  return `${containerNameFor(botId)}-egress`;
}

function proxyNameFor(botId: string): string {
  return `${containerNameFor(botId)}-router`;
}

async function docker(
  args: string[],
  timeoutMs = 60_000,
  environment: Record<string, string> = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, ...environment },
    });
    return { ok: true, stdout, stderr };
  } catch (e: any) {
    return { ok: false, stdout: e?.stdout ?? "", stderr: e?.stderr ?? String(e?.message ?? e) };
  }
}

/** Is the Docker provider usable at all (daemon reachable + images built)? */
export async function dockerConfigured(): Promise<boolean> {
  const ping = await docker(["version", "--format", "{{.Server.Version}}"], 10_000);
  if (!ping.ok) return false;
  const img = await docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"], 10_000);
  if (!img.ok) return false;
  const proxy = await docker(["image", "inspect", PROXY_IMAGE, "--format", "{{.Id}}"], 10_000);
  return proxy.ok;
}

async function inspectContainer(name: string): Promise<DockerBox | null> {
  // Inspect by exact name. `docker ps --filter name=…` is a regex/substring
  // filter and can select the wrong bot when ids share a prefix.
  const res = await docker([
    "container", "inspect", name,
    "--format", `{{.Id}}|{{.State.Status}}|{{index .Config.Labels "openmausbot.desktop"}}`,
  ]).catch(() => null);
  const line = res?.ok ? res.stdout.trim() : "";
  if (!line) return null;
  const [containerId, state, desktop] = line.split("|");
  return {
    name,
    containerId: containerId ?? null,
    state: state === "running" ? "running" : "stopped",
    hasDesktop: desktop === "true",
  };
}

export async function findContainer(botId: string): Promise<DockerBox | null> {
  return inspectContainer(containerNameFor(botId));
}

async function ensureNetwork(botId: string): Promise<{ internal: string; egress: string }> {
  const internal = networkNameFor(botId);
  const egress = egressNetworkNameFor(botId);
  for (const [name, isInternal] of [[internal, true], [egress, false]] as const) {
    const inspect = await docker(["network", "inspect", name], 10_000);
    if (inspect.ok) continue;
    const args = ["network", "create"];
    if (isInternal) args.push("--internal");
    args.push("--label", `${LABEL}=${botId}`, "--driver", "bridge", name);
    const net = await docker(args, 30_000);
    if (!net.ok && !/already exists/i.test(net.stderr)) {
      throw new Error(`container network create failed: ${net.stderr.slice(0, 200)}`);
    }
  }
  return { internal, egress };
}

async function ensureProxy(
  botId: string,
  routerKey: string,
  networks: { internal: string; egress: string },
): Promise<void> {
  const name = proxyNameFor(botId);
  // The proxy is stateless. Recreate it on every wake so a rotated key and any
  // network-policy changes take effect immediately.
  if (await inspectContainer(name)) await docker(["rm", "-f", name], 30_000);

  // `-e NINEROUTER_API_KEY` copies the value from this child process's env.
  // The value never appears in argv/logs and is visible only in the hardened
  // proxy container — never in the agent container.
  const created = await docker(
    [
      "run", "-d",
      "--name", name,
      "--label", `${LABEL}=${botId}`,
      "--label", "openmausbot.role=router-proxy",
      "--restart", "no",
      "--cpus", "0.25",
      "--memory", "128m",
      "--pids-limit", "64",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      // Egress network has internet but the agent is not attached to it.
      "--network", networks.egress,
      "-e", "NINEROUTER_API_KEY",
      PROXY_IMAGE,
    ],
    60_000,
    { NINEROUTER_API_KEY: routerKey },
  );
  if (!created.ok) throw new Error(`router proxy create failed: ${created.stderr.slice(0, 240)}`);

  // Internal network has no internet. The alias exists only there, so the
  // agent can reach `router` but nothing else on the host or default bridge.
  const connected = await docker(
    ["network", "connect", "--alias", "router", networks.internal, name],
    30_000,
  );
  if (!connected.ok) {
    await docker(["rm", "-f", name], 30_000);
    throw new Error(`router proxy network attach failed: ${connected.stderr.slice(0, 200)}`);
  }
}

/** Wait until the private router is actually reachable from the agent
 * container. Returning before DNS/server readiness creates a flaky first turn. */
async function waitForProxy(agentName: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const ready = await docker([
      "exec", "-u", "ubuntu", agentName,
      "curl", "-fsS", "--max-time", "2", "http://router:8080/healthz",
    ], 5_000);
    if (ready.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("private router proxy did not become ready");
}

/** Find-or-create the bot's agent + private router and make sure both run. */
export async function provisionContainer(
  botId: string,
  botName: string,
  routerKey = process.env.NINEROUTER_API_KEY ?? "",
  opts: { desktop?: boolean } = {},
): Promise<DockerBox> {
  if (!routerKey) throw new Error("NINEROUTER_API_KEY is required for isolated bot environments");
  const wantDesktop = opts.desktop ?? desktopEnabled();
  const name = containerNameFor(botId);
  const networks = await ensureNetwork(botId);
  await ensureProxy(botId, routerKey, networks);
  const existing = await findContainer(botId);

  if (existing) {
    if (existing.state !== "running") {
      const started = await docker(["start", name], 60_000);
      if (!started.ok) throw new Error(`could not wake the container: ${started.stderr.slice(0, 200)}`);
    }
    await waitForProxy(name);
    // An existing terminal container is never silently recreated: that would
    // delete the bot's files. The panel offers an explicit upgrade instead.
    if (existing.hasDesktop) await waitForDesktop(name);
    return { ...existing, state: "running" };
  }

  const desktopArgs = wantDesktop
    ? [
        "--label", "openmausbot.desktop=true",
        "--cpus", DESKTOP_LIMITS.cpus,
        "--memory", DESKTOP_LIMITS.memory,
        "--pids-limit", DESKTOP_LIMITS.pids,
        // X and browsers need real shared memory; the 64m default breaks them.
        "--shm-size", DESKTOP_LIMITS.shm,
      ]
    : [
        "--label", "openmausbot.desktop=false",
        "--cpus", LIMITS.cpus,
        "--memory", LIMITS.memory,
        "--pids-limit", LIMITS.pids,
      ];

  const created = await docker([
    "run", "-d",
    "--name", name,
    "--label", `${LABEL}=${botId}`,
    "--label", "openmausbot.role=agent",
    "--label", `openmausbot.bot-name=${botName.slice(0, 60)}`,
    "--restart", "no",
    ...desktopArgs,
    "--storage-opt", `size=${LIMITS.storage}`,
    // hardening: no host docker access, no extra capabilities
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--network", networks.internal,
    // /workspace lives in this capped writable layer: it survives stop/start
    // and is deleted atomically with `docker rm`.
    "-w", "/workspace",
    wantDesktop ? DESKTOP_IMAGE : IMAGE,
  ], 180_000);

  if (!created.ok) {
    await docker(["rm", "-f", proxyNameFor(botId)], 30_000);
    await Promise.all(
      Object.values(networks).map((network) => docker(["network", "rm", network], 30_000)),
    );
    throw new Error(`container create failed: ${created.stderr.slice(0, 300)}`);
  }
  await waitForProxy(name);
  if (wantDesktop) await waitForDesktop(name);
  return { name, containerId: created.stdout.trim() || null, state: "running", hasDesktop: wantDesktop };
}

/** Block until X, the window manager and the input broker are actually up.
 * Streaming before this point shows the user a dead grey rectangle.
 * NOTE: `docker exec` does not inherit the container's runtime env, so DISPLAY
 * and XAUTHORITY must be passed explicitly or every probe fails. */
async function waitForDesktop(agentName: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const ready = await docker([
      "exec", "-u", "desktop",
      "-e", "DISPLAY=:1",
      "-e", "XAUTHORITY=/home/desktop/.Xauthority",
      agentName,
      "sh", "-c", "test -S /run/omb/input.sock && xdpyinfo >/dev/null 2>&1",
    ], 5_000);
    if (ready.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // Surface the real reason instead of a bare timeout: the desktop log says
  // exactly what failed (X lock, missing binary, OOM…).
  const log = await docker(["logs", "--tail", "12", agentName], 5_000);
  const reason = (log.stdout + log.stderr).trim().split("\n").filter(Boolean).slice(-3).join(" | ");
  throw new Error(`the desktop did not finish starting${reason ? ` — ${reason}` : ""}`);
}

/** Recreate a bot's container using the graphical image. Destructive by
 * nature: the writable layer cannot be carried across images, so the caller
 * must confirm with the user first. */
export async function upgradeToDesktop(botId: string, botName: string): Promise<DockerBox> {
  const existing = await findContainer(botId);
  if (existing?.hasDesktop) return provisionContainer(botId, botName, undefined, { desktop: true });
  if (existing) await docker(["rm", "-f", containerNameFor(botId)], 60_000);
  return provisionContainer(botId, botName, undefined, { desktop: true });
}

/** Ensure the environment exists and is running, then return the agent. */
async function ensureRunning(botId: string, botName = "bot"): Promise<DockerBox> {
  return provisionContainer(botId, botName);
}

/** Stop agent + private router: frees CPU/RAM, keeps the agent filesystem. */
export async function sleepContainer(botId: string): Promise<{ ok: boolean }> {
  const names = [containerNameFor(botId), proxyNameFor(botId)];
  await Promise.all(
    names.map(async (name) => {
      const box = await inspectContainer(name);
      if (box?.state === "running") await docker(["stop", "-t", "5", name], 30_000);
    }),
  );
  return { ok: true };
}

/** Delete agent + proxy + networks. The writable layer dies with the agent;
 * an environment must never outlive the bot it belongs to. */
export async function destroyContainer(botId: string): Promise<{ ok: boolean; removed: boolean }> {
  const agent = containerNameFor(botId);
  const proxy = proxyNameFor(botId);
  const networks = [networkNameFor(botId), egressNetworkNameFor(botId)];
  const existing = await findContainer(botId);
  const failures: string[] = [];
  for (const [role, name] of [["agent", agent], ["proxy", proxy]] as const) {
    const container = await inspectContainer(name);
    if (!container) continue;
    const rm = await docker(["rm", "-f", name], 60_000);
    if (!rm.ok) failures.push(`${role}: ${rm.stderr.slice(0, 160)}`);
  }
  // Both per-bot networks outlive the containers; remove them explicitly.
  for (const network of networks) {
    const net = await docker(["network", "rm", network], 30_000);
    if (!net.ok && !/not found|no such network/i.test(net.stderr)) {
      failures.push(`network ${network}: ${net.stderr.slice(0, 160)}`);
    }
  }
  if (failures.length) throw new Error(`environment cleanup incomplete — ${failures.join("; ")}`);
  return { ok: true, removed: Boolean(existing) };
}

/** Run a shell command inside the bot's container (waking it if needed). */
export async function execInContainer(
  botId: string,
  command: string,
  { timeoutMs = 120_000, botName = "bot" } = {},
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const box = await ensureRunning(botId, botName);
  const res = await docker(
    ["exec", "-u", "ubuntu", "-w", "/workspace", box.name, "bash", "-lc", String(command ?? "").slice(0, 8000)],
    timeoutMs,
  );
  return {
    exitCode: res.ok ? 0 : 1,
    stdout: res.stdout.slice(-8000),
    stderr: res.stderr.slice(-4000),
  };
}

/** Lifecycle/state for the Computer panel. */
export async function containerStatus(botId: string) {
  if (!(await dockerConfigured())) {
    return { configured: false, box: null };
  }
  const box = await findContainer(botId);
  const desktopImage = desktopEnabled()
    ? (await docker(["image", "inspect", DESKTOP_IMAGE, "--format", "{{.Id}}"], 10_000)).ok
    : false;
  return {
    configured: true,
    kind: "docker",
    desktopSupported: desktopImage,
    limits: desktopImage
      ? { cpus: DESKTOP_LIMITS.cpus, memory: DESKTOP_LIMITS.memory, storage: LIMITS.storage }
      : { cpus: LIMITS.cpus, memory: LIMITS.memory, storage: LIMITS.storage },
    box: box
      ? {
          boxId: box.name,
          state: box.state,
          // Only a running graphical container can actually be streamed.
          desktopAvailable: box.hasDesktop && box.state === "running",
          hasDesktop: box.hasDesktop,
        }
      : null,
  };
}

/** Bot ids that currently own a container — used to reap orphans at boot. */
export async function listManagedBotIds(): Promise<string[]> {
  const res = await docker(["ps", "-a", "--filter", `label=${LABEL}`, "--format", `{{.Label "${LABEL}"}}`]);
  return [...new Set(res.stdout.trim().split("\n").filter(Boolean))];
}

/** Remove containers whose bot no longer exists. This closes the crash window
 * between persisting bot deletion and destroying its environment. */
export async function reapOrphans(validBotIds: Iterable<string>): Promise<string[]> {
  const valid = new Set(validBotIds);
  const managed = await listManagedBotIds();
  const removed: string[] = [];
  for (const botId of managed) {
    if (valid.has(botId)) continue;
    await destroyContainer(botId);
    removed.push(botId);
  }
  return removed;
}

export const __testing = { networkNameFor, egressNetworkNameFor, proxyNameFor };
