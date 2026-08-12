// Tiny per-bot 9router sidecar. The agent container never receives the real
// API key; it only sees this proxy on its private Docker network. The proxy has
// no workspace, no Docker socket and no published host port.
import { createServer } from "node:http";
import { Readable } from "node:stream";

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM = (process.env.ROUTER_UPSTREAM || "https://rs4v44i.abc-tunnel.us").replace(/\/$/, "");
const KEY = process.env.NINEROUTER_API_KEY || "";

const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(KEY ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: Boolean(KEY) }));
  }
  if (!KEY) {
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "router credential unavailable" }));
  }
  // This is a model-API credential broker, not a generic same-origin proxy.
  // Restrict both path and methods to the OpenAI-compatible API surface.
  if (!req.url?.startsWith("/v1/") || !["GET", "POST"].includes(req.method || "")) {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value || ["host", "connection", "content-length", "authorization", "x-api-key"].includes(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("authorization", `Bearer ${KEY}`);

    const upstream = await fetch(`${UPSTREAM}${req.url || "/"}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      signal: AbortSignal.timeout(10 * 60_000),
      redirect: "manual",
    });

    const outHeaders = {};
    upstream.headers.forEach((value, name) => {
      if (!["connection", "transfer-encoding", "content-length", "content-encoding"].includes(name)) outHeaders[name] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`router proxy on :${PORT}`));
