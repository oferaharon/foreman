# Pane parsers

The evidence behind the **Pane parsers** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps
index — the permission, question, plan, ghost, mode, dialog and pane-width screens, and
what each one costs when it is read as one of the others. Each section below is one trap,
opening with the bold sentence its index line quotes.

## Permission option 2

**Permission option 2 is always a broader yes.** "Yes, and don't ask again", "Yes, allow
all edits this session". `No` is option 3. v1 sent `Down, Enter` for deny and therefore
*granted a standing rule*. Never answer a prompt positionally — parse the real options
and send the option's own digit. `test/permission.test.js` pins this.

**…and a box can offer more than one of them, which is what broke `classify`.** A four-option
Bash prompt reads `1. Yes` / `2. Yes, allow reading from /private/tmp from this project` /
`3. Yes, and switch to auto mode` / `4. No` — two broader yeses, and the second of them does
not widen a rule, it *ends the prompting*. `classify` tested five phrases (`ask again|allow
all|always|this session|add.*allowlist`), matched none of them, and returned plain `approve`
for both, so the desktop drew the pair as ordinary one-tap buttons. The rule is now
**structural rather than a phrase list** — the bare `Yes` is the only narrow approval and any
yes that qualifies itself is read as saying what more it grants — because a phrase list only
knows the phrases it has met and the asymmetry is stark: a yes wrongly called broad costs one
extra click, a yes wrongly called narrow is a standing grant bought on one, from anything on
the LAN. Three kinds now, not two (`approve` / `approve-always` / `approve-mode`), and both
clients arm anything that is not the narrow `approve` — spelled as a negative on purpose,
since naming the broad kinds is exactly how `approve-mode` nearly shipped unarmed on the
phone. One carve-out: the trust gate's `Yes, I trust this folder` stays `approve` — measured,
both widths, `test/pane.test.js` pins it — because that screen is *refused* rather than
classified. `web/trust-gate.js` reads labels and copy, never a `kind`, so no rule in
`classify` decides whether the gate is answerable, and moving its kind would only edit a
recorded measurement.

## A wrapped option label, and the tip line

**An option label wraps, and the run walk used to break on the tail.** At 70 columns that
same box wraps option 3 onto `      for you`, the walk stopped there, the run came back one
option long, it failed the two-option floor and `parsePrompt` returned **null** — so on a
narrow terminal the panel drew "the prompt could not be read" over a perfectly ordinary box.
The tail is joined onto the option above it, and **the alignment test is the whole of what
makes that safe**: this is the one place the parser reads an *unnumbered* line as part of an
option, so the tail must be indented to at least that option's own label column, and a run
whose lines don't line up breaks rather than joins. Without it the join is just "swallow the
next line", which is how a body line above the run — `   cat /private/tmp/probe.txt` sits at
three columns, a real tail at six — gets spliced onto an option label that will then be sent
to the server as `expectLabel`. Declining beats guessing here for the usual reason: a box the
panel refuses to read is answerable in the terminal, a box it reads wrongly is not.
Both widths now yield identical labels, which is also what keeps `expectLabel` honest if the
terminal is resized between the render and the click. Same lesson as "A question wraps, and
so do its options", one box over — `test/fixtures/prompt-bash-broad{,-narrow}.txt` pin it,
and `test/permission.test.js` pins the refusals: misaligned by two columns, and not indented
at all.

**…and the box's own advice used to win the subject slot, on exactly the prompts where the
command matters most.** Claude Code prints a tip *inside* the box, between the title and
the subject — `Tip: auto mode handles these prompts for you — choose "switch to auto mode"
below` — and the body walk took the first line under the title, so the tip became `subject`
and the command was demoted into `detail`. The card header read `Bash command · Tip: auto
mode handles these prompts for you — choose "switch to`, truncated mid-word, on the desktop
and with less room still on the phone. And it appeared **only** on the prompts that offer
the auto-mode row — the ones that grant something broad — so the loudest slot on the card
showed advice where reading the command matters most. Nothing about the digit or the
classification was ever wrong; only the line a human reads, which is the whole of "prefer
showing nothing over showing something wrong".

`dropTip` removes it rather than keeping it as a field, and the reason is that **nothing is
lost**: the tip's whole sentence is already on the card, carried by the option it is advice
about (`3. Yes, and switch to auto mode · auto mode handles these prompts for you`), sitting
against the button that acts on it — and the panel classes that option `approve-mode`, the
broadest thing on the box, and arms it behind a second click, so repeating the nudge in the
card's own voice would be the panel arguing for the thing it guards against. A `tip` field
nobody renders is dead weight that invites a later reader to render it.

Three measurements it rests on, taken on v2.1.257 in the sandbox. **The tip wraps, flush.**
At 220 it is one line, at 70 two, at 40 three, and every continuation sits at the *title's*
own column while the subject and detail are indented past it — so a walk that dropped only
the line matching `Tip:` would leave `auto mode" below` as the subject, the same defect one
line down. **Two independent stops**, either first: a blank line (the box puts one between
the tip and the subject at every width) and a deeper indent. Each is pinned on its own in
`test/permission.test.js` — remove either and a test fails. **And only auto-mode-offering
prompts carry a tip at all**: `Edit file` and `Create file` offer `switch to accept edits`
and get none, which is why the fixtures are Bash prompts. The honest limit, since no rule
could cover it: a tip followed with no blank by a subject at the tip's own column would be
indistinguishable from a wrap. No prompt shape produces that today.

The match is anchored and narrow (`^Tip:\s`) on purpose, and note it runs the *opposite* way
to `classify` one function up. There, a phrase list is the wrong shape because a yes wrongly
called narrow is a standing grant. Here the asymmetry inverts: a tip we fail to recognise
costs one wrong header line — today's bug — while a body line wrongly taken for a tip loses
the command from the card entirely: same reasoning, opposite answer.

## Permission prompts never reach the transcript

**Permission prompts never reach the transcript.** The pane is the only source — and the
converse bit them: prompt-*shaped* text in the transcript was read as a live box. A session
editing this repo shows diffs of the permission fixtures, so "Do you want to proceed?",
`1. Yes` and `Esc to cancel` scroll past while it works. `parsePrompt` and `DECISION_RE`
are now gated on the composer being absent, the same test dialogs already used: if Claude
Code is drawing somewhere to type, nothing above it is waiting on an answer.

## A question box reads as needs-decision

**A question box also reads as `needs-decision`.** The composer must offer the question
card *first* and fall back to the permission bar, not the other way round — with the
branches in the other order the panel showed "the prompt could not be read" while holding
a perfectly parsed question.

## A blocked session reports no model

**A session that is asking you something reports no model.** Model and `ctx:` are scraped
off the composer footer, and a question box, a permission prompt or a picker covers it
completely — so `scrape.model` is `null` for exactly as long as the session is blocked,
which can be hours. This is the `bypass` trap again and it was missed the first time:
`rememberFooter` in `sessions.js` keeps the last real footer per pane, the same way
`#bypass` keeps the last real mode line, and the two values move together because they are
one line (a footer drawn without a `ctx:` clears the percentage rather than leaving a stale
number beside a live model). Effort escapes all of this by living in the transcript. What
made it expensive: `shortModel` in `web/app.js` did `model.replace(...)` unguarded, so the
null threw *inside* `buildComposer` — after it had decided to draw the question card — and
unwound the whole build. No card, no textarea, and every later roster broadcast threw again
in `updateComposerHint`, so the pane never healed. The one session you could not answer was
the one asking you something. Both halves are fixed; keep both.

## Ghost text

**Ghost text is one line, it is not one dim run, and the terminal truncates it — three
separate measurements, and getting any of them wrong ships a wrong suggestion.** The
composer's suggested next prompt is `❯` + U+00A0 + the text, dim, and `server/ghost.js` is
the only thing in this repo that reads the attribute. Measured on v2.1.257 at 220, 70 and
34 columns:

- **The attribute is re-emitted per word as often as not.** The same phrase came back as
  one `\e[2m…\e[0m` in one capture and as `\e[2mfix\e[0m \e[2mslugify\e[0m …` in the
  next, spaces between the runs carrying nothing at all. "Read the first dim run" therefore
  answers `fix` on one capture and the whole phrase on the other — from the *same session
  at the same width*. The rule is **every non-blank character after the caret must be dim**,
  which comes out identical everywhere, and the tests pin that both widths spell one string.
- **Typing removes the dim entirely**, so that structural test *is* the "only when the box
  is empty" guard rather than a second check beside it. A working session draws the same
  empty input line with no dim run, so it answers nothing here either.
- **It truncates rather than wrapping.** At 34 columns the suggestion read
  `fix slugify and add a test for …` — an ellipsis, no second line to collect. A read
  ending in one is **refused**: prefilling somebody's composer with a literal `…`, or with
  auto-send on *sending* it, is the "showing something wrong" this file keeps choosing
  against. So a narrow terminal shows no line at all, which is correct and is not a bug.
- **`38;5;2` is an ordinary 256-colour green whose colour index is 2.** A parser reading
  each `;`-separated number on its own takes that for SGR 2 and hands back typed text as a
  suggestion — the one false positive that ends with the panel offering to send somebody's
  half-written message. The extended-colour forms are consumed, not scanned.

Two things about where it sits. It takes its **own** `capture-pane -pe`, gated on the pane
being plainly `idle` and riding inside the roster poll's existing `Promise.all` (2.9ms) —
switching the shared `capturePane` to `-e` would put ANSI bytes in front of all five
numbered-screen parsers to buy a muted line, and `-p` output was measured byte-identical to
stripped `-pe` output, which is exactly the kind of "it'll be fine" that this file is a list
of. And `rememberGhost` **drops** the suggestion the moment the pane stops being idle rather
than holding it the way `rememberFooter` holds a model: a stale model is a wrong label, a
stale suggestion is a wrong *button*.

On the client it is above the composer and **never in the transcript** — an offer that
expires is not something that happened — it is deliberately outside `composerSig` (a
suggestion changes at the end of every turn, and a signature carrying it would tear the
textarea down under a reader's cursor), it goes **before** the interrupt button so that
button still never moves, and it is gone while the box has anything in it, which is what
makes "use" unable to destroy a half-written message. The auto-send flag is half its
repaint signature, not decoration: without it a button reading `use` stays behind a setting
that now sends — and it lives in `web/prefs.js`, imported by the desktop and by both phone
files, because `/` and `/m/` are one origin and two spellings of one `localStorage` key is
a setting that appears to work. `web/trust-gate.js`'s reasoning, in the trust-gate trap.

## The footer's rotating slot

**The footer's right-hand slot rotates.** It shows `/rc`, "new task? /clear to save…",
and *sometimes* effort. Read effort from the transcript (`effort` on every assistant
record), never by scraping. Model and `ctx:` are stable in the footer and are read there.

## bypass permissions is not a mode

**`bypass permissions` is on the mode line but is not a mode.** A session started with
`--dangerously-skip-permissions` draws `⏵⏵ bypass permissions on` exactly where every
other session draws `auto mode on`, so `parseBypass` reads it off the same line — free,
live, and better than the `ps` walk an earlier version used, which could only report how
a session was *launched*. It must never join `MODES`: that list is the shift+tab cycle
`changeMode` steps through, and an entry there would give the panel a way to switch a
session into running without asking. `null` (no mode line on screen, because a box or a
picker owns the footer) is not `false` — `sessions.js` keeps the last real answer per
pane, or a session stops looking dangerous for as long as it spends asking you something.

## Modes only cycle

**Modes only cycle.** shift+tab steps `auto → manual → accept edits → plan → auto`.
There is no way to jump. `changeMode` presses and re-reads until it matches — never
count presses. It refuses while a permission prompt is open, where shift+tab means
"amend".

## Sending is two paths

**Sending is two paths.** Single line → `send-keys -l` (this is what makes slash
commands execute). Multi-line → bracketed paste (`-l` would submit each line separately).
Before either: `C-u` to clear the prompt, and re-check the pane still runs Claude — the
roster is up to a poll stale, and a session that exited leaves a shell that would
*execute* your text. Force `LC_ALL` or `-l` mangles non-ASCII.

## A modal makes a session look idle

**A modal makes a session look idle** — and the hook agrees with it. While `/model`,
`/effort`, `/config`, `/resume` or an `AskUserQuestion` box is open, nothing is running,
so `Stop` has fired and the hook says `idle`. `parsePane` returns `dialog`, and it outranks
the hook exactly the way a permission box does.

The test is the **absence of the composer footer**, and nothing else. An earlier version
also required a key-hint line (`Esc to cancel`) and that was too clever: the review screen
a multi-select ends on has no hint at all, so it read as `idle` — and its two options are
"submit" and "cancel". If Claude Code will accept typing, it draws the box to type into.
`❯` is useless as a composer marker; every picker marks its selected row with one.
`test/fixtures/dialog-*.txt` are real captures — regenerate them rather than editing.

## The plan-approval box

**The plan-approval box inverts the option-2 rule.** When a session leaves plan mode
Claude Code draws `Claude has written up a plan and is ready to execute. Would you like to
proceed?` over a numbered run — and here **option 1 is the broad yes**, exactly backwards
from a permission box. Worse, the list is built at every render (`iPw` in the bundle, 2–5
rows), so the safe answer is at no fixed number, and the first row can be
`Yes, clear context (N% used) and bypass permissions` — one press that throws the
conversation away *and* stops the session ever asking again. A digit selects **and
submits**, verified by hand. `plan.js` owns it, answers by the option's own digit, and the
card puts the *narrow* yes first because the top button is the one that gets pressed
unread.

Two more things about that screen. Its free-text row's sub-line sits *below* the numbered
run, so `readOptionBlock` never attaches it and `plan.js` looks one line past the end —
miss it and "Tell Claude what to change" becomes a button that opens a text input in a
terminal nobody is watching. And `shift+tab` there means **approve with this feedback**,
not "cycle mode": `Enter` is what keeps planning. `changeMode` now refuses explicitly
while a plan box is up; before, it only refused because it couldn't read a mode.

## What a digit means, per screen

**A question box looks like a permission box and answers nothing like one.**
`AskUserQuestion` renders numbered options under an `Esc to cancel` footer, so it reads as
a permission prompt and is not one. `question.js` owns it; `permission.js` must keep
refusing it (the run 1..N breaks at the rule above `6. Chat about this`, which is the only
thing stopping answer buttons appearing on the wrong parser). What a digit *means* changes
per screen — and nothing on screen tells you when you get it wrong:

| screen | a digit does |
| --- | --- |
| single-select, one question | selects **and submits** |
| single-select, in a set | selects and **moves to the next question** |
| single-select with a preview panel | **moves the cursor only** — `Enter` selects |
| multi-select | **toggles** that row; `Tab` then `1` submits |
| review | `1` **submits everything**, `2` cancels |
| `Type something.`, single-select | **opens an editor** on that row — type, then `Enter` |
| `Type something`, multi-select | **ticks it**, cursor unmoved, no editor |
| `Chat about this` | **declines the questions** and hands the composer back |

## Chat about this, and Type something

**The two rows below the rule are the only way to answer in words, and they were missing
from the card.** They sit outside the numbered run — `permission.js` refuses the box
*because* of that rule — so the panel showed 1..3 of a box that offered five things, and a
question whose answer was "neither" could not be answered at all: while a box is up the
composer queues instead of sending. `planChat` and `planFreeText` own them now, and note
how little they have in common. **Chat** is one press on every layout and always the same:
the tool call is declined (`User declined to answer questions`), the box closes, the
composer is free. **Type something** is three steps — the digit opens an editor on the row
(the footer grows `ctrl+g to edit in Vim`), what you type *replaces the row's label*, and
`Enter` sends it — and it is **single-select only**, because on a multi-select the same
digit merely ticks the row and anything typed after it lands nowhere. All of it pressed by
hand; nothing on screen says any of it.

Two consequences of the label being replaced. The box stops matching `Type something.`, so
recognition had to grow a second witness (the numbered `Chat about this` row) or a
half-typed box stops parsing as a question and the card vanishes from under whoever is
typing — `test/fixtures/dialog-choice-typed.txt` is that state. And the endpoint verifies
the typed text against the **raw capture**, not a re-parse: at that moment the screen is a
question box whose free-text row no longer looks like one.

## A question wraps

**A question wraps, and so do its options.** `questionAbove` took the nearest line only, so
a card read *"lighter preparation-and-reminder track?"* over a terminal asking "Should
durable_power_of_attorney be a full first-class workflow, or a lighter
preparation-and-reminder track?" — the half carrying the subject was the half dropped. It
now collects upward to the box's own chrome, and stepping past a rule is only safe *before*
anything is collected, or a wrapped assistant line gets spliced onto the front. Descriptions
accumulate for the same reason (they ended mid-clause). `dialogTitle` in `tmux.js` had the
same bug from the other end: it takes the line ending in `?`, which on a wrapped question is
its tail — the composer hint read "together? is open in the terminal".

## The preview panel

**Some question boxes draw a preview panel beside the options.** The mock-up sits welded
onto the option lines in `capture-pane` output, which corrupts every label and pushes the
option run out of the tail window the block finder searches. `stripPreviewPanel` cuts the
box back to the panel's column — starting at the panel's own first row, since the question
line above it is full-width and would otherwise be beheaded. That layout also drops the
`Type something.` row and leaves `Chat about this` unnumbered, so a question box is no
longer recognised by the free-text row alone. And it navigates differently: the digit only
moves the cursor there, so `planAnswer` appends `Enter` (`needsConfirm`). Both behaviours
were pressed by hand in a scratch session — a plain box still selects on the digit alone,
and previews are single-select only, so a multi-select never takes this path.

## Attaching a Terminal resizes the pane

**Attaching a Terminal resizes the pane, and pane width is an input to every parser here.**
`+ new` can start a session detached (`terminal: false`) and the pane header offers to
attach one later — but the launcher opens sessions at 220×50 and a default Terminal window
is **80×23**, measured on a scratch session, not guessed. Nothing breaks (the fixtures keep
a narrow capture of every box for exactly this reason), but a pane you last read at 220
columns is a different shape of screen the moment somebody presses that button, and the
option boxes, the plan header and long labels all wrap differently. The button deliberately
sets no size: forcing 220 back would leave you scrolling sideways in the window you opened
to read it. Its tooltip is the only warning, so don't remove it.

The button is drawn from `#{session_attached}` on the roster row, read live off tmux each
poll — never from how the session was launched. A window you close an hour later has to
bring the button back, and one you open has to make it go away; a launch-time flag does
neither. It is also the one control in the header that sends no keys, which is why it has
no `assertNotBlocked` guard: there is no keystroke to land in the wrong place.

## A multi-select's keys are a diff

**A multi-select's keys are a diff, not a selection.** The box remembers what is ticked, so
sending the digits you want turns *off* anything already on. `planAnswer` compares against
what the pane shows and presses only the difference — `test/question.test.js` pins it.

## Never submit a multi-select unread

**Never submit a multi-select without re-reading the review.** `Tab` opens a screen listing
what is about to be sent; the endpoint re-parses it and refuses the submit digit unless
every chosen label appears there. Selections made and nothing submitted is a recoverable
state. A wrong answer sent on the user's behalf is not.
