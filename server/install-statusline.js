#!/usr/bin/env node
/**
 * Wraps (or unwraps) the `statusLine` command in ~/.claude/settings.json — or, with
 * `--config-dir <dir>`, in `<dir>/settings.json` for a second account — so the panel gets
 * a copy of the JSON Claude Code already hands it and the terminal line is unchanged.
 *
 * **One wrapper per settings file.** The default dir's are `statusline-wrapper.sh` and
 * `statusline.json` under the state dir, as they always were; any other dir's carry its
 * folder name (`statusline-wrapper-<folder>.sh`, `statusline-<folder>.json`), each
 * recording what *that* file held. A dir with no status line of its own runs the default
 * account's command, read from the default's record, so both terminals look alike — and
 * `--remove` there takes the key away rather than writing the borrowed command in.
 *
 * The reasoning about *what* to write is next door in `server/statusline.js`, which is
 * pure and has no imports at all. This file is argument parsing, file I/O and printing,
 * and that is the whole of the split.
 *
 * **It does not install anything at import.** `install-hook.js` used to call `install()`
 * at module scope with no guard — so it could only ever be spawned, never imported — and
 * copying that shape here would have had the first `node --test` run rewrite the
 * maintainer's real `~/.claude/settings.json`. The `invokedDirectly()` guard at the bottom
 * is the one `install-agent.js` grew for the same reason, and `install-hook.js` has it too
 * now.
 *
 * **The hooks block is not touched.** Same file, different feature: the settings object is
 * copied with `statusLine` replaced and everything else — `hooks` above all — carried
 * through untouched. A whole-object rewrite that dropped a hook would be invisible until
 * a session stopped binding.
 *
 * **The backup goes beside the `settings.json` it writes**, as `settings.backup-foreman-<ms>.json`,
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

import { PORT } from './config.js';
import { planInstall, planRemove } from './statusline.js';
import {
  backupSettings,
  borrowedStatusLine,
  configDirArg,
  installTarget,
  invokedDirectly,
  readJsonObject,
  readSettings,
  writeSettings,
} from './account-install.js';

/**
 * The settings file, or the fact that it could not be read.
 *
 * Absent is `{}` — the ordinary first-run case. Present-but-unparseable is `null`, which
 * both planners refuse on, rather than a `{}` that would merge into nothing and write a
 * two-key file over somebody's typo.
 */
function loadSettings(file) {
  try {
    return readSettings(file).settings;
  } catch (err) {
    console.error(`Could not read ${file} (${err.code}).`);
    process.exit(1);
  }
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

function install(target) {
  const plan = planInstall({
    settings: loadSettings(target.settingsPath),
    // Missing, or nonsense. Both mean "no record", and both are handled by the planners —
    // loudly, because the original is only recoverable from the timestamped backups.
    sidecar: readJsonObject(target.sidecarPath),
    wrapperPath: target.wrapperPath,
    port: PORT,
    // Only a non-default dir passes these; the default's plan is byte-identical without.
    target: target.isDefault ? null : target,
    borrowed: borrowedStatusLine(target),
  });
  if (!plan.ok) refused(plan);

  fs.mkdirSync(target.stateDir, { recursive: true });
  // The script and its record before the settings that name them, so there is never a
  // moment where `statusLine.command` points at a file that is not there.
  fs.writeFileSync(target.wrapperPath, plan.script, { mode: 0o755 });
  // `writeFileSync`'s mode is ignored for a file that already exists, so say it again.
  fs.chmodSync(target.wrapperPath, 0o755);
  fs.writeFileSync(target.sidecarPath, `${JSON.stringify(plan.sidecar, null, 2)}\n`);

  let bak = null;
  if (plan.changed) {
    bak = backupSettings(target.settingsPath);
    writeSettings(target.settingsPath, plan.settings);
    console.log('Wrapped the status line.');
  } else {
    console.log('Status line already wrapped — regenerated the wrapper, settings.json unchanged.');
  }
  console.log(`  wrapper: ${target.wrapperPath}`);
  console.log(`  record:  ${target.sidecarPath}`);
  say(plan);
  if (bak) console.log(`  backup:  ${bak}`);
  console.log('\nThe terminal line is unchanged. Running sessions pick this up at their next render.');
}

function remove(target) {
  const plan = planRemove({
    settings: loadSettings(target.settingsPath),
    sidecar: readJsonObject(target.sidecarPath),
    wrapperPath: target.wrapperPath,
  });
  if (!plan.ok) refused(plan);

  let bak = null;
  if (plan.changed) {
    bak = backupSettings(target.settingsPath);
    writeSettings(target.settingsPath, plan.settings);
    console.log('Unwrapped the status line.');
  } else {
    console.log('Nothing to unwrap in settings.json.');
  }
  say(plan);

  // Settings first, then the files — the opposite order to install, for the same reason.
  for (const file of [target.wrapperPath, target.sidecarPath]) {
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    console.log(`  removed: ${file}`);
  }
  if (bak) console.log(`  backup:  ${bak}`);
}

if (invokedDirectly(import.meta.url)) {
  const arg = configDirArg(process.argv.slice(2));
  if (arg.error) {
    console.error(arg.error);
    process.exit(2);
  }
  const target = installTarget(arg.configDir);
  if (!target.isDefault) console.log(`Config dir: ${target.configDir}`);
  process.argv.includes('--remove') ? remove(target) : install(target);
}
