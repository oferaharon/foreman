import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * The real helper against the real store. `fake-bot-panel.js` proves the helper against the
 * plan's wire; this proves the STORE answers that wire the way the helper needs, so that
 * item 4's routes can be a thin wrapper over it. The wrapper below is the thinnest one that
 * works — auth, JSON for hello, raw bytes for append, `{status, body}` straight out — and is
 * deliberately not the panel's: no route is mounted anywhere by this change.
 *
 * Every transcript is synthetic, in a temp tree; the helper's timings are shrunk.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bots-helper-state-'));

const { BotStore, CHUNK_MAX } = await import('../server/bots.js');
const { Helper, parseWatch } = await import('../helper/foreman-helper.mjs');

test.after(() => fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true }));

const FAST = { pollMs: 15, fullScanMs: 150, helloMs: 150, backoffMinMs: 10, backoffMaxMs: 40, requestTimeoutMs: 3000 };
const PROJECT = '-workspace-alpha';
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The thinnest wrapper that speaks the wire over a store: the shape item 4 will take. */
async function serve(t, store) {
  const log = [];
  const server = http.createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const body = Buffer.concat(parts);
    const url = new URL(req.url, 'http://panel');
    const m = /^\/api\/bots\/([^/]+)\/(hello|manifest|append)$/.exec(url.pathname);
    const bot = m ? decodeURIComponent(m[1]) : null;
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    let answer;
    if (!m) answer = { status: 404, body: { error: 'not found' } };
    else if (!store.verify(bot, token)) answer = { status: 401, body: { error: 'unknown bot or wrong token' } };
    else if (m[2] === 'hello') {
      let json = null;
      try { json = JSON.parse(body.toString('utf8')); } catch { /* answered as 400 by the store */ }
      answer = store.hello(bot, json);
    } else if (m[2] === 'manifest') answer = store.manifest(bot);
    else {
      const q = url.searchParams;
      answer = store.append(bot, { root: q.get('root'), project: q.get('project'), session: q.get('session'), agent: q.get('agent') }, q.get('offset'), body, { reset: q.get('reset') });
    }
    log.push({ route: m?.[2], query: Object.fromEntries(url.searchParams), bytes: body.length, status: answer.status });
    const text = JSON.stringify(answer.body);
    res.writeHead(answer.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}

function run(t, panel, bot, token, watch) {
  const logs = [];
  const helper = new Helper({ url: panel.url, bot, token, watch: parseWatch(watch) }, { timing: FAST, log: (l) => logs.push(l) });
  const done = helper.run();
  const stop = async () => { helper.stop(); await done; };
  t.after(stop);
  return { helper, logs, stop };
}

const rec = (type, i, extra = {}) => `${JSON.stringify({
  type, uuid: randomUUID(), timestamp: new Date(Date.UTC(2026, 9, 12, 10, 0, i)).toISOString(),
  message: type === 'assistant'
    ? { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: `reply ${i}` }], usage: { input_tokens: 2, cache_read_input_tokens: 1000 * i, cache_creation_input_tokens: 0, output_tokens: 4 } }
    : { role: 'user', content: `prompt ${i}` },
  ...extra,
})}\n`;

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A store whose clock can be moved on, so a restarted helper need not wait out 90 s for real. */
function setup(t) {
  const state = tmp(t, 'foreman-bots-helper-');
  const src = tmp(t, 'foreman-bots-src-');
  const clock = { skew: 0 };
  const store = new BotStore({ dir: state, timers: false, log: () => {}, now: () => Date.now() + clock.skew });
  t.after(() => store.stop());
  const { token } = store.register('alpha-bot');
  return { state, src, store, token, clock };
}

const copyOf = (state, root, session, agent) => (agent
  ? path.join(state, 'bots', 'alpha-bot', root, PROJECT, session, 'subagents', `${agent}.jsonl`)
  : path.join(state, 'bots', 'alpha-bot', root, PROJECT, `${session}.jsonl`));

function same(a, b) {
  try {
    return sha(fs.readFileSync(a)) === sha(fs.readFileSync(b));
  } catch {
    return false;
  }
}

test('the real helper backfills, follows growth and a held partial line, and the copies stay identical', async (t) => {
  const { state, src, store, token, clock } = setup(t);
  const panel = await serve(t, store);
  const a = randomUUID();
  const b = randomUUID();
  const fa = put(path.join(src, PROJECT, `${a}.jsonl`), rec('user', 0) + rec('assistant', 1));
  const fb = put(path.join(src, PROJECT, `${b}.jsonl`), rec('user', 2));
  const fs1 = put(path.join(src, PROJECT, a, 'subagents', 'agent-a1b2.jsonl'), rec('assistant', 3, { isSidechain: true }));
  const h = run(t, panel, 'alpha-bot', token, `main=${src}`);

  await waitFor(() => same(fa, copyOf(state, 'main', a)) && same(fb, copyOf(state, 'main', b)) && same(fs1, copyOf(state, 'main', a, 'agent-a1b2')), 'the backfill');
  assert.equal(store.conversation('alpha-bot', a).model, 'claude-sonnet-5-5');
  assert.equal(store.list()[0].helper.online, true);

  // Growth, with the last line unfinished: shipped up to the newline, the rest held.
  const half = rec('assistant', 4);
  fs.appendFileSync(fa, rec('user', 4) + half.slice(0, 20));
  const upTo = fs.statSync(fa).size - 20;
  await waitFor(() => store.conversation('alpha-bot', a).size === upTo, 'the whole lines');
  await sleep(100);
  assert.equal(store.conversation('alpha-bot', a).size, upTo, 'nothing past the last newline');
  fs.appendFileSync(fa, `${half.slice(20)}${JSON.stringify({ type: 'cost-state' })}\n`);
  await waitFor(() => same(fa, copyOf(state, 'main', a)), 'the completion');
  const conv = store.conversation('alpha-bot', a);
  assert.equal(conv.finished, true);
  assert.equal(conv.ctx.tokens, 4002);
  assert.ok(!h.logs.some((l) => /refused/.test(l)), h.logs.join('\n'));

  // A restart is a new instance: refused at hello while the old one's 90 s run…
  await h.stop();
  const appendsBefore = panel.log.filter((e) => e.route === 'append').length;
  const manifestsBefore = panel.log.filter((e) => e.route === 'manifest').length;
  const again = run(t, panel, 'alpha-bot', token, `main=${src}`);
  await waitFor(() => panel.log.some((e) => e.route === 'hello' && e.status === 409), 'the duplicate refusal');
  assert.equal(panel.log.filter((e) => e.route === 'manifest').length, manifestsBefore, 'a refused instance reads nothing');
  // …and once they are up, it reads the manifest and sends nothing twice.
  clock.skew += 91_000;
  await waitFor(() => panel.log.filter((e) => e.route === 'manifest').length > manifestsBefore, 'the second manifest');
  await sleep(150);
  assert.equal(panel.log.filter((e) => e.route === 'append').length, appendsBefore, 'no byte sent twice');
  fs.appendFileSync(fb, rec('assistant', 5));
  await waitFor(() => same(fb, copyOf(state, 'main', b)), 'growth after the restart');
  assert.ok(again.logs.some((l) => /409/.test(l)));
});

test('a source that shrank is re-sent with reset=1, and the store keeps the old copy as a generation', async (t) => {
  const { state, src, store, token, clock } = setup(t);
  const panel = await serve(t, store);
  const resets = [];
  store.on('reset', (e) => resets.push(e));
  const s = randomUUID();
  const original = rec('user', 0) + rec('assistant', 1) + rec('user', 2);
  const file = put(path.join(src, PROJECT, `${s}.jsonl`), original);
  const h = run(t, panel, 'alpha-bot', token, `main=${src}`);
  await waitFor(() => same(file, copyOf(state, 'main', s)), 'the first copy');
  await h.stop();

  fs.writeFileSync(file, rec('user', 9)); // shorter: "this is not the file the panel has"
  clock.skew += 91_000; // past the old instance's window
  run(t, panel, 'alpha-bot', token, `main=${src}`);
  await waitFor(() => same(file, copyOf(state, 'main', s)), 'the reset copy');
  assert.equal(fs.readFileSync(`${copyOf(state, 'main', s)}.g1`, 'utf8'), original);
  assert.ok(panel.log.some((e) => e.route === 'append' && e.query.reset === '1' && e.query.offset === '0'));
  assert.deepEqual(resets, [{ bot: 'alpha-bot', cid: s, agent: null }]);
  assert.equal(store.conversation('alpha-bot', s).title, 'prompt 9');
});

test('a line longer than CHUNK_MAX goes in pieces and the store indexes it once it ends', async (t) => {
  const { state, src, store, token } = setup(t);
  const panel = await serve(t, store);
  const s = randomUUID();
  const big = rec('assistant', 1).replace('reply 1', `reply ${'B'.repeat(CHUNK_MAX + 5000)}`);
  const file = put(path.join(src, PROJECT, `${s}.jsonl`), rec('user', 0) + big);
  run(t, panel, 'alpha-bot', token, `main=${src}`);
  await waitFor(() => same(file, copyOf(state, 'main', s)), 'the long line', 15000);
  assert.ok(panel.log.filter((e) => e.route === 'append').length >= 2);
  assert.equal(store.conversation('alpha-bot', s).ctx.tokens, 1002);
});

test('two roots sharing one project name, and the same id under both: the second is refused, once', async (t) => {
  const { state, src, store, token } = setup(t);
  const panel = await serve(t, store);
  const shared = randomUUID();
  const own = randomUUID();
  const one = put(path.join(src, 'group-one', PROJECT, `${shared}.jsonl`), rec('user', 0));
  put(path.join(src, 'group-two', PROJECT, `${shared}.jsonl`), rec('user', 1));
  const two = put(path.join(src, 'group-two', PROJECT, `${own}.jsonl`), rec('user', 2));
  fs.utimesSync(one, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000)); // shipped first
  const h = run(t, panel, 'alpha-bot', token, `*=${src}/*`);
  await waitFor(() => same(one, copyOf(state, 'group-one', shared)) && same(two, copyOf(state, 'group-two', own)), 'both roots');
  await waitFor(() => h.logs.some((l) => /refused by the panel \(409/.test(l)), 'the refusal');
  assert.ok(!fs.existsSync(copyOf(state, 'group-two', shared)));
  const refusals = panel.log.filter((e) => e.route === 'append' && e.status === 409 && e.query.root === 'group-two' && e.query.session === shared);
  await sleep(150);
  assert.equal(panel.log.filter((e) => e.route === 'append' && e.status === 409 && e.query.root === 'group-two' && e.query.session === shared).length, refusals.length, 'not retried');
  assert.deepEqual(store.conversations('alpha-bot').conversations.map((c) => c.root).sort(), ['group-one', 'group-two']);
});
