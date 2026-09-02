/*
 * The composer's ghost text — Claude Code's own guess at your next prompt.
 *
 * An idle session offers a suggested next prompt as dim text inside the composer's input
 * line, which Tab accepts. It never reaches the transcript, and plain `capture-pane` output
 * gives a reader no way to tell it from typed text — CLAUDE.md has said so for a while:
 * "`capture-pane -p` cannot tell a suggestion from typed text". So this module reads
 * `capture-pane -pe`, where the dim attribute survives, and the dim attribute is the
 * *whole* of how you tell.
 *
 * Everything below was measured against a scratch session in the sandbox's `alpha` on
 * Claude Code v2.1.257, at 220 columns, at 70, and at 34. None of it is guessable:
 *
 *   • The input line is `❯` + U+00A0 + the suggestion, and the suggestion is wrapped in
 *     `ESC[2m` … `ESC[0m`.
 *
 *   • That wrapping is **not one run**. The attribute comes back re-emitted per word as
 *     often as not: the same phrase captured as `ESC[2mfix slugify and add a test for
 *     itESC[0m` at one moment and as `ESC[2mfixESC[0m ESC[2mslugifyESC[0m …`
 *     at another, with the spaces between the runs carrying no attribute at all. So the test
 *     is not "read the first dim run" — that yields `fix` on one capture and the whole
 *     phrase on the next. It is **every non-blank character after the `❯` must be dim**,
 *     which comes out identical at every width. Same discipline as the permission parser's
 *     "both widths now yield identical labels".
 *
 *   • The moment you type, the dim goes away entirely — `❯` + U+00A0 + `run th` carries no
 *     `ESC[2m` anywhere on the line. So the structural test is also the "only when the input is empty"
 *     guard, rather than a second check bolted on beside it.
 *
 *   • A working session draws the same empty input line with no dim run, so it yields
 *     nothing here either — but the caller gates on `state === 'idle'` anyway, because that
 *     is the guard a reader can see and reason about.
 *
 *   • **The terminal truncates a suggestion it cannot fit, and that is the one thing here
 *     that could ship a lie.** At 34 columns the same suggestion came back as
 *     `fix slugify and add a test for …` — an ellipsis, not a wrap; there is no second line
 *     to collect. Prefilling a composer with that, or worse auto-sending it, puts a literal
 *     `…` into somebody's session. A read ending in `…` is therefore **refused**: showing
 *     nothing beats showing something wrong, and a suggestion the panel cannot spell in full
 *     is not one it may offer.
 *
 * Deliberately not a `parsePane` field. It needs a second capture with `-e`, and switching
 * the shared one over would put ANSI bytes in front of all five numbered-screen parsers to
 * buy a modest feature. `readGhost` in `tmux.js` takes the extra call, and only for panes
 * that are idle.
 */

/**
 * The composer box's own rules, above and below the input line. The upper one carries the
 * tmux session name (`──… alpha-main ─`) and the lower one is bare, so both are matched by
 * their opening run rather than by their whole shape.
 */
const RULE_RE = /^\s*─{6,}/;

/**
 * The composer's prompt glyph. Its own `❯` — a picker marks its selected row with one too,
 * which is why nothing here is reached without the composer test having passed first.
 */
const CARET = '❯';

/**
 * Written as explicit escapes rather than the literal bytes, for the reason `normalize.js`
 * already gives about its ANSI regex: an invisible control character in source lasts until
 * the next careless edit, after which the code quietly starts doing something else.
 */
const ESC = '\u001b';
const BEL = '\u0007';
const NBSP = '\u00a0';

/**
 * A suggestion is one terminal line. Anything longer is not one, and is not typed into
 * somebody's session on this module's word.
 */
const MAX_LEN = 400;

/**
 * Whether SGR parameters turn dim on, off, or leave it alone.
 *
 * The extended-colour forms have to be *consumed* rather than scanned, and this is not
 * pedantry: `38;5;2` is an ordinary 256-colour green whose colour index is 2, and a parser
 * reading each `;`-separated number on its own would take that as `2` — dim — and call a
 * coloured, typed line a suggestion. That is the one false positive that matters here,
 * because it ends with the panel offering to send somebody's half-typed text.
 */
function applyDim(dim, params) {
  const codes = params === '' ? ['0'] : params.split(';');
  let out = dim;
  for (let i = 0; i < codes.length; i += 1) {
    const n = Number(codes[i] || '0');
    if (n === 38 || n === 48 || n === 58) {
      // `5;<idx>` or `2;<r>;<g>;<b>` — skip the arguments so they are never read as codes.
      const kind = Number(codes[i + 1] || '0');
      i += kind === 5 ? 2 : kind === 2 ? 4 : 1;
      continue;
    }
    if (n === 0) out = false;
    else if (n === 2) out = true;
    else if (n === 22) out = false;
  }
  return out;
}

/**
 * One line of `capture-pane -pe` as characters, each carrying whether it is dim.
 *
 * Dim starts **off** at the head of every line, which is not what a terminal does — a
 * `ESC[0m` can and does leak onto the next line (measured: the ghost's own reset landed
 * at the head of the rule below it). Resetting per line is the safe direction of that
 * inaccuracy: an inherited dim state could only ever make *typed* text look like a
 * suggestion, while losing a real suggestion costs a line nobody sees.
 */
function cells(raw) {
  const out = [];
  let dim = false;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === ESC) {
      // OSC — the `]8;;<url>` hyperlink pair sits in the footer directly below this line.
      if (raw[i + 1] === ']') {
        let j = i + 2;
        while (j < raw.length && raw[j] !== BEL && !(raw[j] === ESC && raw[j + 1] === '\\')) {
          j += 1;
        }
        i = raw[j] === BEL ? j + 1 : j + 2;
        continue;
      }
      const m = /^\u001b\[([0-9;:?]*)[ -/]*([@-~])/.exec(raw.slice(i));
      if (m) {
        if (m[2] === 'm') dim = applyDim(dim, m[1]);
        i += m[0].length;
        continue;
      }
      i += 1; // a lone ESC, or a form this does not know — drop the byte, keep the text
      continue;
    }
    out.push({ ch: raw[i], dim });
    i += 1;
  }
  return out;
}

/** The plain text of a line, escapes removed. */
const plain = (raw) =>
  cells(raw)
    .map((c) => c.ch)
    .join('');

/** Space, the composer's own U+00A0 separator, and the tab nobody draws but everybody hits. */
const isBlank = (ch) => ch === ' ' || ch === NBSP || ch === '\t';

/**
 * The suggestion Claude Code is offering in this pane's composer, or `null`.
 *
 * @param {string} text raw `capture-pane -pe` output, escapes intact. Plain `-p` output
 *   carries no attributes at all, so it can only ever answer `null` here — which is the
 *   right answer for a caller that forgot the `-e`, rather than a quietly wrong one.
 * @returns {string|null}
 */
export function parseGhost(text) {
  if (!text) return null;
  // Trailing blank rows first. A pane whose history is shorter than its height pads the
  // capture out with them — a fresh session came back with forty — and the search below is
  // bounded to a dozen lines, which those would spend on nothing.
  const lines = text.split('\n');
  while (lines.length && !plain(lines[lines.length - 1]).trim()) lines.pop();

  // The composer box, found from the bottom up: its lower rule is the last rule on screen
  // (the footer and mode lines below it are not rules), and its upper rule is the next one
  // above. Bounded tightly — the box is three lines tall around an empty input, and this
  // must not go hunting up the transcript for a rule belonging to something else.
  let bottom = -1;
  for (let i = lines.length - 1; i >= 0 && lines.length - i < 12; i -= 1) {
    if (RULE_RE.test(plain(lines[i]))) {
      bottom = i;
      break;
    }
  }
  if (bottom < 1) return null;

  let top = -1;
  for (let i = bottom - 1; i >= 0 && bottom - i <= 4; i -= 1) {
    if (RULE_RE.test(plain(lines[i]))) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;

  // Exactly one line between the rules. A suggestion never wraps — it is truncated with an
  // ellipsis instead, measured at 34 columns — so more than one line in there is a
  // multi-line message somebody is typing, and there is nothing to offer.
  if (bottom - top !== 2) return null;

  const row = cells(lines[top + 1]);
  const caret = row.findIndex((c) => c.ch === CARET);
  if (caret < 0) return null;
  if (row.slice(0, caret).some((c) => !isBlank(c.ch))) return null;

  const rest = row.slice(caret + 1);
  if (!rest.some((c) => !isBlank(c.ch))) return null;
  // Every character that is not blank has to be dim. One that is not is typed text — which
  // is the whole of the "only when the input is empty" guard.
  if (rest.some((c) => !isBlank(c.ch) && !c.dim)) return null;

  const suggestion = rest
    .map((c) => (c.ch === NBSP ? ' ' : c.ch))
    .join('')
    .trim();

  if (!suggestion || suggestion.length > MAX_LEN) return null;
  // Truncated by the terminal's own width — see the header. The panel cannot spell it in
  // full, so it does not offer it at all.
  if (suggestion.endsWith('…')) return null;
  return suggestion;
}

/**
 * The suggestion this pane last showed, remembered across the polls where the read fails.
 *
 * The same shape as `rememberFooter` in `sessions.js` and for the same reason, with one
 * difference that matters more here than it does there: a stale *suggestion* is worse than
 * a stale model, because it is a button. So the memory is dropped the moment the pane stops
 * being eligible — anything but plain `idle`, which is to say a working session, a
 * permission box, a picker, the trust gate — rather than being held for the pane's life.
 *
 * `ghost === undefined` means the capture itself did not come back (a tmux hiccup), and
 * only that keeps the previous answer. A capture that came back carrying nothing clears it,
 * because a session whose suggestion has genuinely gone is offering nothing.
 *
 * @param {Map<string, string>} store per-pane memory
 * @param {string} paneId
 * @param {{eligible: boolean, ghost?: string|null}} read
 * @returns {string|null}
 */
export function rememberGhost(store, paneId, { eligible, ghost } = {}) {
  if (!paneId) return null;
  if (!eligible) {
    store.delete(paneId);
    return null;
  }
  if (ghost === undefined) return store.get(paneId) ?? null;
  if (ghost) store.set(paneId, ghost);
  else store.delete(paneId);
  return store.get(paneId) ?? null;
}
