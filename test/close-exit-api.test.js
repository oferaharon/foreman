import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * Closing a task whose worker has background work running, end to end, against a real
 * scratch panel and real tmux panes. `test/exit-box.test.js` is the reader and
 * `test/exit-session.test.js` the key sequence; this is the endpoint: that the close does
 * not sweep until the session's name has left tmux, answers the background-work box with
 * `Exit and stop tasks` and names what that stopped in the room line, and that a session
 * which does not go leaves the task, its worktree and its branch exactly as they were.
 *
 * Real: tmux, the panel, the roster, `parsePane`, the git worktree and branch, the room.
 * Not real: Claude Code. The pane runs a small program that draws the **committed v2.1.296
 * captures** and answers keys the way the real box was measured to — arrows move the `❯` and
 * wrap, Enter commits the row under it, a digit commits its row, Escape puts the composer
 * back — and exits when it is told to. It is the fake-`claude` bench `test/trust-gate-api.test.js`
 * builds, for that file's reason: the roster only admits a pane whose command is `claude`.
 * What Claude Code itself does with those keys was measured on the bench and is written in
 * `server/exit-box.js`.
 *
 * Nothing here touches the machine's real tmux server, the real state directory or port
 * 48770, and no pane in it is a real Claude session.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const PREFIX = 'foreman-';

let child;
let port;
let stateDir;
let tmuxDir;
let repo;
let bench = false;

function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill();
  });
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port: p } = probe.address();
  await new Promise((r) => probe.close(r));
  return p;
}

const tmux = (...args) =>
  execFileSync('tmux', ['-f', '/dev/null', ...args], { env: process.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

const git = (args, cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/**
 * The pane program. argv: the composer capture, the box capture (or `-` for none), what
 * `/exit` does (`box`, `exit` or `stuck`), and a log file every committed answer is written
 * to — so a test can tell which row Enter landed on, and whether a digit ever arrived.
 */
const EXIT_PROGRAM = `
import fs from 'node:fs';

const [composer, boxFile, mode, log] = process.argv.slice(2);
const box = boxFile === '-' ? [] : fs.readFileSync(boxFile, 'utf8').split('\\n');
const ROW = /^\\s*(❯\\s*)?(\\d)\\.\\s+(.*)$/;
const rows = box.map((l, i) => (ROW.test(l) ? i : -1)).filter((i) => i >= 0);
const labels = rows.map((i) => ROW.exec(box[i])[3]);
let cursor = 0;
let screen = 'composer';
let typed = '';

const note = (line) => fs.appendFileSync(log, line + '\\n');
const draw = () => {
  let text = fs.readFileSync(composer, 'utf8');
  if (screen === 'box') {
    const out = box.slice();
    rows.forEach((at, n) => { out[at] = (n === cursor ? '  ❯ ' : '    ') + (n + 1) + '. ' + labels[n]; });
    text = out.join('\\n');
  }
  process.stdout.write('\\u001b[2J\\u001b[H' + text);
};
const commit = (n) => {
  note('commit ' + labels[n]);
  if (/^Exit and stop tasks$|^Move to background and exit$/.test(labels[n])) process.exit(0);
  screen = 'composer';
};

process.stdin.setRawMode?.(true);
process.stdin.on('data', (buf) => {
  const keys = buf.toString('binary');
  if (screen === 'box') {
    if (keys === '\\u001b') { note('escape'); screen = 'composer'; }
    else if (keys.includes('\\u001b[B') || keys.includes('\\u001bOB')) cursor = (cursor + 1) % rows.length;
    else if (keys.includes('\\u001b[A') || keys.includes('\\u001bOA')) cursor = (cursor - 1 + rows.length) % rows.length;
    else if (keys === '\\r') commit(cursor);
    else if (/^\\d$/.test(keys)) { note('digit ' + keys); commit(Number(keys) - 1); }
    else note('stray ' + JSON.stringify(keys));
    return draw();
  }
  for (const ch of keys) {
    if (ch === '\\u0015') typed = '';
    else if (ch === '\\r') {
      if (typed === '/exit') {
        note('/exit');
        if (mode === 'exit') process.exit(0);
        if (mode === 'box') { screen = 'box'; cursor = 0; }
      }
      typed = '';
    } else typed += ch;
  }
  draw();
});
draw();
process.stdin.resume();
`;

function buildFakeClaude() {
  try {
    const node = fs.realpathSync(process.execPath);
    fs.mkdirSync(path.join(tmuxDir, 'bin'), { recursive: true });
    fs.symlinkSync(path.join(path.dirname(path.dirname(node)), 'lib'), path.join(tmuxDir, 'lib'));
    fs.copyFileSync(node, path.join(tmuxDir, 'bin', 'claude'));
    fs.chmodSync(path.join(tmuxDir, 'bin', 'claude'), 0o755);
    fs.writeFileSync(path.join(tmuxDir, 'exit.mjs'), EXIT_PROGRAM);
    execFileSync(path.join(tmuxDir, 'bin', 'claude'), ['-e', 'process.exit(0)']);
    return true;
  } catch {
    return false;
  }
}

const logOf = (id) => path.join(tmuxDir, `${id}.log`);
const readLog = (id) => (fs.existsSync(logOf(id)) ? fs.readFileSync(logOf(id), 'utf8').trim().split('\n').filter(Boolean) : []);

/** The scenarios: one task, one worktree, one fake worker each. */
const WORKERS = [
  { id: 'wide-box', mode: 'box', box: 'dialog-exit-background.txt', cols: 220, rows: 50 },
  { id: 'narrow-box', mode: 'box', box: 'dialog-exit-background-narrow.txt', cols: 80, rows: 23 },
  { id: 'nothing-running', mode: 'exit', box: null, cols: 220, rows: 50 },
  { id: 'renamed-row', mode: 'box', box: 'renamed', cols: 220, rows: 50 },
  { id: 'never-goes', mode: 'stuck', box: null, cols: 220, rows: 50 },
];

const sessionOf = (id) => `${PREFIX}alpha-${id}`;
const worktreeOf = (id) => path.join(stateDir, 'worktrees', `alpha-${id}`);
const live = (id) => {
  try {
    tmux('has-session', '-t', sessionOf(id));
    return true;
  } catch {
    return false;
  }
};
const branchExists = (id) => git(['branch', '--list', `agent/${id}`]).trim() !== '';

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** Wait until the roster has a row for this worker's session, so the close can find it. */
async function rostered(id, deadline = Date.now() + 20_000) {
  for (;;) {
    const { sessions } = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
    if (sessions.some((s) => s.tmuxSession === sessionOf(id) && s.paneId)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const roomLines = async (id) =>
  (await api('GET', `/api/team/room?folder=${encodeURIComponent(repo)}`)).body.entries.filter((e) => e.about === id);

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-close-'));
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-cx-');
  port = await freePort();
  process.env.TMUX_TMPDIR = tmuxDir;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;

  repo = path.join(stateDir, 'alpha');
  fs.mkdirSync(repo, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'alpha\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);
  fs.mkdirSync(path.join(stateDir, 'teams', repo.replace(/\//g, '-').replace(/^-/, '')), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'teams', repo.replace(/\//g, '-').replace(/^-/, ''), 'team.json'),
    JSON.stringify({ repo }, null, 2),
  );

  fs.writeFileSync(
    path.join(tmuxDir, 'renamed.txt'),
    fs.readFileSync(path.join(FIXTURES, 'dialog-exit-background.txt'), 'utf8').replace('Exit and stop tasks', 'Exit and stop all tasks'),
  );

  bench = buildFakeClaude();
  const records = {};
  for (const w of WORKERS) {
    const dir = worktreeOf(w.id);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(['worktree', 'add', '-q', dir, '-b', `agent/${w.id}`, 'main']);
    fs.writeFileSync(path.join(dir, `${w.id}.txt`), `${w.id}\n`);
    git(['add', '-A'], dir);
    git(['commit', '-q', '-m', w.id], dir);
    records[w.id] = {
      id: w.id, repo, kind: 'build', body: `the ${w.id} worker`, source: 'chat', state: 'review',
      branch: `agent/${w.id}`, worktree: dir, base: 'main', staleBase: false, model: null, modelReason: null,
      startedBy: null, tmuxSession: sessionOf(w.id), pr: null,
      createdAt: '2026-11-09T08:00:00.000Z', updatedAt: '2026-11-09T09:00:00.000Z',
    };
    if (!bench) continue;
    const boxFile = w.box === 'renamed' ? path.join(tmuxDir, 'renamed.txt') : w.box ? path.join(FIXTURES, w.box) : '-';
    tmux(
      'new-session', '-d', '-s', sessionOf(w.id), '-c', dir, '-x', String(w.cols), '-y', String(w.rows),
      path.join(tmuxDir, 'bin', 'claude'), path.join(tmuxDir, 'exit.mjs'),
      path.join(FIXTURES, 'pane-idle.txt'), boxFile, w.mode, logOf(w.id),
    );
  }
  fs.writeFileSync(path.join(stateDir, 'tasks.json'), JSON.stringify(records, null, 2));

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOREMAN_PORT: String(port),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: stateDir,
      FOREMAN_CLAUDE_CONFIG: path.join(stateDir, 'claude.json'),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  fs.writeFileSync(path.join(stateDir, 'claude.json'), JSON.stringify({ mcpServers: {} }, null, 2));
  process.on('exit', () => child?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/team/tasks`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('the scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

test.after(async () => {
  await stop(child);
  try {
    tmux('kill-server');
  } catch {
    /* already gone */
  }
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
  if (tmuxDir) await fsp.rm(tmuxDir, { recursive: true, force: true });
});

for (const [id, width, stopped] of [
  ['wide-box', '220 columns', ['shell · sleep 600', 'monitor · wait for the marker file']],
  ['narrow-box', '80 columns', ['shell · sleep 600']],
]) {
  test(`a worker with background work is ended, then swept, and the room says what stopped (${width})`, async (t) => {
    if (!bench) return t.skip('no fake-claude bench on this machine');
    assert.ok(await rostered(id), 'the worker never reached the roster');

    const res = await api('POST', `/api/team/tasks/${id}/close`, { outcome: 'abandon' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.stopped, stopped);
    assert.equal(res.body.task.state, 'abandoned');

    assert.deepEqual(readLog(id), ['/exit', 'commit Exit and stop tasks'], 'one /exit, one answer, by label, no digit');
    assert.equal(live(id), false, 'the session is gone — the orphan this fixes');
    assert.equal(fs.existsSync(worktreeOf(id)), false, 'and only then the worktree');
    assert.equal(branchExists(id), false);

    const closed = (await roomLines(id)).find((e) => e.event === 'closed');
    assert.ok(closed, 'a close line');
    assert.match(closed.text, new RegExp(`stopped on exit: ${stopped.join('; ')}\\.$`));
  });
}

test('done, with nothing running: the close line reads exactly as it always has', async (t) => {
  if (!bench) return t.skip('no fake-claude bench on this machine');
  assert.ok(await rostered('nothing-running'));
  git(['merge', '-q', '--no-ff', 'agent/nothing-running', '-m', 'merged nothing-running']);

  const res = await api('POST', '/api/team/tasks/nothing-running/close', { outcome: 'done' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.stopped, []);
  assert.equal(live('nothing-running'), false);
  assert.deepEqual(readLog('nothing-running'), ['/exit']);
  const closed = (await roomLines('nothing-running')).find((e) => e.event === 'closed');
  assert.equal(closed.text, 'Task nothing-running is done — merged and cleaned up.');
});

/** The refusals: nothing about the task, its worktree or its branch has moved. */
async function assertUntouched(id) {
  const task = (await api('GET', '/api/team/tasks')).body.tasks.find((x) => x.id === id);
  assert.equal(task.state, 'review', 'the task was not closed');
  assert.equal(fs.existsSync(worktreeOf(id)), true, 'the worktree is still there');
  assert.equal(branchExists(id), true, 'the branch is still there');
  assert.equal(live(id), true, 'and so is the session');
  assert.equal((await roomLines(id)).some((e) => e.event === 'closed'), false, 'nothing announced as cleaned up');
}

test('a box it cannot answer by label is Escaped, and the close is a 409 that changed nothing', async (t) => {
  if (!bench) return t.skip('no fake-claude bench on this machine');
  assert.ok(await rostered('renamed-row'));

  const res = await api('POST', '/api/team/tasks/renamed-row/close', { outcome: 'abandon' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /offers no “Exit and stop tasks” row; pressed Escape/);
  assert.match(res.body.error, /Nothing was changed/);
  assert.deepEqual(readLog('renamed-row'), ['/exit', 'escape'], 'Escape and nothing else — no row was pressed');
  await assertUntouched('renamed-row');
  const alert = (await roomLines('renamed-row')).find((e) => e.alert);
  assert.match(alert.text, /was not closed/);
});

test('a session that never leaves is a 409 after the wait, and nothing was swept', async (t) => {
  if (!bench) return t.skip('no fake-claude bench on this machine');
  assert.ok(await rostered('never-goes'));

  const res = await api('POST', '/api/team/tasks/never-goes/close', { outcome: 'abandon' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /did not close in time — still running/);
  assert.deepEqual(readLog('never-goes'), ['/exit']);
  await assertUntouched('never-goes');
});
