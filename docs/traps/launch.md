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

**A new folder's first session lands on the trust gate, and it does not look like anything
you would guard against — MEASURED, on Claude Code v2.1.247, at 220 columns and at 70.**
Claude Code asks before its composer exists, so `parsePane` reads `needs-decision`. What it
reads it as is the trap: an ordinary, **fully populated permission box**.

```
state:  'needs-decision'      dialog:  null
prompt: { title: 'Accessing workspace:', cursor: 1, options: [
          {index: 1, label: 'Yes, I trust this folder', kind: 'approve', selected: true},
          {index: 2, label: 'No, exit',                 kind: 'deny'} ] }
```

Both obvious tests for "a box the panel must not answer" therefore miss it. It has no
`dialog`, so the picker test misses it; it has a prompt, so the unreadable-box test misses
it. It is a box we read *perfectly* and refuse. `test/fixtures/pane-trust-gate.txt` and
`pane-trust-gate-narrow.txt` are the captures, pinned in `test/pane.test.js`.

## The wording changed, and the panel shipped a button on it

**The wording changed in v2.1.247**, so don't write copy from memory. The screen no longer
says "Do you trust the files in this folder?" It reads `Accessing workspace:` / *<path>* /
`Quick safety check: Is this a project you created or one you trust? (Like your own code, a
well-known open source project, or work from your team). If not, take a moment to review
what's in this folder first.` / `Claude Code'll be able to read, edit, and execute files
here.` / `1. Yes, I trust this folder` / `2. No, exit`.

**And the panel shipped a button on it.** This file used to say the panel "shows it and
stops there" and cited a function to prove it — a function that has never existed in this
repo. The stance had been inherited as prose from a sibling tool rather than written as
code here, and nobody checked. `buildDecisionBar` had no trust-gate case, so a rail row on
that screen drew a full-width, unarmed, one-tap **"Yes, I trust this folder"** — one click, from any browser that can reach
the panel, which under a wide bind is anything on the local network, granting read, edit and
execute in a folder nobody vetted. The phone (`web/m/cards.js`) had the only correct
handling and the only copy of the witness.

`web/trust-gate.js` is now that witness, in one place, with three readers: the desktop
composer, the phone's cards, and `POST /api/sessions/:id/answer`, which refuses the gate
server-side so the stance is a property of the panel and not a habit of its front end. It
is the only file under `web/` that `server/` imports, and the header says why. The witness
is the label `Yes, I trust this folder` **or** `Accessing workspace` plus `safety check` —
the same one `answerTrustGate` uses, loosened from *and* to *or* on purpose: that function
decides whether to **answer** a gate and a miss costs a stalled dispatch, this one decides
whether to **refuse** and a miss ships the button. `test/trust-gate.test.js` pins the card
at both widths by walking it for anything pressable, and pins that the detector itself is
not blind.

## Demonstrated, not asserted

**Demonstrated, not asserted.** A scratch panel (`FOREMAN_PORT=48771`, scratch `FOREMAN_STATE_DIR`)
against a scratch session parked on a real gate, at 220 columns and again at 70: the card
comes back `perm perm-refusal` with **zero** pressable nodes — only `DIV`, `SPAN` and `P` in
the whole tree — the folder reads whole at both widths, and `POST /answer` with
`{option: 1, expectLabel: 'Yes, I trust this folder'}` returns **409** with the pane still
sitting on the gate. The phone's card was re-checked through the same live row after the
witness moved out of `cards.js`.

One thing the fix had to reach beyond the card: `updateComposerHint` said *"answer the
prompt above — messages wait until you do"*, which under a card that has just refused to
draw a button sends the reader hunting for it. That branch now names the gate and points at
the Mac, and it sits ahead of the `dialog`/`working`/`needs-decision` chain for the same
reason the card's own branch does.

The gate is still one reason the launcher opens a Terminal window. The `+ new` box's tick for
it is **off** by default despite this cost — recoverable via the pane header's attach button,
but only if you notice. Verified originally by launching into an empty scratch folder.
