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
 * `wake N asleep` — `POST /api/rooms/:id/wake-asleep` — against a real scratch panel, on the
 * bench `test/hibernate-api.test.js` builds and with its helpers copied rather than shared,
 * the way every API test here keeps its own: a scratch tmux server (`TMUX` deleted,
 * `TMUX_TMPDIR` set), the panel process on a scratch port and state dir, and a fake `claude`
 * on the shell's `PATH` that writes down its arguments and parks on an idle screen.
 *
 * The room holds four members in this order: alpha (asleep), delta (asleep, a **lead** whose
 * folder is not a git repo, so its wake fails in `launchLead` with a sentence), beta (awake,
 * a live fake pane) and gamma (asleep). zeta is asleep too and in no room. So one run proves:
 * the wakes are serial and in the room's order, a failure in the middle stops nothing after
 * it, a sleeper outside the room is untouched, a second press while the run holds the flag
 * is refused, and the room post held for each sleeper reaches its woken pane.
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
let bench = false;
let argsFile;

const IDS = {
  alpha: '0a1fa000-0000-4000-8000-00000000a1fa',
  gamma: '0ca33a00-0000-4000-8000-0000000ca33a',
  delta: '0de17a00-0000-4000-8000-0000000de17a',
  zeta: '0ce7a000-0000-4000-8000-00000000ce7a',
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

const ROOM = 'room-wake-1';
const QUIET = 'room-wake-2';

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-room-wake-'));
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-rw-');
  port = await freePort();

  const dirs = Object.fromEntries(['alpha', 'beta', 'gamma', 'delta', 'zeta'].map((d) => [d, path.join(stateDir, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  for (const id of Object.values(IDS)) fs.writeFileSync(path.join(stateDir, `${id}.jsonl`), '');

  await fsp.writeFile(
    path.join(stateDir, 'hibernate.json'),
    JSON.stringify({
      asleep: {
        [`${PREFIX}alpha-main`]: record(`${PREFIX}alpha-main`, dirs.alpha, IDS.alpha),
        [`${PREFIX}delta-lead`]: record(`${PREFIX}delta-lead`, dirs.delta, IDS.delta, { lead: true }),
        [`${PREFIX}gamma-master`]: record(`${PREFIX}gamma-master`, dirs.gamma, IDS.gamma),
        [`${PREFIX}zeta-main`]: record(`${PREFIX}zeta-main`, dirs.zeta, IDS.zeta),
      },
      keepAwake: [],
      held: {},
    }),
  );
  const member = (name) => ({ tmuxSession: `${PREFIX}${name}`, name, paneId: null, addedAt: 1 });
  await fsp.writeFile(
    path.join(stateDir, 'rooms.json'),
    JSON.stringify({
      seq: 2,
      rooms: [
        {
          id: ROOM,
          name: 'wake-bench',
          members: [member('alpha-main'), member('delta-lead'), member('beta-main'), member('gamma-master')],
          createdAt: 1,
        },
        { id: QUIET, name: 'all-awake', members: [member('beta-main')], createdAt: 1 },
      ],
    }),
  );

  bench = buildFakeClaude();
  if (bench) {
    try {
      fakeSession(`${PREFIX}beta-main`, dirs.beta);
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
  if (bench) bench = Boolean(await until(async () => (await roster()).some((s) => s.tmuxSession === `${PREFIX}beta-main`)));
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

const asleepNow = async () => (await api('GET', '/api/asleep')).body.asleep.map((r) => r.name).sort();

test('an unknown room is a 404, and a room with nobody asleep is a 409 that says so', async () => {
  assert.equal((await api('POST', '/api/rooms/no-such-room/wake-asleep')).status, 404);
  const quiet = await api('POST', `/api/rooms/${QUIET}/wake-asleep`);
  assert.equal(quiet.status, 409);
  assert.equal(quiet.body.error, 'Nobody in “all-awake” is asleep.');
});

test('a post to the room is held for each sleeper and typed to the one awake member', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', `/api/rooms/${ROOM}/post`, { text: 'hello from the bench' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const by = Object.fromEntries(res.body.entry.handed.map((m) => [m.tmuxSession, m.state]));
  assert.equal(by[`${PREFIX}alpha-main`], 'held');
  assert.equal(by[`${PREFIX}delta-lead`], 'held');
  assert.equal(by[`${PREFIX}gamma-master`], 'held');
  assert.notEqual(by[`${PREFIX}beta-main`], 'held');
  const waiting = Object.fromEntries((await api('GET', '/api/asleep')).body.asleep.map((r) => [r.name, r.waiting]));
  assert.equal(waiting[`${PREFIX}alpha-main`], 1);
  assert.equal(waiting[`${PREFIX}gamma-master`], 1);
});

test('wake N asleep wakes the room’s sleepers in order, one failure stops nothing, and a second press is refused', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  // Both presses at once: the first takes the flag before it awaits anything, so the second
  // finds it held.
  const [first, second] = await Promise.all([
    api('POST', `/api/rooms/${ROOM}/wake-asleep`),
    api('POST', `/api/rooms/${ROOM}/wake-asleep`),
  ]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already running/);

  const { results } = first.body;
  assert.deepEqual(
    results.map((r) => [r.name, r.state]),
    [
      [`${PREFIX}alpha-main`, 'woken'],
      [`${PREFIX}delta-lead`, 'failed'],
      [`${PREFIX}gamma-master`, 'woken'],
    ],
    'the room’s order, the awake member skipped, and the failure in the middle stops nothing after it',
  );
  assert.match(results[1].error, /did not wake: Not a git repository/, 'the reason, in words');
  assert.equal(results[0].queued, 1);
  assert.equal(results[2].queued, 1);

  // Each woke on --resume of its own conversation — and the run launched nothing else.
  const runs = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  assert.ok(runs.some((l) => l.includes(`--resume ${IDS.alpha}`)), runs.join(' | '));
  assert.ok(runs.some((l) => l.includes(`--resume ${IDS.gamma}`)), runs.join(' | '));
  assert.ok(!runs.some((l) => l.includes(IDS.zeta)), 'a sleeper in no room is not woken');

  // The failed lead and the sleeper outside the room are still asleep; the two woken are not.
  assert.deepEqual(await asleepNow(), [`${PREFIX}delta-lead`, `${PREFIX}zeta-main`]);
  const live = (await roster()).map((s) => s.tmuxSession);
  assert.ok(live.includes(`${PREFIX}alpha-main`) && live.includes(`${PREFIX}gamma-master`), live.join(', '));
  assert.ok(!live.some((n) => /-2$/.test(n ?? '')), 'nobody came back as -2');

  // The held room post reaches each woken pane.
  for (const r of [results[0], results[2]]) {
    const screen = await until(() => {
      const s = tmux('capture-pane', '-p', '-t', r.paneId, '-S', '-60');
      return s.includes('hello from the bench') ? s : null;
    });
    assert.ok(screen, `the held room post was typed into ${r.name}`);
  }
});

test('a press after the run wakes only who is still asleep in the room', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', `/api/rooms/${ROOM}/wake-asleep`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => [r.name, r.state]), [[`${PREFIX}delta-lead`, 'failed']]);
});
