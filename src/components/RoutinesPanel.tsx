// Routines UI: create, pause, test-run and inspect recurring tasks.
//
// Deliberately self-contained — it owns its own fetches rather than routing
// through the global store, because routines are a side panel concern and the
// server is the single source of truth (a routine can also be created from
// chat, or fire on its own, and this panel must reflect that).
import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2, Play, Trash2 } from "lucide-react";

export type Trigger =
  | { type: "hourly"; minute?: number }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  | { type: "weekly"; weekday: number; time: string }
  | { type: "monthly"; day: number; time: string }
  | { type: "interval"; minutes: number }
  | { type: "cron"; expression: string };

export interface RoutineRun {
  at: number;
  outcome: "ok" | "error" | "missed" | "skipped";
  detail?: string;
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
  nextRunAt: number | null;
  lastRunAt: number | null;
  runs: RoutineRun[];
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Mirrors the server's describeTrigger so the list reads the same everywhere. */
function describe(trigger: Trigger): string {
  switch (trigger.type) {
    case "hourly":
      return `every hour at :${String(trigger.minute ?? 0).padStart(2, "0")}`;
    case "daily":
      return `every day at ${trigger.time}`;
    case "weekdays":
      return `every weekday at ${trigger.time}`;
    case "weekly":
      return `every ${WEEKDAYS[trigger.weekday] ?? "week"} at ${trigger.time}`;
    case "monthly":
      return `on day ${trigger.day} of each month at ${trigger.time}`;
    case "interval":
      return trigger.minutes % 60 === 0
        ? `every ${trigger.minutes / 60}h`
        : `every ${trigger.minutes} minutes`;
    case "cron":
      return `cron: ${trigger.expression}`;
    default:
      return "custom schedule";
  }
}

function when(at: number | null, timezone: string): string {
  if (!at) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
  } catch {
    return new Date(at).toLocaleString();
  }
}

const OUTCOME_STYLE: Record<RoutineRun["outcome"], string> = {
  ok: "text-emerald-400",
  error: "text-red-400",
  missed: "text-amber-400",
  skipped: "text-ink-secondary",
};

export function RoutinesSection({ botId, busy }: { botId: string; busy?: boolean }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/routines?botId=${encodeURIComponent(botId)}`);
      const body = await res.json();
      setRoutines(body.routines ?? []);
    } catch {
      /* the panel simply shows what it last knew */
    } finally {
      setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  // Routines can change from chat or fire on their own; follow the event stream.
  useEffect(() => {
    const source = new EventSource("/api/events");
    const onMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.kind === "routine") void load();
      } catch {
        /* ignore malformed frames */
      }
    };
    source.addEventListener("message", onMessage);
    return () => {
      source.removeEventListener("message", onMessage);
      source.close();
    };
  }, [load]);

  const act = async (path: string, init: RequestInit) => {
    setError(null);
    const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? `request failed (${res.status})`);
      return false;
    }
    await load();
    return true;
  };

  return (
    <div className="mt-4 rounded-xl bg-card p-4">
      <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
        <CalendarClock size={16} className="text-ink-secondary" />
        Routines
      </div>
      <div className="mt-0.5 text-[13px] text-ink-secondary">
        Recurring tasks this agent runs on a schedule. You can also just ask it in chat.
      </div>

      {error && (
        <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{error}</div>
      )}

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-[13px] text-ink-secondary">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              busy={busy}
              running={runningId === routine.id}
              onToggle={(enabled) =>
                act(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) })
              }
              onDelete={() => act(`/api/routines/${routine.id}`, { method: "DELETE" })}
              onTestRun={async () => {
                setRunningId(routine.id);
                await act(`/api/routines/${routine.id}/run`, { method: "POST" });
                setRunningId(null);
              }}
            />
          ))}
          {routines.length === 0 && (
            <div className="rounded-lg border border-dashed border-hairline/60 px-3 py-4 text-center text-[12px] text-ink-secondary">
              No routines yet.
            </div>
          )}
        </div>
      )}

      {creating ? (
        <RoutineForm
          onCancel={() => setCreating(false)}
          onSubmit={async (draft) => {
            const ok = await act("/api/routines", {
              method: "POST",
              body: JSON.stringify({ botId, ...draft }),
            });
            if (ok) setCreating(false);
          }}
        />
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="mt-3 w-full rounded-lg bg-raised py-2 text-[13px] text-ink transition hover:brightness-110"
        >
          Create Routine
        </button>
      )}
    </div>
  );
}

function RoutineRow({
  routine,
  busy,
  running,
  onToggle,
  onDelete,
  onTestRun,
}: {
  routine: Routine;
  busy?: boolean;
  running: boolean;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onTestRun: () => void;
}) {
  const [open, setOpen] = useState(false);
  const lastRun = routine.runs[0];

  return (
    <div className="rounded-lg bg-raised/60 px-3 py-2">
      <div className="flex items-start gap-2">
        <button
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-left"
          title={routine.instruction}
        >
          <div className="truncate text-[13px] text-ink">{routine.name}</div>
          <div className="truncate text-[11px] text-ink-secondary">
            {describe(routine.trigger)}
            {routine.enabled ? ` · next ${when(routine.nextRunAt, routine.timezone)}` : " · paused"}
          </div>
        </button>
        <button
          onClick={onTestRun}
          disabled={busy || running}
          title={busy ? "The agent is already working" : "Run once now"}
          className="rounded p-1 text-ink-secondary transition hover:text-ink disabled:opacity-40"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        </button>
        {/* Pause/resume, so a routine can be silenced without losing it. */}
        <button
          onClick={() => onToggle(!routine.enabled)}
          title={routine.enabled ? "Pause" : "Resume"}
          className={`h-5 w-9 shrink-0 rounded-full transition ${
            routine.enabled ? "bg-emerald-500/80" : "bg-hairline"
          }`}
        >
          <span
            className={`block h-4 w-4 rounded-full bg-white transition-transform ${
              routine.enabled ? "translate-x-[18px]" : "translate-x-[2px]"
            }`}
          />
        </button>
      </div>

      {open && (
        <div className="mt-2 border-t border-hairline/40 pt-2">
          <div className="text-[12px] text-ink-secondary">{routine.instruction}</div>
          <div className="mt-2 text-[11px] text-ink-secondary">
            {routine.runs.length ? "Run history" : "No runs yet."}
          </div>
          {routine.runs.slice(0, 5).map((run, index) => (
            <div key={index} className="mt-1 flex items-baseline gap-2 text-[11px]">
              <span className={OUTCOME_STYLE[run.outcome]}>{run.outcome}</span>
              <span className="text-ink-secondary">{when(run.at, routine.timezone)}</span>
              {run.detail && <span className="truncate text-ink-secondary/70">{run.detail}</span>}
            </div>
          ))}
          <button
            onClick={onDelete}
            className="mt-2 flex items-center gap-1 text-[11px] text-red-400 transition hover:text-red-300"
          >
            <Trash2 size={12} /> Delete routine
          </button>
          {lastRun?.outcome === "missed" && (
            <div className="mt-2 text-[11px] text-amber-400/90">
              A run was skipped because the app was not running. Routines never run late.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RoutineForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (draft: { name?: string; instruction: string; trigger: Trigger; timezone: string }) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Trigger["type"]>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [day, setDay] = useState(1);
  const [minutes, setMinutes] = useState(120);
  const [expression, setExpression] = useState("0 9 * * 1-5");

  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", []);

  const trigger = ((): Trigger => {
    switch (kind) {
      case "hourly":
        return { type: "hourly", minute: 0 };
      case "weekdays":
        return { type: "weekdays", time };
      case "weekly":
        return { type: "weekly", weekday, time };
      case "monthly":
        return { type: "monthly", day, time };
      case "interval":
        return { type: "interval", minutes };
      case "cron":
        return { type: "cron", expression };
      default:
        return { type: "daily", time };
    }
  })();

  const field = "w-full rounded-lg bg-raised px-2 py-1.5 text-[13px] text-ink outline-none";
  const showTime = kind === "daily" || kind === "weekdays" || kind === "weekly" || kind === "monthly";

  return (
    <div className="mt-3 space-y-2 rounded-lg bg-raised/50 p-3">
      <textarea
        autoFocus
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="What should it do each time? e.g. check my inbox and summarise anything urgent"
        rows={3}
        className={`${field} resize-none`}
      />
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name (optional)"
        className={field}
      />
      <div className="flex gap-2">
        <select value={kind} onChange={(event) => setKind(event.target.value as Trigger["type"])} className={field}>
          <option value="hourly">Every hour</option>
          <option value="daily">Every day</option>
          <option value="weekdays">Every weekday</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
          <option value="interval">Every N minutes</option>
          <option value="cron">Advanced (cron)</option>
        </select>
        {showTime && (
          <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className={field} />
        )}
      </div>

      {kind === "weekly" && (
        <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} className={field}>
          {WEEKDAYS.map((label, index) => (
            <option key={label} value={index}>
              {label}
            </option>
          ))}
        </select>
      )}
      {kind === "monthly" && (
        <input
          type="number"
          min={1}
          max={31}
          value={day}
          onChange={(event) => setDay(Number(event.target.value))}
          className={field}
        />
      )}
      {kind === "interval" && (
        <input
          type="number"
          min={1}
          value={minutes}
          onChange={(event) => setMinutes(Number(event.target.value))}
          className={field}
        />
      )}
      {kind === "cron" && (
        <input value={expression} onChange={(event) => setExpression(event.target.value)} className={field} />
      )}

      <div className="text-[11px] text-ink-secondary">Times use {timezone}.</div>
      <div className="flex gap-2">
        <button
          onClick={() => onSubmit({ instruction, name: name || undefined, trigger, timezone })}
          disabled={!instruction.trim()}
          className="flex-1 rounded-lg bg-accent py-2 text-[13px] text-white transition hover:brightness-110 disabled:opacity-40"
        >
          Create
        </button>
        <button onClick={onCancel} className="rounded-lg bg-raised px-3 py-2 text-[13px] text-ink-secondary">
          Cancel
        </button>
      </div>
    </div>
  );
}
