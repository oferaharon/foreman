/**
 * Reading Claude Code's permission box off the pane.
 *
 * These prompts never reach the transcript, so the rendered TUI is the only source.
 * They matter more than the rest of the scraping: answering one blindly can approve
 * something — v1 sent `Down, Enter` for "deny", which lands on option 2, and option 2
 * is reliably a *broader* yes ("Yes, and don't ask again", "Yes, allow all edits").
 *
 * So nothing here guesses. We parse the real options, and answer by typing the option's
 * own digit — which Claude Code accepts directly, with no cursor assumptions. If the box
 * cannot be parsed with confidence, we report that instead of offering buttons.
 *
 * Shape (verified against v2.1.232, Bash and Edit prompts):
 *
 *   ────────────────────────────────
 *    Bash command                     <- title
 *      chmod 755 sample.txt           <- subject / detail
 *      Set permissions on sample.txt
 *    This command requires approval
 *    Do you want to proceed?          <- question
 *    ❯ 1. Yes                         <- options, ❯ marks the cursor
 *      2. Yes, and don't ask again for: chmod 755 *
 *      3. No
 *    Esc to cancel · Tab to amend     <- footer
 */

/** The footer is the only reliable "a prompt is open right now" marker. */
const FOOTER_RE = /(Esc to cancel|Enter to confirm|esc to reject)/i;

/** ` ❯ 1. Yes` / `   3. No` */
const OPTION_RE = /^\s*(❯)?\s*(\d{1,2})\.\s+(.+?)\s*$/;

/**
 * Two kinds of rule, and the difference matters: a solid rule is the top of the box,
 * a dashed one only separates sections inside it (an Edit prompt fences its diff that
 * way). Stopping at a dashed rule would throw away the title.
 */
const BOX_EDGE_RE = /^\s*[─━╭╰│╮╯]{3,}/;
const INNER_RULE_RE = /^\s*[╌┄]{3,}/;
const RULE_RE = /^\s*[─╌━┄╭╰│╮╯]{3,}/;

/** Lines that belong to the transcript above the box, not the box itself. */
const TRANSCRIPT_RE = /^\s*[⏺✻✳✽❯⎿⚠]/;

/**
 * A yes that changes the session's *mode* rather than granting one more rule. `switch to
 * auto mode` is the one seen in the wild; `bypass permissions` is the plan box's row of
 * the same shape, matched here so the day it appears on a permission box it is not a
 * surprise.
 */
const MODE_RE = /switch to .+ mode|bypass permissions/;

/**
 * The bare yes: `Yes`, and nothing after it but punctuation or a key hint. This is the
 * only approval that grants exactly the call in front of you.
 */
const NARROW_YES_RE = /^yes[\s.!]*(\([^)]*\))?[\s.!]*$/;

/** The trust gate's own yes — see the carve-out in `classify`. */
const TRUST_RE = /^yes,?\s+i trust\b/;

/**
 * How much does this option grant?
 *
 * The rule is **structural, not a phrase list**, and that inversion is the fix. The plain
 * `Yes` is the only narrow approval; every yes that qualifies itself is saying out loud
 * what more it grants. v1 of this function tested five phrases — `ask again|allow
 * all|always|this session|add.*allowlist` — and a real four-option Bash prompt walked
 * straight past all of them (`test/fixtures/prompt-bash-broad.txt`, captured live):
 *
 *     1. Yes
 *     2. Yes, allow reading from /private/tmp from this project      <- a standing rule
 *     3. Yes, and switch to auto mode · auto mode handles these…     <- stops the asking
 *     4. No
 *
 * Both came back plain `approve`, and `buildDecisionBar` therefore drew them as ordinary,
 * unstyled, one-tap buttons. A phrase list can only know the phrases it has already met,
 * and this box was the sixth. Appending two more regexes would leave the seventh.
 *
 * **Which way the rule errs is the whole argument.** A yes wrongly called broad costs one
 * extra click. A yes wrongly called narrow is a standing rule — or, on option 3, permission
 * prompts switched off for the rest of the session — bought with one click on a button that
 * looked like the safe default, from anything that can reach the panel on the LAN. So the
 * qualifier is read as the warning it is, and the burden of proof sits on being narrow.
 *
 * **Three kinds, not two**, because these are not one risk:
 *
 *   | kind             | what a click buys                                     |
 *   | ---------------- | ----------------------------------------------------- |
 *   | `approve`        | this call, and nothing else                           |
 *   | `approve-always` | a rule that outlives the call — a path, a project, a session, a tool |
 *   | `approve-mode`   | the session stops asking at all                       |
 *
 * `approve-always` keeps exactly the meaning it had; nothing that was already broad has
 * been loosened to make room. The third exists because "you may read this tree from now on"
 * and "never ask me anything again" want to be drawn differently, and folding the second
 * into the first would have been the same mistake one level up.
 *
 * **One carve-out**: the trust gate's `Yes, I trust this folder`. It is a qualified yes and
 * it is a standing decision, and it stays `approve` all the same, because that screen is
 * refused rather than classified. `web/trust-gate.js` is the witness — the desktop
 * composer, the phone's cards and `POST /api/sessions/:id/answer` all check it and hand
 * the gate a card with nothing on it to press — and it reads labels and copy, never a
 * `kind`, so nothing here decides whether that box is answerable. What a `kind` still
 * decides is what `test/pane.test.js` pins as the parser's measured output on those two
 * captures, and moving it would be changing a recorded measurement to no purpose.
 *
 * (An earlier draft of this paragraph credited the stance to `paneStartupPrompt`. That
 * function has never existed in this repo — it is the other launcher's, and the claim travelled
 * through `CLAUDE.md` as prose until the trust-gate work found the button still being
 * drawn. Cite `web/trust-gate.js`, which is code.)
 */
function classify(label) {
  const l = label.toLowerCase();
  if (/^no\b|^don'?t|^cancel/.test(l)) return 'deny';
  if (!/^yes\b/.test(l)) return 'other';
  if (MODE_RE.test(l)) return 'approve-mode';
  if (TRUST_RE.test(l)) return 'approve';
  return NARROW_YES_RE.test(l) ? 'approve' : 'approve-always';
}

/**
 * @param {string} text  raw `capture-pane` output
 * @returns {null | {title, subject, detail, question, options, cursor, raw}}
 */
export function parsePrompt(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+$/, ''));

  // Find the footer among the last few non-empty lines. Anything older is scrollback
  // from a prompt that has already been answered.
  const nonEmptyIdx = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  const tail = nonEmptyIdx.slice(-3);
  const footerIdx = tail.find((i) => FOOTER_RE.test(lines[i]));
  if (footerIdx === undefined) return null;

  /*
   * Walk up from the footer collecting the contiguous run of numbered options — and join
   * the tail of any label that wrapped.
   *
   * Pane width is an input to every parser here, and at 70 columns the same box reads
   * (`test/fixtures/prompt-bash-broad-narrow.txt`):
   *
   *     3. Yes, and switch to auto mode · auto mode handles these prompts
   *        for you
   *     4. No
   *
   * The walk used to break on `for you`, hand back a one-option "run", fail the two-option
   * floor and return null — so on a narrow terminal the panel drew "the prompt could not
   * be read" over a perfectly ordinary box. `question.js` learned this from the other end
   * ("A question wraps, and so do its options"); this is the same lesson, one box over.
   *
   * A tail is joined onto the option *above* it — we meet it first, walking up, so it is
   * carried until that option arrives — and only when it is indented at least as far as
   * that option's own label. A line that doesn't line up is body text, and a box we can't
   * line up is one we decline to read rather than one we guess at. The window is wide
   * enough for a five-option box that wraps twice a row; what makes the run safe is the
   * contiguity, the alignment and the 1..N check below, never the window.
   */
  const indentOf = (line) => line.length - line.trimStart().length;
  const options = [];
  let carry = []; // a wrapped tail, waiting for the option it belongs to
  let i = footerIdx - 1;
  for (; i >= 0 && footerIdx - i < 24; i -= 1) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line between a tail and an option means it was never that option's tail.
      if (carry.length) break;
      continue;
    }
    const m = OPTION_RE.exec(line);
    if (!m) {
      const wrapped =
        options.length > 0 &&
        carry.length < 4 &&
        indentOf(line) >= 4 &&
        !line.trim().endsWith('?') && // the question, not a tail
        !RULE_RE.test(line) &&
        !TRANSCRIPT_RE.test(line);
      if (!wrapped) break;
      carry.unshift(line);
      continue;
    }
    // Lines are right-trimmed above and OPTION_RE takes the rest of the line, so the
    // label's column is exact rather than searched for.
    const labelCol = line.length - m[3].length;
    if (carry.some((c) => indentOf(c) < labelCol)) break;
    const label = [m[3], ...carry.map((c) => c.trim())].join(' ');
    carry = [];
    options.unshift({
      index: Number(m[2]),
      label,
      kind: classify(label),
      selected: Boolean(m[1]),
    });
  }

  // Two options minimum, and they must be a clean 1..N run — otherwise we've matched
  // something that merely looks like a list and must not offer buttons for it.
  if (options.length < 2) return null;
  if (options.some((o, n) => o.index !== n + 1)) return null;

  // The question is the nearest line above the options that reads as one.
  let question = null;
  let bodyEnd = i;
  for (let j = i; j >= 0 && i - j < 8; j -= 1) {
    const line = lines[j];
    if (!line.trim() || RULE_RE.test(line)) continue;
    if (line.trim().endsWith('?')) {
      question = line.trim();
      bodyEnd = j - 1;
    }
    break;
  }

  // Everything from the box's top edge down to the question is the body.
  const body = [];
  for (let j = bodyEnd; j >= 0 && bodyEnd - j < 24; j -= 1) {
    const line = lines[j];
    if (INNER_RULE_RE.test(line)) continue; // a section divider, keep walking
    if (BOX_EDGE_RE.test(line)) break;
    if (TRANSCRIPT_RE.test(line)) break;
    if (line.trim()) body.unshift(line.trim());
  }

  const title = body[0] || null;
  const subject = body[1] || null;

  return {
    title,
    subject,
    detail: body.slice(2),
    question,
    options,
    cursor: options.find((o) => o.selected)?.index ?? null,
    raw: lines.slice(Math.max(0, bodyEnd - 20), footerIdx + 1).filter((l) => l.trim()),
  };
}

/**
 * The keystroke that selects an option. Typing the digit is exact — it needs no
 * knowledge of where the cursor currently sits, which is the whole point.
 */
export function keyForOption(prompt, index) {
  const opt = prompt?.options?.find((o) => o.index === index);
  if (!opt) return null;
  return String(index);
}
