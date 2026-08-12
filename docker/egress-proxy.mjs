// Minimal SOCKS5 egress proxy for the graphical browser.
//
// The agent container stays attached only to its --internal network. Chrome
// points at this sidecar for normal web browsing; the sidecar resolves names,
// rejects every non-public address (including Tailscale, Docker/private ranges
// and cloud metadata), and connects to ports 80/443 only. This preserves the
// original isolation property while making the browser useful.
import dns from "node:dns/promises";
import net from "node:net";

const blocks = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT and Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) blocks.addSubnet(address, prefix, "ipv4");

for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
]) blocks.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  // Node can return IPv4-mapped IPv6. Normalise it so private IPv4 does not
  // bypass the IPv4 block list through ::ffff:127.0.0.1.
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return !blocks.check(mapped[1], "ipv4");
  return !blocks.check(address, family === 6 ? "ipv6" : "ipv4");
}

async function publicDestination(hostname) {
  const literal = net.isIP(hostname);
  const answers = literal
    ? [{ address: hostname, family: literal }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  // Reject the whole hostname if ANY answer is private. Besides being stricter,
  // this closes split-horizon/DNS-rebinding names that mix public+private IPs.
  if (!answers.length || answers.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("destination is not public");
  }
  return answers[0];
}

function fail(socket, code = 0x02) {
  if (!socket.destroyed) socket.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function parseRequest(buffer) {
  if (buffer.length < 4) return null;
  if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) throw new Error("unsupported SOCKS request");
  const atyp = buffer[3];
  let host;
  let offset;
  if (atyp === 1) {
    if (buffer.length < 10) return null;
    host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
    offset = 8;
  } else if (atyp === 3) {
    if (buffer.length < 5) return null;
    const length = buffer[4];
    if (length < 1 || buffer.length < 7 + length) return null;
    host = buffer.subarray(5, 5 + length).toString("utf8");
    offset = 5 + length;
  } else if (atyp === 4) {
    if (buffer.length < 22) return null;
    const parts = [];
    for (let i = 4; i < 20; i += 2) parts.push(buffer.readUInt16BE(i).toString(16));
    host = parts.join(":");
    offset = 20;
  } else {
    throw new Error("unsupported address type");
  }
  const port = buffer.readUInt16BE(offset);
  return { host, port, consumed: offset + 2 };
}

export function startSocksProxy(port = Number(process.env.SOCKS_PORT || 1080)) {
  const server = net.createServer((client) => {
    client.setTimeout(60_000, () => client.destroy());
    let phase = "hello";
    let pending = Buffer.alloc(0);
    let connecting = false;

    const processInput = async () => {
      if (connecting) return;
      if (phase === "hello") {
        if (pending.length < 2) return;
        const count = pending[1];
        if (pending.length < 2 + count) return;
        const methods = pending.subarray(2, 2 + count);
        pending = pending.subarray(2 + count);
        if (pending[0] === 0) return fail(client, 0x01);
        if (!methods.includes(0)) return client.end(Buffer.from([5, 0xff]));
        client.write(Buffer.from([5, 0])); // no-auth; network itself is private
        phase = "request";
      }
      if (phase !== "request") return;
      let request;
      try {
        request = parseRequest(pending);
      } catch {
        return fail(client, 0x07);
      }
      if (!request) return;
      pending = pending.subarray(request.consumed);
      if (![80, 443].includes(request.port)) return fail(client, 0x02);
      connecting = true;
      client.pause();
      try {
        const destination = await publicDestination(request.host);
        const upstream = net.createConnection({ host: destination.address, port: request.port });
        upstream.setTimeout(60_000, () => upstream.destroy());
        upstream.once("error", () => fail(client, 0x05));
        upstream.once("connect", () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (pending.length) upstream.write(pending);
          client.pipe(upstream);
          upstream.pipe(client);
          client.resume();
        });
      } catch {
        fail(client, 0x02);
      }
    };

    client.on("data", (chunk) => {
      if (pending.length + chunk.length > 64 * 1024) return client.destroy();
      pending = Buffer.concat([pending, chunk]);
      void processInput();
    });
    client.on("error", () => {});
  });
  server.listen(port, "0.0.0.0", () => console.log(`public-web SOCKS proxy on :${port}`));
  return server;
}

if (process.env.EGRESS_PROXY_STANDALONE === "1") startSocksProxy();
