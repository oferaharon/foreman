/**
 * What a session still has running behind its composer, in Claude Code's own words.
 *
 * The roster's `background` field is `{ agents, shells, monitors }` while the mode line is on
 * screen and `null` while a box hides it (`server/tmux.js`, `parseBackground`). Two readers
 * draw it — the rail row's second dot and the line above the composer — and both ask this
 * module, so "is anything running" and "what does it say" have one answer each rather than
 * one per reader.
 *
 * The words are the terminal's: its mode line reads `5 shells, 2 monitors`, and the agents
 * it lists in a panel of their own are put in front in the same shape. The maintainer chose
 * that over a friendlier sentence, on the panel's habit of reusing Claude Code's vocabulary
 * (`bypass permissions`, `auto mode`) rather than inventing a second one. A count of zero is
 * left out entirely, and one is singular.
 *
 * Pure — no DOM — so `node --test` runs it.
 */

const NOUNS = [
  ['agents', 'agent'],
  ['shells', 'shell'],
  ['monitors', 'monitor'],
];

/**
 * `5 agents, 5 shells, 2 monitors` — or `''` when there is nothing to say, which both
 * readers take as "draw nothing". That includes `null`: a box is hiding the line, and the
 * roster drops the count there rather than holding it (`sessions.js`), so a session sitting
 * on a prompt shows no dot rather than one that may have stopped being true.
 */
export function backgroundWords(bg) {
  if (!bg) return '';
  return NOUNS.map(([key, one]) => {
    const n = Number(bg[key]) || 0;
    return n > 0 ? `${n} ${n === 1 ? one : key}` : null;
  })
    .filter(Boolean)
    .join(', ');
}

/**
 * The rail dot's tooltip: the counts, then one line per running agent the terminal listed —
 * `Sleep agent one (general-purpose)` — and `+N more` for the ones its panel hid. The names
 * come off the roster (`background.running`), which carries nothing that ticks, so a row's
 * tooltip changes only when an agent starts or stops. `''` when there is nothing to say.
 */
export function backgroundTitle(bg) {
  const words = backgroundWords(bg);
  if (!words) return '';
  const lines = [`Background: ${words}`];
  const running = Array.isArray(bg.running) ? bg.running : [];
  for (const r of running) lines.push(r.name ? `${r.name} (${r.type})` : r.type);
  const hidden = (Number(bg.agents) || 0) - running.length;
  if (running.length && hidden > 0) lines.push(`+${hidden} more`);
  return lines.join('\n');
}

/**
 * `15m ago`, in the shape `/tasks` itself uses ("started 15m ago", "last active 3m ago").
 * Coarse on purpose — the list repaints only when this string changes, so a minute is the
 * finest grain worth a repaint once past the first minute. `''` for a missing or unparseable
 * time, which the list leaves out rather than guess.
 */
export function agoWords(iso, now = Date.now()) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Whether the line has a list to unfold: agents running now, or agents that ran earlier. */
export function hasAgentList(bg, list) {
  return (Number(bg?.agents) || 0) > 0 || (list?.earlier?.length || 0) > 0 || (list?.running?.length || 0) > 0;
}
