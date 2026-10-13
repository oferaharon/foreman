#!/bin/sh
# The reference bot's entrypoint: three processes, the shape the deployment contract asks for.
#
#   1. the bench's fake Messages API (bench only — a real deployment talks to the real API);
#   2. the helper, beside the bot, restarted whenever it exits (contract item 7);
#   3. the bot itself: `claude -p` on a cron-style loop.
#
# BOT_EVERY   seconds between scheduled runs; 0 turns the loop off, so runs only happen
#             when started by hand with `docker exec <container> bot-run "<prompt>"`
# BOT_PROMPT  what a scheduled run is asked
set -eu

trap 'kill 0 2>/dev/null; exit 0' TERM INT

node /opt/bench/fake-messages-api.mjs &

(
  while :; do
    node /opt/foreman/foreman-helper.mjs &
    echo $! > /tmp/foreman-helper.pid
    wait $! || true
    echo "entrypoint: the helper exited; starting it again in 2 s" >&2
    sleep 2
  done
) &

every="${BOT_EVERY:-600}"
if [ "$every" -gt 0 ]; then
  (
    while :; do
      bot-run "${BOT_PROMPT:-Run the tests and say whether they pass.}" >/dev/null 2>&1 || echo "entrypoint: a scheduled run failed" >&2
      sleep "$every"
    done
  ) &
fi

# `wait` returns when a trapped signal arrives, which is what lets `docker stop` end this
# promptly rather than after its ten-second kill.
while :; do wait; sleep 1; done
