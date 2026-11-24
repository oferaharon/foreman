/**
 * The words of the settings box's per-config-folder rows — "status hook: installed /
 * missing", "status line: wrapped / missing" — and of the Install confirm. Pure, so a test
 * pins the copy the maintainer reads before pressing a button that writes a settings file.
 *
 * A row is what `GET /api/accounts/install` answers for one known config dir
 * (`installRows`, `server/account-install.js`). The confirm has to say three things before
 * the press, each one a ruling or a measurement rather than politeness:
 *
 * - **what will be written**, and that the file is backed up beside itself first;
 * - **that running sessions on that account pick it up within seconds** — MEASURED (M7):
 *   a settings change reaches live sessions, which is the point and is why it is a press;
 * - **which status-line command the wrapper will run** — the dir's own, or, for a dir with
 *   none, the default account's (the maintainer's ruling, Q1 (b)), or nothing at all.
 */

const HOOK_WORDS = {
  installed: 'installed',
  outdated: 'out of date',
  missing: 'missing',
  unreadable: 'unreadable settings',
};

const LINE_WORDS = {
  wrapped: 'wrapped',
  missing: 'missing',
  foreign: 'another wrapper',
  unreadable: 'unreadable settings',
};

/** The row's two facts, its title, and whether — and why not — Install is offered. */
export function installRowView(row) {
  const hook = HOOK_WORDS[row.hook] || row.hook;
  const line = LINE_WORDS[row.statusLine] || row.statusLine;
  const done = row.hook === 'installed' && row.statusLine === 'wrapped';
  let blocked = null;
  if (row.hook === 'unreadable' || row.statusLine === 'unreadable') {
    blocked = `${row.settingsPath} does not parse, so nothing will write over it. Fix the JSON first.`;
  } else if (row.statusLine === 'foreign') {
    blocked = 'Its status line already runs another Foreman wrapper; uninstall that one first.';
  }
  return {
    title: row.isDefault ? `default · ${row.configDir}` : row.configDir,
    facts: [
      { text: `status hook: ${hook}`, ok: row.hook === 'installed' },
      { text: `status line: ${line}`, ok: row.statusLine === 'wrapped' },
    ],
    tone: done ? 'ok' : 'missing',
    offer: !done && !blocked,
    blocked,
    label: row.hook === 'outdated' && row.statusLine === 'wrapped' ? 'Update' : 'Install',
  };
}

/** What the status line will draw once wrapped, in one sentence. */
export function statusLineSays(row) {
  if (!row.runs) {
    return 'There is no status line to run here, so the terminal keeps a blank row under the prompt.';
  }
  if (row.runsBorrowed) {
    return `This folder has no status line of its own, so the wrapper runs the default account’s, so both terminals look alike: ${row.runs}`;
  }
  return `The terminal line stays its own: the wrapper runs ${row.runs}`;
}

/** The confirm's paragraphs, in order. */
export function installConfirmLines(row) {
  const lines = [
    `Writes the panel’s status hook and status-line wrapper into ${row.settingsPath}, after a backup beside it (settings.backup-foreman-<time>.json). Every other key in that file is left as it is.`,
    `The wrapper itself is ${row.wrapperPath}, with its record beside it.`,
    statusLineSays(row),
    row.isDefault
      ? 'Sessions on the default account pick this up within seconds — no restart.'
      : `Sessions already running on this account (${row.folder}) pick this up within seconds — no restart.`,
  ];
  if (!row.isDefault) {
    lines.push(
      'Its usage bars are its own: once its sessions post, a second pair appears in the rail head while it has sessions running, and the default account’s bars are never fed from it.',
    );
  }
  return lines;
}
