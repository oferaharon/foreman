import assert from 'node:assert/strict';
import test from 'node:test';

import { colourFor, PEER_COLOUR_COUNT } from '../web/session-colour.js';

/*
 * `colourFor` is the shared room's whole colour story: a session name folds to a slot in
 * the `--peer-N` ring, `tokens.css` paints that slot, and nothing else in this repo may
 * derive a peer's colour a second way. Pinned here in isolation, `quota.js`'s style, so a
 * future change to the hash can't drift from what the CSS ring actually has room for.
 *
 * Names below are shaped like real session names (`<repo>-<branch>`, a worker's
 * `<repo>-issue-N-<slug>`, a lead's `<repo>-lead`) but built only from the sandbox project
 * names this repo is allowed to write down — `alpha`, `beta`, `gamma` — never a real one.
 */

const REAL_SHAPED_NAMES = [
  'alpha-main', 'alpha-dev', 'alpha-feature-login', 'alpha-hotfix-1', 'alpha-worker-2',
  'beta-main', 'beta-release', 'beta-issue-7-fix-flag', 'beta-scratch', 'beta-lead',
  'gamma-master', 'gamma-main', 'gamma-release-2', 'gamma-worker-3', 'gamma-hotfix',
  'alpha-beta-bridge', 'sandbox-alpha', 'sandbox-beta-2', 'scratch-gamma', 'alpha-main-2',
];

test('PEER_COLOUR_COUNT is 7 — the ring tokens.css actually defines', () => {
  assert.equal(PEER_COLOUR_COUNT, 7);
});

test('every slot is in range 1..N, never 0 and never N+1', () => {
  for (const name of REAL_SHAPED_NAMES) {
    const slot = colourFor(name);
    assert.ok(Number.isInteger(slot), `${name} -> ${slot} is not an integer`);
    assert.ok(slot >= 1 && slot <= PEER_COLOUR_COUNT, `${name} -> ${slot} out of range`);
  }
});

test('deterministic: the same name always folds to the same slot', () => {
  for (const name of REAL_SHAPED_NAMES) {
    const first = colourFor(name);
    for (let i = 0; i < 5; i++) assert.equal(colourFor(name), first);
  }
});

test('stable across "restarts" — no process-local state, a fresh call answers the same', () => {
  // colourFor takes nothing but the name, so "restart" here is just calling it again with
  // no shared state touched in between — the only way this module could ever answer
  // differently is if it secretly depended on something other than its argument.
  assert.equal(colourFor('alpha-main'), colourFor('alpha-main'));
  assert.equal(colourFor('gamma-worker-3'), colourFor('gamma-worker-3'));
});

test('two names that collide on the wrapper\'s <repo>-<branch> fallback still get one colour each, consistently', () => {
  // Not a bug: CLAUDE.md's own first trap is that a launcher can mint identical titles for
  // different sessions. A colour is not an identity — the entry's resolved identity is
  // stored separately (plan §6) — so two same-named sessions sharing a pill colour is the
  // documented cost, not a defect this test should catch.
  const a = colourFor('gamma-main');
  const b = colourFor('gamma-main');
  assert.equal(a, b);
});

test('~20 real-shaped names spread across the ring rather than piling on one or two slots', () => {
  const counts = new Array(PEER_COLOUR_COUNT + 1).fill(0);
  for (const name of REAL_SHAPED_NAMES) counts[colourFor(name)]++;

  const usedSlots = counts.filter((n) => n > 0).length;
  assert.ok(usedSlots >= 5, `only ${usedSlots}/${PEER_COLOUR_COUNT} slots used across 20 names`);

  const maxInOneSlot = Math.max(...counts.slice(1));
  assert.ok(
    maxInOneSlot <= 6,
    `slot piling: ${maxInOneSlot} of ${REAL_SHAPED_NAMES.length} names landed on one slot`
  );
});

test('a non-string or empty name answers a valid slot rather than throwing', () => {
  for (const bad of [undefined, null, 0, {}, [], '']) {
    const slot = colourFor(bad);
    assert.ok(slot >= 1 && slot <= PEER_COLOUR_COUNT, `colourFor(${JSON.stringify(bad)}) -> ${slot}`);
  }
});

test('single-character names still resolve without throwing', () => {
  for (const name of ['a', 'b', 'z']) {
    const slot = colourFor(name);
    assert.ok(slot >= 1 && slot <= PEER_COLOUR_COUNT);
  }
});
