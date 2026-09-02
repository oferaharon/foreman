# Contributing

Bug reports, questions and pull requests to Foreman are all welcome, and they all go to
the same place — see [Working in the open](README.md#working-in-the-open).

Before anything else, read [CLAUDE.md](CLAUDE.md). It is not a style guide: it is the list
of things that have already gone wrong in this codebase and what each one cost, and it is
why the rules below are rules rather than preferences.

## Run the tests

```
npm install
npm test
```

`npm test` is `node --test` over `test/*.test.js` — the five screen parsers, the stores,
pane↔session binding, launch naming, and the team modules. It needs no panel running and no
network. Run it before you start and again before you send anything. Several of those tests
pin behaviour that looks wrong until you know why, so a failure is worth reading rather than
adjusting.

The git wrappers are tested against **real throwaway repositories the tests create**, not
against a stubbed `git`. Stubbing git to test a git wrapper proves nothing.

## Fixtures are regenerated, never hand-edited

Everything under `test/fixtures/` is real `tmux capture-pane` output — a recording of what
Claude Code actually drew, which is the only reason it can settle an argument. Editing one
by hand to make a test pass turns the evidence into a guess, silently, and the next person
has no way to tell.

When a screen genuinely changes, capture it again from a live session and replace the file.

## Capture at 220 **and** 70 columns

Pane width is an input to every parser here. Option labels wrap, box headers wrap, footers
wrap, and a run of numbered options can break in the middle of itself — a box that parses
perfectly at 220 columns has come back unreadable at 70. "Verified end to end" at one width
is not verified, which is why the fixtures keep a wide *and* a narrow capture of the same
box.

Sessions the panel launches open at 220×50. A Terminal window attached to one later is
80×23 by default, and a split window is narrower still, so both widths are real.

## Verify against a scratch session; do not reason about the TUI

Nearly every wrong turn this project has taken came from reasoning about what Claude Code
draws instead of capturing it. There is no API for a terminal — read it.

```
tmux new-session -d -s scratch -x 220 -y 50 -c <a throwaway repo> claude
tmux send-keys -t scratch …           # drive it
tmux capture-pane -p -t scratch       # read it
tmux kill-session -t scratch
```

Use a **throwaway repository** you do not mind breaking — never a real project, and never
this checkout: a scratch session here is indistinguishable from the real one in the rail,
and messages meant for one land in the other.

One trap worth knowing before it fools you: `capture-pane -p` cannot tell a suggestion from
typed text. Claude Code offers the next prompt as dim ghost text and plain capture strips
the attribute, so it reads as though somebody typed it. Use `capture-pane -pe` and look for
`\e[2m` when it matters.

## A scratch panel gets a scratch port, state dir **and** label

The panel is probably already running. Check with `lsof -iTCP:48770` before starting one,
and give the second one all three:

```
FOREMAN_PORT=48771 FOREMAN_STATE_DIR=/tmp/panel-scratch FOREMAN_AGENT_LABEL=scratch npm start
```

Every time, and the state dir is not tidiness:

- A second panel on the **real** state dir runs its own worktree housekeeping against real
  tasks — it will sweep worktrees, delete branches and post the receipt into a real team's
  room, entirely within its rights.
- Two panels sharing one `queue.json` both flush the same waiting message into the same
  session.
- Snapshot/restore is a single slot, so a test run saves over the set of sessions somebody
  is relying on.
- The label decides which two log files are trimmed at boot, and the running process reads
  it from its own environment — a scratch panel carrying the default label truncates the
  real panel's logs.

Stop one **by port** (`lsof -tiTCP:48771`). Never `pkill -f "node server/index.js"`: that
pattern also matches the panel somebody is using.

## Things that are deliberately not here

No issue templates and no PR template. They are forge-specific furniture and can be added
when they earn it; what actually helps is what you saw, what you expected, and enough to
reproduce it.

## Releasing

Semver. A release gets cut when there's something worth announcing, not on a schedule.

1. One small "release vX.Y.Z" PR bumps `package.json` and `package-lock.json`. Nothing
   else goes in it.
2. The maintainer merges it.
3. The lead tags that merge and runs
   `gh release create vX.Y.Z --target <sha> --generate-notes`, with a paragraph on top of
   the generated notes.
4. The tag always matches `package.json` — `vX.Y.Z` for version `X.Y.Z`, no exceptions.
5. **Bump the formula**, once the release above is published — never before. In the tap
   repository (`oferaharon/homebrew-tap`), edit `Formula/foreman-panel.rb`:

   ```
   url    https://github.com/oferaharon/foreman/archive/refs/tags/vX.Y.Z.tar.gz
   sha256 <the checksum below>
   ```

   Compute the checksum against the published tag, never against a local file:

   ```
   curl -fsSL https://github.com/oferaharon/foreman/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
   ```

   Commit to the tap's default branch with the message `foreman-panel X.Y.Z`. Then verify:

   ```
   brew update && brew upgrade foreman-panel && brew services restart foreman-panel
   ```

The ordering in step 5 is the whole point, not a formality: the checksum is taken over the
tarball GitHub generates *for that tag*, and those bytes only exist once the tag does. A
formula bumped before the tag is published points at a 404, which Homebrew reports as a
plain download failure — nothing in the error says the release just isn't out yet.
