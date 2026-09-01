import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAllowed,
  checkOrigin,
  classifyInterfaces,
  normalizeOrigin,
  originBootLines,
} from '../server/origin.js';

/*
 * The origin check — the pure function alone, no server anywhere.
 *
 * It is a **browser guard, not authentication**: a web page on some foreign site must not
 * be able to make the maintainer's own browser act as a LAN peer. Nothing here restricts a LAN peer,
 * and every test below that allows something is a test that the 2026-08-27 ruling still
 * holds — curl works, the hook works, `mcp/foreman.js` works, all by having no `Origin` header
 * at all rather than by being on a list.
 *
 * **The interface table is a fixture, never this Mac's.** The defect the exclusion filter
 * exists for was written from a description of `os.networkInterfaces()` rather than its
 * output, and a test that reads the real table would pass on this machine and prove
 * nothing about anyone else's — or, worse, start failing the day a VPN comes up.
 */

const PORT = 48770;

/**
 * The shape a real machine returns, with the addresses invented.
 *
 * Modelled on a measured table: one wifi interface carrying a private IPv4 *and* a
 * unique-local IPv6 *and* a link-local IPv6; several `utun` tunnels; and `awdl0`/`llw0`,
 * which are AirDrop's peer-to-peer interfaces and are the reason link-local is excluded by
 * name rather than by accident.
 */
const INTERFACES = {
  lo0: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
  ],
  en1: [
    { address: '192.168.7.20', family: 'IPv4', internal: false },
    { address: 'fd00:1234:5678:1::20', family: 'IPv6', internal: false },
    { address: 'fe80::1c2:3d4:5e6:7f8', family: 'IPv6', internal: false },
  ],
  awdl0: [{ address: 'fe80::aaaa:bbbb:cccc:dddd', family: 'IPv6', internal: false }],
  llw0: [{ address: 'fe80::eeee:ffff:1111:2222', family: 'IPv6', internal: false }],
  utun0: [{ address: 'fe80::3333:4444:5555:6666', family: 'IPv6', internal: false }],
  utun3: [{ address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }],
  en5: [{ address: '10.4.5.6', family: 'IPv4', internal: false }],
};

const build = (over = {}) =>
  buildAllowed({
    port: PORT,
    interfaces: INTERFACES,
    localHostName: 'sandbox-mini',
    env: {},
    ...over,
  });

const verdict = (origin, over = {}) => checkOrigin(origin, { allowed: build(over).allowed });

/* ─────────────────────────────────────────────────── clause 1: no Origin header ─── */

test('no Origin header is allowed — curl, the hook, mcp/foreman.js, every non-browser caller', () => {
  const { allowed } = build();
  for (const absent of [undefined, null, '']) {
    const v = checkOrigin(absent, { allowed });
    assert.equal(v.allowed, true, `${JSON.stringify(absent)} should be allowed`);
    assert.match(v.reason, /no Origin header/);
  }
});

test('an opaque `Origin: null` is refused — a sandboxed frame is not a missing header', () => {
  // The one that would quietly hand the guard back: a sandboxed iframe or a `data:` URL
  // sends the literal string `null`, and treating that as "absent" would let any page
  // that can open a frame through.
  const v = verdict('null');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /opaque origin/);
});

/* ────────────────────────────────────────────────────── clause 2: loopback, any port ─── */

test('every loopback spelling is allowed, on any port', () => {
  for (const origin of [
    'http://localhost:48770',
    'http://localhost:8999',
    'http://127.0.0.1:3000',
    'http://127.0.0.2:8080',
    'http://[::1]:5173',
    'https://localhost:8443',
  ]) {
    const v = verdict(origin);
    assert.equal(v.allowed, true, `${origin} should be allowed`);
    assert.equal(v.reason, 'loopback origin');
  }
});

test('a foreign host that merely starts with a loopback spelling is refused', () => {
  // The whole reason the check parses rather than prefix-matches.
  for (const origin of [
    'http://127.0.0.1.evil.example',
    'http://localhost.evil.example:48770',
    'http://evil.example/?x=http://127.0.0.1:48770',
  ]) {
    assert.equal(verdict(origin).allowed, false, `${origin} must be refused`);
  }
});

/* ──────────────────────────────────── clause 3: this machine's own LAN addresses ─── */

test('a private IPv4 on the panel’s own port is allowed; the wrong port is not', () => {
  assert.equal(verdict(`http://192.168.7.20:${PORT}`).allowed, true);
  assert.equal(verdict('http://192.168.7.20:8080').allowed, false);
  assert.equal(verdict('http://192.168.7.20').allowed, false); // port 80
});

test('the unique-local IPv6 on the same interface is allowed too — dropping IPv6 would be wrong', () => {
  assert.equal(verdict(`http://[fd00:1234:5678:1::20]:${PORT}`).allowed, true);
});

test('10/8 and 172.16/12 count; a public IPv4 does not', () => {
  assert.equal(verdict(`http://10.4.5.6:${PORT}`).allowed, true);
  const withPublic = {
    interfaces: {
      en1: [
        { address: '172.20.1.1', family: 'IPv4', internal: false },
        { address: '203.0.113.9', family: 'IPv4', internal: false },
        { address: '172.32.0.1', family: 'IPv4', internal: false }, // just outside 172.16/12
      ],
    },
  };
  assert.equal(verdict(`http://172.20.1.1:${PORT}`, withPublic).allowed, true);
  assert.equal(verdict(`http://203.0.113.9:${PORT}`, withPublic).allowed, false);
  assert.equal(verdict(`http://172.32.0.1:${PORT}`, withPublic).allowed, false);
});

test('IPv6 link-local is refused, AirDrop’s interfaces included', () => {
  // Seven of twelve non-internal addresses on a measured machine were link-local, and two
  // of those were `awdl0`/`llw0` — AirDrop peer-to-peer, not "this Mac's LAN" in any sense.
  for (const origin of [
    `http://[fe80::1c2:3d4:5e6:7f8]:${PORT}`,
    `http://[fe80::aaaa:bbbb:cccc:dddd]:${PORT}`,
    `http://[fe80::eeee:ffff:1111:2222]:${PORT}`,
  ]) {
    assert.equal(verdict(origin).allowed, false, `${origin} must be refused`);
  }
});

test('a utun tunnel is refused even when its address would otherwise qualify', () => {
  // `utun3` carries `fd7a:115c:a1e0::1` — unique-local, so the address filter alone would
  // let it in. It is refused on the interface, because that is where a VPN and Tailscale
  // land and allowing every tunnel is a decision nobody has taken.
  assert.equal(verdict(`http://[fd7a:115c:a1e0::1]:${PORT}`).allowed, false);
  const row = classifyInterfaces(INTERFACES).find((r) => r.iface === 'utun3');
  assert.equal(row.included, false);
  assert.match(row.reason, /tunnel/);
});

test('the .local mDNS name is allowed at the panel’s port, case-insensitively', () => {
  assert.equal(verdict(`http://sandbox-mini.local:${PORT}`).allowed, true);
  assert.equal(verdict(`http://SANDBOX-MINI.local:${PORT}`).allowed, true);
  assert.equal(verdict('http://sandbox-mini.local:9999').allowed, false);
  // A name already carrying `.local` must not become `.local.local`.
  const { mdnsOrigin } = build({ localHostName: 'sandbox-mini.local' });
  assert.equal(mdnsOrigin, `http://sandbox-mini.local:${PORT}`);
  // No name at all is simply no entry, not a crash and not a wildcard.
  assert.equal(build({ localHostName: '' }).mdnsOrigin, null);
});

/* ──────────────────────────────────────────────────────── clause 4: everything else ─── */

test('a foreign origin is refused, and the verdict names it so the 403 body can', () => {
  const v = verdict('http://evil.example');
  assert.equal(v.allowed, false);
  assert.equal(v.origin, 'http://evil.example');
  assert.match(v.reason, /not a loopback or local-network origin/);
});

test('an unparseable Origin is refused, including the duplicate-header join', () => {
  // Node joins repeated headers with ", ". That must not be picked apart into "the first
  // one" — it does not parse as a URL, so it is refused.
  for (const origin of ['not a url', `http://localhost:${PORT}, http://evil.example`, '://x']) {
    const v = checkOrigin(origin, { allowed: build().allowed });
    assert.equal(v.allowed, false, `${origin} must be refused`);
  }
});

/* ────────────────────────────────────────────────── the assembled extension point ─── */

test('$FOREMAN_ALLOWED_ORIGIN contributes, and junk in it is reported rather than added', () => {
  const one = build({ env: { FOREMAN_ALLOWED_ORIGIN: 'https://panel.example:8443' } });
  assert.equal(checkOrigin('https://panel.example:8443', { allowed: one.allowed }).allowed, true);

  // Comma- or space-separated, so one variable can carry more than one.
  const many = build({ env: { FOREMAN_ALLOWED_ORIGIN: 'http://a.example, http://b.example' } });
  assert.equal(checkOrigin('http://a.example', { allowed: many.allowed }).allowed, true);
  assert.equal(checkOrigin('http://b.example', { allowed: many.allowed }).allowed, true);

  const bad = build({ env: { FOREMAN_ALLOWED_ORIGIN: 'panel.example' } });
  assert.deepEqual(bad.rejected, ['panel.example']);
  assert.equal(checkOrigin('http://panel.example', { allowed: bad.allowed }).allowed, false);
});

test('a config object contributes too — the settings file does not exist yet, the argument does', () => {
  const b = build({ config: { allowedOrigins: ['http://tailnet.example:48770'] } });
  assert.equal(checkOrigin('http://tailnet.example:48770', { allowed: b.allowed }).allowed, true);
  // Absent, empty, or the wrong shape must all mean "no extra origins", never a throw.
  for (const config of [undefined, {}, { allowedOrigins: null }, { allowedOrigins: 'nope' }]) {
    assert.equal(checkOrigin('http://tailnet.example:48770', { allowed: build({ config }).allowed }).allowed, false);
  }
});

test('normalizeOrigin keeps a scheme+host+port and refuses anything else', () => {
  assert.equal(normalizeOrigin('HTTP://Example.COM:48770/some/path'), 'http://example.com:48770');
  assert.equal(normalizeOrigin('https://example.com'), 'https://example.com');
  for (const junk of ['', '   ', 'example.com', 'ws://example.com', 'file:///etc/passwd', null]) {
    assert.equal(normalizeOrigin(junk), null, `${junk} should not normalize`);
  }
});

/* ────────────────────────────────────────────────────────────── the boot report ─── */

test('the boot lines name every allowed origin and summarise what was excluded', () => {
  const built = build({ env: { FOREMAN_ALLOWED_ORIGIN: 'http://extra.example:1234' } });
  const text = originBootLines({ port: PORT, built }).join('\n');

  assert.match(text, /not authentication/);
  assert.match(text, /no Origin header/);
  assert.match(text, /loopback, any port/);
  assert.match(text, new RegExp(`http://192\\.168\\.7\\.20:${PORT}\\s+en1`));
  assert.match(text, new RegExp(`http://\\[fd00:1234:5678:1::20\\]:${PORT}\\s+en1`));
  assert.match(text, new RegExp(`http://sandbox-mini\\.local:${PORT}`));
  assert.match(text, /http:\/\/extra\.example:1234\s+configured/);
  assert.match(text, /Excluded here:.*link-local/);
  assert.match(text, /Excluded here:.*tunnel/);
  // Nothing excluded may appear as an allowed line.
  assert.doesNotMatch(text, /allow\s+http:\/\/\[fe80/);
  assert.doesNotMatch(text, /allow\s+http:\/\/\[fd7a/);
});
