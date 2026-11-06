/**
 * Reading — and driving — the `/effort` slider.
 *
 * The fifth screen the panel drives, and the odd one out. It is not a numbered list at all
 * but a track with a marker on it. Claude Code v2.1.296 draws it like this:
 *
 *     Faster                             Smarter
 *     ──────────────────────────────▲───────────      Ultracode  off
 *     low     medium     high     xhigh      max      Tab to toggle
 *
 *     ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
 *
 * Ultracode is a **toggle beside the track**, not a stop on it. On a pane narrower than
 * about 67 columns the toggle wraps to two lines of its own under the labels. v2.1.232 drew
 * it as a sixth stop instead (`… max       ultracode`, captioned `xhigh + workflows`), with
 * no toggle and no `s`. Both layouts are read here, because the panel does not own the
 * sessions it shows and an old binary can still be running in one of them.
 *
 * The v2.1.296 layout is what broke the panel's effort picker. The toggle's text sits on
 * the track's own line, so the track test refused the whole slider at every width the
 * panel launches at. The labels line also ends in `Tab to toggle`, which a word scan would
 * read as three more stops. Both tails are cut off **by name** before the old reading
 * runs. A label starting past the track's end makes the reading refuse rather than guess,
 * because the next thing Claude Code puts there will not be named here.
 *
 * **What each key writes, measured on v2.1.296** against a hash of
 * `~/.claude/settings.json`:
 * - `←`/`→` move the marker and write nothing.
 * - `Tab` flips Ultracode and writes nothing.
 * - `s` commits for this session only and writes nothing. The pane says *"Set effort
 *   level to high (this session only)"*.
 * - `Enter` writes `modelSettings.<current model>.effortLevel`, a per-model default for
 *   every session started afterwards (*"saved as your default for new sessions"*).
 *
 * On v2.1.232 there was no `s`, and `Enter` wrote the top-level `effortLevel`. Every one
 * of those measurements was put back from a backup.
 */

/** The heading and the key line. Both, or this is some other track-shaped thing. */
const TITLE_RE = /^\s*Effort\s*$/;
const FOOTER_RE = /←\/→\s*to adjust\s*·\s*Enter to confirm/;

/** The track: box-drawing, with the marker somewhere on it. */
const TRACK_RE = /^[\s─┆▲]*▲[\s─┆]*$/;

/**
 * v2.1.296's Ultracode toggle, in its two places. On a wide pane its state ends the track
 * line and its hint ends the labels line. On a narrow one each sits on its own line under
 * the labels. Anchored at both ends, so `Ultracode: dynamic workflows on every task` (the
 * caption drawn while it is on) is never read as the toggle.
 */
const TOGGLE_TAIL_RE = /\s{2,}Ultracode\s+(on|off)$/;
const TOGGLE_LINE_RE = /^\s*Ultracode\s+(on|off)$/;
const TOGGLE_HINT_TAIL_RE = /\s{2,}Tab to toggle$/;

/** The session-only key. It can wrap onto the footer's second line on a narrow pane. */
const SESSION_KEY_RE = /\bs for this\s+session only\b/;

/**
 * @param {string} text raw `capture-pane` output
 * @returns {null | {kind, levels, current, ultracode: boolean | null, sessionOnly: boolean}}
 *   `ultracode` is null when the screen draws no toggle, as on the older layout, where
 *   `ultracode` is one of the `levels` instead.
 */
export function parseEffortDialog(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const footerAt = lines.findLastIndex((l) => FOOTER_RE.test(l));
  if (footerAt < 0) return null;
  const titleAt = lines.slice(0, footerAt).findLastIndex((l) => TITLE_RE.test(l));
  if (titleAt < 0) return null;

  // The box is everything from the heading down to the key line.
  let ultracode = null;
  let trackAt = -1;
  let track = '';
  for (let i = titleAt + 1; i < footerAt; i += 1) {
    const toggle = lines[i].match(TOGGLE_TAIL_RE);
    const bare = toggle ? lines[i].slice(0, toggle.index) : lines[i];
    if (TRACK_RE.test(bare)) {
      trackAt = i;
      track = bare;
      if (toggle) ultracode = toggle[1] === 'on';
      break;
    }
  }
  if (trackAt < 0) return null;

  // The labels are the next line with anything on it. They are not evenly spaced, so
  // each one's own column is what matters, never its ordinal position along the track.
  const labelAt = lines.findIndex((l, i) => i > trackAt && i < footerAt && l.trim());
  if (labelAt < 0) return null;
  const labelLine = lines[labelAt].replace(TOGGLE_HINT_TAIL_RE, '');

  const trackEnd = track.length;
  const levels = [];
  const word = /\S+/g;
  let m;
  while ((m = word.exec(labelLine))) {
    // A label that starts past the end of the track is not a stop on it, and nothing
    // here knows what it is, so this is not a screen it can read.
    if (m.index >= trackEnd) return null;
    levels.push({ id: m[0], column: m.index });
  }
  if (levels.length < 2) return null;

  // The narrow layout puts the toggle on a line of its own, somewhere between the labels
  // and the key line (the `max` stop's warning paragraph can come first).
  if (ultracode === null) {
    for (let i = labelAt + 1; i < footerAt; i += 1) {
      const toggle = lines[i].match(TOGGLE_LINE_RE);
      if (toggle) {
        ultracode = toggle[1] === 'on';
        break;
      }
    }
  }

  // Nearest label to the marker. Distance, not "the last one we passed": the marker sits
  // slightly right of its label's first character at some stops and slightly left at
  // others, and a directional rule gets the ends wrong.
  const marker = track.indexOf('▲');
  let current = levels[0];
  for (const level of levels) {
    if (Math.abs(level.column - marker) < Math.abs(current.column - marker)) current = level;
  }

  const footer = lines.slice(footerAt, footerAt + 2).map((l) => l.trim()).join(' ');

  return {
    kind: 'effort',
    levels: levels.map((l, i) => ({ id: l.id, index: i, current: l.id === current.id })),
    current: current.id,
    ultracode,
    sessionOnly: SESSION_KEY_RE.test(footer),
  };
}

/**
 * Which way to nudge the marker, one press at a time.
 *
 * A plan rather than a count, for the reason `changeMode` and the model picker both give:
 * press once, re-read, ask again. A count fired blind lands somewhere nobody chose the
 * first time the scale changes shape. It has already gone from five stops to six and back
 * to five.
 *
 * @returns {'Right' | 'Left' | null} null when it is already there
 */
export function nudgeToward(box, wanted) {
  const from = box.levels.findIndex((l) => l.current);
  const to = box.levels.findIndex((l) => l.id === wanted);
  if (from < 0 || to < 0) throw new Error(`No such effort level: ${wanted}`);
  if (from === to) return null;
  return to > from ? 'Right' : 'Left';
}

/**
 * The key that commits, and what it changes. `s` when the screen offers it, because it
 * writes nothing to disk. Otherwise `Enter`, which on the older screen is the only key
 * that commits, and which writes a default for every new session.
 *
 * @returns {{key: 's' | 'Enter', scope: string}}
 */
export function commitKey(box) {
  return box.sessionOnly
    ? { key: 's', scope: 'this session only' }
    : { key: 'Enter', scope: 'default for new sessions' };
}
