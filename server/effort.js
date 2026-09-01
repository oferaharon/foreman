/**
 * Reading — and driving — the `/effort` slider.
 *
 * The fifth screen the panel drives, and the odd one out twice over. It is not a numbered
 * list at all but a track with a marker on it:
 *
 *     Faster                                                 Smarter
 *     ───────────────────────────────────────────┆─────────▲────────
 *     low     medium     high     xhigh      max       ultracode
 *                                                  xhigh + workflows
 *
 *     ←/→ to adjust · Enter to confirm · Esc to cancel
 *
 * And **there is no session-only path.** `/model` offers `s` for "this session only";
 * this dialog offers nothing of the kind, and its `Enter` writes `effortLevel` into
 * `~/.claude/settings.json` for every session started afterwards — Claude Code says so in
 * the transcript: *"Set effort level to medium (saved as your default for new sessions)"*.
 * The effort row *inside* `/model` is no better: pressing `s` there scopes the model and
 * writes the effort globally regardless. Both were measured, and both had to be undone
 * from a backup.
 *
 * So the panel offers this as what it is — a global setting — rather than pretending it
 * matches the model picker beside it. What is safe, and verified: **arrow keys alone
 * change nothing on disk.** Stepping the marker is free; only `Enter` commits.
 */

/** The heading and the key line. Both, or this is some other track-shaped thing. */
const TITLE_RE = /^\s*Effort\s*$/;
const FOOTER_RE = /←\/→\s*to adjust\s*·\s*Enter to confirm/;

/** The track: box-drawing, with the marker somewhere on it. */
const TRACK_RE = /^[\s─┆▲]*▲[\s─┆]*$/;

/**
 * @param {string} text raw `capture-pane` output
 * @returns {null | {kind, levels, current}}
 */
export function parseEffortDialog(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  if (!lines.some((l) => FOOTER_RE.test(l))) return null;
  if (!lines.some((l) => TITLE_RE.test(l))) return null;

  const trackAt = lines.findIndex((l) => TRACK_RE.test(l) && l.includes('▲'));
  if (trackAt < 0) return null;

  // The labels are the next line with anything on it. They are not evenly spaced — the
  // gaps widen towards `ultracode` — so each one's own column is what matters, never its
  // ordinal position along the track.
  const labelLine = lines.slice(trackAt + 1).find((l) => l.trim());
  if (!labelLine) return null;

  const levels = [];
  const word = /\S+/g;
  let m;
  while ((m = word.exec(labelLine))) levels.push({ id: m[0], column: m.index });
  if (levels.length < 2) return null;

  // Nearest label to the marker. Distance, not "the last one we passed": the marker sits
  // slightly right of its label's first character at some stops and slightly left at
  // others, and a directional rule gets the ends wrong.
  const marker = lines[trackAt].indexOf('▲');
  let current = levels[0];
  for (const level of levels) {
    if (Math.abs(level.column - marker) < Math.abs(current.column - marker)) current = level;
  }

  return {
    kind: 'effort',
    levels: levels.map((l, i) => ({ id: l.id, index: i, current: l.id === current.id })),
    current: current.id,
  };
}

/**
 * Which way to nudge the marker, one press at a time.
 *
 * A plan rather than a count, for the reason `changeMode` and the model picker both give:
 * press once, re-read, ask again. A count fired blind lands somewhere nobody chose the
 * first time the scale gains a stop — and this one already has six where it once had five.
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
