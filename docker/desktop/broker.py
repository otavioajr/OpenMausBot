#!/usr/bin/env python3
"""Input broker for a bot's isolated desktop.

Why this exists: the agent must be able to drive its own GUI (move, click,
type, screenshot) but must NOT be able to fight the human for the cursor.

The X server runs under the `desktop` user with an auth cookie that the agent
user (`ubuntu`) cannot read, so the agent has no direct X access at all. Its
only path to the desktop is this unix socket, which is the single choke point
where the control lock is enforced.

Protocol: one JSON object per line, one JSON response per line.
  {"op": "screenshot", "path": "/workspace/screen.png"}
  {"op": "click", "x": 100, "y": 200, "button": 1}
  {"op": "type", "text": "hello"}
  {"op": "key", "keys": "ctrl+l"}
  {"op": "move", "x": 10, "y": 20}
  {"op": "scroll", "amount": -3}
  {"op": "open", "url": "https://example.com"}
  {"op": "exec", "argv": ["xterm"]}          # launch a GUI app, detached
  {"op": "state"}                            # who holds control
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading

SOCKET_PATH = "/run/omb/input.sock"
LOCK_PATH = "/run/omb/human-control"
DISPLAY = os.environ.get("DISPLAY", ":1")
XAUTHORITY = os.environ.get("XAUTHORITY", "/home/desktop/.Xauthority")
GROUP_NAME = "botio"

ENV = {
    "DISPLAY": DISPLAY,
    "XAUTHORITY": XAUTHORITY,
    "HOME": "/home/desktop",
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8",
    # Keep GUI apps from trying to talk to a session bus that does not exist.
    "NO_AT_BRIDGE": "1",
}


def human_has_control() -> bool:
    return os.path.exists(LOCK_PATH)


def run(argv: list[str], timeout: int = 20) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv, env=ENV, capture_output=True, text=True, timeout=timeout, check=False
    )


def xdotool(args: list[str]) -> dict:
    if not shutil.which("xdotool"):
        return {"ok": False, "error": "xdotool missing"}
    proc = run(["xdotool", *args])
    if proc.returncode != 0:
        return {"ok": False, "error": (proc.stderr or proc.stdout).strip()[:400]}
    return {"ok": True, "output": proc.stdout.strip()[:400]}


def handle(req: dict) -> dict:
    op = str(req.get("op") or "")

    if op == "state":
        return {"ok": True, "control": "human" if human_has_control() else "bot"}

    # Screenshots are observation, never input: allowed even while the human
    # is driving, so the agent can still see what is happening.
    if op == "screenshot":
        path = str(req.get("path") or "/workspace/screen.png")
        if not path.startswith("/workspace/"):
            return {"ok": False, "error": "screenshots must be written under /workspace"}
        proc = run(["scrot", "-o", "-z", path], timeout=30)
        if proc.returncode != 0:
            return {"ok": False, "error": (proc.stderr or proc.stdout).strip()[:400]}
        try:
            os.chmod(path, 0o664)
        except OSError:
            pass
        return {"ok": True, "path": path, "bytes": os.path.getsize(path)}

    # Everything below is input and is blocked while the human holds control.
    if human_has_control():
        return {
            "ok": False,
            "error": "input locked: the human took control of this desktop. "
            "Wait and retry, or ask them to release control.",
            "control": "human",
        }

    if op == "move":
        return xdotool(["mousemove", "--sync", str(int(req.get("x", 0))), str(int(req.get("y", 0)))])

    if op == "click":
        button = str(int(req.get("button", 1)))
        if "x" in req and "y" in req:
            moved = xdotool(["mousemove", "--sync", str(int(req["x"])), str(int(req["y"]))])
            if not moved.get("ok"):
                return moved
        clicks = max(1, min(3, int(req.get("clicks", 1))))
        return xdotool(["click", "--repeat", str(clicks), button])

    if op == "type":
        text = str(req.get("text") or "")[:4000]
        return xdotool(["type", "--delay", str(int(req.get("delay", 12))), "--", text])

    if op == "key":
        keys = str(req.get("keys") or "").strip()
        if not keys:
            return {"ok": False, "error": "keys required"}
        return xdotool(["key", "--clearmodifiers", *keys.split()])

    if op == "scroll":
        amount = int(req.get("amount", -3))
        button = "4" if amount > 0 else "5"
        return xdotool(["click", "--repeat", str(min(10, abs(amount))), button])

    if op in ("open", "exec"):
        if op == "open":
            url = str(req.get("url") or "").strip()
            if not url.startswith(("http://", "https://", "file:///")):
                return {"ok": False, "error": "only http(s)/file urls can be opened"}
            argv = ["epiphany-browser", url]
        else:
            argv = [str(a) for a in (req.get("argv") or [])][:12]
            if not argv:
                return {"ok": False, "error": "argv required"}
        try:
            subprocess.Popen(
                argv,
                env=ENV,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                start_new_session=True,
            )
        except FileNotFoundError:
            return {"ok": False, "error": f"{argv[0]} is not installed in this desktop"}
        return {"ok": True, "launched": argv[0]}

    return {"ok": False, "error": f"unknown op: {op[:40]}"}


def serve_client(conn: socket.socket) -> None:
    with conn, conn.makefile("rwb") as stream:
        for raw in stream:
            try:
                req = json.loads(raw.decode("utf-8", "replace") or "{}")
                resp = handle(req)
            except json.JSONDecodeError:
                resp = {"ok": False, "error": "invalid json"}
            except subprocess.TimeoutExpired:
                resp = {"ok": False, "error": "desktop command timed out"}
            except Exception as exc:  # never kill the broker for one bad call
                resp = {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}
            stream.write((json.dumps(resp) + "\n").encode())
            stream.flush()


def main() -> int:
    os.makedirs("/run/omb", exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    # The agent user reaches the socket through the shared `botio` group only.
    try:
        import grp

        os.chown(SOCKET_PATH, os.getuid(), grp.getgrnam(GROUP_NAME).gr_gid)
    except (KeyError, PermissionError):
        pass
    os.chmod(SOCKET_PATH, 0o660)
    server.listen(16)
    sys.stderr.write(f"omb input broker listening on {SOCKET_PATH}\n")
    sys.stderr.flush()
    while True:
        conn, _ = server.accept()
        threading.Thread(target=serve_client, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    raise SystemExit(main())
