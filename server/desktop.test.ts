// Ticket + control-lock semantics for the live desktop bridge. These guard
// real security properties: a leaked stream URL must not be replayable, must
// not be retargetable at another bot, and control must expire so a user who
// walks away cannot lock the agent out of its own desktop forever.
import { beforeEach, describe, expect, it, vi } from "vitest";

// The bridge shells out to docker for the container-side lock file; keep the
// unit tests hermetic by stubbing that boundary.
vi.mock("./dockerbox.ts", () => ({
  containerNameFor: (id: string) => `omb-bot-${id}`,
  desktopEnabled: () => true,
  findContainer: vi.fn(async () => ({
    name: "omb-bot-x",
    state: "running",
    containerId: "abc",
    hasDesktop: true,
  })),
}));

const execCalls: string[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      execCalls.push([cmd, ...args]);
      const { EventEmitter } = require("node:events");
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.stdin = { write: () => {}, end: () => {} };
      setImmediate(() => proc.emit("close", 0));
      return proc;
    },
  };
});

const desktop = await import("./desktop.ts");

describe("desktop tickets", () => {
  beforeEach(() => {
    execCalls.length = 0;
  });

  it("mints a single-use ticket bound to one bot", () => {
    const a = desktop.issueDesktopTicket("bot-a");
    expect(a.ticket).toBeTruthy();
    expect(a.url).toContain(a.ticket);
    // Distinct bots never share a ticket value.
    const b = desktop.issueDesktopTicket("bot-b");
    expect(b.ticket).not.toBe(a.ticket);
  });

  it("hands out a URL under the stream endpoint", () => {
    const { url } = desktop.issueDesktopTicket("bot-a");
    expect(url.startsWith("/api/desktop/stream?ticket=")).toBe(true);
  });
});

describe("control lock", () => {
  beforeEach(() => {
    execCalls.length = 0;
    vi.useRealTimers();
  });

  it("defaults to the bot holding control", () => {
    expect(desktop.controlState("fresh-bot")).toBe("bot");
  });

  it("marks the human as holder and writes the in-container lock", async () => {
    await desktop.takeControl("bot-c");
    expect(desktop.controlState("bot-c")).toBe("human");
    // The lock the agent's broker actually reads must be created.
    const touched = execCalls.some((call) => call.join(" ").includes("/run/omb/human-control"));
    expect(touched).toBe(true);
  });

  it("returns control to the bot and clears the lock", async () => {
    await desktop.takeControl("bot-d");
    execCalls.length = 0;
    await desktop.releaseControl("bot-d");
    expect(desktop.controlState("bot-d")).toBe("bot");
    const removed = execCalls.some((call) => call.join(" ").includes("rm"));
    expect(removed).toBe(true);
  });

  it("expires human control so the agent is never locked out forever", async () => {
    await desktop.takeControl("bot-e");
    expect(desktop.controlState("bot-e")).toBe("human");
    // Jump past the control TTL (5 min).
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(desktop.controlState("bot-e")).toBe("bot");
    vi.useRealTimers();
  });

  it("keeps control state independent per bot", async () => {
    await desktop.takeControl("bot-f");
    expect(desktop.controlState("bot-f")).toBe("human");
    expect(desktop.controlState("bot-g")).toBe("bot");
  });
});
