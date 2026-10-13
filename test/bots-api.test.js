import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

/*
 * The bot read side against whole scratch panels: the roster frame's `bots`, the bot socket
 * frames, the four GET routes — and, the half that matters most, that **nothing a session
 * reader is handed ever meets a bot**.
 *
 * Two panels share one scratch tmux server and one scratch `HOME` (so `~/.claude/projects`
 * is a scratch folder too, and nothing here reads a real transcript): **A** has two bots
 * registered with conversations in its state dir, **B** has none. Everything a session
 * consumer answers — `GET /api/sessions`, the snapshot's bench entries, the relaunch entries
 * — is compared between them byte for byte.
 *
 * The bots' copies are written before A boots by a `BotStore` in this process, through
 * `append` — the way the ingest route will — and later appends go through a second store on
 * the same directory: A's own `Tailer` follows the copy on disk, so it sees them. Nothing
 * here speaks the ingest wire, which is not this item's.
 *
 * The panes run a copy of this node binary named `claude`, parked on a captured idle
 * screen (`test/rooms-api.test.js` has the why of that rig). Every transcript and record is
 * synthetic; no path names a real folder. Nothing touches 48770, the real state dir, the
 * real logs or the machine's tmux server.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const PREFIX = 'foreman-';
const PROJECT = '-workspace-alpha';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
/** Longer than a roster poll and the tailer's 1.5 s floor. */
const QUIET_MS = 2_500;

let home;
let tmuxDir;
let stateA;
let stateB;
let portA;
let portB;
let panelA;
let panelB;
let bench = false;

const C1 = randomUUID(); // alpha-bot, large: an early half only `bot-load-earlier` reaches
const C2 = randomUUID(); // alpha-bot, small
const C3 = randomUUID(); // beta-bot
const S1 = randomUUID(); // the alpha pane's first transcript, written mid-test
const S2 = randomUUID(); // the beta pane's transcript, large
const IMAGE_UUID = randomUUID();
let botStore; // the store that seeded A's dir, kept for appends while A runs
const tokens = [];
const sizes = new Map();
const agentFile = (name) => path.join(home, 'agent-files', `${name}.jsonl`);

/* ------------------------------------------------------------------ records --- */

const at = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const line = (r) => `${JSON.stringify(r)}\n`;
const user = (text, ago, extra = {}) => line({ type: 'user', uuid: randomUUID(), timestamp: at(ago), message: { role: 'user', content: text }, ...extra });
const reply = (text, ago) => line({
  type: 'assistant', uuid: randomUUID(), timestamp: at(ago),
  message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 100, output_tokens: 3 } },
});
/** A subagent call and its result, whose `toolUseResult.outputFile` names `file` — the
 *  field `rememberAgentFiles` collects. */
const subagent = (agentId, file, ago) => {
  const id = `toolu_${randomUUID().slice(0, 8)}`;
  return line({ type: 'assistant', uuid: randomUUID(), timestamp: at(ago), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id, name: 'Task', input: { description: 'look around', prompt: 'look' } }] } })
    + line({ type: 'user', uuid: randomUUID(), timestamp: at(ago), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] }, toolUseResult: { agentId, outputFile: file, status: 'completed' } });
};
const image = (uuid, ago) => line({ type: 'user', uuid, timestamp: at(ago), message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: 'see this' }] } });
const padding = (label, ago, bytes = 300 * 1024) => {
  let out = '';
  for (let i = 0; Buffer.byteLength(out) < bytes; i++) out += reply(`${label} ${i} ${'x'.repeat(4_000)}`, ago);
  return out;
};

/* -------------------------------------------------------------------- bench --- */

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
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/** The scratch tmux server and the scratch home, and nothing else's. */
function scratchEnv(extra = {}) {
  const env = { ...process.env, HOME: home, TMUX_TMPDIR: tmuxDir, ...extra };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

const tmux = (...args) => execFileSync('tmux', ['-f', '/dev/null', ...args], { env: scratchEnv(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

function buildFakeClaude() {
  try {
    const node = fs.realpathSync(process.execPath);
    fs.mkdirSync(path.join(tmuxDir, 'bin'), { recursive: true });
    fs.symlinkSync(path.join(path.dirname(path.dirname(node)), 'lib'), path.join(tmuxDir, 'lib'));
    fs.copyFileSync(node, path.join(tmuxDir, 'bin', 'claude'));
    fs.chmodSync(path.join(tmuxDir, 'bin', 'claude'), 0o755);
    fs.writeFileSync(
      path.join(tmuxDir, 'screen.mjs'),
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

const cwdOf = (label) => path.join(home, 'work', label.split('-')[0]);
/** Claude Code's own folder rule: every separator, and every dot, a dash. */
const projectDir = (cwd) => path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'));

function fakeSession(label) {
  fs.mkdirSync(cwdOf(label), { recursive: true });
  tmux('new-session', '-d', '-s', `${PREFIX}${label}`, '-c', cwdOf(label), '-x', '120', '-y', '40',
    path.join(tmuxDir, 'bin', 'claude'), path.join(tmuxDir, 'screen.mjs'), path.join(FIXTURES, 'pane-idle.txt'));
}

function writeTranscript(label, sessionId, text) {
  const dir = projectDir(cwdOf(label));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), text);
}

function bootPanel(stateDir, port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: scratchEnv({
      FOREMAN_PORT: String(port),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: stateDir,
      FOREMAN_AGENT_LABEL: 'dev.foreman.bots-api-test',
      FOREMAN_LOG_DIR: path.join(stateDir, 'logs'),
    }),
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  process.on('exit', () => child.kill());
  return child;
}

async function get(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  return { status: res.status, headers: res.headers, text: await res.text(), res };
}

async function rows(port) {
  return JSON.parse((await get(port, '/api/sessions')).text).sessions;
}

async function until(fn, what, ms = 25_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A socket that records every frame it is sent. */
async function connect(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(raw)));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const sock = {
    frames,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => new Promise((r) => {
      ws.once('close', r);
      ws.close();
    }),
    async wait(pred, { from = 0, ms = 15_000 } = {}) {
      const deadline = Date.now() + ms;
      for (;;) {
        const hit = frames.slice(from).find(pred);
        if (hit) return hit;
        if (Date.now() > deadline) throw new Error(`no such frame; got ${JSON.stringify(frames.slice(from).map((f) => [f.type, f.slot]))}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
  await sock.wait((f) => f.type === 'sessions');
  return sock;
}

const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));
const texts = (messages) => messages.map((m) => m.text).filter(Boolean);

function putBot(bot, cid, text, agent = null) {
  const key = `${bot}/${cid}/${agent}`;
  const r = botStore.append(bot, { root: 'main', project: PROJECT, session: cid, agent }, sizes.get(key) ?? 0, Buffer.from(text));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  sizes.set(key, r.body.size);
}

test.before(async () => {
  home = fs.realpathSync(await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-botsapi-home-')));
  stateA = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-botsapi-a-'));
  stateB = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-botsapi-b-'));
  // Short, and not `os.tmpdir()`: a unix socket path has a hard length limit near 104 bytes.
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-ba-');
  portA = await freePort();
  portB = await freePort();
  process.env.FOREMAN_STATE_DIR = stateA; // `bots.js` imports `config.js`; scratch, not ~/.foreman

  // Real files a transcript can name as a subagent's `outputFile`, so that "the panel
  // refused to read it" can only mean it never remembered the name.
  fs.mkdirSync(path.join(home, 'agent-files'), { recursive: true });
  for (const name of ['bot-early', 'bot-late', 'bot-live', 'session']) fs.writeFileSync(agentFile(name), user(`${name} agent transcript`, 60));

  bench = buildFakeClaude();
  if (bench) {
    fakeSession('alpha-main');
    fakeSession('beta-main');
    // Freshness: a transcript last written before its pane existed cannot be that pane's.
    await new Promise((r) => setTimeout(r, 1_200));
    writeTranscript('beta-main', S2, user('SESSION EARLIEST prompt', 400, { sessionId: S2 }) + padding('session pad', 300)
      + subagent('sess1', agentFile('session'), 200) + reply('SESSION LATEST answer', 100));
  }

  const { BotStore } = await import('../server/bots.js');
  const seed = new BotStore({ dir: stateA, timers: false, log: () => {} });
  tokens.push(seed.register('alpha-bot', { name: 'Alpha bot' }).token, seed.register('beta-bot').token);
  botStore = seed;
  putBot('alpha-bot', C1, user('BOT EARLIEST prompt', 900) + subagent('early1', agentFile('bot-early'), 890) + padding('bot pad', 800)
    + image(IMAGE_UUID, 700) + subagent('a1b2', agentFile('bot-late'), 600) + reply('BOT LATEST answer', 500));
  putBot('alpha-bot', C1, user('the subagent was asked this', 600) + reply('SUBAGENT ANSWER', 600), 'agent-a1b2');
  putBot('alpha-bot', C2, user('a small conversation', 50) + reply('small answer', 40));
  putBot('beta-bot', C3, image(randomUUID(), 30) + reply('beta answer', 20));
  seed.flush();

  panelA = bootPanel(stateA, portA);
  panelB = bootPanel(stateB, portB);
  for (const port of [portA, portB]) {
    await until(async () => (await get(port, '/api/bots')).status === 200, `the panel on ${port}`);
    if (bench) {
      await until(async () => {
        const r = await rows(port);
        return r.some((s) => s.label === 'alpha-main') && r.some((s) => s.id === S2);
      }, `both panes on ${port}, the beta one bound`);
    }
  }
});

test.after(async () => {
  botStore?.stop();
  await Promise.all([stop(panelA), stop(panelB)]);
  try { tmux('kill-server'); } catch { /* never started */ }
  for (const dir of [home, stateA, stateB, tmuxDir]) if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

/* -------------------------------------------- what session readers are handed --- */

test('GET /api/sessions, the bench entries and the relaunch entries are byte-identical with and without a bot', async (t) => {
  if (!bench) return t.skip('no fake claude on this machine');
  // One poll more, so both panels have read the same panes the same number of times.
  await new Promise((r) => setTimeout(r, 2_500));
  const [sa, sb] = await Promise.all([get(portA, '/api/sessions'), get(portB, '/api/sessions')]);
  assert.equal(JSON.parse(sa.text).sessions.length, 2);
  assert.equal(sa.text, sb.text);

  const [ra, rb] = await Promise.all([get(portA, '/api/relaunch'), get(portB, '/api/relaunch')]);
  assert.equal(JSON.parse(ra.text).sessions.length, 2, 'two bench rows to compare, not zero');
  assert.equal(ra.text, rb.text);

  // `POST /api/snapshot` is `snapshot.save(benchEntries(registry.list()))`; the saved slot is
  // the bench entries, read back. Only the save time may differ.
  for (const port of [portA, portB]) {
    const res = await fetch(`http://127.0.0.1:${port}/api/snapshot`, { method: 'POST' });
    assert.equal(res.status, 200);
  }
  const [pa, pb] = await Promise.all([get(portA, '/api/snapshot'), get(portB, '/api/snapshot')]);
  const strip = (text) => JSON.stringify({ ...JSON.parse(text), savedAt: null });
  assert.equal(JSON.parse(pa.text).sessions.length, 2);
  assert.equal(strip(pa.text), strip(pb.text));

  // The roster frame: everything but `bots` the same, and `bots` a sibling, never a row.
  const [wa, wb] = await Promise.all([connect(portA), connect(portB)]);
  const fa = wa.frames.find((f) => f.type === 'sessions');
  const fb = wb.frames.find((f) => f.type === 'sessions');
  await Promise.all([wa.close(), wb.close()]);
  assert.deepEqual(fb.bots, [], 'an empty array, so the client can test `\'bots\' in msg`');
  assert.deepEqual(fa.bots.map((b) => b.id), ['alpha-bot', 'beta-bot']);
  const { bots: _a, snapshot: snapA, ...restA } = fa;
  const { bots: _b, snapshot: snapB, ...restB } = fb;
  assert.equal(JSON.stringify(restA), JSON.stringify(restB));
  assert.equal(JSON.stringify({ ...snapA, savedAt: null }), JSON.stringify({ ...snapB, savedAt: null }));
  for (const cid of [C1, C2, C3]) assert.ok(!sa.text.includes(cid) && !JSON.stringify(fa.sessions).includes(cid));

  await stop(panelB);
});

test('every /api/sessions/<id>/… route answers 404 for a bot conversation id', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  const routes = [...source.matchAll(/app\.(get|post|put|patch|delete)\('(\/api\/sessions\/:id[^']*)'/g)].map((m) => ({ method: m[1].toUpperCase(), route: m[2] }));
  assert.ok(routes.length >= 30, `found only ${routes.length} routes — did the pattern stop matching?`);
  const fill = { ':id': C1, ':uuid': IMAGE_UUID, ':index?': '0', ':index': '0', ':itemId': 'x' };
  // A body that passes the route's own check where it makes one before the lookup, so the
  // answer is about the id and not the body.
  const bodies = { '/api/sessions/:id/relaunch': { mode: 'fresh' } };
  const wrong = [];
  for (const { method, route } of routes) {
    const url = route.replace(/:[A-Za-z]+\??/g, (p) => fill[p] ?? 'x');
    const res = await fetch(`http://127.0.0.1:${portA}${url}`, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(bodies[route] ?? {}),
    });
    if (res.status !== 404) wrong.push(`${method} ${route} → ${res.status}`);
  }
  assert.deepEqual(wrong, []);
});

/* ------------------------------------------------------------------ the routes --- */

test('GET /api/bots describes every bot and carries no token', async () => {
  const res = await get(portA, '/api/bots');
  assert.equal(res.status, 200);
  const { bots } = JSON.parse(res.text);
  assert.deepEqual(bots.map((b) => [b.id, b.name, b.conversations]), [['alpha-bot', 'Alpha bot', 2], ['beta-bot', 'beta-bot', 1]]);
  assert.ok(bots[0].disk.bytes > 300 * 1024);
  assert.equal(bots[0].helper.online, false, 'no helper has said hello');
  // `ctx.tokens` is a context size and is meant to be there; a credential is not.
  assert.equal(tokens.length, 2);
  for (const token of tokens) assert.ok(!res.text.includes(token), 'a minted token');
  assert.ok(!/tokenHash|digest/i.test(res.text), res.text.slice(0, 400));
});

test('GET /api/bots/:bot/conversations pages newest first, and 404s a bot that is not registered', async () => {
  let res = await get(portA, '/api/bots/alpha-bot/conversations');
  assert.equal(res.status, 200);
  const page = JSON.parse(res.text);
  assert.deepEqual(page.conversations.map((c) => c.cid), [C2, C1]);
  assert.equal(page.next, null);
  assert.equal(page.conversations[1].title, 'BOT EARLIEST prompt');

  res = await get(portA, `/api/bots/alpha-bot/conversations?before=${page.conversations[0].activeAt}`);
  assert.deepEqual(JSON.parse(res.text).conversations.map((c) => c.cid), [C1]);

  assert.equal((await get(portA, '/api/bots/gamma-bot/conversations')).status, 404);
  assert.equal((await get(portA, '/api/bots/..%2Fbots/conversations')).status, 404);
});

test('the image route serves from the copy, with the session route\'s caching, and only for a conversation the bot holds', async () => {
  const res = await get(portA, `/api/bots/alpha-bot/conversations/${C1}/image/${IMAGE_UUID}/0`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  const bytes = Buffer.from(await (await fetch(`http://127.0.0.1:${portA}/api/bots/alpha-bot/conversations/${C1}/image/${IMAGE_UUID}/0`)).arrayBuffer());
  assert.deepEqual(bytes, Buffer.from(PNG, 'base64'));

  for (const route of [
    `/api/bots/alpha-bot/conversations/${C1}/image/${IMAGE_UUID}/1`, // no second image
    `/api/bots/alpha-bot/conversations/${C1}/image/${randomUUID()}/0`, // no such record
    `/api/bots/alpha-bot/conversations/${C2}/image/${IMAGE_UUID}/0`, // that record is in C1
    `/api/bots/alpha-bot/conversations/${C3}/image/${IMAGE_UUID}/0`, // beta-bot's conversation
    `/api/bots/beta-bot/conversations/${C1}/image/${IMAGE_UUID}/0`, // alpha-bot's conversation
    `/api/bots/alpha-bot/conversations/${randomUUID()}/image/${IMAGE_UUID}/0`,
    `/api/bots/alpha-bot/conversations/${C1.toUpperCase()}/image/${IMAGE_UUID}/0`,
    `/api/sessions/${C1}/image/${IMAGE_UUID}/0`,
  ]) assert.equal((await get(portA, route)).status, 404, route);
});

test('the agent route serves the copy\'s subagent file in the /api/agent-run shape, and only for a conversation the bot holds', async () => {
  const res = await get(portA, `/api/bots/alpha-bot/conversations/${C1}/agent/a1b2`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.deepEqual(Object.keys(body), ['messages']);
  assert.deepEqual(texts(body.messages), ['the subagent was asked this', 'SUBAGENT ANSWER']);

  for (const route of [
    `/api/bots/alpha-bot/conversations/${C2}/agent/a1b2`, // C2 has no such subagent
    `/api/bots/beta-bot/conversations/${C1}/agent/a1b2`,
    `/api/bots/alpha-bot/conversations/${randomUUID()}/agent/a1b2`,
    `/api/bots/alpha-bot/conversations/${C1}/agent/early1`, // named in the transcript, never shipped
    `/api/bots/alpha-bot/conversations/${C1}/agent/agent-a1b2`,
    `/api/bots/alpha-bot/conversations/${C1}/agent/a1b2.jsonl`,
    `/api/bots/alpha-bot/conversations/${C1}/agent/..%2F..%2F${C1}`,
  ]) assert.equal((await get(portA, route)).status, 404, route);
});

/* ----------------------------------------------------------------- the socket --- */

test('subscribe-bot sends the agreed frame, and a bot\'s outputFile is never remembered for /api/agent-run', async () => {
  const ws = await connect(portA);
  t_after(ws);
  ws.send({ type: 'subscribe-bot', botId: 'alpha-bot', cid: C1, slot: 'a' });
  const f = await ws.wait((x) => x.type === 'bot' && x.slot === 'a');
  assert.deepEqual(Object.keys(f).sort(), ['bot', 'botId', 'cid', 'conversations', 'hasEarlier', 'messages', 'next', 'slot', 'type']);
  assert.equal(f.botId, 'alpha-bot');
  assert.equal(f.cid, C1);
  assert.equal(f.hasEarlier, true);
  assert.equal(f.bot.id, 'alpha-bot');
  assert.deepEqual(f.conversations.map((c) => c.cid), [C2, C1]);
  assert.equal(texts(f.messages).at(-1), 'BOT LATEST answer');
  const late = f.messages.find((m) => m.result?.agent?.outputFile);
  assert.equal(late.result.agent.outputFile, agentFile('bot-late'), 'the backfill carries a subagent path');

  ws.send({ type: 'bot-load-earlier', slot: 'a' });
  const e = await ws.wait((x) => x.type === 'bot-earlier' && x.slot === 'a');
  assert.ok(texts(e.messages).includes('BOT EARLIEST prompt'));

  let n = ws.frames.length;
  putBot('alpha-bot', C1, subagent('live1', agentFile('bot-live'), 5));
  const live = await ws.wait((x) => x.type === 'bot-messages' && x.slot === 'a', { from: n });
  assert.deepEqual(Object.keys(live).sort(), ['botId', 'cid', 'messages', 'slot', 'type']);
  assert.equal(live.cid, C1);

  for (const name of ['bot-early', 'bot-late', 'bot-live']) {
    const r = await get(portA, `/api/agent-run?file=${encodeURIComponent(agentFile(name))}`);
    assert.equal(r.status, 404, `${name}: a bot's transcript chose a file this Mac reads`);
  }

  // The control, so the 404s above mean something: a session's own outputFile is remembered.
  if (bench) {
    n = ws.frames.length;
    ws.send({ type: 'subscribe', sessionId: S2, slot: 'b' });
    await ws.wait((x) => x.type === 'transcript' && x.slot === 'b', { from: n });
    assert.equal((await get(portA, `/api/agent-run?file=${encodeURIComponent(agentFile('session'))}`)).status, 200);
  }
});

test('loadEarlier on a session slot and bot-load-earlier on a bot slot never cross', async (t) => {
  if (!bench) return t.skip('no fake claude on this machine');
  const ws = await connect(portA);
  t_after(ws);
  ws.send({ type: 'subscribe-bot', botId: 'alpha-bot', cid: C1, slot: 'a' });
  ws.send({ type: 'subscribe', sessionId: S2, slot: 'b' });
  await ws.wait((x) => x.type === 'bot' && x.slot === 'a');
  const opened = await ws.wait((x) => x.type === 'transcript' && x.slot === 'b');
  assert.equal(opened.hasEarlier, true, 'the session has an earlier half to load, so the refusal below is not vacuous');

  let n = ws.frames.length;
  ws.send({ type: 'loadEarlier', slot: 'a' });
  ws.send({ type: 'bot-load-earlier', slot: 'b' });
  await quiet();
  assert.deepEqual(ws.frames.slice(n).filter((x) => x.type === 'earlier' || x.type === 'bot-earlier'), [], 'each kind answers only its own slot');

  n = ws.frames.length;
  ws.send({ type: 'loadEarlier', slot: 'b' });
  ws.send({ type: 'bot-load-earlier', slot: 'a' });
  const earlier = await ws.wait((x) => x.type === 'earlier', { from: n });
  const botEarlier = await ws.wait((x) => x.type === 'bot-earlier', { from: n });
  assert.equal(earlier.slot, 'b');
  assert.equal(earlier.sessionId, S2);
  assert.ok(texts(earlier.messages).includes('SESSION EARLIEST prompt'));
  assert.ok(!texts(earlier.messages).includes('BOT EARLIEST prompt'));
  assert.equal(botEarlier.slot, 'a');
  assert.equal(botEarlier.botId, 'alpha-bot');
  assert.ok(texts(botEarlier.messages).includes('BOT EARLIEST prompt'));
  assert.ok(!texts(botEarlier.messages).includes('SESSION EARLIEST prompt'));
});

test('a bot slot survives a roster update that rebinds a session, and a session subscribe takes a bot slot back', async (t) => {
  if (!bench) return t.skip('no fake claude on this machine');
  const pane = (await rows(portA)).find((s) => s.label === 'alpha-main');
  assert.match(pane.id, /^pane-/, 'a pane that has never spoken, so its first transcript renames it');
  const ws = await connect(portA);
  t_after(ws);

  // Both slots on the pane-only session; then slot c becomes a bot.
  ws.send({ type: 'subscribe', sessionId: pane.id, slot: 'c' });
  ws.send({ type: 'subscribe', sessionId: pane.id, slot: 'd' });
  await ws.wait((x) => x.type === 'transcript' && x.slot === 'c');
  await ws.wait((x) => x.type === 'transcript' && x.slot === 'd');
  ws.send({ type: 'subscribe-bot', botId: 'alpha-bot', cid: C2, slot: 'c' });
  await ws.wait((x) => x.type === 'bot' && x.slot === 'c');
  const n = ws.frames.length;

  // The pane speaks: its row's id becomes S1, the update fires, and the rebind loop follows
  // every *session* slot that was watching it — slot d, the control, proves it ran.
  writeTranscript('alpha-main', S1, user('the alpha pane speaks', 1, { sessionId: S1 }));
  const rebound = await ws.wait((x) => x.type === 'rebound' && x.slot === 'd', { from: n, ms: 20_000 });
  assert.deepEqual(rebound, { type: 'rebound', from: pane.id, to: S1, slot: 'd' });
  await quiet();
  const intoC = ws.frames.slice(n).filter((x) => x.slot === 'c');
  assert.deepEqual(intoC, [], 'the rebind loop never saw the bot slot');

  let m = ws.frames.length;
  putBot('alpha-bot', C2, reply('the bot carried on', 1));
  const live = await ws.wait((x) => x.type === 'bot-messages' && x.slot === 'c', { from: m });
  assert.deepEqual(texts(live.messages), ['the bot carried on']);

  // And back: a session subscribe on slot c drops its bot.
  ws.send({ type: 'subscribe', sessionId: S1, slot: 'c' });
  await ws.wait((x) => x.type === 'transcript' && x.slot === 'c', { from: m });
  m = ws.frames.length;
  putBot('alpha-bot', C2, reply('nobody is watching this', 1));
  await quiet();
  assert.ok(!ws.frames.slice(m).some((x) => x.type.startsWith('bot')), 'the bot slot went when the session took it');
});

test('unsubscribe-bot stops the stream, and a bot that is not registered opens empty', async () => {
  const ws = await connect(portA);
  t_after(ws);
  ws.send({ type: 'subscribe-bot', botId: 'gamma-bot', cid: null, slot: 'a' });
  const f = await ws.wait((x) => x.type === 'bot' && x.slot === 'a');
  assert.equal(f.bot, null);
  assert.equal(f.cid, null);
  assert.deepEqual(f.conversations, []);

  ws.send({ type: 'subscribe-bot', botId: 'alpha-bot', cid: null, slot: 'a' });
  const g = await ws.wait((x) => x.type === 'bot' && x.slot === 'a' && x.bot);
  assert.equal(g.cid, C2, 'cid: null is the newest conversation');
  ws.send({ type: 'unsubscribe-bot', slot: 'a' });
  await new Promise((r) => setTimeout(r, 300));
  const n = ws.frames.length;
  putBot('alpha-bot', C2, reply('after the unsubscribe', 1));
  await quiet();
  assert.ok(!ws.frames.slice(n).some((x) => x.type === 'bot-messages'));
});

/** Close a test's socket when the test ends, pass or fail. */
const open = new Set();
function t_after(ws) {
  open.add(ws);
}
test.afterEach(async () => {
  for (const ws of open) await ws.close().catch(() => {});
  open.clear();
});
