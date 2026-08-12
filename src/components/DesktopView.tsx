// Live view of a bot's isolated desktop.
//
// Design notes:
//   - ONE RFB connection is reused for the inline monitor and the expanded
//     modal. Reconnecting on expand would blank the screen and re-handshake,
//     which feels broken; instead the canvas is re-parented and rescaled.
//   - The inline monitor is view-only on purpose: a stray click in the sidebar
//     must never move the bot's cursor mid-task.
//   - Taking control writes a lock inside the container, so the agent is
//     actually blocked from sending input — not merely hidden from the UI.
import RFB from "@novnc/novnc";
import { Expand, Loader2, Maximize2, Monitor, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Control = "bot" | "human";

interface Props {
  botId: string;
  botName: string;
  running: boolean;
  onWake?: () => void;
}

export function DesktopView({ botId, botName, running, onWake }: Props) {
  const inlineHost = useRef<HTMLDivElement | null>(null);
  const modalHost = useRef<HTMLDivElement | null>(null);
  const rfb = useRef<RFB | null>(null);
  const canvasHolder = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [control, setControl] = useState<Control>("bot");
  const [status, setStatus] = useState<"idle" | "connecting" | "live" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    if (rfb.current || !running) return;
    setStatus("connecting");
    setError(null);
    try {
      const res = await fetch(`/api/bots/${botId}/desktop/ticket`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "could not open the desktop");
      setControl(data.control === "human" ? "human" : "bot");

      // The canvas lives in a holder we own, so it can move between the inline
      // monitor and the modal without tearing down the connection.
      const holder = document.createElement("div");
      holder.style.width = "100%";
      holder.style.height = "100%";
      canvasHolder.current = holder;
      (expanded ? modalHost.current : inlineHost.current)?.appendChild(holder);

      const proto = location.protocol === "https:" ? "wss" : "ws";
      const client = new RFB(holder, `${proto}://${location.host}${data.url}`);
      client.viewOnly = true; // inline preview never steals the cursor
      client.scaleViewport = true;
      client.resizeSession = false;
      client.background = "#0d1117";
      client.addEventListener("connect", () => setStatus("live"));
      client.addEventListener("disconnect", (event: Event) => {
        rfb.current = null;
        const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean;
        setStatus(clean ? "idle" : "error");
        if (!clean) setError("the desktop stream dropped");
      });
      rfb.current = client;
    } catch (e) {
      setStatus("error");
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [botId, expanded, running]);

  useEffect(() => {
    if (running) void connect();
    return () => {
      rfb.current?.disconnect();
      rfb.current = null;
    };
    // Reconnect only when the bot or its running state changes.
  }, [botId, running]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-parent the live canvas when expanding/collapsing.
  useEffect(() => {
    const holder = canvasHolder.current;
    const target = expanded ? modalHost.current : inlineHost.current;
    if (!holder || !target || holder.parentElement === target) return;
    target.appendChild(holder);
    rfb.current?.focus();
  }, [expanded]);

  // Input is enabled only in the expanded modal AND only while the human holds
  // control, so the two writers can never fight.
  useEffect(() => {
    if (!rfb.current) return;
    rfb.current.viewOnly = !(expanded && control === "human");
    if (expanded && control === "human") rfb.current.focus();
  }, [expanded, control]);

  const setControlMode = useCallback(
    async (next: Control) => {
      const res = await fetch(`/api/bots/${botId}/desktop/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ control: next }),
      });
      if (res.ok) setControl(next);
    },
    [botId],
  );

  const close = useCallback(() => {
    setExpanded(false);
    if (control === "human") void setControlMode("bot");
  }, [control, setControlMode]);

  // Escape leaves the modal and hands control back, so walking away never
  // leaves the bot locked out of its own desktop.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, close]);

  const statusLabel =
    status === "live"
      ? control === "human"
        ? "You're in control"
        : "Bot controlling"
      : status === "connecting"
        ? "Starting the desktop…"
        : status === "error"
          ? (error ?? "Desktop unavailable")
          : running
            ? "Desktop idle"
            : "Stopped — wakes on the next turn";

  return (
    <>
      <div className="mt-3 overflow-hidden rounded-xl bg-card">
        <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-secondary">
          <span
            className={`h-2 w-2 rounded-full ${
              status === "live" ? "bg-emerald-400" : status === "error" ? "bg-red-400" : "bg-ink-tertiary"
            }`}
          />
          <span className="truncate">{statusLabel}</span>
          <div className="ml-auto flex items-center gap-1">
            {status === "live" && (
              <button
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 rounded-md bg-raised px-2 py-1 text-[12px] text-ink hover:bg-raised-hover"
              >
                <Expand size={12} />
                {control === "human" ? "Open" : "Take control"}
              </button>
            )}
            {!running && onWake && (
              <button
                onClick={onWake}
                className="rounded-md bg-raised px-2 py-1 text-[12px] text-ink hover:bg-raised-hover"
              >
                Start
              </button>
            )}
          </div>
        </div>

        {/* Click to expand; view-only until then. */}
        <div
          ref={inlineHost}
          onClick={() => status === "live" && setExpanded(true)}
          title={status === "live" ? "Click to expand and control" : undefined}
          className={`relative flex aspect-[16/10] w-full items-center justify-center bg-[#0d1117] ${
            status === "live" ? "cursor-pointer" : ""
          }`}
        >
          {status !== "live" && (
            <div className="pointer-events-none flex flex-col items-center gap-2 text-ink-tertiary">
              {status === "connecting" ? (
                <Loader2 size={22} className="animate-spin" />
              ) : (
                <Monitor size={22} />
              )}
              <span className="px-4 text-center text-[12px]">{statusLabel}</span>
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm" role="dialog" aria-label={`${botName} desktop`}>
          <div className="flex items-center gap-2 border-b border-white/10 bg-app px-4 py-2">
            <Monitor size={14} className="text-ink-secondary" />
            <strong className="text-[13px] text-ink">{botName}</strong>
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] ${
                control === "human" ? "bg-emerald-500/15 text-emerald-300" : "bg-sky-500/15 text-sky-300"
              }`}
            >
              {control === "human" ? "You're in control" : "Bot controlling"}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {control === "bot" ? (
                <button
                  onClick={() => void setControlMode("human")}
                  className="rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
                >
                  Take control
                </button>
              ) : (
                <button
                  onClick={() => void setControlMode("bot")}
                  className="rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
                >
                  Give back to bot
                </button>
              )}
              <button
                onClick={() => {
                  const el = document.querySelector("[role=dialog]");
                  if (el && !document.fullscreenElement) void (el as HTMLElement).requestFullscreen();
                  else if (document.fullscreenElement) void document.exitFullscreen();
                }}
                className="flex items-center gap-1 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
              >
                <Maximize2 size={12} />
                Fullscreen
              </button>
              <button
                onClick={close}
                className="flex items-center gap-1 rounded-lg bg-raised px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
              >
                <X size={12} />
                Close
              </button>
            </div>
          </div>

          <div ref={modalHost} className="min-h-0 flex-1 bg-[#0d1117]" />

          <div className="border-t border-white/10 bg-app px-4 py-2 text-center text-[12px] text-ink-secondary">
            {control === "human"
              ? "Your mouse and keyboard drive this Linux desktop. Esc closes and hands control back to the bot."
              : "The bot is working — click Take control to use the desktop yourself."}
          </div>
        </div>
      )}
    </>
  );
}
