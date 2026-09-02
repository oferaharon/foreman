import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { bareBase } from './base-branch.js';

const run = promisify(execFile);

/**
 * "Merged" and "live here" are two different facts, and the gap between them is where the
 * confusion lives: a PR merges on the Gitea box, and this Mac's checkout — and the panel
 * running out of it — know nothing about it until somebody pulls and restarts. The
 * maintainer hit exactly that: told the room restyle had shipped, watched an unchanged
 * screen for twenty minutes.
 *
 * So a `done` task carries a second verdict beside its state:
 *
 *   deployed      the merge is in the local checkout, and (for this repo) in the code
 *                 the running panel was started from
 *   not pulled    merged upstream, absent from the checkout — `git pull`
 *   restart       pulled, but the panel process predates it — restart the panel
 *   unknown       we never recorded the branch tip, so we refuse to guess
 *
 * The evidence is the branch tip we record when the work lands (`head` on the task), and
 * ancestry is the whole test: a commit that is an ancestor of `HEAD` has been pulled, and
 * one that is an ancestor of the sha the panel booted on is running. Timestamps were the
 * obvious alternative and are worse — a pull's clock time is nowhere on the commit, and
 * comparing a commit's author date to a process start is a guess wearing a number.
 *
 * The restart half only applies to *this* repo. A merge in some other team's project has
 * no process here to be stale: pulled is as deployed as it gets. And it only applies when
 * the change touched `server/` — `web/` is served from disk on every load.
 *
 * Nothing in here is allowed to be expensive: the tasks endpoint is polled on the roster
 * beat, so answers are cached per (repo, sha) and a `deployed` is cached forever — a
 * commit cannot become un-pulled.
 */

/**
 * The checkout the running panel was started from — `server/` sits directly under it.
 * Overridable for the same reason `FOREMAN_STATE_DIR` is: a scratch server on a scratch port
 * has to be able to point this at a scratch repo, or the restart half of the verdict can
 * only ever be benched by restarting the real panel.
 */
export const PANEL_REPO =
  process.env.FOREMAN_PANEL_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Top-level directories whose code is loaded once, at boot. `web/` is not one of them. */
const RESTART_DIRS = new Set(['server']);

const git = (repo, args, opts = {}) => run('git', ['-C', repo, ...args], opts);

/** `git rev-parse` one ref, or null if the repo or the ref isn't there. */
export async function shaOf(repo, ref) {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Is `ancestor` reachable from `descendant`? `null` when git couldn't answer — a missing
 * object, a repo that isn't one — because "no" and "can't tell" must not collapse: one
 * says pull, the other says we have nothing to show.
 */
export async function isAncestor(repo, ancestor, descendant) {
  try {
    await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (err) {
    return err?.code === 1 ? false : null;
  }
}

/**
 * What a finished branch is: its tip, and the top-level directories it touched.
 *
 * Recorded while the branch still exists — after the merge and the worktree sweep it is
 * gone from this checkout, and the diff with it. `-z` rather than plain `--name-only`
 * because git quotes paths containing spaces, which is the trap `conflicts.js` already
 * pays for once.
 *
 * @param {string} repo
 * @param {{branch: string, base?: string}} opts
 * @returns {Promise<{head: string, changed: string[]}|null>}
 */
export async function branchFacts(repo, { branch, base }) {
  const head = await shaOf(repo, branch);
  if (!head) return null;
  // Both spellings of whatever base we were given, and nothing hardcoded: `main` was the
  // default here and in three other places, which made every one of them wrong on a repo
  // that calls its default branch something else. The caller detects the name
  // (`base-branch.js`); this only has to try it remote-first and then local, because a
  // task's stored `base` is `origin/main` when the fetch worked and `main` when it did not.
  const bare = bareBase(base) || 'main';
  let changed = null;
  for (const ref of [base, `origin/${bare}`, bare]) {
    if (!ref) continue;
    try {
      // `--no-renames`, and here it is the *restart* answer it protects. Rename detection
      // is on by default, so a branch that moved `server/x.js` out to `web/x.js` reports
      // only `web/x.js`, `changed` comes back `['web']`, and `needsRestart` says no — for
      // a branch that plainly removed a file from `server/`. The flag makes a rename read
      // as a delete of the old path plus an add of the new, so both directories are named.
      // It can only ever add a directory that genuinely had a file leave it, so it moves
      // this answer toward "restart" and never away from it, which is the bias the
      // `needsRestart` comment below already states. Same flag, same reason, as
      // `conflicts.js` and `merge-queue.js`.
      const { stdout } = await git(repo, ['diff', '--name-only', '--no-renames', '-z', `${ref}...${branch}`]);
      changed = [...new Set(stdout.split('\0').filter(Boolean).map((p) => p.split('/')[0]))].sort();
      break;
    } catch {
      /* base gone (a pruned origin/<base>, say) — try the next candidate */
    }
  }
  return changed ? { head, changed } : { head };
}

/**
 * Is this branch already merged into its base?
 *
 * The one question standing in front of `git branch -D`. `task_close` with outcome
 * "done" removes a worker's worktree and **force-deletes** its branch, and until this
 * existed the only thing between that and unmerged commits was a sentence in the lead's
 * brief — with no forge in the loop, nothing checked at all.
 *
 * Both spellings of the base are tried, and neither is redundant: a forge merge lands on
 * the box and this checkout's local branch lags it until somebody pulls, while a no-forge
 * merge is local and there may be no remote to have an `origin/` ref at all. The fetch is
 * best-effort for the first case — a lead that merged a PR two minutes ago and has not
 * pulled must not be refused for a stale ref — and its failure is not an answer, because
 * a forge being unreachable says nothing about whether the work merged.
 *
 * `gone: true` means the branch does not exist: there is nothing to force-delete, so
 * there is nothing to protect, and the caller should let the close through.
 *
 * @returns {Promise<{gone: boolean, merged: boolean, mergedInto: string|null, checked: string[]}>}
 */
export async function mergedInto(repo, { branch, base, doFetch = true, timeoutMs = 8000 }) {
  const head = await shaOf(repo, branch);
  if (!head) return { gone: true, merged: false, mergedInto: null, checked: [] };

  const bare = bareBase(base) || 'main';
  if (doFetch) {
    // No remote, forge down, nothing to fetch — all the same non-answer, all ignored.
    await git(repo, ['fetch', 'origin', bare], { timeout: timeoutMs }).catch(() => {});
  }

  const checked = [`origin/${bare}`, bare];
  for (const ref of checked) {
    // Strictly true: `isAncestor` answers `null` when git could not tell (a missing ref),
    // and "can't tell" must never read as "merged" in front of a force delete.
    if ((await isAncestor(repo, branch, ref)) === true) {
      return { gone: false, merged: true, mergedInto: ref, checked };
    }
  }
  return { gone: false, merged: false, mergedInto: null, checked };
}

/** Unknown beats optimistic: a change we can't describe is assumed to touch the server. */
function needsRestart(changed) {
  if (!Array.isArray(changed)) return true;
  return changed.some((d) => RESTART_DIRS.has(d));
}

const UNKNOWN = { state: 'unknown', deployed: false, label: null, why: 'No branch tip recorded for this task.' };

/**
 * @param {object} [deps] all injected so the decision table can be tested without a repo;
 *   the ancestry itself is tested against real throwaway repos.
 */
export function createDeployTracker({
  panelRepo = PANEL_REPO,
  ancestor = isAncestor,
  sha = shaOf,
  ttlMs = 20_000,
  now = Date.now,
} = {}) {
  const cache = new Map(); // `${repo}:${sha}` -> { at, value }
  const sameRepo = new Map(); // repo -> boolean

  /*
   * The sha the process was started on, read *now* — at construction, which is boot.
   *
   * This was lazy for one draft and the bench caught it inside a minute: nobody opens the
   * team panel the second the server comes up, so "first use" is minutes or hours later,
   * by which time somebody may have pulled. The lazy read then took the *post-pull* HEAD
   * as the boot sha and pronounced a stale panel deployed — the exact wrong answer, and
   * the exact case this whole file exists for.
   */
  const bootPromise = (async () => sha(panelRepo, 'HEAD'))().catch(() => null);
  const bootHead = () => bootPromise;

  /** Symlinks and cloud-sync folders make string equality unsafe; realpath both ends once. */
  function isPanelRepo(repo) {
    if (!sameRepo.has(repo)) {
      const real = (p) => {
        try {
          return fs.realpathSync(p);
        } catch {
          return path.resolve(p);
        }
      };
      sameRepo.set(repo, real(repo) === real(panelRepo));
    }
    return sameRepo.get(repo);
  }

  async function evaluate(task) {
    const pulled = await ancestor(task.repo, task.head, 'HEAD');
    if (pulled === null) return { ...UNKNOWN, why: 'The commit is not in this checkout — nothing to compare.' };
    if (!pulled) {
      return {
        state: 'unpulled',
        deployed: false,
        label: 'not pulled',
        why: 'Merged upstream, but this Mac\'s checkout does not have it yet — pull.',
      };
    }
    if (!isPanelRepo(task.repo) || !needsRestart(task.changed)) {
      return {
        state: 'deployed',
        deployed: true,
        label: 'deployed',
        why: 'Merged and pulled — live in what you are looking at.',
      };
    }
    const boot = await bootHead();
    if (!boot) return { ...UNKNOWN, why: 'Could not read the sha this panel booted on.' };
    const live = await ancestor(task.repo, task.head, boot);
    if (live === null) return { ...UNKNOWN, why: 'Could not compare against the sha this panel booted on.' };
    return live
      ? {
          state: 'deployed',
          deployed: true,
          label: 'deployed',
          why: 'Merged, pulled, and the running panel was started on it.',
        }
      : {
          state: 'restart',
          deployed: false,
          label: 'restart',
          why: 'Pulled, but this panel started before it and touches server/ — restart the panel.',
        };
  }

  /**
   * The verdict for one task. `null` for anything that isn't finished — a task still in
   * flight has nothing to be deployed.
   */
  async function status(task) {
    if (!task || task.state !== 'done' || !task.repo) return null;
    if (!task.head) return UNKNOWN;
    const key = `${task.repo}:${task.head}`;
    const hit = cache.get(key);
    // A `deployed` never expires: a pulled commit cannot leave the checkout, and a
    // running process cannot lose code it booted with. Everything else is re-asked.
    if (hit && (hit.value.state === 'deployed' || now() - hit.at < ttlMs)) return hit.value;
    const value = await evaluate(task);
    cache.set(key, { at: now(), value });
    return value;
  }

  return { status, bootHead, isPanelRepo };
}
