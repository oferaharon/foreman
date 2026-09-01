import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Real git, throwaway repo — stubbing git to test a git wrapper proves nothing (the
 * worktree.test.js rule). The state dir is scratch so the worktrees land there too.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-conflicts-'));
const { createWorktree } = await import('../server/worktree.js');
const { TaskStore } = await import('../server/tasks.js');
const { taskPaths, createConflictScanner } = await import('../server/conflicts.js');

const repo = path.join(process.env.FOREMAN_STATE_DIR, 'repo');
let wtA;
let wtB;

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test.before(async () => {
  fs.mkdirSync(repo);
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-m', 'first']);
  wtA = await createWorktree({ repo, label: 'a' });
  wtB = await createWorktree({ repo, label: 'b' });
  // Worker a commits src/f.js on its branch; worker b edits the same path and has not
  // committed — the case only the porcelain side can see.
  fs.mkdirSync(path.join(wtA.dir, 'src'));
  fs.writeFileSync(path.join(wtA.dir, 'src', 'f.js'), 'a was here\n');
  git(['add', '.'], wtA.dir);
  git(['commit', '-m', 'touch f'], wtA.dir);
  fs.mkdirSync(path.join(wtB.dir, 'src'));
  fs.writeFileSync(path.join(wtB.dir, 'src', 'f.js'), 'b was here\n');
});

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

function makeTasks() {
  const tasks = new TaskStore(path.join(process.env.FOREMAN_STATE_DIR, `tasks-${Math.random().toString(36).slice(2)}.json`));
  for (const [id, wt] of [['a', wtA], ['b', wtB]]) {
    tasks.create({ id, repo, branch: wt.branch, worktree: wt.dir, base: wt.base });
    tasks.update(id, { state: 'working' });
  }
  return tasks;
}

test('taskPaths sees committed and uncommitted work alike', async () => {
  const committed = await taskPaths({ repo, base: 'main', branch: 'agent/a', worktree: wtA.dir });
  assert.ok(committed.has('src/f.js'));
  const dirty = await taskPaths({ repo, base: 'main', branch: 'agent/b', worktree: wtB.dir });
  assert.ok(dirty.has('src/f.js'), 'b never committed — porcelain is the only witness');
});

test('an overlap posts once, and the same overlap never re-posts', async () => {
  const calls = [];
  const scanner = createConflictScanner({
    tasks: makeTasks(),
    readTeam: () => ({ toggles: { flagConflicts: true } }),
    postConflict: (r, info) => calls.push({ r, ...info }),
  });
  await scanner.scan({ now: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].r, repo);
  assert.deepEqual(calls[0].tasks, ['a', 'b']);
  assert.deepEqual(calls[0].paths, ['src/f.js']);
  await scanner.scan({ now: 2 });
  assert.equal(calls.length, 1, 'dedupe: same pair, same paths');
});

test('a grown overlap is news again', async () => {
  const calls = [];
  const scanner = createConflictScanner({
    tasks: makeTasks(),
    readTeam: () => ({ toggles: { flagConflicts: true } }),
    postConflict: (_r, info) => calls.push(info),
  });
  await scanner.scan({ now: 1 });
  assert.equal(calls.length, 1);
  // Worker a commits a second shared file; b dirties it. New overlap, new key.
  fs.writeFileSync(path.join(wtA.dir, 'src', 'g.js'), 'a again\n');
  git(['add', '.'], wtA.dir);
  git(['commit', '-m', 'touch g'], wtA.dir);
  fs.writeFileSync(path.join(wtB.dir, 'src', 'g.js'), 'b again\n');
  await scanner.scan({ now: 2 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].paths, ['src/f.js', 'src/g.js']);
});

test('the flagConflicts toggle actually gates the scan', async () => {
  const calls = [];
  const scanner = createConflictScanner({
    tasks: makeTasks(),
    readTeam: () => ({ toggles: { flagConflicts: false } }),
    postConflict: (_r, info) => calls.push(info),
  });
  await scanner.scan({ now: 1 });
  assert.equal(calls.length, 0);
});

test('a vanished worktree is skipped, not fatal', async () => {
  const tasks = makeTasks();
  tasks.update('b', { worktree: path.join(process.env.FOREMAN_STATE_DIR, 'gone') });
  const calls = [];
  const scanner = createConflictScanner({
    tasks,
    readTeam: () => ({ toggles: { flagConflicts: true } }),
    postConflict: (_r, info) => calls.push(info),
  });
  await scanner.scan({ now: 1 }); // must not throw
  assert.equal(calls.length, 0, 'one readable worktree cannot conflict with itself');
});
