#!/usr/bin/env node
/**
 * Registers (or removes) the Foreman hook in a Claude config dir's `settings.json` —
 * `~/.claude/settings.json` by default, or `<dir>/settings.json` with `--config-dir <dir>`,
 * for a second account run through `CLAUDE_CONFIG_DIR`, which never reads the default file.
 *
 * Appends alongside whatever is already there — Claude Code runs every matching
 * entry, so existing consumers keep working untouched.
 *
 * **It also updates an entry it wrote before.** It used to skip any event that already
 * had one of ours, which read as politeness and was actually a wall: a fix to the command
 * — the `Content-Type` header, and now the tmux socket — reached nobody until somebody
 * deleted the entry by hand, and nothing on screen said so. An entry is recognised as
 * ours by the **shape it writes** (a curl at this panel's own `:<port>/hook`), never by a
 * byte-for-byte match, or a version of the command we have since changed would read as
 * somebody else's hook and be left to rot beside the new one. A hook pointing anywhere
 * else is still left strictly alone, and every write is preceded by a backup — so a
 * deliberate hand-edit of *our* entry is replaced rather than preserved, and recoverable
 * from the timestamped copy.
 *
 * **It installs nothing at import.** This file used to call `install()` at module scope
 * with no guard, so the only safe way to run it was as a child and it could not be
 * imported by anything — a test or an endpoint that loaded it would have rewritten the
 * maintainer's real settings as a side effect. What the entry is and what an install does
 * to a settings object now live in `hook-settings.js` (pure); the per-dir files in
 * `account-install.js`; this is argv, I/O and printing, behind `invokedDirectly()`.
 *
 * **The backup goes beside the `settings.json` it writes**, as
 * `settings.backup-foreman-<ms>.json` — not the state dir. `install-statusline.js` puts its
 * own backup of the same file in the same place: one habit, one place to look. (The plist
 * backups in `install-agent.js` go to the state dir for a reason that does not apply here —
 * a second plist in `~/Library/LaunchAgents` carrying the same `Label` is a duplicate job
 * waiting for the next login. A second *settings*-shaped file in a config dir is read by
 * nothing: Claude Code reads `settings.json` and `settings.local.json` and no other name.)
 */
import fs from 'node:fs';

import { PORT } from './config.js';
import { planHookInstall, planHookRemove } from './hook-settings.js';
import { backupSettings, configDirArg, installTarget, invokedDirectly, writeSettings } from './account-install.js';

function load(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Install into one config dir's settings file. Returns `{added, updated, backup}` and
 * prints what it did, in the words it always printed.
 */
export function installHook({ settingsPath, port = PORT, log = console.log } = {}) {
  const { settings, added, updated } = planHookInstall(load(settingsPath), port);
  if (!added && !updated) {
    log('Hook already registered and up to date for all events — nothing to do.');
    return { added, updated, backup: null };
  }
  const bak = backupSettings(settingsPath);
  writeSettings(settingsPath, settings);
  if (added) log(`Registered Foreman hook on ${added} event(s).`);
  if (updated) log(`Updated an existing Foreman hook on ${updated} event(s).`);
  if (bak) log(`Backup: ${bak}`);
  // VERIFIED, and it is what makes the server's fail-open window short rather than
  // permanent: Claude Code re-reads its hook config while running, so a session that is
  // already open picks this up the next time it is spoken to.
  log('\nRunning sessions bind themselves on their next tool call. No restart needed.');
  return { added, updated, backup: bak };
}

export function removeHook({ settingsPath, port = PORT, log = console.log } = {}) {
  const { settings, removed, hadHooks } = planHookRemove(load(settingsPath), port);
  if (!hadHooks) {
    log('No hooks configured — nothing to remove.');
    return { removed: 0, backup: null };
  }
  if (!removed) {
    log('Foreman hook not found — nothing to remove.');
    return { removed: 0, backup: null };
  }
  const bak = backupSettings(settingsPath);
  writeSettings(settingsPath, settings);
  log(`Removed ${removed} hook entr${removed === 1 ? 'y' : 'ies'}.`);
  if (bak) log(`Backup: ${bak}`);
  return { removed, backup: bak };
}

if (invokedDirectly(import.meta.url)) {
  const arg = configDirArg(process.argv.slice(2));
  if (arg.error) {
    console.error(arg.error);
    process.exit(2);
  }
  const target = installTarget(arg.configDir);
  if (!target.isDefault) console.log(`Config dir: ${target.configDir}`);
  const settingsPath = target.settingsPath;
  process.argv.includes('--remove') ? removeHook({ settingsPath }) : installHook({ settingsPath });
}
