import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { BRIEF_KINDS, cacheKey, defaultRepo, isBriefKind, needsRepo } from '../web/briefs-tabs.js';

/*
 * `web/briefs-tabs.js` — the two rules behind the briefs modal's strip, run in node the way
 * `trust-gate.js` and `notify.js` are.
 *
 * Both rules render perfectly when re-derived wrongly, which is the whole reason they are a
 * module: a repo picker on the standalone tab is a control that changes nothing, and a
 * default that ignores the pane you are looking at makes the first thing you do a
 * correction. Neither is visible as a failure — the box opens, draws and answers.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the four tabs, in order, outward from the team', () => {
  assert.deepEqual(
    BRIEF_KINDS.map((k) => k.kind),
    ['lead', 'worker', 'planner', 'standalone'],
  );
  for (const k of BRIEF_KINDS) assert.equal(typeof k.label, 'string');
});

test('three kinds are a function of a repo and the standalone brief is not', () => {
  assert.equal(needsRepo('lead'), true);
  assert.equal(needsRepo('worker'), true);
  assert.equal(needsRepo('planner'), true);
  // One file for the whole machine (`server/session-launch.js`), so a repo picker there
  // would be a control that changes nothing — worse than absent, because it implies the
  // answer depends on it.
  assert.equal(needsRepo('standalone'), false);
});

test('an unknown kind needs no repo and is not a kind', () => {
  // Fails towards *no* picker: guessing `true` draws a control over something nothing can
  // fill in.
  assert.equal(needsRepo('sidekick'), false);
  assert.equal(needsRepo(null), false);
  assert.equal(needsRepo(undefined), false);
  assert.equal(isBriefKind('lead'), true);
  assert.equal(isBriefKind('sidekick'), false);
});

/* ------------------------------------------------ which repo it opens on --- */

const TEAMS = [
  { repo: '/s/alpha', name: 'alpha' },
  { repo: '/s/beta', name: 'beta' },
  { repo: '/s/gamma', name: 'gamma' },
];

test('the open pane’s repo wins when it has a team', () => {
  assert.equal(defaultRepo(TEAMS, '/s/gamma'), '/s/gamma');
});

test('and the first team otherwise — never nothing, when there is something', () => {
  assert.equal(defaultRepo(TEAMS, '/s/not-a-team'), '/s/alpha', 'a repo with no team');
  assert.equal(defaultRepo(TEAMS, null), '/s/alpha', 'no pane open');
  assert.equal(defaultRepo(TEAMS), '/s/alpha', 'nothing passed at all');
});

test('a worker’s worktree is a different folder, and is not filed under the repo', () => {
  // The prefix match that would "helpfully" find the parent is exactly what files
  // `…/alpha-2` under `…/alpha`. Only an exact folder counts.
  assert.equal(defaultRepo(TEAMS, '/s/alpha-worktrees/alpha-issue-9'), '/s/alpha');
  assert.equal(defaultRepo([{ repo: '/s/alpha' }], '/s/alpha-2'), '/s/alpha');
});

test('a trailing slash is the same folder', () => {
  assert.equal(defaultRepo(TEAMS, '/s/beta/'), '/s/beta');
  assert.equal(defaultRepo([{ repo: '/s/beta/' }], '/s/beta'), '/s/beta');
});

test('bare strings work too — the endpoint’s row shape is not this module’s business', () => {
  assert.equal(defaultRepo(['/s/alpha', '/s/beta'], '/s/beta'), '/s/beta');
});

test('no teams at all answers null rather than throwing', () => {
  assert.equal(defaultRepo([], '/s/alpha'), null);
  assert.equal(defaultRepo(null, '/s/alpha'), null);
  assert.equal(defaultRepo(undefined), null);
  assert.equal(defaultRepo([{ name: 'no repo field' }, null, 42]), null);
});

/* ----------------------------------------------------------- cache keys --- */

test('one key per repo and kind', () => {
  assert.notEqual(cacheKey('/s/alpha', 'lead'), cacheKey('/s/alpha', 'worker'));
  assert.notEqual(cacheKey('/s/alpha', 'lead'), cacheKey('/s/beta', 'lead'));
  assert.equal(cacheKey('/s/alpha', 'lead'), cacheKey('/s/alpha', 'lead'));
});

test('standalone ignores the repo, because its brief does', () => {
  assert.equal(cacheKey('/s/alpha', 'standalone'), cacheKey('/s/beta', 'standalone'));
  assert.equal(cacheKey(null, 'standalone'), cacheKey('/s/gamma', 'standalone'));
});

test('no two repo/kind pairs can spell one key', () => {
  // The separator is safe because the *kind* is the half that cannot contain one, so a
  // path carrying the separator itself still cannot collide.
  const seen = new Map();
  for (const repo of ['/s/a', '/s/a|lead', '/s/a|', '', '/s/a/b']) {
    for (const { kind } of BRIEF_KINDS) {
      const key = cacheKey(repo, kind);
      const prior = seen.get(key);
      // `standalone` is the one deliberate collapse, and only with itself.
      if (prior && kind !== 'standalone') assert.fail(`${repo} + ${kind} collides with ${prior}`);
      seen.set(key, `${repo} + ${kind}`);
    }
  }
});

/**
 * No invisible byte in the key or in the module that builds it.
 *
 * `mergeSig`'s trap from the other end: three literal control bytes inside a pair of quotes
 * is valid JavaScript that throws nothing and reads as an empty-string join in every
 * editor. `cacheKey` genuinely had a real NUL in it for about a minute while this was being
 * written, and it looked completely fine.
 *
 * The check is arithmetic on code points rather than a character class, and that is the
 * point: a guard against invisible characters written *with* invisible characters is the
 * same defect wearing the uniform of its own test.
 */
const hasControl = (text) =>
  [...String(text)].some((ch) => {
    const c = ch.codePointAt(0);
    return (c < 32 || c === 127) && c !== 9 && c !== 10 && c !== 13;
  });

test('no control characters in the key, and none in the module', () => {
  assert.equal(hasControl(cacheKey('/s/alpha', 'lead')), false);
  assert.equal(hasControl(cacheKey(null, 'standalone')), false);
  assert.equal(
    hasControl(fs.readFileSync(path.join(REPO, 'web', 'briefs-tabs.js'), 'utf8')),
    false,
    'the source itself carries no invisible control byte',
  );
});
