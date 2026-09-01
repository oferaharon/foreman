/**
 * Where a request came from — a **browser guard, not authentication**.
 *
 * Say that in those words, because the distinction is the whole design. The maintainer's
 * standing ruling of 2026-08-27 is that the panel binds `0.0.0.0` and gets **no
 * authentication**, deliberately, argued and decided: anyone who can reach the port may
 * launch sessions, type into any session on this Mac, answer prompts and read every
 * transcript. Nothing in this file restricts a LAN peer, and nothing here is a boot guard.
 * What it buys is the *browser* case: **a web page on some foreign site must not be able to
 * make the maintainer's own browser act as a LAN peer.**
 *
 * That is a real hole and it was measured, not imagined. `/ws` was mounted with no
 * `verifyClient`, and a WebSocket handshake is **not subject to CORS and triggers no
 * preflight** — so any `http://` page could open `ws://<this-mac>:48770/ws`, be handed the
 * full roster on connect, `subscribe` to any transcript on the machine and send `markRead`.
 * And the roster frame's `id` is the session UUID that `/hook` accepts as `text/plain`
 * (also no preflight), so the same page could then write false status for any session.
 * The socket is the bigger half; `/hook` alone was nearly harmless because the ids are
 * UUIDs and the socket is what hands them out.
 *
 * The rule, in order, and each clause is here for a reason:
 *
 *   1. **No `Origin` header → allow.** curl, the hook's own curl (`install-hook.js`),
 *      `mcp/foreman.js` (which calls `http://127.0.0.1:${PORT}`), the trigger endpoint's
 *      webhook callers. Every non-browser caller is unaffected *by construction* rather
 *      than by an allowlist somebody has to maintain. Browsers set this header themselves
 *      and a page cannot suppress it — `Origin` is a forbidden header name, so `fetch`
 *      cannot remove or forge it.
 *   2. **Loopback origin on any port → allow.** `http://localhost:*`, `http://127.0.0.1:*`,
 *      `http://[::1]:*`. A browser sets `Origin` from the page's real URL, so a remote page
 *      cannot forge a loopback one; and a page genuinely served from this machine is
 *      already inside the trust boundary. Any port, because a scratch static server on
 *      8999 is a normal thing to be doing.
 *   3. **This Mac's own private-LAN addresses, at the panel's own port, plus the `.local`
 *      mDNS name → allow.** Derived from `os.networkInterfaces()`, so a DHCP lease change
 *      fixes itself and there is no list to maintain. This is the clause that keeps the
 *      phone working.
 *   4. **Anything else → 403**, with a body naming the origin refused. A silent refusal
 *      here would be the trigger-token 503 all over again: one hour lost to a feature that
 *      was off looking exactly like a feature that was broken.
 *
 * The decision is a pure function of its inputs (`checkOrigin`, `buildAllowed`,
 * `classifyInterfaces`) so the whole of it is testable with a fake interface table and no
 * server anywhere — see `test/origin.test.js`. The two wrappers at the bottom
 * (`originGuard`, `verifyOrigin`) are the only parts that touch a live request.
 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { PORT } from './config.js';

/**
 * How long a derived address list is trusted before it is rebuilt.
 *
 * `os.networkInterfaces()` is cheap but not free, and this runs on every non-GET request
 * and every socket upgrade. Thirty seconds is well under the time it takes to notice a
 * DHCP lease has moved, and well over the rate at which anything asks.
 */
const DERIVE_TTL_MS = 30_000;

/* ────────────────────────────────────────────────────────── the address filter ─── */

/**
 * Is this an RFC-1918 private IPv4 address? `10/8`, `172.16/12`, `192.168/16`.
 */
function isPrivateV4(address) {
  const parts = String(address).split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((n) => Number(n));
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** The first 16 bits of an IPv6 address, or `null` if it doesn't parse as one. */
function firstHextet(address) {
  const head = String(address).toLowerCase().split('%')[0].split(':')[0];
  // `::1` and `::` start with an empty group, which means those bits are zero.
  if (head === '') return 0;
  if (!/^[0-9a-f]{1,4}$/.test(head)) return null;
  return Number.parseInt(head, 16);
}

/** IPv6 unique-local, `fc00::/7` — the top seven bits are `1111110`. */
function isUniqueLocalV6(address) {
  const h = firstHextet(address);
  return h !== null && ((h >> 8) & 0xfe) === 0xfc;
}

/** IPv6 link-local, `fe80::/10`. */
function isLinkLocalV6(address) {
  const h = firstHextet(address);
  return h !== null && (h & 0xffc0) === 0xfe80;
}

const familyOf = (addr) => (addr.family === 6 || addr.family === 'IPv6' ? 'IPv6' : 'IPv4');

/**
 * Decide, per address, whether it is one of *this Mac's LAN addresses*.
 *
 * **This is a filter, not "everything non-internal", and the exclusions are the point.**
 * The first draft of this clause was written from a description of
 * `os.networkInterfaces()` rather than from its output on a real machine, and said every
 * non-internal address. On this Mac that call returns **twelve** non-internal addresses
 * and exactly **one** of them is the LAN address the phone uses. So:
 *
 * - **Exclude IPv6 link-local (`fe80::/10`).** Seven of the twelve here, and two of those
 *   are `awdl0` and `llw0` — **AirDrop's peer-to-peer interfaces**. Those are not "this
 *   Mac's LAN" in any sense a reader of the phrase would expect, and a link-local address
 *   is not something a browser reaches the panel on anyway.
 * - **Exclude `utun*` tunnels.** That is where a **VPN** lands — and it is where
 *   **Tailscale** lands. Allowing every tunnel would ship a panel reachable from every VPN
 *   this Mac ever joins, without anyone having decided that. Tailscale is deliberately not
 *   built here: the honest shape of the deferral is *filter now, allow selectively later*
 *   — the day it is wanted it becomes a **named** contributor to `buildAllowed`, chosen on
 *   purpose. The wrong framing, and the one the first draft implied, is "everything
 *   non-internal happens to include Tailscale, so it already works".
 * - **Include both families.** `en1` carries a `192.168.x.x` **and** an `fd00:` address,
 *   so dropping IPv6 would be wrong.
 *
 * If you are here to simplify this list: that is the bug it was written to prevent. The
 * comment above is the reason, and it is not tidiness.
 *
 * Returns one row per address — included or not, and why — because the boot block prints
 * them. A derived list nobody looks at is exactly how the original defect survived.
 */
export function classifyInterfaces(interfaces = os.networkInterfaces()) {
  const rows = [];
  for (const [iface, addrs] of Object.entries(interfaces || {})) {
    for (const addr of addrs || []) {
      const family = familyOf(addr);
      const row = { iface, family, address: addr.address, included: false, reason: '' };

      if (addr.internal) {
        // Loopback is clause 2's job, on any port, and it does not depend on a lease.
        row.reason = 'loopback interface — allowed by the loopback clause, on any port';
      } else if (/^utun/.test(iface)) {
        row.reason = 'tunnel interface — a VPN (and Tailscale) lands here; not decided yet';
      } else if (family === 'IPv4') {
        if (isPrivateV4(addr.address)) {
          row.included = true;
          row.reason = 'private IPv4 (RFC-1918)';
        } else {
          row.reason = 'IPv4 outside RFC-1918 — not a private LAN address';
        }
      } else if (isLinkLocalV6(addr.address)) {
        row.reason = /^(awdl|llw)/.test(iface)
          ? 'IPv6 link-local on an AirDrop peer-to-peer interface'
          : 'IPv6 link-local (fe80::/10)';
      } else if (isUniqueLocalV6(addr.address)) {
        row.included = true;
        row.reason = 'IPv6 unique-local (fc00::/7)';
      } else {
        row.reason = 'IPv6 outside fc00::/7 — not a private LAN address';
      }

      rows.push(row);
    }
  }
  return rows;
}

/* ─────────────────────────────────────────────────────────────── the allowlist ─── */

/** `http://host:port`, with IPv6 bracketed and the host lowercased, as a browser sends it. */
function originFor(address, port, family = 'IPv4') {
  const host = family === 'IPv6' ? `[${String(address).split('%')[0]}]` : String(address);
  return `http://${host.toLowerCase()}:${port}`;
}

/**
 * Normalise anything hand-written — an env var, a config entry — to the exact string a
 * browser would send, or `null` if it isn't an origin at all. A typo silently ignored is
 * better than a typo that widens the allowlist, and worse than a boot line saying so, so
 * the caller gets `null` and prints it.
 */
export function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Every origin this panel will accept a write from, as an exact-match `Set`.
 *
 * **Assembled**, deliberately, so a later contributor is one more line here rather than a
 * rewrite: loopback is not in the set at all (it is a rule, clause 2, so it holds on any
 * port); the derived private-LAN addresses go in at the panel's own port; then
 * `config.allowedOrigins` — `<STATE_DIR>/config.json`, read once at boot by `config.js`
 * and handed in as `ALLOWED_ORIGINS`; then `$FOREMAN_ALLOWED_ORIGIN`, which keeps working
 * *alongside* the file rather than being replaced by it. §B2's settings surface will write
 * that file; nothing here needs to change when it does.
 *
 * On that env var's name: it moved to the `FOREMAN_` prefix with every other environment
 * name in this repo, in one pass, rather than arriving early and alone.
 */
export function buildAllowed({
  port = PORT,
  interfaces = os.networkInterfaces(),
  localHostName = '',
  config = {},
  env = process.env,
} = {}) {
  const rows = classifyInterfaces(interfaces);
  const allowed = new Set();
  const rejected = [];

  for (const row of rows) {
    if (row.included) allowed.add(originFor(row.address, port, row.family));
  }

  // The mDNS name, which is how a phone reaches the panel by name rather than by a lease
  // that moves. `scutil --get LocalHostName` on macOS; the machine's hostname elsewhere.
  const mdns = String(localHostName || '').trim().replace(/\.local\.?$/i, '');
  const mdnsOrigin = mdns ? `http://${mdns.toLowerCase()}.local:${port}` : null;
  if (mdnsOrigin) allowed.add(mdnsOrigin);

  const extras = [
    ...(Array.isArray(config?.allowedOrigins) ? config.allowedOrigins : []),
    // Comma- or space-separated, so one variable can carry more than one origin without
    // needing a second variable the day somebody has two.
    ...String(env?.FOREMAN_ALLOWED_ORIGIN || '').split(/[\s,]+/),
  ];
  for (const extra of extras) {
    if (!String(extra || '').trim()) continue;
    const norm = normalizeOrigin(extra);
    if (norm) allowed.add(norm);
    else rejected.push(String(extra).trim());
  }

  return { allowed, rows, mdnsOrigin, rejected };
}

/* ──────────────────────────────────────────────────────────────── the decision ─── */

/** Is this hostname one of the loopback spellings? Parsed, never prefix-matched — */
/* `http://127.0.0.1.evil.example` starts with the right characters and is a foreign site. */
function isLoopbackHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (host === 'localhost') return true;
  if (host === '::1' || host === '[::1]') return true;
  // The whole of 127/8 is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The rule itself. `origin` is the raw header value, or `undefined`/`null` when absent.
 *
 * Returns `{ allowed, reason, origin }` rather than a bare boolean so the 403 body and the
 * boot line can both say *why* without re-deriving it.
 */
export function checkOrigin(origin, { allowed = new Set() } = {}) {
  // Clause 1. An absent header is every non-browser caller — curl, the hook, mcp/foreman.js.
  // An *empty* header is the same case: a browser cannot send one (`Origin` is a forbidden
  // header name, so a page can neither remove nor forge it), so an empty value is a
  // hand-made request that simply set the header to nothing.
  if (origin === undefined || origin === null || String(origin).trim() === '') {
    return { allowed: true, reason: 'no Origin header — not a browser request', origin: null };
  }

  const raw = String(origin).trim();

  // `Origin: null` is a browser saying "an opaque origin" — a sandboxed iframe, a
  // `data:` URL, a page loaded from `file://`. It is attacker-reachable and names nobody,
  // so it is refused. This is not the same as the header being absent, and conflating the
  // two would hand the guard back to anything that can open a sandboxed frame.
  if (raw.toLowerCase() === 'null') {
    return { allowed: false, reason: 'opaque origin (sandboxed frame, data: or file: URL)', origin: raw };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    // Includes the duplicate-header case: node joins repeated headers with ", ", which
    // does not parse as a URL and must not be picked apart into "the first one".
    return { allowed: false, reason: 'unparseable Origin header', origin: raw };
  }

  // Clause 2. Loopback on any port and either scheme: a page served from this machine.
  if (/^https?:$/.test(url.protocol) && isLoopbackHost(url.hostname)) {
    return { allowed: true, reason: 'loopback origin', origin: url.origin.toLowerCase() };
  }

  // Clause 3. This Mac's own private-LAN addresses and its `.local` name, at our own port.
  const normalized = url.origin.toLowerCase();
  if (allowed.has(normalized)) {
    return { allowed: true, reason: "this machine's own LAN address", origin: normalized };
  }

  // Clause 4.
  return { allowed: false, reason: 'not a loopback or local-network origin', origin: normalized };
}

/* ────────────────────────────────────────────────────────── derivation + cache ─── */

let cached = null; // { at, built }
let hostNameCache; // undefined = not looked up yet

/**
 * `scutil --get LocalHostName`, once per process.
 *
 * Cached separately from the address list and for longer: a DHCP lease moves during a
 * panel's life and a machine's own name does not, and this is a subprocess we would rather
 * not spawn on a thirty-second timer. Any failure — a non-macOS machine, `scutil` missing,
 * a name that is empty — falls back to the plain hostname, and an empty answer just means
 * the `.local` origin isn't in the list.
 */
export function readLocalHostName() {
  if (hostNameCache !== undefined) return hostNameCache;
  let name = '';
  try {
    name = execFileSync('scutil', ['--get', 'LocalHostName'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* not macOS, or scutil had nothing to say — the hostname below is the fallback */
  }
  if (!name) name = String(os.hostname() || '').replace(/\.local\.?$/i, '').trim();
  hostNameCache = name;
  return name;
}

/** The assembled allowlist, rebuilt at most every `DERIVE_TTL_MS`. */
export function currentAllowed({ port = PORT, config = {}, now = Date.now(), force = false } = {}) {
  if (!force && cached && now - cached.at < DERIVE_TTL_MS) return cached.built;
  const built = buildAllowed({
    port,
    interfaces: os.networkInterfaces(),
    localHostName: readLocalHostName(),
    config,
  });
  cached = { at: now, built };
  return built;
}

/* ───────────────────────────────────────────────────────────────── boot report ─── */

/**
 * What the boot prints. One line per allowed origin with the interface it came from and
 * why, and one summary line for what was excluded.
 *
 * This exists because the exclusion defect above was written from a *description* of
 * `os.networkInterfaces()` instead of its output, and a derived list nobody ever looks at
 * is how that comes back. Printing it costs six lines a boot and makes the derivation
 * something a human can check in a second.
 */
export function originBootLines({ port = PORT, config = {}, built = null } = {}) {
  // `config` is forwarded, and that is not decoration: `currentAllowed` caches its answer
  // for `DERIVE_TTL_MS`, so a boot report built *without* the configured origins would
  // leave the first thirty seconds of requests being judged against a list the boot line
  // above them says is longer.
  const b = built || currentAllowed({ port, config, force: true });
  const lines = ['Origins: browser guard on — this is not authentication (LAN peers are unaffected)'];
  lines.push('  allow  (no Origin header)              curl, the status hook, mcp/foreman.js');
  lines.push(`  allow  http://localhost|127.0.0.1|[::1]:*   loopback, any port`);

  for (const row of b.rows) {
    if (!row.included) continue;
    lines.push(`  allow  ${originFor(row.address, port, row.family).padEnd(46)} ${row.iface} — ${row.reason}`);
  }
  if (b.mdnsOrigin) lines.push(`  allow  ${b.mdnsOrigin.padEnd(46)} mDNS name (scutil --get LocalHostName)`);

  for (const origin of b.allowed) {
    // Anything in the set that isn't one of the two derived kinds came from the config
    // object or `$FOREMAN_ALLOWED_ORIGIN`, and a hand-added origin is worth its own line.
    const derived =
      origin === b.mdnsOrigin ||
      b.rows.some((r) => r.included && originFor(r.address, port, r.family) === origin);
    if (!derived) lines.push(`  allow  ${origin.padEnd(46)} configured ($FOREMAN_ALLOWED_ORIGIN or config)`);
  }
  for (const bad of b.rejected) {
    lines.push(`  ignored  ${bad} — not a valid origin (want scheme://host:port)`);
  }

  const excluded = b.rows.filter((r) => !r.included);
  if (excluded.length) {
    const counts = new Map();
    for (const row of excluded) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
    const summary = [...counts].map(([reason, n]) => `${n} ${reason}`).join('; ');
    lines.push(`  refuse everything else — 403. Excluded here: ${summary}`);
  }
  return lines;
}

/* ─────────────────────────────────────────────────────────────── the two hooks ─── */

/**
 * The express middleware. **`GET` (and `HEAD`) are deliberately not gated.**
 *
 * The reasoning, in the code because this is precisely what a later reader "tightens": a
 * cross-origin page can *send* a GET but it cannot *read the response*, because this
 * server never sends an `Access-Control-Allow-Origin` header — so the roster, the room and
 * every transcript served over HTTP are already protected by the plain absence of CORS.
 * Gating GET adds no protection and risks breaking something that works (the static panel,
 * an image, a `<script>` tag), which is a bad trade in both directions.
 *
 * What is *not* covered by that argument is the WebSocket — a handshake is a GET, is not
 * subject to CORS, and hands the roster straight over — which is why `verifyOrigin` below
 * exists as a second call site rather than this middleware being made to cover both.
 */
export function originGuard({ port = PORT, config = {} } = {}) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const { allowed } = currentAllowed({ port, config });
    const verdict = checkOrigin(req.headers?.origin, { allowed });
    if (verdict.allowed) return next();
    // Name the origin. A silent refusal is the trigger-token 503 all over again — the same
    // answer for "this is off" and "this is broken", and an hour to tell them apart.
    res
      .status(403)
      .type('text/plain')
      .send(
        `Refused: origin ${verdict.origin} is not allowed (${verdict.reason}). ` +
          `This panel accepts writes from this machine and its own network only. ` +
          `Add an origin with $FOREMAN_ALLOWED_ORIGIN.\n`,
      );
  };
}

/**
 * The `verifyClient` for the WebSocket server, which is the hole this whole file was
 * written for. Refusing the upgrade means the browser's socket never opens and the roster
 * — every session id on this Mac — is never sent.
 *
 * The callback form, not the boolean one, so the client sees a **403** with a reason
 * rather than `ws`'s default 401.
 */
export function verifyOrigin({ port = PORT, config = {} } = {}) {
  return (info, cb) => {
    const { allowed } = currentAllowed({ port, config });
    const verdict = checkOrigin(info?.origin ?? info?.req?.headers?.origin, { allowed });
    if (verdict.allowed) return cb(true);
    return cb(false, 403, `Refused: origin ${verdict.origin} is not allowed (${verdict.reason})`);
  };
}
