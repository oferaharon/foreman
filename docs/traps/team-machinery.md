# Team machinery

The evidence behind the **Team machinery** block of [`CLAUDE.md`](../../CLAUDE.md)'s
Traps index — how a brief is assembled, how a permission path rule has to be spelled, what
the auto-mode classifier does to a tool nobody declared, what the task store does with a
record it cannot read, and how the panel tells "merged" from "running here". Each section
below is one trap, opening with the bold sentence its index line quotes.

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
