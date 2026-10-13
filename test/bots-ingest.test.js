import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import WebSocket from 'ws';

/*
 * The bots wire's three routes, against the real server — `server/index.js` booted as a
 * child with its own port, state dir, log dir, launchd label and tmux socket, then spoken to
 * with real `fetch`. The routes live inline in `index.js`, so there is nothing to import, and
 * what is worth testing is the whole request/response with express's body parsing and status
 * codes included: whether the global JSON parser leaves an append body alone is a fact about
 * the middleware order, which no test of the store can see.
 *
 * And then the real helper, `helper/foreman-helper.mjs`, run as a child against those routes
 * — the fake panel in `test/fake-bot-panel.js` is what the helper was proved against; this is
 * the panel answering it.
 *
 * `FOREMAN_STATE_DIR` is set before `bots.js` is imported, because ESM hoists: `config.js`
 * resolves the state dir when it is first imported, and a value set below a static import
 * would arrive after the real `~/.foreman` had already been chosen. The store in this
 * process is only ever used to write `bots.json` before the panel boots, always with its
 * `dir` passed in as well.
 *
 * Nothing here touches the real tmux server, the real state directory, the real logs or
 * port 48770. Every transcript is synthetic or one of the sandbox fixtures.
 */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bots-ingest-'));
process.env.FOREMAN_STATE_DIR = stateDir;
const { BotStore, CHUNK_MAX, HEAD_MAX } = await import('../server/bots.js');

const exec = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures');
const CLI = path.join(ROOT, 'bin', 'foreman-panel.js');
const HELPER = path.join(ROOT, 'helper', 'foreman-helper.mjs');

/** `BOT_RELOAD_MS` in `index.js`, plus a margin: how long a registry change can take to land. */
const RELOAD_WINDOW_MS = 2_100;
/**
 * The one helper instance these tests speak as. A hello from any other instance opens a
 * 90-second window in which every different one is refused, so a random id per test would
 * have each test lock the next out.
 */
const INSTANCE = 'api-test-instance';

let child = null;
let port;
let tmuxDir;
let token;
/** Everything the panel has written to stderr, across both of its boots. */
let stderr = '';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port: p } = probe.address();
  await new Promise((r) => probe.close(r));
  return p;
}

/** A scratch tmux socket with no server on it, and `TMUX` gone so tmux cannot fall back to
 *  the one this test run may itself be sitting in. The panel polls an empty roster. */
function scratchEnv(extra = {}) {
  const env = {
    ...process.env,
    TMUX_TMPDIR: tmuxDir,
    FOREMAN_PORT: String(port),
    FOREMAN_HOST: '127.0.0.1',
    FOREMAN_STATE_DIR: stateDir,
    FOREMAN_LOG_DIR: path.join(stateDir, 'logs'),
    FOREMAN_AGENT_LABEL: 'dev.foreman.bots-ingest-test',
    ...extra,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

async function bootPanel() {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: scratchEnv(),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/rooms`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`the scratch panel never came up:\n${stderr}`);
      await sleep(100);
    }
  }
}

/** SIGTERM flushes every store into the state dir on the way out; wait for it. */
function stopProc(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill('SIGTERM');
  });
}

function url(bot, route, query) {
  const u = new URL(`http://127.0.0.1:${port}/api/bots/${encodeURIComponent(bot)}/${route}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.set(k, String(v));
  return u;
}

/** One request on the wire, exactly as the helper makes them. */
async function call(bot, route, { tok = token, json, bytes, query, contentType, method } = {}) {
  const headers = {};
  if (tok !== null) headers.authorization = `Bearer ${tok}`;
  let body;
  if (json !== undefined) {
    headers['content-type'] = contentType ?? 'application/json';
    body = JSON.stringify(json);
  } else if (bytes !== undefined) {
    headers['content-type'] = contentType ?? 'application/octet-stream';
    body = bytes;
  }
  const res = await fetch(url(bot, route, query), { method: method ?? (route === 'manifest' ? 'GET' : 'POST'), headers, body });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* the status says enough */ }
  return { status: res.status, body: data, text, type: res.headers.get('content-type') };
}

const hello = (instance, extra = {}, opts = {}) =>
  call(opts.bot ?? 'alpha-bot', 'hello', { ...opts, json: { v: 1, instance, helperVersion: 'test', host: 'sandbox', roots: [], files: 0, ...extra } });

const append = (where, offset, bytes, opts = {}) =>
  call(opts.bot ?? 'alpha-bot', 'append', { ...opts, bytes, query: { ...where, offset, reset: opts.reset ? 1 : undefined } });

const copyPath = (bot, { root, project, session, agent }) => agent
  ? path.join(stateDir, 'bots', bot, root, project, session, 'subagents', `${agent}.jsonl`)
  : path.join(stateDir, 'bots', bot, root, project, `${session}.jsonl`);

/** The `[bots] refused …` lines the panel has printed for this bot and reason. */
async function refusalLines(who, reason) {
  await sleep(150); // stderr is a pipe; give the line a moment to cross it
  const want = `[bots] refused ${who} from 127.0.0.1: ${reason} (`;
  return stderr.split('\n').filter((l) => l.startsWith(want));
}

const line = (obj) => `${JSON.stringify(obj)}\n`;
const conv = () => ({ root: 'main', project: '-srv-alpha', session: randomUUID() });

test.before(async () => {
  // Short, and not `os.tmpdir()`: a unix socket path has a hard length limit around 104
  // bytes, and `$TMPDIR/…/tmux-501/default` on macOS overruns it.
  tmuxDir = await fsp.mkdtemp('/tmp/foreman-ba-');
  port = await freePort();
  ({ token } = new BotStore({ dir: stateDir, copies: false }).register('alpha-bot', { name: 'Alpha sandbox' }));
  await bootPanel();
});

test.after(async () => {
  await stopProc(child);
  await fsp.rm(stateDir, { recursive: true, force: true });
  if (tmuxDir) await fsp.rm(tmuxDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------- the token --- */

test('an unknown bot and a wrong token get the same 401, write nothing, and log one line each', async () => {
  const where = conv();
  const bytes = Buffer.from(line({ type: 'user', message: { role: 'user', content: 'hi' } }));

  const wrong = [];
  for (let i = 0; i < 3; i++) wrong.push(await append(where, 0, bytes, { tok: 'not-the-token' }));
  const unknown = await append(where, 0, bytes, { bot: 'nobody-bot' });
  const bare = await append(where, 0, bytes, { tok: null });
  const helloWrong = await hello(randomUUID(), {}, { tok: 'not-the-token' });
  const manifestWrong = await call('alpha-bot', 'manifest', { tok: 'not-the-token' });

  for (const r of [...wrong, unknown, bare, helloWrong, manifestWrong]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, unknown.body, 'one answer for every way of not being the bot');
  }
  assert.equal(fs.existsSync(copyPath('alpha-bot', where)), false);
  assert.equal(fs.existsSync(path.join(stateDir, 'bots', 'nobody-bot')), false, 'an unknown bot gets no folder');

  // Five wrong-token requests over three routes, one address, one reason: one line.
  assert.equal((await refusalLines('alpha-bot', 'wrong token')).length, 1);
  assert.equal((await refusalLines('nobody-bot', 'unknown bot')).length, 1);
  assert.equal((await refusalLines('alpha-bot', 'no bearer token')).length, 1);
});

test('the token is checked before the body is read: a stranger\'s 6 MB append is a 401', async () => {
  const where = conv();
  const big = Buffer.alloc(6 * 1024 * 1024, 0x61);
  big[big.length - 1] = 10;
  const r = await append(where, 0, big, { tok: 'not-the-token' });
  assert.equal(r.status, 401);
  assert.equal(fs.existsSync(copyPath('alpha-bot', where)), false);
});

test('a bot id that could carry a newline is never printed', async () => {
  const r = await append(conv(), 0, Buffer.from('{}\n'), { bot: 'evil\n[bots] refused alpha-bot' });
  assert.equal(r.status, 401);
  await sleep(150);
  assert.ok(!stderr.includes('evil'), 'the id from the URL reached the log');
  assert.equal((await refusalLines('(not a bot id)', 'unknown bot')).length, 1);
});

/* ------------------------------------------------------------------- the wire --- */

test('the right token says hello, reads an empty manifest, and an append lands byte for byte', async () => {
  const h = await hello(INSTANCE);
  assert.equal(h.status, 200);
  assert.deepEqual(h.body, { ok: true });

  const where = conv();
  // JSON text sent as octet-stream: the global `express.json` must leave it alone, or the
  // copy would hold a re-serialised object rather than these exact bytes.
  const first = Buffer.from(`${line({ type: 'user', message: { role: 'user', content: 'run the tests in alpha' } })}{"b":  1, "spacing":"kept"}\n`);
  const r1 = await append(where, 0, first);
  assert.equal(r1.status, 200, r1.text);
  assert.deepEqual(r1.body, { size: first.length });
  assert.ok(fs.readFileSync(copyPath('alpha-bot', where)).equals(first));

  const second = Buffer.from(line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }));
  const r2 = await append(where, first.length, second);
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(r2.body, { size: first.length + second.length });
  const whole = Buffer.concat([first, second]);
  assert.ok(fs.readFileSync(copyPath('alpha-bot', where)).equals(whole));

  const m = await call('alpha-bot', 'manifest');
  assert.equal(m.status, 200);
  assert.equal(m.body.v, 1);
  const f = m.body.files.find((x) => x.session === where.session);
  assert.deepEqual(f, { ...where, agent: null, size: whole.length, headLen: Math.min(whole.length, HEAD_MAX), head: sha(whole.subarray(0, HEAD_MAX)) });

  // A subagent's file, under the same conversation.
  const sub = Buffer.from(line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'look' } }));
  const r3 = await append({ ...where, agent: 'agent-a1b2c3' }, 0, sub);
  assert.equal(r3.status, 200, r3.text);
  assert.ok(fs.readFileSync(copyPath('alpha-bot', { ...where, agent: 'agent-a1b2c3' })).equals(sub));
});

test('a gap is a 409 carrying the size to resume from, and it is not logged as a refusal', async () => {
  const where = conv();
  const bytes = Buffer.from(line({ type: 'user', message: { role: 'user', content: 'gap' } }));
  assert.equal((await append(where, 0, bytes)).status, 200);
  const before = stderr.length;
  const r = await append(where, bytes.length + 10, bytes);
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, { size: bytes.length });
  assert.equal(fs.statSync(copyPath('alpha-bot', where)).size, bytes.length);
  await sleep(150);
  assert.ok(!stderr.slice(before).includes('[bots] refused'), 'a resume point is the protocol working, not a refusal');
});

test('a second instance within the window is a 409 with since, logged once', async () => {
  const first = await hello(INSTANCE);
  assert.equal(first.status, 200);
  const r = await hello('instance-two');
  assert.equal(r.status, 409);
  assert.equal(typeof r.body.since, 'string');
  assert.ok(Number.isFinite(Date.parse(r.body.since)));
  assert.equal(r.body.size, undefined, 'never readable as "resume from here"');
  await hello('instance-two');
  assert.equal((await refusalLines('alpha-bot', 'another helper instance is reporting for this bot')).length, 1);
  // The first instance carries on.
  assert.equal((await hello(INSTANCE)).status, 200);
});

test('6 MB is a 413 from the parser, 4 MiB + 1 is a 413 from the store, and neither writes', async () => {
  const where = conv();
  const seed = Buffer.from(line({ type: 'user', message: { role: 'user', content: 'seed' } }));
  assert.equal((await append(where, 0, seed)).status, 200);

  const six = Buffer.alloc(6 * 1024 * 1024, 0x61);
  six[six.length - 1] = 10;
  const r6 = await append(where, seed.length, six);
  assert.equal(r6.status, 413);
  assert.match(r6.type, /application\/json/, 'a JSON answer, not express\'s HTML error page');
  assert.equal(typeof r6.body.error, 'string');

  const over = Buffer.alloc(CHUNK_MAX + 1, 0x61);
  over[over.length - 1] = 10;
  const r4 = await append(where, seed.length, over);
  assert.equal(r4.status, 413);
  assert.equal(typeof r4.body.error, 'string');

  assert.equal(fs.statSync(copyPath('alpha-bot', where)).size, seed.length);

  // Exactly CHUNK_MAX with no newline is a full piece of one longer line, and passes the
  // parser's 5 MB limit — the helper's largest body.
  const piece = Buffer.alloc(CHUNK_MAX, 0x62);
  const rp = await append(where, seed.length, piece);
  assert.equal(rp.status, 200, rp.text);
  assert.deepEqual(rp.body, { size: seed.length + CHUNK_MAX });
});

test('protocol v2 is a 426 naming the protocols this panel speaks', async () => {
  const r = await hello(randomUUID(), { v: 2 }, {});
  assert.equal(r.status, 426);
  assert.deepEqual(r.body, { supported: [1] });
});

test('an append that calls itself JSON is parsed by the global parser and refused, not stored', async () => {
  const where = conv();
  const r = await call('alpha-bot', 'append', { json: { type: 'user' }, query: { ...where, offset: 0 } });
  assert.equal(r.status, 400);
  assert.equal(fs.existsSync(copyPath('alpha-bot', where)), false);
});

test('a component the store would refuse is a 400 from the route, never a path', async () => {
  for (const bad of [{ root: '..' }, { root: 'a/b' }, { project: '../x' }, { session: 'NOT-A-UUID' }, { agent: '../agent-x' }]) {
    const where = { ...conv(), ...bad };
    const r = await append(where, 0, Buffer.from('{}\n'));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  // Repeated query keys arrive as arrays; they are refused, not coerced.
  const u = url('alpha-bot', 'append', { ...conv(), offset: 0 });
  u.searchParams.append('root', 'other');
  const res = await fetch(u, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: '{}\n' });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------------- registration --- */

test('a `bots add` while the panel runs is accepted on the next request, and `bots remove` revokes it', async () => {
  const env = scratchEnv();
  const added = await exec(process.execPath, [CLI, 'bots', 'add', 'beta-bot'], { env });
  const betaToken = /^FOREMAN_BOT_TOKEN=(\S+)$/m.exec(added.stdout)?.[1];
  assert.ok(betaToken, added.stdout);

  // The registry is checked at most every two seconds; wait that out, then one request.
  await sleep(RELOAD_WINDOW_MS);
  const ok = await hello(randomUUID(), {}, { bot: 'beta-bot', tok: betaToken });
  assert.equal(ok.status, 200, ok.text);

  await exec(process.execPath, [CLI, 'bots', 'remove', 'beta-bot'], { env });
  await sleep(RELOAD_WINDOW_MS);
  const gone = await call('beta-bot', 'manifest', { tok: betaToken });
  assert.equal(gone.status, 401, 'a revoked token still verified against the registry in memory');
});

/* ------------------------------------------------------- what must not change --- */

test('/ws still opens and sends the roster, and a socket on any other path is still refused', async () => {
  const frame = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('message', (raw) => { ws.close(); resolve(JSON.parse(raw)); });
    ws.once('error', reject);
  });
  assert.equal(frame.type, 'sessions');
  assert.ok(Array.isArray(frame.sessions));

  const refused = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/bots/alpha-bot/hello`);
    ws.once('open', () => { ws.close(); resolve('opened'); });
    ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.once('error', () => resolve('error'));
  });
  assert.notEqual(refused, 'opened');
});

test('/hook still takes a body with no JSON content type and answers 204', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: JSON.stringify({ hook_event_name: 'Notification', session_id: randomUUID(), cwd: stateDir }),
  });
  assert.equal(res.status, 204);
});

/* ------------------------------------------------------------- the stand-down --- */

/** Run `server/index.js` to its own exit, collecting both streams. */
function runToExit(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.setEncoding('utf8').on('data', (d) => { out += d; });
    proc.stderr.setEncoding('utf8').on('data', (d) => { out += d; });
    const kill = setTimeout(() => proc.kill('SIGKILL'), 20_000);
    proc.once('exit', (code, signal) => { clearTimeout(kill); resolve({ code, signal, out }); });
  });
}

/*
 * A panel that finds the port already answering stands down — and must leave the running
 * panel's state dir exactly as it found it. The store is constructed at module load, long
 * before the probe, so the first prune and its line are deferred to `bots.start()` in the
 * boot block. Proved against a fresh state dir holding one conversation 200 days old with a
 * flushed index (so loading it is silent), first with something squatting on the port, then
 * — the control — with the port free, where the same boot prunes it and says so.
 */
test('a panel that stands down prunes no copy and prints no [bots] line; one that boots does', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bots-ingest-standdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const seeder = new BotStore({ dir, timers: false, log: () => {} });
  seeder.register('old-bot');
  const where = conv();
  const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const r = seeder.append('old-bot', where, 0, Buffer.from(line({ type: 'user', timestamp: longAgo, message: { role: 'user', content: 'long ago' } })));
  assert.equal(r.status, 200);
  seeder.stop(); // flushes the index
  const copy = path.join(dir, 'bots', 'old-bot', where.root, where.project, `${where.session}.jsonl`);
  const index = path.join(dir, 'bots', 'old-bot', 'index.json');
  const before = { copy: fs.readFileSync(copy), index: fs.readFileSync(index), registry: fs.readFileSync(path.join(dir, 'bots.json')) };

  const squatter = http.createServer((_req, res) => res.end('already here'));
  await new Promise((r2) => squatter.listen(0, '127.0.0.1', r2));
  const squatPort = squatter.address().port;
  const env = scratchEnv({ FOREMAN_PORT: String(squatPort), FOREMAN_STATE_DIR: dir, FOREMAN_LOG_DIR: path.join(dir, 'logs') });

  const stood = await runToExit(env);
  await new Promise((r2) => { squatter.close(r2); squatter.closeAllConnections(); });
  assert.equal(stood.code, 0, stood.out);
  assert.match(stood.out, /already answers/, 'it did not stand down, so this proves nothing');
  assert.ok(!stood.out.includes('[bots]'), stood.out);
  assert.ok(fs.readFileSync(copy).equals(before.copy), 'the copy moved');
  assert.ok(fs.readFileSync(index).equals(before.index), 'the index moved');
  assert.ok(fs.readFileSync(path.join(dir, 'bots.json')).equals(before.registry), 'the registry moved');

  // The control: the port is free, the same state dir, and this boot does prune.
  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => stopProc(proc));
  let err = '';
  proc.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
  const deadline = Date.now() + 20_000;
  while (!/\[bots\] retention/.test(err) && Date.now() < deadline) await sleep(100);
  await stopProc(proc);
  assert.match(err, /\[bots\] retention \d+ days: pruned 1 conversation, 1 file/, err);
  assert.equal(fs.existsSync(copy), false);
});

/* ------------------------------------------------------------- the real helper --- */

/**
 * A synthetic deployment's projects dir: the sandbox fixtures as conversations, one grown
 * past a 4 MiB chunk, one line longer than a chunk, and a subagent file.
 */
function writeSource(src) {
  const project = path.join(src, '-srv-alpha');
  fs.mkdirSync(project, { recursive: true });
  const files = [];
  for (const name of ['bot-sonnet-5-5.jsonl', 'bot-haiku-4-5.jsonl', 'bot-sonnet-5-5-1m.jsonl']) {
    const file = path.join(project, `${randomUUID()}.jsonl`);
    fs.writeFileSync(file, fs.readFileSync(path.join(FIXTURES, name)));
    files.push(file);
  }
  // Past one chunk, so the helper's 4 MiB bodies go through the route's raw parser.
  const filler = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2000) }] } });
  fs.appendFileSync(files[0], filler.repeat(Math.ceil((CHUNK_MAX * 2.2) / filler.length)));
  // One line longer than a chunk — an image riding inside a transcript.
  fs.appendFileSync(files[1], line({ type: 'user', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(CHUNK_MAX + 1234) } }] } }));
  const session = path.basename(files[2], '.jsonl');
  const subagent = path.join(project, session, 'subagents', 'agent-e2e1');
  fs.mkdirSync(path.dirname(subagent), { recursive: true });
  fs.writeFileSync(`${subagent}.jsonl`, line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'sub' } }));
  files.push(`${subagent}.jsonl`);
  return files;
}

function copyOf(file) {
  const rel = file.split(`${path.sep}-srv-alpha${path.sep}`)[1];
  return path.join(stateDir, 'bots', 'alpha-bot', 'main', '-srv-alpha', rel);
}

async function converged(files, deadline) {
  for (;;) {
    const done = files.every((f) => {
      const c = copyOf(f);
      return fs.existsSync(c) && sha(fs.readFileSync(c)) === sha(fs.readFileSync(f));
    });
    if (done) return true;
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
}

function startHelper(src, log) {
  const proc = spawn(process.execPath, [HELPER], {
    env: {
      ...process.env,
      FOREMAN_URL: `http://127.0.0.1:${port}`,
      FOREMAN_BOT: 'alpha-bot',
      FOREMAN_BOT_TOKEN: token,
      FOREMAN_WATCH: `main=${src}`,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (d) => log.push(d));
  return proc;
}

test('the real helper backfills through these routes, and after a restart sends nothing twice', async (t) => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bots-ingest-src-'));
  t.after(() => fs.rmSync(src, { recursive: true, force: true }));
  const files = writeSource(src);
  const log = [];

  // A fresh panel, so the hellos the tests above made as `INSTANCE` hold no window open
  // against the helper's own instance.
  await stopProc(child);
  await bootPanel();

  let helper = startHelper(src, log);
  t.after(() => stopProc(helper));
  assert.ok(await converged(files, Date.now() + 30_000), `the backfill never matched:\n${log.join('')}`);
  await stopProc(helper);

  // The deployment carries on while nothing is shipping.
  const more = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'later' }] } });
  for (const f of files) fs.appendFileSync(f, more.repeat(3));

  // The panel restarts too: a new helper instance would otherwise wait out the 90 s window
  // the old one's last hello opened, which proves nothing here but costs a minute and a half.
  // The copies, not memory, are what the restarted panel's manifest is built from.
  await stopProc(child);
  await bootPanel();

  helper = startHelper(src, log);
  assert.ok(await converged(files, Date.now() + 30_000), `the resume never matched:\n${log.join('')}`);
  await stopProc(helper);

  for (const f of files) {
    assert.equal(fs.statSync(copyOf(f)).size, fs.statSync(f).size, `${path.basename(f)}: a byte was sent twice or not at all`);
  }
  const generations = fs.readdirSync(path.join(stateDir, 'bots', 'alpha-bot', 'main', '-srv-alpha'), { recursive: true })
    .filter((n) => /\.g\d+$/.test(n));
  assert.deepEqual(generations, [], 'nothing was reset');
  assert.ok(!log.join('').includes('refused by the panel'), log.join(''));
});
