# Bots

The evidence behind the **Bots** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps index —
the helper that ships a headless deployment's transcripts, the store that keeps the panel's
copy, the routes and frames between them, the pane that draws it, and the bench that proves
any of it. Each section below is one trap, opening with the bold sentence its index line
quotes. What a deployment has to do is [`docs/bots.md`](../bots.md); this file is what bit
the people building the panel's side.

Versions: Claude Code **2.1.296** and Agent SDK **0.3.296** for the plan's measurements,
**2.1.296** and a pinned **2.1.263** in the reference container
([`helper/example/`](../../helper/example/README.md)), Docker 29.7.2, `node:22-slim` with
Node 22.23.3. Every measurement was taken against the sandbox (`alpha`, `beta`, `gamma`) or
a scratch panel; none against a real deployment's files.

## A claude -p run inside a panel session rebinds its row

**A `claude -p` run from inside a panel session's shell rebinds that session's row — and
then drops its binding.** The global hooks post `X-Tmux-Pane: $TMUX_PANE`, which a child
process inherits. `StatusEngine.ingest` binds the named pane to whatever `session_id` the
hook carries, and `SessionEnd` deletes the pane's binding — so a headless run started from
a worker's own shell would first claim that worker's row for its throwaway conversation and
then leave the row unbound when it exits. Read from `server/status.js`, and deliberately
*not* run against the real panel to confirm it.

So every bench that starts Claude Code on the host runs

```sh
env -u TMUX -u TMUX_PANE claude -p … --settings '{"disableAllHooks":true}' < /dev/null
```

or the SDK with `settingSources: []`; a scratch interactive session uses `--setting-sources
project` plus its own `--settings`. The `< /dev/null` is not decoration: `-p` otherwise waits
three seconds for stdin before it starts. Inside the reference container none of this
arises — no hooks are registered there and there is no tmux — which is one reason the
demonstrations run in a container at all. The scratch-panel half of the discipline (never
48770, `FOREMAN_HOST=127.0.0.1`, scratch label and log dir, kill by the listening socket) is
[exposure#two-node-servers-can-bind-the-same-port-at-once](exposure.md#two-node-servers-can-bind-the-same-port-at-once)
and [platform-launchd#a-scratch-tmux-server-unsets-tmux](platform-launchd.md#a-scratch-tmux-server-unsets-tmux).

## The reference container's two surprises

**`claude -p`'s `--allowedTools` takes every argument after it, and the request's last
message is not the prompt.** Both cost a round on the bench and both are facts about Claude
Code, not about this repo.

- `claude -p --allowedTools 'Bash(npm test)' 'Bash(sleep:*)' "<prompt>"` answers *Input must
  be provided either through stdin or as a prompt argument*: the option is variadic and ate
  the prompt as a third rule. `helper/example/bot-run.sh` puts the prompt first and the
  rules last.
- In 2.1.296 the request body's `messages` ends with a **`system`-role** message after the
  user's prompt (the environment block). A fake API that reads "the last message" sees no
  prompt and no tool result, and never asks for a tool. `fake-messages-api.mjs` reads the
  last *user* message.

## The 1m suffix is only in requestedModel

**The `[1m]` suffix is only in `requestedModel`.** MEASURED on 2.1.296: `--model
'claude-sonnet-5-5[1m]'` is recorded as `message.model: claude-sonnet-5-5` with
`requestedModel: claude-sonnet-5-5[1m]`, and the transcript's own `cost-state` carries no
`contextWindow` — so the window cannot be read from the file and a lookup by `message.model`
alone is 200k-wrong for a `[1m]` request on any model whose table entry is 200k.
`windowFor(model, requestedModel)` in `server/context-window.js` checks the suffix first.

**And an older Claude Code writes no `requestedModel` at all** — MEASURED on 2.1.263 in the
reference container: four assistant records, none carrying the field (2.1.296's four all
do). A `[1m]` request on such a version is invisible, and its percentage is computed against
the table's window. Nothing can fix that from the panel's side; it is why an unknown model
shows tokens and no percentage rather than a guess.

## One API response is several assistant records

**One API response is several assistant records, each with the same `usage`.** MEASURED, a
headless 2.1.296 run in `alpha`: five assistant records, one per content block, all sharing
one `requestId` and one `usage`. Summing usage across records counts one response five
times. "The latest qualifying record" is the rule (`contextOf`), and anything that counts
replies keys on content — text blocks, the `probe` rule — never on assistant records.

## rememberAgentFiles would let a bot choose what the panel reads

**`rememberAgentFiles` would let a bot's transcript choose which local file the panel
reads.** It adds every `result.agent.outputFile` it sees to `knownAgentFiles`, and
`/api/agent-run?file=` reads that path *on this Mac* through a `Tailer`. A bot's
`outputFile` is a path inside its own container (the shape on this Mac:
`/private/tmp/claude-<uid>/<cwd>/<session>/tasks/<id>.output`), and the path is whatever its
transcript says it is. The session `loadEarlier` handler calls it too, which is the other
reason bots have their own subscription map (`BotSubs`, `server/bot-subs.js`) rather than a
`kind` on the session one: a shared map is a shared `loadEarlier`. Subagent transcripts come
off `GET /api/bots/:bot/conversations/:cid/agent/:agentId`, a path the store builds from a
validated agent id. Pinned by `test/bots-api.test.js` ("a bot's outputFile is never
remembered for /api/agent-run").

## A Tailer follows a path, not a file

**A `Tailer` follows a path, not a file.** When a source shrinks or is replaced, the store
renames the copy to `<session>.jsonl.g<n>` and starts a new file at the same path. The
tailer's `#drain` sees `size < offset`, resets to 0, and *appends* the new file's messages
to what the browser already shows — two conversations spliced into one stream, silently. So
the store emits `reset {bot, cid}`, and `BotSubs` stops the old tailer and re-sends a whole
`bot` frame to every slot showing that conversation. Pinned by `test/bot-subs.test.js` ("a
reset re-sends the whole frame from the new copy, and the old tailer appends nothing").

## Every prompt in a bot is a user record and none of it is you

**Every prompt in a bot's transcript is a `type: 'user'` record and none of it is you.**
Cron text, a chat message the bot wrapped, an SDK `query()` — all `type: 'user'`, with
`promptSource: sdk`. This is
[transcript#a-type-user-record-is-not-proof-a-human-typed-anything](transcript.md#a-type-user-record-is-not-proof-a-human-typed-anything)
at full strength: drawn as the maintainer's own bubble, a bot's prompt would read as
something the maintainer typed. The bot pane passes `renderMessage` one options argument and
a `user` message is labelled **prompt**. Pinned by `test/bots-band.test.js`.

## Assistant markdown is raw HTML in a session

**Assistant text is `marked.parse` → `innerHTML` with raw HTML passed through.** marked
removed its `sanitize` option, and `buildMessage` renders a session's reply as-is. A bot
that quotes third-party chat text can put markup in its reply, so the bot pane renders
through the escaping `html` hook `briefHtml` already uses — and that renderer now also
drops the anchor from any link that is not `http(s)`, `mailto`, a fragment or a same-origin
path, leaving the text. Dev sessions have the same raw-HTML property today; that is out of
this feature's scope and recorded only. Pinned by `test/bots-band.test.js`.

## Images and subagent chips build per-session URLs

**Images and subagent chips build per-session URLs.** `imageStrip` and the agent chip
address `/api/sessions/:id/…`, which answers `404` for a bot's conversation id by design
(`test/bots-api.test.js` asserts every such route does). The bot pane hands them a URL
builder for `/api/bots/:bot/conversations/:cid/…` instead, and the agent route takes the
bare agent id. Large tool outputs Claude Code moved into a `tool-results/` file are not
shipped in phase 1; the transcript's own preview shows.

## A second WebSocketServer breaks the first

**A second `WebSocketServer` on the same `http.Server` breaks `/ws`.** In `ws` 8.21.3 every
server attached with `server:` sees every upgrade, and `shouldHandle` aborts a path that is
not its own with a `400` — so a second server for a helper channel would answer the panel's
own `/ws` upgrades with a refusal. The bots wire is plain HTTP for
exactly this reason, and phase 2's panel-to-bot direction is planned as a long-poll the
helper makes, not a socket. `test/bots-ingest.test.js` holds `/ws` and `/hook` unchanged
with the routes mounted.

## The global JSON parser would read an append sent as JSON

**The global `express.json` would not eat the append body — but only because of the
content type.** `app.use(express.json({limit: '2mb'}))` parses JSON types only, so an
`application/octet-stream` append passes it untouched to the route's own
`express.raw({limit: '5mb'})`, mounted *after* the token check so a stranger's body is never
buffered. An append that calls itself JSON is parsed by the global parser and refused rather
than stored — pinned by `test/bots-ingest.test.js`. The helper always sends octet-stream; a
second client written from the docs must too.

## Transcripts are 0600

**Transcripts are `0600`.** MEASURED: `-rw-------` with umask 022, project directories
`0755`, on the Mac and in the container. A helper running as any user but the one Claude
Code runs as lists the files and reads none of them. On a VM host this bites: a VM's login
user often mirrors the host's uid, which is unlikely to be a container's. `--check` counts
unreadable files per root and says which user to run as. The reference container runs both
Claude Code and the helper as the image's `node` user.

## Records without a timestamp

**Records without a `timestamp` are why "last active" reads the newest timestamped record,
never the last line and never a file's mtime.** `cost-state`, `last-prompt`, `ai-title`,
`mode` and `atis-latch` carry none. MEASURED: every invocation on 2.1.296 ends `last-prompt`,
`atis-latch`, `cost-state`, none of them timestamped; 2.1.263 ends `last-prompt`, likewise
without one. Retention reads the same record clock, and arrival time is used only for a
file with no timestamped record at all.

## Finished needs a cost-state record

**`finished` is read off a closing `cost-state` record, and Claude Code 2.1.263 writes
none.** MEASURED in the reference container: 2.1.296 closes every `claude -p` invocation and
every resume with `cost-state` (and the SDK closes every `query()` the same way); 2.1.263's
runs end on `last-prompt` with no `cost-state` anywhere. On such a version a conversation is
`active` for 60 s after its last append and `idle` after that — never `finished` — and two
runs within a minute read `2 active` after both have exited. Everything else in those
records renders: prompt, tool call with its result, reply, model, effort, and a Haiku 4.5
context against its 200k window.

## Two roots can share one project-dir name

**Two roots can share one project-dir name, so a conversation id seen under a second root is
refused, never merged.** A deployment with one config directory per agent group launches
every group in the same container path, so every group writes the same project folder (the
name comes from the launch cwd — the
[binding#a-transcripts-cwd-moves](binding.md#a-transcripts-cwd-moves) folder rule). The
copy's path keeps the root label, so those are separate files; but a `cid` is the
conversation's identity in every route, so the same id arriving under a second root is a
`409` *without* a numeric `size`, which the helper can never read as "resume from here" —
it skips that file, once, and says so. Pinned by `test/helper.test.js` and
`test/bots-helper.test.js`; proven live by a deployment shipping two labelled roots that
share one project name.

## A spelling that differs only in case

**A root, project or agent spelling that differs from one already held only in case is
refused**, because the default macOS disk is case-insensitive and would append two sources
into one copy — a corruption no `sha256` would catch until the copy was compared with
either source. `#caseClash` refuses it the same way as a duplicate `cid`: `409`, no `size`.
The bot id itself is lowercase-only for the same reason. Pinned by `test/bots.test.js`.

## Concurrent appends to one conversation

**Two resumes of one conversation at once interleave in the source, and the copy interleaves
identically.** The copy is byte-identical by construction, so whatever Claude Code wrote is
what the panel shows. Not the panel's to fix, and not measured — recorded so nobody reads an
interleaved transcript as a shipping bug.

## read.prune runs every poll

**`read.prune(liveIds)` runs every poll** (`server/sessions.js`) — any read watermark kept
for a bot in `read.json` would be deleted two seconds later. Phase 1 keeps no unread state
for bots at all (nothing about them asks for attention), and phase 2 must not borrow that
store for one.

## Stores drop what they do not know

**`bots.json` and every `index.json` carry unknown keys through on rewrite.** `TaskStore`
deletes a record with an unknown state and `GroupStore` drops unknown fields
([team-machinery#an-unknown-task-state](team-machinery.md#an-unknown-task-state),
[rail-and-groups#groupstore-drops-an-unknown-field](rail-and-groups.md#groupstore-drops-an-unknown-field));
phase 2 will add fields to both bot files, and a rollback past it must not erase them. An
unparseable `bots.json` is refused rather than written over. Pinned by `test/bots.test.js`.

## Sizes

**A trivial run is about 120 KB on current Claude Code, and most of it is a snapshot of the
system prompt.** MEASURED: the plan's runs 123–162 KB with `prompt_snapshot` 47–66 KB; the
reference container's 2.1.296 runs 115–120 KB, of which the two runs' `prompt_snapshot`
attachments were 178,614 bytes together. 2.1.263 writes no snapshot: its runs were 13–15 KB.
gzip takes a run 4.5×. Thousands of conversations over 90 days is plausibly gigabytes in the
state dir and in every `backup-state` archive (which names `bots.json` and `bots` in
`KNOWN_STATE_ITEMS`). Disk use is shown per bot in the settings list; compression was
deferred until there are real numbers.

## Liveness has no event

**Liveness has no event.** A helper that dies sends nothing, so nothing would ever tell the
band. The store runs its own unref'd 15 s timer, flips `helper.online` false 90 s after the
last hello, and emits `change` — or the band would show a dead helper as fine forever.
Pinned by `test/bots.test.js`.

## A restarted helper waits out the instance window

**A restarted helper waits out the 90-second instance window before it ships again.** Every
helper process is a new `instance`, and `hello` refuses a different instance for 90 s after
the previous one's last hello, so two helpers can never ship one bot at once — which means a
restart is indistinguishable from a second helper until the old one has been quiet for 90 s.
MEASURED in the reference container, killing the helper mid-run: refused `409` at 07:36:30,
online at 07:38:10 (100 s, the old instance's last hello plus 90 s plus the backoff step);
after `docker rm` and a fresh container, 92 s. Nothing is lost — the copy lags, then
catches up sha256-identical. A restarted *panel* has no such wait: it remembers no instance,
and the same helper reconnects on its next backoff step (5 s after the panel was back, on
the bench). Accepted when the
store was built, since it only delays; a goodbye on shutdown would remove it and is not in
protocol v1.

## A panel that stands down must not prune

**A panel that finds its port taken must not prune, so the store's timers start after the
single-instance probe.** `BotStore` used to run its first retention pass in the constructor,
at module load — before `index.js` probes the port and exits if another panel answers. A
second panel started by mistake against the real state dir would delete the running panel's
copies on its way out and print into its log. The store is now constructed with `timers:
false` and `bots.start()` runs in the boot block beside the other housekeeping, after the
probe and the log rotation. Pinned by `test/bots-ingest.test.js`: a squatted port and a
200-day-old conversation leave the copy, the index and `bots.json` byte-identical, and the
same boot with the port free prunes it.

## A registry check on misses alone never sees a removal

**A registry re-read on an auth miss picks up `bots add`; only a re-read on a hit as well
picks up `bots remove`.** The CLI writes `bots.json` from another process. Checking it only
when a token fails to verify is how a new registration reaches a running panel — but a
revoked token still verifies against the registry in memory, so it would keep being accepted
until the next restart. `botAuth` re-reads on both, each at most once every 2 s (by mtime,
size and inode). Pinned by `test/bots-ingest.test.js`.

## Register against the panel's own state dir

**`bots add` writes the registry of the state dir *its own* environment resolves.** It
follows the same four rungs the panel does (`resolveStateDir`), from the shell it is typed
in — so a panel whose job sets `FOREMAN_STATE_DIR` and a `bots add` typed without it write
two different `bots.json`, and every request from that bot is a `401` with no refusal in
the settings list (the panel records refusals only for bots it knows). The `FOREMAN_URL`
port it prints is the CLI's own `FOREMAN_PORT` the same way. By construction, not measured.
It prints a real `host.docker.internal` address rather than a `<placeholder>` because the
output is meant to be loaded as an env file, and a shell reads `<` as a redirect.

## Retention prunes the copy, not the source

**Retention prunes the panel's copy, never the source, and the helper keeps no memory of
what was pruned.** So a pruned conversation whose source is still on disk comes back whole at
the helper's next manifest. MEASURED on the scratch panel with `FOREMAN_BOT_RETENTION_DAYS`
set to minutes: the boot prune removed exactly the conversations past the cutoff (their
files and index entries; every other file in the state dir byte-identical); a helper whose
container still held two of the pruned sources re-sent them in full on its next reconnect,
`1 of 2 local files to ship`, and the copies were back, sha256-identical, with their old
timestamps — due to be pruned again at the next retention run. A helper that neither
restarts nor fails never refetches the manifest, so in between the copy stays gone.
Harmless while a deployment's own cleanup (Claude Code's default is about 30 days) deletes
sources well inside the panel's 90; with `cleanupPeriodDays` above 90, old conversations
flicker. `docs/bots.md` says so beside the contract's "any `cleanupPeriodDays` is fine".

## A rebase cannot be pushed from a worker

**A worker cannot push a rebased branch, so it brings `main` in with a merge.** Force-push is
in `GIT_DENY` (`server/dispatch.js`) for every worker, and a rebased branch that was already
pushed needs one. Items 4 and 5 of the bots build both edited `server/index.js` in parallel;
item 4, holding a pushed branch when item 5 merged, merged `main` into its branch rather
than rebasing (`Merge main (item 5, PR #194) into bots-4-ingest-routes`), and that merge is
what reached `main`. Plan for it when two workers share a file: the second gets a merge
commit, not a linear history.
