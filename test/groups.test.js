import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * Scratch state dir before the import: the store derives the `worktrees/` prefix from it
 * at load, and that prefix is what tells a panel-made group from a hand-made one. Pointed
 * at the real one, these tests would be reasoning about the maintainer's actual worktrees.
 */
process.env.FOREMAN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-groups-state-'));
const WORKTREES = path.join(process.env.FOREMAN_STATE_DIR, 'worktrees');
const { GroupStore } = await import('../server/groups.js');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-groups-'));
  return path.join(dir, 'groups.json');
}

/** What a dispatch files: the folder name the rail draws, and the checkout behind it. */
const worktree = (name) => path.join(WORKTREES, name);

test.after(() => fs.rmSync(process.env.FOREMAN_STATE_DIR, { recursive: true, force: true }));

test('a group starts empty and open', () => {
  const g = new GroupStore(tmpStore());
  const made = g.create('Work');
  assert.equal(made.name, 'Work');
  assert.deepEqual(made.folders, []);
  assert.equal(made.collapsed, false);
  g.stop();
});

test('names are trimmed, and two groups cannot share one', () => {
  const g = new GroupStore(tmpStore());
  assert.equal(g.create('  Work  ').name, 'Work');
  assert.throws(() => g.create('work'), /already a group/i, 'case is not a distinction');
  assert.throws(() => g.create('   '), /needs a name/i);
  g.stop();
});

/*
 * The whole point of filing by folder rather than by session: a folder in two groups
 * would draw its sessions twice, which is the mess this feature exists to tidy.
 */
test('filing a folder moves it rather than copying it', () => {
  const g = new GroupStore(tmpStore());
  const work = g.create('Work');
  const side = g.create('Side');

  g.assign('Alpha', work.id);
  assert.equal(g.groupOf('Alpha'), work.id);

  g.assign('Alpha', side.id);
  assert.equal(g.groupOf('Alpha'), side.id);
  assert.deepEqual(g.get(work.id).folders, [], 'it left the first group on the way out');
  g.stop();
});

test('a folder can be taken back out again', () => {
  const g = new GroupStore(tmpStore());
  const work = g.create('Work');
  g.assign('Alpha', work.id);
  assert.equal(g.assign('Alpha', null), true);
  assert.equal(g.groupOf('Alpha'), null);
  assert.equal(g.assign('Alpha', null), false, 'nothing left to change');
  g.stop();
});

test('assigning to a group that does not exist is refused', () => {
  const g = new GroupStore(tmpStore());
  assert.throws(() => g.assign('Alpha', 'g99'), /No such group/);
  g.stop();
});

/* The group is a shelf, not a box — deleting it doesn't delete what was on it. */
test('deleting a group leaves its folders alone', () => {
  const g = new GroupStore(tmpStore());
  const work = g.create('Work');
  g.assign('Alpha', work.id);
  assert.equal(g.remove(work.id), true);
  assert.equal(g.groupOf('Alpha'), null, 'the folder stands on its own again');
  assert.equal(g.remove(work.id), false);
  g.stop();
});

test('renaming keeps the folders and still refuses a taken name', () => {
  const g = new GroupStore(tmpStore());
  const work = g.create('Work');
  g.create('Side');
  g.assign('Alpha', work.id);

  const renamed = g.rename(work.id, 'Day job');
  assert.equal(renamed.name, 'Day job');
  assert.deepEqual(renamed.folders, ['Alpha']);
  assert.throws(() => g.rename(work.id, 'Side'), /already a group/i);
  assert.equal(g.rename('g99', 'Nope'), null);
  g.stop();
});

test('collapse is a property of the group, not of the browser', () => {
  const file = tmpStore();
  const g = new GroupStore(file);
  const work = g.create('Work');
  g.setCollapsed(work.id, true);
  g.flush();
  g.stop();

  const reopened = new GroupStore(file);
  assert.equal(reopened.get(work.id).collapsed, true);
  reopened.stop();
});

test('ids are not reused after a delete', () => {
  const file = tmpStore();
  const g = new GroupStore(file);
  const first = g.create('Work');
  g.remove(first.id);
  g.flush();
  g.stop();

  const reopened = new GroupStore(file);
  assert.notEqual(reopened.create('Other').id, first.id);
  reopened.stop();
});

test('list hands out copies, so the store cannot be edited from outside', () => {
  const g = new GroupStore(tmpStore());
  const work = g.create('Work');
  g.assign('Alpha', work.id);
  g.list()[0].folders.push('Sneaky');
  assert.deepEqual(g.get(work.id).folders, ['Alpha']);
  g.stop();
});

test('a hand-mangled store starts clean instead of throwing', () => {
  const file = tmpStore();
  fs.writeFileSync(file, '{ not json at all');
  const g = new GroupStore(file);
  assert.deepEqual(g.list(), []);
  g.stop();
});

/* ------------------------------------------------ groups the panel made --- */

/*
 * The flag is the whole safety catch: it is the only thing that lets the panel delete a
 * group, and everything that arrives over the API is somebody filing something by hand.
 */
test('a group is hand-made unless the panel says otherwise', () => {
  const g = new GroupStore(tmpStore());
  assert.equal(g.create('Work').auto, false);
  assert.equal(g.create('Foreman', { auto: true }).auto, true);
  g.stop();
});

test('reaping takes the empty auto-made groups and leaves yours standing', () => {
  const g = new GroupStore(tmpStore());
  const mine = g.create('Work');
  const team = g.create('Foreman', { auto: true });

  assert.deepEqual(g.reap(), [team.id]);
  assert.equal(g.get(team.id), null);
  assert.equal(g.get(mine.id).name, 'Work', 'an empty group you made is a decision, not litter');
  g.stop();
});

test('a worktree closing takes its filing with it, and the group when it was the last', () => {
  const g = new GroupStore(tmpStore());
  const team = g.create('Foreman', { auto: true });
  g.assign('Foreman-room-bubbles', team.id);
  g.assign('Foreman-group-cleanup', team.id);

  const first = g.retireWorktree(worktree('Foreman-room-bubbles'));
  assert.deepEqual(first.unfiled, ['Foreman-room-bubbles']);
  assert.deepEqual(first.removed, [], 'one worker left — the heading still has something under it');
  assert.equal(g.groupOf('Foreman-room-bubbles'), null);

  const last = g.retireWorktree(worktree('Foreman-group-cleanup'));
  assert.deepEqual(last.removed, [team.id]);
  assert.equal(g.list().length, 0);
  g.stop();
});

/*
 * The rail files what it draws — a basename — but the first version of the dispatch filed
 * the absolute directory, and those entries are still on disk. Retiring has to answer to
 * both spellings, and both must leave the folder in no group at all.
 */
test('either spelling of a worktree is retired, and the folder ends up in neither', () => {
  const g = new GroupStore(tmpStore());
  const team = g.create('Beta-harness', { auto: true });
  const dir = worktree('Beta-harness-parity-issues-doc');
  g.assign(dir, team.id); // the old shape, straight off the maintainer's groups.json

  const { unfiled, removed } = g.retireWorktree(dir);
  assert.deepEqual(unfiled, [dir]);
  assert.deepEqual(removed, [team.id]);
  assert.equal(g.groupOf(dir), null);
  assert.equal(g.groupOf(path.basename(dir)), null);
  g.stop();
});

/* The spec's guard: unfile the dead worktrees, leave everything else exactly where it is. */
test('a team group somebody filed a real project into is never reaped', () => {
  const g = new GroupStore(tmpStore());
  const team = g.create('Foreman', { auto: true });
  g.assign('Foreman-group-cleanup', team.id);
  g.assign('Foreman', team.id); // the real checkout, filed by hand

  const { removed } = g.retireWorktree(worktree('Foreman-group-cleanup'));
  assert.deepEqual(removed, []);
  assert.deepEqual(g.get(team.id).folders, ['Foreman'], 'the worker went, the project stayed');
  g.stop();
});

/*
 * A folder that shares a worktree's name is still a folder. Retiring by a path that isn't
 * under `worktrees/` must not reach for the basename — that is somebody else's filing.
 */
test('retiring a path from elsewhere never unfiles a project of the same name', () => {
  const g = new GroupStore(tmpStore());
  const mine = g.create('Tools');
  g.assign('Foreman', mine.id);

  const { unfiled } = g.retireWorktree('/Users/x/Code/Foreman');
  assert.deepEqual(unfiled, []);
  assert.equal(g.groupOf('Foreman'), mine.id);
  g.stop();
});

test('one group per folder holds across a retire and a reap', () => {
  const g = new GroupStore(tmpStore());
  const team = g.create('Foreman', { auto: true });
  const mine = g.create('Tools');
  g.assign('Foreman-group-cleanup', team.id);
  g.assign('Foreman-group-cleanup', mine.id); // a move, as ever

  g.retireWorktree(worktree('Foreman-group-cleanup'));
  const homes = g.list().filter((x) => x.folders.includes('Foreman-group-cleanup'));
  assert.deepEqual(homes, [], 'in one group at most, and now in none');
  assert.equal(g.get(mine.id).name, 'Tools', 'it was filed by hand last, so its group stays');
  assert.equal(g.get(team.id), null, 'and the one the panel made ran dry');
  g.stop();
});

/* ----------------------------------------- groups that predate the flag --- */

/*
 * The maintainer has live groups with no `auto` key, and reading them as panel-made would delete
 * filing they did by hand. The tell is the shape of the folders, not emptiness.
 */
test('a group from before the flag is read by what it holds', () => {
  const file = tmpStore();
  fs.writeFileSync(
    file,
    JSON.stringify({
      seq: 3,
      groups: [
        { id: 'g1', name: 'Tools', collapsed: true, folders: ['Foreman', 'Gamma'] },
        { id: 'g2', name: 'Foreman', collapsed: false, folders: [worktree('Foreman-room-bubbles')] },
        { id: 'g3', name: 'Empty', collapsed: false, folders: [] },
      ],
    }),
  );

  const g = new GroupStore(file);
  const byId = Object.fromEntries(g.list().map((x) => [x.id, x]));
  assert.equal(byId.g1.auto, false, 'bare folder names are what the rail files by hand');
  assert.equal(byId.g2.auto, true, 'only a dispatch ever wrote an absolute worktree path');
  assert.equal(byId.g3.auto, false, 'empty is no evidence — leave it alone');
  assert.equal(byId.g1.collapsed, true, 'and nothing about the migration touches collapse');

  assert.deepEqual(g.reap(), [], 'the auto one still holds a worktree');
  g.retireWorktree(worktree('Foreman-room-bubbles'));
  assert.deepEqual(
    g.list().map((x) => x.id),
    ['g1', 'g3'],
    'the team heading went; both of yours stayed',
  );
  g.stop();
});

test('the flag survives a reload rather than being re-guessed', () => {
  const file = tmpStore();
  const g = new GroupStore(file);
  const team = g.create('Foreman', { auto: true });
  g.assign('Foreman-group-cleanup', team.id); // a basename, which alone reads hand-made
  g.flush();
  g.stop();

  const reopened = new GroupStore(file);
  assert.equal(reopened.get(team.id).auto, true);
  reopened.stop();
});

/* ------------------------------------------------------------- the colour slot --- */

/*
 * A group wears a slot of the rail's ring (`web/group-hue.js`), and the number lives on
 * the record because a spine has to survive a reload and a restart. The rule itself is
 * tested next door in `test/group-hue.test.js`; what matters here is that the store
 * assigns one, carries it across a reload, and refuses a slot that isn't one.
 */

const { GROUP_COLOUR_COUNT } = await import('../web/group-hue.js');

test('a new group is given a slot, and the first ones are all different', () => {
  const g = new GroupStore(tmpStore());
  const slots = ['alpha', 'beta', 'gamma'].map((n) => g.create(n).colour);
  assert.deepEqual(slots, [1, 2, 3]);
  g.stop();
});

test('the slot survives a reload rather than being re-assigned', () => {
  const file = tmpStore();
  const g = new GroupStore(file);
  g.create('alpha');
  const beta = g.create('beta');
  g.setColour(beta.id, 7);
  g.flush();
  g.stop();

  const reopened = new GroupStore(file);
  assert.equal(reopened.get(beta.id).colour, 7, 'a chosen colour is not re-rolled at boot');
  reopened.stop();
});

/*
 * `#load` rebuilds each record from named keys, so a field it does not know about is
 * dropped — which is why the backfill exists and why it has to be written down. Groups on
 * disk from before this change carry no `colour` at all.
 */
test('a record with no colour is backfilled, in list order, and written once', () => {
  const file = tmpStore();
  fs.writeFileSync(
    file,
    JSON.stringify({
      seq: 3,
      groups: [
        { id: 'g1', name: 'alpha', collapsed: false, folders: ['alpha'] },
        { id: 'g2', name: 'beta', collapsed: false, folders: ['beta'] },
        { id: 'g3', name: 'gamma', collapsed: false, folders: [] },
      ],
    }),
  );

  const g = new GroupStore(file);
  assert.deepEqual(g.list().map((x) => x.colour), [1, 2, 3], 'each one sees what the ones above took');
  assert.equal(g.dirty, true, 'the guess is written, so it is only ever guessed once');
  g.flush();
  g.stop();

  const reopened = new GroupStore(file);
  assert.deepEqual(reopened.list().map((x) => x.colour), [1, 2, 3], 'and the backfill survives');
  assert.equal(reopened.dirty, false, 'nothing left to guess on the second boot');
  reopened.stop();
});

test('a slot already on disk is kept, and only the gaps are filled', () => {
  const file = tmpStore();
  fs.writeFileSync(
    file,
    JSON.stringify({
      seq: 3,
      groups: [
        { id: 'g1', name: 'alpha', colour: 4, folders: [] },
        { id: 'g2', name: 'beta', folders: [] },
        { id: 'g3', name: 'gamma', colour: 99, folders: [] }, // hand-edited into nonsense
      ],
    }),
  );

  const g = new GroupStore(file);
  assert.deepEqual(g.list().map((x) => x.colour), [4, 1, 2]);
  g.stop();
});

test('setColour refuses anything that is not a slot', () => {
  const g = new GroupStore(tmpStore());
  const made = g.create('alpha');

  assert.equal(g.setColour(made.id, 5).colour, 5);
  for (const bad of [0, -1, GROUP_COLOUR_COUNT + 1, 1.5, '2', null, undefined, NaN, {}]) {
    assert.throws(
      () => g.setColour(made.id, bad),
      /whole number from 1 to/i,
      `refused: ${String(bad)}`,
    );
  }
  assert.equal(g.get(made.id).colour, 5, 'and none of them changed the colour it had');
  g.stop();
});

/* The same split `rename` has: an unknown id is nothing to change, a bad slot is a bad
 * request. The route reads the two differently (404 against 400), so the store must too. */
test('setColour on a group that does not exist is null, not a throw', () => {
  const g = new GroupStore(tmpStore());
  assert.equal(g.setColour('g99', 3), null);
  g.stop();
});

/* --------------------------------------------------- the colour over the wire --- */

/*
 * `PATCH /api/groups/:id` against the real server, the shape `test/team-api.test.js`
 * uses: a scratch state dir, a free port, and nothing that touches the real one — a
 * second panel on the real state dir boots its own worktree GC and would sweep real
 * worktrees. The route lives inline in `server/index.js`, so there is nothing to import
 * and the thing worth testing is the whole request: express body parsing, the status
 * codes, and the fact that a slot the store refuses comes back as a 400 rather than as a
 * silently coerced colour.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let panel;
let port;
let panelState;

async function freePort() {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port: p } = probe.address();
  await new Promise((r) => probe.close(r));
  return p;
}

async function api(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/** SIGTERM makes the panel flush on its way out, so an `rm` in the same tick races it. */
function stop(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    proc.once('exit', resolve);
    proc.kill();
  });
}

test.before(async () => {
  panelState = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-groups-api-'));
  /* Seeded with one group carrying no colour, so the boot backfill is visible through the
     API as well as through the store. */
  await fsp.writeFile(
    path.join(panelState, 'groups.json'),
    JSON.stringify({ seq: 1, groups: [{ id: 'g1', name: 'alpha', collapsed: false, folders: ['alpha'] }] }),
  );
  port = await freePort();
  panel = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      FOREMAN_PORT: String(port),
      FOREMAN_HOST: '127.0.0.1',
      FOREMAN_STATE_DIR: panelState,
      /* A scratch label, because a panel rotates the log files its label names at boot and
         the default label's files are the real panel's. Nothing here needs a log; this is
         the one line that makes sure a big one could never be touched. */
      FOREMAN_AGENT_LABEL: 'com.example.foreman-groups-test',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  // Insurance against an interrupted run: `after` never fires on a Ctrl-C.
  process.on('exit', () => panel?.kill());

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/groups`);
      return;
    } catch {
      if (Date.now() > deadline) throw new Error('the scratch panel never came up');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

test.after(async () => {
  await stop(panel);
  if (panelState) await fsp.rm(panelState, { recursive: true, force: true });
});

test('the backfilled colour is on the wire without any client plumbing', async () => {
  const res = await api('GET', '/api/groups');
  assert.equal(res.status, 200);
  assert.equal(res.body.groups[0].colour, 1, 'a group written before the field had one');
});

test('a group made over the API comes back with a slot of its own', async () => {
  const res = await api('POST', '/api/groups', { name: 'beta' });
  assert.equal(res.status, 200);
  assert.equal(res.body.group.colour, 2);
});

test('PATCH colour round-trips, and rides the whole list back', async () => {
  const made = await api('POST', '/api/groups', { name: 'gamma' });
  const id = made.body.group.id;

  const patched = await api('PATCH', `/api/groups/${id}`, { colour: 9 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.group.colour, 9);
  assert.equal(patched.body.groups.find((g) => g.id === id).colour, 9);

  const after = await api('GET', '/api/groups');
  assert.equal(after.body.groups.find((g) => g.id === id).colour, 9, 'and it stuck');
});

test('a slot outside the ring is a 400 with a sentence, and changes nothing', async () => {
  const made = await api('POST', '/api/groups', { name: 'delta' });
  const id = made.body.group.id;
  const had = made.body.group.colour;

  for (const bad of [0, GROUP_COLOUR_COUNT + 1, 2.5, '3', null]) {
    const res = await api('PATCH', `/api/groups/${id}`, { colour: bad });
    assert.equal(res.status, 400, `refused: ${String(bad)}`);
    assert.match(res.body.error, /whole number from 1 to/i);
  }

  const after = await api('GET', '/api/groups');
  assert.equal(after.body.groups.find((g) => g.id === id).colour, had);
});

test('a colour for a group that does not exist is a 404', async () => {
  const res = await api('PATCH', '/api/groups/g999', { colour: 3 });
  assert.equal(res.status, 404);
});

/* Name and collapse still work, and a PATCH carrying a colour beside a name applies both —
 * the route walks the three in order rather than treating them as alternatives. */
test('colour sits beside name and collapsed rather than replacing them', async () => {
  const made = await api('POST', '/api/groups', { name: 'epsilon' });
  const id = made.body.group.id;

  const res = await api('PATCH', `/api/groups/${id}`, { name: 'epsilon-two', collapsed: true, colour: 6 });
  assert.equal(res.status, 200);
  assert.equal(res.body.group.name, 'epsilon-two');
  assert.equal(res.body.group.collapsed, true);
  assert.equal(res.body.group.colour, 6);
});
