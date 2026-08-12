// Routines bridge for isolated (containerised) agents.
//
// An isolated bot's Codex runs inside a network-`internal` container with no
// route to the host — that isolation is the whole point, so routines must not
// punch a hole in it. Instead the harness listens on a Unix socket that is
// bind-mounted into the container, and a tiny client inside speaks MCP over
// that socket. No ports, no tokens in the container, no network at all.
//
// Wire format: newline-delimited JSON, one request per line:
//   -> {"op":"list"}                          <- {"ok":true,"routines":[…]}
//   -> {"op":"create","instruction":…,"trigger":…}
//   -> {"op":"update","id":…,"patch":{…}}
//   -> {"op":"delete","id":…}
// The socket is per-bot, so the server already knows which bot is calling and
// a container can never address another bot's routines.
import { createServer, type Server } from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { formatInstant, type Routine, type RoutineStore } from "./routines.ts";
import { describeTrigger, type Trigger } from "./schedule.ts";

/** Host directory holding one socket per isolated bot. */
export const ROUTINE_SOCKET_DIR = join(DATA_DIR, "routine-sockets");
/** Mount point inside the container. */
export const CONTAINER_SOCKET_PATH = "/run/omb/routines.sock";

export function socketPathFor(botId: string): string {
  return join(ROUTINE_SOCKET_DIR, `${botId}.sock`);
}

function present(routine: Routine) {
  return {
    id: routine.id,
    name: routine.name,
    instruction: routine.instruction,
    enabled: routine.enabled,
    scheduleLabel: describeTrigger(routine.trigger, routine.timezone),
    nextRunLabel: routine.nextRunAt ? formatInstant(routine.nextRunAt, routine.timezone) : null,
    lastRunLabel: routine.lastRunAt ? formatInstant(routine.lastRunAt, routine.timezone) : null,
  };
}

export interface BridgeDeps {
  routines: RoutineStore;
  /** Default zone for new routines when the agent does not name one. */
  timezone: () => string;
  onChange?: (routine: Routine) => void;
}

/** Serve one bot's routine socket. Returns a closer. */
export function serveRoutineSocket(botId: string, deps: BridgeDeps): { path: string; close: () => void } {
  mkdirSync(ROUTINE_SOCKET_DIR, { recursive: true });
  const path = socketPathFor(botId);
  rmSync(path, { force: true }); // a stale socket from a crash would block bind

  const handle = (line: string): string => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return JSON.stringify({ ok: false, error: "invalid JSON" });
    }
    try {
      switch (msg.op) {
        case "list":
          return JSON.stringify({ ok: true, routines: deps.routines.forBot(botId).map(present) });
        case "create": {
          const routine = deps.routines.create({
            botId,
            instruction: String(msg.instruction ?? ""),
            trigger: msg.trigger as Trigger,
            name: typeof msg.name === "string" ? msg.name : undefined,
            timezone: typeof msg.timezone === "string" ? msg.timezone : deps.timezone(),
          });
          deps.onChange?.(routine);
          return JSON.stringify({ ok: true, routine: present(routine) });
        }
        case "update": {
          const id = String(msg.id ?? "");
          // Ownership: only routines belonging to this socket's bot.
          if (!deps.routines.forBot(botId).some((r) => r.id === id)) {
            return JSON.stringify({ ok: false, error: "no such routine" });
          }
          const patch = (msg.patch ?? {}) as Record<string, unknown>;
          const updated = deps.routines.update(id, {
            instruction: typeof patch.instruction === "string" ? patch.instruction : undefined,
            trigger: patch.trigger as Trigger | undefined,
            name: typeof patch.name === "string" ? patch.name : undefined,
            timezone: typeof patch.timezone === "string" ? patch.timezone : undefined,
            enabled: typeof patch.enabled === "boolean" ? patch.enabled : undefined,
          });
          if (updated) deps.onChange?.(updated);
          return JSON.stringify({ ok: true, routine: updated ? present(updated) : null });
        }
        case "delete": {
          const id = String(msg.id ?? "");
          const owned = deps.routines.forBot(botId).find((r) => r.id === id);
          if (!owned) return JSON.stringify({ ok: false, error: "no such routine" });
          deps.routines.remove(id);
          deps.onChange?.({ ...owned, enabled: false });
          return JSON.stringify({ ok: true, deleted: owned.name });
        }
        default:
          return JSON.stringify({ ok: false, error: `unknown op: ${String(msg.op)}` });
      }
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const server: Server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) socket.write(handle(line) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  server.listen(path, () => {
    // The container runs as a different uid; the socket must be writable by it.
    // The directory itself is not exposed, only this one socket per bot.
    try {
      chmodSync(path, 0o666);
    } catch {}
  });
  server.on("error", () => {});

  return {
    path,
    close: () => {
      try {
        server.close();
      } catch {}
      rmSync(path, { force: true });
    },
  };
}
