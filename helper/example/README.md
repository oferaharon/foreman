# The reference bot — a bench kit, not a deployment

**Nothing real runs this.** It is a throwaway container that shows the shape the deployment
contract asks for ([`docs/bots.md`](../../docs/bots.md)) and that the panel's bots
demonstrations were run against. It talks to a **fake Messages API** inside the container,
so it holds no account and spends nothing; its replies come from a script, not from a
model. A real deployment copies `helper/foreman-helper.mjs` into its own image and runs it
beside its own bot — it never copies this directory.

| File | What it is |
| --- | --- |
| `Dockerfile` | `node:22-slim` + Claude Code (pinned by `CLAUDE_CODE_VERSION`, default `2.1.296`) + the helper, unmodified + a small project to work in |
| `entrypoint.sh` | the three processes: the fake API, the helper in a respawn loop (contract item 7), and `claude -p` on a cron-style loop |
| `bot-run.sh` | one run, as cron would start it: `bot-run "<prompt>"`, or `bot-run --resume <session id> "<prompt>"` |
| `fake-messages-api.mjs` | **bench only.** Answers `POST /v1/messages` with the Messages API's SSE sequence (`message_start` → `content_block_start` / `delta` / `stop` → `message_delta` → `message_stop`): a `Bash` call (`npm test`, or `sleep N` when the prompt says so) and then a short reply quoting what it printed |

Claude Code runs as the image's `node` user, and so does the helper — transcripts are
written `0600`, so the helper must be the user that owns them (contract item 3). Every HTTPS
call that `ANTHROPIC_BASE_URL` does not redirect is sent to a dead proxy, so nothing in the
container can reach a real API even by mistake; the helper speaks plain HTTP to the panel
and is unaffected.

## Building it

From the repo root, with any small project as the `workspace` build context (the bench used
a copy of a throwaway sandbox repo with an `npm test`):

```sh
docker build -f helper/example/Dockerfile \
  --build-context workspace=<a small project> \
  -t foreman-bench-bot helper

# an older Claude Code, to check its transcripts render too
docker build -f helper/example/Dockerfile \
  --build-arg CLAUDE_CODE_VERSION=2.1.263 \
  --build-context workspace=<a small project> \
  -t foreman-bench-bot:2.1.263 helper
```

## Running it against a scratch panel

Never against the panel you use. A scratch panel has its own port and its own state dir
(see `CLAUDE.md`'s *Working here*); register the bot against **that** state dir:

```sh
FOREMAN_STATE_DIR=<scratch state dir> FOREMAN_PORT=<scratch port> \
  node bin/foreman-panel.js bots add alpha-bot --name "Alpha bench bot" > bot.env

docker run -d --name foreman-bench-alpha --env-file bot.env -e BOT_EVERY=0 foreman-bench-bot
docker exec foreman-bench-alpha node /opt/foreman/foreman-helper.mjs --check
docker exec foreman-bench-alpha bot-run "Run the tests and say whether they pass."
docker exec -e BOT_MODEL=claude-haiku-5-5 foreman-bench-alpha bot-run "sleep 15, then the tests"
```

`bot.env` holds the token: keep it out of the image and out of anything logged. From Docker
Desktop on the panel's own Mac, `host.docker.internal` reaches a panel bound to loopback, and
arrives as `127.0.0.1`.

| Variable | Default | |
| --- | --- | --- |
| `FOREMAN_URL`, `FOREMAN_BOT`, `FOREMAN_BOT_TOKEN` | — | from `bots add`, via `--env-file` |
| `FOREMAN_WATCH` | `main=/home/node/.claude/projects` | set in the image |
| `BOT_EVERY` | `600` | seconds between scheduled runs; `0` runs only what you `docker exec` |
| `BOT_PROMPT` | `Run the tests and say whether they pass.` | what a scheduled run is asked |
| `BOT_MODEL` | `claude-sonnet-5-5` | what the transcript records; the fake API echoes it |

Remove the containers and the images when you are done: `docker rm -f <name>`,
`docker rmi foreman-bench-bot …`.
