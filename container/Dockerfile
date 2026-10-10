# syntax=docker/dockerfile:1.7
# Explainer render image. Build from repo root:  docker build -f container/Dockerfile -t explainer-container .
# Cloudflare Containers run linux/amd64.
FROM --platform=linux/amd64 node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PIP_BREAK_SYSTEM_PACKAGES=1
# System deps: python, git, ffmpeg, chromium (+ fonts for CJK), zsh/rsync (upstream scripts are zsh and use rsync),
# espeak-ng (kokoro G2P), tar, ca-certificates.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git ffmpeg chromium zsh rsync espeak-ng tar ca-certificates curl \
      fonts-noto-cjk fonts-noto-color-emoji fonts-liberation libgbm1 libnss3 libatk-bridge2.0-0 libgtk-3-0 libasound2 \
    && rm -rf /var/lib/apt/lists/*
# Python deps (edge-tts pinned: it tracks a Microsoft endpoint and breaks across upgrades)
RUN pip install 'edge-tts==7.2.8' numpy pillow scipy kokoro soundfile aider-chat
# Coding agent (Claude Code). No credentials baked in: the Worker injects them on the wire via AI Gateway.
RUN npm install -g @anthropic-ai/claude-code typescript remotion
# ---- Pinned Anything2Explainer (vendor/UPSTREAM_COMMIT) ----
COPY vendor/anything2explainer /opt/a2e
ARG UPSTREAM_COMMIT
RUN echo "${UPSTREAM_COMMIT:-unpinned}" > /opt/a2e/.pinned_commit
# Pre-warm npm cache from the template so `npm install` in new projects works with egress disabled.
RUN cd /opt/a2e/template && npm install --no-audit --no-fund && rm -rf node_modules/.cache
# Pre-bake Kokoro model + voice + spaCy model so runtime needs no network.
ENV HF_HOME=/opt/hf
RUN python3 - <<'PY'
from kokoro import KPipeline
import numpy as np
p = KPipeline(lang_code='a')
for v in ('am_liam', 'am_michael'):
    for _ in p("Warm up.", voice=v):
        pass
print("kokoro warmed")
PY
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    npm_config_offline=true \
    npm_config_prefer_offline=true \
    REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium \
    REMOTION_GL=swangle \
    A2E_DIR=/opt/a2e \
    WORKDIR=/work \
    RENDER_CONCURRENCY=4 \
    CLAUDE_CONFIG_DIR=/home/agent/.claude
# Runner
COPY container/runner /opt/runner
# Unprivileged user (Claude Code refuses --dangerously-skip-permissions as root)
RUN useradd -m -u 10001 agent && \
    cp -r /root/.npm /home/agent/.npm && \
    mkdir -p /work /home/agent/.claude && \
    chown -R agent:agent /work /home/agent /opt/a2e/template
USER agent
WORKDIR /work
EXPOSE 8080
CMD ["node", "/opt/runner/server.mjs"]
# force rebuild 6# force rebuild 7
# force rebuild 8
