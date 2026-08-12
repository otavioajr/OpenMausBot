// Routines MCP proxy — lets a bot create and manage its own recurring tasks
// from chat ("remind me every weekday at 9am to…"), routed back through the
// harness so the harness stays the single owner of scheduling and storage.
//
//   list_routines()                    → this bot's routines
//   create_routine(instruction, …)     → schedule a new recurring task
//   update_routine(routine_id, …)      → retime, rename, pause or resume
//   delete_routine(routine_id)         → remove one
//
// Raw JSON-RPC 2.0 over stdio, matching agents-proxy / computer-proxy.
// Env injected by the harness:
//   OMB_HARNESS_URL  base URL of the harness
//   OMB_BOT_ID       the calling bot (a bot may only touch its own routines)
//   OMB_COMMS_TOKEN  shared secret for the localhost-only internal endpoints
//   OMB_TIMEZONE     default IANA zone for new routines
import readline from "node:readline";

const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const TIMEZONE = process.env.OMB_TIMEZONE || undefined;

const SCHEDULE_HELP =
  'One of: {"type":"hourly","minute":0} | {"type":"daily","time":"09:00"} | ' +
  '{"type":"weekdays","time":"09:00"} | {"type":"weekly","weekday":1,"time":"09:00"} ' +
  '(weekday 0=Sunday) | {"type":"monthly","day":1,"time":"09:00"} | ' +
  '{"type":"interval","minutes":120} | {"type":"cron","expression":"0 9 * * 1-5"}. ' +
  "Times are 24-hour HH:MM in the routine's timezone.";

const TOOLS = [
  {
    name: "list_routines",
    description:
      "List your own scheduled routines (recurring tasks), with their schedule, whether they are active, when they last ran and when they run next.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_routine",
    description:
      "Create a recurring task for yourself. At the scheduled time the harness starts a normal turn and gives you the instruction text, so write the instruction as if the user had just typed it to you. Use this when the user asks for something to happen repeatedly or on a schedule.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "What to do each time it runs, phrased as a task for you.",
        },
        trigger: { type: "object", description: SCHEDULE_HELP },
        name: { type: "string", description: "Optional short label shown in the UI." },
        timezone: {
          type: "string",
          description: "Optional IANA timezone (e.g. America/Sao_Paulo). Defaults to the host's zone.",
        },
      },
      required: ["instruction", "trigger"],
    },
  },
  {
    name: "update_routine",
    description:
      "Change one of your routines: retime it, reword the instruction, rename it, or pause/resume it with enabled true/false.",
    inputSchema: {
      type: "object",
      properties: {
        routine_id: { type: "string", description: "The routine's id (from list_routines)." },
        instruction: { type: "string" },
        trigger: { type: "object", description: SCHEDULE_HELP },
        name: { type: "string" },
        timezone: { type: "string" },
        enabled: { type: "boolean", description: "false pauses the routine, true resumes it." },
      },
      required: ["routine_id"],
    },
  },
  {
    name: "delete_routine",
    description: "Delete one of your routines permanently.",
    inputSchema: {
      type: "object",
      properties: { routine_id: { type: "string" } },
      required: ["routine_id"],
    },
  },
];

type Json = Record<string, unknown>;
const send = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id: unknown, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id: unknown, text: string, isError = false) =>
  ok(id, { content: [{ type: "text", text }], isError });

async function api(path: string, init?: RequestInit): Promise<Json> {
  const res = await fetch(HARNESS + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(String(body.error ?? `HTTP ${res.status}`));
  return body;
}

function describe(routine: Json): string {
  const state = routine.enabled ? "" : " (paused)";
  const next = routine.nextRunLabel ? `, next ${routine.nextRunLabel}` : "";
  const last = routine.lastRunLabel ? `, last ran ${routine.lastRunLabel}` : "";
  return `- ${routine.name} [id: ${routine.id}]${state}: ${routine.scheduleLabel}${next}${last}\n  task: ${routine.instruction}`;
}

/** A bot may only ever touch routines that belong to it. */
async function ownRoutine(routineId: string): Promise<Json> {
  const list = (await api(`/api/internal/routines?botId=${encodeURIComponent(BOT_ID)}`)).routines as Json[];
  const found = (list ?? []).find((r) => r.id === routineId);
  if (!found) throw new Error("no such routine (it may belong to another bot)");
  return found;
}

async function callTool(name: string, args: Json): Promise<{ text: string; isError?: boolean }> {
  if (name === "list_routines") {
    const r = await api(`/api/internal/routines?botId=${encodeURIComponent(BOT_ID)}`);
    const routines = (r.routines as Json[]) ?? [];
    if (!routines.length) return { text: "You have no routines yet." };
    return { text: `Your routines:\n${routines.map(describe).join("\n")}` };
  }

  if (name === "create_routine") {
    const instruction = String(args.instruction ?? "").trim();
    if (!instruction) return { text: "create_routine needs an instruction.", isError: true };
    if (!args.trigger || typeof args.trigger !== "object") {
      return { text: `create_routine needs a trigger. ${SCHEDULE_HELP}`, isError: true };
    }
    const created = await api(`/api/internal/routines`, {
      method: "POST",
      body: JSON.stringify({
        botId: BOT_ID,
        instruction,
        trigger: args.trigger,
        name: args.name,
        timezone: args.timezone ?? TIMEZONE,
      }),
    });
    return { text: `Routine created:\n${describe(created)}` };
  }

  if (name === "update_routine") {
    const routineId = String(args.routine_id ?? "").trim();
    if (!routineId) return { text: "update_routine needs routine_id.", isError: true };
    await ownRoutine(routineId);
    const patch: Json = {};
    for (const key of ["instruction", "trigger", "name", "timezone", "enabled"] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    if (Object.keys(patch).length === 0) return { text: "Nothing to change.", isError: true };
    const updated = await api(`/api/internal/routines/${encodeURIComponent(routineId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return { text: `Routine updated:\n${describe(updated)}` };
  }

  if (name === "delete_routine") {
    const routineId = String(args.routine_id ?? "").trim();
    if (!routineId) return { text: "delete_routine needs routine_id.", isError: true };
    const routine = await ownRoutine(routineId);
    await api(`/api/internal/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" });
    return { text: `Deleted the routine "${routine.name}".` };
  }

  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg: Json) {
  const id = msg.id;
  const method = msg.method as string | undefined;
  if (!method) return;
  const params = (msg.params ?? {}) as Json;
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-routines", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      ok(id, {});
      return;
    case "tools/list":
      ok(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params.name as string;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, (params.arguments ?? {}) as Json);
        textResult(id, text, isError);
      } catch (e) {
        textResult(id, (e as Error).message, true);
      }
      return;
    }
    default:
      if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: Json;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handle(msg);
});
