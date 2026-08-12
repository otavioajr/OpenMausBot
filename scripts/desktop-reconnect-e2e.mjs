// Prove that a dropped disposable VNC bridge can reconnect to the same desktop.
// The UI performs the same sequence automatically: disconnect -> new ticket -> RFB.
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:8799";
const botId = process.argv[2];
if (!botId) throw new Error("usage: node desktop-reconnect-e2e.mjs <botId>");

const wsBase = BASE.replace(/^http/, "ws");
const ticket = async (reconnecting) => {
  const response = await fetch(`${BASE}/api/bots/${botId}/desktop/ticket?wake=${reconnecting ? "0" : "1"}`);
  const body = await response.json();
  if (!response.ok || !body.url) throw new Error(body.error ?? `ticket ${response.status}`);
  return body.url;
};

const connect = async (label, reconnecting = false) => {
  const url = await ticket(reconnecting);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${url}`);
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 20_000);
    socket.once("message", (data) => {
      clearTimeout(timer);
      const banner = Buffer.from(data).subarray(0, 12).toString();
      if (banner !== "RFB 003.008\n") return reject(new Error(`${label}: bad RFB banner ${JSON.stringify(banner)}`));
      console.log(`${label}_RFB_OK`);
      resolve(socket);
    });
    socket.once("error", reject);
  });
};

const first = await connect("FIRST");
// Drop the bridge from the host, the way a lost `docker exec` would: the
// container, X11 and Chrome stay healthy, only the disposable pipe dies.
const { execFileSync } = await import("node:child_process");
const container = `omb-bot-${botId}`;
const pids = execFileSync("docker", ["top", container, "-eo", "pid,args"], { encoding: "utf8" })
  .split("\n")
  .filter((line) => line.includes("socat - TCP:127.0.0.1:5901"))
  .map((line) => line.trim().split(/\s+/)[0]);
if (pids.length === 0) throw new Error("no live bridge to drop");
execFileSync("kill", ["-9", ...pids]);
console.log(`BRIDGE_DROPPED pids=${pids.join(",")}`);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("first bridge did not close")), 20_000);
  first.once("close", () => {
    clearTimeout(timer);
    console.log("FIRST_CLOSED");
    resolve();
  });
});
const second = await connect("SECOND", true);
second.close();
console.log("RECONNECT_OK");
