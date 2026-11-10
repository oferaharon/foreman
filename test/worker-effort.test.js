import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * A team's default worker effort, and the lead's per-task departure from it — the
 * maintainer's ruling of 2026-11-10, built on the model's pattern.
 *
 * What is pinned here is everything that can be pinned without a server: the leaf's list
 * and default, `resolveWorkerEffort`, what a team.json and a task record read as when they
 * predate the field, and — read off the source, the `test/logs.test.js` idiom — the three
 * facts that sit past `Setup failed` on the dispatch path, where `test/team-api.test.js`
 * cannot reach without launching a real Claude Code: the `--effort` flag, the room line
 * and its stamp. The HTTP half (validation, storage, the picker's write) is in
 * `test/team-api.test.js`; the tool surface is in `test/mcp.test.js`; the brief pin is in
 * `test/brief.test.js`.
 *
 * The CLI facts these rest on were MEASURED on Claude Code v2.1.296 in the sandbox, not
 * assumed, and are written down in `server/worker-models.js` beside the list.
 */

// STATE_DIR is read at import time by `team.js`, `tasks.js` and `dispatch.js` — a scratch
// one first, so nothing here can touch the real store.
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'foreman-effort-'));
const {
  WORKER_EFFORTS,
  DEFAULT_WORKER_EFFORT,
  isKnownEffort,
  takesEffort,
  MODELS_WITHOUT_EFFORT,
  WORKER_MODELS,
} = await import('../server/worker-models.js');
const { resolveWorkerEffort } = await import('../server/dispatch.js');
const { teamDefaults, ensureTeam, readTeam, teamDir } = await import('../server/team.js');
const { TaskStore } = await import('../server/tasks.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test.after(() => {
  fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- the leaf --- */

test('the levels are exactly what `claude --effort` accepts, in the CLI\'s own order', () => {
  // `claude --help`, v2.1.296: "Effort level for the current session (low, medium, high,
  // xhigh, max)". `ultracode` is a stop on the /effort track and is not an --effort value.
  assert.deepEqual(WORKER_EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.ok(!WORKER_EFFORTS.includes('ultracode'));
});

test('the default is high — the ruling is that workers stop defaulting to xhigh', () => {
  assert.equal(DEFAULT_WORKER_EFFORT, 'high');
  assert.ok(WORKER_EFFORTS.includes(DEFAULT_WORKER_EFFORT));
});

test('a level is known only exactly as spelled', () => {
  for (const level of WORKER_EFFORTS) assert.equal(isKnownEffort(level), true, level);
  // The CLI warns about a bad value and launches on the global default anyway (measured),
  // so a near-miss accepted here would launch xhigh and say nothing.
  for (const bad of ['HIGH', ' high', 'high ', 'ultracode', 'extra-high', '', null, undefined, 3, ['high']]) {
    assert.equal(isKnownEffort(bad), false, String(bad));
  }
});

test('Haiku 4.5 takes no effort level, and every other launchable model does', () => {
  // Measured: Haiku launched with --effort records no `effort` on any transcript record.
  assert.deepEqual(MODELS_WITHOUT_EFFORT, ['claude-haiku-4-5-20251001']);
  for (const id of WORKER_MODELS) {
    const expected = !MODELS_WITHOUT_EFFORT.includes(id);
    assert.equal(takesEffort(id), expected, id);
    assert.equal(takesEffort(`${id}[1m]`), expected, `${id}[1m]`);
  }
  // Every model it names must be one the panel can launch — a name off the list would be
  // a rule about nothing.
  for (const id of MODELS_WITHOUT_EFFORT) assert.ok(WORKER_MODELS.includes(id), id);
});

/* ------------------------------------------------------ resolveWorkerEffort --- */

test('no choice anywhere → high, and that is not a departure', () => {
  assert.deepEqual(resolveWorkerEffort(undefined, undefined, 'claude-opus-5-5'), {
    effort: 'high',
    defaultEffort: 'high',
    isDefault: true,
  });
  assert.deepEqual(resolveWorkerEffort('', '', 'claude-opus-5-5').effort, 'high');
});

test('the team default fills in when the lead names nothing', () => {
  const r = resolveWorkerEffort(null, 'medium', 'claude-opus-5-5');
  assert.equal(r.effort, 'medium');
  assert.equal(r.defaultEffort, 'medium');
  assert.equal(r.isDefault, true);
});

test('an explicit level wins, and is a departure', () => {
  const r = resolveWorkerEffort('xhigh', 'high', 'claude-opus-5-5');
  assert.equal(r.effort, 'xhigh');
  assert.equal(r.defaultEffort, 'high');
  assert.equal(r.isDefault, false);
});

test('naming the default explicitly is not a departure', () => {
  assert.equal(resolveWorkerEffort('high', 'high', 'claude-opus-5-5').isDefault, true);
  assert.equal(resolveWorkerEffort('high', null, 'claude-opus-5-5').isDefault, true);
});

test('an unknown level fails the dispatch, naming the list — and is never a flags channel', () => {
  assert.throws(() => resolveWorkerEffort('ultracode', null, 'claude-opus-5-5'), /Unknown effort "ultracode"/);
  assert.throws(() => resolveWorkerEffort('bogus', null, 'claude-opus-5-5'), new RegExp(WORKER_EFFORTS.join(', ')));
  assert.throws(
    () => resolveWorkerEffort('high --dangerously-skip-permissions', null, 'claude-opus-5-5'),
    /Unknown effort/,
  );
  assert.throws(() => resolveWorkerEffort('HIGH', null, 'claude-opus-5-5'), /Unknown effort/);
});

test('a corrupted stored default fails loudly, even under an explicit choice', () => {
  assert.throws(() => resolveWorkerEffort(null, 'turbo', 'claude-opus-5-5'), /defaultEffort "turbo"/);
  assert.throws(() => resolveWorkerEffort('low', 'turbo', 'claude-opus-5-5'), /defaultEffort/);
});

test('a model that takes no effort resolves to none, and is not a departure', () => {
  const r = resolveWorkerEffort(undefined, 'xhigh', 'claude-haiku-4-5-20251001');
  assert.equal(r.effort, null, 'no flag, and nothing on the record claiming one');
  assert.equal(r.defaultEffort, 'xhigh');
  assert.equal(r.isDefault, true, 'nothing was departed from, so the room hears nothing');
});

test('an explicit level for a model that takes none is refused, not humoured', () => {
  assert.throws(
    () => resolveWorkerEffort('low', 'high', 'claude-haiku-4-5-20251001'),
    /Haiku 4\.5 takes no effort level/,
  );
  // The unknown-level check still comes first: the lead hears about the typo, not the model.
  assert.throws(() => resolveWorkerEffort('bogus', 'high', 'claude-haiku-4-5-20251001'), /Unknown effort/);
});

test('with no model given, the model question is skipped — what the settings write wants', () => {
  assert.equal(resolveWorkerEffort('max', null).effort, 'max');
  assert.equal(resolveWorkerEffort('', null).effort, 'high');
  assert.throws(() => resolveWorkerEffort('nope', null), /Unknown effort/);
});

/* ------------------------------------------------- what older files read as --- */

test('a team with no team.json reads the default effort', () => {
  assert.equal(teamDefaults('/Users/x/Code/Api').defaultEffort, 'high');
});

test('a team.json written before the field existed reads as high, and keeps its other keys', () => {
  const repo = '/Users/x/Code/OldTeam';
  fs.mkdirSync(teamDir(repo), { recursive: true });
  fs.writeFileSync(
    path.join(teamDir(repo), 'team.json'),
    JSON.stringify({ repo, defaultModel: 'claude-sonnet-5-5', maxWorkers: 2 }, null, 2),
  );
  const team = readTeam(repo);
  assert.equal(team.defaultEffort, 'high', 'the whole point: not the global xhigh');
  assert.equal(team.defaultModel, 'claude-sonnet-5-5');
  assert.equal(team.maxWorkers, 2);
});

test('a stored default effort survives the seeding rewrite', () => {
  const repo = '/Users/x/Code/SetTeam';
  fs.mkdirSync(teamDir(repo), { recursive: true });
  fs.writeFileSync(path.join(teamDir(repo), 'team.json'), JSON.stringify({ repo, defaultEffort: 'medium' }));
  ensureTeam(repo);
  const onDisk = JSON.parse(fs.readFileSync(path.join(teamDir(repo), 'team.json'), 'utf8'));
  assert.equal(onDisk.defaultEffort, 'medium');
});

test('a task record from before the field reads effort as null, and a new one stores it', () => {
  const file = path.join(process.env.FOREMAN_STATE_DIR, 'tasks-effort.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ old: { id: 'old', repo: '/r', state: 'done', model: 'claude-opus-5-5', body: 'b' } }),
  );
  const store = new TaskStore(file);
  clearInterval(store.timer);
  assert.equal(store.get('old').effort, null, 'it inherited a setting the panel never saw — null is true');
  assert.equal(store.get('old').effortReason, null);

  const made = store.create({ id: 'new', repo: '/r', body: 'b', effort: 'low', effortReason: 'a rename' });
  assert.equal(made.effort, 'low');
  assert.equal(made.effortReason, 'a rename');
  assert.equal(store.create({ id: 'bare', repo: '/r', body: 'b' }).effort, null);

  // And the store's own rollback safety: a field it is handed back on disk is kept.
  store.flush();
  const again = new TaskStore(file);
  clearInterval(again.timer);
  assert.equal(again.get('new').effort, 'low');
});

/* -------------------------------------- past `Setup failed`, read off source --- */

const index = read('server', 'index.js');

test('the worker launch carries --effort, only when there is a level to carry', () => {
  const launch = index.match(/extraArgs: \[\n\s+'--settings', settingsFile,[\s\S]*?\n\s+\],/)[0];
  assert.match(launch, /'--model', model\.model,/);
  assert.match(launch, /\.\.\.\(effort\.effort \? \['--effort', effort\.effort\] : \[\]\),/);
  // The flag value is the resolved level and nothing else — never a request field.
  assert.ok(!/req\.body\?\.effort/.test(launch));
});

test('the non-default effort line is stamped `event: \'effort\'` and names both levels and the why', () => {
  const block = index.match(/if \(!effort\.isDefault\) \{\n\s+room\.post[\s\S]*?\n {4}\}/)[0];
  assert.match(block, /event: 'effort'/);
  assert.match(block, /kind: 'system'/);
  assert.match(block, /\$\{effort\.effort\} effort, not the default \$\{effort\.defaultEffort\} — \$\{effortReason\}/);
});

test('both config responses serve the levels from the leaf', () => {
  const calls = index.match(/efforts: WORKER_EFFORTS,/g) || [];
  assert.equal(calls.length, 2, 'the GET and the PATCH, which the panel treats as one shape');
});

test('the room gives the effort line no colour of its own, like the model line', () => {
  // `roomEntryNode` claims a hue only for an exact list of events; a departure is a fact
  // to read, not an alarm. If this ever changes, it changes for model and effort together.
  const app = read('web', 'app.js');
  assert.ok(!/e\.event === 'effort'/.test(app));
  assert.ok(!/e\.event === 'model'/.test(app));
});

/* ------------------------------------------------------------- the picker --- */

test('the team panel\'s effort picker draws the served levels and writes defaultEffort', () => {
  const app = read('web', 'app.js');
  assert.match(app, /const effortIds = Array\.isArray\(team\.efforts\) \? \[\.\.\.team\.efforts\] : \[\];/);
  assert.match(app, /await patchTeam\(\{ defaultEffort: effortPick\.value \}\);/);
  // One spelling: the browser is handed the list and holds no copy of it.
  for (const level of WORKER_EFFORTS) {
    assert.ok(!app.includes(`'${level}'`), `${level} is spelled in web/app.js`);
    assert.ok(!app.includes(`"${level}"`), `${level} is spelled in web/app.js`);
  }
});

test('the task modal shows the effort and its reason, on desktop and phone', () => {
  for (const file of [['web', 'app.js'], ['web', 'm', 'tasks.js']]) {
    const src = read(...file);
    assert.match(src, /fact\('effort', t\.effort\);\n\s+fact\('why', t\.effortReason\);/, file.join('/'));
  }
});
