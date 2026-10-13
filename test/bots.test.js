import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

/*
 * `BotStore` on temp dirs with real files. Every store here is handed its own state dir
 * through the constructor — setting `FOREMAN_STATE_DIR` above the imports would not be
 * enough on its own, because ESM hoists them — and the variable is set as well only so
 * that `config.js`, which `bots.js` imports, resolves somewhere scratch rather than at the
 * real `~/.foreman`.
 *
 * Every record is synthetic, built below or read from the minimised sandbox fixtures in
 * `test/fixtures/bot-*.jsonl`; none is an `attachment` (the real ones carry a whole system
 * prompt), and no path names a real folder.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bots-state-'));

const {
  ACTIVE_MS, BOT_ID_RE, BotStore, CHANGE_MIN_MS, CHUNK_MAX, HEAD_MAX, HELLO_WINDOW_MS, LIVENESS_TICK_MS,
} = await import('../server/bots.js');
const { contextOf } = await import('../server/context-window.js');
const { probe } = await import('../server/transcript.js');
const { BOT_RETENTION_DAYS } = await import('../server/config.js');

test.after(() => fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true }));

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const PROJECT = '-workspace-alpha';
const DAY = 86_400_000;
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-bots-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A store on `dir` with no timers, a collected log, and a clock the test can move. */
function open(dir, { now, ...opts } = {}) {
  const lines = [];
  const clock = { t: now ?? Date.UTC(2026, 9, 12, 12, 0, 0) };
  const store = new BotStore({ dir, timers: false, now: () => clock.t, log: (l) => lines.push(l), ...opts });
  return { store, lines, clock };
}

function withBot(t, id = 'alpha-bot', opts) {
  const dir = scratch(t);
  const s = open(dir, opts);
  const reg = s.store.register(id);
  return { dir, ...s, bot: id, token: reg.token };
}

const ts = (min) => new Date(Date.UTC(2026, 9, 12, 10, min, 0)).toISOString();
const line = (r) => `${JSON.stringify(r)}\n`;
const user = (text, min, extra = {}) => line({ type: 'user', uuid: randomUUID(), timestamp: ts(min), entrypoint: 'sdk-cli', version: '2.1.296', message: { role: 'user', content: text }, ...extra });
const reply = (text, min, { model = 'claude-sonnet-5-5', effort = 'medium', input = 2, cacheRead = 10_000, cacheCreate = 30_000, requestedModel } = {}) => line({
  type: 'assistant', uuid: randomUUID(), timestamp: ts(min), entrypoint: 'sdk-cli', version: '2.1.296', ...(effort ? { effort } : {}),
  ...(requestedModel ? { requestedModel } : { requestedModel: model }),
  message: { role: 'assistant', model, content: [{ type: 'text', text }], usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: 7 } },
});
const toolUse = (min) => line({ type: 'assistant', uuid: randomUUID(), timestamp: ts(min), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 5, output_tokens: 3 } } });
const toolResult = (min) => line({ type: 'user', uuid: randomUUID(), timestamp: ts(min), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md' }] } });
const costState = () => line({ type: 'cost-state', totalCostUSD: 0.01 });
const lastPrompt = () => line({ type: 'last-prompt' });

/** A small whole conversation: prompt, a tool call, a reply, closed by `cost-state`. */
function conversation(prompt = 'Summarise the alpha README', from = 0) {
  return user(prompt, from) + toolUse(from + 1) + toolResult(from + 2) + reply('It is a demo package.', from + 3) + lastPrompt() + costState();
}

const ids = (session = randomUUID(), root = 'main', agent = null) => ({ root, project: PROJECT, session, agent });

function append(store, bot, c, offset, text, opts) {
  return store.append(bot, c, offset, Buffer.isBuffer(text) ? text : Buffer.from(text), opts);
}

function copyPath(dir, bot, c) {
  return c.agent
    ? path.join(dir, 'bots', bot, c.root, c.project, c.session, 'subagents', `${c.agent}.jsonl`)
    : path.join(dir, 'bots', bot, c.root, c.project, `${c.session}.jsonl`);
}

/* ------------------------------------------------------------------ registry --- */

test('register mints a token once, stores only its sha256, and verify checks it', (t) => {
  const dir = scratch(t);
  const { store } = open(dir);
  const reg = store.register('alpha-bot', { name: 'Alpha bot' });
  assert.equal(reg.id, 'alpha-bot');
  assert.equal(reg.name, 'Alpha bot');
  assert.match(reg.token, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');

  const file = path.join(dir, 'bots.json');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes(reg.token), 'the token itself is never written');
  const saved = JSON.parse(text).bots[0];
  assert.equal(saved.tokenHash, sha(reg.token));
  assert.deepEqual(Object.keys(saved).sort(), ['createdAt', 'id', 'name', 'tokenHash']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  assert.equal(store.verify('alpha-bot', reg.token), true);
  assert.equal(store.verify('alpha-bot', `${reg.token}x`), false);
  assert.equal(store.verify('alpha-bot', ''), false);
  assert.equal(store.verify('alpha-bot', undefined), false);
  assert.equal(store.verify('beta-bot', reg.token), false, 'an unknown bot answers exactly as a wrong token does');

  // Another process (the CLI) reads the same file.
  assert.equal(open(dir).store.verify('alpha-bot', reg.token), true);

  assert.deepEqual(store.registered(), [{ id: 'alpha-bot', name: 'Alpha bot', createdAt: reg.createdAt }]);
  assert.equal(store.unregister('alpha-bot'), true);
  assert.equal(store.verify('alpha-bot', reg.token), false);
  assert.equal(store.unregister('alpha-bot'), false);
});

test('the bot id is lowercase, starts with a letter, and is at most 32 characters', (t) => {
  const { store } = open(scratch(t));
  for (const good of ['a', 'alpha-bot', 'gamma2', `a${'b'.repeat(31)}`]) assert.ok(BOT_ID_RE.test(good), good);
  for (const bad of ['', 'Alpha', '1alpha', '-alpha', 'alpha_bot', 'alpha.bot', '../x', 'a/b', `a${'b'.repeat(32)}`, '.', '..']) {
    assert.ok(!BOT_ID_RE.test(bad), bad);
    assert.throws(() => store.register(bad), { code: 'EINVAL' }, bad);
  }
  store.register('alpha-bot');
  assert.throws(() => store.register('alpha-bot'), { code: 'EEXIST' });
  assert.throws(() => store.register('beta-bot', { name: 'line\nbreak' }), { code: 'EINVAL' });
});

test('unknown keys survive a bots.json rewrite: on the file, on each entry, and entries this version cannot read', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'bots.json');
  const future = {
    schema: 3,
    outbox: { enabled: true },
    bots: [
      { id: 'alpha-bot', name: 'Alpha', tokenHash: sha('x'), createdAt: 1, inbox: 'https://example.invalid/hook', tags: ['phase-2'] },
      { id: 'Not An Id', note: 'kept as found' },
      'not even an object',
    ],
  };
  fs.writeFileSync(file, JSON.stringify(future));
  const { store } = open(dir);
  assert.deepEqual(store.registered().map((b) => b.id), ['alpha-bot']);
  store.register('beta-bot');
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.schema, 3);
  assert.deepEqual(after.outbox, { enabled: true });
  assert.deepEqual(after.bots.slice(0, 3), future.bots);
  assert.equal(after.bots[3].id, 'beta-bot');
  store.unregister('beta-bot');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).bots, future.bots);
  assert.equal(store.verify('alpha-bot', 'x'), true);
});

test('a bots.json that will not parse is never written over', (t) => {
  const dir = scratch(t);
  const file = path.join(dir, 'bots.json');
  fs.writeFileSync(file, '{"bots": [ {"id": "alpha-bot", ');
  const { store, lines } = open(dir);
  assert.deepEqual(store.registered(), []);
  assert.equal(lines.length, 1);
  assert.throws(() => store.register('beta-bot'), { code: 'ECORRUPT' });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"bots": [ {"id": "alpha-bot", ');
});

test('a registration made by another process is picked up by reloadRegistry, with a change', (t) => {
  const dir = scratch(t);
  const panel = open(dir).store;
  const changes = [];
  panel.on('change', (e) => changes.push(e.bot));
  assert.equal(panel.reloadRegistry(), false);
  const { token } = open(dir, { copies: false }).store.register('alpha-bot');
  assert.equal(panel.verify('alpha-bot', token), false, 'not until it re-reads');
  assert.equal(panel.reloadRegistry(), true);
  assert.equal(panel.verify('alpha-bot', token), true);
  assert.deepEqual(changes, ['alpha-bot']);
  assert.equal(panel.reloadRegistry(), false);
});

/* ------------------------------------------------------------------- appends --- */

test('append lands at the copy\'s size, byte for byte, and the manifest describes it', (t) => {
  const { dir, store, bot } = withBot(t);
  const c = ids();
  const a = conversation().slice(0, 300);
  const first = a.slice(0, a.lastIndexOf('\n') + 1);
  assert.deepEqual(append(store, bot, c, 0, first), { status: 200, body: { size: Buffer.byteLength(first) } });
  const more = user('And the tests?', 9) + reply('They pass.', 10);
  const r = append(store, bot, c, String(Buffer.byteLength(first)), more);
  assert.equal(r.status, 200);
  assert.equal(r.body.size, Buffer.byteLength(first) + Buffer.byteLength(more), 'size === offset + bytes.length');

  const file = copyPath(dir, bot, c);
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString(), first + more);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'as private as the transcript it copies');
  assert.equal(store.pathOf(bot, c.session), file);

  const m = store.manifest(bot);
  assert.equal(m.status, 200);
  assert.deepEqual(m.body, {
    v: 1,
    files: [{ root: 'main', project: PROJECT, session: c.session, agent: null, size: bytes.length, headLen: Math.min(bytes.length, HEAD_MAX), head: sha(bytes.subarray(0, HEAD_MAX)) }],
  });
});

test('the head is the first 4096 bytes once the copy is longer, and a subagent is its own file', (t) => {
  const { dir, store, bot } = withBot(t);
  const c = ids();
  let text = '';
  for (let i = 0; i < 80; i++) text += user(`prompt ${i} ${'x'.repeat(60)}`, i);
  append(store, bot, c, 0, text.slice(0, 1000).slice(0, text.slice(0, 1000).lastIndexOf('\n') + 1));
  const at = fs.statSync(copyPath(dir, bot, c)).size;
  append(store, bot, c, at, text.slice(at));
  const sub = { ...c, agent: 'agent-a1b2c3' };
  const subText = reply('subagent says hi', 5);
  assert.equal(append(store, bot, sub, 0, subText).status, 200);

  const files = store.manifest(bot).body.files;
  assert.equal(files.length, 2);
  const [main, agent] = files;
  assert.equal(main.size, Buffer.byteLength(text));
  assert.equal(main.headLen, HEAD_MAX);
  assert.equal(main.head, sha(Buffer.from(text).subarray(0, HEAD_MAX)));
  assert.deepEqual(agent, { root: 'main', project: PROJECT, session: c.session, agent: 'agent-a1b2c3', size: Buffer.byteLength(subText), headLen: Buffer.byteLength(subText), head: sha(Buffer.from(subText)) });
  assert.equal(fs.readFileSync(copyPath(dir, bot, sub), 'utf8'), subText);
  assert.equal(store.pathOf(bot, c.session, 'agent-a1b2c3'), copyPath(dir, bot, sub));
  assert.equal(store.pathOf(bot, c.session, 'agent-zz'), null);
  // A subagent's records are not the conversation's: its usage is not the conversation's context.
  assert.equal(store.conversation(bot, c.session).model, null);
});

test('a gap is refused with the copy\'s size, and nothing is written', (t) => {
  const { dir, store, bot } = withBot(t);
  const c = ids();
  const a = user('one', 0);
  append(store, bot, c, 0, a);
  const size = Buffer.byteLength(a);
  assert.deepEqual(append(store, bot, c, size + 10, user('two', 1)), { status: 409, body: { size } });
  assert.deepEqual(append(store, bot, c, 0, user('two', 1)), { status: 409, body: { size } }, 'behind is a gap too');
  assert.deepEqual(append(store, bot, ids(), 5, user('new', 1)), { status: 409, body: { size: 0 } }, 'a file the panel lacks is at 0');
  assert.equal(fs.readFileSync(copyPath(dir, bot, c), 'utf8'), a);
  assert.equal(store.manifest(bot).body.files.length, 1, 'a refused new file leaves no entry behind');
});

test('bodies, offsets and the bot itself are checked before anything is written', (t) => {
  const { dir, store, bot } = withBot(t);
  const c = ids();
  assert.equal(append(store, bot, c, 0, 'no newline').status, 400);
  assert.equal(append(store, bot, c, 0, '').status, 400);
  assert.equal(append(store, bot, c, -1, user('x', 0)).status, 400);
  assert.equal(append(store, bot, c, '1.5', user('x', 0)).status, 400);
  assert.equal(append(store, bot, c, '', user('x', 0)).status, 400, 'an empty offset is not 0');
  assert.equal(append(store, bot, c, 1.5, user('x', 0)).status, 400);
  assert.equal(append(store, bot, c, 0, Buffer.alloc(CHUNK_MAX + 1, 10)).status, 413);
  assert.equal(store.append(bot, c, 0, 'a string, not bytes\n').status, 400);
  assert.equal(append(store, 'beta-bot', c, 0, user('x', 0)).status, 401);
  assert.equal(store.manifest('beta-bot').status, 401);
  assert.equal(store.hello('beta-bot', { v: 1, instance: 'i' }).status, 401);
  assert.ok(!fs.existsSync(path.join(dir, 'bots', bot)), 'no directory was made for any of it');
});

test('a partial-line chunk is held by the index until its completion arrives', (t) => {
  const { dir, store, bot } = withBot(t);
  const c = ids();
  const head = user('Describe the image', 0);
  const image = reply(`here it is: ${'A'.repeat(CHUNK_MAX + 1000)}`, 1, { model: 'claude-haiku-4-5-20251001', effort: null, cacheRead: 150_000, cacheCreate: 0 });
  const whole = Buffer.from(head + image + costState());
  append(store, bot, c, 0, head);
  const at = Buffer.byteLength(head);

  // The helper's piece of one long line is exactly CHUNK_MAX and ends mid-line.
  const piece = whole.subarray(at, at + CHUNK_MAX);
  assert.notEqual(piece[piece.length - 1], 10);
  assert.deepEqual(store.append(bot, c, at, piece), { status: 200, body: { size: at + CHUNK_MAX } });
  let conv = store.conversation(bot, c.session);
  assert.equal(conv.model, null, 'the reply is not read while its line is unfinished');
  assert.equal(conv.prompts, 1);
  assert.equal(conv.finished, false);

  // A shorter piece that ends mid-line is not something the helper sends.
  assert.equal(store.append(bot, c, at + CHUNK_MAX, whole.subarray(at + CHUNK_MAX, at + CHUNK_MAX + 10)).status, 400);

  assert.equal(store.append(bot, c, at + CHUNK_MAX, whole.subarray(at + CHUNK_MAX)).status, 200);
  conv = store.conversation(bot, c.session);
  assert.equal(conv.model, 'claude-haiku-4-5-20251001');
  assert.equal(conv.effort, null);
  assert.deepEqual(conv.ctx, { tokens: 150_002, window: 200_000, pct: 75 });
  assert.equal(conv.finished, true);
  assert.equal(sha(fs.readFileSync(copyPath(dir, bot, c))), sha(whole));
});

test('a reset (shrink, or a head that differs) sets the copy aside as a generation and starts again', (t) => {
  const { dir, store, bot } = withBot(t);
  const resets = [];
  store.on('reset', (e) => resets.push(e));
  const c = ids();
  const original = conversation('First version of the prompt');
  append(store, bot, c, 0, original);
  const file = copyPath(dir, bot, c);

  // Shrink: the source is now shorter than the copy, so the helper re-sends from 0.
  const shorter = user('Second, shorter', 20);
  assert.equal(append(store, bot, c, 5, shorter, { reset: true }).status, 400, 'reset only ever comes with offset 0');
  assert.deepEqual(append(store, bot, c, '0', shorter, { reset: '1' }), { status: 200, body: { size: Buffer.byteLength(shorter) } });
  assert.equal(fs.readFileSync(`${file}.g1`, 'utf8'), original, 'the old copy is intact');
  assert.equal(fs.readFileSync(file, 'utf8'), shorter);
  assert.deepEqual(resets, [{ bot, cid: c.session, agent: null }]);
  let conv = store.conversation(bot, c.session);
  assert.equal(conv.title, 'Second, shorter', 'the index is the new copy\'s, not a blend');
  assert.equal(conv.prompts, 1);
  assert.equal(conv.finished, false);
  assert.equal(conv.firstTs, ts(20));

  // Head mismatch: same size, other bytes.
  const same = user('Second, shorteR', 21);
  assert.equal(Buffer.byteLength(same), Buffer.byteLength(shorter));
  append(store, bot, c, 0, same, { reset: 1 });
  assert.equal(fs.readFileSync(`${file}.g1`, 'utf8'), original);
  assert.equal(fs.readFileSync(`${file}.g2`, 'utf8'), shorter);
  assert.equal(fs.readFileSync(file, 'utf8'), same);
  assert.equal(resets.length, 2);
  assert.equal(store.manifest(bot).body.files[0].head, sha(Buffer.from(same)));

  // A reset for a file the panel does not hold is a plain first append, and sets nothing aside.
  const fresh = ids();
  append(store, bot, fresh, 0, user('new', 0), { reset: true });
  assert.equal(resets.length, 2);
  assert.ok(!fs.existsSync(`${copyPath(dir, bot, fresh)}.g1`));

  // Generations are counted in the disk use, and never in a *.jsonl scan.
  const disk = store.describe()[0].disk;
  assert.equal(disk.files, 4);
  assert.equal(disk.bytes, Buffer.byteLength(original + shorter + same + user('new', 0)));
  conv = store.conversation(bot, c.session);
  assert.equal(conv.size, Buffer.byteLength(same));
});

test('every component regex refuses traversal, absolute paths, . and .., and uppercase UUIDs', (t) => {
  const { dir, store, bot } = withBot(t);
  const session = randomUUID();
  const bad = [
    { root: '..' }, { root: '.' }, { root: '../x' }, { root: 'a/b' }, { root: '/etc' }, { root: '' }, { root: '.hidden' },
    { root: 'a\\b' }, { root: 'a\0b' }, { root: 'x'.repeat(65) }, { root: null },
    { project: '..' }, { project: '.' }, { project: '../../etc' }, { project: '/abs' }, { project: 'a/b' }, { project: '' },
    { project: '-work space' }, { project: 'a.b' },
    { session: session.toUpperCase() }, { session: `../${session}` }, { session: `/${session}` }, { session: '.' }, { session: '..' },
    { session: `${session}.jsonl` }, { session: session.replace(/-/g, '') }, { session: '' },
    { agent: '..' }, { agent: '.' }, { agent: 'agent-../x' }, { agent: '/agent-x' }, { agent: 'agent-' }, { agent: 'agent-a/b' },
    { agent: 'a1b2' }, { agent: 'agent-a.b' }, { agent: `agent-${'a'.repeat(65)}` },
  ];
  for (const over of bad) {
    const c = { ...ids(session), ...over };
    assert.deepEqual(append(store, bot, c, 0, user('x', 0)), { status: 400, body: { error: 'bad component' } }, JSON.stringify(over));
  }
  assert.equal(append(store, bot, { ...ids(session), root: 'index.json' }, 0, user('x', 0)).status, 400, 'the store\'s own file name');
  assert.equal(append(store, bot, { ...ids(session), root: 'INDEX.JSON' }, 0, user('x', 0)).status, 400);
  assert.ok(!fs.existsSync(path.join(dir, 'bots')), 'nothing was created anywhere');
  for (const agent of [undefined, null, '']) {
    assert.equal(append(store, bot, { ...ids(randomUUID()), agent }, 0, user('x', 0)).status, 200, `agent ${JSON.stringify(agent)} is a main file`);
  }
});

test('a conversation id already held under another root is refused without a size, and never merged', (t) => {
  const { dir, store, bot } = withBot(t);
  const session = randomUUID();
  const a = user('group one', 0);
  append(store, bot, ids(session, 'group-one'), 0, a);
  const refused = append(store, bot, ids(session, 'group-two'), 0, user('group two', 0));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.size, undefined, 'no numeric size, so it can never read as "resume from here"');
  assert.match(refused.body.error, /another root/);
  assert.equal(append(store, bot, { ...ids(session, 'group-two'), agent: 'agent-a1' }, 0, user('x', 0)).status, 409, 'its subagents too');
  assert.equal(append(store, bot, { ...ids(session, 'group-one'), project: '-workspace-beta' }, 0, user('x', 0)).status, 409, 'and another project');
  assert.ok(!fs.existsSync(path.join(dir, 'bots', bot, 'group-two')));
  assert.equal(fs.readFileSync(copyPath(dir, bot, ids(session, 'group-one')), 'utf8'), a);
  assert.equal(store.describe()[0].lastRefusal.status, 409);

  // Two roots sharing one project name is fine (trap 13): different conversations.
  assert.equal(append(store, bot, ids(randomUUID(), 'group-two'), 0, user('group two', 0)).status, 200);
});

test('a spelling that differs only in case is refused, since this disk folds case', (t) => {
  const { store, bot } = withBot(t);
  const session = randomUUID();
  append(store, bot, ids(session, 'Main'), 0, user('x', 0));
  for (const c of [
    ids(randomUUID(), 'main'),
    { ...ids(randomUUID(), 'Main'), project: PROJECT.toUpperCase() },
  ]) {
    const r = append(store, bot, c, 0, user('y', 0));
    assert.equal(r.status, 409, JSON.stringify(c));
    assert.equal(r.body.size, undefined);
    assert.match(r.body.error, /only in case/);
  }
  append(store, bot, { ...ids(session, 'Main'), agent: 'agent-Ab1' }, 0, user('a', 0));
  assert.equal(append(store, bot, { ...ids(session, 'Main'), agent: 'agent-ab1' }, 0, user('a', 0)).status, 409);
});

/* --------------------------------------------------------------------- index --- */

test('the index reads title, prompts, model, effort, context, version and entrypoint off the bytes', (t) => {
  const { store, bot } = withBot(t);
  const c = ids();
  const text = conversation('Summarise the alpha README');
  append(store, bot, c, 0, text);
  const conv = store.conversation(bot, c.session);
  const records = text.trim().split('\n').map((l) => JSON.parse(l));
  const expect = contextOf(records);
  assert.deepEqual(
    { ...conv, lastAppendAt: 0 },
    {
      cid: c.session, root: 'main', project: PROJECT, title: 'Summarise the alpha README',
      firstTs: ts(0), lastTs: ts(3), lastAppendAt: 0, size: Buffer.byteLength(text), prompts: 1,
      model: expect.model, modelName: expect.modelName, effort: expect.effort,
      ctx: { tokens: expect.tokens, window: expect.window, pct: expect.pct },
      finished: true, entrypoint: 'sdk-cli', version: '2.1.296',
      activeAt: Date.parse(ts(3)), active: false,
    },
  );
  assert.equal(conv.modelName, 'Sonnet 5.5');
  assert.deepEqual(conv.ctx, { tokens: 40_002, window: 1_000_000, pct: 4 });
});

test('the minimised sandbox fixtures read as contextOf reads them, [1m] and Haiku 4.5 included', (t) => {
  const { store, bot } = withBot(t);
  for (const name of ['bot-sonnet-5-5.jsonl', 'bot-sonnet-5-5-1m.jsonl', 'bot-haiku-4-5.jsonl']) {
    const bytes = fs.readFileSync(path.join(FIXTURES, name));
    const records = bytes.toString().trim().split('\n').map((l) => JSON.parse(l));
    const c = ids(records[0].sessionId);
    assert.equal(store.append(bot, c, 0, bytes).status, 200, name);
    const conv = store.conversation(bot, c.session);
    const want = contextOf(records);
    assert.deepEqual([conv.model, conv.modelName, conv.effort, conv.ctx], [want.model, want.modelName, want.effort, { tokens: want.tokens, window: want.window, pct: want.pct }], name);
    assert.equal(conv.finished, true, `${name} ends in cost-state`);
    assert.equal(conv.title, 'Reply with the single word: ok');
  }
});

test('a cost-state tail marks finished, and a resume that appends clears it until its own', (t) => {
  const { store, bot } = withBot(t);
  const c = ids();
  let size = 0;
  const step = (text) => { size = append(store, bot, c, size, text).body.size; return store.conversation(bot, c.session); };
  assert.equal(step(user('go', 0) + reply('done', 1)).finished, false);
  assert.equal(step(lastPrompt() + costState()).finished, true);
  const resumed = step(user('again', 5));
  assert.equal(resumed.finished, false, '--resume appends to the same file');
  assert.equal(resumed.prompts, 2);
  // Neither cost-state nor last-prompt carries a timestamp, so they never move lastTs.
  assert.equal(step(reply('done again', 6) + lastPrompt() + costState()).finished, true);
  assert.equal(store.conversation(bot, c.session).lastTs, ts(6));
});

test('titles: custom-title, then ai-title, then the first prompt (through its paste wrapper), then the id', (t) => {
  const { store, bot } = withBot(t);
  const make = (text) => {
    const c = ids();
    append(store, bot, c, 0, text);
    return store.conversation(bot, c.session);
  };
  const pasted = '\n\n<pasted_content id="1a2b">\nNightly digest for alpha\nsecond line\nthird\nfourth\n</pasted_content id="1a2b">\n';
  assert.equal(make(user(pasted, 0)).title, 'Nightly digest for alpha');
  assert.equal(make(user('<command-name>/x</command-name>', 0) + user('the real one', 1)).title, 'the real one');
  assert.equal(make(user('meta first', 0, { isMeta: true }) + user('then this', 1)).title, 'then this');
  const long = 'L'.repeat(80);
  assert.equal(make(user(long, 0)).title, `${'L'.repeat(57)}…`);
  const ai = line({ type: 'ai-title', aiTitle: 'Alpha README summary' });
  assert.equal(make(user('a prompt', 0) + ai).title, 'Alpha README summary');
  const custom = line({ type: 'custom-title', customTitle: 'Named by hand' });
  assert.equal(make(custom + user('a prompt', 0) + ai).title, 'Named by hand');
  const none = make(toolResult(0));
  assert.equal(none.title, `conversation ${none.cid.slice(0, 8)}`);
  assert.equal(none.prompts, 0, 'a tool result is not a prompt');
});

test('the first-prompt title is the one probe gives a session, on the same transcript', async (t) => {
  const { dir, store, bot } = withBot(t);
  const cases = [
    user('Summarise the alpha README', 0),
    user('\n\n<pasted_content id="1a2b">\nNightly digest\nb\nc\nd\n</pasted_content id="1a2b">\n', 0),
    user('<local-command-stdout>x</local-command-stdout>', 0) + user('second', 1),
    user('M'.repeat(90), 0),
    line({ type: 'custom-title', customTitle: 'By hand' }) + user('p', 0),
  ];
  for (const text of cases) {
    const c = ids();
    append(store, bot, c, 0, text + reply('ok', 4));
    const meta = await probe(copyPath(dir, bot, c));
    assert.equal(store.conversation(bot, c.session).title, meta.title);
  }
});

test('the bot row is the newest qualifying record across conversations, and counts the active ones', (t) => {
  const { store, bot, clock } = withBot(t);
  const a = ids();
  const b = ids();
  append(store, bot, a, 0, user('a', 0) + reply('a', 10, { model: 'claude-opus-5-5', effort: 'xhigh', cacheRead: 200_000 }));
  append(store, bot, b, 0, user('b', 0) + reply('b', 5, { model: 'claude-haiku-4-5-20251001', effort: null, cacheRead: 50_000, cacheCreate: 0 }));
  let [row] = store.list();
  assert.equal(row.id, bot);
  assert.equal(row.conversations, 2);
  assert.equal(row.active, 2, 'neither has finished and both arrived just now');
  assert.deepEqual(row.current, { cid: a.session, at: ts(10), model: 'claude-opus-5-5', modelName: 'Opus 5.5', effort: 'xhigh', ctx: { tokens: 230_002, window: 1_000_000, pct: 23 } });
  assert.equal(row.lastTs, ts(10));

  // b's reply is newer by record time; it arrives later, but that is not what decides.
  append(store, bot, b, store.conversation(bot, b.session).size, reply('b2', 12, { model: 'claude-haiku-4-5-20251001', effort: null, cacheRead: 100_000, cacheCreate: 0 }) + costState());
  [row] = store.list();
  assert.equal(row.current.cid, b.session);
  assert.deepEqual(row.current.ctx, { tokens: 100_002, window: 200_000, pct: 50 });
  assert.equal(row.current.effort, null, 'model, effort and context come from one record, never mixed');
  assert.equal(row.active, 1, 'a finished conversation is not active');

  clock.t += ACTIVE_MS;
  assert.equal(store.list()[0].active, 0, 'nor is one with no append for 60 s');
  assert.equal(store.conversation(bot, a.session).active, false);
});

test('conversations() pages newest first by last activity, with a cursor', (t) => {
  const { store, bot } = withBot(t);
  const made = [];
  for (let i = 0; i < 5; i++) {
    const c = ids();
    append(store, bot, c, 0, user(`p${i}`, i * 2));
    made.push(c.session);
  }
  // Same record time on two of them: the cursor still splits them exactly.
  const tie = ids();
  append(store, bot, tie, 0, user('tie', 8));
  const all = store.conversations(bot).conversations.map((c) => c.cid);
  assert.equal(all.length, 6);
  assert.deepEqual(all.slice(2), [made[3], made[2], made[1], made[0]]);
  const p1 = store.conversations(bot, { limit: 2 });
  assert.equal(p1.conversations.length, 2);
  const p2 = store.conversations(bot, { limit: 2, before: p1.next });
  const p3 = store.conversations(bot, { limit: 2, before: p2.next });
  assert.equal(p3.next, null);
  assert.deepEqual([...p1.conversations, ...p2.conversations, ...p3.conversations].map((c) => c.cid), all);
  assert.deepEqual(store.conversations(bot, { before: Date.parse(ts(4)) }).conversations.map((c) => c.cid), [made[1], made[0]]);
  assert.deepEqual(store.conversations(bot, { before: ts(4) }).conversations.map((c) => c.cid), [made[1], made[0]]);
  assert.equal(store.conversations('beta-bot'), null);
  assert.equal(store.pathOf('beta-bot', made[0]), null);
  assert.equal(store.pathOf(bot, made[0].toUpperCase()), null);
  assert.equal(store.pathOf(bot, randomUUID()), null);
});

/**
 * Feed `text` the way a helper would: chunks that end on newlines, sized `step`, with any
 * line longer than CHUNK_MAX cut into CHUNK_MAX pieces.
 */
function ship(store, bot, c, text, step) {
  const buf = Buffer.from(text);
  let off = 0;
  while (off < buf.length) {
    let window = buf.subarray(off, Math.min(buf.length, off + step));
    if (window.lastIndexOf(10) < 0) window = buf.subarray(off, Math.min(buf.length, off + CHUNK_MAX));
    const nl = window.lastIndexOf(10);
    const n = nl >= 0 ? nl + 1 : window.length;
    const r = store.append(bot, c, off, buf.subarray(off, off + n));
    assert.equal(r.status, 200, JSON.stringify(r));
    off += n;
  }
}

function strip(list) {
  return list.map(({ lastAppendAt, active, activeAt, ...rest }) => rest);
}

test('an index rebuilt from the copies equals the incremental one', (t) => {
  const dir = scratch(t);
  const { store, lines } = open(dir);
  const bot = 'alpha-bot';
  store.register(bot);
  const convs = [];
  for (let i = 0; i < 4; i++) {
    const c = ids(randomUUID(), i % 2 ? 'group-one' : 'group-two');
    let text = '';
    for (let j = 0; j < 30; j++) text += user(`prompt ${i}.${j}`, j) + reply(`reply ${j}`, j, { cacheRead: 1000 * j }) + toolResult(j);
    if (i === 1) text += line({ type: 'ai-title', aiTitle: 'Titled by the model' });
    if (i !== 2) text += costState();
    ship(store, bot, c, text, 97 + i * 211); // a different chunking per conversation
    convs.push(c);
  }
  append(store, bot, { ...convs[0], agent: 'agent-a1b2' }, 0, reply('sub', 1));
  append(store, bot, convs[3], 0, user('reset', 40), { reset: true });
  store.flush();
  const incremental = store.conversations(bot).conversations;
  const manifest = store.manifest(bot).body;
  const disk = store.describe()[0].disk;
  const indexFile = path.join(dir, 'bots', bot, 'index.json');
  assert.equal(fs.statSync(indexFile).mode & 0o777, 0o600);

  // Read back through the index.
  const again = open(dir).store;
  assert.deepEqual(again.conversations(bot).conversations, incremental, 'through the index, nothing moves at all');
  assert.deepEqual(again.manifest(bot).body, manifest);

  // Missing, unreadable, and an old shape: each is a full rebuild, and never an error.
  for (const spoil of [() => fs.rmSync(indexFile), () => fs.writeFileSync(indexFile, '{"v":1,"conv'), () => fs.writeFileSync(indexFile, '{"v":0,"conversations":[]}')]) {
    spoil();
    const before = lines.length;
    const rebuilt = open(dir, { log: (l) => lines.push(l) }).store;
    assert.deepEqual(strip(rebuilt.conversations(bot).conversations), strip(incremental));
    assert.deepEqual(rebuilt.manifest(bot).body, manifest);
    assert.deepEqual(rebuilt.describe()[0].disk, disk);
    assert.ok(lines.slice(before).some((l) => /rebuilt from 5 copies/.test(l)), lines.slice(before).join('\n'));
    rebuilt.flush();
  }
});

test('copies that moved on after the last flush are re-read, and unknown index keys are carried through', (t) => {
  const { dir, store, bot } = withBot(t);
  const c = ids();
  append(store, bot, c, 0, user('one', 0));
  store.flush();
  const indexFile = path.join(dir, 'bots', bot, 'index.json');
  const idx = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  idx.phase2 = { outbox: [] };
  idx.conversations[0].pinnedBy = 'a later version';
  fs.writeFileSync(indexFile, JSON.stringify(idx));
  // Appended after the flush, as a crash between the two would leave it.
  const size = store.conversation(bot, c.session).size;
  append(store, bot, c, size, reply('two', 1) + costState());

  const next = open(dir);
  const conv = next.store.conversation(bot, c.session);
  assert.equal(conv.finished, true);
  assert.equal(conv.model, 'claude-sonnet-5-5');
  assert.ok(next.lines.some((l) => /re-read 1 copy/.test(l)));
  next.store.flush();
  const written = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.deepEqual(written.phase2, { outbox: [] });
  assert.equal(written.conversations[0].pinnedBy, 'a later version');
});

test('a copy changed behind the store\'s back is re-read before the next append is judged', (t) => {
  const { dir, store, bot } = withBot(t);
  const c = ids();
  const a = user('one', 0) + reply('two', 1);
  append(store, bot, c, 0, a);
  fs.rmSync(copyPath(dir, bot, c));
  // The manifest still says otherwise, so the helper appends where it thinks the copy ends.
  assert.deepEqual(append(store, bot, c, Buffer.byteLength(a), user('three', 2)), { status: 409, body: { size: 0 } });
  assert.deepEqual(store.manifest(bot).body.files, []);
  assert.equal(append(store, bot, c, 0, a).status, 200);
});

/* ----------------------------------------------------------------- retention --- */

test('prune keeps 90 days from the last record, and uses receipt time only when there is none', (t) => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const { dir, store, bot, lines, clock } = withBot(t, 'alpha-bot', { now });
  assert.equal(BOT_RETENTION_DAYS, 90);
  const at = (days) => new Date(now - days * DAY).toISOString();
  const rec = (days, text) => line({ type: 'user', uuid: randomUUID(), timestamp: at(days), message: { role: 'user', content: text } });

  // Old records, arrived today (a first backfill): record time decides, so it goes.
  const old = ids();
  append(store, bot, old, 0, rec(100, 'old') + costState());
  append(store, bot, { ...old, agent: 'agent-a1' }, 0, rec(100, 'old sub'));
  append(store, bot, old, 0, rec(99, 'old again'), { reset: true });
  // Recent records: kept.
  const recent = ids();
  append(store, bot, recent, 0, rec(89, 'recent'));
  // No timestamped record at all, received 100 days ago: receipt time decides, so it goes.
  const quiet = ids();
  clock.t = now - 100 * DAY;
  append(store, bot, quiet, 0, costState());
  // No timestamped record, received today: kept.
  clock.t = now;
  const fresh = ids();
  append(store, bot, fresh, 0, lastPrompt());

  const removed = store.prune(now);
  assert.deepEqual(removed.conversations, 2);
  assert.equal(removed.files, 4, 'old: the copy, its generation and its subagent; quiet: its copy');
  assert.equal(lines.filter((l) => /retention/.test(l)).length, 1);
  assert.match(lines.at(-1), /pruned 2 conversations, 4 files/);
  const pdir = path.join(dir, 'bots', bot, 'main', PROJECT);
  assert.deepEqual(fs.readdirSync(pdir).sort(), [`${fresh.session}.jsonl`, `${recent.session}.jsonl`].sort());
  assert.deepEqual(store.conversations(bot).conversations.map((c) => c.cid).sort(), [fresh.session, recent.session].sort());
  assert.equal(store.pathOf(bot, old.session), null);

  // And it holds across a reload: the index no longer lists them.
  store.flush();
  assert.equal(open(dir).store.conversations(bot).conversations.length, 2);

  // Directories emptied by a prune go with it.
  store.prune(now + 200 * DAY);
  assert.ok(!fs.existsSync(path.join(dir, 'bots', bot, 'main')));
});

/* ----------------------------------------------------------- liveness, events --- */

test('hello: 200, a second instance within 90 s is 409 {since}, another protocol 426', (t) => {
  const { store, bot, clock } = withBot(t);
  const t0 = clock.t;
  const hi = (instance, v = 1) => store.hello(bot, { v, instance, helperVersion: '0.4.0', host: 'alpha-host', roots: [{ label: 'main', path: '/srv/alpha' }], files: 3 });
  assert.deepEqual(hi('one'), { status: 200, body: { ok: true } });
  clock.t += 30_000;
  assert.deepEqual(hi('one'), { status: 200, body: { ok: true } });
  assert.deepEqual(hi('two'), { status: 409, body: { since: new Date(t0).toISOString() } });
  assert.deepEqual(hi('one', 2), { status: 426, body: { supported: [1] } });
  assert.equal(store.hello(bot, { v: 1 }).status, 400);
  assert.equal(store.hello(bot, 'nope').status, 400);
  const d = store.describe()[0];
  assert.deepEqual(d.helper, {
    online: true, lastSeen: t0 + 30_000, since: t0, instance: 'one', helperVersion: '0.4.0', host: 'alpha-host',
    roots: [{ label: 'main', path: '/srv/alpha' }], files: 3, claudeVersions: [],
  });
  assert.equal(d.lastRefusal.status, 400);

  // After 90 s of silence a new instance takes over, and its own run starts the clock.
  clock.t += HELLO_WINDOW_MS;
  assert.deepEqual(hi('two'), { status: 200, body: { ok: true } });
  assert.equal(store.describe()[0].helper.since, clock.t);
  assert.ok(!('instance' in store.list()[0].helper), 'the roster row carries online and lastSeen only');
});

test('liveness has no event: helper.online flips false 90 s after the last hello, on the 15 s timer', (t) => {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.UTC(2026, 9, 12, 12) });
  t.after(() => mock.timers.reset());
  const dir = scratch(t);
  const store = new BotStore({ dir, log: () => {} });
  t.after(() => store.stop());
  store.register('alpha-bot');
  const changes = [];
  store.on('change', (e) => changes.push([e.bot, Date.now()]));
  const t0 = Date.now();
  store.hello('alpha-bot', { v: 1, instance: 'one' });
  assert.equal(store.list()[0].helper.online, true);
  assert.equal(changes.length, 1);

  mock.timers.tick(HELLO_WINDOW_MS - 1);
  assert.equal(store.list()[0].helper.online, true);
  mock.timers.tick(LIVENESS_TICK_MS);
  assert.equal(store.list()[0].helper.online, false);
  assert.equal(changes.length, 2, 'the flip is broadcast');
  assert.ok(changes[1][1] - t0 <= HELLO_WINDOW_MS + LIVENESS_TICK_MS);

  store.hello('alpha-bot', { v: 1, instance: 'one' });
  assert.equal(store.list()[0].helper.online, true);
  mock.timers.tick(CHANGE_MIN_MS); // within a second of the flip, so it trails by the floor
  assert.equal(changes.length, 3);
});

test('change: at most once a second per bot, and only when something displayed moved', (t) => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 9, 12, 12) });
  t.after(() => mock.timers.reset());
  const dir = scratch(t);
  const store = new BotStore({ dir, timers: false, log: () => {} });
  t.after(() => store.stop());
  store.register('alpha-bot');
  store.register('beta-bot');
  const changes = [];
  store.on('change', (e) => changes.push(e.bot));
  changes.length = 0;

  const c = ids();
  let size = append(store, 'alpha-bot', c, 0, user('one', 0)).body.size;
  assert.deepEqual(changes, ['alpha-bot'], 'a new conversation is shown at once');
  size = append(store, 'alpha-bot', c, size, reply('two', 1)).body.size;
  size = append(store, 'alpha-bot', c, size, reply('three', 2)).body.size;
  assert.deepEqual(changes, ['alpha-bot'], 'held to the floor');
  append(store, 'beta-bot', ids(), 0, user('b', 0));
  assert.deepEqual(changes, ['alpha-bot', 'beta-bot'], 'the floor is per bot');
  mock.timers.tick(CHANGE_MIN_MS);
  assert.deepEqual(changes, ['alpha-bot', 'beta-bot', 'alpha-bot'], 'one trailing change for the held ones');

  // Bytes that move nothing a reader sees: a subagent's file, a line with no timestamp that
  // changes no field, a hello from a helper already online.
  mock.timers.tick(5 * CHANGE_MIN_MS);
  store.hello('alpha-bot', { v: 1, instance: 'one' });
  const before = changes.length;
  append(store, 'alpha-bot', { ...c, agent: 'agent-a1' }, 0, reply('sub', 3));
  size = append(store, 'alpha-bot', c, size, line({ type: 'queue-operation' })).body.size;
  mock.timers.tick(CHANGE_MIN_MS);
  store.hello('alpha-bot', { v: 1, instance: 'one' });
  mock.timers.tick(5 * CHANGE_MIN_MS);
  assert.equal(changes.length, before, changes.join(' '));
  append(store, 'alpha-bot', c, size, costState());
  assert.equal(changes.length, before + 1, 'finished is displayed');
});

test('the constructor prunes at boot when its timers run; the CLI\'s registry-only store touches no copy', (t) => {
  const dir = scratch(t);
  const { store, bot } = (() => { const s = open(dir, { now: Date.now() }); s.store.register('alpha-bot'); return { ...s, bot: 'alpha-bot' }; })();
  const old = ids();
  append(store, bot, old, 0, line({ type: 'user', timestamp: new Date(Date.now() - 200 * DAY).toISOString(), message: { role: 'user', content: 'old' } }));
  store.flush();
  const indexFile = path.join(dir, 'bots', bot, 'index.json');
  const indexBefore = fs.readFileSync(indexFile, 'utf8');

  const cli = new BotStore({ dir, copies: false, log: () => {} });
  cli.register('beta-bot');
  cli.stop();
  assert.equal(fs.readFileSync(indexFile, 'utf8'), indexBefore);
  assert.ok(fs.existsSync(copyPath(dir, bot, old)));

  const lines = [];
  const booted = new BotStore({ dir, log: (l) => lines.push(l) });
  booted.stop();
  assert.ok(!fs.existsSync(copyPath(dir, bot, old)));
  assert.match(lines.join('\n'), /pruned 1 conversation, 1 file/);
});

test('with timers off, construction prunes nothing and says nothing; start() prunes once, and only once', (t) => {
  const dir = scratch(t);
  const s = open(dir, { now: Date.now() });
  s.store.register('alpha-bot');
  const old = ids();
  append(s.store, 'alpha-bot', old, 0, line({ type: 'user', timestamp: new Date(Date.now() - 200 * DAY).toISOString(), message: { role: 'user', content: 'old' } }));
  s.store.flush();
  const indexFile = path.join(dir, 'bots', 'alpha-bot', 'index.json');
  const indexBefore = fs.readFileSync(indexFile, 'utf8');

  // What the panel constructs before its stand-down probe: nothing on disk moves, nothing
  // is said — the copy and its index are exactly as they were.
  const lines = [];
  const panel = new BotStore({ dir, timers: false, log: (l) => lines.push(l) });
  assert.ok(fs.existsSync(copyPath(dir, 'alpha-bot', old)));
  assert.equal(fs.readFileSync(indexFile, 'utf8'), indexBefore);
  assert.deepEqual(lines, []);

  // …and what it does once the probe has passed.
  panel.start();
  panel.start();
  panel.stop();
  assert.ok(!fs.existsSync(copyPath(dir, 'alpha-bot', old)));
  assert.equal(lines.filter((l) => /retention/.test(l)).length, 1, 'a second start() is not a second boot');
  assert.match(lines.join('\n'), /pruned 1 conversation, 1 file/);

  // A registry-only store has no copies to prune and no timers to start.
  const cliLines = [];
  const cli = new BotStore({ dir, copies: false, log: (l) => cliLines.push(l) });
  cli.start();
  cli.stop();
  assert.deepEqual(cliLines, []);
});
