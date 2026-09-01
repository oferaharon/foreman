import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PaneLock } from '../server/claim.js';
import { parsePane } from '../server/tmux.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * A reader that answers with a *real* capture put through the *real* parser.
 *
 * Only tmux is stubbed. The thing under test is the ordering in `PaneLock#claim` and what
 * it does with a pane state, so a hand-written `{state: 'dialog'}` would prove nothing —
 * it would be asserting that the lock agrees with a shape the lock's author invented.
 * `test/fixtures/` holds what these screens actually look like.
 */
function reading(fixture) {
  const text = fs.readFileSync(path.join(FIXTURES, `${fixture}.txt`), 'utf8');
  return async () => parsePane(text);
}

const pane = (status) => ({ paneId: '%7', status });

test('a pane showing a composer takes a message', async () => {
  const lock = new PaneLock(reading('pane-idle'));
  assert.equal(await lock.claim(pane('idle')), true);
  assert.equal(lock.held('%7'), true, 'a won claim holds the pane until delivery');
});

/**
 * The bug, in one line.
 *
 * An interrupt fires no hook, so the roster goes on carrying `working` for the full
 * `STATUS_STALE_MS` while the pane sits at a composer. The old ordering asked the roster
 * first and bailed, so the live read — which exists precisely because the roster is
 * stale — could only ever veto a send, never rescue one. The message queued behind a
 * session that was plainly ready to hear it.
 */
test('a stale `working` roster does not veto a pane that is showing a composer', async () => {
  const lock = new PaneLock(reading('pane-idle'));
  assert.equal(await lock.claim(pane('working')), true);
});

test('a stale `idle` roster does not rescue a pane that is actually working', async () => {
  const lock = new PaneLock(reading('pane-working'));
  assert.equal(await lock.claim(pane('idle')), false);
  assert.equal(lock.held('%7'), false, 'a refused claim must give the pane back');
});

/*
 * The property the reorder could plausibly break, and the reason the lock exists at all:
 * nothing may be typed into a pane that is holding something. Every screen the panel has
 * a parser for, plus the two that only read as `needs-decision`.
 */
for (const [what, fixture] of [
  ['a permission prompt', 'prompt-edit'],
  ['a bash permission prompt', 'prompt-bash'],
  ['the plan-approval box', 'dialog-plan-approve'],
  ['the plan-approval box at 70 columns', 'dialog-plan-approve-narrow'],
  ['a single-select question', 'dialog-choice-single'],
  ['a multi-select question', 'dialog-choice-multi'],
  ['the /model picker', 'dialog-model'],
  ['the /model switch confirmation', 'dialog-model-confirm'],
  ['the /effort track', 'dialog-effort'],
]) {
  test(`${what} refuses a claim, whatever the roster says`, async () => {
    const lock = new PaneLock(reading(fixture));
    // `idle` is the *worst* case the roster can offer here: the hook honestly reports it,
    // because while a box is open nothing is running.
    assert.equal(await lock.claim(pane('idle')), false);
    assert.equal(lock.held('%7'), false);
  });
}

test('two callers racing one free pane produce one claim', async () => {
  let reads = 0;
  const read = reading('pane-idle');
  const lock = new PaneLock(async (id) => {
    reads += 1;
    // Yield, so the second caller lands inside the first one's read — the window the
    // claim-before-read ordering exists to close.
    await new Promise((r) => setImmediate(r));
    return read(id);
  });

  const [a, b] = await Promise.all([lock.claim(pane('idle')), lock.claim(pane('idle'))]);
  assert.deepEqual([a, b].sort(), [false, true]);
  assert.equal(reads, 1, 'the loser never even reads the pane');
});

test('a held pane refuses everything until the cooloff runs out', async () => {
  const lock = new PaneLock(reading('pane-idle'), { cooloffMs: 20 });
  assert.equal(await lock.claim(pane('idle')), true);
  assert.equal(await lock.claim(pane('idle')), false, 'still mid-delivery');

  lock.hold('%7');
  assert.equal(await lock.claim(pane('idle')), false, 'the cooloff has not run out');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(await lock.claim(pane('idle')), true);
});

test('a pane that cannot be read is not a free one', async () => {
  const lock = new PaneLock(async () => {
    throw new Error('no such pane');
  });
  assert.equal(await lock.claim(pane('idle')), false);
  assert.equal(lock.held('%7'), false);
});

test('a session with no pane is refused without touching the lock', async () => {
  const lock = new PaneLock(async () => {
    throw new Error('should never be read');
  });
  assert.equal(await lock.claim({ paneId: null, status: 'idle' }), false);
  assert.equal(await lock.claim(undefined), false);
});

test('release gives a claim back at once', async () => {
  const lock = new PaneLock(reading('pane-idle'));
  assert.equal(await lock.claim(pane('idle')), true);
  lock.release('%7');
  assert.equal(lock.held('%7'), false);
});
