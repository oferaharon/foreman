import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { accountTag } from '../web/account-tag.js';

/*
 * The tag's rule: nickname, else the config folder's name, and never the email — which is
 * in the hover only. And the two rules that keep it out of places it must not reach.
 */

const work = {
  uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  email: 'beta@example.com',
  plan: 'Max 5x',
  folder: '.claude-work',
  configDir: '~/.claude-work',
  signedIn: true,
  nickname: null,
};

test('the nickname is the tag when set', () => {
  const t = accountTag({ ...work, nickname: 'Work' });
  assert.equal(t.text, 'Work');
  assert.equal(t.nicknamed, true);
  assert.equal(t.title, 'Claude account “Work”: beta@example.com · Max 5x · ~/.claude-work');
});

test('otherwise the folder name, and the default dir reads `default`', () => {
  assert.equal(accountTag(work).text, '.claude-work');
  assert.equal(accountTag({ ...work, folder: 'default', configDir: '~/.claude' }).text, 'default');
  assert.equal(accountTag(work).nicknamed, false);
});

test('the email is never the visible text', () => {
  for (const a of [work, { ...work, nickname: 'Work' }, { ...work, folder: 'x' }]) {
    assert.doesNotMatch(accountTag(a).text, /@/);
    assert.match(accountTag(a).title, /beta@example\.com/);
  }
});

test('a dir nobody is signed into says so on hover and still shows its folder', () => {
  const t = accountTag({ uuid: null, email: null, plan: null, folder: '.claude-work', configDir: '~/.claude-work', signedIn: false, nickname: null });
  assert.equal(t.text, '.claude-work');
  assert.equal(t.title, 'Claude account: not signed in · ~/.claude-work');
});

test('unknown draws nothing', () => {
  assert.equal(accountTag(null), null);
  assert.equal(accountTag(undefined), null);
  assert.equal(accountTag({ folder: '' }), null);
});

test('the account never joins composerSig, and the tag rides the meta line, not a new one', () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'web', 'app.js'), 'utf8');
  const sig = app.slice(app.indexOf('const composerSig = (s) =>'), app.indexOf('let lastComposerSig'));
  assert.ok(sig.length > 100);
  assert.doesNotMatch(sig, /account/);
  // In the rail it is appended to `meta`, the row's second line.
  assert.match(app, /const acct = accountTagEl\(document, s\.account\);\n\s*if \(acct\) meta\.append\(acct\);/);
});
