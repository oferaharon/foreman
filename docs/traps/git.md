# Git

The evidence behind the **Git** block of [`CLAUDE.md`](../../CLAUDE.md)'s Traps index —
what git actually prints as against what a reader of it expects: the porcelain's collapse
of an untracked directory, the two quotings, the `-z` rename encoding and the rename
detection three separate readers depend on. Each section below is one trap, opening with
the bold sentence its index line quotes.

## Porcelain collapses an untracked directory

**`git status --porcelain` collapses an untracked directory to `dir/`.** A new file in a
new folder is reported as its parent, so two workers editing the same fresh path never
compare equal and the conflict scan misses them entirely. `-uall` is the fix, and it is
not optional — `conflicts.js` unions the porcelain read with the branch diff precisely
because a mid-task worker's changes are mostly *uncommitted*, which makes this the half
that matters. Git also quotes paths containing spaces; strip the quotes or they never
match diff output. `test/conflicts.test.js` pins both.

## `git diff` and `git status` quote paths differently

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
