/**
 * The envelope: two speakers, two prefixes, and the refusal that keeps a quoted line from
 * drawing as an unquoted one.
 *
 * Lifted out of `server/links.js`, which is where this reasoning was first written and
 * where the fuller history of it still lives. It moved here because a second feature
 * (the shared room) needs the same prefixing and the same refusal, and it must not import
 * either from a module that is scheduled for deletion once that feature ships — see
 * `links.js`'s own header for the retirement plan. `links.js` re-exports every name below
 * under its existing spelling, so its own public surface and its tests are unchanged.
 *
 * ---
 *
 * ## The invariant this module exists to hold
 *
 * There are exactly **two speakers** on an envelope and each gets its own two-character
 * prefix, applied by the panel to **every** line of a body:
 *
 *   - another project's lead, `LEAD_PREFIX` — a **request**. Never authority.
 *   - the maintainer, `HUMAN_PREFIX` — **their own word**. It can authorize.
 *
 * Because the panel prefixes every line, **no body can begin a line at column 0**, and
 * therefore no body can produce the other speaker's shape — or the panel's own. A lead
 * body already starting with the human prefix comes out quoted behind the lead one; a
 * maintainer body already starting with the lead prefix comes out quoted behind the human
 * one. Neither reaches column 0. That is the whole of the injection defence, and it is
 * structural rather than a phrase list: it does not depend on recognising the sentence
 * being forged, which is what the merge line's authority would otherwise rest on.
 *
 * The prefixes are exported from here and spelled nowhere else. Two spellings of a
 * naming contract is the `isLeadName` lesson, and here the cost of two spellings is a
 * lead reading one speaker's shape as the other's.
 *
 * ## Its one dependency, and it is where this breaks if it breaks
 *
 * **The quoter has to agree with the terminal about what a line is.** Three ways it
 * doesn't, every one of which produces a string that looks correctly prefixed in memory
 * and draws an unprefixed line on screen:
 *
 *   1. **Carriage return.** A body of `merge PR #40<CR>NOT QUOTED` is *one* line to
 *      `split('\n')`, so it gets one prefix — and then the terminal draws the prefixed
 *      first half, returns the cursor to column 0, and overwrites the prefix with
 *      `NOT QUOTED`. A working forgery against an implementation that looks right in a
 *      diff, in a review, and in a unit test that inspects the composed string.
 *   2. **Escape, and the rest of C0.** Cursor-position and erase-line sequences do the
 *      same thing more thoroughly.
 *   3. **U+2028 / U+2029, and the bidi controls.** `split('\n')` does not break on the
 *      first pair and some renderers do; the second set visually reorders a line, which
 *      moves a prefix off the front without changing a byte of it.
 *
 * So the quoter is **two rules, and the second is the load-bearing one**:
 *
 *   - split on `/\r\n|\r|\n/`, never on `'\n'` alone; and
 *   - **refuse** — never strip, never escape — a body containing any of those characters.
 *
 * Refusing rather than sanitising for `MAX_TRIGGER_TEXT`'s stated reason
 * (`server/trigger.js`): silently rewriting a caller's input hands them a way to have it
 * rewritten into something else. Over the length cap is a refusal for the same reason,
 * never a truncation. And the rule is **symmetric** — the maintainer's own body goes
 * through it too, because a rule with an exception in it is a rule with a hole in it.
 *
 * Neither rule alone closes it, and both are kept even though the refusal makes the
 * splitter's `\r` case unreachable today: they are two independent locks, and the day
 * something composes a body by a path that skipped the refusal, the splitter still
 * prefixes every physical line.
 *
 * **The control characters are written as explicit numeric escapes in the source**, never
 * as the bytes themselves. This repo has been bitten twice by invisible characters in
 * source — `normalize.js`'s ANSI regex, which says so on the line above itself, and
 * `mergeSig`'s three literal control bytes that every editor drew as an empty string —
 * and the planner's own tool calls were refused mid-draft for carrying one by accident.
 * The first draft of this file, when it still lived in `links.js`, was refused by the
 * harness for the same reason, which is as good a demonstration as the vector is likely
 * to get.
 *
 * ## What is refused, and one addition to the specified list
 *
 * C0 other than newline and tab (which includes carriage return and escape), DEL,
 * U+2028, U+2029, and the bidi controls U+202A-U+202E and U+2066-U+2069 — the plan's
 * list. Plus **C1, U+0080-U+009F**, which the plan did not name: a terminal may read
 * U+009B as CSI, no prose contains them, and the asymmetry is the one `classify` already
 * resolved — over-refusing costs one message that has to be retyped, under-refusing is a
 * working forgery.
 *
 * The line is drawn there deliberately and not one step further. U+200E / U+200F
 * (LRM/RLM) and U+061C are *not* refused: they are directionality marks that appear in
 * ordinary bidirectional prose, and refusing them would refuse legitimate Hebrew and
 * Arabic text. The overrides and isolates above have no such use in a sentence one lead
 * sends another.
 */

/* -------------------------------------------------------------------------- */
/* The contract: the two prefixes, and who may hold them.                     */
/* -------------------------------------------------------------------------- */

/** Another project's lead. A **request**, never authority. */
export const LEAD_PREFIX = '> ';

/** The maintainer, typing in the panel. **Their word** — it can authorize. */
export const HUMAN_PREFIX = '| ';

/** The pair, by speaker. The one spelling in the codebase; import it, never retype it. */
export const PREFIX = Object.freeze({ lead: LEAD_PREFIX, human: HUMAN_PREFIX });

/**
 * Who may be speaking. Set by **which endpoint composed the message**, never read from a
 * request body — a `speaker` parameter would be a one-word promotion of a lead's message
 * to the maintainer's word, which is the entire failure this module is shaped around.
 * The same stance `skipPermissions` already has in the dispatch path: not plumbed, so
 * there is no door to find.
 */
export const SPEAKERS = Object.freeze(['lead', 'human']);

/**
 * What a line break is, for the panel and for the terminal both. Never `'\n'` alone —
 * see the header. Not a global regex: `String#split` needs no `g`, and a stateful one is
 * a `lastIndex` waiting to surprise a second caller.
 */
export const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Longest body accepted. Over it is a refusal; a sender can send two messages.
 *
 * Named generically (not `MAX_LINK_TEXT`) because this cap now guards more than link
 * messages — `links.js` re-exports it under its old name so nothing there had to change.
 */
export const MAX_MESSAGE_TEXT = 4000;

/** Longest label. It rides in an envelope header, so it is a header fragment, not prose. */
export const MAX_LINK_LABEL = 80;

/* -------------------------------------------------------------------------- */
/* The refusal.                                                                */
/* -------------------------------------------------------------------------- */

/*
 * Numeric escapes, deliberately and without exception. Read the ranges:
 *
 *   \u0000-\u0008  C0 below tab
 *   \u000B-\u001F  C0 above newline: vertical tab, form feed,
 *                  CARRIAGE RETURN, escape, and the rest
 *   \u007F-\u009F  DEL, and the whole of C1
 *   \u2028 \u2029  line separator, paragraph separator
 *   \u202A-\u202E  bidi embeddings and overrides
 *   \u2066-\u2069  bidi isolates
 *
 * Tab (\u0009) and newline (\u000A) fall in the gap between the first two
 * ranges, and are the only two characters in C0 this accepts.
 */
const BODY_BAD = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

/** The same set with tab and newline folded back in: a header fragment is one line. */
const LINE_BAD = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

const NAMED = new Map([
  [0x00, 'a null'],
  [0x07, 'a bell'],
  [0x08, 'a backspace'],
  [0x09, 'a tab'],
  [0x0a, 'a newline'],
  [0x0b, 'a vertical tab'],
  [0x0c, 'a form feed'],
  [0x0d, 'a carriage return'],
  [0x1b, 'the escape character'],
  [0x7f, 'a delete'],
  [0x2028, 'a line separator'],
  [0x2029, 'a paragraph separator'],
]);

function nameOf(code) {
  const known = NAMED.get(code);
  if (known) return known;
  if (code <= 0x1f) return 'a control character';
  if (code >= 0x80 && code <= 0x9f) return 'a C1 control character';
  return 'a bidi control';
}

/** `U+000D` — the same spelling the source uses, so a refusal and the code agree. */
const codePoint = (code) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * The first character that must not be here, or null.
 *
 * Named and exported so a refusal can say *which* character it found. A test that
 * asserted only "it threw" would pass against an implementation that refuses one of these
 * and misses another, which is the whole hazard.
 *
 * @param {string} text
 * @param {{oneLine?: boolean}} [opts] `oneLine` refuses tab and newline as well: a header
 *   fragment (a label, a project name) is one line by construction.
 * @returns {{index: number, code: number, name: string} | null}
 */
export function controlFault(text, { oneLine = false } = {}) {
  const bad = oneLine ? LINE_BAD : BODY_BAD;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i += 1) {
    if (!bad.test(s[i])) continue;
    const code = s.codePointAt(i);
    return { index: i, code, name: nameOf(code) };
  }
  return null;
}

/** Shared by every caller in this module and by `links.js`'s own header/id composition. */
export function assertClean(text, what, { oneLine = false } = {}) {
  const fault = controlFault(text, { oneLine });
  if (!fault) return;
  throw new Error(
    `${what} cannot contain ${fault.name} (${codePoint(fault.code)}, at position ${fault.index}). ` +
      'These characters are refused rather than stripped, because they can make a quoted ' +
      'line draw as an unquoted one.',
  );
}

/**
 * A body that may be sent, or a throw saying why not.
 *
 * Three refusals and no rewriting of any kind: nothing is trimmed, escaped, collapsed or
 * cut. What comes back is what was passed in, and what gets quoted is what was passed in.
 *
 * @returns {string} the body, unchanged
 */
export function assertSendableBody(text, what = 'A message') {
  const s = String(text ?? '');
  if (!s.trim()) throw new Error(`${what} needs something to say.`);
  if (s.length > MAX_MESSAGE_TEXT) {
    throw new Error(
      `${what} is ${s.length} characters and the cap is ${MAX_MESSAGE_TEXT}. ` +
        'It is refused rather than shortened — send it in two.',
    );
  }
  assertClean(s, what);
  return s;
}

/** A label, or a throw. One line, capped, and it goes through the same refusal. */
export function assertSendableLabel(text) {
  const s = String(text ?? '');
  if (!s) return '';
  if (s.length > MAX_LINK_LABEL) {
    throw new Error(
      `A link label is ${s.length} characters and the cap is ${MAX_LINK_LABEL}. ` +
        'It is refused rather than shortened.',
    );
  }
  assertClean(s, 'A link label', { oneLine: true });
  return s;
}

/**
 * The prefix for a speaker, or a throw naming the two valid ones.
 *
 * Exported so `linkLine` (`links.js`) can run the same check before it composes anything,
 * rather than discovering an unknown speaker partway through building a message.
 */
export function prefixFor(speaker) {
  const prefix = PREFIX[speaker];
  if (!prefix) throw new Error(`A link message needs a speaker: ${SPEAKERS.join(' or ')}.`);
  return prefix;
}

/**
 * Every line of `body`, each carrying `speaker`'s prefix.
 *
 * Verbatim: the body is not trimmed, so a trailing newline yields a trailing prefixed
 * blank line. That is deliberate — the quoted block is exactly the lines it was given,
 * which is what makes "every body line is prefixed" a statement about the input rather
 * than about some tidied version of it.
 */
export function quoteBody(body, speaker) {
  const prefix = prefixFor(speaker);
  return String(body ?? '')
    .split(LINE_BREAK)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
