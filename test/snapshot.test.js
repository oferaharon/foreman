import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SnapshotStore,
  benchEntries,
  isLeadEntry,
  liveWorkers,
  relaunchEntries,
  restoreSessions,
} from '../server/snapshot.js';
import { WORKTREES_DIR } from '../server/worktree.js';
import { sessionName } from '../server/launch.js';
import { SESSION_PREFIX } from '../server/config.js';

/*
 * Every session name below is one the panel minted, so they are built from the configured
 * prefix rather than written as a literal. This file is about which rows are *on the
 * bench* and how one is put back, not about the naming contract — that is pinned at both
 * live prefixes in `test/launch.test.js`. Hardcoding one here would only mean this suite
 * failing wholesale the day somebody's `config.json` says something else.
 */
const P = SESSION_PREFIX;

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-snap-'));
  return path.join(dir, 'snapshot.json');
}

const entry = (slug, extra = {}) => ({
  folder: `/Users/x/Code/${slug}`,
  slug: 'main',
  tmuxSession: `${P}${slug}-main`,
  ...extra,
});

test('a snapshot survives the trip to disk and back', () => {
  const file = tmpStore();
  const a = new SnapshotStore(file);
  a.save([entry('alpha', { pinned: true, skipPermissions: true }), entry('beta')], 1000);
  a.stop();

  const b = new SnapshotStore(file);
  const snap = b.get();
  assert.equal(snap.savedAt, 1000);
  assert.equal(snap.sessions.length, 2);
  assert.deepEqual(snap.sessions[0], {
    folder: '/Users/x/Code/alpha',
    slug: 'main',
    tmuxSession: `${P}alpha-main`,
    skipPermissions: true,
    pinned: true,
  });
  assert.equal(snap.sessions[1].skipPermissions, false, 'absent flags read as off');
  assert.equal(snap.sessions[1].pinned, false);
  b.stop();
});

/* The safe way round to be wrong: a snapshot that forgets the flag restores a session
   that asks before it edits, rather than one that doesn't. */
test('an entry with no folder is not restorable and is dropped', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([entry('alpha'), { slug: 'orphan' }, null], 1);
  assert.equal(s.get().sessions.length, 1);
  s.stop();
});

test('nonsense on disk starts clean rather than throwing', () => {
  const file = tmpStore();
  fs.writeFileSync(file, '{ this is not json');
  assert.equal(new SnapshotStore(file).get(), null);

  fs.writeFileSync(file, JSON.stringify({ savedAt: 'yesterday', sessions: [] }));
  assert.equal(new SnapshotStore(file).get(), null, 'a savedAt that is not a number');

  fs.writeFileSync(file, JSON.stringify({ savedAt: 1, sessions: 'lots' }));
  assert.equal(new SnapshotStore(file).get(), null, 'sessions that are not a list');
});

/* One slot. Saving again means "like this now", not "as well as". */
test('saving replaces the slot', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([entry('alpha'), entry('beta')], 1);
  s.save([entry('gamma')], 2);
  assert.equal(s.get().savedAt, 2);
  assert.deepEqual(
    s.get().sessions.map((e) => e.tmuxSession),
    [`${P}gamma-main`],
  );
  s.stop();
});

test('what comes out is a copy, not the store', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([entry('alpha')], 1);
  s.get().sessions[0].folder = '/tmp/somewhere-else';
  s.get().sessions.push(entry('beta'));
  assert.equal(s.get().sessions.length, 1);
  assert.equal(s.get().sessions[0].folder, '/Users/x/Code/alpha');
  s.stop();
});

test('clearing empties the slot and removes the file', () => {
  const file = tmpStore();
  const s = new SnapshotStore(file);
  s.save([entry('alpha')], 1);
  s.flush();
  assert.equal(fs.existsSync(file), true);
  assert.equal(s.clear(), true);
  assert.equal(s.clear(), false, 'clearing nothing changes nothing');
  s.flush();
  assert.equal(fs.existsSync(file), false);
  assert.equal(new SnapshotStore(file).get(), null);
  s.stop();
});

/* ------------------------------------------------------------- drift --- */

const live = (...names) => names.map((tmuxSession) => ({ tmuxSession }));

test('nothing saved is not drift', () => {
  const s = new SnapshotStore(tmpStore());
  assert.deepEqual(s.drift(live(`${P}alpha-main`)), { missing: [], extra: [] });
  s.stop();
});

test('a snapshot matching what runs has drifted nowhere', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([entry('alpha'), entry('beta')], 1);
  assert.deepEqual(s.drift(live(`${P}beta-main`, `${P}alpha-main`)), {
    missing: [],
    extra: [],
  });
  s.stop();
});

test('a session started since the save is extra', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([entry('alpha')], 1);
  assert.deepEqual(s.drift(live(`${P}alpha-main`, `${P}gamma-main`)), {
    missing: [],
    extra: [`${P}gamma-main`],
  });
  s.stop();
});

test('a saved session no longer running is missing', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([entry('alpha'), entry('beta')], 1);
  assert.deepEqual(s.drift(live(`${P}alpha-main`)), {
    missing: [`${P}beta-main`],
    extra: [],
  });
  s.stop();
});

test('drift after a reboot is the whole snapshot', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([entry('alpha'), entry('beta')], 1);
  assert.deepEqual(s.drift([]), {
    missing: [`${P}alpha-main`, `${P}beta-main`],
    extra: [],
  });
  s.stop();
});

/* A pane with no tmux name can't be matched either way, and must not read as drift on
   both sides of the comparison at once. */
test('nameless entries sit out the comparison', () => {
  const s = new SnapshotStore(tmpStore());
  s.save([{ folder: '/Users/x/Code/scratch', slug: null }], 1);
  assert.deepEqual(s.drift([{ tmuxSession: null }]), { missing: [], extra: [] });
  s.stop();
});

/* --------------------------------------------------- what gets saved --- */

const row = (over = {}) => ({
  tmuxSession: `${P}alpha-main`,
  paneCwd: '/Users/x/Code/alpha',
  bypass: false,
  pinned: false,
  team: null,
  ...over,
});

test('the bench is your sessions and your lead, and not the workers', () => {
  const entries = benchEntries([
    row(),
    row({ tmuxSession: `${P}alpha-lead`, team: { role: 'lead', tasks: 2 } }),
    row({
      tmuxSession: `${P}alpha-fix-the-thing`,
      paneCwd: path.join(WORKTREES_DIR, 'alpha-fix-the-thing'),
      team: { role: 'worker', repo: '/Users/x/Code/alpha', task: 't1' },
    }),
  ]);
  assert.deepEqual(
    entries.map((e) => e.slug),
    ['main', 'lead'],
  );
});

/* A planner (Gitea PR #14) is a `kind: 'plan'` task, and `sessions.js` gives it the same `worker`
   role — so it is already out. The test is here because the filter is an allow-list: if a
   planner ever gets a role of its own, this is what fails instead of a snapshot quietly
   growing a session nobody can restore. */
test('a planner is not on the bench either, whatever role it ends up with', () => {
  const planner = (role) =>
    row({
      tmuxSession: `${P}alpha-plan-the-thing`,
      paneCwd: '/Users/x/Code/alpha',
      team: { role, repo: '/Users/x/Code/alpha', task: 'plan-the-thing', state: 'working' },
    });
  assert.deepEqual(benchEntries([planner('worker')]), [], 'as sessions.js labels it today');
  assert.deepEqual(benchEntries([planner('planner')]), [], 'and if it is ever given its own');
});

/* Both halves of the worker test earn their place: `team.role` is the live join on an
   open task, and it goes null the moment that task closes — while the checkout, which is
   about to be swept, is still what the pane is sitting in. */
test('a worker whose task has closed is still not part of the bench', () => {
  const entries = benchEntries([
    row({
      tmuxSession: `${P}alpha-fix-the-thing`,
      paneCwd: path.join(WORKTREES_DIR, 'alpha-fix-the-thing'),
      team: null,
    }),
  ]);
  assert.deepEqual(entries, []);
});

/* `startsWith` would call this a worktree. It is a project that shares a prefix. */
test('a folder beside the worktrees dir is an ordinary project', () => {
  const entries = benchEntries([row({ paneCwd: `${WORKTREES_DIR}-archive/alpha` })]);
  assert.equal(entries.length, 1);
});

test('a row with no pane folder has nothing to relaunch into', () => {
  assert.deepEqual(benchEntries([row({ paneCwd: null })]), []);
});

test('what a saved row records is the live pane, not the launch flags', () => {
  const [e] = benchEntries([row({ bypass: true, pinned: true })]);
  assert.deepEqual(e, {
    folder: '/Users/x/Code/alpha',
    slug: 'main',
    tmuxSession: `${P}alpha-main`,
    skipPermissions: true,
    pinned: true,
  });
});

/* A dispatched worker is not the snapshot going stale, and a dot that lit up every time
   the team got busy would stop meaning anything. */
test('workers do not read as drift', () => {
  const s = new SnapshotStore(tmpStore());
  s.save(benchEntries([row(), row({ tmuxSession: `${P}alpha-lead` })]), 1);
  assert.deepEqual(
    s.drift([
      row(),
      row({ tmuxSession: `${P}alpha-lead` }),
      row({
        tmuxSession: `${P}alpha-fix-the-thing`,
        paneCwd: path.join(WORKTREES_DIR, 'alpha-fix-the-thing'),
        team: { role: 'worker', repo: '/Users/x/Code/alpha', task: 't1' },
      }),
    ]),
    { missing: [], extra: [] },
  );
  s.stop();
});

/* ------------------------------------------------------ lead entries --- */

test('a lead is recognised by its slug, and by its name when the slug is missing', () => {
  assert.equal(isLeadEntry({ slug: 'lead' }), true);
  assert.equal(isLeadEntry({ slug: 'main' }), false);
  assert.equal(isLeadEntry({ slug: 'lead-2' }), false, 'a second session called lead-2 is not the lead');
  assert.equal(
    isLeadEntry({ slug: null, tmuxSession: `${P}alpha-lead`, folder: '/Users/x/Code/alpha' }),
    true,
  );
  assert.equal(
    isLeadEntry({ slug: null, tmuxSession: `${P}alpha-lead`, folder: '/Users/x/Code/beta' }),
    false,
    'a name minted for another folder is not this folder’s lead',
  );
  assert.equal(isLeadEntry(null), false);
});

/* ----------------------------------------------------------- restore --- */

/** Records what each launcher was handed, so a test can see which door an entry went through. */
function launchers({ leadFails = null } = {}) {
  const calls = { sessions: [], leads: [], leadArgs: [] };
  return {
    calls,
    startSession: async (opts) => {
      calls.sessions.push(opts);
      // The real launcher's name, not a stand-in: the live-set bookkeeping is keyed on it.
      return {
        name: sessionName(path.basename(opts.folder), opts.label),
        paneId: `%${calls.sessions.length}`,
      };
    },
    startLead: async (folder, resume) => {
      calls.leads.push(folder);
      calls.leadArgs.push([folder, resume]);
      if (leadFails) throw new Error(leadFails);
      return { name: `${P}alpha-lead`, paneId: '%lead' };
    },
  };
}

test('a saved lead comes back through the lead path, an ordinary session through the other', async () => {
  const l = launchers();
  const results = await restoreSessions(
    [entry('alpha', { slug: 'lead', tmuxSession: `${P}alpha-lead` }), entry('beta')],
    { liveNames: [], ...l },
  );
  assert.deepEqual(l.calls.leads, ['/Users/x/Code/alpha']);
  assert.deepEqual(
    l.calls.sessions.map((c) => [c.folder, c.label]),
    [['/Users/x/Code/beta', 'main']],
  );
  assert.deepEqual(
    results.map((r) => [r.state, r.lead]),
    [['started', true], ['started', false]],
  );
});

/* A bypass lead is not a thing, and the way to keep it not a thing is for the restore
   path to have no argument for it — `startLead` takes positionals and no options bag.
   The arity grew to two when relaunch-all added `resume`; what the assertion is actually
   about is that neither of them is an object, because an object is the shape a stored
   `skipPermissions` could ride in on. */
test('a saved lead carrying skipPermissions does not come back with bypass', async () => {
  const l = launchers();
  await restoreSessions(
    [entry('alpha', { slug: 'lead', tmuxSession: `${P}alpha-lead`, skipPermissions: true })],
    { liveNames: [], ...l },
  );
  assert.deepEqual(l.calls.leads, ['/Users/x/Code/alpha']);
  assert.deepEqual(l.calls.sessions, [], 'never reaches the launcher that takes the flag');
  for (const arg of l.calls.leadArgs[0]) {
    assert.ok(
      arg === null || arg === undefined || typeof arg === 'string',
      'no options bag for a stored flag to ride in on',
    );
  }
});

test('an ordinary session keeps its bypass across the restore', async () => {
  const l = launchers();
  await restoreSessions([entry('alpha', { skipPermissions: true })], { liveNames: [], ...l });
  assert.equal(l.calls.sessions[0].skipPermissions, true);
});

/* Skipping is what stops a second press minting `-2`s — and for a lead it is what stops
   the one-lead-per-project refusal being reported as a failure. */
test('a lead already running is skipped, not launched again', async () => {
  const l = launchers();
  const results = await restoreSessions(
    [entry('alpha', { slug: 'lead', tmuxSession: `${P}alpha-lead` })],
    { liveNames: [`${P}alpha-lead`], ...l },
  );
  assert.deepEqual(l.calls.leads, []);
  assert.equal(results[0].state, 'skipped');
});

test('a lead that will not launch takes only itself down', async () => {
  const l = launchers({ leadFails: 'Not a git repository' });
  const results = await restoreSessions(
    [entry('alpha', { slug: 'lead', tmuxSession: `${P}alpha-lead` }), entry('beta')],
    { liveNames: [], ...l },
  );
  assert.deepEqual(
    results.map((r) => r.state),
    ['failed', 'started'],
  );
  assert.equal(results[0].error, 'Not a git repository');
  assert.equal(l.calls.sessions.length, 1);
});

/* A name that comes up during the restore must not be launched twice by a later entry —
   two saved rows can share a name if the file was hand-edited. */
test('a name started earlier in the run counts as live for what follows', async () => {
  const l = launchers();
  const results = await restoreSessions([entry('alpha'), entry('alpha')], { liveNames: [], ...l });
  assert.deepEqual(
    results.map((r) => r.state),
    ['started', 'skipped'],
  );
});

/* No field was added for lead-ness, and this is the reason: the maintainer has a snapshot saved
   from before any of this, and `slug: "lead"` was already in it. */
test('a snapshot.json written before leads restored properly still restores its lead', async () => {
  const file = tmpStore();
  fs.writeFileSync(
    file,
    JSON.stringify({
      savedAt: 1000,
      sessions: [
        { folder: '/Users/x/Code/alpha', slug: 'lead', tmuxSession: `${P}alpha-lead`, skipPermissions: false, pinned: true },
        { folder: '/Users/x/Code/beta', slug: 'main', tmuxSession: `${P}beta-main`, skipPermissions: false, pinned: false },
      ],
    }),
  );
  const store = new SnapshotStore(file);
  const l = launchers();
  const results = await restoreSessions(store.get().sessions, { liveNames: [], ...l });
  assert.deepEqual(l.calls.leads, ['/Users/x/Code/alpha']);
  assert.deepEqual(
    results.map((r) => r.lead),
    [true, false],
  );
  store.stop();
});

/* Pins are replayed by the caller off `paneId` + the saved flag; the lead's own launcher
   pins it from birth, so the step has to say which kind it was. */
test('every started step carries its pane and whether it was the lead', async () => {
  const l = launchers();
  const seen = [];
  const results = await restoreSessions(
    [entry('alpha', { slug: 'lead', tmuxSession: `${P}alpha-lead`, pinned: false }), entry('beta', { pinned: true })],
    { liveNames: [], ...l, onStep: (step, e) => seen.push([step.state, step.paneId, step.lead, e.pinned]) },
  );
  assert.deepEqual(seen, [
    ['started', '%lead', true, false],
    ['started', '%1', false, true],
  ]);
  assert.equal(results.length, 2);
});

/* ------------------------------------------------- relaunch all --- */

/* The refusal is the feature. A worker cannot be put back — `restoreSessions` has no path
   to a worker brief or the `foreman` tools — so a relaunch that stepped around one would leave
   it on the old Claude Code build, which is the thing the button exists to prevent. */
test('a live worker is what makes a relaunch refuse, and it is named', () => {
  const worker = row({
    tmuxSession: `${P}alpha-fix-the-thing`,
    paneCwd: path.join(WORKTREES_DIR, 'alpha-fix-the-thing'),
    team: { role: 'worker', repo: '/Users/x/Code/alpha', task: 't1' },
  });
  assert.deepEqual(
    liveWorkers([row(), row({ tmuxSession: `${P}alpha-lead`, team: { role: 'lead' } }), worker]).map(
      (w) => w.tmuxSession,
    ),
    [`${P}alpha-fix-the-thing`],
  );
});

test('a bench of your own sessions and a lead has no workers to refuse over', () => {
  assert.deepEqual(
    liveWorkers([row(), row({ tmuxSession: `${P}alpha-lead`, team: { role: 'lead', tasks: 1 } })]),
    [],
  );
});

/* Both halves again, and for the same reason `benchEntries` needs both: the role goes null
   when the task closes, while the doomed checkout is still what the pane sits in. */
test('a worker whose task has closed still refuses a relaunch', () => {
  const orphan = row({
    tmuxSession: `${P}alpha-fix-the-thing`,
    paneCwd: path.join(WORKTREES_DIR, 'alpha-fix-the-thing'),
    team: null,
  });
  assert.equal(liveWorkers([orphan]).length, 1);
});

/* The property that matters is not that the filter is right twice — it is that there is
   one filter. A relaunch must never offer to end a row a snapshot would not save. */
test('a relaunch files exactly the rows a snapshot would save', () => {
  const roster = [
    row({ paneId: '%1' }),
    row({ tmuxSession: `${P}alpha-lead`, paneId: '%2', team: { role: 'lead', tasks: 0 } }),
    row({
      tmuxSession: `${P}alpha-fix-the-thing`,
      paneId: '%3',
      paneCwd: path.join(WORKTREES_DIR, 'alpha-fix-the-thing'),
      team: { role: 'worker', repo: '/Users/x/Code/alpha', task: 't1' },
    }),
  ];
  assert.deepEqual(
    relaunchEntries(roster).map((e) => e.tmuxSession),
    benchEntries(roster).map((e) => e.tmuxSession),
  );
});

test('a relaunch entry carries the pane, which is what /exit is typed into', () => {
  const [e] = relaunchEntries([row({ paneId: '%19' })]);
  assert.equal(e.paneId, '%19');
  assert.equal(e.folder, '/Users/x/Code/alpha');
  assert.equal(e.slug, 'main');
});

const bound = (over = {}) =>
  row({ id: '507be0d1-ab7e-4037-82f2-ddcf8d649f09', transcriptPath: '/p/507be0d1.jsonl', paneId: '%1', ...over });

test('fresh mode carries no session id at all, whatever the roster holds', () => {
  assert.equal(relaunchEntries([bound()])[0].resume, null);
  assert.equal(relaunchEntries([bound()], { resume: false })[0].resume, null);
});

test('resume mode carries the bound row’s own session id', () => {
  assert.equal(relaunchEntries([bound()], { resume: true })[0].resume, '507be0d1-ab7e-4037-82f2-ddcf8d649f09');
});

/* The roster's `id` is two different things, and the synthetic one is not a session id.
   Handing `pane-19` to `--resume` fails the launch — and fails it *after* the old session
   has already been exited, which is the expensive half. */
test('a pane the panel never bound to a history comes back fresh, not broken', () => {
  const unbound = row({ id: 'pane-19', transcriptPath: null, paneId: '%19' });
  assert.equal(relaunchEntries([unbound], { resume: true })[0].resume, null);
});

test('an id that is not shaped like a session id is refused even with a transcript', () => {
  const odd = row({ id: 'pane-19', transcriptPath: '/p/whatever.jsonl', paneId: '%19' });
  assert.equal(relaunchEntries([odd], { resume: true })[0].resume, null);
});

test('a session id with no transcript behind it is refused too', () => {
  const odd = row({ id: '507be0d1-ab7e-4037-82f2-ddcf8d649f09', transcriptPath: null, paneId: '%1' });
  assert.equal(relaunchEntries([odd], { resume: true })[0].resume, null);
});

/* Per-entry, not a mode the loop carries: a bench of one bound session and one bare pane
   is half resumable, and the honest answer for the second half is a fresh session. */
test('resume is decided per row, not for the run', () => {
  const out = relaunchEntries(
    [bound(), row({ id: 'pane-19', transcriptPath: null, paneId: '%19', tmuxSession: `${P}alpha-2` })],
    { resume: true },
  );
  assert.deepEqual(out.map((e) => Boolean(e.resume)), [true, false]);
});

test('a resume id reaches the ordinary launcher, and the step says it was resumed', async () => {
  const l = launchers();
  const results = await restoreSessions([entry('alpha', { resume: 'abc-123' })], { liveNames: [], ...l });
  assert.equal(l.calls.sessions[0].resume, 'abc-123');
  assert.equal(results[0].resumed, true);
});

test('a lead is resumed through the lead launcher, as its second positional', async () => {
  const l = launchers();
  await restoreSessions(
    [entry('alpha', { slug: 'lead', tmuxSession: `${P}alpha-lead`, resume: 'abc-123' })],
    { liveNames: [], ...l },
  );
  assert.deepEqual(l.calls.leadArgs, [['/Users/x/Code/alpha', 'abc-123']]);
});

/* Restoring the saved bench is still fresh, and this is what keeps it that way: nothing
   writes `resume` into `snapshot.json`, so an entry read off disk has none. */
test('a snapshot read off disk restores fresh — no resume, no history', async () => {
  const file = tmpStore();
  const a = new SnapshotStore(file);
  a.save(relaunchEntries([bound()], { resume: true }), 1);
  a.flush();
  a.stop();

  const saved = new SnapshotStore(file);
  assert.equal('resume' in saved.get().sessions[0], false, 'the store never writes the field');
  const l = launchers();
  const results = await restoreSessions(saved.get().sessions, { liveNames: [], ...l });
  assert.equal(l.calls.sessions[0].resume, null);
  assert.equal(results[0].resumed, false);
  saved.stop();
});

/* A garbage `resume` is not a resume. The entry file is hand-editable and the flag ends up
   on a command line. */
test('a resume that is not a string is dropped rather than passed on', async () => {
  const l = launchers();
  await restoreSessions([entry('alpha', { resume: 42 }), entry('beta', { resume: '' })], {
    liveNames: [],
    ...l,
  });
  assert.deepEqual(l.calls.sessions.map((c) => c.resume), [null, null]);
});
