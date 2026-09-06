import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * Peer messages' one endpoint, against the real server — `test/team-api.test.js`'s shape,
 * for its reason: it lives inline in `server/index.js`, so there is nothing to import, and
 * the thing worth testing is the whole request/response with express body parsing and
 * status codes included.
 *
 * **One endpoint, because there used to be two.** `POST /api/shared-room/message` typed the
 * maintainer's own message into one chosen session and was retired on 2026-09-05; a group
 * room with one member is the same thing with a shared record. Its refusals had their own
 * eleven tests and a whole scratch tmux bench underneath them — a fake `claude` binary,
 * three panes parked on captured screens, a task record to make one of them a worker — and
 * all of that went with the endpoint, which is why this file is now short and touches no
 * tmux server at all.
 *
 * What is left is the log, which is the half the retirement kept: `GET` reads it back as a
 * tail with a cursor, and the send route is **gone** rather than merely refusing. That
 * second test is the regression guard — an endpoint that answered 405, or one that came
 * back in a later edit, would both pass a test that only checked "not 200".
 *
 * `TMUX_TMPDIR` still points at a scratch directory with no server in it, and `TMUX` is
 * deleted from the child's environment. Nothing here needs a roster; the isolation is so
 * that a scratch panel booted by a test run never polls the machine's real tmux server.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let child;
let port;
let stateDir;
/** An empty scratch socket directory, so the panel's tmux polling finds nothing of anyone's. */
let tmuxDir;

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
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* express's own 404 page is HTML; the status is what that test reads */
  }
  return { status: res.status, body: parsed, text };
}

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-shared-'));
  // Short on purpose, and not `os.tmpdir()`: a unix socket path has a hard length limit
  // around 104 bytes, and `$TMPDIR/…/tmux-501/default` on macOS overruns it — measured,
  // "File name too long" from tmux itself.
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-sr-');
  port = await freePort();

  const env = {
    ...process.env,
    TMUX_TMPDIR: tmuxDir,
    FOREMAN_PORT: String(port),
    FOREMAN_HOST: '127.0.0.1',
    FOREMAN_STATE_DIR: stateDir,
  };
  // Deleted rather than merely overridden: tmux reads the socket path out of `TMUX` and
  // would otherwise ignore `TMUX_TMPDIR` entirely — measured, a "scratch" server that
  // landed on the real one.
  delete env.TMUX;
  delete env.TMUX_PANE;

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
});

test.after(async () => {
  await stop(child);
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
  if (tmuxDir) await fsp.rm(tmuxDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ the log --- */

test('the log reads back as a tail, with a cursor', async () => {
  const res = await api('GET', '/api/shared-room');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.entries));
  assert.equal(typeof res.body.cursor, 'number');
});

/* ------------------------------------------------------- the retired send --- */

test('there is no send endpoint any more — the route is gone, not refusing', async () => {
  const before = (await api('GET', '/api/shared-room')).body.cursor;
  const res = await api('POST', '/api/shared-room/message', { to: 'anything', text: 'hello' });
  // 404 and not 405: express only answers 405 where a route exists for another method, so
  // this is the difference between "the handler was deleted" and "the handler is still
  // there and turning things away", which is what the retirement actually asked for.
  assert.equal(res.status, 404);
  assert.equal((await api('GET', '/api/shared-room')).body.cursor, before);
});
