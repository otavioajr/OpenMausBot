// The bot's computer, in the right-side slot. Explicit Cloud uses either the
// self-hosted per-bot Docker environment (server deployment) or paid Box
// fallback; Docker is terminal-only, while Box has screenshot/desktop URLs.
// Local/unset uses the VPS in the browser build or This Mac in Electron. Off
// selects neither runtime (an existing isolated environment is parked).
import { useEffect, useRef, useState } from "react";
import {
  CalendarClock,
  ExternalLink,
  Loader2,
  Monitor,
  Moon,
  Power,
  Settings,
  X,
} from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { ApiKeyRow } from "./ApiKeys";
import { DesktopView } from "./DesktopView";
import { cn } from "@/lib/cn";

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

type Phase =
  | "checking"
  | "unconfigured"
  | "starting"
  | "ready"
  | "docker"
  | "local"
  | "local-unavailable"
  | "off"
  | "error";

export function ComputerPanel({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const [phase, setPhase] = useState<Phase>("checking");
  const [boxState, setBoxState] = useState<string | null>(null);
  const [computerKind, setComputerKind] = useState<"box" | "docker">("box");
  const [limits, setLimits] = useState<{ cpus?: string; memory?: string; storage?: string } | null>(null);
  // Graphical desktop: whether this host can build one, and whether THIS bot's
  // container already has one (older containers are terminal-only).
  const [desktopSupported, setDesktopSupported] = useState(false);
  const [hasDesktop, setHasDesktop] = useState(false);
  const [polledFrame, setPolledFrame] = useState<{ png: string; mime: string } | null>(null);
  const [localFrame, setLocalFrame] = useState<string | null>(null);
  const [pending, setPending] = useState<"join" | "sleep" | "provision" | "desktop-upgrade" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bumped when a Box token is saved inline, to re-run the spin-up flow
  const [retry, setRetry] = useState(0);

  // resolve the mode on open; box endpoints are only ever hit on the
  // cloud path, so local/off can never render a JSON error as an image
  useEffect(() => {
    let alive = true;
    setPhase("checking");
    setPolledFrame(null);
    setLocalFrame(null);
    setComputerKind("box");
    setLimits(null);
    setDesktopSupported(false);
    setHasDesktop(false);
    setError(null);
    const isElectron = Boolean(window.ogb);
    if (bot.computer === "off") {
      setPhase("off");
      return;
    }
    if (bot.computer !== "cloud") {
      // Browser/server build: unset or Local means the VPS itself. Electron
      // keeps its existing "This Mac" path.
      setPhase(isElectron ? "local" : "local-unavailable");
      return;
    }
    // Explicit Cloud only. Merely opening the panel must not allocate compute.
    api(`/api/bots/${bot.id}/computer`)
      .then((status) => {
        if (!alive) return;
        if (status.kind === "docker") {
          setComputerKind("docker");
          setLimits(status.limits ?? null);
          setBoxState(status.box?.state ?? "stopped");
          setDesktopSupported(Boolean(status.desktopSupported));
          setHasDesktop(Boolean(status.box?.hasDesktop));
          setPhase("docker");
          return;
        }
        setComputerKind("box");
        if (!status.configured) {
          setPhase("unconfigured");
          return;
        }
        setPhase("starting");
        return api(`/api/bots/${bot.id}/computer/provision`, { method: "POST" }).then((r) => {
          if (!alive) return;
          setBoxState(r.state ?? null);
          setPhase("ready");
        });
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message);
        setPhase("error");
      });
    return () => {
      alive = false;
    };
  }, [bot.id, bot.computer, retry]);

  // cloud preview: SSE frames win while the bot works; otherwise poll
  const live = state.screens[bot.id];
  const sseFlowing = Boolean(bot.busy && live);
  const inFlight = useRef(false);
  useEffect(() => {
    if (phase !== "ready" || computerKind !== "box" || sseFlowing) return;
    let alive = true;
    const shoot = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const { png, format } = await api(`/api/bots/${bot.id}/computer/screenshot`, { method: "POST" });
        if (alive) setPolledFrame({ png, mime: format === "jpeg" ? "image/jpeg" : "image/png" });
      } catch {
        /* box mid-command or asleep — next tick */
      } finally {
        inFlight.current = false;
      }
    };
    void shoot();
    const timer = setInterval(shoot, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase, computerKind, sseFlowing, bot.id]);

  // local preview: frames from the Electron main process. The FIRST capture
  // attempt is what makes macOS show the Screen Recording prompt (there is
  // no reliable pre-grant flow on macOS 15+), so repeated empty frames mean
  // the user denied — surface the Settings repair path instead of spinning.
  const [localMisses, setLocalMisses] = useState(0);
  useEffect(() => {
    if (phase !== "local" || !window.ogb) return;
    let alive = true;
    setLocalMisses(0);
    const shoot = async () => {
      try {
        const url = await window.ogb!.screenFrame();
        if (alive && url) setLocalFrame(url);
        else if (alive) setLocalMisses((n) => n + 1);
      } catch {
        if (alive) setLocalMisses((n) => n + 1);
      }
    };
    void shoot();
    const timer = setInterval(shoot, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [phase]);

  const lastScreenMessage = [...bot.messages].reverse().find((m) => m.kind === "screen" && m.png);
  const cloudFrame =
    live ??
    polledFrame ??
    (lastScreenMessage ? { png: lastScreenMessage.png!, mime: lastScreenMessage.mime ?? "image/png" } : null);
  const frameSrc =
    phase === "local"
      ? localFrame
      : phase === "ready" || phase === "starting"
        ? cloudFrame && `data:${cloudFrame.mime};base64,${cloudFrame.png}`
        : null;

  const run = (kind: "join" | "sleep" | "provision" | "desktop-upgrade") => {
    setPending(kind);
    setError(null);
    // The desktop upgrade lives under /desktop/upgrade; the rest are computer ops.
    const path =
      kind === "desktop-upgrade"
        ? `/api/bots/${bot.id}/desktop/upgrade`
        : `/api/bots/${bot.id}/computer/${kind}`;
    api(path, { method: "POST" })
      .then((result) => {
        // the join URL's stream token rotates — always freshly minted, never cached
        if (kind === "join" && result.joinUrl) window.open(result.joinUrl);
        if (kind === "sleep") setBoxState(computerKind === "docker" ? "stopped" : "archived");
        if (kind === "provision") setBoxState(result.state ?? "running");
        if (kind === "desktop-upgrade") {
          setHasDesktop(Boolean(result.hasDesktop));
          setBoxState(result.state ?? "running");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setPending(null));
  };

  const emptyState: Record<Exclude<Phase, "ready" | "docker" | "local">, string> = {
    checking: "Checking…",
    starting: "Starting your bot's computer…",
    unconfigured: "No cloud computer configured",
    "local-unavailable": "This bot uses the VPS directly. Choose Cloud for an isolated per-bot container.",
    off: "This bot's computer is off",
    error: "Couldn't reach the computer",
  };

  return (
    <aside className="animate-panel-in flex h-full w-[400px] shrink-0 flex-col border-l border-hairline/40 bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => dispatch({ type: "toggleSettings", open: true })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          title="Bot settings"
        >
          <Settings size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Computer</span>
        <button
          onClick={() => dispatch({ type: "toggleComputer", open: false })}
          className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        {/* Screen preview */}
        <div className="mb-1.5 mt-2 flex items-center justify-between text-[13px] text-ink-secondary">
          <span>{computerKind === "docker" ? `${bot.name}'s environment` : `${bot.name}'s screen`}</span>
          {phase === "local" && <span className="text-[11px]">this Mac</span>}
          {phase === "docker" && (
            <span className="text-[11px]">{hasDesktop ? "live desktop" : "terminal only"}</span>
          )}
        </div>
        {/* A graphical bot streams live in the monitor slot; everything else
            keeps the static frame/placeholder. */}
        {phase === "docker" && hasDesktop ? (
          <DesktopView
            botId={bot.id}
            botName={bot.name}
            running={boxState === "running"}
            onWake={() => run("provision")}
          />
        ) : (
        <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-xl bg-card">
          {frameSrc ? (
            <img src={frameSrc} alt={`${bot.name}'s screen`} className="h-full w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-2 px-6 text-center text-ink-secondary">
              {phase === "checking" || phase === "starting" || phase === "local" ? (
                <Loader2 size={18} className="animate-spin" />
              ) : phase === "off" ? (
                <Power size={22} />
              ) : (
                <Monitor size={22} />
              )}
              <span className="text-[12px]">
                {phase === "docker"
                  ? `Isolated Linux container · ${boxState === "running" ? "running" : "stopped"}. It wakes automatically on the next Codex turn.`
                  : phase === "ready"
                    ? "Waiting for the first frame…"
                    : phase === "local"
                      ? localMisses >= 3
                        ? "No frames yet — the preview needs Screen Recording permission. After granting, relaunch the app (macOS applies it on next launch)."
                        : "Capturing this Mac's screen…"
                      : emptyState[phase]}
              </span>
              {phase === "local" && localMisses >= 3 && (
                <button
                  onClick={() => window.ogb?.permOpenSettings?.("screen")}
                  className="mt-1 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Open Settings
                </button>
              )}
            </div>
          )}
        </div>
        )}

        {error && (
          <div className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </div>
        )}
        {phase === "unconfigured" && computerKind === "box" && (
          <div className="mt-3 rounded-xl bg-card p-4">
            <div className="mb-3 text-[13px] text-ink-secondary">
              Paste a Box token from box.ascii.dev to give this bot a cloud computer — it spins up right here.
            </div>
            <ApiKeyRow
              section="box"
              label="Box token"
              placeholder="Token from box.ascii.dev"
              onSaved={(configured) => configured && setRetry((n) => n + 1)}
            />
          </div>
        )}

        {/* Paid Box-only actions */}
        {phase === "ready" && computerKind === "box" && (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => run("join")}
              disabled={pending === "join"}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-raised py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
            >
              {pending === "join" ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              Open desktop
            </button>
            {boxState !== "archived" && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="flex items-center justify-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                title="Put the computer to sleep"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Sleep
              </button>
            )}
          </div>
        )}

        {phase === "docker" && (
          <div className="mt-3 rounded-xl bg-card p-4 text-[13px] text-ink-secondary">
            <div className="font-medium text-ink">
              {hasDesktop ? "Isolated Linux desktop" : "Terminal-only isolated environment"}
            </div>
            <div className="mt-1">
              {hasDesktop
                ? "The bot works on its own graphical desktop — you can watch live and take over at any time. Files persist while the bot exists; deleting the bot deletes the environment."
                : "Codex, shell commands and files run inside this bot's container. Files persist while the bot exists; deleting the bot deletes the environment."}
            </div>
            <div className="mt-2 text-[12px]">
              Limits: {limits?.cpus ?? "1"} vCPU · {limits?.memory ?? "2g"} RAM · {limits?.storage ?? "10G"} disk
            </div>

            {!hasDesktop && desktopSupported && (
              <button
                onClick={() => {
                  // Recreating the container drops its writable layer, so this
                  // must never happen behind the user's back.
                  if (!confirm("Add a graphical desktop to this bot?\n\nThe container is recreated, so files currently in /workspace are lost.")) return;
                  void run("desktop-upgrade");
                }}
                disabled={pending === "desktop-upgrade"}
                className="mt-3 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "desktop-upgrade" ? <Loader2 size={14} className="animate-spin" /> : <Monitor size={14} />}
                Add graphical desktop
              </button>
            )}

            {boxState === "running" && (
              <button
                onClick={() => run("sleep")}
                disabled={pending === "sleep"}
                className="mt-3 flex items-center gap-2 rounded-lg bg-raised px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
              >
                {pending === "sleep" ? <Loader2 size={14} className="animate-spin" /> : <Moon size={14} />}
                Stop now
              </button>
            )}
          </div>
        )}

        {/* Computer source */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="text-[15px] font-medium text-ink">Runs on</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Default/Local uses the VPS. Cloud creates a persistent isolated container for this bot.
          </div>
          <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
            {(
              [
                ["cloud", "Isolated"],
                ["local", "VPS"],
                ["off", "Off"],
              ] as const
            ).map(([mode, label], i) => (
              <button
                key={mode}
                onClick={() => dispatch({ type: "updateBot", botId: bot.id, patch: { computer: mode } })}
                className={cn(
                  "flex-1 py-1.5 text-[13px]",
                  i > 0 && "border-l border-hairline/40",
                  bot.computer === mode
                    ? "bg-raised text-ink"
                    : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Routines */}
        <div className="mt-4 rounded-xl bg-card p-4">
          <div className="flex items-center gap-2 text-[15px] font-medium text-ink">
            <CalendarClock size={16} className="text-ink-secondary" />
            Routines
          </div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            Routines are recurring tasks this agent runs on a schedule.
          </div>
          <button
            disabled
            className="mt-3 w-full cursor-not-allowed rounded-lg bg-raised py-2 text-[13px] text-ink-secondary opacity-60"
            title="Coming soon"
          >
            Create Routine
          </button>
        </div>
      </div>
    </aside>
  );
}
