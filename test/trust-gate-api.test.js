import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isTrustGate, trustOption } from '../web/trust-gate.js';

/*
 * Answering the folder-trust gate, end to end, against a real scratch panel and real tmux
 * panes. `test/trust-gate.test.js` is the pure half — the witness, the reader, the card.
 *
 * This file replaces a test that asserted `POST /api/sessions/:id/answer` returned **409**
 * with the pane still sitting on the gate. The 2026-09-19 ruling reversed that stance (see
 * `web/trust-gate.js`'s header for what was weighed and by whom), so what is asserted now is
 * the whole path: the roster reads the pane as `needs-decision` with a trust prompt, the
 * endpoint walks the cursor onto the row it was asked for, presses Enter, and the pane moves
 * on. Plus `answerTrustGate`, the one gate the panel answers unattended, which v2.1.257's
 * layout had broken outright.
 *
 * ── What is real here and what is not ────────────────────────────────────────────────
 *
 * Real: tmux, the panel process, the roster, `parsePane` and `parseTrustGate`,
 * `confirmGateOption`'s press-and-re-read, and the keys that actually cross the socket.
 *
 * Not real: Claude Code. The pane runs a small program that draws the **committed
 * v2.1.257 capture** — not a reconstruction — and moves the `❯` on an arrow key, wrapping at
 * the ends exactly as the real box was measured to. It is the same fake-`claude` bench
 * `test/rooms-api.test.js` builds, and for the same reason: `sessions.js` only rosters a
 * pane whose foreground command is `claude`, and `sendText` refuses one that is not. That
 * guard is what stops the panel typing into a shell that would *execute* the text, and it is
 * not one to work around in the server to make a test easier.
 *
 * A simulation cannot prove what Claude Code does with an Enter key. That was measured on
 * the bench against a live v2.1.257 session in a throwaway folder, and written down in
 * `docs/traps/launch.md`. What this file proves is the panel's half: that it never sends
 * Enter until the pane's own `❯` is on the row the caller named, and that a **wrapping** list
 * does not make it press the other answer — which on this screen is the difference between
 * granting a folder and killing the session.
 *
 * Nothing here touches the machine's real tmux server, the real state directory or port
 * 48770, and no pane in it is a real Claude session.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');

/** The session prefix a panel with no `sessionPrefix` in its config mints under. */
const PREFIX = 'foreman-';

let child;
let port;
let stateDir;
let tmuxDir;
/** Whether the fake-Claude bench came up at all. */
let bench = false;
/**
 * `server/dispatch.js`, loaded in `before` and never at the top of this file.
 *
 * `server/tmux.js` builds `TMUX_ENV` from `process.env` **at module load**, and a static
 * import is hoisted above every statement that could set `TMUX_TMPDIR` — so a static import
 * here would point `answerTrustGate` at the machine's real tmux server. It is the same hoist
 * that points a test at the real state dir (`test/state-dir.test.js`), and the reason this
 * file is split from `test/trust-gate.test.js` at all.
 */
let dispatch;

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

const tmux = (...args) =>
  execFileSync('tmux', ['-f', '/dev/null', ...args], {
    env: process.env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/**
 * The pane program: the real capture, and the cursor behaviour that was measured on it.
 *
 * `Down` moves down and **wraps** from the last row to the first — the fact that makes a
 * counted number of presses wrong rather than merely fragile. `Enter` on the trust row hands
 * back an ordinary idle composer; on the refusal row it leaves a dead screen, the way a
 * session that has exited does, so a test can tell "landed on Yes" from "landed on No"
 * without reading Claude Code's mind.
 */
const GATE_PROGRAM = `
import fs from 'node:fs';

const gate = fs.readFileSync(process.argv[2], 'utf8').split('\\n');
const after = fs.readFileSync(process.argv[3], 'utf8');

const rows = [];
for (let i = 0; i < gate.length; i += 1) {
  if (/No, exit|I trust this folder/.test(gate[i])) rows.push(i);
}
let cursor = rows.findIndex((i) => gate[i].includes('❯'));
let done = null;

const draw = () => {
  const out = gate.slice();
  rows.forEach((line, n) => {
    const label = out[line].replace('❯', '').trim();
    out[line] = (n === cursor ? ' ❯ ' : '   ') + label;
  });
  process.stdout.write('\\u001b[2J\\u001b[H' + (done ?? out.join('\\n')));
};

process.stdin.setRawMode?.(true);
process.stdin.on('data', (buf) => {
  if (done) return;
  const keys = buf.toString('binary');
  if (keys.includes('\\u001b[B')) cursor = (cursor + 1) % rows.length;
  else if (keys.includes('\\u001b[A')) cursor = (cursor - 1 + rows.length) % rows.length;
  else if (keys.includes('\\r') || keys.includes('\\n')) {
    done = /I trust this folder/.test(gate[rows[cursor]]) ? after : '\\n(exited)\\n';
  }
  draw();
});
draw();
process.stdin.resume();
`;

/** A pane parked on the gate, named so the panel will roster it. */
function gatePane(label, cwd, gateFixture, cols, rows) {
  fs.mkdirSync(cwd, { recursive: true });
  tmux(
    'new-session', '-d',
    '-s', `${PREFIX}${label}`,
    '-c', cwd,
    '-x', String(cols), '-y', String(rows),
    path.join(tmuxDir, 'bin', 'claude'),
    path.join(tmuxDir, 'gate.mjs'),
    path.join(FIXTURES, gateFixture),
    path.join(FIXTURES, 'pane-idle.txt'),
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
    fs.writeFileSync(path.join(tmuxDir, 'gate.mjs'), GATE_PROGRAM);
    execFileSync(path.join(tmuxDir, 'bin', 'claude'), ['-e', 'process.exit(0)']);
    return true;
  } catch {
    return false;
  }
}

/** The roster row for a label, once the panel has one. */
async function rosterRow(label, deadline = Date.now() + 20_000) {
  for (;;) {
    const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
    const { sessions } = await res.json();
    const row = sessions.find((s) => s.label === label && s.prompt);
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const screenOf = (label) => tmux('capture-pane', '-p', '-t', `${PREFIX}${label}`);

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-trust-'));
  // Short on purpose, and not `os.tmpdir()`: a unix socket path has a hard length limit
  // around 104 bytes, and `$TMPDIR/…/tmux-501/default` on macOS overruns it.
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-tg-');
  port = await freePort();

  // The scratch tmux server, and nothing else's. `TMUX` is deleted rather than merely
  // overridden: tmux reads the socket path out of it and would otherwise ignore
  // `TMUX_TMPDIR` entirely — and `$TMUX` is set whenever this test run is itself inside a
  // pane, which is most of the time on this Mac.
  process.env.TMUX_TMPDIR = tmuxDir;
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  dispatch = await import('../server/dispatch.js');

  bench = buildFakeClaude();
  if (bench) {
    try {
      gatePane('alpha-trust-1', path.join(stateDir, 'alpha-trust-1'), 'pane-trust-gate.txt', 220, 50);
      gatePane('beta-trust-1', path.join(stateDir, 'beta-trust-1'), 'pane-trust-gate-narrow.txt', 70, 40);
      gatePane('gamma-trust-1', path.join(stateDir, 'gamma-trust-1'), 'pane-trust-gate.txt', 220, 50);
      gatePane('alpha-trust-2', path.join(stateDir, 'alpha-trust-2'), 'pane-trust-gate-narrow.txt', 70, 40);
      gatePane('beta-trust-2', path.join(stateDir, 'beta-trust-2'), 'pane-trust-gate.txt', 220, 50);
    } catch {
      bench = false;
    }
  }

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOREMAN_PORT: String(port),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: stateDir,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  process.on('exit', () => child?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/sessions`);
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

for (const [label, width] of [
  ['alpha-trust-1', '220 columns'],
  ['beta-trust-1', '70 columns'],
]) {
  test(`the gate is answered and the pane moves on (${width})`, async (t) => {
    if (!bench) return t.skip('no fake-claude bench on this machine');

    const row = await rosterRow(label);
    assert.ok(row, 'the pane never reached the roster with a prompt on it');
    assert.equal(row.status, 'needs-decision', 'the regression: v2.1.257 read as `dialog`');
    assert.equal(isTrustGate(row.prompt), true);

    const yes = trustOption(row.prompt);
    assert.ok(yes, 'no row on the box says it grants');
    assert.equal(yes.selected, false, 'the cursor starts on No — there is a walk to do');

    const res = await api('POST', `/api/sessions/${encodeURIComponent(row.id)}/answer`, {
      option: yes.index,
      expectLabel: yes.label,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.answered.label, 'Yes, I trust this folder');

    const screen = screenOf(label);
    assert.doesNotMatch(screen, /Accessing workspace/, 'the pane is still sitting on the gate');
    assert.doesNotMatch(screen, /\(exited\)/, 'Enter landed on the wrong row');
  });
}

test('answering No presses the other row, not the far end of a counted walk', async (t) => {
  if (!bench) return t.skip('no fake-claude bench on this machine');

  const row = await rosterRow('gamma-trust-1');
  assert.ok(row);
  const no = row.prompt.options.find((o) => /^No/.test(o.label));

  const res = await api('POST', `/api/sessions/${encodeURIComponent(row.id)}/answer`, {
    option: no.index,
    expectLabel: no.label,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(screenOf('gamma-trust-1'), /\(exited\)/);
});

test('a label that no longer matches the box is refused with nothing sent', async (t) => {
  if (!bench) return t.skip('no fake-claude bench on this machine');

  // The render-to-click guard, on the one screen where the label is all there is: no digit
  // to cross-check with, so the label is also what `confirmGateOption` holds the pane's own
  // `❯` against before it commits.
  const row = await rosterRow('alpha-trust-2');
  assert.ok(row);
  const res = await api('POST', `/api/sessions/${encodeURIComponent(row.id)}/answer`, {
    option: 1,
    expectLabel: 'Yes, and never ask again',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /nothing was sent/);
  assert.match(screenOf('alpha-trust-2'), /Accessing workspace/, 'and the pane did not move');
});

test('answerTrustGate answers a v2.1.257 gate for the worktree a dispatch just made', async (t) => {
  if (!bench) return t.skip('no fake-claude bench on this machine');

  // The regression's other half. This function required `❯\s*1\.`, and v2.1.257 has neither
  // a `1.` nor the cursor on Yes, so it could never answer — every dispatched worker sat on
  // an unanswered gate. The folder guard is exercised first: a gate whose screen does not
  // name *this* worktree is never confirmed, however answerable it looks.
  const row = await rosterRow('beta-trust-2');
  assert.ok(row);

  assert.equal(
    await dispatch.answerTrustGate(row.paneId, path.join(stateDir, 'some-other-worktree'), { tries: 1 }),
    'unrecognised',
    'a gate, but not ours',
  );
  assert.match(screenOf('beta-trust-2'), /Accessing workspace/, 'and nothing was pressed');

  // The gate's own capture names `alpha-trust-1`, which is the folder a real dispatch would
  // have created — the pane's tmux name is a separate thing and deliberately not what the
  // guard reads.
  assert.equal(await dispatch.answerTrustGate(row.paneId, path.join(stateDir, 'alpha-trust-1')), 'answered');
  assert.doesNotMatch(screenOf('beta-trust-2'), /Accessing workspace/);
  assert.doesNotMatch(screenOf('beta-trust-2'), /\(exited\)/);
});
