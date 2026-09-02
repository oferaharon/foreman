import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPO_URL } from '../server/config.js';
import { branchFacts, createDeployTracker, isAncestor, shaOf } from '../server/deployed.js';

/*
 * Two halves, tested two ways.
 *
 * Ancestry runs against a real throwaway repo with a real remote, because a stubbed git
 * proves nothing about a git wrapper — the same rule as worktree.test.js. The decision
 * table (pulled / restart / deployed / unknown, and the cache in front of it) is driven
 * with injected answers, because what is being tested there is the reasoning, not git.
 */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-deployed-'));
const origin = path.join(scratch, 'origin.git');
const repo = path.join(scratch, 'repo');

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(file, text, msg) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  git(['add', '.']);
  git(['commit', '-m', msg]);
  return git(['rev-parse', 'HEAD']);
}

test.before(() => {
  execFileSync('git', ['init', '--bare', '-b', 'main', origin]);
  fs.mkdirSync(repo);
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  git(['remote', 'add', 'origin', origin]);
  commit('README.md', 'hello\n', 'first');
  git(['push', '-u', 'origin', 'main']);
});

test.after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('ancestry answers yes, no, and "cannot tell" as three different things', async () => {
  const first = git(['rev-parse', 'HEAD']);
  const second = commit('a.txt', 'a\n', 'second');
  assert.equal(await isAncestor(repo, first, second), true);
  assert.equal(await isAncestor(repo, second, first), false, 'a later commit is not an ancestor');
  assert.equal(
    await isAncestor(repo, '0'.repeat(40), second),
    null,
    'an object git has never seen is unknown, not "no" — one says pull, the other says show nothing',
  );
  assert.equal(await shaOf(repo, 'HEAD'), second);
  assert.equal(await shaOf(repo, 'no-such-branch'), null);
});

test('a branch records its tip and the top-level dirs it touched', async () => {
  git(['checkout', '-b', 'agent/web-only', 'origin/main']); // as createWorktree does
  const tip = commit('web/app.js', '// x\n', 'web change');
  git(['checkout', 'main']);
  const facts = await branchFacts(repo, { branch: 'agent/web-only', base: 'origin/main' });
  assert.equal(facts.head, tip);
  assert.deepEqual(facts.changed, ['web']);
});

test('a path with a space survives — git quotes it, -z does not', async () => {
  git(['checkout', '-b', 'agent/spaces', 'origin/main']);
  const tip = commit('some dir/thing.txt', 'x\n', 'spaced path');
  git(['checkout', 'main']);
  const facts = await branchFacts(repo, { branch: 'agent/spaces', base: 'origin/main' });
  assert.equal(facts.head, tip);
  assert.deepEqual(facts.changed, ['some dir'], 'not `"some` — the quoting trap conflicts.js already paid for');
});

test('a merged branch is not pulled until the checkout has it', async () => {
  // The shape of the real thing: the merge happens on the server, this checkout lags.
  git(['checkout', '-b', 'agent/server-work', 'origin/main']);
  const tip = commit('server/thing.js', 'export const x = 1;\n', 'server change');
  const facts = await branchFacts(repo, { branch: 'agent/server-work', base: 'origin/main' });
  git(['checkout', 'main']);
  git(['merge', '--no-ff', '-m', 'merge server-work', 'agent/server-work']);
  git(['push', 'origin', 'main']);
  const merged = git(['rev-parse', 'HEAD']);
  git(['reset', '--hard', 'HEAD~1']); // rewind: the merge is upstream, we have not pulled

  const tracker = createDeployTracker({ panelRepo: repo });
  const task = { id: 't', repo, state: 'done', head: facts.head, changed: facts.changed };
  assert.deepEqual(facts.changed, ['server']);
  assert.equal((await tracker.status(task)).state, 'unpulled');

  git(['merge', '--ff-only', merged]); // the pull
  const after = createDeployTracker({ panelRepo: repo, sha: async () => merged });
  assert.equal((await after.status(task)).state, 'deployed', 'pulled, and this "panel" booted on the merge');
  assert.equal(tip, facts.head);

  const stale = createDeployTracker({ panelRepo: repo, sha: async () => git(['rev-parse', 'HEAD~1']) });
  assert.equal(
    (await stale.status(task)).state,
    'restart',
    'pulled, but the process booted before it and the change is in server/',
  );
});

/*
 * The rename blind spot, in the form it takes here. `git diff` detects renames by default,
 * so a branch that moved a file out of `server/` reports only where it landed — `changed`
 * comes back without `server`, and `needsRestart` says no for a branch that plainly took a
 * file out of the directory this panel runs from. Same flag, same reason, as `conflicts.js`
 * and `merge-queue.js`; here it is the restart answer it protects.
 */
test('a file moved out of server/ still names server/ — detection would report only where it went', async () => {
  // `server/thing.js` is on main from the test above, so this is a real cross-directory
  // move of a file that exists at the base.
  git(['checkout', '-b', 'agent/moved-out', 'origin/main']);
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true }); // git mv will not create it
  git(['mv', 'server/thing.js', 'web/thing.js']);
  git(['commit', '-m', 'move it out of server/']);
  const facts = await branchFacts(repo, { branch: 'agent/moved-out', base: 'origin/main' });
  git(['checkout', 'main']);

  assert.deepEqual(
    git(['diff', '--name-only', 'origin/main...agent/moved-out']).split('\n'),
    ['web/thing.js'],
    'detection on: server/ vanishes from the answer entirely',
  );
  assert.deepEqual(facts.changed, ['server', 'web'], 'both ends — the branch did take a file out of server/');

  // The consequence, in this file's own words: `needsRestart` is `changed.some(RESTART_DIRS)`,
  // pinned by the decision table below. With detection on, `changed` was `['web']` and this
  // branch read as live on the pull alone.
  const merged = git(['merge', '--no-ff', '-m', 'merge moved-out', 'agent/moved-out']) && git(['rev-parse', 'HEAD']);
  const stale = createDeployTracker({ panelRepo: repo, sha: async () => git(['rev-parse', 'HEAD~1']) });
  const task = { id: 't', repo, state: 'done', head: facts.head, changed: facts.changed };
  assert.equal(merged, git(['rev-parse', 'HEAD']));
  assert.equal((await stale.status(task)).state, 'restart', 'pulled, booted before it, and server/ lost a file');
  // A second tracker, because answers are cached by `${repo}:${head}` and this is the
  // same commit asked a different way: the old `changed`, and the pill it used to draw.
  const asDetected = createDeployTracker({ panelRepo: repo, sha: async () => git(['rev-parse', 'HEAD~1']) });
  assert.equal(
    (await asDetected.status({ ...task, changed: ['web'] })).state,
    'deployed',
    'and the answer detection used to give — the whole of what the flag changes',
  );
});

/*
 * The packaged install, against real repositories.
 *
 * Installed rather than cloned, the panel runs out of a package directory that is not a git
 * repository — so there is no boot sha, and the directory test never names any team's
 * checkout. Left there, a task in *this project's own* checkout read `deployed` on the pull
 * alone: the merge is in the checkout and the running panel is the released build, which
 * does not have it. A wrong green badge is the worst answer this file can give.
 *
 * `origin` and `sha` are both the real ones here — the point of the test is that a genuine
 * `git remote get-url` on a genuine repository, put through `browsableRepoUrl`, matches what
 * `package.json` says this project is.
 */
test('an installed panel draws no chip for this project, and is unchanged for anyone else', async () => {
  const notARepo = path.join(scratch, 'libexec-package'); // where a packaged install lives
  fs.mkdirSync(notARepo, { recursive: true });
  assert.equal(await shaOf(notARepo, 'HEAD'), null, 'the premise: a package directory is not a checkout');
  assert.ok(REPO_URL, 'package.json names this project, which is what the match is against');

  // A clone of this project on a contributor's Mac. The scp-like spelling on purpose: it is
  // one of the three git accepts, and `browsableRepoUrl` is what makes it compare equal.
  const mine = path.join(scratch, 'mine');
  const ssh = `git@${REPO_URL.replace(/^https?:\/\//, '').replace('/', ':')}.git`;
  fs.mkdirSync(mine);
  execFileSync('git', ['init', '-b', 'main'], { cwd: mine });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: mine });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: mine });
  execFileSync('git', ['remote', 'add', 'origin', ssh], { cwd: mine });
  fs.writeFileSync(path.join(mine, 'server-change.js'), 'x\n');
  execFileSync('git', ['add', '.'], { cwd: mine });
  execFileSync('git', ['commit', '-m', 'work'], { cwd: mine });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mine, encoding: 'utf8' }).trim();

  const brewed = createDeployTracker({ panelRepo: notARepo });
  const verdict = await brewed.status({ id: 't', repo: mine, state: 'done', head, changed: ['server'] });
  assert.equal(verdict.state, 'unknown');
  assert.equal(verdict.label, null, 'no label is how `web/app.js` draws no chip at all');
  assert.match(verdict.why, /installed rather than cloned/);
  assert.equal(await brewed.isPanelRepo(mine), true, 'matched by project, not by path');

  // Somebody else's project, from the same installed panel: exactly as it answered before.
  const theirs = path.join(scratch, 'theirs');
  fs.mkdirSync(theirs);
  execFileSync('git', ['init', '-b', 'main'], { cwd: theirs });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: theirs });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: theirs });
  execFileSync('git', ['remote', 'add', 'origin', 'https://example.invalid/someone/else.git'], { cwd: theirs });
  fs.writeFileSync(path.join(theirs, 'thing.js'), 'x\n');
  execFileSync('git', ['add', '.'], { cwd: theirs });
  execFileSync('git', ['commit', '-m', 'work'], { cwd: theirs });
  const theirHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: theirs, encoding: 'utf8' }).trim();

  const other = await brewed.status({ id: 'u', repo: theirs, state: 'done', head: theirHead, changed: ['server'] });
  assert.equal(other.state, 'deployed', 'another team\'s project has no process here to be stale');
  assert.equal(await brewed.isPanelRepo(theirs), false);
});

test('an installed panel with no project to compare against says nothing new', async () => {
  // `REPO_URL` is null when `package.json` could not be read — the same non-fatal shrug
  // `config.js` takes for the footer's link. With no project name in hand there is no
  // second way to match, so every repo answers exactly as it did before this existed.
  const tracker = createDeployTracker({
    panelRepo: '/not/a/repo',
    sha: async () => null, // the packaged install: no checkout, no boot sha
    ancestor: async () => true,
    repoUrl: null,
    origin: async () => 'https://example.invalid/owner/repo',
  });
  const s = await tracker.status({ id: 't', repo: '/repo', state: 'done', head: 'abc', changed: ['server'] });
  assert.equal(s.state, 'deployed');
  assert.equal(await tracker.isPanelRepo('/repo'), false);
});

test('a panel running from a checkout never asks a repo for its origin', async () => {
  // The byte-identical half: with a boot sha in hand the project rung is unreachable, so
  // this is the same answer, by the same route, as before the packaged case existed.
  let asked = 0;
  const tracker = createDeployTracker({
    panelRepo: repo,
    sha: async () => 'boot',
    ancestor: async () => true,
    origin: async () => {
      asked += 1;
      return REPO_URL;
    },
  });
  const s = await tracker.status({ id: 't', repo: '/somewhere/else', state: 'done', head: 'abc', changed: ['server'] });
  assert.equal(s.state, 'deployed');
  assert.equal(asked, 0, 'a checkout panel shells out to `git remote` exactly never');
});

/* ---------------------------------------------------------- the decision table --- */

const done = (over = {}) => ({ id: 't', repo: '/repo', state: 'done', head: 'abc', changed: ['server'], ...over });

function fake({ pulled = true, live = false, boot = 'boot', panelRepo = '/repo', ...rest } = {}) {
  const calls = { ancestor: 0 };
  const tracker = createDeployTracker({
    panelRepo,
    sha: async () => boot,
    ancestor: async (_repo, _a, target) => {
      calls.ancestor += 1;
      return target === 'HEAD' ? pulled : live;
    },
    ...rest,
  });
  return { tracker, calls };
}

test('only a finished task has a deployment at all', async () => {
  const { tracker } = fake();
  assert.equal(await tracker.status(done({ state: 'working' })), null);
  assert.equal(await tracker.status(done({ state: 'review' })), null);
  assert.equal(await tracker.status(null), null);
});

test('no recorded tip means unknown, never a guess', async () => {
  const { tracker, calls } = fake();
  const s = await tracker.status(done({ head: null }));
  assert.equal(s.state, 'unknown');
  assert.equal(s.label, null, 'the row draws nothing rather than something wrong');
  assert.equal(calls.ancestor, 0);
});

test('a web-only change is live on the pull alone', async () => {
  const { tracker, calls } = fake({ pulled: true, live: false });
  const s = await tracker.status(done({ changed: ['web', 'docs'] }));
  assert.equal(s.state, 'deployed');
  assert.equal(calls.ancestor, 1, 'the boot sha is never consulted — web/ is read off disk');
});

test('another team\'s repo has no process here to be stale', async () => {
  const { tracker } = fake({ panelRepo: '/somewhere/else', pulled: true, live: false });
  assert.equal((await tracker.status(done())).state, 'deployed');
});

test('a change we cannot describe is assumed to need a restart', async () => {
  const { tracker } = fake({ pulled: true, live: false });
  assert.equal((await tracker.status(done({ changed: undefined }))).state, 'restart');
});

test('an unreadable boot sha is unknown, not deployed', async () => {
  const { tracker } = fake({ pulled: true, boot: null });
  assert.equal((await tracker.status(done())).state, 'unknown');
});

test('git failing to compare is unknown, not "not pulled"', async () => {
  const tracker = createDeployTracker({ panelRepo: '/repo', ancestor: async () => null, sha: async () => 'boot' });
  assert.equal((await tracker.status(done())).state, 'unknown');
});

test('the boot sha is read at boot, not at the first look', async () => {
  // The bench caught this one: nobody opens the team panel the instant the server comes
  // up, so a lazy read takes whatever HEAD is when somebody finally does — including one
  // that has been pulled since. That reads a stale panel as deployed.
  let head = 'at-boot';
  const tracker = createDeployTracker({
    panelRepo: '/repo',
    sha: async () => head,
    ancestor: async (_r, _a, target) => (target === 'HEAD' ? true : target === 'at-boot'),
  });
  await new Promise((r) => setImmediate(r));
  head = 'after-a-pull';
  assert.equal((await tracker.bootHead()), 'at-boot');
  assert.equal((await tracker.status(done())).state, 'deployed');
});

test('answers are cached — the roster paints every couple of seconds', async () => {
  let clock = 1000;
  const { tracker, calls } = fake({ pulled: false, now: () => clock, ttlMs: 20_000 });
  await tracker.status(done());
  await tracker.status(done());
  await tracker.status(done());
  assert.equal(calls.ancestor, 1, 'three paints, one shell-out');
  clock += 25_000;
  await tracker.status(done());
  assert.equal(calls.ancestor, 2, 'a "not pulled" is re-asked once the ttl lapses — it can change');
});

test('a deployed answer is cached forever', async () => {
  let clock = 1000;
  const { tracker, calls } = fake({ pulled: true, live: true, now: () => clock });
  assert.equal((await tracker.status(done())).state, 'deployed');
  clock += 10 * 60_000;
  assert.equal((await tracker.status(done())).state, 'deployed');
  assert.equal(calls.ancestor, 2, 'the two of the first evaluation, and none since');
});

test('the cache is keyed by commit, so a second task is its own question', async () => {
  const { tracker, calls } = fake({ pulled: true, live: true });
  await tracker.status(done({ head: 'aaa' }));
  await tracker.status(done({ id: 'u', head: 'bbb' }));
  assert.equal(calls.ancestor, 4);
});
