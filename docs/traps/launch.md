# Launch and relaunch

The evidence behind the **Launch and relaunch** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — starting a session, duplicating one, ending one, putting one to sleep and
waking it, putting a whole bench back, the prefix every one of those names is built from, and
the folder-trust gate a fresh launch lands on. Each section below is one trap, opening with the bold sentence its index line
quotes.

## A duplicate inherits bypass

**A duplicate inherits bypass, and that is the point.** `⧉` on a rail row relaunches into
`paneCwd` with the source's own slug (`slugFor`, so `alpha-main` → `alpha-main-2`) and
with `skipPermissions` copied from `s.bypass`. A copy that quietly asked for permission
where its original didn't would be worse than no button — but it is a real consequence for
one hover-click, so the glyph takes the badge's colour on those rows. Note the guard beside
it: `sessionRow` rebuilds from scratch on every roster broadcast, so `disabled` on the node
is wiped long before the launch returns and the in-flight flag has to live in module scope
(`duplicating`). Three fast clicks must make one session, not three.

## Closing a session is `/exit`

**Closing a session is `/exit`, and "blocked" is wider than `state === 'dialog'`.** The bin
on a rail row types `/exit`, which ends Claude Code, takes the `zsh -ilc claude` with it and
drops the tmux session — verified in a scratch run, and it works while the session is busy,
so there is no wait-for-idle case. The guard is the part worth reading: a check written as
`live.state === 'dialog'` walks straight past the startup trust gate, which sets no
`dialog` at all, and types six characters into a security gate. Test every way a pane can
be holding something — `prompt || plan || question || state === 'needs-decision' ||
state === 'dialog'` — which is what `assertNotBlocked` already does and why `sendText` is
the backstop underneath. (This paragraph used to say the gate parses as `needs-decision`
with **no** `prompt` behind it and `dialog` *set*. Both halves were wrong; see the trap
below. The conclusion about `assertNotBlocked` was right for a different reason — on that
screen `prompt` and `needs-decision` are both true.)

## `--resume` continues the *same* transcript file

**`--resume` continues the *same* transcript file, and the launch flags beat the replayed
conversation — VERIFIED, and both halves decided the shape of relaunch-all.** Measured on a
scratch session before a line was written. The file: 42,438 bytes before the resume, 52,190
after, one `sessionId` throughout, no second `.jsonl` — so a resumed session keeps the
identity every rule in `binding.js` is written against, and nothing rotates, re-adopts or
hops a rail heading. The flags: resumed against an `--append-system-prompt-file` whose
contents had been *rewritten between the two runs*, the session answered out of the **new**
file while still remembering the **old** conversation. That is the only reason a resumed
team lead is honest — `launchLead` regenerates the brief, the MCP config and the settings
from today's code, and a resume does not quietly replay yesterday's. Had it gone the other
way the lead would be fresh-only, and the task said so. Re-checked end to end through the
real launcher afterwards: the lead came back with `isLead`, its pin, its history, a working
`room_post`, and its Bash write to the checkout still denied.

## A resume comes back on the transcript's model

**A `--resume` comes back on the model its transcript last answered on, and
`"model"` in `~/.claude/settings.json` does not hold it — MEASURED on Claude Code v2.1.288,
in the sandbox, on a private tmux server. `--model` beats both.** This is what brought most
of a bench back on Sonnet 5.5 the week Claude Code's own default moved there, although the
user's settings said `"model": "opus"`, and it is why every launch the panel owns now says
`--model` out loud (`launchModelArgs`, `server/session-launch.js`).

Five launches, all in the sandbox, model read off the pane footer:

| Launch | Footer |
| --- | --- |
| `claude` (settings say `"model": "opus"`) | Opus 5.5 |
| `claude --setting-sources project,local` (user settings skipped) | Opus 5.5 |
| `claude --model claude-sonnet-5-5`, one turn answered, then `/exit` | Sonnet 5.5 |
| `claude --resume <that id>` | **Sonnet 5.5** |
| `claude --resume <that id> --model claude-opus-5-5` | Opus 5.5 |

Three things follow, and the first is the one a reader will otherwise get wrong:

- **The alias was not the problem.** A fresh `claude` resolved `"opus"` to Opus 5.5, and so
  did a session with user settings switched off entirely — on this account, on this day.
  The fresh path could not reproduce the drift; only the resumed one did. Which model a
  bare launch lands on is Claude Code's to change, and nothing here can see when it does,
  which is the reason to stop depending on it rather than a reason to chase the alias.
- **The transcript is where the model is remembered.** It is on every assistant record
  (`message.model`), and a resume reads it back. A session that had drifted onto a new
  default — by a launch that predates a settings change, by a `/model` pick, by anything —
  stays drifted across every *keep the conversation* relaunch, however often it is
  restarted. `relaunch all` in resume mode and the bin's *restart, keep the conversation*
  are exactly that launch.
- **The flag wins, on a resume too.** `--resume` is placed before the caller's flags
  (`claudeCommand`, `server/launch.js`), so `--model` arrives after it; the resumed session
  above came back on Opus with its earlier turn still on screen and the same transcript
  file. Proven again end to end through the panel: a sandbox session launched on Sonnet,
  given a turn, then restarted from the bin keeping its conversation, came back on Opus 5.5
  with `--resume … --model claude-opus-5-5` on its command line.

What this costs, stated plainly because it is a choice and not a side effect: a session
somebody deliberately moved to another model with `/model` comes back on the launch model
after a relaunch, not on the one they picked. That is the 2026-10-08 ruling — lock the
launch default, do not save a per-session model in the snapshot, because by the time
anything was saved the saved models were already the drifted ones. The setting is
`launchModel` in the panel's `config.json`, a picker in the settings box; workers are
excluded, because their model is the lead's per-task call through `resolveWorkerModel`.

## Relaunching the whole bench can take the tmux server down

**Relaunching the whole bench can take the tmux server down with it, and pane ids restart
at `%0`.** Exit-all-then-restore-all means that for a moment nothing is running — and if
the bench *is* the whole server, tmux shuts down and the next launch starts a fresh one
numbering from zero. Harmless (session **names** are the contract, and they survive), and
it is also what makes the wait-for-exit loop return instantly: `liveSessionNames()` answers
`[]` for a server that no longer exists. Worth knowing before you read a pane-id reset as a
bug. It does not happen when anything was skipped — benched both ways, with two blocked
sessions surviving and the ids continuing from `%3`.

**…and a reused `%0` used to cost the relaunched session its pin.** Measured restarting a
single session that was the only one on a scratch tmux server: the new pane came back as
`%0` inside one roster poll, before `PinStore.prune` had seen the old one go, so the dead
pane's pin was still on file under that id. `set` read that as "already pinned" and did
nothing, the next `prune` dropped the pin for its changed birthday, and the session came
back unpinned — while the same restart, timed so a poll *did* land in the gap, kept it. `set`
now applies `prune`'s own birthday rule and replaces a pin that belongs to an earlier pane.
It is a race, so a bench that happens to keep the pin proves nothing; `test/pins.test.js`
pins both halves.

**…and the pane that was showing it lets go.** The moment a session leaves the roster, each
pane's `adopt` hands itself to some other session — so a restart that asks "which pane is
showing this?" when the answer lands finds none. The bin's box notes those panes at the
press instead; its backdrop covers the rail for the whole restart, so nothing else can have
moved them. Hibernation is a third way a session leaves the roster, and there the pane
does *not* let go: `followIntoSleep` (`web/asleep.js`) keeps it on the sleeper, read-only,
and `wokenSession` takes it back to the live row after a Wake.

## A relaunch into a folder whose trust was never recorded

**A relaunch into a folder whose trust was never recorded lands on the trust gate.** Not
new behaviour and not the relaunch's fault — the panel has always shown that screen — but
it is the state a relaunched session is most likely to come up in, because the record lives
in `~/.claude.json` and three sessions answering their gates at once can lose one to the
last writer. Benched: two folders came back straight into their history, the third came
back on the gate and resumed correctly the moment it was answered.

## The name a launch mints is a contract

**The name a launch mints is a contract, so `launch.js` is a port and not a rewrite.**
`server/launch.js` was ported line for line from an existing launcher rather than written
fresh, because `sessions.js` reads the label back out of `<prefix><folder>-<label>` and the
server-global pbcopy binding is guarded on the same prefix — change the spelling and the
panel claims sessions it can no longer name. Two details in it look like noise and are not,
and each cost a debugging session before they were understood. **`-ilc`, not `-lc`**: an
*interactive* login shell is what sources the user's rc file, and without it `PATH` may not
contain `claude` at all. **The bare word `claude`, never an exec of the resolved path**: a
shell function named `claude` in the user's rc file is a common way to add flags such as
`--name`, and execing the binary directly walks straight past it. Neither depends on any
particular wrapper existing; both are what make the launch behave the way the user's own
shell would. `test/launch.test.js` pins the naming.

**…and the prefix in that name is configuration, not a literal.** `sessionPrefix` in
`<STATE_DIR>/config.json`, default **`foreman-`**, resolved once at boot as
`SESSION_PREFIX` (`config.js`) and printed on the `Config:` line. Five sites read it —
`sessionName`/`slugFor`/`isLeadName`/`uniqueSessionName` in `launch.js`, the display name
`attachTerminal` strips, the `#{m:<prefix>*,#{session_name}}` guard on the pbcopy bind, and
the two label slices in `sessions.js` and `tmux.js` — and every one of them takes it from
the same export, because two spellings of a naming contract is the `isLeadName` lesson in
another costume. **One prefix, never two:** there is no compatibility mode that mints under
one name and also answers to another, since a panel claiming sessions it cannot name back
is a panel binding a transcript to the wrong pane.

## What a non-matching prefix costs

**What a non-matching prefix costs is narrower than "invisible", and it was measured**
because the first draft of this paragraph said invisible and was wrong. A session whose
name lacks the configured prefix is *still in the roster* — the panel lists every Claude
pane on the machine and always has. Benched on a scratch panel against two sessions minted
by a different launcher: configured with the prefix those sessions carry, both rows came
back with their labels sliced; configured with a different one, the same two rows were
still there with `label: null`. So what is lost is the **name**, and
everything keyed on it: the rail falls back to the ambiguous `<repo>-<branch>` title,
`slugFor` yields nothing so `⧉` auto-numbers and a snapshot cannot restore the row under
its own name, `isLeadName` never matches so a lead among them is not badged, and the
server-global pbcopy bind is rewritten to the configured prefix at the next launch. That is
why an install whose sessions are also minted by some other tool records that tool's prefix
in `config.json`, while a fresh install records nothing and takes the default.
**An existing `config.json` is never seeded into** (`seedConfigFile` only writes an absent
file), so a panel upgrading
into this code mints under the default until somebody adds the line, and the boot line is
the only place that shows. An invalid value is a warning and the default, never a refusal
to boot, and it is never inferred from live tmux sessions — that would key a naming
contract on whatever else the machine happened to be running. `server/snapshot.js`'s header
traces what a saved bench does when the prefix changes under it.

## The trust gate

**A new folder's first session lands on the trust gate, and what it draws changed under
the panel — MEASURED, on Claude Code v2.1.247 and again on v2.1.257, at 220 columns and at
70.** Claude Code asks before its composer exists, so the screen arrives with no composer
footer to read.

**v2.1.247** drew an ordinary, fully populated permission box — numbered options, the
cursor on Yes:

```
 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
```

```
state:  'needs-decision'      dialog:  null
prompt: { title: 'Accessing workspace:', cursor: 1, options: [
          {index: 1, label: 'Yes, I trust this folder', kind: 'approve', selected: true},
          {index: 2, label: 'No, exit',                 kind: 'deny'} ] }
```

**v2.1.257** draws the same screen with the options **unnumbered** and the cursor on
**No**:

```
 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
```

and that broke the panel's reading of the screen outright. `OPTION_RE` in
`server/permission.js` requires an `N.`, so `parsePrompt` returned null, `parsePane` fell
through to `{state: 'dialog', prompt: null, dialog: 'Accessing workspace:'}`, and every
reader of the gate went silent at once: the desktop card, the phone card, and
`needsKind → 'trust'` in `web/notify.js`. What a person saw instead was the generic
*"Accessing workspace: is open in the terminal — messages wait for it"* hint, with nothing
saying the session was stuck on a question only they could answer. `answerTrustGate` in
`server/dispatch.js` broke the same way and more quietly: it required `❯\s*1\.`, which
v2.1.257 never shows, so every dispatched worker sat on an unanswered gate.

**The fix is `parseTrustGate` in `web/trust-gate.js`, and where it is *not* is the point.**
It reads the unnumbered layout off the raw pane and synthesises the prompt shape
`parsePrompt` already produced, so nothing downstream knows which build drew the screen;
`parsePane` tries `parsePrompt` first and falls back to it. The shared `OPTION_RE` is
untouched. Loosening it to admit a bare label would teach every screen in the panel to read
a sentence as an option — the five screen parsers refuse each other's boxes by exactly that
strictness, and `test/plan.test.js`, `test/model.test.js` and `test/effort.test.js` pin the
refusals. It is the same shape of fix as the scrolling-window flattening in
`server/model.js`: the odd layout is normalised inside the one file that knows about it.

Both layouts stay live, because nothing here pins which Claude Code is installed. Four
captures are committed: `test/fixtures/pane-trust-gate.txt` and `-narrow.txt` (v2.1.257),
`pane-trust-gate-2.1.247.txt` and `-2.1.247-narrow.txt`. All four are pinned in
`test/pane.test.js`.

Both obvious tests for "a box the panel must not treat as an ordinary prompt" still miss
this screen on both builds. It has no `dialog`, so the picker test misses it; it has a
prompt, so the unreadable-box test misses it. It is a box we read *perfectly* and then
handle specially.

## The wording changed, and the panel shipped a button on it

**The wording changed in v2.1.247**, so don't write copy from memory. The screen no longer
says "Do you trust the files in this folder?" It reads `Accessing workspace:` / *<path>* /
`Quick safety check: Is this a project you created or one you trust? (Like your own code, a
well-known open source project, or work from your team). If not, take a moment to review
what's in this folder first.` / `Claude Code'll be able to read, edit, and execute files
here.` / `Security guide` / the two option rows. That copy is unchanged in v2.1.257; only
the rows moved.

**And the panel shipped a button on it.** This file used to say the panel "shows it and
stops there" and cited a function to prove it — a function that has never existed in this
repo. The stance had been inherited as prose from a sibling tool rather than written as
code here, and nobody checked. `buildDecisionBar` had no trust-gate case, so a rail row on
that screen drew a full-width, unarmed, one-tap **"Yes, I trust this folder"** — one click,
from any browser that can reach the panel, which under a wide bind is anything on the local
network, granting read, edit and execute in a folder nobody vetted. The phone
(`web/m/cards.js`) had the only correct handling and the only copy of the witness.

The fix then was to refuse the box everywhere: `web/trust-gate.js` became the one witness,
with the desktop composer, the phone's cards and `POST /api/sessions/:id/answer` all asking
it, the endpoint refusing server-side so the stance was a property of the panel and not a
habit of its front end. The witness is the label `Yes, I trust this folder` **or**
`Accessing workspace` plus `safety check`, looser than `answerTrustGate`'s test on purpose.

**That stance was reversed by the maintainer on 2026-09-19, and the reasoning on both sides
is worth keeping.** He was told plainly what it costs: the panel has no authentication by
the 2026-08-27 ruling, it binds wider than loopback, and a button here is a one-click grant
of read, edit and execute in a folder nobody vetted, reachable from anything on the LAN.
His ruling is that Foreman must not force a user to open a terminal — *one panel to use
instead of terminals* is the tool's whole narrative, and a screen the panel reads perfectly
and will not answer sends him to the Mac for the one keystroke the tool exists to save. The
exposure is accepted as it stands. **Do not re-derive the refusal, and do not reach for
authentication to make it palatable**; both are decided, and both were decided with the
cost spelled out.

What the reversal did **not** change is as load-bearing as what it did. The gate still gets
its own card rather than the permission bar: the folder in full, and the gate's own
sentence about read, edit and execute, because that is what a person decides *on* — a card
offering two buttons and no folder path would be asking for a signature on an unread page.
The Yes still asks twice. And the rows carry **no digit**, because v2.1.257 draws none and
a number printed beside a row would invent the one cross-check a reader has against the
terminal.

**The answer is the cursor, not a keystroke.** There is no digit on the unnumbered layout,
so `confirmGateOption` (`server/tmux.js`) presses `Down`, re-reads the pane, and sends
`Enter` only once the pane's own `❯` is on the row it was asked for. Written as
press-and-re-read rather than a counted number of presses for a measured reason: **the list
wraps** — `Down` from the last row lands on the first — so a miscount does not stall on the
end of the list, it silently selects the other answer, and on this screen the other answer
is either granting a folder or killing the session. `POST /api/sessions/:id/answer` routes
the gate through it and never computes a digit for it; `answerTrustGate` uses the same walk,
keeping its own stricter guard that the worktree's name is on screen.

## Demonstrated, not asserted

**Demonstrated, not asserted.** A scratch panel (`FOREMAN_PORT=48771`, scratch
`FOREMAN_STATE_DIR`, scratch `FOREMAN_AGENT_LABEL`) on its own tmux server, against real
Claude Code v2.1.257 sessions parked on real gates in throwaway folders — 220×50 and 70×40.
The roster read both as `needs-decision` with the two options and the cursor on `No`. On the
desktop the card came back with its transcript, the folder whole at both widths, and exactly
two buttons; the first click on Yes armed it and sent nothing, showing *"sure? click again —
this grants read, edit and execute in that folder, for good"* with the label still on screen;
the second click trusted the folder and the pane landed on the composer. The phone's card
did the same at 70 columns, from `/m/`. `No, exit` went on one click and ended the session —
the tmux session was gone a moment later.

The earlier bench, under the refusing stance, is what this replaced: the card came back
`perm perm-refusal` with **zero** pressable nodes, and `POST /answer` with
`{option: 1, expectLabel: 'Yes, I trust this folder'}` returned **409** with the pane still
sitting on the gate.

`test/trust-gate.test.js` holds the pure half — the witness, the raw-pane reader, and a card
that must offer exactly the two rows and arm the Yes. `test/trust-gate-api.test.js` holds
the endpoint against a real scratch panel and real tmux panes, and is a separate file for a
reason worth knowing: `server/tmux.js` builds `TMUX_ENV` from `process.env` at module load,
and a static import is hoisted above every statement that could set `TMUX_TMPDIR` — so a
bench and a pure test in one file points the bench at the machine's real tmux server. Its
pane program draws the committed capture and wraps its cursor the way the real box was
measured to; what a simulation cannot prove is what Claude Code does with an `Enter`, which
is why the paragraph above exists.

One thing the fix had to reach beyond the card, and it changed twice: `updateComposerHint`
once said *"answer the prompt above — messages wait until you do"*, which under a card that
had just refused to draw a button sent the reader hunting for it; it then said *"answer it
at the Mac"*, which now sends the reader past the button that exists. It names the gate and
points at the card above it, and it sits ahead of the `dialog`/`working`/`needs-decision`
chain for the same reason the card's own branch does.

The gate is still one reason the launcher opens a Terminal window, though it is no longer
the only way past it. The `+ new` box's tick for it is **off** by default — recoverable via
the pane header's attach button, but only if you notice.

## A `/loop` outlives `/clear`, and only the transcript and one lock file know it exists

**A cron or a `/loop` wake-up draws nothing the roster reads, survives `/clear` into a
transcript that never mentions it, and the folder's lock file names only one of the
sessions using the scheduler — MEASURED on v2.1.296, in the sandbox's `alpha`, two
sessions side by side.** Hibernation must never `/exit` a session that has one, because
both kinds are session-only: the `CronCreate` result says *"Session-only (not written to
disk, dies when Claude exits)"*. So `server/hibernate.js` reads its own witness out of the
transcript (`CronWitness`) and out of `<folder>/.claude/scheduled_tasks.lock`, and each of
the measurements below decided something about how. The excerpts are committed:
`test/fixtures/cron-recurring.jsonl`, `cron-after-clear.jsonl`,
`cron-delete-and-wakeup.jsonl` and `cron-wakeup-fire.jsonl`, cut down to the records a scan
reads, with the home directory rewritten.

**What the records are.** A `CronCreate` result is a `type: 'user'` record whose
`toolUseResult` is `{id, humanSchedule, recurring, durable}`; a `CronDelete` result's is
`{id}`; a `CronList` result's is `{jobs: [{id, cron, humanSchedule, prompt, recurring,
durable}]}`, the exact list at that moment. A `ScheduleWakeup` result's is `{scheduledFor
/* ms */, clampedDelaySeconds, wasClamped}`, and a `stop: true` call answers `{…, stopped:
true, cancelledWakeups: N}`. None of those shapes names its tool — `{id}` alone could be
anything — so the scan learns each `tool_use` id's name from the assistant record first and
reads a result only through that. An errored call is real and was hit (`noop` missing): its
`tool_result` carries `is_error: true` and its `toolUseResult` is a string, and it schedules
nothing.

**1. A recurring cron survives `/clear`.** After `/clear`, `CronList` in the new
conversation still listed the job, the new transcript held no `CronCreate` for it, and the
lock file still named the *old* session id under the *same* pid. So a scan keyed on the
transcript path alone answers "nothing scheduled" for a session with a live loop. The
witness follows the **pane process** across the rotation — keyed by pane id and the pane's
creation time — and the lock is matched by **pid, never by `sessionId`**.

**2. A one-shot cron fires and is gone, and leaves no `CronDelete`.** The fire is a
`type: 'system'`, `subtype: 'scheduled_task_fire'` record carrying `taskId` (the cron's id)
and `cron`, followed by the prompt as an `isMeta` user record with `turnOrigin:
'scheduled'`; `CronList` afterwards no longer had it. So a `recurring: false` id is retired
by its own fire record, and a recurring one is not.

**3. Two sessions in one folder share one lock, and it names only the first.** With crons
live in both, `scheduled_tasks.lock` held the first session's `{sessionId, pid, procStart,
acquiredAt}` and nothing about the second. When the first exited, the second took it over
under its own pid and its *current* session id. So the lock is a witness for one session per
folder at a time, and the transcript scan is the only witness for every other one — "either
alone blocks" is the rule because neither alone sees everything. The lock also goes when the
holder is killed (`kill-server` left `.claude/` empty), so a stale one naming a dead pid
blocks nothing.

**4. A `/loop` wake-up also survives `/clear`, fires early, and says so.** Armed with
`ScheduleWakeup` and then `/clear`ed, it fired into the *new* transcript as a
`scheduled_task_fire` record with `taskKind: 'loop'` and an internal `taskId` that matches
nothing in the old one — and it fired **49 seconds before** its own `scheduledFor`. So a
pending wake-up is the latest successful arm on this pane process with no later `stopped`
and no later loop fire; `scheduledFor` only bounds how long the witness believes an arm
whose fire it never saw.

**And one the next item needs: `/exit` asks first.** With a cron live, `/exit` does not exit:
it draws *"The following will stop when you exit: scheduled task · Every 30 minutes · …"*
over `1. Exit and stop tasks`, `2. Move to background and exit`, `3. Stay`, `Enter to
confirm · Esc to cancel`. `parsePane` reads it as `needs-decision` with a prompt, so
`heldBy` calls it *"a permission prompt"* — it blocks, under the wrong words — and `Esc`
put the session back on its composer with the cron intact. That box is a last line of
defence, not a witness: a sleep that reaches it has already typed `/exit`, and must Escape
it rather than wait out the name.

**And what the screen shows: nothing.** After `/loop 30m …` the mode line still read
`⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents` — no shell, monitor or cron segment, and
`← 2 agents` is the navigation hint with nothing running behind it (the agent-panel trap's
`← 1 agent` in another number). `parseBackground` is an allow-list of shells and monitors, so
the roster's `background` reads all zeros for a session with a live loop. That is why the
witness above exists at all, rather than being a second opinion.

Not measured here, because it needed a wake: whether a scratch panel rebinds a woken row. The
sleep loop's bench (item 2) answered it — the woken session rebound to its own transcript and
went back under its pin — and the next two sections are what that bench and the planner's
measured on the way.

## Hibernation is the third place the panel ends a session

**Hibernation `/exit`s a session nobody pressed anything to close, so it is off by default,
it has one caller of `/exit`, and that caller re-reads everything before it types.** The
other two places — the bin on a rail row, and a task closed `done` — are both a person's
press. This one runs on a timer, so it was built narrow, and every piece of that is a rule
somebody will be tempted to relax:

- **Off unless set.** `hibernateAfter` absent, `off` or anything not in
  `HIBERNATE_CHOICES` reads as off (`hibernateMs` answers `null`), never as the shortest
  wait. With it off, every pass ends on its first line.
- **No route puts a named session to sleep.** Automatic only, by the maintainer's ruling of
  2026-10-29. `Hibernator#hibernate` (`server/hibernate-loop.js`) is the only `/exit` the
  feature adds, reached from the once-a-minute pass alone, at most one session per pass,
  longest idle first.
- **The relaunch loop's order.** Roster refreshed, pane re-read, `sleepVerdict` asked again
  with the terminal's input line read too (`ghost.js`'s `composerEmpty`, because `sendText`
  presses `C-u` and would wipe something half-typed in a Terminal window); the sleep record
  written **and flushed** before `/exit`, so a crash between the two leaves a greyed row
  rather than a session that vanished; `/exit` through `sendText`, which re-reads a third time
  and refuses a box; then a wait for the *name* to leave tmux.
- **A box after `/exit` is Escaped, never answered.** The cron box measured above offers
  `Exit and stop tasks` and `Move to background and exit` — both end or orphan somebody's
  loop. The loop presses `Escape` (which was measured to put the session back on its composer
  with the cron intact). The verdict refuses any session with a cron, so this is the backstop
  and should never be seen.
- **…and the record is deleted only for a session proven still awake.** Found live on
  2026-10-31, one sleep in 32: a pass typed `/exit`, a poll read *"a box is open in its
  terminal"*, the loop pressed Escape and deleted the record — and the transcript showed the
  `/exit` had landed (`<command-name>/exit</command-name>` and its farewell), the tmux session
  was gone, and the session had vanished from the rail with nothing to wake it from. So every
  give-up after `/exit` went out now asks again (`#exitOutcome`): after the Escape it settles
  for `EXIT_SETTLE_MS` (5 s), and the name leaving tmux, the pane leaving the server, or
  something other than Claude holding the pane (a pane that outlived Claude is a shell, and
  the conversation is as resumable) is **asleep** — record kept, `is asleep … but it exited`
  logged, `onSlept` called. The record goes only when, at the end of the window, the name is
  live, Claude is the pane's command and the pane is at its composer (`idle` or `working`,
  which `parsePane` reads only with the composer drawn). Anything else — a box that survived
  the Escape, a tmux read that failed — **keeps the record** and logs `kept asleep`, without
  `onSlept`. A name not freed after 20 s is asked the same question, once. Only `/exit`
  refused by `sendText` before anything was typed deletes the record outright. "Every doubt a
  no" still holds for *sleeping*; for *deleting a record*, doubt means keep it.

  What a kept record costs a session that turns out to be awake, read off the code rather
  than guessed: the rail draws it twice (the live row and a greyed sleeper — `mergeByActivity`
  does not dedupe by name), `sendOrHold` holds anything sent to the name instead of typing it,
  Wake refuses because a live session holds the name, and the loop never considers it again.
  The binding claim does not bite — the pane wearing the sleeper's own name is exempt — and
  `reserved` reserves a name that is already taken. All of it is visible and undone by
  **forget** on the sleeping row (which drops the held messages with it). A deleted record for
  a session that exited costs the conversation's place on the rail, with no row to wake it
  from. That trade is the rule.

  **What the box was: a teardown frame, inferred, not caught.** `heldBy`'s words name the
  shape — no composer in `parsePane`'s last 14 lines, no parsed prompt, no dialog title, so
  `dialog: 'dialog'`; the cron box would have read *"a permission prompt"*. Six sandbox exits
  in `alpha` (v2.1.296, 220×50, `claude` and the panel's own `/bin/zsh -ilc claude`, fresh
  and after one turn), captured as fast as tmux would answer — 42 to 60 frames each, about
  0.9 s from `Enter` to the name freeing — read `idle` on every frame that captured, with
  `claude.exe` the pane's command throughout; the last frame drew the composer with
  `Resume this session with: claude --resume <id>` printed below it, and the only frame
  that read as a box was a capture that *failed* as the session went (which `readPaneState`
  answers as `unknown`, not a box). So the live frame came from a slower exit than the
  sandbox produces — a larger session's teardown — and `heldBy` was deliberately **not**
  widened: what it reads is true of a frame with no composer, and the fix is to stop
  trusting one read about an outcome the name answers. Note too that the composer stays on
  screen to within a frame of the end: one composer read mid-exit proves nothing either,
  which is why "awake" waits out the settle.
- **Doubt refuses.** `background: null` (a box over the mode line), an unreadable input line,
  a transcript the cron scan cannot read, an unknown keep-awake: each is a "no", in words. A
  wrong "asleep" kills somebody's loop or half-typed message; a wrong "awake" costs a few
  hundred MB.
- **Nothing else moves the bench meanwhile.** The pass is skipped while a relaunch, restore
  or wake holds the bench, and the loop holds its own `sleeping` flag from the re-read until
  the name frees — relaunch all, restart one, restore, wake and forget all answer 409 while
  it is up.

## `/exit` and `--resume` leave different marks, so the idle clock has four inputs

**`/exit` writes a timestamped record and `--resume` writes only an untimestamped one, so a
freshly woken session's transcript says it has been idle since the moment it went to sleep
— MEASURED on v2.1.296, in the sandbox.** An idle clock read off the transcript alone puts a
woken session straight back to sleep on the next pass.

**`/exit`.** It leaves a `type: 'user'` record, `<local-command-stdout>…</local-command-stdout>`,
**with** a `timestamp`, so it moves both `lastTs` and the file's mtime. The farewell inside it
is not fixed: the planner's capture read `See ya!`, the desktop bench's read `Goodbye!`, and
the transcripts on this Mac hold four wordings in near-equal numbers — `Bye!`, `Catch you
later!`, `See ya!`, `Goodbye!` — so it is picked at random, and nothing may key on it (nothing
does). That record is also what makes a sleeper's transcript its folder's freshest, which is
why `binding.js` claims it — see
[binding#a-sleepers-transcript-is-its-folders-freshest](binding.md#a-sleepers-transcript-is-its-folders-freshest).

**`--resume`.** Same file, same id (the `--resume` trap above). About a second after launch it
appended **267 bytes**: one `bridge-session` record with **no `timestamp`**. That is enough to
put the mtime after the new pane's creation, so the freshness rule passes and the woken pane
binds its own transcript again — but `lastTs` does not move. The pane then shows the tail of
the old conversation, the `/exit` and its farewell included, over an empty composer: idle, no
box, the footer on the `--model` it was given. No trust gate in a folder already trusted; a
folder never trusted would show one (the trap above).

**So `idleSince` is the latest of four times, never the transcript's alone**
(`server/hibernate.js`): the transcript's `lastActivity`; `lastBusy`, the last poll on which
the row was anything but `idle` (`IdleClock`, in memory, keyed by name); the pane's
`createdMs`; and `wokeAt`, set by a successful wake. The last two are the woken-session case;
`lastBusy` catches a session that worked without writing. `lastBusy` starts every name at
the panel's boot, so **a panel restart restarts every idle clock** — accepted on purpose (the
plan's Q9): the cost is one more idle period, and the alternative is trusting a timestamp a
resume does not move. `test/hibernate.test.js` pins the woken case by name.

## A sleeping name is a free name to tmux

**A sleeper's name is free as far as tmux is concerned, so every launch passes the sleepers'
names as `reserved` — except a wake, and `liveSessionNames()` itself must never learn about
them.** `uniqueSessionName` and `launchLead`'s one-lead check both read `liveSessionNames()`,
so without the reservation a `+ new` in that folder mints the sleeper's name and the sleeper
can never come back under it — ruling 5 says it wakes under the *same* name. Hence:
`createSession` unions `reserved` into what it treats as taken, at every standalone launch
site; `launchLead` refuses outright when the folder's lead is asleep (*"This project's lead is
asleep — wake it from its row."*); `restoreSessions` skips a saved entry whose name is asleep
(`ASLEEP_SKIP`, *"asleep — wake it from its row"*); a save includes sleepers
(`sleeperEntries`), and `drift` counts them present, so a sleep does not light the dot.

The opposite mistake is as bad and looks like a tidy-up: teach `liveSessionNames()` about
sleepers and `relaunchBench`'s wait-for-exit never sees a name free, and a wake reserves its
own name against itself. A wake passes an empty `reserved`, and refuses instead when a live
session already holds the name — a stranger took it, and coming back as `-2` is exactly what
the reservation exists to prevent.

## The hibernation choices are spelled once

**`HIBERNATE_CHOICES` is spelled once, in `web/hibernate-choices.js`, and both the settings
picker and the validator import it.** A leaf with no imports under `web/`, so the browser
loads it as it is (the `group-hue.js` precedent). `server/settings-file.js` imports it for
`validateConfigPatch` and builds its refusal message (`HIBERNATE_RULE`) from it,
`server/hibernate.js` re-exports it to the loop, and the settings box in `web/app.js` draws
its rows from it. The picker's labels (`30 min`, `1 h`, …) sit in the same file for the same
reason. A second literal anywhere is a picker offering a choice the server answers 400 to, or
a choice the server would take that nobody can pick — the
[one-spelling](one-spelling.md) family.
