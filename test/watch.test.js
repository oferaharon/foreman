import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// RoomStore derives its paths at module load, so the scratch dir must exist first —
// same dance as test/room.test.js, and for the same reason.
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-watch-'));
const { RoomStore } = await import('../server/room.js');
const { TaskStore } = await import('../server/tasks.js');
const { MessageQueue } = await import('../server/queue.js');
const { createTeamWatch, NUDGE_MARK } = await import('../server/watch.js');

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

const T0 = 1_756_200_000_000;
const MIN = 60_000;
let n = 0;

/**
 * A harness per test: real stores on scratch files, a stub registry (it fronts tmux —
 * the one genuine stub), and a distinct repo so rooms never bleed between tests.
 */
function harness({ team = null, human = null } = {}) {
  n += 1;
  const repo = `/scratch/watch-${n}`;
  const dir = path.join(process.env.FOREMAN_STATE_DIR, `files-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const tasks = new TaskStore(path.join(dir, 'tasks.json'));
  const queue = new MessageQueue(path.join(dir, 'queue.json'));
  const room = new RoomStore();
  const rows = [
    { isLead: true, paneCwd: repo, paneId: '%L', tmuxSession: `voice-w${n}-lead`, status: 'idle' },
  ];
  const watch = createTeamWatch({
    registry: { list: () => rows },
    tasks,
    room,
    queue,
    readTeam: () => team,
    // The name in a room line is detected per repo (`human-name.js`). Injected here so
    // these tests never depend on the git identity of whatever machine runs them; the
    // default is the real reader, and `/scratch/watch-N` does not exist, so it answers
    // the fallback — which is also what a repo with no `user.name` gets.
    ...(human ? { human: () => human } : {}),
  });
  const worker = (id, state, live, kind = 'build') => {
    tasks.create({ id, repo, kind }, { now: T0 });
    tasks.update(id, { state, tmuxSession: `voice-w${n}-${id}` }, { now: T0 });
    if (live) rows.push({ tmuxSession: `voice-w${n}-${id}`, status: 'working', ...live });
    return rows[rows.length - 1];
  };
  const roomTexts = () => room.read(repo).entries.map((e) => e.text);
  const nudges = () => queue.list('%L').filter((i) => i.text.startsWith(NUDGE_MARK));
  return { repo, tasks, queue, room, rows, watch, worker, roomTexts, nudges };
}

test('dispatched → working advances the task, posts, and nudges the lead', () => {
  const h = harness();
  const live = h.worker('t1', 'dispatched', { status: 'idle' });
  h.watch.tick({ now: T0 }); // first sighting announces nothing
  assert.deepEqual(h.roomTexts(), []);
  live.status = 'working';
  h.watch.tick({ now: T0 + 5_000 });
  assert.deepEqual(h.roomTexts(), ['Worker t1 started working.']);
  assert.equal(h.tasks.get('t1').state, 'working');
  assert.equal(h.nudges().length, 1);
});

test('a question box and a bare needs-decision both read as blocked', () => {
  const h = harness();
  h.worker('q', 'working', { status: 'dialog', question: { text: 'which?' } });
  h.worker('p', 'working', { status: 'needs-decision' });
  h.watch.tick({ now: T0 });
  // Blocked is the boot-rule exception: first sighting still announces it.
  assert.deepEqual(h.roomTexts(), [
    'Worker q is blocked on a question.',
    'Worker p is blocked on a permission prompt.',
  ]);
});

test('the same status never posts twice, and unblocking posts once', () => {
  const h = harness();
  const live = h.worker('t1', 'working', { status: 'needs-decision' });
  h.watch.tick({ now: T0 });
  h.watch.tick({ now: T0 + 5_000 });
  assert.equal(h.roomTexts().length, 1);
  live.status = 'idle';
  delete live.question;
  h.watch.tick({ now: T0 + 10_000 });
  assert.deepEqual(h.roomTexts().at(-1), 'Worker t1 is unblocked and running again.');
});

test('working → idle posts unless the task is already in review', () => {
  const h = harness();
  const a = h.worker('a', 'working', { status: 'working' });
  const b = h.worker('b', 'review', { status: 'working' });
  h.watch.tick({ now: T0 });
  a.status = 'idle';
  b.status = 'idle';
  h.watch.tick({ now: T0 + 5_000 });
  assert.deepEqual(h.roomTexts(), [
    'Worker a went idle — possibly finished, and it has not reported. Check its tail.',
  ]);
});

test('a task with no live roster row is skipped entirely', () => {
  const h = harness();
  h.worker('ghost', 'working', null); // task exists, no pane
  h.watch.tick({ now: T0 });
  h.watch.tick({ now: T0 + 5_000 });
  assert.deepEqual(h.roomTexts(), []);
});

test('nudges coalesce: 60s floor, and one queued marker at a time', () => {
  const h = harness();
  h.watch.postSystem(h.repo, 't1', 'one', { now: T0 });
  h.watch.postSystem(h.repo, 't1', 'two', { now: T0 + 10_000 });
  assert.equal(h.roomTexts().length, 2, 'the room keeps every line');
  assert.equal(h.nudges().length, 1, 'the floor holds the second nudge');
  // Past the floor but the first marker is still queued — skip-if-queued.
  h.watch.postSystem(h.repo, 't1', 'three', { now: T0 + 2 * MIN });
  assert.equal(h.nudges().length, 1);
});

test('no lead in the roster means no nudge, but the room line lands', () => {
  const h = harness();
  h.rows.length = 0; // the lead is gone
  h.watch.postSystem(h.repo, 't1', 'orphan line', { now: T0 });
  assert.deepEqual(h.roomTexts(), ['orphan line']);
});

/* ------------------------------------------------------------------ stuck --- */

test('blocked past the threshold fires one alert, and only one', () => {
  const h = harness({ team: { toggles: { stuckAfterMinutes: 1 } } });
  h.worker('t1', 'working', { status: 'needs-decision' });
  h.watch.tick({ now: T0 }); // announces blocked, clock starts
  h.watch.tick({ now: T0 + 30_000 });
  assert.equal(h.roomTexts().length, 1, 'under the threshold — silence');
  h.watch.tick({ now: T0 + 61_000 });
  const texts = h.roomTexts();
  assert.equal(texts.length, 2);
  assert.match(texts[1], /blocked on a permission prompt for 1 minutes.*Surface this to the human/);
  assert.equal(h.room.read(h.repo).entries[1].alert, true);
  h.watch.tick({ now: T0 + 10 * MIN });
  assert.equal(h.roomTexts().length, 2, 'one alert per episode');
  assert.equal(h.watch.flags('t1').stuck, true);
});

test('unblock and re-block restarts the stuck clock', () => {
  const h = harness({ team: { toggles: { stuckAfterMinutes: 1 } } });
  const live = h.worker('t1', 'working', { status: 'needs-decision' });
  h.watch.tick({ now: T0 });
  h.watch.tick({ now: T0 + 61_000 }); // first stuck alert
  live.status = 'working';
  h.watch.tick({ now: T0 + 70_000 }); // unblocked
  assert.equal(h.watch.flags('t1').stuck, false, 'a state change clears the flag');
  live.status = 'needs-decision';
  h.watch.tick({ now: T0 + 80_000 }); // blocked again — new episode
  h.watch.tick({ now: T0 + 100_000 });
  assert.equal(h.roomTexts().filter((t) => /Surface this to the human/.test(t)).length, 1, 'fresh clock, not yet due');
  h.watch.tick({ now: T0 + 80_000 + 61_000 });
  assert.equal(h.roomTexts().filter((t) => /Surface this to the human/.test(t)).length, 2, 'second episode fires on its own clock');
});

test('idle-and-silent fires once; a room post from the worker restarts the clock', () => {
  const h = harness({ team: { toggles: { stuckAfterMinutes: 1 } } });
  h.worker('t1', 'working', { status: 'idle' });
  h.watch.tick({ now: T0 }); // first sighting — silent boot rule, clock starts
  // The worker speaks 30s in: not silent, clock restarts from its post.
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'still going' }, { now: T0 + 30_000 });
  h.watch.tick({ now: T0 + 61_000 });
  assert.ok(!h.roomTexts().some((t) => /idle and silent/.test(t)), 'the post reset the clock');
  h.watch.tick({ now: T0 + 30_000 + 61_000 });
  const texts = h.roomTexts();
  assert.ok(texts.some((t) => /idle and silent for 1 minutes.*Poke it once/.test(t)));
  h.watch.tick({ now: T0 + 10 * MIN });
  assert.equal(texts.filter((t) => /idle and silent/.test(t)).length, 1, 'once per episode');
});

test('a task in review never reads as idle-stuck', () => {
  const h = harness({ team: { toggles: { stuckAfterMinutes: 1 } } });
  h.worker('t1', 'review', { status: 'idle' });
  h.watch.tick({ now: T0 });
  h.watch.tick({ now: T0 + 10 * MIN });
  assert.deepEqual(h.roomTexts(), []);
});

/* ------------------------------------------------------------------- loop --- */

test('three identical posts flag a loop, once, and different text resets', () => {
  const h = harness();
  h.worker('t1', 'working', { status: 'working' });
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'running tests' }, { now: T0 });
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'running tests' }, { now: T0 + MIN });
  assert.ok(!h.roomTexts().some((t) => /looping/.test(t)), 'two is not a loop');
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'running tests' }, { now: T0 + 2 * MIN });
  const flagged = h.roomTexts().filter((t) => /may be looping/.test(t));
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /posted the same message 3 times/);
  // The flag line itself is from the panel and must not feed the streak.
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'running tests' }, { now: T0 + 3 * MIN });
  assert.equal(h.roomTexts().filter((t) => /may be looping/.test(t)).length, 1, 'flagged once per streak');
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'done now' }, { now: T0 + 4 * MIN });
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'done now' }, { now: T0 + 5 * MIN });
  h.room.post(h.repo, { from: 't1', kind: 'status', text: 'done now' }, { now: T0 + 6 * MIN });
  assert.equal(h.roomTexts().filter((t) => /may be looping/.test(t)).length, 2, 'a new streak can flag again');
});

test('lead and panel posts never count toward a streak', () => {
  const h = harness();
  h.worker('t1', 'working', { status: 'working' });
  for (const from of ['lead', 'panel']) {
    for (let i = 0; i < 4; i++) {
      h.room.post(h.repo, { from, kind: 'status', text: 'same words every time' }, { now: T0 + i * MIN });
    }
  }
  assert.ok(!h.roomTexts().some((t) => /looping/.test(t)));
});

test('a planner is called a planner in the room', () => {
  // The two want different reactions: a worker that went idle without reporting has lost
  // a branch, a planner has lost a document. A line that calls both "Worker" hides that.
  const h = harness();
  const live = h.worker('shape-it', 'dispatched', { status: 'idle' }, 'plan');
  h.watch.tick({ now: T0 });
  live.status = 'working';
  h.watch.tick({ now: T0 + MIN });
  assert.deepEqual(h.roomTexts(), ['Planner shape-it started working.']);

  live.status = 'needs-decision';
  h.watch.tick({ now: T0 + 2 * MIN });
  assert.match(h.roomTexts().at(-1), /^Planner shape-it is blocked on/);
});

/* ------------------------------------------------- who the lines name --- */

/*
 * Every line the watcher posts used to name one person. The name is detected per repo
 * now, so what is pinned is the substitution: a team whose repo has a `user.name` gets
 * that name in the stuck line and the nudge, and one with none gets "the human". A test
 * asserting a literal name would be the defect in test form.
 */
test('the detected name reaches the stuck line and the nudge', () => {
  const h = harness({ team: { toggles: { stuckAfterMinutes: 1 } }, human: 'zzq-testname' });
  h.worker('t1', 'working', { status: 'needs-decision' });
  h.watch.tick({ now: T0 });
  h.watch.tick({ now: T0 + 61_000 });
  const stuck = h.roomTexts()[1];
  assert.match(stuck, /Surface this to zzq-testname even if you could answer it/);
  assert.doesNotMatch(stuck, /the human/);
  assert.match(h.nudges()[0].text, /surface to zzq-testname only what needs them/);
});

test('with no name on the repo, the same lines read as the fallback', () => {
  const h = harness({ team: { toggles: { stuckAfterMinutes: 1 } } });
  h.worker('t1', 'working', { status: 'needs-decision' });
  h.watch.tick({ now: T0 });
  h.watch.tick({ now: T0 + 61_000 });
  assert.match(h.roomTexts()[1], /Surface this to the human even if you could answer it/);
  assert.match(h.nudges()[0].text, /surface to the human only what needs them/);
});
