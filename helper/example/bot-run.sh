#!/bin/sh
# One run of the bench bot: `claude -p` in /workspace, the way a cron job would start it.
#
#   bot-run "<prompt>"                    a new conversation
#   bot-run --resume <session id> "<prompt>"   continue one (the same transcript file grows)
#
# BOT_MODEL picks the model the transcript records (the fake API echoes it). The two tools
# the fake API ever asks for are allowed and nothing else is; the run never waits on a
# prompt, because `-p` has nobody to ask.
set -eu
cd /workspace
# `--allowedTools` takes every argument after it, so it goes last, behind the prompt.
exec claude -p "$@" \
  --model "${BOT_MODEL:-claude-sonnet-5-5}" \
  --allowedTools 'Bash(npm test)' 'Bash(sleep:*)' < /dev/null
