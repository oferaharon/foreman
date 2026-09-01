import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PinStore } from '../server/pins.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-pins-'));
  return path.join(dir, 'pins.json');
}

test('a pin sticks, and unpinning releases it', () => {
  const p = new PinStore(tmpStore());
  assert.equal(p.set('%1', true), true);
  assert.equal(p.has('%1'), true);
  assert.equal(p.set('%1', false), true);
  assert.equal(p.has('%1'), false);
  p.stop();
});

test('setting a pin that is already set changes nothing', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { now: 100 });
  assert.equal(p.set('%1', true, { now: 900 }), false, 'no change to report');
  assert.equal(p.at('%1'), 100, 'and the original order is kept');
  assert.equal(p.set('%2', false), false, 'unpinning something unpinned is not an error');
  p.stop();
});

/*
 * The pinned group is ordered by when each pin was made, so that pinning a second session
 * never reshuffles the first. That only works if the timestamp is the one thing that
 * doesn't move.
 */
test('pins remember their order', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { now: 100 });
  p.set('%2', true, { now: 200 });
  assert.ok(p.at('%1') < p.at('%2'));
  p.stop();
});

/* ---------------------------------------------------------------- pruning --- */

test('a pane that closed takes its pin with it', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { paneCreatedMs: 500 });
  p.set('%2', true, { paneCreatedMs: 500 });
  p.prune(new Map([['%2', 500]]));
  assert.equal(p.has('%1'), false);
  assert.equal(p.has('%2'), true);
  p.stop();
});

/*
 * Same guard as the queue's, for the same reason: tmux hands out %0, %1, … afresh with
 * every new server, so an inherited pin would sit a stranger at the top of the rail.
 */
test('a pane id reused by a new tmux server does not inherit the pin', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { paneCreatedMs: 500 });
  p.prune(new Map([['%1', 9000]]));
  assert.equal(p.has('%1'), false);
  p.stop();
});

test('the same pane, still alive, keeps its pin', () => {
  const p = new PinStore(tmpStore());
  p.set('%1', true, { paneCreatedMs: 500 });
  p.prune(new Map([['%1', 500]]));
  p.prune(new Map([['%1', 500]]));
  assert.equal(p.has('%1'), true);
  p.stop();
});

/* ------------------------------------------------------------- persistence --- */

test('pins survive the process that made them', () => {
  const file = tmpStore();
  const p = new PinStore(file);
  p.set('%1', true, { now: 100, paneCreatedMs: 500 });
  p.flush();
  p.stop();

  const reopened = new PinStore(file);
  assert.equal(reopened.has('%1'), true);
  assert.equal(reopened.at('%1'), 100);
  reopened.stop();
});

test('a hand-mangled store starts clean instead of throwing', () => {
  const file = tmpStore();
  fs.writeFileSync(file, '{ not json at all');
  const p = new PinStore(file);
  assert.equal(p.has('%1'), false);
  p.stop();
});
