import assert from 'node:assert/strict';
import test from 'node:test';

import { asideStripFacts, roomStripFacts, foldTracks } from '../web/panel-fold.js';
import { memberRow } from '../web/rooms-pane.js';
import { unseenText } from '../web/rooms-band.js';

/*
 * The fold's shared piece, run in node the way `trust-gate.js` and `notify.js` are: three
 * pure functions over plain objects, no DOM anywhere near them.
 *
 * What is worth pinning here is not that arithmetic adds up. It is the four answers a
 * future reader is most likely to get wrong: that a zero count draws **nothing** rather
 * than a `0`, that the second team count is `review` and there is no `waiting`, that a
 * member's dot is `memberRow`'s answer and not a fourth spelling of the resolution order,
 * and that a window too narrow to hold one strip produces a clamped pair rather than a
 * negative track.
 *
 * The fixtures are the ones `test/rooms-pane.test.js` already drives `memberRow` against —
 * deliberately the same shapes, so the two files cannot come to disagree about what a
 * member or a roster row looks like — and every project named in them is a sandbox one.
 */

/* ------------------------------------------------------------ fixtures --- */

const row = (over = {}) => ({
  id: 'sess-1',
  label: 'alpha-main',
  title: 'alpha-main',
  project: 'alpha',
  paneId: '%1',
  paneCwd: '/sandbox/alpha',
  tmuxSession: 'foreman-alpha-main',
  status: 'idle',
  interactive: true,
  team: null,
  ...over,
});

const member = (over = {}) => ({
  tmuxSession: 'foreman-alpha-main',
  name: 'alpha-main',
  paneId: '%1',
  addedAt: 1,
  ...over,
});

/* ------------------------------------------------- the team aside strip --- */

test('a lead strip carries the role, the open tasks and the review count', () => {
  assert.deepEqual(asideStripFacts({ role: 'lead', tasks: 4, review: 2 }), {
    role: 'lead',
    tasks: 4,
    review: 2,
  });
});

test('zero draws nothing — both counts, not only the review one', () => {
  // The rail has room for the words `no tasks` and draws them. A 2.5rem column has room for
  // a number and nothing else, so a `0` is furniture here exactly as a `· 0` is on the row.
  assert.deepEqual(asideStripFacts({ role: 'lead', tasks: 0, review: 0 }), {
    role: 'lead',
    tasks: 0,
    review: 0,
  });
  // …and a team object that simply has no counts on it answers the same, rather than NaN.
  assert.deepEqual(asideStripFacts({ role: 'lead' }), { role: 'lead', tasks: 0, review: 0 });
});

test('the second count is `review`, and there is no `waiting`', () => {
  /*
   * The sharp one. A `waiting` count was removed on 2026-08-27 and deliberately replaced:
   * `needsYou` includes `unread > 0`, the panel viewer's own read state, so it dropped to
   * zero the moment anybody opened a worker's transcript even though nothing had been
   * handled. The ruling is that this signal comes from **task state**, and a strip that
   * reinstated `waiting` would undo it in a place nobody would look.
   */
  const facts = asideStripFacts({ role: 'lead', tasks: 3, review: 1, waiting: 9 });
  assert.equal(facts.review, 1);
  assert.equal('waiting' in facts, false, 'nothing may carry a `waiting` count out of here');
  assert.deepEqual(Object.keys(facts).sort(), ['review', 'role', 'tasks']);
});

test('a row with no team, or a team with no role, draws no strip at all', () => {
  assert.equal(asideStripFacts(null), null);
  assert.equal(asideStripFacts(undefined), null);
  assert.equal(asideStripFacts({}), null);
  assert.equal(asideStripFacts({ role: '   ' }), null);
});

test('the role is carried through rather than assumed to be `lead`', () => {
  // Only a lead has an aside today. The role travels anyway so the chip on the strip and
  // the chip on the rail row cannot come to disagree about what this session is.
  assert.equal(asideStripFacts({ role: 'worker', task: 't1' }).role, 'worker');
});

test('a count that arrived malformed reads as nothing, never as NaN on screen', () => {
  const facts = asideStripFacts({ role: 'lead', tasks: '7', review: -3 });
  assert.equal(facts.tasks, 7);
  assert.equal(facts.review, 0);
  assert.equal(asideStripFacts({ role: 'lead', tasks: null, review: undefined }).tasks, 0);
  assert.equal(asideStripFacts({ role: 'lead', tasks: 'lots' }).tasks, 0);
});

/* ------------------------------------------------------ a room's strip --- */

test('the strip names the room and one dot per member', () => {
  const sessions = [
    row(),
    row({ id: 'sess-2', label: 'beta-main', tmuxSession: 'foreman-beta-main', paneId: '%2', status: 'working' }),
  ];
  const rooms = {
    name: 'alpha ↔ beta',
    unseen: 3,
    members: [member(), member({ tmuxSession: 'foreman-beta-main', name: 'beta-main', paneId: '%2' })],
  };
  assert.deepEqual(roomStripFacts(rooms, sessions), {
    name: 'alpha ↔ beta',
    dots: ['idle', 'working'],
    unseen: '3',
  });
});

test('a member with no live row is `gone`, exactly as the open strip draws it', () => {
  const facts = roomStripFacts(
    { name: 'gamma', members: [member({ tmuxSession: 'foreman-gone', name: 'gone', paneId: '%9' })] },
    [row()],
  );
  assert.deepEqual(facts.dots, ['gone']);
});

test('the dots are `memberRow`\'s answer, rung for rung, and not a fourth spelling', () => {
  /*
   * `memberRow` mirrors `resolveMember` in `server/rooms-line.js` and
   * `test/rooms-pane.test.js` pins those two against each other. This holds the strip onto
   * the same function, so the chain is one link longer and still one implementation: a live
   * dot on a strip beside a member the fan-out will record as unreachable is the failure all
   * three tests exist to prevent.
   */
  const CASES = [
    { what: 'the tmux name answers first', m: member(), rows: [row()] },
    { what: 'a relaunched member under a new pane id', m: member({ paneId: '%9' }), rows: [row({ paneId: '%77' })] },
    {
      what: 'two panes under one tmux name need the exact pane id',
      m: member({ paneId: '%2' }),
      rows: [row(), row({ id: 'sess-2', paneId: '%2', status: 'working' })],
    },
    {
      what: 'two panes under one tmux name and no pane id declines',
      m: member({ paneId: '' }),
      rows: [row(), row({ id: 'sess-2', paneId: '%2' })],
    },
    {
      what: 'with no tmux name it takes the pane and the name together',
      m: member({ tmuxSession: '' }),
      rows: [row({ tmuxSession: 'something-else', status: 'needs-decision' })],
    },
    {
      what: 'and never the pane alone',
      m: member({ tmuxSession: '', name: 'someone-else' }),
      rows: [row({ tmuxSession: 'something-else' })],
    },
    { what: 'nothing live answers nothing', m: member(), rows: [] },
  ];
  for (const c of CASES) {
    const theirs = memberRow(c.m, c.rows);
    const expect = theirs ? theirs.status : 'gone';
    assert.deepEqual(
      roomStripFacts({ name: 'alpha', members: [c.m] }, c.rows).dots,
      [expect],
      `the strip must resolve as \`memberRow\` does — ${c.what}`,
    );
  }
});

test('a row carrying no status reads as `unknown`, never as the word undefined', () => {
  // `dot undefined` would reach the DOM as a class name, draw the default grey, and claim
  // to be a status. `unknown` is a real `.dot` class and is the honest word for it.
  const facts = roomStripFacts({ name: 'alpha', members: [member()] }, [row({ status: undefined })]);
  assert.deepEqual(facts.dots, ['unknown']);
});

test('the unseen count is `unseenText`\'s, so the strip and the rail band cannot disagree', () => {
  const one = (n) => roomStripFacts({ name: 'alpha', unseen: n, members: [] }, []).unseen;
  assert.equal(one(0), '', 'zero draws nothing');
  assert.equal(one(7), '7');
  assert.equal(one(99), '99');
  assert.equal(one(100), '99+', 'a long-quiet room must never widen the column');
  assert.equal(one(4000), unseenText(4000));
});

test('a room with nothing on it still draws something nameable', () => {
  assert.deepEqual(roomStripFacts(null), { name: 'room', dots: [], unseen: '' });
  assert.deepEqual(roomStripFacts({}, undefined), { name: 'room', dots: [], unseen: '' });
  assert.deepEqual(roomStripFacts({ name: '   ', members: 'nope' }, []).name, 'room');
});

test('the strip answers a name, counts and dots — and no shape that could carry text', () => {
  // A strip is a door, not a window. There is deliberately no field here a message body,
  // a last line or a preview could travel in.
  const facts = roomStripFacts(
    { name: 'alpha', unseen: 2, members: [member()], lastFrom: 'alpha-main', lastText: 'the whole message' },
    [row()],
  );
  assert.deepEqual(Object.keys(facts).sort(), ['dots', 'name', 'unseen']);
  assert.equal(JSON.stringify(facts).includes('the whole message'), false);
});

/* ---------------------------------------------------- the split's px --- */

test('folding `a` puts the strip on the left and gives the rest to `b`', () => {
  assert.deepEqual(foldTracks({ frameW: 1000, aW: 500, bW: 500, stripW: 40, fold: 'a' }), {
    from: [500, 500],
    to: [40, 960],
  });
});

test('folding `b` puts the strip on the right', () => {
  // A room can be in slot `a` or slot `b` — `openGroupRoom` uses the non-focused pane — so
  // both directions are real and neither is the special case.
  assert.deepEqual(foldTracks({ frameW: 1000, aW: 300, bW: 700, stripW: 40, fold: 'b' }), {
    from: [300, 700],
    to: [960, 40],
  });
});

test('the folded pair always sums to the frame', () => {
  for (const fold of ['a', 'b']) {
    for (const frameW of [1470, 1100, 879, 400]) {
      const { to } = foldTracks({ frameW, aW: frameW / 2, bW: frameW / 2, stripW: 40, fold });
      assert.equal(to[0] + to[1], frameW, `${fold} at ${frameW}`);
      assert.ok(to[0] >= 0 && to[1] >= 0);
    }
  }
});

test('a window narrower than one strip clamps rather than producing a negative track', () => {
  /*
   * What is clamped and to what: the strip track is `min(stripW, frameW)` and the other is
   * the remainder, so the strip takes the whole frame and its neighbour is `0`. Never a
   * negative track, and never a pair wider than the window it is in — a negative
   * `grid-template-columns` entry is invalid and the browser would drop the whole
   * declaration, landing the fold on whatever was there before with nothing saying so.
   */
  assert.deepEqual(foldTracks({ frameW: 30, aW: 15, bW: 15, stripW: 40, fold: 'a' }).to, [30, 0]);
  assert.deepEqual(foldTracks({ frameW: 30, aW: 15, bW: 15, stripW: 40, fold: 'b' }).to, [0, 30]);
  assert.deepEqual(foldTracks({ frameW: 0, aW: 0, bW: 0, stripW: 40, fold: 'a' }).to, [0, 0]);
});

test('the expanded pair is passed through, not renormalised to the frame', () => {
  // It is *measured*. Forcing it to sum to `frameW` would animate to a width the panes do
  // not have — this module inventing a layout rather than describing one.
  const { from } = foldTracks({ frameW: 1000, aW: 480, bW: 505, stripW: 40, fold: 'a' });
  assert.deepEqual(from, [480, 505]);
});

test('every input is read as a finite length at or above zero', () => {
  assert.deepEqual(foldTracks({ frameW: 1000, aW: -5, bW: NaN, stripW: 40, fold: 'a' }).from, [0, 0]);
  assert.deepEqual(foldTracks({ frameW: '1000', aW: '600', bW: '400', stripW: '40', fold: 'b' }), {
    from: [600, 400],
    to: [960, 40],
  });
  assert.deepEqual(foldTracks({ frameW: 1000, stripW: -40, fold: 'a' }).to, [0, 1000]);
});

test('nothing folded, and anything unrecognised, is expanded at both ends', () => {
  /*
   * The direction this feature fails in on purpose. A 2.5rem *session* pane is the worst
   * thing a fold can produce, so `null` — and a `fold` value nobody has heard of — answers
   * the expanded pair twice over: `from` and `to` are equal, which is nothing to animate.
   */
  const pair = { frameW: 1000, aW: 500, bW: 500, stripW: 40 };
  for (const fold of [null, undefined, '', 'c', 0, 'A']) {
    const { from, to } = foldTracks({ ...pair, fold });
    assert.deepEqual(from, [500, 500]);
    assert.deepEqual(to, [500, 500], `\`${String(fold)}\` must land on expanded`);
  }
  assert.deepEqual(foldTracks(), { from: [0, 0], to: [0, 0] });
});

test('a fold and its undo are the same two numbers, read the other way round', () => {
  // One pair of numbers describes both directions — a collapse runs `from → to` and an
  // expand runs `to → from` — which is what keeps a fold and its undo from being two
  // different sums, and what keeps the stored split width out of the arithmetic entirely.
  const t = foldTracks({ frameW: 1470, aW: 735, bW: 735, stripW: 40, fold: 'b' });
  assert.deepEqual(t.to, [1430, 40]);
  assert.deepEqual(t.from, [735, 735]);
  assert.equal(t.from[0] + t.from[1], 1470);
});

/* ------------------------------------------------------- the one token --- */

test('the folded width is spelled once, in `tokens.css`, and nothing else spells it', async () => {
  /*
   * `--strip` is a default, and CLAUDE.md's rule is that a default lives in `tokens.css`
   * and nowhere else — a reset *removes* a custom property, so a second spelling is a
   * default that comes apart. Both halves of the fold read this one line: the stylesheet
   * through `var(--strip)`, and `foldTracks` through the `stripW` its caller measures off a
   * node wearing it.
   *
   * The narrow claim is what is asserted: no file under `web/` other than `tokens.css` may
   * name the folded width as a literal. `web/` does hold other `2.5rem` values — a sticky
   * offset and a block's padding, both older than this feature and about other things — so
   * the test names the property rather than grepping the number blind.
   */
  const { readFile } = await import('node:fs/promises');
  const dir = new URL('../web/', import.meta.url);
  const tokens = await readFile(new URL('tokens.css', dir), 'utf8');
  const decl = [...tokens.matchAll(/--strip:\s*([^;]+);/g)];
  assert.equal(decl.length, 1, '`--strip` must be declared exactly once');
  assert.equal(decl[0][1].trim(), '2.5rem');

  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const root = new URL('.', dir).pathname;
  const tokensPath = join(root, 'tokens.css');
  const files = await readdir(root, { recursive: true, withFileTypes: true });
  for (const f of files) {
    if (!f.isFile() || !/\.(css|js|html)$/.test(f.name)) continue;
    const path = join(f.parentPath ?? f.path ?? root, f.name);
    if (path === tokensPath) continue;
    const text = await readFile(path, 'utf8');
    assert.equal(
      /--strip:/.test(text),
      false,
      `${f.name} must read \`var(--strip)\`, never re-declare it`,
    );
  }
});
