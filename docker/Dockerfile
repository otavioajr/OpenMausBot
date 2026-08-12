# Imagem base dos "computadores" dos bots (alternativa local ao box.ascii.dev).
# Uma imagem compartilhada por todos os bots; cada bot ganha seu proprio
# container + volume, destruidos quando o bot e' deletado.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/ubuntu \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/ubuntu/.local/bin

RUN apt-get update -qq && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git jq unzip zip passwd \
      python3 python3-pip python3-venv \
      ripgrep tree less nano vim-tiny \
      procps iputils-ping dnsutils \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# Node LTS via nodesource (o do apt e' antigo demais para tooling moderno)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm config set update-notifier false \
    && npm install -g @openai/codex@0.130.0

# A imagem oficial Ubuntu 24.04 ja traz o usuario nao-root `ubuntu` (uid 1000).
# Reutiliza-lo evita criar um segundo uid e limita o estrago de comandos
# destrutivos ao proprio container/volume.
RUN mkdir -p /workspace \
    && mkdir -p /home/ubuntu/.codex \
    && chown -R ubuntu:ubuntu /workspace /home/ubuntu

COPY --chown=ubuntu:ubuntu codex-config.toml /home/ubuntu/.codex/config.toml

USER ubuntu
WORKDIR /workspace

# Mantem o container vivo sem consumir CPU. O trabalho real entra via
# `docker exec`; este PID 1 so existe para o container ter estado "running".
CMD ["sleep", "infinity"]
