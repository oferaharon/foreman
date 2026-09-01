import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Above the import, because `config.js` reads it once: worktrees are cut under
// `STATE_DIR/worktrees`, and without this the suite puts scratch checkouts in among real
// workers' — where a failed assertion leaves one behind, registered against a repo in
// `/tmp` that the next run has already deleted. That is exactly how this line came to be
// written (CLAUDE.md: scratch state dir, every time).
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-worktree-state-'));

import { createWorktree, removeWorktree, tidyLabel } from '../server/worktree.js';

/*
 * Real git, throwaway repo. The module shells out to `git worktree`, and stubbing git to
 * test a git wrapper proves nothing — the same reasoning as the real capture-pane
 * fixtures everywhere else in this suite.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-worktree-'));
const repo = path.join(scratch, 'repo');

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test.before(() => {
  fs.mkdirSync(repo);
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-m', 'first']);
});

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

test('a label is tidied, not trusted', () => {
  assert.equal(tidyLabel('Add a search index!'), 'add-a-search-index');
  assert.equal(tidyLabel('  two   spaces  '), 'two-spaces');
  assert.equal(tidyLabel('!!!'), 'task', 'all punctuation still mints a name');
  assert.equal(tidyLabel('x'.repeat(80)).length, 40, 'capped');
  assert.equal(tidyLabel('café au lait'), 'caf-au-lait');
});

test('a worktree is created from main on its own agent branch', async () => {
  // No remote in this repo — the fetch fails and the fallback to local main is the
  // path exercised, which is also the honest one to pin: `stale` must say so.
  const wt = await createWorktree({ repo, label: 'first-task' });
  assert.ok(fs.existsSync(path.join(wt.dir, 'README.md')), 'a full checkout');
  assert.equal(wt.branch, 'agent/first-task');
  assert.equal(wt.base, 'main');
  assert.equal(wt.stale, true, 'no remote means a stale base, and it says so');

  const branch = git(['branch', '--show-current'], wt.dir).trim();
  assert.equal(branch, 'agent/first-task');

  await removeWorktree({ repo, dir: wt.dir, branch: wt.branch });
  assert.ok(!fs.existsSync(wt.dir), 'worktree gone');
  const branches = git(['branch', '--list', 'agent/first-task']).trim();
  assert.equal(branches, '', 'branch gone with it');
});

test('a second worktree with the same label is refused', async () => {
  const wt = await createWorktree({ repo, label: 'twice' });
  await assert.rejects(() => createWorktree({ repo, label: 'twice' }), /already exists/);
  await removeWorktree({ repo, dir: wt.dir, branch: wt.branch });
});

test('a repo with no main works, because the base is detected rather than assumed', async () => {
  // This test used to assert the opposite — `No such base branch: main` — and it was
  // pinning a defect: `main` was hardcoded, so the team feature was simply unusable on a
  // repo that calls its default branch anything else, with a message that never said why.
  // Now `trunk` is found and dispatched from. The refusal it used to prove is still
  // reachable and still tested, one test down: a base that genuinely does not exist.
  const bare = path.join(scratch, 'no-main');
  fs.mkdirSync(bare);
  git(['init', '-b', 'trunk'], bare);
  git(['config', 'user.email', 't@t'], bare);
  git(['config', 'user.name', 't'], bare);
  fs.writeFileSync(path.join(bare, 'a.txt'), 'x\n');
  git(['add', '.'], bare);
  git(['commit', '-m', 'first'], bare);
  const wt = await createWorktree({ repo: bare, label: 'nope' });
  assert.equal(wt.base, 'trunk');
  await removeWorktree({ repo: bare, dir: wt.dir, branch: wt.branch });
});

test('a base that does not exist still names the problem', async () => {
  const bare = path.join(scratch, 'no-main');
  await assert.rejects(
    () => createWorktree({ repo: bare, label: 'nope-2', base: 'release' }),
    /No such base branch: release/,
  );
});

test('the worktree does not contain uncommitted work from the checkout', async () => {
  // The branch-from-main decision, pinned: a dirty file in the repo must not leak into a
  // worker's copy. (In this fixture HEAD == main, so the discriminating case is dirt.)
  fs.writeFileSync(path.join(repo, 'uncommitted.txt'), 'not yours\n');
  const wt = await createWorktree({ repo, label: 'clean-base' });
  assert.ok(!fs.existsSync(path.join(wt.dir, 'uncommitted.txt')), 'dirt stayed home');
  await removeWorktree({ repo, dir: wt.dir, branch: wt.branch });
  fs.rmSync(path.join(repo, 'uncommitted.txt'));
});
