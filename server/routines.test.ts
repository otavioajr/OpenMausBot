// Routine policy tests: the missed-run rule the product promises, plus the
// store invariants that keep a routine from firing twice or drifting.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store writes next to the app data dir; point it at a scratch dir.
const scratch = mkdtempSync(join(tmpdir(), "omb-routines-"));
vi.mock("./config.ts", async () => {
  const actual = await vi.importActual<typeof import("./config.ts")>("./config.ts");
  return { ...actual, DATA_DIR: scratch };
});

const { RoutineStore, dueRoutines, MISSED_AFTER_MS, formatInstant } = await import("./routines.ts");
const { zonedTimeToInstant } = await import("./schedule.ts");

const SP = "America/Sao_Paulo";

describe("RoutineStore", () => {
  let store: InstanceType<typeof RoutineStore>;
  const now = zonedTimeToInstant(SP, 2026, 8, 12, 21, 0);

  beforeEach(() => {
    rmSync(join(scratch, "routines.json"), { force: true });
    store = new RoutineStore();
  });

  afterEach(() => {
    rmSync(join(scratch, "routines.json"), { force: true });
  });

  const daily = (over: Partial<Parameters<typeof store.create>[0]> = {}) =>
    store.create(
      {
        botId: "bot-1",
        instruction: "check the inbox",
        trigger: { type: "daily", time: "09:00" },
        timezone: SP,
        ...over,
      },
      now,
    );

  it("creates a routine with a computed next run and a readable default name", () => {
    const routine = daily();
    expect(routine.enabled).toBe(true);
    expect(routine.name).toBe(`Every day at 09:00 (${SP})`);
    expect(routine.nextRunAt).toBe(zonedTimeToInstant(SP, 2026, 8, 13, 9, 0));
    expect(routine.runs).toEqual([]);
  });

  it("rejects an invalid trigger and an empty instruction", () => {
    expect(() => daily({ trigger: { type: "daily", time: "9am" } })).toThrow(/09:00/);
    expect(() => daily({ instruction: "   " })).toThrow(/instruction/);
  });

  it("persists across instances (survives a restart)", () => {
    const created = daily();
    const reopened = new RoutineStore();
    expect(reopened.get(created.id)?.instruction).toBe("check the inbox");
  });

  it("clears the next run when disabled and recomputes when re-enabled", () => {
    const routine = daily();
    const paused = store.update(routine.id, { enabled: false }, now)!;
    expect(paused.nextRunAt).toBeNull();

    const later = now + 20 * 60 * 60_000; // next day, 17:00 local
    const resumed = store.update(routine.id, { enabled: true }, later)!;
    expect(resumed.nextRunAt).toBe(zonedTimeToInstant(SP, 2026, 8, 14, 9, 0));
  });

  it("never leaves a stale due time after retiming (no instant re-fire)", () => {
    const routine = daily();
    const tomorrowEvening = zonedTimeToInstant(SP, 2026, 8, 13, 20, 0);
    const updated = store.update(routine.id, { trigger: { type: "daily", time: "07:00" } }, tomorrowEvening)!;
    expect(updated.nextRunAt!).toBeGreaterThan(tomorrowEvening);
    expect(updated.nextRunAt).toBe(zonedTimeToInstant(SP, 2026, 8, 14, 7, 0));
  });

  it("rolls the schedule forward after a run and keeps bounded history", () => {
    const routine = daily();
    const firedAt = zonedTimeToInstant(SP, 2026, 8, 13, 9, 0);
    const after = store.recordRun(routine.id, { at: firedAt, outcome: "ok", scheduledFor: firedAt }, firedAt)!;
    expect(after.lastRunAt).toBe(firedAt);
    expect(after.nextRunAt).toBe(zonedTimeToInstant(SP, 2026, 8, 14, 9, 0));

    for (let i = 0; i < 30; i++) {
      store.recordRun(routine.id, { at: firedAt + i, outcome: "ok" }, firedAt);
    }
    expect(store.get(routine.id)!.runs.length).toBeLessThanOrEqual(20);
    expect(store.get(routine.id)!.runs[0].at).toBe(firedAt + 29); // newest first
  });

  it("removes routines with their bot", () => {
    daily();
    daily({ botId: "bot-2" });
    store.removeForBot("bot-1");
    expect(store.all().map((r) => r.botId)).toEqual(["bot-2"]);
  });
});

describe("dueRoutines", () => {
  const base = {
    id: "r1",
    botId: "b1",
    name: "n",
    instruction: "do it",
    trigger: { type: "daily" as const, time: "09:00" },
    timezone: SP,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    lastRunAt: null,
    runs: [],
  };
  const now = 1_000_000_000_000;

  it("ignores routines that are not due yet", () => {
    expect(dueRoutines([{ ...base, nextRunAt: now + 60_000 }], now)).toEqual([]);
  });

  it("ignores disabled routines even when their time has passed", () => {
    expect(dueRoutines([{ ...base, enabled: false, nextRunAt: now - 60_000 }], now)).toEqual([]);
  });

  it("runs a routine that just came due", () => {
    const [decision] = dueRoutines([{ ...base, nextRunAt: now - 1_000 }], now);
    expect(decision.action).toBe("run");
  });

  it("still runs a slightly late tick rather than dropping it", () => {
    const [decision] = dueRoutines([{ ...base, nextRunAt: now - 60_000 }], now);
    expect(decision.action).toBe("run");
  });

  it("marks an occurrence missed when the host was down too long", () => {
    const [decision] = dueRoutines([{ ...base, nextRunAt: now - MISSED_AFTER_MS - 60_000 }], now);
    expect(decision.action).toBe("missed");
    expect(decision.scheduledFor).toBe(now - MISSED_AFTER_MS - 60_000);
  });
});

describe("formatInstant", () => {
  it("renders in the routine's own timezone", () => {
    const at = zonedTimeToInstant(SP, 2026, 8, 13, 9, 0);
    expect(formatInstant(at, SP)).toBe("2026-08-13 09:00");
    expect(formatInstant(at, "UTC")).toBe("2026-08-13 12:00");
  });
});
