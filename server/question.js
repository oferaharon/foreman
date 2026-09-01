/**
 * Reading Claude Code's question box off the pane — the one `AskUserQuestion` puts up
 * when Claude asks *you* something.
 *
 * It looks almost exactly like a permission box and behaves nothing like one, which is
 * the whole reason this is a separate module. `permission.js` deliberately refuses these
 * (their option run breaks at a rule), and it must keep refusing them: its answer is a
 * single digit meaning "approve", while here a digit can mean toggle, advance, or submit
 * depending on which screen you are on.
 *
 * Three screens, all verified by hand against v2.1.232:
 *
 *   Single-select                      Multi-select                 Review
 *   ─────────────                      ────────────                 ──────
 *    ☐ Lunch                            ☐ Breakfast  ✔ Submit        ☒ Breakfast ✔ Submit
 *    What's the plan for lunch?         What are you in the mood…    Review your answers
 *    ❯ 1. Sandwich                      ❯ 1. [ ] Eggs & toast         ● What are you…
 *      2. Hot meal                        2. [✔] Pastry & coffee        → Pastry & coffee
 *      3. Skip it                         3. [ ] Yogurt & fruit       Ready to submit…?
 *      4. Type something.                 4. [ ] Just coffee          ❯ 1. Submit answers
 *      ──────────────                     5. [ ] Type something         2. Cancel
 *      5. Chat about this                    Submit
 *    Enter to select · ↑/↓ …              ──────────────
 *                                         6. Chat about this
 *
 * Keystrokes, all of them addressed by the option's own digit and never by cursor
 * position — the same rule that keeps `permission.js` honest:
 *
 *   single-select  digit            selects *and* submits, in one press
 *   with a preview digit            moves the cursor only; `Enter` is what selects
 *   multi-select   digit            toggles that row; the cursor does not move
 *                  Tab              opens the review screen
 *                  1                submits · 2 cancels
 *   a set of questions              a single-select digit advances to the next question
 *                                   rather than submitting
 *
 * The review screen carries no key-hint footer at all, which is why `parsePane` decides
 * "a dialog owns the pane" from the *absence of the composer* rather than from hints.
 */

/** ` ❯ 1. [ ] Eggs & toast` / `   2. Hot meal` — the leading `❯` marks the cursor. */
const OPTION_RE = /^\s*(❯)?\s*(\d{1,2})\.\s+(?:\[([ ✔x])\]\s+)?(.+?)\s*$/;

/** The tab strip: `←  ☒ Drink  ☐ Snacks  ✔ Submit  →`. Only a question set draws it. */
const TAB_STRIP_RE = /(?:^|\s)[←→]\s|\s[☐☒]\s\S/;

/** Solid rule. A question box fences its escape hatch off with one. */
const RULE_RE = /^\s*[─━╌┄]{3,}\s*$/;

/** Rows that are not answers: the free-text row and the bail-out row. */
const TYPE_SOMETHING_RE = /^type something\.?$/i;
const CHAT_ABOUT_RE = /^chat about this\.?$/i;

/** The review screen, which is its own thing and answers with 1 / 2. */
const REVIEW_HEAD_RE = /^\s*Review your answers\s*$/i;

/** Full-width solid rule — the top and bottom edge of the question box. */
const BOX_EDGE_RE = /^\s*─{20,}\s*$/;

/** A box-drawing glyph opening a preview panel to the right of the options. */
const PANEL_RE = /\s{2,}([┌└├┤│╭╰╯╮┐┘])/;

/**
 * Newer question boxes draw a *preview* panel to the right of the options — an ASCII
 * mock-up of what each answer would look like. `capture-pane` gives it to us welded onto
 * the option lines themselves (`1. Hover menu on the folder     ┌────────┐`), which both
 * corrupts every label and pushes the option run out of the tail window the block finder
 * looks in.
 *
 * So: find the column the panel starts at and cut every line in the box back to it.
 * Detection is confined to the box itself (from its top edge down), because the welcome
 * banner higher up the scrollback is also a column of `│` and truncating the transcript
 * at it would be a silent corruption.
 *
 * @returns {{lines: string[], hadPanel: boolean}}
 */
function stripPreviewPanel(lines) {
  const edges = lines.map((l, i) => (BOX_EDGE_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!edges.length) return { lines, hadPanel: false };
  // The box is fenced by its last two rules; with only one, everything below it.
  const from = edges.length > 1 ? edges[edges.length - 2] : edges[edges.length - 1];

  const counts = new Map();
  for (let i = from; i < lines.length; i += 1) {
    const m = PANEL_RE.exec(lines[i]);
    if (!m) continue;
    const col = m.index + m[0].length - 1;
    if (col > 0) counts.set(col, (counts.get(col) || 0) + 1);
  }
  let col = -1;
  for (const [c, n] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (n >= 3 && (col < 0 || n > counts.get(col))) col = c;
  }
  if (col < 0) return { lines, hadPanel: false };

  // Cut only from the panel's own first row down. The question sits *above* the panel
  // and is full-width; truncating it at the panel column would behead it.
  let start = lines.length;
  for (let i = from; i < lines.length; i += 1) {
    const m = PANEL_RE.exec(lines[i]);
    if (m && m.index + m[0].length - 1 === col) { start = i; break; }
  }

  const out = lines.slice();
  for (let i = start; i < out.length; i += 1) {
    if (out[i].length > col) out[i] = out[i].slice(0, col).replace(/\s+$/, '');
  }
  return { lines: out, hadPanel: true };
}

/**
 * The numbered block at the foot of a box, read into rows.
 *
 * Shared with `plan.js`, which faces the same layout for a different screen — the plan
 * approval that ends plan mode is also a run of numbered options with description lines
 * under some of them. This is the subtle part of both parsers, so there is one of it.
 *
 * @param {string[]} nonEmpty the capture with blank lines dropped
 * @param {{hadPanel?: boolean}} [opts]
 * @returns {null | {top: number, last: number, rows: Array<{index, checkbox, label, selected, description}>}}
 */
export function readOptionBlock(nonEmpty, { hadPanel = false } = {}) {
  // The last numbered row is not the last line — a key-hint footer usually follows it —
  // so locate that row first and work outwards from there.
  let last = -1;
  for (let i = nonEmpty.length - 1; i >= 0 && nonEmpty.length - i < 8; i -= 1) {
    if (OPTION_RE.test(nonEmpty[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;

  // Walk up to the top of the block. It tolerates description lines and *one* rule —
  // a question box fences its "Chat about this" escape hatch off with one, which is the
  // very thing that stops `permission.js` reading these as a clean 1..N run.
  let top = last;
  let rules = 0;
  for (let i = last - 1; i >= 0 && last - i < 40; i -= 1) {
    const line = nonEmpty[i];
    if (OPTION_RE.test(line)) {
      top = i;
      continue;
    }
    if (RULE_RE.test(line)) {
      if (rules) break;
      rules += 1;
      continue;
    }
    if (/^\s{2,}\S/.test(line) && !TAB_STRIP_RE.test(line)) continue; // a description
    break;
  }

  // Now read the block in reading order, so a description attaches to the option above it.
  const rows = [];
  for (let i = top; i <= last; i += 1) {
    const m = OPTION_RE.exec(nonEmpty[i]);
    if (m) {
      rows.push({
        index: Number(m[2]),
        checkbox: m[3] ?? null,
        label: m[4].trim(),
        selected: Boolean(m[1]),
        description: null,
      });
    } else if (rows.length && !RULE_RE.test(nonEmpty[i])) {
      const prev = rows[rows.length - 1];
      // With a preview panel present the descriptions live *in* the panel, so a stray
      // line here is the tail of a wrapped label, not a description of its own.
      //
      // Either way it accumulates. A description is one sentence the terminal happened to
      // wrap over three lines, and keeping only the first ended cards mid-clause —
      // "the undeposited medical POA dying at one year," and then nothing.
      if (hadPanel) prev.label = `${prev.label} ${nonEmpty[i].trim()}`.trim();
      else prev.description = `${prev.description ? `${prev.description} ` : ''}${nonEmpty[i].trim()}`;
    }
  }

  if (rows.length < 2) return null;
  // Must be a clean 1..N run, or we have matched something that merely looks like a list.
  if (rows.some((r, n) => r.index !== n + 1)) return null;
  return { top, last, rows };
}

/**
 * @param {string} text raw `capture-pane` output
 * @returns {null | {kind, question, options, multiSelect, chosen, submitIndex, cancelIndex, questions, raw}}
 */
export function parseQuestion(text) {
  const { lines, hadPanel } = stripPreviewPanel(
    text.split('\n').map((l) => l.replace(/\s+$/, '')),
  );
  const nonEmpty = lines.filter((l) => l.trim());
  if (!nonEmpty.length) return null;

  const review = parseReview(nonEmpty);
  if (review) return review;

  const block = readOptionBlock(nonEmpty, { hadPanel });
  if (!block) return null;
  const { top, rows } = block;

  // A question box always offers a way out that a permission prompt never does: the
  // free-text row, the `Chat about this` escape hatch, or the notes hint in the footer.
  // Requiring the free-text row alone was too strict — the preview-panel layout drops it,
  // and leaves `Chat about this` unnumbered. Without *any* of the three this is some
  // other numbered list and must not get answer buttons.
  //
  // The numbered chat row is checked as a *row* as well as a raw line, and that matters
  // more than it looks: the moment anyone types into the free-text row — in the terminal,
  // or through this panel — its label stops being "Type something." and becomes the text.
  // With only the other three tests, a box mid-answer stopped parsing as a question at all
  // and the card vanished from under whoever was typing into it.
  const escapeHatch =
    rows.some((r) => TYPE_SOMETHING_RE.test(r.label) || CHAT_ABOUT_RE.test(r.label)) ||
    nonEmpty.some((l) => CHAT_ABOUT_RE.test(l.trim())) ||
    nonEmpty.slice(-2).some((l) => /to add notes|to switch questions/i.test(l));
  if (!escapeHatch) return null;

  const question = questionAbove(nonEmpty, top);
  if (!question) return null;

  const options = rows.filter(
    (r) => !TYPE_SOMETHING_RE.test(r.label) && !CHAT_ABOUT_RE.test(r.label),
  );
  if (!options.length) return null;

  const freeText = rows.find((r) => TYPE_SOMETHING_RE.test(r.label)) || null;
  const chat = rows.find((r) => CHAT_ABOUT_RE.test(r.label)) || null;

  // Checkboxes are the tell. A single-select draws none, and answers in one press.
  const multiSelect = options.every((o) => o.checkbox !== null);

  // The preview layout navigates differently, and this is the trap in it: a digit only
  // *moves the cursor*, and `Enter` is what selects. Verified both ways in a scratch
  // session — a plain box (`Enter to select · Tab/Arrow keys to navigate`) selects and
  // advances on the digit alone, while the preview box (`… · n to add notes · Tab to
  // switch questions`) sat there with the cursor moved and nothing chosen.
  const needsConfirm =
    hadPanel || nonEmpty.slice(-2).some((l) => /\bn to add notes\b/i.test(l));

  return {
    kind: 'question',
    question,
    multiSelect,
    options: options.map((o) => ({
      index: o.index,
      label: o.label,
      description: o.description || null,
      checked: o.checkbox ? o.checkbox !== ' ' : false,
      cursor: o.selected,
    })),
    needsConfirm,
    chosen: options.filter((o) => o.checkbox && o.checkbox !== ' ').map((o) => o.index),
    freeTextIndex: freeText?.index ?? null,
    chatIndex: chat?.index ?? null,
    questions: parseTabStrip(nonEmpty),
    raw: nonEmpty.slice(Math.max(0, top - 3)),
  };
}

/**
 * `Review your answers` — where a multi-select ends up after Tab. Two options, and the
 * digits mean something entirely different from the ones on the question screen, so this
 * is reported as its own kind rather than folded in.
 */
function parseReview(nonEmpty) {
  const headAt = nonEmpty.findIndex((l) => REVIEW_HEAD_RE.test(l));
  if (headAt < 0) return null;

  const rows = [];
  for (let i = headAt + 1; i < nonEmpty.length; i += 1) {
    const m = OPTION_RE.exec(nonEmpty[i]);
    if (m) rows.push({ index: Number(m[2]), label: m[4].trim() });
  }

  const submit = rows.find((r) => /^submit\b/i.test(r.label));
  const cancel = rows.find((r) => /^cancel\b/i.test(r.label));
  if (!submit || !cancel) return null;

  // `● What would you like to drink?` / `  → Tea` — what is about to be sent.
  const answers = [];
  for (let i = headAt + 1; i < nonEmpty.length; i += 1) {
    const q = /^\s*●\s*(.+?)\s*$/.exec(nonEmpty[i]);
    if (!q) continue;
    const a = /^\s*→\s*(.+?)\s*$/.exec(nonEmpty[i + 1] || '');
    answers.push({ question: q[1], answer: a ? a[1] : null });
  }

  return {
    kind: 'review',
    question: 'Ready to submit your answers?',
    multiSelect: false,
    options: [],
    answers,
    submitIndex: submit.index,
    cancelIndex: cancel.index,
    questions: parseTabStrip(nonEmpty),
    raw: nonEmpty.slice(headAt),
  };
}

/** `←  ☒ Drink  ☐ Snacks  ✔ Submit  →` — the questions in this set, and which are done. */
function parseTabStrip(nonEmpty) {
  // It sits just above the box, not at the top of the capture — and a `→` in the
  // transcript above would otherwise be mistaken for it.
  const line = nonEmpty.slice(-30).find((l) => TAB_STRIP_RE.test(l));
  if (!line) return [];
  const out = [];
  for (const m of line.matchAll(/([☐☒])\s+([^☐☒✔←→]+?)(?=\s{2,}|\s*[☐☒✔←→]|$)/g)) {
    out.push({ label: m[2].trim(), answered: m[1] === '☒' });
  }
  return out;
}

/**
 * The question itself: the lines above the options that aren't chrome, joined.
 *
 * Plural, because a question long enough to matter wraps. Taking only the nearest line
 * showed *"lighter preparation-and-reminder track?"* on a card whose terminal was asking
 * "Should durable_power_of_attorney be a full first-class workflow, or a lighter
 * preparation-and-reminder track?" — the half that carried the subject was the half that
 * got dropped, and the card read as a fragment of someone else's sentence.
 *
 * The box's own chrome is the top edge: the tab strip, or the rule it draws under the
 * transcript. Skipping past those is only safe *before* anything has been collected —
 * once inside the question, a rule means the question started here, and stepping over it
 * would splice a wrapped assistant line onto the front.
 */
function questionAbove(nonEmpty, top) {
  const lines = [];
  for (let i = top - 1; i >= 0 && top - i < 9; i -= 1) {
    const line = nonEmpty[i];
    if (RULE_RE.test(line) || TAB_STRIP_RE.test(line)) {
      if (lines.length) break;
      continue;
    }
    const t = line.trim();
    if (!t || /^[⏺✻✳✽❯⎿⚠·]/.test(t)) break;
    lines.unshift(t);
  }
  return lines.length ? lines.join(' ') : null;
}

function attachDescription(rows, line) {
  const last = rows[0];
  if (last && !last.description) last.description = line.trim();
}

/**
 * The keystrokes that answer a box, given what is on screen and what was chosen.
 *
 * Returns a plan rather than sending anything, so the caller can re-read the pane between
 * steps and abandon the whole thing if it stopped matching. Nothing here is positional:
 * every key is an option's own digit.
 *
 * @param {object} box   the parsed question screen
 * @param {number[]} picks option indexes the user chose
 * @returns {{keys: string[], needsReview: boolean}}
 */
export function planAnswer(box, picks) {
  if (!box || box.kind !== 'question') throw new Error('Not a question box.');
  if (!picks.length) throw new Error('Nothing was chosen.');

  const known = new Set(box.options.map((o) => o.index));
  for (const p of picks) {
    if (!known.has(p)) throw new Error(`Option ${p} is not on screen.`);
  }

  if (!box.multiSelect) {
    if (picks.length > 1) throw new Error('This question takes a single answer.');
    // One press. It selects and submits — or, in a set, moves to the next question.
    // Unless the box draws previews, where the digit only moves the cursor and `Enter`
    // is the press that commits.
    const keys = [String(picks[0])];
    if (box.needsConfirm) keys.push('Enter');
    return { keys, needsReview: false };
  }

  // Toggling is relative to what is already ticked, because the box remembers.
  const wanted = new Set(picks);
  const keys = [];
  for (const option of box.options) {
    if (wanted.has(option.index) !== option.checked) keys.push(String(option.index));
  }
  return { keys, needsReview: true };
}

/**
 * "Chat about this" — the way out when none of the options is the answer.
 *
 * The row below the rule, and the only one of the two escape hatches that behaves the same
 * on every layout: one press declines the whole tool call (`User declined to answer
 * questions`), the box closes and the composer comes back free to type into. Verified by
 * hand on a single-select and on a multi-select, where every *other* digit merely toggles.
 *
 * It is the one thing a panel user cannot otherwise do — while the box is up the composer
 * queues rather than sends, so "just reply in words" is unavailable until something closes
 * it. The preview-panel layout draws this row unnumbered; there `chatIndex` is null and
 * there is nothing to offer.
 */
export function planChat(box) {
  if (!box || box.kind !== 'question') throw new Error('Not a question box.');
  if (!box.chatIndex) throw new Error('This box offers no "Chat about this" row.');
  return { keys: [String(box.chatIndex)] };
}

/**
 * "Type something." — an answer in your own words, which is three steps and not one.
 *
 * Measured, because nothing on screen says any of it: pressing the row's digit does **not**
 * submit and does **not** toggle — it moves the cursor onto the row and turns it into a
 * text field (the footer grows `ctrl+g to edit in Vim`, which is the tell). What you type
 * replaces the row's label, and `Enter` sends it as the answer.
 *
 * Single-select only, and that is not caution: on a multi-select the same digit just
 * *ticks* the row, cursor unmoved, no editor — so the panel would type into a box that
 * isn't listening. Offer it there and the text lands somewhere unpredictable.
 *
 * Returns the steps separately so the caller can re-read the pane between them and stop
 * with the text typed and nothing submitted, which is a state you can finish in the
 * terminal.
 */
export function planFreeText(box, text) {
  if (!box || box.kind !== 'question') throw new Error('Not a question box.');
  if (box.multiSelect) {
    throw new Error('This question takes ticks, not typing — its free-text row only toggles.');
  }
  if (!box.freeTextIndex) throw new Error('This box offers no free-text row.');

  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('Nothing was typed.');
  if (clean.length > 500) throw new Error('That is too long for the box — say it in the chat instead.');

  return { open: String(box.freeTextIndex), text: clean, submit: 'Enter' };
}
