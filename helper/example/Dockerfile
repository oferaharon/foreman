# The reference bot — a bench kit, never a real deployment. See README.md.
#
# Build from the repo root, with the project the bot works in as the `workspace` context:
#
#   docker build -f helper/example/Dockerfile \
#     --build-context workspace=<a small project> \
#     -t foreman-bench-bot helper
#
# CLAUDE_CODE_VERSION pins the Claude Code the bot runs, so an older one's transcripts can be
# checked against the panel too.
FROM node:22-slim

ARG CLAUDE_CODE_VERSION=2.1.296
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# The helper: one file, no dependencies, copied in exactly as it is in the repo.
COPY foreman-helper.mjs /opt/foreman/foreman-helper.mjs
# Bench only: the fake Messages API, and the scripts that run the bot.
COPY example/fake-messages-api.mjs /opt/bench/fake-messages-api.mjs
COPY example/bot-run.sh /usr/local/bin/bot-run
COPY example/entrypoint.sh /usr/local/bin/bot-entrypoint
RUN chmod 755 /usr/local/bin/bot-run /usr/local/bin/bot-entrypoint

# The project the bot works in. Owned by the user Claude Code runs as, which is also the user
# the helper runs as: transcripts are written 0600, so only that user can ship them.
COPY --from=workspace --chown=node:node . /workspace

USER node
WORKDIR /workspace

# Claude Code talks to the fake API inside this container and nothing else. The proxy is a
# dead end on purpose: any HTTPS call that was not redirected — to a real account's API above
# all — fails instead of leaving the container. The helper speaks plain HTTP to the panel and
# is not affected.
ENV ANTHROPIC_BASE_URL=http://127.0.0.1:8790 \
    ANTHROPIC_API_KEY=bench-fake-key-not-a-credential \
    HTTPS_PROXY=http://127.0.0.1:9 \
    https_proxy=http://127.0.0.1:9 \
    NO_PROXY=127.0.0.1,localhost,host.docker.internal \
    no_proxy=127.0.0.1,localhost,host.docker.internal \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1 \
    FOREMAN_WATCH=main=/home/node/.claude/projects

ENTRYPOINT ["bot-entrypoint"]
