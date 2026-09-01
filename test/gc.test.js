import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * Real git, scratch state dir set before the imports so every derived path (worktrees,
 * worker-settings, teams, logs) lands in scratch — the module derives them at load.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-gc-'));
const { createWorktree, LOGS_DIR } = await import('../server/worktree.js');
const { WORKER_SETTINGS_DIR } = await import('../server/dispatch.js');
const { teamDir } = await import('../server/team.js');
const { TaskStore } = await import('../server/tasks.js');
const { RoomStore } = await import('../server/room.js');
const { GroupStore } = await import('../server/groups.js');
const { gcFailedWorktrees, pruneAllWorktrees, gcGroupFilings, GC_AGE_MS } = await import('../server/gc.js');

const repo = path.join(process.env.FOREMAN_STATE_DIR, 'repo');
const DAY = 24 * 3600_000;
const T0 = 1_756_200_000_000;

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
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

let n = 0;
async function failedTask({ ageDays }) {
  n += 1;
  const id = `dead-${n}`;
  const wt = await createWorktree({ repo, label: id });
  const tasks = new TaskStore(path.join(process.env.FOREMAN_STATE_DIR, `tasks-${n}.json`));
  tasks.create({ id, repo, branch: wt.branch, worktree: wt.dir, base: wt.base }, { now: T0 - ageDays * DAY });
  tasks.update(id, { state: 'failed' }, { now: T0 - ageDays * DAY });
  // The artefacts a dispatch leaves in orbit around a worktree.
  const orbit = [
    path.join(WORKER_SETTINGS_DIR, `${path.basename(repo)}-${id}.json`),
    path.join(teamDir(repo), `worker-${id}.brief.md`),
    path.join(teamDir(repo), `worker-${id}.mcp.json`),
    path.join(LOGS_DIR, `setup-${path.basename(wt.dir)}.log`),
  ];
  for (const f of orbit) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{}');
  }
  return { id, wt, tasks, orbit };
}

test('a failed task past the age is announced, swept, and stays failed', async () => {
  const { id, wt, tasks, orbit } = await failedTask({ ageDays: 15 });
  const room = new RoomStore();
  const swept = await gcFailedWorktrees({ tasks, room, now: T0 });
  assert.deepEqual(swept, [id]);
  const lines = room.read(repo).entries;
  assert.match(lines.at(-1).text, /failed 15 days ago — removing/);
  assert.ok(!fs.existsSync(wt.dir), 'worktree gone');
  assert.equal(git(['branch', '--list', wt.branch]).trim(), '', 'branch gone');
  for (const f of orbit) assert.ok(!fs.existsSync(f), `artefact gone: ${path.basename(f)}`);
  const rec = tasks.get(id);
  assert.equal(rec.state, 'failed', 'no new state invented');
  assert.equal(rec.worktree, null, 'the null is the idempotence guard');
  // Second run: nothing to say, nothing to do.
  const again = await gcFailedWorktrees({ tasks, room, now: T0 });
  assert.deepEqual(again, []);
  assert.equal(room.read(repo).entries.length, lines.length, 'no repeat receipt');
});

test('a young failure keeps its worktree — it is still evidence', async () => {
  const { id, wt, tasks } = await failedTask({ ageDays: 2 });
  const room = new RoomStore();
  assert.deepEqual(await gcFailedWorktrees({ tasks, room, now: T0 }), []);
  assert.ok(fs.existsSync(wt.dir));
  assert.equal(tasks.get(id).worktree, wt.dir);
  assert.ok(T0 - (T0 - 2 * DAY) < GC_AGE_MS, 'sanity: two days is under the default age');
});

test('a worktree already deleted by hand still gets its branch and artefacts swept', async () => {
  const { id, wt, tasks, orbit } = await failedTask({ ageDays: 20 });
  fs.rmSync(wt.dir, { recursive: true, force: true });
  await pruneAllWorktrees(tasks); // boot order: prune clears the bookkeeping first
  const room = new RoomStore();
  const swept = await gcFailedWorktrees({ tasks, room, now: T0 });
  assert.deepEqual(swept, [id]);
  assert.equal(git(['branch', '--list', wt.branch]).trim(), '', 'branch gone');
  for (const f of orbit) assert.ok(!fs.existsSync(f));
  assert.equal(tasks.get(id).worktree, null);
});

/* ------------------------------------------------------ group filings --- */

/*
 * The half that clears what shipped before any of this existed: tasks that closed, took
 * their checkout with them, and left the folder filed under a heading that could never
 * fill again. Two `· 0` groups on the maintainer's rail are exactly this.
 */

let m = 0;
function groupStore() {
  m += 1;
  return new GroupStore(path.join(process.env.FOREMAN_STATE_DIR, `groups-${m}.json`));
}

async function closedTask(label) {
  const wt = await createWorktree({ repo, label });
  const tasks = new TaskStore(path.join(process.env.FOREMAN_STATE_DIR, `tasks-c${m}-${label}.json`));
  tasks.create({ id: label, repo, branch: wt.branch, worktree: wt.dir, base: wt.base }, { now: T0 });
  tasks.update(label, { state: 'done' }, { now: T0 });
  return { tasks, wt };
}

test('a closed task’s filing goes, and the team group with it', async () => {
  const groups = groupStore();
  const { tasks, wt } = await closedTask('gone-1');
  const team = groups.create('repo', { auto: true });
  groups.assign(path.basename(wt.dir), team.id);

  // Still on disk: the task is done but nothing has removed the checkout yet.
  assert.deepEqual((await gcGroupFilings({ tasks, groups })).removed, [], 'the folder is still there');

  fs.rmSync(wt.dir, { recursive: true, force: true });
  const { unfiled, removed } = await gcGroupFilings({ tasks, groups });
  assert.deepEqual(unfiled, [path.basename(wt.dir)]);
  assert.deepEqual(removed, [team.id]);
  assert.deepEqual(groups.list(), []);
  groups.stop();
});

/* The shape actually sitting in the maintainer's groups.json: filed by absolute path, and unflagged. */
test('a legacy absolute filing is swept even with no task record left', async () => {
  const groups = groupStore();
  const tasks = new TaskStore(path.join(process.env.FOREMAN_STATE_DIR, 'tasks-orphan.json'));
  const dir = path.join(process.env.FOREMAN_STATE_DIR, 'worktrees', 'repo-long-forgotten');
  const team = groups.create('repo', { auto: true });
  groups.assign(dir, team.id);

  const { unfiled, removed } = await gcGroupFilings({ tasks, groups });
  assert.deepEqual(unfiled, [dir]);
  assert.deepEqual(removed, [team.id]);
  groups.stop();
});

test('a group you made keeps its shelf when the dead worktree on it is swept', async () => {
  const groups = groupStore();
  const { tasks, wt } = await closedTask('gone-2');
  const mine = groups.create('Tools');
  groups.assign(path.basename(wt.dir), mine.id);
  groups.assign('Foreman', mine.id);
  fs.rmSync(wt.dir, { recursive: true, force: true });

  const { removed } = await gcGroupFilings({ tasks, groups });
  assert.deepEqual(removed, [], 'yours is never reaped, empty or not');
  assert.deepEqual(groups.get(mine.id).folders, ['Foreman'], 'only the dead worktree left');
  groups.stop();
});

/* A live worker is not litter — its checkout is right there. */
test('an open task keeps its filing and its heading', async () => {
  const groups = groupStore();
  const wt = await createWorktree({ repo, label: 'still-going' });
  const tasks = new TaskStore(path.join(process.env.FOREMAN_STATE_DIR, 'tasks-live.json'));
  tasks.create({ id: 'still-going', repo, branch: wt.branch, worktree: wt.dir, base: wt.base }, { now: T0 });
  const team = groups.create('repo', { auto: true });
  groups.assign(path.basename(wt.dir), team.id);

  const { unfiled, removed } = await gcGroupFilings({ tasks, groups });
  assert.deepEqual(unfiled, []);
  assert.deepEqual(removed, []);
  assert.equal(groups.groupOf(path.basename(wt.dir)), team.id);
  groups.stop();
});

/* The other sweep, wired to the same store: what it removes, it also unfiles. */
test('the failed-worktree sweep takes the filing with it', async () => {
  const groups = groupStore();
  const { id, wt, tasks } = await failedTask({ ageDays: 30 });
  const team = groups.create('repo', { auto: true });
  groups.assign(path.basename(wt.dir), team.id);

  const swept = await gcFailedWorktrees({ tasks, room: new RoomStore(), groups, now: T0 });
  assert.deepEqual(swept, [id]);
  assert.equal(groups.groupOf(path.basename(wt.dir)), null);
  assert.deepEqual(groups.list(), [], 'the heading went with the last worktree under it');
  groups.stop();
});
