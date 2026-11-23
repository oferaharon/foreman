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
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { runsClaude } from './tmux.js';

const run = promisify(execFile);

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
    return { configDir: path.join(home, '.claude'), explicit: false };
  }
  let dir = value.trim();
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/')) dir = path.join(home, dir.slice(2));
  if (!path.isAbsolute(dir)) return null;
  return { configDir: path.resolve(dir), explicit: true };
}

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
    configDir: shortPath(configDir, home),
    folder: explicit ? path.basename(configDir) : 'default',
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
      const file = accountFileFor(dir, this.home);
      usedFiles.add(file);
      const account = await this.#account(file, dir);
      out.set(p.paneId, account);
      if (account?.uuid) seen.set(account.uuid, account);
    }
    for (const f of this.files.keys()) if (!usedFiles.has(f)) this.files.delete(f);
    this.seen = seen;
    return out;
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
