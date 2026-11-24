import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AccountReader,
  accountFileFor,
  claudePidFor,
  configDirFromPs,
  parseProcessTable,
  planLabel,
  readAccount,
  shortPath,
  withNickname,
} from '../server/account.js';

/*
 * `server/account.js`: pane → claude pid → config dir → account record.
 *
 * The `ps` fixtures are the measured *shape* of `ps -A -o pid=,ppid=,comm=` and
 * `ps -E -ww -p <pid> -o command=` on macOS with Claude Code v2.1.322 — argv first, then the
 * environment, space-joined — with every value replaced by a fake one. The account files are
 * built in a real temp directory, because the cache's whole job is what it does *not* read.
 */

const FIX = path.join(import.meta.dirname, 'fixtures');
const HOME = '/Users/tester';
const TABLE = fs.readFileSync(path.join(FIX, 'ps-table-account.txt'), 'utf8');
const ENV_DEFAULT = fs.readFileSync(path.join(FIX, 'ps-env-default.txt'), 'utf8');
const ENV_WORK = fs.readFileSync(path.join(FIX, 'ps-env-work.txt'), 'utf8');

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const signedIn = (uuid, email, tier = 'default_claude_max_5x', type = 'claude_max') =>
  JSON.stringify({
    numStartups: 3,
    projects: { '/Users/tester/alpha': {} },
    oauthAccount: {
      accountUuid: uuid,
      emailAddress: email,
      displayName: 'Tester',
      organizationName: "Tester's Organization",
      organizationType: type,
      organizationRateLimitTier: tier,
    },
  });

/* ───────────────────────────────────────────────────────── the process table ── */

test('the process table parses, with a comm that has spaces in it', () => {
  const t = parseProcessTable(TABLE);
  assert.deepEqual(t.get(9011), { ppid: 9010, comm: 'claude' });
  assert.equal(t.get(9050).comm, '/Applications/Some App.app/Contents/MacOS/Some App');
  assert.equal(parseProcessTable('').size, 0);
});

test('claude is the pane shell’s child, or the pane pid itself when the shell exec’d it', () => {
  const t = parseProcessTable(TABLE);
  assert.equal(claudePidFor(9010, t), 9011); // `zsh -ilc claude`, measured
  assert.equal(claudePidFor(9030, t), 9030); // exec'd
  // The shallowest claude wins: 9021's own child shell is not a second session.
  assert.equal(claudePidFor(9020, t), 9021);
  assert.equal(claudePidFor(9040, t), null); // a pane running node, not claude
  assert.equal(claudePidFor(424242, t), null); // gone
  assert.equal(claudePidFor(9010, new Map()), null);
});

/* ──────────────────────────────────────────────────────────── the config dir ── */

test('no CLAUDE_CONFIG_DIR is the default dir, and the account file is in HOME beside it', () => {
  const dir = configDirFromPs(ENV_DEFAULT, HOME);
  assert.deepEqual(dir, { configDir: '/Users/tester/.claude', explicit: false });
  assert.equal(accountFileFor(dir, HOME), '/Users/tester/.claude.json');
});

test('CLAUDE_CONFIG_DIR set puts the account file inside that dir — measured', () => {
  const dir = configDirFromPs(ENV_WORK, HOME);
  assert.deepEqual(dir, { configDir: '/Users/tester/.claude-work', explicit: true });
  assert.equal(accountFileFor(dir, HOME), '/Users/tester/.claude-work/.claude.json');
});

test('a config dir with a space in it survives, and ~ is expanded', () => {
  const line = 'claude CLAUDE_CONFIG_DIR=/Users/tester/My Claude HOME=/Users/tester TMUX_PANE=%3';
  assert.equal(configDirFromPs(line, HOME).configDir, '/Users/tester/My Claude');
  const tilde = 'claude CLAUDE_CONFIG_DIR=~/.claude-work HOME=/Users/tester';
  assert.equal(configDirFromPs(tilde, HOME).configDir, '/Users/tester/.claude-work');
  // A trailing slash is the same folder.
  const slash = 'claude HOME=/Users/tester CLAUDE_CONFIG_DIR=/Users/tester/.claude-work/';
  assert.equal(configDirFromPs(slash, HOME).configDir, '/Users/tester/.claude-work');
});

test('the environment wins over an argument that spells the same text', () => {
  const line = 'claude -p CLAUDE_CONFIG_DIR=/nope HOME=/Users/tester CLAUDE_CONFIG_DIR=/Users/tester/.claude-work';
  assert.equal(configDirFromPs(line, HOME).configDir, '/Users/tester/.claude-work');
});

test('no visible environment is unknown, not the default — another user’s process', () => {
  assert.equal(configDirFromPs('claude --name alpha-main', HOME), null);
  assert.equal(configDirFromPs('', HOME), null);
});

test('a relative CLAUDE_CONFIG_DIR is unknown, since its cwd is not ours to see', () => {
  assert.equal(configDirFromPs('claude CLAUDE_CONFIG_DIR=work HOME=/Users/tester', HOME), null);
});

/* ─────────────────────────────────────────────────────────── the account file ── */

test('a signed-in account file gives uuid, email, plan and the folder', () => {
  const a = readAccount(signedIn(UUID_A, 'alpha@example.com'), { configDir: '/Users/tester/.claude', explicit: false }, HOME);
  assert.deepEqual(a, {
    dir: '/Users/tester/.claude',
    configDir: '~/.claude',
    folder: 'default',
    uuid: UUID_A,
    email: 'alpha@example.com',
    plan: 'Max 5x',
    signedIn: true,
  });
  // Nothing else in the file rides along.
  assert.equal('projects' in a, false);
  assert.equal('displayName' in a, false);
});

test('a dir nobody has logged into reads as not signed in, with its folder name', () => {
  // The measured shape: a fresh CLAUDE_CONFIG_DIR at the login screen has a `.claude.json`
  // with bookkeeping keys and no `oauthAccount`.
  const fresh = JSON.stringify({ firstStartTime: '2026-11-22T00:00:00.000Z', userID: 'x', migrationVersion: 3 });
  const a = readAccount(fresh, { configDir: '/Users/tester/.claude-work', explicit: true }, HOME);
  assert.deepEqual(a, {
    dir: '/Users/tester/.claude-work',
    configDir: '~/.claude-work',
    folder: '.claude-work',
    uuid: null,
    email: null,
    plan: null,
    signedIn: false,
  });
});

test('an unparseable or non-object file is unknown', () => {
  const dir = { configDir: '/Users/tester/.claude', explicit: false };
  assert.equal(readAccount('{not json', dir, HOME), null);
  assert.equal(readAccount('[]', dir, HOME), null);
  assert.equal(readAccount('null', dir, HOME), null);
});

test('plan labels come off the tier, then the type, and nothing is guessed', () => {
  assert.equal(planLabel({ organizationRateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(planLabel({ organizationRateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(planLabel({ organizationType: 'claude_pro' }), 'Pro');
  assert.equal(planLabel({ organizationType: 'claude_team' }), 'Team');
  assert.equal(planLabel({ organizationType: 'something_else' }), null);
  assert.equal(planLabel(null), null);
});

test('shortPath tildes the home dir only', () => {
  assert.equal(shortPath('/Users/tester/.claude', HOME), '~/.claude');
  assert.equal(shortPath('/Users/testerx/.claude', HOME), '/Users/testerx/.claude');
  assert.equal(shortPath(HOME, HOME), '~');
});

test('withNickname adds the nickname by uuid and nothing for an unsigned dir', () => {
  const a = { uuid: UUID_A, folder: 'default' };
  assert.equal(withNickname(a, { [UUID_A]: 'Personal' }).nickname, 'Personal');
  assert.equal(withNickname(a, {}).nickname, null);
  assert.equal(withNickname({ uuid: null, folder: '.claude-work' }, { [UUID_A]: 'Personal' }).nickname, null);
  assert.equal(withNickname(null, { [UUID_A]: 'Personal' }), null);
});

/* ─────────────────────────────────────────────────────────────── the reader ── */

/** A reader over a real temp HOME, with `ps` answered from the fixtures and counted. */
async function bench() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-account-'));
  await fsp.writeFile(path.join(home, '.claude.json'), signedIn(UUID_A, 'alpha@example.com'));
  await fsp.mkdir(path.join(home, '.claude-work'));
  await fsp.writeFile(path.join(home, '.claude-work', '.claude.json'), JSON.stringify({ userID: 'x' }));
  const fix = (s) => s.replaceAll('/Users/tester', home);
  const envs = new Map([
    [9011, fix(ENV_DEFAULT)],
    [9021, fix(ENV_WORK)],
  ]);
  const alive = new Set([9011, 9021]);
  const ps = { table: fix(TABLE), calls: [] };
  let clock = 1_000_000;
  const reader = new AccountReader({
    home,
    now: () => clock,
    alive: (pid) => alive.has(pid),
    ps: async (args) => {
      ps.calls.push(args.join(' '));
      if (args[0] === '-A') return ps.table;
      const pid = Number(args[args.indexOf('-p') + 1]);
      if (!envs.has(pid)) throw new Error('no such process');
      return envs.get(pid);
    },
  });
  return { home, reader, ps, envs, alive, tick: (ms) => (clock += ms) };
}

const PANES = [
  { paneId: '%0', pid: 9010 },
  { paneId: '%1', pid: 9020 },
];

test('the reader answers each pane, signed in and not', async () => {
  const b = await bench();
  try {
    const got = await b.reader.forPanes(PANES);
    assert.equal(got.get('%0').uuid, UUID_A);
    assert.equal(got.get('%0').folder, 'default');
    assert.equal(got.get('%0').plan, 'Max 5x');
    assert.equal(got.get('%1').signedIn, false);
    assert.equal(got.get('%1').folder, '.claude-work');
    assert.deepEqual(b.reader.known().map((a) => a.uuid), [UUID_A]);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('a steady roster runs no subprocess and reads no file after the first poll', async () => {
  const b = await bench();
  try {
    await b.reader.forPanes(PANES);
    const after = b.ps.calls.length;
    const reads = b.reader.calls.read;
    assert.equal(after, 3); // one table, one env per claude
    for (let i = 0; i < 5; i += 1) {
      b.tick(2000);
      await b.reader.forPanes(PANES);
    }
    assert.equal(b.ps.calls.length, after);
    // Re-stat'ed past the recheck window, but the mtime did not move, so nothing was parsed.
    assert.equal(b.reader.calls.read, reads);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('a re-login is seen at the next stat, not before', async () => {
  const b = await bench();
  try {
    await b.reader.forPanes(PANES);
    const file = path.join(b.home, '.claude-work', '.claude.json');
    await fsp.writeFile(file, signedIn(UUID_B, 'beta@example.com', '', 'claude_pro'));
    // Push the mtime somewhere a coarse clock cannot confuse with the first write.
    const later = new Date(Date.now() + 5000);
    await fsp.utimes(file, later, later);
    b.tick(1000);
    assert.equal((await b.reader.forPanes(PANES)).get('%1').signedIn, false); // within the window
    b.tick(5000);
    const got = (await b.reader.forPanes(PANES)).get('%1');
    assert.equal(got.uuid, UUID_B);
    assert.equal(got.plan, 'Pro');
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('a claude that restarts in the same shell is found again, with its new env', async () => {
  const b = await bench();
  try {
    await b.reader.forPanes(PANES);
    // 9011 exits; the shell starts a new claude, 9012, on the work dir.
    b.alive.delete(9011);
    b.alive.add(9012);
    b.ps.table = b.ps.table.replace(' 9011  9010 claude', ' 9012  9010 claude');
    b.envs.set(9012, b.envs.get(9021));
    const got = await b.reader.forPanes(PANES);
    assert.equal(got.get('%0').folder, '.claude-work');
    assert.equal(b.ps.calls.filter((c) => c.startsWith('-A')).length, 2);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('a pane that left the roster is forgotten, so a reused pid starts clean', async () => {
  const b = await bench();
  try {
    await b.reader.forPanes(PANES);
    await b.reader.forPanes([PANES[0]]);
    assert.equal(b.reader.claudeOf.has(9020), false);
    assert.equal(b.reader.dirOf.has(9021), false);
    assert.deepEqual(b.reader.known().map((a) => a.uuid), [UUID_A]);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('every failure is a pane with no tag, never a throw', async () => {
  const b = await bench();
  try {
    // ps itself failing.
    const broken = new AccountReader({ home: b.home, ps: async () => { throw new Error('ps gone'); } });
    const got = await broken.forPanes(PANES);
    assert.equal(got.get('%0'), null);
    assert.equal(got.get('%1'), null);
    // A missing account file.
    await fsp.rm(path.join(b.home, '.claude.json'));
    assert.equal((await b.reader.forPanes(PANES)).get('%0'), null);
    // No panes at all.
    assert.equal((await b.reader.forPanes([])).size, 0);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('a file caught unparseable keeps the last good answer until it parses again', async () => {
  const b = await bench();
  try {
    await b.reader.forPanes(PANES);
    const file = path.join(b.home, '.claude.json');
    await fsp.writeFile(file, '{"oauthAccount": {"accountUu');
    const later = new Date(Date.now() + 5000);
    await fsp.utimes(file, later, later);
    b.tick(6000);
    assert.equal((await b.reader.forPanes(PANES)).get('%0').uuid, UUID_A);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('the reader keeps each pane’s config dir, absolute, even where the account file is unreadable', async () => {
  const b = await bench();
  try {
    // The work dir's account file goes away: no tag for that pane, but the dir is still known —
    // the binding fence must not loosen because a label could not be drawn.
    await fsp.rm(path.join(b.home, '.claude-work', '.claude.json'));
    const got = await b.reader.forPanes(PANES);
    assert.equal(got.get('%1'), null);
    assert.equal(b.reader.configDirOf('%0'), path.join(b.home, '.claude'));
    assert.equal(b.reader.configDirOf('%1'), path.join(b.home, '.claude-work'));
    assert.equal(b.reader.configDirOf('%9'), null);
    // Only the explicit one is a candidate for the known list; the default is always on it.
    assert.deepEqual(b.reader.explicitDirs(), [path.join(b.home, '.claude-work')]);
    // A pane that left the roster takes its dir with it.
    await b.reader.forPanes([PANES[0]]);
    assert.equal(b.reader.configDirOf('%1'), null);
    assert.deepEqual(b.reader.explicitDirs(), []);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});

test('the roster’s account carries an absolute dir beside the ~-shortened one', async () => {
  const b = await bench();
  try {
    const got = await b.reader.forPanes(PANES);
    assert.equal(got.get('%0').dir, path.join(b.home, '.claude'));
    assert.equal(got.get('%0').configDir, '~/.claude');
    assert.equal(path.isAbsolute(got.get('%0').dir), true);
  } finally {
    await fsp.rm(b.home, { recursive: true, force: true });
  }
});
