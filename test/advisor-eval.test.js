import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/*
 * The advisor replay / live scorer (`scripts/advisor-eval.mjs`), on a made-up state dir
 * naming the sandbox repos only, with a stub `claude` — this checks our wrapper and our
 * scoring, not Claude Code.
 */

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-advisor-eval-'));
// `team.js` (teamKey) derives paths from STATE_DIR at import — point it at scratch first.
process.env.FOREMAN_STATE_DIR = path.join(tmp, 'import-state');
const ev = await import('../scripts/advisor-eval.mjs');

const REPOS = { alpha: '/sandbox/alpha', beta: '/sandbox/beta', gamma: '/sandbox/gamma' };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 7, 1);

/** A stub claude: answers by keyword, logs what it was handed, and can misbehave. */
function writeStub(dir) {
  const log = path.join(dir, 'stub-calls.jsonl');
  const stub = path.join(dir, 'claude-stub.mjs');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env node
import fs from 'node:fs';
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), tmux: process.env.TMUX ?? null, pane: process.env.TMUX_PANE ?? null, session: process.env.CLAUDE_CODE_SESSION_ID ?? null, input }) + '\\n');
  if (input.includes('JUNK')) { process.stdout.write('not json at all'); return; }
  if (input.includes('HANG')) { setTimeout(() => {}, 60000); return; }
  const model = input.includes('rename') ? 'claude-sonnet-5-5' : input.includes('race') ? 'claude-fable-5-2' : 'claude-opus-5-5';
  const effort = input.includes('rename') ? 'low' : input.includes('race') ? 'xhigh' : 'high';
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: { model, effort, reason: 'stub says so' }, usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 500, cache_creation_input_tokens: 100 }, total_cost_usd: 0.01 }));
});
`,
  );
  fs.chmodSync(stub, 0o755);
  return { stub, log };
}

/** A made-up history: ten tasks across the three sandbox repos, with room lines. */
function writeState(stateDir) {
  const t = (id, repo, i, extra = {}) => ({
    id,
    repo: REPOS[repo],
    kind: 'build',
    body: `In ${repo}, do task ${id}.`,
    state: 'done',
    model: 'claude-opus-5-5',
    effort: 'high',
    tags: ['chore'],
    pr: 'https://example.invalid/pr/1',
    createdAt: T0 + i * DAY,
    dispatchedAt: T0 + i * DAY + 1000,
    ...extra,
  });
  const tasks = [
    t('alpha-rename-one', 'alpha', 0, { body: 'In alpha, rename addOne to increment.' }), // cheaper, clean → would save
    t('alpha-rename-two', 'alpha', 1, { body: 'In alpha, rename subOne to decrement.' }), // cheaper, struggled (alert) → would risk
    t('beta-runner-fix', 'beta', 2, { model: 'claude-sonnet-5-5', body: 'In beta, fix the runner.' }), // heavier, reworked → would catch
    t('gamma-queue-race', 'gamma', 3, { body: 'In gamma, find the queue race.' }), // heavier (fable), clean
    t('gamma-plan', 'gamma', 4, { kind: 'plan', pr: null, tags: ['research'], body: 'Plan a plugin system for gamma.' }), // same, clean
    t('alpha-old-opus5', 'alpha', 5, { model: 'claude-opus-5', body: 'In alpha, rename x to y.' }), // retired id read as Opus → cheaper, clean
    t('beta-abandoned', 'beta', 6, { state: 'abandoned', body: 'In beta, rename z.' }),
    t('beta-no-model', 'beta', 7, { model: null, body: 'In beta, update docs.' }),
    t('gamma-escalated', 'gamma', 8, { body: 'In gamma, rename the flag.' }), // cheaper, escalation only → risk (escalation only)
    t('alpha-pending', 'alpha', 9, { state: 'pending', dispatchedAt: null }),
  ];
  const json = Object.fromEntries(tasks.map((x) => [x.id, x]));
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks.json'), JSON.stringify(json));
  let seq = 0;
  const room = (repo, lines) => {
    const d = path.join(stateDir, 'teams', REPOS[repo].replace(/^\//, '').replace(/\//g, '-'));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'room.jsonl'), lines.map((l) => JSON.stringify({ seq: ++seq, ts: seq, ...l })).join('\n') + '\n');
    return d;
  };
  const review = (id) => ({ from: id, to: 'lead', kind: 'status', report: 'review', text: 'done' });
  const dirs = {
    alpha: room('alpha', [
      review('alpha-rename-one'),
      { from: 'panel', to: 'lead', kind: 'system', about: 'alpha-rename-two', alert: true, text: 'stuck' },
      review('alpha-rename-two'),
      review('alpha-old-opus5'),
    ]),
    beta: room('beta', [review('beta-runner-fix'), { from: 'lead', to: 'beta-runner-fix', kind: 'chat', text: 'one more thing' }, review('beta-no-model')]),
    gamma: room('gamma', [review('gamma-queue-race'), review('gamma-plan'), { from: 'gamma-escalated', to: 'lead', kind: 'escalation', text: 'which way?' }, review('gamma-escalated')]),
  };
  return { tasks, dirs };
}

test('family and direction read retired ids as their family, Fable heaviest', () => {
  assert.equal(ev.family('claude-opus-5'), 'opus');
  assert.equal(ev.family('claude-sonnet-5-5[1m]'), 'sonnet');
  assert.equal(ev.family(null), null);
  assert.equal(ev.direction('claude-sonnet-5-5', 'claude-opus-5'), 'cheaper');
  assert.equal(ev.direction('claude-fable-5-2', 'claude-opus-5-5'), 'heavier');
  assert.equal(ev.direction('claude-opus-5-5', 'claude-opus-5'), 'same');
  assert.equal(ev.direction('claude-opus-5-5', null), null);
});

test('labelOutcome: clean, reworked, struggled, unclear and the unscored states', () => {
  const task = (x) => ({ id: 'alpha-x', state: 'done', kind: 'build', pr: 'p', ...x });
  const rv = { from: 'alpha-x', report: 'review', seq: 5 };
  assert.equal(ev.labelOutcome(task(), [rv]).outcome, 'clean');
  assert.equal(ev.labelOutcome(task({ pr: null }), [rv]).outcome, 'unclear');
  assert.equal(ev.labelOutcome(task({ pr: null, kind: 'plan' }), [rv]).outcome, 'clean');
  assert.equal(ev.labelOutcome(task(), [rv, { ...rv, seq: 9 }]).outcome, 'reworked');
  assert.equal(ev.labelOutcome(task(), [rv, { from: 'lead', to: 'alpha-x', kind: 'chat', seq: 6 }]).outcome, 'reworked');
  // The lead writing *before* the done report is the brief being clarified, not rework.
  assert.equal(ev.labelOutcome(task(), [{ from: 'lead', to: 'alpha-x', kind: 'chat', seq: 2 }, rv]).outcome, 'clean');
  assert.equal(ev.labelOutcome(task(), [rv, { about: 'alpha-x', alert: true, seq: 1 }]).outcome, 'struggled');
  assert.equal(ev.labelOutcome(task(), [rv, { about: 'alpha-x', event: 'interrupt', seq: 1 }]).outcome, 'struggled');
  const esc = ev.labelOutcome(task(), [rv, { from: 'alpha-x', kind: 'escalation', seq: 1 }]);
  assert.equal(esc.outcome, 'struggled');
  assert.equal(esc.escalationOnly, true);
  // The early room's done line was a system line carrying `about`.
  assert.equal(ev.labelOutcome(task(), [{ kind: 'system', about: 'alpha-x', text: 'Worker alpha-x reports DONE, ready', seq: 1 }]).outcome, 'clean');
  assert.equal(ev.labelOutcome(task({ state: 'abandoned' }), [rv]).outcome, 'abandoned');
  assert.equal(ev.labelOutcome(task({ state: 'failed' }), [rv]).outcome, 'abandoned');
  assert.equal(ev.labelOutcome(task({ state: 'review' }), [rv]).outcome, 'open');
});

test('replayItems takes dispatched tasks only, oldest first, newest 30% held out', () => {
  const stateDir = path.join(tmp, 'items');
  writeState(stateDir);
  const { tasks, roomIndex } = ev.loadState(stateDir);
  const items = ev.replayItems(tasks, roomIndex);
  assert.equal(items.length, 9, 'the pending task is not replayed');
  assert.deepEqual(items.map((i) => i.split), ['train', 'train', 'train', 'train', 'train', 'train', 'held-out', 'held-out', 'held-out']);
  assert.ok(items.every((a, i) => i === 0 || items[i - 1].at <= a.at));
  const calls = ev.plannedCalls(items);
  // held-out first, both models, then train on Sonnet; every brief twice.
  assert.equal(calls.length, 3 * 2 * 2 + 6 * 2);
  assert.ok(calls.slice(0, 12).every((c) => c.it.split === 'held-out'));
  assert.ok(calls.filter((c) => c.model === ev.SECOND_MODEL).every((c) => c.it.split === 'held-out'));
  assert.equal(ev.plannedCalls(items, { secondModel: null }).length, 9 * 2);
});

test('pool never runs more than n at once', async () => {
  let live = 0;
  let peak = 0;
  await ev.pool([...Array(12).keys()], 3, async () => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
  });
  assert.equal(peak, 3);
});

test('parseArgs caps concurrency at three and defaults out under advisor-eval', () => {
  const o = ev.parseArgs(['replay', '--state-dir', '/s', '--concurrency', '8']);
  assert.equal(o.concurrency, 3);
  assert.ok(o.out.startsWith('/s/advisor-eval/'));
  assert.throws(() => ev.parseArgs(['replay', '--bogus']), /Unknown option/);
  assert.throws(() => ev.parseArgs(['nope']), /Unknown mode/);
});

test('callAdvisor: scrubbed env, input on stdin, junk refused, timeout killed', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'call-'));
  const { stub, log } = writeStub(dir);
  const env = { ...process.env, TMUX: '/tmp/fake,1,0', TMUX_PANE: '%99', CLAUDE_CODE_SESSION_ID: 'parent' };
  const good = await ev.callAdvisor({ claude: stub, input: 'Kind: build\nTag: none\n\n--- brief ---\nIn alpha, rename a.', model: 'claude-sonnet-5-5', cwd: dir, env });
  assert.equal(good.ok, true);
  assert.equal(good.model, 'claude-sonnet-5-5');
  assert.deepEqual(good.tokens, { input: 3, output: 40, cacheRead: 500, cacheWrite: 100 });
  const junk = await ev.callAdvisor({ claude: stub, input: 'JUNK', model: 'claude-sonnet-5-5', cwd: dir, env });
  assert.equal(junk.ok, false);
  const hang = await ev.callAdvisor({ claude: stub, input: 'HANG', model: 'claude-sonnet-5-5', cwd: dir, env, timeoutMs: 300 });
  assert.deepEqual([hang.ok, hang.error], [false, 'timed out']);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const c of calls) {
    assert.equal(c.tmux, null);
    assert.equal(c.pane, null);
    assert.equal(c.session, null);
    assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(dir));
    assert.ok(!c.args.some((a) => a.includes('--- brief ---')), 'input never in argv');
  }
  assert.ok(calls[0].input.endsWith('In alpha, rename a.'));
  const missing = await ev.callAdvisor({ claude: path.join(dir, 'no-such-claude'), input: 'x', model: 'claude-sonnet-5-5', cwd: dir });
  assert.equal(missing.ok, false);
});

test('replay end to end: rows, a nameless summary, a repo key, a resume that makes no call', async () => {
  const stateDir = path.join(tmp, 'e2e');
  const { tasks } = writeState(stateDir);
  const { stub, log } = writeStub(tmp);
  const out = path.join(stateDir, 'advisor-eval', 'test-run');
  const projectsDir = path.join(tmp, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const lines = [];
  const opts = { stateDir, out, claude: stub, concurrency: 3, limit: 0, secondModel: ev.SECOND_MODEL, budget: 1e12, timeoutMs: 10_000, projectsDir, log: (l) => lines.push(l) };
  const { rows, meta } = await ev.replay(opts);
  assert.equal(rows.length, 9 * 2 + 3 * 2);
  assert.ok(rows.every((r) => r.ok));
  // Haiku only ever ran on the held-out set, and without --effort.
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const haiku = calls.filter((c) => c.args.includes('claude-haiku-4-5-20251001'));
  assert.equal(haiku.length, 6);
  assert.ok(haiku.every((c) => !c.args.includes('--effort')));
  assert.equal(meta.rail.newWithInput, 0);
  assert.equal(meta.rail.advisorFolder, false);
  assert.equal(meta.advisorCwdEmpty, true);

  const s = ev.score(rows.filter((r) => r.advisorModel === 'claude-sonnet-5-5' && r.run === 1));
  // save: alpha-rename-one, alpha-old-opus5. risk: alpha-rename-two (alert), gamma-escalated (escalation only).
  // catch: beta-runner-fix (heavier, reworked). heavier-clean: gamma-queue-race.
  assert.equal(s.save, 2);
  assert.equal(s.risk, 2);
  assert.equal(s.riskEscalationOnly, 1);
  assert.equal(s.catch, 1);
  assert.equal(s.heavierClean, 1);
  assert.equal(s.noHistoryModel, 1);

  const summary = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  for (const t of tasks) {
    assert.ok(!summary.includes(t.id), `summary names task ${t.id}`);
    assert.ok(!summary.includes(t.body), 'summary carries brief text');
  }
  for (const r of Object.values(REPOS)) {
    assert.ok(!summary.includes(r), `summary names ${r}`);
    assert.ok(!summary.includes(path.basename(r)), `summary names ${path.basename(r)}`);
  }
  assert.ok(!summary.includes('stub says so'), 'no advisor reasons on the page');
  assert.match(summary, /Would risk/);
  assert.match(summary, /unscored/);
  assert.match(summary, /held-out set only/);
  for (const line of lines) for (const t of tasks) assert.ok(!line.includes(t.id), 'stdout names a task');
  const key = JSON.parse(fs.readFileSync(path.join(out, 'repo-key.json'), 'utf8'));
  assert.deepEqual(Object.values(key).sort(), Object.values(REPOS).sort());
  for (const h of Object.keys(key)) assert.ok(summary.includes(h));

  // Nothing written outside advisor/ and advisor-eval/.
  assert.deepEqual(fs.readdirSync(stateDir).sort(), ['advisor', 'advisor-eval', 'tasks.json', 'teams']);

  const n = fs.readFileSync(log, 'utf8').split('\n').length;
  await ev.replay(opts);
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').length, n, 'a resume makes no new call');
});

test('the budget guard stops a run early and the page says so', async () => {
  const stateDir = path.join(tmp, 'budget');
  writeState(stateDir);
  // Make the history long enough to pass the 30-call floor.
  const json = JSON.parse(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8'));
  for (let i = 0; i < 40; i++) json[`alpha-more-${i}`] = { ...json['alpha-rename-one'], id: `alpha-more-${i}`, createdAt: T0 + (20 + i) * DAY };
  fs.writeFileSync(path.join(stateDir, 'tasks.json'), JSON.stringify(json));
  const { stub } = writeStub(fs.mkdtempSync(path.join(tmp, 'b-')));
  const out = path.join(stateDir, 'advisor-eval', 'b');
  const { rows, meta } = await ev.replay({ stateDir, out, claude: stub, concurrency: 3, limit: 0, secondModel: null, budget: 1000, timeoutMs: 10_000, projectsDir: tmp, log: () => {} });
  assert.equal(meta.stopped, true);
  assert.ok(rows.length < 49 * 2 && rows.length >= 30);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /stopped early/);
});

test('live mode joins advice.jsonl with task records and outcomes, per team', () => {
  const stateDir = path.join(tmp, 'live');
  const { dirs } = writeState(stateDir);
  const json = JSON.parse(fs.readFileSync(path.join(stateDir, 'tasks.json'), 'utf8'));
  // alpha: two advised tasks — one followed (Sonnet, struggled), one overruled.
  json['alpha-rename-two'].model = 'claude-sonnet-5-5';
  json['alpha-rename-two'].effort = 'low';
  json['alpha-rename-two'].advice = { id: 'a1', model: 'claude-sonnet-5-5', effort: 'low', reason: 'r', version: 1 };
  json['alpha-rename-one'].advice = { id: 'a2', model: 'claude-sonnet-5-5', effort: 'low', reason: 'r', version: 1 };
  fs.writeFileSync(path.join(stateDir, 'tasks.json'), JSON.stringify(json));
  const line = (id, model, effort, extra = {}) => JSON.stringify({ id, at: T0, briefSha: 'x', kind: 'build', tag: 'chore', advisorVersion: 1, advisorModel: 'claude-sonnet-5-5', model, effort, reason: 'r', tokens: { in: 1200, out: 100 }, ms: 2000, ok: true, ...extra });
  fs.writeFileSync(path.join(dirs.alpha, 'advice.jsonl'), [line('a1', 'claude-sonnet-5-5', 'low'), line('a2', 'claude-sonnet-5-5', 'low'), line('a3', null, null, { ok: false, error: 'timed out' })].join('\n') + '\n');

  const { tasks, roomIndex } = ev.loadState(stateDir);
  const advice = fs.readFileSync(path.join(dirs.alpha, 'advice.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const rows = ev.liveRows(tasks.filter((t) => t.repo === REPOS.alpha), advice, roomIndex);
  const two = rows.find((r) => r.task === 'alpha-rename-two');
  assert.deepEqual([two.advised, two.followedModel, two.followedEffort, two.outcome], [true, true, true, 'struggled']);
  const one = rows.find((r) => r.task === 'alpha-rename-one');
  assert.deepEqual([one.followedModel, one.dir], [false, 'cheaper']);
  assert.equal(rows.find((r) => r.task === 'alpha-old-opus5').advised, false);

  const out = path.join(stateDir, 'advisor-eval', 'live-test');
  const teams = ev.live({ stateDir, out, log: () => {} });
  assert.equal(teams.length, 1, 'only the team that wrote advice');
  const page = fs.readFileSync(path.join(out, 'live-summary.md'), 'utf8');
  assert.ok(page.includes(ev.repoHash(REPOS.alpha)));
  assert.match(page, /followed the model: 1; overruled: 1/);
  assert.match(page, /lead followed\*\*: 1 of 1/);
  assert.match(page, /Advisor calls: 3 \(1 failed\)/);
  for (const t of tasks) assert.ok(!page.includes(t.id));
  assert.ok(!page.includes('alpha'));
});
