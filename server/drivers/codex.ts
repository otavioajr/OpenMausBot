// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume
// and falls back to a fresh thread/start.
import { spawn, execFile } from "node:child_process";
import { homedir } from "node:os";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { augmentedPath } from "../env-path.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "codex";

// catalog ported from upstream packages/contracts/src/model.ts
const MODELS = {
  default: "gpt-5.6-sol",
  options: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
    { id: "gpt-5.4", label: "GPT-5.4" },
  ],
};

export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "OpenMausBot: nobody answered this permission request in time. Skip this action and finish what you can without it.";

// Computer-use commands travel through the in-container `botpc` broker. The
// broker is already the security boundary: it validates URLs and screenshot
// paths, exposes only bounded pointer/keyboard operations, and enforces the
// human-control lock. Asking the user to approve every observation frame makes
// visual automation stall before it can move the mouse.
//
// Deliberately reject shell metacharacters and `botpc exec` here. This is not a
// general shell allowlist: it only recognizes one simple broker command from
// Codex's parsed commandActions. Anything ambiguous still opens an approval.
const SAFE_BOTPC_OPS = new Set(["screenshot", "state", "move", "click", "type", "key", "scroll", "open"]);
const SHELL_META = /[;&|><`$()\r\n]/;

export function isSafeBotpcApproval(params: Record<string, any>, dockerDesktop: boolean): boolean {
  if (!dockerDesktop) return false;
  const actions = Array.isArray(params.commandActions) ? params.commandActions : [];
  if (actions.length !== 1 || typeof actions[0]?.command !== "string") return false;
  const command = actions[0].command.trim();
  if (SHELL_META.test(command)) return false;
  const match = command.match(/^botpc(?:\s+([a-z]+))(?:\s+.*)?$/);
  if (!match || !SAFE_BOTPC_OPS.has(match[1])) return false;

  // Codex supplies this amendment when its own exec-policy parser agrees that
  // the command's executable is exactly botpc. Requiring both parsers to agree
  // avoids trusting display text from the outer `/bin/bash -lc ...` wrapper.
  const amendment = params.proposedExecpolicyAmendment;
  return Array.isArray(amendment) && amendment.length === 1 && amendment[0] === "botpc";
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => void;
      turnId: string;
      asks: Map<string, (behavior: string, message?: string) => void>;
    }
    const active = new Map<string, Turn>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();

      const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), NPM_CONFIG_LOGLEVEL: "error" };
      // the CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal)
      delete env.OPENAI_API_KEY;

      const dockerComputer = turn.integrations?.dockerComputer;
      // In cloud/self-hosted mode the CLI itself runs in the bot's container —
      // not merely an MCP shell bolted onto a host-side agent. That makes cwd,
      // file edits, subprocesses and Codex's own session state truly per-bot.
      // The isolated CLI gets a dummy credential only. A hardened sidecar on
      // the bot's private network replaces it with the real 9router key; the
      // agent container never receives that secret in env, argv or filesystem.
      const command = dockerComputer ? "docker" : config.cli;
      const args = dockerComputer
        ? [
            "exec",
            "-i",
            "-u",
            "ubuntu",
            "-w",
            "/workspace",
            "-e",
            "BOT_ROUTER_KEY=openmausbot-private-proxy",
            dockerComputer.containerName,
            "codex",
            "app-server",
          ]
        : ["app-server"];
      const child = spawn(command, args, {
        cwd: dockerComputer ? homedir() : turn.cwd ?? homedir(),
        env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      const state = { settled: false, lastText: "" };
      const asks = new Map<string, (behavior: string, message?: string) => void>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          rpcPending.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method, params });
        });

      const stop = () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          try {
            child.kill("SIGTERM");
          } catch {}
        }
      };

      const settle = (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of [...asks.values()]) finish("deny", "OpenMausBot: the turn ended");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null });
        stop(); // the app-server never exits on its own
      };

      // server→client approval request → canonical request.opened
      const handleServerRequest = (msg: any) => {
        const method = msg.method as string;
        const params = msg.params ?? {};
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isQuestion = method === "item/tool/requestUserInput";
        const tool =
          method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : "shell";
        if ((config.fullAuto || isSafeBotpcApproval(params, turn.integrations?.dockerDesktop === true)) && !isQuestion) {
          return send({ jsonrpc: "2.0", id: msg.id, result: { decision: legacy ? "approved" : "accept" } });
        }
        const requestId = newId();
        const summary =
          typeof params.command === "string"
            ? params.command.slice(0, 200)
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        const choices = isQuestion
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
          : undefined;
        const finish = (behavior: string, message?: string) => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
            }
            send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source: "user" });
        };
        const timer = setTimeout(
          () => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE) : finish("deny", DENY_TIMEOUT_NOTE)),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary,
          choices,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        switch (msg.method) {
          case "item/started": {
            const item = p.item ?? {};
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell").slice(0, 80)
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (title) emit({ ...base(threadId, turnId), type: "item.started", itemType: "tool", itemId: item.id, title });
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const t = p.tokenUsage?.total;
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            if (p.message) emit({ ...base(threadId, turnId), type: "runtime.error", message: p.message });
            break;
        }
      };

      let buf = "";
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              msg.error ? pend.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        emit({ ...base(threadId, turnId), type: "runtime.error", message: `spawn failed: ${e.message}` });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId, asks });
      emit({ ...base(threadId, turnId), type: "turn.started" });

      // handshake + kickoff; any refusal surfaces as failure, not a hang
      (async () => {
        try {
          await request("initialize", { clientInfo: { name: "openmausbot", version: "1" } });
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          const cursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
          let codexThreadId: string | null = null;
          let startedModel: string | null = null;
          if (cursor) {
            try {
              const resumed = await request("thread/resume", {
                threadId: cursor,
                // Resume accepts the same overrides as thread/start. Without
                // these, Codex silently falls back to workspace-write and
                // bubblewrap fails under cap-drop ALL/no-new-privileges.
                cwd: dockerComputer ? "/workspace" : turn.cwd ?? homedir(),
                model: turn.model || null,
                sandbox: dockerComputer || config.fullAuto ? "danger-full-access" : "workspace-write",
                approvalPolicy: config.fullAuto ? "never" : "on-request",
              });
              codexThreadId = resumed?.thread?.id ?? cursor;
            } catch {
              /* resume unsupported or thread gone — start fresh below */
            }
          }
          if (!codexThreadId) {
            const started = await request("thread/start", {
              cwd: dockerComputer ? "/workspace" : turn.cwd ?? homedir(),
              model: turn.model || null,
              // The container is already the sandbox (1 CPU / 2 GB, uid 1000,
              // no capabilities, no host Docker socket). Nested bubblewrap is
              // unreliable under Docker, so don't stack another filesystem
              // sandbox inside it. Approval cards remain on-request.
              sandbox: dockerComputer || config.fullAuto ? "danger-full-access" : "workspace-write",
              approvalPolicy: config.fullAuto ? "never" : "on-request",
              ephemeral: false,
            });
            codexThreadId = started?.thread?.id ?? null;
            startedModel = started?.model ?? null;
          }
          emit({ ...base(threadId, turnId), type: "session.started", sessionId: codexThreadId, model: startedModel ?? turn.model ?? null });
          await request("turn/start", {
            threadId: codexThreadId,
            input: [{ type: "text", text: turn.system ? `${turn.system}\n\n${turn.text}` : turn.text }],
          });
        } catch (e) {
          if (!state.settled) {
            emit({ ...base(threadId, turnId), type: "runtime.error", message: (e as Error).message });
            settle(false, "rpc_error");
          }
        }
      })();

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      const version = await new Promise<string | null>((resolve) => {
        execFile(config.cli, ["--version"], { timeout: 8000, env: { ...process.env, PATH: augmentedPath() } }, (err, stdout) =>
          resolve(err ? null : stdout.trim()),
        );
      });
      if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
      return { state: "available", version };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: { sessionModelSwitch: "unsupported" },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        respondToRequest: async (threadId, requestId, decision) => {
          const turn = active.get(threadId);
          const finish = turn?.asks.get(requestId);
          if (!finish) throw new Error("no such pending request");
          finish(decision.behavior, decision.message);
        },
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};
