#!/usr/bin/env node
/**
 * Wraps (or unwraps) the `statusLine` command in ~/.claude/settings.json, so the panel
 * gets a copy of the JSON Claude Code already hands it and the terminal line is unchanged.
 *
 * The reasoning about *what* to write is next door in `server/statusline.js`, which is
 * pure and has no imports at all. This file is argument parsing, file I/O and printing,
 * and that is the whole of the split.
 *
 * **It does not install anything at import.** `install-hook.js` calls `install()` at
 * module scope with no guard — which is why `bin/foreman-panel.js` has to spawn it, and
 * why it has no test. Copy that shape here and the first `node --test` run would rewrite
 * the maintainer's real `~/.claude/settings.json`. The `invokedDirectly()` guard at the
 * bottom is the same one `install-agent.js` grew for the same reason.
 *
 * **The hooks block is not touched.** Same file, different feature: the settings object is
 * copied with `statusLine` replaced and everything else — `hooks` above all — carried
 * through untouched. A whole-object rewrite that dropped a hook would be invisible until
 * a session stopped binding.
 *
 * **The backup goes beside `settings.json`**, as `settings.backup-foreman-<ms>.json`,
 * which is where `install-hook.js` already puts one. Not the state dir. One habit, one
 * place to look, and a person hunting for what they had before does not need to be told
 * which of two directories this particular installer chose.
 *
 * Order matters on both paths. Installing writes the wrapper and the sidecar **first**,
 * then points `settings.json` at them: a settings file naming a script that does not exist
 * yet is a broken status line for however long the gap is. Removing goes the other way —
 * settings first, then delete the files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SETTINGS_PATH, STATE_DIR, PORT } from './config.js';
import {
  SIDECAR_FILENAME,
  WRAPPER_FILENAME,
  planInstall,
  planRemove,
} from './statusline.js';

const WRAPPER_PATH = path.join(STATE_DIR, WRAPPER_FILENAME);
const SIDECAR_PATH = path.join(STATE_DIR, SIDECAR_FILENAME);

/**
 * The settings file, or the fact that it could not be read.
 *
 * Absent is `{}` — the ordinary first-run case. Present-but-unparseable is `null`, which
 * both planners refuse on, rather than a `{}` that would merge into nothing and write a
 * two-key file over somebody's typo.
 */
function loadSettings() {
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error(`Could not read ${SETTINGS_PATH} (${err.code}).`);
    process.exit(1);
  }
  try {
    const parsed = JSON.parse(raw);
    // A settings file that parses to an array or a string is not a settings file, and the
    // planners say so by name rather than spreading it into an object.
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function loadSidecar() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SIDECAR_PATH, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Missing, or nonsense. Both mean "no record", and both are handled by the planners —
    // loudly, because the original is only recoverable from the timestamped backups.
    return null;
  }
}

function backup() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  const dest = path.join(
    path.dirname(SETTINGS_PATH),
    `settings.backup-foreman-${Date.now()}.json`,
  );
  fs.copyFileSync(SETTINGS_PATH, dest);
  return dest;
}

function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Print a plan's `notes` and `warnings`. Warnings are the ones somebody has to read. */
function say(plan) {
  for (const note of plan.notes) console.log(`  ${note}`);
  for (const warning of plan.warnings) console.warn(`\n!  ${warning}`);
}

function refused(plan) {
  console.error(`Refused (${plan.code}): ${plan.message}`);
  process.exit(1);
}

function install() {
  const plan = planInstall({
    settings: loadSettings(),
    sidecar: loadSidecar(),
    wrapperPath: WRAPPER_PATH,
    port: PORT,
  });
  if (!plan.ok) refused(plan);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  // The script and its record before the settings that name them, so there is never a
  // moment where `statusLine.command` points at a file that is not there.
  fs.writeFileSync(WRAPPER_PATH, plan.script, { mode: 0o755 });
  // `writeFileSync`'s mode is ignored for a file that already exists, so say it again.
  fs.chmodSync(WRAPPER_PATH, 0o755);
  fs.writeFileSync(SIDECAR_PATH, `${JSON.stringify(plan.sidecar, null, 2)}\n`);

  let bak = null;
  if (plan.changed) {
    bak = backup();
    save(plan.settings);
    console.log('Wrapped the status line.');
  } else {
    console.log('Status line already wrapped — regenerated the wrapper, settings.json unchanged.');
  }
  console.log(`  wrapper: ${WRAPPER_PATH}`);
  console.log(`  record:  ${SIDECAR_PATH}`);
  say(plan);
  if (bak) console.log(`  backup:  ${bak}`);
  console.log('\nThe terminal line is unchanged. Running sessions pick this up at their next render.');
}

function remove() {
  const plan = planRemove({
    settings: loadSettings(),
    sidecar: loadSidecar(),
    wrapperPath: WRAPPER_PATH,
  });
  if (!plan.ok) refused(plan);

  let bak = null;
  if (plan.changed) {
    bak = backup();
    save(plan.settings);
    console.log('Unwrapped the status line.');
  } else {
    console.log('Nothing to unwrap in settings.json.');
  }
  say(plan);

  // Settings first, then the files — the opposite order to install, for the same reason.
  for (const file of [WRAPPER_PATH, SIDECAR_PATH]) {
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    console.log(`  removed: ${file}`);
  }
  if (bak) console.log(`  backup:  ${bak}`);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return path.resolve(entry) === self;
  }
}

if (invokedDirectly()) {
  process.argv.includes('--remove') ? remove() : install();
}
