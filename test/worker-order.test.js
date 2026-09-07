import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderWorkers } from '../web/worker-order.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(dir, '..', p), 'utf8');

/*
 * A lead's workers are the one list in the rail that is not sorted by recency. The tests
 * below are the things that would actually cost something if that drifted: the order moving
 * when a worker is spoken to, and a row leaving the screen because the comparator met
 * something it did not expect.
 */

const worker = (task, since, extra = {}) => ({
  id: `sess-${task}`,
  team: { role: 'worker', task, branch: `agent/${task}`, state: 'working', stuck: false, since },
  ...extra,
});

const ids = (rows) => rows.map((r) => r.team?.task ?? null);

test('newest dispatch on top, whatever order the roster hands them over in', () => {
  const first = worker('alpha-one', 1_000);
  const second = worker('alpha-two', 2_000);
  const third = worker('alpha-three', 3_000);

  // The roster is recency-ordered, so any permutation is a thing that really arrives.
  assert.deepEqual(ids(orderWorkers([first, second, third])), [
    'alpha-three',
    'alpha-two',
    'alpha-one',
  ]);
  assert.deepEqual(ids(orderWorkers([second, third, first])), [
    'alpha-three',
    'alpha-two',
    'alpha-one',
  ]);
});

/*
 * The whole ask, stated as a test: speaking to the middle worker moves its `lastActivity`
 * and the roster hands it back first. Its row must not move.
 */
test('activity does not reorder them — the roster can shuffle, the block cannot', () => {
  const rows = [worker('beta-one', 1_000), worker('beta-two', 2_000), worker('beta-three', 3_000)];
  const settled = ids(orderWorkers(rows));

  // The middle one is spoken to: the roster now leads with it, and the other two follow in
  // whatever order they last moved.
  const afterAMessage = [rows[1], rows[2], rows[0]];
  assert.deepEqual(ids(orderWorkers(afterAMessage)), settled);

  // …and again, with a different one at the front.
  assert.deepEqual(ids(orderWorkers([rows[0], rows[1], rows[2]])), settled);
});

test('two dispatched in the same millisecond break on the task id, not on arrival', () => {
  const a = worker('zulu', 5_000);
  const b = worker('alpha', 5_000);
  // Both orders in, one order out — a tie broken by arrival is a tie broken by recency,
  // which is the thing this module exists to remove.
  assert.deepEqual(ids(orderWorkers([a, b])), ['alpha', 'zulu']);
  assert.deepEqual(ids(orderWorkers([b, a])), ['alpha', 'zulu']);
});

/*
 * Fail open, in the direction of still being on screen. A row the task join missed, or one
 * from a panel that predates the field, has no stamp to sort on — it goes last and it is
 * still there. A rail row that vanishes is the panel's worst failure.
 */
test('a row with no stamp sorts last and is never dropped', () => {
  const dated = worker('dated', 1_000);
  const undated = worker('undated', undefined);
  delete undated.team.since;

  const out = orderWorkers([undated, dated]);
  assert.deepEqual(ids(out), ['dated', 'undated']);
  assert.equal(out.length, 2, 'nothing left the rail');
});

test('undated rows keep the order they arrived in, among themselves', () => {
  const one = { id: 's1', team: { role: 'worker', task: 'one' } };
  const two = { id: 's2', team: { role: 'worker', task: 'two' } };
  assert.deepEqual(ids(orderWorkers([two, one])), ['two', 'one']);
  assert.deepEqual(ids(orderWorkers([one, two])), ['one', 'two']);
});

test('a stamp that is not a finite number is not a stamp', () => {
  // A string, a NaN or an ISO date would each order somewhere arbitrary if believed. They
  // read as "no stamp" and go to the end, where a reader can see there is something odd.
  for (const bad of ['1757000000000', NaN, Infinity, null, {}, '2026-09-07T00:00:00Z']) {
    const out = orderWorkers([worker('bad', bad), worker('good', 9_000)]);
    assert.deepEqual(ids(out), ['good', 'bad'], `${String(bad)} is not orderable`);
  }
});

test('it never throws, whatever it is handed', () => {
  assert.deepEqual(orderWorkers([]), []);
  assert.deepEqual(orderWorkers(null), []);
  assert.deepEqual(orderWorkers(undefined), []);
  assert.deepEqual(orderWorkers('not a list'), []);
  // A row with no `team` at all is the shape a missed join leaves behind.
  const bare = [{ id: 'x' }, null, worker('real', 1_000)];
  const out = orderWorkers(bare);
  assert.equal(out.length, 3, 'three in, three out');
  assert.equal(out[0].team.task, 'real', 'the one that can be placed goes first');
});

test('the input array is not touched', () => {
  const rows = [worker('one', 1_000), worker('two', 2_000)];
  const before = ids(rows);
  const out = orderWorkers(rows);
  assert.notEqual(out, rows, 'a new array');
  assert.deepEqual(ids(rows), before, 'the caller keeps roster order');
});

/*
 * The rule is only static because the key is. `since` comes off `dispatchedAt`, which is
 * written once, and nothing may recompute it here from something the poll can see — a key
 * derived from activity would put the old behaviour back under a function named for the new
 * one, silently and with every test above still passing.
 */
test('the sort key is read off the row and derived from nothing', () => {
  // Comments out — the paragraph above `orderWorkers` says the words `activity` and
  // `lastActivity` on purpose, to say what this must never do.
  const code = read('web/worker-order.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.match(code, /row\?\.team\?\.since/, 'the stamp comes off the row');
  assert.doesNotMatch(code, /lastActivity|Date\.now\(\)|activity/i, 'and nothing here invents one');
});

test('renderRail sorts the nested workers before it draws them', () => {
  const app = read('web/app.js');
  assert.match(app, /import \{ orderWorkers \} from '\.\/worker-order\.js'/);
  assert.match(
    app,
    /for \(const \[leadId, workers\] of nestedWorkers\) nestedWorkers\.set\(leadId, orderWorkers\(workers\)\);/,
    'the whole map is ordered once, not per `rowsFor` call',
  );
});
