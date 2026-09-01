import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MessageQueue } from '../server/queue.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-queue-'));
  return path.join(dir, 'queue.json');
}

test('messages come out in the order they went in', () => {
  const q = new MessageQueue(tmpStore());
  q.add('%1', 'first');
  q.add('%1', 'second');
  assert.deepEqual(
    q.list('%1').map((i) => i.text),
    ['first', 'second'],
  );
  assert.equal(q.due('%1').text, 'first');
  q.stop();
});

test('queues are per pane', () => {
  const q = new MessageQueue(tmpStore());
  q.add('%1', 'for one');
  q.add('%2', 'for two');
  assert.equal(q.size('%1'), 1);
  assert.equal(q.due('%2').text, 'for two');
  q.stop();
});

test('a delivered message leaves, the next one becomes due', () => {
  const q = new MessageQueue(tmpStore());
  const first = q.add('%1', 'first');
  q.add('%1', 'second');
  q.settle('%1', first.id);
  assert.equal(q.due('%1').text, 'second');
  q.stop();
});

test('dropping something you thought better of', () => {
  const q = new MessageQueue(tmpStore());
  q.add('%1', 'keep');
  const oops = q.add('%1', 'oops');
  assert.equal(q.remove('%1', oops.id), true);
  assert.equal(q.remove('%1', oops.id), false, 'removing twice is not an error, just false');
  assert.deepEqual(
    q.list('%1').map((i) => i.text),
    ['keep'],
  );
  q.stop();
});

/*
 * The point of the module: a failed send must never lose what someone typed. It backs
 * off instead, so a session that keeps refusing isn't hammered on every 2s poll.
 */
test('a failed delivery keeps the message and backs off', () => {
  const q = new MessageQueue(tmpStore());
  const item = q.add('%1', 'hello', { now: 1000 });
  q.fail('%1', item.id, 'a dialog is open', 1000);

  assert.equal(q.size('%1'), 1, 'still queued');
  assert.equal(q.due('%1', 1000), null, 'not due while backing off');
  assert.equal(q.due('%1', 9999).text, 'hello', 'due again once the backoff passes');
  assert.match(q.list('%1')[0].error, /dialog/);
  q.stop();
});

test('backoff lengthens with each failure', () => {
  const q = new MessageQueue(tmpStore());
  const item = q.add('%1', 'hello', { now: 0 });
  q.fail('%1', item.id, 'nope', 0);
  const first = q.list('%1')[0].nextTryAt;
  q.fail('%1', item.id, 'nope', 0);
  assert.ok(q.list('%1')[0].nextTryAt > first, 'a second failure waits longer than the first');
  q.stop();
});

test('the queue is capped rather than growing without limit', () => {
  const q = new MessageQueue(tmpStore());
  for (let i = 0; i < 20; i += 1) q.add('%1', `m${i}`);
  assert.throws(() => q.add('%1', 'one too many'), /20 messages waiting/);
  q.stop();
});

/* ---------------------------------------------------------------- pruning --- */

test('a pane that closed takes its queue with it', () => {
  const q = new MessageQueue(tmpStore());
  q.add('%1', 'orphan', { paneCreatedMs: 500 });
  q.add('%2', 'live', { paneCreatedMs: 500 });
  q.prune(new Map([['%2', 500]]));
  assert.equal(q.size('%1'), 0);
  assert.equal(q.size('%2'), 1);
  q.stop();
});

/*
 * tmux hands out %0, %1, … afresh with every new server, so the same id can come back
 * belonging to someone else entirely. Delivering yesterday's message into it would be
 * the worst thing this module could do.
 */
test('a pane id reused by a new tmux server does not inherit the old queue', () => {
  const q = new MessageQueue(tmpStore());
  q.add('%1', 'from before the restart', { paneCreatedMs: 500 });
  q.prune(new Map([['%1', 9000]]));
  assert.equal(q.size('%1'), 0);
  q.stop();
});

test('the same pane, still alive, keeps its queue', () => {
  const q = new MessageQueue(tmpStore());
  q.add('%1', 'still waiting', { paneCreatedMs: 500 });
  q.prune(new Map([['%1', 500]]));
  q.prune(new Map([['%1', 500]]));
  assert.equal(q.size('%1'), 1);
  q.stop();
});

/* ------------------------------------------------------------- persistence --- */

test('the queue survives the process that made it', () => {
  const file = tmpStore();
  const q = new MessageQueue(file);
  q.add('%1', 'typed before the tab closed', { paneCreatedMs: 500 });
  q.flush();
  q.stop();

  const reopened = new MessageQueue(file);
  assert.equal(reopened.due('%1').text, 'typed before the tab closed');
  reopened.stop();
});

test('a hand-mangled store starts clean instead of throwing', () => {
  const file = tmpStore();
  fs.writeFileSync(file, '{ not json at all');
  const q = new MessageQueue(file);
  assert.equal(q.size('%1'), 0);
  q.stop();
});

test('changes announce themselves so the roster can rebroadcast', () => {
  const q = new MessageQueue(tmpStore());
  let beats = 0;
  q.on('changed', () => (beats += 1));
  const item = q.add('%1', 'one');
  q.remove('%1', item.id);
  assert.equal(beats, 2);
  q.stop();
});
