import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CHECKS, MERGEABLE, mergeVerdict, reviewPathHits } from '../server/merge-check.js';

/*
 * The self-merge verdict.
 *
 * Two halves, and they are tested two different ways for the same reason `merge-queue.js`
 * splits: the decision table is pure once the two git reads are injected, so it needs no
 * repo at all; the git reads themselves are only worth testing against a **real throwaway
 * one**, because stubbing git to test a git wrapper proves nothing.
 *
 * What is deliberately absent from every test here: a forge. The panel cannot read one
 * (the maintainer's ruling, 2026-08-30) — `mergeable` and `checks` arrive from the lead and
 * are checked against an enum, so there is no network to fake and none is faked.
 */

/* ------------------------------------------------------------ the matcher --- */

test('a review path matches a file, a folder, and nothing that merely starts alike', () => {
  // The whole of the rule is the `/` boundary. A naive `p.startsWith(e)` passes every
  // other line in this test and fails the third, which is why it gets its own.
  assert.deepEqual(reviewPathHits(['server/index.js'], ['server/index.js']), ['server/index.js'], 'an exact file');
  assert.deepEqual(reviewPathHits(['server/index.js'], ['server']), ['server/index.js'], 'a folder prefix');
  assert.deepEqual(reviewPathHits(['serverless.js'], ['server']), [], 'and NOT a sibling that starts with the same letters');
  assert.deepEqual(reviewPathHits(['server'], ['server']), ['server'], 'the entry may name a file with no extension');
  assert.deepEqual(reviewPathHits(['web/app.js'], ['server']), []);
  assert.deepEqual(reviewPathHits(['web/m/cards.js'], ['web/m']), ['web/m/cards.js'], 'a nested folder');
  assert.deepEqual(reviewPathHits(['web/mobile.js'], ['web/m']), [], 'and its own near-miss one level down');
});

test('the shapes `conflicts.js` paid for: a space and a non-ASCII path', () => {
  // `mergePaths` reads `-z`, so both arrive as raw bytes with no quoting and no octal
  // escaping — which is the entire point, and what makes these two ordinary.
  assert.deepEqual(reviewPathHits(['web/my file.js'], ['web']), ['web/my file.js']);
  assert.deepEqual(reviewPathHits(['web/café.js'], ['web']), ['web/café.js']);
  assert.deepEqual(reviewPathHits(['web/café.js'], ['web/café.js']), ['web/café.js'], 'exact, non-ASCII');
  assert.deepEqual(reviewPathHits(['docs/my file.md'], ['docs/my file.md']), ['docs/my file.md'], 'exact, with a space');
  // The near-miss again, in the shape that would slip past an unescaped regex.
  assert.deepEqual(reviewPathHits(['web/café.js.bak'], ['web/café.js']), []);
});

test('an empty list reserves nothing, and a missing one is not a crash', () => {
  assert.deepEqual(reviewPathHits(['server/index.js'], []), []);
  assert.deepEqual(reviewPathHits(['server/index.js'], null), []);
  assert.deepEqual(reviewPathHits(null, ['server']), []);
  // Order is git's, so the room line reads like the diff.
  assert.deepEqual(reviewPathHits(['z.js', 'server/a.js', 'server/b.js'], ['server']), ['server/a.js', 'server/b.js']);
});

/* ----------------------------------------------- the table, without a repo --- */

const REPO = '/Users/x/Code/Alpha';
const TIP = 'a'.repeat(40);

const team = (over = {}) => ({
  repo: REPO,
  toggles: { leadDecidesMerges: true, ...(over.toggles || {}) },
  humanReviewPaths: [],
  ...over,
});

const task = (over = {}) => ({
  id: 'stop-icon', repo: REPO, kind: 'build', state: 'review',
  branch: 'agent/stop-icon', base: 'main', pr: 'http://forge.example.com:3002/team/alpha/pulls/53',
  ...over,
});

const GITEA = { reading: 'Gitea', forge: 'gitea', via: 'mcp' };

/** The git seam: the branch tip is TIP, and every changed file is `changed`. */
const deps = ({ changed = ['web/app.js'], tip = TIP } = {}) => ({
  sha: async (_repo, ref) => (ref === TIP || ref === 'agent/stop-icon' ? tip : null),
  paths: async () => changed,
});

/** Everything the lead has to say, all of it fine — so each test can spoil one thing. */
const said = {
  head: TIP, mergeable: 'clean', checks: 'green',
  evidence: 'gh pr view 53: MERGEABLE/CLEAN, statusCheckRollup all SUCCESS',
  reason: 'a one-line icon swap in web/, reviewed, no interface changes',
};

const verdict = (over = {}, d = deps()) =>
  mergeVerdict({ team: team(), task: task(), repo: REPO, forge: GITEA, ...said, ...over }, d);

test('everything in order is allowed, and the reasons say what was checked', async () => {
  const v = await verdict();
  assert.equal(v.allowed, true);
  assert.equal(v.head, TIP);
  assert.equal(v.forge, 'Gitea');
  assert.deepEqual(v.paths, ['web/app.js']);
  // `reasons` is what the room line prints and what the maintainer reads back a week
  // later, so on an allow it is the checklist rather than the word "yes".
  const all = v.reasons.join('\n');
  assert.match(all, /leadDecidesMerges" toggle is on/);
  assert.match(all, /forge: Gitea/);
  assert.match(all, /stop-icon is in review with http/);
  assert.match(all, /is the tip of agent\/stop-icon/);
  assert.match(all, /empty humanReviewPaths/);
  assert.match(all, /mergeable: clean, checks: green/);
});

/*
 * The eleven refusals, in the plan's order, each naming itself in `reasons`. The order is
 * deliberately not cheapest-first: a refusal should name the most fundamental thing that is
 * wrong, so a team whose toggle is off hears about the toggle rather than about a missing
 * quote.
 */

test('1 — the toggle is off, and that is the answer', async () => {
  const v = await mergeVerdict(
    { team: team({ toggles: { leadDecidesMerges: false } }), task: task(), repo: REPO, forge: GITEA, ...said },
    deps(),
  );
  assert.equal(v.allowed, false);
  assert.match(v.reasons[0], /"leadDecidesMerges" toggle is off/);
  assert.match(v.reasons[0], /however good it looks/, 'the sentence the maintainer ruled, verbatim');

  // A team with no `toggles` at all — an older `team.json` read raw — is off, not on.
  const bare = await mergeVerdict({ team: {}, task: task(), repo: REPO, forge: GITEA, ...said }, deps());
  assert.equal(bare.allowed, false);
  assert.match(bare.reasons[0], /toggle is off/);
  const none = await mergeVerdict({ task: task(), repo: REPO, forge: GITEA, ...said }, deps());
  assert.equal(none.allowed, false, 'and no team at all is off too — fail closed');
});

test('2 — an unparseable review list refuses, and never falls back to "empty"', async () => {
  // Empty means *nothing is reserved*. Reading a typo as empty is the one fail-open this
  // whole feature has to avoid, so an unreadable list is a refusal with the entry named.
  const v = await verdict({ team: team({ humanReviewPaths: ['web/**'] }) });
  assert.equal(v.allowed, false);
  assert.match(v.reasons[0], /humanReviewPaths could not be read/);
  assert.match(v.reasons[0], /"web\/\*\*"/, 'the offending entry, so it can be fixed');

  const wrongType = await verdict({ team: team({ humanReviewPaths: 'server' }) });
  assert.equal(wrongType.allowed, false);
  assert.match(wrongType.reasons[0], /could not be read/);
});

test('3 — push only and no remote both mean there is no PR to merge', async () => {
  for (const reading of ['push only', 'no remote']) {
    const v = await verdict({ forge: { reading, forge: null, via: null } });
    assert.equal(v.allowed, false);
    assert.match(v.reasons[0], /there is no PR to merge/);
    assert.match(v.reasons[0], new RegExp(reading));
    assert.equal(v.forge, reading);
  }
  const nothing = await verdict({ forge: null });
  assert.equal(nothing.allowed, false);
  assert.match(nothing.reasons[0], /no PR to merge/);
});

test('4 — the task\'s shape: wrong repo, a plan, not in review, no PR, no branch', async () => {
  const wrongRepo = await verdict({ task: task({ repo: '/Users/x/Code/Beta' }) });
  assert.equal(wrongRepo.allowed, false);
  assert.match(wrongRepo.reasons[0], /not a task in this folder/);

  // A planner is refused **by kind**, ahead of the state and PR checks, following
  // `POST /api/team/merge`: it never gets a PR either, so those would catch it — and a
  // rule that holds by accident stops holding the day the data changes.
  const plan = await verdict({ task: task({ kind: 'plan' }) });
  assert.equal(plan.allowed, false);
  assert.match(plan.reasons[0], /is a plan — it is read and approved, not merged/);
  const donePlan = await verdict({ task: task({ kind: 'plan', state: 'done', pr: null }) });
  assert.match(donePlan.reasons[0], /is a plan/, 'and by kind before state, so it says what it is');

  for (const state of ['done', 'working', 'pending', 'abandoned']) {
    const v = await verdict({ task: task({ state }) });
    assert.equal(v.allowed, false);
    assert.match(v.reasons[0], new RegExp(`is ${state}, not in review`));
  }

  const noPr = await verdict({ task: task({ pr: null }) });
  assert.match(noPr.reasons[0], /no PR recorded/);
  const noBranch = await verdict({ task: task({ branch: null }) });
  assert.match(noBranch.reasons[0], /no branch recorded/);

  const noTask = await mergeVerdict({ team: team(), task: null, repo: REPO, forge: GITEA, ...said }, deps());
  assert.match(noTask.reasons[0], /no such task/);
});

test('5 — the verdict is bound to a sha, and it must be the branch tip here', async () => {
  const missing = await verdict({ head: '' });
  assert.equal(missing.allowed, false);
  assert.match(missing.reasons[0], /no head sha was given/);
  assert.match(missing.reasons[0], /bound to the commit/);

  // A sha this checkout has never heard of: `shaOf` answers null, and unknown refuses.
  const unknown = await verdict({ head: 'f'.repeat(40) });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.reasons[0], /does not resolve in this checkout/);

  // Resolvable, but not the tip — "checked yesterday, merged today", which is exactly
  // what this clause exists to stop.
  const moved = 'b'.repeat(40);
  const stale = await mergeVerdict(
    { team: team(), task: task(), repo: REPO, forge: GITEA, ...said, head: moved },
    { sha: async (_r, ref) => (ref === moved ? moved : TIP), paths: async () => ['web/app.js'] },
  );
  assert.equal(stale.allowed, false);
  assert.match(stale.reasons[0], /is not the tip of agent\/stop-icon/);
  assert.match(stale.reasons[0], /vouching for a different commit/);

  const goneBranch = await mergeVerdict(
    { team: team(), task: task(), repo: REPO, forge: GITEA, ...said },
    { sha: async (_r, ref) => (ref === TIP ? TIP : null), paths: async () => ['web/app.js'] },
  );
  assert.match(goneBranch.reasons[0], /agent\/stop-icon does not resolve/);
});

test('6 — an unreadable branch refuses: "could not be read" is not "touches nothing"', async () => {
  const v = await verdict({}, deps({ changed: null }));
  assert.equal(v.allowed, false);
  assert.match(v.reasons[0], /could not be read/);
  assert.match(v.reasons[0], /nothing can be cleared against the review paths/);
  assert.equal(v.paths, null);
});

test('7 — a changed file under a review path refuses, and the hits are named', async () => {
  const v = await verdict(
    { team: team({ humanReviewPaths: ['server', 'SECURITY.md'] }) },
    deps({ changed: ['server/index.js', 'server/team.js', 'web/app.js'] }),
  );
  assert.equal(v.allowed, false);
  assert.match(v.reasons[0], /server\/index\.js and server\/team\.js/, 'the files, so it is actionable');
  assert.match(v.reasons[0], /under humanReviewPaths/);
  assert.doesNotMatch(v.reasons[0], /web\/app\.js/, 'and only the files that actually hit');
  assert.deepEqual(v.paths, ['server/index.js', 'server/team.js', 'web/app.js'], 'the whole diff rides along');

  // The near-miss, end to end through the verdict rather than through the matcher alone.
  const near = await verdict({ team: team({ humanReviewPaths: ['server'] }) }, deps({ changed: ['serverless.js'] }));
  assert.equal(near.allowed, true, '`server` does not reserve `serverless.js`');

  // A list that is set and cleared says so, so the room line records what was checked.
  const cleared = await verdict({ team: team({ humanReviewPaths: ['server'] }) }, deps({ changed: ['web/app.js'] }));
  assert.equal(cleared.allowed, true);
  assert.match(cleared.reasons.join('\n'), /none of its 1 changed file is under humanReviewPaths \(server\)/);
});

test('8 — mergeable must be clean, and an unrecognised word is never a pass', async () => {
  for (const word of MERGEABLE.filter((w) => w !== 'clean')) {
    const v = await verdict({ mergeable: word });
    assert.equal(v.allowed, false, word);
    assert.match(v.reasons[0], new RegExp(`reported the PR as "${word}"`));
  }
  // `UNKNOWN` in particular: GitHub computes mergeability lazily and answers UNKNOWN on
  // the first read, and a merged PR reads UNKNOWN too. It is never a pass.
  assert.match((await verdict({ mergeable: 'unknown' })).reasons[0], /rather than clean/);

  for (const junk of ['CLEAN', 'yes', '', undefined, true]) {
    const v = await verdict({ mergeable: junk });
    assert.equal(v.allowed, false, String(junk));
    assert.match(v.reasons[0], /is not something this accepts for mergeable/);
  }
});

test('9 — checks must be green, or none', async () => {
  for (const word of ['red', 'pending', 'unknown']) {
    const v = await verdict({ checks: word });
    assert.equal(v.allowed, false, word);
    assert.match(v.reasons[0], new RegExp(`reported the checks as "${word}"`));
  }
  for (const junk of ['GREEN', 'passing', '', null]) {
    const v = await verdict({ checks: junk });
    assert.equal(v.allowed, false, String(junk));
    assert.match(v.reasons[0], /is not something this accepts for checks/);
  }
  assert.ok(CHECKS.includes('green') && CHECKS.includes('none'));
});

test('10 — "no checks" needs the worker\'s own words about the suite', async () => {
  // The live path on a repo with no CI at all, which is the ordinary case here rather
  // than the exotic one: with nothing to be green, the thing standing in for it is the
  // worker's report, and it has to be quoted rather than asserted.
  const bare = await verdict({ checks: 'none' });
  assert.equal(bare.allowed, false);
  assert.match(bare.reasons[0], /quote it in suiteQuote/);
  assert.equal((await verdict({ checks: 'none', suiteQuote: '   ' })).allowed, false, 'whitespace is not a quote');

  const quoted = await verdict({ checks: 'none', suiteQuote: 'npm test: 731 pass, 0 fail' });
  assert.equal(quoted.allowed, true);
  assert.match(quoted.reasons.join('\n'), /731 pass, 0 fail/, 'and the quote lands in the room line');
});

test('11 — evidence and reason are required, and whitespace is not an answer', async () => {
  for (const field of ['evidence', 'reason']) {
    for (const empty of ['', '   ', undefined, null]) {
      const v = await verdict({ [field]: empty });
      assert.equal(v.allowed, false, `${field}=${JSON.stringify(empty)}`);
      assert.match(v.reasons[0], new RegExp(`no ${field} given`));
    }
  }
});

test('a refusal names one reason, not a pile — and the most fundamental one', async () => {
  // Everything is wrong at once. The toggle is the answer, because a team that has not
  // opted in should hear that rather than a critique of its PR.
  const v = await mergeVerdict(
    {
      team: team({ toggles: { leadDecidesMerges: false }, humanReviewPaths: ['web/**'] }),
      task: task({ state: 'done' }), repo: REPO, forge: null,
      head: '', mergeable: 'dirty', checks: 'red', evidence: '', reason: '',
    },
    deps({ changed: null }),
  );
  assert.equal(v.allowed, false);
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0], /toggle is off/);
});

test('a refusal before the git reads does not shell out at all', async () => {
  // Fail-closed is cheap only if it is also *early*: the toggle refusal must not cost a
  // `rev-parse` on a team that has not opted in, and the plan's order is what makes that
  // true rather than an accident of implementation.
  let touched = 0;
  await mergeVerdict(
    { team: team({ toggles: { leadDecidesMerges: false } }), task: task(), repo: REPO, forge: GITEA, ...said },
    { sha: async () => (touched++, TIP), paths: async () => (touched++, []) },
  );
  assert.equal(touched, 0);
});

/* --------------------------------------------- the git half, on a real repo --- */

/*
 * `mergePaths` and `shaOf` are only worth testing against a real repo — stubbing git to
 * test a git wrapper proves nothing, which is the rule the worktree and conflict suites
 * already follow. This one is on **`master`** deliberately: `main` was hardcoded in four
 * places once, and a base branch called something else is how anyone notices.
 */

let dir;

test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-mergecheck-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q', '-b', 'master']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);

  git(['checkout', '-q', '-B', 'agent/stop-icon', 'master']);
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'app.js'), 'icon\n');
  // The two shapes `-z` exists for, so they travel the whole way rather than only through
  // the matcher's unit test.
  fs.writeFileSync(path.join(dir, 'web', 'café.js'), 'accents\n');
  fs.writeFileSync(path.join(dir, 'web', 'my file.js'), 'a space\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'stop icon']);
  git(['checkout', '-q', 'master']);
});

test.after(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

test('against a real repo on master: the tip is read, and the diff is the real one', async () => {
  const tip = execFileSync('git', ['-C', dir, 'rev-parse', 'agent/stop-icon'], { encoding: 'utf8' }).trim();
  const rec = task({ repo: dir, base: 'master' });

  const v = await mergeVerdict({ team: team(), task: rec, repo: dir, forge: GITEA, ...said, head: tip });
  assert.equal(v.allowed, true);
  assert.equal(v.head, tip);
  // Raw bytes, no quoting, no octal escaping — `-z`, all the way from git.
  assert.deepEqual(v.paths, ['web/app.js', 'web/café.js', 'web/my file.js']);

  // A short sha resolves, because `shaOf` is a `rev-parse` — the lead passes what the
  // forge showed it, which is not always forty characters.
  const shortSha = await mergeVerdict({ team: team(), task: rec, repo: dir, forge: GITEA, ...said, head: tip.slice(0, 8) });
  assert.equal(shortSha.allowed, true);
  assert.equal(shortSha.head, tip, 'and the verdict records the full one');
});

test('…and the base is the task\'s own, never a hardcoded main', async () => {
  const tip = execFileSync('git', ['-C', dir, 'rev-parse', 'agent/stop-icon'], { encoding: 'utf8' }).trim();
  // No `base` on the record at all — the repo's detected default arrives as the argument,
  // and it is `master` here. With `main` assumed anywhere, `mergePaths` answers null and
  // this reads as an unreadable branch.
  const v = await mergeVerdict({
    team: team(), task: task({ repo: dir, base: null }), repo: dir, forge: GITEA, ...said, head: tip, base: 'master',
  });
  assert.equal(v.allowed, true, 'a repo on master is not a special case');
  assert.deepEqual(v.paths, ['web/app.js', 'web/café.js', 'web/my file.js']);

  // And with neither, `mergePaths` refuses to guess — which is refusal 6, not an allow.
  const blind = await mergeVerdict({
    team: team(), task: task({ repo: dir, base: null }), repo: dir, forge: GITEA, ...said, head: tip, base: null,
  });
  assert.equal(blind.allowed, false);
  assert.match(blind.reasons[0], /could not be read/);
});

test('a real non-ASCII path really is reserved by its folder', async () => {
  const tip = execFileSync('git', ['-C', dir, 'rev-parse', 'agent/stop-icon'], { encoding: 'utf8' }).trim();
  const v = await mergeVerdict({
    team: team({ humanReviewPaths: ['web'] }), task: task({ repo: dir, base: 'master' }),
    repo: dir, forge: GITEA, ...said, head: tip,
  });
  assert.equal(v.allowed, false);
  assert.match(v.reasons[0], /web\/café\.js/, 'the escaped spelling would never have matched');
  assert.match(v.reasons[0], /web\/my file\.js/);
});
