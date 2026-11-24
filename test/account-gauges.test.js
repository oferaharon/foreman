/*
 * The usage gauges, per account (the multi-account plan, item 7).
 *
 * Every uuid here is fake and every path is under a made-up home: this repo is public, and a
 * real account id in a fixture is published the moment it is pushed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RateLimitStore } from '../server/rate-limits.js';
import { AccountReader, accountOfPayload, knownConfigDir } from '../server/account.js';
import { accountRows } from '../web/quota.js';

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');

const MAIN = { uuid: '00000000-0000-4000-8000-0000000000a1', explicit: false, folder: 'default' };
const WORK = { uuid: '00000000-0000-4000-8000-0000000000b2', explicit: true, folder: '.claude-work' };

const NOW = 1788_500_000_000;
const R5 = 1788_571_200; // five-hour reset, Unix seconds, after NOW
const R7 = 1789_084_800; // weekly reset

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-gauges-')), 'rate-limits.json');
}

/** A status-line post from one session: the two windows at these percentages. */
function post(session, five, seven, reset5 = R5) {
  return {
    session_id: session,
    rate_limits: {
      five_hour: { used_percentage: five, resets_at: reset5 },
      seven_day: { used_percentage: seven, resets_at: R7 },
    },
  };
}

function pct(store, uuid, win) {
  return store.byAccount().find((r) => r.uuid === uuid)?.windows[win]?.usedPercentage;
}

/* ------------------------------------------------------- the store's split --- */

test('two accounts are two records, and each post lands only on its own', () => {
  const s = new RateLimitStore(tmpFile());
  assert.equal(s.ingest(post('m1', 40, 10), NOW, MAIN), true);
  assert.equal(s.ingest(post('w1', 7, 70), NOW + 1000, WORK), true);
  assert.equal(pct(s, MAIN.uuid, 'five_hour'), 40);
  assert.equal(pct(s, WORK.uuid, 'five_hour'), 7);
  // `rateLimits` — the field old tabs read — stays the default account's, whoever spoke last.
  assert.equal(s.get().windows.five_hour.usedPercentage, 40);
  const rows = s.byAccount();
  assert.deepEqual(rows.map((r) => [r.uuid, r.default]), [[MAIN.uuid, true], [WORK.uuid, false]]);
  s.stop();
});

test('interleaved posts: an idle re-post on one account while the other moves — neither bar moves on the other\'s post', () => {
  const s = new RateLimitStore(tmpFile());
  // Baselines, then one fresh move each, so both accounts hold a witnessed reading.
  s.ingest(post('m1', 40, 10), NOW, MAIN);
  s.ingest(post('w1', 7, 70), NOW + 1000, WORK);
  s.ingest(post('m1', 41, 10), NOW + 2000, MAIN);
  s.ingest(post('w1', 8, 70), NOW + 3000, WORK);

  for (let i = 1; i <= 5; i++) {
    // The work account is busy and climbing…
    assert.equal(s.ingest(post('w1', 8 + i, 70 + i), NOW + i * 60_000, WORK), true, `work moves, minute ${i}`);
    // …while a main-account sleeper re-posts its old copy, byte for byte.
    assert.equal(s.ingest(post('m1', 41, 10), NOW + i * 60_000 + 500, MAIN), false, `main repeat, minute ${i}`);
    assert.equal(pct(s, MAIN.uuid, 'five_hour'), 41, 'the main bar is the main account\'s own');
    assert.equal(pct(s, MAIN.uuid, 'seven_day'), 10);
  }
  assert.equal(pct(s, WORK.uuid, 'five_hour'), 13);
  assert.equal(pct(s, WORK.uuid, 'seven_day'), 75);

  // And the other way round: the work account goes idle while main moves.
  const workBefore = JSON.stringify(s.byAccount().find((r) => r.uuid === WORK.uuid).windows);
  assert.equal(s.ingest(post('m1', 50, 11), NOW + 10 * 60_000, MAIN), true);
  assert.equal(s.ingest(post('w1', 13, 75), NOW + 10 * 60_000 + 1, WORK), false);
  assert.equal(JSON.stringify(s.byAccount().find((r) => r.uuid === WORK.uuid).windows), workBefore);
  s.stop();
});

test('a payload with no resolvable account is ignored — never folded into the default', () => {
  const s = new RateLimitStore(tmpFile());
  s.ingest(post('m1', 40, 10), NOW, MAIN);
  for (const account of [null, undefined, {}, { uuid: null, explicit: false }, { uuid: '', explicit: false }]) {
    assert.equal(s.ingest(post('x', 99, 99, R5 + 3600), NOW + 1000, account), false, JSON.stringify(account));
  }
  assert.equal(s.get().windows.five_hour.usedPercentage, 40);
  assert.equal(s.byAccount().length, 1);
  s.stop();
});

test('T10: a session moved to the other account keeps its id, and its first post there is `first`, not `fresh`', () => {
  const s = new RateLimitStore(tmpFile());
  // The work account has a witnessed reading of its own.
  s.ingest(post('w1', 20, 30), NOW, WORK);
  s.ingest(post('w1', 21, 30), NOW + 1000, WORK);
  // Session `mv` lived on main, and moved its reading there.
  s.ingest(post('mv', 60, 80), NOW + 2000, MAIN);
  s.ingest(post('mv', 61, 80), NOW + 3000, MAIN);

  // Moved: same session id, now posting on the work account with different numbers. Judged
  // against one shared memory it would read as `fresh` (61 → 5 moved) and drag the work bar
  // down; judged against the work account's own memory it is a first sighting.
  assert.equal(s.ingest(post('mv', 5, 31), NOW + 4000, WORK), false);
  assert.equal(pct(s, WORK.uuid, 'five_hour'), 21);
  assert.equal(pct(s, WORK.uuid, 'seven_day'), 30);
  // Its next post that moves is a witness on the account it is on now.
  assert.equal(s.ingest(post('mv', 6, 31), NOW + 5000, WORK), true);
  assert.equal(pct(s, WORK.uuid, 'five_hour'), 6);
  // And the main account never heard any of it.
  assert.equal(pct(s, MAIN.uuid, 'five_hour'), 61);
  s.stop();
});

test('the default account is whichever account the default dir posts as, and a change of it is a change', () => {
  const s = new RateLimitStore(tmpFile());
  s.ingest(post('w1', 7, 70), NOW, WORK);
  assert.equal(s.get(), null, 'a non-default account never becomes `rateLimits`');
  assert.equal(s.byAccount()[0].default, false);
  assert.equal(s.ingest(post('m1', 40, 10), NOW + 1000, MAIN), true);
  assert.equal(s.get().windows.five_hour.usedPercentage, 40);
  s.stop();
});

/* ---------------------------------------------------------------- on disk --- */

test('the file round-trips: default top-level, every account under `accounts`, no session id', () => {
  const file = tmpFile();
  const a = new RateLimitStore(file);
  a.ingest(post('session-main', 40, 10), NOW, MAIN);
  a.ingest(post('session-work', 7, 70), NOW + 1000, WORK);
  a.stop();

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.windows.five_hour.usedPercentage, 40, 'top level is the default account — what a rollback reads');
  assert.equal(disk.at, NOW);
  assert.equal(disk.defaultAccount, MAIN.uuid);
  assert.deepEqual(Object.keys(disk.accounts).sort(), [MAIN.uuid, WORK.uuid].sort());
  assert.equal(disk.accounts[WORK.uuid].windows.seven_day.usedPercentage, 70);
  assert.ok(!/session-main|session-work|folder/.test(fs.readFileSync(file, 'utf8')));

  const b = new RateLimitStore(file);
  assert.deepEqual(b.byAccount(), a.byAccount().map((r) => ({ ...r, folder: null })));
  assert.equal(b.get().windows.five_hour.usedPercentage, 40);
  // Baselines are memory only: after the restart each session's first post is `first` again.
  assert.equal(b.ingest(post('session-work', 1, 1), NOW + 2000, WORK), false);
  b.stop();
});

test('a rollback-shaped file (no `accounts`) draws as the default row and is handed to the default account only', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    windows: { five_hour: { usedPercentage: 33, resetsAt: R5 }, seven_day: { usedPercentage: 5, resetsAt: R7 } },
    at: NOW,
  }));
  const s = new RateLimitStore(file);
  assert.equal(s.get().windows.five_hour.usedPercentage, 33, 'old tabs keep their gauge');
  assert.deepEqual(s.byAccount().map((r) => [r.uuid, r.default]), [[null, true]]);

  // A second account's post does not inherit it…
  s.ingest(post('w1', 7, 70), NOW + 1000, WORK);
  assert.equal(pct(s, WORK.uuid, 'five_hour'), 7);
  assert.equal(s.get().windows.five_hour.usedPercentage, 33, '…and does not displace it');

  // …the default dir's first post adopts it, as a stored reading the witness rules then guard.
  // `true` because the default row has learned whose it is — the frame's entry changes —
  // but the bar does not move: a first sighting is a baseline, not a witness.
  assert.equal(s.ingest(post('m1', 20, 4), NOW + 2000, MAIN), true);
  assert.equal(pct(s, MAIN.uuid, 'five_hour'), 33);
  assert.equal(s.ingest(post('m1', 20, 4), NOW + 3000, MAIN), false, 'and its repeat is nothing at all');
  assert.deepEqual(s.byAccount().map((r) => r.uuid), [MAIN.uuid, WORK.uuid]);
  s.stop();

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.windows.five_hour.usedPercentage, 33);
  assert.ok(disk.accounts[MAIN.uuid] && disk.accounts[WORK.uuid]);
});

test('what a rollback build writes back — `{windows, at}` alone — is read again without losing the main gauge', () => {
  const file = tmpFile();
  const a = new RateLimitStore(file);
  a.ingest(post('m1', 40, 10), NOW, MAIN);
  a.ingest(post('w1', 7, 70), NOW, WORK);
  a.stop();
  // The older build's rewrite: it reads `{windows, at}` and writes exactly that.
  const { windows, at } = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ windows, at }));
  const b = new RateLimitStore(file);
  assert.equal(b.get().windows.five_hour.usedPercentage, 40);
  assert.equal(b.byAccount().length, 1, 'the second account is gone until it posts again — accepted, and said in the PR');
  b.stop();
});

test('nonsense under `accounts` is skipped, the rest survives', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    accounts: {
      [WORK.uuid]: { windows: { five_hour: { usedPercentage: 'NaN', resetsAt: R5 } }, at: NOW },
      bad: 'not an object',
      [MAIN.uuid]: { windows: {}, at: 'yesterday' },
    },
    defaultAccount: 42,
  }));
  const s = new RateLimitStore(file);
  assert.deepEqual(s.byAccount().map((r) => r.uuid), [WORK.uuid]);
  assert.equal(pct(s, WORK.uuid, 'five_hour'), null);
  assert.equal(s.get(), null);
  s.stop();
});

/* ------------------------------------------- payload → account resolution --- */

const HOME = '/Users/someone';
const DEFAULT_DIR = `${HOME}/.claude`;
const WORK_DIR = `${HOME}/.claude-work`;

function fakeReader(files) {
  let reads = 0;
  const reader = new AccountReader({
    home: HOME,
    stat: async (f) => {
      if (!(f in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { mtimeMs: 1, size: files[f].length };
    },
    readFile: async (f) => {
      reads += 1;
      return files[f];
    },
    ps: async () => '',
    now: () => NOW,
  });
  return { reader, reads: () => reads };
}

const ACCOUNT_FILES = {
  [`${HOME}/.claude.json`]: JSON.stringify({ oauthAccount: { accountUuid: MAIN.uuid, emailAddress: 'main@example.invalid' } }),
  [`${WORK_DIR}/.claude.json`]: JSON.stringify({ oauthAccount: { accountUuid: WORK.uuid, emailAddress: 'work@example.invalid' } }),
};

test('T13: the pinned status-line fixture carries the account witness, and it resolves to that dir\'s account', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'payload-statusline.json'), 'utf8'));
  assert.ok(fixture.rate_limits, 'the fixture is a gauge-bearing payload');
  const { reader } = fakeReader(ACCOUNT_FILES);
  const account = await accountOfPayload(fixture, { known: [DEFAULT_DIR, WORK_DIR], reader });
  assert.equal(account.uuid, WORK.uuid);
  assert.equal(account.explicit, true);
});

test('a default-dir transcript resolves to the default account, read from ~/.claude.json', async () => {
  const { reader } = fakeReader(ACCOUNT_FILES);
  const account = await accountOfPayload(
    { transcript_path: `${DEFAULT_DIR}/projects/-Users-someone-foreman-sandbox-alpha/x.jsonl` },
    { known: [DEFAULT_DIR, WORK_DIR], reader },
  );
  assert.equal(account.uuid, MAIN.uuid);
  assert.equal(account.explicit, false);
});

test('no transcript_path, a relative one, an unknown dir, or a signed-out dir: no account, so the payload is ignored', async () => {
  const files = { ...ACCOUNT_FILES, [`${HOME}/.claude-new/.claude.json`]: JSON.stringify({}) };
  const { reader, reads } = fakeReader(files);
  const known = [DEFAULT_DIR, WORK_DIR, `${HOME}/.claude-new`];
  for (const transcript_path of [
    undefined,
    '',
    'projects/-x/y.jsonl',
    `${HOME}/elsewhere/y.jsonl`, // no `projects` ancestor
    `${HOME}/.claude-stranger/projects/-x/y.jsonl`, // not a known dir: never read
    `${HOME}/.claude-new/projects/-x/y.jsonl`, // known, but nobody signed in
  ]) {
    assert.equal(await accountOfPayload({ transcript_path, rate_limits: {} }, { known, reader }), null, String(transcript_path));
  }
  assert.equal(reads(), 1, 'only the known, signed-out dir\'s file was ever read');

  const store = new RateLimitStore(tmpFile());
  assert.equal(store.ingest(post('s', 1, 1), NOW, await accountOfPayload({ ...post('s', 1, 1) }, { known, reader })), false);
  assert.equal(store.get(), null);
  store.stop();
});

test('knownConfigDir matches a folder, not a prefix', () => {
  assert.equal(knownConfigDir(`${WORK_DIR}/`, [DEFAULT_DIR, WORK_DIR]), WORK_DIR);
  assert.equal(knownConfigDir(`${WORK_DIR}-2`, [DEFAULT_DIR, WORK_DIR]), null);
  assert.equal(knownConfigDir(null, [DEFAULT_DIR]), null);
});

test('accountForDir answers through the file cache: one parse for many posts', async () => {
  const { reader, reads } = fakeReader(ACCOUNT_FILES);
  for (let i = 0; i < 5; i++) assert.equal((await reader.accountForDir(WORK_DIR)).uuid, WORK.uuid);
  assert.equal(reads(), 1);
  // A roster poll with no pane on that account does not drop a file a post just asked for.
  await reader.forPanes([]);
  assert.equal((await reader.accountForDir(WORK_DIR)).uuid, WORK.uuid);
  assert.equal(reads(), 1);
});

/* ------------------------------------------------------------ which rows --- */

const rec = (five) => ({ windows: { five_hour: { usedPercentage: five, resetsAt: R5 } }, at: NOW });

test('accountRows: the default always, another only while live, default first', () => {
  const list = [
    { uuid: WORK.uuid, nickname: 'work', folder: '.claude-work', default: false, live: true, ...rec(7) },
    { uuid: MAIN.uuid, nickname: null, folder: 'default', default: true, live: false, ...rec(40) },
    { uuid: '00000000-0000-4000-8000-0000000000c3', nickname: 'old', folder: '.claude-old', default: false, live: false, ...rec(1) },
  ];
  const rows = accountRows(list);
  assert.deepEqual(rows.map((r) => r.label), ['default', 'work']);
  assert.equal(rows[0].record.windows.five_hour.usedPercentage, 40);
  assert.equal(rows[1].record.windows.five_hour.usedPercentage, 7);

  // The second account's last live row leaves: its gauge row goes, and the lone default is
  // drawn unlabelled, exactly as the single gauge always was.
  const after = accountRows(list.map((r) => ({ ...r, live: false })));
  assert.deepEqual(after.map((r) => [r.label, r.default]), [[null, true]]);
});

test('accountRows: a nickname wins over the folder, and a frame without the field falls back to `rateLimits`', () => {
  const rows = accountRows([
    { uuid: MAIN.uuid, nickname: 'home', folder: 'default', default: true, live: true, ...rec(1) },
    { uuid: WORK.uuid, nickname: null, folder: '.claude-work', default: false, live: true, ...rec(2) },
  ]);
  assert.deepEqual(rows.map((r) => r.label), ['home', '.claude-work']);
  assert.ok(rows.every((r) => !JSON.stringify(r.label).includes('0000')), 'a uuid is never a label');

  assert.deepEqual(accountRows(undefined, rec(9)), [{ key: 'default', label: null, record: rec(9), default: true }]);
  assert.deepEqual(accountRows(undefined, null), []);
  assert.deepEqual(accountRows([]), []);
});
