import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { jobEnvironment, legacyJobs } from '../server/install-agent.js';
import { HOME, resolveStateDir } from '../server/config.js';
import { DEFAULT_AGENT_LABEL } from '../server/logs.js';

/*
 * `jobEnvironment` — what goes into the LaunchAgent's `EnvironmentVariables`.
 *
 * This is the first test this installer has had, and it exists because of one line: the
 * host was written as a literal wide bind into **every** plist the installer ever
 * generated, unconditionally. That is what actually exposed a machine — the code
 * default has always been loopback — and it meant a stranger running
 * `npm run install-agent` got a panel answering on their whole local network without ever
 * being asked. Nothing pinned it, so nothing objected.
 *
 * Importing this module used to run `install()` — a plist written into
 * `~/Library/LaunchAgents` and a job bootstrapped, from a test run. It is now guarded on
 * being the process's entry point, which is what makes the function below reachable at
 * all. If that guard is ever removed, this file installs a LaunchAgent.
 *
 * The rest of the installer — `launchctl`, the port takeover, the plist XML — is exercised
 * on a **scratch label** by hand and reported with the change, never here: a unit test
 * that bootstraps jobs is a unit test that can hijack the real panel.
 */

// The same answer the installer computes, from the same resolver — a second spelling of
// a multi-rung default is a test that agrees with itself and not with the code.
const DEFAULT_STATE_DIR = resolveStateDir({ env: {}, home: HOME }).dir;

test('a loopback bind writes no FOREMAN_HOST key at all — the whole of B1b', () => {
  const env = jobEnvironment({ host: '127.0.0.1', port: 48770, stateDir: DEFAULT_STATE_DIR, label: DEFAULT_AGENT_LABEL });
  assert.ok(!('FOREMAN_HOST' in env), `expected no FOREMAN_HOST, got ${JSON.stringify(env.FOREMAN_HOST)}`);
  // …and nothing else creeps in with it. A default install is `PATH` and nothing more.
  assert.deepEqual(Object.keys(env), ['PATH']);
});

test('a wide bind writes the key, so a reinstall carries the decision into the job', () => {
  const env = jobEnvironment({ host: '0.0.0.0', port: 48770, stateDir: DEFAULT_STATE_DIR, label: DEFAULT_AGENT_LABEL });
  assert.equal(env.FOREMAN_HOST, '0.0.0.0');
});

test('any non-default host is written, not just the wide one', () => {
  // Someone binding a single interface is making the same kind of decision as someone
  // binding all of them, and it has to survive a reboot the same way.
  assert.equal(jobEnvironment({ host: '10.0.0.4' }).FOREMAN_HOST, '10.0.0.4');
  assert.equal(jobEnvironment({ host: '::1' }).FOREMAN_HOST, '::1');
});

test('the omit-when-default rule holds for the port, the state dir and the label too', () => {
  const plain = jobEnvironment({ host: '127.0.0.1', port: 48770, stateDir: DEFAULT_STATE_DIR, label: DEFAULT_AGENT_LABEL });
  assert.deepEqual(Object.keys(plain), ['PATH']);

  const scratch = jobEnvironment({
    host: '127.0.0.1',
    port: 48771,
    stateDir: '/tmp/scratch-state',
    label: 'com.example.scratch',
  });
  assert.equal(scratch.FOREMAN_PORT, '48771');
  assert.equal(scratch.FOREMAN_STATE_DIR, '/tmp/scratch-state');
  // The label has to reach the *job*, not just the plist: the boot-time log rotation in
  // `index.js` reads it from the running process's environment, so a scratch job without
  // it truncates the real panel's logs.
  assert.equal(scratch.FOREMAN_AGENT_LABEL, 'com.example.scratch');
  assert.ok(!('FOREMAN_HOST' in scratch));
});

test('PATH is always written, and never carries npm’s node_modules/.bin chain', () => {
  // launchd's own PATH is four directories and `npm` is in none of them. The filtered
  // entries are an artifact of having been started by `npm run`, and would let a daemon
  // resolve binaries out of a checkout that can be deleted.
  const dirs = jobEnvironment().PATH.split(':');
  assert.ok(dirs.includes('/usr/bin'));
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.equal(dirs.filter((d) => d.endsWith('/node_modules/.bin')).length, 0);
  assert.equal(new Set(dirs).size, dirs.length, 'PATH should be deduped');
});

// ---------------------------------------------------------------------------- legacy ---

/*
 * `legacyJobs` — which plists in `~/Library/LaunchAgents` are this panel under a name it no
 * longer uses.
 *
 * The whole point is what it *refuses*. Detection is by shape and not by name — the old
 * label is deliberately not in the code — so the only thing standing between this function
 * and booting out somebody's real, running panel is the rung that leaves a plist alone when
 * its program exists and is a different file. That is also what makes the installer safe to
 * bench from inside a git worktree, where `server/index.js` is a copy of the real one.
 *
 * Plists are described as objects rather than written as XML: `readPlist` is injected for
 * exactly that, and what is under test is the decision, not `plutil`. The real reader is
 * exercised by hand against real plists on a scratch label and reported with the change.
 */

function jobs(entries) {
  // A directory of names, and a reader that answers from the table rather than the disk.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-agents-'));
  const table = new Map();
  for (const [name, job] of Object.entries(entries)) {
    const file = path.join(dir, `${name}.plist`);
    fs.writeFileSync(file, '');
    table.set(file, job);
  }
  return { dir, readPlist: (file) => table.get(file) ?? null };
}

const OURS = '/repo/server/index.js';

test('a plist whose program no longer exists is legacy — the checkout moved out from under it', () => {
  const { dir, readPlist } = jobs({
    'old.job': { Label: 'old.job', ProgramArguments: ['/bin/node', '/gone/server/index.js'] },
  });
  const found = legacyJobs({
    dir, currentLabel: 'dev.foreman.panel', entry: OURS, readPlist,
    exists: (p) => p === OURS, realpath: (p) => p,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].label, 'old.job');
  assert.match(found[0].why, /checkout is gone/);
});

test('a plist that runs this very file is legacy — the same panel installed under two names', () => {
  const { dir, readPlist } = jobs({
    'old.job': { Label: 'old.job', ProgramArguments: ['/bin/node', '/link/server/index.js'] },
  });
  const found = legacyJobs({
    dir, currentLabel: 'dev.foreman.panel', entry: OURS, readPlist,
    exists: () => true,
    // A symlinked checkout resolves to the same file, which is why the comparison is by
    // realpath and not by string.
    realpath: (p) => (p === '/link/server/index.js' ? OURS : p),
  });
  assert.equal(found.length, 1);
  assert.match(found[0].why, /this same file/);
});

test('a plist whose program exists and is a DIFFERENT file is not touched', () => {
  // The rung that protects a real, running panel from an installer benched out of a git
  // worktree — where `server/index.js` exists, and is a copy.
  const { dir, readPlist } = jobs({
    'someone.elses': { Label: 'someone.elses', ProgramArguments: ['/bin/node', '/other/server/index.js'] },
  });
  assert.deepEqual(legacyJobs({
    dir, currentLabel: 'dev.foreman.panel', entry: OURS, readPlist,
    exists: () => true, realpath: (p) => p,
  }), []);
});

test('our own label is never in the list, however it is spelled on disk', () => {
  // The current job is replaced by `bootout` + `bootstrap` further down the installer, not
  // by being displaced — displacing it would delete the plist about to be rewritten.
  const { dir, readPlist } = jobs({
    'whatever': { Label: 'dev.foreman.panel', ProgramArguments: ['/bin/node', OURS] },
  });
  assert.deepEqual(legacyJobs({
    dir, currentLabel: 'dev.foreman.panel', entry: OURS, readPlist,
    exists: () => true, realpath: (p) => p,
  }), []);
});

test('a plist with no server/index.js argument at all is somebody else\'s job', () => {
  const { dir, readPlist } = jobs({
    'com.example.backups': { Label: 'com.example.backups', ProgramArguments: ['/bin/sh', '/opt/backup.sh'] },
    'com.example.noargs': { Label: 'com.example.noargs' },
  });
  assert.deepEqual(legacyJobs({
    dir, currentLabel: 'dev.foreman.panel', entry: OURS, readPlist,
    exists: () => false, realpath: (p) => p,
  }), []);
});

test('an unreadable plist is skipped, not guessed at', () => {
  // `readPlist` answering null is "plutil could not make a job out of this". Treating that
  // as a match would boot out a job on the strength of a file we could not read.
  const { dir, readPlist } = jobs({ 'broken': null });
  assert.deepEqual(legacyJobs({
    dir, currentLabel: 'dev.foreman.panel', entry: OURS, readPlist,
    exists: () => false, realpath: (p) => p,
  }), []);
});

test('a directory that is not there answers nothing rather than throwing', () => {
  assert.deepEqual(legacyJobs({
    dir: path.join(os.tmpdir(), 'foreman-no-such-agents-dir'),
    currentLabel: 'dev.foreman.panel', entry: OURS,
  }), []);
});
