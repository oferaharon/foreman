#!/usr/bin/env node
/**
 * Registers (or removes) the Foreman hook in ~/.claude/settings.json.
 *
 * Appends alongside whatever is already there — Claude Code runs every matching
 * entry, so existing consumers keep working untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SETTINGS_PATH, PORT } from './config.js';

const MARKER = '/hook'; // our endpoint path, used to recognise our own entry
const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'Notification',
  'PermissionRequest',
];

// `--data-binary @-` without a Content-Type is labelled form-urlencoded by curl, which is
// how every hook this panel was ever sent came to be dropped by the JSON parser. The
// server no longer cares, but say what we mean here too — a hook already written into
// settings.json is never revisited, so this line only helps the next install.
const COMMAND =
  `curl -s -m 2 -X POST http://127.0.0.1:${PORT}/hook ` +
  `-H "Content-Type: application/json" -H "X-Tmux-Pane: $TMUX_PANE" ` +
  `--data-binary @- >/dev/null 2>&1 || true`;

const isOurs = (entry) =>
  Array.isArray(entry?.hooks) &&
  entry.hooks.some((h) => typeof h.command === 'string' && h.command.includes(`:${PORT}${MARKER}`));

function load() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
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
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function install() {
  const settings = load();
  settings.hooks ||= {};
  let added = 0;

  for (const event of EVENTS) {
    settings.hooks[event] ||= [];
    if (settings.hooks[event].some(isOurs)) continue;
    settings.hooks[event].push({
      matcher: '',
      hooks: [{ type: 'command', command: COMMAND, timeout: 5 }],
    });
    added += 1;
  }

  if (!added) {
    console.log('Hook already registered for all events — nothing to do.');
    return;
  }
  const bak = backup();
  save(settings);
  console.log(`Registered Foreman hook on ${added} event(s).`);
  if (bak) console.log(`Backup: ${bak}`);
  console.log('\nRunning sessions bind themselves on their next tool call. No restart needed.');
}

function remove() {
  const settings = load();
  if (!settings.hooks) {
    console.log('No hooks configured — nothing to remove.');
    return;
  }
  let removed = 0;
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter((e) => !isOurs(e));
    removed += before - settings.hooks[event].length;
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (!removed) {
    console.log('Foreman hook not found — nothing to remove.');
    return;
  }
  const bak = backup();
  save(settings);
  console.log(`Removed ${removed} hook entr${removed === 1 ? 'y' : 'ies'}.`);
  if (bak) console.log(`Backup: ${bak}`);
}

process.argv.includes('--remove') ? remove() : install();
