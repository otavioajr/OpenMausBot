# Self-hosted per-bot containers

OpenMausBot can use the host VPS as a free alternative to `box.ascii.dev`.

## Behaviour

| Bot setting | Runtime |
|---|---|
| unset / Local | Provider runs directly on the host VPS |
| Cloud / Isolated | Codex runtime runs inside a persistent per-bot container |
| Off | No computer environment is selected |

An isolated environment is created when Cloud is selected (or lazily on the
first turn), then parked. Every turn wakes it; completion parks it again. Stop
preserves `/workspace` and Codex sessions. Deleting the bot removes the agent,
credential proxy, writable layer, and both networks before deleting bot state.

## Resource limits

Defaults (overridable by environment):

```ini
OMB_DOCKER_COMPUTERS=true
OMB_DOCKER_CPUS=1
OMB_DOCKER_MEMORY=2g
OMB_DOCKER_PIDS=512
OMB_DOCKER_STORAGE=10G
OMB_DOCKER_IMAGE=openmausbot-box:latest
OMB_DOCKER_PROXY_IMAGE=openmausbot-router-proxy:latest
```

Containers are named deterministically: `omb-bot-<bot-id>`.

## Security model

```text
agent container (no real key, no direct internet)
        |
        | private --internal network
        v
read-only credential sidecar (128 MB / 0.25 CPU)
        |
        | separate per-bot egress network
        v
9router /v1 API
```

The agent:

- runs as uid 1000 (`ubuntu`), not root;
- has all Linux capabilities dropped and `no-new-privileges`;
- has no Docker socket or host mounts;
- has a hard CPU/RAM/PID/storage ceiling;
- has no direct internet or access to the host/default Docker bridge;
- never receives `NINEROUTER_API_KEY` in argv, environment, image, or filesystem.

The sidecar:

- is stateless and recreated on every wake (key rotation applies immediately);
- has a read-only root filesystem, no workspace, no published port, and no
  Docker socket;
- accepts only `GET`/`POST` under `/v1/*` and injects the real credential
  upstream;
- is attached to the agent's internal network plus its own egress network.

The Codex CLI in the agent receives only a dummy `BOT_ROUTER_KEY`; shell tools
use a strict environment allowlist.

## Build images

```bash
cd ~/projects/openmausbot/app/docker
docker build -t openmausbot-box:latest .
docker build -f Dockerfile.proxy -t openmausbot-router-proxy:latest .
```

Images are shared across all bots. Per-bot data lives in the container's capped
writable layer and disappears with `docker rm`.

## Operations

```bash
# managed environments
docker ps -a --filter label=openmausbot.bot-id \
  --format 'table {{.Names}}\t{{.Status}}'

# state through the API
curl -s http://100.85.198.61:8799/api/bots/<bot-id>/computer

# park now
curl -s -X POST http://100.85.198.61:8799/api/bots/<bot-id>/computer/sleep

# service
systemctl --user status openmausbot
systemctl --user restart openmausbot
```

On startup, the harness removes environments whose bot no longer exists and
parks valid environments left running by a prior crash.

## Current limitation

The self-hosted environment is terminal-only. There is no graphical desktop,
screenshot stream, or browser/VNC panel yet. Computer-use can be added later
without changing the lifecycle contract.

The agent has no direct outbound internet by design. Model access works through
the private sidecar. Controlled git/npm/web egress can be introduced later via
an allowlisted proxy if required.

## Verification performed

- Full TypeScript typecheck.
- Full suite: 97 tests across 12 files.
- Production Vite build.
- Docker lifecycle: create, stop, wake, persistence, destroy.
- Secret audit: real key absent from agent inspect, environment, and exported
  filesystem.
- Network audit: agent only on internal network; sidecar on internal + egress.
- Real model call through sidecar returned `PONG`.
- API E2E: first turn created a file, second turn read it after wake, bot delete
  removed agent, sidecar, internal network, and egress network.
- Production smoke test: provisioned and parked an existing Cloud bot without
  sending a user message.
