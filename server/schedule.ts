// Schedule maths for routines. Pure functions, no I/O, no globals — so the
// tricky parts (timezones, DST, month lengths) are unit-testable.
//
// Every trigger resolves to "the next instant at or after `from`". The caller
// stores that instant and compares it against the wall clock; nothing here
// knows about bots, containers or persistence.
//
// Timezone handling uses the platform's own IANA database via Intl, so a
// downloaded copy works anywhere without shipping a tz table or hardcoding
// the author's own zone.

export type Trigger =
  | { type: "hourly"; minute: number }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  | { type: "weekly"; weekday: number; time: string }
  | { type: "monthly"; day: number; time: string }
  | { type: "interval"; minutes: number }
  | { type: "cron"; expression: string };

export interface ScheduleOptions {
  /** IANA zone, e.g. "America/Sao_Paulo". Defaults to the host zone. */
  timezone?: string;
  /** Anchor for interval triggers (creation time or last run). */
  anchor?: number;
}

const MINUTE = 60_000;
// A leap-day cron ("0 12 29 2 *") can be almost four years out, so the horizon
// must clear that; anything beyond it is genuinely unsatisfiable.
const MAX_HORIZON_DAYS = 366 * 4 + 2;

export function hostTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0=Sunday
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    partsCache.set(timezone, fmt);
  }
  return fmt;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant, as seen in `timezone`. */
export function partsIn(at: number, timezone: string): Parts {
  const parsed: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(new Date(at))) {
    if (part.type !== "literal") parsed[part.type] = part.value;
  }
  return {
    year: Number(parsed.year),
    month: Number(parsed.month),
    day: Number(parsed.day),
    hour: Number(parsed.hour),
    minute: Number(parsed.minute),
    weekday: WEEKDAYS[parsed.weekday] ?? 0,
  };
}

/** Offset (ms) that `timezone` is ahead of UTC at a given instant. */
function offsetAt(at: number, timezone: string): number {
  const p = partsIn(at, timezone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Instants are whole minutes here; drop seconds so the fixpoint is stable.
  return asUtc - Math.floor(at / MINUTE) * MINUTE;
}

/**
 * Convert a wall-clock time in `timezone` to an absolute instant.
 *
 * Two passes settle the offset (the naive guess can land on the wrong side of
 * a DST boundary). Times skipped by a spring-forward transition resolve to the
 * first valid instant after the gap rather than silently jumping an hour.
 */
export function zonedTimeToInstant(
  timezone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target - offsetAt(target, timezone);
  for (let i = 0; i < 2; i++) {
    const next = target - offsetAt(guess, timezone);
    if (next === guess) break;
    guess = next;
  }
  // Verify: during a DST gap the requested wall time does not exist.
  const check = partsIn(guess, timezone);
  if (check.hour !== hour || check.minute !== minute) {
    // Walk forward to the first minute that lands after the requested time.
    const wanted = hour * 60 + minute;
    for (let step = 1; step <= 180; step++) {
      const probe = guess + step * MINUTE;
      const p = partsIn(probe, timezone);
      if (p.day === day && p.hour * 60 + p.minute >= wanted) return probe;
      if (p.day !== day) break;
    }
  }
  return guess;
}

/** Parse "HH:MM" into minutes since midnight; null when malformed. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** Cron semantics: when both day fields are restricted, either may match. */
  dayUnion: boolean;
}

function parseField(field: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const chunk of field.split(",")) {
    const [range, stepRaw] = chunk.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${name}: "${chunk}"`);
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`invalid ${name}: "${chunk}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty ${name}`);
  return out;
}

/** Standard 5-field cron: minute hour day-of-month month day-of-week. */
export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron needs 5 fields: minute hour day month weekday");
  const daysOfWeek = parseField(fields[4], 0, 7, "weekday");
  if (daysOfWeek.delete(7)) daysOfWeek.add(0); // both spellings of Sunday
  return {
    minutes: parseField(fields[0], 0, 59, "minute"),
    hours: parseField(fields[1], 0, 23, "hour"),
    daysOfMonth: parseField(fields[2], 1, 31, "day"),
    months: parseField(fields[3], 1, 12, "month"),
    daysOfWeek,
    dayUnion: fields[2] !== "*" && fields[4] !== "*",
  };
}

/** Validate a trigger, returning a human-readable problem or null. */
export function validateTrigger(trigger: Trigger): string | null {
  switch (trigger.type) {
    case "hourly":
      return Number.isInteger(trigger.minute) && trigger.minute >= 0 && trigger.minute <= 59
        ? null
        : "minute must be between 0 and 59";
    case "daily":
    case "weekdays":
      return parseTimeOfDay(trigger.time) ? null : "time must look like 09:00";
    case "weekly":
      if (!parseTimeOfDay(trigger.time)) return "time must look like 09:00";
      return Number.isInteger(trigger.weekday) && trigger.weekday >= 0 && trigger.weekday <= 6
        ? null
        : "weekday must be between 0 (Sunday) and 6";
    case "monthly":
      if (!parseTimeOfDay(trigger.time)) return "time must look like 09:00";
      return Number.isInteger(trigger.day) && trigger.day >= 1 && trigger.day <= 31
        ? null
        : "day must be between 1 and 31";
    case "interval":
      return Number.isInteger(trigger.minutes) && trigger.minutes >= 1
        ? null
        : "interval must be at least 1 minute";
    case "cron":
      try {
        parseCron(trigger.expression);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : "invalid cron expression";
      }
    default:
      return "unknown trigger type";
  }
}

function dayMatches(fields: CronFields, p: Parts): boolean {
  const dom = fields.daysOfMonth.has(p.day);
  const dow = fields.daysOfWeek.has(p.weekday);
  if (!fields.months.has(p.month)) return false;
  return fields.dayUnion ? dom || dow : dom && dow;
}

/** Days in a calendar month, honouring leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Next fire time at or after `from` (exclusive of `from` itself, so a routine
 * that just ran does not immediately re-fire). Returns null when nothing
 * matches inside the horizon — a cron like "0 0 30 2 *" has no valid date.
 */
export function nextRunAt(trigger: Trigger, from: number, options: ScheduleOptions = {}): number | null {
  const timezone = options.timezone || hostTimezone();
  const after = Math.floor(from / MINUTE) * MINUTE + MINUTE;

  if (trigger.type === "interval") {
    const step = trigger.minutes * MINUTE;
    const anchor = options.anchor ?? from;
    if (anchor > from) return anchor;
    const elapsed = from - anchor;
    return anchor + (Math.floor(elapsed / step) + 1) * step;
  }

  if (trigger.type === "hourly") {
    const p = partsIn(after, timezone);
    for (let hours = 0; hours <= 48; hours++) {
      const base = zonedTimeToInstant(timezone, p.year, p.month, p.day, p.hour, trigger.minute);
      const candidate = base + hours * 60 * MINUTE;
      if (candidate >= after) return candidate;
    }
    return null;
  }

  const fields = asCronFields(trigger);
  if (!fields) return null;

  let cursor = partsIn(after, timezone);
  for (let dayOffset = 0; dayOffset <= MAX_HORIZON_DAYS; dayOffset++) {
    if (dayMatches(fields, cursor)) {
      for (const hour of [...fields.hours].sort((a, b) => a - b)) {
        for (const minute of [...fields.minutes].sort((a, b) => a - b)) {
          const candidate = zonedTimeToInstant(timezone, cursor.year, cursor.month, cursor.day, hour, minute);
          if (candidate >= after) return candidate;
        }
      }
    }
    // Step to the next local day at noon (safe from DST edges), then re-read.
    const noon = zonedTimeToInstant(timezone, cursor.year, cursor.month, cursor.day, 12, 0);
    cursor = partsIn(noon + 24 * 60 * MINUTE, timezone);
  }
  return null;
}

function asCronFields(trigger: Trigger): CronFields | null {
  const all = (min: number, max: number) => {
    const set = new Set<number>();
    for (let v = min; v <= max; v++) set.add(v);
    return set;
  };
  const base = {
    daysOfMonth: all(1, 31),
    months: all(1, 12),
    daysOfWeek: all(0, 6),
    dayUnion: false,
  };
  switch (trigger.type) {
    case "daily": {
      const t = parseTimeOfDay(trigger.time);
      if (!t) return null;
      return { ...base, minutes: new Set([t.minute]), hours: new Set([t.hour]) };
    }
    case "weekdays": {
      const t = parseTimeOfDay(trigger.time);
      if (!t) return null;
      return { ...base, minutes: new Set([t.minute]), hours: new Set([t.hour]), daysOfWeek: new Set([1, 2, 3, 4, 5]) };
    }
    case "weekly": {
      const t = parseTimeOfDay(trigger.time);
      if (!t) return null;
      return {
        ...base,
        minutes: new Set([t.minute]),
        hours: new Set([t.hour]),
        daysOfWeek: new Set([trigger.weekday]),
      };
    }
    case "monthly": {
      const t = parseTimeOfDay(trigger.time);
      if (!t) return null;
      return { ...base, minutes: new Set([t.minute]), hours: new Set([t.hour]), daysOfMonth: new Set([trigger.day]) };
    }
    case "cron":
      try {
        return parseCron(trigger.expression);
      } catch {
        return null;
      }
    default:
      return null;
  }
}

/** Clamp a monthly day to the month's real length (31st in a 30-day month). */
export function clampDayToMonth(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

/** Short human description, used in the UI and in chat replies. */
export function describeTrigger(trigger: Trigger, timezone?: string): string {
  const zone = timezone ? ` (${timezone})` : "";
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  switch (trigger.type) {
    case "hourly":
      return `every hour at :${String(trigger.minute).padStart(2, "0")}`;
    case "daily":
      return `every day at ${trigger.time}${zone}`;
    case "weekdays":
      return `weekdays at ${trigger.time}${zone}`;
    case "weekly":
      return `every ${days[trigger.weekday]} at ${trigger.time}${zone}`;
    case "monthly":
      return `day ${trigger.day} of each month at ${trigger.time}${zone}`;
    case "interval": {
      const m = trigger.minutes;
      if (m % 1440 === 0) return `every ${m / 1440} day(s)`;
      if (m % 60 === 0) return `every ${m / 60} hour(s)`;
      return `every ${m} minute(s)`;
    }
    case "cron":
      return `cron: ${trigger.expression}${zone}`;
    default:
      return "unknown schedule";
  }
}
