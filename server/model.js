import { readOptionBlock } from './question.js';

/**
 * Reading — and driving — the `/model` picker.
 *
 * The fourth numbered screen, and the one that punishes a wrong key hardest, because what
 * it writes is not in this session at all. Its own footer spells it out:
 *
 *     Enter to set as default · s to use this session only · Esc to cancel
 *
 * **A digit commits, and commits as the global default.** Pressing `4` here does not move a
 * cursor and does not wait for Enter — it selects Sonnet *and* rewrites `model` in
 * `~/.claude/settings.json` for every session started afterwards. That was measured, not
 * guessed: it happened, and the file had to be restored from a backup taken minutes
 * earlier. Every other numbered screen in this panel is answered by the option's own digit;
 * this is the one where a digit is the thing you must never send.
 *
 * So the cursor is *stepped* — `Down`/`Up`, re-reading the pane after each press until `❯`
 * sits on the row that was asked for — and then `s`. Same discipline as `changeMode`, for
 * the same reason: verifying beats counting, and if the layout ever changes this stops
 * rather than committing something nobody chose.
 *
 * The panel never sends `Enter` here. Setting a global default is a decision about every
 * future session, taken from a list of fourteen rows where one is highlighted — it belongs
 * in the terminal, where you can see what you are doing.
 */

/**
 * How a Claude model is spelled on the composer footer — `| Opus 5 (1M context) | ctx: 14%`.
 *
 * It lives here rather than in `tmux.js`, which is the only place that scrapes that line,
 * because this file has to *predict* what the line will say: the panel can commit a model
 * faster than the terminal redraws its footer. Two spellings of one naming contract is the
 * `isLeadName` mistake in another costume, so there is one pattern and both readers share
 * it. See `footerModelName` below.
 */
export const FOOTER_MODEL_RE = /\b((?:Opus|Sonnet|Haiku|Fable)\s+[\d.]+(?:\s*\([^)]*\))?)/;

/** The heading, and the footer that tells you what the keys do. Both, or it isn't this box. */
const TITLE_RE = /^\s*Select model\s*$/i;
const FOOTER_RE = /to set as default\s*·\s*s to use this session only/i;

/**
 * …and the second screen, which only sometimes exists.
 *
 * `s` does not always finish the job. If the conversation is already cached for the model
 * it is leaving — meaning a message has been sent under it — Claude Code draws one more box:
 *
 *     Switch model?
 *     Your next response will be slower and use more tokens
 *     This conversation is cached for the current model. Switching to Sonnet 5 means the
 *     full history gets re-read on your next message.
 *     ❯ 1. Yes, switch to Sonnet 5
 *       2. No, go back
 *
 * and **nothing has changed yet**. It carries no key-hint footer at all, so it reads as
 * `needs-decision` with no prompt behind it — the trust-gate shape — and a panel that
 * reported success after `s` was reporting a switch that had not happened, over a session
 * now sitting blocked on a box nobody in the browser could see.
 *
 * Measured in a scratch session: a digit here **selects and submits**, and the session-only
 * scope survives it (`Set model to Sonnet 5 for this session only`, `settings.json`
 * untouched). `Esc` goes back to the picker, not to the composer — one press is not an exit.
 */
const CONFIRM_TITLE_RE = /^\s*Switch model\?\s*$/i;
const YES_RE = /^Yes,\s*switch to\s+(.+)$/i;
const NO_RE = /^No,\s*go back\b/i;

/** `    4. Sonnet                  Sonnet 5 · Efficient for routine tasks` */
const GAP_RE = /\s{2,}/;

/**
 * The scrolling window — what the picker becomes when the pane is short.
 *
 * Measured on v2.1.257 in the sandbox's `alpha`, and the finding that matters first is
 * that **it is height, not width**: at 220 columns and 23 rows the box collapses exactly
 * as it does at 80×23, while 220×50 draws all five rows. 80×23 is not an exotic size —
 * it is what the panel's own attach-terminal button shrinks a pane to, because a default
 * macOS Terminal window is 80×23 (CLAUDE.md's "Attaching a Terminal resizes the pane").
 *
 *       1. Default (recommended)  Opus 5 with 1M context · Best for everyday,
 *                                 complex tasks
 *     ❯ 2. Opus (1M context)      Opus 5 with 1M context · Best for everyday,
 *                                 complex tasks
 *     ↓ 3. Fable ✔                Fable 5.1 · Most capable for your hardest and
 *                                 longest-running tasks
 *        … +2 models
 *
 * Three rows of a five-row list, and three things about the chrome, all captured:
 *
 * - `↑` / `↓` sit **in the cursor column**, where `❯` goes, on the first/last visible row
 *   when there is more list beyond it. They are not the cursor and they never share a row
 *   with it: with the cursor on the bottom visible row the `↓` is simply not drawn.
 * - `… +N models` counts what is **hidden in total**, not what is below. It reads `+2` at
 *   the top of the list and `+2` at the bottom of it, so `visible + N` is the length of the
 *   whole list. Measured true at every size the panel produces — three rows at 80×23 and at
 *   220×23, two at 60×12, five in each case — and measured **one short at 60×10**, where the
 *   window degenerates to a single row and the count still reads `+3`. So it is reported as
 *   `total` and nothing is decided by it: the endpoint that walks the list stops on a
 *   completed lap, not on this number.
 * - The list **wraps**: `Down` from the last row lands on the first. That is why
 *   `stepToward` stays monotonic (below) and why the window can be enumerated by walking
 *   one direction.
 *
 * What it cost before this was read: `↓ 3.` does not match `OPTION_RE`, so the run came
 * back as 1..2 (or 3..4, which is not a 1..N run at all) and `parseModelDialog` answered
 * **null** — over a box the panel had opened itself, which then could not be read, could
 * not be closed, and blocked the composer until somebody pressed Esc in the terminal.
 *
 * So the window is flattened before `readOptionBlock` ever sees it: the marker column is
 * blanked, the `… +N models` row is lifted out, and the run is rebased to start at 1. The
 * offset is added back afterwards. Nothing here changes what the shared block reader —
 * or `permission.js`, `question.js`, `plan.js`, `effort.js` — sees on any other screen.
 */
const SCROLL_MARKERS = '↑↓';
/** `  ↓ 3. Fable ✔` / `  ❯ 2. Opus` / `    1. Default` — enough of a row to find its number. */
const ROW_HEAD_RE = new RegExp(`^(\\s*)([❯${SCROLL_MARKERS}])?(\\s*)(\\d{1,2})\\.(?=\\s)`);
/** `     … +2 models` — how many rows the window is not showing. */
const MORE_RE = /^\s*…\s*\+(\d+)\s+models?\s*$/;

/**
 * Cut the picker's option run down to a plain 1..N run `readOptionBlock` can read.
 *
 * @param {string[]} nonEmpty the capture with blank lines dropped
 * @param {number} from index of the box's own title — nothing above it is touched, because
 *   a numbered line in the scrollback above is somebody's transcript, not an option
 * @returns {{lines: string[], offset: number, hidden: number, windowed: boolean}}
 */
function flattenWindow(nonEmpty, from) {
  const out = [];
  const rows = [];
  let hidden = 0;
  let windowed = false;

  for (let i = 0; i < nonEmpty.length; i += 1) {
    if (i < from) {
      out.push(nonEmpty[i]);
      continue;
    }
    const more = MORE_RE.exec(nonEmpty[i]);
    if (more) {
      // Lifted out rather than left in: below the last visible row it is harmless, but
      // above one it would be filed as that row's description and end up on a card.
      hidden = Number(more[1]);
      windowed = true;
      continue;
    }
    const m = ROW_HEAD_RE.exec(nonEmpty[i]);
    if (m) rows.push({ at: out.length, m });
    out.push(nonEmpty[i]);
  }

  if (!rows.length) return { lines: out, offset: 0, hidden, windowed };

  const offset = Number(rows[0].m[4]) - 1;
  if (offset > 0) windowed = true;

  for (const { at, m } of rows) {
    const marker = m[2];
    if (marker && SCROLL_MARKERS.includes(marker)) windowed = true;
    if (!offset && (!marker || marker === '❯')) continue; // nothing to rewrite
    const num = String(Number(m[4]) - offset);
    // Keep the column the label starts at: the rebased number can only be shorter, so the
    // difference goes back into the indent. `❯` survives; a scroll marker becomes a space.
    const pad = ' '.repeat(m[1].length + (m[4].length - num.length));
    const cursor = marker === '❯' ? '❯' : marker ? ' ' : '';
    out[at] = `${pad}${cursor}${m[3]}${num}.${out[at].slice(m[0].length)}`;
  }

  return { lines: out, offset, hidden, windowed };
}

/**
 * Is `/model` on screen at all, whether or not its rows can be read?
 *
 * The title and the footer, and nothing about the options — which is the whole point.
 * `parseModelDialog` decides whether the panel may *drive* the box; this decides whether
 * there is a box to get **out of**, and those are different questions with different costs
 * for being wrong. A picker the panel opened and then failed to parse used to be
 * abandoned: `closeModelDialog` asked the same failing parser, concluded nothing was open,
 * returned `true` without ever pressing Escape, and left the session blocked behind a box
 * only the terminal could dismiss.
 *
 * The footer is required *below* the title so an old `Select model` line in the scrollback
 * cannot stand in for a live one.
 */
export function modelDialogOpen(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!TITLE_RE.test(lines[i])) continue;
    return lines.slice(i + 1).some((l) => FOOTER_RE.test(l));
  }
  return false;
}

/**
 * …and the same question for the second screen.
 *
 * By title alone, deliberately: `parseModelConfirm` is narrow on purpose (it answers with a
 * digit), so the day Claude Code grows a third row there it returns null — and that is
 * exactly the state the panel must still be able to Escape out of.
 */
export function modelConfirmOpen(text) {
  return text.split('\n').some((l) => CONFIRM_TITLE_RE.test(l));
}

/**
 * @param {string} text raw `capture-pane` output
 * @returns {null | {kind, options, cursorIndex, currentIndex, windowed, hidden, total, partial}}
 */
export function parseModelDialog(text) {
  const nonEmpty = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  if (!nonEmpty.length) return null;

  // The footer is the load-bearing half of the recognition: a list of models under some
  // other heading must never be driven by the code below, which ends in a keystroke.
  if (!nonEmpty.some((l) => FOOTER_RE.test(l))) return null;

  // The title is found before anything is rewritten, because it is what bounds the
  // rewriting: only lines below the box's own heading are the box's own rows.
  let titleAt = -1;
  for (let i = nonEmpty.length - 1; i >= 0; i -= 1) {
    if (TITLE_RE.test(nonEmpty[i])) {
      titleAt = i;
      break;
    }
  }
  if (titleAt < 0) return null;

  const { lines, offset, hidden, windowed } = flattenWindow(nonEmpty, titleAt);
  const block = readOptionBlock(lines);
  if (!block) return null;
  const { top, rows } = block;

  // Still checked against the block itself, and not merely "there is a title somewhere":
  // an option run six lines below the heading is this box's, one further down is not.
  let titled = false;
  for (let i = top - 1; i >= 0 && top - i <= 6; i -= 1) {
    if (TITLE_RE.test(lines[i])) {
      titled = true;
      break;
    }
  }
  if (!titled) return null;

  const options = rows.map((r) => {
    // Label and blurb share the line, separated by a run of spaces the TUI uses as a
    // column gap. The tick rides on the label, never on the blurb.
    const [head, ...tail] = r.label.split(GAP_RE);
    const name = head.replace(/\s*✔\s*$/, '').trim();
    return {
      // Back to the number the terminal itself drew, so `expectLabel`, the client's menu
      // and the cursor arithmetic all speak the list's own numbering rather than the
      // window's.
      index: r.index + offset,
      label: name,
      description: tail.join(' ').trim() || null,
      current: /✔/.test(head),
      cursor: r.selected,
    };
  });

  // `visible + N` is the length of the list — `… +N models` counts everything hidden, not
  // just what is below the fold. With no such row the window is the list.
  const total = windowed ? (hidden ? options.length + hidden : null) : options.length;

  return {
    kind: 'model',
    options,
    cursorIndex: options.find((o) => o.cursor)?.index ?? null,
    currentIndex: options.find((o) => o.current)?.index ?? null,
    // The box is showing a slice of the list...
    windowed,
    hidden,
    total,
    // ...and these rows are therefore not the whole menu. Said out loud so a caller that
    // draws them knows it is drawing part of a list, rather than inferring it from a
    // count that happens to be short.
    partial: windowed && (total == null || options.length < total),
  };
}

/**
 * What the composer footer will call an option, worked out from the option itself.
 *
 * The picker and the footer do not spell a model the same way, and neither is wrong: a
 * picker row names a **choice** — `Default (recommended)`, `Opus (1M context)`, `Sonnet` —
 * while the footer names the **model** — `Opus 5 (1M context)`, `Sonnet 5`. The bridge is
 * the row's own blurb, which already speaks the footer's vocabulary (`Sonnet 5 · Efficient
 * for routine tasks`), so it is read with the footer's own pattern rather than a second one
 * written to match it.
 *
 * Why the panel needs to guess at all: setting a model takes a couple of keystrokes and the
 * terminal redraws its footer some unknowable time afterwards, so the roster frame that
 * lands next still names the model the session was on a moment ago. This is what lets the
 * click's own answer be shown immediately, and seeded, instead of the label sitting a switch
 * behind. `Opus (1M context)` is the one row where the two strings differ after this —
 * `Opus 5` here, `Opus 5 (1M context)` once scraped — and they are the same on screen,
 * because `shortModel` in the client drops exactly that trailing parenthetical.
 *
 * Null rather than a guess when the row carries no blurb, or a blurb naming no model. That
 * is a floor for a layout nobody has met, not a description of a narrow terminal: measured
 * at 70 columns the blurb *wraps* but survives, and the model name sits at its front
 * (`Fable 5.1 · Most capable for your`), so it is the half that is never cut. Declining
 * costs the label one poll; a wrong name shown confidently is worse.
 *
 * @param {{label: string, description: string|null}} option a row from `parseModelDialog`
 * @returns {string|null}
 */
export function footerModelName(option) {
  const m = FOOTER_MODEL_RE.exec(option?.description ?? '');
  return m ? m[1].trim() : null;
}

/**
 * Which way to step, and how far, to get the cursor from `from` to `to`.
 *
 * Returned as a plan rather than executed, so the caller can press one key, re-read, and
 * ask again — a count computed once and fired blind is the thing this avoids.
 *
 * **Monotonic on purpose, though the list wraps.** `Down` from the last row lands on the
 * first — measured — so from row 5 to row 1 a single `Down` would beat four `Up`s. It is
 * still four `Up`s here, because a direction chosen by comparison converges whether or not
 * the list wraps, while a direction chosen *because* it wraps stalls against the end of the
 * list the day it stops. The caller is bounded and re-reads after every press, so the extra
 * presses cost a fraction of a second and buy a rule that cannot walk the wrong way.
 *
 * @returns {'Down' | 'Up' | null} null when it is already there
 */
export function stepToward(from, to) {
  if (from == null || from === to) return null;
  return to > from ? 'Down' : 'Up';
}

/**
 * The `Switch model?` box, or null.
 *
 * Recognition is the title plus the exact pair of options — `Yes, switch to …` and
 * `No, go back`, in that order and nothing else. Deliberately narrow: the only reason this
 * parser exists is that its caller answers by pressing a digit, and the day Claude Code
 * grows a third row here ("and don't ask again", say) this must stop rather than guess.
 *
 * At 50 columns the yes label wraps and `readOptionBlock` files the tail as a description,
 * so the model name is read from the two joined — captured, not imagined.
 *
 * @param {string} text raw `capture-pane` output
 * @returns {null | {kind, target, yesIndex, noIndex}}
 */
export function parseModelConfirm(text) {
  const nonEmpty = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  if (!nonEmpty.length) return null;

  const block = readOptionBlock(nonEmpty);
  if (!block) return null;
  const { top, rows } = block;
  if (rows.length !== 2) return null;

  let titled = false;
  for (let i = top - 1; i >= 0 && top - i <= 8; i -= 1) {
    if (CONFIRM_TITLE_RE.test(nonEmpty[i])) {
      titled = true;
      break;
    }
  }
  if (!titled) return null;

  const full = (r) => [r.label, r.description].filter(Boolean).join(' ').trim();
  const yes = YES_RE.exec(full(rows[0]));
  if (!yes || !NO_RE.test(full(rows[1]))) return null;

  return {
    kind: 'model-confirm',
    target: yes[1].trim(),
    yesIndex: rows[0].index,
    noIndex: rows[1].index,
  };
}

const WORD_RE = /[a-z0-9]+/g;
const words = (s) => new Set(String(s).toLowerCase().match(WORD_RE) ?? []);

/**
 * Is the model this box names the one that was clicked?
 *
 * The two screens spell the same model differently — the picker's row is `Sonnet` with
 * `Sonnet 5 · Efficient for routine tasks` beside it, the confirmation says `Sonnet 5`;
 * `Default (recommended)` becomes `Opus 5 (1M context) (default)`. So the test is that
 * every word of the confirmation's name appears somewhere in the row's label or blurb,
 * which holds for all five rows and still tells option 1 from option 2 — only the default
 * row carries the word "default".
 *
 * @param {string} target the name in `Yes, switch to …`
 * @param {{label: string, description?: string|null}} option the row that was asked for
 */
export function confirmNames(target, option) {
  const want = words(target);
  if (!want.size || !option) return false;
  const have = words(`${option.label ?? ''} ${option.description ?? ''}`);
  for (const w of want) if (!have.has(w)) return false;
  return true;
}
