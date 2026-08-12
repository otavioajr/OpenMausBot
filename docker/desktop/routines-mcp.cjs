#!/usr/bin/env node
// Routines MCP server for an isolated bot. Runs INSIDE the container and
// reaches the harness over a bind-mounted Unix socket — the container has no
// network route to the host, and this must not create one.
//
// Speaks JSON-RPC 2.0 over stdio to Codex, and newline-JSON over the socket.
"use strict";

const net = require("node:net");
const readline = require("node:readline");

const SOCKET = process.env.OMB_ROUTINES_SOCKET || "/run/omb/routines.sock";

const SCHEDULE_HELP =
  'One of: {"type":"hourly","minute":0} | {"type":"daily","time":"09:00"} | ' +
  '{"type":"weekdays","time":"09:00"} | {"type":"weekly","weekday":1,"time":"09:00"} ' +
  '(weekday 0=Sunday) | {"type":"monthly","day":1,"time":"09:00"} | ' +
  '{"type":"interval","minutes":120} | {"type":"cron","expression":"0 9 * * 1-5"}. ' +
  "Times are 24-hour HH:MM.";

const TOOLS = [
  {
    name: "list_routines",
    description: "List your scheduled routines (recurring tasks): schedule, active state, last and next run.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_routine",
    description:
      "Create a recurring task for yourself. At the scheduled time the harness starts a normal turn and gives you the instruction text, so phrase the instruction as a task addressed to you. Use when the user asks for something to happen repeatedly or on a schedule.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: { type: "string", description: "What to do each run." },
        trigger: { type: "object", description: SCHEDULE_HELP },
        name: { type: "string", description: "Optional short label." },
        timezone: { type: "string", description: "Optional IANA timezone." },
      },
      required: ["instruction", "trigger"],
    },
  },
  {
    name: "update_routine",
    description: "Change a routine: retime, reword, rename, or pause/resume via enabled true/false.",
    inputSchema: {
      type: "object",
      properties: {
        routine_id: { type: "string" },
        instruction: { type: "string" },
        trigger: { type: "object", description: SCHEDULE_HELP },
        name: { type: "string" },
        timezone: { type: "string" },
        enabled: { type: "boolean" },
      },
      required: ["routine_id"],
    },
  },
  {
    name: "delete_routine",
    description: "Delete one of your routines permanently.",
    inputSchema: { type: "object", properties: { routine_id: { type: "string" } }, required: ["routine_id"] },
  },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
const textResult = (id, text, isError) => ok(id, { content: [{ type: "text", text }], isError: !!isError });

/** One request/response over the harness socket. */
function ask(payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET);
    let buffer = "";
    const done = (fn, value) => {
      socket.destroy();
      fn(value);
    };
    socket.setTimeout(15_000, () => done(reject, new Error("routines bridge timed out")));
    socket.on("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      const index = buffer.indexOf("\n");
      if (index === -1) return;
      try {
        done(resolve, JSON.parse(buffer.slice(0, index)));
      } catch (error) {
        done(reject, error);
      }
    });
    socket.on("error", () =>
      done(reject, new Error("routines are unavailable in this environment")),
    );
  });
}

function describe(routine) {
  const state = routine.enabled ? "" : " (paused)";
  const next = routine.nextRunLabel ? `, next ${routine.nextRunLabel}` : "";
  const last = routine.lastRunLabel ? `, last ran ${routine.lastRunLabel}` : "";
  return `- ${routine.name} [id: ${routine.id}]${state}: ${routine.scheduleLabel}${next}${last}\n  task: ${routine.instruction}`;
}

async function callTool(name, args) {
  if (name === "list_routines") {
    const reply = await ask({ op: "list" });
    if (!reply.ok) return { text: reply.error, isError: true };
    if (!reply.routines.length) return { text: "You have no routines yet." };
    return { text: `Your routines:\n${reply.routines.map(describe).join("\n")}` };
  }
  if (name === "create_routine") {
    if (!args.instruction || !args.trigger) {
      return { text: `create_routine needs instruction and trigger. ${SCHEDULE_HELP}`, isError: true };
    }
    const reply = await ask({
      op: "create",
      instruction: args.instruction,
      trigger: args.trigger,
      name: args.name,
      timezone: args.timezone,
    });
    if (!reply.ok) return { text: reply.error, isError: true };
    return { text: `Routine created:\n${describe(reply.routine)}` };
  }
  if (name === "update_routine") {
    const { routine_id: id, ...rest } = args;
    if (!id) return { text: "update_routine needs routine_id.", isError: true };
    const patch = {};
    for (const key of ["instruction", "trigger", "name", "timezone", "enabled"]) {
      if (rest[key] !== undefined) patch[key] = rest[key];
    }
    if (!Object.keys(patch).length) return { text: "Nothing to change.", isError: true };
    const reply = await ask({ op: "update", id, patch });
    if (!reply.ok) return { text: reply.error, isError: true };
    return { text: `Routine updated:\n${describe(reply.routine)}` };
  }
  if (name === "delete_routine") {
    if (!args.routine_id) return { text: "delete_routine needs routine_id.", isError: true };
    const reply = await ask({ op: "delete", id: args.routine_id });
    if (!reply.ok) return { text: reply.error, isError: true };
    return { text: `Deleted the routine "${reply.deleted}".` };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  if (!method) return;
  const params = msg.params || {};
  switch (method) {
    case "initialize":
      ok(id, {
        protocolVersion: params.protocolVersion || "2024-11-05",
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
      const name = params.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const { text, isError } = await callTool(name, params.arguments || {});
        textResult(id, text, isError);
      } catch (error) {
        textResult(id, error.message, true);
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
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handle(msg);
});
