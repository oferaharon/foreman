import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * The one server change hibernation's desktop item makes: a sleeper's pane is opened
 * read-only over the ordinary `subscribe`, and the roster has no row for it — so a miss
 * falls back to the sleep record, and the transcript read is the one **the panel wrote down**
 * when it put the session to sleep, never a path a client sent.
 *
 * A real scratch panel on real throwaway state, its own empty tmux server (`TMUX` deleted,
 * `TMUX_TMPDIR` set) and a port of its own. Nothing here touches the real panel, its state
 * or its tmux server, and no Claude session is started.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = '0a51e0a0-0000-4000-8000-0000000a51e0';
const NAME = 'foreman-alpha-sleepy';

let child;
let port;
let stateDir;
let tmuxDir;

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port: p } = probe.address();
  await new Promise((r) => probe.close(r));
  return p;
}

/** Open `/ws`, send one frame, and collect frames until `want` matches one or time runs out. */
async function ask(frame, want, ms = 8000) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (want(msg)) {
          clearTimeout(timer);
          resolve(msg);
        }
      };
      ws.send(JSON.stringify(frame));
    });
  } finally {
    ws.close();
  }
}

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-asleep-sub-'));
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-as-');
  port = await freePort();
  const folder = path.join(stateDir, 'alpha');
  fs.mkdirSync(folder, { recursive: true });

  // The sleeper's conversation, where the record says it is.
  const transcript = path.join(stateDir, `${ID}.jsonl`);
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  fs.writeFileSync(
    transcript,
    [
      { type: 'user', uuid: 'u1', sessionId: ID, timestamp: ts, message: { role: 'user', content: 'hello from alpha' } },
      { type: 'assistant', uuid: 'a1', sessionId: ID, timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: 'hi back from alpha' }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  // A second file the record does not name — what a client-chosen path would have read.
  fs.writeFileSync(path.join(stateDir, 'elsewhere.jsonl'), '');

  await fsp.writeFile(
    path.join(stateDir, 'hibernate.json'),
    JSON.stringify({
      asleep: {
        [NAME]: {
          name: NAME, folder, slug: 'sleepy', lead: false, sessionId: ID, transcriptPath: transcript,
          title: 'alpha-sleepy', label: null, project: 'alpha', bypass: false, attached: false,
          pinned: false, pinAfter: null, sleptAt: Date.now() - 60_000, idleSince: Date.now() - 3_600_000,
          lastActivity: Date.now() - 3_600_000, model: 'Opus 5.5',
        },
      },
      keepAwake: [],
      held: {},
    }),
  );

  const env = { ...process.env, TMUX_TMPDIR: tmuxDir, FOREMAN_PORT: String(port), FOREMAN_HOST: '127.0.0.1', FOREMAN_STATE_DIR: stateDir };
  delete env.TMUX;
  delete env.TMUX_PANE;
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] });
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
});

test.after(async () => {
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
  }
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
  if (tmuxDir) await fsp.rm(tmuxDir, { recursive: true, force: true });
});

test('a sleeper is not in the roster, and its conversation is still readable by id', async () => {
  const roster = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
  assert.ok(!(roster.sessions || roster).some((s) => s.id === ID), 'never a roster row');

  const frame = await ask({ type: 'subscribe', sessionId: ID, slot: 'a' }, (m) => m.type === 'transcript' || m.type === 'error');
  assert.equal(frame?.type, 'transcript', `answered ${JSON.stringify(frame)}`);
  assert.equal(frame.sessionId, ID);
  assert.equal(frame.slot, 'a');
  const text = JSON.stringify(frame.messages);
  assert.match(text, /hello from alpha/);
  assert.match(text, /hi back from alpha/);

  // Slot-aware exactly like the live path: another slot asking gets its own frame, under the
  // id it asked for — the phone filters on that id.
  const b = await ask({ type: 'subscribe', sessionId: ID, slot: 'm' }, (m) => m.type === 'transcript' || m.type === 'error');
  assert.equal(b?.type, 'transcript');
  assert.equal(b.sessionId, ID);
  assert.equal(b.slot, 'm');
});

test('the path is the record’s: a client cannot name one, and an id nobody holds is refused', async () => {
  const stray = await ask(
    { type: 'subscribe', sessionId: 'not-a-sleeper', transcriptPath: path.join(stateDir, 'elsewhere.jsonl'), slot: 'b' },
    (m) => m.type === 'transcript' || m.type === 'error',
  );
  assert.equal(stray?.type, 'error');
  assert.equal(stray.message, 'Unknown session.');
});

test('the header’s sleep verdict is for live sessions only — a sleeper id is a 404', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/api/sessions/${ID}/sleep?beside=watched`);
  assert.equal(res.status, 404);
});
