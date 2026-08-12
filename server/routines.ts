// Routines: recurring tasks a bot runs on a schedule.
//
// Design notes for anyone self-hosting this:
//   - persistence is a plain JSON file next to bots.json, so a routine survives
//     restarts, upgrades and moving the install to another machine
//   - the scheduler owns no bot logic: it calls back into the harness to start
//     an ordinary turn, so approvals, tools, transcripts and the isolated
//     desktop lifecycle all behave exactly as a typed message would
//   - a missed occurrence (host was down / asleep) is NOT run late. It is
//     recorded as "missed" and reported, because a stale routine firing hours
//     later is usually worse than not firing.
//   - every timestamp is absolute (epoch ms); the wall-clock interpretation
//     lives in the routine's own timezone field, defaulting to the host zone.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { newId } from "./contracts.ts";
import { describeTrigger, hostTimezone, nextRunAt, validateTrigger, type Trigger } from "./schedule.ts";

export type RunOutcome = "ok" | "error" | "missed" | "skipped";

export interface RoutineRun {
  at: number;
  outcome: RunOutcome;
  detail?: string;
  /** Scheduled instant this run belongs to, for missed-run reporting. */
  scheduledFor?: number;
}

export interface Routine {
  id: string;
  botId: string;
  name: string;
  instruction: string;
  trigger: Trigger;
  timezone: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runs: RoutineRun[];
}

export interface RoutineInput {
  botId: string;
  name?: string;
  instruction: string;
  trigger: Trigger;
  timezone?: string;
  enabled?: boolean;
}

const FILE = join(DATA_DIR, "routines.json");
const MAX_RUNS = 20;
/** Fire anything due within this slack of the tick, so a late tick still runs. */
const DUE_SLACK_MS = 30_000;
/** Beyond this, an occurrence is treated as missed rather than run late. */
export const MISSED_AFTER_MS = 10 * 60_000;

export class RoutineStore {
  private routines: Routine[] = [];

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    try {
      const parsed = JSON.parse(readFileSync(FILE, "utf8"));
      if (Array.isArray(parsed)) this.routines = parsed;
    } catch {
      /* first run */
    }
  }

  private save() {
    writeFileSync(FILE, JSON.stringify(this.routines, null, 2));
  }

  all(): Routine[] {
    return this.routines;
  }

  forBot(botId: string): Routine[] {
    return this.routines.filter((r) => r.botId === botId);
  }

  get(id: string): Routine | null {
    return this.routines.find((r) => r.id === id) ?? null;
  }

  create(input: RoutineInput, now = Date.now()): Routine {
    const problem = validateTrigger(input.trigger);
    if (problem) throw Object.assign(new Error(problem), { status: 400 });
    const instruction = input.instruction.trim();
    if (!instruction) throw Object.assign(new Error("instruction is required"), { status: 400 });

    const timezone = input.timezone || hostTimezone();
    const enabled = input.enabled ?? true;
    const routine: Routine = {
      id: newId(),
      botId: input.botId,
      name: (input.name ?? "").trim() || defaultName(input.trigger, timezone),
      instruction,
      trigger: input.trigger,
      timezone,
      enabled,
      createdAt: now,
      updatedAt: now,
      nextRunAt: enabled ? nextRunAt(input.trigger, now, { timezone, anchor: now }) : null,
      lastRunAt: null,
      runs: [],
    };
    this.routines.push(routine);
    this.save();
    return routine;
  }

  update(id: string, patch: Partial<RoutineInput>, now = Date.now()): Routine | null {
    const routine = this.get(id);
    if (!routine) return null;
    if (patch.trigger) {
      const problem = validateTrigger(patch.trigger);
      if (problem) throw Object.assign(new Error(problem), { status: 400 });
      routine.trigger = patch.trigger;
    }
    if (patch.instruction !== undefined) {
      const instruction = patch.instruction.trim();
      if (!instruction) throw Object.assign(new Error("instruction is required"), { status: 400 });
      routine.instruction = instruction;
    }
    if (patch.name !== undefined) routine.name = patch.name.trim() || routine.name;
    if (patch.timezone) routine.timezone = patch.timezone;
    if (patch.enabled !== undefined) routine.enabled = patch.enabled;

    routine.updatedAt = now;
    // Recompute from now: a re-enabled or retimed routine must not inherit a
    // stale due time that would fire immediately.
    routine.nextRunAt = routine.enabled
      ? nextRunAt(routine.trigger, now, { timezone: routine.timezone, anchor: routine.lastRunAt ?? now })
      : null;
    this.save();
    return routine;
  }

  remove(id: string): boolean {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.id !== id);
    if (this.routines.length === before) return false;
    this.save();
    return true;
  }

  removeForBot(botId: string): void {
    const before = this.routines.length;
    this.routines = this.routines.filter((r) => r.botId !== botId);
    if (this.routines.length !== before) this.save();
  }

  /** Record an attempt and roll the schedule forward. */
  recordRun(id: string, run: RoutineRun, now = Date.now()): Routine | null {
    const routine = this.get(id);
    if (!routine) return null;
    routine.runs = [run, ...routine.runs].slice(0, MAX_RUNS);
    if (run.outcome === "ok" || run.outcome === "error") routine.lastRunAt = run.at;
    routine.nextRunAt = routine.enabled
      ? nextRunAt(routine.trigger, now, { timezone: routine.timezone, anchor: routine.lastRunAt ?? now })
      : null;
    this.save();
    return routine;
  }

  /** Advance a routine past an occurrence without running it. */
  skip(id: string, scheduledFor: number, reason: string, outcome: RunOutcome = "missed", now = Date.now()) {
    return this.recordRun(id, { at: now, outcome, detail: reason, scheduledFor }, now);
  }
}

function defaultName(trigger: Trigger, timezone: string): string {
  const label = describeTrigger(trigger, timezone);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface DueDecision {
  routine: Routine;
  scheduledFor: number;
  /** "run" fires now; "missed" advances the schedule and reports instead. */
  action: "run" | "missed";
}

/**
 * Decide what to do with every enabled routine at this tick.
 *
 * Separated from execution so the policy is unit-testable without bots,
 * containers or timers.
 */
export function dueRoutines(routines: Routine[], now: number): DueDecision[] {
  const out: DueDecision[] = [];
  for (const routine of routines) {
    if (!routine.enabled || routine.nextRunAt === null) continue;
    if (routine.nextRunAt > now + DUE_SLACK_MS) continue;
    const lateBy = now - routine.nextRunAt;
    out.push({
      routine,
      scheduledFor: routine.nextRunAt,
      action: lateBy > MISSED_AFTER_MS ? "missed" : "run",
    });
  }
  return out;
}

/** Wall-clock description of an instant, for user-facing messages. */
export function formatInstant(at: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .format(new Date(at))
      .replace(",", "");
  } catch {
    return new Date(at).toISOString();
  }
}
