# Accounts

The evidence behind the **Accounts** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps index —
what a second Claude account on the same Mac keeps, reads and does not read, and every
measurement the multi-account work was built on. Each section below is one trap, opening with
the bold sentence its index line quotes. How the feature behaves is in
[`docs/panel.md`](../panel.md#accounts); this file is why it behaves that way.

A second account is a **config folder** — `CLAUDE_CONFIG_DIR=~/.claude-work claude`, usually
behind an alias. The default account is `~/.claude`. Everything below was measured on
**Claude Code v2.1.331** in the sandbox (`alpha` and `beta`, a scratch tmux server, a scratch
panel on its own port and state dir) unless it says otherwise. Where a trap already has its
own section in another file it is linked from here and **not** repeated — the index at the
end lists all of them.

## The measurements

| # | Question | Answer |
|---|---|---|
| M1 | Where does a second account's transcript go? | `<dir>/projects/<cwd as dashes>/<id>.jsonl`. **Nothing** is written under `~/.claude/projects`. The folder-name encoding is the default account's. |
| M2 | The peer registry? | `<dir>/sessions/<pid>.json` — per account, so a reader of `~/.claude/sessions` misses it. |
| M3 | Does a second-account session read `~/.claude/settings.json`? | **No.** The default account's status line draws under the default session's composer and nothing draws under the second one's. A fresh second account's `settings.json` holds a theme and nothing else: no `hooks`, `statusLine`, `permissions`, `autoMode`, `skipDangerousModePermissionPrompt`, `model` or `effortLevel`. |
| M4 | Folder trust? | **Per account**, recorded in `<dir>/.claude.json`. A folder trusted on the default account lands on the trust gate (the v2.1.257+ unnumbered layout, cursor on `No`) the first time a second account opens it. |
| M5 | Does `CLAUDE_CONFIG_DIR=<dir> claude …` inside `zsh -ilc` survive the `claude()` shell function? | **Yes.** `ps -E` on the `claude` child shows the variable and `--name` is still applied. |
| M6 | Do hook and status-line payloads say which account? | Neither has an account field. **Both carry `transcript_path`, whose root is the config dir.** Present on every render and every hook captured; status-line payloads carry `rate_limits.five_hour` / `seven_day` as on the default account. |
| M7 | Is a settings change picked up by a running session? | **Yes, within seconds, status line included.** |
| M8 | Does the wrong binding happen? | **Yes, reproduced on `main` before the fix.** A second-account pane alone in a folder was bound, `inferred`, to a default-account `claude -p` run started there afterwards. |
| M9 | Resume on the wrong account? | `CLAUDE_CONFIG_DIR=<dir> claude --resume <an id from the other account>` prints `No conversation found with session ID: …` and exits 1. |
| M10 | Can a conversation move between accounts? | **Yes.** Copy `<id>.jsonl` (and any `<id>/` folder) into the other account's `projects/<same folder>/` and `--resume` it there: it replays and recalls a codeword given earlier, under one `sessionId`. The original stays byte-identical. What the panel's move does with that: [launch#a-move-to-another-account-is-one-way](launch.md#a-move-to-another-account-is-one-way-and-the-original-is-final-only-after-exit). |

Measured later, while the pieces were built, and recorded where each belongs:

| Measurement | Where |
|---|---|
| A `--dangerously-skip-permissions` launch on a dir without `skipDangerousModePermissionPrompt` stops on a *Bypass Permissions* warning, cursor on `No, exit` — at 220 and 70 columns. | [launch#bypass-onto-another-account-stops-on-a-warning-the-panel-will-not-answer](launch.md#bypass-onto-another-account-stops-on-a-warning-the-panel-will-not-answer) |
| `/exit` appends to a transcript, so a hash taken before the press differs from the original afterwards. | [launch#a-move-to-another-account-is-one-way](launch.md#a-move-to-another-account-is-one-way-and-the-original-is-final-only-after-exit) |
| A moved session keeps its `session_id`. | [rate-limits#a-moved-session-keeps-its-id](rate-limits.md#a-moved-session-keeps-its-id) |
| Where the account file lives: `~/.claude.json` for the default, `<dir>/.claude.json` for another (v2.1.322). | [panel.md](../panel.md#which-account-a-session-runs-on) |
| A live sleep on a second-account session was held by the `unread` rule — below. | this file |

## A second account keeps everything in its own folder and reads none of the default's

**A second account files its conversations, peer registry and plans under its own config dir,
and reads none of `~/.claude/settings.json` — MEASURED (M1–M3).** Every reader in the panel
that once assumed `~/.claude` gave a wrong answer for such a session, not a blank one: no
conversation, or the wrong one (M8); a peer registry that never listed it; a plan file read
from the wrong folder; a `/` menu offering commands the session does not have. The fix is one
spelling: `server/account.js` is the only file that works out a projects root, a config dir
from a path, a peers dir, a plans dir or "is this the default" — `projectsDirOf`,
`configDirOfTranscript`, `peersDirOf`, `plansDirOf`, `DEFAULT_CONFIG_DIR`,
`KnownConfigDirs`. A reader that needs a root asks it; a second spelling is how the default
comes back in by the side door ([one-spelling](one-spelling.md)).

And because M3 holds, a second account has **none of the default's permissions, auto-mode
rules, plugins, skills or global `CLAUDE.md`** — its sessions prompt more and know less. That
is the account's own, mirrored by hand if at all: the panel writes nothing into a config dir
but its two Install entries, and never `skipDangerousModePermissionPrompt`.

**`account.configDir` on the roster is `~`-shortened for display.** A launch, scan or install
fed that string gets a literal `~` inside a quoted shell argument or a `path.join`. The
absolute `account.dir` beside it is the one to use, and `rowConfigDir` is the way back from a
row.

## The account is a prefix on the launch string, and it survives the `claude` function

**`CLAUDE_CONFIG_DIR='<dir>' claude …` inside `zsh -ilc` reaches the real binary through the
shell's `claude()` function — MEASURED (M5).** So the account rides as a `VAR=value` prefix
on the same string, still the bare word `claude` and still `-ilc`
([launch#the-name-a-launch-mints-is-a-contract](launch.md#the-name-a-launch-mints-is-a-contract)).
Two alternatives were turned down, and the reasons stand: `tmux new-session -e` would also
reach `claude` but leaks the variable into whatever that pane's shell runs afterwards; and
"unset it first" on a default launch would change a string every session depends on. A
default launch carries no prefix and is byte-identical to before, pinned by
`test/account-launch.test.js`. The same variable is how the panel reads an account back: `ps -E` on
the pane's `claude` pid, absent meaning `~/.claude`.

## A payload names its account only by its transcript path

**Hook and status-line payloads carry no account field; `transcript_path` is the only witness
of the account, on every render — MEASURED (M6).** Everything account-shaped that arrives by
payload keys off it: the gauges
([rate-limits#a-moved-session-keeps-its-id](rate-limits.md#a-moved-session-keeps-its-id)) and
the hook's binding. A payload without one is **ignored**, never folded into the default.
`test/account-gauges.test.js` pins the field in a fixture, because a future Claude Code that
dropped it would make every gauge go blank — the safe direction, and the one a reader would
notice.

## An Install reaches the account's running sessions within seconds

**Writing the hook and status-line entries into a config dir's `settings.json` changes its
*running* sessions within seconds, no restart — MEASURED (M7).** That is the whole design of
the per-folder Install, and also why it is a **human press** and never a side effect of a
folder appearing: pressing it changes live sessions the moment it lands (the maintainer's
ruling). The measurement had a cost worth stating plainly: with a scratch status line
swapped into a second account's settings for about twelve seconds, a real session already
running there ran it once, posted nothing, and the file was restored byte-identical by hash.
Hence the rule for every later bench: **an install is demonstrated on a scratch config dir**
(`CLAUDE_CONFIG_DIR=<scratchpad>/cfg`), never on an account somebody is working in. What the
button writes and how it is kept from wrapping a wrapper is in
[rate-limits#a-second-config-dirs-wrapper-must-read-as-a-wrapper](rate-limits.md#a-second-config-dirs-wrapper-must-read-as-a-wrapper)
and [binding#install-hookjs-installed-at-import](binding.md#install-hookjs-installed-at-import).

## A resume on the wrong account fails after the exit

**`claude --resume <id>` on an account whose `projects/` does not hold that conversation
prints "No conversation found" and exits, and a relaunch has already `/exit`ed the session —
MEASURED (M9).** So the failure is loud but the session is gone. The panel therefore checks
the transcript's root against the account it would start on *before* anything ends
(`resumeRootProblem`, `server/account.js`): refused by restart-one, skipped by relaunch-all,
refused as a sleep (it could never wake), and refused once more by `restoreSessions` as the
backstop.

## A held sleep on a second account was the `unread` rule, by design

**The first live sleep → wake on a second-account session did not sleep when expected, and the
reason was the `unread` rule — a reply the maintainer had not read — not the account.** Found
on a real session while the launch work was being proven, and left as it is: `sleepVerdict`
refuses any row holding an unread reply (`server/hibernate.js`), on every account alike, and
the sleep went ahead once the reply was read. Recorded because "it will not hibernate" on a
second account looks like an account bug and is the ordinary rule; read the verdict's reason
before reading the account.

## Trust is per account, and a move can land on the gate

**A folder trusted on one account is new to the other — MEASURED (M4).** Every `+ new`, `⧉`,
relaunch, restore, move and new worktree lands on the trust gate once per folder on a second
account, and it is the ordinary gate, answered the ordinary way — the same unnumbered layout
the panel already reads. The gate's last-writer race now has a second file to lose an answer
in. The evidence is
[launch#a-relaunch-into-a-folder-whose-trust-was-never-recorded](launch.md#a-relaunch-into-a-folder-whose-trust-was-never-recorded)
(the race and the measurement both live there).

## Not demonstrated live

Two things shipped on tests and the shape of the sandbox, not on a real second-account
session, because a scratch config dir cannot be logged in:

- **A worker on a second account reporting back** through the `foreman` tools on that
  account, and answering that account's trust gate on a fresh worktree. The dispatch itself —
  which dir, which refusals, the room line — is tested; the far end is not.
- **The `/rewind` checkpoints' folder** (`file-history/<id>/`) as part of a move: named as
  not travelling, never measured.

## Every account trap, in one place

What the account work left in the other trap files, so nothing here is searched for twice:

- Binding — [a second account's pane was bound to the other account's file](binding.md#a-second-accounts-pane-was-bound-to-the-other-accounts-file)
  (M8; the scan and the fence ship together)
- Binding — [install-hook.js installed at import](binding.md#install-hookjs-installed-at-import)
  (the split the per-folder Install needed)
- Launch — [a relaunch into a folder whose trust was never recorded](launch.md#a-relaunch-into-a-folder-whose-trust-was-never-recorded)
  (trust per account, M4)
- Launch — [a snapshot entry is rebuilt from a field list, twice](launch.md#a-snapshot-entry-is-rebuilt-from-a-field-list-twice)
  (`configDir`)
- Launch — [bypass onto another account](launch.md#bypass-onto-another-account-stops-on-a-warning-the-panel-will-not-answer)
- Launch — [a move to another account is one-way](launch.md#a-move-to-another-account-is-one-way-and-the-original-is-final-only-after-exit)
  (M10; `/exit` before the hash)
- Rate limits — [a moved session keeps its id](rate-limits.md#a-moved-session-keeps-its-id)
  (per-account gauges, M6)
- Rate limits — [a second config dir's wrapper must read as a wrapper](rate-limits.md#a-second-config-dirs-wrapper-must-read-as-a-wrapper)
