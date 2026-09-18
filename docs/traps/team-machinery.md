# Team machinery

The evidence behind the **Team machinery** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — how the forge is detected, how a brief is assembled, how a permission path
rule has to be spelled, what the auto-mode classifier does to a tool nobody declared, what
the task store does with a record it cannot read, how the panel tells "merged" from
"running here", and what the merge queue in front of the composer may and may not depend
on. Each section below is one trap, opening with the bold sentence its index line quotes.

## A GitLab remote read as Gitea

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

## "Done" force-deletes a branch

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

## A self-merge is decided on facts the panel cannot check

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

## `main` was hardcoded in four places

**`main` was hardcoded in four places, and that made the team feature unusable on `master`.**
`worktree.js`, `deployed.js` and two sites in `index.js` all defaulted to `main`/`origin/main`,
so a repo on `master` or `trunk` failed its first dispatch with `No such base branch:
origin/main` and no explanation. `base-branch.js` detects it from `origin/HEAD`, falling back
to the checkout's current branch (refusing an `agent/` one, which inside a worktree would
branch every future task off another task's work), and it is shown read-only in the team panel
beside the forge. The sandbox's `gamma` is on `master` deliberately — it is the test.

## Deny beats allow

**Deny beats allow, so a narrow write grant has to be a subfolder, not a carve-out.** The
planner may write its plan and must not touch `decisions.md` — the human record of every
ruling — which lives in the same team dir. There is no "all of this except those
files": a deny on `<teamDir>/**` would swallow the one folder the planner exists to write
to, and allow-plus-deny on overlapping paths resolves to denied. Hence `plans/` as a
subfolder and an allow that names only it (`plannerStance`). Any future "this session may
write exactly here" grant has the same shape — put the writable thing *below* the protected
thing, and never try to subtract.

## A brief is assembled in one place

**A brief is assembled in one place, and both halves of "one place" are load-bearing.**
`server/briefs.js` is what `launchLead` calls and what `GET /api/briefs` calls, because the
modal's claim is "this is what the next lead will read" and a second copy of the assembly
would be a claim that decays: the two agree the day they are written and disagree at the
first change to either, silently, since nothing on screen can say a brief is a generation
behind. `test/briefs.test.js` pins byte-identical output and scans `index.js` for a direct
`leadBrief(` call. Two things inside it are not obvious. The **forge must be demoted before
the brief is written** — a credential-carrying MCP entry is refused and the forge drops to
`push only` — so a route that resolved the forge and skipped the demotion would show a lead
being handed tools it will not have; that is the one branch that had to move into the shared
function rather than stay at the launch. And **the route creates nothing**: `ensureTeam` is
deliberately not imported there, `readTeam` → `teamDefaults` answers for a repo with no team,
and every path is computed. Opening a modal must not seed somebody a team directory.

**…and marked eats the placeholders those briefs are full of.** `agent/<task>`, `gh pr merge
<N>`, `task <id>` — not all of them sit inside backticks, and marked's default reads a bare
`<task>` as raw HTML, so the browser makes an unknown element of it and the word simply
**disappears**: measured in the panel, the worker brief's first line came back reading *"on
branch agent/."* with nothing on screen to say a placeholder had been eaten. `briefHtml`
(`web/app.js`) overrides the renderer's `html` hook to escape instead, which also stops a
repo's own `git config user.name` becoming markup. Escaping the source text *before* parsing
is the obvious alternative and is wrong — marked escapes `&` inside code spans, so every
placeholder in a backtick comes back reading `&lt;task&gt;`.

## Path permission rules

**A path permission rule must say `Edit`, and must double-slash.** Two traps welded
together, both measured, both the silent kind. First: `Write(/abs/path/**)` with a plain
absolute path **matches nothing** — the "denied" write succeeded. The shape is
`Edit(//abs/path/**)`, double slash. Second, found in Wave E: Claude Code no longer
matches `Write(path)` rules in file permission checks *at all*, and says so at launch —
*"only Edit(path) rules are … Edit rules cover all file-editing tools."* So a `Write`
rule is a warning banner over a hole. The lead's settings carried both halves for four
waves; the Write halves were never doing anything. `pathRule` in `server/team.js` is
the one place that builds these — don't hand-write them, and don't reach for `Write`.

## The auto-mode classifier

**A tool call with no matching allow rule goes to the auto-mode classifier, and the
classifier can itself fail.** The maintainer hit this live: a standalone room member's
`mcp__foreman__group_post` came back denied with *"Permission for this action was denied
by the Claude Code auto mode classifier. Reason: Stage 2 classifier error — blocking based
on stage 1 assessment (usually transient — retrying often succeeds)."* Nothing about the
call was wrong and nothing this repo's own guards would have refused — the classifier
simply errored on its own, on a tool nobody had told it about in advance. Every role now
carries an explicit allow rule for the panel's own server (`mcp__foreman`, the bare
whole-server form — confirmed against the installed Claude Code's own docs, `### MCP` on
the permissions page, v2.1.257: "`mcp__puppeteer` matches any tool provided by the
`puppeteer` server"), so a `foreman` tool call is decided before the classifier is ever
asked. `leadSettings` (`server/team.js`), `writeWorkerSettings` (`server/dispatch.js`, so
both build workers and planners), and the standalone `session-settings.json`
(`server/session-launch.js`, via `--settings`) each carry it. This is an allow rule and
nothing more: `assertNotBlocked`, `PaneLock`, every endpoint refusal, the merge-check wall,
and the dispatch-confirmation discipline in the brief are all untouched — it removes the
harness's flaky second opinion on tools the panel itself serves, and nothing else. The bare
server form was chosen over a hand-copied per-tool list for the `isLeadName` reason: a tool
added to `LEAD_TOOLS` or `WORKER_TOOLS` later needs no matching update here, because there
is nothing to update.

## An unknown task state

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

## Merged versus live here

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

## `composerSig` does not know about tasks

**`composerSig` does not know about tasks, and a merge block built inside `buildComposer`
would freeze on stale data.** The composer is only rebuilt when that signature changes,
which happens on a prompt/mode/dialog change, not on a task closing. `renderMergeQueue`
is its own function, called from `renderHead` on the roster beat instead — the same shape
as `renderQueue`. Task state must never join `composerSig` itself: that would tear the
whole textarea down under a reader's cursor every time a worker reported done, for a
block that only needed its own repaint.

## The interrupt row never moves

**The interrupt row's design is that it never moves, and the merge block is the first
thing ever placed above it.** Two things make that affordable, and both have to keep
holding: PRs arrive minutes apart rather than per reply, so the block repaints rarely; and
it is *appended and removed* from `.composer-above` rather than hidden, so
`.composer-above:empty` still fires and a session with nothing to merge stays
byte-identical to before the feature existed — checked by SHA-256 on the cropped
screenshot region, not by eye, because "looks the same" is not evidence a selector still
fires.

## Cache a three-dot diff on both shas

**Cache a three-dot diff on both shas, not the branch tip alone.** `base...branch`
changes its answer when *main* moves even though the branch tip did not — and main moves
at every merge, which is this feature's whole subject. `conflicts.js` keys its own cache
on the branch sha alone and is right to, for its own question ("what has this worker
changed"); this file's question is "what would land next to what", which the same key
would answer with a diff taken before the thing that mattered moved. The key here is
`${repo}:${branchSha}:${baseSha}`, both resolved to shas via `shaOf`.

## A signature joined with an invisible character

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
