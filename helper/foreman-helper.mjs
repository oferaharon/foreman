#!/usr/bin/env node
/*
 * foreman-helper — ships a headless deployment's Claude Code transcripts to a Foreman panel.
 *
 * One file, no dependencies, Node >= 22 (global `fetch`). Copy it from the Foreman release
 * tag that matches the panel and run it beside the bot, as the user that owns the transcript
 * files (Claude Code writes them 0600, so any other user sees nothing).
 *
 *   FOREMAN_URL=http://<panel host>:<port>
 *   FOREMAN_BOT=<bot id>                 from `foreman-panel bots add <bot id>` on the panel
 *   FOREMAN_BOT_TOKEN=<token>            printed once by that same command; keep it secret
 *   FOREMAN_WATCH=<label>=<projects dir>[;<label>=<projects dir>...]
 *
 *   node foreman-helper.mjs              run until stopped
 *   node foreman-helper.mjs --check      say what is wrong, then exit
 *
 * A path in FOREMAN_WATCH may hold ONE `*`, inside one segment. Each directory it matches
 * is a root of its own, and the label must then hold a `*` too, which is replaced by what
 * the path's `*` matched — so with one config directory per agent group, a label of `*` names
 * every group's root after the group's own folder. Dot-folders are never matched.
 *
 * What it does, and what it deliberately does not:
 *
 * - It only ever dials OUT, to the panel, over plain HTTP with its own bearer token. It
 *   opens no port, and the panel never connects to it.
 * - It reads exactly two shapes under each root, both with `lstat`, and never follows a
 *   symlink: `<root>/<project>/<session>.jsonl` and
 *   `<root>/<project>/<session>/subagents/agent-*.jsonl`. It never writes into the tree.
 * - It keeps no state of its own. On start, and after any failure, it says `hello`, asks the
 *   panel what it already has (`manifest`), and sends only the rest — oldest file first, in
 *   whole lines, each chunk appended at the panel's own offset. Restarts and rebuilds need
 *   nothing migrated, and a retry can never duplicate a byte.
 * - Files modified in the last 24 hours are polled every 2 seconds; everything else is
 *   re-read on a full scan every 5 minutes.
 * - The panel's offset is the only offset. A `409 {size}` means the panel's copy is not
 *   where this process thought, so the manifest is fetched again and shipping resumes from
 *   there. A head mismatch, or a local file smaller than the panel's copy, means "this is
 *   not the file the panel has", and it is sent again from 0 with `reset=1`.
 * - It backs off 1 s → 30 s, jittered, forever, and writes one stderr line per change of
 *   state — never one per poll.
 *
 * The wire is protocol v1, and the panel's side of it is `/api/bots/:bot/{hello,manifest,append}`.
 * Its four path components are re-validated by the panel, which builds every path itself:
 * this file sends components and never a path. The regexes and limits below are exported so
 * a test can hold them equal to the panel's own (the helper ships alone and cannot import
 * them), and importing this file starts nothing.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOL_VERSION = 1;
/** The Foreman release this file shipped with; a test holds it equal to package.json. */
export const HELPER_VERSION = '0.6.0';

// ------------------------------------------------------------------- the four components ---

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

export function isRoot(s) {
  return typeof s === 'string' && s !== '.' && s !== '..' && ROOT_RE.test(s);
}

/** True when all four components would pass the panel's validation. `agent` may be absent. */
export function validComponents({ root, project, session, agent } = {}) {
  return isRoot(root)
    && typeof project === 'string' && PROJECT_RE.test(project)
    && typeof session === 'string' && SESSION_RE.test(session)
    && (agent == null || agent === '' || (typeof agent === 'string' && AGENT_RE.test(agent)));
}

// ------------------------------------------------------------------------------ limits ---

/** The largest append body. A chunk ends on a newline unless one line is longer than this. */
export const CHUNK_MAX = 4 * 1024 * 1024;
/** The head the panel hashes: sha256 of its copy's first `min(size, HEAD_MAX)` bytes. */
export const HEAD_MAX = 4096;

export const TIMING = Object.freeze({
  pollMs: 2_000,
  fullScanMs: 5 * 60_000,
  recentMs: 24 * 60 * 60_000,
  helloMs: 30_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  requestTimeoutMs: 60_000,
});

/**
 * How many bytes of a read may be shipped: up to and including the last newline, or the
 * whole buffer when it is a full `CHUNK_MAX` piece of one longer line, or 0 — a partial last
 * line is held back until its newline lands.
 */
export function shippableLength(buf, max = CHUNK_MAX) {
  const nl = buf.lastIndexOf(10);
  if (nl >= 0) return nl + 1;
  return buf.length >= max ? max : 0;
}

/** sha256 hex — the `head` the manifest carries. */
export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 1 s → 30 s, equal jitter: attempt 0 waits 1–2 s, and the cap waits 15–30 s. */
export function backoffDelay(attempt, min = TIMING.backoffMinMs, max = TIMING.backoffMaxMs, rand = Math.random) {
  const base = Math.min(max, min * 2 ** (Math.min(attempt, 30) + 1));
  return Math.round(base / 2 + rand() * (base / 2));
}

// ------------------------------------------------------------------------------ config ---

/**
 * `label=path;label=path` → `[{label, path, glob}]`. A path may hold one `*`, inside one
 * segment; its label must then hold one `*` as well, and a literal label must pass ROOT_RE.
 */
export function parseWatch(spec) {
  if (typeof spec !== 'string' || !spec.trim()) throw new Error('FOREMAN_WATCH is empty');
  const roots = [];
  for (const part of spec.split(';')) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`FOREMAN_WATCH entry "${item}" is not label=path`);
    const label = item.slice(0, eq).trim();
    const dir = item.slice(eq + 1).trim();
    if (!path.isAbsolute(dir)) throw new Error(`FOREMAN_WATCH path "${dir}" is not absolute`);
    const stars = (dir.match(/\*/g) || []).length;
    const labelStars = (label.match(/\*/g) || []).length;
    if (stars > 1) throw new Error(`FOREMAN_WATCH path "${dir}" holds more than one *`);
    if (stars !== labelStars) {
      throw new Error(stars
        ? `FOREMAN_WATCH label "${label}" must hold one * for the glob path "${dir}"`
        : `FOREMAN_WATCH label "${label}" holds a * but its path has none`);
    }
    let glob = null;
    if (stars) {
      const segments = path.normalize(dir).split(path.sep);
      const at = segments.findIndex(s => s.includes('*'));
      const [pre, post] = segments[at].split('*');
      glob = { parent: segments.slice(0, at).join(path.sep) || path.sep, pre, post, rest: segments.slice(at + 1).filter(Boolean) };
      if (!isRoot(label.replace('*', 'x'))) throw new Error(`FOREMAN_WATCH label "${label}" is not a valid label`);
    } else if (!isRoot(label)) {
      throw new Error(`FOREMAN_WATCH label "${label}" must match ${ROOT_RE}`);
    }
    roots.push({ label, path: path.normalize(dir), glob });
  }
  if (!roots.length) throw new Error('FOREMAN_WATCH names no root');
  const literal = roots.filter(r => !r.glob).map(r => r.label);
  const dup = literal.find((l, i) => literal.indexOf(l) !== i);
  if (dup) throw new Error(`FOREMAN_WATCH names the label "${dup}" twice`);
  return roots;
}

/** The four variables, checked. Throws an Error whose message is fit to print. */
export function readConfig(env = process.env) {
  const missing = ['FOREMAN_URL', 'FOREMAN_BOT', 'FOREMAN_BOT_TOKEN', 'FOREMAN_WATCH'].filter(k => !env[k]?.trim());
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  let url;
  try { url = new URL(env.FOREMAN_URL.trim()); } catch { throw new Error('FOREMAN_URL is not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('FOREMAN_URL must be http:// or https://');
  if (url.username || url.password) throw new Error('FOREMAN_URL must not carry credentials; the token goes in FOREMAN_BOT_TOKEN');
  return {
    url: url.href.replace(/\/+$/, ''),
    bot: env.FOREMAN_BOT.trim(),
    token: env.FOREMAN_BOT_TOKEN.trim(),
    watch: parseWatch(env.FOREMAN_WATCH),
  };
}

// ------------------------------------------------------------------------------ helper ---

const O_READ = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

function keyOf({ root, project, session, agent }) {
  return `${root}/${project}/${session}${agent ? `/${agent}` : ''}`;
}

function errCode(err) {
  return err?.code || err?.name || 'error';
}

/**
 * A failure that is the connection's, not one file's: the loop backs off and says hello
 * again. `kind` is what decides whether the next failure is a new state worth a log line —
 * a socket that closed and then a refused connect are one outage, not two.
 */
class PanelError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}
/** A `409 {size}` on append: refetch the manifest and resume from the panel's offset. */
class Resync extends Error {
  kind = 'resync';
}
class Stopped extends Error {}

function refusal(status, data) {
  const message = status === 401 ? 'token refused (401): check FOREMAN_BOT and FOREMAN_BOT_TOKEN'
    : status === 404 ? 'the panel has no bots routes (404): is it older than this helper?'
    : status === 409 ? `another helper instance is reporting for this bot (409${data?.since != null ? `, since ${data.since}` : ''})`
    : status === 426 ? `protocol v${PROTOCOL_VERSION} refused (426; the panel supports ${JSON.stringify(data?.supported ?? [])})`
    : `the panel answered HTTP ${status}`;
  return new PanelError(message, `http ${status}`);
}

export class Helper {
  #abort = new AbortController();
  #wake = null;
  #problems = new Map();
  #stateSig = null;
  #lastHello = 0;
  #lastFull = 0;
  #seenSessionDirs = new Set();

  constructor(config, { log, fetch, timing } = {}) {
    this.config = config;
    this.base = config.url.replace(/\/+$/, '');
    this.timing = { ...TIMING, ...timing };
    this.log = log ?? (line => process.stderr.write(`foreman-helper ${new Date().toISOString()} ${line}\n`));
    this.fetch = fetch ?? globalThis.fetch;
    this.instance = randomUUID();
    this.host = os.hostname();
    this.stopped = false;
    this.state = 'starting';
    /** key → {key, root, project, session, agent, path, size, mtimeMs, ino} */
    this.local = new Map();
    /** key → {size, headLen, head}, or null until a manifest has been read */
    this.panel = null;
    /** key → the inode whose head was checked against this manifest */
    this.verified = new Map();
    /** key → `${offset}:${size}` when a partial last line was held back at exactly that state */
    this.held = new Map();
    /** key → the panel's reason for refusing that file; not retried by this process */
    this.refused = new Map();
    /** [{label, dir}] — the roots the last scan found */
    this.roots = [];
    /** [{label, path, glob, matched, missing}] — one per FOREMAN_WATCH entry, for --check */
    this.specs = [];
  }

  stop() {
    this.stopped = true;
    this.#abort.abort();
    this.#wake?.();
  }

  // --------------------------------------------------------------------------- the loop ---

  async run() {
    const { watch, bot, url } = this.config;
    this.log(`starting: helper ${HELPER_VERSION}, bot ${bot}, panel ${url}, ${watch.length} root${watch.length === 1 ? '' : 's'} configured`);
    let attempt = 0;
    while (!this.stopped) {
      try {
        const now = Date.now();
        const full = now - this.#lastFull >= this.timing.fullScanMs;
        await this.scan(full);
        if (full) this.#lastFull = now;
        if (!this.panel) await this.#connect();
        await this.#ship();
        await this.#maybeHello();
        attempt = 0;
        await this.#sleep(this.timing.pollMs);
      } catch (err) {
        if (this.stopped || err instanceof Stopped) break;
        this.panel = null;
        const known = err instanceof PanelError || err instanceof Resync;
        this.#setState('down', known ? err.kind : errCode(err), `down: ${known ? err.message : `${errCode(err)}: ${err.message}`}`);
        await this.#sleep(backoffDelay(attempt++, this.timing.backoffMinMs, this.timing.backoffMaxMs));
      }
    }
    this.log('stopped');
  }

  async #connect() {
    await this.#hello();
    await this.#loadManifest();
    const behind = [...this.local.values()]
      .filter(f => !this.refused.has(f.key) && f.size !== (this.panel.get(f.key)?.size ?? 0)).length;
    this.#setState('online', '', `online: the panel has ${this.panel.size} file${this.panel.size === 1 ? '' : 's'}; ${behind} of ${this.local.size} local file${this.local.size === 1 ? '' : 's'} to ship`);
  }

  #setState(state, detail, message) {
    const sig = `${state}\0${detail}`;
    this.state = state;
    if (sig === this.#stateSig) return;
    this.#stateSig = sig;
    this.log(message ?? `${state}: ${detail}`);
  }

  /** One line the first time a problem is seen (or its wording changes), then silence. */
  #problem(key, message) {
    if (this.#problems.get(key) === message) return;
    this.#problems.set(key, message);
    this.log(message);
  }

  #resolved(key, message) {
    if (!this.#problems.delete(key)) return;
    if (message) this.log(message);
  }

  #sleep(ms) {
    if (this.stopped) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.#wake = null; resolve(); };
      const timer = setTimeout(done, ms);
      this.#wake = done;
    });
  }

  // --------------------------------------------------------------------------- the wire ---

  async #call(method, route, { query, json, body } = {}) {
    const url = new URL(`${this.base}/api/bots/${encodeURIComponent(this.config.bot)}/${route}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) url.searchParams.set(k, String(v));
    const headers = {
      authorization: `Bearer ${this.config.token}`,
      'user-agent': `foreman-helper/${HELPER_VERSION}`,
    };
    let payload;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    } else if (body !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      payload = body;
    }
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(this.timing.requestTimeoutMs)]);
    let status, text;
    try {
      const res = await this.fetch(url, { method, headers, body: payload, signal });
      status = res.status;
      text = await res.text();
    } catch (err) {
      if (this.stopped) throw new Stopped();
      const code = err?.name === 'TimeoutError' ? 'timed out' : errCode(err?.cause ?? err);
      throw new PanelError(`the panel is unreachable (${code})`, 'unreachable');
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON; the status says enough */ }
    return { status, data };
  }

  async #hello() {
    const { status, data } = await this.#call('POST', 'hello', {
      json: {
        v: PROTOCOL_VERSION,
        instance: this.instance,
        helperVersion: HELPER_VERSION,
        host: this.host,
        roots: this.roots.map(r => ({ label: r.label, path: r.dir })),
        files: this.local.size,
      },
    });
    if (status !== 200) throw refusal(status, data);
    this.#lastHello = Date.now();
  }

  async #maybeHello() {
    if (Date.now() - this.#lastHello >= this.timing.helloMs) await this.#hello();
  }

  async fetchManifest() {
    const { status, data } = await this.#call('GET', 'manifest');
    if (status !== 200) throw refusal(status, data);
    if (data?.v !== PROTOCOL_VERSION || !Array.isArray(data.files)) {
      throw new PanelError(`the manifest is not protocol v${PROTOCOL_VERSION}`, 'manifest');
    }
    const panel = new Map();
    for (const f of data.files) {
      if (!f || !validComponents(f) || !Number.isSafeInteger(f.size) || f.size < 0) continue;
      const headLen = Math.min(Number.isSafeInteger(f.headLen) && f.headLen >= 0 ? f.headLen : HEAD_MAX, f.size);
      panel.set(keyOf(f), { size: f.size, headLen, head: typeof f.head === 'string' ? f.head : null });
    }
    return panel;
  }

  async #loadManifest() {
    this.panel = await this.fetchManifest();
    this.verified.clear();
  }

  // ----------------------------------------------------------------------- the shipping ---

  #differs(f) {
    if (this.refused.has(f.key)) return false;
    const p = this.panel?.get(f.key);
    if (!p) return f.size > 0 && this.held.get(f.key) !== `0:${f.size}`;
    if (this.verified.get(f.key) !== f.ino) return true;
    if (f.size === p.size) return false;
    return this.held.get(f.key) !== `${p.size}:${f.size}`;
  }

  async #ship() {
    for (let round = 0; ; round++) {
      try {
        const todo = [...this.local.values()]
          .filter(f => this.#differs(f))
          .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        for (const f of todo) {
          if (this.stopped) throw new Stopped();
          await this.#shipFile(f);
        }
        return;
      } catch (err) {
        if (!(err instanceof Resync) || round >= 1) throw err;
        this.log(`${err.message}: fetching the manifest again`);
        await this.#loadManifest();
      }
    }
  }

  async #shipFile(f) {
    let fh;
    try {
      fh = await fsp.open(f.path, O_READ);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      this.#problem(`read:${f.key}`, err.code === 'ELOOP'
        ? `refusing symlink ${f.path}`
        : `cannot read ${f.path} (${errCode(err)}): run the helper as the user that owns the files`);
      return;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) return;
      this.#resolved(`read:${f.key}`);
      const size = st.size;
      const p = this.panel.get(f.key);
      let offset = p ? p.size : 0;
      let reset = null;
      if (p && size < p.size) {
        reset = `the local file is smaller than the panel's copy (${size} < ${p.size})`;
      } else if (p && this.verified.get(f.key) !== st.ino) {
        if (p.head && p.head !== await headOf(fh, p.headLen)) reset = 'its head differs from the panel\'s copy';
        else this.verified.set(f.key, st.ino);
      }
      if (reset) {
        offset = 0;
        this.#problem(`reset:${f.key}`, `${f.key}: ${reset}; sending it again from 0`);
      }
      while (offset < size) {
        if (this.stopped) throw new Stopped();
        const want = Math.min(CHUNK_MAX, size - offset);
        const buf = Buffer.allocUnsafe(want);
        const { bytesRead } = await fh.read(buf, 0, want, offset);
        const n = shippableLength(buf.subarray(0, bytesRead));
        if (n === 0) {
          this.held.set(f.key, `${offset}:${size}`);
          return;
        }
        await this.#maybeHello();
        const { status, data } = await this.#call('POST', 'append', {
          query: {
            root: f.root,
            project: f.project,
            session: f.session,
            agent: f.agent || undefined,
            offset,
            reset: reset ? 1 : undefined,
          },
          body: buf.subarray(0, n),
        });
        if (status === 200) {
          if (data?.size !== offset + n) throw new Resync(`${f.key}: the panel answered size ${data?.size} after an append that should end at ${offset + n}`);
          offset = data.size;
          // The panel's head now covers bytes this process sent from this very inode, so it
          // is hashed here rather than left unknown — or a later replacement could not be told.
          const prev = this.panel.get(f.key);
          const headLen = Math.min(offset, HEAD_MAX);
          const head = !reset && prev?.head && prev.headLen === headLen ? prev.head : await headOf(fh, headLen);
          this.panel.set(f.key, { size: offset, headLen, head });
          this.verified.set(f.key, st.ino);
          this.held.delete(f.key);
          if (reset) this.#resolved(`reset:${f.key}`);
          reset = null;
          continue;
        }
        if (status === 409 && Number.isSafeInteger(data?.size)) {
          throw new Resync(`${f.key}: the panel's copy is ${data.size} bytes, not ${offset} (409)`);
        }
        if (status === 400 || status === 409 || status === 413 || status === 422) {
          const reason = data?.error ? `${status}, ${data.error}` : String(status);
          this.refused.set(f.key, reason);
          this.#problem(`refused:${f.key}`, `${f.key}: refused by the panel (${reason}); not sent again until the helper restarts`);
          return;
        }
        throw refusal(status, data);
      }
    } finally {
      await fh.close();
    }
  }

  // --------------------------------------------------------------------------- the walk ---

  /**
   * Re-reads what is on disk. A full scan `lstat`s every file; a quick one only the files it
   * has not seen and the ones modified within `recentMs`, and only opens a session's
   * `subagents/` when that session is new or its own file is recent. Never throws.
   */
  async scan(full = true) {
    const now = Date.now();
    const roots = await this.#expandRoots();
    const agentsBySession = new Map();
    for (const f of this.local.values()) {
      if (!f.agent) continue;
      const sk = `${f.root}/${f.project}/${f.session}`;
      if (!agentsBySession.has(sk)) agentsBySession.set(sk, []);
      agentsBySession.get(sk).push(f);
    }
    const next = new Map();
    const sessionDirs = new Set();
    for (const r of roots) await this.#scanRoot(r, { full, now, next, agentsBySession, sessionDirs });
    this.#seenSessionDirs = sessionDirs;
    this.roots = roots;
    this.local = next;
    for (const key of this.held.keys()) if (!next.has(key)) this.held.delete(key);
  }

  async #expandRoots() {
    const roots = [];
    const labels = new Set();
    const add = (label, dir) => {
      if (labels.has(label)) {
        this.#problem(`dup:${dir}`, `skipping ${dir}: the label "${label}" is already a root`);
        return false;
      }
      labels.add(label);
      roots.push({ label, dir });
      return true;
    };
    this.specs = [];
    for (const spec of this.config.watch) {
      const report = { label: spec.label, path: spec.path, glob: !!spec.glob, matched: 0, missing: false };
      this.specs.push(report);
      if (!spec.glob) {
        const ok = await isDir(spec.path);
        if (!ok) {
          report.missing = true;
          this.#problem(`root:${spec.path}`, `root ${spec.label}: ${spec.path} is not a directory (yet)`);
          continue;
        }
        this.#resolved(`root:${spec.path}`, `root ${spec.label}: ${spec.path} found`);
        if (add(spec.label, spec.path)) report.matched = 1;
        continue;
      }
      const { parent, pre, post, rest } = spec.glob;
      let names = [];
      try { names = await fsp.readdir(parent); } catch { /* reported below as matching nothing */ }
      for (const name of names.sort()) {
        if (name.startsWith('.') || name.length < pre.length + post.length + 1) continue;
        if (!name.startsWith(pre) || !name.endsWith(post)) continue;
        const match = name.slice(pre.length, name.length - post.length);
        let dir = path.join(parent, name);
        if (!await this.#plainDir(dir)) continue;
        let ok = true;
        for (const seg of rest) {
          dir = path.join(dir, seg);
          if (!await this.#plainDir(dir)) { ok = false; break; }
        }
        if (!ok) continue;
        const label = spec.label.replace('*', match);
        if (!isRoot(label)) {
          this.#problem(`label:${dir}`, `skipping ${dir}: "${label}" is not a valid root label`);
          continue;
        }
        if (add(label, dir)) report.matched++;
      }
      if (report.matched) this.#resolved(`glob:${spec.path}`, `root ${spec.label}: ${spec.path} matches ${report.matched} root${report.matched === 1 ? '' : 's'}`);
      else this.#problem(`glob:${spec.path}`, `root ${spec.label}: ${spec.path} matches nothing (yet)`);
    }
    const before = new Map(this.roots.map(r => [r.label, r.dir]));
    for (const r of roots) if (before.get(r.label) !== r.dir) this.log(`root ${r.label}: watching ${r.dir}`);
    for (const [label, dir] of before) if (!roots.some(r => r.label === label)) this.log(`root ${label}: ${dir} is gone`);
    return roots;
  }

  /** A directory reached by walking: `lstat`, and a symlink is refused rather than followed. */
  async #plainDir(p) {
    let st;
    try { st = await fsp.lstat(p); } catch { return false; }
    if (st.isSymbolicLink()) {
      this.#problem(`symlink:${p}`, `refusing symlink ${p}`);
      return false;
    }
    return st.isDirectory();
  }

  /** A file reached by walking: `lstat` → {size, mtimeMs, ino}, or null. Symlinks refused. */
  async #plainFile(p) {
    let st;
    try { st = await fsp.lstat(p); } catch { return null; }
    if (st.isSymbolicLink()) {
      this.#problem(`symlink:${p}`, `refusing symlink ${p}`);
      return null;
    }
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino } : null;
  }

  async #readdir(dir) {
    try {
      const names = await fsp.readdir(dir);
      this.#resolved(`readdir:${dir}`);
      return names;
    } catch (err) {
      if (err.code !== 'ENOENT') this.#problem(`readdir:${dir}`, `cannot list ${dir} (${errCode(err)})`);
      return null;
    }
  }

  async #scanRoot(r, { full, now, next, agentsBySession, sessionDirs }) {
    const projects = await this.#readdir(r.dir);
    if (!projects) return;
    const recent = f => full || !f || now - f.mtimeMs < this.timing.recentMs;
    for (const project of projects.sort()) {
      if (project.startsWith('.')) continue;
      const pdir = path.join(r.dir, project);
      if (!await this.#plainDir(pdir)) continue;
      if (!PROJECT_RE.test(project)) {
        this.#problem(`project:${pdir}`, `skipping ${pdir}: the panel would refuse that project name`);
        continue;
      }
      const names = await this.#readdir(pdir);
      if (!names) continue;
      const dirs = [];
      for (const name of names) {
        if (name.endsWith('.jsonl')) {
          const session = name.slice(0, -'.jsonl'.length);
          if (!SESSION_RE.test(session)) continue;
          const ids = { root: r.label, project, session, agent: null };
          const key = keyOf(ids);
          const prev = this.local.get(key);
          const file = path.join(pdir, name);
          const st = recent(prev) ? await this.#plainFile(file) : prev;
          if (st) next.set(key, { ...ids, key, path: file, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
        } else if (SESSION_RE.test(name)) {
          dirs.push(name);
        }
      }
      for (const session of dirs) {
        const sdir = path.join(pdir, session);
        const sk = `${r.label}/${project}/${session}`;
        const main = next.get(keyOf({ root: r.label, project, session }));
        const look = full || !this.#seenSessionDirs.has(sdir) || (main && now - main.mtimeMs < this.timing.recentMs);
        sessionDirs.add(sdir);
        if (!look) {
          for (const f of agentsBySession.get(sk) ?? []) next.set(f.key, f);
          continue;
        }
        if (!await this.#plainDir(sdir)) continue;
        const adir = path.join(sdir, 'subagents');
        let st;
        try { st = await fsp.lstat(adir); } catch { continue; }
        if (st.isSymbolicLink()) { this.#problem(`symlink:${adir}`, `refusing symlink ${adir}`); continue; }
        if (!st.isDirectory()) continue;
        const agents = await this.#readdir(adir);
        if (!agents) continue;
        for (const name of agents) {
          if (!name.endsWith('.jsonl')) continue;
          const agent = name.slice(0, -'.jsonl'.length);
          if (!AGENT_RE.test(agent)) continue;
          const ids = { root: r.label, project, session, agent };
          const key = keyOf(ids);
          const prev = this.local.get(key);
          const file = path.join(adir, name);
          const fst = recent(prev) ? await this.#plainFile(file) : prev;
          if (fst) next.set(key, { ...ids, key, path: file, size: fst.size, mtimeMs: fst.mtimeMs, ino: fst.ino });
        }
      }
    }
  }

  // -------------------------------------------------------------------------- --check ---

  /** Prints what a maintainer needs when the bot's row does not appear. Resolves to an exit code. */
  async check(write = s => process.stdout.write(s)) {
    const out = (k, v) => write(`${k.padEnd(13)}${v}\n`);
    write(`foreman-helper ${HELPER_VERSION} --check (protocol v${PROTOCOL_VERSION})\n`);
    await this.scan(true);
    let ok = true;

    let panel = null;
    try {
      panel = await this.fetchManifest();
      out('panel', `${this.config.url}  reachable`);
      out('token', `accepted for bot ${this.config.bot}`);
    } catch (err) {
      ok = false;
      const msg = err.message;
      if (/unreachable/.test(msg)) {
        out('panel', `${this.config.url}  unreachable ${msg.replace(/^the panel is unreachable /, '')}`);
        out('token', 'not checked');
      } else {
        out('panel', `${this.config.url}  reachable`);
        out('token', /401/.test(msg) ? `refused for bot ${this.config.bot}: check FOREMAN_BOT and FOREMAN_BOT_TOKEN` : `not checked: ${msg}`);
      }
    }

    const width = Math.max(4, ...this.roots.map(r => r.label.length), ...this.specs.map(sp => sp.label.length));
    let first = true;
    const rootLine = text => { out(first ? 'roots' : '', text); first = false; };
    for (const r of this.roots) {
      const files = [...this.local.values()].filter(f => f.root === r.label);
      let unreadable = 0;
      for (const f of files) {
        try { await fsp.access(f.path, fs.constants.R_OK); } catch { unreadable++; }
      }
      const note = unreadable ? ` (${unreadable} unreadable: run the helper as the user that owns the files)` : '';
      rootLine(`${r.label.padEnd(width)}  ${r.dir}  ${files.length} file${files.length === 1 ? '' : 's'}${note}`);
    }
    for (const spec of this.specs) {
      if (!spec.matched) rootLine(`${spec.label.padEnd(width)}  ${spec.path}  ${spec.glob ? 'matches nothing' : 'not found'}`);
    }

    if (panel) {
      let never = 0;
      let behind = 0;
      for (const f of this.local.values()) {
        const p = panel.get(f.key);
        if (!p) { if (f.size > 0) never++; continue; }
        if (f.size !== p.size) { behind++; continue; }
        if (p.head) {
          let head = null;
          try {
            const fh = await fsp.open(f.path, O_READ);
            try { head = await headOf(fh, p.headLen); } finally { await fh.close(); }
          } catch { /* unreadable: counted on the roots line */ }
          if (head !== p.head) behind++;
        }
      }
      const lacking = never + behind;
      out('panel lacks', `${lacking} of ${this.local.size} file${this.local.size === 1 ? '' : 's'}${lacking ? ` (${never} never sent, ${behind} behind or different)` : ''}`);
    } else {
      out('panel lacks', 'unknown: no manifest');
    }
    out('result', ok ? 'ok' : 'NOT ok');
    return ok ? 0 : 1;
  }
}

/** The operator's own configured path: followed, symlinks and all, since they wrote it. */
async function isDir(p) {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

/** sha256 hex of a file's first `len` bytes, or null when it is shorter than that. */
async function headOf(fh, len) {
  const buf = Buffer.alloc(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, got);
    if (!bytesRead) return null;
    got += bytesRead;
  }
  return sha256(buf);
}

// -------------------------------------------------------------------------------- main ---

const USAGE = `usage: node foreman-helper.mjs [--check]

  FOREMAN_URL        the panel, e.g. http://host.docker.internal:48770
  FOREMAN_BOT        the bot id from \`foreman-panel bots add <bot id>\`
  FOREMAN_BOT_TOKEN  the token that command printed
  FOREMAN_WATCH      label=<projects dir>[;label=<projects dir>...]; a path may hold one *,
                     and its label then holds one * that becomes what the path's * matched

  --check            say whether the panel is reachable, the token accepted, which roots
                     matched and how many files the panel lacks, then exit
`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--version')) {
    process.stdout.write(`foreman-helper ${HELPER_VERSION} (protocol v${PROTOCOL_VERSION})\n`);
    return 0;
  }
  const unknown = argv.filter(a => a !== '--check');
  if (unknown.length) {
    process.stderr.write(`foreman-helper: unknown argument ${unknown[0]}\n${USAGE}`);
    return 2;
  }
  let config;
  try {
    config = readConfig(env);
  } catch (err) {
    process.stderr.write(`foreman-helper: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (argv.includes('--check')) {
    // The report is the whole output; the walk's own state lines would only repeat it.
    return new Helper(config, { log: () => {}, timing: { requestTimeoutMs: 10_000 } }).check();
  }
  const helper = new Helper(config);
  // As PID 1 in a container, Node ignores SIGTERM unless something listens for it.
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => helper.stop());
  await helper.run();
  return 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(code => { process.exitCode = code; }, err => {
    process.stderr.write(`foreman-helper: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
}
