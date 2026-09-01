import { readOptionBlock } from './question.js';

/**
 * Reading the box that ends plan mode — "Claude has written up a plan…".
 *
 * The third numbered screen, and the third parser, because it answers like neither of the
 * other two. A permission box is a fixed run whose option 2 is always a *broader* yes. A
 * question box toggles, advances or submits depending on which of its layouts you are on.
 * This one is a plain single-select that commits on the digit — and its options are built
 * fresh at every render, so the run is anywhere from two to five rows and the labels move.
 *
 * All of this was verified rather than assumed: a scratch session driven into plan mode
 * gave the capture in `test/fixtures/dialog-plan-approve.txt`, pressing `2` by hand showed
 * that a digit selects *and* submits in one press, and the option list below is quoted out
 * of Claude Code v2.1.232's own builder, not reconstructed from what happened to be on
 * screen that day:
 *
 *   context full + bypass    Yes, clear context (N% used) and bypass permissions
 *   context full + auto      Yes, clear context (N% used) and use auto mode
 *   context full, neither    Yes, clear context (N% used) and auto-accept edits
 *   bypass available         Yes, and bypass permissions
 *   auto available           Yes, and use auto mode
 *   neither                  Yes, auto-accept edits
 *   always                   Yes, manually approve edits
 *   Ultraplan enabled        No, refine with Ultraplan on Claude Code on the web
 *   always (free text)       Tell Claude what to change
 *
 * Read that list twice before touching anything here. **The broad option comes first**,
 * which is the exact inverse of the permission box, and it is where the two genuinely
 * dangerous answers live: one turns permission prompts off for the rest of the session,
 * and the `clear context` variants throw the conversation away on the way past. A parser
 * that answered this screen by position would eventually do both at once.
 */

/** The three headers this box is drawn under. Recognition is one of these, and nothing else. */
const HEADERS = [
  /Claude has written up a plan and is ready to execute\.\s*Would you like to proceed\?/i,
  /Claude has written up a plan\.\s*Would you like to review it as an artifact first\?/i,
  /Claude wants to exit plan mode/i,
];

/** The free-text row's own sub-line. It is what tells that row apart from an answer. */
const FEEDBACK_HINT_RE = /shift\+tab to approve with this feedback/i;

/**
 * …and its label, as a second way in. `No, keep planning` is what it says once you type.
 *
 * A prefix match, not an exact one, because a narrow pane wraps these too — and getting
 * this row wrong is the worst outcome in the file: it would put a button behind a row that
 * opens a text input, press its digit, and leave a terminal nobody is watching waiting to
 * be typed into.
 */
const FEEDBACK_LABEL_RE = /^(?:tell claude what to|no, keep planning)/i;

/**
 * `ctrl+g to edit in Vim · ~/.claude/plans/add-a-farewell-quizzical-pie.md`
 *
 * The path is optional in the match because this line wraps too — in a 70-column pane the
 * separator ends one line and the filename starts the next.
 */
const PLAN_PATH_RE = /ctrl\+g\s+to\s+edit\s+in\s+\S+\s*·\s*(.*)$/i;

/**
 * How much a given answer costs you.
 *
 *   danger  turns permission prompts off, or clears the conversation, or both
 *   refine  leaves the machine — Ultraplan publishes the plan to Claude Code on the web
 *   narrow  the yes that keeps asking before it edits
 *   broad   a yes that stops asking about edits, but not about everything
 */
function toneOf(label) {
  const l = label.toLowerCase();
  if (/bypass permissions|clear context/.test(l)) return 'danger';
  if (/ultraplan/.test(l)) return 'refine';
  if (/manually approve/.test(l)) return 'narrow';
  return 'broad';
}

/**
 * @param {string} text raw `capture-pane` output
 * @returns {null | {kind, header, options, feedback, planPath, raw}}
 */
export function parsePlanPrompt(text) {
  const nonEmpty = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  if (!nonEmpty.length) return null;

  const block = readOptionBlock(nonEmpty);
  if (!block) return null;
  const { top, last, rows } = block;

  // The header sits above the run, and in a narrow pane it *wraps* — at 70 columns
  // "Claude has written up a plan and is ready to execute. Would you like" ends one line
  // and "to proceed?" begins the next. So match against the joined window rather than any
  // single line; a session in a split Terminal is exactly where this box goes unread.
  //
  // Requiring the whole sentence is still the point. A numbered list under a heading this
  // parser doesn't recognise must not be handed approval buttons, and joining a few lines
  // can't conjure that sentence out of anything else.
  let header = null;
  for (let i = top - 1; i >= 0 && top - i <= 4 && !header; i -= 1) {
    const joined = nonEmpty.slice(i, top).join(' ').replace(/\s+/g, ' ').trim();
    if (HEADERS.some((re) => re.test(joined))) header = joined;
  }
  if (!header) return null;

  // The free-text row is an answer box, not an answer, and it is always the last one — the
  // builder pushes it after everything else. Its sub-line sits *below* the block rather
  // than inside it, so `readOptionBlock` never attaches it and this has to look one line
  // past the run. The label is the second way in, because a row that opens a text input in
  // the terminal must not end up behind a button that presses its digit and walks away.
  // The legacy Yes/No variant has no such row at all.
  // A few lines, not one: the row above it may have wrapped and pushed the hint down.
  let trailing = null;
  for (let i = last + 1; i < nonEmpty.length && i - last <= 3 && !trailing; i += 1) {
    if (FEEDBACK_HINT_RE.test(nonEmpty[i])) trailing = nonEmpty[i].trim();
  }
  const lastRow = rows[rows.length - 1];
  const feedbackRow =
    rows.find((r) => r.description && FEEDBACK_HINT_RE.test(r.description)) ||
    (trailing || FEEDBACK_LABEL_RE.test(lastRow.label) ? lastRow : null);

  const options = rows.filter((r) => r !== feedbackRow);
  if (!options.length) return null;

  let planPath = null;
  for (let i = last + 1; i < nonEmpty.length && i - last <= 4; i += 1) {
    const m = PLAN_PATH_RE.exec(nonEmpty[i]);
    if (!m) continue;
    // Wrapped: the separator ended the line and the filename begins the next one.
    planPath = (m[1].trim() || (nonEmpty[i + 1] || '').trim()) || null;
    break;
  }

  return {
    kind: 'plan',
    header,
    options: options.map((o) => ({
      index: o.index,
      label: o.label,
      description: o.description || null,
      cursor: o.selected,
      tone: toneOf(o.label),
    })),
    feedback: feedbackRow
      ? {
          index: feedbackRow.index,
          label: feedbackRow.label,
          hint: feedbackRow.description || trailing,
        }
      : null,
    planPath,
    raw: nonEmpty.slice(Math.max(0, top - 2)),
  };
}

/**
 * The keys that answer this box.
 *
 * An option is sent as **its own digit**, read off the box, never as its position in the
 * list — the rule `permission.js` exists to enforce, and one this screen punishes harder
 * because its first row can be "clear context and bypass permissions".
 *
 * Feedback is the row's digit to open the input, the text, then `Enter`. Never `BTab`:
 * on that row `Enter` means *keep planning with this note* and `shift+tab` means *approve
 * the plan and pass the note along*, which are opposite answers to the question asked.
 *
 * `planAnswer` is taken: `question.js` already has one, and "plan" means something
 * different in each. This one is only ever about the plan-approval box.
 *
 * @param {object} box the parse
 * @param {{index?: number, feedback?: string}} choice
 * @returns {{keys: Array<string|{text: string}>, label: string}}
 */
export function approvalKeys(box, choice) {
  if (choice?.feedback != null) {
    const note = String(choice.feedback).trim();
    if (!note) throw new Error('Nothing to send.');
    if (!box.feedback) throw new Error('This plan box has no feedback row.');
    return {
      keys: [String(box.feedback.index), { text: note }, 'Enter'],
      label: 'keep planning, with a note',
    };
  }

  const option = box.options.find((o) => o.index === choice?.index);
  if (!option) throw new Error('That option is not on screen.');
  return { keys: [String(option.index)], label: option.label };
}
