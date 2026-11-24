/**
 * The Foreman hook entry: what it says, how it is recognised, and what an install or a
 * removal would do to a settings object. **Pure** — no `fs`, no `process`, no imports —
 * so the settings box can ask "is the hook installed in this config dir?" and a test can
 * plan an install without anything being written.
 *
 * This is the split `statusline.js` / `install-statusline.js` already made. It came late
 * here: `install-hook.js` used to call `install()` at module scope with no guard, so the
 * only safe way to run it was as a child process, and the only safe way to test it was a
 * subprocess pointed at a throwaway `HOME`. An endpoint that installs into another account's
 * config dir has to *call* it, and importing the old file would have rewritten the default
 * account's `settings.json` as a side effect of being loaded.
 *
 * The rules themselves are unchanged and are `install-hook.js`'s header: append beside
 * whatever else is registered, recognise our own entry by the shape it writes (a curl at
 * this panel's own `:<port>/hook`) and never by a byte match, replace an older spelling of
 * ours rather than leave it to rot, and leave every other hook strictly alone.
 */

/** Our endpoint path, used to recognise our own entry. */
export const MARKER = '/hook';

export const HOOK_EVENTS = [
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
 *
 * **The same command for every config dir.** Which account a hook came from is not said by
 * any header: the payload's own `transcript_path` sits under that account's
 * `<dir>/projects/`, MEASURED on v2.1.331 and pinned in `test/fixtures/payload-*.json`.
 */
export function hookCommand(port) {
  return (
    `curl -s -m 2 -X POST http://127.0.0.1:${port}/hook ` +
    `-H "Content-Type: application/json" -H "X-Tmux-Pane: $TMUX_PANE" ` +
    '-H "X-Tmux-Socket: ${TMUX%%,*}" ' +
    `--data-binary @- >/dev/null 2>&1 || true`
  );
}

/** The entry this installer writes, freshly built so nothing can share a nested object. */
export const hookEntry = (port) => ({
  matcher: '',
  hooks: [{ type: 'command', command: hookCommand(port), timeout: 5 }],
});

/** Ours by the shape we write — a curl at this panel's own `:<port>/hook` — never by a
 *  byte match on the command, which changes whenever the command is fixed. */
export const isOurHook = (e, port) =>
  Array.isArray(e?.hooks) &&
  e.hooks.some((h) => typeof h.command === 'string' && h.command.includes(`:${port}${MARKER}`));

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What an install does to `settings` (never mutated): `{settings, added, updated}`, where
 * `added + updated === 0` means the file is already right and must not be written.
 */
export function planHookInstall(settings, port) {
  const next = structuredClone(settings);
  next.hooks ||= {};
  let added = 0;
  let updated = 0;

  for (const event of HOOK_EVENTS) {
    next.hooks[event] ||= [];
    const list = next.hooks[event];
    const mine = list.filter((e) => isOurHook(e, port));
    const others = list.filter((e) => !isOurHook(e, port));
    const want = hookEntry(port);

    // Exactly one of ours, already spelled the way we spell it now: leave the file alone.
    // Anything else — none, an older command, or two of ours from some past state — is
    // replaced by one current entry, appended after whatever else is registered.
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(want)) continue;
    next.hooks[event] = [...others, want];
    if (mine.length) updated += 1;
    else added += 1;
  }
  return { settings: next, added, updated };
}

/** What a removal does: `{settings, removed, hadHooks}`. */
export function planHookRemove(settings, port) {
  const next = structuredClone(settings);
  if (!next.hooks) return { settings: next, removed: 0, hadHooks: false };
  let removed = 0;
  for (const event of Object.keys(next.hooks)) {
    const before = next.hooks[event].length;
    next.hooks[event] = next.hooks[event].filter((e) => !isOurHook(e, port));
    removed += before - next.hooks[event].length;
    if (!next.hooks[event].length) delete next.hooks[event];
  }
  return { settings: next, removed, hadHooks: true };
}

/**
 * Is the hook in this settings object, for the settings box: `installed` (every event has
 * exactly our current entry), `outdated` (ours somewhere, but an install would still change
 * the file), `missing` (none of ours anywhere) or `unreadable` (`null` — a file that did not
 * parse). Decided by the planner itself, so "installed" can never disagree with what the
 * Install button would then do.
 */
export function hookState(settings, port) {
  if (!isPlainObject(settings)) return 'unreadable';
  const plan = planHookInstall(settings, port);
  if (!plan.added && !plan.updated) return 'installed';
  const hooks = isPlainObject(settings.hooks) ? settings.hooks : {};
  const any = Object.values(hooks).some((list) => Array.isArray(list) && list.some((e) => isOurHook(e, port)));
  return any ? 'outdated' : 'missing';
}
