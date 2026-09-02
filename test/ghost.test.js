import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseGhost, rememberGhost } from '../server/ghost.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(dir, 'fixtures', name), 'utf8');

/*
 * `ghost-*.txt` are real `capture-pane -pe` output from a scratch session in the sandbox's
 * `alpha`, escapes and all — regenerate them rather than editing them, the same rule the
 * `dialog-*` captures already carry. Two same-width scrubs were applied and nothing else: an
 * absolute path in the working capture, and the session id inside the footer's `/rc`
 * hyperlink. Neither is anywhere near the composer box these tests read.
 */

test('the wide capture yields the suggestion', () => {
  assert.equal(parseGhost(fixture('ghost-wide.txt')), 'fix slugify and add a test for it');
});

test('…and the narrow capture yields exactly the same string', () => {
  // The whole point of reading "every non-blank character after the caret is dim" rather
  // than "the first dim run": the attribute comes back re-emitted per word at some widths,
  // and a first-run read would answer `fix` on one of these two and the phrase on the other.
  assert.equal(
    parseGhost(fixture('ghost-narrow.txt')),
    parseGhost(fixture('ghost-wide.txt')),
    'both widths must spell the same suggestion',
  );
});

test('typed text is refused — the dim attribute is the whole test', () => {
  // `fix slug` typed into the composer. It reads identically to a suggestion in plain
  // `capture-pane -p` output, which is exactly why this module exists.
  assert.equal(parseGhost(fixture('ghost-typed.txt')), null);
});

test('a working session offers nothing', () => {
  assert.equal(parseGhost(fixture('ghost-working.txt')), null);
});

test('a suggestion the terminal truncated is refused, not offered short', () => {
  // Captured at 34 columns, where the same suggestion renders as
  // `fix slugify and add a test for …`. Offering that would prefill somebody's composer
  // with a literal ellipsis, and with auto-send on would send it.
  assert.equal(parseGhost(fixture('ghost-truncated.txt')), null);
});

test('plain -p output can only ever answer null', () => {
  // The documented contract for a caller that forgot the `-e`: no attributes, no answer.
  // The permission fixtures are plain captures of a session that is not even at a composer,
  // which makes them a cross-refusal too.
  const stripped = fixture('ghost-wide.txt').replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]/g, '');
  assert.equal(parseGhost(stripped), null);
  assert.equal(parseGhost(fixture('prompt-bash.txt')), null);
  assert.equal(parseGhost(fixture('dialog-model.txt')), null);
});

test('a 256-colour index of 2 is not dim', () => {
  // `38;5;2` is an ordinary green. Read one `;`-separated number at a time it looks like
  // SGR 2, and typed text would come back as a suggestion — the one false positive that
  // would put somebody's half-written message behind a send button.
  const box = [
    '\u001b[38;5;244m──────────────── alpha-main ─',
    '\u001b[39m❯\u00a0\u001b[38;5;2mfix slug',
    '\u001b[38;5;244m────────────────────────────────',
    '  alpha (main) | Fable 5.1 | ctx: 5%',
  ].join('\n');
  assert.equal(parseGhost(box), null);
});

test('an empty composer with no suggestion yields nothing', () => {
  const box = [
    '\u001b[38;5;244m──────────────── alpha-main ─',
    '\u001b[38;5;246m❯\u00a0\u001b[39m',
    '\u001b[38;5;244m────────────────────────────────',
    '  alpha (main) | Fable 5.1 | ctx: 5%',
  ].join('\n');
  assert.equal(parseGhost(box), null);
});

test('a multi-line composer is refused — a suggestion never wraps', () => {
  const box = [
    '\u001b[38;5;244m──────────────── alpha-main ─',
    '\u001b[39m❯\u00a0\u001b[2mfix slugify and',
    '\u001b[39m  \u001b[2madd a test for it',
    '\u001b[38;5;244m────────────────────────────────',
    '  alpha (main) | Fable 5.1 | ctx: 5%',
  ].join('\n');
  assert.equal(parseGhost(box), null);
});

test('trailing blank rows do not push the box out of the search window', () => {
  // A pane whose history is shorter than its height pads the capture out with them; a fresh
  // session came back with forty.
  const box = [
    '\u001b[38;5;244m──────────────── alpha-main ─',
    '\u001b[39m❯\u00a0\u001b[2mrun the tests\u001b[0m',
    '\u001b[38;5;244m────────────────────────────────',
    '  alpha (main) | Fable 5.1 | ctx: 5%',
    '  \u001b[38;5;220m⏵⏵ auto mode on',
    ...Array(40).fill(''),
  ].join('\n');
  assert.equal(parseGhost(box), 'run the tests');
});

test('nothing at all', () => {
  assert.equal(parseGhost(''), null);
  assert.equal(parseGhost(undefined), null);
});

test('rememberGhost holds a suggestion across a capture that did not come back', () => {
  const store = new Map();
  assert.equal(rememberGhost(store, '%1', { eligible: true, ghost: 'run the tests' }), 'run the tests');
  // `undefined` is a tmux hiccup, not an empty composer.
  assert.equal(rememberGhost(store, '%1', { eligible: true }), 'run the tests');
});

test('…and drops it the moment the pane stops being eligible', () => {
  const store = new Map();
  rememberGhost(store, '%1', { eligible: true, ghost: 'run the tests' });
  assert.equal(rememberGhost(store, '%1', { eligible: false }), null);
  assert.equal(store.has('%1'), false, 'a stale suggestion is a stale button');
  // And it stays gone: a later read with nothing behind it must not resurrect it.
  assert.equal(rememberGhost(store, '%1', { eligible: true }), null);
});

test('…and a read that came back empty clears it too', () => {
  const store = new Map();
  rememberGhost(store, '%1', { eligible: true, ghost: 'run the tests' });
  assert.equal(rememberGhost(store, '%1', { eligible: true, ghost: null }), null);
  assert.equal(store.has('%1'), false);
});
