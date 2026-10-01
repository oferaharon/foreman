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
