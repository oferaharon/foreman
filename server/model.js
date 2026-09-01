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
 * @param {string} text raw `capture-pane` output
 * @returns {null | {kind, options, cursorIndex, currentIndex}}
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

  const block = readOptionBlock(nonEmpty);
  if (!block) return null;
  const { top, rows } = block;

  let titled = false;
  for (let i = top - 1; i >= 0 && top - i <= 6; i -= 1) {
    if (TITLE_RE.test(nonEmpty[i])) {
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
      index: r.index,
      label: name,
      description: tail.join(' ').trim() || null,
      current: /✔/.test(head),
      cursor: r.selected,
    };
  });

  return {
    kind: 'model',
    options,
    cursorIndex: options.find((o) => o.cursor)?.index ?? null,
    currentIndex: options.find((o) => o.current)?.index ?? null,
  };
}

/**
 * Which way to step, and how far, to get the cursor from `from` to `to`.
 *
 * Returned as a plan rather than executed, so the caller can press one key, re-read, and
 * ask again — a count computed once and fired blind is the thing this avoids.
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
