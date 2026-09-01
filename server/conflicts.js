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
 * Everything injected, nothing on import; index.js owns the timer.
 */

async function branchPaths(repo, base, branch) {
  const paths = new Set();
  if (!base || !branch) return paths;
  const { stdout } = await git(repo, ['diff', '--name-only', `${base}...${branch}`]);
  for (const line of stdout.split('\n')) if (line.trim()) paths.add(line.trim());
  return paths;
}

async function dirtyPaths(worktree) {
  const paths = new Set();
  // -uall, or an untracked file in a new directory collapses to `?? src/` and its path
  // never matches the other worker's — measured, the test caught it.
  const { stdout } = await git(worktree, ['status', '--porcelain', '-uall']);
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // `XY path` or `XY old -> new` — a rename touches both names. Git quotes paths
    // holding spaces; strip the quotes so they compare equal to diff output.
    for (const p of line.slice(3).split(' -> ')) {
      const clean = p.trim().replace(/^"|"$/g, '');
      if (clean) paths.add(clean);
    }
  }
  return paths;
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
