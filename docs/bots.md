# Bots

[README](../README.md) · [The panel](panel.md) · [The team](team.md) · [Running it](running.md) · **Bots**

A **bot** is a deployed agent the panel watches but does not run: a cron job calling
`claude -p`, a chat bridge that spawns it per message, an Agent SDK loop in a VM. None of
them has a terminal for the panel to read, so a small **helper** runs beside each one,
copies every transcript line Claude Code writes to the panel as it is written, and the
panel keeps its own copy for 90 days. Each deployment is one row in the rail's **bots**
band; opening it lists its conversations — each cron run, each chat thread — newest first,
and any one of them in full, with the model, effort and context of the newest reply.

Phase 1 is **read-only**: no composer, no buttons, nothing that asks for attention. A bot
cannot be typed to, closed, pinned or filed in a group, and it never enters the session
roster (see [The panel side](#the-panel-side)).

![The bots band with three bench bots, each row's age right-aligned, and one of them open in the main pane and selected in the rail: its conversation list, the selected run's prompt, its Bash calls and its report, and the read-only line where a composer would be.](images/bots.png)

What follows is the contract a deployment meets, how to register one, how to check it, and
what the panel does with what it receives. The evidence behind the rules is in
[`docs/traps/bots.md`](traps/bots.md); the reference container that every rule below was
demonstrated against is [`helper/example/`](../helper/example/README.md), a bench kit that
no real deployment uses.

---

## The deployment contract

**A deployment takes part when all of the following hold.**

1. **One helper per deployment.** Copy `helper/foreman-helper.mjs` from the Foreman release
   tag that matches the panel. It is one file with no dependencies and needs Node ≥ 22. A
   protocol mismatch is refused loudly (`426`), never half-works.
2. **Run it where it can read every conversation file.** Claude Code writes one file per
   conversation under `<config dir>/projects/<project>/<session-id>.jsonl`, where `<config
   dir>` is `$CLAUDE_CONFIG_DIR` if set, else `~/.claude` of the user Claude Code runs as.
   Three placements work:
   - **inside the container that runs Claude Code**, as a second process beside the bot;
   - **a sidecar** that mounts the same `projects` directory read-only;
   - **on the VM or host** that holds the config directory, when Claude Code runs in
     short-lived containers that bind-mount it from there.
3. **Run it as the user that owns the files.** Claude Code creates transcripts with mode
   `0600` regardless of umask. A helper running as any other user sees nothing — check uids
   when the helper runs outside the container (a VM's login user is often not the
   container's user).
4. **Tell it where to look.** `FOREMAN_WATCH=<label>=<projects dir>[;<label>=<projects
   dir>…]`. A path may contain one `*`; whatever it matches becomes that root's label (for
   one config directory per agent group, user or tenant). Labels appear in the panel next
   to each conversation.
5. **Tell it where the panel is.** `FOREMAN_URL=http://<panel host>:<port>`,
   `FOREMAN_BOT=<bot id>`, `FOREMAN_BOT_TOKEN=<token>`. Get the id and token by running
   `foreman-panel bots add <bot id>` on the panel's machine. The token is a secret: put it
   in an env file or secret store, never in the image. Its purpose is to keep scratch and
   test helpers out of the real panel; it is not authentication.
6. **Network: outbound only.** The helper opens no port and needs only outbound TCP to the
   panel's port. From a Docker Desktop container on the panel's own machine,
   `host.docker.internal` reaches the panel even when it listens on loopback only. From
   anywhere else, the panel must listen on an address you can reach, and any firewall
   between (a VM's own firewall included) must allow outbound to that port.
7. **Keep it running.** Start it with the bot and restart it if it exits (the bot's own
   supervisor, `systemd`, or the container's entrypoint). It keeps no state of its own: on
   every start it asks the panel what it already has and sends only the rest, so restarts
   and rebuilds need nothing migrated.
8. **Keep Claude Code writing transcripts.** Never pass `--no-session-persistence` (no file
   is written, so there is nothing to ship). Any `cleanupPeriodDays` is fine — the helper
   ships within seconds and the panel keeps its own copy for 90 days.
9. **What is not needed.** No tmux, no hooks, no status line, no published ports, no Docker
   socket, no credentials of the panel's. Do not register the panel's `/hook` or `/status`
   URLs in a deployment.
10. **Check it.** `node foreman-helper.mjs --check` prints whether the panel is reachable,
    whether the token is accepted, which roots matched and how many files the panel still
    lacks, then exits. If the bot still does not appear, the panel's settings list shows
    when its helper was last seen and the last refusal.
11. **Later (two-way, not yet built):** the deployment will provide one entry point that
    accepts a message from the panel into the bot's own inbox — see the panel docs when it
    lands.

### What the contract does not say, and a deployment should know

- **Until the next release, copy the helper from `main`, not from a tag.** Item 1's release
  tag does not exist yet: **v0.4.0 predates the helper**, so no tag carries the file. Copy
  it from the commit your panel runs (`git -C <panel checkout> show
  HEAD:helper/foreman-helper.mjs > foreman-helper.mjs`). It reports itself as `0.4.0`,
  because its version string follows `package.json` — which still reads `0.4.0` — not the
  tag that shipped it. Every helper copied so far is the same file, unchanged since it was
  merged.
- **A restarted helper waits up to 90 seconds before it ships again.** Every start is a new
  instance, and the panel refuses a different instance for 90 s after the last hello of the
  one before it, so two helpers can never ship one bot at once. A restart or a rebuild is
  `409` and one `down: another helper instance …` line, then catches up on its own — nothing
  is lost, the panel's copy just lags by that long. Measured on the bench: 100 s and 92 s.
- **"Any `cleanupPeriodDays` is fine" holds while the source dies first.** Retention prunes
  the panel's copy, never the source, and the helper has no memory of what was pruned: a
  conversation the panel dropped at 90 days whose source file is *still on disk* is shipped
  again, whole, at the helper's next start or reconnect — and pruned again at the next
  retention run. Claude Code's default cleanup (about 30 days) never lets that happen; a
  `cleanupPeriodDays` above 90 makes old conversations flicker in and out of the panel.
- **On a Claude Code that writes no `cost-state` record, a conversation is never
  "finished".** `finished` is read off that closing record, which 2.1.263 does not write
  (2.1.296 closes every `claude -p` invocation and every SDK `query()` with one). Such a
  conversation shows `active` for 60 s after its last line and `idle` after, never
  `finished` — measured with the reference container pinned to 2.1.263, whose records
  otherwise render in full.

---

## Registering a bot

On the panel's machine, as the user the panel runs as:

```sh
foreman-panel bots add <bot id> --name "<what the rail calls it>" > bot.env
# from a checkout:  node bin/foreman-panel.js bots add <bot id> --name "…" > bot.env
```

- The id is lowercase letters, digits and dashes, starts with a letter, at most 32
  characters. It is the folder name under the panel's state dir and the `:bot` in every
  route, so it cannot be renamed — remove it and add another.
- **`bots add` prints three lines on stdout and nothing else there** — `FOREMAN_URL`,
  `FOREMAN_BOT`, `FOREMAN_BOT_TOKEN` — and everything a human reads on stderr, so `>
  bot.env` leaves a file the deployment can load as it is. **The token is shown this once**;
  the panel stores only its sha256.
- **Never paste the token anywhere that is logged**: not a room, not a chat, not an issue,
  a commit, a PR or a terminal transcript you will share. Move the file into the
  deployment's env file or secret store, never into the image. If it leaked, `bots remove`
  and `add` again.
- **Register against the state dir the panel reads.** The CLI resolves its state directory
  exactly as the panel does, from its own environment: a panel started with
  `FOREMAN_STATE_DIR` (in its launchd job, a Homebrew env file, or a scratch shell) needs
  the same variable on the `bots add` command, or the registration lands where that panel
  never looks and every request is `401`. The same goes for the port printed in
  `FOREMAN_URL`, which is the CLI's own `FOREMAN_PORT`.
- `FOREMAN_URL` is printed as `http://host.docker.internal:<port>`, right for a Docker
  Desktop container on the panel's own Mac. From anywhere else, replace the host with an
  address of the panel's machine that the deployment can reach.
- **A running panel needs no restart.** It re-reads `bots.json` when the file changes, at
  the next request a helper makes (each check at most every 2 s) — so a new registration is
  accepted, and a removed one refused, within a couple of seconds.

`foreman-panel bots list` shows what is registered (never a token). `foreman-panel bots
remove <id>` revokes the token; the bot's copies stay in the state dir and age out like any
other, 90 days after each conversation's last record.

---

## Checking it: `--check`

Run it where the helper runs, with the same environment:

```
$ node foreman-helper.mjs --check
foreman-helper 0.4.0 --check (protocol v1)
panel        http://host.docker.internal:48770  reachable
token        accepted for bot alpha-bot
roots        main  /home/node/.claude/projects  2 files
panel lacks  0 of 2 files
result       ok
```

| Line | Says | If it is wrong |
| --- | --- | --- |
| `panel` | whether anything answers at `FOREMAN_URL` | `unreachable (ECONNREFUSED)`, a timeout: the address, the panel's bind, or a firewall between — contract item 6 |
| `token` | whether the panel accepts `FOREMAN_BOT` + `FOREMAN_BOT_TOKEN` | `refused`: a typo, a removed bot, or a registration made against another state dir |
| `roots` | each `FOREMAN_WATCH` root, its label and its file count | `not found` / `matches nothing`: the path or the glob; `(N unreadable: …)`: the helper is not the user that owns the files (item 3) |
| `panel lacks` | files the panel does not hold yet, or holds shorter or different | non-zero while the helper is running and not waiting: see the settings list below |

`--check` exits `0` on `result ok` and `1` otherwise. It never says hello, so running it
beside a live helper cannot fight it for the bot. A root that is `not found` before the bot
has run once is normal: Claude Code creates `projects/` on its first conversation, and the
helper picks it up when it appears.

---

## When a bot does not appear: the settings Bots list

The settings modal (the gear in the rail head) has a read-only **Bots** list with one block
per registered bot, from `GET /api/bots`. It is there so a deployment that is not showing
up is visible rather than silent — the band itself never goes red.

| Field | Means |
| --- | --- |
| `helper` | `online — seen …`, `offline — last seen …` (no hello for 90 s), or `never seen` |
| `instance`, `since` | the helper process now reporting, and since when |
| `version`, `host` | the helper's own version and the hostname it runs on |
| `roots` | the labels and paths its last hello reported |
| `conversations` | how many the panel holds, and how many are active |
| `disk` | what this bot's copies take in the panel's state dir |
| `last refusal` | the last request the panel refused for this bot: status, reason, when |

Reading it:

- **`never seen`, no refusal** — no helper has reached this panel with this bot's id. The
  network, `FOREMAN_URL`, or a registration made against a different state dir (the panel
  only records refusals for bots *it* knows).
- **`last refusal 401 wrong token`** — the right bot id with the wrong token. `bots remove`
  and `add` again if the token is lost; it is not shown twice.
- **`last refusal 409 another helper instance …`** — either two helpers are shipping one
  bot (two containers, a sidecar and an in-container copy), or one just restarted and is
  waiting out the 90 s window. The second clears itself; the first never does.
- **`last refusal 426`** — the helper speaks a protocol this panel does not. Copy the
  helper from the panel's own commit.
- **`online` but `0` conversations** — the helper is fine and finds nothing: the roots are
  wrong, empty, or unreadable to its user. `--check`'s `roots` line says which.
- **`offline — last seen …`** — the helper stopped. Its supervisor (item 7) should have
  restarted it.

Each refusal is also one line on the panel's stderr — `[bots] refused <bot> from <address>:
<reason> (<status>)` — printed once per bot, address and reason, never into a room.

---

## The panel side

### Not in the roster

**A bot is not a session and never enters the session roster.** It rides the roster frame
as a sibling field, `bots`, exactly the way rooms do, so nothing that walks the session list
— the inbox, notifications, pins, groups, snapshot, relaunch, `/exit`, the queue, read
state — is ever handed one. There is nothing to type into: a bot has no pane, and every
`/api/sessions/:id/…` route answers `404` for a bot's conversation id. Bots have their own
routes (`/api/bots/…`), their own socket frames (`subscribe-bot`, `bot`, `bot-messages`,
`bot-earlier`, `bot-conversations`) and their own subscription map.

### The band and the pane

The **bots** band sits below the session list and above the rooms band, drawn only when at
least one bot is registered. One two-line row per bot, ordered by last activity:

- line 1: a dot, the name, and — right-aligned, as the rooms band shows a room's — when the
  bot was last active. The dot pulses while a conversation is active and is **grey** while
  the helper is offline. Never red: red means "needs you", and a bot whose helper stopped
  needs a look at the settings list, not an alarm;
- line 2: the **newest reply's** model · effort · ctx, plus `N active` when more than one
  conversation is. All three facts come from one record; two conversations' contexts are
  never summed or maxed.

Opening a row puts the bot in the **main pane**, where a session's conversation opens: it
replaces what that pane shows, the row takes a session row's selected marker, and clicking a
session row switches back. Split view treats a bot as it treats a session, and a reload puts
it back. (Rooms are the other kind: they open beside the main pane and never replace a bot.)
Its head shows the helper's
state and the newest reply's model, effort and ctx; its body lists the conversations (title,
root label, active / finished / idle, model · effort · ctx, when it started) and shows the
selected one's transcript — prompts labelled **prompt** rather than drawn as your own
bubble, because none of them is you, and the bot's markdown rendered through the escaping
renderer. Images and subagent transcripts come off the bot routes. Where a composer would be,
a line says the pane is read-only.

### Context

The panel computes `ctx` itself, from the token counts every reply records — the same rule
Claude Code uses for its own `ctx:` figure: the newest assistant record that has usage
(skipping synthetic, error and unmetered ones), its last `usage.iterations` entry if it has
any, `input + cache_creation + cache_read` (output excluded), against the model's window.
Claude Code does not write the window into the transcript, so the panel carries a table of
measured windows (`server/context-window.js`); a `[1m]` request widens it to 1,000,000, and a
model the table does not know shows its tokens (`41k`) with no percentage rather than a
guessed one. A model the panel launches nothing on still gets a display name
(`server/worker-models.js`), so the row reads `Haiku 4.5`, not a raw id.

### The copy

Everything lives under the panel's resolved state directory:

| Path | What |
| --- | --- |
| `bots.json` | the registry: id, name, the token's sha256, when it was created. Mode `600`; unknown keys are carried through on every rewrite |
| `bots/<bot>/<root>/<project>/<session>.jsonl` | each conversation, **byte-identical** to the source and append-only |
| `bots/<bot>/<root>/<project>/<session>/subagents/agent-<id>.jsonl` | its subagents |
| `bots/<bot>/<root>/<project>/<session>.jsonl.g<n>` | an earlier generation, set aside when a source shrank or was replaced |
| `bots/<bot>/index.json` | a cache of the conversation list, rebuilt from the copies whenever it disagrees with them |

- A chunk lands only at an offset equal to the copy's size, and the helper sends components
  (root label, project folder, session id, agent id), never a path — the panel builds every
  path itself from validated parts. That is what makes restarts and retries idempotent and
  the copy identical: `sha256` of the copy equals `sha256` of the source.
- **Retention is 90 days from each conversation's last timestamped record** — Claude Code's
  own clock, what the pane calls "last active" — and arrival time only for a file with no
  timestamped record at all. It runs at boot and every 6 hours, removes the conversation's
  file, its subagents and its generations together, and prints one line with the counts.
  `FOREMAN_BOT_RETENTION_DAYS` exists for benches only.
- **The copies hold everything the transcripts hold**, including, on current Claude Code,
  the full system prompt snapshot each run records — most of a trivial run's 115–160 KB.
  Per-bot disk use is in the settings list. `backup-state`
  archives them with the rest of the state dir, deliberately: past the deployment's own
  cleanup, the panel's copy is the only record.
- A panel that finds its port already taken stands down **before** the store's first prune,
  so a second panel started by mistake never deletes the running one's copies.

### The wire

The helper dials out; the panel never connects to a deployment. Protocol v1, plain HTTP,
every request carrying `Authorization: Bearer <token>`:

| Request | Answers |
| --- | --- |
| `POST /api/bots/:bot/hello` — `{v, instance, helperVersion, host, roots, files}`, at start and every 30 s | `200` · `401` unknown bot or wrong token (one answer for both) · `409 {since}` another instance said hello within 90 s · `426 {supported}` |
| `GET /api/bots/:bot/manifest` | `200 {v, files: [{root, project, session, agent, size, headLen, head}]}` |
| `POST /api/bots/:bot/append?root=&project=&session=&agent=&offset=&reset=` — `application/octet-stream`, at most 4 MiB, ending on a newline | `200 {size}` · `409 {size}` the offset is not the copy's size · `400` a bad component · `413` too big |

The read side — `GET /api/bots`, `GET /api/bots/:bot/conversations`, and the image and
subagent routes under `/api/bots/:bot/conversations/:cid/` — is not token-gated, like every
session transcript the panel serves. [`SECURITY.md`](../SECURITY.md) states what both halves
mean for who can reach what.

### Two-way: not built

Phase 2 would let a message reach a bot the way its chat messages do — into its own inbox,
through the helper, never typed into a terminal — with each deployment building the entry
point that receives it. None of it exists yet; contract item 11 is the placeholder.
