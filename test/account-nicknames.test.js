import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPOSURE_KEYS,
  NICKNAME_MAX,
  NICKNAMES_MAX,
  WRITABLE_KEYS,
  mergeNicknames,
  readNicknames,
  touchesExposure,
  validateConfigPatch,
  writeConfigFile,
} from '../server/settings-file.js';

/*
 * `accountNicknames` in `config.json`: what an account tag reads instead of its folder name.
 * A delta per PATCH, merged inside the atomic write; plain, bounded, keyed by account uuid;
 * not exposure. The writer runs against a real temp dir, the same rule as config-surface.
 */

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let dir;
test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-nick-'));
});
test.after(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

test('writable, and not an exposure key — a LAN peer may name an account', () => {
  assert.ok(WRITABLE_KEYS.includes('accountNicknames'));
  assert.equal(EXPOSURE_KEYS.includes('accountNicknames'), false);
  assert.equal(touchesExposure({ accountNicknames: { [A]: 'Personal' } }), false);
});

test('a nickname is trimmed and kept; an empty one or null removes', () => {
  const ok = validateConfigPatch({ accountNicknames: { [A]: '  Personal  ', [B]: '' } });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.patch.accountNicknames, { [A]: 'Personal', [B]: null });
  assert.deepEqual(validateConfigPatch({ accountNicknames: { [A]: null } }).patch.accountNicknames, { [A]: null });
});

test('the uuid is lowercased, so one account is one key', () => {
  const ok = validateConfigPatch({ accountNicknames: { [A.toUpperCase()]: 'Work' } });
  assert.deepEqual(ok.patch.accountNicknames, { [A]: 'Work' });
});

test('refusals: not an object, not a uuid, too long, control characters, not a string', () => {
  for (const bad of [
    'Personal',
    ['Personal'],
    null,
    { 'not-a-uuid': 'Personal' },
    { 'alpha@example.com': 'Personal' },
    { [A]: 'x'.repeat(NICKNAME_MAX + 1) },
    { [A]: 'Per\nsonal' },
    { [A]: 'Per\u0007sonal' },
    { [A]: 42 },
    { [A]: { name: 'Personal' } },
  ]) {
    const got = validateConfigPatch({ accountNicknames: bad });
    assert.equal(got.ok, false, JSON.stringify(bad));
    assert.equal(got.status, 400);
  }
  // Exactly at the bound is fine.
  assert.equal(validateConfigPatch({ accountNicknames: { [A]: 'x'.repeat(NICKNAME_MAX) } }).ok, true);
});

test('a stored map that a hand edit broke reads as only its valid entries', () => {
  const got = readNicknames({
    accountNicknames: { [A]: ' Personal ', [B]: 7, 'nope': 'X', ['cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee']: 'y'.repeat(99) },
  });
  assert.deepEqual(got, { [A]: 'Personal' });
  assert.deepEqual(readNicknames({ accountNicknames: 'Personal' }), {});
  assert.deepEqual(readNicknames({}), {});
  assert.deepEqual(readNicknames(undefined), {});
});

test('the write merges a delta into what is on disk, and keeps every other key', () => {
  const file = path.join(dir, 'merge.json');
  fs.writeFileSync(file, JSON.stringify({ bindHost: '127.0.0.1', futureKey: 1, accountNicknames: { [A]: 'Personal' } }));
  const add = writeConfigFile(file, validateConfigPatch({ accountNicknames: { [B]: 'Work' } }).patch);
  assert.equal(add.ok, true);
  assert.deepEqual(add.changed, ['accountNicknames']);
  let disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.accountNicknames, { [A]: 'Personal', [B]: 'Work' });
  assert.equal(disk.futureKey, 1);
  assert.equal(disk.bindHost, '127.0.0.1');

  const drop = writeConfigFile(file, validateConfigPatch({ accountNicknames: { [A]: '' } }).patch);
  assert.deepEqual(drop.config.accountNicknames, { [B]: 'Work' });
  disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(disk.accountNicknames, { [B]: 'Work' });

  // The same name again is not a change.
  const same = writeConfigFile(file, validateConfigPatch({ accountNicknames: { [B]: 'Work' } }).patch);
  assert.deepEqual(same.changed, []);
});

test('the map is bounded on disk as well as per request', () => {
  const file = path.join(dir, 'bound.json');
  const full = {};
  for (let i = 0; i < NICKNAMES_MAX; i += 1) full[`${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`] = `n${i}`;
  fs.writeFileSync(file, JSON.stringify({ accountNicknames: full }));
  const over = writeConfigFile(file, { accountNicknames: { [A]: 'one more' } });
  assert.equal(over.ok, false);
  assert.equal(over.status, 400);
  // Replacing one that is there is still fine.
  const first = Object.keys(full)[0];
  assert.equal(writeConfigFile(file, { accountNicknames: { [first]: 'renamed' } }).ok, true);
});

test('mergeNicknames applies removals and leaves the input alone', () => {
  const config = { accountNicknames: { [A]: 'Personal' } };
  assert.deepEqual(mergeNicknames(config, { [A]: null, [B]: 'Work' }), { [B]: 'Work' });
  assert.deepEqual(config.accountNicknames, { [A]: 'Personal' });
});
