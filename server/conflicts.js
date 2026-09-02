import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (dir, args) => run('git', ['-C', dir, ...args]);

/**
 * Conflict flagging — two workers on one repo touching the same paths. The response is a
 * room post and nothing else: the lead decides the ordering. Nothing here serialises,
 * pauses or kills a worker, because nothing in this system kills a worker automatically.
 *
 * Committed work is visible from the parent repo (worktrees share its .git), so the
 * branch side is `base...branch`, three-dot — the branch's own changes since the merge
 * base. The uncommitted side matters more: a mid-task worker's changes mostly haven't
 * been committed yet, and only `status --porcelain` inside its worktree sees them.
 *
 * **Both sides read `-z`, and that is the whole of what makes the union work.** The two
 * commands do not spell a path the same way, and the mismatch is silent. Measured against
 * a throwaway repo, one worker having committed the file and the other holding it dirty:
 *
 *     branch side : ["\"web/caf\\303\\251.js\"", "web/my file.js"]
 *     dirty side  : ["web/caf\\303\\251.js",       "web/my file.js"]
 *     overlap     : ["web/my file.js"]
 *
 * `diff --name-only` leaves a space bare and quotes non-ASCII; `status --porcelain`
 * quotes both. Both octal-escape non-ASCII, because `core.quotepath` defaults on. This
 * module used to strip outer quotes on the **porcelain side only** — which happens to fix
 * the space case, which is why the tests passed and nobody noticed, and which leaves the
 * two spellings of `web/café.js` differing by exactly the two quote characters. Two
 * workers editing it were never flagged, and no-conflict-found is indistinguishable from
 * no-conflict: the failure this repo's own rule warns about, where showing nothing wrong
 * looks exactly like nothing being wrong.
 *
 * Stripping quotes on *both* sides would have made those two strings equal, and is still
 * the wrong fix: the path then kept is `web/caf\303\251.js`, and that escaped spelling
 * is what the room post would name at the maintainer. `-z` returns raw bytes with no
 * quoting and no escaping on either side — the same reasoning `deployed.js` and
 * `merge-queue.js` already record — so equality and the displayed name come out right
 * together, and there is nothing left to strip. Do not reintroduce `.trim()` on a path
 * either: leading and trailing spaces are legal in a filename and `-z` hands them over
 * exactly.
 *
 * **The trap inside the fix is the rename encoding.** `-z` does not only change the
 * quoting on the porcelain side, it changes the *shape*: a rename is `XY new\0old\0`,
 * two NUL-separated fields, rather than the `XY old -> new` arrow of the non-`-z` form.
 * Split on NUL, treat every field as an entry, and the original path is parsed as a
 * status line — `web/old.js` read as the code `we` and the path `old.js` — silently, on
 * exactly the entries a rename produces. `parsePorcelainZ` is where that is handled, and
 * it is the only reason this parse is a named function rather than four lines inline.
 *
 * **And rename detection is the *other* half of the same asymmetry, found after the `-z`
 * fix and not covered by it.** `git diff` detects renames by default, so once a rename is
 * committed the diff names only where the file went; `status --porcelain` names both ends
 * of an uncommitted one. Two workers, one having committed `web/x.js` -> `web/y.js` and
 * one editing `web/x.js`, therefore shared no path at all and were never flagged — the
 * same shape of silence as the encoding bug, in the case where the work is further along.
 * `--no-renames` on the branch side is the fix and `branchPaths` carries the measurement.
 *
 * **No shared parse with `merge-queue.js`, deliberately.** That module's diff side is
 * `split('\0').filter(Boolean)` and so is this one's, and so is `deployed.js`'s
 * `branchFacts` — but that is the definition of "a NUL-separated list", not a contract
 * two callers could come to disagree about, and a module exporting it would be indirection
 * over a one-liner. The parse that *is* subtle is the porcelain one above, and it has
 * exactly one caller: `merge-queue.js` has no dirty side on purpose (a PR contains only
 * what was pushed) and neither does `deployed.js`. The day a second caller needs porcelain,
 * it imports `parsePorcelainZ` from here rather than growing its own.
 *
 * Everything injected, nothing on import; index.js owns the timer.
 */

/**
 * `git status --porcelain -z` output → the set of paths it names.
 *
 * Two things the arrow form did not make you think about:
 *
 * 1. **A field is not an entry.** An entry is `XY<space>path`; a rename or a copy is
 *    followed by a *second* field holding the original path, carrying no `XY` prefix of
 *    its own. The loop therefore consumes that field instead of iterating onto it.
 *    Measured — `git mv web/old-name.js web/moved.js && git add -A` gives
 *    `R  web/moved.js\0web/old-name.js\0`: **new first, then old**, the opposite order to
 *    the arrow form's `old -> new`. An *unstaged* move is not a rename at all and needs
 *    none of this: measured, it arrives as two ordinary entries, ` D old` and `?? new`.
 * 2. **Which column carries it.** Porcelain v1 puts `R`/`C` in the index column only —
 *    `RM` is "renamed in index, modified in worktree" — and no unmerged code
 *    (`DD AU UD UA DU AA UU`) contains either letter. The worktree column is tested
 *    anyway: it cannot fire, and the asymmetry is stark, since missing an extra field
 *    corrupts a path while an inert check costs a character.
 *
 * Both names are kept, exactly as the arrow form kept both: a rename touches the path it
 * came from as much as the one it went to, and a second worker editing the old name is
 * precisely the collision this module exists to find.
 *
 * @param {string} stdout raw `--porcelain -z` output
 * @returns {Set<string>}
 */
export function parsePorcelainZ(stdout) {
  const paths = new Set();
  const fields = String(stdout).split('\0');
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (!entry) continue; // the empty tail after the final NUL
    const named = entry.slice(3); // `XY path`, and never trimmed — see the header
    if (named) paths.add(named);
    const [x, y] = entry;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const original = fields[++i]; // consumed, not iterated onto
      if (original) paths.add(original);
    }
  }
  return paths;
}

async function branchPaths(repo, base, branch) {
  if (!base || !branch) return new Set();
  // `--no-renames`, and it is load-bearing: rename detection is **on by default** in
  // `git diff`, so a committed `web/x.js` -> `web/y.js` reports only `web/y.js` and the
  // old name leaves this worker's set entirely — a sibling editing `web/x.js` then
  // overlaps nothing and is never flagged. The porcelain side has always kept both names
  // (`parsePorcelainZ` above, and the arrow form before it), so without this flag the two
  // sides disagree about what a rename touches and the blind spot is exactly the
  // *committed* case. Measured in a throwaway repo: default gives `web/y.js`,
  // `--no-renames` gives `web/x.js` and `web/y.js`. It also overrides a `diff.renames`
  // config set to `true` or `copies` ("even when the configuration file gives the default
  // to do so"), which is why it is a flag here rather than a repo setting somebody could
  // switch back. Do not "tidy" it away: a rename touches the path it came from as much as
  // the one it went to, and that is this module's whole question.
  const { stdout } = await git(repo, ['diff', '--name-only', '--no-renames', '-z', `${base}...${branch}`]);
  return new Set(stdout.split('\0').filter(Boolean));
}

async function dirtyPaths(worktree) {
  // -uall, or an untracked file in a new directory collapses to `?? src/` and its path
  // never matches the other worker's — measured, the test caught it.
  const { stdout } = await git(worktree, ['status', '--porcelain', '-uall', '-z']);
  return parsePorcelainZ(stdout);
}

/** Every path a task is touching: committed on its branch ∪ dirty in its worktree. */
export async function taskPaths({ repo, base, branch, worktree }) {
  const [committed, dirty] = await Promise.all([branchPaths(repo, base, branch), dirtyPaths(worktree)]);
  return new Set([...committed, ...dirty]);
}

export function createConflictScanner({ tasks, readTeam, postConflict }) {
  const diffCache = new Map(); // task id -> { sha, paths } — the committed side only
  const flagged = new Set(); // "a|b|path,path" — same pair + same overlap never re-posts

  async function scan({ now = Date.now() } = {}) {
    const byRepo = new Map();
    for (const t of tasks.list()) {
      if (t.state !== 'dispatched' && t.state !== 'working' && t.state !== 'review') continue;
      if (!t.worktree) continue; // review still owns an unmerged branch — it collides too
      if (!byRepo.has(t.repo)) byRepo.set(t.repo, []);
      byRepo.get(t.repo).push(t);
    }
    for (const [repo, group] of byRepo) {
      if (group.length < 2) continue;
      if (!(readTeam(repo)?.toggles?.flagConflicts ?? true)) continue;
      const touched = [];
      for (const t of group) {
        try {
          // The branch diff is cached by head sha; the porcelain read runs every scan —
          // dirt has no sha to cache by, and it is the cheap half anyway.
          let committed = new Set();
          if (t.branch) {
            const sha = (await git(repo, ['rev-parse', t.branch])).stdout.trim();
            const hit = diffCache.get(t.id);
            if (hit?.sha === sha) {
              committed = hit.paths;
            } else {
              committed = await branchPaths(repo, t.base, t.branch);
              diffCache.set(t.id, { sha, paths: committed });
            }
          }
          const dirty = await dirtyPaths(t.worktree);
          touched.push({ t, paths: new Set([...committed, ...dirty]) });
        } catch {
          /* worktree vanished mid-scan, branch gone — skip this task, keep scanning */
        }
      }
      for (let i = 0; i < touched.length; i++) {
        for (let j = i + 1; j < touched.length; j++) {
          const overlap = [...touched[i].paths].filter((p) => touched[j].paths.has(p)).sort();
          if (!overlap.length) continue;
          const pair = [touched[i].t.id, touched[j].t.id].sort();
          const key = `${pair.join('|')}|${overlap.join(',')}`;
          if (flagged.has(key)) continue;
          flagged.add(key);
          postConflict(repo, { tasks: pair, paths: overlap, now });
        }
      }
    }
  }

  return { scan };
}
