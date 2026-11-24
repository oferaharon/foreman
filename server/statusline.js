/**
 * The status-line wrapper: what it says, and what wrapping it costs.
 *
 * Claude Code hands its configured `statusLine` command a blob of JSON on stdin every
 * time it redraws the little line under the prompt, and in that blob are the two
 * rate-limit percentages. Nothing has to be asked of anyone: the number is already
 * arriving on this machine and being thrown away. So the installer wraps whatever command
 * is already configured in a small script that keeps a copy for the panel and then runs
 * the original, unchanged.
 *
 * **Everything here is pure.** No `fs`, no `process`, no imports at all —
 * `install-statusline.js` is the shell that reads files, writes them and prints, and
 * `account-install.js` decides which files those are for a given config dir. That split is
 * not tidiness: `install-hook.js` used to call `install()` at module scope with no guard,
 * so nothing could import it — and a test file, or the settings box's Install endpoint,
 * that imported this one must not rewrite anybody's `settings.json` as a side effect of
 * being loaded. `hook-settings.js` is the hook's half of the same split.
 *
 * ## Five things measured before any of this was written
 *
 * **stdin is a pipe and is readable once.** The existing script on this Mac opens with
 * `input=$(cat)`. A wrapper that piped stdin to the original *and* to curl without
 * capturing first starves one of them, non-deterministically. `payload=$(cat)` once, then
 * `printf '%s'` into each.
 *
 * **The POST must be forked and must not hold the line open.** `( … & )` with both
 * descriptors closed. A bare `&` leaves curl attached to the wrapper's stdout and stderr,
 * and a status line that waits on a socket is a status line that stutters.
 *
 * **The whole payload goes, never a filtered subset.** It is ~1.8 KB, measured. Filtering
 * it down to `rate_limits` with `jq` would save nothing and would close the door on every
 * other number in it (context window, cache warmth, effort, lines added and removed),
 * each of which would then need a second install step on somebody's machine.
 *
 * **`$TMUX_PANE` is in the status line command's environment** — measured `%178`, beside
 * `TMUX` and `TERM=tmux-256color`. One header, and the pane↔payload join is free. The
 * same header `install-hook.js` already sends, for the same reason.
 *
 * **The percentages are not promised to be integers.** Measured `55.00000000000001` on
 * one render and `5` on another in the same payload. Nothing here reads them — that is
 * the store's job — but it is why the wrapper posts the body untouched rather than
 * pre-formatting anything.
 *
 * ## Why the wrapper is a file rather than an inline command
 *
 * The thing being wrapped is an arbitrary shell command that lives inside a JSON string.
 * Quoting it back *into* another JSON string, to be run by another shell, is where this
 * breaks — and it breaks on somebody else's command, not on the one it was written
 * against. A file takes the original as a plain line of bash, which is exactly what
 * Claude Code was already going to run it as. It also gives the installer somewhere to
 * regenerate from, which is what makes a second run idempotent instead of a wrapper
 * wrapping a wrapper.
 */

/** The generated script, under `STATE_DIR`. Joined with the state dir by the caller —
 *  nothing in this file knows where that is, which is what keeps it pure. */
export const WRAPPER_FILENAME = 'statusline-wrapper.sh';

/** The record of what was replaced, beside it. */
export const SIDECAR_FILENAME = 'statusline.json';

/*
 * **One wrapper and one sidecar per settings file.** A second Claude account
 * (`CLAUDE_CONFIG_DIR`) reads its own `settings.json` and never the default one (MEASURED,
 * v2.1.331), so each config dir is wrapped on its own, with its own record of what *its*
 * file held. The default dir keeps the two names above, unsuffixed, so a rollback past this
 * build still finds its files; every other dir gets `statusline-wrapper-<folder>.sh` and
 * `statusline-<folder>.json`, `<folder>` being `configDirSuffix` of its path.
 */

/**
 * The suffix a non-default config dir's files carry: its folder name, leading dots dropped
 * and anything outside `[A-Za-z0-9_-]` turned into `-` — `~/.claude-work` → `claude-work`.
 * The dot rule is load-bearing rather than cosmetic: with dots kept, folder `x` and folder
 * `x.sh` would name `statusline-wrapper-x.sh` and `statusline-wrapper-x.sh.sh`, and the
 * first is a substring of the second, which is exactly the match `isOurs` makes. Two dirs
 * that still spell the same suffix are told apart by the sidecar, which records whose it is
 * (`configDir`), and the installer refuses rather than share one.
 *
 * Pure string work, no `path`: this module has no imports.
 */
export function configDirSuffix(configDir) {
  const base = String(configDir || '').replace(/\/+$/, '').split('/').pop() || '';
  const clean = base.replace(/^\.+/, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '');
  return clean || 'config';
}

/** The wrapper's file name for a suffix, or the default's for none. */
export function wrapperFilenameFor(suffix = null) {
  return suffix ? `statusline-wrapper-${suffix}.sh` : WRAPPER_FILENAME;
}

/** The sidecar's file name for a suffix, or the default's for none. */
export function sidecarFilenameFor(suffix = null) {
  return suffix ? `statusline-${suffix}.json` : SIDECAR_FILENAME;
}

/**
 * The generated script's format version, recorded in the sidecar.
 *
 * Not the panel's version. This is the number a future installer would read to know what
 * shape of file it is looking at — the sidecar exists to regenerate from, and a
 * regeneration that assumed today's layout of a file written by a much older build is the
 * kind of thing that fails quietly.
 */
export const WRAPPER_VERSION = 1;

/**
 * What `refreshInterval` is set to when the key is absent, and never when it is present.
 *
 * The status line is **event-driven by default** — measured 2 renders in 5m43s and zero
 * across 90 seconds of idle — so without this the gauges move only when a session starts
 * or finishes a turn, and an idle bench shows a number that can be hours old.
 * `refreshInterval` re-runs the command on a tick as well, and those idle renders carry
 * live numbers (measured, 9 renders in 45 s at `refreshInterval: 5`, with the five-hour
 * figure moving 43 → 44 while nothing was typed).
 *
 * 60 rather than 5 because the thing being re-run is *the user's own script*, whatever it
 * is — the one on this Mac shells out to `git` twice per render at ~36 ms. Once a minute
 * per session is negligible; once every five seconds plainly is not.
 *
 * **Never overwrite a value that is already there.** A person who has set this has said
 * what they want, and an installer that "corrected" it would be undoing a decision to fix
 * a gauge. The sidecar records whether we added the key so the output can say so, and
 * `--remove` restores the whole object as it was found, which puts it back either way.
 */
export const DEFAULT_REFRESH_INTERVAL = 60;

/** Refusal codes. Each one is a thing we could have guessed at and deliberately do not. */
export const REFUSALS = {
  UNREADABLE_SETTINGS: 'UNREADABLE_SETTINGS',
  BAD_STATUS_LINE: 'BAD_STATUS_LINE',
  UNKNOWN_TYPE: 'UNKNOWN_TYPE',
  FOREIGN_WRAPPER: 'FOREIGN_WRAPPER',
  SIDECAR_CLASH: 'SIDECAR_CLASH',
};

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const refuse = (code, message) => ({ ok: false, code, message });

/**
 * Quote a path for a shell.
 *
 * The command written into `settings.json` is run through a shell, and a state directory
 * can contain a space — `$FOREMAN_STATE_DIR` pointed at a scratch tmpdir is the common
 * case, and `~/Library/Application Support` is the one that would bite a stranger. Single
 * quotes with the standard `'\''` escape, which is the only form that is correct for
 * every byte a POSIX path can hold.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Is this `statusLine.command` ours?
 *
 * Matched on the wrapper's own path, the same shape as `install-hook.js`'s `isOurs`
 * (which matches `:${PORT}/hook` inside its curl). Not on the file's contents, because
 * the question is asked about a string in `settings.json` with the file possibly deleted,
 * and not on the basename alone, because a basename match on a *different* install's
 * wrapper would have us regenerate from a sidecar that describes somebody else's original
 * — see `looksLikeAWrapper`, which is how that case is refused instead of guessed at.
 */
export function isOurs(command, wrapperPath) {
  if (typeof command !== 'string' || !wrapperPath) return false;
  // Both spellings, because what goes into `settings.json` is the *quoted* path and a
  // path holding a `'` comes out of `shellQuote` broken into pieces — a bare `includes`
  // of the raw path would then answer no about our own wrapper and wrap it again.
  return command.includes(wrapperPath) || command.includes(shellQuote(wrapperPath));
}

/**
 * Does this command point at *a* wrapper of this shape, but not at ours?
 *
 * The state directory is resolved at boot on four rungs (`config.js`), so it can honestly
 * differ between two runs on one machine — and the one thing the installer must never do
 * is wrap a wrapper, which nests the POST and the original one level deeper on every run.
 * Recognising the shape by basename and *refusing* is the right direction: the other
 * install's sidecar is the only thing that knows what the real original was.
 */
export function looksLikeAWrapper(command) {
  return wrapperNameIn(command) !== null;
}

/**
 * What a settings file's status line is, for the settings box: `wrapped` (this install's
 * wrapper), `foreign` (some other Foreman wrapper — another state dir's, or another config
 * dir's), `missing` (anything else, including no key) or `unreadable` (a file that did not
 * parse, which is `null` here as it is for the planners).
 */
export function statusLineState(settings, wrapperPath) {
  if (!isPlainObject(settings)) return 'unreadable';
  const current = settings.statusLine;
  if (!isPlainObject(current)) return 'missing';
  if (isOurs(current.command, wrapperPath)) return 'wrapped';
  if (looksLikeAWrapper(current.command)) return 'foreign';
  return 'missing';
}

/**
 * The wrapper file name a command points at — `statusline-wrapper.sh` or any per-dir
 * `statusline-wrapper-<folder>.sh` — or `null`. **Both forms, and that is the trap**: this
 * matched the unsuffixed name alone until a second config dir got its own wrapper, and a
 * check that cannot see the suffixed form lets one dir's settings be pointed at another
 * dir's wrapper and wrapped again, which nests the POST and the original one level deeper
 * — the exact failure this function exists to refuse.
 */
export function wrapperNameIn(command) {
  if (typeof command !== 'string') return null;
  const m = /(?:^|[\s'"/])(statusline-wrapper(?:-[A-Za-z0-9_-]+)?\.sh)(?=\s|['"]|$)/.exec(command);
  return m ? m[1] : null;
}

/**
 * The wrapper script, as text, from the sidecar's two load-bearing fields.
 *
 * A pure function of `{original, port}` on purpose — no timestamp, no version banner that
 * moves — so re-running the installer against an unchanged sidecar produces a
 * byte-identical file, and a diff of the generated script is a real signal rather than
 * noise.
 *
 * `original` is the whole previous `statusLine` object (or `null` when there was none);
 * only its `command` is used, and it is spliced in **verbatim as a line of bash**, which
 * is precisely what Claude Code was going to do with it.
 */
export function wrapperScript({ original = null, port, borrowed = null, target = null } = {}) {
  const own = isPlainObject(original) && typeof original.command === 'string'
    ? original.command.trim()
    : '';
  // A config dir with no status line of its own runs the default account's, so both
  // terminals look alike (the maintainer's ruling, Q1 (b) of the multi-account plan).
  const lent = !own && isPlainObject(borrowed) && typeof borrowed.command === 'string'
    ? borrowed.command.trim()
    : '';
  const command = own || lent;

  // The default dir's header is the one every earlier install wrote, byte for byte; a
  // per-dir wrapper names its own record, its own settings file and the flag that reaches it.
  const about = target
    ? [
      `# The panel's Install button (Settings → Account tags), or`,
      `# \`npm run install-statusline -- --config-dir ${target.configDir}\`, rewrites this file`,
      `# from <STATE_DIR>/${target.sidecarName}, and \`npm run uninstall-statusline -- --config-dir\``,
      `# with the same folder puts the original back into ${target.settingsPath}`,
      '# and deletes this file. Anything typed here is lost at the next install.',
    ]
    : [
      '# `npm run install-statusline` rewrites this file from <STATE_DIR>/statusline.json,',
      '# and `npm run uninstall-statusline` puts the original command back into',
      '# ~/.claude/settings.json and deletes this file. Anything typed here is lost at the',
      '# next install.',
    ];

  const head = [
    '#!/usr/bin/env bash',
    '#',
    '# Generated by Foreman — do not edit.',
    '#',
    ...about,
    '#',
    '# It hands the panel a copy of the JSON Claude Code already sends its status line and',
    '# changes nothing else: stdout, stderr and the exit code below are the original',
    "# command's.",
    '',
    `PORT=${Number(port)}`,
    '',
    '# stdin is a pipe and is readable once. The usual first line of a status-line script',
    '# is `input=$(cat)`, so a wrapper that piped stdin to both the POST and the original',
    '# would starve one of them at random. Capture once, print twice.',
    'payload=$(cat)',
    '',
    '# Forked, in a subshell, with both descriptors closed. A bare `&` leaves curl holding',
    "# the status line's stdout and stderr, and a status line that waits on a socket is a",
    '# status line that stutters. Every failure here is silent on purpose: the panel being',
    '# down must never show up in somebody\'s terminal.',
    `( printf '%s' "$payload" | curl -s -m 2 -X POST "http://127.0.0.1:$PORT/status" \\`,
    `    -H 'Content-Type: application/json' \\`,
    '    -H "X-Tmux-Pane: $TMUX_PANE" \\',
    '    --data-binary @- >/dev/null 2>&1 & ) >/dev/null 2>&1',
    '',
  ];

  const tail = own
    ? [
      '# The original command, verbatim, fed the payload it would have read from stdin.',
      '# `exit $?` is the pipeline\'s status, which is the original\'s.',
      `printf '%s' "$payload" | ${command}`,
      'exit $?',
      '',
    ]
    : command
    ? [
      '# This settings file had no status line of its own, so this runs the default',
      "# account's, as it was recorded when this was generated — so both accounts' terminals",
      '# draw the same line. Uninstalling takes the key away again; it never writes this',
      '# command into that settings file.',
      `printf '%s' "$payload" | ${command}`,
      'exit $?',
      '',
    ]
    : [
      '# There was no status line configured when this was generated, so there is nothing',
      '# to run and nothing to print. Claude Code still keeps a footer row for an empty',
      '# status line (measured) — `uninstall-statusline` takes the key away again.',
      'exit 0',
      '',
    ];

  return [...head, ...tail].join('\n');
}

/**
 * Validate a `statusLine` object we are about to wrap.
 *
 * Only `command` was found in 2.1.257 — in the binary's strings and in its own status-line
 * setup prompt — and a `type` this code has never met is a shape whose semantics are
 * unknown. Refusing by name costs a one-line change on the day another type ships;
 * guessing costs somebody their terminal line with no error to look for.
 */
function checkStatusLine(statusLine, where) {
  if (statusLine === undefined || statusLine === null) return null;
  if (!isPlainObject(statusLine)) {
    return refuse(
      REFUSALS.BAD_STATUS_LINE,
      `${where} is ${Array.isArray(statusLine) ? 'an array' : typeof statusLine}, not an object — refusing to guess what it means.`,
    );
  }
  if (statusLine.type !== undefined && statusLine.type !== 'command') {
    return refuse(
      REFUSALS.UNKNOWN_TYPE,
      `${where}.type is "${statusLine.type}". Only "command" is known to this installer ` +
      '(it is the only type in Claude Code 2.1.257), so wrapping it would be a guess. ' +
      'Nothing has been changed.',
    );
  }
  return null;
}

/**
 * What an install would do, decided from the two files and nothing else.
 *
 * `settings` is the parsed `~/.claude/settings.json` (`{}` when there is no file) or
 * `null` when it could not be parsed — the same refusal `writeConfigFile` makes for the
 * panel's own settings, and for the same reason: merging into a file you could not read
 * and writing it back replaces a file with a typo in it, recoverable in any editor, with
 * one this code invented.
 *
 * Returns `{ok: false, code, message}` for a refusal, or a plan:
 *
 *   `settings`   the object to write — a copy; the input is never mutated
 *   `sidecar`    the record to write beside the wrapper
 *   `script`     the wrapper's text
 *   `command`    what went into `statusLine.command`
 *   `changed`    whether `settings.json` needs writing at all
 *   `notes`      lines to print
 *   `warnings`   lines to print that somebody has to read
 *
 * Two inputs only a non-default config dir passes, and the default's plan is byte-identical
 * without them:
 *
 *   `target`     `{configDir, settingsPath, sidecarName}` — whose files these are. Recorded
 *                in the sidecar as `configDir`, and a sidecar that names another dir is
 *                refused rather than shared (two folders whose names clean up alike).
 *   `borrowed`   the default account's own `statusLine` object, for a file that has none:
 *                the wrapper runs it, the sidecar records it as `borrowed`, and `original`
 *                stays `null` — so `--remove` takes the key away rather than writing the
 *                main account's command into this file.
 */
export function planInstall({
  settings,
  sidecar = null,
  wrapperPath,
  port,
  now = Date.now(),
  refreshInterval = DEFAULT_REFRESH_INTERVAL,
  target = null,
  borrowed = null,
} = {}) {
  if (!isPlainObject(settings)) {
    return refuse(
      REFUSALS.UNREADABLE_SETTINGS,
      'settings.json could not be parsed. Refusing to write over a file this installer ' +
      'cannot read — a typo in it is recoverable in any editor, and a rewrite is not. ' +
      'Fix the JSON and run this again.',
    );
  }
  if (!wrapperPath) throw new Error('planInstall needs a wrapperPath');

  const notes = [];
  const warnings = [];
  const current = settings.statusLine;
  const alreadyWrapped = isPlainObject(current) && isOurs(current.command, wrapperPath);

  // A wrapper that is not ours — another install, under another state directory. Its
  // sidecar is the only record of the real original, so this is refused rather than
  // wrapped a second time.
  if (!alreadyWrapped && isPlainObject(current) && looksLikeAWrapper(current.command)) {
    const name = wrapperNameIn(current.command);
    return refuse(
      REFUSALS.FOREIGN_WRAPPER,
      `statusLine.command already points at a ${name} that is not this one ` +
      `(${current.command}). That is another Foreman install's wrapper, and only its own ` +
      'sidecar knows what the original command was. Run `uninstall-statusline` with that ' +
      'install\'s FOREMAN_STATE_DIR' +
      (name === WRAPPER_FILENAME ? '' : ' and the --config-dir it was installed for') +
      ' first. Nothing has been changed.',
    );
  }

  if (target && isPlainObject(sidecar) && typeof sidecar.configDir === 'string' &&
      sidecar.configDir !== target.configDir) {
    return refuse(
      REFUSALS.SIDECAR_CLASH,
      `${target.sidecarName} already records the status line of ${sidecar.configDir}, not ` +
      `${target.configDir}: two config folders whose names spell the same suffix. Refusing to ` +
      'share one record between them, because the other folder\'s original would be lost. ' +
      'Nothing has been changed.',
    );
  }

  // The default account's command, lent to a file with none of its own. Never another
  // wrapper — running one from here would post every render twice.
  let lend = null;
  if (isPlainObject(borrowed) && typeof borrowed.command === 'string' && borrowed.command.trim()) {
    if (looksLikeAWrapper(borrowed.command) || checkStatusLine(borrowed, 'the default status line')) {
      warnings.push(
        `The default account's status line (${borrowed.command}) is not a plain command this ` +
        'installer can run, so nothing is borrowed and this terminal line stays blank.',
      );
    } else {
      lend = structuredClone(borrowed);
    }
  }

  const bad = checkStatusLine(current, 'statusLine');
  if (bad) return bad;

  /** The object we are wrapping — from the sidecar when this is a regeneration, because
   *  by then `settings.statusLine` is our own wrapper and no longer says anything about
   *  what was there first. */
  let original;
  if (alreadyWrapped) {
    original = isPlainObject(sidecar) && isPlainObject(sidecar.original) ? sidecar.original : null;
    if (isPlainObject(sidecar) && sidecar.original === null) {
      notes.push('Already wrapped; regenerating. The sidecar records that there was no status line to wrap.');
    } else if (!original && lend) {
      warnings.push(
        `Already wrapped, but ${target?.sidecarName || SIDECAR_FILENAME} is missing or ` +
        'unreadable, so what this file held before is not known. Regenerating as though it ' +
        'held nothing, so the default account\'s line is run and `--remove` takes the key ' +
        'away. If it had one, it is in a timestamped `settings.backup-foreman-*.json` ' +
        'beside settings.json.',
      );
    } else if (!original) {
      warnings.push(
        `Already wrapped, but ${SIDECAR_FILENAME} is missing or unreadable — the original ` +
        'command cannot be recovered from it. Regenerating with nothing to wrap, so the ' +
        'terminal line will be blank from now on. The original is in one of the ' +
        'timestamped `settings.backup-foreman-*.json` files beside settings.json; put it ' +
        'back by hand and run this again.',
      );
    } else {
      notes.push('Already wrapped; regenerating from the sidecar rather than wrapping the wrapper.');
    }
    const staleOriginal = checkStatusLine(original, `${SIDECAR_FILENAME}'s original`);
    if (staleOriginal) return staleOriginal;
  } else {
    original = isPlainObject(current) ? structuredClone(current) : null;
    // With a loan there is something to run, and the note below says what.
    if (!original && !lend) {
      warnings.push(
        'There is no statusLine in settings.json, so there is nothing to wrap and the ' +
        'wrapper prints nothing. Claude Code keeps a footer row for an empty status line ' +
        '(measured), so expect a blank row under the prompt. `uninstall-statusline` ' +
        'removes the key again.',
      );
    }
  }

  // Every other key on the object survives — `padding`, `refreshInterval`, and whatever a
  // later Claude Code adds. Only `command` is ours to change.
  const base = isPlainObject(current) ? structuredClone(current) : {};
  const nextStatusLine = { ...base, type: 'command', command: shellQuote(wrapperPath) };

  const hadRefresh = Object.hasOwn(nextStatusLine, 'refreshInterval');
  if (!hadRefresh) {
    nextStatusLine.refreshInterval = refreshInterval;
    notes.push(
      `Set statusLine.refreshInterval to ${refreshInterval}. Without it the status line ` +
      'only runs when a session starts or finishes a turn (measured: 2 renders in 5m43s, ' +
      'none across 90s idle), so the gauges would sit still for hours. Your own script ' +
      'now also runs once a minute per session. A value you had already set is never ' +
      'touched, and `uninstall-statusline` puts the object back as it was found.',
    );
  } else {
    notes.push(`Left statusLine.refreshInterval at ${nextStatusLine.refreshInterval} — it was already set.`);
  }

  // Whether *this installer* is responsible for the key, carried across regenerations so
  // a second run does not forget what the first one did. Informational: `--remove`
  // restores the whole object as it was found, which puts the key back either way.
  const addedRefreshInterval = !hadRefresh
    || (alreadyWrapped && isPlainObject(sidecar) && sidecar.addedRefreshInterval === true);

  const next = { ...settings, statusLine: nextStatusLine };

  // Only when this file has nothing of its own does the loan apply.
  const borrowedNow = original ? null : lend;
  if (borrowedNow) {
    notes.push(
      `This settings file has no status line of its own, so the wrapper runs the default ` +
      `account's: ${borrowedNow.command}`,
    );
  }

  const record = {
    original,
    port: Number(port),
    wrappedAt: new Date(now).toISOString(),
    version: WRAPPER_VERSION,
    addedRefreshInterval,
  };
  // Keys only a per-dir install writes, so the default's sidecar stays the shape it was.
  if (target) {
    record.configDir = target.configDir;
    record.borrowed = borrowedNow;
  }

  return {
    ok: true,
    settings: next,
    sidecar: record,
    script: wrapperScript({ original, port, borrowed: borrowedNow, target }),
    borrowed: borrowedNow,
    command: nextStatusLine.command,
    original,
    addedRefreshInterval,
    changed: JSON.stringify(settings.statusLine) !== JSON.stringify(nextStatusLine),
    notes,
    warnings,
  };
}

/**
 * What `--remove` would do.
 *
 * The whole `statusLine` object is restored **as it was found**, from the sidecar, rather
 * than reconstructed key by key: the object is the unit that was replaced, so it is the
 * unit that goes back. That is also what puts `refreshInterval` back — removed if this
 * installer added it, restored to the user's own number if they had one.
 *
 * A `statusLine` that is not ours is left strictly alone. The files are still swept, and
 * the plan says so, because a leftover wrapper under `STATE_DIR` is confusing and harmless
 * in exactly the way an orphaned plist is not.
 */
export function planRemove({ settings, sidecar = null, wrapperPath } = {}) {
  if (!isPlainObject(settings)) {
    return refuse(
      REFUSALS.UNREADABLE_SETTINGS,
      'settings.json could not be parsed. Refusing to write over a file this installer ' +
      'cannot read. Fix the JSON and run this again.',
    );
  }
  if (!wrapperPath) throw new Error('planRemove needs a wrapperPath');

  const notes = [];
  const warnings = [];
  const current = settings.statusLine;
  const ours = isPlainObject(current) && isOurs(current.command, wrapperPath);

  if (!ours) {
    notes.push(
      current === undefined
        ? 'settings.json has no statusLine — nothing to restore.'
        : 'settings.json\'s statusLine is not this installer\'s wrapper — left exactly as it is.',
    );
    return { ok: true, settings, changed: false, restored: null, notes, warnings };
  }

  const next = { ...settings };
  const original = isPlainObject(sidecar) && isPlainObject(sidecar.original) ? sidecar.original : null;

  if (original) {
    next.statusLine = structuredClone(original);
    notes.push('Restored the original statusLine from the sidecar, exactly as it was recorded.');
    if (isPlainObject(sidecar) && sidecar.addedRefreshInterval === true) {
      notes.push(`The refreshInterval this installer added is gone with it.`);
    }
  } else {
    delete next.statusLine;
    if (isPlainObject(sidecar) && sidecar.original === null) {
      notes.push('There was no statusLine before the install, so the key is removed again.');
    } else {
      warnings.push(
        `${SIDECAR_FILENAME} is missing or unreadable, so there is no record of what was ` +
        'wrapped. Removing the statusLine key rather than inventing one. If you had a ' +
        'status line, it is in a timestamped `settings.backup-foreman-*.json` beside ' +
        'settings.json.',
      );
    }
  }

  return {
    ok: true,
    settings: next,
    changed: true,
    restored: original,
    notes,
    warnings,
  };
}
