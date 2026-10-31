import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { asleepItems, drawnPinnedNames } from '../web/asleep.js';

/*
 * A sleeper's pin, live — the star and the grip on a sleeping row, by the maintainer's ruling
 * of 2026-10-31 — against a real scratch panel on real throwaway state: the harness of
 * `test/hibernate-api.test.js`, sleepers seeded into `hibernate.json` before boot, two fake
 * `claude` panes pinned through the ordinary route, and a real wake through the fake launch.
 *
 * One order across two stores, and every step below checks the order **as drawn**:
 * `drawnPinnedNames` over the roster's live pins and the sleepers' records — the rail's own
 * function — must read exactly what the step meant. The steps run in order and build on each
 * other, from the seeded group `G O B T W` (G, B, T asleep; O, W live; S asleep, unpinned).
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
  G: '0ca33a00-0000-4000-8000-0000000ca33a',
  B: '0be7a000-0000-4000-8000-00000000be7a',
  T: '0ca33b00-0000-4000-8000-0000000ca33b',
  S: '0be7b000-0000-4000-8000-00000000be7b',
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


let dirs;
const N = (k) => ({ G: `${PREFIX}gamma-master`, B: `${PREFIX}beta-main`, T: `${PREFIX}gamma-tail`, S: `${PREFIX}beta-spare`, O: `${PREFIX}alpha-one`, W: `${PREFIX}alpha-two` })[k];
const K = (name) => ['G', 'B', 'T', 'S', 'O', 'W'].find((k) => N(k) === name) ?? name;

/** The pinned group as the rail would draw it now, as letters. */
async function drawn() {
  const sessions = await roster();
  const live = sessions.filter((s) => s.pinned).sort((a, b) => a.pinOrder - b.pinOrder).map((s) => s.tmuxSession);
  const asleep = (await api('GET', '/api/asleep')).body.asleep;
  return drawnPinnedNames(live, asleepItems(asleep).filter((s) => s.pinned)).map(K).join(' ');
}

const untilDrawn = (want) => until(async () => ((await drawn()) === want ? want : null), 10_000);
const paneOf = async (k) => (await roster()).find((s) => s.tmuxSession === N(k))?.paneId;
/** A row as the drop sends it: its pane while it is live, its name while it is asleep. */
const entry = async (k) => (await paneOf(k)) ?? { asleep: N(k) };
const drop = async (...ks) => api('POST', '/api/pins/order', { panes: await Promise.all(ks.map(entry)) });

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-pin-api-'));
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-pa-');
  port = await freePort();
  dirs = Object.fromEntries(['alpha', 'beta', 'gamma'].map((d) => [d, path.join(stateDir, d)]));
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  for (const id of Object.values(IDS)) fs.writeFileSync(path.join(stateDir, `${id}.jsonl`), '');

  await fsp.writeFile(
    path.join(stateDir, 'hibernate.json'),
    JSON.stringify({
      asleep: {
        [N('G')]: record(N('G'), dirs.gamma, IDS.G, { pinned: true, pinAfter: null, sleptAt: Date.now() - 50_000 }),
        [N('B')]: record(N('B'), dirs.beta, IDS.B, { pinned: true, pinAfter: N('O'), sleptAt: Date.now() - 40_000 }),
        [N('T')]: record(N('T'), dirs.gamma, IDS.T, { pinned: true, pinAfter: N('B'), sleptAt: Date.now() - 30_000 }),
        [N('S')]: record(N('S'), dirs.beta, IDS.S),
      },
      keepAwake: [],
      held: {},
      fromTheFuture: { kept: true },
    }),
  );

  bench = buildFakeClaude();
  if (bench) {
    try {
      fakeSession(N('O'), dirs.alpha);
      fakeSession(N('W'), dirs.alpha);
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
  if (bench) {
    const rows = await until(async () => {
      const r = await roster();
      return r.some((s) => s.tmuxSession === N('O')) && r.some((s) => s.tmuxSession === N('W')) ? r : null;
    });
    bench = Boolean(rows);
    if (bench) {
      for (const k of ['O', 'W']) {
        const row = rows.find((s) => s.tmuxSession === N(k));
        await api('POST', `/api/sessions/${row.id}/pin`, { pinned: true });
      }
      bench = Boolean(await untilDrawn('G O B T W'));
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

test('an order that leaves out a pinned sleeper, or names one that is not pinned, is refused', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const liveOnly = await drop('W', 'O');
  assert.equal(liveOnly.status, 409, 'the old live-only body, with sleepers pinned');
  assert.ok(Array.isArray(liveOnly.body.order));
  assert.deepEqual(Object.keys(liveOnly.body.asleep).map(K).sort(), ['B', 'G', 'T'], 'what it holds rides back');
  assert.equal((await drop('G', 'O', 'B', 'T', 'W', 'S')).status, 409, 'S is asleep but not pinned');
  assert.equal((await drop('G', 'O', 'B', 'T', 'W', 'G')).status, 400);
  assert.equal(await drawn(), 'G O B T W', 'nothing moved');
});

test('a drop that interleaves live rows and sleepers lands exactly as dropped', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await drop('W', 'G', 'B', 'O', 'T');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    Object.fromEntries(Object.entries(res.body.asleep).map(([n, a]) => [K(n), a && K(a)])),
    { G: 'W', B: 'G', T: 'O' },
    'each sleeper anchored to the row directly above it',
  );
  assert.ok(await untilDrawn('W G B O T'), `drawn ${await drawn()}`);
});

test('a sleeper is pinned from its star to the bottom, and unpinned out of the group', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  assert.equal((await api('POST', `/api/asleep/${PREFIX}nobody-main/pin`, { pinned: true })).status, 404);
  const pin = await api('POST', `/api/asleep/${N('S')}/pin`, { pinned: true });
  assert.deepEqual(pin.body, { ok: true, name: N('S'), pinned: true });
  assert.ok(await untilDrawn('W G B O T S'), `drawn ${await drawn()}`);

  // G had B under it: B takes G's place and nothing else moves.
  const unpin = await api('POST', `/api/asleep/${N('G')}/pin`, { pinned: false });
  assert.equal(unpin.status, 200);
  assert.ok(await untilDrawn('W B O T S'), `drawn ${await drawn()}`);
  const g = (await api('GET', '/api/asleep')).body.asleep.find((r) => r.name === N('G'));
  assert.equal(g.pinned, false, 'still asleep, now among its folder’s rows');
  assert.equal(g.pinAfter, null);

  // A toggle with no body flips it, as the live star does.
  assert.equal((await api('POST', `/api/asleep/${N('G')}/pin`)).body.pinned, true);
  assert.ok(await untilDrawn('W B O T S G'));
  assert.equal((await api('POST', `/api/asleep/${N('G')}/pin`)).body.pinned, false);
  assert.ok(await untilDrawn('W B O T S'));
});

test('unpinning a live row re-anchors the sleeper under it; re-pinning it goes to the bottom', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const w = (await roster()).find((s) => s.tmuxSession === N('W'));
  assert.equal((await api('POST', `/api/sessions/${w.id}/pin`, { pinned: false })).status, 200);
  assert.ok(await untilDrawn('B O T S'), `drawn ${await drawn()}`);
  assert.equal((await api('POST', `/api/sessions/${w.id}/pin`, { pinned: true })).status, 200);
  assert.ok(await untilDrawn('B O T S W'), `drawn ${await drawn()}`);
});

test('a pinned sleeper anchored to another sleeper wakes exactly where it was drawn', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  // S sits under T, which is asleep: the wake used to look for T among the live pins, not
  // find it, and put S at the bottom — below W.
  assert.equal((await api('GET', '/api/asleep')).body.asleep.find((r) => r.name === N('S')).pinAfter, N('T'));
  const res = await api('POST', `/api/asleep/${N('S')}/wake`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, N('S'));
  assert.ok(await untilDrawn('B O T S W'), `drawn ${await drawn()}`);
  const s = (await roster()).find((r) => r.tmuxSession === N('S'));
  assert.ok(s?.pinned, 'it is a live pin now, in the store');
  assert.ok(!(await api('GET', '/api/asleep')).body.asleep.some((r) => r.name === N('S')));
});

test('forgetting a pinned sleeper re-anchors the one under it', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  assert.equal((await api('POST', `/api/asleep/${N('G')}/pin`, { pinned: true })).status, 200);
  assert.ok(await untilDrawn('B O T S W G'), `drawn ${await drawn()}`);
  assert.equal((await drop('B', 'O', 'T', 'G', 'S', 'W')).status, 200);
  assert.ok(await untilDrawn('B O T G S W'), `drawn ${await drawn()}`);
  const res = await api('DELETE', `/api/asleep/${N('T')}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(await untilDrawn('B O G S W'), `drawn ${await drawn()}`);
});

test('the store carried a key it has never heard of through every rewrite', async () => {
  await new Promise((r) => setTimeout(r, 2500));
  const doc = JSON.parse(fs.readFileSync(path.join(stateDir, 'hibernate.json'), 'utf8'));
  assert.deepEqual(doc.fromTheFuture, { kept: true });
});
