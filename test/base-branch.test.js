import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Before anything imports `config.js`, which reads this once: `createWorktree` writes
// under `STATE_DIR/worktrees`, and a suite pointed at the real state dir puts scratch
// checkouts in among real workers' (CLAUDE.md — scratch state dir, every time). Same
// idiom as `gc.test.js`, and it has to sit above the imports for the same reason.
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-base-state-'));

import { bareBase, detectBaseBranch, resetBaseBranchCache, resolveBaseBranch } from '../server/base-branch.js';
import { mergedInto } from '../server/deployed.js';
import { createWorktree, removeWorktree } from '../server/worktree.js';

/*
 * Real git, throwaway repos — this whole module is a git wrapper, and stubbing git to test
 * one proves nothing. Every repo here is minted in a temp dir and thrown away.
 *
 * The case that matters is a repo whose default branch is not `main`: `main` was hardcoded
 * in four places, and a dispatch into such a repo failed with `No such base branch:
 * origin/main` and no explanation. The sandbox keeps a repo on `master` for exactly this
 * reason; this file makes the same point without needing it.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-base-'));
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo(name, branch = 'main') {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-b', branch], dir);
  git(['config', 'user.email', 'test@test'], dir);
  git(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'first'], dir);
  return dir;
}

test.before(() => resetBaseBranchCache());
test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

test('a repo with no remote is read off its own current branch', async () => {
  assert.deepEqual(
    { ...(await detectBaseBranch(repo('on-main'))) },
    { branch: 'main', reason: 'no origin/HEAD; this checkout is on main', source: 'current' },
  );
  const master = await detectBaseBranch(repo('on-master', 'master'));
  assert.equal(master.branch, 'master', 'the whole point: a repo on master is not a repo on main');
  assert.equal(master.source, 'current');
});

test('origin/HEAD wins over whatever the checkout is sitting on', async () => {
  const origin = repo('upstream', 'trunk');
  const clone = path.join(scratch, 'clone');
  git(['clone', origin, clone], scratch);
  git(['config', 'user.email', 'test@test'], clone);
  git(['config', 'user.name', 'test'], clone);
  // Sit the checkout on something else entirely — the remote's answer must still win.
  git(['checkout', '-b', 'feature/x'], clone);
  const seen = await detectBaseBranch(clone);
  assert.equal(seen.branch, 'trunk');
  assert.equal(seen.source, 'origin');
});

test('an agent branch is never a base', async () => {
  // The failure this refuses: reached through the current-branch fallback inside a
  // worktree, it would branch every future task off another task's work, silently.
  const dir = repo('worker-ish');
  git(['checkout', '-b', 'agent/some-task'], dir);
  const seen = await detectBaseBranch(dir);
  assert.equal(seen.branch, 'main');
  assert.equal(seen.source, 'guess', 'it fell through to a branch that exists, not to agent/');
});

test('a detached HEAD falls back to a branch that exists', async () => {
  const dir = repo('detached', 'master');
  const sha = git(['rev-parse', 'HEAD'], dir).trim();
  git(['checkout', sha], dir);
  const seen = await detectBaseBranch(dir);
  assert.equal(seen.branch, 'master');
  assert.equal(seen.source, 'guess');
});

test('nothing to go on says main, and says that is what it did', async () => {
  const empty = path.join(scratch, 'empty');
  fs.mkdirSync(empty);
  const seen = await detectBaseBranch(empty);
  assert.equal(seen.branch, 'main');
  assert.equal(seen.source, 'default');
  assert.match(seen.reason, /assuming main/);
});

test('the answer is cached per repo', async () => {
  resetBaseBranchCache();
  const dir = repo('cached', 'master');
  assert.equal((await resolveBaseBranch(dir)).branch, 'master');
  // Rename the branch under it: the cache is what we are proving, so a stale answer here
  // is the pass condition.
  git(['branch', '-m', 'master', 'main'], dir);
  assert.equal((await resolveBaseBranch(dir)).branch, 'master', 'cached');
  assert.equal((await resolveBaseBranch(dir, { fresh: true })).branch, 'main', 'and asked again on demand');
  resetBaseBranchCache();
});

test('`origin/main` and `main` are the same base spelled twice', () => {
  assert.equal(bareBase('origin/main'), 'main');
  assert.equal(bareBase('main'), 'main');
  assert.equal(bareBase('origin/release/2.0'), 'release/2.0');
  assert.equal(bareBase(null), '');
});

/* ------------------------------------------------ a worktree on a master repo --- */

test('a worktree cuts from the detected base, so a master repo dispatches at all', async () => {
  const dir = repo('dispatch-master', 'master');
  const wt = await createWorktree({ repo: dir, label: 'first-task' });
  assert.equal(wt.base, 'master', 'not origin/master, and not main — there is no remote here');
  assert.equal(wt.branch, 'agent/first-task');
  assert.ok(fs.existsSync(path.join(wt.dir, 'README.md')));
  const removed = await removeWorktree({ repo: dir, dir: wt.dir, branch: wt.branch });
  assert.equal(removed.branchRemoved, true, 'the sweep reports what it did, rather than swallowing it');
});

/* ------------------------------------------------------------ the close gate --- */

test('an unmerged branch is not merged, and a merged one is', async () => {
  const dir = repo('gate', 'master');
  const wt = await createWorktree({ repo: dir, label: 'gated' });
  fs.writeFileSync(path.join(wt.dir, 'new.txt'), 'work\n');
  git(['add', '.'], wt.dir);
  git(['commit', '-m', 'the work'], wt.dir);

  // No fetch: there is no remote, and a network call in a test is a flake waiting.
  const before = await mergedInto(dir, { branch: wt.branch, base: 'master', doFetch: false });
  assert.equal(before.merged, false, 'this is what stands in front of `git branch -D`');
  assert.equal(before.gone, false);
  assert.deepEqual(before.checked, ['origin/master', 'master']);

  git(['merge', '--no-ff', wt.branch, '-m', 'merge it'], dir);
  const after = await mergedInto(dir, { branch: wt.branch, base: 'master', doFetch: false });
  assert.equal(after.merged, true);
  assert.equal(after.mergedInto, 'master', 'local, because a no-forge merge has nowhere else to be');

  await removeWorktree({ repo: dir, dir: wt.dir, branch: wt.branch, force: true });
});

test('a branch that is already gone is not something to protect', async () => {
  const dir = repo('gone', 'main');
  const seen = await mergedInto(dir, { branch: 'agent/never-existed', base: 'main', doFetch: false });
  assert.equal(seen.gone, true);
  assert.equal(seen.merged, false, 'gone is not merged — the caller reads `gone`, not `merged`');
});

test('an unreadable base is refused, not assumed', async () => {
  const dir = repo('no-such-base', 'main');
  const wt = await createWorktree({ repo: dir, label: 'orphan' });
  fs.writeFileSync(path.join(wt.dir, 'x.txt'), 'x\n');
  git(['add', '.'], wt.dir);
  git(['commit', '-m', 'x'], wt.dir);
  // `trunk` does not exist here: git cannot answer, and "can't tell" must never read as
  // "merged" in front of a force delete.
  const seen = await mergedInto(dir, { branch: wt.branch, base: 'trunk', doFetch: false });
  assert.equal(seen.merged, false);
  await removeWorktree({ repo: dir, dir: wt.dir, branch: wt.branch, force: true });
});

test('a merge that landed only on the remote still counts', async () => {
  // The forge path: the PR merged on the box, and this checkout's local branch lags it
  // until somebody pulls. `origin/<base>` is the ref that knows, which is why both
  // spellings are checked.
  const upstream = path.join(scratch, 'upstream-bare');
  const work = repo('remote-merge', 'main');
  execFileSync('git', ['clone', '--bare', work, upstream], { encoding: 'utf8' });
  git(['remote', 'add', 'origin', upstream], work);
  git(['fetch', 'origin'], work);

  const wt = await createWorktree({ repo: work, label: 'landed' });
  fs.writeFileSync(path.join(wt.dir, 'r.txt'), 'r\n');
  git(['add', '.'], wt.dir);
  git(['commit', '-m', 'remote work'], wt.dir);
  git(['push', 'origin', wt.branch], wt.dir);

  // Merge it "on the forge" — in the bare repo — and do not pull.
  const merged = path.join(scratch, 'forge-side');
  execFileSync('git', ['clone', upstream, merged], { encoding: 'utf8' });
  git(['config', 'user.email', 'test@test'], merged);
  git(['config', 'user.name', 'test'], merged);
  git(['merge', '--no-ff', `origin/${wt.branch}`, '-m', 'merged on the forge'], merged);
  git(['push', 'origin', 'HEAD:main'], merged);

  const local = await mergedInto(work, { branch: wt.branch, base: 'main', doFetch: false });
  assert.equal(local.merged, false, 'local main lags — this is the state a lead closes in');

  const fetched = await mergedInto(work, { branch: wt.branch, base: 'main' });
  assert.equal(fetched.merged, true, 'the best-effort fetch is what stops a stale ref refusing a real merge');
  assert.equal(fetched.mergedInto, 'origin/main');

  await removeWorktree({ repo: work, dir: wt.dir, branch: wt.branch, force: true });
});
