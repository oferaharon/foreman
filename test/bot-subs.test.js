import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/*
 * `BotSubs` — the bot pane's socket side — against a real `BotStore` on a temp dir and the
 * real `Tailer`, with a socket that only records what it was sent. Data goes into the store
 * the way the ingest route will put it there, by calling `store.append(...)`; nothing here
 * speaks HTTP. `test/bots-api.test.js` is the same feature against a whole scratch panel.
 *
 * Every record is synthetic, and no path names a real folder.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-botsubs-state-'));

const { BotStore } = await import('../server/bots.js');
const { BotSubs } = await import('../server/bot-subs.js');
const { BACKFILL_BYTES } = await import('../server/config.js');

test.after(() => fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true }));

const PROJECT = '-workspace-alpha';
/** Longer than the tailer's 1.5 s poll floor, so "nothing arrived" means nothing will. */
const QUIET_MS = 2_200;

const ts = (min) => new Date(Date.UTC(2026, 9, 12, 10, min, 0)).toISOString();
const line = (r) => `${JSON.stringify(r)}\n`;
const user = (text, min) => line({ type: 'user', uuid: randomUUID(), timestamp: ts(min), message: { role: 'user', content: text } });
const reply = (text, min) => line({
  type: 'assistant', uuid: randomUUID(), timestamp: ts(min),
  message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 100, output_tokens: 3 } },
});

function bench(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-botsubs-'));
  const store = new BotStore({ dir, timers: false, log: () => {} });
  const subs = new BotSubs({ store, send: (ws, type, data) => ws.frames.push({ type, ...data }) });
  const sockets = [];
  t.after(() => {
    for (const ws of sockets) subs.unsubscribe(ws);
    store.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const socket = () => {
    const ws = { frames: [] };
    sockets.push(ws);
    return ws;
  };
  store.register('alpha-bot');
  const sizes = new Map();
  /** Append to a conversation at its current size; `reset` starts its copy again. */
  const put = (cid, text, { reset = false } = {}) => {
    const at = reset ? 0 : sizes.get(cid) ?? 0;
    const r = store.append('alpha-bot', { root: 'main', project: PROJECT, session: cid, agent: null }, at, Buffer.from(text), { reset });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    sizes.set(cid, r.body.size);
  };
  return { dir, store, subs, socket, put };
}

/** Wait for a frame matching `pred` among those after index `from`; the frame, or a throw. */
async function frame(ws, pred, { from = 0, ms = 5_000 } = {}) {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = ws.frames.slice(from).find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`no such frame; got ${JSON.stringify(ws.frames.slice(from).map((f) => f.type))}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const quiet = () => new Promise((r) => setTimeout(r, QUIET_MS));
const texts = (messages) => messages.map((m) => m.text);

test('cid: null opens the newest conversation, and the frame carries exactly the agreed fields', async (t) => {
  const { store, subs, socket, put } = bench(t);
  const older = randomUUID();
  const newer = randomUUID();
  put(older, user('older prompt', 1) + reply('older answer', 2));
  put(newer, user('newer prompt', 5) + reply('newer answer', 6));

  const ws = socket();
  await subs.subscribe(ws, { botId: 'alpha-bot', cid: null, slot: 'a' });
  const f = ws.frames.at(-1);
  assert.deepEqual(Object.keys(f).sort(), ['bot', 'botId', 'cid', 'conversations', 'hasEarlier', 'messages', 'next', 'slot', 'type']);
  assert.equal(f.type, 'bot');
  assert.equal(f.botId, 'alpha-bot');
  assert.equal(f.slot, 'a');
  assert.equal(f.cid, newer);
  assert.deepEqual(texts(f.messages), ['newer prompt', 'newer answer']);
  assert.equal(f.hasEarlier, false);
  assert.deepEqual(f.bot, store.list().find((r) => r.id === 'alpha-bot'), 'the roster row, as the roster frame carries it');
  const page = store.conversations('alpha-bot');
  assert.deepEqual(f.conversations, page.conversations);
  assert.deepEqual(f.conversations.map((c) => c.cid), [newer, older]);
  assert.equal(f.next, null);
  assert.equal(subs.holds(ws, 'a'), true);
});

test('an explicit cid opens that one; a cid the bot does not hold, or a bot that is not registered, opens nothing', async (t) => {
  const { subs, socket, put } = bench(t);
  const older = randomUUID();
  const newer = randomUUID();
  put(older, user('older prompt', 1));
  put(newer, user('newer prompt', 5));

  const ws = socket();
  await subs.subscribe(ws, { botId: 'alpha-bot', cid: older, slot: 'a' });
  assert.equal(ws.frames.at(-1).cid, older);
  assert.deepEqual(texts(ws.frames.at(-1).messages), ['older prompt']);

  await subs.subscribe(ws, { botId: 'alpha-bot', cid: randomUUID(), slot: 'b' });
  let f = ws.frames.at(-1);
  assert.equal(f.slot, 'b');
  assert.equal(f.cid, null, 'never another conversation in its place');
  assert.deepEqual(f.messages, []);
  assert.equal(f.conversations.length, 2, 'the list is still there to pick from');

  // Not selected is not "follow the newest": a new conversation does not move this pane.
  const n = ws.frames.length;
  put(randomUUID(), user('newest prompt', 9));
  await quiet();
  assert.ok(!ws.frames.slice(n).some((x) => x.slot === 'b' && x.type === 'bot'), 'a pane that asked for one conversation is not handed another');

  await subs.subscribe(ws, { botId: 'beta-bot', cid: null, slot: 'c' });
  f = ws.frames.at(-1);
  assert.deepEqual({ ...f, conversations: f.conversations.length }, {
    type: 'bot', botId: 'beta-bot', bot: null, conversations: 0, next: null, cid: null, messages: [], hasEarlier: false, slot: 'c',
  });
});

test('growth arrives as bot-messages, stamped with its slot, and only in the slot showing that conversation', async (t) => {
  const { subs, socket, put } = bench(t);
  const one = randomUUID();
  const two = randomUUID();
  put(one, user('first prompt', 1));
  put(two, user('second prompt', 2));
  const ws = socket();
  await subs.subscribe(ws, { botId: 'alpha-bot', cid: one, slot: 'a' });
  await subs.subscribe(ws, { botId: 'alpha-bot', cid: two, slot: 'b' });

  const n = ws.frames.length;
  put(one, reply('first answer', 3));
  const f = await frame(ws, (x) => x.type === 'bot-messages', { from: n });
  assert.deepEqual(f, { type: 'bot-messages', botId: 'alpha-bot', cid: one, messages: f.messages, slot: 'a' });
  assert.deepEqual(texts(f.messages), ['first answer']);
  await quiet();
  assert.equal(ws.frames.slice(n).filter((x) => x.type === 'bot-messages').length, 1, 'once, and never into slot b');
});

test('a reset re-sends the whole frame from the new copy, and the old tailer appends nothing to what was shown', async (t) => {
  const { subs, socket, put } = bench(t);
  const cid = randomUUID();
  const other = randomUUID();
  put(cid, user('the original first prompt, long enough to be longer than its replacement', 1) + reply('original answer', 2));
  put(other, user('another conversation', 3));
  const ws = socket();
  await subs.subscribe(ws, { botId: 'alpha-bot', cid, slot: 'a' });
  await subs.subscribe(ws, { botId: 'alpha-bot', cid: other, slot: 'b' });
  assert.deepEqual(texts(ws.frames.at(-2).messages), ['the original first prompt, long enough to be longer than its replacement', 'original answer']);

  const n = ws.frames.length;
  put(cid, user('replacement', 5), { reset: true });
  const f = await frame(ws, (x) => x.type === 'bot' && x.slot === 'a', { from: n });
  assert.equal(f.cid, cid);
  assert.deepEqual(texts(f.messages), ['replacement'], 'the new generation alone, never the old one plus the new');

  await quiet();
  const after = ws.frames.slice(n);
  assert.ok(!after.some((x) => x.type === 'bot-messages'), `a Tailer that rewound would have appended: ${JSON.stringify(after)}`);
  assert.ok(!after.some((x) => x.slot === 'b' && x.type === 'bot'), 'another conversation\'s reset leaves this slot alone');

  // And the slot still follows its conversation afterwards, on the fresh tailer.
  const m = ws.frames.length;
  put(cid, reply('answer to the replacement', 6));
  const g = await frame(ws, (x) => x.type === 'bot-messages' && x.slot === 'a', { from: m });
  assert.deepEqual(texts(g.messages), ['answer to the replacement']);
});

test('a change sends the conversation list; an empty pane opens the first conversation when it lands, a full one stays put', async (t) => {
  const { store, subs, socket, put } = bench(t);
  const ws = socket();
  await subs.subscribe(ws, { botId: 'alpha-bot', cid: null, slot: 'a' });
  assert.equal(ws.frames.at(-1).cid, null, 'a bot with no conversations opens empty');

  let n = ws.frames.length;
  const first = randomUUID();
  put(first, user('the first conversation', 1));
  let f = await frame(ws, (x) => x.type === 'bot' && x.slot === 'a', { from: n });
  assert.equal(f.cid, first);
  assert.deepEqual(texts(f.messages), ['the first conversation']);

  n = ws.frames.length;
  const second = randomUUID();
  // The store emits `change` at most once a second per bot.
  await new Promise((r) => setTimeout(r, 1_100));
  put(second, user('a newer conversation', 4));
  f = await frame(ws, (x) => x.type === 'bot-conversations', { from: n });
  assert.deepEqual(Object.keys(f).sort(), ['bot', 'botId', 'conversations', 'next', 'slot', 'type']);
  assert.deepEqual(f.conversations.map((c) => c.cid), [second, first]);
  assert.deepEqual(f.bot, store.list()[0]);
  await quiet();
  assert.ok(!ws.frames.slice(n).some((x) => x.type === 'bot'), 'a pane showing a conversation is not moved to a newer one');
});

test('bot-load-earlier walks this slot back, and answers nothing for a slot that shows no bot', async (t) => {
  const { subs, socket, put } = bench(t);
  const cid = randomUUID();
  const pad = 'x'.repeat(4_000);
  let text = user('EARLIEST prompt', 0);
  for (let i = 1; Buffer.byteLength(text) < BACKFILL_BYTES + 64 * 1024; i++) text += reply(`answer ${i} ${pad}`, i % 50);
  text += user('LATEST prompt', 55);
  put(cid, text);

  const ws = socket();
  await subs.subscribe(ws, { botId: 'alpha-bot', cid, slot: 'a' });
  const opened = ws.frames.at(-1);
  assert.equal(opened.hasEarlier, true);
  assert.equal(texts(opened.messages).at(-1), 'LATEST prompt');
  assert.ok(!texts(opened.messages).includes('EARLIEST prompt'));

  let n = ws.frames.length;
  await subs.loadEarlier(ws, 'b');
  assert.equal(ws.frames.length, n, 'no bot in slot b, so nothing at all');

  await subs.loadEarlier(ws, 'a');
  const f = ws.frames.at(-1);
  assert.deepEqual(Object.keys(f).sort(), ['botId', 'cid', 'hasEarlier', 'messages', 'slot', 'type']);
  assert.equal(f.type, 'bot-earlier');
  assert.equal(f.cid, cid);
  assert.equal(f.hasEarlier, false);
  assert.equal(texts(f.messages)[0], 'EARLIEST prompt');

  subs.unsubscribe(ws, 'a');
  n = ws.frames.length;
  await subs.loadEarlier(ws, 'a');
  assert.equal(ws.frames.length, n);
});

test('unsubscribe stops the tailer, one slot or every slot, and a re-subscribe never leaves two tailers', async (t) => {
  const { subs, socket, put } = bench(t);
  const cid = randomUUID();
  put(cid, user('a prompt', 1));
  const ws = socket();

  // Two subscribes into one slot without waiting: the second must supersede the first.
  await Promise.all([
    subs.subscribe(ws, { botId: 'alpha-bot', cid, slot: 'a' }),
    subs.subscribe(ws, { botId: 'alpha-bot', cid, slot: 'a' }),
  ]);
  await subs.subscribe(ws, { botId: 'alpha-bot', cid, slot: 'b' });
  let n = ws.frames.length;
  put(cid, reply('one answer', 2));
  await frame(ws, (x) => x.type === 'bot-messages' && x.slot === 'b', { from: n });
  await quiet();
  assert.equal(ws.frames.slice(n).filter((x) => x.type === 'bot-messages' && x.slot === 'a').length, 1, 'drawn once, not twice');

  subs.unsubscribe(ws, 'a');
  assert.equal(subs.holds(ws, 'a'), false);
  assert.equal(subs.holds(ws, 'b'), true);
  n = ws.frames.length;
  put(cid, reply('two answer', 3));
  await frame(ws, (x) => x.type === 'bot-messages' && x.slot === 'b', { from: n });
  await quiet();
  assert.ok(!ws.frames.slice(n).some((x) => x.slot === 'a'));

  subs.unsubscribe(ws);
  assert.equal(subs.holds(ws, 'b'), false);
  n = ws.frames.length;
  put(cid, reply('three answer', 4));
  await quiet();
  assert.equal(ws.frames.length, n, 'a socket that went sends nothing more');
});
