/**
 * The panel's two settings entries — the status hook and the status-line wrapper — for one
 * Claude config dir: where its files are, what is installed there, and installing both.
 *
 * **Why per config dir.** A second Claude account runs through `CLAUDE_CONFIG_DIR` and reads
 * its own `<dir>/settings.json`, never `~/.claude/settings.json` (MEASURED on v2.1.331, see
 * `docs/traps/accounts.md`). So a session on that account sends the panel nothing until
 * *that* file holds the two entries, and the CLIs (`--config-dir`) and the settings box's
 * Install button both come through here.
 *
 * **Detected, never typed in.** `POST /api/accounts/:key/install` takes an index into
 * `KnownConfigDirs` — dirs the panel saw on a live pane's own process — and never a path,
 * because the panel answers anyone on the LAN with no authentication (by ruling), and an
 * endpoint that wrote a settings file wherever a request said would hand that write to all of
 * them. The CLIs take a path because whoever runs them already has this machine's shell.
 *
 * **Never automatic.** Nothing here runs when a new dir appears: a human presses Install
 * (the maintainer's ruling, Q4 of the multi-account plan). A settings change reaches that
 * account's *running* sessions within seconds (MEASURED, M7), which is the point and is
 * exactly why it is a press and not a side effect.
 *
 * **The default dir is byte-identical to before.** Its settings path is
 * `~/.claude/settings.json` (`installTarget()` is the one spelling of it — `config.js`'s old
 * `SETTINGS_PATH` is gone), its wrapper and sidecar keep their unsuffixed names, and the plans the
 * pure halves (`hook-settings.js`, `statusline.js`) hand back for it carry no new key.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG_DIR, sameConfigDir, shortPath } from './account.js';
import { STATE_DIR } from './config.js';
import { hookState, planHookInstall } from './hook-settings.js';
import {
  configDirSuffix,
  looksLikeAWrapper,
  planInstall,
  sidecarFilenameFor,
  statusLineState,
  wrapperFilenameFor,
} from './statusline.js';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Every path one config dir's install touches. `isDefault` is decided by `sameConfigDir`
 * against `account.js`'s default, the one spelling of "is this the default dir".
 */
export function installTarget(configDir = DEFAULT_CONFIG_DIR, { stateDir = STATE_DIR, defaultDir = DEFAULT_CONFIG_DIR } = {}) {
  const dir = path.resolve(configDir);
  const isDefault = sameConfigDir(dir, defaultDir);
  const suffix = isDefault ? null : configDirSuffix(dir);
  const sidecarName = sidecarFilenameFor(suffix);
  return {
    configDir: dir,
    isDefault,
    suffix,
    settingsPath: path.join(dir, 'settings.json'),
    wrapperPath: path.join(stateDir, wrapperFilenameFor(suffix)),
    sidecarPath: path.join(stateDir, sidecarName),
    sidecarName,
    stateDir,
    // The default dir's own wrapper record, which a dir with no status line borrows from.
    defaultSidecarPath: path.join(stateDir, sidecarFilenameFor(null)),
    defaultSettingsPath: path.join(path.resolve(defaultDir), 'settings.json'),
  };
}

/**
 * `{settings, exists}`: absent is `{}` (the first-run case), present-but-unparseable — or a
 * JSON value that is not an object — is `settings: null`, which every planner refuses on.
 * An unreadable file (permissions) throws, because "could not read" is not "empty".
 */
export function readSettings(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { settings: {}, exists: false };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw);
    return { settings: isPlainObject(parsed) ? parsed : null, exists: true };
  } catch {
    return { settings: null, exists: true };
  }
}

/** A JSON file's object, or `null` for missing or nonsense. */
export function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Copy `settings.json` aside before writing it — **beside that file**, as
 * `settings.backup-foreman-<ms>.json`, which is where both installers have always put one.
 * Claude Code reads `settings.json` and `settings.local.json` and no other name there, so a
 * backup beside it is read by nothing. Never over an earlier backup: two installers run in
 * one millisecond (the Install button runs both) would otherwise overwrite the pristine copy
 * with the half-installed one, so the stamp steps forward until the name is free.
 */
export function backupSettings(file) {
  if (!fs.existsSync(file)) return null;
  let ms = Date.now();
  let dest;
  for (;;) {
    dest = path.join(path.dirname(file), `settings.backup-foreman-${ms}.json`);
    if (!fs.existsSync(dest)) break;
    ms += 1;
  }
  fs.copyFileSync(file, dest);
  return dest;
}

export function writeSettings(file, settings) {
  // The config dir may not exist yet on a machine that has never had a settings file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * The status line a config dir with none of its own runs: the default account's own command
 * (the maintainer's ruling, Q1 (b)), read from the default's wrapper record — that record is
 * the only place the command still exists once the default is wrapped. If the default has
 * never been wrapped its settings file still holds it, unless that is itself a wrapper whose
 * record has gone, in which case nothing is borrowed. `null` for the default dir itself.
 */
export function borrowedStatusLine(target) {
  if (target.isDefault) return null;
  const sidecar = readJsonObject(target.defaultSidecarPath);
  if (sidecar && Object.hasOwn(sidecar, 'original')) {
    return isPlainObject(sidecar.original) ? sidecar.original : null;
  }
  let settings = null;
  try {
    settings = readSettings(target.defaultSettingsPath).settings;
  } catch {
    settings = null;
  }
  const line = settings?.statusLine;
  if (!isPlainObject(line) || typeof line.command !== 'string' || looksLikeAWrapper(line.command)) return null;
  return line;
}

/**
 * What the settings box shows for one dir, read from its own file: the hook (`installed` /
 * `outdated` / `missing` / `unreadable`), the status line (`wrapped` / `missing` / `foreign`
 * / `unreadable`), and the command the wrapper runs or would run — the dir's own, or the
 * borrowed default one, or `null` for a blank line. Never throws.
 */
export function installStatus(target, port) {
  let settings = null;
  try {
    settings = readSettings(target.settingsPath).settings;
  } catch {
    settings = null;
  }
  const statusLine = statusLineState(settings, target.wrapperPath);
  let own = null;
  let lent = null;
  if (statusLine === 'wrapped') {
    // What the wrapper on disk runs now, from its own record — not what a regeneration
    // would borrow, which can have moved since.
    const sidecar = readJsonObject(target.sidecarPath);
    own = isPlainObject(sidecar?.original) ? sidecar.original : null;
    lent = own ? null : isPlainObject(sidecar?.borrowed) ? sidecar.borrowed : null;
  } else {
    own = isPlainObject(settings?.statusLine) ? settings.statusLine : null;
    lent = own ? null : borrowedStatusLine(target);
  }
  const runs = typeof (own || lent)?.command === 'string' ? (own || lent).command : null;
  return {
    hook: hookState(settings, port),
    statusLine,
    runs,
    runsBorrowed: !own && Boolean(lent),
  };
}

/**
 * Install both entries into one config dir, as one write: plan the hook, plan the status
 * line on the result, refuse the lot if either refuses, then write the wrapper and its
 * record, back the settings file up, and write it once. `{ok, …}` — never `process.exit`,
 * because the caller is an endpoint.
 */
export function installAccount(target, { port, now = Date.now() } = {}) {
  let read;
  try {
    read = readSettings(target.settingsPath);
  } catch (err) {
    return { ok: false, code: 'UNREADABLE_SETTINGS', message: `Could not read ${target.settingsPath} (${err.code}).` };
  }
  if (!read.settings) {
    return {
      ok: false,
      code: 'UNREADABLE_SETTINGS',
      message: `${target.settingsPath} could not be parsed. Refusing to write over a file the panel cannot read. Nothing has been changed.`,
    };
  }

  const hook = planHookInstall(read.settings, port);
  const line = planInstall({
    settings: hook.settings,
    sidecar: readJsonObject(target.sidecarPath),
    wrapperPath: target.wrapperPath,
    port,
    now,
    target: target.isDefault ? null : target,
    borrowed: borrowedStatusLine(target),
  });
  if (!line.ok) return line;

  // The script and its record before the settings that name them, so there is never a
  // moment where `statusLine.command` points at a file that is not there.
  fs.mkdirSync(target.stateDir, { recursive: true });
  fs.writeFileSync(target.wrapperPath, line.script, { mode: 0o755 });
  fs.chmodSync(target.wrapperPath, 0o755);
  fs.writeFileSync(target.sidecarPath, `${JSON.stringify(line.sidecar, null, 2)}\n`);

  const changed = Boolean(hook.added || hook.updated || line.changed);
  let backup = null;
  if (changed) {
    backup = backupSettings(target.settingsPath);
    writeSettings(target.settingsPath, line.settings);
  }
  return {
    ok: true,
    changed,
    hook: { added: hook.added, updated: hook.updated },
    statusLine: { changed: line.changed, borrowed: line.borrowed, notes: line.notes, warnings: line.warnings },
    wrote: changed ? [target.settingsPath, target.wrapperPath, target.sidecarPath] : [target.wrapperPath, target.sidecarPath],
    backup,
  };
}

/**
 * The settings box's rows: one per known config dir, in `KnownConfigDirs` order — the
 * default first — with its index as the key the Install button posts back. Paths are
 * `~`-shortened here because they are for reading; nothing posts them back.
 */
export function installRows(dirs, { port, stateDir = STATE_DIR, defaultDir = DEFAULT_CONFIG_DIR } = {}) {
  return dirs.map((dir, key) => {
    const target = installTarget(dir, { stateDir, defaultDir });
    return {
      key,
      folder: target.isDefault ? 'default' : path.basename(target.configDir),
      configDir: shortPath(target.configDir),
      isDefault: target.isDefault,
      settingsPath: shortPath(target.settingsPath),
      wrapperPath: shortPath(target.wrapperPath),
      ...installStatus(target, port),
    };
  });
}

/**
 * `--config-dir <dir>` (or `--config-dir=<dir>`) off a CLI's argv: `{configDir}` — the
 * default dir when the flag is absent — or `{error}`. A leading `~` is the home directory
 * and a relative path is the shell's cwd, because whoever typed it meant a folder on this
 * machine; only the endpoint is refused paths, and it never comes through here.
 */
export function configDirArg(argv, { cwd = process.cwd(), home = path.dirname(DEFAULT_CONFIG_DIR) } = {}) {
  let value;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config-dir') {
      value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: '--config-dir needs a folder after it.' };
    } else if (a.startsWith('--config-dir=')) {
      value = a.slice('--config-dir='.length);
    }
  }
  if (value === undefined) return { configDir: DEFAULT_CONFIG_DIR };
  if (!value.trim()) return { error: '--config-dir needs a folder after it.' };
  let dir = value;
  if (dir === '~') dir = home;
  else if (dir.startsWith('~/')) dir = path.join(home, dir.slice(2));
  return { configDir: path.resolve(cwd, dir) };
}

/** Is this module the process's entry point? The guard both installers end on. */
export function invokedDirectly(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(metaUrl);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

/**
 * The Install endpoint's whole input check, here so it is tested without a server: `:key`
 * must be the decimal index of a dir in `dirs` (the `KnownConfigDirs` list), and the body
 * must be empty. **No path is ever accepted** — not as the key (`%2F`-encoded or not), not
 * in the body — because the panel is LAN-reachable with no authentication, and a request
 * naming a folder would get a settings file written wherever it said.
 * `{ok: true, dir}` or `{ok: false, status, error}`.
 */
export function resolveInstallKey(key, body, dirs) {
  if (body && typeof body === 'object' && Object.keys(body).length) {
    return {
      ok: false,
      status: 400,
      error: 'This takes no body. The folder is chosen by its number in the panel’s own list of config folders, never by a path.',
    };
  }
  if (typeof key !== 'string' || !/^(0|[1-9][0-9]{0,3})$/.test(key)) {
    return { ok: false, status: 400, error: 'The key is the number of a config folder in the panel’s own list, never a path.' };
  }
  const dir = dirs[Number(key)];
  if (!dir) return { ok: false, status: 404, error: `No config folder ${key} — the panel knows ${dirs.length}.` };
  return { ok: true, dir };
}
