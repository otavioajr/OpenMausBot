// Live desktop bridge for isolated bots.
//
// Two jobs:
//   1) hand the browser a real-time VNC stream (no screenshot polling)
//   2) enforce ONE writer at a time — bot or human, never both
//
// Security shape: the container publishes no port and x11vnc listens on
// 127.0.0.1 *inside* the container. The only route in is this process, which
// pipes bytes through `docker exec socat`. So reaching a bot's desktop requires
// access to the harness (already Tailscale-only) plus a short-lived,
// single-bot ticket — there is no network listener to find or scan.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import { containerNameFor, desktopEnabled, findContainer } from "./dockerbox.ts";

/** Tickets are single-bot and short-lived: a leaked URL cannot be replayed
 * later, and cannot be pointed at a different bot. */
const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, { botId: string; expires: number }>();

/** Who may send input to a desktop. The bot's own broker enforces the same
 * lock inside the container, so this is not merely a UI affordance. */
const humanControl = new Map<string, { until: number }>();
const CONTROL_TTL_MS = 5 * 60_000;

/** Live VNC bridges per bot, so parking can close them from the host side.
 * A `docker exec socat` left running would otherwise be frozen inside a paused
 * container and hold a half-open WebSocket. */
const bridges = new Map<string, Set<() => void>>();

/** Drop tickets and tear down every live stream for one bot. Called before a
 * graphical container is paused. */
export function closeDesktopBridges(botId: string): void {
  for (const [key, value] of tickets) if (value.botId === botId) tickets.delete(key);
  const active = bridges.get(botId);
  if (!active) return;
  for (const stop of [...active]) stop();
  bridges.delete(botId);
}

export function issueDesktopTicket(botId: string): { ticket: string; url: string; expiresIn: number } {
  const ticket = randomBytes(24).toString("base64url");
  tickets.set(ticket, { botId, expires: Date.now() + TICKET_TTL_MS });
  // Sweep expired tickets so the map cannot grow unbounded.
  for (const [key, value] of tickets) if (value.expires < Date.now()) tickets.delete(key);
  return { ticket, url: `/api/desktop/stream?ticket=${ticket}`, expiresIn: TICKET_TTL_MS };
}

function consumeTicket(ticket: string | null): string | null {
  if (!ticket) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket); // single use
  if (entry.expires < Date.now()) return null;
  return entry.botId;
}

export function controlState(botId: string): "human" | "bot" {
  const held = humanControl.get(botId);
  if (!held) return "bot";
  if (held.until < Date.now()) {
    humanControl.delete(botId);
    return "bot";
  }
  return "human";
}

/** Take/refresh human control. The lock file inside the container is what
 * actually stops the agent, so this awaits the container write. */
export async function takeControl(botId: string): Promise<{ control: "human" }> {
  humanControl.set(botId, { until: Date.now() + CONTROL_TTL_MS });
  await execInDesktop(botId, ["touch", "/run/omb/human-control"]);
  return { control: "human" };
}

export async function releaseControl(botId: string): Promise<{ control: "bot" }> {
  humanControl.delete(botId);
  await execInDesktop(botId, ["rm", "-f", "/run/omb/human-control"]);
  return { control: "bot" };
}

/** Keep the lock alive while a human is actively driving. Without this the
 * bot would stay locked out forever if a tab is closed mid-session. */
export function heartbeatControl(botId: string): void {
  if (humanControl.has(botId)) humanControl.set(botId, { until: Date.now() + CONTROL_TTL_MS });
}

function execInDesktop(botId: string, argv: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    // The lock file lives in /run/omb, owned by the desktop user.
    const child = spawn("docker", ["exec", "-u", "desktop", containerNameFor(botId), ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("error", () => resolve({ ok: false, output }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.slice(0, 500) }));
  });
}

/** Ask the in-container broker for a screenshot and return it as a data URL.
 * Used for the parked-state thumbnail and for chat evidence — not as a stream. */
export async function captureScreenshot(botId: string): Promise<string | null> {
  const path = `/workspace/.omb-screen.png`;
  const shot = await execInDesktop(botId, [
    "python3",
    "-c",
    `import json,socket
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.settimeout(30)
s.connect("/run/omb/input.sock")
s.sendall(json.dumps({"op":"screenshot","path":"${path}"}).encode()+b"\\n")
print(s.makefile("rb").readline().decode())`,
  ]);
  if (!shot.ok || !/"ok":\s*true/.test(shot.output)) return null;
  const base64 = await new Promise<string>((resolve) => {
    const child = spawn("docker", ["exec", "-u", "desktop", containerNameFor(botId), "base64", "-w", "0", path]);
    let out = "";
    child.stdout.on("data", (c) => (out += String(c)));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out.trim()));
  });
  return base64 ? `data:image/png;base64,${base64}` : null;
}

/**
 * Bridge a browser WebSocket to the container's loopback VNC port.
 *
 * Frames arrive as binary and are piped straight through; RFB is a byte
 * stream, so no protocol awareness is needed here. Input suppression happens
 * at the broker (for the bot) and by the client running view-only (for the
 * human), which keeps this hot path a dumb, fast pipe.
 */
export function attachDesktopBridge(server: import("node:http").Server): void {
  if (!desktopEnabled()) return;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/desktop/stream") return;
    const botId = consumeTicket(url.searchParams.get("ticket"));
    if (!botId) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => pipeToVnc(ws, botId));
  });
}

function pipeToVnc(ws: WebSocket, botId: string): void {
  void (async () => {
    const box = await findContainer(botId);
    if (!box || box.state !== "running") {
      ws.close(1011, "desktop is not running");
      return;
    }

    // socat is the shim: stdio on this side, loopback TCP on the container side.
    const child = spawn(
      "docker",
      ["exec", "-i", "-u", "desktop", box.name, "socat", "-", "TCP:127.0.0.1:5901"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let closed = false;
    const shutdown = (reason: string) => {
      if (closed) return;
      closed = true;
      bridges.get(botId)?.delete(shutdownRef);
      child.kill("SIGKILL");
      if (ws.readyState === ws.OPEN) ws.close(1000, reason);
    };
    const shutdownRef = () => shutdown("desktop parked");
    const set = bridges.get(botId) ?? new Set<() => void>();
    set.add(shutdownRef);
    bridges.set(botId, set);

    child.stdout.on("data", (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk, { binary: true });
    });
    child.stderr.on("data", () => {}); // socat chatter is not interesting
    child.on("error", () => shutdown("bridge error"));
    child.on("close", () => shutdown("desktop stream ended"));

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (child.stdin.destroyed) return;
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
      child.stdin.write(buf);
      // Any traffic from a controlling human keeps the lock warm.
      heartbeatControl(botId);
    });
    ws.on("close", () => shutdown("client closed"));
    ws.on("error", () => shutdown("client error"));
  })();
}
