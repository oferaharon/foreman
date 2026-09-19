# Launch and relaunch

The evidence behind the **Launch and relaunch** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — starting a session, duplicating one, ending one, putting a whole bench back,
the prefix every one of those names is built from, and the folder-trust gate a fresh launch
lands on. Each section below is one trap, opening with the bold sentence its index line
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

## Relaunching the whole bench can take the tmux server down

**Relaunching the whole bench can take the tmux server down with it, and pane ids restart
at `%0`.** Exit-all-then-restore-all means that for a moment nothing is running — and if
the bench *is* the whole server, tmux shuts down and the next launch starts a fresh one
numbering from zero. Harmless (session **names** are the contract, and they survive), and
it is also what makes the wait-for-exit loop return instantly: `liveSessionNames()` answers
`[]` for a server that no longer exists. Worth knowing before you read a pane-id reset as a
bug. It does not happen when anything was skipped — benched both ways, with two blocked
sessions surviving and the ids continuing from `%3`.

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
