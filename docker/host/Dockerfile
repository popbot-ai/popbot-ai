# popbot-host in a container: Node, git, and the claude / codex CLIs
# around the single-file daemon. Build context is the repo root with the
# daemon already bundled (npm run build:host → dist-host/popbot-host.cjs);
# the image never installs the app's dependencies.
#
#   docker build -f docker/host/Dockerfile -t popbot-host .
#   docker run -d --name popbot-host -p 127.0.0.1:7677:7677 \
#     -v popbot-host-data:/data -v /srv/repos:/repos \
#     -v ~/.claude:/home/popbot/.claude -v ~/.codex:/home/popbot/.codex \
#     popbot-host --repo myrepo=/repos/myrepo --slots myrepo=4
#
# The first start writes /data/config.json and prints its token; PopBot
# takes the published address and that token in Preferences ▸ Hosts.
# Sign-ins are the mounted ~/.claude and ~/.codex of a user who ran
# `claude` and `codex login` once (on macOS, export the Claude sign-in
# with `security find-generic-password -s "Claude Code-credentials" -w`
# into .claude/.credentials.json).
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl procps \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force \
  && useradd --create-home --uid 1001 --shell /bin/bash popbot \
  && mkdir -p /data /repos /app \
  && chown -R popbot:popbot /data /repos /app

COPY --chown=popbot:popbot dist-host/popbot-host.cjs /app/popbot-host.cjs
COPY --chown=popbot:popbot docker/host/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

USER popbot
WORKDIR /home/popbot
# The daemon finds the CLIs through a login shell.
ENV SHELL=/bin/bash \
    HOME=/home/popbot \
    POPBOT_LOG_DIR=/data/logs \
    NODE_ENV=production
VOLUME ["/data", "/repos"]
EXPOSE 7677
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS -o /dev/null http://127.0.0.1:7677/v1/info -H "Authorization: Bearer $(node -e 'try{process.stdout.write(require("/data/config.json").token)}catch{process.stdout.write("")}')" || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
