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
 * Hibernation's routes, against a real scratch panel on real throwaway state — the
 * `test/rooms-api.test.js` shape, and in the parts that build a bench very nearly its code.
 *
 * The sleepers are **seeded** into `hibernate.json` before the panel boots, rather than put
 * to sleep by it: the loop needs half an hour of idle at the shortest setting, and the
 * plan's rule is that nothing in the panel gets a test-only knob to go faster. The sleep
 * itself is proven in `test/hibernate-loop.test.js` with an injected clock, and on the bench.
 *
 * What is real: tmux (its own scratch server — `TMUX` deleted, `TMUX_TMPDIR` set), the panel
 * process, its stores, and **the launch a wake performs**: `createSession` running
 * `/bin/zsh -ilc 'claude …'` exactly as it does for anyone. What is not: Claude Code. The
 * shell's `ZDOTDIR` points at a `.zshrc` that puts a fake `claude` first on `PATH` — a script
 * that writes down the arguments it was given and then `exec`s a copy of node named
 * `claude`, parked on a captured idle screen, so the roster rosters it and `sendText` will
 * type into it. That is how this file can assert a wake passed `--resume <id>` and
 * `--model` without starting a real session.
 *
 * Nothing here touches the machine's real tmux server, the real state directory or port
 * 48770, no Terminal window is opened (every launch is `terminal: false` or a record that
 * was not attached), and no pane in it is a real Claude session.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const PREFIX = 'foreman-';

let child;
let port;
let stateDir;
let tmuxDir;
let bench = false;
let argsFile;

const IDS = {
  alpha: '0a1fa000-0000-4000-8000-00000000a1fa',
  beta: '0be7a000-0000-4000-8000-00000000be7a',
  gamma: '0ca33a00-0000-4000-8000-0000000ca33a',
  delta: '0de17a00-0000-4000-8000-0000000de17a',
};

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

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** The scratch tmux server — and, through `ZDOTDIR`, the fake `claude` every pane's shell finds. */
function tmuxEnv() {
  const env = { ...process.env, TMUX_TMPDIR: tmuxDir, ZDOTDIR: path.join(tmuxDir, 'zdot') };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

const tmux = (...args) =>
  execFileSync('tmux', ['-f', '/dev/null', ...args], { env: tmuxEnv(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

function buildFakeClaude() {
  try {
    const node = fs.realpathSync(process.execPath);
    fs.mkdirSync(path.join(tmuxDir, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tmuxDir, 'fake'), { recursive: true });
    fs.mkdirSync(path.join(tmuxDir, 'zdot'), { recursive: true });
    fs.symlinkSync(path.join(path.dirname(path.dirname(node)), 'lib'), path.join(tmuxDir, 'lib'));
    fs.copyFileSync(node, path.join(tmuxDir, 'bin', 'claude'));
    fs.chmodSync(path.join(tmuxDir, 'bin', 'claude'), 0o755);
    fs.writeFileSync(
      path.join(tmuxDir, 'screen.mjs'),
      "import fs from 'node:fs';\n" +
        "process.stdout.write(fs.readFileSync(process.argv[2], 'utf8'));\n" +
        'process.stdin.resume();\n',
    );
    // What the panel's own launch runs, by the bare word `claude`: note the arguments, then
    // become the parked node copy (so the pane's foreground command reads `claude`).
    argsFile = path.join(tmuxDir, 'args.log');
    fs.writeFileSync(
      path.join(tmuxDir, 'fake', 'claude'),
      '#!/bin/sh\n' +
        `printf '%s\\n' "$*" >> '${argsFile}'\n` +
        `exec '${path.join(tmuxDir, 'bin', 'claude')}' '${path.join(tmuxDir, 'screen.mjs')}' '${path.join(FIXTURES, 'pane-idle.txt')}'\n`,
    );
    fs.chmodSync(path.join(tmuxDir, 'fake', 'claude'), 0o755);
    fs.writeFileSync(path.join(tmuxDir, 'zdot', '.zshrc'), `export PATH='${path.join(tmuxDir, 'fake')}':"$PATH"\nunfunction claude 2>/dev/null\n`);
    execFileSync(path.join(tmuxDir, 'bin', 'claude'), ['-e', 'process.exit(0)']);
    return true;
  } catch {
    return false;
  }
}

function fakeSession(name, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  tmux(
    'new-session', '-d', '-s', name, '-c', cwd, '-x', '120', '-y', '40',
    path.join(tmuxDir, 'bin', 'claude'), path.join(tmuxDir, 'screen.mjs'), path.join(FIXTURES, 'pane-idle.txt'),
  );
}

const liveNames = () => {
  try {
    return tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

async function roster() {
  return (await api('GET', '/api/sessions')).body.sessions;
}

async function until(fn, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const record = (name, folder, id, extra = {}) => ({
  name,
  folder,
  slug: name.slice(PREFIX.length + path.basename(folder).length + 1),
  lead: false,
  sessionId: id,
  transcriptPath: path.join(stateDir, `${id}.jsonl`),
  title: name.slice(PREFIX.length),
  label: name.slice(PREFIX.length),
  project: path.basename(folder),
  bypass: false,
  attached: false,
  pinned: false,
  pinAfter: null,
  sleptAt: Date.now() - 60_000,
  idleSince: Date.now() - 3_600_000,
  lastActivity: Date.now() - 3_600_000,
  model: 'Opus 5.5',
  ...extra,
});

const held = (text, i) => ({ id: `h${i}`, text, at: Date.now() - 1000 + i, paneCreatedMs: null, attempts: 0, nextTryAt: 0, error: null });

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-hib-api-'));
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-hb-');
  port = await freePort();

  const dirs = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta'].map((d) => [d, path.join(stateDir, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // The lead-refusal case needs a git repo: `launchLead` checks for one before anything else.
  execFileSync('git', ['init', '-q', dirs.delta]);
  for (const id of Object.values(IDS)) fs.writeFileSync(path.join(stateDir, `${id}.jsonl`), '');

  await fsp.writeFile(
    path.join(stateDir, 'hibernate.json'),
    JSON.stringify({
      asleep: {
        [`${PREFIX}alpha-main`]: record(`${PREFIX}alpha-main`, dirs.alpha, IDS.alpha),
        [`${PREFIX}beta-main`]: record(`${PREFIX}beta-main`, dirs.beta, IDS.beta),
        [`${PREFIX}gamma-master`]: record(`${PREFIX}gamma-master`, dirs.gamma, IDS.gamma),
        [`${PREFIX}delta-lead`]: record(`${PREFIX}delta-lead`, dirs.delta, IDS.delta, { lead: true }),
      },
      keepAwake: [],
      held: {
        [`${PREFIX}alpha-main`]: [held('first for alpha', 0), held('second for alpha', 1)],
        [`${PREFIX}beta-main`]: [held('one for beta', 0), held('two for beta', 1)],
      },
      // A key this build has never heard of, which the store must carry through.
      fromTheFuture: { kept: true },
    }),
  );
  // A saved bench holding one sleeper, for the restore to skip.
  await fsp.writeFile(
    path.join(stateDir, 'snapshot.json'),
    JSON.stringify({ savedAt: 1, sessions: [{ folder: dirs.alpha, slug: 'main', tmuxSession: `${PREFIX}alpha-main`, skipPermissions: false, pinned: false }] }),
  );

  bench = buildFakeClaude();
  if (bench) {
    try {
      // A stranger now holds gamma's sleeper's name, so its wake must be refused.
      fakeSession(`${PREFIX}gamma-master`, dirs.gamma);
    } catch {
      bench = false;
    }
  }

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...tmuxEnv(), FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1', FOREMAN_STATE_DIR: stateDir },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  process.on('exit', () => child?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/asleep`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('the scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (bench) bench = Boolean(await until(async () => (await roster()).some((s) => s.tmuxSession === `${PREFIX}gamma-master`)));
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

/* --------------------------------------------------------------------- the frame --- */

test('the sleepers ride beside the roster, never in it, with what is waiting for each', async () => {
  const { status, body } = await api('GET', '/api/asleep');
  assert.equal(status, 200);
  const by = Object.fromEntries(body.asleep.map((r) => [r.name, r]));
  assert.equal(by[`${PREFIX}alpha-main`].waiting, 2);
  assert.equal(by[`${PREFIX}beta-main`].waiting, 2);
  assert.equal(by[`${PREFIX}delta-lead`].waiting, 0);
  assert.deepEqual(body.hibernation, { after: 'off', keepAwake: [] }, 'off by default');
  const sessions = await roster();
  for (const name of [`${PREFIX}alpha-main`, `${PREFIX}beta-main`, `${PREFIX}delta-lead`]) {
    assert.ok(!sessions.some((s) => s.tmuxSession === name), `${name} is not a roster row`);
  }
});

test('the setting is written through the settings route, and a wrong one is refused', async () => {
  const bad = await api('PATCH', '/api/config', { hibernateAfter: '2h' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /off, 30m, 1h, 4h, 12h/);
  const cfg = await api('GET', '/api/config');
  assert.deepEqual(cfg.body.hibernateChoices, ['off', '30m', '1h', '4h', '12h']);
  assert.equal(cfg.body.hibernateAfter, null, 'absent from the file');
  assert.equal(cfg.body.live.hibernateAfter, 'off');
  // Written as `off` explicitly: anything else would arm a real loop over this scratch bench.
  const ok = await api('PATCH', '/api/config', { hibernateAfter: 'off' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.hibernateAfter, 'off');
  assert.equal(ok.body.restartRequired, false, 'read at every pass, never at boot');
});

/* ------------------------------------------------------------------- keep awake --- */

test('keep awake is by name, for a live session or a sleeper, and refuses a stranger', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  assert.equal((await api('POST', '/api/asleep/keep-awake', { on: true })).status, 400);
  assert.equal((await api('POST', '/api/asleep/keep-awake', { name: `${PREFIX}gamma-master`, on: 'yes' })).status, 400);
  assert.equal((await api('POST', '/api/asleep/keep-awake', { name: `${PREFIX}nobody-main`, on: true })).status, 404);

  const on = await api('POST', '/api/asleep/keep-awake', { name: `${PREFIX}gamma-master`, on: true });
  assert.deepEqual(on.body, { ok: true, name: `${PREFIX}gamma-master`, keepAwake: true });
  assert.deepEqual((await api('GET', '/api/asleep')).body.hibernation.keepAwake, [`${PREFIX}gamma-master`]);
  const row = (await roster()).find((s) => s.tmuxSession === `${PREFIX}gamma-master`);
  const v = await api('GET', `/api/sessions/${row.id}/sleep`);
  assert.equal(v.body.keepAwake, true);
  assert.equal(v.body.ok, false);
  assert.equal(v.body.why, 'hibernation is off');

  await api('POST', '/api/asleep/keep-awake', { name: `${PREFIX}gamma-master`, on: false });
  assert.deepEqual((await api('GET', '/api/asleep')).body.hibernation.keepAwake, []);
});

/* ----------------------------------------------------------------------- forget --- */

test('forget drops the row and what was waiting, says how many, and keeps the conversation', async () => {
  const gone = await api('DELETE', `/api/asleep/${PREFIX}beta-main`);
  assert.equal(gone.status, 200);
  assert.equal(gone.body.dropped, 2);
  assert.ok(fs.existsSync(path.join(stateDir, `${IDS.beta}.jsonl`)), 'the transcript stays on disk');
  assert.equal((await api('DELETE', `/api/asleep/${PREFIX}beta-main`)).status, 404);
  assert.ok(!(await api('GET', '/api/asleep')).body.asleep.some((r) => r.name === `${PREFIX}beta-main`));
});

test('the store carried a key it has never heard of through its rewrites', async () => {
  const doc = await until(() => {
    const d = JSON.parse(fs.readFileSync(path.join(stateDir, 'hibernate.json'), 'utf8'));
    return d.asleep[`${PREFIX}beta-main`] ? null : d;
  }, 5000);
  assert.ok(doc, 'the forget reached the file');
  assert.deepEqual(doc.fromTheFuture, { kept: true });
});

/* --------------------------------------------------------------- the reservation --- */

test('+ new in a sleeper’s folder cannot mint its name', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', '/api/launch', { folder: path.join(stateDir, 'alpha'), label: 'main', terminal: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, `${PREFIX}alpha-main-2`);
  tmux('kill-session', '-t', `=${PREFIX}alpha-main-2`);
});

test('a lead whose name is asleep is refused, and told to wake it', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', '/api/launch', { lead: true, folder: path.join(stateDir, 'delta'), terminal: false });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'This project’s lead is asleep — wake it from its row.');
  assert.ok(!liveNames().includes(`${PREFIX}delta-lead`));
});

test('a snapshot restore skips a saved name that is asleep', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', '/api/snapshot/restore', { terminal: false });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.results.map((r) => [r.name, r.state, r.reason]),
    [[`${PREFIX}alpha-main`, 'skipped', 'asleep — wake it from its row']],
  );
  // And the drift dot does not light for it.
  assert.deepEqual((await api('GET', '/api/snapshot')).body.drift.missing, []);
});

/* ------------------------------------------------------------------------- wake --- */

test('a wake is refused for a name a stranger now holds, and the sleeper stays', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', `/api/asleep/${PREFIX}gamma-master/wake`);
  assert.equal(res.status, 409);
  assert.match(res.body.error, /Something else is running under/);
  assert.ok((await api('GET', '/api/asleep')).body.asleep.some((r) => r.name === `${PREFIX}gamma-master`));
  assert.equal((await api('POST', `/api/asleep/${PREFIX}nobody-main/wake`)).status, 404);
});

test('Wake starts it again under its own name, on --resume and the launch model, and hands over what was held', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', `/api/asleep/${PREFIX}alpha-main/wake`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, `${PREFIX}alpha-main`, 'the same name — not alpha-main-2');
  assert.equal(res.body.resumed, true);
  assert.equal(res.body.queued, 2);

  // What the launch actually ran.
  const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  const woke = runs.find((l) => l.includes(IDS.alpha));
  assert.ok(woke, `no launch carried --resume ${IDS.alpha}: ${runs.join(' | ')}`);
  assert.match(woke, new RegExp(`--resume ${IDS.alpha}`));
  assert.equal(woke.match(/--model /g)?.length, 1, 'exactly one --model');
  assert.match(woke, /--append-system-prompt-file /, 'a standalone’s own flags, today’s');

  // The record is gone, the row is live, and what was held reaches the new pane in order:
  // the first is typed as soon as the pane reads idle, and the second waits behind it.
  assert.ok(!(await api('GET', '/api/asleep')).body.asleep.some((r) => r.name === `${PREFIX}alpha-main`));
  const screen = await until(() => {
    const s = tmux('capture-pane', '-p', '-t', res.body.paneId, '-S', '-60');
    return s.includes('first for alpha') ? s : null;
  });
  assert.ok(screen, 'the first held message was typed into the woken pane');
  const row = (await roster()).find((s) => s.tmuxSession === `${PREFIX}alpha-main`);
  const rest = row.queued.map((q) => q.text);
  const onScreen = screen.indexOf('second for alpha');
  assert.ok(
    (onScreen > screen.indexOf('first for alpha')) || (rest.length === 1 && rest[0] === 'second for alpha'),
    `the second follows the first: queued ${JSON.stringify(rest)}`,
  );
});
