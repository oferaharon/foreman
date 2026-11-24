import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OTHER_ACCOUNT_WHY, onOtherAccount, readAccount } from '../server/account.js';
import { sleepVerdict } from '../server/hibernate.js';
import { SnapshotStore, benchEntries, relaunchEntries, relaunchOne } from '../server/snapshot.js';
import { SESSION_PREFIX } from '../server/config.js';

/*
 * The account fence: a row positively known to run on another Claude account is never
 * ended in order to be started again, saved, or put to sleep, because every launch path
 * here starts plain `claude` — the default account — and a `--resume` of a conversation
 * that lives in another account's folder fails after the old session is already gone.
 * Fixture rows only; the uuids and addresses are made up.
 */
const P = SESSION_PREFIX;
const HOME = '/Users/tester';
const UUID = '00000000-0000-4000-8000-000000000001';
const SID = '507be0d1-ab7e-4037-82f2-ddcf8d649f09';
const HOUR = 60 * 60_000;
const NOW = Date.parse('2026-11-23T12:00:00Z');

const acct = (over = {}) => ({
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
const OTHER = acct({ configDir: '~/.claude-work', folder: '.claude-work', explicit: true });

const row = (over = {}) => ({
  id: SID,
  transcriptPath: '/p/507be0d1.jsonl',
  paneId: '%7',
  tmuxSession: `${P}alpha-main`,
  paneCwd: '/Users/x/Code/alpha',
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

/* ------------------------------------------------------------ the predicate --- */

test('only a row positively on another config dir is on another account', () => {
  assert.equal(onOtherAccount(row({ account: OTHER })), true);
  assert.equal(onOtherAccount(row({ account: acct() })), false); // the default dir
  assert.equal(onOtherAccount(row({ account: null })), false); // unknown is not "other"
  assert.equal(onOtherAccount(row({ account: undefined })), false);
  assert.equal(onOtherAccount(null), false);
  // A fresh dir nobody has logged into is still another dir.
  assert.equal(onOtherAccount(row({ account: { ...OTHER, uuid: null, signedIn: false } })), true);
});

test('readAccount says whether the dir is another one, and CLAUDE_CONFIG_DIR=~/.claude is not', () => {
  const fresh = '{"userID":"x"}';
  const other = readAccount(fresh, { configDir: `${HOME}/.claude-work`, explicit: true }, HOME);
  assert.equal(other.explicit, true);
  assert.equal(readAccount(fresh, { configDir: `${HOME}/.claude`, explicit: false }, HOME).explicit, false);
  // Set explicitly, but to the default folder itself: its conversations are the default's.
  assert.equal(readAccount(fresh, { configDir: `${HOME}/.claude`, explicit: true }, HOME).explicit, false);
});

/* ------------------------------------------------------------ restart one --- */

test('restart-one refuses a row on another account, in words, before anything is built', () => {
  for (const mode of ['fresh', 'resume']) {
    const out = relaunchOne(row({ account: OTHER }), { mode });
    assert.equal(out.entry, undefined);
    assert.equal(out.status, 409);
    assert.equal(out.why, 'account');
    assert.ok(out.error.includes(OTHER_ACCOUNT_WHY), out.error);
  }
});

test('restart-one still restarts the default account and an unknown one', () => {
  for (const account of [acct(), null]) {
    const out = relaunchOne(row({ account }), { mode: 'resume' });
    assert.equal(out.error, undefined);
    assert.equal(out.entry.tmuxSession, `${P}alpha-main`);
    assert.equal(out.entry.resume, SID);
  }
});

/* ------------------------------------------------------------ relaunch all --- */

test('relaunch-all keeps the row but marks it, so it is reported rather than dropped', () => {
  const entries = relaunchEntries(
    [row(), row({ tmuxSession: `${P}beta-main`, paneCwd: '/Users/x/Code/beta', account: OTHER, pinned: true })],
    { resume: true },
  );
  assert.deepEqual(
    entries.map((e) => [e.tmuxSession, e.skip ?? null]),
    [
      [`${P}alpha-main`, null],
      [`${P}beta-main`, OTHER_ACCOUNT_WHY],
    ],
  );
  // The marked entry never carries what would let it be ended or resumed on the wrong account.
  assert.equal(entries[0].resume, SID);
});

test('relaunch-all treats an unknown account exactly as before', () => {
  const [e] = relaunchEntries([row({ account: null })], { resume: true });
  assert.equal(e.skip, undefined);
  assert.equal(e.resume, SID);
});

/* ------------------------------------------------------------ a save --- */

test('a snapshot save leaves a row on another account out, and keeps the rest in order', () => {
  const entries = benchEntries([
    row({ tmuxSession: `${P}gamma-main`, paneCwd: '/Users/x/Code/gamma' }),
    row({ account: OTHER }),
    row({ tmuxSession: `${P}beta-main`, paneCwd: '/Users/x/Code/beta', account: null }),
  ]);
  assert.deepEqual(
    entries.map((e) => e.tmuxSession),
    [`${P}gamma-main`, `${P}beta-main`],
  );
  assert.equal(entries.every((e) => !('skip' in e)), true);
});

test('a session left out of a save does not read as drift for as long as it runs', () => {
  const store = new SnapshotStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-fence-')), 'snapshot.json'));
  store.save(benchEntries([row()]), 1);
  const live = [row(), row({ tmuxSession: `${P}beta-main`, paneCwd: '/Users/x/Code/beta', account: OTHER })];
  assert.deepEqual(store.drift(live), { missing: [], extra: [] });
  store.stop();
});

/* ------------------------------------------------------------ hibernation --- */

test('hibernation says no to a row on another account, with the reason in words', () => {
  const out = sleepVerdict(row({ account: OTHER }), ctx());
  assert.deepEqual(out, { ok: false, rule: 'account', why: OTHER_ACCOUNT_WHY });
});

test('hibernation is unchanged for the default account and an unknown one', () => {
  assert.deepEqual(sleepVerdict(row({ account: acct() }), ctx()), { ok: true });
  assert.deepEqual(sleepVerdict(row({ account: null }), ctx()), { ok: true });
});
