import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { removeWorktree, pruneWorktrees, LOGS_DIR, WORKTREES_DIR } from './worktree.js';
import { WORKER_SETTINGS_DIR } from './dispatch.js';
import { teamDir } from './team.js';

/**
 * Worktree housekeeping at boot: `git worktree prune`, plus a GC that removes `failed`
 * worktrees older than 14 days — after posting a room line saying which, never silently.
 * A `failed` worktree is kept in the first place because it is the evidence of what went
 * wrong; fourteen days is how long that stays worth keeping.
 *
 * Boot-only, like pruneImages: the server restarts often enough, and a GC that only runs
 * while someone is around to read its room line is a feature, not a limitation.
 */

export const GC_AGE_MS = 14 * 24 * 3600_000;

const run = promisify(execFile);
const removeBranch = async (repo, branch) => {
  if (!branch) return;
  await run('git', ['-C', repo, 'branch', '-D', branch]).catch(() => {});
};

/** `git worktree prune` for every repo the task store knows. Best-effort throughout. */
export async function pruneAllWorktrees(tasks) {
  const repos = new Set(tasks.list().map((t) => t.repo).filter(Boolean));
  for (const repo of repos) await pruneWorktrees(repo).catch(() => {});
}

/**
 * Tell first, then remove: a `failed` task past the age loses its worktree, its branch
 * and the artefacts that orbit them — the settings file, the team-dir brief and mcp
 * config, the setup log. `updatedAt` on a failed task is when it failed. The task stays
 * `failed` (no new state invented); the nulled `worktree` is the idempotence guard, and
 * on a removal failure it is kept so the next boot retries.
 *
 * `groups`, when given, has the swept worktree's filing taken out with it — the folder
 * is gone from disk, so the shelf it sat on is holding nothing.
 *
 * @returns {Promise<string[]>} ids swept
 */
export async function gcFailedWorktrees({ tasks, room, groups = null, now = Date.now(), maxAgeMs = GC_AGE_MS }) {
  const swept = [];
  for (const t of tasks.list()) {
    if (t.state !== 'failed' || !t.worktree) continue;
    if (now - (t.updatedAt || 0) <= maxAgeMs) continue;
    const days = Math.round((now - t.updatedAt) / (24 * 3600_000));
    try {
      room.post(t.repo, {
        from: 'panel', to: 'lead', kind: 'system', about: t.id,
        text: `Task ${t.id} failed ${days} days ago — removing its worktree, branch and artefacts.`,
      }, { now });
    } catch {
      /* the receipt is best-effort too — a failed post must not stop the sweep */
    }
    const exists = await fsp.access(t.worktree).then(() => true, () => false);
    try {
      await removeWorktree({ repo: t.repo, dir: t.worktree, branch: t.branch, force: true });
    } catch {
      // A dir that is really there and refused to go gets retried next boot. One that
      // was deleted by hand can't be "removed" — prune cleared its bookkeeping already,
      // so just take the branch and fall through to the artefact sweep.
      if (exists) continue;
      await removeBranch(t.repo, t.branch);
    }
    // The launch artefacts, and deliberately not a planner's `plans/<id>.md`: that is
    // the work, not the scaffolding. A plan outlives the task that produced it — it is
    // the thing the lead dispatches from, and the sweep is about reclaiming a checkout.
    const orbit = [
      path.join(WORKER_SETTINGS_DIR, `${path.basename(t.repo)}-${t.id}.json`),
      path.join(teamDir(t.repo), `worker-${t.id}.brief.md`),
      path.join(teamDir(t.repo), `worker-${t.id}.mcp.json`),
      path.join(LOGS_DIR, `setup-${path.basename(t.worktree)}.log`),
    ];
    for (const f of orbit) await fsp.rm(f, { force: true }).catch(() => {});
    groups?.retireWorktree(t.worktree);
    tasks.update(t.id, { worktree: null }, { now });
    swept.push(t.id);
  }
  return swept;
}

/**
 * Filings left behind by worktrees that are already gone — and the team groups those
 * filings were the last thing holding up.
 *
 * Boot-only housekeeping for the same reason everything else here is: this is the sweep
 * that clears what shipped before `retireWorktree` existed, when a task closed, deleted
 * its checkout, and left the folder filed under a group that could never fill again.
 *
 * Two passes, because there have been two spellings and neither may be guessed at:
 *
 *  1. **What the task store knows.** Every task record keeps its `worktree` after close.
 *     A directory that is no longer there is a task that is over — its filing goes, in
 *     both spellings, whatever group it happens to be in.
 *  2. **What is unmistakably a worktree.** An absolute path under `worktrees/` that does
 *     not exist can be nothing else, so it goes even if the task record is long pruned.
 *
 * Nothing sweeps a *bare* name it cannot tie to a task, which is the guard the spec asks
 * for: a real project hand-filed into a team's group is filed by name, matches neither
 * pass, and stays exactly where it was put.
 *
 * @returns {Promise<{unfiled: string[], removed: string[]}>}
 */
export async function gcGroupFilings({ tasks, groups }) {
  if (!groups) return { unfiled: [], removed: [] };
  const gone = async (dir) => !(await fsp.access(dir).then(() => true, () => false));

  // Each retirement reaps as it goes, so the ids come back a few at a time; the trailing
  // reap is for a group that was already empty before any of this ran.
  const unfiled = [];
  const removed = [];
  const retire = (dir) => {
    const out = groups.retireWorktree(dir);
    unfiled.push(...out.unfiled);
    removed.push(...out.removed);
  };

  for (const t of tasks.list()) {
    if (!t.worktree) continue;
    if (!(await gone(t.worktree))) continue;
    retire(t.worktree);
  }

  // `list()` hands out copies, so removing a group mid-walk is safe.
  for (const g of groups.list()) {
    for (const f of g.folders) {
      if (!f.startsWith(`${WORKTREES_DIR}${path.sep}`)) continue;
      if (!(await gone(f))) continue;
      retire(f);
    }
  }

  removed.push(...groups.reap());
  return { unfiled, removed };
}
