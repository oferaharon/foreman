import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { asleepMembers, wakeLabel, wakeResultText } from '../web/rooms-pane.js';
import { roomStripFacts } from '../web/panel-fold.js';

/*
 * `wake N asleep` in a group room's pane: who the browser draws as asleep, when the button is
 * drawn at all, and how a run's answer reads. The press itself — serial, one failure stopping
 * nothing, a second press refused — is the server's, and is proven against a real scratch
 * panel in `test/room-wake-api.test.js`.
 */

const member = (name, extra = {}) => ({ tmuxSession: `foreman-${name}`, name, paneId: null, ...extra });
const row = (name, extra = {}) => ({ id: `id-${name}`, tmuxSession: `foreman-${name}`, paneId: `%${name.length}`, status: 'idle', ...extra });
const sleeper = (name) => ({ name: `foreman-${name}` });

const room = {
  id: 'r1',
  name: 'bench',
  members: [member('alpha-main'), member('beta-main'), member('gamma-master'), member('zeta-main')],
};

test('a member is asleep when it resolves to no row and its tmux name has a sleep record', () => {
  const sessions = [row('beta-main')];
  const asleep = [sleeper('alpha-main'), sleeper('gamma-master'), sleeper('delta-lead')];
  assert.deepEqual(asleepMembers(room, sessions, asleep), ['foreman-alpha-main', 'foreman-gamma-master'],
    'the room’s order; a sleeper outside the room is not counted; zeta (no row, no record) is gone, not asleep');
});

test('a live row wearing a sleeper’s name is waking, not asleep', () => {
  // The record leaves the frame a beat after the woken row joins it, or the other way round.
  const sessions = [row('alpha-main')];
  assert.deepEqual(asleepMembers(room, sessions, [sleeper('alpha-main')]), []);
});

test('a member counted once however the file came to hold it twice, and nothing without a name', () => {
  const twice = { members: [member('alpha-main'), member('alpha-main', { name: 'again' }), { name: 'no-tmux', paneId: '%9' }] };
  assert.deepEqual(asleepMembers(twice, [], [sleeper('alpha-main'), { name: 'no-tmux' }]), ['foreman-alpha-main']);
});

test('malformed input reads as nobody asleep rather than throwing', () => {
  assert.deepEqual(asleepMembers(null, null, null), []);
  assert.deepEqual(asleepMembers(room, [], undefined), []);
  assert.deepEqual(asleepMembers({ members: 'x' }, [], [sleeper('alpha-main')]), []);
});

test('the button is drawn only when at least one member is asleep, and says how many', () => {
  assert.equal(wakeLabel(0), null);
  assert.equal(wakeLabel(undefined), null);
  assert.equal(wakeLabel(-1), null);
  assert.equal(wakeLabel(1), 'wake 1 asleep');
  assert.equal(wakeLabel(2), 'wake 2 asleep');
  // While a run is in flight it does not count down under a disabled button.
  assert.equal(wakeLabel(2, true), 'waking…');
  assert.equal(wakeLabel(0, true), 'waking…');
});

test('a run reads per member: who woke, and each failure in the server’s own words', () => {
  const label = (n) => n.replace(/^foreman-/, '');
  const out = wakeResultText(
    [
      { name: 'foreman-alpha-main', state: 'woken' },
      { name: 'foreman-delta-lead', state: 'failed', error: 'foreman-delta-lead did not wake: Not a git repository. It is still asleep — try Wake again.' },
      { name: 'foreman-gamma-master', state: 'woken' },
      { name: 'foreman-eta-main', state: 'something-new' },
    ],
    label,
  );
  assert.equal(out.woke, 'woke alpha-main, gamma-master');
  assert.deepEqual(out.failed, [
    'foreman-delta-lead did not wake: Not a git repository. It is still asleep — try Wake again.',
    'eta-main did not wake.',
  ], 'a state this version has never heard of is not read as a success');
  assert.deepEqual(wakeResultText([]), { woke: null, failed: [] });
  assert.deepEqual(wakeResultText(null), { woke: null, failed: [] });
});

test('the folded strip draws a sleeping member’s dot as asleep, not gone', () => {
  const facts = roomStripFacts(room, [row('beta-main', { status: 'working' })], [sleeper('alpha-main')]);
  assert.deepEqual(facts.dots, ['asleep', 'working', 'gone', 'gone']);
  // Called the old way, nothing changes.
  assert.deepEqual(roomStripFacts(room, [row('beta-main')]).dots, ['gone', 'idle', 'gone', 'gone']);
});

/* ---------------------------------------------------------------- the pane's wiring --- */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const mcp = fs.readFileSync(path.join(ROOT, 'mcp', 'foreman.js'), 'utf8');
// Prose out, so a negative check is not failed by the comment that records the rule.
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
const fn = (name) => {
  const m = app.match(new RegExp(`\\n  (?:async )?function ${name}\\([\\s\\S]*?\\n  \\}`));
  assert.ok(m, `\`${name}\` must exist`);
  return m[0];
};

test('the wake is a human press and nothing else — no auto-wake on a post, a frame or a timer', () => {
  // Exactly one reference to the handler outside its own definition: the button's onclick.
  const uses = code(app).match(/wakeGroupSleepers/g) || [];
  assert.equal(uses.length, 2, 'the definition and the onclick');
  assert.match(code(app), /wake\.onclick = wakeGroupSleepers;/);
  // The bulk route is reached from the pane alone; no `foreman` tool reaches it.
  assert.equal((code(app).match(/\/wake-asleep`/g) || []).length, 1);
  assert.ok(!/wake-asleep/.test(mcp));
  // And nothing on the server calls it — it is a route, not a function anything else runs.
  assert.equal((code(server).match(/wake-asleep/g) || []).length, 1);
});

test('the room’s wake goes through the one wake function, and holds the flag across the run', () => {
  const route = server.slice(server.indexOf("app.post('/api/rooms/:id/wake-asleep'"));
  const body = route.slice(0, route.indexOf('\n});') + 4);
  assert.match(body, /await wakeSleeper\(name\)/);
  assert.ok(!/startEntries|createSession|launchLead|restoreSessions/.test(code(body)), 'never a second launcher');
  // Taken once before the loop and released once after it.
  assert.ok(body.indexOf('relaunching = true') < body.indexOf('for (const name of names)'));
  assert.ok(body.indexOf('relaunching = false') > body.indexOf('for (const name of names)'));
  assert.match(body, /const busy = wakeRefusal\(\);/);
  // And the sleeper pane's own Wake is the same function.
  const one = server.slice(server.indexOf("app.post('/api/asleep/:name/wake'"));
  assert.match(one.slice(0, one.indexOf('\n});')), /await wakeSleeper\(name\)/);
});

test('the button is patched on every beat, after the strip’s guard, and never joins a signature', () => {
  const strip = fn('renderGroupStrip');
  const sig = strip.slice(strip.indexOf('const sig = ['), strip.indexOf("].join('#')"));
  assert.ok(!/asleep|wake/i.test(sig), 'a sleep must not rebuild the strip and take an armed question away');
  const after = strip.slice(strip.indexOf('groupStripSig ='));
  const patched = after.slice(after.indexOf('const wake = [...strip.children]'));
  assert.match(patched, /wake\.hidden = !word;/);
  assert.match(patched, /wakeLabel\(sleepers\.length, view\.groupWakeBusy\)/);
  // `composerSig` knows nothing about any of it.
  const composerSig = app.match(/const composerSig = [\s\S]*?\n  let lastComposerSig/)?.[0] || '';
  assert.ok(composerSig, '`composerSig` must exist');
  assert.ok(!/asleep|wake/i.test(code(composerSig)));
});

test('a run’s result and refusal live in view state, and the CSS keeps `[hidden]` honest', () => {
  const press = fn('wakeGroupSleepers');
  assert.match(press, /view\.groupWakeNote = wakeResultText\(out\.results, label\)/);
  assert.match(press, /view\.groupHeadError = err\.message;/);
  assert.match(press, /if \(!id \|\| view\.groupWakeBusy\) return;/);
  const css = fs.readFileSync(path.join(ROOT, 'web', 'styles.css'), 'utf8');
  assert.match(css, /\.group-wake\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.group-wake-note\[hidden\] \{ display: none; \}/);
  assert.match(css, /\.group-chip\.is-asleep \{/);
});
