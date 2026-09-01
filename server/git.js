import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * What the `claude()` wrapper in ~/.zshrc would name a session started in this folder.
 *
 * It builds `<repo>-<branch>` from git, falling back to the folder name outside a repo.
 * Knowing that default lets the binder spot a title that proves nothing: if a session's
 * label happens to equal the branch, its title is identical to every other session's in
 * that folder, and matching it is not evidence of ownership.
 *
 * Cached per directory — branches change rarely and this runs on every poll.
 */
const cache = new Map(); // cwd -> { at, value }
const TTL_MS = 60_000;

export async function defaultSessionTitle(cwd) {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value;
  try {
    const [top, branch] = await Promise.all([
      run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).then((r) => r.stdout.trim()),
      run('git', ['-C', cwd, 'branch', '--show-current']).then((r) => r.stdout.trim()),
    ]);
    value = `${path.basename(top)}-${branch || 'nobranch'}`;
  } catch {
    // Not a git repo — the wrapper uses the bare folder name there.
    value = path.basename(cwd);
  }

  cache.set(cwd, { at: Date.now(), value });
  return value;
}
