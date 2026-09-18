# Binding

The evidence behind the **Binding** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps
index — how a pane is matched to the transcript it is showing: titles, labels, siblings,
freshness, the folder a transcript really lives in, and the hook receipts that overrule all
of it. Each section below is one trap, opening with the bold sentence its index line quotes.

## A `<repo>-<branch>` title proves nothing

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

## A label can collide with the branch

**A label can collide with the branch.** A session labelled `main` in a repo on branch
`main` produces `alpha-main` either way, so the title is identical whether it was derived
from the branch or from the label. The guard against branch-derived titles must therefore
only fire when a *sibling* could still be writing that default — see `modernNamer` in
`sessions.js` / `wrapper.js`. Getting this wrong permanently blocks a legitimate binding.

## Ambiguity comes from siblings

**Ambiguity comes from siblings, not names.** One pane in a folder means one live
conversation, so a name mismatch there is harmless. Several panes means only an exact
label match is safe. Over-tightening this blanked five working sessions.

## Freshness is load-bearing

**Freshness is load-bearing.** A transcript last written *before* a pane existed cannot
be that pane's. Without this guard a new session adopts yesterday's history, and a
restarted one adopts its own previous run.

## The roster's `label` is not the label you launched with

**The roster's `label` is not the label you launched with.** `sessions.js` slices only
the session prefix, so `<prefix>alpha-main` arrives as `alpha-main` — folder and all.
Feed that back into `uniqueSessionName` and you get `<prefix>alpha-alpha-main`, a session
that no longer answers to the name anybody saved. `slugFor` in `launch.js` is the inverse of
`sessionName` and the only correct way back; `test/launch.test.js` pins the round trip.
The same row's `cwd` is the transcript's and moves (see below) — `paneCwd` is the launch
folder, and it is what a relaunch has to use.

## A binding survives a sibling

**A binding survives a sibling.** A pane bound while alone in its folder used to come
unbound the instant a second session opened there — the folder turned ambiguous and the
panel blanked a transcript it had been reading for an hour. `rememberedFor` replays the
last poll's answer, re-checked against cwd and freshness. Hooks still overrule it. On a
cold start there is nothing to remember, so rule 3 also binds the leftovers: one unbound
pane in a folder with exactly one unclaimed *live* transcript is arithmetic, not a guess.
"Live" matters because `/clear` leaves a chain behind — a file whose last word predates
another file's first is a rotation predecessor, and counting those as rivals is what kept
an identifiable session reading "can't tell which history is this one's".

## The hook posts JSON without saying so

**The hook posts JSON without saying so — and that silently cost the panel its best
evidence.** `install-hook.js` writes a `curl --data-binary @-` with no `Content-Type`, so
curl labels the body `application/x-www-form-urlencoded`, `express.json()` skips it,
`req.body` is `{}`, `ingest` finds no `session_id` and returns. Every hook ever sent was
dropped there: `~/.foreman/panes/` held not one receipt, no session ever read
`hook` as its status source, and the authoritative binding rule — the whole reason the
hook exists — had never once fired. The panel had been running entirely on pane scraping
and looked fine doing it, which is why nobody noticed. `/hook` now parses any
content-type; the installer sends the header too — and it now **replaces an entry it wrote
before** rather than skipping the event, which is what stopped that header (and every later
fix to the command) from reaching a machine that had already run the installer once. See the
socket trap below for the second half of the same lesson.

## A pane id is only meaningful relative to one tmux server

**A pane id is only meaningful relative to one tmux server, and the hook used not to say
which — so a bench's scratch session owned the real panel's bindings.** MEASURED on
2026-09-16. Every tmux server numbers its panes from `%0`, so a scratch server (`env -u
TMUX` plus its own `TMUX_TMPDIR`, which is how every bench here is isolated) hands out `%0`
and `%1` again while the real server's `%0` and `%1` belong to somebody else entirely. The
hook is registered **globally** in `~/.claude/settings.json` against a hardcoded
`127.0.0.1:48770`, so those throwaway sessions posted `UserPromptSubmit`/`Stop` receipts at
the real panel carrying a bare `$TMUX_PANE` — and the hook is the *authoritative* binding
rule, so it won. `~/.foreman/panes/_0.json` held a sandbox session's transcript while the
pane the panel drew it under was a real one in another folder. Every heuristic in
`binding.js` behaved correctly throughout; it never got a say.

Three things about it. It is **reads and display only** — sends resolve the pane from the
live roster, off real `tmux list-panes`, so nothing has ever been typed into the wrong
session by this. It **flip-flops**, whichever server last fired a hook for a given number
owning that pane's transcript, so it self-heals within minutes and reads as an intermittent
binding bug rather than as a hook that should never have been accepted — both receipts from
the measured incident had already healed by the time the fix was benched. And it is **not a
one-off**: every bench this repo has ever run on a scratch tmux server did it, which is
almost certainly what produced the 2026-09-06 "wrong transcript in pane" screenshot.

So the hook says which server it came from. `install-hook.js` sends
`-H "X-Tmux-Socket: ${TMUX%%,*}"` — `$TMUX` is `<socket path>,<server pid>,<session id>` and
that expansion is POSIX, verified in sh, bash and zsh, so it needs no `jq`, no `cut` and no
subshell; it is a **header rather than a body key** because the body is Claude Code's own
JSON arriving on the hook's stdin and curl cannot add a field to it, which is the same
reason `X-Tmux-Pane` already travels this way. `tmuxSocketPath()` (`tmux.js`) reads the
panel's own with `display-message -p '#{socket_path}'` — **read, never reconstructed**:
`$TMUX_TMPDIR`, `/tmp` against `/private/tmp`, the uid in `tmux-<uid>` and a `-L`/`-S`
override all feed the real answer, and a guess that got any of them wrong would refuse every
receipt the panel depends on. It is answered by the *same* server `listPanes` polls by
construction, since neither call passes `-L` or `-S`. It memoises only a **real** answer and
retries a miss, because the panel usually boots before any tmux server exists and caching
that `null` would disarm the guard permanently.

## The asymmetry is the fix

**The asymmetry is the fix, and it is deliberate rather than an oversight.** A receipt
carrying **no** socket is accepted exactly as before — every session already running was
launched under the old entry, and refusing those would trade an intermittent
wrong-transcript bug for a total loss of binding. A socket that is **present and different**
is refused whole: no binding, no state, no receipt on disk, every event including
`SessionEnd`. The panel not yet knowing its *own* socket is the same "cannot judge" and
answers the same way, which is the beat between boot and the first tmux server. What keeps
the fail-open window short rather than permanent is that **Claude Code re-reads its hook
config while running** — measured, and recorded under *Working here* in
[`CLAUDE.md`](../../CLAUDE.md); this is what it buys.

Two consequences worth knowing. The refusal is **logged once per foreign socket**, because
the alternative is a line per tool call of every session on that server, and a silent
refusal is precisely the shape this panel has already been bitten by one trap up. And
`install-hook.js` had to learn to **replace its own entry** — it skipped any event that
already had one, so this fix would have reached nothing until somebody deleted the entry by
hand, with nothing on screen saying so. Ours is recognised by the **shape it writes** (a
curl at this panel's own `:<port>/hook`), never by a byte match on the command: match on the
bytes and the entry we wrote yesterday reads as a stranger's and rots beside the new one.
A hook pointing anywhere else is still left strictly alone, and the backup in front of every
write is what makes replacing a hand-edited one recoverable.

The bench is `ingest`'s own decision rather than an end-to-end round trip, for the reason
this file keeps choosing: proving it end to end would mean registering a hook globally, and
that reaches every session on the Mac. So `test/status.test.js` pins accept/refuse/absent
with an injected socket, `test/install-hook.test.js` drives the real installer as a
subprocess against a throwaway `HOME`, and the live half was the installer's own curl
command fired at a scratch panel (scratch port, scratch state dir): a foreign socket wrote
nothing to that panel's `panes/`, the panel's own socket wrote `_0.json`, a second foreign
receipt did not take `%0` back, and `env -u TMUX` was accepted. A sink on its own port
confirmed what the wire actually carries rather than inferring it —
`content-type: application/json`, `x-tmux-pane: "%12"`,
`x-tmux-socket: "/private/tmp/tmux-501/default"`.

## A transcript's `cwd` moves

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
