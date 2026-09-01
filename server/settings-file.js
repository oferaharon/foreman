/**
 * `<STATE_DIR>/config.json` — the panel's own settings file, seeded by the panel and
 * never by hand.
 *
 * **The precedence, in one line and in this order:** `$FOREMAN_HOST` → `config.json`'s
 * `bindHost` → `127.0.0.1`. The same shape as the trigger token (`config.js`): the
 * environment first so a one-off override still works and nothing already running changes
 * behaviour, then the file, which is what makes the value survive a restart.
 *
 * Read **once at boot**, like `PORT` and `STATE_DIR`. A change to the file takes effect at
 * the next restart, and the boot line is how you tell which host was used and where it
 * came from.
 *
 * **Why the file is seeded rather than documented.** The bind host is the one setting this
 * panel's exposure depends on, and until now it lived in exactly one place: the
 * LaunchAgent's `EnvironmentVariables`, written by `install-agent.js`. The environment
 * rename kills that key on any machine whose plist predates it — the code stops reading
 * the name the plist spells — and only a *reinstall* writes the replacement, because
 * `launchctl kickstart -k` does not re-read the plist (measured; see `CLAUDE.md`). So
 * there is a window in which
 * "restart the panel" instead of "reinstall the job" produces a panel that comes up
 * perfectly, on loopback, with nothing wrong in any log and a phone that has simply
 * stopped answering. No error is available to look for.
 *
 * This file closes that window from the other side. The first boot of this code on a
 * machine whose plist still carries the wide bind writes `bindHost: "0.0.0.0"` into a file
 * under a **name-independent key**, captured from the environment the panel is actually
 * running in — no human step, and human steps get skipped. A stranger's first boot writes
 * `127.0.0.1` and gets a discoverable file instead of a setting they never knew they had.
 *
 * **If this seeding is ever removed, the ordering rule becomes the only guard** — the
 * rename and the `install-agent` run that rewrites the plist would then have to happen in
 * one sitting, with the terminal open, or the failure above is live and silent. That is
 * the belt; the sequence is the braces. Do not drop one thinking the other covers it.
 *
 * **Seed only when the file is absent, never rewrite one that exists.** The file is a
 * person's answer (or B2's settings surface writing on their behalf), and a boot that
 * "corrects" it would be a boot that quietly undid a decision. An unreadable or malformed
 * file is reported and treated as empty — the panel then falls back to loopback, which is
 * the safe direction to fail in for a setting that decides who can reach it.
 *
 * **The second key, `sessionPrefix`, and why it is *not* seeded into a file that already
 * exists.** Every tmux session this panel mints is named `<prefix><folder>-<label>`, and
 * the panel recognises exactly the sessions carrying that prefix. The prefix used to be a
 * literal in `launch.js` — one word belonging to another tool that happens to run on the
 * maintainer's Mac, which every stranger running this would then find in their own
 * `tmux ls` with no idea what it meant. So it moves here, defaulting to `foreman-`.
 *
 * Precedence is one rung shorter than the host's: **`config.json`'s `sessionPrefix` →
 * `foreman-`**, with no environment override. Every environment name here was renamed
 * wholesale once already, and adding a new one buys a name to carry for the sake of a
 * value nobody wants to set for one boot anyway — since
 * a panel that mints under one prefix and is restarted under another no longer recognises
 * the sessions it just started. Tests inject it as a parameter instead — `sessionName`,
 * `slugFor`, `uniqueSessionName` and `isLeadName` all take one, defaulting to what
 * `config.js` resolved.
 *
 * **It is never inferred from live tmux sessions.** Reading the roster and guessing "most
 * of these start with `x-`, that must be the prefix" is exactly the kind of guess this
 * project refuses everywhere else: it would key a naming contract on whatever else the
 * machine happened to be running, and be wrong on a quiet morning. Absent means the
 * default, said out loud on the boot line.
 *
 * **An invalid value is a warning and the default, never a panel that will not boot** —
 * the same stance as `bindHost`. `validSessionPrefix` is the whole rule: lowercase
 * `[a-z0-9-]`, starting with a letter or digit, ending in `-`. The trailing dash is
 * required rather than appended, because a prefix is what a name `startsWith` and what a
 * tmux `#{m:...*}` pattern matches — appending one silently for a person who wrote
 * `foreman` would mean the file and the running panel disagree about the string.
 *
 * **The file now has a second writer, and it is not a boot.** `PATCH /api/config` — the
 * settings modal — writes `bindHost` and `allowedOrigins` through `writeConfigFile` at the
 * bottom of this file. That does not weaken the seed rule above: seeding still only ever
 * writes an *absent* file, and the surface writes an existing one on a person's say-so,
 * which is the case the seed rule was protecting in the first place. What the surface adds
 * is a guard the boot has no use for — `isLoopbackRemote`, which is the one place in this
 * panel where a LAN peer is treated differently from the machine itself, and the reason is
 * on the function.
 *
 * Deliberately dependency-free: node builtins only, no import of `config.js`. `config.js`
 * owns `STATE_DIR` and therefore the file's *path*, and imports this module for the read
 * and the resolution — one direction, so there is no cycle to reason about and no
 * temporal-dead-zone hazard on a `const` export.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/** What the panel binds when nothing says otherwise. Loopback: a stranger who installs
 *  this does not get a LAN-exposed panel without having asked for one. */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/**
 * What every tmux session this panel mints is named after, when nothing says otherwise.
 *
 * `foreman-` because that is this tool's name, and because a stranger's `tmux ls` should
 * read as something they installed. A maintainer whose machine runs a second launcher
 * with its own naming contract records that tool's prefix in `config.json` instead — the
 * panel then mints and recognises *only* that one, which is the point: there is no
 * two-prefix mode, and adding one would mean the panel claiming sessions it did not
 * start.
 */
export const DEFAULT_SESSION_PREFIX = 'foreman-';

/**
 * A prefix a name can be tested with `startsWith` and a tmux pattern can match on.
 *
 * Lowercase `[a-z0-9-]` because `sanitize` in `launch.js` collapses everything else out
 * of the two components that follow, and a prefix that could contain what those cannot
 * would make the name unreadable back into its parts. Must start with a letter or digit
 * (so `-` and `--` are refused) and must end with `-`, which is the separator every
 * reader of a session name splits on.
 */
const SESSION_PREFIX_RE = /^[a-z0-9][a-z0-9-]*-$/;

/** True for a value this panel will mint names with. Exported for the tests and for
 *  anything that later offers the key as a control. */
export const validSessionPrefix = (value) =>
  typeof value === 'string' && SESSION_PREFIX_RE.test(value);

/**
 * Read the settings file, or explain why there isn't one.
 *
 * Returns `{ config, notes, exists }` and prints nothing — the boot block in `index.js`
 * owns the printing, the same rule `readTokenFile` follows and for the same reason: this
 * module is imported by `config.js`, which is imported by every server module and
 * transitively by most of the tests, and a module that talks at import time talks in all
 * of them.
 *
 * The notes are the point. "There is no file" and "there is a file I could not parse"
 * produce the same silence and mean opposite things.
 */
export function readConfigFile(file) {
  const notes = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      notes.push(`Config at ${file} could not be read (${err.code}) — treating it as absent.`);
    }
    return { config: {}, notes, exists: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Never fatal. A settings file that cannot be parsed is settings that are not there,
    // not a panel that will not boot — but say so loudly, because the fallback below is
    // loopback and a silent fallback here is exactly the dead phone described above.
    notes.push(`Config at ${file} is not valid JSON (${err.message}) — ignoring it, using defaults.`);
    return { config: {}, notes, exists: true };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    notes.push(`Config at ${file} is not a JSON object — ignoring it, using defaults.`);
    return { config: {}, notes, exists: true };
  }
  return { config: parsed, notes, exists: true };
}

/**
 * The host to bind, and where it came from. Pure — hand it an env object and a parsed
 * config and it answers, which is the whole of what the tests need.
 *
 * A non-string or blank `bindHost` is ignored rather than obeyed: `server.listen` would
 * take a number or `null` and do something surprising with it, and a file written by hand
 * is exactly where that arrives.
 */
export function resolveBindHost({ env = process.env, config = {} } = {}) {
  const fromEnv = String(env?.FOREMAN_HOST || '').trim();
  if (fromEnv) return { host: fromEnv, source: '$FOREMAN_HOST' };

  const fromFile = typeof config?.bindHost === 'string' ? config.bindHost.trim() : '';
  if (fromFile) return { host: fromFile, source: 'config.json' };

  return { host: DEFAULT_BIND_HOST, source: 'default' };
}

/**
 * The prefix every session name is minted with and read back through, and where it came
 * from. Pure, like `resolveBindHost` — hand it a parsed config and it answers.
 *
 * Returns `{ prefix, source, note }`. The `note` is the whole reason this returns an
 * object rather than a string: a value that was written down and then ignored is the one
 * case that must not be silent. `file` is only ever quoted into that note — it names the
 * file to open, the same way `readConfigFile`'s notes do. A panel that fell back to `foreman-` because somebody
 * typed `"Voice"` looks, from every side, exactly like a panel nobody configured — and
 * the consequence is a rail that has stopped recognising the sessions on the machine.
 *
 * No environment rung. See the module header: a prefix is not a per-boot value.
 */
export function resolveSessionPrefix({ config = {}, file = 'config.json' } = {}) {
  const raw = config?.sessionPrefix;
  // Only `undefined` is "absent". An explicit `"sessionPrefix": null` in the file is
  // something a person typed and is about to have ignored, which is the one case that has
  // to be noisy — the same distinction `readConfigFile` draws between no file and an
  // unparseable one.
  if (raw === undefined) {
    return { prefix: DEFAULT_SESSION_PREFIX, source: 'default', note: null };
  }
  if (!validSessionPrefix(raw)) {
    const shown = typeof raw === 'string' ? JSON.stringify(raw) : typeof raw;
    return {
      prefix: DEFAULT_SESSION_PREFIX,
      source: 'default',
      note:
        `Config at ${file} has \`sessionPrefix\` ${shown} — it must be lowercase [a-z0-9-], ` +
        `start with a letter or digit and end with \`-\`. Using ${DEFAULT_SESSION_PREFIX} instead.`,
    };
  }
  return { prefix: raw, source: 'config.json', note: null };
}

/** The `allowedOrigins` array, or an empty one. Anything that isn't an array of strings is
 *  dropped here rather than in `origin.js`, which already refuses what it cannot parse. */
export function allowedOriginsFrom(config = {}) {
  const list = config?.allowedOrigins;
  if (!Array.isArray(list)) return [];
  return list.filter((v) => typeof v === 'string' && v.trim());
}

/**
 * Write the file if it is not there, recording the host this boot is *actually using*.
 *
 * Returns `{ seeded, file, error }`. Seeding failing is not fatal — a read-only state dir
 * is a bad day, not a reason to refuse to start — but it is reported, because a seed that
 * silently did not happen is the guard silently not being there.
 *
 * `allowedOrigins` is seeded empty on purpose rather than captured from
 * `$FOREMAN_ALLOWED_ORIGIN`. The host is captured because the plist is about to stop carrying
 * it; nothing is about to be lost on the origins side, that variable keeps working
 * alongside the file, and a boot that quietly froze a live override into a file would be
 * the surprising half of this design rather than the useful half.
 */
export function seedConfigFile(
  file,
  { bindHost = DEFAULT_BIND_HOST, sessionPrefix = DEFAULT_SESSION_PREFIX } = {},
) {
  if (fs.existsSync(file)) return { seeded: false, file };
  const body = {
    bindHost,
    // Written at the default rather than left out, so the key is discoverable in the one
    // file a person will actually open. `bindHost` is captured from the running panel
    // because the plist is about to stop carrying it; this one has nowhere else it could
    // have come from, so the default *is* what this boot used.
    sessionPrefix,
    allowedOrigins: [],
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // `wx` — fail rather than clobber. Between the `existsSync` above and this write is a
    // window, and two panels booting at once is a thing this project has measured.
    fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, { flag: 'wx' });
    return { seeded: true, file };
  } catch (err) {
    if (err.code === 'EEXIST') return { seeded: false, file };
    return { seeded: false, file, error: err };
  }
}

/* ═══════════════════════════════════════════════ B2 — the settings surface ═══
 *
 * Everything below is written for `GET`/`PATCH /api/config` and the modal behind them.
 * The read half above is what a boot uses; this half is what a person uses, and the two
 * have different failure rules — a boot treats an unparseable file as absent and carries
 * on, while a *write* against one refuses, because merging into a file we could not parse
 * would throw away the half somebody is one editor session away from rescuing.
 */

/**
 * The keys whose value decides **who can reach this panel**.
 *
 * Named as a list rather than checked one by one at the endpoint, because the guard below
 * is written as "does this patch touch one of these" — so the day a key that *isn't* about
 * exposure becomes writable, it does not silently inherit the loopback restriction, and
 * the day another one *is*, adding it here is the whole change.
 */
export const EXPOSURE_KEYS = ['bindHost', 'allowedOrigins'];

/** Every key `PATCH /api/config` will write. A whitelist, the same stance
 *  `PATCH /api/team/config` takes: this must never become a general "write anything into
 *  config.json" channel. `sessionPrefix` is deliberately absent — see `PREFIX_REFUSAL`. */
export const WRITABLE_KEYS = ['bindHost', 'allowedOrigins'];

/**
 * Why the prefix is shown and not offered.
 *
 * Not a UI nicety: `SESSION_PREFIX` is resolved once at boot and is the *only* prefix the
 * panel recognises, so a value written here takes effect at the next restart — at which
 * point every session minted under the old prefix stops being named, `slugFor` yields
 * nothing for it, `isLeadName` stops matching the lead and a snapshot can no longer
 * restore a row under its own name. The rail keeps listing them (it lists every Claude
 * pane on the machine) with `label: null`, which is exactly the shape of a change that
 * looks like it did nothing until you need one of the things it broke.
 */
export const PREFIX_REFUSAL =
  '`sessionPrefix` is read-only here. It is resolved once at boot and is the only prefix ' +
  'the panel recognises, so changing it unnames every session already running — they stay ' +
  'in the rail with no label, no duplicate button and no snapshot entry. Edit config.json ' +
  'by hand and restart if you really mean to.';

/* ─────────────────────────────────────────────────── who may change exposure ─── */

/**
 * The address a request actually arrived from — the socket's, and nothing else.
 *
 * **No `X-Forwarded-For`, ever, and that is the point of this function existing rather
 * than the check being inlined.** A header is written by the caller; the peer address is
 * written by the kernel. The whole value of the guard below is that a LAN peer holding
 * `curl` cannot spell its way past it, and a forwarded-for rung would hand it exactly
 * that. If this panel ever sits behind a reverse proxy, that is a decision with its own
 * ruling, not a header this function starts trusting.
 *
 * Returns the address with any IPv6 zone index (`%en0`) trimmed, or `null` when there
 * isn't one — a socket that has already closed, or a fake `req` in a test.
 */
export function remoteAddressOf(req) {
  const raw = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress ?? null;
  const addr = String(raw ?? '').trim().split('%')[0];
  return addr || null;
}

/**
 * Did this request come from **this machine**?
 *
 * The rule the maintainer's 2026-08-27 ruling makes necessary. That ruling is that the
 * panel binds wide and gets no authentication, deliberately — so a LAN peer may do
 * everything the panel does. What it may *not* do is **widen its own access**: `bindHost`
 * and `allowedOrigins` decide who can reach the panel at all, and a peer that could patch
 * them could turn a loopback panel into a LAN one and add its own origin to the allowlist.
 * That is the one asymmetry, and it is the same shape CCC uses (its network-config
 * endpoint is localhost-only while everything else takes the wider allowlist).
 *
 * **This is not the origin guard and does not replace it.** `origin.js` allows a request
 * with *no* `Origin` header at all, by construction, so that curl, the status hook and
 * `mcp/foreman.js` work without an allowlist anyone maintains — which means a LAN peer with
 * curl sails straight through it. That is correct for everything else on this panel and
 * wrong for these two keys, so this is a second, tighter gate in front of them. The origin
 * guard still runs first, and still covers the browser case.
 *
 * Fails **closed**: no address is not loopback. A `req` with no socket is a shape nobody
 * planned for, and the safe direction to guess in for a setting that decides exposure is
 * "not from here".
 *
 * All of 127/8 counts, the same as `origin.js`'s `isLoopbackHost` — and so does the
 * IPv4-mapped spelling `::ffff:127.0.0.1`, which is what a dual-stack listener hands you
 * for a plain `curl 127.0.0.1`. Missing that one would refuse the maintainer's own
 * terminal on a panel bound to `::`.
 */
export function isLoopbackRemote(req) {
  const addr = remoteAddressOf(req);
  if (!addr) return false;
  const host = addr.toLowerCase();
  if (host === '::1') return true;
  // IPv4-mapped IPv6: `::ffff:127.0.0.1`. Some stacks also spell it `::ffff:7f00:1`,
  // which is not handled — it has never been observed from node and guessing at
  // hex spellings is how a guard grows a hole it cannot be read for.
  const v4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/* ──────────────────────────────────────────────────────────────── validation ─── */

/**
 * A bind host this panel will accept: a **literal address**, never a name.
 *
 * `net.isIP` is the whole rule — `127.0.0.1`, `0.0.0.0`, `::1`, `::` and any real IPv4 or
 * IPv6 literal pass; `localhost`, an empty string, a number and a hostname do not. Names
 * are refused rather than resolved because `server.listen` would resolve one at boot,
 * against whatever DNS said at that moment, and a bind address that can change meaning
 * between two boots is the last thing this key should be.
 */
export function validBindHost(value) {
  return typeof value === 'string' && net.isIP(value.trim()) !== 0;
}

/** The sentence a refused `bindHost` comes back with. One place, so the endpoint, the
 *  test and the modal cannot disagree about what the rule is. */
export const BIND_HOST_RULE =
  'bindHost must be a literal address: 127.0.0.1 (this machine only), 0.0.0.0 (every ' +
  'interface), or another IPv4/IPv6 address this machine holds. Host names are refused — ' +
  'they would resolve at boot against whatever DNS said at that moment.';

/**
 * Check a patch body and return the keys to write, or the refusal.
 *
 * Pure, and `normalizeOrigin` is **injected** rather than imported: it lives in
 * `origin.js`, which imports `PORT` from `config.js`, which imports this module — so an
 * import here would close a cycle. Handing it in also means the test exercises the real
 * function rather than a copy of its rules.
 *
 * Returns `{ ok: true, patch }` with normalized values, or `{ ok: false, error, status }`.
 * Every refusal **names the value it refused**: an origin silently dropped from an
 * allowlist is a control that appears to have worked and did not.
 */
export function validateConfigPatch(body, { normalizeOrigin } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'Expected a JSON object of settings to change.' };
  }

  // The prefix first and by name, because it is the one key a person will reasonably try
  // and the generic "unknown key" refusal below would tell them nothing about why.
  if ('sessionPrefix' in body) {
    return { ok: false, status: 400, error: PREFIX_REFUSAL };
  }

  const unknown = Object.keys(body).filter((k) => !WRITABLE_KEYS.includes(k));
  if (unknown.length) {
    return {
      ok: false,
      status: 400,
      error:
        `This endpoint writes ${WRITABLE_KEYS.join(' and ')} and nothing else. ` +
        `Refused: ${unknown.join(', ')}.`,
    };
  }

  const patch = {};

  if ('bindHost' in body) {
    if (!validBindHost(body.bindHost)) {
      const shown = typeof body.bindHost === 'string' ? JSON.stringify(body.bindHost) : typeof body.bindHost;
      return { ok: false, status: 400, error: `bindHost ${shown} is not an address. ${BIND_HOST_RULE}` };
    }
    patch.bindHost = body.bindHost.trim();
  }

  if ('allowedOrigins' in body) {
    if (!Array.isArray(body.allowedOrigins)) {
      return { ok: false, status: 400, error: 'allowedOrigins must be an array of origins like "http://host:port".' };
    }
    const out = [];
    for (const entry of body.allowedOrigins) {
      const raw = typeof entry === 'string' ? entry.trim() : '';
      // A blank row is what an empty "add" box leaves behind, not a value somebody meant.
      if (!raw) continue;
      const norm = normalizeOrigin ? normalizeOrigin(raw) : null;
      if (!norm) {
        return {
          ok: false,
          status: 400,
          error:
            `${JSON.stringify(raw)} is not an origin. Want scheme://host:port — ` +
            `for example http://192.0.2.10:48770. It was not saved, and nothing else was either.`,
        };
      }
      // Exact-match `Set` at the other end, so two spellings of one origin are one entry.
      if (!out.includes(norm)) out.push(norm);
    }
    patch.allowedOrigins = out;
  }

  return { ok: true, patch };
}

/** True when a patch touches something that decides who can reach the panel. Written
 *  against `EXPOSURE_KEYS` rather than spelled out, so the list is the single answer. */
export function touchesExposure(body) {
  if (!body || typeof body !== 'object') return false;
  return EXPOSURE_KEYS.some((key) => key in body);
}

/* ───────────────────────────────────────────────────────────────── the write ─── */

/** Nothing about this needs to be unguessable — it only has to be unique among concurrent
 *  writers in one directory, and it is unlinked either way. */
let tmpCounter = 0;

/**
 * Merge a validated patch into `config.json` and write it **atomically**.
 *
 * Three properties, each of which has a test:
 *
 * - **Atomic.** Written to a temp file *in the same directory* and `rename`d over the
 *   target. Same directory because rename is only atomic within one filesystem, and a
 *   temp dir on another volume would silently degrade to copy-then-delete. A reader that
 *   catches the panel mid-write sees the old file or the new one, never half of either —
 *   which matters because the reader is a boot deciding what to bind.
 * - **Unknown keys survive.** The file is read, merged into, and written back, so a key
 *   this version has never heard of — one a newer panel wrote, one a person added — is
 *   still there afterwards. A settings surface that quietly truncated the file to the
 *   fields it knows would be a downgrade that eats data.
 * - **An unparseable file is refused, not merged into.** `readConfigFile` answers `{}` for
 *   a file it could not parse, which is right for a boot (settings that are not there) and
 *   catastrophic here: merging into `{}` and writing would replace a file with a typo in
 *   it — recoverable in any editor — with a two-key file that has thrown the rest away.
 *
 * Returns `{ ok, config, changed, error }`. `changed` names the keys whose value actually
 * moved, which is what decides the restart notice: re-saving the same host is not a change
 * and must not tell somebody to restart for nothing.
 */
export function writeConfigFile(file, patch = {}) {
  const { config, notes, exists } = readConfigFile(file);
  if (exists && notes.length) {
    return {
      ok: false,
      status: 409,
      error:
        `${file} could not be read as JSON, so nothing was written — merging into it would ` +
        `discard whatever is in it. Fix or move the file and try again. (${notes[0]})`,
    };
  }

  const changed = [];
  for (const [key, value] of Object.entries(patch)) {
    const before = JSON.stringify(config[key] ?? null);
    if (before !== JSON.stringify(value ?? null)) changed.push(key);
  }

  const next = { ...config, ...patch };
  const tmp = `${file}.tmp-${process.pid}-${(tmpCounter += 1)}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may never have been created; a leftover is noise, not a failure */
    }
    return { ok: false, status: 500, error: `Could not write ${file}: ${err.message}` };
  }
  return { ok: true, config: next, changed };
}
