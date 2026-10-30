import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HibernateStore } from '../server/hibernate.js';
import { Hibernator, PASS_EVERY_MS, SLEEP_EXIT_TIMEOUT_MS, pidTree, pinAfterOf, wakePinOrder } from '../server/hibernate-loop.js';
import { EXPOSURE_KEYS, WRITABLE_KEYS, resolveHibernateAfter, validateConfigPatch } from '../server/settings-file.js';
import { SESSION_PREFIX } from '../server/config.js';

/*
 * The sleep loop, against a fake bench and an **injected clock** — never a knob that makes
 * the real panel sleep faster. The store is the real `HibernateStore` on a throwaway file,
 * and every transcript the cron witness reads is a real file on disk, because the witness is
 * its own incremental reader and a stub would prove nothing about it. What is faked is tmux:
 * the roster, the pane reads, `sendText`, `liveSessionNames`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const P = SESSION_PREFIX;
const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-29T12:00:00Z');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-hib-loop-'));

/** A transcript with one ordinary exchange, or the lines given. */
function transcript(dir, id, lines = null) {
  const file = path.join(dir, `${id}.jsonl`);
  const body = lines || [
    { type: 'user', timestamp: new Date(T0 - 3 * HOUR).toISOString(), message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: new Date(T0 - 3 * HOUR).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ];
  fs.writeFileSync(file, body.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

let seq = 0;
const uuid = () => `507be0d1-ab7e-4037-82f2-${String((seq += 1)).padStart(12, '0')}`;

/** A roster row that may sleep under a 30 min setting once the clock is past boot + 30 min. */
function row(dir, over = {}) {
  const id = over.id || uuid();
  const label = over.label || 'main';
  return {
    id,
    transcriptPath: transcript(dir, id),
    paneId: over.paneId || `%${seq}`,
    tmuxSession: `${P}alpha-${label}`,
    paneCwd: path.join(dir, 'alpha'),
    title: `alpha-${label}`,
    label: `alpha-${label}`,
    project: 'alpha',
    team: null,
    status: 'idle',
    prompt: null,
    plan: null,
    question: null,
    dialog: null,
    queued: [],
    background: { agents: 0, shells: 0, monitors: 0 },
    unread: 0,
    needsYou: false,
    bypass: false,
    attached: false,
    pinned: false,
    lastActivity: T0 - 3 * HOUR,
    model: 'Opus 5.5',
    ...over,
  };
}

/**
 * The fake bench. `sessions` is the roster; `live` the names tmux holds; `exits` every
 * `sendText`, with whether the record was already on disk when it was sent.
 */
function bench({ rows = [], setting = '30m', storeFile, now = T0 } = {}) {
  const b = {
    now,
    sessions: rows,
    live: new Set(rows.map((r) => r.tmuxSession)),
    exits: [],
    keys: [],
    lines: [],
    slept: [],
    setting,
    busy: false,
    watched: new Set(),
    paneState: new Map(), // paneId -> what readPaneState answers
    afterExit: new Map(), // paneId -> 'close' | 'box' | 'stay'
    composer: new Map(), // paneId -> true | false | null
    pinned: [],
  };
  b.store = new HibernateStore(storeFile, { flushMs: 60_000 });
  b.hib = new Hibernator({
    store: b.store,
    now: () => b.now,
    deps: {
      sessions: () => b.sessions,
      refresh: async () => {},
      listPanes: async () => b.sessions.map((r, i) => ({ paneId: r.paneId, tmuxSession: r.tmuxSession, pid: 5000 + i, createdMs: T0 - 4 * HOUR })),
      processTable: async () => b.sessions.map((_, i) => `${5000 + i} 1\n${6000 + i} ${5000 + i}`).join('\n'),
      readLock: () => null,
      readPaneState: async (paneId) => b.paneState.get(paneId) || { state: 'idle' },
      composerEmpty: async (paneId) => (b.composer.has(paneId) ? b.composer.get(paneId) : true),
      sendText: async (paneId, text) => {
        const r = b.sessions.find((s) => s.paneId === paneId);
        const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        b.exits.push({ paneId, text, recorded: Boolean(r && onDisk.asleep?.[r.tmuxSession]) });
        const after = b.afterExit.get(paneId) || 'close';
        if (after === 'refuse') throw new Error('This session is waiting on a permission prompt — answer that first.');
        if (after === 'close') {
          b.live.delete(r.tmuxSession);
          b.sessions = b.sessions.filter((s) => s !== r);
        }
        if (after === 'box') {
          b.paneState.set(paneId, { state: 'needs-decision', prompt: { title: 'The following will stop when you exit' } });
        }
      },
      sendKeys: async (paneId, ...keys) => {
        b.keys.push({ paneId, keys });
      },
      liveSessionNames: async () => [...b.live],
      setting: () => b.setting,
      busy: () => b.busy,
      watched: () => b.watched,
      pinnedNames: async () => b.pinned,
      log: (line) => b.lines.push(line),
      onSlept: (rec) => b.slept.push(rec),
      sleep: async (ms) => {
        b.now += ms;
      },
    },
  });
  b.hib.start();
  return b;
}

const later = (b, ms) => {
  b.now += ms;
};

/* ------------------------------------------------------------------- the setting --- */

test('hibernateAfter is writable, validated against the one list, and is not an exposure key', () => {
  assert.ok(WRITABLE_KEYS.includes('hibernateAfter'));
  assert.ok(!EXPOSURE_KEYS.includes('hibernateAfter'), 'it changes nothing about who can reach the panel');
  assert.deepEqual(validateConfigPatch({ hibernateAfter: '4h' }), { ok: true, patch: { hibernateAfter: '4h' } });
  for (const bad of ['2h', '', 30, null, 'OFF']) {
    const out = validateConfigPatch({ hibernateAfter: bad });
    assert.equal(out.ok, false, String(bad));
    assert.match(out.error, /off, 30m, 1h, 4h, 12h/);
  }
  // Absent or unknown is off, never the shortest wait.
  assert.equal(resolveHibernateAfter({ config: {} }), 'off');
  assert.equal(resolveHibernateAfter({ config: { hibernateAfter: 'soon' } }), 'off');
  assert.equal(resolveHibernateAfter({ config: { hibernateAfter: '12h' } }), '12h');
});

/* ---------------------------------------------------------------------- the loop --- */

test('off: a pass does nothing at all', async () => {
  const dir = tmp();
  const b = bench({ rows: [row(dir)], setting: 'off', storeFile: path.join(dir, 'h.json') });
  later(b, 2 * HOUR);
  assert.deepEqual(await b.hib.pass(), { slept: null, why: 'off' });
  assert.equal(b.exits.length, 0);
});

test('an eligible idle session sleeps — the record on disk before the /exit, and kept after', async () => {
  const dir = tmp();
  const file = path.join(dir, 'h.json');
  const r = row(dir, { pinned: true });
  const b = bench({ rows: [r], storeFile: file });
  b.pinned = [`${P}beta-main`, null, r.tmuxSession];
  later(b, 31 * MIN);
  const out = await b.hib.pass();
  assert.ok(out.slept, out.why);
  assert.deepEqual(b.exits.map((e) => [e.paneId, e.text, e.recorded]), [[r.paneId, '/exit', true]]);
  const rec = b.store.get(r.tmuxSession);
  assert.equal(rec.sessionId, r.id);
  assert.equal(rec.folder, r.paneCwd);
  assert.equal(rec.pinned, true);
  assert.equal(rec.pinAfter, `${P}beta-main`, 'the nearest named pin above it');
  assert.equal(b.slept.length, 1);
  b.store.stop();
});

test('not before its time: the idle clock starts at boot, so a restart restarts it', async () => {
  const dir = tmp();
  const b = bench({ rows: [row(dir)], storeFile: path.join(dir, 'h.json') });
  later(b, 29 * MIN);
  const out = await b.hib.pass();
  assert.equal(out.slept, null);
  assert.equal(b.exits.length, 0);
  later(b, 2 * MIN);
  assert.ok((await b.hib.pass()).slept);
});

test('at most one sleep per pass, and the longest idle goes first', async () => {
  const dir = tmp();
  const newer = row(dir, { label: 'newer' });
  const older = row(dir, { label: 'older' });
  const b = bench({ rows: [newer, older], storeFile: path.join(dir, 'h.json') });
  // The older one was busy less recently than the newer one, as far as the clock knows.
  later(b, 5 * MIN);
  b.hib.clock.note([{ ...newer, status: 'working' }], b.now);
  later(b, 40 * MIN);
  const out = await b.hib.pass();
  assert.equal(out.slept?.name, older.tmuxSession);
  assert.equal(b.exits.length, 1, 'one /exit per pass');
  assert.ok((await b.hib.pass()).slept, 'the next pass takes the next one');
  assert.equal(b.exits.length, 2);
});

test('a tick runs a pass at most once a minute, and none before start()', async () => {
  const dir = tmp();
  const b = bench({ rows: [row(dir), row(dir, { label: 'two' })], storeFile: path.join(dir, 'h.json') });
  b.hib.started = false;
  later(b, HOUR);
  assert.equal(b.hib.tick(), null, 'not started: the single-instance probe has not answered');
  b.hib.start();
  const at = b.now;
  await b.hib.tick();
  assert.equal(b.exits.length, 1);
  // The throttle counts from when the pass began, not from when its /exit finished waiting.
  b.now = at + PASS_EVERY_MS - 1;
  assert.equal(b.hib.tick(), null);
  later(b, 1);
  await b.hib.tick();
  assert.equal(b.exits.length, 2);
});

test('skipped whole while a relaunch, restore or wake runs', async () => {
  const dir = tmp();
  const b = bench({ rows: [row(dir)], storeFile: path.join(dir, 'h.json') });
  b.busy = true;
  later(b, HOUR);
  assert.deepEqual(await b.hib.pass(), { slept: null, why: 'busy' });
  assert.equal(b.exits.length, 0);
});

test('a relaunch that starts while the pane is being re-read wins, and nothing is exited', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  later(b, HOUR);
  const read = b.hib.deps.readPaneState;
  b.hib.deps.readPaneState = async (id) => {
    b.busy = true;
    return read(id);
  };
  assert.equal((await b.hib.pass()).slept, null);
  assert.equal(b.exits.length, 0);
  assert.equal(b.store.has(r.tmuxSession), false);
  assert.equal(b.hib.sleeping, false, 'the flag the endpoints refuse on is down again');
});

test('the pane is re-read before the /exit: a turn that started since the roster poll wins', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  b.paneState.set(r.paneId, { state: 'needs-decision', prompt: { title: 'Bash command' } });
  later(b, HOUR);
  const out = await b.hib.pass();
  assert.equal(out.slept, null);
  assert.equal(b.exits.length, 0);
  assert.equal(b.store.has(r.tmuxSession), false, 'no record for a session that never slept');
});

test('something typed in the terminal keeps it awake — the composer is read before the /exit', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  b.composer.set(r.paneId, false);
  later(b, HOUR);
  assert.equal((await b.hib.pass()).slept, null);
  b.composer.set(r.paneId, null);
  assert.equal((await b.hib.pass()).slept, null, 'unreadable is not empty');
  assert.equal(b.exits.length, 0);
});

test('keep-awake, and open in a browser, both keep it awake', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  later(b, HOUR);
  b.store.setKeepAwake(r.tmuxSession, true);
  assert.equal((await b.hib.pass()).slept, null);
  b.store.setKeepAwake(r.tmuxSession, false);
  b.watched = new Set([r.id]);
  assert.equal((await b.hib.pass()).slept, null);
  b.watched = new Set();
  assert.ok((await b.hib.pass()).slept);
});

test('never a lead with a live worker', async () => {
  const dir = tmp();
  const lead = row(dir, { label: 'lead', team: { role: 'lead', tasks: 1 } });
  const worker = row(dir, { label: 'w', team: { role: 'worker', repo: lead.paneCwd }, status: 'working' });
  const b = bench({ rows: [lead, worker], storeFile: path.join(dir, 'h.json') });
  later(b, HOUR);
  assert.equal((await b.hib.pass()).slept, null);
  assert.equal(b.exits.length, 0);
});

test('a /loop in the transcript keeps it awake — read by the witness off the real file', async () => {
  const dir = tmp();
  const id = uuid();
  const at = new Date(T0 - 4 * HOUR + MIN).toISOString();
  const r = row(dir, { id });
  transcript(dir, id, [
    { type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'CronCreate', input: { cron: '*/30 * * * *', prompt: 'x' } }] } },
    { type: 'user', timestamp: at, toolUseResult: { id: 'c0ffee01', humanSchedule: 'every 30 minutes', recurring: true, durable: false }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
  ]);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  later(b, HOUR);
  assert.equal((await b.hib.pass()).slept, null);
  const v = await b.hib.verdict(r);
  assert.equal(v.rule, 'cron');
});

test('a box after the /exit is escaped — never answered — and the session is left awake', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  b.afterExit.set(r.paneId, 'box');
  later(b, HOUR);
  const out = await b.hib.pass();
  assert.equal(out.slept, null);
  assert.equal(out.tried, true, 'it counts as this pass’s one attempt');
  assert.deepEqual(b.keys, [{ paneId: r.paneId, keys: ['Escape'] }], 'Escape, and nothing else — never 1 or 2');
  assert.equal(b.store.has(r.tmuxSession), false, 'the record is deleted');
  assert.match(b.lines.join('\n'), /left awake/);
  // And it did not wait the name out: one poll, not twenty seconds.
  assert.ok(b.now - T0 - HOUR < SLEEP_EXIT_TIMEOUT_MS);
});

test('a name that never frees: the record is deleted after the timeout and the session stays', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  b.afterExit.set(r.paneId, 'stay');
  later(b, HOUR);
  const before = b.now;
  const out = await b.hib.pass();
  assert.equal(out.slept, null);
  assert.ok(b.now - before >= SLEEP_EXIT_TIMEOUT_MS);
  assert.equal(b.store.has(r.tmuxSession), false);
  assert.equal(b.keys.length, 0, 'no box, so nothing pressed');
});

test('a refused /exit deletes the record', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  b.afterExit.set(r.paneId, 'refuse');
  later(b, HOUR);
  assert.equal((await b.hib.pass()).slept, null);
  assert.equal(b.store.has(r.tmuxSession), false);
});

test('a woken session is not put straight back to sleep', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  later(b, HOUR);
  // Measured: a resume moves neither `lastActivity` nor anything else the roster reads — so
  // only the wake time stands between it and the next pass.
  b.hib.woke(r.tmuxSession);
  assert.equal((await b.hib.pass()).slept, null);
  assert.match((await b.hib.verdict(r)).why, /idle 0 min of 30 min/);
  later(b, 31 * MIN);
  assert.ok((await b.hib.pass()).slept);
});

test('a sleeper is never a candidate again while it sleeps', async () => {
  const dir = tmp();
  const r = row(dir);
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  b.afterExit.set(r.paneId, 'stay');
  b.store.put({ name: r.tmuxSession, folder: r.paneCwd, sessionId: r.id });
  later(b, HOUR);
  assert.equal((await b.hib.pass()).slept, null);
  assert.equal(b.exits.length, 0);
});

test('the verdict for the tooltip says why, in words', async () => {
  const dir = tmp();
  const r = row(dir, { background: { agents: 0, shells: 1, monitors: 0 } });
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  later(b, HOUR);
  assert.equal((await b.hib.verdict(r)).why, 'a background shell is running');
  b.setting = 'off';
  assert.equal((await b.hib.verdict(r)).why, 'hibernation is off');
});

test('the tooltip can ask past "open in a browser" — and a pass never can', async () => {
  // The header that asks is on screen, so `watched` is always true there; the reason behind
  // it is the one worth reading. The pass itself must still see the browser.
  const dir = tmp();
  const r = row(dir, { background: { agents: 0, shells: 1, monitors: 0 } });
  const b = bench({ rows: [r], storeFile: path.join(dir, 'h.json') });
  later(b, HOUR);
  b.watched = new Set([r.id]);
  assert.equal((await b.hib.verdict(r)).why, 'it is open in a browser');
  assert.equal((await b.hib.verdict(r, { besideWatched: true })).why, 'a background shell is running');
  const clean = row(dir, { id: '11111111-2222-4333-8444-555555555555', tmuxSession: r.tmuxSession });
  const c = bench({ rows: [clean], storeFile: path.join(dir, 'h2.json') });
  later(c, HOUR);
  c.watched = new Set([clean.id]);
  assert.equal((await c.hib.pass()).slept, null, 'a watched session is never put to sleep');
  // …and the same row, unwatched, would have been — so the refusal above is the browser's.
  c.watched = new Set();
  assert.ok((await c.hib.pass()).slept, 'unwatched, it sleeps');
});

/* ---------------------------------------------------------------------- the pure bits --- */

test('pidTree walks the pane process and everything under it', () => {
  const ps = '  1     0\n 100     1\n 200   100\n 201   100\n 300   200\n 999     1\n';
  assert.deepEqual(pidTree(ps, 100).sort((a, b) => a - b), [100, 200, 201, 300]);
  assert.deepEqual(pidTree(ps, 999), [999]);
  assert.equal(pidTree(ps, 0), null);
});

test('pinAfter is the nearest named pin above; a wake splices the name back under it', () => {
  assert.equal(pinAfterOf(['a', 'b', 'c'], 'a'), null);
  assert.equal(pinAfterOf(['a', null, 'c'], 'c'), 'a');
  assert.equal(pinAfterOf(['a'], 'z'), null);
  assert.deepEqual(wakePinOrder(['a', 'c'], { name: 'b', pinAfter: 'a' }), ['a', 'b', 'c']);
  assert.deepEqual(wakePinOrder(['a', 'c'], { name: 'b', pinAfter: null }), ['b', 'a', 'c']);
  assert.deepEqual(wakePinOrder(['a', 'c'], { name: 'b', pinAfter: 'gone' }), ['a', 'c', 'b']);
});

/* ------------------------------------------------------------------------ the source --- */

test('one function sends this feature’s /exit, and no route puts a session to sleep', () => {
  const loop = fs.readFileSync(path.join(root, 'server', 'hibernate-loop.js'), 'utf8');
  assert.equal(loop.match(/sendText\([^)]*'\/exit'\)/g)?.length, 1);
  const index = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const routes = [...index.matchAll(/app\.(get|post|put|patch|delete)\('([^']*asleep[^']*)'/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(routes.sort(), [
    'delete /api/asleep/:name',
    'get /api/asleep',
    'post /api/asleep/:name/wake',
    'post /api/asleep/keep-awake',
    // A room's `wake N asleep` — a wake, through `wakeSleeper`, never a sleep.
    'post /api/rooms/:id/wake-asleep',
  ]);
  assert.ok(!/hibernator\.hibernate\(/.test(index), 'index.js never calls hibernate() itself — only the loop does');
});

test('every createSession in index.js says which names are reserved, and a wake reserves none', () => {
  const src = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const missing = [];
  for (let i = src.indexOf('createSession('); i !== -1; i = src.indexOf('createSession(', i + 1)) {
    if (/[\w$.]/.test(src[i - 1] || '')) continue;
    let depth = 0;
    let end = i + 'createSession'.length;
    for (; end < src.length; end++) {
      if (src[end] === '(') depth++;
      else if (src[end] === ')' && --depth === 0) break;
    }
    const block = src.slice(i, end + 1);
    // A worker launches into its own worktree under a name a sleeper can never hold.
    if (block.includes("'--strict-mcp-config'") && block.includes('wBriefFile')) continue;
    if (!/\breserved\b/.test(block)) missing.push(src.slice(0, i).split('\n').length);
  }
  assert.deepEqual(missing, [], `createSession without reserved at server/index.js:${missing.join(', ')}`);
  assert.match(src, /startEntries\(\[entry\], \{[^}]*reserved: new Set\(\)/, 'the wake passes an empty set');
});
