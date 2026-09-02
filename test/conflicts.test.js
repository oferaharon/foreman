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
const { taskPaths, createConflictScanner, parsePorcelainZ } = await import('../server/conflicts.js');

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

/*
 * Path encoding — the bug this file's `-z` change exists for.
 *
 * These build their own worktrees (`nz-a`/`nz-b`) and their own task store rather than
 * reusing wtA/wtB: the tests above mutate the shared pair in order, and a scan is over
 * *every* task in a repo, so borrowing them would make each suite's expectations depend
 * on the other's. Real git throughout, per the rule at the top.
 */

const CAFE = 'web/café.js'; // non-ASCII: quoted *and* octal-escaped by both commands
const SPACED = 'web/my file.js'; // a space: bare from diff, quoted from porcelain

async function encodingPair() {
  const a = await createWorktree({ repo, label: 'nz-a' });
  const b = await createWorktree({ repo, label: 'nz-b' });
  // a commits both paths on its branch — this is the `git diff` side.
  fs.mkdirSync(path.join(a.dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(a.dir, CAFE), 'a\n');
  fs.writeFileSync(path.join(a.dir, SPACED), 'a\n');
  git(['add', '-A'], a.dir);
  git(['commit', '-m', 'a touches both'], a.dir);
  // b leaves them uncommitted — this is the `git status --porcelain` side.
  fs.mkdirSync(path.join(b.dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(b.dir, CAFE), 'b\n');
  fs.writeFileSync(path.join(b.dir, SPACED), 'b\n');

  const tasks = new TaskStore(path.join(process.env.FOREMAN_STATE_DIR, `tasks-nz-${Math.random().toString(36).slice(2)}.json`));
  for (const [id, wt] of [['nz-a', a], ['nz-b', b]]) {
    tasks.create({ id, repo, branch: wt.branch, worktree: wt.dir, base: wt.base });
    tasks.update(id, { state: 'working' });
  }
  return { a, b, tasks };
}

test('a non-ASCII path matches across the diff and porcelain sides', async () => {
  const { a, b, tasks } = await encodingPair();

  // Both sides name the path in its real bytes — not `"web/caf\303\251.js"` from the
  // diff and `web/caf\303\251.js` from porcelain, which is how they used to differ.
  const committed = await taskPaths({ repo, base: 'main', branch: a.branch, worktree: a.dir });
  const dirty = await taskPaths({ repo, base: 'main', branch: b.branch, worktree: b.dir });
  assert.ok(committed.has(CAFE), `diff side must name ${CAFE} unescaped, got ${JSON.stringify([...committed])}`);
  assert.ok(dirty.has(CAFE), `porcelain side must name ${CAFE} unescaped, got ${JSON.stringify([...dirty])}`);

  const calls = [];
  const scanner = createConflictScanner({
    tasks,
    readTeam: () => ({ toggles: { flagConflicts: true } }),
    postConflict: (_r, info) => calls.push(info),
  });
  await scanner.scan({ now: 1 });
  assert.equal(calls.length, 1, 'two workers on the same non-ASCII path is one conflict');
  // The space case came out right before this change and is here as the regression guard:
  // quote-stripping on the porcelain side alone happened to fix it, which is exactly why
  // the non-ASCII case went unnoticed.
  assert.deepEqual(calls[0].paths, [CAFE, SPACED].sort());
});

test('parsePorcelainZ reads a rename as two fields, not two entries', async () => {
  const wt = await createWorktree({ repo, label: 'nz-rename' });
  fs.mkdirSync(path.join(wt.dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(wt.dir, 'web', 'old-name.js'), 'r\n');
  fs.writeFileSync(path.join(wt.dir, 'web', 'after.js'), 'k\n');
  git(['add', '-A'], wt.dir);
  git(['commit', '-m', 'a file to rename'], wt.dir);

  // Staged, because an *unstaged* move is not a rename to git — it comes back as two
  // ordinary entries (` D old`, `?? new`) and never exercises the second field.
  git(['mv', 'web/old-name.js', 'web/moved.js'], wt.dir);
  fs.writeFileSync(path.join(wt.dir, 'web', 'after.js'), 'edited\n'); // an entry behind it
  fs.writeFileSync(path.join(wt.dir, CAFE), 'u\n'); // and a non-ASCII one

  const raw = execFileSync('git', ['status', '--porcelain', '-uall', '-z'], { cwd: wt.dir, encoding: 'utf8' });
  assert.match(raw, /R.? web\/moved\.js\0web\/old-name\.js\0/, 'the shape this parse is written against');

  const paths = parsePorcelainZ(raw);
  assert.ok(paths.has('web/moved.js'), 'the new name');
  assert.ok(paths.has('web/old-name.js'), 'the old name — a rename touches both');
  // The trap: split on NUL and treat every field as an entry, and the original path is
  // read as a status line, `web/old-name.js` becoming the code `we` and the path
  // `/old-name.js`. Nothing on screen would say so.
  assert.ok(!paths.has('/old-name.js'), 'the original path is a field, not an entry');
  assert.ok(paths.has('web/after.js'), 'the entry after a rename is not swallowed');
  assert.ok(paths.has(CAFE), 'and non-ASCII arrives in its real bytes');

  // Exactly those four; the extra field minted nothing of its own.
  assert.deepEqual([...paths].sort(), [CAFE, 'web/after.js', 'web/moved.js', 'web/old-name.js'].sort());
});

test('parsePorcelainZ on an empty tree is empty, not a phantom path', () => {
  assert.equal(parsePorcelainZ('').size, 0);
});

/*
 * Rename detection — the *other* half of the asymmetry the `-z` work above uncovered.
 *
 * `git diff` detects renames by default, so once a worker has **committed** a move the
 * branch side names only where the file went. The porcelain side names both ends. So the
 * one case the union could not see was a committed rename colliding with a sibling still
 * editing the old name — recorded as its own task on 2026-09-01 rather than folded into
 * that fix, and this is it. Real git, real worktrees, same rule as the rest of the file.
 */

test('a committed rename collides with a sibling editing the old name', async () => {
  // The file has to exist at the base, or there is no rename for git to detect: a file
  // added and moved entirely on one branch is just an add of the new name.
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'web', 'moving.js'), 'one\ntwo\nthree\nfour\nfive\n');
  git(['add', '-A']);
  git(['commit', '-m', 'a file for one worker to move and another to edit']);

  const a = await createWorktree({ repo, label: 'rn-a' });
  const b = await createWorktree({ repo, label: 'rn-b' });

  // a commits the rename; b edits the old name and has not committed — the ordinary
  // mid-task shape, and the pair that used to overlap on nothing at all.
  git(['mv', 'web/moving.js', 'web/moved.js'], a.dir);
  git(['commit', '-m', 'move it'], a.dir);
  fs.writeFileSync(path.join(b.dir, 'web', 'moving.js'), 'b is editing this\n');

  // What the branch side would say without the flag, so the assertions below are not
  // merely asserting what git happens to do today.
  const detected = git(['diff', '--name-only', `${a.base}...${a.branch}`]).trim().split('\n');
  assert.deepEqual(detected, ['web/moved.js'], 'detection on: the old name is simply gone');

  const committed = await taskPaths({ repo, base: a.base, branch: a.branch, worktree: a.dir });
  assert.ok(committed.has('web/moved.js'), 'where it went');
  assert.ok(committed.has('web/moving.js'), 'and where it came from — a rename touches both');

  const tasks = new TaskStore(path.join(process.env.FOREMAN_STATE_DIR, `tasks-rn-${Math.random().toString(36).slice(2)}.json`));
  for (const [id, wt] of [['rn-a', a], ['rn-b', b]]) {
    tasks.create({ id, repo, branch: wt.branch, worktree: wt.dir, base: wt.base });
    tasks.update(id, { state: 'working' });
  }
  const calls = [];
  const scanner = createConflictScanner({
    tasks,
    readTeam: () => ({ toggles: { flagConflicts: true } }),
    postConflict: (_r, info) => calls.push(info),
  });
  await scanner.scan({ now: 1 });
  assert.equal(calls.length, 1, 'the committed rename and the edit of the old name are one conflict');
  assert.deepEqual(calls[0].tasks, ['rn-a', 'rn-b']);
  assert.deepEqual(calls[0].paths, ['web/moving.js'], 'named by the path they actually share');
});
