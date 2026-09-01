import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTokenFile, TRIGGER_TOKEN_FILE, STATE_DIR } from '../server/config.js';

/*
 * The trigger token file, against real files on a real disk.
 *
 * `readTokenFile` is the whole of item 3 that can be tested — `TRIGGER_TOKEN` itself is a
 * module-level constant read once at boot, which is deliberate (`config.js`) and which
 * makes it untestable in-process without re-importing the module per case. The end-to-end
 * half is `test/team-api.test.js`'s 503 case and the bench in the report: 503 with no
 * file, 401 with one, which is the exact discriminator that proves the file was read.
 *
 * No stubbed `fs`. Same rule as the git wrappers: stubbing the thing under test proves
 * nothing, and every failure mode here — a mode bit, an unreadable file, a trailing
 * newline — is a property of the filesystem rather than of this function's arithmetic.
 */

let dir;

test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-token-'));
});

test.after(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

/** Write `body` to a fresh file at `mode` and read it back. */
function withToken(name, body, mode = 0o600) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return { file, ...readTokenFile(file) };
}

test('no file is the ordinary case and says nothing — the boot line already says off', () => {
  const { token, notes } = readTokenFile(path.join(dir, 'nothing-here'));
  assert.equal(token, '');
  assert.deepEqual(notes, []);
});

test('a token is read, and a trailing newline is trimmed off it', () => {
  // The one that would 401 every request forever: `triggerAuthorized` compares byte
  // lengths first, so a token one newline too long is refused before the compare, and
  // it looks correct in every way you would inspect it.
  const plain = withToken('plain', 'sekrit-0123456789');
  const trailing = withToken('trailing', 'sekrit-0123456789\n');
  assert.equal(plain.token, 'sekrit-0123456789');
  assert.equal(trailing.token, 'sekrit-0123456789');
  assert.deepEqual(trailing.notes, []);

  // `echo` is how a person writes this file, so cover what `echo` actually produces.
  const echoed = withToken('echoed', 'sekrit-0123456789\n', 0o600);
  assert.equal(echoed.token, plain.token);
});

test('a mode wider than 600 warns and still works — a soft problem, not a hard failure', () => {
  const wide = withToken('wide', 'sekrit-0123456789', 0o644);
  assert.equal(wide.token, 'sekrit-0123456789', 'the feature stays on');
  assert.equal(wide.notes.length, 1);
  assert.match(wide.notes[0], /644/);
  assert.match(wide.notes[0], /chmod 600/);
  // Never the token, in any note, ever — these lines go to a log that never rotates.
  assert.equal(wide.notes[0].includes('sekrit'), false);
});

test('600 and narrower are silent', () => {
  assert.deepEqual(withToken('six', 'sekrit-0123456789', 0o600).notes, []);
  assert.deepEqual(withToken('four', 'sekrit-0123456789', 0o400).notes, []);
});

test('a file that exists but cannot be read is a different fact from no file', () => {
  const { token, notes, file } = withToken('locked', 'sekrit-0123456789', 0o000);
  assert.equal(token, '', 'triggers stay off');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /could not be read/);
  assert.match(notes[0], /EACCES/);
  assert.equal(notes[0].includes(file), true, 'names the path so it can be fixed');
});

test('an empty file says so rather than passing for absent', () => {
  const { token, notes } = withToken('empty', '   \n\n  ');
  assert.equal(token, '');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /empty/);
});

test('a directory where the file should be does not take the boot down', () => {
  const file = path.join(dir, 'a-directory');
  fs.mkdirSync(file, { recursive: true });
  const { token, notes } = readTokenFile(file);
  assert.equal(token, '');
  assert.equal(notes.length, 1, 'one note, and no throw');
});

test('the file lives under STATE_DIR, which is what gives a scratch panel its own answer', () => {
  // Not HOME. `FOREMAN_STATE_DIR=/tmp/scratch npm start` must find /tmp/scratch/trigger-token,
  // find nothing, and run with triggers off — a scratch panel firing a real trigger into
  // a real lead is the thing this placement exists to make impossible.
  assert.equal(path.basename(TRIGGER_TOKEN_FILE), 'trigger-token');
  assert.equal(TRIGGER_TOKEN_FILE, path.join(STATE_DIR, 'trigger-token'));
});
