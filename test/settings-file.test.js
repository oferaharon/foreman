import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_BIND_HOST,
  DEFAULT_SESSION_PREFIX,
  allowedOriginsFrom,
  readConfigFile,
  resolveBindHost,
  resolveSessionPrefix,
  seedConfigFile,
  validSessionPrefix,
} from '../server/settings-file.js';

/*
 * `<STATE_DIR>/config.json`, against real files on a real disk.
 *
 * Same rule as `config.test.js` and the git wrappers: no stubbed `fs`. Every failure this
 * module has to survive — a file that isn't there, one that is half-written, a state dir
 * that cannot be written to — is a property of the filesystem rather than of this
 * module's arithmetic, and stubbing it away would prove nothing.
 *
 * The two things worth being careful about, and both have a case below: **the precedence**
 * (`$FOREMAN_HOST` → the file → `127.0.0.1`), because it is what decides who can reach the
 * panel; and **seed-only-when-absent**, because a boot that rewrote an existing file would
 * quietly undo somebody's decision, and this file is the thing that carries the wide bind
 * across the coming env-name rename.
 */

let dir;

test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-config-'));
});

test.after(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

/** A fresh `config.json` under its own subdirectory, so cases cannot see each other's. */
function withConfig(name, body) {
  const home = path.join(dir, name);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  if (body !== undefined) fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return file;
}

/* ─────────────────────────────────────────────────────────────────── the read ─── */

test('no file is the ordinary case and says nothing — the boot line already says so', () => {
  const { config, notes, exists } = readConfigFile(withConfig('absent'));
  assert.deepEqual(config, {});
  assert.deepEqual(notes, []);
  assert.equal(exists, false);
});

test('a file is read, and its keys come back as written', () => {
  const file = withConfig('plain', { bindHost: '0.0.0.0', allowedOrigins: ['http://alpha.local:48770'] });
  const { config, notes, exists } = readConfigFile(file);
  assert.equal(config.bindHost, '0.0.0.0');
  assert.deepEqual(config.allowedOrigins, ['http://alpha.local:48770']);
  assert.deepEqual(notes, []);
  assert.equal(exists, true);
});

test('a malformed file is a note and a fall back to defaults, never a panel that will not boot', () => {
  // The direction matters: broken settings fall back to *loopback*, which is the safe way
  // to fail for a value that decides who can reach the panel — and it is loud, because a
  // silent fall back here is exactly the dead-phone failure this module exists to prevent.
  const file = withConfig('broken', '{ "bindHost": "0.0.0.0", ');
  const { config, notes, exists } = readConfigFile(file);
  assert.deepEqual(config, {});
  assert.equal(exists, true);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /not valid JSON/);
  assert.equal(resolveBindHost({ env: {}, config }).host, DEFAULT_BIND_HOST);
});

test('a file holding an array or a bare value is not a config object', () => {
  for (const body of ['[]', '"0.0.0.0"', 'null', '7']) {
    const { config, notes } = readConfigFile(withConfig(`shape-${body.replace(/\W/g, '')}`, body));
    assert.deepEqual(config, {});
    assert.equal(notes.length, 1, `expected one note for ${body}`);
  }
});

/* ─────────────────────────────────────────────────────────────── the precedence ─── */

test('the precedence is $FOREMAN_HOST, then the file, then loopback', () => {
  const config = { bindHost: '0.0.0.0' };

  const fromEnv = resolveBindHost({ env: { FOREMAN_HOST: '10.0.0.4' }, config });
  assert.deepEqual(fromEnv, { host: '10.0.0.4', source: '$FOREMAN_HOST' });

  const fromFile = resolveBindHost({ env: {}, config });
  assert.deepEqual(fromFile, { host: '0.0.0.0', source: 'config.json' });

  const fallback = resolveBindHost({ env: {}, config: {} });
  assert.deepEqual(fallback, { host: DEFAULT_BIND_HOST, source: 'default' });
});

test('the file survives the environment going away — the bridge, in one assertion', () => {
  // This is the whole point of the item. A machine that was widened by an env var in its
  // job environment keeps the wide bind once that variable is gone, because the first boot
  // wrote it down. Without this, a rename of the env names is a silently dead phone.
  const file = withConfig('bridge');
  seedConfigFile(file, { bindHost: resolveBindHost({ env: { FOREMAN_HOST: '0.0.0.0' }, config: {} }).host });

  const { config } = readConfigFile(file);
  assert.deepEqual(resolveBindHost({ env: {}, config }), { host: '0.0.0.0', source: 'config.json' });
});

test('a blank or non-string bindHost is ignored rather than obeyed', () => {
  // `server.listen(port, null)` and `server.listen(port, 0)` both do something, and
  // neither is what a hand-edited file meant. A hand-edited file is exactly where this
  // arrives.
  for (const bindHost of ['', '   ', null, 0, 8080, [], {}]) {
    assert.equal(resolveBindHost({ env: {}, config: { bindHost } }).host, DEFAULT_BIND_HOST);
  }
  // …but surrounding whitespace on a real value is trimmed, not treated as a typo.
  assert.equal(resolveBindHost({ env: {}, config: { bindHost: ' 0.0.0.0 ' } }).host, '0.0.0.0');
  assert.equal(resolveBindHost({ env: { FOREMAN_HOST: ' 0.0.0.0\n' }, config: {} }).host, '0.0.0.0');
});

test('an empty $FOREMAN_HOST falls through to the file rather than binding nothing', () => {
  // `FOREMAN_HOST= npm start` sets the variable to the empty string. Reading that as an answer
  // would hand `server.listen` an empty host and skip the file that has the real one.
  const config = { bindHost: '0.0.0.0' };
  assert.deepEqual(resolveBindHost({ env: { FOREMAN_HOST: '' }, config }), { host: '0.0.0.0', source: 'config.json' });
});

/* ────────────────────────────────────────────────────────────── allowedOrigins ─── */

test('allowedOrigins comes back as a list of non-empty strings, or empty', () => {
  assert.deepEqual(allowedOriginsFrom({}), []);
  assert.deepEqual(allowedOriginsFrom({ allowedOrigins: 'http://alpha.local:48770' }), []);
  assert.deepEqual(
    allowedOriginsFrom({ allowedOrigins: ['http://alpha.local:48770', '', 42, null, 'http://beta.local:48770'] }),
    ['http://alpha.local:48770', 'http://beta.local:48770'],
  );
});

/* ─────────────────────────────────────────────────────────────────── the seed ─── */

test('a first boot seeds the host it is actually using, with room for the origins', () => {
  const file = withConfig('seed-wide');
  const result = seedConfigFile(file, { bindHost: '0.0.0.0' });
  assert.equal(result.seeded, true);

  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(written, {
    bindHost: '0.0.0.0',
    // Seeded at the default rather than omitted, so the key is discoverable in the one
    // file somebody will actually open. Nothing else could have supplied it — unlike the
    // host, which is captured from the environment this boot is running in.
    sessionPrefix: DEFAULT_SESSION_PREFIX,
    allowedOrigins: [],
  });
  // Written for a human to open and edit — pretty-printed, newline-terminated.
  assert.match(fs.readFileSync(file, 'utf8'), /\n$/);
});

test("a stranger's first boot seeds loopback", () => {
  const file = withConfig('seed-default');
  seedConfigFile(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bindHost, DEFAULT_BIND_HOST);
});

test('the state dir is created if it is not there yet', () => {
  const file = path.join(dir, 'brand-new-state-dir', 'config.json');
  assert.equal(seedConfigFile(file, { bindHost: '0.0.0.0' }).seeded, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).bindHost, '0.0.0.0');
});

test('an existing file is never rewritten, whatever the boot is binding', () => {
  // The one that would quietly undo a decision: a panel started once with a stray
  // `FOREMAN_HOST` in the shell must not stamp that over the file somebody wrote.
  const file = withConfig('existing', { bindHost: '0.0.0.0', allowedOrigins: ['http://alpha.local:48770'] });
  const before = fs.readFileSync(file, 'utf8');

  const result = seedConfigFile(file, { bindHost: '127.0.0.1' });
  assert.equal(result.seeded, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('an unwritable state dir is reported, not thrown — a bad day, not a refusal to boot', () => {
  const home = path.join(dir, 'readonly');
  fs.mkdirSync(home, { recursive: true });
  fs.chmodSync(home, 0o500);
  try {
    const result = seedConfigFile(path.join(home, 'config.json'), { bindHost: '0.0.0.0' });
    assert.equal(result.seeded, false);
    assert.ok(result.error, 'expected the failure to be reported so the boot line can say so');
  } finally {
    fs.chmodSync(home, 0o700);
  }
});

/* ───────────────────────────────────────────────────────────── sessionPrefix ─── */

/*
 * The prefix every tmux session is minted with. Its failure mode is quieter than the
 * host's and worth naming: a rejected value doesn't break anything visibly — the panel
 * boots, the rail draws — it just stops recognising the sessions on the machine, which
 * reads as "the panel has gone blank" rather than as a bad setting. Hence a note on every
 * rejection, asserted below, and hence no silent repair of a near-miss like `foreman`.
 */

test('a valid prefix is lowercase, starts with a letter or digit, and ends with a dash', () => {
  for (const good of ['foreman-', 'voice-', 'a-', 'x1-', 'my-tool-', 'a-b-c-']) {
    assert.ok(validSessionPrefix(good), good);
  }
  for (const bad of [
    '',            // nothing at all
    'foreman',     // no separator — the half a hand-editor gets wrong
    'Voice-',      // uppercase; `sanitize` could never produce it in the rest of the name
    'voice_',      // wrong separator
    'voice-x',     // does not end in the separator
    '-',           // no body
    '--',          // ditto, with the body being another separator
    '-voice-',     // leading separator
    'vo ice-',     // whitespace
    'café-',       // outside [a-z0-9-]
    null, undefined, 42, [], {},
  ]) {
    assert.equal(validSessionPrefix(bad), false, JSON.stringify(bad));
  }
});

test('an absent sessionPrefix is the default, silently', () => {
  // Silence is right here and nowhere else in this block: nothing was written down, so
  // nothing was ignored. Every *other* path below has to say something.
  assert.deepEqual(resolveSessionPrefix({ config: {} }), {
    prefix: DEFAULT_SESSION_PREFIX,
    source: 'default',
    note: null,
  });
  assert.deepEqual(resolveSessionPrefix(), {
    prefix: DEFAULT_SESSION_PREFIX,
    source: 'default',
    note: null,
  });
});

test('a valid sessionPrefix wins, and says the file answered', () => {
  assert.deepEqual(resolveSessionPrefix({ config: { sessionPrefix: 'voice-' } }), {
    prefix: 'voice-',
    source: 'config.json',
    note: null,
  });
});

test('an invalid sessionPrefix is a note and the default, never a refusal to boot', () => {
  // The stance `bindHost` set: a panel that will not start over a typo is worse than a
  // panel that starts and tells you. What must not happen is starting *quietly*.
  for (const bad of ['Voice', '', 'foreman', 'voice_', 42, null]) {
    const got = resolveSessionPrefix({ config: { sessionPrefix: bad } });
    assert.equal(got.prefix, DEFAULT_SESSION_PREFIX, JSON.stringify(bad));
    assert.equal(got.source, 'default');
    assert.ok(got.note, `expected a boot warning for ${JSON.stringify(bad)}`);
    assert.match(got.note, /sessionPrefix/);
    assert.match(got.note, /foreman-/, 'the note has to name the value actually used');
  }
  // …and it names the file to open, the same way `readConfigFile`'s notes do. A warning
  // about "config" is a warning you have to go and find the file for.
  {
    const got = resolveSessionPrefix({ config: { sessionPrefix: 'Voice' }, file: '/tmp/x/config.json' });
    assert.match(got.note, /\/tmp\/x\/config\.json/);
  }
});

test('no whitespace trim, unlike bindHost — a padded prefix is a rejected prefix', () => {
  // Deliberately not symmetric with `bindHost`. A host is a value handed to
  // `server.listen` and ` 0.0.0.0 ` unambiguously meant `0.0.0.0`; a prefix is a string
  // other things `startsWith` and a tmux `#{m:...*}` pattern matches, so trimming it would
  // mean the file and the running panel hold different strings.
  const got = resolveSessionPrefix({ config: { sessionPrefix: ' voice- ' } });
  assert.equal(got.prefix, DEFAULT_SESSION_PREFIX);
  assert.ok(got.note);
});

test('a fresh state dir gets the key written down; an existing file is left alone', () => {
  const file = withConfig('prefix-seed');
  assert.equal(seedConfigFile(file, { bindHost: '127.0.0.1', sessionPrefix: 'foreman-' }).seeded, true);
  assert.equal(readConfigFile(file).config.sessionPrefix, 'foreman-');

  // And the half that decides the migration on a machine that already has the file: the
  // key is *not* added to it. A panel upgrading into this code mints under the default
  // until somebody writes the line, which is why the boot line prints the prefix.
  const existing = withConfig('prefix-existing', { bindHost: '0.0.0.0', allowedOrigins: [] });
  const before = fs.readFileSync(existing, 'utf8');
  assert.equal(seedConfigFile(existing, { bindHost: '0.0.0.0', sessionPrefix: 'voice-' }).seeded, false);
  assert.equal(fs.readFileSync(existing, 'utf8'), before);
  assert.equal(readConfigFile(existing).config.sessionPrefix, undefined);
});
