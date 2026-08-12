
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "omb-bridge-"));
process.env.OMB_DATA_DIR_OVERRIDE = scratch;

const { RoutineStore } = await import("../server/routines.ts");
const { serveRoutineSocket } = await import("../server/routine-bridge.ts");

const store = new RoutineStore();
const bot = "bot-under-test";
const { path } = serveRoutineSocket(bot, { routines: store, timezone: () => "America/Sao_Paulo" });
await new Promise((r) => setTimeout(r, 300));

const child = spawn(process.execPath, ["docker/desktop/routines-mcp.cjs"], {
  env: { ...process.env, OMB_ROUTINES_SOCKET: path },
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (c) => (out += String(c)));
child.stderr.on("data", (c) => process.stderr.write(String(c)));

const rpc = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create_routine", arguments: { instruction: "check the news", trigger: { type: "daily", time: "09:00" }, name: "Morning news" } } });
rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_routines", arguments: {} } });
await new Promise((r) => setTimeout(r, 1500));
rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "create_routine", arguments: { instruction: "bad", trigger: { type: "daily", time: "9am" } } } });
await new Promise((r) => setTimeout(r, 1200));
child.kill();

console.log("=== MCP OUTPUT ===");
for (const line of out.trim().split("\n")) {
  const msg = JSON.parse(line);
  const text = msg.result?.content?.[0]?.text;
  console.log(`id=${msg.id}`, text ? `\n${text}` : JSON.stringify(msg.result?.tools?.map((t) => t.name) ?? msg.result ?? msg.error));
}
console.log("=== STORE ===");
console.log(JSON.stringify(store.forBot(bot).map((r) => ({ name: r.name, next: r.nextRunAt })), null, 2));
process.exit(0);
