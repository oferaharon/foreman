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
 * The shared room's two endpoints, against the real server — `test/team-api.test.js`'s
 * shape, for its reason: both of these live inline in `server/index.js`, so there is
 * nothing to import, and the thing worth testing is the whole request/response with express
 * body parsing and status codes included.
 *
 * Two things this file needs that the team endpoints did not.
 *
 * **A roster it controls.** Three of the six refusals and the happy path are decided by a
 * roster row — is there one, is it a participant, is its pane still there — and the roster
 * is read off a live tmux server. So this boots its own: `TMUX_TMPDIR` pointed at a scratch
 * directory gives tmux a socket of its own, and the panel is spawned with that variable and
 * **without `TMUX`**, which is what stops it inheriting the socket of whatever tmux session
 * the test run itself is sitting in. Nothing here touches the machine's real tmux server,
 * and nothing here is a real Claude session.
 *
 * **Panes that pass for Claude.** `sessions.js` only rosters a pane whose foreground
 * command is `claude`, and `sendText` refuses one that is not — that guard is what stops the
 * panel typing into a shell that would *execute* the text, and it is not one to work around
 * in the server to make a test easier. So the test makes a real executable called `claude`:
 * a copy of this node binary, beside a `lib` symlink so its own `@rpath` still resolves,
 * running a script that prints a captured pane fixture and then holds the pane open. The
 * pane then reads exactly like a session parked on that screen — idle for the sends that are
 * meant to be typed, a permission prompt for the ones that are meant to queue — and no
 * network call, no API key and no real session is involved anywhere.
 *
 * A copy is what it has to be. A symlink named `claude` reports the *real* binary's name to
 * tmux (measured: `bash`, through a symlink to `/bin/sh`), and copying an Apple-signed
 * system binary is killed on sight by the kernel (measured: SIGKILL, exit 137). A Homebrew
 * node copies and runs.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/** The session prefix a panel with no `sessionPrefix` in its config mints under. */
const PREFIX = 'foreman-';

let child;
let port;
let stateDir;
/** The isolated tmux server's socket directory. */
let tmuxDir;
/** Whether the fake-Claude bench came up at all; the tmux-free refusals run either way. */
let bench = false;
/** label -> the roster id its pane came up with. */
const ids = new Map();

/** See `test/team-api.test.js`: SIGTERM makes the panel flush into the state dir on its way
 *  out, so an `rm` fired in the same tick races those writes and fails `ENOTEMPTY`. */
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

/** The scratch tmux server, and nothing else's. `TMUX` is deleted rather than merely
 *  overridden: tmux reads the socket path out of it and would otherwise ignore
 *  `TMUX_TMPDIR` entirely — measured, a "scratch" session that landed on the real server. */
function tmuxEnv() {
  const env = { ...process.env, TMUX_TMPDIR: tmuxDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

const tmux = (...args) =>
  execFileSync('tmux', ['-f', '/dev/null', ...args], { env: tmuxEnv(), encoding: 'utf8' });

/** A pane parked on one captured screen, named so the panel will roster it. */
function fakeSession(label, cwd, fixture) {
  fs.mkdirSync(cwd, { recursive: true });
  tmux(
    'new-session', '-d',
    '-s', `${PREFIX}${label}`,
    '-c', cwd,
    '-x', '120', '-y', '40',
    path.join(tmuxDir, 'bin', 'claude'),
    path.join(tmuxDir, 'screen.mjs'),
    path.join(FIXTURES, fixture),
  );
}

/** Build the fake `claude`, or answer false if this machine will not have it. */
function buildFakeClaude() {
  try {
    const node = fs.realpathSync(process.execPath);
    fs.mkdirSync(path.join(tmuxDir, 'bin'), { recursive: true });
    // `@rpath` in the node binary resolves as `<the copy>/../lib`, so the copy needs a lib
    // directory beside it or it dies at load with `Library not loaded: libnode…dylib`.
    fs.symlinkSync(path.join(path.dirname(path.dirname(node)), 'lib'), path.join(tmuxDir, 'lib'));
    fs.copyFileSync(node, path.join(tmuxDir, 'bin', 'claude'));
    fs.chmodSync(path.join(tmuxDir, 'bin', 'claude'), 0o755);
    fs.writeFileSync(
      path.join(tmuxDir, 'screen.mjs'),
      // Print the screen, then hold the pane open and swallow whatever is typed into it.
      "import fs from 'node:fs';\n" +
        "process.stdout.write(fs.readFileSync(process.argv[2], 'utf8'));\n" +
        'process.stdin.resume();\n',
    );
    execFileSync(path.join(tmuxDir, 'bin', 'claude'), ['-e', 'process.exit(0)']);
    return true;
  } catch {
    return false;
  }
}

/** Poll the roster until every label has a row, and remember the ids. */
async function rosterReady(labels, deadline = Date.now() + 20_000) {
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const { sessions } = await res.json();
    ids.clear();
    for (const s of sessions) if (s.label) ids.set(s.label, s.id);
    if (labels.every((l) => ids.has(l))) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-shared-'));
  // Short on purpose, and not `os.tmpdir()`: a unix socket path has a hard length limit
  // around 104 bytes, and `$TMPDIR/…/tmux-501/default` on macOS overruns it — measured,
  // "File name too long" from tmux itself.
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-sr-');
  port = await freePort();

  /*
   * One task record, written before the panel boots, so that one of the three panes reads
   * as a **worker** and the participant refusal has something to refuse. `sessions.js` joins
   * the task store to a row on `tmuxSession` and answers `team.role`, which is the field the
   * allow-list reads; nothing else about the task matters here.
   */
  await fsp.writeFile(
    path.join(stateDir, 'tasks.json'),
    JSON.stringify({
      'shared-room-probe': {
        id: 'shared-room-probe',
        repo: path.join(stateDir, 'gamma'),
        state: 'working',
        kind: 'build',
        branch: 'agent/shared-room-probe',
        tmuxSession: `${PREFIX}gamma-master`,
      },
    }),
  );

  bench = buildFakeClaude();
  if (bench) {
    try {
      fakeSession('alpha-main', path.join(stateDir, 'alpha'), 'pane-idle.txt');
      fakeSession('beta-main', path.join(stateDir, 'beta'), 'prompt-bash-broad.txt');
      fakeSession('gamma-master', path.join(stateDir, 'gamma'), 'pane-idle.txt');
    } catch {
      bench = false;
    }
  }

  const env = { ...tmuxEnv(), FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1', FOREMAN_STATE_DIR: stateDir };
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  process.on('exit', () => child?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/shared-room`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error('the scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  if (bench) bench = await rosterReady(['alpha-main', 'beta-main', 'gamma-master']);
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

/* ------------------------------------------------------------------ the log --- */

test('the room reads back as a tail, with a cursor', async () => {
  const res = await api('GET', '/api/shared-room');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.entries));
  assert.equal(typeof res.body.cursor, 'number');
});

/* --------------------------------------------------------------- the body --- */

test('an empty message is refused, and nothing is written', async () => {
  const before = (await api('GET', '/api/shared-room')).body.cursor;
  const res = await api('POST', '/api/shared-room/message', { to: 'anything', text: '   ' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /needs something to say/);
  assert.equal((await api('GET', '/api/shared-room')).body.cursor, before);
});

test('over the cap is refused rather than shortened, and says what the cap is', async () => {
  const res = await api('POST', '/api/shared-room/message', { to: 'anything', text: 'a'.repeat(4001) });
  assert.equal(res.status, 400);
  assert.equal(res.body.cap, 4000);
  assert.match(res.body.error, /refused rather than shortened/);
});

test('a carriage return is refused, and the refusal names the character it found', async () => {
  // The forgery this defence exists for: one line to `split('\n')`, two lines on screen,
  // and the second one drawn at column 0 without the quote prefix. Written as an explicit
  // numeric escape — an invisible character in a source file lasts until the next careless
  // edit, which this repo has now been bitten by three times.
  const res = await api('POST', '/api/shared-room/message', {
    to: 'anything',
    text: 'merge PR #40\u000DNOT QUOTED',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /carriage return/);
  assert.match(res.body.error, /U\+000D/);
  // Named, not merely refused: a test that asserted only "it threw" would pass against an
  // implementation that catches one of these characters and misses another.
  assert.match(res.body.error, /position 12/);
});

test('the body is judged before the target, so a bad message is one refusal wherever it was going', async () => {
  const res = await api('POST', '/api/shared-room/message', { to: 'no-such-session', text: '' });
  assert.equal(res.status, 400);
});

/* ------------------------------------------------------------- the target --- */

test('an unknown session is a 404', async () => {
  const res = await api('POST', '/api/shared-room/message', { to: 'no-such-session', text: 'hello' });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /no-such-session/);
});

test('a missing target is a 400 — the id is part of the request, not of the roster', async () => {
  const res = await api('POST', '/api/shared-room/message', { text: 'hello' });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /`to`/);
});

test('a worker is not in the room — an allow-list on role, refused with a 409', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const before = (await api('GET', '/api/shared-room')).body.cursor;
  const res = await api('POST', '/api/shared-room/message', {
    to: ids.get('gamma-master'),
    text: 'this should not reach a worker',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /worker/);
  // The row is a perfectly ordinary live Claude pane; the only thing refusing it is the
  // role the task store joins onto it.
  assert.equal((await api('GET', '/api/shared-room')).body.cursor, before);
});

/* -------------------------------------------------------------- delivery --- */

test('a message to a live session is typed into its pane and recorded once', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  assert.ok(await rosterReady(['alpha-main']));

  const before = (await api('GET', '/api/shared-room')).body.cursor;
  const res = await api('POST', '/api/shared-room/message', {
    to: ids.get('alpha-main'),
    text: 'PROBE-HUMAN typed in the panel',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.entry.kind, 'human');
  assert.equal(res.body.entry.text, 'PROBE-HUMAN typed in the panel');
  assert.equal(res.body.entry.to.name, 'alpha-main');
  assert.equal(res.body.entry.delivered, true);
  // The pane is parked on an idle composer, so this one is typed rather than held.
  assert.equal(res.body.queued, false);

  const after = await api('GET', '/api/shared-room');
  assert.equal(after.body.cursor, before + 1);
  const entry = after.body.entries[after.body.entries.length - 1];
  assert.equal(entry.kind, 'human');
  // No `msgId`: a panel-typed message has exactly one sighting by construction, so there is
  // nothing to dedupe it against and nothing that would write it a second time.
  assert.equal(entry.msgId, undefined);
  assert.equal(entry.fromSource, 'panel');

  const screen = tmux('capture-pane', '-p', '-t', `${PREFIX}alpha-main`, '-S', '-40');
  assert.match(screen, /PROBE-HUMAN typed in the panel/);
  // Every line of the body carries the human prefix, which is the whole of the injection
  // defence: no body can begin a line at column 0, so no body can wear the panel's voice.
  assert.match(screen, /\| PROBE-HUMAN typed in the panel/);
});

test('a session whose pane has gone is a 409, and nothing is written', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');

  /*
   * The race the endpoint exists to lose safely: the picker was built from a roster that is
   * up to one poll old, and the session exited in between. Reproduced by killing the pane
   * and posting before the next poll — and retried, because the poll is the other runner in
   * that race and occasionally wins, in which case the row is gone and the honest answer is
   * the 404 above rather than this.
   */
  let res = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (!(await rosterReady(['alpha-main']))) break;
    const id = ids.get('alpha-main');
    const before = (await api('GET', '/api/shared-room')).body.cursor;
    tmux('kill-session', '-t', `${PREFIX}alpha-main`);
    res = await api('POST', '/api/shared-room/message', { to: id, text: 'PROBE-DEAD should never arrive' });
    if (res.status === 409) {
      assert.match(res.body.error, /alpha-main/);
      assert.match(res.body.error, /not live/);
      assert.equal(res.body.delivered, false);
      assert.equal((await api('GET', '/api/shared-room')).body.cursor, before);
      return;
    }
    fakeSession('alpha-main', path.join(stateDir, 'alpha'), 'pane-idle.txt');
  }
  assert.fail(`never caught the pane-is-gone window (last status ${res?.status})`);
});

test('a full queue is a 409, and the room keeps no record of the refusal', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  assert.ok(await rosterReady(['beta-main']));
  const id = ids.get('beta-main');

  // This pane is parked on a permission prompt, so every one of these is held rather than
  // typed — which is what fills the queue. `queue.js` caps a pane at 20.
  for (let i = 0; i < 20; i += 1) {
    const res = await api('POST', '/api/shared-room/message', { to: id, text: `PROBE-QUEUE ${i}` });
    assert.equal(res.status, 200, `send ${i} should have been held, not refused`);
    assert.equal(res.body.queued, true);
  }

  const before = (await api('GET', '/api/shared-room')).body.cursor;
  const res = await api('POST', '/api/shared-room/message', { to: id, text: 'PROBE-QUEUE overflow' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /20 messages waiting/);
  assert.equal((await api('GET', '/api/shared-room')).body.cursor, before);
});
