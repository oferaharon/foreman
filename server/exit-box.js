/*
 * exit-box.js — the box `/exit` raises instead of exiting, when background work is running.
 *
 * Measured on Claude Code v2.1.296 in the sandbox's `alpha`, at 220×50 and at 80×23, with a
 * `run_in_background` shell and a Monitor live (`test/fixtures/dialog-exit-background*.txt`):
 *
 *     ────────────────────────────────────────
 *       Background work is running
 *       The following will stop when you exit:
 *       shell · sleep 600
 *       monitor · wait for the marker file
 *       ❯ 1. Exit and stop tasks
 *         2. Move to background and exit
 *         3. Stay
 *
 *       Enter to confirm · Esc to cancel
 *
 * What each key does, measured rather than assumed, and the first one is why this file exists:
 *
 *   - **a digit selects and submits.** `3` went straight back to the composer; there is no
 *     "move the cursor and wait for Enter". So a digit is never sent to this box.
 *   - `Down`/`Up` move the `❯` and **wrap** — `Down` from `3.` lands on `1.`.
 *   - `Enter` commits the row under the `❯`. On `Exit and stop tasks` the background shell
 *     was killed and the tmux name freed 1.2 s later.
 *   - `Esc` puts the session back on its composer with every task still running.
 *
 * It looks like a permission box — numbered rows over an `Enter to confirm · Esc to cancel`
 * footer — and `parsePrompt` read it as one until this file: three rows classed `other`,
 * drawn as three one-tap buttons answered by digit. Nothing on it is a yes, so no row was
 * armed as broad, but it is a box with a different contract from every other one, and the
 * five screen parsers keep refusing each other's boxes by recognising them, never by
 * loosening `OPTION_RE`. So: `isExitBox` is the witness, `permission.js` refuses on it, and
 * `parsePane` names it as a `dialog` — blocked, never a composer.
 *
 * The only thing in the panel that answers it is closing a task (`exitAndWait` in
 * `server/exit-session.js`): the close is already the order to end that session and delete
 * its folder, so it chooses `Exit and stop tasks` — by label, after reading where the cursor
 * is, with arrow keys only until the `❯` is on that row. `Move to background and exit` would
 * leave work running detached in a folder about to be deleted, and `Stay` is the orphan the
 * close used to leave behind.
 *
 * Pure: no imports, so `permission.js` can import it without a cycle through `tmux.js`.
 */

/** The box's own title, exactly as drawn. */
export const EXIT_BOX_TITLE = 'Background work is running';

/** The row the close answers with, by its label — never by its number. */
export const STOP_AND_EXIT = 'Exit and stop tasks';

const TITLE_RE = /^\s*Background work is running\s*$/;
const LEAD_RE = /^\s*The following will stop when you exit:\s*$/;
const FOOTER_RE = /^\s*Enter to confirm · Esc to cancel\s*$/;
/**
 * One line of the list: `<kind> · <what>` — `shell · sleep 600`, `monitor · …`, and the
 * cron box's `scheduled task · Every 30 minutes · …` (`docs/traps/launch.md`). Required of
 * every line between the lead and the rows, which is what stops a box drawn below scrollback
 * that *mentions* this one from reading as it.
 */
const ITEM_RE = /^\s*\S.*?\s·\s\S/;
/** This box's rows. Its own pattern, deliberately — `OPTION_RE` is not borrowed or widened. */
const ROW_RE = /^\s*(❯)?\s*(\d)\.\s+(\S.*?)\s*$/;
const RULE_RE = /^\s*─{6,}\s*$/;

/** How many tasks the list may name before this stops believing it is the list. */
const MAX_ITEMS = 16;

/**
 * Read the box off the pane, or `null` for any other screen.
 *
 * Anchored at both ends of the box: the footer must be among the last three non-empty lines
 * (so a box scrolled into the backlog is not a live one), the rows directly above it must be
 * a clean `1..N` run, every line above them up to the lead must be a `<kind> · <what>` item,
 * and the lead and the title must sit directly above that — under the box's top rule. Any
 * line that breaks the shape is a refusal, never a guess.
 *
 * @param {string} text raw `capture-pane -p` output
 * @returns {null | {title: string, stopping: string[], options: Array<{index: number, label: string, selected: boolean}>, cursor: number|null}}
 */
export function parseExitBox(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  const footer = lines.length - 1 - lines.slice(-3).reverse().findIndex((l) => FOOTER_RE.test(l));
  if (footer >= lines.length) return null;

  // Rows, walking up from the footer.
  const options = [];
  let i = footer - 1;
  for (; i >= 0; i -= 1) {
    const m = ROW_RE.exec(lines[i]);
    if (!m) break;
    options.unshift({ index: Number(m[2]), label: m[3], selected: Boolean(m[1]) });
  }
  if (options.length < 2 || options.some((o, n) => o.index !== n + 1)) return null;

  // The list, then the lead, then the title, then the rule — nothing else in between.
  const stopping = [];
  for (; i >= 0 && ITEM_RE.test(lines[i]) && !LEAD_RE.test(lines[i]); i -= 1) {
    stopping.unshift(lines[i].trim());
    if (stopping.length > MAX_ITEMS) return null;
  }
  if (i < 1 || !LEAD_RE.test(lines[i]) || !TITLE_RE.test(lines[i - 1])) return null;
  if (i >= 2 && !RULE_RE.test(lines[i - 2])) return null;

  return {
    title: EXIT_BOX_TITLE,
    stopping,
    options,
    cursor: options.find((o) => o.selected)?.index ?? null,
  };
}

/**
 * Is this screen the background-work box? The witness every other parser refuses on.
 *
 * Deliberately looser than `parseExitBox` in one place only: it does not need the rows to
 * read. A later Claude Code that adds a row or wraps a label must still be refused by
 * `parsePrompt` and still be recognised by the close (which then Escapes it rather than
 * answering), so the witness walks up from the live footer through numbered rows — and any
 * deeper-indented line a wrapped label would leave — then the list, and needs the lead and
 * the title directly above. Walking *up from the footer*, rather than searching for the
 * title, is what keeps a copy of this box in the scrollback from vouching for a different
 * box drawn below it: the trust gate shares this footer exactly.
 *
 * @param {string} text raw `capture-pane -p` output
 */
export function isExitBox(text) {
  if (parseExitBox(text)) return true;
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  const footer = lines.length - 1 - lines.slice(-3).reverse().findIndex((l) => FOOTER_RE.test(l));
  if (footer >= lines.length) return false;

  const indent = (l) => l.length - l.trimStart().length;
  let i = footer - 1;
  let rows = 0;
  for (; i >= 0 && footer - i <= 12; i -= 1) {
    const l = lines[i];
    if (ROW_RE.test(l)) rows += 1;
    else if (indent(l) < 4 || LEAD_RE.test(l) || TITLE_RE.test(l) || RULE_RE.test(l)) break;
  }
  if (!rows) return false;
  for (let n = 0; i >= 0 && n <= MAX_ITEMS && ITEM_RE.test(lines[i]) && !LEAD_RE.test(lines[i]); n += 1) i -= 1;
  return i >= 1 && LEAD_RE.test(lines[i]) && TITLE_RE.test(lines[i - 1]);
}

/**
 * The row that stops the tasks and exits, by its own label, or `null` when the box does not
 * offer it — in which case nothing on it is pressed but `Escape`.
 *
 * @param {ReturnType<typeof parseExitBox>} box
 */
export function stopAndExitOption(box) {
  return box?.options.find((o) => o.label === STOP_AND_EXIT) ?? null;
}
