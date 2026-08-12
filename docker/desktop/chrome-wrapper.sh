#!/usr/bin/env bash
# Launch the official Google Chrome inside the bot's X desktop.
#
# The persistent profile lives in the container's capped writable layer, while
# cache goes under /tmp and is cleared on every wake. Keep the sandbox enabled
# by default; the build's E2E test proves whether namespace sandboxing works in
# the actual --cap-drop ALL / no-new-privileges runtime.
set -e
export HOME=/home/desktop
export DISPLAY="${DISPLAY:-:1}"
export XAUTHORITY="${XAUTHORITY:-/home/desktop/.Xauthority}"
# There is no session bus inside this single-purpose desktop. An invalid bus
# address makes Chrome fail fast instead of repeatedly probing dbus-launch.
export DBUS_SESSION_BUS_ADDRESS="disabled:"

# Chrome's setuid sandbox is incompatible with no-new-privileges, and its
# user-namespace sandbox is blocked by Docker's seccomp profile. The browser is
# already inside a non-root, cap-drop-ALL, private-network container; use that
# outer sandbox rather than weakening it just to enable Chrome's inner one.
exec /usr/bin/google-chrome-stable \
  --user-data-dir=/home/desktop/.config/google-chrome \
  --disk-cache-dir=/tmp/omb-chrome-cache \
  --disk-cache-size=104857600 \
  --no-sandbox \
  --no-first-run \
  --no-default-browser-check \
  --password-store=basic \
  --proxy-server=socks5://router:1080 \
  --disable-gpu \
  --disable-breakpad \
  --disable-crash-reporter \
  --disable-component-update \
  --disable-dev-shm-usage \
  --disable-software-rasterizer \
  --disable-features=Translate,MediaRouter,OptimizationHints \
  "$@"
