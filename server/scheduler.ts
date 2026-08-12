// The routine scheduler: a single timer that turns due routines into ordinary
// bot turns.
//
// Deliberately dependency-injected (no imports from index.ts) so it can be
// tested without a server, and so a future deployment can run the same loop
// against a remote execution backend instead of local Docker.
import { dueRoutines, formatInstant, type Routine, type RoutineStore } from "./routines.ts";
import { describeTrigger } from "./schedule.ts";

export interface SchedulerDeps {
  routines: RoutineStore;
  /** Start a normal turn. Resolves when the turn has been accepted. */
  startTurn: (botId: string, text: string) => Promise<void>;
  /** True when the bot is mid-turn; the routine waits instead of colliding. */
  isBusy: (botId: string) => boolean;
  /** True when the bot still exists. */
  botExists: (botId: string) => boolean;
  /** Post a message into the bot's transcript (missed-run reports). */
  notify: (botId: string, text: string) => void;
  /** Emit a state change so open UIs update live. */
  broadcast?: (routine: Routine) => void;
  now?: () => number;
  /** Tick interval; 30s keeps minute-precision schedules honest. */
  intervalMs?: number;
}

export class RoutineScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = new Set<string>();
  private deps: Required<Pick<SchedulerDeps, "now" | "intervalMs">> & SchedulerDeps;

  constructor(deps: SchedulerDeps) {
    this.deps = { now: () => Date.now(), intervalMs: 30_000, ...deps };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs);
    // Never hold the process open: a scheduler must not stop the app exiting.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduling pass. Exposed for tests and for an immediate first run. */
  async tick(): Promise<void> {
    const { routines, now } = this.deps;
    const at = now();
    for (const decision of dueRoutines(routines.all(), at)) {
      const { routine, scheduledFor, action } = decision;

      // A routine whose bot was deleted must not keep firing forever.
      if (!this.deps.botExists(routine.botId)) {
        routines.remove(routine.id);
        continue;
      }
      // Already executing (a slow turn spanning several ticks).
      if (this.running.has(routine.id)) continue;

      if (action === "missed") {
        const detail = `Missed the ${formatInstant(scheduledFor, routine.timezone)} run — the app was not running.`;
        const updated = routines.skip(routine.id, scheduledFor, detail, "missed", at);
        this.deps.notify(
          routine.botId,
          `Routine "${routine.name}" did not run.\n\n${detail} It was skipped rather than run late; the next run is ${
            updated?.nextRunAt ? formatInstant(updated.nextRunAt, routine.timezone) : "not scheduled"
          }.`,
        );
        if (updated && this.deps.broadcast) this.deps.broadcast(updated);
        continue;
      }

      // The bot is mid-turn: leave nextRunAt alone and retry next tick, so a
      // long conversation delays a routine instead of dropping or racing it.
      if (this.deps.isBusy(routine.botId)) continue;

      void this.run(routine, scheduledFor);
    }
  }

  /** Execute one routine as a normal turn. */
  async run(routine: Routine, scheduledFor?: number): Promise<void> {
    if (this.running.has(routine.id)) return;
    this.running.add(routine.id);
    const { routines, now } = this.deps;
    try {
      await this.deps.startTurn(routine.botId, routine.instruction);
      const updated = routines.recordRun(
        routine.id,
        { at: now(), outcome: "ok", scheduledFor },
        now(),
      );
      if (updated && this.deps.broadcast) this.deps.broadcast(updated);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const updated = routines.recordRun(
        routine.id,
        { at: now(), outcome: "error", detail, scheduledFor },
        now(),
      );
      this.deps.notify(routine.botId, `Routine "${routine.name}" failed to start: ${detail}`);
      if (updated && this.deps.broadcast) this.deps.broadcast(updated);
    } finally {
      this.running.delete(routine.id);
    }
  }

  /** Human summary used by chat tools and the API. */
  static summarize(routine: Routine): string {
    const schedule = describeTrigger(routine.trigger, routine.timezone);
    const next =
      routine.enabled && routine.nextRunAt
        ? ` Next run ${formatInstant(routine.nextRunAt, routine.timezone)}.`
        : " Paused.";
    return `"${routine.name}" — ${schedule}.${next}`;
  }
}
