import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG_DIR, peersDirOf, plansDirOf } from '../server/account.js';
import { listCommands } from '../server/commands.js';
import { listPeers, readPeer } from '../server/peers.js';
import { readPlanFile, resolvePlanFile } from '../server/plan-file.js';
import { resolveSender } from '../server/observe.js';

/*
 * The `~/.claude` readers that are not the transcript scan: the peer registry, the plan file
 * a plan-approval box names, and the `/` menu. Each one used to read the default dir only,
 * and a second-account session writes its own dir (MEASURED on v2.1.331) — so each gave a
 * wrong answer for it rather than a blank one. A fixture second root, fake paths, fake ids.
 */

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'foreman-readers-'));
const MAIN = path.join(root, 'home', '.claude');
const OTHER = path.join(root, 'home', '.claude-second');
const STRANGER = path.join(root, 'home', '.claude-unseen');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------- peers --

const peer = (pid, name, pane) =>
  JSON.stringify({ pid, sessionId: `fake-session-${name}`, cwd: `/fake/${name}`, name, tmux: `foreman-${name}:@1.${pane}` });

write(path.join(peersDirOf(MAIN), '100.json'), peer(100, 'first', '%1'));
write(path.join(peersDirOf(OTHER), '200.json'), peer(200, 'second', '%2'));

test('a session on the second account is found in its own registry, not only the default’s', () => {
  const dirs = [MAIN, OTHER].map(peersDirOf);
  assert.equal(readPeer(200, dirs).name, 'second');
  assert.equal(readPeer(200, dirs).paneId, '%2');
  assert.equal(readPeer(100, dirs).name, 'first', 'the default dir still answers its own');
  assert.equal(readPeer(200, [peersDirOf(MAIN)]), null, 'the default-only read — what it used to be — misses it');
  assert.equal(readPeer(300, dirs), null);
});

test('listPeers spans every registry it is handed, and a missing one is skipped', () => {
  const dirs = [MAIN, STRANGER, OTHER].map(peersDirOf);
  assert.deepEqual(listPeers(dirs).map((p) => p.name).sort(), ['first', 'second']);
});

test('a sender on the second account joins its row through that account’s registry', () => {
  const rows = [
    { paneId: '%1', tmuxSession: 'foreman-first', id: 'fake-session-first' },
    { paneId: '%2', tmuxSession: 'foreman-second', id: 'fake-session-second' },
  ];
  const peersDirs = [MAIN, OTHER].map(peersDirOf);
  const hit = resolveSender({ fromPid: 200, from: 'second' }, rows, { peersDirs });
  assert.equal(hit.fromSource, 'registry');
  assert.equal(hit.row.paneId, '%2');
  // The list is asked afresh when it is a function, so a dir noted later is read at once.
  let known = [MAIN];
  const late = { peersDirs: () => known.map(peersDirOf) };
  assert.equal(resolveSender({ fromPid: 200 }, rows, late).fromSource, 'unknown');
  known = [MAIN, OTHER];
  assert.equal(resolveSender({ fromPid: 200 }, rows, late).fromSource, 'registry');
});

// ------------------------------------------------------------------------ plan file --

write(path.join(plansDirOf(MAIN), 'main-plan.md'), '# main plan');
write(path.join(plansDirOf(OTHER), 'x.md'), '# second plan');
write(path.join(plansDirOf(STRANGER), 'y.md'), '# unseen plan');
write(path.join(root, 'elsewhere', 'z.md'), '# not a plan');
const home = path.join(root, 'home');
const known = [MAIN, OTHER];

test('the plan route serves <second dir>/plans/x.md', async () => {
  const r = await readPlanFile(path.join(plansDirOf(OTHER), 'x.md'), known, { home });
  assert.equal(r.status, 200);
  assert.equal(r.body.markdown, '# second plan');
});

test('a `~`-led path is read against the home it was printed under', async () => {
  const r = await readPlanFile('~/.claude-second/plans/x.md', known, { home });
  assert.equal(r.status, 200);
  assert.equal(r.body.path, '~/.claude-second/plans/x.md', 'the card shows the path as the box printed it');
});

test('the default dir’s plans are still served', async () => {
  assert.equal((await readPlanFile('~/.claude/plans/main-plan.md', known, { home })).status, 200);
});

test('a plans folder in a dir the panel has not seen is refused, even though the file exists', async () => {
  const r = await readPlanFile(path.join(plansDirOf(STRANGER), 'y.md'), known, { home });
  assert.equal(r.status, 400);
  assert.equal(r.body.markdown, undefined);
});

test('nothing outside a plans folder is served — not a sibling, not a `..` out of one', async () => {
  for (const p of [
    path.join(root, 'elsewhere', 'z.md'),
    path.join(OTHER, 'settings.json'),
    path.join(plansDirOf(OTHER), '..', 'settings.json'),
    path.join(plansDirOf(OTHER), '..', '..', '..', 'elsewhere', 'z.md'),
    `${plansDirOf(OTHER)}-evil/x.md`,
    '',
    null,
  ]) {
    assert.equal((await readPlanFile(p, known, { home })).status, 400, String(p));
  }
  assert.equal(resolvePlanFile(path.join(plansDirOf(OTHER), 'x.md'), [], home), null, 'no known dirs, no plans');
});

test('a plan that is gone, a directory, and an oversized file each answer in their own words', async () => {
  assert.equal((await readPlanFile(path.join(plansDirOf(OTHER), 'gone.md'), known, { home })).status, 404);
  fs.mkdirSync(path.join(plansDirOf(OTHER), 'sub'), { recursive: true });
  assert.equal((await readPlanFile(path.join(plansDirOf(OTHER), 'sub'), known, { home })).status, 404);
  write(path.join(plansDirOf(OTHER), 'big.md'), 'x'.repeat(256 * 1024 + 1));
  assert.equal((await readPlanFile(path.join(plansDirOf(OTHER), 'big.md'), known, { home })).status, 413);
});

// -------------------------------------------------------------------------- commands --

const md = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`;
write(path.join(OTHER, 'commands', 'second-only.md'), md('second-only', 'a command of the second account'));
write(path.join(OTHER, 'skills', 'sk', 'SKILL.md'), md('second-skill', 'a skill of the second account'));
write(path.join(OTHER, 'plugins', 'p', 'commands', 'plug.md'), md('second-plug', 'a plugin command'));
const cwd = path.join(root, 'project');
write(path.join(cwd, '.claude', 'commands', 'proj.md'), md('proj', 'a project command'));

test('the / menu for a pane on another account reads that pane’s own dir', async () => {
  const names = (await listCommands(cwd, OTHER)).map((c) => c.name);
  for (const n of ['second-only', 'second-skill', 'second-plug']) assert.ok(names.includes(n), n);
  assert.ok(names.includes('proj'), 'the project’s own commands are the same on either account');
});

test('…and offers no user command but that dir’s own', async () => {
  const user = (await listCommands(cwd, OTHER)).filter((c) => c.source === 'user').map((c) => c.name);
  assert.deepEqual(user, ['second-only'], 'whatever the default dir holds on this machine is not in it');
});

test('the same folder on two accounts is two lists — the cache is keyed on both', async () => {
  const a = (await listCommands(cwd, MAIN)).map((c) => c.name);
  const b = (await listCommands(cwd, OTHER)).map((c) => c.name);
  assert.ok(!a.includes('second-only'));
  assert.ok(b.includes('second-only'));
  assert.deepEqual((await listCommands(cwd, OTHER)).map((c) => c.name), b, 'and a repeat is the cached one');
});

test('a default or unknown pane reads exactly what it always did', async () => {
  const bare = (await listCommands(cwd)).map((c) => c.name);
  const named = (await listCommands(cwd, DEFAULT_CONFIG_DIR)).map((c) => c.name);
  assert.deepEqual(bare, named);
  assert.ok(!bare.includes('second-only'));
});
