// Schedule maths tests. These pin the behaviour that is easy to get wrong and
// impossible to notice in manual testing: DST transitions, month lengths,
// timezone-relative wall clocks, and cron's day-field union rule.
import { describe, expect, it } from "vitest";

import {
  clampDayToMonth,
  describeTrigger,
  nextRunAt,
  parseCron,
  parseTimeOfDay,
  partsIn,
  validateTrigger,
  zonedTimeToInstant,
  type Trigger,
} from "./schedule.ts";

const SP = "America/Sao_Paulo";
const NY = "America/New_York";

/** Wall-clock string in a zone, for readable assertions. */
const wall = (at: number, timezone: string) => {
  const p = partsIn(at, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe("time parsing", () => {
  it("accepts HH:MM and rejects nonsense", () => {
    expect(parseTimeOfDay("09:00")).toEqual({ hour: 9, minute: 0 });
    expect(parseTimeOfDay("9:05")).toEqual({ hour: 9, minute: 5 });
    expect(parseTimeOfDay("23:59")).toEqual({ hour: 23, minute: 59 });
    for (const bad of ["24:00", "12:60", "12", "abc", "", "12:5"]) {
      expect(parseTimeOfDay(bad)).toBeNull();
    }
  });
});

describe("zoned wall clock", () => {
  it("resolves a wall time to the right instant in a negative-offset zone", () => {
    const at = zonedTimeToInstant(SP, 2026, 3, 10, 9, 0);
    expect(wall(at, SP)).toBe("2026-03-10 09:00");
    expect(new Date(at).toISOString()).toBe("2026-03-10T12:00:00.000Z");
  });

  it("survives a DST spring-forward in a zone that observes it", () => {
    // US DST 2026 starts Sunday 8 March: 02:00 -> 03:00 local.
    const exists = zonedTimeToInstant(NY, 2026, 3, 8, 1, 30);
    expect(wall(exists, NY)).toBe("2026-03-08 01:30");
    // 02:30 does not exist; it must not silently resolve to 01:30 or jump a day.
    const skipped = zonedTimeToInstant(NY, 2026, 3, 8, 2, 30);
    const p = partsIn(skipped, NY);
    expect(p.day).toBe(8);
    expect(p.hour).toBe(3);
  });

  it("resolves the repeated hour of a fall-back without moving days", () => {
    // US DST 2026 ends Sunday 1 November.
    const at = zonedTimeToInstant(NY, 2026, 11, 1, 1, 30);
    const p = partsIn(at, NY);
    expect(p.day).toBe(1);
    expect(p.hour).toBe(1);
    expect(p.minute).toBe(30);
  });
});

describe("nextRunAt", () => {
  const from = zonedTimeToInstant(SP, 2026, 8, 12, 21, 45); // Wednesday

  it("never returns the current minute (no double fire)", () => {
    const trigger: Trigger = { type: "interval", minutes: 30 };
    const next = nextRunAt(trigger, from, { timezone: SP, anchor: from })!;
    expect(next).toBeGreaterThan(from);
  });

  it("daily rolls to tomorrow once today's time has passed", () => {
    const next = nextRunAt({ type: "daily", time: "09:00" }, from, { timezone: SP })!;
    expect(wall(next, SP)).toBe("2026-08-13 09:00");
  });

  it("daily fires later the same day when the time is still ahead", () => {
    const morning = zonedTimeToInstant(SP, 2026, 8, 12, 7, 0);
    const next = nextRunAt({ type: "daily", time: "09:00" }, morning, { timezone: SP })!;
    expect(wall(next, SP)).toBe("2026-08-12 09:00");
  });

  it("weekdays skips the weekend", () => {
    const friday = zonedTimeToInstant(SP, 2026, 8, 14, 18, 0);
    const next = nextRunAt({ type: "weekdays", time: "09:00" }, friday, { timezone: SP })!;
    expect(wall(next, SP)).toBe("2026-08-17 09:00"); // Monday
  });

  it("weekly picks the requested weekday", () => {
    const next = nextRunAt({ type: "weekly", weekday: 1, time: "08:30" }, from, { timezone: SP })!;
    expect(wall(next, SP)).toBe("2026-08-17 08:30");
  });

  it("monthly handles a day that does not exist in the next month", () => {
    const jan31 = zonedTimeToInstant(SP, 2026, 1, 31, 12, 0);
    const next = nextRunAt({ type: "monthly", day: 31, time: "10:00" }, jan31, { timezone: SP })!;
    // February has no 31st, so the next valid 31st is in March.
    expect(wall(next, SP)).toBe("2026-03-31 10:00");
  });

  it("hourly fires at the requested minute of the next hour", () => {
    const next = nextRunAt({ type: "hourly", minute: 15 }, from, { timezone: SP })!;
    expect(wall(next, SP)).toBe("2026-08-12 22:15");
  });

  it("interval walks forward from its anchor, not from now", () => {
    const anchor = zonedTimeToInstant(SP, 2026, 8, 12, 20, 0);
    const next = nextRunAt({ type: "interval", minutes: 120 }, from, { timezone: SP, anchor })!;
    expect(wall(next, SP)).toBe("2026-08-12 22:00");
  });

  it("interval in the future waits for its anchor", () => {
    const anchor = zonedTimeToInstant(SP, 2026, 8, 13, 6, 0);
    const next = nextRunAt({ type: "interval", minutes: 60 }, from, { timezone: SP, anchor })!;
    expect(next).toBe(anchor);
  });

  it("respects the routine's timezone rather than the host's", () => {
    const trigger: Trigger = { type: "daily", time: "09:00" };
    const sp = nextRunAt(trigger, from, { timezone: SP })!;
    const ny = nextRunAt(trigger, from, { timezone: NY })!;
    expect(sp).not.toBe(ny);
    expect(wall(sp, SP)).toBe("2026-08-13 09:00");
    expect(wall(ny, NY)).toBe("2026-08-13 09:00");
  });

  it("keeps a daily time stable across a DST change", () => {
    const before = zonedTimeToInstant(NY, 2026, 3, 6, 12, 0);
    let cursor = before;
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      cursor = nextRunAt({ type: "daily", time: "09:00" }, cursor, { timezone: NY })!;
      seen.push(wall(cursor, NY));
    }
    expect(seen).toEqual(["2026-03-07 09:00", "2026-03-08 09:00", "2026-03-09 09:00", "2026-03-10 09:00"]);
  });

  it("supports cron expressions", () => {
    const next = nextRunAt({ type: "cron", expression: "30 6 * * 1-5" }, from, { timezone: SP })!;
    expect(wall(next, SP)).toBe("2026-08-13 06:30");
  });

  it("returns null for a cron date that can never happen", () => {
    expect(nextRunAt({ type: "cron", expression: "0 0 30 2 *" }, from, { timezone: SP })).toBeNull();
  });

  it("handles leap-day cron across years", () => {
    const at = zonedTimeToInstant(SP, 2026, 3, 1, 0, 0);
    const next = nextRunAt({ type: "cron", expression: "0 12 29 2 *" }, at, { timezone: SP })!;
    expect(wall(next, SP)).toBe("2028-02-29 12:00");
  });
});

describe("cron parsing", () => {
  it("expands lists, ranges and steps", () => {
    const fields = parseCron("0,30 9-11 * * *");
    expect([...fields.minutes]).toEqual([0, 30]);
    expect([...fields.hours]).toEqual([9, 10, 11]);
    const every15 = parseCron("*/15 * * * *");
    expect([...every15.minutes]).toEqual([0, 15, 30, 45]);
  });

  it("treats weekday 7 as Sunday", () => {
    expect(parseCron("0 0 * * 7").daysOfWeek.has(0)).toBe(true);
  });

  it("unions the day fields when both are restricted", () => {
    expect(parseCron("0 0 1 * 1").dayUnion).toBe(true);
    expect(parseCron("0 0 1 * *").dayUnion).toBe(false);
  });

  it("rejects malformed expressions", () => {
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "abc * * * *", "*/0 * * * *"]) {
      expect(() => parseCron(bad)).toThrow();
    }
  });
});

describe("validateTrigger", () => {
  it("accepts well-formed triggers", () => {
    const good: Trigger[] = [
      { type: "hourly", minute: 0 },
      { type: "daily", time: "09:00" },
      { type: "weekdays", time: "18:30" },
      { type: "weekly", weekday: 0, time: "10:00" },
      { type: "monthly", day: 1, time: "00:00" },
      { type: "interval", minutes: 15 },
      { type: "cron", expression: "0 9 * * *" },
    ];
    for (const trigger of good) expect(validateTrigger(trigger)).toBeNull();
  });

  it("explains what is wrong", () => {
    expect(validateTrigger({ type: "daily", time: "9am" })).toMatch(/09:00/);
    expect(validateTrigger({ type: "interval", minutes: 0 })).toMatch(/at least/);
    expect(validateTrigger({ type: "monthly", day: 32, time: "09:00" })).toMatch(/1 and 31/);
    expect(validateTrigger({ type: "cron", expression: "nope" })).toBeTruthy();
  });
});

describe("helpers", () => {
  it("clamps a day to the month length", () => {
    expect(clampDayToMonth(2026, 2, 31)).toBe(28);
    expect(clampDayToMonth(2028, 2, 31)).toBe(29); // leap year
    expect(clampDayToMonth(2026, 4, 31)).toBe(30);
    expect(clampDayToMonth(2026, 1, 15)).toBe(15);
  });

  it("describes triggers for humans", () => {
    expect(describeTrigger({ type: "daily", time: "09:00" }, SP)).toBe(`every day at 09:00 (${SP})`);
    expect(describeTrigger({ type: "interval", minutes: 120 })).toBe("every 2 hour(s)");
    expect(describeTrigger({ type: "interval", minutes: 1440 })).toBe("every 1 day(s)");
    expect(describeTrigger({ type: "weekdays", time: "07:30" })).toBe("weekdays at 07:30");
  });
});
