import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
