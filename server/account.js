/**
 * Which Claude account a pane's session runs on — a label, and nothing more.
 *
 * A second Claude Code account on one Mac is run through `CLAUDE_CONFIG_DIR` (an alias
 * like `claude-work` pointing it at `~/.claude-work`). Nothing on screen says which account
 * a session is on, and the transcript does not either, so the answer is read off the
 * process: pane → the `claude` process under it → that process's environment → the config
 * dir → that dir's account record. Every step can fail, and every failure is `null` — no
 * tag rather than a wrong one.
 *
 * **What was measured, on Claude Code v2.1.322, in the sandbox:**
 *
 * - `pane_pid` is the login shell (`zsh -ilc claude`); `claude` is its child. A pane where
 *   the shell `exec`s instead has `claude` as `pane_pid` itself — both are handled.
 * - `ps -E -ww -p <pid> -o command=` prints the argv, then the environment, space-joined.
 *   `CLAUDE_CONFIG_DIR` absent means the default dir, `~/.claude`.
 * - **The account file moves with the variable.** Absent, it is `~/.claude.json` — in the
 *   home directory, beside `~/.claude/`, not inside it. Set, Claude Code writes
 *   `$CLAUDE_CONFIG_DIR/.claude.json` (a fresh dir gained one, plus `backups/`, `cache/`
 *   and `sessions/`, within seconds of the first launch, at the login screen).
 * - A dir nobody has logged into has a `.claude.json` with **no `oauthAccount`** — it still
 *   says which config dir the session is on, so it is answered as `signedIn: false` with
 *   its folder name, not as `null`.
 * - `oauthAccount.displayName` and `organizationName` are the person's, not the account's,
 *   so two accounts of one person read alike there; `accountUuid` is the identity and is
 *   what a nickname is keyed on.
 *
 * **Cost.** A process's environment never changes during its life, so the config dir is
 * read once per `claude` pid and kept until that pid leaves the roster. The process table
 * is read only when a pane's cached `claude` has died (a `kill(pid, 0)` answers that
 * without a subprocess) or the pane is new — on a quiet bench, never. The account file
 * itself is ~0.5 MB for the default dir and rewritten often, so it is re-stat'ed at most
 * every few seconds and re-parsed only when its mtime or size moved.
 *
 * The email rides the roster for the hover and is never the visible tag (`web/account-tag.js`).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runsClaude } from './tmux.js';
import { STATE_DIR } from './config.js';

const run = promisify(execFile);

/*
 * **The one spelling of account roots.** A config dir is the folder `CLAUDE_CONFIG_DIR`
 * names — `~/.claude` when it is unset — and everything account-shaped hangs off it: its
 * transcripts in `<dir>/projects/<cwd with each slash as a dash>/<id>.jsonl` (MEASURED on
 * v2.1.331: a second-account session writes *nothing* under `~/.claude/projects`), its peer
 * registry in `<dir>/sessions/`, its plan files in `<dir>/plans/`, its slash commands, skills and
 * plugins beside them. Nothing else in `server/` works out a projects root, a config dir from
 * a path, or "is this the default dir"; `config.js`'s `PROJECTS_DIR` is the default dir's
 * spelling and a test pins it to these.
 */

/** The config dir Claude Code uses when `CLAUDE_CONFIG_DIR` is unset, for a given home. */
export function defaultConfigDirFor(home = os.homedir()) {
  return path.join(home, '.claude');
}

/** `~/.claude`, absolute. */
export const DEFAULT_CONFIG_DIR = defaultConfigDirFor();

/** Where a config dir keeps its transcripts. */
export function projectsDirOf(configDir) {
  return path.join(configDir, 'projects');
}

/** Where a config dir keeps its peer registry (`<pid>.json` per live session). */
export function peersDirOf(configDir) {
  return path.join(configDir, 'sessions');
}

/** Where a config dir keeps the plan files plan mode writes (`<dir>/plans/<name>.md`). */
export function plansDirOf(configDir) {
  return path.join(configDir, 'plans');
}

/**
 * The config dir a transcript belongs to: the folder above the nearest `projects` ancestor
 * of the file, or `null` when the path has none (or is not absolute).
 *
 * *Nearest*, walking up from the file, because a config dir may itself sit under a folder
 * called `projects`; the folder a transcript is filed under is a cwd encoded with dashes,
 * which starts with a dash and so is never the bare word. A subagent's transcript
 * (`<id>/subagents/…`) walks up to the same root as its parent's.
 */
export function configDirOfTranscript(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    if (path.basename(dir) === 'projects') return parent;
    dir = parent;
  }
}

/**
 * Is this `configDirFromPs` answer another account's folder rather than the default one?
 * An explicit `CLAUDE_CONFIG_DIR` that *is* `~/.claude` is not: its conversations are the
 * default's. The one spelling of "non-default dir" — the roster's `account.explicit` (what
 * `onOtherAccount` reads) and the known-dirs list are both this.
 */
export function isOtherConfigDir({ configDir, explicit } = {}, home = os.homedir()) {
  return Boolean(explicit) && Boolean(configDir) && !sameConfigDir(configDir, defaultConfigDirFor(home));
}

/** Do two config dirs name the same folder? Both absolute; `null` is never the same as anything. */
export function sameConfigDir(a, b) {
  return Boolean(a && b) && path.resolve(a) === path.resolve(b);
}

/** `/bin/ps`, absolute: launchd's `PATH` resolves it anyway, but nothing here should depend on that. */
const PS = '/bin/ps';

/** How long a stat of an account file is trusted before it is asked again. */
export const ACCOUNT_RECHECK_MS = 5000;

/**
 * `ps -A -o pid=,ppid=,comm=` → `Map<pid, {ppid, comm}>`. `comm` can be a full path with
 * spaces in it (an app bundle), so it is the rest of the line, not a third token.
 */
export function parseProcessTable(stdout) {
  const table = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3] });
  }
  return table;
}

/**
 * The `claude` process a pane is running: the pane's own pid when the shell `exec`ed it,
 * otherwise the shallowest descendant that is one. `null` when there is none — a pane the
 * roster admitted on `pane_current_command` whose process has since gone.
 */
export function claudePidFor(panePid, table) {
  if (!panePid || !table?.size) return null;
  if (runsClaude(table.get(panePid)?.comm)) return panePid;
  const children = new Map();
  for (const [pid, { ppid }] of table) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  let level = [panePid];
  for (let depth = 0; depth < 4 && level.length; depth += 1) {
    const next = [];
    for (const pid of level) {
      for (const child of (children.get(pid) || []).sort((a, b) => a - b)) {
        if (runsClaude(table.get(child)?.comm)) return child;
        next.push(child);
      }
    }
    level = next;
  }
  return null;
}

/**
 * The config dir a process runs with, from `ps -E -ww -p <pid> -o command=`.
 *
 * Returns `{ configDir, explicit }`, or `null` when the answer is not knowable:
 * - no environment in the output at all — `ps -E` prints none for another user's process,
 *   and reading that silence as "the default dir" would tag a stranger's session wrongly;
 * - a relative `CLAUDE_CONFIG_DIR`, which Claude Code resolves against a cwd this cannot see.
 *
 * The value is taken up to the next ` NAME=` token, so a path with a space in it survives;
 * the *last* occurrence wins, because the environment comes after the argv and an argument
 * could spell the same text.
 */
export function configDirFromPs(output, home = os.homedir()) {
  const line = String(output || '').replace(/\n+$/, '');
  if (!/\s(HOME|PATH|USER|TMUX_PANE)=/.test(line)) return null;
  const re = /(?:^|\s)CLAUDE_CONFIG_DIR=(.*?)(?=\s+[A-Za-z_][A-Za-z0-9_]*=|$)/g;
  let value = null;
  for (let m = re.exec(line); m; m = re.exec(line)) value = m[1];
  if (value == null || value.trim() === '') {
    return { configDir: defaultConfigDirFor(home), explicit: false };
  }
  let dir = value.trim();
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/')) dir = path.join(home, dir.slice(2));
  if (!path.isAbsolute(dir)) return null;
  return { configDir: path.resolve(dir), explicit: true };
}

/**
 * Why a row on another account is left alone by every path that would start it again.
 * One sentence, spelled once: restart-one's refusal, relaunch-all's skip and hibernation's
 * verdict all say it, and the rail shows it.
 */
export const OTHER_ACCOUNT_WHY = 'it runs on another Claude account; the panel can’t start it there yet';

/**
 * **The account fence.** Is this roster row positively known to run on a config dir other
 * than the default one?
 *
 * Every launch path here starts plain `claude`, which is the default account, and a
 * `--resume` of a conversation that lives in another account's folder fails with "No
 * conversation found" after the old session has already been `/exit`ed — the session is
 * gone (measured, see `docs/traps/accounts.md`). So anything that would end a session in
 * order to start it again asks this first. It is one predicate so there is one spelling of
 * "another account" (`docs/traps/one-spelling.md`); the day launches carry an account it is
 * lifted from here and from nowhere else.
 *
 * Only a *known* answer fires it. `account: null` — `ps` failed, the process is gone, the
 * environment was unreadable — behaves exactly as it did before the fence existed: unknown
 * is not "another account", and a fence that fired on a doubt would refuse every session
 * the moment `ps` hiccupped.
 */
export const onOtherAccount = (row) => row?.account?.explicit === true;

/** Where that config dir's account record lives — measured, see the header. */
export function accountFileFor({ configDir, explicit }, home = os.homedir()) {
  return explicit ? path.join(configDir, '.claude.json') : path.join(home, '.claude.json');
}

/**
 * A plan in a few words, from the org record: the rate-limit tier when it names one
 * (`default_claude_max_5x` → `Max 5x`), else the org type (`claude_pro` → `Pro`). `null`
 * for anything else — an unknown shape is not guessed at.
 */
export function planLabel(oauth) {
  const word = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const tier = typeof oauth?.organizationRateLimitTier === 'string' ? oauth.organizationRateLimitTier : '';
  const t = /claude_([a-z]+)(?:_(\d+x))?$/.exec(tier);
  if (t) return t[2] ? `${word(t[1])} ${t[2]}` : word(t[1]);
  const type = typeof oauth?.organizationType === 'string' ? oauth.organizationType : '';
  const o = /^claude_([a-z]+)$/.exec(type);
  return o ? word(o[1]) : null;
}

/** `~`-shortened, for a hover. */
export function shortPath(p, home = os.homedir()) {
  if (!p) return p;
  if (p === home) return '~';
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * The account a config dir is on, from the text of its account file. Only the few fields
 * the tag and its hover draw are kept — the file holds a great deal else (projects, MCP
 * config, history) and none of it belongs on a roster.
 *
 * `null` for text that is not a JSON object: unreadable is unknown, and unknown is no tag.
 */
export function readAccount(text, { configDir, explicit }, home = os.homedir()) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const base = {
    // Absolute, for anything that computes with it (a scan root, a binding fence, a launch).
    // `configDir` beside it is `~`-shortened for display and must never be fed back into a
    // `path.join` or a shell argument — a literal `~` is not a home directory there.
    dir: configDir,
    configDir: shortPath(configDir, home),
    folder: explicit ? path.basename(configDir) : 'default',
    // Another account's folder, as against the default one — what `onOtherAccount` reads. An
    // explicit `CLAUDE_CONFIG_DIR` that *is* `~/.claude` is not another folder: its
    // conversations are the default's, so a plain `claude --resume` finds them.
    explicit: isOtherConfigDir({ configDir, explicit }, home),
  };
  const o = json.oauthAccount;
  const uuid = typeof o?.accountUuid === 'string' && o.accountUuid ? o.accountUuid : null;
  if (!uuid) return { ...base, uuid: null, email: null, plan: null, signedIn: false };
  return {
    ...base,
    uuid,
    email: typeof o.emailAddress === 'string' ? o.emailAddress : null,
    plan: planLabel(o),
    signedIn: true,
  };
}

async function runPs(args) {
  const { stdout } = await run(PS, args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The reader the roster asks once a poll. Everything it touches is injectable — `ps`,
 * the file reads, the clock, the liveness probe — so the cache is tested for what it
 * *does not* run, against fixture output, without a process in sight.
 */
export class AccountReader {
  constructor({
    ps = runPs,
    readFile = (f) => fsp.readFile(f, 'utf8'),
    stat = (f) => fsp.stat(f),
    alive = pidAlive,
    now = Date.now,
    home = os.homedir(),
    recheckMs = ACCOUNT_RECHECK_MS,
  } = {}) {
    this.ps = ps;
    this.readFile = readFile;
    this.stat = stat;
    this.alive = alive;
    this.now = now;
    this.home = home;
    this.recheckMs = recheckMs;
    this.claudeOf = new Map(); // pane pid -> claude pid
    this.dirOf = new Map(); // claude pid -> {configDir, explicit} | null
    this.files = new Map(); // account file -> {checkedAt, mtimeMs, size, account}
    this.seen = new Map(); // accountUuid -> account, as of the last call
    // paneId -> {configDir, explicit}, as of the last call: the binding fence's input. Kept
    // apart from the account, because the dir is known from the process even when the
    // account file beside it is unreadable — and the fence must not loosen for that.
    this.paneDirs = new Map();
    this.calls = { table: 0, env: 0, read: 0 }; // what the cache let through, for the tests
  }

  /**
   * `panes` is the roster's `listClaudePanes()` answer (`paneId`, `pid`). Returns
   * `Map<paneId, account|null>`. Never throws: a failure is a pane with no tag.
   */
  async forPanes(panes) {
    const out = new Map();
    const list = (panes || []).filter((p) => p?.paneId && p.pid);

    const stale = list.some((p) => {
      const c = this.claudeOf.get(p.pid);
      return !c || !this.alive(c);
    });
    if (stale) {
      let table = null;
      try {
        this.calls.table += 1;
        table = parseProcessTable(await this.ps(['-A', '-o', 'pid=,ppid=,comm=']));
      } catch {
        table = null;
      }
      for (const p of list) {
        const c = this.claudeOf.get(p.pid);
        if (c && this.alive(c)) continue;
        const found = table ? claudePidFor(p.pid, table) : null;
        if (found) this.claudeOf.set(p.pid, found);
        else this.claudeOf.delete(p.pid);
      }
    }

    // Forget what left the roster, so a reused pid starts from nothing.
    const livePanePids = new Set(list.map((p) => p.pid));
    for (const pid of this.claudeOf.keys()) if (!livePanePids.has(pid)) this.claudeOf.delete(pid);
    const liveClaude = new Set(this.claudeOf.values());
    for (const pid of this.dirOf.keys()) if (!liveClaude.has(pid)) this.dirOf.delete(pid);

    const seen = new Map();
    const usedFiles = new Set();
    const paneDirs = new Map();
    for (const p of list) {
      const claude = this.claudeOf.get(p.pid);
      if (!claude) {
        out.set(p.paneId, null);
        continue;
      }
      const dir = await this.#dir(claude);
      if (!dir) {
        out.set(p.paneId, null);
        continue;
      }
      paneDirs.set(p.paneId, dir);
      const file = accountFileFor(dir, this.home);
      usedFiles.add(file);
      const account = await this.#account(file, dir);
      out.set(p.paneId, account);
      if (account?.uuid) seen.set(account.uuid, account);
    }
    for (const f of this.files.keys()) if (!usedFiles.has(f)) this.files.delete(f);
    this.seen = seen;
    this.paneDirs = paneDirs;
    return out;
  }

  /**
   * The absolute config dir this pane's `claude` runs with, as of the last `forPanes`, or
   * `null` when that is not knowable (no process found, `ps` refused, another user's
   * process). A `null` is read by the binding fence as the default dir — today's behaviour.
   */
  configDirOf(paneId) {
    return this.paneDirs.get(paneId)?.configDir ?? null;
  }

  /** Every other-account dir on a live pane as of the last call — `account.explicit`'s rule. */
  explicitDirs() {
    const other = [...this.paneDirs.values()].filter((d) => isOtherConfigDir(d, this.home));
    return [...new Set(other.map((d) => d.configDir))];
  }

  /** The signed-in accounts on the roster right now, for the settings box. */
  known() {
    return [...this.seen.values()];
  }

  async #dir(pid) {
    if (this.dirOf.has(pid)) return this.dirOf.get(pid);
    let output;
    try {
      this.calls.env += 1;
      output = await this.ps(['-E', '-ww', '-p', String(pid), '-o', 'command=']);
    } catch {
      return null; // gone between the table and now — asked again next poll, not cached
    }
    const dir = configDirFromPs(output, this.home);
    this.dirOf.set(pid, dir);
    return dir;
  }

  async #account(file, dir) {
    const now = this.now();
    const held = this.files.get(file);
    if (held && now - held.checkedAt < this.recheckMs) return held.account;
    let st;
    try {
      st = await this.stat(file);
    } catch {
      this.files.set(file, { checkedAt: now, mtimeMs: null, size: null, account: null });
      return null;
    }
    if (held && held.mtimeMs === st.mtimeMs && held.size === st.size) {
      held.checkedAt = now;
      return held.account;
    }
    let account = null;
    try {
      this.calls.read += 1;
      account = readAccount(await this.readFile(file), dir, this.home);
    } catch {
      account = null;
    }
    // A file caught mid-rewrite by a writer that does not rename is unparseable for a
    // moment; the last good answer stands until the next stat, rather than the tag flickering.
    if (!account && held?.account) account = held.account;
    this.files.set(file, { checkedAt: now, mtimeMs: st.mtimeMs, size: st.size, account });
    return account;
  }
}

/**
 * The roster's `account` field: the reader's answer plus the nickname, or `null`.
 * `nicknames` is the validated map from `config.json` (`readNicknames`).
 */
export function withNickname(account, nicknames = {}) {
  if (!account) return null;
  const nickname = account.uuid && typeof nicknames?.[account.uuid] === 'string' ? nicknames[account.uuid] : null;
  return { ...account, nickname };
}

/** `STATE_DIR/accounts.json` — the config dirs the panel has seen on a live pane. */
export const ACCOUNTS_FILE = path.join(STATE_DIR, 'accounts.json');

/**
 * The **known config dirs**: the default, plus every explicit dir `AccountReader` has seen on
 * a live pane, persisted so a dir stays scanned through a moment with nothing running on it
 * (its transcripts are still somebody's conversation to bind once a pane comes back).
 *
 * Detected, never typed in: the only writer is `note`, fed from the process table. The file
 * is `{dirs: [absolute paths], …}` and is rewritten wholesale with **unknown keys carried
 * through**, so a later build's fields survive a rollback's rewrite. An unparseable file is
 * left exactly where it is and never replaced — the dirs noted while it is unreadable are
 * held in memory for the run. Dirs are never pruned: a dir that has gone from disk costs one
 * failed `readdir` a poll.
 */
export class KnownConfigDirs {
  constructor({ file = ACCOUNTS_FILE, defaultDir = DEFAULT_CONFIG_DIR } = {}) {
    this.file = file;
    this.defaultDir = path.resolve(defaultDir);
    this.extra = {}; // unknown top-level keys, carried through
    this.dirs = [];
    this.writable = true;
    this.#load();
  }

  #load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') this.writable = false;
      return;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      this.writable = false;
      return;
    }
    const { dirs, ...rest } = json;
    this.extra = rest;
    for (const d of Array.isArray(dirs) ? dirs : []) this.#add(d);
  }

  #add(dir) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
    const abs = path.resolve(dir);
    if (sameConfigDir(abs, this.defaultDir) || this.dirs.includes(abs)) return false;
    this.dirs.push(abs);
    return true;
  }

  /** Record dirs seen on live panes. Writes only when something new was learned. */
  note(dirs) {
    let changed = false;
    for (const d of dirs || []) if (this.#add(d)) changed = true;
    if (changed) this.#flush();
    return changed;
  }

  /** The default dir first, then every explicit one, in the order they were first seen. */
  list() {
    return [this.defaultDir, ...this.dirs];
  }

  #flush() {
    if (!this.writable) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Same directory, so the rename is a rename and not a silent copy-then-delete.
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ ...this.extra, dirs: this.dirs }, null, 2)}\n`);
      fs.renameSync(tmp, this.file);
    } catch {
      /* the list is still right in memory; the next new dir tries again */
    }
  }
}
