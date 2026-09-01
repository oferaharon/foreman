import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (repo, args) => run('git', ['-C', repo, ...args]);

/**
 * What a repo calls its default branch — detected, never typed.
 *
 * `main` was hardcoded in four places (`worktree.js`, `deployed.js` and two in
 * `index.js`), which made the whole team feature unusable on a repo that calls its
 * default branch anything else: `createWorktree` failed with `No such base branch:
 * origin/master` and nothing said why. A stranger's first dispatch hit it; so does the
 * sandbox's `gamma`, which is on `master` deliberately for exactly this reason.
 *
 * Same stance as the forge and the setup command: detected, cached, shown read-only in
 * the team panel, and never a box to fill in (the maintainer's ruling, 2026-08-26).
 *
 * The order of evidence, best first:
 *
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — what the *remote* says its default
 *      is. Set by `git clone`, so it is present on any ordinary checkout with a remote,
 *      and it is the only source that is right when the local checkout is sitting on a
 *      feature branch.
 *   2. the checkout's current branch — the answer for a repo with no remote at all, which
 *      is every sandbox repo and every repo somebody has not pushed yet.
 *   3. `main`, then `master`, if either exists — the fallback for a detached HEAD, where
 *      there is no current branch to read.
 *
 * Note what (2) costs and why it is still second: in a *worktree* the current branch is
 * `agent/<label>`, which is not a base. It is only reached when there is no
 * `origin/HEAD`, and the callers all pass the real checkout rather than a worktree — but
 * an `agent/` answer is refused here anyway, because being wrong about this silently
 * branches every future task off another task's work.
 */

/** Refuse a worker branch as a base: `worktree.js` mints these, and none is a default. */
const isAgentBranch = (name) => /^agent\//.test(String(name || ''));

async function refExists(repo, ref) {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{branch: string, reason: string, source: 'origin'|'current'|'guess'|'default'}>}
 *          `branch` is the bare name (`main`, `master`, `trunk`) — never `origin/`-prefixed.
 */
export async function detectBaseBranch(repo) {
  try {
    const { stdout } = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    // `origin/main` → `main`. Only the first slash: a default branch may contain more.
    const name = stdout.trim().replace(/^origin\//, '');
    if (name && !isAgentBranch(name)) {
      return { branch: name, reason: `origin says its default branch is ${name}`, source: 'origin' };
    }
  } catch {
    /* no origin/HEAD — an unpushed repo, or a clone whose symbolic ref was never set */
  }

  try {
    const { stdout } = await git(repo, ['branch', '--show-current']);
    const name = stdout.trim();
    if (name && !isAgentBranch(name)) {
      return { branch: name, reason: `no origin/HEAD; this checkout is on ${name}`, source: 'current' };
    }
  } catch {
    /* not a git repo, or a detached HEAD */
  }

  for (const guess of ['main', 'master']) {
    if (await refExists(repo, guess)) {
      return { branch: guess, reason: `nothing named a default branch; ${guess} exists here`, source: 'guess' };
    }
  }

  // Nothing to go on — say `main` and let `createWorktree` fail with a message naming the
  // branch it could not find, which is more use than a second guess here.
  return { branch: 'main', reason: 'could not work out a default branch; assuming main', source: 'default' };
}

/**
 * Cached per repo — the config endpoint is on the paint path and every dispatch asks too.
 * A default branch changes about never; a minute of staleness costs nothing.
 */
const cache = new Map(); // repo -> { at, value }
const TTL_MS = 60_000;

export async function resolveBaseBranch(repo, { fresh = false } = {}) {
  const key = String(repo || '');
  const hit = cache.get(key);
  if (hit && !fresh && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = await detectBaseBranch(repo);
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function resetBaseBranchCache() {
  cache.clear();
}

/** `origin/main` → `main`, `main` → `main`. What a stored `task.base` has to be read as. */
export const bareBase = (base) => String(base || '').replace(/^origin\//, '');
