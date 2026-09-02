import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * The merge queue: the git read, the decision table, and the sentence.
 *
 * Real git, throwaway repo — stubbing git to test a git wrapper proves nothing (the
 * `worktree.test.js` rule, which `conflicts.test.js` follows and this file follows too).
 * The scratch state dir is set before the import so nothing here can touch the real one.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-mergeq-'));
const {
  mergePaths,
  buildQueue,
  composition,
  mergeLine,
  collectQueue,
  candidates,
  prNumber,
  prName,
  resetCaches,
} = await import('../server/merge-queue.js');

const repo = path.join(process.env.FOREMAN_STATE_DIR, 'repo');
const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Commit one file's worth of content on `branch`, cut from `from`. */
function commitOn(branch, files, { from = 'main', message = 'work' } = {}) {
  git(['checkout', '-q', '-B', branch, from]);
  for (const [file, body] of Object.entries(files)) {
    const full = path.join(repo, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
  const head = git(['rev-parse', 'HEAD']).trim();
  git(['checkout', '-q', 'main']);
  return head;
}

test.before(() => {
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);
});

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------ mergePaths --- */

test('mergePaths reads a branch diff, and -z survives the two quotings that break conflicts.js', async () => {
  resetCaches();
  // The measured trap: `diff --name-only` leaves a space bare but quotes and
  // octal-escapes non-ASCII, so a plain read hands back `"web/caf\303\251.js"` — a string
  // that never compares equal to the same path from any other source. `-z` returns raw
  // bytes and no quoting at all.
  commitOn('agent/quoting', {
    'web/my file.js': 'space\n',
    'web/café.js': 'non-ascii\n',
    'server/plain.js': 'ordinary\n',
  });
  const paths = await mergePaths(repo, { branch: 'agent/quoting', base: 'main' });
  assert.deepEqual(paths, ['server/plain.js', 'web/café.js', 'web/my file.js']);

  // …and the shape that would have arrived without it, so the assertion above is not
  // just asserting what git happens to do today.
  const raw = git(['diff', '--name-only', 'main...agent/quoting']).trim().split('\n');
  assert.ok(raw.some((p) => p.startsWith('"') && p.includes('\\303')), 'plain --name-only quotes and escapes');
});

test('an unreadable branch is null, which is not the same as touching nothing', async () => {
  resetCaches();
  assert.equal(await mergePaths(repo, { branch: 'agent/never-existed', base: 'main' }), null);
  assert.equal(await mergePaths(repo, { branch: 'agent/quoting', base: 'origin/nowhere' }), null);
  assert.equal(await mergePaths(repo, {}), null);
  // A branch that really changes nothing answers `[]`, and the two must not collapse:
  // one withholds the batch, the other composes with everything.
  git(['branch', '-f', 'agent/empty', 'main']);
  assert.deepEqual(await mergePaths(repo, { branch: 'agent/empty', base: 'main' }), []);
});

test('the cache is keyed on both shas — a branch whose base moved is re-read', async () => {
  resetCaches();
  const head = commitOn('agent/moved', { 'src/one.js': 'one\n' });
  assert.deepEqual(await mergePaths(repo, { branch: 'agent/moved', base: 'main' }), ['src/one.js']);

  // Main absorbs the branch. The branch tip has not moved — but `base...branch` is
  // three-dot, so the merge base is now the branch itself and the answer is empty. A
  // cache keyed on the branch sha alone would still be saying `src/one.js`, which is the
  // exact case this feature is about: main moves at every merge.
  git(['merge', '-q', '--no-ff', '-m', 'merge moved', 'agent/moved']);
  assert.equal(git(['rev-parse', 'agent/moved']).trim(), head, 'the branch tip did not move');
  assert.deepEqual(await mergePaths(repo, { branch: 'agent/moved', base: 'main' }), []);
});

/* ------------------------------------------------------- the Gitea #50/#51 case --- */

/*
 * Every test in this file is about a repo that *has* a forge — that is what a merge queue
 * is for. `collectQueue` now asks, because with no forge there are no PRs and the block
 * has to be absent rather than full of grey rows nobody can press (the composer strip
 * collapses on `:empty`, so absent is the only thing that works). The no-forge case has
 * its own test at the end.
 */
const FORGE = 'gitea';

const review = (id, over = {}) => ({
  id,
  repo,
  state: 'review',
  kind: 'build',
  body: `${id} did a thing\nand said more about it`,
  branch: `agent/${id}`,
  base: 'main',
  pr: `http://192.0.2.10:3002/admin/Foreman/pulls/${50 + Object.keys(over).length}`,
  updatedAt: `2026-08-30T10:0${id.length}:00.000Z`,
  ...over,
});

test('the Gitea #50/#51 case: two review PRs rewriting one file are named, with the file they share', async () => {
  resetCaches();
  // Two branches that both change `web/app.js` — what actually happened on 2026-08-29.
  commitOn('agent/permission-classify', { 'web/app.js': 'classify\n', 'web/styles.css': 'a\n' });
  commitOn('agent/trust-gate', { 'web/app.js': 'trust gate\n', 'web/m/cards.js': 'b\n' });

  const tasks = [
    review('permission-classify', { pr: 'http://box/pulls/51', updatedAt: '2026-08-30T10:00:00.000Z' }),
    review('trust-gate', { pr: 'http://box/pulls/50', updatedAt: '2026-08-30T09:00:00.000Z' }),
  ];
  const { rows, batch } = await collectQueue({ tasks, repo, forge: FORGE });

  // Oldest first — a queue is FIFO, and it is the order a batch would merge in.
  assert.deepEqual(rows.map((r) => r.id), ['trust-gate', 'permission-classify']);
  const [trust, classify] = rows;
  assert.deepEqual(trust.shares, [{ id: 'permission-classify', paths: ['web/app.js'] }]);
  assert.deepEqual(classify.shares, [{ id: 'trust-gate', paths: ['web/app.js'] }]);
  assert.equal(classify.sharesNote, 'also changed by trust-gate: web/app.js');

  // The batch is withheld, and the sentence names both tasks and the file.
  assert.equal(batch.allowed, false);
  assert.match(batch.why, /trust-gate and permission-classify both change web\/app\.js/);
  assert.match(batch.why, /merge them one at a time so the second can be rebuilt on the first\./);

  // Both rows still carry a button's worth of state: an individual press is never
  // refused, only annotated.
  assert.deepEqual(rows.map((r) => r.state), ['ready', 'ready']);
});

test('…and the same two with disjoint paths report nothing and compose', async () => {
  resetCaches();
  commitOn('agent/only-server', { 'server/one.js': 'a\n' });
  commitOn('agent/only-web', { 'web/two.js': 'b\n' });
  const tasks = [
    review('only-server', { pr: 'http://box/pulls/60', updatedAt: '2026-08-30T09:00:00.000Z' }),
    review('only-web', { pr: 'http://box/pulls/61', updatedAt: '2026-08-30T10:00:00.000Z' }),
  ];
  const { rows, batch } = await collectQueue({ tasks, repo, forge: FORGE });
  assert.deepEqual(rows.flatMap((r) => r.shares), []);
  assert.deepEqual(rows.map((r) => r.sharesNote), [null, null]);
  assert.equal(batch.allowed, true);
  assert.equal(batch.why, null);
  assert.deepEqual(batch.tasks, ['only-server', 'only-web']);
});

/*
 * The same rename blind spot `conflicts.js` was fixed for, asked of this file's question.
 * Rename detection is on by default, so a PR that moved a file reports only where it went
 * — and a second PR editing the old name would share nothing with it, so `sharesNote`
 * would stay silent and the batch would compose two PRs that cannot land side by side.
 */
test('a committed rename keeps both names, so a PR editing the old one still shares a file', async () => {
  resetCaches();
  // The file has to exist at the base, or the move is just an add of the new name.
  fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'web/moving.js'), 'one\ntwo\nthree\nfour\nfive\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'a file for one PR to move and another to edit']);

  git(['checkout', '-q', '-B', 'agent/renamer', 'main']);
  git(['mv', 'web/moving.js', 'web/moved.js']);
  git(['commit', '-q', '-m', 'move it']);
  git(['checkout', '-q', 'main']);
  commitOn('agent/old-name-editor', { 'web/moving.js': 'edited under the old name\n' });

  assert.deepEqual(
    await mergePaths(repo, { branch: 'agent/renamer', base: 'main' }),
    ['web/moved.js', 'web/moving.js'],
    'both ends of the rename',
  );
  // …and what it would have said without the flag, so the line above is not just
  // asserting what git happens to do today.
  assert.deepEqual(
    git(['diff', '--name-only', 'main...agent/renamer']).trim().split('\n'),
    ['web/moved.js'],
    'detection on: the old name is simply gone',
  );

  const tasks = [
    review('renamer', { pr: 'http://box/pulls/70', updatedAt: '2026-08-30T09:00:00.000Z' }),
    review('old-name-editor', { pr: 'http://box/pulls/71', updatedAt: '2026-08-30T10:00:00.000Z' }),
  ];
  const { rows, batch } = await collectQueue({ tasks, repo, forge: FORGE });
  assert.deepEqual(rows.find((r) => r.id === 'renamer').shares, [
    { id: 'old-name-editor', paths: ['web/moving.js'] },
  ]);
  assert.equal(rows.find((r) => r.id === 'old-name-editor').sharesNote, 'also changed by renamer: web/moving.js');
  assert.equal(batch.allowed, false, 'one press standing for both is the thing withheld');
  assert.match(batch.why, /both change web\/moving\.js/);
});

/* ------------------------------------------------------------ the states --- */

const rowsFor = (tasks, extra = {}) => buildQueue({ tasks, repo, ...extra });

test('a review task with no PR is still a row — the block and the rail must agree', () => {
  const rows = rowsFor([review('waiting', { pr: null })], { paths: new Map([['waiting', ['a.js']]]) });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'no-pr');
  assert.equal(rows[0].prNumber, null);
  assert.equal(rows[0].note, 'waiting on the lead to open the PR');
  // The rail's amber count is `state === 'review'` and nothing else. A block that drew
  // only PR-bearing rows would say 2 under a count that says 3.
  assert.equal(candidates(rows).length, 0, 'nothing to press');
});

test('a planner in review is a row too, and is told apart by its words, not by a new state', () => {
  const rows = rowsFor([review('shape-it', { pr: null, kind: 'plan', branch: null })]);
  // `no-pr` already describes it exactly, and items 2 and 3 are written against the six
  // states they were given. `kind` is the discriminator they render differently on.
  assert.equal(rows[0].state, 'no-pr');
  assert.equal(rows[0].kind, 'plan');
  // A fact about the task, not a sentence explaining the maintainer's own workflow back —
  // they approve plans in conversation with their lead.
  assert.equal(rows[0].note, 'a plan — read and approved, not merged');
  assert.deepEqual(candidates(rows), []);
});

test('a planner is out of the batch by kind, not by the accident of having no PR', () => {
  // A planner never gets a PR, so `r.pr` already excludes it today. That is a fact about
  // the data, and a rule that holds by accident stops holding the day the data changes —
  // so this one is fabricated with a PR it could never really have.
  const rows = rowsFor([review('shape-it', { kind: 'plan', pr: 'http://box/pulls/99' }), review('build-it')], {
    paths: new Map([['shape-it', ['docs/x.md']], ['build-it', ['server/y.js']]]),
  });
  assert.equal(rows.find((r) => r.id === 'shape-it').kind, 'plan');
  assert.deepEqual(candidates(rows).map((r) => r.id), ['build-it']);
  // …and with the planner the only other row, there is no batch to draw at all.
  assert.equal(composition(rows).allowed, false);
  assert.equal(composition(rows).why, null);
});

test('unknown paths withhold the batch, and say so — unknown beats optimistic', () => {
  const tasks = [review('a', { pr: 'http://box/pulls/1' }), review('b', { pr: 'http://box/pulls/2' })];
  const rows = rowsFor(tasks, { paths: new Map([['a', ['x.js']], ['b', null]]) });
  assert.equal(rows.find((r) => r.id === 'b').state, 'unreadable');
  assert.equal(rows.find((r) => r.id === 'b').note, 'its changed files could not be read — the branch may be gone');
  const batch = composition(rows);
  assert.equal(batch.allowed, false);
  assert.match(batch.why, /^b could not be read/);
  // …but it is still a candidate for a press of its own. §1: only the batch is refused.
  assert.deepEqual(candidates(rows).map((r) => r.id), ['a', 'b']);
});

test('sent and merged are different facts, and both take the row out of the batch', () => {
  const tasks = [review('a'), review('b'), review('c')];
  const rows = rowsFor(tasks, {
    paths: new Map([['a', ['1.js']], ['b', ['2.js']], ['c', ['3.js']]]),
    sent: new Set(['a']),
    merged: new Set(['b']),
  });
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.equal(by.get('a').state, 'sent');
  assert.equal(by.get('a').note, 'merge sent — waiting on the lead');
  assert.equal(by.get('b').state, 'merged');
  assert.equal(by.get('b').note, 'merged — waiting on the lead to close it');
  // Evidence beats the receipt: a row we typed a line for *and* whose head has landed
  // reads as merged, not as sent.
  const both = rowsFor([review('a')], { paths: new Map([['a', ['1.js']]]), sent: new Set(['a']), merged: new Set(['a']) });
  assert.equal(both[0].state, 'merged');
  assert.deepEqual(candidates(rows).map((r) => r.id), ['c']);
});

test('rebase first fires only on real evidence: merged, pulled, missing here, and overlapping', async () => {
  resetCaches();
  // `landedPaths` is remembered from when the row was readable, so the sequence matters:
  // both are seen in review first, exactly as they would be on screen.
  const landedHead = commitOn('agent/landed', { 'web/shared.js': 'landed\n', 'web/own.js': 'x\n' });
  commitOn('agent/open', { 'web/shared.js': 'open\n' });
  const openTask = review('open', { pr: 'http://box/pulls/71', updatedAt: '2026-08-30T10:00:00.000Z' });
  const landedTask = review('landed', { pr: 'http://box/pulls/70', head: landedHead, updatedAt: '2026-08-30T09:00:00.000Z' });

  const seen = await collectQueue({ tasks: [landedTask, openTask], repo, forge: FORGE });
  assert.deepEqual(seen.rows.map((r) => r.state), ['ready', 'ready'], 'nothing has merged yet');

  // It merges and is pulled, and its task closes.
  git(['merge', '-q', '--no-ff', '-m', 'merge landed', 'agent/landed']);
  const after = await collectQueue({ tasks: [{ ...landedTask, state: 'done' }, openTask], repo, forge: FORGE });
  assert.deepEqual(after.rows.map((r) => r.id), ['open'], 'a done task is not a row');
  assert.equal(after.rows[0].state, 'rebase-first');
  assert.equal(after.rows[0].note, 'rebase first — landed changed web/shared.js after this branched');
  // The button is still there and still pressable: it is one press, one decision, and the
  // row has said what it is.
  assert.deepEqual(candidates(after.rows).map((r) => r.id), ['open']);

  // A branch that already contains the landed head says nothing, even sharing every file.
  git(['checkout', '-q', 'agent/open']);
  // `-s ours` keeps this branch's own tree and still records the landed head as a
  // parent — which is the fact under test: containment, not content.
  git(['merge', '-q', '--no-ff', '-s', 'ours', '-m', 'catch up', 'agent/landed']);
  git(['checkout', '-q', 'main']);
  const caught = await collectQueue({ tasks: [{ ...landedTask, state: 'done' }, openTask], repo, forge: FORGE });
  assert.equal(caught.rows[0].state, 'ready');
  assert.deepEqual(caught.rows[0].behind, []);
});

test('a merged review row is read off ancestry, not off the fact that a line was sent', async () => {
  resetCaches();
  const head = commitOn('agent/already-in', { 'server/gone.js': 'a\n' });
  git(['merge', '-q', '--no-ff', '-m', 'merge already-in', 'agent/already-in']);
  const { rows } = await collectQueue({
    tasks: [review('already-in', { pr: 'http://box/pulls/80', head })],
    repo,
    forge: FORGE,
  });
  assert.equal(rows[0].state, 'merged');
});

test('with no forge there is no queue at all — removed, not greyed', async () => {
  resetCaches();
  // A review task with a PR is the strongest case: even *that* draws nothing, because on
  // a repo with no forge tools there is nothing the panel can ask a lead to merge. The
  // block is appended and removed rather than hidden (`.composer-above:empty` is what
  // collapses the strip), so an empty row list is the whole mechanism.
  const tasks = [review('nothing-to-merge', { pr: 'http://box/pulls/99' })];
  const withForge = await collectQueue({ tasks, repo, forge: FORGE });
  assert.equal(withForge.rows.length, 1, 'the control: with a forge it is a row');

  const none = await collectQueue({ tasks, repo, forge: null });
  assert.deepEqual(none.rows, [], 'push only / no remote: no rows');
  assert.equal(none.batch.allowed, false);
  assert.equal(none.forge, null);
});

/* ----------------------------------------------------------- composition --- */

test('one bad pair withholds the whole batch, clean third included', () => {
  const rows = rowsFor([review('a'), review('b'), review('c')], {
    paths: new Map([['a', ['web/app.js']], ['b', ['web/app.js']], ['c', ['server/only.js']]]),
  });
  const batch = composition(rows);
  assert.equal(batch.allowed, false);
  assert.match(batch.why, /a and b both change web\/app\.js/);
  // Wholesale, following `trigger.js`'s `compile()`: a team whose triggers stop working
  // gets looked at, one silently narrowed does not. `c` is not quietly offered on its own.
  assert.deepEqual(batch.tasks, ['a', 'b', 'c']);
});

test('fewer than two candidates is not a refusal — there is nothing to explain', () => {
  const one = composition(rowsFor([review('a')], { paths: new Map([['a', ['x.js']]]) }));
  assert.equal(one.allowed, false);
  assert.equal(one.why, null, 'no sentence, so no control and no explanation of a control');
  assert.deepEqual(composition([]), { allowed: false, why: null, tasks: [] });
});

test('a long overlap is clamped rather than run off the row', () => {
  const many = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'];
  const batch = composition(rowsFor([review('a'), review('b')], { paths: new Map([['a', many], ['b', many]]) }));
  assert.match(batch.why, /a\.js, b\.js and c\.js and 2 more/);
});

/* ------------------------------------------------------------- the words --- */

test('a PR number is parsed, never guessed', () => {
  assert.equal(prNumber('http://192.0.2.10:3002/admin/Foreman/pulls/51'), 51);
  assert.equal(prNumber('https://github.com/o/r/pull/1234'), 1234);
  assert.equal(prNumber(null), null);
  // `PATCH /api/team/tasks/:id` validates only `^https?://`, so a URL that is not
  // Gitea-shaped is not a bug — it names itself rather than borrowing a number.
  assert.equal(prNumber('https://example.test/review/latest'), null);
  assert.equal(prName({ pr: 'https://example.test/review/latest', prNumber: null }), 'PR https://example.test/review/latest');
});

test('the single line is the wording in the plan, exactly', () => {
  const [row] = rowsFor([review('permission-classify-broader-yes', { pr: 'http://box/pulls/51' })]);
  assert.equal(
    mergeLine([row], 'zzq-testname'),
    'Merge PR #51 — task permission-classify-broader-yes. zzq-testname pressed the merge button in the panel; ' +
      'this is their explicit word for this PR and nothing else.',
  );
  // The name is detected per repo and passed in (`human-name.js`); with none detected the
  // sentence still has to read as a sentence.
  assert.equal(
    mergeLine([row]),
    'Merge PR #51 — task permission-classify-broader-yes. the human pressed the merge button in the panel; ' +
      'this is their explicit word for this PR and nothing else.',
  );
});

test('the batch line names every PR, every task, and the order', () => {
  const rows = rowsFor(
    [
      review('trust-gate-not-answerable', { pr: 'http://box/pulls/50', updatedAt: '2026-08-30T09:00:00.000Z' }),
      review('permission-classify-broader-yes', { pr: 'http://box/pulls/51', updatedAt: '2026-08-30T10:00:00.000Z' }),
    ],
    { paths: new Map() },
  );
  assert.equal(
    mergeLine(rows, 'zzq-testname'),
    'Merge PR #50 and PR #51 — tasks trust-gate-not-answerable, permission-classify-broader-yes, in that order. ' +
      'zzq-testname pressed merge all in the panel; this is their explicit word for exactly these PRs and nothing else.',
  );
  // "…and nothing else" is load-bearing: the five rules and the 2026-08-27 ruling both
  // turn on a merge word being per-PR, and a line that read as standing permission would
  // quietly undo them.
  assert.match(mergeLine(rows), /and nothing else\.$/);
  // And it does not restate the post-merge sequence — that is the lead's, already bound.
  assert.doesNotMatch(mergeLine(rows), /pull|restart|close/i);
  assert.throws(() => mergeLine([]), /needs at least one PR/);
});

test('a title is the brief\'s first line, and a body cannot make a row two lines tall', () => {
  const [row] = rowsFor([review('long', { body: `${'x'.repeat(300)}\nsecond line` })]);
  assert.equal(row.title.length, 161);
  assert.ok(row.title.endsWith('…'));
  assert.equal(rowsFor([review('empty', { body: '' })])[0].title, '');
});

test('another repo\'s tasks are not this repo\'s rows', () => {
  const rows = rowsFor([review('mine'), { ...review('theirs'), repo: '/somewhere/else' }]);
  assert.deepEqual(rows.map((r) => r.id), ['mine']);
});
