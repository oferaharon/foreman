#!/usr/bin/env node
/**
 * Registers (or removes) the Foreman hook in ~/.claude/settings.json.
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

/*
 * `--data-binary @-` without a Content-Type is labelled form-urlencoded by curl, which is
 * how every hook this panel was ever sent came to be dropped by the JSON parser. The
 * server no longer cares, but say what we mean here too.
 *
 * **`X-Tmux-Socket` is what makes `X-Tmux-Pane` mean anything.** A pane id is relative to
 * one tmux server and every server numbers from `%0`, so a session on a second server — a
 * bench's scratch one — posts `%0` and `%1` for panes that belong to somebody else here.
 * Inside tmux `$TMUX` is `<socket path>,<server pid>,<session id>`; `${TMUX%%,*}` is the
 * socket path, a POSIX parameter expansion (verified in sh, bash and zsh) so it needs no
 * `jq`, no `cut` and no subshell. Outside tmux it expands to nothing, and an empty header
 * is read as "not told", which the server accepts — see `foreignTmuxServer` in `status.js`.
 *
 * It is a header rather than a body key because the body is Claude Code's own JSON on
 * stdin: curl cannot add a field to it without a JSON tool this command has no business
 * depending on, and `X-Tmux-Pane` already travels this way.
 */
const COMMAND =
  `curl -s -m 2 -X POST http://127.0.0.1:${PORT}/hook ` +
  `-H "Content-Type: application/json" -H "X-Tmux-Pane: $TMUX_PANE" ` +
  '-H "X-Tmux-Socket: ${TMUX%%,*}" ' +
  `--data-binary @- >/dev/null 2>&1 || true`;

/** The entry this installer writes, freshly built so nothing can share a nested object. */
const entry = () => ({
  matcher: '',
  hooks: [{ type: 'command', command: COMMAND, timeout: 5 }],
});

/** Ours by the shape we write — a curl at this panel's own `:<port>/hook` — never by a
 *  byte match on the command, which changes whenever the command is fixed. */
const isOurs = (e) =>
  Array.isArray(e?.hooks) &&
  e.hooks.some((h) => typeof h.command === 'string' && h.command.includes(`:${PORT}${MARKER}`));

function load() {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

/**
 * Copy `settings.json` aside before writing it, and answer where it went.
 *
 * **Beside the original, as `settings.backup-foreman-<ms>.json`** — not the state dir.
 * `install-statusline.js` writes its own backup of this same file to this same place and
 * its header says why: one habit, one place to look, and somebody hunting for what they
 * had before should not have to know which of two installers touched it last. (The plist
 * backups in `install-agent.js` go to the state dir for a reason that does not apply here
 * — a second plist in `~/Library/LaunchAgents` carrying the same `Label` is a duplicate
 * job waiting for the next login. A second *settings*-shaped file in `~/.claude/` is read
 * by nothing: Claude Code reads `settings.json` and `settings.local.json` and no other
 * name in that directory.)
 */
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
  // `~/.claude` may not exist yet on a machine that has never had a settings file.
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function install() {
  const settings = load();
  settings.hooks ||= {};
  let added = 0;
  let updated = 0;

  for (const event of EVENTS) {
    settings.hooks[event] ||= [];
    const list = settings.hooks[event];
    const mine = list.filter(isOurs);
    const others = list.filter((e) => !isOurs(e));
    const want = entry();

    // Exactly one of ours, already spelled the way we spell it now: leave the file alone.
    // Anything else — none, an older command, or two of ours from some past state — is
    // replaced by one current entry, appended after whatever else is registered.
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(want)) continue;
    settings.hooks[event] = [...others, want];
    if (mine.length) updated += 1;
    else added += 1;
  }

  if (!added && !updated) {
    console.log('Hook already registered and up to date for all events — nothing to do.');
    return;
  }
  const bak = backup();
  save(settings);
  if (added) console.log(`Registered Foreman hook on ${added} event(s).`);
  if (updated) console.log(`Updated an existing Foreman hook on ${updated} event(s).`);
  if (bak) console.log(`Backup: ${bak}`);
  // VERIFIED, and it is what makes the server's fail-open window short rather than
  // permanent: Claude Code re-reads its hook config while running, so a session that is
  // already open picks this up the next time it is spoken to.
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
