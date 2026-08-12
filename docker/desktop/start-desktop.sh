#!/usr/bin/env bash
# Bring up the bot's graphical desktop.
#
# PID 1 runs as the unprivileged `desktop` user (see Dockerfile USER). That is
# deliberate: with --cap-drop ALL a root PID 1 has neither CAP_SETUID nor
# CAP_DAC_OVERRIDE, so it could neither drop privileges nor manage its own
# runtime dir. Starting as `desktop` keeps zero capabilities AND avoids root
# entirely. The agent user (`ubuntu`) still cannot read this user's X cookie,
# so the input broker remains the only path from agent to GUI.
set -euo pipefail

DISPLAY_NUM="${OMB_DISPLAY:-1}"
SCREEN="${OMB_SCREEN:-1440x900x24}"
export DISPLAY=":${DISPLAY_NUM}"
export XAUTHORITY=/home/desktop/.Xauthority
export HOME=/home/desktop

# A fresh boot must not inherit a stale control lock or socket.
rm -f /run/omb/human-control /run/omb/input.sock 2>/dev/null || true

# X lock/socket files live in the writable layer, so a stopped-then-started
# container still has them and Xvfb refuses to boot ("Server is already active
# for display 1"). Nothing from the previous run is alive at this point — PID 1
# has just started — so clearing them is safe and required for wake to work.
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" 2>/dev/null || true

# Fresh auth cookie for this boot; the file itself is created at build time.
truncate -s 0 /home/desktop/.Xauthority
COOKIE="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
xauth -f /home/desktop/.Xauthority add "${DISPLAY}" . "${COOKIE}" >/dev/null

log() { printf '[desktop] %s\n' "$*"; }

log "starting Xvfb on ${DISPLAY} (${SCREEN})"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -auth /home/desktop/.Xauthority \
  -nolisten tcp -dpi 96 >/var/log/omb/xvfb.log 2>&1 &

for _ in $(seq 1 60); do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then break; fi
  sleep 0.25
done
xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 || { log "Xvfb failed"; cat /var/log/omb/xvfb.log; exit 1; }

log "starting window manager"
fluxbox -no-slit >/var/log/omb/fluxbox.log 2>&1 &

# Wallpaper + no screen blanking. hsetroot renders the generated gradient;
# xsetroot is the fallback so the root window is never plain black.
xsetroot -solid "#242e52" >/dev/null 2>&1 || true
if command -v hsetroot >/dev/null 2>&1 && [ -f /usr/share/backgrounds/omb.png ]; then
  hsetroot -cover /usr/share/backgrounds/omb.png >/dev/null 2>&1 || true
fi
xset -dpms >/dev/null 2>&1 || true
xset s off >/dev/null 2>&1 || true

# Chrome: menu bar on top, dock at the bottom, compositor for soft shadows.
# Every piece here is cosmetic and started best-effort — a missing binary or a
# bad config must never keep the desktop (or the agent) from coming up.
if command -v tint2 >/dev/null 2>&1; then
  log "starting top bar and dock"
  tint2 -c /home/desktop/.config/tint2/topbar.conf >/var/log/omb/tint2-top.log 2>&1 &
  tint2 -c /home/desktop/.config/tint2/dock.conf >/var/log/omb/tint2-dock.log 2>&1 &
fi
if command -v picom >/dev/null 2>&1; then
  # --no-vsync: there is no real display to sync to under Xvfb, and vsync
  # would just add latency to the VNC stream.
  picom --backend xrender --no-vsync >/var/log/omb/picom.log 2>&1 &
fi

log "starting input broker"
python3 /opt/omb/broker.py >/var/log/omb/broker.log 2>&1 &

# VNC binds to loopback only: there is no published port and no listener on
# any network. The harness reaches it through `docker exec` + socat, so the
# desktop stays unreachable from anywhere else, including other containers.
log "starting VNC on 127.0.0.1:5901"
x11vnc -display "${DISPLAY}" -auth /home/desktop/.Xauthority \
  -localhost -rfbport 5901 -nopw -shared -forever -noxdamage \
  -ncache 0 -wait 10 -defer 10 >/var/log/omb/x11vnc.log 2>&1 &

# A terminal on screen from the start: the desktop should never look empty.
# Positioned clear of the top bar (26px) and the dock. lxterminal is themed via
# ~/.config/lxterminal; xterm stays as the fallback on minimal builds.
# Everything below is cosmetic. Wrapped so that no styling failure can take
# down the container: the agent's shell must work even on an ugly desktop.
set +e
sleep 0.5
if command -v lxterminal >/dev/null 2>&1; then
  # `--geometry=WxH` is silently ignored by lxterminal (it wants the X form),
  # which left the window at 10x10. Size/position are set with the WM instead,
  # so this works regardless of the terminal's own flag parsing.
  lxterminal >/dev/null 2>&1 &
  # `set -e` is on: a failing/empty command substitution here would kill PID 1
  # before "ready", so every step is guarded. Cosmetics must never break boot.
  win=""
  for _ in $(seq 1 40); do
    win="$(xdotool search --class lxterminal 2>/dev/null | head -1 || true)"
    if [ -n "${win}" ]; then break; fi
    sleep 0.25
  done
  if [ -n "${win}" ]; then
    xdotool windowsize "${win}" 880 540 >/dev/null 2>&1 || true
    xdotool windowmove "${win}" 90 70 >/dev/null 2>&1 || true
  fi
else
  xterm -geometry 100x28+40+60 -fa Monospace -fs 11 \
    -bg "#101317" -fg "#e6e6e6" -title "bot terminal" >/dev/null 2>&1 &
fi

log "ready"
# PID 1 stays alive; the agent's real work arrives via `docker exec`.
exec tail -f /dev/null
