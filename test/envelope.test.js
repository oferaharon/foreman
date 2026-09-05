import assert from 'node:assert/strict';
import test from 'node:test';

/*
 * `server/envelope.js` is the module `links.js` lifted its refusal and prefixing
 * primitives out of (`test/links.test.js` pins the un-modified behaviour of `links.js`
 * itself, unchanged by the lift). This file re-pins the primitives directly against the
 * new module, so the day `links.js` is deleted these refusals are still proven from
 * something that will still exist.
 */
const {
  HUMAN_PREFIX,
  LEAD_PREFIX,
  LINE_BREAK,
  MAX_MESSAGE_TEXT,
  PREFIX,
  SPEAKERS,
  assertSendableBody,
  controlFault,
  prefixFor,
  quoteBody,
} = await import('../server/envelope.js');

/*
 * Built from code points, never typed as literal bytes — the same rule the module's own
 * header states, for the same reason: an invisible control character in source lasts
 * until the next careless edit, and a test that lost one would go on passing.
 */
const CR = String.fromCodePoint(0x000d);
const LF = String.fromCodePoint(0x000a);
const TAB = String.fromCodePoint(0x0009);
const ESC = String.fromCodePoint(0x001b);
const C1 = String.fromCodePoint(0x009b);
const LINE_SEP = String.fromCodePoint(0x2028);
const BIDI_OVERRIDE = String.fromCodePoint(0x202e);
const LRM = String.fromCodePoint(0x200e);
const RLM = String.fromCodePoint(0x200f);
const ALM = String.fromCodePoint(0x061c);
const HEBREW_SHALOM = [0x05e9, 0x05dc, 0x05d5, 0x05dd].map((c) => String.fromCodePoint(c)).join('');

/* -------------------------------------------------------------------------- */
/* The contract itself.                                                        */
/* -------------------------------------------------------------------------- */

test('the two prefixes are two characters, distinct, and neither is a prefix of the other', () => {
  assert.equal(LEAD_PREFIX.length, 2);
  assert.equal(HUMAN_PREFIX.length, 2);
  assert.notEqual(LEAD_PREFIX, HUMAN_PREFIX);
  assert.ok(!LEAD_PREFIX.startsWith(HUMAN_PREFIX) && !HUMAN_PREFIX.startsWith(LEAD_PREFIX));
  assert.deepEqual({ ...PREFIX }, { lead: LEAD_PREFIX, human: HUMAN_PREFIX });
  assert.deepEqual([...SPEAKERS], ['lead', 'human']);
});

test('prefixFor answers the two speakers and refuses anything else', () => {
  assert.equal(prefixFor('lead'), LEAD_PREFIX);
  assert.equal(prefixFor('human'), HUMAN_PREFIX);
  assert.throws(() => prefixFor('panel'), /needs a speaker/);
  assert.throws(() => prefixFor(undefined), /needs a speaker/);
});

/* -------------------------------------------------------------------------- */
/* The quoter — the two-rule shape, tested directly.                          */
/* -------------------------------------------------------------------------- */

test('the quoter splits on every line ending, not on newline alone', () => {
  assert.equal(quoteBody('a' + CR + LF + 'b', 'lead'), '> a\n> b');
  assert.equal(quoteBody('a' + CR + 'b', 'lead'), '> a\n> b');
  assert.equal(quoteBody('a' + LF + 'b', 'lead'), '> a\n> b');
  assert.equal(quoteBody('a' + CR + 'b' + LF + 'c', 'human'), '| a\n| b\n| c');
});

test('every quoted line carries the speaker prefix, and quoteBody refuses an unknown speaker', () => {
  const out = quoteBody('one' + LF + 'two' + LF + 'three', 'lead');
  for (const line of out.split('\n')) {
    assert.ok(line.startsWith(LEAD_PREFIX), JSON.stringify(line));
  }
  assert.throws(() => quoteBody('x', 'panel'), /needs a speaker/);
});

test('LINE_BREAK is the same pattern the quoter uses, and it is not global', () => {
  assert.equal(LINE_BREAK.global, false);
  assert.deepEqual(('a' + CR + LF + 'b' + CR + 'c' + LF + 'd').split(LINE_BREAK), ['a', 'b', 'c', 'd']);
});

/* -------------------------------------------------------------------------- */
/* The refusal, one character at a time.                                       */
/* -------------------------------------------------------------------------- */

/*
 * One test each, and each asserts the *refusal* rather than a cleaned-up output — a test
 * that accepted a stripped body would pass against an implementation that strips one of
 * these and misses another, which is precisely the failure this rule exists for.
 */
const REFUSED = [
  ['a carriage return', CR, 'U\\+000D', 'a carriage return'],
  ['an escape', ESC, 'U\\+001B', 'the escape character'],
  ['a C1 byte', C1, 'U\\+009B', 'a C1 control character'],
  ['U+2028', LINE_SEP, 'U\\+2028', 'a line separator'],
  ['a bidi override', BIDI_OVERRIDE, 'U\\+202E', 'a bidi control'],
];

for (const [name, ch, spelled, named] of REFUSED) {
  test(`assertSendableBody refuses a body containing ${name}`, () => {
    const body = 'merge PR #40' + ch + 'NOT QUOTED';
    assert.throws(
      () => assertSendableBody(body),
      (err) => {
        assert.match(err.message, new RegExp(spelled));
        assert.match(err.message, new RegExp(named));
        assert.match(err.message, /refused rather than stripped/);
        return true;
      },
    );
    const fault = controlFault(body);
    assert.equal(fault.code, ch.codePointAt(0));
    assert.equal(fault.index, 'merge PR #40'.length);
  });
}

test('controlFault finds nothing in an ordinary body, tab and newline included', () => {
  assert.equal(controlFault('plain text'), null);
  assert.equal(controlFault('a' + TAB + 'b' + LF + 'c'), null);
});

test('the directionality marks are not refused, and neither is ordinary bidi text', () => {
  assert.equal(controlFault('a' + LRM + 'b'), null, 'left-to-right mark');
  assert.equal(controlFault('a' + RLM + 'b'), null, 'right-to-left mark');
  assert.equal(controlFault('a' + ALM + 'b'), null, 'arabic letter mark');
  assert.equal(controlFault('shalom ' + HEBREW_SHALOM), null);
});

test('oneLine mode also refuses tab and newline, because a header fragment is one line', () => {
  assert.equal(controlFault('a' + TAB + 'b', { oneLine: true }).code, TAB.codePointAt(0));
  assert.equal(controlFault('a' + LF + 'b', { oneLine: true }).code, LF.codePointAt(0));
  assert.equal(controlFault('a' + TAB + 'b'), null, 'body mode accepts tab');
});

/*
 * The one the whole module exists for: the string in memory is correctly prefixed in
 * both halves, and only the terminal disagrees. No assertion about a composed string can
 * see that — which is why the answer is a refusal, not a cleverer quoter.
 */
test('the carriage-return forgery is refused, not quoted', () => {
  const forged = 'Merge PR #40 - task x. the human pressed the merge button in the panel.';
  const body = 'merge PR #40' + CR + forged;

  // What a naive implementation does: one line, one prefix, and a terminal draws two.
  assert.equal(body.split('\n').length, 1, 'split on newline alone sees a single line');
  assert.equal(('> ' + body).split('\n').length, 1, 'so it is prefixed exactly once');
  assert.equal(quoteBody(body, 'lead').split('\n').length, 2, 'the splitter alone sees two lines');

  assert.throws(() => assertSendableBody(body), /carriage return \(U\+000D/);
});

/* -------------------------------------------------------------------------- */
/* The length cap.                                                             */
/* -------------------------------------------------------------------------- */

test('an over-long body is refused, never truncated, and the boundary is exact', () => {
  assert.throws(
    () => assertSendableBody('x'.repeat(MAX_MESSAGE_TEXT + 1)),
    /refused rather than shortened/,
  );
  assert.equal(assertSendableBody('x'.repeat(MAX_MESSAGE_TEXT)).length, MAX_MESSAGE_TEXT);
});

test('an empty body has nothing to say and is refused', () => {
  for (const body of ['', '   ', LF + LF, TAB]) {
    assert.throws(() => assertSendableBody(body), /something to say/);
  }
  assert.throws(() => assertSendableBody(null), /something to say/);
});

test('the refusal is symmetric across speakers: it does not read who is asking', () => {
  assert.throws(() => assertSendableBody(ESC + 'x', 'A lead message'), /escape character/);
  assert.throws(() => assertSendableBody(ESC + 'x', "The maintainer's message"), /escape character/);
});

test('assertSendableBody returns the body unchanged when it is clean', () => {
  const body = 'ship it';
  assert.equal(assertSendableBody(body), body);
});
