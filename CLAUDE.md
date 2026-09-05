# Foreman

One local web panel for every Claude Code session running on the machine. Read the
conversations, see status, type back — without hunting for the right terminal window.

`npm run install-agent` once, `npm run restart-panel` after any `server/` change →
http://127.0.0.1:48770 (the LaunchAgent's own job environment carries the bind host).
`npm start` is the scratch-server command only. `npm test` runs the parser tests.

**The panel does not own the sessions it shows.** Most are started by something else — a
terminal, a shell function, another launcher — and the panel finds them; it can also start
one itself, from `+ new`, from a row's `⧉`, by restoring a snapshot, or when a team lead
dispatches a worker (`server/launch.js`). It still starts nothing on its own: a dispatch
happens because a lead asked you first. It *ends* a session
in exactly two places — the bin on a rail row, and a task closed `done` once its PR is
verified merged. Everything else it does is observe and inject. See `docs/panel.md` for how each
feature works and `docs/team.md` for the team; this file is the things that will bite you.

**Five screens, five parsers, and they must keep refusing each other's boxes.**
`permission.js` (a permission prompt — every yes past the plain one is broader, and there
can be more than one of them), `question.js`
(`AskUserQuestion` — a digit toggles, advances or submits depending on the layout),
`plan.js` (the box that ends plan mode — option *1* is the broad yes, and it can be "clear
context and bypass permissions"), `model.js` (`/model` — where a digit commits **as the
global default**, so the cursor is stepped and `s` commits instead, and where `s` sometimes
raises a second box that *is* answered by a digit) and `effort.js`
(`/effort` — not a list at all but a marker on a track, and the only one with **no
session-only path**: its Enter writes `effortLevel` for every future session). They look
alike on screen and answer nothing alike. `test/plan.test.js`, `test/model.test.js` and
`test/effort.test.js` pin the cross-refusals; keep it that way.

**And there is a sixth screen that is not a parser, because nothing may answer it.** The
folder-trust gate parses as an ordinary permission box — full prompt, no `dialog`, option 1
`Yes, I trust this folder` — so the panel has to *recognise* it in order to refuse it.
`web/trust-gate.js` is that one witness, shared by the desktop composer, the phone and the
answer endpoint. See the trap under Traps; it is the one screen where reading it correctly
and offering a button are the same mistake.

**And one seventh thing that is a parser but is not a screen.** `ghost.js` reads the
composer's *suggested next prompt* — dim text inside the input line rather than a box over
it — so it refuses nothing and is refused by nothing; it simply answers `null` for every
pane that is not idle with a suggestion in it. It is the only reader in this repo of
`capture-pane -pe`, and the only one that would be wrong to fold into `parsePane`. Its trap
is under Traps and it is sharper than its size suggests.

---

## The substrate

There is no API. Everything is assembled from three places:

| Source | Gives |
| --- | --- |
| `tmux list-panes -a` | the session roster, and the channel to type into |
| `~/.claude/projects/**/*.jsonl` | message history, already structured |
| Claude Code hooks → `POST /hook` | live status, and pane↔session binding |

`server/` is one module per concern. The ones with real subtlety all have tests: on the
panel side `binding.js`, `permission.js`, `question.js`, `plan.js`, `model.js`,
`effort.js`, `ghost.js`, `queue.js`, `claim.js`, `status.js`, `settings-file.js` and `parsePane` in `tmux.js`; on the team side `tasks.js`,
`team.js`, `room.js`, `worktree.js`, `setup-detect.js`, `forge.js`, `base-branch.js`, `watch.js`, `conflicts.js`,
`gc.js` and `launch.js`. Run them before touching any of them, and note that `test/fixtures/` holds
real `capture-pane` output, not reconstructions — and that the git wrappers are tested
against **real throwaway repos**, because stubbing git to test a git wrapper proves
nothing.

---

## The team

The panel also runs **team leads**: a Claude Code session you talk to, which dispatches
**workers** — other sessions, each in its own git worktree — and brings you only the
decisions that need you. Tick **Team lead** in `+ new` and the folder gets one.
`docs/team.md` describes what a team does and what it deliberately does not. What holds it
together is here: the rules in this section, the Traps below, and the team modules' own
tests, listed under *The substrate* above. Read them before changing any of it.

A role is **launch flags, never files in the repo** — `--append-system-prompt-file` for
the brief (`lead-brief.js` / `worker-brief.js`), `--mcp-config` + `--strict-mcp-config`
for the tools (`mcp/foreman.js`, one hand-rolled stdio server serving two roles), and
`--settings` for the permission stance. No repo gets a new file and no `CLAUDE.md` gets
edited for a session to take part, which is deliberate: a role declared in the folder is
a role handed to every *ordinary* session opened there.

State lives outside every repo, under `~/.foreman/` (resolved, not fixed — see the trap
below): `teams/<repo-key>/` holds
`team.json` (config + autonomy toggles), `room.jsonl` (the append-only team log) and
`decisions.md` (the standing rulings for the repo, which survive the lead's `/clear`); `tasks.json`,
`worktrees/`, `worker-settings/` and `worker-logs/` sit beside it.

Who does what: `team.js` owns the disk layout — and, beside `leadSettings`, the
**planner's** stance (`plannerStance`) and where a plan lands (`plansDir`/`planPath`);
`tasks.js` the task records (including `kind`: `build` or `plan`), `worktree.js` the
checkouts, `setup-detect.js` the worktree-prepare command (read off the repo's own files and
shown read-only, on the rule that a control the user cannot answer correctly should not be
a control — so nothing writes `setup` any more and a wrong command is a bug in detection), `dispatch.js` the worker's settings file, the one trust gate the panel ever
answers, and the worker-model list (`WORKER_MODELS` + `resolveWorkerModel` — the lead picks
each worker's model per task, judged on size and complexity; omitted means the team's
`defaultModel`, Opus, shown as a picker in the team panel; a departure from the default
requires a reason and gets a `system` room line saying which and why, so a human can see
when the lead called it wrong; an unknown id fails the dispatch, which is what keeps
`model` from becoming a general launch-flags channel), `room.js` the log, `watch.js`
transitions + stuck + loop + the nudge, `conflicts.js` the path-overlap scan, `gc.js` boot
housekeeping, `deployed.js` whether a merged task is actually running on this Mac.

**Five rules that do not bend**, each enforced somewhere rather than merely asked for:

- **The lead never writes code.** Its `--settings` denies the checkout and allows only
  its team dir. It reads, decides, dispatches, reviews, reports. No exception for
  one-liners — dispatch a worker.
- **Workers never launch with bypass.** `skipDangerousModePermissionPrompt` is set
  globally, so a bypass worker would look entirely normal in the rail. The flag is not
  reachable from the dispatch path at all.
- **Destructive git stays denied** (`GIT_DENY` in `dispatch.js`) regardless of mode. A
  worktree isolates *files*, not history — a force-push from inside one reaches the real
  repository.
- **Nothing merges on anything but an explicit per-PR word from a human — with one named
  exception, which a human turns on themselves.** The lead performs the merge; the decision is
  never inferred from green checks, timers or silence. **Three adjacent things, and
  confusing them is how this rule gets undone:**
  - `mergePRs` means **auto-merge** — the panel merging on a trigger, a timer, or checks
    going green with nobody looking. Still refused at every endpoint, still deleted from
    every patch, and this feature deliberately gave it no way in.
  - `leadMerges` (off by default) is about **the prompt**, not the decision: it only adds
    an allow rule for **that repo's own forge's** merge tool (`mergeRule` in `team.js`) so a
    merge that was ordered doesn't stop on a harness prompt. What it costs differs by
    forge and the panel's copy says which — on Gitea one tool both opens and merges PRs, so
    a rule cannot tell those apart and the per-PR rule is then enforced by the lead's
    discipline rather than by a prompt; under `gh` the rule is `Bash(gh pr merge:*)`, which
    genuinely cannot open one; through a GitHub MCP server it adds **nothing**, because
    that server's tool name has never been verified here, and an unverified tool name in an
    allow rule is a rule that silently does nothing.
  - `leadDecidesMerges` (off by default, issue #7) is **the decision**: with it on, the
    lead may merge a worker's PR per PR, on its own judgment, having asked
    `POST /api/team/tasks/:id/merge-check` first (`mergeVerdict`, `merge-check.js`; the
    lead tool is `task_merge_check`). It is not `mergePRs` in another costume — there is no
    trigger, no timer, and no deferred merge anywhere in it, the verdict is bound to one
    head sha, and every call is a room line (`event: 'self-merge'`), refusals included.
    The two toggles are independent: deciding without `leadMerges` means the lead decides
    and then stops at a prompt.

  **The wall and the discipline, and the split is the whole design.** The panel holds no
  forge credential and makes no network call — a deliberate design rule, not an omission —
  so only half of a merge's conditions can be enforced. **Wall** — computed from this disk,
  unarguable: the toggle, an unparseable `humanReviewPaths`, a `push only`/`no remote`
  forge, the task's shape, a head that is not the branch tip here, an unreadable branch, and
  a changed file under `humanReviewPaths`. **Discipline** — the lead's own word, written
  into the room and checkable by nothing here: `mergeable` and `checks` are validated
  against an enum (which only rules out a word nobody meant), and `evidence`, `reason` and
  `suiteQuote` are required to be *said* rather than to be true. The brief
  (`selfMergeSection`, `lead-brief.js`) is where that discipline is actually specified,
  which is why its forbidden-flag sentences are pinned by name in `test/brief.test.js`.
  The close line then says whether a decision was recorded for the head that merged — a
  visible non-event, never a second refusal, because refusing there would catch merges a
  human ordered. The settings file **and the brief** are
  written at lead launch (`leadSettings`, `leadBrief` in `index.js`), so a flip of either
  toggle reaches the next lead, not a running one.
- **Nothing kills a worker automatically.** Stuck, silent, looping — all of it surfaces;
  none of it `/exit`s. That is a human's call, and `assertNotBlocked` is the backstop.

**A worker is one of two kinds.** `task_dispatch` with `kind: 'plan'` starts a **planner**:
it researches the repo, writes one document to `<teamDir>/plans/<task>.md`, and reports.
Everything mechanical about it is a worker — worktree, `agent/<label>` branch, room, task
record, cap slot, the same two `foreman` tools — and two things are not: `plannerBrief` in
`worker-brief.js`, and `plannerStance` in `team.js`, which denies its own worktree, the
worktrees root, the real checkout and `git commit`/`git push`. Its branch ends with no
commits and that is correct. The plan reaches the lead through `plan_read`, never through
the room (a plan is a page; the room is a log a human scans), and **the lead never
approves one** — a plan goes to a human, exactly like a merge. Note the honest limit
of that stance: these are file-permission rules, and a shell redirect is a Bash call no path
rule sees, so it raises the cost of drifting into implementation from nothing to
deliberately routing around the panel. It is a wall, not a sandbox.

The lead answers a worker's question through the panel's own guarded endpoint, never
`send-keys` — and only behind a toggle, and only when it can cite grounds. And note the
`/exit` guard's lesson applies here verbatim: **"blocked" is wider than one status**, a
question box being `dialog` + `question` rather than `needs-decision`. The transition
watcher relearned that the expensive way.

---

## Traps, each of which cost real debugging

**A `<repo>-<branch>` title proves nothing.** Claude Code stamps a `customTitle` on a
session, and a launcher is free to derive it from the repo and branch — which several do,
including the wrapper this project grew up beside. When it is derived that way, every
session in one repo on one branch writes the *same* title: one folder on the machine this
was found on held 96 transcripts all titled `<repo>-main`. **So a title is a hint, never an
identity** — binding on it is a coin flip, and `binding.js` never does. A launcher that
prefers the session's own *label* makes titles unique, but only for sessions started after
it began doing so, and only while it recognises the name: an external launcher matching a
literal prefix of its own stops producing unique titles the moment `sessionPrefix` is set to
something it does not look for. That costs the titles and not the binding, which has other
rules. `binding.js` handles the overlap; don't simplify it without reading the tests.

**A label can collide with the branch.** A session labelled `main` in a repo on branch
`main` produces `alpha-main` either way, so the title is identical whether it was derived
from the branch or from the label. The guard against branch-derived titles must therefore
only fire when a *sibling* could still be writing that default — see `modernNamer` in
`sessions.js` / `wrapper.js`. Getting this wrong permanently blocks a legitimate binding.

**Ambiguity comes from siblings, not names.** One pane in a folder means one live
conversation, so a name mismatch there is harmless. Several panes means only an exact
label match is safe. Over-tightening this blanked five working sessions.

**Freshness is load-bearing.** A transcript last written *before* a pane existed cannot
be that pane's. Without this guard a new session adopts yesterday's history, and a
restarted one adopts its own previous run.

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

**Exposure is the one thing a LAN peer may not change, and the check is the socket, not
the header.** `PATCH /api/config` — the settings modal — writes `bindHost` and
`allowedOrigins`, and both decide who can reach this panel at all. The no-auth stance says
a LAN peer gets everything else; it does not say a LAN peer may *widen its own reach*,
so those two keys are gated on `req.socket.remoteAddress` being loopback (`isLoopbackRemote`
in `settings-file.js`, 127/8, `::1` and the IPv4-mapped `::ffff:127.0.0.1` a dual-stack
listener hands you for a plain `curl 127.0.0.1`). **A loopback `Origin` would prove
nothing** — `origin.js` allows a request with *no* `Origin` at all, by construction, so
curl, the hook and `mcp/foreman.js` need no allowlist, which means a LAN peer holding curl
sails through it. And **never an `X-Forwarded-For` rung**: a header is written by the
caller, the peer address by the kernel, and the whole value of the guard is that it cannot
be spelled. It fails closed — no address is not loopback. The modal disables its own
controls off `canEditExposure` from the GET, and the PATCH re-decides it server-side, so
re-enabling them in devtools still gets the 403; measured both ways on a scratch panel
bound wide. This is not authentication and must not grow into it.

**…and `sessionPrefix` is in that file but is not writable from it.** It resolves once at
boot and is the *only* prefix the panel recognises, so a value written here takes effect at
the next restart — at which point every session minted under the old one keeps running,
stays in the rail, and stops being *named*: `slugFor` yields nothing so `⧉` auto-numbers,
`isLeadName` stops matching the lead, and a snapshot cannot restore a row under its own
name. `validateConfigPatch` refuses it by name with that reason (`PREFIX_REFUSAL`), ahead
of the generic unknown-key refusal, because a person who tries it deserves the *why* rather
than "not a key". The modal shows it read-only with the same sentence on hover.

**A settings write merges; a boot read does not.** `readConfigFile` answers `{}` for a file
it could not parse — right for a boot (settings that are not there, fall back to loopback,
loudly) and catastrophic for a write, because merging into `{}` and writing back replaces a
file with a typo in it, recoverable in any editor, with a two-key file that has thrown the
rest away. `writeConfigFile` therefore **refuses** an unparseable file with a 409, and
otherwise merges so a key this version has never heard of survives. Temp file **in the same
directory** then `rename`, because rename is only atomic within one filesystem and a temp
dir on another volume degrades silently to copy-then-delete — and the reader that must
never see half a file is a boot deciding what to bind.

**A GitLab remote read as `Gitea`, because "not GitHub" is not the same as "Gitea" —
found on the bench.** The forge is derived per repo from `git remote get-url origin`
(`forge.js`), and detection is deliberately **two independent questions**: what the origin
points at, and whether tooling for it is installed. Matching the remote's host against the
registered MCP server's URL is *not* a detector — on the machine this was found on, a Gitea
remote and a registered Gitea MCP server shared an IP by coincidence and differed in port,
and a forge's MCP server need not live on its git host at all. Four readings come out of the pair, and the words are
deliberately chosen and are not to be paraphrased: `GitHub`, `Gitea`, `push only`, `no remote`.

The trap is in the second question's *else*. Written as "any non-GitHub host is a
self-hosted forge, and a registered `gitea` server means we have tools for it", a
`gitlab.com` repo reads **Gitea** on any machine that has a `gitea` server registered at
all — and its lead is then handed gitea tools for a forge that has never heard of them. So
`push only`, the reading that exists for exactly that case — a GitLab or Bitbucket repo on
a machine with no tooling for it — could never fire on such a machine. `NOT_GITEA_HOSTS` names the public forges that are
neither, `codeberg.org` among them because it runs **Forgejo** — whose API is close enough
to Gitea's that it may well work, which is precisely why it must not be *implied* to.
The limit the list cannot fix is written beside it: a **self-hosted** GitLab is
indistinguishable from a self-hosted Gitea by host alone, so it reads `Gitea` and fails at
the lead's first tool call — loudly, in the lead's hands, never quietly.

Two more things that hang off the same answer. `<teamDir>/mcp.json` is world-readable and
the panel copies the user's registered entry into it verbatim, so an entry carrying a
credential in its `env` (the standard GitHub MCP server carries a PAT) is **refused**, with
the refusal reported in the launch result and the room — and the brief is then written from
the *demoted* forge, so it never promises a tool the file does not contain. `gh` is
preferred for GitHub for that reason alone: its login is in the keychain. And `gh`'s login
is **not git's** — without `gh auth setup-git` a worker's plain `git push` fails with
*"could not read Username for 'https://github.com'"*, measured on a bench repo. `README.md`
and `docs/running.md` state it as a prerequisite.

**"Done" force-deletes a branch, so the endpoint checks before it sweeps.** `task_close`
with outcome `done` runs `git branch -D`, and until this existed the only thing in front of
that was a sentence in the lead's brief — with no forge in the loop, nothing checked at
all. `POST /api/team/tasks/:id/close` now requires the branch to be an ancestor of the base
(`mergedInto` in `deployed.js`), checked against **both** `origin/<base>` and local
`<base>`, fetching first: a forge merge lands on the box and the local branch lags it,
while a no-forge merge is local and there may be no remote. It fails **closed** — a check
that could not run refuses — and the refusal names `abandon`, which is the word for
discarding work deliberately. A planner's branch and an already-deleted branch are the two
exemptions, and both are exemptions because there is nothing there to protect.

**A self-merge is decided on facts the panel cannot check, and every one of them has a
trap in it — all measured by the planner against real PRs, none of them guessable.** The
first is the load-bearing one and it is about *this* code, not about GitHub: **the panel
cannot read a forge, and `merge-check.js` must never start.** Every instinct while
building or extending it says "the endpoint should just call `gh pr view`"; it holds no
credential, makes no network call, and the 2026-08-30 ruling says it never will. Whoever
touches this next will be tempted exactly once, which is why the module's own header says
so first.

Then the four the brief has to teach a lead, because the lead is the only party that *can*
look. **A merged GitHub PR reads `mergeable: UNKNOWN`** — full read on a merged PR:
`state: MERGED`, `mergeable: UNKNOWN`, `mergeStateStatus: UNKNOWN`, `statusCheckRollup:
[]`. So `state` is read **before** `mergeable`, or a PR that is already done reads as "not
computed yet" and gets retried forever. **`UNKNOWN` is lazy and is never a pass**: the
first query starts the computation and returns it, a second a moment later has the answer
— so re-read a few times a couple of seconds apart, and if it is *still* unknown, refuse.
**`statusCheckRollup: []` is two different
facts** and `gh` cannot tell them apart on its own: either the repo configures no checks,
or checks exist and none has reported on this head. `mergeStateStatus` disambiguates —
`CLEAN` means no checks (which is `checks: 'none'`, and then the worker's own quoted suite
result is what stands in for CI), `BLOCKED` means a required one has not reported, and
`UNSTABLE` means one is red. And **Gitea's `merge_when_checks_succeed` is auto-merge by
another name** — a real argument on `pull_request_write`, beside `force_merge`, that arms a
merge to fire later on green with nobody looking. It is `mergePRs` in tool form, one
argument away from a lead that means well, which is why the brief forbids it *by name*
along with `--admin`, `--auto` and `force_merge`, and why `test/brief.test.js` pins each
name rather than pinning "says something about flags".

**`main` was hardcoded in four places, and that made the team feature unusable on `master`.**
`worktree.js`, `deployed.js` and two sites in `index.js` all defaulted to `main`/`origin/main`,
so a repo on `master` or `trunk` failed its first dispatch with `No such base branch:
origin/main` and no explanation. `base-branch.js` detects it from `origin/HEAD`, falling back
to the checkout's current branch (refusing an `agent/` one, which inside a worktree would
branch every future task off another task's work), and it is shown read-only in the team panel
beside the forge. The sandbox's `gamma` is on `master` deliberately — it is the test.

**Permission prompts never reach the transcript.** The pane is the only source — and the
converse bit them: prompt-*shaped* text in the transcript was read as a live box. A session
editing this repo shows diffs of the permission fixtures, so "Do you want to proceed?",
`1. Yes` and `Esc to cancel` scroll past while it works. `parsePrompt` and `DECISION_RE`
are now gated on the composer being absent, the same test dialogs already used: if Claude
Code is drawing somewhere to type, nothing above it is waiting on an answer.

**A question box also reads as `needs-decision`.** The composer must offer the question
card *first* and fall back to the permission bar, not the other way round — with the
branches in the other order the panel showed "the prompt could not be read" while holding
a perfectly parsed question.

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
a setting that appears to work. `web/trust-gate.js`'s reasoning, one floor down.

**The footer's right-hand slot rotates.** It shows `/rc`, "new task? /clear to save…",
and *sometimes* effort. Read effort from the transcript (`effort` on every assistant
record), never by scraping. Model and `ctx:` are stable in the footer and are read there.

**`bypass permissions` is on the mode line but is not a mode.** A session started with
`--dangerously-skip-permissions` draws `⏵⏵ bypass permissions on` exactly where every
other session draws `auto mode on`, so `parseBypass` reads it off the same line — free,
live, and better than the `ps` walk an earlier version used, which could only report how
a session was *launched*. It must never join `MODES`: that list is the shift+tab cycle
`changeMode` steps through, and an entry there would give the panel a way to switch a
session into running without asking. `null` (no mode line on screen, because a box or a
picker owns the footer) is not `false` — `sessions.js` keeps the last real answer per
pane, or a session stops looking dangerous for as long as it spends asking you something.

**Modes only cycle.** shift+tab steps `auto → manual → accept edits → plan → auto`.
There is no way to jump. `changeMode` presses and re-reads until it matches — never
count presses. It refuses while a permission prompt is open, where shift+tab means
"amend".

**Sending is two paths.** Single line → `send-keys -l` (this is what makes slash
commands execute). Multi-line → bracketed paste (`-l` would submit each line separately).
Before either: `C-u` to clear the prompt, and re-check the pane still runs Claude — the
roster is up to a poll stale, and a session that exited leaves a shell that would
*execute* your text. Force `LC_ALL` or `-l` mangles non-ASCII.

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

**A question wraps, and so do its options.** `questionAbove` took the nearest line only, so
a card read *"lighter preparation-and-reminder track?"* over a terminal asking "Should
durable_power_of_attorney be a full first-class workflow, or a lighter
preparation-and-reminder track?" — the half carrying the subject was the half dropped. It
now collects upward to the box's own chrome, and stepping past a rule is only safe *before*
anything is collected, or a wrapped assistant line gets spliced onto the front. Descriptions
accumulate for the same reason (they ended mid-clause). `dialogTitle` in `tmux.js` had the
same bug from the other end: it takes the line ending in `?`, which on a wrapped question is
its tail — the composer hint read "together? is open in the terminal".

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

**The roster's `label` is not the label you launched with.** `sessions.js` slices only
the session prefix, so `<prefix>alpha-main` arrives as `alpha-main` — folder and all.
Feed that back into `uniqueSessionName` and you get `<prefix>alpha-alpha-main`, a session
that no longer answers to the name anybody saved. `slugFor` in `launch.js` is the inverse of
`sessionName` and the only correct way back; `test/launch.test.js` pins the round trip.
The same row's `cwd` is the transcript's and moves (see below) — `paneCwd` is the launch
folder, and it is what a relaunch has to use.

**A binding survives a sibling.** A pane bound while alone in its folder used to come
unbound the instant a second session opened there — the folder turned ambiguous and the
panel blanked a transcript it had been reading for an hour. `rememberedFor` replays the
last poll's answer, re-checked against cwd and freshness. Hooks still overrule it. On a
cold start there is nothing to remember, so rule 3 also binds the leftovers: one unbound
pane in a folder with exactly one unclaimed *live* transcript is arithmetic, not a guess.
"Live" matters because `/clear` leaves a chain behind — a file whose last word predates
another file's first is a rotation predecessor, and counting those as rivals is what kept
an identifiable session reading "can't tell which history is this one's".

**The hook posts JSON without saying so — and that silently cost the panel its best
evidence.** `install-hook.js` writes a `curl --data-binary @-` with no `Content-Type`, so
curl labels the body `application/x-www-form-urlencoded`, `express.json()` skips it,
`req.body` is `{}`, `ingest` finds no `session_id` and returns. Every hook ever sent was
dropped there: `~/.foreman/panes/` held not one receipt, no session ever read
`hook` as its status source, and the authoritative binding rule — the whole reason the
hook exists — had never once fired. The panel had been running entirely on pane scraping
and looked fine doing it, which is why nobody noticed. `/hook` now parses any
content-type; the installer sends the header too, which only matters for a fresh install
since an entry already in `settings.json` is never rewritten.

**A transcript's `cwd` moves; the folder it lives in doesn't.** Claude Code stamps `cwd`
on every record and rewrites it when a session changes directory mid-conversation — so
`alpha-secondary`, launched in `Alpha` and now working in `Alpha/alpha-dev/backend`,
recorded a directory its pane could never match, and every binding rule (all of which
filtered on `m.cwd === pane.cwd`) skipped it. A live session with a unique label read
"can't tell which history is this one's" for as long as it stayed in the subfolder. The
stable identity is the transcript's own folder, `~/.claude/projects/<cwd with each slash
as a dash>`, which is named at launch and never rewritten — `sameWorkspace` in
`binding.js`, off `projectDir` from `probe`. Note the mirror case it also fixes: a
transcript that wandered *into* this pane's directory used to match on `cwd` and bind
wrongly. The rail groups by the pane's launch folder for the same reason — a row must not
hop headings, and out of the group you filed it under, mid-conversation.

**A slash command's output is a transcript record, it carries ANSI, and it comes in two
shapes.** `/model` writes `<local-command-stdout>Set model to \x1b[1mFable 5\x1b[22m for this
session only</local-command-stdout>` — bold codes and all, invisible in a terminal and raw
bytes in a browser. `parseCommandOutput` in `normalize.js` strips them, and its regex is
written as an explicit `\u001b` rather than the literal ESC byte it started as: an invisible
control character in source lasts until the next careless edit, after which the pattern
quietly starts eating ordinary text shaped like `[1m`. The match is anchored `^…$` for a
reason that is already live — a message *mentioning* the tag (this trap's own bug report did)
must stay the user's words. Two shapes: 112 `user` records, which is what you see, and 222
`system`/`local_command` records, which `DROP_TYPES` discards and always has; 190 of those
are empty. Only the first was ever visible, so only the first was changed. And note
`<command-name>` already carries the slash — the chip adds its own, which is why every
command in the panel read `//model` until it was stripped in `parseCommand`.

**A `type: 'user'` record is not proof a human typed anything.** When a subagent, a
background command or a monitor finishes, Claude Code injects the result back as a
**synthetic user turn** — a whole `<task-notification>` envelope — and the terminal draws
one line for it. `normalize.js` drops only by `DROP_TYPES` and `isMeta`, so the panel drew
every one as a full user bubble: a subagent's entire report, in the user's own voice,
saying something they never typed, two screens tall. Measured across this Mac: 472 of them,
median 425 bytes, p90 8.5 KB, largest 48 KB. `parseTaskNotice` reads them as a `notice`
chip.

Three measurements decided its shape and none of them is guessable. **`<summary>` is on all
472 and is self-describing**, so it *is* the chip's line — and it is why the label says
`notice` rather than the obvious `agent finished`: only 92 are agents, 263 are background
commands and 94 are monitors, so that wording would be wrong on four rows in five.
**`<result>` is on only 92 and `<event>` on 94**; the other ~290 are a status and a pointer
to an output file, and their chip is deliberately unopenable rather than opening on nothing.
And **detection is two witnesses that must both hold** — a record field (`origin.kind`, or
`promptSource` for a record carrying no `origin`) *and* an anchored `^<task-notification>`
envelope — never the sentence inside, which is Claude Code's wording and will be reworded.
The conjunction is also the scope: a typed message quoting an envelope stays a bubble, and
whatever else `promptSource: 'system'`
grows to carry falls through unchanged, which is the right default for a shape nobody has
read. Unread never counted these — it counts `assistant` records with text — so nothing
about the inbox moved.

**One peer message, two records, and which one Claude Code writes depends on whether the
recipient was busy — MEASURED on v2.1.257, both shapes captured minutes apart in one
sandbox session.** A native `SendMessage` delivered to an **idle** session lands as
`type: 'user'` with `origin.kind: 'peer'` at the top level. Delivered to one **mid tool
call** it is queued and then absorbed into the turn already running, and lands as
`type: 'attachment'` / `attachment.type: 'queued_command'` — the `queue-operation` beside
it says `reason: 'absorbed_mid_turn'` — carrying the **identical `origin` object one level
deeper**, at `rec.attachment.origin`. It has no top-level `message`, no top-level `origin`
and no top-level `isMeta` (that rides inside `attachment` too), so every test the first
shape passes, the second fails. `peerOrigin` in `normalize.js` is the one place either is
recognised; everything downstream is written once.

Three things about it. **The busy shape is the common case, not an edge** — a worker
telling its lead "done" is by definition talking to a session that is working, and it is a
worker→lead completion message that first proved this traffic exists. **It fires no
`UserPromptSubmit` hook at all**, measured against a scratch hook that caught the idle
delivery from the same sender in the same session seconds earlier and never saw the busy
one, so a collector watching the hook sees nothing and the transcript is the only path to
these. And **`attachment` stays in `DROP_TYPES`**: the carve-out asks the parser rather
than the type (`if (DROP_TYPES.has(type) && !peer)`), so exactly one shape comes back out
and `total_tokens_reminder`, `output_style` and the rest are dropped on the next line as
before. Note the shape is not what you get by messaging a session that merely *looks*
occupied — a probe fired at one busy generating prose arrived as the ordinary `user`
record, because the turn ended first. It takes a tool call in flight.
`test/fixtures/peer-message-busy.jsonl` is the capture and `test/normalize.test.js` pins
both spellings against it.

**A subscription dies with the socket, and nothing on screen says so.** The tailer holding
a file offset is server state, so a dropped connection or a server restart ends it — while
the roster keeps arriving, because that is broadcast to every client. The result is a rail
that looks perfectly alive above a transcript that silently stopped minutes ago — found
because the terminal had twenty minutes the panel didn't. `ws.onopen` re-subscribes
**every open pane**; the version before split view re-subscribed `state.selected`, a variable
the `createPane` refactor had already deleted, so it re-subscribed nothing at all.

**…and a subscription that outlives its slot doubles every message.** `subscribe` used to
claim the slot *after* `await tailer.start()`, leaving the slot empty for the length of a
file read. A second subscribe landing in that window found nothing to stop, so the first
tailer was never recorded anywhere and never stopped: it went on watching the same file and
sending into the same slot for the life of the socket, and `appendMessages` in `web/app.js`
appends without dedupe. Every record after that point drew twice. It hides well — the next
full `transcript` frame replaces the list wholesale, so the screen "snaps into place" while
the orphan keeps running, and the file was never wrong. `/clear` is what makes the race
routine: a rotation fires **two** subscribes for one slot, the server's own rebound and the
client's `adopt` → `open` off the same roster frame. The slot is now claimed before the read
and the tailer checks it still owns it afterwards; the second subscribe is harmless, it just
supersedes. Proving it took a websocket that double-subscribes one slot and single-subscribes
another as a control, against a live session — the panel cannot show you this from inside.

**A duplicate inherits bypass, and that is the point.** `⧉` on a rail row relaunches into
`paneCwd` with the source's own slug (`slugFor`, so `alpha-main` → `alpha-main-2`) and
with `skipPermissions` copied from `s.bypass`. A copy that quietly asked for permission
where its original didn't would be worse than no button — but it is a real consequence for
one hover-click, so the glyph takes the badge's colour on those rows. Note the guard beside
it: `sessionRow` rebuilds from scratch on every roster broadcast, so `disabled` on the node
is wiped long before the launch returns and the in-flight flag has to live in module scope
(`duplicating`). Three fast clicks must make one session, not three.

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

**Relaunching the whole bench can take the tmux server down with it, and pane ids restart
at `%0`.** Exit-all-then-restore-all means that for a moment nothing is running — and if
the bench *is* the whole server, tmux shuts down and the next launch starts a fresh one
numbering from zero. Harmless (session **names** are the contract, and they survive), and
it is also what makes the wait-for-exit loop return instantly: `liveSessionNames()` answers
`[]` for a server that no longer exists. Worth knowing before you read a pane-id reset as a
bug. It does not happen when anything was skipped — benched both ways, with two blocked
sessions surviving and the ids continuing from `%3`.

**A relaunch into a folder whose trust was never recorded lands on the trust gate.** Not
new behaviour and not the relaunch's fault — the panel has always shown that screen — but
it is the state a relaunched session is most likely to come up in, because the record lives
in `~/.claude.json` and three sessions answering their gates at once can lose one to the
last writer. Benched: two folders came back straight into their history, the third came
back on the gate and resumed correctly the moment it was answered.

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

**A multi-select's keys are a diff, not a selection.** The box remembers what is ticked, so
sending the digits you want turns *off* anything already on. `planAnswer` compares against
what the pane shows and presses only the difference — `test/question.test.js` pins it.

**Never submit a multi-select without re-reading the review.** `Tab` opens a screen listing
what is about to be sent; the endpoint re-parses it and refuses the submit digit unless
every chosen label appears there. Selections made and nothing submitted is a recoverable
state. A wrong answer sent on the user's behalf is not.

**Nothing may be typed without claiming the pane first.** The roster is a poll behind, so
five messages fired in one second all saw `idle` and all landed on the same prompt line.
The lock lives in `claim.js` — `PaneLock` takes it *before* re-reading the pane and holds it
for a beat after delivery. Both the send endpoint and the queue flusher go through it;
neither types directly.

**An interrupt fires no hook, and the receipt it leaves behind lasts ten minutes —
VERIFIED.** `Escape` is not a natural stop, so Claude Code's `Stop` hook never runs and the
status engine's last word on that session stays `working` for the whole `STATUS_STALE_MS`.
Nothing else was ever going to correct it: the hook is the only thing that writes `states`,
and the one that would have has already declined to fire. Measured on a scratch panel with
the fix disabled — ninety seconds after an interrupt the roster still said `working`, the
composer button still read `queue`, and a message sent into a session plainly sitting at its
composer went to the queue instead of the pane. It was hit live, and the tell is that the
tmux window was the faster route.

So the **interrupt endpoint** drops that session's receipt (`StatusEngine#interrupted`),
because the panel is the only party that knows. Three things about it. It **drops** rather
than writing `idle` — `stateOf` answers `unknown` for a session it has never heard of, and
`unknown` is the one word `sessions.js`'s precedence hands straight back to the pane
scrape; writing `idle` would assert an outcome nobody observed, and the Escape may have
landed on a box. The precedence at `sessions.js:398` is **not** the bug and must not be
inverted — the hook still beats the scrape for everything that is not a prompt, plan or
dialog, for the three separate reasons above. And the **join is the part that silently does
nothing**: `states` is keyed by the hook's `session_id` while the caller holds a pane id and
the registry's id, which agree except for the beat after a `/clear`, so both spellings are
cleared. With it, the button flips in **0.77s** — the next roster refresh, which the
`changed` event triggers.

**…and the live pane read now decides a claim, which is looser in exactly one measured
window.** `PaneLock#claim` asks the lock, then reads the pane, and the pane's answer is
final. The version before it asked the *roster* first (`session.status !== 'idle'`) and only
then read the pane, so the live read could veto a send and never rescue one — which defeats
the reason it is there. What that ordering was quietly covering, and now isn't: **the first
spinner frame of a turn does not match `WORKING_RE`.** Claude Code draws `✢ Burrowing…`
with no parenthesised suffix, and the pattern is `/⎿\s+Running…|\S+…\s*\(/` — it wants the
`(`. Sampled at 120ms against a real session: **~1.8 seconds** at the top of every turn
where `parsePane` says `idle` and the session is working. Once the `(3s · ↓ 12 tokens)` tail
appears it is `working` for the rest of the run — 280 of 280 samples through a two-minute
tool call. So a message flushed inside that window is typed into a session that has just
started; Claude Code absorbs it as a follow-up rather than losing it, and `COOLOFF_MS`
(1500ms) covers most of the window when the panel is what submitted the prompt. It is not
covered when a human typed in the terminal. Widening `WORKING_RE` is the real fix and was
left alone deliberately — it changes the roster status of every session in the panel and
wants its own fixture. Weigh that 1.8s against the ten minutes it bought.

**An image in a transcript is addressed by an ordinal, and exactly one function may
compute it.** A screenshot arrives as ~60KB of base64 — 9 of them were 19% of one 2.9MB
file — so a normalized message names `{uuid, index, media}` and the bytes come over HTTP
(`/api/sessions/:id/image/:uuid/:index`), never over the socket. `index` is the image's
position in a depth-first walk of the record, and `imageBlocks` in `normalize.js` is that
walk for *both* ends: the message that names an image and the endpoint that reads it back.
Two walks that could disagree about what "the second image" means is the `isLeadName`
lesson in a different costume. Note the ordinal is assigned **before** anything is
filtered, so a block the panel declines to serve (a `url` source, an unexpected media
type) still consumes its number — renumber the survivors and the endpoint quietly hands
back the wrong picture, only in records that had a refused block. Measured across 429
transcripts on this Mac: 1027 image blocks, every one `source.type === 'base64'`, only
`image/jpeg` (704) and `image/png` (323), and **not one on a sidechain record** — so the
decision to keep sidechain images (flagged, not filtered) is about the shape of the data
rather than anything on disk.

**The gallery has to read the whole file, and nothing else here does.** The tailer
backfills a byte window, `loadEarlier` walks another one back, `probe` deliberately samples
head and tail and never the middle. Every one of those is right, and every one of them
would make a gallery that is a subset while looking complete — the specimen session proves
it, 9 images and *none* of them in the window the panel opened on. `scanImages` streams the
file and parses only lines containing `image`: 1,115 lines and 45 parses for a 2.9MB
transcript at **~10ms**, 3,014 lines and 158 parses for the largest one on this Mac at 26MB
at **~55ms**. Cheap enough to redo on every open, so nothing is cached and nothing goes
stale. `readImage` streams the same way, guarded on the uuid — and the record's own `uuid`
field is what decides, because every reply names its parent in `parentUuid` and a
take-the-first-match would return the wrong image for any record that has children, which
is all of them.

**A thumbnail with `width: auto` is zero pixels wide until its bytes land.** Measured: a
`0 x 86px` box. Every image in a strip pops into existence as it arrives, shoving the ones
after it sideways, so `.img-thumb img` carries a `min-width` floor. And a related bench
artifact that will cost you an hour: `loading="lazy"` defers until Chrome actually
*renders* the page, which an automated window does not do until something forces a frame —
so thumbnails plainly on screen read back `complete: false`, and a screenshot fixes them.
Same family as the `requestAnimationFrame` / `ResizeObserver` trap the room panel hit;
`document.visibilityState` is still the first thing to check. The strip loads eagerly
anyway (one turn, one to three images, nothing to defer); the gallery keeps `lazy` because
it can hold ninety.

**`web/app.js` is one shared shell plus a `createPane` factory.** Everything per-session —
the selected id, its messages, `streamEl`, `composerEl`, `chipNodes`, the completion popup
— lives inside the factory, because split view means two of them at once. The roster,
drafts and the thinking toggle stay shared outside it. Adding per-session state to module
scope will work perfectly until someone opens a second pane.

**The rail is a flat list of siblings, and three things depend on it.** There is no nesting
for CSS to key off, so the indent inside a group is a class added in `renderRail`, not a
descendant selector. `.folder-label.in-group`'s sticky `top` is a hand-measured offset for
the group header's height — change that header's size and this moves too. And an open
group's tint is *tiled* from three full-width siblings rather than painted on a container,
which holds only while none of them carries a vertical margin: the gap between groups is
`margin-top` on the next header, deliberately outside the tint, and the block's bottom edge
is `in-group-last`, marked in JS because nothing in a flat list knows it is last.

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

**A group is filed by the name the rail draws, and the dispatch filed a path.** The rail
keys folders by `basename(cwd)` — that is what `s.project` is — but `task_dispatch` filed
`wt.dir`, the absolute worktree directory. It matched no session that has ever existed, so
every team heading read `· 0` with its workers live three rows below it, and it looked
exactly like the staleness bug it was found next to. Two spellings are now on disk in front
of a reader, which is why `retireWorktree` unfiles both — and why it only reaches for
the basename when the path is genuinely under `worktrees/`: closing a task must never
quietly unfile a real project that happens to share the name.

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

**A collapsed group hides one thing for ordinary rows and two for workers, and the dot
covers only the first.** For an ordinary session and for a lead, folding is safe because
the inbox hoists anything blocked or unread *out* of its folder first — but **working** is
neither, so a busy session is the one state a closed group can genuinely hide. Hence the
pulsing dot on the heading, drawn only when collapsed.

The hoisting rule then changed, for workers alone. A worker's permission prompt is its
lead's to answer and its finished report is its lead's to read, so a worker row no longer
hoists until `stuck` fires (`stuckAfterMinutes`, default 20) — a deliberate call, taken
knowing that a blocked-but-not-yet-stuck worker inside a *collapsed* team group is therefore
not visible. The trade was bought with the lead row's `N waiting` count, which names the
same fact the inbox stopped showing, and backstopped by the stuck timer, which
puts the row in the inbox for real once it has actually been abandoned there.

And the compensating signal is hidden for exactly that window, which is the part nothing
on screen tells you. Measured on a scratch panel driven with fixture rosters, reading the
heading's own DOM: a plain **working** session in a collapsed group draws
`<span class="dot working shelf-dot">`; a worker nested under its lead draws **no dot in
either state**, blocked or working, because `renderRail` pulls nested workers out of
`rest` before `busy` is computed off it. So inside a collapsed team group such a worker
has no row *and* no dot — and the lead's `N waiting` line is inside the collapse too. It
all surfaces when the timer fires; nothing stays hidden past it. Anything that widens the
quieting, or that changes what the dot counts, has to be measured against this again.

**A subscription is keyed by socket *and slot*.** `subs` is `ws -> Map(slot -> sub)`, and
every `transcript` / `messages` / `earlier` / `rebound` frame carries its slot. A frame
without one means slot `a`, which is how the panel behaved before there were two.

**tmux pane ids contain `%`.** `pane:%19` in a URL path is read as a percent-escape.
Synthetic session ids use `pane-19`.

**`probe` only samples head and tail.** A burst of tool calls pushes earlier replies out
of the window, so unread is *accumulated* across polls rather than recomputed. Don't
"simplify" that back.

**Deny beats allow, so a narrow write grant has to be a subfolder, not a carve-out.** The
planner may write its plan and must not touch `decisions.md` — the human record of every
ruling — which lives in the same team dir. There is no "all of this except those
files": a deny on `<teamDir>/**` would swallow the one folder the planner exists to write
to, and allow-plus-deny on overlapping paths resolves to denied. Hence `plans/` as a
subfolder and an allow that names only it (`plannerStance`). Any future "this session may
write exactly here" grant has the same shape — put the writable thing *below* the protected
thing, and never try to subtract.

**A path permission rule must say `Edit`, and must double-slash.** Two traps welded
together, both measured, both the silent kind. First: `Write(/abs/path/**)` with a plain
absolute path **matches nothing** — the "denied" write succeeded. The shape is
`Edit(//abs/path/**)`, double slash. Second, found in Wave E: Claude Code no longer
matches `Write(path)` rules in file permission checks *at all*, and says so at launch —
*"only Edit(path) rules are … Edit rules cover all file-editing tools."* So a `Write`
rule is a warning banner over a hole. The lead's settings carried both halves for four
waves; the Write halves were never doing anything. `pathRule` in `server/team.js` is
the one place that builds these — don't hand-write them, and don't reach for `Write`.

**`git status --porcelain` collapses an untracked directory to `dir/`.** A new file in a
new folder is reported as its parent, so two workers editing the same fresh path never
compare equal and the conflict scan misses them entirely. `-uall` is the fix, and it is
not optional — `conflicts.js` unions the porcelain read with the branch diff precisely
because a mid-task worker's changes are mostly *uncommitted*, which makes this the half
that matters. Git also quotes paths containing spaces; strip the quotes or they never
match diff output. `test/conflicts.test.js` pins both.

**A task state the store has never heard of is deleted, not rejected.** `TaskStore.#load`
(`tasks.js`) skips any record whose `state` is missing from `TASK_STATES`, and `#flush`
rewrites the whole file from the Map two seconds later — so a panel *without* a state,
started against a `tasks.json` *with* records in it, drops them on read and erases them on
the next write. No error, nothing on screen, and the file it deleted them from is the only
copy — benched with a two-record file, one state known and one not: the unknown one was
absent from the Map on load and absent from the file after the next flush. That is the
shape of every future revert past a state addition: `pending` shipped
first and alone for exactly this reason, and **`~/.foreman/tasks.json` gets backed up
before any rollback of a commit that added a state.** The same paragraph applies to
`TASK_KINDS`, which is loaded more leniently (an unknown kind survives as itself) — the
state list is the strict one.

**"Merged" and "live here" are different facts, and the boot sha is how you tell.** A PR
merges on the forge; the checkout on this machine and the panel running out of it know
nothing until somebody pulls and restarts. `deployed.js` answers it by *ancestry*, never
timestamps: the task's branch tip against local `HEAD` is "pulled", and against the sha
the panel booted on is "running" — the second half only for this repo (another team's
merge has no process here to be stale) and only when the change touched `server/`
(`web/` is read off disk every load). Three things it cost. The boot sha must be read at
**construction**, not on first use: nobody opens the team panel the second the server comes
up, so a lazy read takes the *post-pull* HEAD as the boot sha and pronounces a stale panel
deployed — the exact wrong answer, and the whole reason the file exists. The evidence has to
be recorded **while the branch still exists** (on the review report, re-read at close before
the worktree sweep deletes it) — after the merge there is no branch and no diff. And a
three-dot diff taken at close, against a main that now *contains* the branch, is **empty**,
which reads as "nothing to restart for"; the review-time file list wins when that happens.
"No tip recorded" draws no pill at all — the rule about showing nothing over showing
something wrong applies to a green badge more than to anything else here.

**The room's box moves under its own scroll, and nothing says so.** `renderRoom` pinned
to the bottom on every paint, which was both too much and not enough. Too much: a full
repaint fires on every incoming post, so a worker's report — now a bubble you can spend a
minute reading — yanked you to the newest line mid-read. Not enough: the tasks list and
the settings block above it arrive over HTTP a beat after the aside mounts, and each one
*shrinks* the room, so a scrollTop set while the box was 947px tall is 454px short of the
bottom once it is 493 — silently, with no scroll event, on every single open since the
aside existed. Following is now an intention flipped only by a real scroll, and the two
things that resize that box call `pinRoom` when they repaint. A `ResizeObserver` is the
general answer and was tried; it never fired, and neither did `requestAnimationFrame`,
because **an automated Chrome window reports `visibilityState: 'hidden'`** and Chrome
suspends both there. Worth knowing before you spend an hour blaming your own code:
`document.visibilityState` is the first thing to check when a callback that should be
free never arrives on a bench.

**…and a room that doesn't yank you needs to say what you're missing.** The other half of
the same rule: leaving the scroll alone means arrivals land off-screen with nothing to mark
them. A muted `N new below ↓` pill hangs off the room's bottom edge (absolutely positioned
against `.room-panel`, so it never reflows the list under the reader), exists only while
`follow` is false, and clicking it rejoins. The condition on it was "keep it quiet" —
muted ink, no accent, no motion. The counter is floored at zero on purpose: a full `room`
frame can *shrink* the list, and a negative count would hide a hint that was due.

**A room line's colour is keyed on what the poster said it is, never on how it reads.**
A dispatch line was asked for in green, the way a conflict is amber — and there was nothing
on the entry to tell one system line from another. `about` looks like the key
and is not: it is the *task id*, carried by every task-scoped system line, so a dispatch and
the `→ working` transition a minute later are identical by it. Every `kind: 'system'` post
in the repo (gc.js, watch.js's `postSystem`, and index.js's dispatch, model, PR and close
lines) carries exactly `{from, to, kind, about, text}` plus `alert`. So the dispatch post
gained `event: 'dispatch'` — riding the same `...rest` that `conflict`, `report` and `alert`
already use, `room.js` untouched — and `roomEntryNode` matches it exactly, so adding `event:
'pr'` later colours nothing by accident. **Do not match the sentence.** The text is a
message to a human and will be reworded; the day it is, a string-matched colour turns off
silently and the room looks fine. Two consequences worth knowing: this half is a `server/`
change, so it needs a panel restart, and `room.jsonl` is append-only history — lines already
written carry no `event` and stay grey, so the colour starts at the next dispatch rather
than filling in behind itself.

**A repaint that measures anything stops holding the reader's place.** The room got the
scroll rules above without ever preserving `scrollTop` across a paint, and it didn't need
to: `replaceChildren` followed by a run of appends never forces a layout, so the old offset
survived the swap untouched. Then the five-line clamp added a measurement — every candidate
is marked clamped, appended, and only *then* read — and that read is a layout, after which
every height settled above the reader slides the list under them. Measured at **66px per
incoming line**, which is exactly the four `view more` buttons that sat above the fold
during the measured layout and were taken away after it; with no scroll event to notice it
by, this box's signature failure. Two halves to the fix and both are load-bearing: nothing
is drawn until it is known to be needed (the button is built in the write pass, for the
three entries in twenty that overflow, instead of built for all twenty and removed from
seventeen), and `renderRoom` holds `scrollTop` across the whole paint. Note **where** that
read has to happen — `list.scrollTop` *after* `replaceChildren` is a forced layout on an
emptied box, which clamps the answer to 0 before you have read it, and the first draft put
the reader at the top of the room on every arriving line. Read it before the swap.

**A clamp that can't be measured can't be trusted.** `-webkit-line-clamp` is what the room
uses, and the standard `line-clamp` is deliberately *not* set beside it: Chrome 151 answers
`CSS.supports('line-clamp','5')` with false, so it is inert today — and the shape it will
ship is `continue: discard`, which removes the clamped lines from the box rather than
hiding them. The overflow test is `scrollHeight > clientHeight`; discard the lines and
those two are equal, every entry reads as fitting, and the control silently stops
appearing on exactly the entries that need it. Add the property the day it can be measured,
not the day it parses.

**A list painted at build time paints nothing, and a quiet feature hides it.** Everything
in `web/app.js` that renders through an `isConnected` guard — `renderRoom`, `renderTasks`
— must be called *after* its container is in the document, not inside the builder that
creates it. `renderMain` mounts the lead's aside and then paints. Get it backwards and
the guard silently skips, and the next repaint only arrives with the next incoming
message: a busy room self-heals in seconds and looks perfect, while a quiet one stays
blank for hours. That is exactly how it shipped and how it was caught — seven entries in
`room.jsonl`, none on screen. The general lesson is about benches, not guards: a feature
proven against a *busy* fixture is not proven against a quiet one.

**The panel can be bound wider than loopback, and it has no authentication — a stated
non-goal, not a gap.** `bindHost` decides who can reach it: `127.0.0.1` by default, and a
wider bind is something an operator records deliberately. What a wide bind grants, spelled
out because it is easy to under-read: anything that can reach the port can launch sessions,
type arbitrary text into any session on the machine, `/exit` them, dispatch workers, answer
permission prompts, and read every transcript over `/ws` — which is not read-only in spirit,
it carries `markRead`. The team endpoints live on the same port, so the merge path is
reachable too. And `0.0.0.0` is **every** interface the machine has, not one network: a
machine that later joins another network is on that one as well.

None of that is an oversight. Authentication was argued for this panel, the cost of leaving
it out was named, and the project's stance is that it stays out — so **do not quietly add an
auth requirement, or a boot guard that refuses a wide bind.** The origin check below is the
only thing here that resembles one, and it is a *browser* guard: it must not grow into
authentication. The stance can be revisited, but deliberately, not by a guard slipped in
under a bug fix.

The bind used to live only in the shell that started the process, so a plain `npm start` put
it back on loopback silently. It now rides in the LaunchAgent's own job environment
(`npm run install-agent`), so it survives a crash, a reboot, and the routine restart
(`npm run restart-panel`). `npm start` by hand still binds loopback only — correct and
expected, because the panel that matters isn't the one `npm start` starts.

**The installer must not hardcode the bind, and the panel records the one it is actually
using.** `jobEnvironment()` used to put a literal `FOREMAN_HOST: '0.0.0.0'` into *every*
plist it generated, unconditionally — so anybody running the installer got a LAN-exposed
panel without being asked. The code default has always been loopback (`config.js`), which
made the installer the whole of the exposure. The host is now **resolved** — `$FOREMAN_HOST`
→ `<STATE_DIR>/config.json`'s `bindHost` → `127.0.0.1` — and the plist carries the key only
when it is not loopback, the same omit-when-default rule `FOREMAN_PORT` and
`FOREMAN_STATE_DIR` already followed. A wide bind survives an upgrade by having been
*recorded* rather than by being everyone's default: the panel **seeds `config.json` at its
first boot** with the host it is actually using, so an install whose plist already carries a
wide host writes that fact down without anybody doing anything. That seeding is the belt to
a brace: renaming the environment variable killed the key any older plist spells, and only a
*reinstall* writes the replacement — so a restart at the wrong moment produces a panel that
comes up perfectly, on loopback, with nothing in any log and a phone that has simply stopped
answering. If the seeding is ever removed, doing the rename and the reinstall in one sitting
is the only thing left guarding that. `server/settings-file.js` is the module and its header
is the long version.

**Two node servers can bind the same port at once, silently, and split traffic by
interface — VERIFIED.** `SO_REUSEADDR` plus macOS letting a specific bind sit beside a
wildcard one means a process on `0.0.0.0:48770` and one on `127.0.0.1:48770` both succeed,
in either order, with no error from either `listen()` call. They then answer differently
depending on which interface the request arrived on — `curl 127.0.0.1:48770` reaches one,
`curl <lan-address>:48770` reaches the other — and only `lsof -iTCP:48770` shows two
`LISTEN` rows; nothing on either process's own output says so. Worse than "two panels":
the hook posts to `127.0.0.1` (`install-hook.js`) and `mcp/foreman.js` calls
`http://127.0.0.1:${PORT}`, so all hook traffic and every lead tool call reach whichever
panel is bound to loopback while a phone on the LAN reaches the other — which is
meanwhile polling tmux, flushing the same `queue.json`, and running its own worktree GC
against real tasks. This is why the boot guard (`index.js`, before `server.listen`) is an
HTTP probe of `127.0.0.1:<port>`, never a bind attempt — a bind attempt is precisely the
check that does not detect this. Anything answering there means refuse and
`process.exit(0)`; refused, timed out, or threw all mean go ahead. The exit code is a
contract with the plist's `KeepAlive: {SuccessfulExit: false}` (`install-agent.js`) — 0
means "I deliberately declined to start", not a crash, so launchd stands down instead of
looping.

**A WebSocket handshake is exempt from CORS, so `/ws` was the whole hole — and the guard
that closes it is a *browser* guard, not authentication.** `new WebSocketServer({server,
path:'/ws'})` had no `verifyClient`, and a handshake triggers no preflight: any `http://`
page a browser visited could open `ws://<host>:48770/ws`, be handed the full roster the
moment it connected, `subscribe` to any transcript and send `markRead`. The roster's `id`
is the session UUID `/hook` accepts as `text/plain` (also no preflight), so the same page
could then write false status for any session — `/hook` alone was nearly harmless because
the ids are UUIDs and the socket is what hands them out. `server/origin.js` is one pure
decision with three call sites: an `app.use` gating every non-GET, `verifyClient`, and
`/hook` (a POST, so the gate covers it — confirmed against the running route, not assumed).

Four things about it that a later reader will want to undo, each for a reason:

- **It restricts nobody on the local network.** The no-auth stance above holds: no header,
  no check — curl, the hook's curl and `mcp/foreman.js` are allowed *by construction*, not
  by a list. A device on the local network is allowed by clause 3, derived at run time, so a
  DHCP lease that moves fixes itself. This is not a boot guard and must never grow into auth.
- **`GET` is deliberately not gated.** A cross-origin page can send one but cannot read the
  response, because no `Access-Control-Allow-Origin` is ever sent. The socket is the
  exception and that is why it has its own call site.
- **The address filter is a filter, not "everything non-internal".** RFC-1918 and
  `fc00::/7` in; `fe80::/10` out, because on macOS most non-internal addresses are
  link-local and some of those interfaces are peer-to-peer ones a browser has no business
  reaching across; and `utun*` out, because that is where VPN and overlay-network
  interfaces land, and allowing every tunnel ships a panel reachable from every VPN the
  machine ever joins with nobody having decided that. A tunnel that should be reachable is
  a *named* addition to the list, never a side effect of a loose filter.
- **`Origin: null` is refused and an absent header is allowed** — they are not the same
  case. `null` is a sandboxed iframe or a `data:` URL, which is attacker-reachable.

The boot prints the origins it resolved, one line each with the interface and the reason,
because this clause was first written from a *description* of `os.networkInterfaces()`
rather than its output, and a derived list nobody looks at is how that comes back.

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

**Stopping the job does not kill the tmux server — VERIFIED, and worth it as a
reassurance.** The obvious fear: if the panel is first to touch tmux after a reboot, does
`bootout` take every Claude session down with the job? No — the tmux server daemonizes to
`ppid 1` and leaves the job's process tree entirely, so `bootout`, a fresh `bootstrap`,
and `kickstart -k` against a job holding a tmux server all leave a running session
untouched. Measured against a throwaway job on its own tmux socket, all three operations
run in sequence against it.

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

**An orphaned plist runs the *current* code under an older label, and the detector for it
must be by shape rather than by name.** `ProgramArguments` is `[node, <checkout>/server/index.js]`
— a **path**, not a name — so a plist written under a label this repo no longer uses goes on
starting that same file at every login. Both jobs then bind the one port (the two-panels trap
above, which is silent), and `restart-panel` kickstarts whichever is not holding it. So
`install()` sweeps first, on two rungs that both mean *this plist starts a copy of this panel
that is not the one being installed*: its `…/server/index.js` **no longer exists** (the
checkout moved out from under it), or it **is this very file** by `realpath`.

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

**Plist backups go to the state dir, not beside the original.** A second file in
`~/Library/LaunchAgents` carrying the same `Label` as the live plist is a duplicate job
waiting for the next login, so `install-agent.js` backs up into `STATE_DIR` — the same
habit `install-hook.js` has for `settings.json` — rather than writing a `.bak` next to the
file launchd actually reads.

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

**A scratch `FOREMAN_AGENT_LABEL` has to reach the job, not just the plist.** The label decides
both the plist's log paths *and*, now, which two files the running panel truncates — and
the second is read from the process's own environment. `jobEnvironment()` was writing
`FOREMAN_PORT` and `FOREMAN_STATE_DIR` into `EnvironmentVariables` but not the label, so a bench
job wrote to scratch logs while the panel inside it computed the default paths: the first
bench of the rotation would have deleted the real panel's history. Found while setting the
bench up, not by it. Anything else derived from the label has the same shape.

**`git diff` and `git status` quote paths differently, and the fix has its own trap
inside it.** Measured in a throwaway repo: `diff --name-only` leaves a space bare
(`web/my file.js`) but quotes *and* octal-escapes non-ASCII (`"web/caf\303\251.js"`);
`status --porcelain -uall` quotes and escapes both. `conflicts.js` stripped outer quotes
on the **porcelain side only**, so the two spellings of `web/café.js` differed by exactly
the two quote characters and never compared equal — while the space case came out right,
which is why its tests passed and nobody noticed. Two workers editing `web/café.js` were
never flagged, and nothing-found is indistinguishable from nothing-there. Both sides now
read **`-z`**, which returns raw bytes with no quoting and no escaping, the same reasoning
`merge-queue.js`'s `mergePaths` and `deployed.js`'s `branchFacts` already carry. Note
stripping quotes on *both* sides would also have made those two strings equal and is still
wrong: the path kept is then `web/caf\303\251.js`, and that escaped spelling is what the
room post puts in front of a human.

**And `-z` changes the porcelain rename encoding, which is the silent half.** A rename is
`XY new\0old\0` — two NUL-separated fields, **new first** — not the `XY old -> new` arrow
of the plain form. Split on NUL and treat every field as an entry and the original path is
read as a status line: `web/old-name.js` becomes the code `we` and the path
`/old-name.js`, on exactly the entries a rename produces, with nothing on screen saying
so. `parsePorcelainZ` in `conflicts.js` is the one place that parse lives, and it is a
named export for that reason alone. Two things it pins that reasoning would get wrong:
`R`/`C` ride in the **index** column only (`RM` is renamed-in-index, modified-in-worktree,
and no unmerged code carries either letter), and an *unstaged* move is not a rename to git
at all — it arrives as two ordinary entries, ` D old` and `?? new`. `test/conflicts.test.js`
pins the non-ASCII match, the space case as a regression guard, and the rename; all three
against real throwaway repos, and all three verified to fail against the old parse.

**…and rename detection is the same asymmetry from the other end.** `diff --name-only`
detects renames **by default**, so a *committed* rename reports only the new name while the
porcelain side reports both — a worker that committed
`web/x.js` → `web/y.js` shared no path at all with one editing `web/x.js`, and was never
flagged. `--no-renames` is the fix and it is one flag on three diffs, because all three
sites ask a question a vanished old name answers wrongly: `conflicts.js` (two workers on
one file *right now*), `merge-queue.js` (would these two PRs compose — git will either
carry the edit onto the new name or conflict, and either way a human must be told
before one press stands for both), and `deployed.js`, where it is the **restart** answer
it protects: a branch that moved `server/x.js` out to `web/x.js` reported `changed:
['web']` and `needsRestart` said no for a branch that plainly took a file out of `server/`.
Measured — default gives `web/y.js`, `--no-renames` gives `web/x.js` and `web/y.js`, and it
overrides a `diff.renames` config of `true` or `copies`, so it is a flag rather than a
setting somebody could switch back. No `-M0` and no `--diff-filter`: `--no-renames` alone
makes a rename read as a delete of the old path plus an add of the new. The flag can only
ever *add* the old name, so every one of the three widens what it warns about and never
narrows it — the direction all three files already prefer. Each has a test built on real
throwaway repos, and each was run against the old code first to see it fail.

**`composerSig` does not know about tasks, and a merge block built inside `buildComposer`
would freeze on stale data.** The composer is only rebuilt when that signature changes,
which happens on a prompt/mode/dialog change, not on a task closing. `renderMergeQueue`
is its own function, called from `renderHead` on the roster beat instead — the same shape
as `renderQueue`. Task state must never join `composerSig` itself: that would tear the
whole textarea down under a reader's cursor every time a worker reported done, for a
block that only needed its own repaint.

**The interrupt row's design is that it never moves, and the merge block is the first
thing ever placed above it.** Two things make that affordable, and both have to keep
holding: PRs arrive minutes apart rather than per reply, so the block repaints rarely; and
it is *appended and removed* from `.composer-above` rather than hidden, so
`.composer-above:empty` still fires and a session with nothing to merge stays
byte-identical to before the feature existed — checked by SHA-256 on the cropped
screenshot region, not by eye, because "looks the same" is not evidence a selector still
fires.

**Cache a three-dot diff on both shas, not the branch tip alone.** `base...branch`
changes its answer when *main* moves even though the branch tip did not — and main moves
at every merge, which is this feature's whole subject. `conflicts.js` keys its own cache
on the branch sha alone and is right to, for its own question ("what has this worker
changed"); this file's question is "what would land next to what", which the same key
would answer with a diff taken before the thing that mattered moved. The key here is
`${repo}:${branchSha}:${baseSha}`, both resolved to shas via `shaOf`.

**A signature can be joined with what reads as an empty string and is not.** `mergeSig`
(`web/app.js`) is what decides whether the merge block repaints — and its first version
joined every field with `''`. Not a bug you can see: three literal control bytes (U+0001,
U+0002, U+0003) had ended up inside the quotes, which is valid JavaScript, throws nothing,
and looks like an empty-string join in every editor. The consequence is the same as an
empty join would be — two different queues can come out spelled identically, and a real
change stops repainting. Ordinary punctuation now (`|` within a row, `~` between rows), and
`kind` was folded in too, since a row's `plan` chip is drawn from it and wasn't part of the
signature at all. Same lesson `normalize.js` already carries about the ESC byte in its ANSI
regex, in new clothes: an invisible character in source lasts until the next careless edit.

**Two manifests on one origin with the same `id` are one app, and the second one installed
replaces the first.** `/manifest.webmanifest` and `/m/manifest.webmanifest` are two
installable apps — the panel and the phone's leads view — and `id` is what a browser keys an
installed app on. Omitted, it **defaults to `start_url`**, which reads like it would settle
it and does not always: a browser matching on the resolved id would see two apps whose
scopes differ but whose identity was never stated. Both spell `id` out, `/` and `/m/`, and
`test/icons.test.js` pins that they differ along with the short names. Verified through
Chrome's own parser rather than by reading the spec — `Page.getAppManifest` over CDP returns
what Chrome made of each file plus its error list, and both came back with `errors: []`,
distinct ids, and every icon fetching 200.

**…and `apple-touch-icon` transparency is filled in by iOS with a colour you did not
choose.** The `any` icons are a rounded tile with transparent corners, which is what makes
them sit correctly in the Dock under Chrome's installed `.app`; the Apple touch icons are
the same mark **flattened opaque and unrounded**, because iOS applies its own mask and
composites whatever is behind the alpha itself. A maskable icon is the third shape again —
full-bleed square with the content pulled into the middle 80%, since the platform crops it
to something it does not announce in advance. Three purposes, three geometries, one
`GEOMETRY` constant; `scripts/make-icons.mjs` is the only description of any of it and
`npm run icons` moves all of them at once.

**A `.webmanifest` already serves as `application/manifest+json`, and `sips` cannot read an
SVG.** Two things that would each have cost a detour. Express's `send` resolves the type
from `mime-db`, which knows the extension — measured on a scratch panel, both manifests came
back with the right type off plain `express.static`, so no server change and no restart. And
this Mac has `sips` and `qlmanage` and nothing else — no `rsvg-convert`, no ImageMagick, no
PIL, no cairosvg — while `sips` has no SVG decoder at all. Rasterizing four rounded
rectangles in `node:zlib` and about a hundred lines of arithmetic beat both the Quick Look
route (whose output is a *thumbnail*, sized to its own taste) and the headless-Chrome route
(which would make regenerating an icon depend on a browser).

**A stored preference is not a granted permission, and printing the first over the second
reads as a bug.** The notifications opt-in lives in `localStorage`; the permission belongs
to the browser and can go back to `default` on its own — a new profile, cleared site data, a
reset. The first version of `paintNotify` (`web/app.js`) read the stored flag for its status
line and `notifyArmed()` for the checkbox, so a browser in that state drew **"On, in this
browser"** over an empty box. Nothing fired, correctly; the box just said the opposite.
Caught by looking at a screenshot of the settings section, not by any assertion — which is
the general lesson: every state a two-source control can be in wants a rendering, and the
contradictory one is the state nobody writes a test for. There are three now (never asked,
armed, remembered-but-not-granted) and `bench-states` walked all three.

**`Notification` needs a secure context, and Chrome will not even *grant* it otherwise.**
`http://127.0.0.1` is a secure context by specification and `http://<a LAN address>` is not,
so the notifications control works in the panel opened on this Mac and cannot work from the
phone — which follows from the 2026-08-27 exposure ruling rather than being a gap in it.
Measured both ways on a scratch panel bound wide: at the LAN address `isSecureContext` is
false, the checkbox disables itself and prints which gate is shut, and every session
blocking at once still fired nothing; the same browser at `127.0.0.1` turned it on
normally. `Browser.grantPermissions` over CDP **refuses** the LAN origin outright
(*"Permission can't be granted in current context"*), which is the same fact from the other
side. This is not an argument for putting TLS in front of the panel; it is why the phone's
half of that issue was an icon.

**The needs-you notification is derived from the roster, and must not be derived from
`needsYou`.** Every transition it fires on — a permission prompt, a question, a plan, the
trust gate, a worker's task reaching `review` — is already a field on the roster row and
already in `sessions.js`'s `#diff`, so no socket event and no endpoint were needed and
nothing needs restarting to pick it up. What is tempting and wrong is the field with the
matching name: `needsYou` also counts *"it replied and you haven't looked"*, which is an
unread badge in the rail and would put a notification on somebody's screen every time any
session finished a turn. `needsKind` in `web/notify.js` is the narrower rule, it asks about
the trust gate **first** (that screen is a fully-parsed permission box, so the general
question answers it wrongly and sends the reader to a card with deliberately no button on
it), and it applies the rail's own `quietWorker` so a worker's prompt stays its lead's
until the stuck timer fires. The module is pure for the usual reason: `test/notify.test.js`
runs it in node, the way `trust-gate.js` is tested.

**The status line is event-driven, and the wrapper's whole reason to touch
`refreshInterval` is that this makes the gauges go stale for hours on a quiet bench.**
Measured: 2 renders in 5m43s, zero across 90 seconds of idle. `npm run install-statusline`
sets `statusLine.refreshInterval` to 60 **only when the key is absent** — a value already
there is somebody's own decision and is never overwritten, and `uninstall-statusline`
restores the whole `statusLine` object from the sidecar exactly as it was found, which
puts the key back either way. 60 rather than something snappier because the thing being
re-run every tick is the *user's own script*, whatever it is; once a minute per session is
negligible, once every few seconds plainly isn't.

**…and that same interval is what broke a naive "latest payload wins" merge, live, on one
account.** Once `refreshInterval` is set, a session idle for hours re-posts its
*last-known* payload every minute — stale percentages, and no `five_hour` key at all once
that window's own reset had passed, because Claude Code had already dropped it from the
payload that sleeping session was holding. Replacing the whole stored record with whatever
arrived last let one idle re-post blank a live five-hour bar every sixty seconds. The
weekly window took longer to notice because it is long enough that a sleeping session's
copy still matches its `resetsAt` exactly — only the percentage tells the two readings
apart — and it flapped 9% → 5% → 9% on the same idle re-post the five-hour fix had already
solved for. `server/rate-limits.js` now merges **per window**: the later `resetsAt` wins
across windows, the **higher** percentage wins within one window (usage only climbs until
a reset mints a new one), and a window the incoming payload simply doesn't mention is left
alone — the only thing that ever removes a window is its own `resetsAt` actually passing.
Wholesale latest-wins is the trap; per-field, per-window is the only shape that survives an
idle sender.

**`resets_at` is Unix seconds, not milliseconds, and `used_percentage` isn't the payload's
only name for itself.** `new Date(1788571200)` is January 1970 — a wrong answer that
renders without complaint rather than throwing — so every reader multiplies by 1000 before
comparing against `Date.now()`. And every window is read as `used_percentage ?? utilization`:
the capture used the first, but the binary's own string table sits `utilization` right next
to `five_hour`, which makes the fallback cheap insurance against a rename rather than dead
code.

**The payload carries a dollar figure, and none of it is ever kept.** `cost.total_cost_usd`
rides in the same JSON as `rate_limits` — measured `0.3027715` on one real turn — and it is
meaningless against a subscription, so `server/rate-limits.js` extracts only the two
windows and nothing else: no cost, no session id, no model. Ruling of 2026-09-04, and it is
enforced by what the store's `ingest` reads out of the body, not by a filter on the route —
the endpoint hands the whole payload through unfiltered on purpose, for issue #52.

---

## What exists, and what deliberately doesn't

Present tense, not a changelog: what the panel has, and the rules that came with each piece.
How those rules were learned is in the Traps above; what the team deliberately does *not* do
is in `docs/team.md`'s Non-goals.

**A per-pane send queue** (`server/queue.js`, keyed by pane and persisted), the dialog
detection beside it, and the card that answers Claude's own questions (`server/question.js`
plus `web/app.js`) are all one thread: the panel should never put a keystroke somewhere you
didn't mean, and never demand attention for something you can't act on.

**Only sessions with a live pane make the roster.** There is no finished-session list and no
toggle for one — a transcript whose terminal has closed used to arrive in the inbox with an
unread badge nobody could clear. Reading one back is `claude --resume`'s job.

**Split view** puts two sessions side by side, which is why everything per-session lives
inside the `createPane` factory rather than in module scope.

**Pinning** (`server/pins.js`, pane-keyed and persisted like the queue) adds a `pinned` group
above the inbox. Pinned rows come *out* of the inbox rather than moving into it — a pin is a
promise about where a row will be, and one that relocated the moment it needed you would
break that promise exactly when you were looking for it.

**Groups** (`server/groups.js`) file folder headings under names you choose and fold them
away. Four things are load-bearing. A group holds **folders**, not sessions — sessions rotate
with `/clear`, folders don't. A folder is in exactly one group, enforced in `assign`, because
the one thing worse than an unsorted rail is a session drawn twice. Collapse is safe for
ordinary sessions and leads because the inbox hoists anything blocked or unread *out* of its
folder first — no longer true of **workers**, which hoist only once `stuck` fires; see the
trap above for what a collapsed team group can hide and for the measurement of what the dot
does and doesn't cover. And **a group the panel made for a team is the only kind it will ever
delete**: `auto` on the record says which, set only by `teamGroup()`, and those hold
worktrees the panel itself removes at close, so without reaping the heading outlives
everything under it, permanently. Not pruning stays right for a group *you* made — a folder
you filed comes back where you put it, empty or not. Groups written before the flag carry
none and are read by what they hold: a hand-made group files what the rail draws (a bare
folder name), and only a dispatch ever wrote an absolute path under `worktrees/`; empty is no
evidence and stays yours. Reaping is guarded by emptiness alone, which doubles as the guard
for a team group somebody hand-filed a real project into: it isn't empty, so it stays.

**Snapshot / restore** (`server/snapshot.js`) keeps one slot in `~/.foreman/snapshot.json`,
written on a button press: `{folder, slug, tmuxSession, skipPermissions, pinned}` per
session, replayed a lead through `launchLead` and everything else through `createSession`. It
holds **no groups** — those are folder-keyed and outlive any one session, so they survive on
their own and a copy would be a second source of truth — and **no queue**, because a message
written for a conversation that no longer exists must never be replayed into a fresh one.
Restore is serial, skips names already live (so a second press mints no `-2`), and fails per
entry. `benchEntries` decides what gets saved and `restoreSessions` runs the loop, both in
`snapshot.js` so both are tested; the endpoints are the two launchers and the pins.

**Relaunch all** (`+ new` → `Snapshot` → `relaunch all…`) closes every bench session with
`/exit` and starts it again — the control for "I updated Claude Code". Two modes and no
default; the box asks. It builds its list from the **live** roster (`relaunchEntries`) rather
than the saved slot, so pressing it never spends the bench save, and `snapshot.json` still
holds no session ids — restoring a saved bench is fresh, as it always was. Three guards, all
measured: refused outright while any worker is live (a worker cannot be put back), a session
holding anything is skipped rather than forced and named in the result, and everything is
reported. The exits all land before any relaunch, which costs a window where the bench is
down and buys reusing `restoreSessions` unchanged — its skip-what-is-already-live rule is
also what handles the sessions the guard refused to touch.

**The room reads as three shapes**, all left-aligned: framed system cards (amber for a
conflict), speech bubbles laned by direction for anyone actually talking, and the loud
escalation card. What gives the bubbles any traffic at all is that a worker's report is
posted **as the worker** — `from: <task id>`, `kind: 'status'` — rather than as a `system`
line from `panel` about it, which is how a multi-paragraph summary used to arrive dressed as
one-line machinery. `report: 'review'` on the entry carries the fact that it *is* the done
report; the lead reads it out of `room_read`, the card draws it under the bubble. Everything
else in the room is machinery and stays `system`.

**Row and header controls**: `⧉` duplicates a session into the same folder, the bin `/exit`s
one behind a confirmation, a folder icon opens the project in Finder, and `recent` drops the
filing for one recency-ordered list.

**The team** has a `pending` task state — a task recorded with its brief and nothing else,
the middle rung between an issue on a tracker and a dispatched worker: added via `task_add`,
promoted only on a second, explicit yes via `task_start`. Every task row opens a read-only
brief modal on click, showing a planner's plan alongside its brief where one exists and
rendering both as markdown rather than raw text. The lead's own `room_read` / `team_status`
return a tail rather than the whole log, so a long-running lead's context doesn't fill up on
its own room.

**A known gap: there is no "refresh brief" control.** A brief change needs a panel restart
*and* a lead relaunch to take effect. `plannerBrief` reaches a planner at its next dispatch,
so a restart is enough there; the lead's own brief only ever reaches the *next* lead.

**The panel runs under launchd** — `npm run install-agent` writes and bootstraps the plist,
`npm run restart-panel` is the day-to-day restart. Its two log files are trimmed once at
boot, and that policy is deliberate: copy aside, truncate in place, one `.1`, boot only, no
`newsyslog`, and the file logs are *not* dropped in favour of the unified log, because
`tail -f` is how this thing is actually debugged. What launchd does, as against what
reasoning about it predicts, is in the Traps above — the silent port collision first.

**It installs as an app**, out of `web/` with no server change: a manifest and a generated
icon set for each of the two views, plus an opt-in macOS notification when a session walks
into something it cannot get past. The transitions come off the roster the panel already
broadcasts, so no socket event was needed. The honest limit of any bench here is worth
stating, because it applies to every future icon change: a bench can show that Chrome parses
both manifests without error, that every icon they name is served, and that a real session
walking into a real prompt raises exactly one notification which opens that session when
clicked. It cannot press "Add to Dock" — whether an icon looks right in the Dock and on a
Home Screen is a pair of eyes.

**Not built, and not oversights.** A search index across transcripts: wanted, unbuilt.
Authentication: a stated non-goal, argued and decided — see the exposure trap above before
reaching for it. And anything that merges a PR, kills a worker, or approves a plan without a
human saying so: see the five rules under *The team*.

## Working here

- **Verify against a scratch session in the sandbox, don't assume.** Nearly every wrong
  turn this project has taken came from reasoning about the TUI instead of capturing it.
  `tmux new-session -d -s foreman-test -c <dir> claude`, drive it, read it, kill it. The
  `<dir>` is not a free choice any more: it is one of the three throwaway repos in
  `../foreman-sandbox`, beside this checkout — **alpha** (Node on `main`, a
  `package.json` with no lockfile), **beta** (no `package.json` at all, shell scripts and
  a `t/run.sh`), **gamma** (Node, with a lockfile, and deliberately on **`master`** —
  this repo hardcodes `main` as a base branch in places, and gamma is the only way anyone
  would notice). They are real repos with real tests and nothing in them is anybody's
  work, so break them freely. Never a real project, and never this folder: a scratch
  session here is titled after this repo in the rail, indistinguishable from the real
  one, and messages meant for one land in the other.
- **Only sandbox projects may be named in anything that gets written down.** The reason
  is not tidiness, and knowing it is what stops the rule being optimised away. This
  panel's purpose is watching real Claude Code sessions, so proving a change works has
  always meant touching real work — and the proof then carries those projects' names into
  test fixtures, measurements, commit messages and PR bodies. None of that is anyone's to
  publish, and this project is developed **in the open**, where a branch is public the
  moment it is pushed and permanent afterwards. So `alpha`, `beta` and `gamma` are the only
  project names allowed in a fixture, a screenshot, a commit message, a PR or a report.
  Where a measurement can genuinely only be taken against something real, write down its
  *shape* and not its name — "a session in another folder", not the folder. And note what
  the rule does not do, because assuming otherwise is how it fails: it does not stop anyone
  *seeing* every project on the machine, since any panel lists every tmux session on it. It
  governs what is written down, because that is what gets published.
- **Capture at a narrow width too.** Pane width is an input to every parser here. The
  launcher opens 220 columns; sessions started from a plain terminal are far
  narrower, and at 70 the plan box's header, its footer path and long option labels all
  wrap. "Verified end to end" at one width is not verified — `test/fixtures/` keeps a
  wide and a narrow capture of that box for exactly this reason.
- **`capture-pane -p` cannot tell a suggestion from typed text.** Claude Code offers a
  next prompt as dim ghost text in the composer; plain capture strips the attribute, so it
  reads as though someone typed it. Use `capture-pane -pe` and look for `\e[2m` if it
  matters. Harmless to sending — `C-u` clears the line first — but it will fool you.
  `server/ghost.js` is now the one reader of that attribute; read its trap under Traps
  before reaching for the dim run yourself — the run is not one run.
- **Effort has no session-only setting. At all.** `/effort` offers `←/→ to adjust · Enter
  to confirm` and nothing else, and that Enter writes `effortLevel` into
  `~/.claude/settings.json` — Claude Code says so itself: *"saved as your default for new
  sessions"*. The effort row inside `/model` is no escape: pressing **`s`** there, the
  "use this session only" key, still wrote it globally. Both measured, both restored from a
  backup. So the panel's effort picker is labelled as a global setting rather than dressed
  up as a sibling of the model picker beside it. What *is* safe: arrow keys alone change
  nothing on disk, which is what lets the marker be walked into place before committing.

- **In `/model`, a digit *commits*, and commits as the global default.** Not "moves the
  cursor", not "selects and waits for Enter" — pressing `4` picks Sonnet **and** rewrites
  `model` in `~/.claude/settings.json` for every session you start afterwards. Measured the
  expensive way: it happened, and the file was restored from a backup taken minutes before.
  Every other numbered screen here is answered by the option's own digit; this is the one
  where a digit is the thing you must never send. `server/model.js` steps the cursor with
  `Down`/`Up`, re-reading after each press, then commits with `s` — and `Enter` is never
  sent from the panel at all. **Back `~/.claude/settings.json` up before touching that
  dialog by hand.**
- **…and `s` is not always the last key.** If the conversation is already cached for the
  model it is leaving — meaning a message has been sent under it — one more box appears:
  `Switch model?`, `1. Yes, switch to X`, `2. No, go back`, and **until it is answered
  nothing has changed**. It carries no key-hint footer at all, so it reads as
  `needs-decision` with no prompt behind it — a shape this file used to attribute to the
  trust gate as well, wrongly; that one has a full prompt — which is exactly how it was
  found: the panel reported a model it had not set, over a session now blocked on a box
  the browser couldn't draw. Here a digit *is* the answer (it selects and submits, and the
  session-only scope survives it — measured, `settings.json` untouched), so the endpoint
  presses the yes row's own digit after checking the model it names is the one that was
  clicked, and Escapes back out if it isn't. Note `Esc` goes back to the **picker**, not to
  the composer: `closeModelDialog` presses and re-reads rather than pressing once. Whether
  the box appears at all depends on the cache, so both paths are live — a fresh session
  switches on `s` alone.
- **…and on a short pane it is not a list at all but a window onto one, which is how the
  panel came to strand a session behind a box it had opened itself.** At **80×23** — the
  size the panel's own attach-terminal button shrinks a pane to, because a default macOS
  Terminal window is 80×23 — Claude Code v2.1.257 draws the picker as a **three-row
  scrolling window**: `↑`/`↓` in the *cursor column* where `❯` goes, and a `… +2 models`
  row. `↓ 3.` does not match `OPTION_RE`, so the run came back as 1..2 or as 3..4 — not a
  1..N run — and `parseModelDialog` answered **null**. `POST /model` then stepped once,
  re-read null, answered 409 "the model picker is not open" and **left the box up**; every
  later `/model/open` answered 409, `closeModelDialog` returned `true` without pressing
  Escape *because it asked the same failing parser*, and the composer stayed blocked until
  somebody pressed Esc in the terminal. Hit live, on a lead.

  Four measurements, taken in the sandbox's `alpha`, and the first is the one that decides
  where to look. **It is height, not width**: 220×23 windows exactly as 80×23 does, while
  220×50 draws all five rows — so a wide capture proves nothing here and the fixtures are a
  matched set at both sizes. **A marker is never the cursor**: with the cursor on the edge
  row the marker is simply not drawn, so `↑`/`↓` can be blanked without ever losing a `❯`.
  **`… +N models` counts everything hidden, not what is below** — `+2` at the top of the
  list and `+2` at the bottom — so `visible + N` is the length of the list; true at every
  size the panel produces and **one short at 60×10**, where the window degenerates to a
  single row, which is why nothing is decided by it. And **the list wraps**: `Down` from the
  last row lands on the first.

  Two rules come out of it. The window is flattened **inside `model.js`** — marker column
  blanked, `… +N` lifted out, the run rebased to start at 1 and the offset added back — so
  `OPTION_RE` and `readOptionBlock` are untouched and the other four parsers see nothing
  new; loosening the shared regex to admit `↓ 3.` would have taught every screen in the
  panel to read a scroll marker as part of an option. And **getting out must not depend on
  reading**: `modelDialogOpen` / `modelConfirmOpen` are witnesses by title and footer alone,
  and every path that used to abandon an unreadable picker now Escapes it and says so. A box
  the panel opened and cannot read is a box it must close.

  What the endpoint does with all that: `/model/open` walks the cursor round the list with
  arrow keys — the only keys in this dialog that commit nothing — merging what each window
  shows, then walks it back to where it found it, so the browser's menu offers all five
  models. **The stall test is the cursor, not the yield**, and that is the one trap inside
  the fix: written as "two presses that revealed no new row, so stop", it fired after two
  presses *inside* a three-row window and returned three models of five — from exactly the
  state a freshly opened picker is in when the current model is row 1. A press that does not
  move the cursor is the end of a list that does not wrap; nothing inside a window imitates
  that. It was found by driving the real menu from a browser, because every run driven from
  the CLI had happened to start on a row where the first press scrolled the window.
- **The panel is probably already running.** Check `lsof -iTCP:48770` before starting
  one, use `FOREMAN_PORT` for a second, and never `pkill -f "node server/index.js"` — that
  pattern matches the one the user is using; kill by port (`lsof -tiTCP:<port>`). Give the
  second one `FOREMAN_STATE_DIR` too, and that is not just tidiness. Two servers must not
  run the queue at once (they share
  `~/.foreman/queue.json` and would both flush the same message), a test run would
  otherwise be saving snapshots over the bench you actually rely on, and **a second
  server boots its own worktree GC**: pointed at the real state dir it will sweep real
  worktrees and branches belonging to real failed tasks, post the receipt into a real
  team's room, and be entirely within its rights. Scratch state dir, scratch port, every
  time.
- **Prefer showing nothing over showing something wrong.** A blank transcript that
  explains itself beats a plausible one belonging to another session.
- Claude Code re-reads hook config **while running** — measured, not assumed: a session
  whose `claude` started at 01:07 was posting to a hook registered at 01:38, and one
  running since a week earlier began reporting the moment it was next spoken to. An
  earlier note here said the opposite (read once at launch, restart to pick up a change)
  and it was wrong. Registering a hook and then waiting is enough.
- `/clear` mints a new session id and a new transcript. The panel follows the rotation.
