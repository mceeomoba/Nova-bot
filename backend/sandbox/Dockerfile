# Minimal, purpose-built sandbox image for agent exec.
# Not a general-purpose dev image — only what the agent actually needs.
# Extend deliberately; every extra tool is extra attack surface.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      git \
      curl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. UID/GID fixed so file ownership matches predictably
# between host bind mount and container.
RUN groupadd -g 10001 agent && useradd -u 10001 -g agent -m -s /bin/bash agent

WORKDIR /workspace
RUN chown agent:agent /workspace
USER agent

# No ENTRYPOINT/CMD — this container stays alive via `tail -f /dev/null`
# (set in docker.ts) and commands are injected with `docker exec`.
