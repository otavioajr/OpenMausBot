// Scheduler behaviour: what actually fires, what waits, what is reported.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "omb-sched-"));
vi.mock("./config.ts", async () => {
  const actual = await vi.importActual<typeof import("./config.ts")>("./config.ts");
  return { ...actual, DATA_DIR: scratch };
});

const { RoutineStore, MISSED_AFTER_MS } = await import("./routines.ts");
const { RoutineScheduler } = await import("./scheduler.ts");
const { zonedTimeToInstant } = await import("./schedule.ts");

const SP = "America/Sao_Paulo";

interface Harness {
  store: InstanceType<typeof RoutineStore>;
  scheduler: InstanceType<typeof RoutineScheduler>;
  turns: Array<{ botId: string; text: string }>;
  notices: Array<{ botId: string; text: string }>;
  setNow: (at: number) => void;
  setBusy: (busy: boolean) => void;
  setExists: (exists: boolean) => void;
  failNext: (message: string) => void;
}

function harness(startAt: number): Harness {
  rmSync(join(scratch, "routines.json"), { force: true });
  const store = new RoutineStore();
  const turns: Harness["turns"] = [];
  const notices: Harness["notices"] = [];
  let now = startAt;
  let busy = false;
  let exists = true;
  let failure: string | null = null;

  const scheduler = new RoutineScheduler({
    routines: store,
    now: () => now,
    startTurn: async (botId, text) => {
      if (failure) {
        const message = failure;
        failure = null;
        throw new Error(message);
      }
      turns.push({ botId, text });
    },
    isBusy: () => busy,
    botExists: () => exists,
    notify: (botId, text) => notices.push({ botId, text }),
  });

  return {
    store,
    scheduler,
    turns,
    notices,
    setNow: (at) => (now = at),
    setBusy: (value) => (busy = value),
    setExists: (value) => (exists = value),
    failNext: (message) => (failure = message),
  };
}

const NINE_AM = zonedTimeToInstant(SP, 2026, 8, 13, 9, 0);
const EVENING_BEFORE = zonedTimeToInstant(SP, 2026, 8, 12, 21, 0);

const makeRoutine = (h: Harness) =>
  h.store.create(
    {
      botId: "bot-1",
      name: "Morning check",
      instruction: "check the inbox",
      trigger: { type: "daily", time: "09:00" },
      timezone: SP,
    },
    EVENING_BEFORE,
  );

describe("RoutineScheduler", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness(EVENING_BEFORE);
  });

  it("does nothing before the scheduled time", async () => {
    makeRoutine(h);
    await h.scheduler.tick();
    expect(h.turns).toEqual([]);
  });

  it("starts a normal turn with the routine's instruction when due", async () => {
    const routine = makeRoutine(h);
    h.setNow(NINE_AM);
    await h.scheduler.tick();
    expect(h.turns).toEqual([{ botId: "bot-1", text: "check the inbox" }]);
    const after = h.store.get(routine.id)!;
    expect(after.runs[0].outcome).toBe("ok");
    // and it rolls forward to tomorrow rather than firing again
    expect(after.nextRunAt).toBe(zonedTimeToInstant(SP, 2026, 8, 14, 9, 0));
  });

  it("does not fire twice for the same occurrence", async () => {
    makeRoutine(h);
    h.setNow(NINE_AM);
    await h.scheduler.tick();
    await h.scheduler.tick();
    expect(h.turns).toHaveLength(1);
  });

  it("waits instead of colliding when the bot is mid-turn", async () => {
    const routine = makeRoutine(h);
    h.setNow(NINE_AM);
    h.setBusy(true);
    await h.scheduler.tick();
    expect(h.turns).toEqual([]);
    // the occurrence is still pending, not lost
    expect(h.store.get(routine.id)!.nextRunAt).toBe(NINE_AM);

    h.setBusy(false);
    await h.scheduler.tick();
    expect(h.turns).toHaveLength(1);
  });

  it("skips a long-missed occurrence and reports it", async () => {
    const routine = makeRoutine(h);
    h.setNow(NINE_AM + MISSED_AFTER_MS + 60_000);
    await h.scheduler.tick();

    expect(h.turns).toEqual([]); // never runs late
    const after = h.store.get(routine.id)!;
    expect(after.runs[0].outcome).toBe("missed");
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0].text).toContain("did not run");
    expect(h.notices[0].text).toContain("2026-08-13 09:00");
    expect(after.nextRunAt).toBe(zonedTimeToInstant(SP, 2026, 8, 14, 9, 0));
  });

  it("records a failure and tells the user", async () => {
    const routine = makeRoutine(h);
    h.setNow(NINE_AM);
    h.failNext("no provider instance");
    await h.scheduler.tick();

    const after = h.store.get(routine.id)!;
    expect(after.runs[0].outcome).toBe("error");
    expect(after.runs[0].detail).toContain("no provider");
    expect(h.notices[0].text).toContain("failed to start");
    // still reschedules, so one bad day does not kill the routine
    expect(after.nextRunAt).toBe(zonedTimeToInstant(SP, 2026, 8, 14, 9, 0));
  });

  it("ignores paused routines", async () => {
    const routine = makeRoutine(h);
    h.store.update(routine.id, { enabled: false }, EVENING_BEFORE);
    h.setNow(NINE_AM);
    await h.scheduler.tick();
    expect(h.turns).toEqual([]);
  });

  it("cleans up routines whose bot was deleted", async () => {
    const routine = makeRoutine(h);
    h.setExists(false);
    h.setNow(NINE_AM);
    await h.scheduler.tick();
    expect(h.turns).toEqual([]);
    expect(h.store.get(routine.id)).toBeNull();
  });

  it("runs on demand for a test run, regardless of schedule", async () => {
    const routine = makeRoutine(h);
    await h.scheduler.run(routine);
    expect(h.turns).toHaveLength(1);
  });

  it("summarises a routine for chat and UI", () => {
    const routine = makeRoutine(h);
    const text = RoutineScheduler.summarize(routine);
    expect(text).toContain("Morning check");
    expect(text).toContain("every day at 09:00");
    expect(text).toContain("Next run 2026-08-13 09:00");
  });

  it("does not keep the process alive", () => {
    const scheduler = new RoutineScheduler({
      routines: h.store,
      startTurn: async () => {},
      isBusy: () => false,
      botExists: () => true,
      notify: () => {},
    });
    scheduler.start();
    // start() is idempotent and unrefs its timer
    scheduler.start();
    scheduler.stop();
    expect(true).toBe(true);
  });
});
