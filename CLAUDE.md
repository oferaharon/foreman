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
`effort.js`, `ghost.js`, `queue.js`, `claim.js`, `status.js`, `settings-file.js`, `rooms.js`,
`rooms-line.js`, `session-launch.js`, `briefs.js` and `parsePane` in `tmux.js`; on the team side `tasks.js`,
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
a role handed to every *ordinary* session opened there. **Every role now carries a
`--settings` file, including a standalone** (`session-settings.json`,
`server/session-launch.js`) — the one thing in it is an allow rule for the panel's own
`foreman` tools, spelled `mcp__foreman`, the bare whole-server form. See the classifier
trap below for why.

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
  one-liners — dispatch a worker. It may publish a release (`Bash(gh release create:*)` is
  a standing allow rule, unconditional unlike `leadMerges`, because a release can only
  follow a version bump the maintainer already merged by hand) — it still cannot commit,
  push, or merge without the maintainer's own word.
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

### Binding

Which transcript belongs to which pane: titles, labels, siblings, freshness, the folder a
transcript really lives in, and the hook receipts that overrule every heuristic. Evidence:
[`docs/traps/binding.md`](docs/traps/binding.md).

- `server/binding.js` · `server/sessions.js` — **A `<repo>-<branch>` title proves nothing.**
  Several launchers derive it from the repo and branch, so every session in one repo on one
  branch writes the same one; a title is a hint, never an identity.
  [binding#a-repo-branch-title-proves-nothing](docs/traps/binding.md#a-repo-branch-title-proves-nothing)
- `server/sessions.js` (`modernNamer`) — **A label can collide with the branch.** The guard
  against branch-derived titles must only fire when a *sibling* could still be writing that
  default.
  [binding#a-label-can-collide-with-the-branch](docs/traps/binding.md#a-label-can-collide-with-the-branch)
- `server/binding.js` — **Ambiguity comes from siblings, not names.** One pane in a folder is
  one conversation; several means only an exact label match is safe.
  [binding#ambiguity-comes-from-siblings](docs/traps/binding.md#ambiguity-comes-from-siblings)
- `server/binding.js` — **Freshness is load-bearing.** A transcript last written before a
  pane existed cannot be that pane's.
  [binding#freshness-is-load-bearing](docs/traps/binding.md#freshness-is-load-bearing)
- `server/sessions.js` · `server/launch.js` (`slugFor`, `uniqueSessionName`) — **The
  roster's `label` is not the label you launched with.** `slugFor` is the only correct way
  back, and the row's `cwd` is the transcript's — `paneCwd` is what a relaunch has to use.
  [binding#the-rosters-label-is-not-the-label-you-launched-with](docs/traps/binding.md#the-rosters-label-is-not-the-label-you-launched-with)
- `server/binding.js` (`rememberedFor`) — **A binding survives a sibling.** The last poll's
  answer is replayed, re-checked against cwd and freshness; hooks still overrule it, and on a
  cold start rule 3 binds the leftovers.
  [binding#a-binding-survives-a-sibling](docs/traps/binding.md#a-binding-survives-a-sibling)
- `server/install-hook.js` · `server/status.js` (`ingest`) · `POST /hook` — **The hook
  posts JSON without saying so — and that silently cost the panel its best evidence.**
  `/hook` now parses any content-type, and the installer sends the header and replaces an
  entry it wrote before rather than skipping the event.
  [binding#the-hook-posts-json-without-saying-so](docs/traps/binding.md#the-hook-posts-json-without-saying-so)
- `server/install-hook.js` (`X-Tmux-Socket`) · `server/tmux.js` (`tmuxSocketPath`) ·
  `server/status.js` (`ingest`) — **A pane id is only meaningful relative to one tmux
  server, and the hook used not to say which — so a bench's scratch session owned the real
  panel's bindings.** The panel's own socket path is read off tmux, never reconstructed.
  [binding#a-pane-id-is-only-meaningful-relative-to-one-tmux-server](docs/traps/binding.md#a-pane-id-is-only-meaningful-relative-to-one-tmux-server)
- `server/status.js` (`ingest`) · `server/install-hook.js` — **The asymmetry is the fix, and
  it is deliberate rather than an oversight.** A receipt carrying no socket is accepted
  exactly as before; one that is present and different is refused whole.
  [binding#the-asymmetry-is-the-fix](docs/traps/binding.md#the-asymmetry-is-the-fix)
- `server/binding.js` (`sameWorkspace`) · `server/transcript.js` (`probe`) — **A
  transcript's `cwd` moves; the folder it lives in doesn't.** Match on
  `~/.claude/projects/<cwd with each slash as a dash>`, which is named at launch and never
  rewritten.
  [binding#a-transcripts-cwd-moves](docs/traps/binding.md#a-transcripts-cwd-moves)

### Pane parsers

Permission, question and plan boxes, ghost text, the mode line, the dialog test, and the
pane width every one of them depends on. Evidence:
[`docs/traps/pane-parsers.md`](docs/traps/pane-parsers.md).

- `server/permission.js` (`classify`, `parsePrompt`) · `web/app.js` · `web/m/cards.js` —
  **Permission option 2 is always a broader yes.** Answer by the option's own digit, never
  positionally — and a box can offer more than one broad yes.
  [pane-parsers#permission-option-2](docs/traps/pane-parsers.md#permission-option-2)
- `server/permission.js` (`parsePrompt`, `dropTip`) ·
  `test/fixtures/prompt-bash-broad{,-narrow}.txt` — **An option label wraps, and the run walk
  used to break on the tail.** The unnumbered tail is joined only where it aligns, and the
  box's own `Tip:` line is dropped before the body walk.
  [pane-parsers#a-wrapped-option-label-and-the-tip-line](docs/traps/pane-parsers.md#a-wrapped-option-label-and-the-tip-line)
- `server/permission.js` (`parsePrompt`) · `server/tmux.js` (`DECISION_RE`) — **Permission
  prompts never reach the transcript.** Both are gated on the composer being absent, or a diff
  of the fixtures reads as a live box.
  [pane-parsers#permission-prompts-never-reach-the-transcript](docs/traps/pane-parsers.md#permission-prompts-never-reach-the-transcript)
- `web/app.js` (`buildComposer`) · `web/m/cards.js` — **A question box also reads as
  `needs-decision`.** The question card is offered first and the permission bar is the
  fallback, never the other way round.
  [pane-parsers#a-question-box-reads-as-needs-decision](docs/traps/pane-parsers.md#a-question-box-reads-as-needs-decision)
- `server/sessions.js` (`rememberFooter`) · `web/app.js` (`shortModel`, `buildComposer`) — **A
  session that is asking you something reports no model.** A `null` model must never reach an
  unguarded `model.replace`.
  [pane-parsers#a-blocked-session-reports-no-model](docs/traps/pane-parsers.md#a-blocked-session-reports-no-model)
- `server/ghost.js` (`parseGhost`, `rememberGhost`) · `server/tmux.js` (`readGhost`) ·
  `web/prefs.js` — **Ghost text is one line, it is not one dim run, and the terminal truncates
  it — three separate measurements, and getting any of them wrong ships a wrong suggestion.**
  Every non-blank character after the caret must be dim, and a read ending in `…` is refused.
  [pane-parsers#ghost-text](docs/traps/pane-parsers.md#ghost-text)
- `server/transcript.js` (`effort`) · `server/sessions.js` · `server/tmux.js` (the footer
  scrape) — **The footer's right-hand slot rotates.** Read effort from the transcript, never by
  scraping; model and `ctx:` are stable in the footer and are read there.
  [pane-parsers#the-footers-rotating-slot](docs/traps/pane-parsers.md#the-footers-rotating-slot)
- `server/tmux.js` (`parseBypass`, `MODES`) · `server/sessions.js` — **`bypass permissions` is
  on the mode line but is not a mode.** It must never join `MODES`, and `null` is not `false`.
  [pane-parsers#bypass-permissions-is-not-a-mode](docs/traps/pane-parsers.md#bypass-permissions-is-not-a-mode)
- `server/tmux.js` (`changeMode`, `MODES`) — **Modes only cycle.** `changeMode` presses and
  re-reads until it matches — never count presses.
  [pane-parsers#modes-only-cycle](docs/traps/pane-parsers.md#modes-only-cycle)
- `server/tmux.js` (`sendText`) — **Sending is two paths.** Single line `send-keys -l`,
  multi-line bracketed paste, `C-u` first, and re-check the pane still runs Claude.
  [pane-parsers#sending-is-two-paths](docs/traps/pane-parsers.md#sending-is-two-paths)
- `server/tmux.js` (`parsePane`) · `test/fixtures/dialog-*.txt` — **A modal makes a session
  look idle** — the test is the absence of the composer footer and nothing else; a key-hint
  line is too clever.
  [pane-parsers#a-modal-makes-a-session-look-idle](docs/traps/pane-parsers.md#a-modal-makes-a-session-look-idle)
- `server/plan.js` · `web/app.js` — **The plan-approval box inverts the option-2 rule.** Option
  1 is the broad yes, the safe answer is at no fixed number, and a digit selects *and* submits.
  [pane-parsers#the-plan-approval-box](docs/traps/pane-parsers.md#the-plan-approval-box)
- `server/question.js` (`readOptionBlock`, `planAnswer`) · `server/permission.js` — **A
  question box looks like a permission box and answers nothing like one.** What a digit does
  changes per screen, and nothing on screen tells you when you get it wrong.
  [pane-parsers#what-a-digit-means-per-screen](docs/traps/pane-parsers.md#what-a-digit-means-per-screen)
- `server/question.js` (`planChat`, `planFreeText`) — **The two rows below the rule are the
  only way to answer in words, and they were missing from the card.** `Chat about this` is one
  press on every layout; `Type something` is three steps and single-select only.
  [pane-parsers#chat-about-this-and-type-something](docs/traps/pane-parsers.md#chat-about-this-and-type-something)
- `server/question.js` (`questionAbove`) · `server/tmux.js` (`dialogTitle`) — **A question
  wraps, and so do its options.** Collect upward to the box's own chrome; `dialogTitle` had the
  same bug from the other end.
  [pane-parsers#a-question-wraps](docs/traps/pane-parsers.md#a-question-wraps)
- `server/question.js` (`stripPreviewPanel`, `planAnswer`) · `web/m/cards.js` — **Some question
  boxes draw a preview panel beside the options.** The box is cut back to the panel's column,
  and there a digit only moves the cursor.
  [pane-parsers#the-preview-panel](docs/traps/pane-parsers.md#the-preview-panel)
- `server/launch.js` (`attachTerminal`) · `test/fixtures/` — **Attaching a Terminal resizes the
  pane, and pane width is an input to every parser here.**
  [pane-parsers#attaching-a-terminal-resizes-the-pane](docs/traps/pane-parsers.md#attaching-a-terminal-resizes-the-pane)
- `server/question.js` (`planAnswer`) — **A multi-select's keys are a diff, not a selection.**
  It presses only the difference against what the pane shows.
  [pane-parsers#a-multi-selects-keys-are-a-diff](docs/traps/pane-parsers.md#a-multi-selects-keys-are-a-diff)
- `server/question.js` · `POST /api/sessions/:id/answer` — **Never submit a multi-select
  without re-reading the review.**
  [pane-parsers#never-submit-a-multi-select-unread](docs/traps/pane-parsers.md#never-submit-a-multi-select-unread)

### Exposure

Who can reach this panel and who may widen that: the bind host, the settings writes that
decide it, the origin guard the socket needed, and the two servers that can hold one port at
once. Evidence: [`docs/traps/exposure.md`](docs/traps/exposure.md).

- `server/settings-file.js` (`isLoopbackRemote`, `validateConfigPatch`, `PREFIX_REFUSAL`) ·
  `PATCH /api/config` · `web/app.js` (the settings modal) — **Exposure is the one thing a
  LAN peer may not change, and the check is the socket, not the header.** A loopback `Origin`
  would prove nothing, and `sessionPrefix` sits in the same file and is refused by name.
  [exposure#exposure-is-the-one-thing-a-lan-peer-may-not-change](docs/traps/exposure.md#exposure-is-the-one-thing-a-lan-peer-may-not-change)
- `server/settings-file.js` (`readConfigFile`, `writeConfigFile`) — **A settings write
  merges; a boot read does not.** An unparseable file is refused with a 409 rather than
  replaced, and the temp file goes in the same directory because `rename` is only atomic
  within one filesystem.
  [exposure#a-settings-write-merges-a-boot-read-does-not](docs/traps/exposure.md#a-settings-write-merges-a-boot-read-does-not)
- `server/config.js` (`HOST`, `HOST_SOURCE`) · `server/settings-file.js` (`bindHost`) —
  **The panel can be bound wider than loopback, and it has no authentication — a stated
  non-goal, not a gap.** Do not add an auth requirement or a boot guard that refuses a wide
  bind; the origin check is a *browser* guard and must not grow into one.
  [exposure#the-panel-can-be-bound-wider-than-loopback](docs/traps/exposure.md#the-panel-can-be-bound-wider-than-loopback)
- `server/install-agent.js` (`jobEnvironment`) · `server/settings-file.js` (`seedConfigFile`,
  `resolveBindHost`) — **The installer must not hardcode the bind, and the panel records the
  one it is actually using.** The host is resolved, the plist carries the key only when it is
  not loopback, and the panel seeds `config.json` at its first boot.
  [exposure#the-installer-must-not-hardcode-the-bind](docs/traps/exposure.md#the-installer-must-not-hardcode-the-bind)
- `server/index.js` (`portAnswering`, the boot block before `server.listen`) ·
  `server/install-agent.js` (`KeepAlive`) — **Two node servers can bind the same port at
  once, silently, and split traffic by interface — VERIFIED.** The guard is an HTTP probe of
  loopback, never a bind attempt — a bind attempt is precisely the check that does not detect
  this — and `process.exit(0)` is a contract with the plist.
  [exposure#two-node-servers-can-bind-the-same-port-at-once](docs/traps/exposure.md#two-node-servers-can-bind-the-same-port-at-once)
- `server/origin.js` · `server/index.js` (`verifyClient`, the non-`GET` `app.use`) ·
  `POST /hook` — **A WebSocket handshake is exempt from CORS, so `/ws` was the whole hole —
  and the guard that closes it is a *browser* guard, not authentication.** It restricts nobody
  on the local network, `GET` is deliberately not gated, the address filter is a filter, and
  `Origin: null` is refused while an absent header is allowed.
  [exposure#a-websocket-handshake-is-exempt-from-cors](docs/traps/exposure.md#a-websocket-handshake-is-exempt-from-cors)

### Transcript records

What a `.jsonl` record really is before `normalize.js` is done with it: slash command
output, task notices, peer messages, room deliveries, and the subscription that carries
them to a browser. Evidence:
[`docs/traps/transcript.md`](docs/traps/transcript.md).

- `server/normalize.js` (`parseCommandOutput`, `parseCommand`, `DROP_TYPES`) — **A slash
  command's output is a transcript record, it carries ANSI, and it comes in two shapes.**
  The ANSI regex is written as an explicit escape rather than the literal ESC byte, and the
  match is anchored so a message *mentioning* the tag stays the user's words.
  [transcript#a-slash-commands-output-is-a-transcript-record](docs/traps/transcript.md#a-slash-commands-output-is-a-transcript-record)
- `server/normalize.js` (`parseTaskNotice`) — **A `type: 'user'` record is not proof a human
  typed anything.** Detection is two witnesses that must both hold — a record field and an
  anchored `^<task-notification>` envelope — never the sentence inside.
  [transcript#a-type-user-record-is-not-proof-a-human-typed-anything](docs/traps/transcript.md#a-type-user-record-is-not-proof-a-human-typed-anything)
- `server/normalize.js` (`peerOrigin`, `DROP_TYPES`) · `test/fixtures/peer-message-busy.jsonl`
  — **One peer message, two records, and which one Claude Code writes depends on whether the
  recipient was busy — MEASURED on v2.1.257, both shapes captured minutes apart in one
  sandbox session.** The busy shape carries its `origin` a level deeper, inside `attachment`,
  and fires no `UserPromptSubmit` hook at all.
  [transcript#one-peer-message-two-records](docs/traps/transcript.md#one-peer-message-two-records)
- `server/room-header.js` (`readRoomDelivery`) · `server/normalize.js` — **A room delivery
  leaves the same record a typed message leaves, so the only witnesses are in the text —
  MEASURED on v2.1.257, on a real delivery in the sandbox.** Both witnesses come out of the
  text: the anchored header shape, and every remaining line carrying that speaker's prefix.
  [transcript#a-room-delivery-leaves-the-same-record-a-typed-message-leaves](docs/traps/transcript.md#a-room-delivery-leaves-the-same-record-a-typed-message-leaves)
- `server/index.js` (`subscribe`) · `web/app.js` (`ws.onopen`, `appendMessages`) — **A
  subscription dies with the socket, and nothing on screen says so.** `ws.onopen`
  re-subscribes every open pane, and the slot is claimed before the read — a subscription
  that outlives its slot doubles every message.
  [transcript#a-subscription-dies-with-the-socket](docs/traps/transcript.md#a-subscription-dies-with-the-socket)
- `server/index.js` (`subscribe`) · `web/app.js` — **A subscription is keyed by socket *and
  slot*.** Every `transcript` / `messages` / `earlier` / `rebound` frame carries its slot; a
  frame without one means slot `a`.
  [transcript#a-subscription-is-keyed-by-socket-and-slot](docs/traps/transcript.md#a-subscription-is-keyed-by-socket-and-slot)
- `server/sessions.js` (the synthetic id) · `web/app.js` — **tmux pane ids contain `%`.**
  `pane:%19` in a URL path is read as a percent-escape, so synthetic session ids use
  `pane-19`.
  [transcript#tmux-pane-ids-in-urls](docs/traps/transcript.md#tmux-pane-ids-in-urls)
- `server/transcript.js` (`probe`) · `server/sessions.js` — **`probe` only samples head and
  tail.** Unread is *accumulated* across polls rather than recomputed; don't "simplify" that
  back.
  [transcript#probe-samples-head-and-tail](docs/traps/transcript.md#probe-samples-head-and-tail)

### Launch and relaunch

Starting a session, duplicating one, ending one, putting a whole bench back, the prefix
every one of those names is built from, and the folder-trust gate a fresh launch lands on.
Evidence: [`docs/traps/launch.md`](docs/traps/launch.md).

- `web/app.js` (`sessionRow`, `duplicating`) · `server/launch.js` (`slugFor`) — **A duplicate
  inherits bypass, and that is the point.** The in-flight flag has to live in module scope,
  because the row is rebuilt from scratch on every roster broadcast.
  [launch#a-duplicate-inherits-bypass](docs/traps/launch.md#a-duplicate-inherits-bypass)
- `server/tmux.js` (`assertNotBlocked`, `sendText`) · `web/app.js` (the rail row's bin) —
  **Closing a session is `/exit`, and "blocked" is wider than `state === 'dialog'`.** Test
  every way a pane can be holding something — the startup trust gate sets no `dialog` at all.
  [launch#closing-a-session-is-exit](docs/traps/launch.md#closing-a-session-is-exit)
- `server/launch.js` (`launchLead`) · `server/snapshot.js` (`restoreSessions`) —
  **`--resume` continues the *same* transcript file, and the launch flags beat the replayed
  conversation — VERIFIED, and both halves decided the shape of relaunch-all.** A resumed
  lead answers out of today's brief, settings and MCP config while remembering yesterday's
  conversation.
  [launch#--resume-continues-the-same-transcript-file](docs/traps/launch.md#--resume-continues-the-same-transcript-file)
- `server/snapshot.js` (`relaunchEntries`, `liveSessionNames`) — **Relaunching the whole
  bench can take the tmux server down with it, and pane ids restart at `%0`.** Session
  **names** are the contract and survive it; read a pane-id reset as expected, not as a bug.
  [launch#relaunching-the-whole-bench-can-take-the-tmux-server-down](docs/traps/launch.md#relaunching-the-whole-bench-can-take-the-tmux-server-down)
- `server/snapshot.js` (`restoreSessions`) · `~/.claude.json` — **A relaunch into a folder
  whose trust was never recorded lands on the trust gate.** Three sessions answering their
  gates at once can lose one to the last writer.
  [launch#a-relaunch-into-a-folder-whose-trust-was-never-recorded](docs/traps/launch.md#a-relaunch-into-a-folder-whose-trust-was-never-recorded)
- `server/launch.js` (`sessionName`, `slugFor`, `isLeadName`, `uniqueSessionName`) — **The
  name a launch mints is a contract, so `launch.js` is a port and not a rewrite.** `-ilc`,
  not `-lc`, and the bare word `claude`, never an exec of the resolved path — and the prefix
  in that name is configuration (`sessionPrefix`), read by five sites from one export.
  [launch#the-name-a-launch-mints-is-a-contract](docs/traps/launch.md#the-name-a-launch-mints-is-a-contract)
  · [one-spelling](docs/traps/one-spelling.md)
- `server/config.js` (`SESSION_PREFIX`) · `server/sessions.js` · `server/launch.js`
  (`slugFor`, `isLeadName`) — **What a non-matching prefix costs is narrower than
  "invisible", and it was measured** — the row is still in the roster; what is lost is the
  **name**, and everything keyed on it.
  [launch#what-a-non-matching-prefix-costs](docs/traps/launch.md#what-a-non-matching-prefix-costs)
- `web/trust-gate.js` · `server/tmux.js` (`parsePane`) ·
  `test/fixtures/pane-trust-gate{,-narrow}.txt` — **A new folder's first session lands on the
  trust gate, and it does not look like anything you would guard against — MEASURED, on
  Claude Code v2.1.247, at 220 columns and at 70.** It parses as an ordinary, fully populated
  permission box, so both obvious tests for a box the panel must not answer miss it.
  [launch#the-trust-gate](docs/traps/launch.md#the-trust-gate)
- `web/trust-gate.js` · `web/app.js` (`buildDecisionBar`, `updateComposerHint`) ·
  `web/m/cards.js` — **The wording changed in v2.1.247** — so don't write copy from memory,
  and note that the panel once shipped a full-width one-tap button on that screen.
  [launch#the-wording-changed-and-the-panel-shipped-a-button-on-it](docs/traps/launch.md#the-wording-changed-and-the-panel-shipped-a-button-on-it)
- `web/trust-gate.js` · `POST /api/sessions/:id/answer` · `test/trust-gate.test.js` —
  **Demonstrated, not asserted.** The card comes back with zero pressable nodes at 220
  columns and at 70, and the answer endpoint returns 409 with the pane still on the gate.
  [launch#demonstrated-not-asserted](docs/traps/launch.md#demonstrated-not-asserted)

### Sending and claiming

Nothing types into a pane without claiming it first, what an interrupt leaves behind, and
the two windows in which the pane's own answer and the roster's disagree. Evidence:
[`docs/traps/sending.md`](docs/traps/sending.md).

- `server/claim.js` (`PaneLock`) · `server/queue.js` (the flusher) ·
  `POST /api/sessions/:id/send` — **Nothing may be typed without claiming the pane first.**
  The roster is a poll behind, so the lock is taken *before* the pane is re-read and held for
  a beat after delivery; neither the endpoint nor the flusher types directly.
  [sending#claiming-the-pane](docs/traps/sending.md#claiming-the-pane)
- `server/status.js` (`StatusEngine#interrupted`) · `server/claim.js` (`PaneLock#claim`) ·
  `server/tmux.js` (`WORKING_RE`) · `mcp/foreman.js` (`SETTLE_MS`) — **An interrupt fires no
  hook, and the receipt it leaves behind lasts ten minutes — VERIFIED.** The endpoint drops
  that session's receipt rather than writing `idle`, and the two scrape errors either side of
  it are opposite — `working` read while idle after the endpoint answers, `idle` read while
  working at the top of a turn.
  [sending#an-interrupt-fires-no-hook](docs/traps/sending.md#an-interrupt-fires-no-hook)

### Files and images

What a session produced for a human to read — images, `Write`-created documents,
attachments: the ordinal that addresses one, the readers that must agree about it, what may
be cached, and the gallery that reads the whole file. Evidence:
[`docs/traps/files-and-images.md`](docs/traps/files-and-images.md).

- `server/normalize.js` (`imageBlocks`) · `GET /api/sessions/:id/image/:uuid/:index` — **An
  image in a transcript is addressed by an ordinal, and exactly one function may compute
  it.** The ordinal is assigned *before* anything is filtered, so a block the panel declines
  to serve still consumes its number.
  [files-and-images#image-ordinals](docs/traps/files-and-images.md#image-ordinals)
- `server/outputs.js` (`outputBlocks`, `readOutput`, `revealablePath`) — **The ordinal rule
  now has a second reader.** One index space per record: an image keeps the ordinal
  `imageBlocks` gave it, and a `Write` or `SendUserFile` entry is numbered from the
  pre-filter image count.
  [files-and-images#the-ordinal-rules-second-reader](docs/traps/files-and-images.md#the-ordinal-rules-second-reader)
  · [one-spelling](docs/traps/one-spelling.md)
- `server/index.js` (`GET /api/sessions/:id/output/:uuid/:index`) · `server/outputs.js` —
  **`Cache-Control: immutable` is right for a transcript record and wrong for a disk file.**
  A `sendfile` attachment is bytes on disk that can be overwritten between two opens, so it
  gets `no-store` plus an `ETag` instead.
  [files-and-images#the-caching-split](docs/traps/files-and-images.md#the-caching-split)
- `server/outputs.js` (`outputBlocks`) — **A `Write` of an existing path is `update`, not
  `create`.** Key on `toolUseResult.type`, never on whether `filePath` exists.
  [files-and-images#a-write-of-an-existing-path](docs/traps/files-and-images.md#a-write-of-an-existing-path)
- `web/styles.css` (`.files-grid`, `.files-list`) — **`.files-grid`/`.files-list` carry a
  `display` that beats `[hidden]`.** An author `display` rule outranks the `[hidden]` UA
  default regardless of specificity, so each container needs its own `[hidden]` rule.
  [files-and-images#the-files-views-two-containers](docs/traps/files-and-images.md#the-files-views-two-containers)
- `web/app.js` (`scanOutputs`) · `web/files-new.js` (`anyNewOutput`) — **The refresh must
  key on the `toolUseResult` record landing, not the tool call going out.** That record is
  not in the transcript until the result lands, so a refresh on the `Write` frame runs the
  scan a beat early.
  [files-and-images#when-the-files-view-refreshes](docs/traps/files-and-images.md#when-the-files-view-refreshes)
- `test/session-launch.test.js` · `server/session-launch.js` —
  **`test/session-launch.test.js` greps the serialised MCP config for `PAT` and trips on any
  worktree whose path contains "path."** `PAT` is a substring of `PATH`, and the
  serialisation carries the absolute path to `mcp/foreman.js`, worktree directory included.
  [files-and-images#the-pat-substring-in-a-worktree-path](docs/traps/files-and-images.md#the-pat-substring-in-a-worktree-path)
- `server/images.js` (`scanImages`, `readImage`) — **The gallery has to read the whole file,
  and nothing else here does.** The tailer, `loadEarlier` and `probe` each read a window, and
  every one of them would make a gallery that is a subset while looking complete.
  [files-and-images#the-gallery-reads-the-whole-file](docs/traps/files-and-images.md#the-gallery-reads-the-whole-file)
- `web/styles.css` (`.img-thumb img`) — **A thumbnail with `width: auto` is zero pixels wide
  until its bytes land.** Hence the `min-width` floor — and `loading="lazy"` never resolves
  in an automated window until something forces a frame.
  [files-and-images#thumbnails](docs/traps/files-and-images.md#thumbnails)

### Rail and groups

The rail is a flat list of siblings, and everything drawn on it — the indent, the tint, the
spine, the fold, the group colours, a team row's third line — is built on top of that one
fact; the front end's own cascade traps are here too. Evidence:
[`docs/traps/rail-and-groups.md`](docs/traps/rail-and-groups.md).

- `web/app.js` (`createPane`) — **`web/app.js` is one shared shell plus a `createPane`
  factory.** Everything per-session lives inside the factory, because split view means two of
  them at once; the roster, drafts and the thinking toggle stay shared outside it.
  [rail-and-groups#the-shared-shell-and-the-pane-factory](docs/traps/rail-and-groups.md#the-shared-shell-and-the-pane-factory)
- `web/app.js` (`renderRail`) · `web/styles.css` (`.shelf-label`, `.folder-label.in-group`,
  `.session-row.in-group`) · `web/tokens.css` (`--shelf`, `--row-open`) — **The rail is a flat
  list of siblings, and three things depend on it.** The indent is a class and not a
  descendant selector, the sticky offset is hand-measured against the group header, and an
  open group's tint is *tiled* from three full-width siblings.
  [rail-and-groups#a-flat-list-of-siblings](docs/traps/rail-and-groups.md#a-flat-list-of-siblings)
- `web/app.js` (`sessionRow`) · `server/sessions.js` (the roster's `team` field) — **A team
  row is three lines tall, and every other row must stay two.** The extra line rides in the
  meta line's grid columns, carries no margin that escapes the row, and is gated on
  `OPEN_STATES`.
  [rail-and-groups#a-team-row-is-three-lines-tall](docs/traps/rail-and-groups.md#a-team-row-is-three-lines-tall)
- `server/snapshot.js` (`restoreSessions`) · `server/launch.js` (`isLeadName`, `launchLead`)
  — **A role is launch flags, so anything that relaunches a session has to know the role.**
  No new field says "this was a lead" — the rail and the restore both ask `isLeadName` — and
  `launchLead` regenerates the brief, the MCP config and the settings.
  [rail-and-groups#a-role-is-launch-flags](docs/traps/rail-and-groups.md#a-role-is-launch-flags)
- `server/snapshot.js` (`benchEntries`, `drift`) — **A worker is not part of the bench, and
  saving one tells the same lie twice.** The role test is written as an allow-list — no team,
  or `lead` — and never as "not a worker", because kinds have already grown once.
  [rail-and-groups#a-worker-is-not-part-of-the-bench](docs/traps/rail-and-groups.md#a-worker-is-not-part-of-the-bench)
- `server/groups.js` (`retireWorktree`) · `server/index.js` (`task_dispatch`) · `web/app.js`
  (`renderRail`) — **A group is filed by the name the rail draws, and the dispatch filed a
  path.** Two spellings are on disk in front of a reader, so `retireWorktree` unfiles both —
  and only reaches for the basename when the path is genuinely under `worktrees/`.
  [rail-and-groups#how-a-group-is-filed](docs/traps/rail-and-groups.md#how-a-group-is-filed)
- `web/app.js` (`renderRail`) — **A heading with nothing under it isn't drawn, and "nothing"
  is measured after hoisting.** A group with nothing running anywhere has no heading, so
  there is nothing to rename or delete it from until one of its folders wakes up.
  [rail-and-groups#an-empty-heading-isnt-drawn](docs/traps/rail-and-groups.md#an-empty-heading-isnt-drawn)
- `web/rail-fold.js` · `web/app.js` (`renderRail`) — **A collapsed group hides one thing for
  ordinary rows and two for workers.** `working` is neither blocked nor unread, so it is the
  one state the inbox never hoists out — and a worker row no longer hoists until `stuck`
  fires.
  [rail-and-groups#what-a-collapsed-group-hides](docs/traps/rail-and-groups.md#what-a-collapsed-group-hides)
- `web/group-summary.js` (`groupSummary`) · `web/app.js` (`renderRail`) — **The dot used to
  cover only the ordinary-row half of that trade, and now covers both.** The summary reads the
  worker-inclusive set, so a collapsed team group now pulses when *only* a nested worker is
  busy; the header's own `· N` still counts top-level rows alone.
  [rail-and-groups#the-collapsed-groups-dot](docs/traps/rail-and-groups.md#the-collapsed-groups-dot)
- `web/tokens.css` (`--row-open`, `--group-N`) · `web/styles.css` (`.session-row.in-group`) —
  **The spine runs at half strength and the marker at full, and that split is measured, not
  sketched.** 50% is the point that maximises the *weaker* of the spine's contrast against its
  worst ground and the marker's step over the spine, rather than trading one for the other.
  [rail-and-groups#the-spine-and-the-marker](docs/traps/rail-and-groups.md#the-spine-and-the-marker)
- `web/app.js` (`sessionRow`) · `web/styles.css` (`.session`) — **A `▾` on the row's own path
  can't be a `<button>`, because the row it sits inside already is one — or was.** Every row
  is now `<div role="button" tabindex="0">` with its own `keydown` handler, and the invalid
  `aria-selected` is now `aria-current` on the open row alone.
  [rail-and-groups#the-row-is-not-a-button](docs/traps/rail-and-groups.md#the-row-is-not-a-button)
- `web/rail-fold.js` · `web/app.js` (`sessionRow`) — **The fold's title split is bound to the
  folder, never to the string's own last dash.** The split only fires when the title begins
  with `${s.project}-`, so a session started by another launcher never folds.
  [rail-and-groups#the-folds-title-split](docs/traps/rail-and-groups.md#the-folds-title-split)
- `web/tokens.css` (`--group-N`) · `web/group-hue.js` (`GROUP_COLOUR_COUNT`) ·
  `server/groups.js` (`assignColour`) — **The spine's ring is its own ten hues, measured to a
  different rule than the room's seven, and the slot order is itself a measurement.** The ten
  lines are ordered to maximise the gap between *consecutive* slots, since those are the pairs
  a real rail draws next to each other.
  [rail-and-groups#the-spines-ring-of-ten-hues](docs/traps/rail-and-groups.md#the-spines-ring-of-ten-hues)
  · [one-spelling](docs/traps/one-spelling.md)
- `server/groups.js` (`GroupStore`, `#load`, `#flush`) — **`GroupStore` drops a field it has
  never heard of, the same way `TaskStore` drops a whole record.** Back up `groups.json`
  before rolling back past #145.
  [rail-and-groups#groupstore-drops-an-unknown-field](docs/traps/rail-and-groups.md#groupstore-drops-an-unknown-field)
- `web/styles.css` (`.menu-item`) — **`.menu-item`'s `display: flex` beat `[hidden]`, the same
  way `.files-grid`'s did.** Scoped rather than a blanket `[hidden]` override, which would
  have to be proven safe against every other `hidden` toggle in the stylesheet.
  [rail-and-groups#the-menu-items-display-rule](docs/traps/rail-and-groups.md#the-menu-items-display-rule)
- `web/styles.css` (`.shelf-label.collapsed`, `.shelf-summary`) — **Turning `flex-wrap` on
  hands the container's own `gap` to the row gap as well, silently.** `.shelf-summary`'s
  `row-gap: 0` sits beside the wrap for exactly that reason.
  [rail-and-groups#turning-flex-wrap-on](docs/traps/rail-and-groups.md#turning-flex-wrap-on)
- `web/app.js` (`sessionRow`) · `web/styles.css` (`.dot.working`) — **An automated Chrome
  window answers no keyboard input and no CSS transition, and both bit this feature.**
  `document.visibilityState` reads `hidden`, so keyboard proof goes through dispatched events
  and anything transitioning has to be measured with `transition: none` forced.
  [rail-and-groups#an-automated-chrome-window](docs/traps/rail-and-groups.md#an-automated-chrome-window)
- `web/app.js` (its `/vendor/marked.js` import) · `web/index.html` — **A static copy of `web/`
  needs `/vendor/marked.js` in place, or the page 404s silently while still looking fine.**
  Copy `node_modules/marked/lib/marked.esm.js` into the static copy's own `vendor/marked.js`
  before benching anything.
  [rail-and-groups#a-static-copy-of-web](docs/traps/rail-and-groups.md#a-static-copy-of-web)
- `web/styles.css` (`.rail-actions`, `--rail`) · `web/index.html` (the rail head) — **A fifth
  button does not fit the rail head at the default width.** Anything adding a sixth control to
  that row is adding a third line, not a second.
  [rail-and-groups#a-fifth-button-in-the-rail-head](docs/traps/rail-and-groups.md#a-fifth-button-in-the-rail-head)
- `web/m/index.html` · `web/m/m.css` · `web/m/lead.css` (`.m-tab`, `.m-nav-*`) — **The phone
  loads five stylesheets into one `<head>`, so a class the shell shares with a screen is a
  class the screen wins.** The build split guarantees *files*, not names; a new class in
  `m.css` is grepped against the four sheets below it before it is written.
  [rail-and-groups#the-phones-five-stylesheets](docs/traps/rail-and-groups.md#the-phones-five-stylesheets)

### Team machinery

The machinery a team runs on and the rules a session is launched holding: how the forge is
detected, how a brief is assembled, how a permission path rule has to be spelled, what the
auto-mode classifier does to a tool nobody declared, what the task store does with a record
it cannot read, how the panel tells "merged" from "running here", and what the merge queue
in front of the composer may and may not depend on. Evidence:
[`docs/traps/team-machinery.md`](docs/traps/team-machinery.md).

- `server/forge.js` (`NOT_GITEA_HOSTS`) · `<teamDir>/mcp.json` · `server/briefs.js` — **A
  GitLab remote read as `Gitea`, because "not GitHub" is not the same as "Gitea" — found on the
  bench.** Detection is two independent questions, the four readings' words are fixed, and a
  credential-carrying MCP entry is refused before the brief is written.
  [team-machinery#a-gitlab-remote-read-as-gitea](docs/traps/team-machinery.md#a-gitlab-remote-read-as-gitea)
- `POST /api/team/tasks/:id/close` · `server/deployed.js` (`mergedInto`) — **"Done"
  force-deletes a branch, so the endpoint checks before it sweeps.** Ancestry is checked
  against both `origin/<base>` and local `<base>`, it fails closed, and the refusal names
  `abandon`.
  [team-machinery#done-force-deletes-a-branch](docs/traps/team-machinery.md#done-force-deletes-a-branch)
- `server/merge-check.js` · `server/lead-brief.js` (`selfMergeSection`) · `test/brief.test.js`
  — **A self-merge is decided on facts the panel cannot check, and every one of them has a trap
  in it — all measured by the planner against real PRs, none of them guessable.** The panel
  holds no credential and `merge-check.js` must never start; the other four are the lead's to
  read.
  [team-machinery#a-self-merge-is-decided-on-facts-the-panel-cannot-check](docs/traps/team-machinery.md#a-self-merge-is-decided-on-facts-the-panel-cannot-check)
- `server/base-branch.js` · `server/worktree.js` · `server/deployed.js` · `server/index.js` —
  **`main` was hardcoded in four places, and that made the team feature unusable on `master`.**
  Detected from `origin/HEAD`, falling back to the checkout's current branch and refusing an
  `agent/` one; the sandbox's `gamma` is on `master` deliberately, and is the test.
  [team-machinery#main-was-hardcoded-in-four-places](docs/traps/team-machinery.md#main-was-hardcoded-in-four-places)
- `server/team.js` (`plannerStance`, `pathRule`) — **Deny beats allow, so a narrow write
  grant has to be a subfolder, not a carve-out.** Put the writable thing *below* the protected
  thing, and never try to subtract.
  [team-machinery#deny-beats-allow](docs/traps/team-machinery.md#deny-beats-allow)
- `server/briefs.js` · `server/index.js` (`GET /api/briefs`) · `server/launch.js`
  (`launchLead`) · `web/app.js` (`briefHtml`) — **A brief is assembled in one place, and both
  halves of "one place" are load-bearing.** The forge is demoted *before* the brief is
  written, the route creates nothing — and marked eats a bare `<task>` placeholder unless the
  renderer's `html` hook escapes it.
  [team-machinery#a-brief-is-assembled-in-one-place](docs/traps/team-machinery.md#a-brief-is-assembled-in-one-place)
- `server/team.js` (`pathRule`, `leadSettings`, `plannerStance`) · `server/dispatch.js` — **A
  path permission rule must say `Edit`, and must double-slash.** A plain absolute path matches
  nothing, and `Write(path)` rules are no longer matched in file permission checks at all.
  [team-machinery#path-permission-rules](docs/traps/team-machinery.md#path-permission-rules)
- `server/team.js` (`leadSettings`) · `server/dispatch.js` (`writeWorkerSettings`) ·
  `server/session-launch.js` — **A tool call with no matching allow rule goes to the auto-mode
  classifier, and the classifier can itself fail.** Every role allows the bare whole-server
  form `mcp__foreman`; it is an allow rule and nothing more, and no panel guard is touched.
  [team-machinery#the-auto-mode-classifier](docs/traps/team-machinery.md#the-auto-mode-classifier)
- `server/tasks.js` (`TaskStore`, `TASK_STATES`, `TASK_KINDS`) — **A task state the store has
  never heard of is deleted, not rejected.** `#flush` rewrites the whole file from the Map two
  seconds later, so back up `~/.foreman/tasks.json` before any rollback of a commit that added
  a state.
  [team-machinery#an-unknown-task-state](docs/traps/team-machinery.md#an-unknown-task-state)
- `server/deployed.js` (`mergedInto`, `branchFacts`) — **"Merged" and "live here" are
  different facts, and the boot sha is how you tell.** The boot sha is read at *construction*,
  the evidence is recorded while the branch still exists, and "no tip recorded" draws no pill
  at all.
  [team-machinery#merged-versus-live-here](docs/traps/team-machinery.md#merged-versus-live-here)
- `web/app.js` (`composerSig`, `renderMergeQueue`, `renderHead`) — **`composerSig` does not
  know about tasks, and a merge block built inside `buildComposer` would freeze on stale
  data.** Task state must never join that signature — it would tear the whole textarea down
  under a reader's cursor every time a worker reported done.
  [team-machinery#composersig-does-not-know-about-tasks](docs/traps/team-machinery.md#composersig-does-not-know-about-tasks)
- `web/app.js` (`renderMergeQueue`) · `web/styles.css` (`.composer-above`) — **The interrupt
  row's design is that it never moves, and the merge block is the first thing ever placed above
  it.** The block is appended and removed rather than hidden, so `.composer-above:empty` still
  fires — checked by SHA-256 on the cropped region, not by eye.
  [team-machinery#the-interrupt-row-never-moves](docs/traps/team-machinery.md#the-interrupt-row-never-moves)
- `server/merge-queue.js` (`mergePaths`, `shaOf`) — **Cache a three-dot diff on both shas, not
  the branch tip alone.** `base...branch` changes its answer when *main* moves even though the
  branch tip did not, and main moves at every merge — this feature's whole subject.
  [team-machinery#cache-a-three-dot-diff-on-both-shas](docs/traps/team-machinery.md#cache-a-three-dot-diff-on-both-shas)
- `web/app.js` (`mergeSig`) — **A signature can be joined with what reads as an empty string
  and is not.** Three literal control bytes inside the quotes are valid JavaScript, throw
  nothing, and look like an empty-string join in every editor.
  [team-machinery#a-signature-joined-with-an-invisible-character](docs/traps/team-machinery.md#a-signature-joined-with-an-invisible-character)

### Rooms

The room panel's scroll and repaint rules, what a line's colour is keyed on, the five-line
clamp, how a member is resolved, and what `@name` does and does not change. Evidence:
[`docs/traps/rooms.md`](docs/traps/rooms.md).

- `web/app.js` (`renderRoom`, `pinRoom`, `pinRooms`) — **The room's box moves under its own
  scroll, and nothing says so.** Following is an intention flipped only by a real scroll, and
  the two things that resize that box repin it — a `ResizeObserver` never fired.
  [rooms#the-rooms-box-moves-under-its-own-scroll](docs/traps/rooms.md#the-rooms-box-moves-under-its-own-scroll)
- `web/app.js` (`roomEntryNode`) · `server/index.js` (the dispatch post) — **A room line's
  colour is keyed on what the poster said it is, never on how it reads.** The key is `event`;
  `about` looks like it and is the task id every task-scoped system line carries.
  [rooms#a-room-lines-colour](docs/traps/rooms.md#a-room-lines-colour)
- `web/app.js` (`renderRoom`) — **A repaint that measures anything stops holding the reader's
  place.** `scrollTop` is held across the whole paint and read *before* `replaceChildren`, and
  nothing is drawn until it is known to be needed.
  [rooms#a-repaint-that-measures-anything](docs/traps/rooms.md#a-repaint-that-measures-anything)
- `web/styles.css` (`.room-clamp`) — **A clamp that can't be measured can't be trusted.** The
  standard `line-clamp` is deliberately not set beside `-webkit-line-clamp`; add it the day it
  can be measured, not the day it parses.
  [rooms#a-clamp-that-cant-be-measured](docs/traps/rooms.md#a-clamp-that-cant-be-measured)
- `web/app.js` (`renderRoom`, `renderTasks`, `renderMain`) — **A list painted at build time
  paints nothing, and a quiet feature hides it.** Paint after the container is in the document;
  a busy room self-heals in seconds while a quiet one stays blank for hours.
  [rooms#a-list-painted-at-build-time](docs/traps/rooms.md#a-list-painted-at-build-time)
- `server/rooms-line.js` (`resolveMember`) · `web/rooms-pane.js` (`memberRow`) ·
  `test/rooms-pane.test.js` — **A room member is resolved `tmuxSession` first, and the
  recorded decision said the opposite.** A stored pane id can be live and belong to somebody
  else, which is a post typed into a stranger.
  [rooms#a-room-member-is-resolved-tmuxsession-first](docs/traps/rooms.md#a-room-member-is-resolved-tmuxsession-first)
  · [one-spelling](docs/traps/one-spelling.md)
- `server/index.js` (`sendOrQueue`, `roomTurn`) · `server/rooms.js` (`rateFault`) ·
  `web/rooms-pane.js` — **`handed` is not `delivered`, and the window between checking and
  writing it down had to be closed by hand.** Every surface says `handed`, and the order is
  forced — check, fan out, append — so the posts to one room are serialised.
  [rooms#handed-is-not-delivered](docs/traps/rooms.md#handed-is-not-delivered)
- `web/app.js` (`groupEntryNode`, `sharedEntryNode`, `addressedNames`) — **`to` means two
  different things one pane apart, and both are built by near-identical functions in one
  file.** Anchor on the node's own class prefix, never on the shape the two share.
  [rooms#to-means-two-different-things-one-pane-apart](docs/traps/rooms.md#to-means-two-different-things-one-pane-apart)
- `server/rooms-line.js` (`mentionsIn`, `memberLabel`) · `POST /api/rooms/:id/post` ·
  `web/app.js` (the composer's `@` menu) — **`@name` in a room is a signal, and the ruling
  that makes it one is easy to optimise away.** The fan-out has no branch on `to` at all: a
  mention changes what each recipient is told, never who gets a copy.
  [rooms#name-in-a-room-is-a-signal](docs/traps/rooms.md#name-in-a-room-is-a-signal)

### launchd

Facts about this machine rather than about a file here, which is why they are filed under
the tool's name and not a path — the plist, the label's three copies, the job's `PATH`, the
log rotation, the state dir's four rungs, Homebrew's own rename, and the tmux server every
session on this Mac shares. Read them before changing the plist, the label or the log paths.
Evidence:
[`docs/traps/platform-launchd.md`](docs/traps/platform-launchd.md).

- **launchd** (`launchctl kickstart`/`bootout`/`bootstrap`, `server/install-agent.js`'s
  `install`, `package.json`'s `restart-panel`) — **`launchctl kickstart -k` does not re-read
  the plist — VERIFIED.** A change to the job itself needs `npm run install-agent` again; a
  reinstall that only kickstarts is a reinstall that did nothing.
  [platform-launchd#launchctl-kickstart--k-does-not-re-read-the-plist](docs/traps/platform-launchd.md#launchctl-kickstart--k-does-not-re-read-the-plist)
- **launchd** (`jobPath` in `server/install-agent.js`, `tmuxPath` in `server/tmux.js`,
  `runSetup` in `server/worktree.js`) — **launchd's `PATH` is `/usr/bin:/bin:/usr/sbin:/sbin`
  and nothing else — VERIFIED.** Bare `git` works and bare `node` and `tmux` do not, and a
  worktree's prepare command fails *quietly* when they don't resolve.
  [platform-launchd#launchds-path](docs/traps/platform-launchd.md#launchds-path)
- **launchd** (`ProgramArguments`, `nodeBinary` in `server/install-agent.js`) — **A bare
  program name in `ProgramArguments` fails with exit 78 `EX_CONFIG` and writes nothing —
  VERIFIED.** From outside the job never existed, so the installer captures an absolute node
  path — and prefers the stable Homebrew spelling over the Cellar path an upgrade deletes.
  [platform-launchd#a-bare-program-name-in-programarguments](docs/traps/platform-launchd.md#a-bare-program-name-in-programarguments)
- **launchd** (`bootout`, `bootstrap`, `kickstart -k`) — **Stopping the job does not kill the
  tmux server — VERIFIED, and worth it as a reassurance.** The tmux server daemonizes to
  `ppid 1` and leaves the job's process tree entirely.
  [platform-launchd#stopping-the-job-does-not-kill-the-tmux-server](docs/traps/platform-launchd.md#stopping-the-job-does-not-kill-the-tmux-server)
- `server/logs.js` (`DEFAULT_AGENT_LABEL`) · `package.json` (`restart-panel`, `stop-panel`) ·
  `scripts/backup-state.sh` · `test/logs.test.js` — **The launchd label has three copies and
  two of them are not JavaScript, so only a test holds them together.** Rename one and miss
  the others and `npm run restart-panel` kickstarts a job that does not exist, silently.
  [platform-launchd#the-launchd-label-has-three-copies](docs/traps/platform-launchd.md#the-launchd-label-has-three-copies)
  · [one-spelling](docs/traps/one-spelling.md)
- `server/install-agent.js` (`legacyJobs`, `install`) — **An orphaned plist runs the
  *current* code under an older label, and the detector for it must be by shape rather than
  by name.**
  No legacy label is named in the code; the rung that matters most is the refusal, and it is
  `bootout`, never a signal.
  [platform-launchd#an-orphaned-plist-under-an-older-label](docs/traps/platform-launchd.md#an-orphaned-plist-under-an-older-label)
- `server/homebrew.js` (`BREW_LAUNCHD_LABELS`, `existingBrewPlists`) ·
  `scripts/backup-state.sh` — **Homebrew renamed its own launchd label prefix, so the brew
  plist has two names and the panel carries both.** An upgrade can write the new plist and
  leave the old one behind, so the answer is none, one, or both.
  [platform-launchd#homebrew-renamed-its-own-launchd-label-prefix](docs/traps/platform-launchd.md#homebrew-renamed-its-own-launchd-label-prefix)
- `server/config.js` (`STATE_DIR`, `resolveStateDir`, `LEGACY_STATE_DIR_NAME`) ·
  `scripts/backup-state.sh` · `test/state-dir.test.js` — **The state dir is resolved on four
  rungs, and the third is the only place the old spelling survives in this code.** It is not a
  migration and must never become one — and a test that sets `FOREMAN_STATE_DIR` above its
  imports is still pointed at the real one, because ESM hoists.
  [platform-launchd#the-state-dir-is-resolved-on-four-rungs](docs/traps/platform-launchd.md#the-state-dir-is-resolved-on-four-rungs)
- `server/install-agent.js` · `server/install-hook.js` · `server/install-statusline.js` —
  **Plist backups go to the state dir, not beside the original.** A second file in
  `~/Library/LaunchAgents` carrying the live `Label` is a duplicate job waiting for the next
  login; the settings installers go the other way, deliberately.
  [platform-launchd#plist-backups-go-to-the-state-dir](docs/traps/platform-launchd.md#plist-backups-go-to-the-state-dir)
- **launchd** (`StandardOutPath`/`StandardErrorPath`, `rotateLogs` in `server/logs.js`, the
  boot block in `server/index.js`) — **Renaming a launchd log rotates nothing, and looks
  exactly like it worked — VERIFIED.** Copy aside and truncate in place, copy first, one
  `.1`, and boot-only — after the single-instance probe and before the panel prints anything.
  [platform-launchd#renaming-a-launchd-log-rotates-nothing](docs/traps/platform-launchd.md#renaming-a-launchd-log-rotates-nothing)
- `server/install-agent.js` (`jobEnvironment`) · `server/logs.js` (`AGENT_LABEL`) — **A
  scratch `FOREMAN_AGENT_LABEL` has to reach the job, not just the plist.** The running panel
  reads it from its own environment to decide which two files it truncates.
  [platform-launchd#a-scratch-foremanagentlabel-has-to-reach-the-job](docs/traps/platform-launchd.md#a-scratch-foremanagentlabel-has-to-reach-the-job)
- **tmux** (`$TMUX`, `TMUX_TMPDIR`, a scratch socket) — **`$TMUX` is set inside a worker, and
  it defeats `TMUX_TMPDIR`.** A scratch tmux server is `env -u TMUX` *plus* `TMUX_TMPDIR`,
  never `TMUX_TMPDIR` alone, and the check afterwards is that the real server still holds what
  it held before.
  [platform-launchd#a-scratch-tmux-server-unsets-tmux](docs/traps/platform-launchd.md#a-scratch-tmux-server-unsets-tmux)

### Git

What git actually prints as against what a reader of it expects: the porcelain's collapse of an
untracked directory, the two quotings, the `-z` rename encoding and the rename detection three
separate readers depend on. Evidence: [`docs/traps/git.md`](docs/traps/git.md).

- `server/conflicts.js` · `test/conflicts.test.js` — **`git status --porcelain` collapses an
  untracked directory to `dir/`.** `-uall` is the fix and it is not optional, because a
  mid-task worker's changes are mostly uncommitted — which makes that the half that matters.
  [git#porcelain-collapses-an-untracked-directory](docs/traps/git.md#porcelain-collapses-an-untracked-directory)
- `server/conflicts.js` (`parsePorcelainZ`) · `server/merge-queue.js` · `server/deployed.js` ·
  `test/conflicts.test.js` — **`git diff` and `git status` quote paths differently, and the fix
  has its own trap inside it.** Both sides read `-z`, which silently changes the porcelain
  rename encoding to `XY new\0old\0`; `--no-renames` on all three diffs is the other half.
  [git#git-diff-and-git-status-quote-paths-differently](docs/traps/git.md#git-diff-and-git-status-quote-paths-differently)

### Browser and notifications

What a browser and a phone do with what the panel hands them: the two manifests, the three icon
geometries, the notification permission and the secure context it needs, and the one control
the page does not paint at all. Evidence: [`docs/traps/browser.md`](docs/traps/browser.md).

- `web/manifest.webmanifest` · `web/m/manifest.webmanifest` · `scripts/make-icons.mjs` ·
  `test/icons.test.js` — **Two manifests on one origin with the same `id` are one app, and the
  second one installed replaces the first.** Omitted, `id` defaults to `start_url`, which reads
  like it would settle it and does not — and the Apple touch icons are a third geometry again.
  [browser#two-manifests-on-one-origin](docs/traps/browser.md#two-manifests-on-one-origin)
- `scripts/make-icons.mjs` · `server/index.js` (`express.static`) — **A `.webmanifest` already
  serves as `application/manifest+json`, and `sips` cannot read an SVG.** No server change and
  no restart; the icons are rasterized in `node:zlib` rather than by Quick Look or a browser.
  [browser#webmanifest-and-sips](docs/traps/browser.md#webmanifest-and-sips)
- `web/app.js` (`paintNotify`, `notifyArmed`) — **A stored preference is not a granted
  permission, and printing the first over the second reads as a bug.** Every state a two-source
  control can be in wants a rendering, and the contradictory one is the state nobody writes a
  test for.
  [browser#a-stored-preference-is-not-a-granted-permission](docs/traps/browser.md#a-stored-preference-is-not-a-granted-permission)
- `web/notify.js` · `web/app.js` (the settings section) — **`Notification` needs a secure
  context, and Chrome will not even *grant* it otherwise.** `http://127.0.0.1` is secure by
  specification and `http://<a LAN address>` is not, so the control cannot work from the phone
  — which follows from the exposure ruling rather than being a gap in it.
  [browser#notification-needs-a-secure-context](docs/traps/browser.md#notification-needs-a-secure-context)
- `web/notify.js` (`needsKind`) · `server/sessions.js` (`#diff`) · `test/notify.test.js` —
  **The needs-you notification is derived from the roster, and must not be derived from
  `needsYou`.** That field also counts "it replied and you haven't looked", which would fire on
  every finished turn; `needsKind` asks about the trust gate first.
  [browser#the-needs-you-notification](docs/traps/browser.md#the-needs-you-notification)
- `web/styles.css` (`.field-check`, `.team-toggle-row`) · `web/rooms-create.js` — **A stock
  checkbox is drawn by the browser from the *browser's* colour scheme, not the page's
  `data-theme` — so an unticked box read as ticked.** The UA paints that control and
  `data-theme` is not a signal it reads; `.field-check` is still exposed.
  [browser#a-stock-checkbox-is-painted-by-the-browser](docs/traps/browser.md#a-stock-checkbox-is-painted-by-the-browser)

### Rate limits and the status line

What the status line does on a quiet bench, what an idle sender re-posts, what the payload's
own fields mean, and what is deliberately never kept out of it. Evidence:
[`docs/traps/rate-limits.md`](docs/traps/rate-limits.md).

- `server/install-statusline.js` · `server/rate-limits.js` — **The status line is event-driven,
  and the wrapper's whole reason to touch `refreshInterval` is that this makes the gauges go
  stale for hours on a quiet bench.** The key is set only when it is absent — and that same
  interval is what broke a naive latest-payload-wins merge, live, on one account.
  [rate-limits#the-status-line-is-event-driven](docs/traps/rate-limits.md#the-status-line-is-event-driven)
- `server/rate-limits.js` — **`resets_at` is Unix seconds, not milliseconds, and
  `used_percentage` isn't the payload's only name for itself.** A wrong answer that renders
  without complaint rather than throwing, so every reader multiplies by 1000 first.
  [rate-limits#unix-seconds-not-milliseconds](docs/traps/rate-limits.md#unix-seconds-not-milliseconds)
- `server/rate-limits.js` (`ingest`) — **The payload carries a dollar figure, and none of it is
  ever kept.** Enforced by what the store's `ingest` reads out of the body, not by a filter on
  the route — the endpoint hands the whole payload through unfiltered on purpose.
  [rate-limits#the-dollar-figure-is-never-kept](docs/traps/rate-limits.md#the-dollar-figure-is-never-kept)

### MCP and naming

The tool names a session is handed and the environment the MCP child is handed with them: why
group rooms are spelled `group_*`, what a stdio child inherits, and what `--strict-mcp-config`
would cost an ordinary session. Evidence:
[`docs/traps/mcp-and-naming.md`](docs/traps/mcp-and-naming.md).

- `mcp/foreman.js` (`room_*` vs `group_*`) · `server/rooms.js` (`GroupRoomStore`) ·
  `web/app.js` (the socket frames) — **`room_post` and `room_read` were already taken, and so
  were `room-append` and `markRoomRead` — so group rooms are `group_*` in every spelling they
  have.** What is refused is a *sibling* name, not the word "room".
  [mcp-and-naming#group-rooms-and-the-sibling-name](docs/traps/mcp-and-naming.md#group-rooms-and-the-sibling-name)
  · [one-spelling](docs/traps/one-spelling.md)
- `mcp/foreman.js` (`TMUX_PANE`) · `server/session-launch.js` (`standaloneArgs`) ·
  `test/session-launch.test.js` — **An MCP stdio child inherits `TMUX_PANE`, which is why one
  static config serves every session — and why `--strict-mcp-config` must never be copied onto
  it.** One brief and one config file for the whole machine; the strict flag on the standalone
  path would silently strip every connector the user has registered.
  [mcp-and-naming#an-mcp-stdio-child-inherits-the-pane-id](docs/traps/mcp-and-naming.md#an-mcp-stdio-child-inherits-the-pane-id)

### One spelling

The one lesson here with no home of its own, because no single file owns it: it was learned
eight times, in eight subsystems, and each story stays where it was learned. This file states
the shared conclusion and links all eight. Evidence:
[`docs/traps/one-spelling.md`](docs/traps/one-spelling.md).

- `server/launch.js` (`sessionName`, `slugFor`, `isLeadName`, `uniqueSessionName`) ·
  `server/logs.js` (`DEFAULT_AGENT_LABEL`, also spelled in `package.json` and
  `scripts/backup-state.sh`) · `server/normalize.js` (`imageBlocks`) with
  `server/outputs.js` (`outputBlocks`) · `server/rooms-line.js` (`resolveMember`) with
  `web/rooms-pane.js` (`memberRow`) · `mcp/foreman.js` (`room_*` vs `group_*`) ·
  `web/prefs.js` · `web/group-hue.js` (`GROUP_COLOUR_COUNT`) with `web/tokens.css`
  (`--group-N`) · `server/room-header.js` — **Two spellings of one contract agree the day
  they are written and diverge silently afterwards.** One spelling, imported, wherever an
  import is possible; a test where it genuinely is not; and a *sibling* name one letter
  apart refused outright, because nothing can hold that together.
  [one-spelling](docs/traps/one-spelling.md)

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

**The Files view** (`server/outputs.js`, the `files/links` header button) widens the old image
gallery into everything a session produced for a human to read — images, `Write`-created
documents, `SendUserFile` attachments, and the links it fetched, cited or created — plus a
path link in the conversation, bounded to that same set. `docs/panel.md`'s "Files a session
produced" has the shape; the per-turn image strip and its byte route are untouched.

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

Each group also wears a colour, assigned automatically and changeable from the `⋯` menu's
swatch row, drawn as a spine down its header, its folder headings and its rows, with the
selected row inside taking that colour at full strength; a folder holding exactly one
session folds into that row's own name instead of printing a heading; and the header's `+`
files a folder into the group, the `▾`'s own move in reverse.

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

**The room reads as three tiers of loudness, not three shapes any more.** Tier 1
(`system`, `conflict`) is a git-log row: a 2px gutter carries the colour a frame used to
carry, keyed on `event` — green for a dispatch, amber for a conflict, dashed grey for a
task merely `pending`, accent for a lead's own self-merge, plain `--ink-muted` for
everything else, the four server-stamped events (`closed`, `pr`, `started`, `model`)
included. Tier 2 (`chat`, `status`, `answer`, legacy `link`) is the panel's own rooms
bubble, full column width, one `--peer-N` hue per speaker on the pill and nowhere else; the
lead's line keeps the accent edge and 7% tint instead of a hue, and a `lead → [worker]`
line draws the recipient as that worker's own pill, from the same `roomPill` function both
ends of the line go through. What gives the bubbles any traffic at all is that a worker's
report is posted **as the worker** — `from: <task id>`, `kind: 'status'` — rather than as a
`system` line from `panel` about it, which is how a multi-paragraph summary used to arrive
dressed as one-line machinery. `report: 'review'` on the entry carries the fact that it
*is* the done report, shown as a `review`/`plan` tag in the author line; the lead reads it
out of `room_read`. Tier 3 (`escalation`, `alert`) is the one framed, tinted, red card
left — the two share it and are told apart only by the author line and tag, a worker's name
against `panel`. A self-merge's own evidence list folds behind `N checks ›`, closed by
default. Everything else in the room is machinery and stays `system`.

**Row and header controls**: `⧉` duplicates a session into the same folder, the bin `/exit`s
one behind a confirmation, a folder icon opens the project in Finder, and `recent` drops the
filing for one recency-ordered list.

**The briefs modal** (`briefs` in the rail head, `server/briefs.js`, `GET /api/briefs`,
`web/briefs-tabs.js`) shows all four briefs a session here is launched reading — lead,
worker, planner and the machine-wide standalone one — for a chosen team repo, built by the
functions the launch itself calls. Read-only, a GET and nothing beside it, and it creates
nothing on disk: `ensureTeam` is deliberately absent, so opening it on a repo with no team
renders from `teamDefaults` rather than seeding one. It shows the *next* generation and says
so; the refresh control it does not have is the known gap above.

**Rooms** (`server/rooms.js` the store, `server/rooms-line.js` the resolution and the
envelope, the `group rooms` block in `server/index.js` the only part that touches a pane,
`web/rooms-band.js` / `rooms-create.js` / `rooms-pane.js` the three pure modules the browser
side is built out of) are named places where up to **8** peer sessions coordinate: a member
posts once, the panel appends one entry and types a copy into every *other* member's terminal
through `sendOrQueue` → `PaneLock` → `assertNotBlocked`, the same guarded path as everything
else it types. Six things hold it together and none of them bends. **Only a human makes a
room or changes its membership** — there is no create, join or add tool, deliberately, because
membership is who may type into whose terminal and that is never a session's call to make.
**Workers are never in one**, by an
allow-list on role (`participant` in `observe.js`, an allow-list because kinds have already
grown once here) and again by the panel refusing them at the endpoint. **Two prefixes, never
a third**: `> ` is *not the maintainer* — any other **session**, which may be nobody's lead —
and `| ` is the maintainer's own word, which authorizes. **The word
is `handed`**, never *delivered* and never *read*. **State is under `STATE_DIR`**, resolved:
`rooms.json` rewritten wholesale from memory (so unknown keys are carried through, or a
rollback past this feature deletes rooms — `TaskStore`'s erasure) and `rooms/<id>.jsonl`
append-only, never rewritten. And **nothing about rooms joins `composerSig`**, because a
message landing in a room would otherwise take the textarea out from under whoever is typing.
Archiving closes a room to posts and deletes nothing; the rail band folds archived ones away
and its head is deliberately outside the `has-rooms` gate, since `+ room` is the only way to
make the first one. **`@name` addresses a post and narrows nothing** — `mentionsIn` is the one
parse, both writers go through it, and the two envelopes say something different to a named
member than to everybody else; the trap above is what stops that becoming a delivery. **A
delivery is one line and a body** (`server/room-header.js`): the header names who spoke, the
room by name *and* id, who it was addressed to relative to this reader, and which of the two
speakers it is — and nothing else, because the roster is `group_list`'s answer and the rule is
the standing brief's, and repeating either per post cost a reader a paragraph a turn. In the
recipient's own transcript it draws as a folded chip, the notice chip's register; how it is
recognised there is the trap above, and it is sharper than it looks.

**The cost, which lands on every session and not only on members**: an ordinary session the
panel launches now carries a short standing brief about rooms and one extra MCP server
(`server/session-launch.js`, two static files under `STATE_DIR`, four launch sites). It is
small, it names no repo and no person, and it is unavoidable — a session cannot be told about
rooms by a message, because it forgets — but it is a change to every session opened from the
panel, not only the ones put in a room.

They sit beside two things they are not. The **team room** is one lead and its workers,
vertical, untouched by any of this. **Peer messages** (`server/shared-room.js` plus the
`observe.js` collector) is an observation log of native peer traffic with no writer and no
reader on the session side — a room is where sessions write *into*, peer messages is where the
panel *reads from*. `docs/panel.md` documents both.

**And peer messages is `shared` in every identifier it has, on purpose.** The panel's label,
the pane header and the docs read `peer messages`; `SharedRoomStore`, `shared-room.jsonl`,
`GET /api/shared-room`, the `subscribe-shared` / `shared` / `shared-append` / `markSharedRead`
frames, `.shared-*` and `rail-shared` all still say `shared`. That is the 2026-09-05 rename
read the safe way rather than a rename somebody abandoned: renaming a store class and three
socket frames for a label is a large diff whose failure mode is **silent** — a frame the
client no longer switches on — and `peer_*` beside `peers.js` would be exactly the sibling
name the `room_*` / `group_*` rule above refuses. `server/shared-room.js`'s header says the
same thing from the store's end; do not "fix" the mismatch without deciding to.

**Links are retired, and a room is what replaced them.** The panel used to run *links*: a
private line between the team **leads** of two projects, opened from a project's own aside,
drawn as a band at the foot of the rail, with `link_open` / `link_send` / `link_list` /
`link_read` / `link_close` on the lead's tool surface and a copy of every message kept in both
teams' rooms. All of it is gone — the store, the routes, the roster field, the rail band, the
tools and the brief section. Retired on **2026-09-05**, the date every comment in the tree
carries; the last of the code went on 2026-09-06 (PRs #85, #86, #88, #89, #90). A room does the
same job with a shared record, a name and a log you can scroll, and **a room with one member is
legal** (`GroupRoomStore` has a maximum of eight and no minimum): that one-member room is the
real replacement both for a link and for the `@` composer peer messages used to carry.

Three things outlived the deletion on purpose, and none of them is a leftover to tidy. The
`> ` / `| ` envelope was **lifted into `server/envelope.js` before** the module went, precisely
so rooms would never import from something scheduled for deletion — its header is the story of
that lift, and `test/envelope.test.js` exists so the refusals stay proven from a file that
still exists. `LINK_MARK` moved into `normalize.js` with its anchored `[link] ` match, because
the `[link] ` records already sitting in transcripts on this Mac must still read as what they
were. And `roomLinkPill` with the two `kind === 'link'` branches beside it in `web/app.js`
stays, because `room.jsonl` is append-only and holds two dozen link entries across four team
rooms that a reader still has to be able to see. `~/.foreman/links.json` is left exactly where
it is — unread, unmigrated, undeleted: it is the only record of what was ever linked, deleting
a maintainer's state file is not a code change's call, and leaving it makes a revert clean.

**The team** has a `pending` task state — a task recorded with its brief and nothing else,
the middle rung between an issue on a tracker and a dispatched worker: added via `task_add`,
promoted only on a second, explicit yes via `task_start`. Every task row opens a read-only
brief modal on click, showing a planner's plan alongside its brief where one exists and
rendering both as markdown rather than raw text. The lead's own `room_read` returns a tail
rather than the whole log, and `team_status` the same for closed tasks — open and pending
ones in full, `done`/`failed`/`abandoned` as counts plus a 10-record recent list — so a
long-running lead's context doesn't fill up on its own history either way.

**A known gap: there is no "refresh brief" control.** A brief change needs a panel restart
*and* a lead relaunch to take effect. `plannerBrief` reaches a planner at its next dispatch,
so a restart is enough there; the lead's own brief only ever reaches the *next* lead. **The
standalone brief is in the same gap** — `server/session-launch.js` rewrites
`session-brief.md` and `session-mcp.json` at boot and before every launch, so a change to
either needs the restart *and* a relaunch of each session, and a session already running has
neither the rooms instruction nor the `foreman` tool server. `relaunch all…` is the control
that exists; a refresh is the one that does not. The **briefs modal** (`briefs` in the rail
head, `GET /api/briefs` → `server/briefs.js`) is where you read one, and it is read-only for
exactly this reason: it shows the brief the *next* lead, worker, planner or standalone
session would be launched with, which is not necessarily the one a running session is on,
and its own note says so. A refresh button there would reach nothing that is running.

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
  pattern matches the one the user is using; kill by port, with `-sTCP:LISTEN` on it (see
  the bullet below — without that flag the same command kills the browser). Give the second
  one `FOREMAN_STATE_DIR` too, and that is not just tidiness. Two servers must not
  run the queue at once (they share
  `~/.foreman/queue.json` and would both flush the same message), a test run would
  otherwise be saving snapshots over the bench you actually rely on, and **a second
  server boots its own worktree GC**: pointed at the real state dir it will sweep real
  worktrees and branches belonging to real failed tasks, post the receipt into a real
  team's room, and be entirely within its rights. Scratch state dir, scratch port, every
  time.
- **`kill $(lsof -tiTCP:<port>)` kills the browser too, and this line used to recommend it.**
  `lsof -tiTCP:<port>` matches every socket on that port, **ESTABLISHED client connections
  included** — so the pid list holds whatever browser has the panel open, and the `kill`
  sends it SIGTERM along with the server. It took Chrome's tab group down twice on one
  bench, on a scratch port; against 48770 it would take the panel the user is reading with
  it, mid-session, and nothing about the command says so. The safe form is
  `lsof -tiTCP:<port> -sTCP:LISTEN`, which is the listening socket and nothing else.
- **Prefer showing nothing over showing something wrong.** A blank transcript that
  explains itself beats a plausible one belonging to another session.
- Claude Code re-reads hook config **while running** — measured, not assumed: a session
  whose `claude` started at 01:07 was posting to a hook registered at 01:38, and one
  running since a week earlier began reporting the moment it was next spoken to. An
  earlier note here said the opposite (read once at launch, restart to pick up a change)
  and it was wrong. Registering a hook and then waiting is enough.
- `/clear` mints a new session id and a new transcript. The panel follows the rotation.
