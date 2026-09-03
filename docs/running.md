# Running it

Prerequisites in full, the module layout, configuration and the settings modal, the
LaunchAgent, Homebrew, the browser guard, backing up state, and removing the hook.

[README](../README.md) · [The panel](panel.md) · [The team](team.md) · **Running it**

## Prerequisites

Under Homebrew, `node`, `tmux` and `git` arrive as formula dependencies and `gh` is named
in the caveats rather than required; installing from a checkout, all of the below are
yours to provide. Either way, **Claude Code is not a Homebrew dependency** — it isn't
packaged there, and the panel is useless without it, so it stays a prerequisite you install
yourself.

- **macOS.** This is not portable and does not pretend to be. The launcher opens Terminal
  windows through `/usr/bin/osascript` and `/usr/bin/open -a Terminal`
  (`server/launch.js:264`, `server/launch.js:313`), the panel installs itself into
  `~/Library/LaunchAgents` (`server/install-agent.js:48`), and its logs are trimmed in
  `~/Library/Logs` (`server/logs.js:45`).
- **tmux, installed.** It is the session roster and the channel every keystroke goes
  through. It is resolved by absolute path — `/opt/homebrew/bin/tmux`,
  `/usr/local/bin/tmux`, `/usr/bin/tmux` (`server/tmux.js:51`) — because launchd hands a
  job a `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin` and tmux is in none of those.
- **Node ≥ 20** (`package.json`, `engines`). No build step and three runtime dependencies.
- **Claude Code**, on the `PATH` of a login shell. Sessions are started as
  `/bin/zsh -ilc claude` so your shell profile is sourced and any `claude()` wrapper you
  have keeps working (`server/launch.js:144`).
- **For a team on a GitHub-hosted repository: `gh`, logged in, plus `gh auth setup-git`
  once.** Both, not either — `gh`'s login is not git's, and without the second one a
  worker's plain `git push` fails. A team on any other host needs none of this; see
  [The forge](team.md#the-forge) for what you get instead.

**What it touches outside its own state directory.** Everything the panel itself owns lives
in one folder (see [Where the state lives](team.md#where-the-state-lives)), and nothing is ever
written into your repositories. Beyond that:

- It **reads** `~/.claude/projects/**` — the transcripts Claude Code already writes
  (`server/config.js:9`). Nothing here ever writes to that folder.
- It **reads** `~/.claude.json` for the MCP servers you have registered, which is how a
  team's forge is worked out (`server/config.js:20`, `server/forge.js:254`). Read only, and
  no credential is ever copied out of it.
- It **writes** `~/.claude/settings.json` once, at `npm run install-hook`, to register the
  status hook. The file is copied to a timestamped backup beside itself first, and
  registration only ever *appends* to the arrays already there, so other hooks are
  untouched (`server/install-hook.js:42`). `npm run uninstall-hook` removes it again.
- `npm run install-agent` **writes** `~/Library/LaunchAgents/<label>.plist` and bootstraps
  it. launchd then appends to two files in `~/Library/Logs`, which the panel trims itself at
  boot — see [Running it under launchd](#running-it-under-launchd). It also **removes** a
  plist in that directory that starts a copy of this same panel under a label it no longer
  uses, after backing it up into the state dir; a plist that starts anything else is never
  touched.

---

## Layout

```
server/
  index.js        HTTP + WebSocket, hook receiver, send/answer endpoints
  sessions.js     the roster: merge panes + transcripts, bind, diff
  binding.js      which pane is writing which transcript, and when to admit it can't tell
  tmux.js         pane roster, injection, TUI state scraping
  permission.js   parses the permission box off the pane; answers by option digit
  question.js     parses AskUserQuestion; plans the keys that answer it
  plan.js         parses the plan-approval box; answers by the option's own digit
  model.js        parses /model and the Switch model? box behind it; steps, never a digit
  effort.js       parses the /effort track; nudges the marker, then confirms
  queue.js        messages waiting for a pane to be ready, persisted
  claim.js        the lock between a message and a pane — nothing types without it
  pins.js         panes held at the top of the rail, persisted
  snapshot.js     the saved set of sessions, and putting it back
  groups.js       folders filed under names you chose, and whether each is folded
  launch.js       starting a session, ported from the other launcher on this Mac
  read-state.js   per-session read watermarks, persisted
  transcript.js   cheap metadata probe, and the offset-based tailer
  normalize.js    JSONL records -> view messages
  status.js       hook events -> state + pane bindings
  commands.js     the session's real slash commands, for completion
  files.js        file listing under a session's cwd, for `@` mentions
  uploads.js      pasted and dropped images and text files, saved and pruned
  images.js       every image in a transcript, for the per-session gallery
  git.js          what the shell wrapper would have named a session by default
  wrapper.js      when ~/.zshrc last changed, which dates the naming scheme
  config.js       ports, paths, windows, thresholds — and the resolved bind
                  host and session prefix
  settings-file.js  <STATE_DIR>/config.json — the bind host, the session prefix,
                    and the settings modal's validator, writer and loopback guard
                  and extra origins, read once at boot and seeded on the first one
  origin.js       which browser origins may write — a browser guard, not auth
  trigger.js      the trigger endpoint's allow-list, and the lead it resolves to
  install-hook.js one-shot settings.json registration
  install-agent.js the LaunchAgent installer — writes and bootstraps the plist
  logs.js         where launchd's log files are, and the boot-time trim that bounds them

  --- the team ---
  team.js         a team's folder on disk: config, toggles, decisions
  tasks.js        the task records and their states, persisted
  worktree.js     one checkout per task, branched from the base; setup, removal, prune
  setup-detect.js the worktree-prepare command, read off the repo's own files
  forge.js        GitHub / Gitea / push only / no remote, derived per repo
  base-branch.js  what this repo calls its default branch — detected, never typed
  dispatch.js     a worker's settings file, the git deny floor, the one trust gate
  room.js         the append-only per-team log, addressed and broadcast
  watch.js        worker transitions, stuck and looping detection, the lead's nudge
  conflicts.js    two workers touching one path — committed and uncommitted alike
  gc.js           boot housekeeping: prune worktrees, sweep cold failures
  deployed.js     merged, pulled, and actually running here — three different facts
  merge-queue.js  the PRs waiting on you, and the one sentence its button types
  lead-brief.js   what a lead is told it is, assembled at launch
  worker-brief.js the same for a worker, plus its task
mcp/
  foreman.js      the tool surface, over this panel's own API — one server, two roles:
                  a lead gets dispatch, read, send, room and the gated answering tools;
                  a worker gets exactly two, and can never touch another session
web/
  index.html  styles.css  app.js   (app.js: shared shell + rail, then a createPane factory)
  trust-gate.js   the one screen nothing may answer — the only web/ file server/ imports
  notify.js       what is worth interrupting somebody for, and when it became true
  manifest.webmanifest  m/manifest.webmanifest   two installable apps, two ids
  icons/          the mark, generated — never hand-edited
scripts/
  make-icons.mjs  the only description of the mark: one geometry, the SVG and every PNG
  backup-state.sh a copy of the state dir and the plist, before anything risky
```

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `FOREMAN_PORT` | `48770` | HTTP/WS port (48765 is the other launcher's — stay clear) |
| `FOREMAN_HOST` | `127.0.0.1` | bind address, and the top rung of the precedence below: `$FOREMAN_HOST` → `config.json`'s `bindHost` → `127.0.0.1`. Loopback by default everywhere, including under the LaunchAgent — the installer writes the resolved value into the job and **omits the key entirely when it is loopback**, so the panel is on the local network only if something said so. Read [SECURITY.md](../SECURITY.md) before widening it |
| `<FOREMAN_STATE_DIR>/config.json` | *(seeded)* | the panel's own settings file, holding `bindHost`, `sessionPrefix` and `allowedOrigins`. **Written by the panel at first boot** — never by hand, never rewritten — recording the host that boot was actually using, so a value that reached the panel through the environment survives the environment going away. Read **once at boot**: edit it and restart, and the `Config:` boot line says which file and which host. Absent or unparseable falls back to loopback, loudly |
| `FOREMAN_WINDOW_HOURS` | `48` | how far back a transcript counts as recent |
| `FOREMAN_STATE_DIR` | `~/.foreman` | queue, pins, groups, snapshot, read marks, and the team's state — teams, tasks, worktrees. Resolved `$FOREMAN_STATE_DIR` → `~/.foreman` if it is there → the directory an older build of this tool used if *that* is there → `~/.foreman`, and the `State:` boot line says which rung answered. Nothing is ever moved or copied between them. Point a test server elsewhere, and mean it: a second server on the real state dir runs its own worktree housekeeping against your real tasks |
| `FOREMAN_LOG_DIR` | `~/Library/Logs` | the directory the two launchd logs live in; the basenames stay derived from the job's label. It exists because a service manager that generates its own job definition is the only thing that knows where it pointed `StandardOutPath` — a second derivation of these paths, in a file this repository cannot read, is how a panel ends up trimming two files nobody writes to while the ones being appended to grow without bound. Set it in the job, not in your shell; the `Logs:` boot lines and `foreman-panel logs` both print what it resolved to |
| `config.json`'s `sessionPrefix` | `foreman-` | the prefix on every tmux session the panel mints, and the only prefix it recognises — `<prefix><folder>-<label>`. Read **once at boot** and printed on the `Config:` line. Must be lowercase `[a-z0-9-]`, start with a letter or digit and end with `-`; anything else is a boot warning and the default, never a panel that refuses to start. There is no environment override and no two-prefix mode — see "Session names" below for the one situation where you would change it |
| `FOREMAN_ALLOWED_ORIGIN` | *(none)* | extra browser origins the panel accepts writes from, comma- or space-separated (`http://host:port`). Added to whatever `config.json`'s `allowedOrigins` holds rather than replacing it. Loopback, this machine's own private-LAN addresses and its `.local` name are already allowed and need no entry — see "Which browsers may write to it" below |
| `FOREMAN_TRIGGER_TOKEN` | *(none)* | the shared secret `POST /api/trigger` checks. Checked first, then `<FOREMAN_STATE_DIR>/trigger-token` (one line, `chmod 600`, trailing newline trimmed) — the file is what lets the value survive a restart, since it's read fresh at every boot by every way of starting the panel. Neither one present means the endpoint answers **503 to everything**, not 401: the feature is off, not broken |

### The settings modal

`settings`, in the rail head beside `+ new`, is the panel's own view of that
`config.json`. It shows three things and writes two: the **bind host** — *this machine
only* (`127.0.0.1`), *every interface* (`0.0.0.0`, with what that costs stated beside it),
or a specific address you type — and the **extra browser origins** below it. The
**session prefix** is shown read-only, because changing it would unname every session
already running: they stay in the rail with no label, no duplicate button and no snapshot
entry.

Both writable settings are read **once at boot**, so the box says *takes effect at the
next restart (`npm run restart-panel`)* the moment you change one, and stays quiet when you
have not. On a machine where `$FOREMAN_HOST` is set — under launchd, that means the plist
carries the key — the environment beats the file, and the box says so in place rather than
letting you edit a value the running panel is ignoring: the file's value takes effect at
the next `npm run install-agent`, because `kickstart -k` does not re-read the job.

**Exposure is only changeable from the machine the panel runs on.** A `PATCH` touching the
bind host or the allowlist must arrive on a **loopback socket address** — checked on
`req.socket.remoteAddress`, never on the `Origin` header, and never on `X-Forwarded-For`.
The Origin check below allows a request with *no* `Origin` at all, by construction, so a
LAN peer holding `curl` passes it trivially; that is correct for everything else this panel
does and wrong for the two keys that decide who can reach it. Opened from a phone or
another machine, the modal draws those controls disabled with the reason, and a save
attempted anyway comes back `403` naming the address it saw. This is not authentication and
is not a step toward it — every other capability stays open to a LAN peer, deliberately;
what it may not do is widen its own reach.

**There is no credentials field and there never will be.** The forge is detected from the
repo's own `origin` and from what is registered in `~/.claude.json`, never typed in here: a
token sitting in a world-readable JSON behind a panel with no authentication is a worse
liability than any convenience it buys.

## Running it under launchd

`npm start` is the scratch-server command only — `FOREMAN_PORT=… FOREMAN_STATE_DIR=… npm start`,
unchanged on purpose, because pointing a second server at the real state dir sweeps real
worktrees and flushes the same `queue.json` a running panel already owns. The panel meant
to stay up runs as a LaunchAgent instead:

```
npm run install-agent                # once — writes the plist, bootstraps it
npm run install-agent -- --takeover  # the same, but stops a panel already on the port first
npm run restart-panel                # after any server/ change
npm run stop-panel                   # bootout — leaves the plist on disk
npm run uninstall-agent              # bootout, then backs up and removes the plist
```

The `--` before `--takeover` matters — without it, npm swallows the flag instead of
passing it through to the script.

**Installing displaces an older job of this panel's own, and says which.** A plist's
`ProgramArguments` is a *path*, not a name, so one written under a label this panel no
longer uses goes on starting `server/index.js` at every login — which after a rename is the
current code under a name nothing else knows about. Two jobs then race for one port, macOS
lets both binds succeed with no error from either, they split traffic by interface, and
`restart-panel` kickstarts whichever one is not holding it. So before it bootstraps
anything, `install-agent` looks through `~/Library/LaunchAgents` for plists that start a
`…/server/index.js` which either **no longer exists** (the checkout moved out from under it)
or **is this very file** by `realpath` — boots each one out, backs its plist up into the
state dir, removes it, and names it in the summary.

A plist whose program exists and is a *different* file is left strictly alone. That is what
makes it safe to run this installer from a git worktree, where `server/index.js` is a copy:
it stops there rather than booting out the job pointing at the real checkout.

**`restart-panel` and `install-agent` are not interchangeable.** `restart-panel` is
`launchctl kickstart -k`, which restarts the process but does **not** re-read the
plist — measured: a job's `EnvironmentVariables` was edited on disk, `kickstart -k`'d,
and the *old* value came back; only `bootout` + `bootstrap` (what `install-agent` does on
every reinstall) picks it up. So: changed something under `server/`? `restart-panel` —
the process re-imports its own files fresh, nothing about the job changed. Changed the
job itself — the host, the port, the injected `PATH`? `install-agent` again, never just a
restart. `web/` is read off disk on every request either way and needs neither command.

**Logs** land at `~/Library/Logs/foreman.log` and `…-error.log` — or wherever
`FOREMAN_LOG_DIR` says, if the job that started the panel set it. Whichever it is, the boot
prints both paths and `foreman-panel logs` prints them on their own. launchd appends to
both across every restart — it never truncates — so **the panel trims them itself, at
boot**: a log over its threshold is copied to `<name>.1` and truncated back to zero, and
the boot says so beside the `Triggers:` line. One previous copy is kept and overwritten
each time; there is no `.2` and no archive. The thresholds are 1 MB for stdout (a boot
writes 172 bytes, so a megabyte is thousands of them — over that, something is logging
that isn't the boot block) and 5 MB for stderr, which is about twelve hours of a measured
crash loop or two days of a once-per-poll error. That is a floor of 12 MB, flat.

It has to be a **truncate**, never a `mv`: launchd holds the log file open, so a renamed
log keeps receiving every line under its new name while the path you are tailing never
comes back. `test/logs.test.js` reproduces that failure before proving the fix.

Nothing runs on a timer — rotation happens once per boot, after the port probe (a panel
standing down must not touch the running one's logs) and before the panel prints anything
of its own. Started by hand with `npm start` there are no launchd logs at all, and it is a
no-op.

**Two panels can no longer share a port.** Two node servers — one bound to `0.0.0.0`, one
to `127.0.0.1` — used to both take port 48770 with no error and silently split traffic by
interface: your phone and your browser reaching two different panels, each running its
own worktree GC against your real tasks. The panel now probes `127.0.0.1:<port>` before
it starts listening and refuses to boot (exit 0, so launchd doesn't crash-loop it) if
anything already answers there — `npm start` while the LaunchAgent is up prints what it
found and exits cleanly instead of starting a second panel.

### Under Homebrew

A Homebrew install runs under `brew services` instead of `install-agent`/`restart-panel` —
same launchd underneath, different mechanism, and three things about it are worth knowing
before you reach for a command that doesn't apply:

- **`brew services restart foreman-panel` is both restart and reinstall.** It's `stop` then
  `start`, and `start` regenerates `~/Library/LaunchAgents/homebrew.mxcl.foreman-panel.plist`
  from the formula — the one command covers what `restart-panel` and `install-agent` are two
  separate commands for in a checkout.
- **A non-default port or state dir goes in an `.env` file, not the plist.**
  `~/.homebrew/services/foreman-panel.env` (`KEY=value` per line, mode `600` — Homebrew
  skips a group- or world-writable file and only warns), not
  `~/Library/LaunchAgents/homebrew.mxcl.foreman-panel.plist`.
- **`brew upgrade` does not restart the service.** The new version lands on disk; the old
  process keeps running until you `brew services restart foreman-panel` yourself.

## Which browsers may write to it

**A browser guard, not authentication.** The panel has no login and is not getting one: on
a machine that binds wide, anyone who can reach the port can still `curl` it, launch
sessions, type into any session and read every transcript. What this check buys is the
*browser* case — **a web page on some foreign site must not be able to make your own
browser act as a LAN peer.** Without it, any page you happened to be visiting could open a
WebSocket to the panel (a handshake is exempt from CORS and triggers no preflight), be
handed the roster of every session on the machine, and stream any conversation on it.

Every non-`GET` request and every WebSocket handshake is checked, in this order:

1. **No `Origin` header → allowed.** That is every non-browser caller — `curl`, the status
   hook, `mcp/foreman.js`, a webhook — and it is unaffected *by construction*, not by a list.
   Browsers set the header themselves and a page cannot remove or forge it.
2. **Loopback on any port → allowed** (`http://localhost:*`, `127.0.0.1:*`, `[::1]:*`).
3. **This machine's own private-LAN addresses at the panel's own port, plus
   `http://<LocalHostName>.local:<port>` → allowed.** Derived from the network interfaces
   at run time, so a new DHCP lease fixes itself and your phone keeps working with no list
   to maintain. RFC-1918 IPv4 and unique-local IPv6 only: link-local (`fe80::/10`,
   which includes AirDrop's `awdl0`/`llw0`) and `utun*` tunnels — where a VPN lands — are
   deliberately excluded.
4. **Anything else → `403`**, with a body naming the origin it refused.

`GET` is deliberately *not* checked: a cross-origin page can send one but cannot read the
response, because the panel never sends an `Access-Control-Allow-Origin` header.

The panel prints the origins it resolved at boot, one line each with the interface and the
reason, next to the `Triggers:` line. To add one — a reverse proxy, a tunnel you have
decided on — set `FOREMAN_ALLOWED_ORIGIN` to a full `http://host:port` (comma- or
space-separated for more than one) and restart.

## Backing up state

Everything the panel depends on that isn't in git — the state dir, the hook
registration, the LaunchAgent plist, `~/.claude.json`, and the repo's own uncommitted
work — in one archive, before a risky change or a switchover:

```
npm run backup-state
npm run backup-state -- --force          # even with the panel running
npm run backup-state -- --desktop-copy   # also drop a copy on ~/Desktop
npm run backup-state -- --verify <archive>
```

It **refuses while the panel is up** (an HTTP probe of `127.0.0.1:$FOREMAN_PORT`, the same
check the boot guard uses) — every store in `server/` is a Map behind a debounced flush,
so a live backup can capture a state dir mid-write. Stop it, run the backup, then bring it
back — the script itself prints the right pair, `npm run stop-panel` /
`npm run install-agent` from a checkout or `brew services stop foreman-panel` /
`brew services start foreman-panel` under Homebrew, detected the same way `foreman-panel`
itself detects its install. `--force` overrides the refusal and records in the manifest
that it did.

The archive lands at `~/foreman-backups/foreman-backup-<timestamp>.tar.gz`, mode `600`
in a `700` directory, **never** under this repo or inside a cloud-sync folder — it contains
`~/.claude.json`, which holds MCP credentials, so a synced path would push those off the
machine. It carries a `MANIFEST.txt` naming every source and whether it was captured or
missing (an absent `snapshot.json` is normal; an absent `tasks.json` is not), which
`--verify` reads back without extracting anything. The script never deletes or rotates
anything itself — if the folder grows, that's a call for whoever's backing things up, not
this script's.

Git already has the repo; what it doesn't have is what's sitting in the working tree.
`git diff HEAD` only covers tracked files, so a brand-new file nobody has `git add`ed yet
is copied in verbatim rather than diffed — otherwise it would silently never make it into
the archive at all.

## Removing the hook

```
npm run uninstall-hook
```

Registration only ever *appends* to the arrays in `~/.claude/settings.json`, and
backs the file up first, so existing consumers are untouched.

`npm run uninstall-agent` is the equivalent for the LaunchAgent — `launchctl bootout`,
then the plist is backed up (to `FOREMAN_STATE_DIR`, not beside itself) and removed.
