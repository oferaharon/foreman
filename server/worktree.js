import { execFile, exec } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveBaseBranch } from './base-branch.js';
import { STATE_DIR } from './config.js';

const run = promisify(execFile);
const runShell = promisify(exec);

/**
 * Worker worktrees — one isolated checkout per task.
 *
 * They live flat under `<STATE_DIR>/worktrees/<repo>-<label>/`, outside the Code
 * folder and outside any cloud-sync folder, for three reasons that all matter: a worktree
 * inside the repo can be committed by accident; one beside the repo pollutes the folder
 * the rail groups by; and a synced worktree means the sync client uploading
 * `node_modules` every time a worker installs.
 *
 * A worktree isolates *files*, not history — it shares the parent's `.git`, so a
 * force-push from inside one reaches the real repository. That protection is the worker's
 * per-session `permissions.deny`, not anything here.
 */

export const WORKTREES_DIR = path.join(STATE_DIR, 'worktrees');
export const LOGS_DIR = path.join(STATE_DIR, 'worker-logs');

const git = (repo, args) => run('git', ['-C', repo, ...args]);

/**
 * The label the lead typed, made safe for a branch, a folder and a tmux name.
 *
 * `sanitize` in launch.js is deliberately not touched — its exact behaviour is a contract
 * with the other launcher on this Mac, pinned by tests. This tidies *on top*: collapse the runs of `-` that
 * `sanitize` leaves behind (`a  b!` → `a-b-`), trim the ends, cap the length. Falls back
 * to `task` so an all-punctuation label can't mint an empty name.
 */
export function tidyLabel(raw, { max = 40 } = {}) {
  const tidy = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '');
  return tidy || 'task';
}

/**
 * Workers branch from the repo's default branch, not from whatever the checkout is
 * sitting on — team practice, decided explicitly: each PR carries only its own work.
 * Fetch first so the base is the *merged* one on the forge, not a local branch that lags
 * it; if the fetch fails (forge unreachable, no remote) fall back to the local branch and
 * say so in the result, because a task built on a stale base is a fact the reviewer wants
 * to know.
 *
 * `base` is **detected** when the caller names none (`base-branch.js`) rather than
 * defaulting to `main`. A repo on `master` or `trunk` used to fail here with
 * `No such base branch: origin/master` and no explanation — the team feature was simply
 * unusable on it.
 *
 * @param {{repo: string, label: string, base?: string}} opts
 * @returns {Promise<{dir: string, branch: string, base: string, stale: boolean}>}
 */
export async function createWorktree({ repo, label, base = null }) {
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).stdout.trim();
  const branch = `agent/${label}`;
  const dir = path.join(WORKTREES_DIR, `${path.basename(top)}-${label}`);

  if (fs.existsSync(dir)) throw new Error(`Worktree already exists: ${dir}`);

  // Detected off the top level, not off `repo` — the two differ when a caller passes a
  // subdirectory, and the default branch is a fact about the repository.
  const baseName = base || (await resolveBaseBranch(top)).branch;

  let ref = baseName;
  let stale = false;
  try {
    await git(top, ['fetch', 'origin', baseName]);
    ref = `origin/${baseName}`;
  } catch {
    stale = true; // no remote, or unreachable — the local branch it is
  }
  // Verify the ref exists before asking worktree add to guess (a repo with no `main`
  // should fail with a message naming the problem, not git's).
  await git(top, ['rev-parse', '--verify', '--quiet', ref]).catch(() => {
    throw new Error(`No such base branch: ${ref} in ${top}`);
  });

  await fsp.mkdir(WORKTREES_DIR, { recursive: true });
  await git(top, ['worktree', 'add', dir, '-b', branch, ref]);
  return { dir, branch, base: ref, stale, top };
}

/**
 * Remove a worktree and its branch. Whether a *failed* task keeps its worktree as
 * evidence is the caller's rule — this just does what it's told.
 *
 * `git branch -D` is a **force** delete: it discards commits nobody merged, and for a
 * long time the only thing standing between it and a worker's unmerged work was a
 * sentence in the lead's brief. The guard now lives in the close endpoint, which refuses
 * `outcome: 'done'` unless the branch is an ancestor of the base (`index.js`). So the
 * failure this used to swallow — `-D` refusing, or failing for any other reason — is
 * reported rather than dropped: with the gate in front of it, a failure here means the
 * branch is still on disk after the panel said it swept it.
 */
export async function removeWorktree({ repo, dir, branch, force = false }) {
  const args = ['worktree', 'remove', dir];
  if (force) args.splice(2, 0, '--force');
  await git(repo, args);
  if (!branch) return { branchRemoved: false };
  try {
    await git(repo, ['branch', '-D', branch]);
    return { branchRemoved: true };
  } catch (err) {
    // Never thrown: the worktree is already gone, so throwing here would leave the caller
    // unable to tell "nothing happened" from "half of it happened".
    return { branchRemoved: false, error: err.stderr?.trim() || err.message };
  }
}

/** Clear the bookkeeping for worktrees whose folders are already gone. Boot-time. */
export async function pruneWorktrees(repo) {
  await git(repo, ['worktree', 'prune']).catch(() => {});
}

/**
 * Run a project's setup command (`npm ci`, `swift build`, …) in a fresh worktree so a
 * worker's first act isn't discovering it can't run the tests. Output goes to a log file
 * rather than the response — setup on a heavy repo takes minutes and nobody should be
 * holding an HTTP request open for it.
 *
 * Shell syntax is allowed (it's the user's own setup line, same trust as the panel
 * itself), but it runs in the worktree with a hard timeout.
 */
export async function runSetup(dir, cmd, { timeoutMs = 10 * 60_000, log = null } = {}) {
  if (!cmd) return { ok: true, skipped: true };
  await fsp.mkdir(LOGS_DIR, { recursive: true });
  const logFile = log || path.join(LOGS_DIR, `setup-${path.basename(dir)}.log`);
  try {
    const { stdout, stderr } = await runShell(cmd, {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    await fsp.writeFile(logFile, `$ ${cmd}\n${stdout}\n${stderr}`);
    return { ok: true, logFile };
  } catch (err) {
    await fsp.writeFile(logFile, `$ ${cmd}\nFAILED: ${err.message}\n${err.stdout || ''}\n${err.stderr || ''}`).catch(() => {});
    return { ok: false, logFile, error: err.message };
  }
}
