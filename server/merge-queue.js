import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isAncestor, shaOf } from './deployed.js';

import { FALLBACK } from './human-name.js';

/**
 * The merge queue — the PRs waiting on the maintainer, and the one sentence a button
 * types.
 *
 * The maintainer's problem (decisions.md, 2026-08-30): when three workers finish, each PR is
 * reported in conversation minutes apart, and by the time they come back the *count* is
 * still on the rail (`3 in review`) but the *links* are scattered up the scrollback.
 * This is the fixed place for them.
 *
 * **The button does not merge.** It types `Merge PR #51 — task …` into the lead's own
 * session, exactly as if the maintainer had typed it, and the lead does what it already
 * does: merges through its Gitea tools, pulls, restarts the panel when `server/` changed,
 * verifies, closes the task. The panel holds no Gitea credential and gains none. Same
 * mechanism as `POST /api/trigger`, which already types into a running lead.
 *
 * Underneath it is the part that is actually new. On 2026-08-29 Gitea PRs #50 and #51 both
 * rewrote the same function in the same file; merging both without thought would have
 * landed a combination nobody had ever looked at. `conflicts.js` *did* catch it — it
 * posted the overlap into the room at seq 290 and 294 — but the room is a log you scan,
 * the line lands while the workers are still running, and it stops the instant one of the
 * two tasks closes. The work is not inventing a check. It is **moving the check to where
 * the decision is made**: onto the merge row, computed when you look at it, in words that
 * name the two tasks and the file they share.
 *
 * And the rule the whole design turns on (plan §1, the maintainer's own reasoning):
 *
 *   > A **batch** press is refused when the batch does not compose. An **individual**
 *   > press is never refused, only annotated.
 *
 * One press standing for several decisions is the thing they cannot evaluate, so the panel
 * withholds it. One press for one decision is theirs, and the row says what it is first.
 *
 * Everything here is either pure or a thin git read. The endpoint owns the lead, the
 * dedupe window and the room line; this file owns the facts and the words.
 */

const run = promisify(execFile);
const git = (dir, args) => run('git', ['-C', dir, ...args]);

/**
 * What a task's PR contains: the paths on its branch since it left the base.
 *
 * **`-z` is not optional.** Measured by the planner in a throwaway repo:
 * `diff --name-only` leaves a space bare (`web/my file.js`) but quotes *and*
 * octal-escapes non-ASCII (`"web/caf\303\251.js"`), while `status --porcelain -uall`
 * quotes the space. `conflicts.js` strips outer quotes on the porcelain side only, which
 * happens to fix the space case and *cannot* fix the non-ASCII one — the two sides never
 * compare equal. `-z` returns raw bytes and no quoting at all, which is what
 * `deployed.js:88` already does and says why. (That `conflicts.js` blind spot is recorded
 * as its own task, deliberately not fixed here.)
 *
 * **There is no dirty side, and that is the difference from `conflicts.js`.** `taskPaths`
 * unions the branch diff with `git status --porcelain` inside the worker's worktree —
 * right for its question ("two workers editing one file *right now*"), wrong for this
 * one. A PR contains only what was committed and pushed; uncommitted dirt in a review
 * worktree is not in the PR, and counting it would flag pairs that cannot possibly
 * compose badly. A sibling function, not a reuse.
 *
 * `null` means **could not be read** — a deleted branch, a pruned base — and it is not
 * the same as "touches nothing". Unknown beats optimistic here exactly as it does in
 * `deployed.js`'s `needsRestart`: an unreadable row withholds the batch.
 *
 * @param {string} repo
 * @param {{branch?: string, base?: string}} task
 * @returns {Promise<string[]|null>} sorted paths, or null when git could not answer
 */
export async function mergePaths(repo, { branch, base } = {}, deps = {}) {
  const { cache = pathCache, sha = shaOf } = deps;
  // No base is not "assume main" — that assumption was wrong on every repo whose default
  // branch is called something else, and here it would silently answer the wrong diff.
  // `null` is this function's word for "could not be read", and the row withholds.
  if (!repo || !branch || !base) return null;
  const [branchSha, baseSha] = await Promise.all([sha(repo, branch), sha(repo, base)]);
  if (!branchSha || !baseSha) return null;

  /*
   * The cache key is the *pair* of shas, not the branch tip alone.
   *
   * `base...branch` is three-dot, so its answer changes when **main** moves even though
   * the branch tip did not — and main moves at every merge, which is this feature's whole
   * subject. `conflicts.js` keys on the branch sha and is right to for its own question;
   * keying on it here would answer the question this file exists to ask with an answer
   * taken before the thing that changed it.
   */
  const key = `${repo}:${branchSha}:${baseSha}`;
  const hit = cache.get(key);
  if (hit) return hit;

  try {
    // By sha, not by ref: the shas are what the key promises, and resolving twice leaves
    // a window where the diff is of something the cache is not named after.
    const { stdout } = await git(repo, ['diff', '--name-only', '-z', `${baseSha}...${branchSha}`]);
    const paths = [...new Set(stdout.split('\0').filter(Boolean))].sort();
    remember(cache, key, paths);
    return paths;
  } catch {
    return null;
  }
}

/** Sha-keyed, so an entry can never be stale — but bounded, since the panel is a daemon. */
const pathCache = new Map();
const CACHE_MAX = 200;
function remember(cache, key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/**
 * What a merged task changed, remembered from when it was still readable.
 *
 * The `rebase first` verdict needs the paths of a task that has already merged — and
 * after the merge those are gone: the worktree sweep deletes the branch, and a three-dot
 * diff against a main that now *contains* the branch is empty (the trap `deployed.js`
 * already pays for once). `branchFacts` records only top-level directories, which is far
 * too blunt to compare against a file list.
 *
 * So the answer is remembered rather than recovered: every time the queue reads a review
 * row's paths, it keeps them under the task id. That is populated by construction for the
 * case this feature is about — a merge the maintainer pressed here was a row on screen a
 * moment earlier, which means its paths passed through this function. A merge done some
 * other way, or one whose row this panel never saw, simply has no record and draws no
 * `rebase first` clause. In memory and cleared by a restart, like `triggerSeen`: a warning
 * we cannot substantiate is one we do not show.
 */
const landedPaths = new Map(); // task id -> { head, paths }

/** Test seam: the two module caches, so a suite can start from nothing. */
export function resetCaches() {
  pathCache.clear();
  landedPaths.clear();
}

/** The PR's number, or null. Never guessed. */
export function prNumber(pr) {
  const m = /(\d+)\s*$/.exec(String(pr || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * How a PR is named in a sentence.
 *
 * All 89 live records are Gitea's `…/pulls/<N>`, but `PATCH /api/team/tasks/:id` validates
 * only `^https?://` — so a URL with no trailing number names itself. Never invent a number
 * for a lead to act on.
 */
export function prName(row) {
  return row?.prNumber ? `PR #${row.prNumber}` : `PR ${row?.pr || ''}`.trim();
}

/** The brief's first line, clamped — a row is one line tall and a body is not. */
function firstLine(body) {
  const line = String(body || '').split('\n').find((l) => l.trim()) || '';
  const clipped = line.trim().slice(0, 160);
  return clipped.length < line.trim().length ? `${clipped}…` : clipped;
}

/** `a`, `a and b`, `a, b and c` — with a cap, because a row is one line tall. */
function list(items, max = 3) {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const joined =
    shown.length <= 1 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return rest > 0 ? `${joined} and ${rest} more` : joined;
}

/**
 * The rows, from records and already-gathered facts. Pure — every git answer arrives as
 * an argument, so the decision table can be tested without a repo and the git reads can be
 * tested against a real one.
 *
 * A row is **a task in `review` in this repo**, and note what that is not: it is not
 * "in review *and* has a PR". The rail's amber count is `state === 'review'` and nothing
 * else (`sessions.js:189`), so a block that drew only PR-bearing rows would say 2 under a
 * count that says 3 — which reads as a bug and costs a hunt. A review task with no PR yet
 * draws greyed, with no button, saying what it is waiting for.
 *
 * @param {object} o
 * @param {object[]} o.tasks    every task record; this filters
 * @param {string} o.repo
 * @param {Map<string, string[]|null>} [o.paths]   task id -> its PR's paths (null = unreadable)
 * @param {Set<string>} [o.sent]     ids whose merge line already went, inside the window
 * @param {Set<string>} [o.merged]   ids whose head is already an ancestor of local HEAD
 * @param {Map<string, {id: string, paths: string[]}[]>} [o.behind]
 *        id -> tasks that merged and were pulled after this branched, and overlap it
 */
export function buildQueue({ tasks = [], repo, paths = new Map(), sent = new Set(), merged = new Set(), behind = new Map() } = {}) {
  const review = tasks
    .filter((t) => t && t.repo === repo && t.state === 'review')
    // Oldest first: a queue is FIFO, and it is also the order a batch merges in, which is
    // what makes "so the second can be rebuilt on the first" true of the button too.
    .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')) || String(a.id).localeCompare(String(b.id)));

  const rows = review.map((t) => {
    const own = paths.has(t.id) ? paths.get(t.id) : null;
    const row = {
      id: t.id,
      kind: t.kind || 'build',
      pr: t.pr || null,
      prNumber: prNumber(t.pr),
      title: firstLine(t.body),
      branch: t.branch || null,
      base: t.base || null,
      updatedAt: t.updatedAt || null,
      paths: own,
      shares: [],
      sharesNote: null,
      behind: behind.get(t.id) || [],
      state: 'ready',
      note: null,
    };
    return row;
  });

  // Which review rows share a path with which. Pairwise, over the rows themselves — the
  // fact a row carries about its neighbours, separate from whether a batch is allowed.
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (!a.paths || !b.paths) continue;
      const both = new Set(b.paths);
      const overlap = a.paths.filter((p) => both.has(p));
      if (!overlap.length) continue;
      a.shares.push({ id: b.id, paths: overlap });
      b.shares.push({ id: a.id, paths: overlap });
    }
  }

  for (const row of rows) {
    /*
     * Precedence, and each step is evidence beating a weaker claim:
     *   merged      ancestry says it is already in the checkout — a fact, not a guess
     *   sent        we typed the line; the lead has not finished yet
     *   no-pr       there is nothing to merge, whatever else is true
     *   unreadable  we cannot say what it changes, so we will not vouch for a batch
     *   rebase-first something merged under it, and they touch the same files
     *   ready
     */
    if (merged.has(row.id)) {
      row.state = 'merged';
      row.note = 'merged — waiting on the lead to close it';
    } else if (sent.has(row.id)) {
      row.state = 'sent';
      row.note = 'merge sent — waiting on the lead';
    } else if (!row.pr) {
      row.state = 'no-pr';
      // A planner's deliverable is a page, not a branch, and the maintainer approves it in
      // conversation with their lead. It counts on the rail's amber `N in review` — so it is
      // a row here too, or the block and the count disagree and that reads as a bug — but
      // `waiting on the lead to open the PR` would be a lie about what it is waiting for.
      // Same state, honest words, and a fact about the task rather than a sentence
      // explaining the maintainer's own workflow back to them. (Ruled 2026-08-30: §3.1 said
      // both "the count always agrees" and "planner tasks never appear", and only the first
      // is stated with a reason that survives — the second's reason, "no branch and no PR",
      // is equally true of a build task whose PR is not open yet, which the same section
      // explicitly includes.)
      row.note = row.kind === 'plan' ? 'a plan — read and approved, not merged' : 'waiting on the lead to open the PR';
    } else if (!row.paths) {
      row.state = 'unreadable';
      row.note = 'its changed files could not be read — the branch may be gone';
    } else if (row.behind.length) {
      row.state = 'rebase-first';
      const [first] = row.behind;
      row.note = `rebase first — ${first.id} changed ${list(first.paths)} after this branched`;
    }

    if (row.shares.length) {
      const by = list(row.shares.map((s) => s.id));
      const files = list([...new Set(row.shares.flatMap((s) => s.paths))]);
      row.sharesNote = `also changed by ${by}: ${files}`;
    }
  }

  return rows;
}

/**
 * The rows a merge press could name: a build task, with a PR, that nothing has happened
 * to yet.
 *
 * `kind !== 'plan'` is here rather than left to `r.pr` being null. A planner never gets a
 * PR, so the `pr` test already excludes it today — but that is an accident of the data,
 * and a rule that holds by accident stops holding the day the data changes. A plan is not
 * a thing that merges; say so by name.
 */
export const candidates = (rows) =>
  rows.filter((r) => r.kind !== 'plan' && r.pr && r.state !== 'sent' && r.state !== 'merged');

/**
 * Does this set of PRs compose well enough for **one** press to stand for all of them?
 *
 * The test is path overlap, and it is deliberately blunt. `git merge-tree --write-tree`
 * exists here and reports real textual conflicts; it is the wrong tool and is declined —
 * Gitea #50 and #51 would have merged cleanly and still composed wrongly, because they were two
 * different rewrites of the same function's *intent*. "A human should look at these two
 * together" is the question, and a shared file is the honest proxy for it. Recorded so
 * nobody re-proposes it.
 *
 * Withheld **wholesale**, never partially: a batch with one bad pair and one clean third
 * is refused entire, following `trigger.js`'s `compile()` on the reasoning that a team
 * whose triggers stop working gets looked at while one silently narrowed does not. The
 * per-PR buttons are one row away.
 *
 * A known limit, accepted rather than assumed away (decisions.md, 2026-08-30): "composes"
 * is defined as "shares no file". Two PRs can still fight through an interface neither
 * file names.
 *
 * @returns {{allowed: boolean, why: string|null, tasks: string[]}}
 */
export function composition(rows = []) {
  const able = candidates(rows);
  const tasks = able.map((r) => r.id);

  // Nothing to compose. `why` is null rather than a sentence: there is no refusal to
  // explain, and a client draws no control at all.
  if (able.length < 2) return { allowed: false, why: null, tasks };

  const blind = able.filter((r) => !r.paths);
  if (blind.length) {
    return {
      allowed: false,
      tasks,
      why: `${list(blind.map((r) => r.id))} could not be read, so there is no telling whether these compose — merge them one at a time.`,
    };
  }

  const clauses = [];
  for (let i = 0; i < able.length; i++) {
    for (let j = i + 1; j < able.length; j++) {
      const both = new Set(able[j].paths);
      const overlap = able[i].paths.filter((p) => both.has(p));
      if (overlap.length) clauses.push(`${able[i].id} and ${able[j].id} both change ${list(overlap)}`);
    }
  }
  if (!clauses.length) return { allowed: true, why: null, tasks };

  return {
    allowed: false,
    tasks,
    why: `${list(clauses, 2)} — merge them one at a time so the second can be rebuilt on the first.`,
  };
}

/**
 * The sentence the button types, composed **here** and never by a client.
 *
 * This is the trust-gate move (`web/trust-gate.js`): one measured fact with two readers
 * must not become two facts. The desktop and the phone post task ids and are told what
 * was sent, so the wording is a property of the panel rather than a habit of a front end
 * — and the two clients cannot drift.
 *
 * Why each part of it:
 *   - **`Merge PR #51` leads**, because `lead-brief.js` already names "merge it" and
 *     "merge #49" as the forms that count. The button speaks the language the brief binds.
 *   - **The task id is named**, so the lead never maps a number back to a branch.
 *   - **"…and nothing else" is load-bearing.** The five rules and the 2026-08-27 ruling
 *     both turn on a merge word being per-PR; a line that could be read as standing
 *     permission would quietly undo them.
 *   - **It says the button was pressed** — not to weaken the authority (the maintainer's
 *     ruling settles that it *is* their word) but so the lead can be precise in its own
 *     report.
 *   - **The name is passed in, not read here.** It is detected per repo from
 *     `git config user.name` (`human-name.js`), and the same answer goes into the lead's
 *     brief — which quotes this sentence's opening back at the lead, so the two must not
 *     be able to disagree.
 *   - **It does not repeat the post-merge sequence.** Pull, restart, verify and close are
 *     already bound by `decisions.md` and by the brief. Restating them here is the start
 *     of a second source of truth.
 */
export function mergeLine(rows = [], human = FALLBACK) {
  const named = rows.filter(Boolean);
  if (!named.length) throw new Error('A merge line needs at least one PR.');

  if (named.length === 1) {
    const [row] = named;
    return (
      `Merge ${prName(row)} — task ${row.id}. ` +
      `${human} pressed the merge button in the panel; this is their explicit word for this PR and nothing else.`
    );
  }

  const prs = named.map(prName);
  const both = `${prs.slice(0, -1).join(', ')} and ${prs[prs.length - 1]}`;
  return (
    `Merge ${both} — tasks ${named.map((r) => r.id).join(', ')}, in that order. ` +
    `${human} pressed merge all in the panel; this is their explicit word for exactly these PRs and nothing else.`
  );
}

/**
 * Everything the endpoint needs for one repo: the git reads, then the pure build.
 *
 * Not folded into `GET /api/team/tasks`, on purpose — the desktop polls that every three
 * seconds for *every* team, and git shell-outs do not belong in it. This one takes a
 * folder and is asked only while a lead's block is on screen.
 *
 * Cost, measured by the planner: `git diff --name-only -z base...branch` is ~11ms on this
 * repo, so three review PRs is ~35ms a beat, and zero review tasks costs no git at all.
 */
export async function collectQueue({ tasks = [], repo, sent = new Set(), forge = null, base = null } = {}, deps = {}) {
  const { paths: readPaths = mergePaths, ancestor = isAncestor } = deps;
  const mine = tasks.filter((t) => t && t.repo === repo);

  /*
   * **No forge, no block.** A row is a task in `review` whether or not it has a PR yet,
   * which is right with a forge — the count agrees with the rail's amber count, and a row
   * with no PR draws greyed saying what it is waiting for. With no forge it never
   * resolves: every review task becomes a permanently grey row above the composer that
   * can never be pressed, on a repo where "done" means "the maintainer merged it locally".
   *
   * So the answer is *no rows*, not styled-away rows. `.composer-above:empty` is what
   * collapses that strip, and it only fires when the block is genuinely absent — the
   * client removes it on an empty list, so emptiness here is what makes the composer
   * byte-identical to a panel without the feature.
   */
  if (!forge) return { rows: [], batch: composition([]), forge: null };

  const review = mine.filter((t) => t.state === 'review');

  const paths = new Map();
  await Promise.all(
    review.map(async (t) => {
      // `t.base` is what the worktree was cut from; `base` is the repo's detected default,
      // for a record written before the base was recorded at all.
      const found = t.kind === 'plan' ? null : await readPaths(repo, { branch: t.branch, base: t.base || base });
      paths.set(t.id, found);
      // Remembered for as long as this process lives, against the day it merges and its
      // branch stops existing — see `landedPaths`.
      if (found && t.head) landedPaths.set(t.id, { head: t.head, paths: found });
    }),
  );

  // Already merged, and not yet closed: between the press and the lead's `task_close`
  // there are minutes where the row is still on screen. Ancestry answers it — evidence,
  // not the assumption that a sent line worked.
  const merged = new Set();
  await Promise.all(
    review.map(async (t) => {
      if (!t.head) return; // absent draws nothing extra, exactly as `deployed.js` refuses to guess
      if ((await ancestor(repo, t.head, 'HEAD')) === true) merged.add(t.id);
    }),
  );

  /*
   * The base moved under everyone else.
   *
   * After a merge every other open PR is written against an older main — true of every
   * branch ever, so saying so unconditionally is noise. It is surfaced only when all four
   * hold: the other task is `done`, its head really merged *and* was really pulled, this
   * branch does not contain it, and they share a file. Anything less is a warning about
   * nothing.
   */
  const landed = mine.filter((t) => t.state === 'done' && t.head && landedPaths.get(t.id)?.head === t.head);
  const behind = new Map();
  await Promise.all(
    review.map(async (t) => {
      const own = paths.get(t.id);
      if (!own?.length || !t.branch) return;
      const hits = [];
      for (const done of landed) {
        const theirs = landedPaths.get(done.id).paths;
        const mineSet = new Set(own);
        const overlap = theirs.filter((p) => mineSet.has(p));
        if (!overlap.length) continue;
        if ((await ancestor(repo, done.head, 'HEAD')) !== true) continue;
        // Strictly false, not "not true": a `null` here is git declining to answer, and a
        // rebase warning we cannot substantiate is one we do not draw.
        if ((await ancestor(repo, done.head, t.branch)) !== false) continue;
        hits.push({ id: done.id, paths: overlap });
      }
      if (hits.length) behind.set(t.id, hits);
    }),
  );

  const rows = buildQueue({ tasks: mine, repo, paths, sent, merged, behind });
  return { rows, batch: composition(rows) };
}
