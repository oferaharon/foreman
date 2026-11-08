import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { keepAwakeFace, keepAwakePress, keepAwakeResultText, roomKeepAwake } from '../web/rooms-pane.js';

/*
 * The keep-awake toggle in a group room's header: who a press reaches, which way it goes, how
 * the button reads, and what is said afterwards. The route it posts to is the session button's
 * own and is proven against a real scratch panel in `test/hibernate-api.test.js`.
 */

const member = (name, extra = {}) => ({ tmuxSession: `foreman-${name}`, name, paneId: null, ...extra });
const row = (name, extra = {}) => ({ id: `id-${name}`, tmuxSession: `foreman-${name}`, paneId: `%${name.length}`, status: 'idle', ...extra });
const sleeper = (name) => ({ name: `foreman-${name}` });
const held = (...names) => names.map((n) => `foreman-${n}`);

const room = { id: 'r1', name: 'bench', members: [member('alpha-main'), member('beta-main'), member('gamma-master')] };
const allLive = [row('alpha-main'), row('beta-main'), row('gamma-master')];

test('the state is all, some or off, counted over the members a press can reach', () => {
  assert.equal(roomKeepAwake(room, allLive, [], []).state, 'off');
  const some = roomKeepAwake(room, allLive, [], held('alpha-main', 'beta-main'));
  assert.equal(some.state, 'some');
  assert.equal(some.on, 2);
  assert.equal(some.total, 3);
  assert.equal(roomKeepAwake(room, allLive, [], held('alpha-main', 'beta-main', 'gamma-master')).state, 'all');
  assert.equal(roomKeepAwake(room, allLive, [], held('delta-lead')).state, 'off', 'a name outside the room counts for nothing');
});

test('a press turns all off only from all-on, and turns all on from anything else', () => {
  const press = (kept) => keepAwakePress(roomKeepAwake(room, allLive, [], kept));
  assert.equal(press([]), true);
  assert.equal(press(held('alpha-main')), true, 'a mixed room goes on, never off');
  assert.equal(press(held('alpha-main', 'beta-main', 'gamma-master')), false);
});

test('a sleeper is a target by its stored name, and is said to be asleep', () => {
  const facts = roomKeepAwake(room, [row('alpha-main'), row('beta-main')], [sleeper('gamma-master')], held('gamma-master'));
  assert.deepEqual(facts.targets.map((t) => [t.name, t.asleep, t.on]), [
    ['foreman-alpha-main', false, false],
    ['foreman-beta-main', false, false],
    ['foreman-gamma-master', true, true],
  ]);
  assert.deepEqual(facts.skipped, []);
});

test('a member with no live row and no sleep record is skipped, and does not stop the room reading all-on', () => {
  const facts = roomKeepAwake(room, [row('alpha-main'), row('beta-main')], [], held('alpha-main', 'beta-main'));
  assert.deepEqual(facts.targets.map((t) => t.name), ['foreman-alpha-main', 'foreman-beta-main']);
  assert.deepEqual(facts.skipped, ['gamma-master']);
  assert.equal(facts.state, 'all');
  assert.equal(keepAwakePress(facts), false, 'or a room with one member gone could never be turned off');
});

test('a stale flag on a gone member changes nothing, and it is never a target', () => {
  const facts = roomKeepAwake(room, [row('alpha-main'), row('beta-main')], [], held('gamma-master'));
  assert.equal(facts.state, 'off');
  assert.deepEqual(facts.skipped, ['gamma-master']);
});

test('nobody to reach is `none`, and malformed input reads the same rather than throwing', () => {
  assert.equal(roomKeepAwake(room, [], [], []).state, 'none');
  assert.equal(roomKeepAwake({ members: [] }).state, 'none');
  assert.equal(roomKeepAwake(null, null, null, null).state, 'none');
  assert.equal(roomKeepAwake({ members: 'x' }, 'x', 'x', 'x').state, 'none');
});

test('a live member is keyed by its row’s name, the one its own button sends', () => {
  // Resolved on the second rung: the stored tmux name is stale, the pane and the name agree.
  const moved = { tmuxSession: 'foreman-old-name', name: 'alpha-main', paneId: '%7' };
  const live = { id: 'x', tmuxSession: 'foreman-new-name', paneId: '%7', label: 'alpha-main', title: 'alpha-main', status: 'idle' };
  const facts = roomKeepAwake({ members: [moved] }, [live], [], ['foreman-new-name']);
  assert.deepEqual(facts.targets.map((t) => t.name), ['foreman-new-name']);
  assert.equal(facts.state, 'all');
});

test('a member held twice is one target, and a worker row is skipped as its own header would', () => {
  const twice = { members: [member('alpha-main'), member('alpha-main', { name: 'again' })] };
  assert.equal(roomKeepAwake(twice, [row('alpha-main')], [], []).total, 1);
  const worker = roomKeepAwake({ members: [member('alpha-main')] }, [row('alpha-main', { team: { role: 'worker' } })], [], []);
  assert.equal(worker.state, 'none');
  assert.deepEqual(worker.skipped, ['alpha-main']);
  const lead = roomKeepAwake({ members: [member('alpha-main')] }, [row('alpha-main', { team: { role: 'lead' } })], [], []);
  assert.equal(lead.total, 1);
});

test('the face: two words, a count only when mixed, and only all-on pressed', () => {
  const face = (kept) => keepAwakeFace(roomKeepAwake(room, allLive, [], kept));
  const off = face([]);
  assert.deepEqual([off.text, off.count, off.pressed, off.hidden], ['keep awake', '', 'false', false]);
  const some = face(held('alpha-main', 'gamma-master'));
  assert.deepEqual([some.text, some.count, some.pressed], ['kept awake 2/3', '2/3', 'mixed']);
  assert.match(some.title, /2 of 3 kept awake: alpha-main, gamma-master\. Click to keep all 3 members awake\./);
  const all = face(held('alpha-main', 'beta-main', 'gamma-master'));
  assert.deepEqual([all.text, all.count, all.pressed], ['kept awake', '', 'true']);
  assert.match(all.title, /Click to let them sleep/);
});

test('the face draws nothing with nobody to reach, and its hover says what a press will not do', () => {
  assert.equal(keepAwakeFace(roomKeepAwake(room, [], [], [])).hidden, true);
  assert.equal(keepAwakeFace(null).hidden, true);
  const withSleeper = keepAwakeFace(roomKeepAwake(room, [row('alpha-main')], [sleeper('beta-main')], []));
  assert.match(withSleeper.title, /wakes nobody/);
  assert.match(withSleeper.title, /gamma-master: no session to keep awake/);
  const one = keepAwakeFace(roomKeepAwake({ members: [member('alpha-main')] }, [row('alpha-main')], [], []));
  assert.match(one.title, /this room’s one member/);
  assert.equal(keepAwakeFace(roomKeepAwake({ members: [member('alpha-main')] }, [row('alpha-main')], [], held('alpha-main'))).text, 'kept awake');
});

test('a clean press says nothing; a skip is muted; a refusal is the server’s own sentence', () => {
  assert.equal(keepAwakeResultText([{ name: 'a', ok: true }], []), null);
  assert.equal(keepAwakeResultText(), null);
  assert.equal(keepAwakeResultText(null, null), null);
  assert.deepEqual(keepAwakeResultText([{ name: 'a', ok: true }], ['gamma-master', 'zeta-main']), {
    woke: null,
    skipped: 'skipped gamma-master, zeta-main — no session to keep awake',
    failed: [],
  });
  assert.deepEqual(
    keepAwakeResultText([
      { name: 'foreman-beta-main', ok: false, error: 'No session is running or asleep under foreman-beta-main.' },
      { name: 'foreman-eta-main', ok: false },
    ]),
    {
      woke: null,
      skipped: null,
      failed: ['No session is running or asleep under foreman-beta-main.', 'foreman-eta-main did not change.'],
    },
  );
});

/* ---------------------------------------------------------------- the pane's wiring --- */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const app = read('web', 'app.js');
const server = read('server', 'index.js');
// Prose out, so a negative check is not failed by the comment that records the rule.
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const fn = (name) => {
  const m = app.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(m, `\`${name}\` must exist`);
  return m[0];
};

test('a press reuses the session button’s route, and that route is still the only one', () => {
  const press = fn('pressGroupKeepAwake');
  assert.match(press, /postJSON\('\/api\/asleep\/keep-awake', \{ name, on \}\)/);
  assert.equal((code(server).match(/keep-awake'/g) || []).length, 1, 'no bulk route beside it');
  // The guard the route holds against a keep-awake for nobody.
  const route = server.slice(server.indexOf("app.post('/api/asleep/keep-awake'"));
  assert.match(route.slice(0, route.indexOf('\n});')), /if \(!known\) return res\.status\(404\)/);
});

test('it is a human press and nothing else: no tool, no timer, and it types into no pane', () => {
  const uses = code(app).match(/pressGroupKeepAwake/g) || [];
  assert.equal(uses.length, 2, 'the definition and the onclick');
  assert.match(code(app), /keepAwake\.onclick = pressGroupKeepAwake;/);
  assert.ok(!/keep-?awake/i.test(read('mcp', 'foreman.js')), 'on no session’s tool surface');
  const press = fn('pressGroupKeepAwake');
  assert.ok(!/\/wake|wakeSleeper|wakeGroupSleepers|sendText|\/send/.test(press), 'wakes nobody and types nothing');
});

test('the head paints it on the roster beat, from the frame, and an archived room draws none', () => {
  assert.match(fn('renderGroupHead'), /paintGroupKeepAwake\(\);/);
  const paint = fn('paintGroupKeepAwake');
  assert.match(paint, /roomKeepAwake\(room, state\.sessions, state\.asleep, state\.hibernation\.keepAwake\)/);
  assert.match(paint, /btn\.hidden = face\.hidden \|\| Boolean\(room\.archivedAt\);/);
  assert.match(fn('pressGroupKeepAwake'), /for \(const p of panes\) p\.renderHead\(\);/);
  // `.ghost-btn` is laid out by flex here, so `[hidden]` is spelled out as its neighbours' is.
  assert.match(read('web', 'styles.css'), /\.main-head\.is-group \.room-keep-awake\[hidden\] \{ display: none; \}/);
});

test('a narrow pane draws the compact face off the pane’s width, and is still named by the word', () => {
  assert.match(fn('paintGroupKeepAwake'), /btn\.setAttribute\('aria-label', face\.text\);/);
  const css = read('web', 'styles.css');
  assert.match(css, /\.main-head\.is-group \{ container: room-head \/ inline-size; \}/);
  const tier = css.slice(css.indexOf('@container room-head'));
  assert.match(tier, /\.room-keep-awake \.keep-word \{ display: none; \}/);
  assert.match(tier, /\.room-keep-awake\[aria-pressed='mixed'\] \.keep-mini svg \{ display: none; \}/);
});

test('nothing about it joins composerSig or the strip’s signature', () => {
  const composerSig = app.match(/const composerSig = [\s\S]*?\n  let lastComposerSig/)?.[0] || '';
  assert.ok(composerSig, '`composerSig` must exist');
  assert.ok(!/keep-?awake|hibernation/i.test(code(composerSig)));
  const strip = fn('renderGroupStrip');
  const sig = strip.slice(strip.indexOf('const sig = ['), strip.indexOf("].join('#')"));
  assert.ok(!/keep/i.test(sig), 'a press must not rebuild the strip and take an armed question away');
});

test('the phone is untouched', () => {
  for (const file of ['rooms.js', 'app.js', 'asleep.js']) {
    assert.ok(!/keep-?awake/i.test(code(read('web', 'm', file))), `${file} offers no keep-awake`);
  }
});
