# Rail and groups

The evidence behind the **Rail and groups** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps
index — the rail is a flat list of siblings, and everything drawn on it (the indent, the
tint, the spine, the fold, the group colours, a team row's third line) is built on top of
that one fact; the front end's own cascade traps are here too. Each section below is one
trap, opening with the bold sentence its index line quotes.

## The shared shell and the pane factory

**`web/app.js` is one shared shell plus a `createPane` factory.** Everything per-session —
the selected id, its messages, `streamEl`, `composerEl`, `chipNodes`, the completion popup
— lives inside the factory, because split view means two of them at once. The roster,
drafts and the thinking toggle stay shared outside it. Adding per-session state to module
scope will work perfectly until someone opens a second pane.

## A flat list of siblings

**The rail is a flat list of siblings, and three things depend on it.** There is no nesting
for CSS to key off, so the indent inside a group is a class added in `renderRail`, not a
descendant selector. `.folder-label.in-group`'s sticky `top` is a hand-measured offset for
the group header's height — change that header's size and this moves too. And an open
group's tint is *tiled* from three full-width siblings rather than painted on a container,
which holds only while none of them carries a vertical margin: the gap between groups is
`margin-top` on the next header, deliberately outside the tint, and the block's bottom edge
is `in-group-last`, marked in JS because nothing in a flat list knows it is last.

The spine — the 3px coloured bar a group's rows carry down their left edge — is a second
tenant of that exact constraint, and got it for free: `.shelf-label`, `.folder-label.in-group`
and `.session-row.in-group` all already pad *inside* their box, so their left borders land on
the same x without anything new being measured, and the two places the tint breaks
(`.shelf-label`'s `margin-top`, `.in-group-last`'s `padding-bottom`) are the two places the
spine breaks too. The two heading kinds give back exactly the 3px the border adds, out of
their own `padding-left`, so nothing they contain moves sideways when the border appears.
And `.folder-label.in-group`'s sticky offset — hand-measured against the group header's own
height, per the line above — was re-measured rather than assumed at two different points in
the rail redesign, once when the spine first landed and once again after the header grew its
`+` and `⋯` controls, and came back unchanged both times. That is the lesson worth keeping,
not the figure: read the header's actual height off the DOM before trusting the offset,
because anything that changes the header's padding — this one included — moves it, and a
number copied out of an old PR body is exactly the kind of thing that goes stale here first.

`--shelf` is `color-mix(in srgb, var(--ink) 4%, var(--surface))` on purpose: one line that
darkens the light theme and lightens the dark one. It must not be `--surface-sunk`, which
is what a row's hover uses — a tinted group whose rows stopped reacting to the cursor would
be a bad trade.

`--row-open` is the same trick and exists because the selected row has to be legible over
**three** backgrounds at once: plain surface, `--shelf` inside an open group, and
`--surface-sunk` under the cursor. It used to be `--accent-soft`, which is a button hover
tint a couple of points off the surface, and against any of those three it was invisible —
the bug report was a screenshot of the rail where you genuinely could not tell which row was
open. 22% of the accent clears all three. Two things beside it: the 3px left border is
carried by *every* row as transparent, because growing it on the open row alone steps that
row's content sideways as the selection moves; and `.is-open` deliberately beats `:hover`
(it is later in the file), since a selected row that changed under the cursor would flicker
between two strong states every time the mouse crossed the rail.

## A team row is three lines tall

**A team row is three lines tall, and every other row must stay two.** `worker · agent/<id>`
under a worker, `lead · N tasks` under a lead — chosen over a coloured stripe and over a
fifth badge, and the *only* thing that makes it affordable is that it lands on nothing else. Generalising it to ordinary rows undoes the trade. Three things it
has to respect: the extra line rides in the meta line's grid columns (`grid-column: 2 / -1`,
auto row) so nothing above it moves; it carries no margin that escapes the row, because an
open group's tint is tiled from full-width siblings and a gap anywhere would cut through it;
and only the *fact* half ellipsises — the role chip never shrinks, since a branch name is
long and the rail is 20rem. The `lead` badge was **moved** here, not copied: the meta line
is for state and a role is not state, and a lead is exactly as findable as it was because it
is the same chip one line down. The role comes off the roster's `team` field — `sessions.js`
joins the task store on `tmuxSession` and `isLead`/`workerOf` are read back out of that one
answer, so the rail cannot be told a row is a worker in one field and something else in
another. It is gated on `OPEN_STATES`: a `done`, `failed` or `abandoned` task is not a task,
and a row that kept naming one would name a branch that has been merged or swept. `team` is
in `#diff` for the same reason — a task closing changes that line and nothing else on the
row.

## A role is launch flags

**A role is launch flags, so anything that relaunches a session has to know the role.**
Snapshot/restore replayed every saved entry through `createSession`, which is how a saved
**team lead** came back as an ordinary session that merely happens to be called `lead` — no
brief, no `foreman` tools, no permission stance — while the rail, which reads the role off the
*name*, went on badging it as the lead and counting its tasks. The one row a reader would
trust most was the one lying, and nothing on screen said so. Restore now sends a lead entry
through `launchLead`. Three things about the fix that will matter again:

- **No new field says "this was a lead".** `isLeadName` lives in `launch.js` (with the
  naming contract it reads) and both the rail and the restore ask it, so the two cannot
  disagree — a stored `lead: false` beside a `slug: 'lead'` would recreate this exact bug
  in a form that survives every test that only checks the flag. It also means there was
  nothing to migrate: a `snapshot.json` saved before the fix already carried `slug: 'lead'`.
- **`startLead` takes a folder and nothing else.** `launchLead` deliberately doesn't plumb
  `skipPermissions` — a bypass lead is not a thing — and the injected launcher's *shape* is
  what keeps a saved flag from finding some other door in. Restoring an entry with
  `skipPermissions: true` was benched: the lead came up `auto mode on`.
- **`launchLead` regenerates the brief, the MCP config and the settings** from current code
  and current `team.json`, which is right and not an accident of reuse — a restored lead
  should be *today's* lead, not a replay of the one that was running before the reboot.

## A worker is not part of the bench

**A worker is not part of the bench, and saving one tells the same lie twice.** A worker
exists because a lead dispatched it against a task, in a worktree the panel deletes at
close. Relaunched, it gets no worker brief and no tools, comes up joined to a task record
that still says `working` — so the rail draws `worker · agent/<id>` over it and the lead's
`worker_read` reads a session that has never heard of the task — and half the time its
worktree has been swept, so the launch just fails. Planners are the same story: a
`kind: 'plan'` task is still `role: 'worker'` to `sessions.js`, and the one thing you would
want back — the plan — was never in the checkout anyway. `benchEntries` leaves them all out
by **role** and by the folder being under `WORKTREES_DIR`, because the first goes null the
moment the task closes while the pane is still sitting in the doomed checkout. Note the
role test is written as an allow-list — no team, or `lead` — and not as "not a worker":
kinds have already grown once, and the day a planner gets a role of its own, a negative
test starts silently saving sessions nobody can restore. `drift` filters the live roster
the same way, or every dispatch lights the rail's stale-snapshot dot and it stops meaning
anything.

## How a group is filed

**A group is filed by the name the rail draws, and the dispatch filed a path.** The rail
keys folders by `basename(cwd)` — that is what `s.project` is — but `task_dispatch` filed
`wt.dir`, the absolute worktree directory. It matched no session that has ever existed, so
every team heading read `· 0` with its workers live three rows below it, and it looked
exactly like the staleness bug it was found next to. Two spellings are now on disk in front
of a reader, which is why `retireWorktree` unfiles both — and why it only reaches for
the basename when the path is genuinely under `worktrees/`: closing a task must never
quietly unfile a real project that happens to share the name.

## An empty heading isn't drawn

**A heading with nothing under it isn't drawn, and "nothing" is measured after hoisting.**
`renderRail` skips a group whose `count` is 0 — computed from the rows it is *about* to
draw, which is what makes it agree with the screen: a group whose only session is up in the
inbox reads as empty here and is right to, because the row is on screen two headings
higher. Note what it costs, since nothing on screen says it: a group with nothing running
anywhere has no heading, so there is nothing to rename or delete it from until one of its
folders wakes up. Its folders can still be re-filed from the folder menu, which lists every
group. And when you remove rows from a flat list, check the tint: it is tiled from three
full-width siblings, so a group must go as a whole block or its edges come apart —
benched with a lone group first, last and alone between two hidden ones.

## What a collapsed group hides

**A collapsed group hides one thing for ordinary rows and two for workers.** For an
ordinary session and for a lead, folding is safe because the inbox hoists anything blocked
or unread *out* of its folder first — but **working** is neither, so a busy session is the
one state a closed group can genuinely hide. Hence the pulsing dot on the heading, drawn
only when collapsed, and now a second line beside it: `2 working · newest 4m · 3 tasks`.

The hoisting rule then changed, for workers alone. A worker's permission prompt is its
lead's to answer and its finished report is its lead's to read, so a worker row no longer
hoists until `stuck` fires (`stuckAfterMinutes`, default 20) — a deliberate call, taken
knowing that a blocked-but-not-yet-stuck worker inside a *collapsed* team group is therefore
not visible. The trade was bought with the lead row's `N waiting` count, which names the
same fact the inbox stopped showing, and backstopped by the stuck timer, which
puts the row in the inbox for real once it has actually been abandoned there.

## The collapsed group's dot

**The dot used to cover only the ordinary-row half of that trade, and now covers both.**
`renderRail` pulls nested workers out of `rest` before the folder map is built, so the
group's own `count` — top-level rows only — was also, until this, the set the dot and
`busy` were computed over: a worker working inside a collapsed team group lit nothing at
all until the stuck timer fired twenty minutes later. `web/group-summary.js`'s
`groupSummary` closes that hole by reading the **worker-inclusive** set instead — the same
`expand()` the fold rule already builds, folded workers included — so the dot and the new
summary line both count a busy worker the moment it starts, not twenty minutes after. `busy`
itself is gone from the group loop; the module's `working` is what feeds the dot now. The
accepted cost, taken on the maintainer's own ruling: a collapsed team group now pulses when
*only* a nested worker is busy and every top-level row in it is idle — worth knowing before
reading a quiet-looking heading as quiet. The header's own `· N` is untouched and still
counts top-level rows alone, which is why it and the summary line one row down can
legitimately disagree — `· 1` on the heading, `3 working` in the line below it, both true.

## The spine and the marker

**The spine runs at half strength and the marker at full, and that split is measured, not
sketched.** `--row-open`'s own reasoning is three signals, not one — a filled band, an edge
thick enough to read as a marker, and a title at full ink — and inside a group the edge
would otherwise be the group's own hue against the group's own hue, no step at all: exactly
the state `--row-open` was built to get *out* of. 50% is the point (within half a point of
49.5%) that maximises the *weaker* of the two things pulling against each other — the
spine's contrast against its worst ground and the marker's step over the spine — rather than
trading one for the other. In dark theme the binding ground is `--shelf` (contrast 1.68 –
3.09) and the marker's step over the spine is 1.96 – 2.70 (ΔE2000 18.0 – 27.2 minimum); light
theme's binding ground is `--surface-sunk` (1.68 – 2.45) with a 1.65 – 2.98 marker step. The
amended mockup's own drawing — spine and marker in one colour — was refused for exactly
this reason once it was measured rather than eyeballed.

## The row is not a button

**A `▾` on the row's own path can't be a `<button>`, because the row it sits inside already
is one — or was.** Interactive content cannot nest, and a `<span role="button">` inside a
real `<button>` is exactly as invalid as a nested `<button>` would be, since the restriction
is on interactive content and not on the tag. So `.session` is now uniformly `<div
role="button" tabindex="0">` with its own `keydown` handler answering Enter and Space by
hand — every row, not only the folded ones, because two element types for one row kind is
two focus behaviours and two stylesheets to keep honest. The one thing carried over from the
`button {}` reset is `cursor: pointer`; nothing in the stylesheet ever selected
`button.session`, every rule is a class. It also retired an invalid attribute that had been
sitting there unnoticed: `aria-selected` belongs to `option`/`tab`, not a button or a
`role="button"` div, and is now `aria-current` — set only on the open row, so a screen
reader isn't walking past `aria-current="false"` on every other one.

## The fold's title split

**The fold's title split is bound to the folder, never to the string's own last dash.** A
row's title is `label || meta.title || project`, and `label` — the thing that would make a
dash-split safe — is present only for sessions this panel itself minted; anything else falls
back to Claude Code's own `customTitle`, which several launchers derive as `<repo>-<branch>`,
CLAUDE.md's very first trap and the reason one folder on the machine this was built on held
96 transcripts under one title. Splitting *that* on its last dash hands back a "path" that is
a repo name, not the folder the row is actually filed under. So the split only fires when the
title begins with `${s.project}-`, and a title that can't be split that way keeps its
folder's heading rather than getting an invented path — honest rather than worked around,
and it means a session started by another launcher never folds.

## The spine's ring of ten hues

**The spine's ring is its own ten hues, measured to a different rule than the room's seven,
and the slot order is itself a measurement.** `--peer-N` is *text* on `--ground`, held to
7:1; the spine is a **non-text graphic** sitting on `--surface`, `--shelf` and
`--surface-sunk` at once, so it is held to WCAG 1.4.11's 3:1 against all three — light
theme's binding ground is `--surface-sunk` (3.00 – 6.48), dark's is `--shelf` (3.66 – 8.27).
Every one of the ten also has to clear a floor of ΔE2000 from `--working` / `--decision` /
`--accent` / `--idle` / `--mode-edits`, the same reservation the peer ring makes, measured
here at 12.50 (light) / 12.59 (dark) minimum. And because slots are handed out 1, 2, 3… in
creation order (`assignColour`: least-used, ties by lowest index), the ten lines in
`web/tokens.css` are not listed by hue — they're ordered to maximise the gap between
*consecutive* slots, since consecutive slots are the pairs a real rail draws next to each
other: 48.33 (light) / 50.22 (dark) ΔE2000 minimum between neighbours. `GROUP_COLOUR_COUNT`
is spelled once in `web/group-hue.js` and `test/group-hue.test.js` pins it against the actual
count of `--group-N` tokens, because CSS cannot import a constant and the two would otherwise
drift silently.

## GroupStore drops an unknown field

**`GroupStore` drops a field it has never heard of, the same way `TaskStore` drops a whole
record.** `#load` rebuilds each group from named keys and `#flush` rewrites the file from
that rebuild two seconds later, so a `colour` written by this feature and then rolled back
past it is silently erased on the next flush — milder than the task-state version of this
(there whole records vanish; here the colours re-assign themselves on the next boot), but
the same family. **Back up `groups.json` before rolling back past #145.**

## The menu item's display rule

**`.menu-item`'s `display: flex` beat `[hidden]`, the same way `.files-grid`'s did.** The
group `+` menu's filter box hides non-matching rows by setting `.hidden`, and `.menu-item`
carries an unconditional `display: flex` that outranks the `[hidden]` UA default — so a
filtered-out item stayed on screen, just no longer clickable in the way its position
implied. `.menu-item[hidden] { display: none }`, scoped rather than a blanket `[hidden]`
override, is the same fix in the same shape.

## Turning flex-wrap on

**Turning `flex-wrap` on hands the container's own `gap` to the row gap as well, silently.**
`.shelf-label.collapsed` wraps so the new summary line can sit under the header's first row,
and `.shelf-label`'s `gap` — measured for the items sitting on its *one* line — became the
step between that line and the summary the moment wrapping was enabled, measured at 28px
where 22 was asked for. `.shelf-summary`'s `row-gap: 0` sits beside the wrap for exactly that
reason, and it is a trap worth remembering anywhere else in this stylesheet a `flex-wrap` is
switched on after the fact.

## An automated Chrome window

**An automated Chrome window answers no keyboard input and no CSS transition, and both bit
this feature.** `document.visibilityState: 'hidden'` is what an automated window reports,
which is the same fact the room panel's `ResizeObserver` trap and the files gallery's `lazy`
trap already carry, in new clothes here: the window delivers no *trusted* keyboard event, so
keyboard proof for the row's new `div role="button"` had to go through dispatched events
rather than a real keypress, with mouse clicks proven separately; and it suspends CSS
transitions and animations outright, so `getComputedStyle` on a transitioning opacity reads
the *from* value forever and a hover/focus state measured against a live `transition` has to
force `transition: none` first or the numbers are simply wrong. The same suspension is why a
pulsing dot's presence has to be read off the DOM (is the node there, does it carry `.dot
working`) rather than off whether it visibly pulses in a bench screenshot — the animation
itself does not run in an automated window even when the element is drawn correctly.

## A static copy of web/

**A static copy of `web/` needs `/vendor/marked.js` in place, or the page 404s silently
while still looking fine.** `app.js`'s first line is `import { marked } from
'/vendor/marked.js'` — served in the real panel from `node_modules/marked/lib/marked.esm.js`
by a server route, which a bare static file server over `web/` doesn't have. The failure is
quiet: the page paints its static HTML, the module import 404s in the console, and nothing
in the rail ever renders, which reads like a fixture problem rather than a missing file. Copy
`marked.esm.js` into the static copy's own `vendor/marked.js` before benching anything.

## A fifth button in the rail head

**A fifth button does not fit the rail head at the default width.** Measured on a scratch
panel at `--rail: 20rem`: `+ new` / `snapshot` / `briefs` / `recent` / `settings` are 297px
of buttons plus four 6.4px gaps against 284px of content width — 39px short, so `settings`
wraps to a second line and the list loses a row. One line returns at 22.5rem. It is a state
`.rail-actions` already supports (`flex-wrap` and a `row-gap` are both there deliberately),
but that comment was written about the 14rem *floor*, and this now happens at the default.
Anything adding a sixth control to that row is adding a third line, not a second.

## The phone's five stylesheets

**The phone loads five stylesheets into one `<head>`, so a class the shell shares with a
screen is a class the screen wins.** `web/m/index.html` links `m.css` then `lead.css`, and
each is owned by a different build item precisely so they never collide in that head — but
the guarantee is about *files*, not about *names*. `lead.css` already owned `.m-tab` for the
lead screen's own chat/tasks pair, so a tab bar added to the shell under the same name came
up wearing the lead screen's colours and its 34px height, while the shell's own declarations
leaked back onto the lead screen's tabs in return. Neither screen looked broken: only one of
them is ever on screen at a time, which is exactly what makes this cost nothing until it
costs an hour. Caught by measuring a target written `min-height: 44px` and reading back 34.
The shell's controls are `.m-nav-*` for that reason, and the general rule is that a new class
in `m.css` is grepped against the four sheets below it before it is written — the cascade,
not the file split, is what decides.
