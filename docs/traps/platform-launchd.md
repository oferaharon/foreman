# launchd

The evidence behind the **launchd** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps index —
facts about this machine rather than about a file in this repo, which is why they are filed
under the tool's name and not a path: the plist, the label's three copies, the job's `PATH`,
the log rotation, the state dir's four rungs and Homebrew's own rename. Each section below
is one trap, opening with the bold sentence its index line quotes.

## `launchctl kickstart -k` does not re-read the plist

**`launchctl kickstart -k` does not re-read the plist — VERIFIED.** A job was
bootstrapped, its `EnvironmentVariables` edited on disk, then `kickstart -k`'d — the
process came back holding the *old* value; only `bootout` + `bootstrap` picked up the
change. `npm run restart-panel` is `kickstart -k` and is correct for anything under
`server/`, because the process re-imports its own files fresh and nothing about the job
changed. A change to the job itself — the host, an env var, the injected `PATH` — needs
`npm run install-agent` again, and `install()` (`install-agent.js`) always `bootout`s a
live job before it `bootstrap`s a new one for exactly this reason: a reinstall that only
kickstarts is a reinstall that did nothing. It is also why the trigger token
(`config.js`'s `TRIGGER_TOKEN_FILE`) lives in a file under `STATE_DIR` rather than in the
plist's `EnvironmentVariables` — rotating a plist-held secret would hit this same trap,
silently keeping the old value alive through the documented restart.

## launchd's `PATH`

**launchd's `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — VERIFIED.** Bare
`git` works (`/usr/bin/git` ships with macOS); bare `node` and bare `tmux` do not. tmux is
resolved absolutely for that reason (`tmuxPath()`, in `tmux.js`, memoised); the plist's
injected `PATH` (`jobPath()` in `install-agent.js`) is still
load-bearing beyond that, because `runSetup` (`worktree.js`) shells a worktree's prepare
command — typically `npm install` — through `exec()` with the inherited environment, and
fails
*quietly*: `{ok: false}`, a line under `worker-logs/`, dispatch carries on as if nothing
happened. `jobPath()` builds the injected `PATH` from the installing shell's own `PATH`
plus the Homebrew/local/system directories, deduped, with npm's own `node_modules/.bin`
chain filtered back out — those directories are an artifact of running `npm run
install-agent`, not a fact about the Mac, and would let a long-lived daemon resolve
binaries out of a checkout that can later be deleted.

## A bare program name in `ProgramArguments`

**A bare program name in `ProgramArguments` fails with exit 78 `EX_CONFIG` and writes
nothing — VERIFIED.** Both `StandardOutPath` and `StandardErrorPath` come back empty,
`log show` has nothing, and the label simply doesn't show up as running — from outside,
the job never existed. `install-agent.js` captures an absolute node path at install time
rather than trusting `PATH` to resolve it inside the job. `process.execPath` is the
obvious source (`index.js` already uses it for the MCP config) but resolves through the
Homebrew symlink to a versioned Cellar path that `brew upgrade node` deletes — which
reproduces the same silent exit 78 after the next upgrade — so the installer prefers the
stable `/opt/homebrew/bin/node` spelling whenever `realpathSync` proves it points at the
same binary `process.execPath` did.

## Stopping the job does not kill the tmux server

**Stopping the job does not kill the tmux server — VERIFIED, and worth it as a
reassurance.** The obvious fear: if the panel is first to touch tmux after a reboot, does
`bootout` take every Claude session down with the job? No — the tmux server daemonizes to
`ppid 1` and leaves the job's process tree entirely, so `bootout`, a fresh `bootstrap`,
and `kickstart -k` against a job holding a tmux server all leave a running session
untouched. Measured against a throwaway job on its own tmux socket, all three operations
run in sequence against it.

## The launchd label has three copies

**The launchd label has three copies and two of them are not JavaScript, so only a test
holds them together.** `server/logs.js` owns `DEFAULT_AGENT_LABEL`; `scripts/backup-state.sh`
hardcodes it as the fallback for when the repo is not beside the script; and `package.json`
bakes it into `restart-panel` and `stop-panel`. Rename one and miss the others and **`npm run
restart-panel` kickstarts a job that does not exist** — no error, no output, nothing
restarted — while the backup silently captures the wrong plist or none. `test/logs.test.js`
reads `package.json` and the shell script and asserts both against the exported constant,
which is the only mechanism available: neither of the other two can import anything. Same
family as `isLeadName`, except there are three of them and they are in three languages.
Measured on a scratch install under the default label: `restart-panel` took the job from one
PID to another, `stop-panel` left `launchctl list` with nothing and the port free.

## An orphaned plist under an older label

**An orphaned plist runs the *current* code under an older label, and the detector for it
must be by shape rather than by name.** `ProgramArguments` is `[node, <checkout>/server/index.js]`
— a **path**, not a name — so a plist written under a label this repo no longer uses goes on
starting that same file at every login. Both jobs then bind the one port (the two-panels trap
in [`exposure.md`](exposure.md), which is silent), and `restart-panel` kickstarts whichever is
not holding it. So `install()` sweeps first, on two rungs that both mean *this plist starts a
copy of this panel that is not the one being installed*: its `…/server/index.js` **no longer
exists** (the checkout moved out from under it), or it **is this very file** by `realpath`.

Three things about it that will matter again. **No legacy label is named in the code and
none should be** — the rule is structural, and a *list* of superseded labels is exactly the
residue the naming rule forbids. **The rung that matters most is the
refusal:** a plist whose program exists and is a *different* file is left strictly alone, and
that single condition is what stops an installer benched from inside a worktree — where
`server/index.js` is a copy — from booting out the real job. Verified read-only against a
real `~/Library/LaunchAgents` from a worktree: `legacyJobs()` returned `[]`. And it is
**`bootout`, never a signal**: `KeepAlive: {SuccessfulExit: false}` reads a signal death as a
crash and starts the job straight back up, so `--takeover`'s SIGTERM is a fight launchd wins.
The sweep runs *before* the port refusal, deliberately — the orphan may be the thing holding
the port, and refusing there would leave the very plist the step exists to remove.

## Homebrew renamed its own launchd label prefix

**Homebrew renamed its own launchd label prefix, so the brew plist has two names and the
panel carries both.** `brew services` used to write `homebrew.mxcl.<formula>.plist`; it now
writes `sh.brew.<formula>.plist` — measured on 6.0.21 while the v0.4.0 formula was being
proved, and read out of the installed source on 6.0.22, where `canonical_plist_name` is the
new spelling and `legacy_plist_name` the old. `BREW_LAUNCHD_LABEL` was one hardcoded string
of the old shape, so on a current Homebrew `scripts/backup-state.sh` went looking for a file
that does not exist and skipped it silently: the same class of bug the label fix was for in
the first place, reopened by somebody else's rename. `BREW_LAUNCHD_LABELS` is now a **list of
two, newest first**, and `existingBrewPlists` (`server/homebrew.js`) answers whichever of
them is really in `~/Library/LaunchAgents` — none, one, or **both**, since an upgrade can
write the new plist and leave the old one behind. A list rather than a detector because there
is nothing to detect it from except the file's own existence: the panel is not installed by
Homebrew's code, and `brew --version` would be a version number standing in for a fact on
disk — an install predating the rename keeps its old plist through every upgrade. Homebrew
reaches the same answer, its `plist_names` being `[canonical, legacy]`. Swapping one
hardcoded name for the other would only have moved the bug onto every older install; the
backup now captures every plist that is there, each under its own basename in the archive.

## The state dir is resolved on four rungs

**The state dir is resolved on four rungs, and the third is the only place the old spelling
survives in this code.** `$FOREMAN_STATE_DIR` → `~/.foreman` if it exists → the directory an
older build used if *that* exists → `~/.foreman`. It is a **path**, not a name anything reads
as configuration, it is dead on a machine that has never run the older build, and it is
`LEGACY_STATE_DIR_NAME` in `config.js` so nothing spells it twice. **It is not a migration and
must never become one** — nothing moves, copies or merges, because the failure mode of a
half-finished automatic move is one person's task history in two directories with no way to
tell which is live; `test/state-dir.test.js` pins that as directly as it pins which directory
wins. `scripts/backup-state.sh` carries the same rungs in bash for the same reason it carries
the label, and the same test file pins those too. The boot prints `State: <dir> (<rung>)`,
because a resolver that quietly picked the other directory is indistinguishable from a panel
whose tasks, room and rulings have vanished.

**…and a test that sets `FOREMAN_STATE_DIR` above its imports is still pointed at the real
one, because ESM hoists.** Every static `import` is evaluated before *any* statement in the
file, so `process.env.FOREMAN_STATE_DIR = mkdtempSync(...)` on line 12 runs after
`config.js` has already frozen `STATE_DIR` on line 14 — and the comment above it saying
"above the imports" is true of the source and false of the execution order, which is why it
survived review twice. `base-branch.test.js` and `worktree.test.js` both had it: every
`npm test` cut scratch worktrees (`repo-first-task`, `no-main-nope`) straight into the
maintainer's own `~/.foreman/worktrees/` beside live workers', and the suites' teardown
removed only the empty temp dir they had made, so nothing was ever left behind to notice.
Caught by polling the real directory during a run. The fix is `const { … } = await
import('…')` after the assignment — test files are ESM, top-level await is fine — and the
guard in `test/state-dir.test.js` is a source scan that refuses **any** static relative
import in a file that sets the variable, rather than a list of modules known to reach
`config.js`: the import graph moves, and a module that is pure today reaches it tomorrow.
Do not answer this by making `config.js` re-read the env lazily; the running panel resolves
once at boot on purpose.

## Plist backups go to the state dir

**Plist backups go to the state dir, not beside the original.** A second file in
`~/Library/LaunchAgents` carrying the same `Label` as the live plist is a duplicate job
waiting for the next login, so `install-agent.js` backs up into `STATE_DIR` rather than
writing a `.bak` next to the file launchd actually reads.

**…and the settings installers go the other way, deliberately.** `install-hook.js` and
`install-statusline.js` both copy `~/.claude/settings.json` aside **beside itself**, as
`settings.backup-foreman-<ms>.json`: one habit, one place to look, and somebody hunting for
what they had before should not have to know which of two installers touched it last. The
plist reasoning above does not carry over — a second settings-shaped file in `~/.claude/` is
read by nothing, since Claude Code reads `settings.json` and `settings.local.json` and no
other name in that directory. This paragraph used to describe the state dir as *"the same
habit `install-hook.js` has"*, which was never true of any version of that file, and a later
task inherited the claim as an instruction before it was checked.

## Renaming a launchd log rotates nothing

**Renaming a launchd log rotates nothing, and looks exactly like it worked — VERIFIED.**
launchd opens `StandardOutPath`/`StandardErrorPath` once and holds the descriptor, so
`mv foreman.log foreman.log.1` does not make the daemon reopen anything: the
renamed file goes on collecting every line, and the path you are tailing never comes back
at all. Benched against a real job — the moved file grew by the daemon's next 60 bytes
while the live path stayed absent. So `logs.js` **copies aside and then truncates in
place**, which is what an open descriptor does follow: measured on the real job, the fd
was sitting at a 6 MB offset, the file was truncated under it, and the next write landed
at byte 0 with no sparse hole — launchd opens these `O_APPEND`. Copy *first*: a truncate
whose copy failed has thrown the history away for nothing. One `.1`, overwritten; no `.2`.

Three things about where it runs. It is in the boot block **after the single-instance
probe and before the panel prints anything** — a panel about to stand down must not rotate
the running panel's logs, they are the same two files, and a rotation after the boot lines
would copy them into `.1` and truncate away the one boot somebody was watching. It is
boot-only, because the copy→truncate window loses anything appended inside it, and at boot
the writer is this process and it has not written yet. And the paths come from `logs.js`,
which owns the label too — `install-agent.js` imports them rather than the reverse,
because that file runs `install()` at the bottom and importing it from the boot path would
install the LaunchAgent on every start.

## A scratch `FOREMAN_AGENT_LABEL` has to reach the job

**A scratch `FOREMAN_AGENT_LABEL` has to reach the job, not just the plist.** The label decides
both the plist's log paths *and*, now, which two files the running panel truncates — and
the second is read from the process's own environment. `jobEnvironment()` was writing
`FOREMAN_PORT` and `FOREMAN_STATE_DIR` into `EnvironmentVariables` but not the label, so a bench
job wrote to scratch logs while the panel inside it computed the default paths: the first
bench of the rotation would have deleted the real panel's history. Found while setting the
bench up, not by it. Anything else derived from the label has the same shape.
