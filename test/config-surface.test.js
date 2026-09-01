import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BIND_HOST_RULE,
  EXPOSURE_KEYS,
  PREFIX_REFUSAL,
  WRITABLE_KEYS,
  isLoopbackRemote,
  remoteAddressOf,
  readConfigFile,
  touchesExposure,
  validBindHost,
  validateConfigPatch,
  writeConfigFile,
} from '../server/settings-file.js';
import { normalizeOrigin } from '../server/origin.js';

/*
 * B2's half of `settings-file.js`: the loopback guard, the two validators, and the writer.
 *
 * The writer runs against a **real temp directory**, the same rule the rest of this
 * project follows for anything that touches disk — the three properties worth pinning
 * (rename-over-the-target, unknown keys survive, an unparseable file is refused) are
 * properties of the filesystem, not of this module's arithmetic, and a stubbed `fs` would
 * prove none of them.
 *
 * The guard is pure and gets fake `req` shapes instead, because that is exactly what it
 * takes: `req.socket.remoteAddress` and nothing else. Standing up a server to prove that
 * `::ffff:127.0.0.1` is loopback would be testing node's dual-stack listener.
 */

let dir;

test.before(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'foreman-b2-'));
});

test.after(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

/** A `req` with the socket express would hand a handler, and nothing else on it. */
const req = (remoteAddress) => ({ socket: remoteAddress === undefined ? {} : { remoteAddress } });

/* ────────────────────────────────────────────── the loopback-address guard ─── */

test('loopback IPv4, IPv6 and the mapped spelling are this machine', () => {
  assert.equal(isLoopbackRemote(req('127.0.0.1')), true);
  assert.equal(isLoopbackRemote(req('::1')), true);
  // What a dual-stack listener (`::`) hands you for a plain `curl 127.0.0.1`. Missing this
  // would refuse the maintainer's own terminal on a wide-bound panel.
  assert.equal(isLoopbackRemote(req('::ffff:127.0.0.1')), true);
  // All of 127/8, the same as `origin.js`'s `isLoopbackHost`.
  assert.equal(isLoopbackRemote(req('127.0.0.53')), true);
  assert.equal(isLoopbackRemote(req('::ffff:127.1.2.3')), true);
});

test('a LAN peer is not this machine, whatever it calls itself', () => {
  // RFC-5737 documentation addresses — never a real machine's, and never this one's.
  assert.equal(isLoopbackRemote(req('192.0.2.10')), false);
  assert.equal(isLoopbackRemote(req('198.51.100.4')), false);
  assert.equal(isLoopbackRemote(req('::ffff:192.0.2.10')), false);
  assert.equal(isLoopbackRemote(req('fd00::1')), false);
  // The prefix trap `origin.js` also guards: right characters, wrong machine.
  assert.equal(isLoopbackRemote(req('127.0.0.1.example.test')), false);
  assert.equal(isLoopbackRemote(req('1270.0.0.1')), false);
});

test('no address at all fails closed — for a setting that decides exposure, "not from here"', () => {
  assert.equal(isLoopbackRemote(req(undefined)), false);
  assert.equal(isLoopbackRemote(req('')), false);
  assert.equal(isLoopbackRemote({}), false);
  assert.equal(isLoopbackRemote(null), false);
  assert.equal(remoteAddressOf(req(undefined)), null);
  assert.equal(remoteAddressOf(null), null);
});

test('an IPv6 zone index is trimmed, not compared', () => {
  assert.equal(remoteAddressOf(req('fe80::1%en0')), 'fe80::1');
  assert.equal(isLoopbackRemote(req('::1%lo0')), true);
});

test('a forwarded-for header is not a rung — the socket is the only source', () => {
  // The whole value of this guard is that a LAN peer holding curl cannot spell its way
  // past it. If somebody adds a header rung later, this is the test that stops them.
  const spoof = { socket: { remoteAddress: '192.0.2.10' }, headers: { 'x-forwarded-for': '127.0.0.1' } };
  assert.equal(isLoopbackRemote(spoof), false);
  assert.equal(remoteAddressOf(spoof), '192.0.2.10');
});

test('both exposure keys are gated and nothing else is', () => {
  assert.deepEqual(EXPOSURE_KEYS, ['bindHost', 'allowedOrigins']);
  assert.equal(touchesExposure({ bindHost: '0.0.0.0' }), true);
  assert.equal(touchesExposure({ allowedOrigins: [] }), true);
  assert.equal(touchesExposure({ sessionPrefix: 'x-' }), false);
  assert.equal(touchesExposure({}), false);
  assert.equal(touchesExposure(null), false);
});

/* ─────────────────────────────────────────────────────────────── bindHost ─── */

test('a bind host is a literal address, never a name', () => {
  assert.equal(validBindHost('127.0.0.1'), true);
  assert.equal(validBindHost('0.0.0.0'), true);
  assert.equal(validBindHost('::1'), true);
  assert.equal(validBindHost('::'), true);
  assert.equal(validBindHost('192.0.2.10'), true);
  assert.equal(validBindHost(' 10.0.0.4 '), true); // trimmed, then judged

  // A name would be resolved at boot against whatever DNS said at that moment.
  assert.equal(validBindHost('localhost'), false);
  assert.equal(validBindHost('panel.local'), false);
  assert.equal(validBindHost('0.0.0.0:48770'), false);
  assert.equal(validBindHost('999.1.1.1'), false);
  assert.equal(validBindHost(''), false);
  assert.equal(validBindHost(0), false);
  assert.equal(validBindHost(null), false);
});

test('a refused bind host comes back naming the value and stating the rule', () => {
  const out = validateConfigPatch({ bindHost: 'localhost' }, { normalizeOrigin });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.error, /"localhost"/);
  assert.ok(out.error.endsWith(BIND_HOST_RULE));
});

/* ──────────────────────────────────────────────────────── allowedOrigins ─── */

test('origins go through normalizeOrigin and come back as a browser spells them', () => {
  const out = validateConfigPatch(
    { allowedOrigins: ['HTTP://192.0.2.10:48770/some/path', 'http://panel.local:48770'] },
    { normalizeOrigin },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.patch.allowedOrigins, ['http://192.0.2.10:48770', 'http://panel.local:48770']);
});

test('an invalid origin is a refusal that names it, never a silent drop', () => {
  // Silently dropping is the failure this asserts against: a control that appears to have
  // worked and did not.
  const out = validateConfigPatch({ allowedOrigins: ['http://192.0.2.10:48770', 'not an origin'] }, { normalizeOrigin });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.error, /"not an origin"/);
  assert.match(out.error, /nothing else was either/);
});

test('blank rows are what an empty add box leaves behind, and duplicates collapse', () => {
  const out = validateConfigPatch(
    { allowedOrigins: ['', '   ', 'http://192.0.2.10:48770', 'http://192.0.2.10:48770/'] },
    { normalizeOrigin },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.patch.allowedOrigins, ['http://192.0.2.10:48770']);
});

test('allowedOrigins must be an array', () => {
  const out = validateConfigPatch({ allowedOrigins: 'http://192.0.2.10:48770' }, { normalizeOrigin });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
});

/* ─────────────────────────────────────────── what this endpoint will not do ─── */

test('sessionPrefix is refused by name, with the reason', () => {
  const out = validateConfigPatch({ sessionPrefix: 'x-' }, { normalizeOrigin });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.equal(out.error, PREFIX_REFUSAL);
  assert.match(out.error, /unnames every session already running/);
});

test('an unknown key is refused rather than written — this is not a general write channel', () => {
  const out = validateConfigPatch({ bindHost: '127.0.0.1', triggerToken: 'hunter2' }, { normalizeOrigin });
  assert.equal(out.ok, false);
  assert.equal(out.status, 400);
  assert.match(out.error, /triggerToken/);
  assert.deepEqual(WRITABLE_KEYS, ['bindHost', 'allowedOrigins']);
});

test('a body that is not an object is refused', () => {
  for (const body of [null, 'bindHost=0.0.0.0', 42, ['bindHost']]) {
    assert.equal(validateConfigPatch(body, { normalizeOrigin }).ok, false);
  }
});

/* ───────────────────────────────────────────────────────────── the writer ─── */

/** A fresh `config.json` under its own subdirectory, so cases cannot see each other's. */
function withConfig(name, body) {
  const home = path.join(dir, name);
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  if (body !== undefined) fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  return file;
}

test('the write lands, and only the keys that moved are reported as changed', () => {
  const file = withConfig('write', { bindHost: '127.0.0.1', sessionPrefix: 'foreman-', allowedOrigins: [] });
  const out = writeConfigFile(file, { bindHost: '0.0.0.0', allowedOrigins: [] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.changed, ['bindHost']); // allowedOrigins was already `[]`
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
    bindHost: '0.0.0.0',
    sessionPrefix: 'foreman-',
    allowedOrigins: [],
  });
});

test('re-saving the same value changes nothing, so nothing tells you to restart', () => {
  const file = withConfig('noop', { bindHost: '0.0.0.0', allowedOrigins: ['http://192.0.2.10:48770'] });
  const out = writeConfigFile(file, { bindHost: '0.0.0.0', allowedOrigins: ['http://192.0.2.10:48770'] });
  assert.equal(out.ok, true);
  assert.deepEqual(out.changed, []);
});

test('a key this version never heard of survives the write', () => {
  // A settings surface that truncated the file to the fields it knows would be a downgrade
  // that eats data — a newer panel's key, or a line somebody added by hand.
  const file = withConfig('unknown', {
    bindHost: '127.0.0.1',
    sessionPrefix: 'foreman-',
    allowedOrigins: [],
    somethingLater: { deep: [1, 2, 3] },
  });
  const out = writeConfigFile(file, { bindHost: '0.0.0.0' });
  assert.equal(out.ok, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(after.somethingLater, { deep: [1, 2, 3] });
  assert.equal(after.sessionPrefix, 'foreman-');
  assert.equal(after.bindHost, '0.0.0.0');
});

test('the prefix cannot be reached through the writer either — validation is what stops it', () => {
  // Belt and braces: `validateConfigPatch` never produces a `sessionPrefix` key, and this
  // pins that the endpoint's only path to the writer goes through it.
  const file = withConfig('prefix-guard', { sessionPrefix: 'foreman-' });
  const check = validateConfigPatch({ sessionPrefix: 'x-' }, { normalizeOrigin });
  assert.equal(check.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionPrefix, 'foreman-');
});

test('an unparseable file is refused, not merged into and overwritten', () => {
  // `readConfigFile` answers `{}` for this, which is right for a boot (settings that are
  // not there) and catastrophic for a write: a typo an editor could fix in ten seconds
  // would become a two-key file with the rest thrown away.
  const broken = '{ "bindHost": "0.0.0.0",\n  "allowedOrigins": [ }';
  const file = withConfig('broken', broken);
  const out = writeConfigFile(file, { bindHost: '127.0.0.1' });
  assert.equal(out.ok, false);
  assert.equal(out.status, 409);
  assert.equal(fs.readFileSync(file, 'utf8'), broken);
});

test('no file yet is written, not refused — the seed only runs at boot', () => {
  const file = withConfig('absent');
  const out = writeConfigFile(file, { bindHost: '0.0.0.0', allowedOrigins: [] });
  assert.equal(out.ok, true);
  // Every key is new, so every key moved. `changed` is about the *file*, not about
  // whether the panel's behaviour would differ — a key that was absent and now says `[]`
  // reads the same at boot but is a real edit to a real file, and over-reporting there
  // costs a restart notice nobody needed while under-reporting costs a setting that
  // silently is not in force.
  assert.deepEqual(out.changed, ['bindHost', 'allowedOrigins']);
  assert.equal(readConfigFile(file).config.bindHost, '0.0.0.0');
});

test('the write is atomic and leaves no temp file behind', () => {
  const file = withConfig('atomic', { bindHost: '127.0.0.1' });
  const home = path.dirname(file);
  const out = writeConfigFile(file, { bindHost: '0.0.0.0' });
  assert.equal(out.ok, true);
  // Same directory, so `rename` is atomic within one filesystem — and nothing left over.
  assert.deepEqual(fs.readdirSync(home), ['config.json']);
  // A reader sees the whole file or the old one, never half of either.
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('a directory that cannot be written to is a 500 with the path, not a throw', () => {
  const home = path.join(dir, 'readonly');
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ bindHost: '127.0.0.1' }));
  fs.chmodSync(home, 0o500);
  try {
    const out = writeConfigFile(file, { bindHost: '0.0.0.0' });
    assert.equal(out.ok, false);
    assert.equal(out.status, 500);
    assert.match(out.error, /Could not write/);
  } finally {
    fs.chmodSync(home, 0o700);
  }
});
