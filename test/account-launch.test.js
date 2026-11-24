import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  BYPASS_CONFIRM_WHY,
  DEFAULT_CONFIG_DIR,
  bypassConfirmProblem,
  checkedLaunchDir,
  launchAccountChoices,
  launchConfigDir,
  readAccount,
  recordConfigDir,
  resumeRootProblem,
  rowConfigDir,
} from '../server/account.js';
import { claudeCommand, createSession } from '../server/launch.js';
import { HibernateStore, sleepRecord, sleepVerdict } from '../server/hibernate.js';
import {
  SnapshotStore,
  UNKNOWN_ACCOUNT_WHY,
  benchEntries,
  relaunchEntries,
  relaunchOne,
  restoreSessions,
  sleeperEntries,
} from '../server/snapshot.js';
import { SESSION_PREFIX } from '../server/config.js';

/*
 * Launching on an account, and keeping it — the plan's item 5, which lifts item 1's fence.
 * Every path that starts a session again carries the account it was on (`configDir`, `null`
 * the default), a resume is refused before anything ends when its conversation is filed
 * under another account, and a bypass launch onto an account that never accepted bypass
 * mode is refused rather than stranded on the startup warning (Q6, measured).
 *
 * Fixture rows only; the uuids, addresses and the second dir are made up. The default dir
 * is this machine's own, read from `DEFAULT_CONFIG_DIR`, so no home directory is written here.
 */
const P = SESSION_PREFIX;
const UUID = '00000000-0000-4000-8000-000000000001';
const SID = '507be0d1-ab7e-4037-82f2-ddcf8d649f09';
const HOUR = 60 * 60_000;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const OTHER_DIR = '/Users/tester/.claude-work';
const ALPHA = '/Users/x/Code/alpha';

const transcriptIn = (configDir, id = SID) => path.join(configDir, 'projects', '-Users-x-Code-alpha', `${id}.jsonl`);

const acct = (over = {}) => ({
  dir: DEFAULT_CONFIG_DIR,
  configDir: '~/.claude',
  folder: 'default',
  explicit: false,
  uuid: UUID,
  email: 'one@example.com',
  plan: 'Max 5x',
  signedIn: true,
  nickname: null,
  ...over,
});
const OTHER = acct({ dir: OTHER_DIR, configDir: OTHER_DIR, folder: '.claude-work', explicit: true });

const row = (over = {}) => ({
  id: SID,
  transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR),
  paneId: '%7',
  tmuxSession: `${P}alpha-main`,
  paneCwd: ALPHA,
  title: 'alpha-main',
  team: null,
  status: 'idle',
  queued: [],
  background: { agents: 0, shells: 0, monitors: 0 },
  unread: 0,
  needsYou: false,
  bypass: false,
  pinned: false,
  account: acct(),
  ...over,
});
const otherRow = (over = {}) => row({ account: OTHER, transcriptPath: transcriptIn(OTHER_DIR), ...over });

const ctx = () => ({
  now: NOW,
  afterMs: HOUR,
  sessions: [],
  live: { state: 'idle' },
  held: 0,
  idleSince: NOW - 2 * HOUR,
  cron: { blocked: false, why: null },
  lock: null,
  pids: [4242],
  composerEmpty: true,
  keepAwake: false,
  watched: false,
});

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ------------------------------------------------------------ the command --- */

test('a default launch is byte-identical: no prefix, unset, null, or the default dir named', () => {
  const args = { resume: 'abc-123', extraArgs: ['--settings', '/s.json', '--model', 'claude-opus-5-5'] };
  const before = "claude --resume 'abc-123' '--settings' '/s.json' '--model' 'claude-opus-5-5'";
  assert.equal(claudeCommand(args), before);
  assert.equal(claudeCommand({ ...args, configDir: null }), before);
  assert.equal(claudeCommand({ ...args, configDir: DEFAULT_CONFIG_DIR }), before);
  assert.equal(claudeCommand({ ...args, configDir: `${DEFAULT_CONFIG_DIR}/` }), before);
  assert.ok(!claudeCommand(args).includes('CLAUDE_CONFIG_DIR'));
});

test('another account rides as a shell-quoted prefix, before the bare word claude', () => {
  assert.equal(
    claudeCommand({ configDir: OTHER_DIR, skipPermissions: true, extraArgs: ['--model', 'm'] }),
    `CLAUDE_CONFIG_DIR='${OTHER_DIR}' claude --dangerously-skip-permissions '--model' 'm'`,
  );
  // A space and a quote in the path stay one word, and nothing after them runs.
  assert.equal(
    claudeCommand({ configDir: "/Users/t/it's here; rm -rf ~" }),
    `CLAUDE_CONFIG_DIR='/Users/t/it'\\''s here; rm -rf ~' claude`,
  );
});

test('a launch only starts on a dir the panel detected — never one a request named', () => {
  const known = [DEFAULT_CONFIG_DIR, OTHER_DIR];
  assert.equal(checkedLaunchDir(null, known), null);
  assert.equal(checkedLaunchDir(DEFAULT_CONFIG_DIR, known), null);
  assert.equal(checkedLaunchDir(OTHER_DIR, known), OTHER_DIR);
  assert.throws(() => checkedLaunchDir('/Users/tester/.claude-evil', known), /Not an account this panel has seen/);
  assert.throws(() => checkedLaunchDir('~/.claude-work', known), /absolute/);
  assert.throws(() => checkedLaunchDir(OTHER_DIR, null), /Not an account/);
});

test('createSession refuses an unknown dir, and a bypass onto an unaccepted one, before tmux is touched', async () => {
  const folder = tmp('foreman-acct-folder-');
  const dir = tmp('foreman-acct-');
  await assert.rejects(createSession({ folder, configDir: '/Users/tester/.claude-evil', knownDirs: [DEFAULT_CONFIG_DIR] }), /Not an account/);
  await assert.rejects(createSession({ folder, configDir: dir }), /Not an account/, 'no known list is no account');
  await assert.rejects(
    createSession({ folder, configDir: dir, knownDirs: [DEFAULT_CONFIG_DIR, dir], skipPermissions: true }),
    (err) => err.message === `Not started: ${BYPASS_CONFIRM_WHY}.`,
  );
});

/* ------------------------------------------------------------ which account --- */

test('a row’s account comes off the process, and off its transcript when the process is unreadable', () => {
  assert.equal(rowConfigDir(row()), null);
  assert.equal(rowConfigDir(otherRow()), OTHER_DIR);
  // `ps` failed: the transcript's own root answers.
  assert.equal(rowConfigDir(otherRow({ account: null })), OTHER_DIR);
  assert.equal(rowConfigDir(row({ account: null })), null);
  assert.equal(rowConfigDir(row({ account: null, transcriptPath: null })), null);
  // Positively another account, with no dir anywhere: unsayable, which a launch refuses.
  assert.equal(rowConfigDir(row({ account: { ...OTHER, dir: undefined }, transcriptPath: null })), undefined);
  // The display form is never used: a `~` path is not a dir.
  assert.equal(rowConfigDir(row({ account: { ...OTHER, dir: '~/.claude-work' }, transcriptPath: null })), undefined);
});

test('a record without the field is read by its transcript, then as the default', () => {
  assert.equal(recordConfigDir({ configDir: OTHER_DIR }), OTHER_DIR);
  assert.equal(recordConfigDir({ configDir: null, transcriptPath: transcriptIn(OTHER_DIR) }), null);
  assert.equal(recordConfigDir({ transcriptPath: transcriptIn(OTHER_DIR) }), OTHER_DIR);
  assert.equal(recordConfigDir({ transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR) }), null);
  assert.equal(recordConfigDir({}), null);
  assert.equal(launchConfigDir('relative/dir'), null);
});

/* ------------------------------------------------------------ the resume check --- */

test('a resume onto the account its conversation is not filed under is refused, in words', () => {
  assert.equal(resumeRootProblem(transcriptIn(OTHER_DIR), OTHER_DIR), null);
  assert.equal(resumeRootProblem(transcriptIn(DEFAULT_CONFIG_DIR), null), null);
  const why = resumeRootProblem(transcriptIn(DEFAULT_CONFIG_DIR), OTHER_DIR);
  assert.match(why, /filed under .* where a resume finds nothing/);
  assert.ok(resumeRootProblem(transcriptIn(OTHER_DIR), null));
  // A path under no `projects/` says nothing about an account and refuses nothing.
  assert.equal(resumeRootProblem('/p/507be0d1.jsonl', OTHER_DIR), null);
});

test('restore refuses a mismatched resume without launching, and hands the account to both launchers', async () => {
  const calls = [];
  const startSession = async (o) => (calls.push(['session', o]), { name: `${P}alpha-main`, paneId: '%1' });
  const startLead = async (...a) => (calls.push(['lead', a]), { name: `${P}beta-lead`, paneId: '%2' });
  const results = await restoreSessions(
    [
      { folder: ALPHA, slug: 'main', tmuxSession: `${P}alpha-main`, configDir: OTHER_DIR, resume: SID, transcriptPath: transcriptIn(OTHER_DIR) },
      { folder: '/Users/x/Code/beta', slug: 'lead', tmuxSession: `${P}beta-lead`, configDir: OTHER_DIR, resume: null },
      { folder: '/Users/x/Code/gamma', slug: 'main', tmuxSession: `${P}gamma-main`, configDir: OTHER_DIR, resume: SID, transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR) },
      { folder: '/Users/x/Code/gamma', slug: 'two', tmuxSession: `${P}gamma-two` }, // a rollback-shaped entry
    ],
    { liveNames: [], startSession, startLead },
  );
  assert.deepEqual(results.map((r) => r.state), ['started', 'started', 'failed', 'started']);
  assert.match(results[2].error, /^Not resumed: /);
  assert.deepEqual(calls[0], ['session', { folder: ALPHA, label: 'main', skipPermissions: false, resume: SID, configDir: OTHER_DIR }]);
  assert.deepEqual(calls[1], ['lead', ['/Users/x/Code/beta', null, OTHER_DIR]]);
  assert.equal(calls[2][1].configDir, null, 'no field is the default');
  assert.equal(calls.length, 3, 'the refused entry launched nothing');
});

/* ------------------------------------------------------------ Q6: bypass --- */

test('a bypass launch onto an account that never accepted bypass mode is refused (Q6)', () => {
  const dir = tmp('foreman-acct-');
  assert.equal(bypassConfirmProblem(dir), BYPASS_CONFIRM_WHY, 'no settings file');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"theme":"dark"}');
  assert.equal(bypassConfirmProblem(dir), BYPASS_CONFIRM_WHY, 'the key absent');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"skipDangerousModePermissionPrompt": true}');
  assert.equal(bypassConfirmProblem(dir), null);
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
  assert.equal(bypassConfirmProblem(dir), BYPASS_CONFIRM_WHY, 'unreadable is a refusal');
  // The default dir is never asked.
  assert.equal(bypassConfirmProblem(null, { readFile: () => { throw new Error('read'); } }), null);
});

test('the measured warning box is a dialog nothing answers, at both widths', async () => {
  const { parsePane } = await import('../server/tmux.js');
  for (const f of ['dialog-bypass-confirm.txt', 'dialog-bypass-confirm-narrow.txt']) {
    const pane = parsePane(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
    assert.equal(pane.state, 'dialog', f);
    assert.equal(pane.prompt, null, f);
    assert.equal(pane.question, null, f);
    assert.equal(pane.plan, null, f);
  }
});

/* ------------------------------------------------------------ restart one: the fence is lifted --- */

test('restart-one restarts another account’s session now, carrying the account', () => {
  for (const mode of ['fresh', 'resume']) {
    const out = relaunchOne(otherRow(), { mode });
    assert.equal(out.error, undefined, out.error);
    assert.equal(out.entry.configDir, OTHER_DIR);
    assert.equal(out.entry.resume, mode === 'resume' ? SID : null);
  }
  const plain = relaunchOne(row(), { mode: 'resume' });
  assert.equal(plain.entry.configDir, null);
});

test('restart-one refuses, before anything ends, a resume its account would not find', () => {
  const out = relaunchOne(otherRow({ transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR) }), { mode: 'resume' });
  assert.equal(out.status, 409);
  assert.equal(out.why, 'account');
  assert.match(out.error, /^Not restarted: its conversation is filed under/);
  // Fresh has no conversation to find, so it is not refused.
  assert.ok(relaunchOne(otherRow({ transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR) }), { mode: 'fresh' }).entry);
});

test('restart-one refuses a bypass session on an account that never accepted bypass mode', () => {
  const dir = tmp('foreman-acct-');
  const r = otherRow({ bypass: true, account: { ...OTHER, dir }, transcriptPath: transcriptIn(dir) });
  const out = relaunchOne(r, { mode: 'resume' });
  assert.equal(out.why, 'account');
  assert.ok(out.error.includes(BYPASS_CONFIRM_WHY));
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"skipDangerousModePermissionPrompt":true}');
  assert.equal(relaunchOne(r, { mode: 'resume' }).entry.configDir, dir);
});

test('an unsayable other account is still refused, in words', () => {
  const out = relaunchOne(row({ account: { ...OTHER, dir: undefined }, transcriptPath: null }), { mode: 'fresh' });
  assert.equal(out.why, 'account');
  assert.ok(out.error.includes(UNKNOWN_ACCOUNT_WHY));
});

/* ------------------------------------------------------------ relaunch all --- */

test('relaunch-all relaunches another account’s row on that account, and reports what it leaves', () => {
  const entries = relaunchEntries(
    [
      row(),
      otherRow({ tmuxSession: `${P}beta-main`, paneCwd: '/Users/x/Code/beta' }),
      otherRow({ tmuxSession: `${P}gamma-main`, paneCwd: '/Users/x/Code/gamma', transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR) }),
    ],
    { resume: true },
  );
  assert.deepEqual(
    entries.map((e) => [e.tmuxSession, e.configDir, e.resume, Boolean(e.skip)]),
    [
      [`${P}alpha-main`, null, SID, false],
      [`${P}beta-main`, OTHER_DIR, SID, false],
      [`${P}gamma-main`, OTHER_DIR, SID, true],
    ],
  );
  assert.equal(entries[1].transcriptPath, transcriptIn(OTHER_DIR), 'the file the backstop checks');
});

/* ------------------------------------------------------------ a save, and drift --- */

test('a save keeps another account’s row now, with its account; only an unsayable one is left out', () => {
  const entries = benchEntries([
    row({ tmuxSession: `${P}gamma-main`, paneCwd: '/Users/x/Code/gamma' }),
    otherRow(),
    row({ tmuxSession: `${P}beta-main`, paneCwd: '/Users/x/Code/beta', account: { ...OTHER, dir: undefined }, transcriptPath: null }),
  ]);
  assert.deepEqual(
    entries.map((e) => [e.tmuxSession, e.configDir]),
    [
      [`${P}gamma-main`, null],
      [`${P}alpha-main`, OTHER_DIR],
    ],
  );
  assert.equal(entries.every((e) => !('skip' in e)), true);
});

test('configDir survives the snapshot’s trip to disk, through both field lists', () => {
  const file = path.join(tmp('foreman-acct-'), 'snapshot.json');
  const a = new SnapshotStore(file);
  a.save(benchEntries([row(), otherRow({ tmuxSession: `${P}beta-main`, paneCwd: '/Users/x/Code/beta' })]), 1);
  assert.deepEqual(a.get().sessions.map((e) => e.configDir), [null, OTHER_DIR], 'save keeps it');
  a.stop();
  const b = new SnapshotStore(file);
  assert.deepEqual(b.get().sessions.map((e) => e.configDir), [null, OTHER_DIR], 'load keeps it');
  // Saved, it is not drift.
  assert.deepEqual(b.drift([row(), otherRow({ tmuxSession: `${P}beta-main`, paneCwd: '/Users/x/Code/beta' })]), { missing: [], extra: [] });
  b.stop();
});

test('a rollback-shaped snapshot (no configDir) reads as the default, and so does a non-path', () => {
  const file = path.join(tmp('foreman-acct-'), 'snapshot.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      savedAt: 1,
      sessions: [
        { folder: ALPHA, slug: 'main', tmuxSession: `${P}alpha-main`, skipPermissions: false, pinned: false },
        { folder: ALPHA, slug: 'two', tmuxSession: `${P}alpha-two`, configDir: '~/.claude-work' },
        { folder: ALPHA, slug: 'three', tmuxSession: `${P}alpha-three`, configDir: DEFAULT_CONFIG_DIR },
      ],
    }),
  );
  const s = new SnapshotStore(file);
  assert.deepEqual(s.get().sessions.map((e) => e.configDir), [null, null, null]);
  s.stop();
});

/* ------------------------------------------------------------ hibernation --- */

test('hibernation may sleep another account’s session now, and the record keeps its account', () => {
  assert.deepEqual(sleepVerdict(otherRow(), ctx()), { ok: true });
  assert.deepEqual(sleepVerdict(row({ account: null }), ctx()), { ok: true });
  assert.equal(sleepRecord(otherRow()).configDir, OTHER_DIR);
  assert.equal(sleepRecord(row()).configDir, null);
});

test('hibernation says no where a wake would fail on the account, with the reason in words', () => {
  const out = sleepVerdict(otherRow({ transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR) }), ctx());
  assert.equal(out.ok, false);
  assert.equal(out.rule, 'account');
  assert.match(out.why, /^its conversation is filed under/);
});

test('a sleep record keeps configDir across the store’s reload, and a rollback record falls back', () => {
  const dir = tmp('foreman-acct-');
  const s = new HibernateStore(path.join(dir, 'hibernate.json'), { flushMs: 60_000 });
  s.put(sleepRecord(otherRow(), { now: NOW }));
  s.stop();
  const t = new HibernateStore(path.join(dir, 'hibernate.json'), { flushMs: 60_000 });
  const rec = t.get(`${P}alpha-main`);
  assert.equal(rec.configDir, OTHER_DIR);
  assert.equal(recordConfigDir(rec), OTHER_DIR);
  t.stop();
  const { configDir: _gone, ...rollback } = rec;
  assert.equal(recordConfigDir(rollback), OTHER_DIR, 'by its transcript');
  assert.equal(recordConfigDir({ ...rollback, transcriptPath: transcriptIn(DEFAULT_CONFIG_DIR) }), null);
  // A save of the sleeper carries it into the snapshot.
  assert.equal(sleeperEntries([rec])[0].configDir, OTHER_DIR);
  assert.equal(sleeperEntries([rollback])[0].configDir, OTHER_DIR);
});

/* ------------------------------------------------------------ + new's picker --- */

test('the + new picker lists the default first, then signed-in other dirs by nickname, by key', async () => {
  const home = '/Users/tester';
  const files = {
    [`${home}/.claude.json`]: JSON.stringify({ oauthAccount: { accountUuid: UUID, emailAddress: 'one@example.com', organizationType: 'claude_max' } }),
    [`${OTHER_DIR}/.claude.json`]: JSON.stringify({ oauthAccount: { accountUuid: '00000000-0000-4000-8000-000000000002', emailAddress: 'two@example.com', organizationType: 'claude_pro' } }),
    [`${home}/.claude-fresh/.claude.json`]: JSON.stringify({ userID: 'x' }),
  };
  const readFile = async (f) => {
    if (f in files) return files[f];
    throw new Error('ENOENT');
  };
  const choices = await launchAccountChoices([`${home}/.claude`, `${home}/.claude-fresh`, OTHER_DIR, `${home}/.claude-gone`], {
    home,
    readFile,
    nicknames: { '00000000-0000-4000-8000-000000000002': 'work' },
  });
  assert.deepEqual(choices, [
    { key: 0, default: true, folder: 'default', configDir: '~/.claude', nickname: null, plan: 'Max' },
    { key: 2, default: false, folder: '.claude-work', configDir: '~/.claude-work', nickname: 'work', plan: 'Pro' },
  ]);
  assert.ok(!JSON.stringify(choices).includes('@'), 'no email in a label');
});

test('readAccount still says whether the dir is another one, and CLAUDE_CONFIG_DIR=~/.claude is not', () => {
  const HOME = '/Users/tester';
  const fresh = '{"userID":"x"}';
  assert.equal(readAccount(fresh, { configDir: `${HOME}/.claude-work`, explicit: true }, HOME).explicit, true);
  assert.equal(readAccount(fresh, { configDir: `${HOME}/.claude`, explicit: false }, HOME).explicit, false);
  assert.equal(readAccount(fresh, { configDir: `${HOME}/.claude`, explicit: true }, HOME).explicit, false);
});
