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
 * Holding messages for a sleeper, against a real scratch panel on real throwaway state —
 * `test/hibernate-api.test.js`'s shape, and its fake `claude`.
 *
 * One sleeping **lead**, seeded into `hibernate.json` before the panel boots, in a real git
 * checkout that has a team (with a trigger on its allow-list), a forge reading, one task in
 * `review` with a real branch, and a group room the lead is a member of. Every path that used
 * to find "no session" for it — the trigger, the merge press, the room fan-out, the team
 * room's nudge — must now hold, and the session's own send box must refuse. Then a real wake
 * (`launchLead` on `--resume`, the fake `claude` parked on an idle screen) must hand
 * everything that waited to the new pane's queue **in the order it arrived**.
 *
 * Nothing here touches the machine's real tmux server (its own `TMUX_TMPDIR`, `TMUX`
 * deleted), the real state directory or port 48770, and no Terminal window is opened.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const PREFIX = 'foreman-';
const TOKEN = 'hold-test-token';
const LEAD = `${PREFIX}delta-lead`;
const LEAD_ID = '0de17a00-0000-4000-8000-0000000de17a';
const PHRASE = 'review feedback issue 66';

let child;
let port;
let stateDir;
let tmuxDir;
let repo;
let bench = false;
let argsFile;

const teamKeyFor = (dir) => String(dir).replace(/\/+$/, '').replace(/\//g, '-').replace(/^-/, '');

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

async function api(method, route, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function tmuxEnv() {
  const env = { ...process.env, TMUX_TMPDIR: tmuxDir, ZDOTDIR: path.join(tmuxDir, 'zdot') };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

const tmux = (...args) =>
  execFileSync('tmux', ['-f', '/dev/null', ...args], { env: tmuxEnv(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

/** The fake `claude` of `test/hibernate-api.test.js`, unchanged: note the arguments, then
 *  park a copy of node named `claude` on a captured idle screen. */
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

async function until(fn, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

const teamRoom = () => {
  try {
    return fs
      .readFileSync(path.join(stateDir, 'teams', teamKeyFor(repo), 'room.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const waiting = async () => (await api('GET', '/api/asleep')).body.asleep.find((r) => r.name === LEAD)?.waiting;

/** A real checkout with one branch in review, and a remote so the forge reads `gitea`. */
function prepareRepo(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@test']);
  git(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);
  git(['checkout', '-q', '-B', 'agent/one-fix', 'main']);
  fs.writeFileSync(path.join(dir, 'fix.js'), 'fixed\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'one fix']);
  git(['checkout', '-q', 'main']);
  git(['remote', 'add', 'origin', 'http://forge.example.com:3002/team/delta.git']);
}

test.before(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-hold-api-'));
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-hh-');
  port = await freePort();
  repo = path.join(stateDir, 'delta');
  prepareRepo(repo);
  fs.writeFileSync(path.join(stateDir, `${LEAD_ID}.jsonl`), '');

  const teamDir = path.join(stateDir, 'teams', teamKeyFor(repo));
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(
    path.join(teamDir, 'team.json'),
    JSON.stringify({ repo, triggers: [{ id: 'feedback-review', match: '^review feedback issue \\d{1,6}$' }] }),
  );
  fs.writeFileSync(
    path.join(stateDir, 'tasks.json'),
    JSON.stringify({
      'one-fix': {
        id: 'one-fix', repo, kind: 'build', body: 'one fix', source: 'chat', state: 'review',
        branch: 'agent/one-fix', worktree: null, base: 'main', staleBase: false, model: null,
        modelReason: null, startedBy: null, tmuxSession: null, pr: 'http://box/pulls/7',
        createdAt: '2026-10-29T08:00:00.000Z', updatedAt: '2026-10-29T09:00:00.000Z',
      },
    }),
  );
  fs.writeFileSync(
    path.join(stateDir, 'claude.json'),
    JSON.stringify({ mcpServers: { gitea: { type: 'http', url: 'http://mcp.example.com:8093/mcp' } } }),
  );
  // A group room whose only member is the sleeping lead, by name — `resolveMember`'s first
  // rung, which is what makes a woken member find its rooms again with no migration.
  fs.writeFileSync(
    path.join(stateDir, 'rooms.json'),
    JSON.stringify({
      seq: 1,
      rooms: [{ id: 'room-1', name: 'night shift', members: [{ tmuxSession: LEAD, name: 'delta-lead', paneId: '%97', addedAt: 1 }], createdAt: 1 }],
    }),
  );
  fs.writeFileSync(
    path.join(stateDir, 'hibernate.json'),
    JSON.stringify({
      asleep: {
        [LEAD]: {
          name: LEAD, folder: repo, slug: 'lead', lead: true, sessionId: LEAD_ID,
          transcriptPath: path.join(stateDir, `${LEAD_ID}.jsonl`), title: 'delta-lead', label: 'lead',
          project: 'delta', bypass: false, attached: false, pinned: false, pinAfter: null,
          sleptAt: Date.now() - 60_000, idleSince: Date.now() - 3_600_000, lastActivity: Date.now() - 3_600_000,
          model: 'Opus 5.5',
        },
      },
      keepAwake: [],
      held: {},
    }),
  );

  bench = buildFakeClaude();

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...tmuxEnv(),
      FOREMAN_PORT: String(port),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: stateDir,
      FOREMAN_TRIGGER_TOKEN: TOKEN,
      FOREMAN_CLAUDE_CONFIG: path.join(stateDir, 'claude.json'),
    },
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
});

test.after(async () => {
  await stop(child);
  try {
    tmux('kill-server');
  } catch {
    /* never started, or already gone */
  }
  if (stateDir) await fsp.rm(stateDir, { recursive: true, force: true });
  if (tmuxDir) await fsp.rm(tmuxDir, { recursive: true, force: true });
});

/* The tests below run in file order and build on each other: four things are held, then a
 * wake hands all four over. */

test('a trigger to a sleeping lead is held, answers held, and says so in the room', async () => {
  const res = await api('POST', '/api/trigger', { folder: repo, text: PHRASE }, { Authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.held, true);
  assert.equal(res.body.delivered, false);
  assert.equal(res.body.queued, false);
  assert.equal(res.body.sessionId, LEAD_ID);
  const line = teamRoom().findLast((e) => e.event === 'trigger');
  assert.match(line.text, /handed to the lead, which is asleep\.$/);
  assert.equal(line.alert, undefined, 'a held trigger is not a failure');
  assert.equal(await waiting(), 1);
});

test('a merge press for a sleeping lead is held, answers held, and merges nothing by itself', async () => {
  const res = await api('POST', '/api/team/merge', {
    folder: repo, tasks: ['one-fix'], expect: [{ id: 'one-fix', pr: 'http://box/pulls/7' }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.held, true);
  assert.equal(res.body.delivered, false);
  const line = teamRoom().findLast((e) => e.event === 'merge');
  assert.match(line.text, /handed to the lead, which is asleep\.$/);
  assert.equal(await waiting(), 2);

  // The second press is the duplicate it always was: one held line, not two.
  const again = await api('POST', '/api/team/merge', {
    folder: repo, tasks: ['one-fix'], expect: [{ id: 'one-fix', pr: 'http://box/pulls/7' }],
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.duplicate, true);
  assert.equal(await waiting(), 2);
});

test('a group-room post to a sleeping member is handed, held, and marked asleep', async () => {
  const res = await api('POST', '/api/rooms/room-1/post', { text: 'the nightly build is red' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.handed.map((m) => [m.tmuxSession, m.state, m.reason]),
    [[LEAD, 'held', 'asleep']],
  );
  assert.deepEqual(res.body.entry.handed, res.body.handed, 'the log records the same handoff');
  assert.equal(await waiting(), 3);
});

test('the team room nudges a sleeping lead once, however many events arrive', async () => {
  for (let i = 0; i < 3; i += 1) {
    const res = await api('POST', '/api/team/room', { folder: repo, from: 'one-fix', kind: 'status', text: `update ${i}` });
    assert.equal(res.status, 200);
  }
  assert.equal(await waiting(), 4);
});

test('the send box refuses a sleeper outright, and holds nothing', async () => {
  const res = await api('POST', `/api/sessions/${LEAD_ID}/send`, { text: 'hello?' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'This session is asleep — wake it.');
  assert.equal(await waiting(), 4);
});

test('Wake hands everything that waited to the new pane, in the order it arrived', async (t) => {
  if (!bench) return t.skip('no scratch tmux bench on this machine');
  const res = await api('POST', `/api/asleep/${LEAD}/wake`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.name, LEAD);
  assert.equal(res.body.queued, 4);
  assert.ok(fs.readFileSync(argsFile, 'utf8').includes(`--resume ${LEAD_ID}`));

  // The flusher types the first as soon as the pane reads idle; the rest wait behind it.
  // Whatever has been typed is on screen, whatever has not is still in the queue, and read
  // together the two must be the arrival order.
  const order = [PHRASE, 'merge', 'the nightly build is red', '[room]'];
  const screen = await until(() => {
    const s = tmux('capture-pane', '-p', '-J', '-t', res.body.paneId, '-S', '-200');
    return s.includes(PHRASE) ? s : null;
  });
  assert.ok(screen, 'the first held message was typed into the woken pane');
  const row = (await api('GET', '/api/sessions')).body.sessions.find((s) => s.tmuxSession === LEAD);
  const queued = (await api('GET', `/api/sessions/${row.id}/queue`)).body.queued.map((q) => q.text);
  const typedCount = order.length - queued.length;
  assert.ok(typedCount >= 1, `queued ${JSON.stringify(queued)}`);
  queued.forEach((text, i) => assert.ok(text.includes(order[typedCount + i]), `queue slot ${i}: ${text}`));
  let at = -1;
  for (const want of order.slice(0, typedCount)) {
    const found = screen.indexOf(want, at + 1);
    assert.ok(found > at, `${want} typed after what came before it`);
    at = found;
  }
  assert.ok(!(await api('GET', '/api/asleep')).body.asleep.some((r) => r.name === LEAD), 'the record is gone');
});
