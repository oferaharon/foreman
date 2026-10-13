/*
 * bots.js — the panel's own copy of each headless deployment's transcripts, and the index
 * over it.
 *
 * A **bot** is a deployment that runs Claude Code headless (`claude -p`, the Agent SDK) and
 * has no terminal for the panel to read. A helper beside it (`helper/foreman-helper.mjs`)
 * ships its transcript files here over the bots wire, protocol v1 (`test/fake-bot-panel.js`
 * is its reference implementation); this module is the store under that wire and nothing
 * else. It knows no HTTP, mounts no route, touches no pane
 * and never enters the session roster — bots ride beside the roster, never in it.
 *
 * Everything lives under the resolved `STATE_DIR` (passed in, so a bench or a test never
 * reaches the real one — ESM hoists, so setting `FOREMAN_STATE_DIR` above an import is not
 * enough):
 *
 *   - `bots.json` — the registry `{id, name, tokenHash, createdAt}`, mode 600. Written only
 *     by `register` / `unregister` (the CLI), each a fresh read-modify-write so two processes
 *     cannot erase each other's registration, and with unknown keys carried through on the
 *     file and on every entry — a store that drops what it does not know deletes it on the
 *     next rewrite (`TaskStore`, `GroupStore`), and phase 2 will add fields.
 *   - `bots/<bot>/<root>/<project>/<session>.jsonl` and
 *     `bots/<bot>/<root>/<project>/<session>/subagents/<agent>.jsonl` — the copies.
 *     Byte-identical to the source and append-only: a chunk lands only at an offset equal to
 *     the copy's size. A reset renames the old copy to `<file>.g<n>` (never matched by a
 *     `*.jsonl` scan) and starts again from 0; nothing here ever truncates a copy.
 *   - `bots/<bot>/index.json` — a cache of the per-conversation index, rebuilt from the
 *     copies whenever it is missing, unreadable, or disagrees with a copy's size. Never an
 *     error: the copies are the record, the index is only a way not to re-read them.
 *
 * Every path is built here from four validated components — root label, project folder,
 * session id, agent id — and never from a path a caller sent. The regexes are the helper's,
 * spelled twice because the helper ships alone and cannot import `server/`;
 * `test/bot-components.test.js` holds the two spellings equal on a shared table of inputs.
 *
 * Three refusals beyond the regexes, each because the disk is the index's source of truth:
 *
 *   - a conversation id already held under another root or project is refused, without a
 *     numeric `size` (so the helper can never read it as "resume from here") — two roots can
 *     share a project-dir name, and a `cid` is the conversation's identity in every route;
 *   - a root, project or agent spelling that differs from one already held only in case is
 *     refused the same way, because the default macOS disk cannot tell them apart and would
 *     append two sources into one copy;
 *   - the root label `index.json` is refused, because that is this store's own file name at
 *     that level.
 *
 * Two clocks, never mixed. **Record time** — a transcript's own `timestamp`, ISO strings,
 * Claude Code's clock — is what "last active" and retention mean; records without one
 * (`cost-state`, `last-prompt`, `ai-title`, …) are skipped for it, and neither the last line
 * nor a file's mtime ever stands in. **Panel time** — `lastAppendAt`, the helper's last
 * hello, numbers in ms — is when bytes arrived, and is used only where record time cannot
 * be: a file with no timestamped record at all, and "active" (an append in the last 60 s).
 *
 * The wire methods (`hello`, `manifest`, `append`) answer `{status, body}`, the exact answer
 * the route sends, so the routes are a thin wrapper and the contract is pinned here.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { BOT_RETENTION_DAYS, STATE_DIR } from './config.js';
import { contextOf, modelName as nameOfModel } from './context-window.js';
import { normalizeRecord } from './normalize.js';
import { unwrapPasted } from './pasted-content.js';

export const PROTOCOL_VERSION = 1;
export const SUPPORTED_PROTOCOLS = Object.freeze([PROTOCOL_VERSION]);

/**
 * A bot id: what `foreman-panel bots add <id>` takes, what `:bot` in every route is, and
 * the folder name under `bots/`. Lowercase only, so no two ids collide on a case-insensitive
 * disk; no dot, so it can never be `.`/`..`.
 */
export const BOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

// The four components — the helper's own spellings, held equal by test/bot-components.test.js.
/** A root label: what the panel files a conversation under. `.`/`..` can't match the first char. */
export const ROOT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** Claude Code's project folder: the launch cwd with every other character turned into `-`. */
export const PROJECT_RE = /^[A-Za-z0-9-]{1,255}$/;
/** A conversation's session id: a lowercase UUID. */
export const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A subagent transcript's file stem, `agent-` included. Absent for the conversation itself. */
export const AGENT_RE = /^agent-[A-Za-z0-9]{1,64}$/;

export const COMPONENT_RES = Object.freeze({
  root: ROOT_RE,
  project: PROJECT_RE,
  session: SESSION_RE,
  agent: AGENT_RE,
});

/** The largest append body. A chunk ends on a newline unless it is a full piece of a longer line. */
export const CHUNK_MAX = 4 * 1024 * 1024;
/** The head the manifest carries: sha256 hex of a copy's first `min(size, HEAD_MAX)` bytes. */
export const HEAD_MAX = 4096;

/** A helper is offline this long after its last hello, and a different instance is refused within it. */
export const HELLO_WINDOW_MS = 90_000;
/** Nothing arrives when a helper dies, so liveness is a timer of its own (unref'd). */
export const LIVENESS_TICK_MS = 15_000;
/** A conversation is active while its last append is this recent and it has not finished. */
export const ACTIVE_MS = 60_000;
/** `change` is emitted at most this often per bot. */
export const CHANGE_MIN_MS = 1_000;
/** How often a dirty index is written. */
export const FLUSH_MS = 2_000;
/** How often retention runs, beside the run at construction. */
export const PRUNE_EVERY_MS = 6 * 3600_000;

const DAY_MS = 86_400_000;
const UNAUTHORIZED = 'unknown bot or wrong token';
const RESERVED_ROOTS = new Set(['index.json']);
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const GEN_RE = /^(.+)\.jsonl\.g([1-9][0-9]{0,8})$/;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const APPEND_FLAGS = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NO_FOLLOW;
/** Compared against when the bot is unknown, so an unknown bot costs what a wrong token does. */
const DUMMY_DIGEST = Buffer.alloc(32);

export function isRoot(s) {
  return typeof s === 'string' && s !== '.' && s !== '..' && ROOT_RE.test(s);
}

/** True when all four components pass. `agent` may be absent, `null` or `""` for a main file. */
export function validComponents({ root, project, session, agent } = {}) {
  return isRoot(root)
    && typeof project === 'string' && PROJECT_RE.test(project)
    && typeof session === 'string' && SESSION_RE.test(session)
    && (agent == null || agent === '' || (typeof agent === 'string' && AGENT_RE.test(agent)));
}

export function isBotId(s) {
  return typeof s === 'string' && BOT_ID_RE.test(s);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const clip = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** `"<ms>:<cid>"` — the cursor `conversations` hands back as `next`. */
function cursorOf(c) {
  return `${activeAt(c)}:${c.cid}`;
}

function parseCursor(before) {
  if (before == null || before === '') return null;
  if (typeof before === 'number' && Number.isFinite(before)) return { at: before, cid: null };
  if (typeof before !== 'string') return null;
  const m = /^(-?\d+)(?::([0-9a-f-]{36}))?$/.exec(before);
  if (m) return { at: Number(m[1]), cid: m[2] ?? null };
  const at = Date.parse(before);
  return Number.isFinite(at) ? { at, cid: null } : null;
}

/** The record time a conversation was last active, else when its bytes last arrived. */
function activeAt(c) {
  if (c.lastTs) return Date.parse(c.lastTs);
  let at = c.lastAppendAt ?? 0;
  for (const a of Object.values(c.agents)) at = Math.max(at, a.lastAppendAt ?? 0);
  return at;
}

function isActive(c, now) {
  return c.size > 0 && !c.finished && c.lastAppendAt != null && now - c.lastAppendAt < ACTIVE_MS;
}

function freshParse() {
  return { parsedTo: 0, customTitle: null, aiTitle: null, promptTitle: null, ctxAt: null, requestedModel: null, lastType: null };
}

const NO_CTX = Object.freeze({ tokens: null, window: null, pct: null });

function freshConv(cid, root, project) {
  return {
    cid, root, project,
    title: `conversation ${cid.slice(0, 8)}`,
    firstTs: null, lastTs: null, lastAppendAt: null, size: 0, prompts: 0,
    model: null, modelName: null, effort: null, ctx: { ...NO_CTX },
    finished: false, entrypoint: null, version: null,
    head: null, headLen: 0,
    parse: freshParse(),
    /** agent id → {size, headLen, head, lastAppendAt} */
    agents: {},
    /** [{agent: null|id, n, size}] — copies a reset set aside */
    generations: [],
    /** keys a later version wrote into index.json, carried through */
    extra: {},
  };
}

/** Clear what a main file's bytes decided, keeping what is the conversation's, not the file's. */
function resetMain(c) {
  const kept = { cid: c.cid, root: c.root, project: c.project, lastAppendAt: c.lastAppendAt, agents: c.agents, generations: c.generations, extra: c.extra };
  Object.assign(c, freshConv(c.cid, c.root, c.project), kept);
}

/** custom-title → ai-title → the first prompt (the `probe` rule) → `conversation <8 hex>`. */
function titleOf(c) {
  const p = c.parse;
  return p.customTitle || p.aiTitle || p.promptTitle || `conversation ${c.cid.slice(0, 8)}`;
}

/** The fields a reader sees for one conversation, minus the two that move on every append. */
function convSig(c) {
  return JSON.stringify([c.root, c.project, c.title, c.firstTs, c.lastTs, c.prompts, c.model, c.modelName,
    c.effort, c.ctx.tokens, c.ctx.window, c.ctx.pct, c.finished, c.entrypoint, c.version, c.size > 0]);
}

function readBytes(file, start, end) {
  const len = Math.max(0, end - start);
  const buf = Buffer.alloc(len);
  if (!len) return buf;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NO_FOLLOW);
  try {
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, start + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

function headOf(file, size) {
  const headLen = Math.min(size, HEAD_MAX);
  return { headLen, head: sha256(readBytes(file, 0, headLen)) };
}

/** A regular file's `{size, mtimeMs}`, or null — `lstat`, so a planted symlink is not a copy. */
function plainFile(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

function plainDir(p) {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readdir(p) {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return [];
  }
}

/** Write via a temp file in the same directory, so the rename is atomic; mode 600 either way. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // the mode above applies only when the file is created
  fs.renameSync(tmp, file);
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function refuse(status, error, extra) {
  return { status, body: { error, ...extra } };
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Emits:
 *   'change' {bot}           — at most once a second per bot, and only when something a
 *                              reader sees moved (row or conversation list); never on bytes
 *                              alone
 *   'reset'  {bot, cid, agent} — a copy was set aside as a generation and a new file started
 *                              at the same path; a `Tailer` on it would append the new file
 *                              to what it already showed, so a viewer must be re-sent whole
 */
export class BotStore extends EventEmitter {
  #reg = new Map(); // id → {id, name, createdAt, digest: Buffer|null}
  #regEntries = []; // the file's entries as found, unknown ones included
  #regExtra = {};
  #regCorrupt = false;
  #regStamp = null;
  #books = new Map(); // id → {conversations: Map, dirty, extra, rev, sentSig, sentAt, timer}
  #helpers = new Map(); // id → helper state, memory only
  #refusals = new Map(); // id → {at, status, reason}
  #timers = [];

  /**
   * @param {object} [opts]
   * @param {string}   [opts.dir]           the state dir (default: the resolved `STATE_DIR`)
   * @param {number}   [opts.retentionDays] default `BOT_RETENTION_DAYS`
   * @param {boolean}  [opts.copies]        false: the registry only — no index load, no
   *                                        timers (the CLI's `bots add|remove|list`)
   * @param {boolean}  [opts.timers]        false: no liveness tick, flush or prune timers,
   *                                        and no prune at construction (tests)
   * @param {function} [opts.now]           the panel clock, ms
   * @param {function} [opts.log]           one stderr line
   */
  constructor({ dir = STATE_DIR, retentionDays = BOT_RETENTION_DAYS, copies = true, timers = true, now, log } = {}) {
    super();
    this.dir = dir;
    this.copies = false;
    this.registryFile = path.join(dir, 'bots.json');
    this.botsDir = path.join(dir, 'bots');
    this.retentionDays = retentionDays;
    this.now = now ?? (() => Date.now());
    this.log = log ?? ((line) => console.error(line));
    this.#loadRegistry();
    if (!copies) return;
    this.copies = true;
    for (const id of readdir(this.botsDir)) {
      if (isBotId(id) && plainDir(path.join(this.botsDir, id))) this.#loadBook(id);
    }
    this.#ensureBooks();
    if (!timers) return;
    this.prune();
    const every = (ms, fn) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.#timers.push(t);
    };
    every(LIVENESS_TICK_MS, () => this.tick());
    every(FLUSH_MS, () => this.flush());
    every(PRUNE_EVERY_MS, () => this.prune());
  }

  stop() {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const b of this.#books.values()) {
      clearTimeout(b.timer);
      b.timer = null;
    }
    this.flush();
  }

  /* ------------------------------------------------------------- the registry --- */

  #readRegistryFile() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
    } catch (err) {
      return { entries: [], extra: {}, corrupt: err?.code !== 'ENOENT' };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { entries: [], extra: {}, corrupt: true };
    const { bots, ...extra } = raw;
    return { entries: Array.isArray(bots) ? bots : [], extra, corrupt: false };
  }

  #loadRegistry() {
    const { entries, extra, corrupt } = this.#readRegistryFile();
    this.#regEntries = entries;
    this.#regExtra = extra;
    if (corrupt && !this.#regCorrupt) this.log(`[bots] ${this.registryFile} could not be parsed; no bot is registered until it is fixed`);
    this.#regCorrupt = corrupt;
    this.#reg = new Map();
    for (const e of entries) {
      if (!e || typeof e !== 'object' || !isBotId(e.id) || this.#reg.has(e.id)) continue;
      this.#reg.set(e.id, {
        id: e.id,
        name: typeof e.name === 'string' && e.name ? e.name : e.id,
        createdAt: Number(e.createdAt) || null,
        // A malformed hash is kept on disk as found and simply never verifies.
        digest: typeof e.tokenHash === 'string' && HEX64_RE.test(e.tokenHash) ? Buffer.from(e.tokenHash, 'hex') : null,
      });
    }
    this.#regStamp = this.#stamp();
  }

  #stamp() {
    try {
      const st = fs.statSync(this.registryFile);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return null;
    }
  }

  /** Re-read `bots.json` if it changed on disk (another process registered). True when it did. */
  reloadRegistry() {
    if (this.#stamp() === this.#regStamp) return false;
    const before = new Set(this.#reg.keys());
    this.#loadRegistry();
    const after = new Set(this.#reg.keys());
    for (const id of before) if (!after.has(id)) this.#helpers.delete(id);
    this.#ensureBooks();
    for (const id of new Set([...before, ...after])) {
      if (before.has(id) !== after.has(id)) this.emit('change', { bot: id });
    }
    return true;
  }

  /** A fresh read-modify-write of the registry; refuses to write over a file it cannot parse. */
  #editRegistry(edit) {
    const file = this.#readRegistryFile();
    if (file.corrupt) throw fail('ECORRUPT', `${this.registryFile} could not be parsed; fix or move it first`);
    const entries = edit(file.entries);
    writeAtomic(this.registryFile, `${JSON.stringify({ ...file.extra, bots: entries }, null, 2)}\n`);
    this.#loadRegistry();
  }

  /**
   * Register a bot and mint its token. The token is returned once and stored only as its
   * sha256 hex digest. Throws `EINVAL` (bad id or name), `EEXIST`, `ECORRUPT`.
   *
   * @returns {{id: string, name: string, token: string, createdAt: number}}
   */
  register(id, { name } = {}) {
    if (!isBotId(id)) throw fail('EINVAL', `a bot id must match ${BOT_ID_RE}`);
    const label = name == null ? id : String(name).trim();
    if (!label || label.length > 64 || CONTROL_RE.test(label)) throw fail('EINVAL', 'a bot name is 1-64 characters with no control characters');
    const token = randomBytes(32).toString('base64url');
    const createdAt = this.now();
    this.#editRegistry((entries) => {
      if (entries.some((e) => e?.id === id)) throw fail('EEXIST', `bot ${id} is already registered`);
      return [...entries, { id, name: label, tokenHash: sha256(token), createdAt }];
    });
    this.#ensureBooks();
    this.emit('change', { bot: id });
    return { id, name: label, token, createdAt };
  }

  /** Revoke a bot's token. Its copies stay until they age out. True when it was registered. */
  unregister(id) {
    if (!isBotId(id)) return false;
    let found = false;
    this.#editRegistry((entries) => entries.filter((e) => {
      const hit = e?.id === id;
      found ||= hit;
      return !hit;
    }));
    this.#helpers.delete(id);
    if (found) this.emit('change', { bot: id });
    return found;
  }

  /** The registry, no tokens and no hashes. */
  registered() {
    return [...this.#reg.values()].map(({ id, name, createdAt }) => ({ id, name, createdAt }));
  }

  has(id) {
    return this.#reg.has(id);
  }

  /**
   * Whether `token` is `bot`'s. `timingSafeEqual` over two sha256 digests — equal length
   * always, so nothing leaks a length — and an unknown bot is compared against a dummy, so
   * it costs what a wrong token costs and answers the same.
   */
  verify(bot, token) {
    const want = this.#reg.get(bot)?.digest ?? null;
    const given = createHash('sha256').update(typeof token === 'string' ? token : '', 'utf8').digest();
    const same = timingSafeEqual(given, want ?? DUMMY_DIGEST);
    return same && want !== null && typeof token === 'string' && token.length > 0;
  }

  /** Record a refusal the route made (a wrong token on a known bot), for the settings list. */
  noteRefusal(bot, status, reason) {
    if (!this.#reg.has(bot)) return;
    this.#refusals.set(bot, { at: this.now(), status, reason: clip(String(reason ?? ''), 200) });
  }

  /* ----------------------------------------------------------------- liveness --- */

  #helper(id) {
    let h = this.#helpers.get(id);
    if (!h) {
      h = { online: false, lastSeen: null, since: null, instance: null, helperVersion: null, host: null, roots: [], files: null, claudeVersions: [] };
      this.#helpers.set(id, h);
    }
    return h;
  }

  /**
   * `POST /api/bots/:bot/hello`. `200 {ok}` · `401` unknown bot · `400` a body that is not a
   * hello · `426 {supported}` another protocol · `409 {since}` a different `instance` said
   * hello within the last 90 s (`since`, ISO, is when the current instance first did).
   */
  hello(bot, body, now = this.now()) {
    if (!this.#reg.has(bot)) return refuse(401, UNAUTHORIZED);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return this.#refused(bot, 400, 'a hello is a JSON object', now);
    if (body.v !== PROTOCOL_VERSION) {
      this.#note(bot, 426, `protocol ${JSON.stringify(body.v ?? null)}`, now);
      return { status: 426, body: { supported: [...SUPPORTED_PROTOCOLS] } };
    }
    const instance = clip(body.instance, 128);
    if (!instance) return this.#refused(bot, 400, 'a hello names its instance', now);
    const h = this.#helper(bot);
    if (h.instance && h.instance !== instance && h.lastSeen != null && now - h.lastSeen < HELLO_WINDOW_MS) {
      this.#note(bot, 409, 'another helper instance is reporting for this bot', now);
      return { status: 409, body: { since: new Date(h.since).toISOString() } };
    }
    if (h.instance !== instance) {
      h.instance = instance;
      h.since = now;
    }
    h.lastSeen = now;
    h.online = true;
    h.helperVersion = clip(body.helperVersion, 64);
    h.host = clip(body.host, 255);
    h.roots = (Array.isArray(body.roots) ? body.roots : []).slice(0, 64)
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({ label: clip(r.label, 64), path: clip(r.path, 1024) }));
    h.files = Number.isSafeInteger(body.files) && body.files >= 0 ? body.files : null;
    h.claudeVersions = (Array.isArray(body.claudeVersions) ? body.claudeVersions : []).slice(0, 16).map((v) => clip(v, 32)).filter(Boolean);
    this.#touch(bot);
    return { status: 200, body: { ok: true } };
  }

  /** Flip helpers silent for 90 s offline, and let `active` age out; emits `change` for what moved. */
  tick(now = this.now()) {
    for (const h of this.#helpers.values()) {
      if (h.online && (h.lastSeen == null || now - h.lastSeen >= HELLO_WINDOW_MS)) h.online = false;
    }
    for (const id of this.#reg.keys()) this.#touch(id, now);
  }

  #note(bot, status, reason, now) {
    this.#refusals.set(bot, { at: now, status, reason });
  }

  #refused(bot, status, reason, now = this.now(), extra) {
    this.#note(bot, status, reason, now);
    return refuse(status, reason, extra);
  }

  /* -------------------------------------------------------------- the copies --- */

  #book(id) {
    let b = this.#books.get(id);
    if (!b) {
      b = { conversations: new Map(), dirty: false, extra: {}, rev: 0, sentSig: null, sentAt: -Infinity, timer: null };
      this.#books.set(id, b);
      b.sentSig = this.#sig(id);
    }
    return b;
  }

  /**
   * A book for every registered bot, so that the first thing that happens to one is measured
   * against how it looked before — not against a signature taken after it moved.
   */
  #ensureBooks() {
    if (!this.copies) return;
    for (const id of this.#reg.keys()) this.#book(id);
  }

  #fileOf(bot, { root, project, session, agent }) {
    if (!isBotId(bot) || !validComponents({ root, project, session, agent })) throw fail('EINVAL', 'bad component');
    const file = agent
      ? path.join(this.botsDir, bot, root, project, session, 'subagents', `${agent}.jsonl`)
      : path.join(this.botsDir, bot, root, project, `${session}.jsonl`);
    // Belt and braces: the regexes already make this impossible.
    if (!file.startsWith(path.join(this.botsDir, bot) + path.sep)) throw fail('EINVAL', 'bad component');
    return file;
  }

  /**
   * `GET /api/bots/:bot/manifest`: every file the panel holds for the bot, main files and
   * subagent files, with `head` = sha256 hex of the copy's first `headLen = min(size, 4096)`
   * bytes. `agent` is `null` for a main file.
   */
  manifest(bot) {
    if (!this.#reg.has(bot)) return refuse(401, UNAUTHORIZED);
    const files = [];
    const book = this.#books.get(bot);
    for (const c of book ? [...book.conversations.values()].sort(byKey) : []) {
      const at = { root: c.root, project: c.project, session: c.cid };
      if (c.size > 0) files.push({ ...at, agent: null, size: c.size, headLen: c.headLen, head: c.head });
      for (const agent of Object.keys(c.agents).sort()) {
        const a = c.agents[agent];
        if (a.size > 0) files.push({ ...at, agent, size: a.size, headLen: a.headLen, head: a.head });
      }
    }
    return { status: 200, body: { v: PROTOCOL_VERSION, files } };
  }

  /**
   * `POST /api/bots/:bot/append`: `bytes` land only at `offset` === the copy's size.
   *
   *   200 {size}   appended; `size === offset + bytes.length`
   *   409 {size}   the copy is `size` bytes, not `offset` — resume from there
   *   409 {error}  this conversation is held under another root/project, or a spelling
   *                clashes in case — no `size`, so it cannot be read as "resume here"
   *   400 {error}  a bad component, offset or body, or `reset` at an offset other than 0
   *   413 {error}  more than `CHUNK_MAX`
   *   401 {error}  not a registered bot
   *   500 {error}  the write failed; the copy is whatever reached the disk
   *
   * `components` is `{root, project, session, agent}` (agent absent / null / "" for a main
   * file); `offset` a non-negative integer or its decimal string; `reset` true / 1 / "1".
   * A body ends on a newline unless it is exactly `CHUNK_MAX` bytes of one longer line.
   */
  append(bot, components, offset, bytes, { reset } = {}) {
    if (!this.#reg.has(bot)) return refuse(401, UNAUTHORIZED);
    const now = this.now();
    const { root, project, session } = components ?? {};
    const agent = components?.agent == null || components.agent === '' ? null : components.agent;
    if (!validComponents({ root, project, session, agent })) return this.#refused(bot, 400, 'bad component', now);
    if (RESERVED_ROOTS.has(root.toLowerCase())) return this.#refused(bot, 400, `the root label "${root}" is reserved`, now);
    const at = typeof offset === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(offset) ? Number(offset) : offset;
    if (!Number.isSafeInteger(at) || at < 0) return this.#refused(bot, 400, 'bad offset', now);
    const isReset = reset === true || reset === 1 || reset === '1';
    if (isReset && at !== 0) return this.#refused(bot, 400, 'reset needs offset 0', now);
    if (!(bytes instanceof Uint8Array)) return this.#refused(bot, 400, 'the body is bytes', now);
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buf.length > CHUNK_MAX) return this.#refused(bot, 413, `a chunk is at most ${CHUNK_MAX} bytes`, now);
    if (!buf.length || (buf[buf.length - 1] !== 10 && buf.length !== CHUNK_MAX)) {
      return this.#refused(bot, 400, 'a chunk must end on a newline', now);
    }

    const book = this.#book(bot);
    let c = book.conversations.get(session);
    if (c && (c.root !== root || c.project !== project)) {
      return this.#refused(bot, 409, 'this conversation is already held under another root', now);
    }
    const isNewFile = !c || (agent ? !c.agents[agent] : c.size === 0);
    if (isNewFile) {
      const clash = this.#caseClash(book, { root, project, agent }, c);
      if (clash) return this.#refused(bot, 409, clash, now);
    }

    const file = this.#fileOf(bot, { root, project, session, agent });
    const before = c ? convSig(c) : null;
    const created = !c;
    if (created) {
      c = freshConv(session, root, project);
      book.conversations.set(session, c);
    }
    // The disk is the truth; a copy changed behind the store's back is re-read first.
    if (this.#resync(c, file, agent)) book.dirty = true;
    let rotated = false;
    const held = agent ? c.agents[agent]?.size ?? 0 : c.size;
    if (isReset && held > 0) {
      this.#rotate(c, file, agent);
      rotated = true;
    }
    const size = agent ? c.agents[agent]?.size ?? 0 : c.size;
    if (at !== size) {
      if (created && !c.size && !Object.keys(c.agents).length) book.conversations.delete(session);
      else if (before !== convSig(c)) {
        book.rev++;
        this.#touch(bot);
      }
      return { status: 409, body: { size } };
    }

    let written = 0;
    let error = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, APPEND_FLAGS, 0o600);
      try {
        while (written < buf.length) written += fs.writeSync(fd, buf, written, buf.length - written);
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      error = err;
    }

    const end = error ? plainFile(file)?.size ?? size : size + buf.length;
    if (agent) {
      const prev = c.agents[agent];
      const keep = prev && prev.headLen === HEAD_MAX && end >= HEAD_MAX;
      c.agents[agent] = { size: end, ...(keep ? { headLen: prev.headLen, head: prev.head } : headOf(file, end)), lastAppendAt: now };
    } else {
      if (!(c.headLen === HEAD_MAX && end >= HEAD_MAX)) Object.assign(c, headOf(file, end));
      c.size = end;
      c.lastAppendAt = now;
      // A failed write may have left any prefix of the chunk; the next append re-reads it.
      if (!error) this.#advance(c, file, at, buf);
    }
    book.dirty = true;
    if (before !== convSig(c)) book.rev++;
    if (rotated) this.emit('reset', { bot, cid: session, agent });
    this.#touch(bot);
    if (error) {
      this.log(`[bots] ${bot}: writing ${session}${agent ? `/${agent}` : ''} failed (${error.code || error.message})`);
      return this.#refused(bot, 500, 'the write failed', now);
    }
    return { status: 200, body: { size: end } };
  }

  /** Only one spelling per level, since the default macOS disk folds case. */
  #caseClash(book, { root, project, agent }, conv) {
    const lower = (s) => s.toLowerCase();
    for (const other of book.conversations.values()) {
      if (other.root !== root && lower(other.root) === lower(root)) {
        return `the root label "${root}" differs only in case from "${other.root}", which this disk cannot tell apart`;
      }
      if (other.root === root && other.project !== project && lower(other.project) === lower(project)) {
        return `the project "${project}" differs only in case from "${other.project}", which this disk cannot tell apart`;
      }
    }
    if (agent && conv) {
      for (const a of Object.keys(conv.agents)) {
        if (a !== agent && lower(a) === lower(agent)) return `the agent "${agent}" differs only in case from "${a}", which this disk cannot tell apart`;
      }
    }
    return null;
  }

  /** Set the copy aside as `<file>.g<n>`, never truncating it, and start the file again at 0. */
  #rotate(c, file, agent) {
    let n = 1 + Math.max(0, ...c.generations.filter((g) => g.agent === agent).map((g) => g.n));
    while (fs.existsSync(`${file}.g${n}`)) n++;
    const size = plainFile(file)?.size ?? 0;
    fs.renameSync(file, `${file}.g${n}`);
    c.generations.push({ agent, n, size });
    if (agent) c.agents[agent] = { size: 0, headLen: 0, head: null, lastAppendAt: c.agents[agent]?.lastAppendAt ?? null };
    else resetMain(c);
  }

  /** When the copy on disk is not the size the index says, re-read it rather than trust either. */
  #resync(c, file, agent) {
    const disk = plainFile(file)?.size ?? 0;
    if (agent) {
      const a = c.agents[agent];
      if ((a?.size ?? 0) === disk) return false;
      if (!disk) delete c.agents[agent];
      else c.agents[agent] = { size: disk, ...headOf(file, disk), lastAppendAt: a?.lastAppendAt ?? null };
      return true;
    }
    if (c.size === disk) return false;
    this.#reparse(c, file, disk);
    return true;
  }

  /** Read a main copy from 0, in the pieces an append would have brought it in. */
  #reparse(c, file, size) {
    resetMain(c);
    if (!size) return;
    for (let off = 0; off < size; off += CHUNK_MAX) {
      this.#advance(c, file, off, readBytes(file, off, Math.min(size, off + CHUNK_MAX)));
    }
    c.size = size;
    Object.assign(c, headOf(file, size));
  }

  /**
   * Fold the complete lines that `bytes` (landing at `offset`) finishes into the index. A
   * partial last line is held: `parsedTo` stays where it began, and the line is read back
   * from the copy when the chunk carrying its newline arrives — so a 20 MB line costs one
   * read at the end, not one per 4 MiB piece.
   */
  #advance(c, file, offset, bytes) {
    const nl = bytes.lastIndexOf(10);
    if (nl < 0) return;
    const p = c.parse;
    let region = bytes.subarray(0, nl + 1);
    if (p.parsedTo < offset) region = Buffer.concat([readBytes(file, p.parsedTo, offset), region]);
    for (const line of region.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // a torn line; the copy keeps it, the index cannot use it
      }
      try {
        this.#record(c, r);
      } catch {
        // A record no reader here understands is skipped like a torn one; it is still in the copy.
      }
    }
    p.parsedTo = offset + nl + 1;
    c.finished = p.lastType === 'cost-state';
    c.title = titleOf(c);
  }

  #record(c, r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return;
    const p = c.parse;
    p.lastType = typeof r.type === 'string' ? r.type : null;

    const ms = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    const iso = Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    if (iso) {
      if (!c.firstTs || ms < Date.parse(c.firstTs)) c.firstTs = iso;
      if (!c.lastTs || ms > Date.parse(c.lastTs)) c.lastTs = iso;
    }

    if (r.type === 'custom-title' && typeof r.customTitle === 'string' && r.customTitle) p.customTitle = r.customTitle;
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string' && r.aiTitle) p.aiTitle = r.aiTitle;
    // The `probe` rule (transcript.js), so a conversation is titled the way a session is.
    if (!p.promptTitle && r.type === 'user' && !r.isMeta && typeof r.message?.content === 'string') {
      const said = unwrapPasted(r.message.content) ?? r.message.content;
      const line = said.trim().split('\n')[0];
      if (line && !line.startsWith('<')) p.promptTitle = line.length > 60 ? `${line.slice(0, 57)}…` : line;
    }

    // A prompt is what the pane will draw as one: the renderer decides, not a second rule.
    if (r.type === 'user' && !r.isSidechain && normalizeRecord(r).some((m) => m.kind === 'user')) c.prompts++;

    if (r.type === 'assistant') {
      // `contextOf` over one record is `contextOf` over the file, walked forward: the latest
      // qualifying record wins, and model, effort and context all come from it.
      const ctx = contextOf([r]);
      if (ctx.tokens !== null) {
        c.model = ctx.model;
        c.modelName = ctx.modelName;
        c.effort = ctx.effort;
        c.ctx = { tokens: ctx.tokens, window: ctx.window, pct: ctx.pct };
        p.requestedModel = ctx.requestedModel;
        p.ctxAt = iso;
      }
    }

    if (typeof r.entrypoint === 'string' && r.entrypoint) c.entrypoint = r.entrypoint;
    if (typeof r.version === 'string' && r.version) c.version = r.version;
  }

  /* --------------------------------------------------------------- the index --- */

  #indexFile(id) {
    return path.join(this.botsDir, id, 'index.json');
  }

  #readIndex(id) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.#indexFile(id), 'utf8'));
    } catch (err) {
      return { ok: false, missing: err?.code === 'ENOENT', extra: {}, entries: new Map() };
    }
    if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.conversations)) {
      return { ok: false, missing: false, extra: {}, entries: new Map() };
    }
    const { v, conversations, ...extra } = raw;
    const entries = new Map();
    for (const e of conversations) {
      if (e && typeof e === 'object' && typeof e.cid === 'string' && !entries.has(e.cid)) entries.set(e.cid, e);
    }
    return { ok: true, missing: false, extra, entries };
  }

  /** What is on disk for one bot: main copies, subagent copies, generations. Validated names only. */
  #scanDisk(id) {
    const found = { mains: [], agents: [], gens: [] };
    const base = path.join(this.botsDir, id);
    const isSession = (s) => SESSION_RE.test(s);
    const isAgent = (s) => AGENT_RE.test(s);
    for (const root of readdir(base)) {
      if (!isRoot(root) || RESERVED_ROOTS.has(root.toLowerCase())) continue;
      const rdir = path.join(base, root);
      if (!plainDir(rdir)) continue;
      for (const project of readdir(rdir)) {
        const pdir = path.join(rdir, project);
        if (!PROJECT_RE.test(project) || !plainDir(pdir)) continue;
        for (const name of readdir(pdir)) {
          const g = GEN_RE.exec(name);
          if (name.endsWith('.jsonl') && isSession(name.slice(0, -6))) {
            const st = plainFile(path.join(pdir, name));
            if (st) found.mains.push({ root, project, session: name.slice(0, -6), ...st });
          } else if (g && isSession(g[1])) {
            const st = plainFile(path.join(pdir, name));
            if (st) found.gens.push({ root, project, session: g[1], agent: null, n: Number(g[2]), size: st.size });
          } else if (isSession(name) && plainDir(path.join(pdir, name, 'subagents'))) {
            const adir = path.join(pdir, name, 'subagents');
            for (const an of readdir(adir)) {
              const ag = GEN_RE.exec(an);
              if (an.endsWith('.jsonl') && isAgent(an.slice(0, -6))) {
                const st = plainFile(path.join(adir, an));
                if (st) found.agents.push({ root, project, session: name, agent: an.slice(0, -6), ...st });
              } else if (ag && isAgent(ag[1])) {
                const st = plainFile(path.join(adir, an));
                if (st) found.gens.push({ root, project, session: name, agent: ag[1], n: Number(ag[2]), size: st.size });
              }
            }
          }
        }
      }
    }
    return found;
  }

  /**
   * Load one bot's index, reconciled against its copies: an entry whose copy has the size it
   * recorded is trusted; anything else — a missing or unreadable index, a size that moved
   * after the last flush, a copy the index never heard of — is re-read from the copy.
   */
  #loadBook(id) {
    const idx = this.#readIndex(id);
    const disk = this.#scanDisk(id);
    const book = { conversations: new Map(), dirty: false, extra: idx.extra, rev: 0, sentSig: null, sentAt: -Infinity, timer: null };
    this.#books.set(id, book);
    let reread = 0;
    const where = (c, f) => c.root === f.root && c.project === f.project;

    for (const f of disk.mains) {
      if (book.conversations.has(f.session)) {
        this.log(`[bots] ${id}: ${f.session} is on disk under two roots; keeping ${book.conversations.get(f.session).root}`);
        continue;
      }
      const e = idx.entries.get(f.session);
      const file = this.#fileOf(id, { ...f, agent: null });
      let c = e && where(e, f) && e.size === f.size ? restore(e) : null;
      if (!c) {
        c = freshConv(f.session, f.root, f.project);
        if (e && where(e, f)) c.extra = extraOf(e);
        c.lastAppendAt = Math.max(Number(e?.lastAppendAt) || 0, Math.round(f.mtimeMs));
        this.#reparse(c, file, f.size);
        reread++;
        book.dirty = true;
      }
      book.conversations.set(f.session, c);
    }

    for (const f of disk.agents) {
      let c = book.conversations.get(f.session);
      if (c && !where(c, f)) continue;
      if (!c) {
        const e = idx.entries.get(f.session);
        c = freshConv(f.session, f.root, f.project);
        if (e && where(e, f)) c.extra = extraOf(e);
        book.conversations.set(f.session, c);
      }
      const ea = idx.entries.get(f.session)?.agents?.[f.agent];
      if (ea && ea.size === f.size && typeof ea.head === 'string' && Number.isSafeInteger(ea.headLen)) {
        c.agents[f.agent] = { size: f.size, headLen: ea.headLen, head: ea.head, lastAppendAt: Number(ea.lastAppendAt) || Math.round(f.mtimeMs) };
      } else {
        c.agents[f.agent] = { size: f.size, ...headOf(this.#fileOf(id, f), f.size), lastAppendAt: Math.round(f.mtimeMs) };
        book.dirty = true;
      }
    }

    for (const g of disk.gens) {
      const c = book.conversations.get(g.session);
      if (c && where(c, g)) c.generations.push({ agent: g.agent, n: g.n, size: g.size });
    }
    for (const c of book.conversations.values()) c.generations.sort((a, b) => (a.agent ?? '').localeCompare(b.agent ?? '') || a.n - b.n);

    // An entry whose copies are all gone is gone: the copies are the record.
    if (idx.entries.size !== book.conversations.size) book.dirty = true;
    if (!idx.ok && disk.mains.length + disk.agents.length) {
      this.log(`[bots] ${id}: index ${idx.missing ? 'missing' : 'unreadable'}; rebuilt from ${disk.mains.length + disk.agents.length} copies`);
    } else if (reread) {
      this.log(`[bots] ${id}: re-read ${reread} cop${reread === 1 ? 'y' : 'ies'} the index was behind on`);
    }
    book.sentSig = this.#sig(id);
  }

  /** Write every dirty index now (also every 2 s, and on `stop`). */
  flush() {
    for (const [id, book] of this.#books) {
      if (!book.dirty) continue;
      book.dirty = false;
      const conversations = [...book.conversations.values()].sort(byKey).map(persisted);
      try {
        writeAtomic(this.#indexFile(id), JSON.stringify({ ...book.extra, v: 1, conversations }));
      } catch (err) {
        this.log(`[bots] ${id}: writing the index failed (${err.code || err.message}); it is rebuilt from the copies at the next boot`);
      }
    }
  }

  /* ------------------------------------------------------------------- reads --- */

  /**
   * One row per registered bot, from memory only — this feeds a roster frame every two
   * seconds. Record times are ISO strings; panel times (`lastSeen`, `lastAppendAt`) are ms.
   *
   *   {id, name, helper: {online, lastSeen}, conversations, active, lastTs, lastActiveAt,
   *    current: {cid, at, model, modelName, effort, ctx: {tokens, window, pct}} | null}
   *
   * `current` is the single latest qualifying assistant record across all the bot's
   * conversations, so model, effort and context always come from one record; `active`
   * counts conversations, it never sums their contexts.
   */
  list(now = this.now()) {
    return [...this.#reg.keys()].sort().map((id) => this.#summary(id, now).row);
  }

  /** `list()`'s row plus what the settings list shows: helper details, roots, disk use, last refusal. */
  describe(now = this.now()) {
    return [...this.#reg.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => {
      const { row } = this.#summary(r.id, now);
      const h = this.#helpers.get(r.id);
      let bytes = 0;
      let files = 0;
      for (const c of this.#books.get(r.id)?.conversations.values() ?? []) {
        bytes += c.size;
        files += c.size > 0 ? 1 : 0;
        for (const a of Object.values(c.agents)) { bytes += a.size; files++; }
        for (const g of c.generations) { bytes += g.size; files++; }
      }
      return {
        ...row,
        createdAt: r.createdAt,
        helper: {
          ...row.helper,
          since: h?.since ?? null,
          instance: h?.instance ?? null,
          helperVersion: h?.helperVersion ?? null,
          host: h?.host ?? null,
          roots: h?.roots ?? [],
          files: h?.files ?? null,
          claudeVersions: h?.claudeVersions ?? [],
        },
        disk: { bytes, files },
        lastRefusal: this.#refusals.get(r.id) ?? null,
      };
    });
  }

  #summary(id, now) {
    const reg = this.#reg.get(id);
    const h = this.#helpers.get(id);
    let conversations = 0;
    let lastTs = null;
    let lastActiveAt = null;
    let current = null;
    let currentAt = -Infinity;
    const active = [];
    for (const c of this.#books.get(id)?.conversations.values() ?? []) {
      if (!c.size) continue;
      conversations++;
      if (isActive(c, now)) active.push(c.cid);
      if (c.lastTs && (!lastTs || Date.parse(c.lastTs) > Date.parse(lastTs))) lastTs = c.lastTs;
      const at = activeAt(c);
      if (lastActiveAt == null || at > lastActiveAt) lastActiveAt = at;
      if (c.ctx.tokens !== null) {
        const t = c.parse.ctxAt ? Date.parse(c.parse.ctxAt) : -1;
        if (t > currentAt || (t === currentAt && current && c.cid > current.cid)) {
          currentAt = t;
          current = { cid: c.cid, at: c.parse.ctxAt, model: c.model, modelName: c.modelName, effort: c.effort, ctx: { ...c.ctx } };
        }
      }
    }
    active.sort();
    const row = {
      id,
      name: reg?.name ?? id,
      helper: { online: h?.online ?? false, lastSeen: h?.lastSeen ?? null },
      conversations,
      active: active.length,
      lastTs,
      lastActiveAt,
      current,
    };
    return { row, active };
  }

  /**
   * A bot's conversations, newest first by last activity (record time, else receipt time).
   * `before` is the `next` cursor of a previous page (`"<ms>:<cid>"`), or a time (ms or ISO)
   * to start strictly before. `null` for a bot that is not registered.
   *
   *   {conversations: [{cid, root, project, title, firstTs, lastTs, lastAppendAt, size,
   *     prompts, model, modelName, effort, ctx, finished, entrypoint, version, activeAt,
   *     active}], next: string|null}
   */
  conversations(bot, { before, limit = 200 } = {}) {
    if (!this.#reg.has(bot)) return null;
    const now = this.now();
    const n = Math.min(500, Math.max(1, Number.isSafeInteger(limit) ? limit : 200));
    const cur = parseCursor(before);
    const all = [...(this.#books.get(bot)?.conversations.values() ?? [])]
      .filter((c) => c.size > 0)
      .map((c) => ({ c, at: activeAt(c) }))
      .sort((a, b) => b.at - a.at || (a.c.cid < b.c.cid ? 1 : a.c.cid > b.c.cid ? -1 : 0));
    const rest = cur
      ? all.filter(({ c, at }) => at < cur.at || (cur.cid !== null && at === cur.at && c.cid < cur.cid))
      : all;
    const page = rest.slice(0, n);
    return {
      conversations: page.map(({ c }) => view(c, now)),
      next: rest.length > n ? cursorOf(page[page.length - 1].c) : null,
    };
  }

  /** One conversation's view, or null. */
  conversation(bot, cid) {
    if (!this.#reg.has(bot)) return null;
    const c = this.#books.get(bot)?.conversations.get(cid);
    return c && c.size > 0 ? view(c, this.now()) : null;
  }

  /**
   * The copy's path for a conversation (or one of its subagents), built from validated
   * components, or null when the bot is not registered or holds no such file.
   */
  pathOf(bot, cid, agent = null) {
    if (!this.#reg.has(bot) || typeof cid !== 'string' || !SESSION_RE.test(cid)) return null;
    if (agent != null && (typeof agent !== 'string' || !AGENT_RE.test(agent))) return null;
    const c = this.#books.get(bot)?.conversations.get(cid);
    if (!c || !c.size || (agent && !c.agents[agent]?.size)) return null;
    return this.#fileOf(bot, { root: c.root, project: c.project, session: cid, agent });
  }

  /* --------------------------------------------------------------- retention --- */

  /**
   * Remove every conversation last active more than `retentionDays` ago — by its newest
   * timestamped record, or by when its bytes last arrived if it has none. The main copy, its
   * `<session>/` directory (subagents and their generations) and its generations go
   * together. One stderr line with the counts. Copies of a bot that is no longer registered
   * age out the same way.
   */
  prune(now = this.now()) {
    const cutoff = now - this.retentionDays * DAY_MS;
    const removed = { conversations: 0, files: 0, bytes: 0 };
    for (const [id, book] of this.#books) {
      let changed = false;
      for (const [cid, c] of book.conversations) {
        if (activeAt(c) >= cutoff) continue;
        const pdir = path.join(this.botsDir, id, c.root, c.project);
        const victims = [path.join(pdir, `${cid}.jsonl`), ...c.generations.filter((g) => !g.agent).map((g) => path.join(pdir, `${cid}.jsonl.g${g.n}`))];
        for (const f of victims) {
          const st = plainFile(f);
          if (!st) continue;
          try {
            fs.unlinkSync(f);
            removed.files++;
            removed.bytes += st.size;
          } catch { /* already gone */ }
        }
        const sdir = path.join(pdir, cid);
        if (plainDir(sdir)) {
          for (const f of walkFiles(sdir)) { removed.files++; removed.bytes += f.size; }
          fs.rmSync(sdir, { recursive: true, force: true });
        }
        book.conversations.delete(cid);
        removed.conversations++;
        changed = true;
        for (const dir of [pdir, path.dirname(pdir)]) {
          try { fs.rmdirSync(dir); } catch { break; } // not empty: keep it and everything above
        }
      }
      if (changed) {
        book.dirty = true;
        book.rev++;
        this.#touch(id, now);
      }
    }
    this.log(`[bots] retention ${this.retentionDays} days: pruned ${removed.conversations} conversation${removed.conversations === 1 ? '' : 's'}, ${removed.files} file${removed.files === 1 ? '' : 's'}, ${humanBytes(removed.bytes)}`);
    return removed;
  }

  /* ----------------------------------------------------------------- change --- */

  #sig(id, now = this.now()) {
    const { row, active } = this.#summary(id, now);
    const { lastSeen, ...helper } = row.helper; // moves every 30 s with nothing on screen
    return JSON.stringify([row.name, helper, row.conversations, row.lastTs, row.lastActiveAt, row.current, active, this.#books.get(id)?.rev ?? 0]);
  }

  /** Emit `change` if something a reader sees moved — now, or once the 1 s floor allows. */
  #touch(id, now = this.now()) {
    const b = this.#books.get(id) ?? this.#book(id);
    const sig = this.#sig(id, now);
    if (sig === b.sentSig) return;
    const wait = b.sentAt + CHANGE_MIN_MS - now;
    if (wait <= 0) {
      clearTimeout(b.timer);
      b.timer = null;
      b.sentSig = sig;
      b.sentAt = now;
      this.emit('change', { bot: id });
      return;
    }
    if (b.timer) return;
    b.timer = setTimeout(() => {
      b.timer = null;
      this.#touch(id);
    }, wait);
    b.timer.unref?.();
  }
}

function byKey(a, b) {
  const ka = `${a.root}/${a.project}/${a.cid}`;
  const kb = `${b.root}/${b.project}/${b.cid}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

function view(c, now) {
  return {
    cid: c.cid,
    root: c.root,
    project: c.project,
    title: c.title,
    firstTs: c.firstTs,
    lastTs: c.lastTs,
    lastAppendAt: c.lastAppendAt,
    size: c.size,
    prompts: c.prompts,
    model: c.model,
    modelName: c.modelName,
    effort: c.effort,
    ctx: { ...c.ctx },
    finished: c.finished,
    entrypoint: c.entrypoint,
    version: c.version,
    activeAt: activeAt(c),
    active: isActive(c, now),
  };
}

const KNOWN = ['cid', 'root', 'project', 'title', 'firstTs', 'lastTs', 'lastAppendAt', 'size', 'prompts', 'model', 'modelName',
  'effort', 'ctx', 'finished', 'entrypoint', 'version', 'head', 'headLen', 'parse', 'agents', 'generations'];

function extraOf(e) {
  const extra = {};
  for (const [k, v] of Object.entries(e)) if (!KNOWN.includes(k)) extra[k] = v;
  return extra;
}

/** An index entry → a conversation, or null when it is not one this version can trust. */
function restore(e) {
  const p = e.parse;
  if (!SESSION_RE.test(e.cid) || !isRoot(e.root) || typeof e.project !== 'string' || !PROJECT_RE.test(e.project)) return null;
  if (!Number.isSafeInteger(e.size) || e.size < 0 || !p || typeof p !== 'object') return null;
  if (!Number.isSafeInteger(p.parsedTo) || p.parsedTo < 0 || p.parsedTo > e.size) return null;
  if (e.size > 0 && (typeof e.head !== 'string' || !Number.isSafeInteger(e.headLen) || e.headLen !== Math.min(e.size, HEAD_MAX))) return null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const ctx = e.ctx && typeof e.ctx === 'object' ? e.ctx : {};
  const num = (v) => (Number.isFinite(v) ? v : null);
  const c = freshConv(e.cid, e.root, e.project);
  Object.assign(c, {
    firstTs: str(e.firstTs),
    lastTs: str(e.lastTs),
    lastAppendAt: num(e.lastAppendAt),
    size: e.size,
    prompts: Number.isSafeInteger(e.prompts) && e.prompts >= 0 ? e.prompts : 0,
    model: str(e.model),
    effort: str(e.effort),
    ctx: { tokens: num(ctx.tokens), window: num(ctx.window), pct: num(ctx.pct) },
    finished: e.finished === true,
    entrypoint: str(e.entrypoint),
    version: str(e.version),
    head: e.size > 0 ? e.head : null,
    headLen: e.size > 0 ? e.headLen : 0,
    parse: {
      parsedTo: p.parsedTo,
      customTitle: str(p.customTitle),
      aiTitle: str(p.aiTitle),
      promptTitle: str(p.promptTitle),
      ctxAt: str(p.ctxAt),
      requestedModel: str(p.requestedModel),
      lastType: str(p.lastType),
    },
    // Agents and generations are re-read from the disk walk, never trusted from here.
    agents: {},
    generations: [],
    extra: extraOf(e),
  });
  // Derived, so recomputed: a name list that grew since the last flush shows up at once.
  c.modelName = nameOfModel(c.model, c.parse.requestedModel);
  c.title = titleOf(c);
  return c;
}

function persisted(c) {
  return {
    ...c.extra,
    cid: c.cid,
    root: c.root,
    project: c.project,
    title: c.title,
    firstTs: c.firstTs,
    lastTs: c.lastTs,
    lastAppendAt: c.lastAppendAt,
    size: c.size,
    prompts: c.prompts,
    model: c.model,
    modelName: c.modelName,
    effort: c.effort,
    ctx: c.ctx,
    finished: c.finished,
    entrypoint: c.entrypoint,
    version: c.version,
    head: c.head,
    headLen: c.headLen,
    parse: c.parse,
    agents: c.agents,
    generations: c.generations,
  };
}

function* walkFiles(dir) {
  for (const name of readdir(dir)) {
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isDirectory()) yield* walkFiles(p);
    else yield { path: p, size: st.size };
  }
}
