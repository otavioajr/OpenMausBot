// E2E of the live desktop path, exercising exactly what the browser does:
// ticket -> WebSocket -> RFB handshake -> control lock.
import WebSocket from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:8901";
const bot = process.argv[2];
if (!bot) throw new Error("usage: node desktop-e2e.mjs <botId>");

const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

const ticket = await api(`/api/bots/${bot}/desktop/ticket`);
console.log("ticket status:", ticket.status);
console.log("ticket control:", ticket.body.control, "| url:", ticket.body.url?.slice(0, 40));
if (!ticket.body.url) {
  console.log("ERRO:", JSON.stringify(ticket.body));
  process.exit(1);
}

// The browser opens exactly this URL. A real RFB banner proves the whole
// chain: token -> ws -> docker exec -> socat -> x11vnc.
const framed = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:8901${ticket.body.url}`);
  let banner = null;
  let bytes = 0;
  ws.on("message", (data) => {
    bytes += data.length;
    if (!banner) {
      banner = data.subarray(0, 12).toString();
      // Answer the handshake so the server keeps streaming real frames.
      ws.send(Buffer.from("RFB 003.008\n"));
    }
  });
  ws.on("error", (e) => resolve({ error: String(e.message) }));
  setTimeout(() => {
    ws.close();
    resolve({ banner, bytes });
  }, 2500);
});
console.log("stream:", JSON.stringify(framed));

// Control lock, end to end.
const take = await api(`/api/bots/${bot}/desktop/control`, {
  method: "POST",
  body: JSON.stringify({ control: "human" }),
});
console.log("take control ->", take.status, JSON.stringify(take.body));

const shot = await api(`/api/bots/${bot}/desktop/screenshot`);
console.log("screenshot while human holds control ->", shot.status, shot.body.image ? "image ok" : JSON.stringify(shot.body));

const give = await api(`/api/bots/${bot}/desktop/control`, {
  method: "POST",
  body: JSON.stringify({ control: "bot" }),
});
console.log("give back ->", give.status, JSON.stringify(give.body));
