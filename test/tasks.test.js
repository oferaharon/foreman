import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TaskStore, TASK_KINDS, TASK_STATES, OPEN_STATES, DEFAULT_TASK_KIND } from '../server/tasks.js';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-tasks-'));
const file = (n) => path.join(scratch, `${n}.json`);

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('a task is created queued and advances through its states', () => {
  const store = new TaskStore(file('crud'));
  const t = store.create({ id: 'fix-the-thing', repo: '/x/Repo', body: 'Fix it.' });
  assert.equal(t.state, 'queued');
  assert.equal(store.get('fix-the-thing').body, 'Fix it.');

  store.update('fix-the-thing', { state: 'dispatched', tmuxSession: 'voice-repo-fix-the-thing', pane: '%9' });
  assert.equal(store.get('fix-the-thing').state, 'dispatched');
  assert.ok(store.get('fix-the-thing').dispatchedAt, 'dispatch is stamped');

  assert.throws(() => store.update('fix-the-thing', { state: 'levitating' }), /No such state/);
  assert.throws(() => store.create({ id: 'fix-the-thing', repo: '/x' }), /already exists/);
  store.stop();
});

test('the store survives a restart', () => {
  const f = file('persist');
  const a = new TaskStore(f);
  a.create({ id: 'one', repo: '/x/Repo', body: 'a' });
  a.update('one', { state: 'working' });
  a.stop(); // flushes

  const b = new TaskStore(f);
  assert.equal(b.get('one').state, 'working');
  b.stop();
});

test('the cap counts only active tasks', () => {
  const store = new TaskStore(file('active'));
  store.create({ id: 'a', repo: '/x/Repo' });
  store.create({ id: 'b', repo: '/x/Repo' });
  store.create({ id: 'c', repo: '/y/Other' });
  store.update('a', { state: 'done' });
  assert.deepEqual(store.active('/x/Repo').map((t) => t.id), ['b']);
  assert.deepEqual(store.active('/y/Other').map((t) => t.id), ['c']);
  store.stop();
});

test('a vanished session fails its task and keeps the record', () => {
  const store = new TaskStore(file('prune'));
  store.create({ id: 'gone', repo: '/x/Repo' });
  store.update('gone', { state: 'working', tmuxSession: 'voice-repo-gone' });
  store.create({ id: 'alive', repo: '/x/Repo' });
  store.update('alive', { state: 'working', tmuxSession: 'voice-repo-alive' });
  store.create({ id: 'never-sent', repo: '/x/Repo' }); // queued, no session — not prunable

  const failed = store.prune(new Set(['voice-repo-alive']));
  assert.deepEqual(failed, ['gone']);
  assert.equal(store.get('gone').state, 'failed', 'marked, not deleted');
  assert.equal(store.get('alive').state, 'working');
  assert.equal(store.get('never-sent').state, 'queued');

  // A failed task does not fail twice.
  assert.deepEqual(store.prune(new Set(['voice-repo-alive'])), []);
  store.stop();
});

test('a task is a build task unless it says otherwise', () => {
  const store = new TaskStore(file('kinds'));
  assert.equal(store.create({ id: 'ordinary', repo: '/x/Repo', body: 'Fix it.' }).kind, 'build');
  assert.equal(DEFAULT_TASK_KIND, 'build');

  const planner = store.create({
    id: 'shape-it', repo: '/x/Repo', body: 'Plan it.', kind: 'plan',
    planFile: '/state/teams/x-Repo/plans/shape-it.md',
  });
  assert.equal(planner.kind, 'plan');
  assert.equal(planner.planFile, '/state/teams/x-Repo/plans/shape-it.md');
  assert.equal(store.get('ordinary').planFile, null, 'a builder has no plan file');

  // The kind decides a permission stance, so an unknown one must fail the dispatch
  // rather than fall through to whatever `build` happens to mean.
  assert.throws(() => store.create({ id: 'nonsense', repo: '/x/Repo', kind: 'design' }), /No such task kind/);
  assert.deepEqual(TASK_KINDS, ['build', 'plan']);
  store.stop();
});

test('a task written before kinds existed reads as a build task', () => {
  // The field is additive: nothing migrates tasks.json, so an old record has to answer
  // `build` rather than let `undefined` decide something at dispatch or close.
  const f = file('legacy');
  fs.writeFileSync(f, JSON.stringify({
    old: { id: 'old', repo: '/x/Repo', body: 'from before', state: 'review', branch: 'agent/old' },
  }));
  const store = new TaskStore(f);
  assert.equal(store.get('old').kind, 'build');
  store.stop();
});

/*
 * A pending task is a task record with a brief and nothing else — no session, no branch,
 * no worktree, no cost. It is the rung between "an idea in the lead's head" and a running
 * worker, and every one of the tests below guards a way it could quietly stop being free.
 */

test('a pending task does not count against the cap', () => {
  // `active()` is what `server/index.js` checks against `maxWorkers`, so a `pending` that
  // leaked into `ACTIVE` would let three recorded ideas fill a default team's cap and
  // refuse every dispatch — with no worker running at all, and nothing on screen saying
  // why. This is the trap most likely to brick the feature.
  const store = new TaskStore(file('pending-cap'));
  for (const id of ['idea-a', 'idea-b', 'idea-c']) {
    assert.equal(store.create({ id, repo: '/x/Repo', body: 'later', state: 'pending' }).state, 'pending');
  }
  store.create({ id: 'in-flight', repo: '/x/Repo', body: 'now' });
  store.update('in-flight', { state: 'working', tmuxSession: 'voice-repo-in-flight' });

  assert.deepEqual(store.active('/x/Repo').map((t) => t.id), ['in-flight']);
  assert.equal(store.list('/x/Repo').length, 4, 'all four are on the board, one is running');
  store.stop();
});

test('a pending task is not an open task', () => {
  // `OPEN_STATES` is the other set, and it answers a different question: is a live session
  // on a ticket? A pending task has no session to be on one. The companion half — that
  // `openTaskFor` says so too — is in test/sessions.test.js, where it lives.
  assert.equal(OPEN_STATES.has('pending'), false);
  assert.deepEqual(TASK_STATES[0], 'pending', 'first in the array, so it reads as the lifecycle');
});

test('promotion keeps the record', () => {
  // The whole point of recording an idea early is that the brief you wrote while you knew
  // most about it is the brief the worker gets. Promotion is an `update`, not a second
  // `create` — `create` throws on a duplicate id, and would reset the clock if it didn't.
  const store = new TaskStore(file('pending-promote'));
  const born = store.create({
    id: 'search-index', repo: '/x/Repo', body: 'The brief, written while it was cheap.',
    state: 'pending', model: 'claude-sonnet-5', modelReason: 'Mechanical, well-specified.',
  }, { now: 1000 });
  assert.equal(born.dispatchedAt, null);
  assert.equal(born.startedBy, null, 'nothing has said "start it" yet');

  const promoted = store.update('search-index', {
    state: 'dispatched', branch: 'agent/search-index', tmuxSession: 'voice-repo-search-index',
  }, { now: 5000 });
  assert.equal(promoted.createdAt, 1000, 'the record is the same record');
  assert.equal(promoted.dispatchedAt, 5000, 'dispatch is stamped at promotion');
  assert.equal(promoted.body, 'The brief, written while it was cheap.');
  assert.equal(promoted.modelReason, 'Mechanical, well-specified.', 'the why survives to the dispatch');
  store.stop();
});

test('a state the store does not know fails at the store', () => {
  const store = new TaskStore(file('pending-bad-state'));
  assert.throws(() => store.create({ id: 'nope', repo: '/x/Repo', state: 'planned' }), /No such state/);
  assert.equal(store.get('nope'), null, 'nothing was written');
  assert.equal(store.create({ id: 'ordinary', repo: '/x/Repo' }).state, 'queued', 'the default is unchanged');
  store.stop();
});

test('a task written before pending existed answers null for its new fields', () => {
  // Additive, like `kind`: nothing migrates tasks.json, so an old record has to say `null`
  // rather than `undefined` — the room line at promotion reads `modelReason` directly.
  const f = file('pending-legacy');
  fs.writeFileSync(f, JSON.stringify({
    old: { id: 'old', repo: '/x/Repo', body: 'from before', state: 'review', branch: 'agent/old' },
  }));
  const store = new TaskStore(f);
  assert.equal(store.get('old').modelReason, null);
  assert.equal(store.get('old').startedBy, null);
  store.stop();
});

/*
 * Tags — one word from `web/task-tags.js` saying what the task is, for its whole life.
 * The store is where a bad set has to fail, and where two things that look like tidiness
 * would quietly break the feature: `create` building its record field by field, and
 * `updatedAt` moving on a retag.
 */

test('create keeps a valid tag, refuses a bad set, and an omitted one is untagged', () => {
  const store = new TaskStore(file('tags-create'));
  // `create` builds the record from a fixed list of fields, so a `tags` it did not carry
  // would vanish without a word — and the call would still look as though it worked.
  assert.deepEqual(store.create({ id: 'tagged', repo: '/x/Repo', tags: ['feature'] }).tags, ['feature']);
  assert.deepEqual(store.create({ id: 'untagged', repo: '/x/Repo' }).tags, []);

  for (const bad of [[], ['bug', 'chore'], ['blocked'], 'bug', null]) {
    assert.throws(
      () => store.create({ id: 'refused', repo: '/x/Repo', tags: bad }),
      /bug, feature, research or chore/,
      JSON.stringify(bad),
    );
    assert.equal(store.get('refused'), null, 'nothing was written');
  }
  store.stop();
});

test('a task written before tags existed reads as untagged', () => {
  const f = file('tags-legacy');
  fs.writeFileSync(f, JSON.stringify({
    old: { id: 'old', repo: '/x/Repo', body: 'from before', state: 'done', branch: 'agent/old' },
  }));
  const store = new TaskStore(f);
  assert.deepEqual(store.get('old').tags, []);
  store.stop();
});

test('update validates tags, so the general path cannot write what setTags would refuse', () => {
  const store = new TaskStore(file('tags-update'));
  store.create({ id: 't', repo: '/x/Repo', tags: ['bug'] });
  assert.throws(() => store.update('t', { tags: ['nonsense'] }), /No such tag/);
  assert.throws(() => store.update('t', { tags: undefined }), /a list holding exactly one/, 'an explicit undefined is a write');
  assert.deepEqual(store.get('t').tags, ['bug'], 'a refused patch changed nothing');
  assert.deepEqual(store.update('t', { tags: ['chore'] }).tags, ['chore']);
  // A patch that does not mention tags leaves them alone — the promotion path relies on it.
  assert.deepEqual(store.update('t', { state: 'working' }).tags, ['chore']);
  store.stop();
});

test('setTags retags any state and leaves updatedAt alone', () => {
  const store = new TaskStore(file('tags-set'));
  store.create({ id: 'old-news', repo: '/x/Repo', tags: ['bug'] }, { now: 1000 });
  store.update('old-news', { state: 'done' }, { now: 2000 });

  // Both task lists sort on `updatedAt`, so a retag that moved it would jump the row the
  // maintainer just clicked to the top of its tier — and put a month-old task back in the
  // lead's recent list.
  const rec = store.setTags('old-news', ['research']);
  assert.deepEqual(rec.tags, ['research']);
  assert.equal(rec.updatedAt, 2000, 'unchanged by a retag');
  assert.equal(rec.state, 'done', 'a done task may be retagged');

  assert.throws(() => store.setTags('old-news', ['research', 'chore']), /exactly one tag/);
  assert.deepEqual(store.get('old-news').tags, ['research']);
  assert.equal(store.setTags('no-such-task', ['bug']), null);

  const input = ['feature'];
  store.setTags('old-news', input);
  input.push('chore');
  assert.deepEqual(store.get('old-news').tags, ['feature'], 'the caller’s array is not the stored one');
  store.stop();
});

test('a retag survives a restart', () => {
  const f = file('tags-persist');
  const a = new TaskStore(f);
  a.create({ id: 'one', repo: '/x/Repo', tags: ['bug'] });
  a.setTags('one', ['chore']);
  a.stop(); // flushes — `setTags` marked the store dirty

  const b = new TaskStore(f);
  assert.deepEqual(b.get('one').tags, ['chore']);
  b.stop();
});

test('a field the store has never heard of survives load and flush', () => {
  // The rollback guarantee. Unlike `GroupStore` and `PinStore`, `#load` spreads the stored
  // record, so a field a later build wrote rides through an older one untouched — which is
  // what lets a rollback past tags lose none, and a second tag group join the same array
  // later. The price is that a bad value is kept just as faithfully, so readers go through
  // `readTags`; the store does not "clean" it.
  const f = file('tags-unknown-field');
  fs.writeFileSync(f, JSON.stringify({
    later: {
      id: 'later', repo: '/x/Repo', body: 'from a later build', state: 'pending',
      tags: ['bug', 'blocked'], futureField: { nested: [1, 2] },
    },
    junk: { id: 'junk', repo: '/x/Repo', body: 'hand-edited', state: 'done', tags: ['nonsense'] },
  }));
  const a = new TaskStore(f);
  assert.deepEqual(a.get('later').futureField, { nested: [1, 2] });
  assert.deepEqual(a.get('later').tags, ['bug', 'blocked']);
  a.update('later', { state: 'abandoned' }); // dirty, so the next flush rewrites the file
  a.stop();

  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(onDisk.later.futureField, { nested: [1, 2] });
  assert.deepEqual(onDisk.later.tags, ['bug', 'blocked']);
  assert.deepEqual(onDisk.junk.tags, ['nonsense'], 'kept verbatim — the reader drops it, the store does not');
  assert.equal(onDisk.later.state, 'abandoned');
});
