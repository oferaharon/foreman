/**
 * Claude Code's `<pasted_content>` wrapper, taken off a record the panel typed — **exactly
 * one** of them, around the **whole** record, or nothing.
 *
 * Since v2.1.280 a paste that the composer folds into a `[Pasted text #N +K lines]` chip
 * reaches the transcript as
 *
 *   `\n\n<pasted_content id="f4d4">\n<the pasted text>\n</pasted_content id="f4d4">\n`
 *
 * on an ordinary `type: 'user'` record — `origin: {kind: 'human'}`, nothing else on it
 * says so. The panel pastes every multi-line message it types (`sendText`'s bracketed-paste
 * path, `server/tmux.js`), so a room delivery, a panel message and a dispatch brief can all
 * arrive this way, and the two readers that key on the record's text — the room chip and
 * the user bubble — both drew the raw tags.
 *
 * ## What was measured (v2.1.280, sandbox `alpha`, through the panel's own `sendText`)
 *
 * - **The fold decides, not the path.** A paste is wrapped exactly when the composer folds
 *   it: more than 800 characters, or more than `min(rows − 10, 2)` newlines — so four
 *   lines on an ordinary pane, and any multi-line paste on one 10 rows tall. Two- and
 *   three-line pastes and an 800-character one arrive bare at 50 rows and at 23. A single
 *   line typed with `send-keys -l` is wrapped too once
 *   it is long enough — the terminal hands it over in ~1 KB reads and each read over the
 *   limit folds on its own, so a 2,000-character line arrives as **two** wrappers with the
 *   words cut at the seams. That is not one wrapper and stays raw here.
 * - **Two whitespace shapes.** Delivered to an idle session the record is the shape above;
 *   delivered while it is busy, Claude Code queues it (`promptSource: 'queued'`) and trims
 *   it on the way out, so the tags are the first and last characters. Both are read.
 * - **The id is per session, not per paste.** Four lowercase hex digits — today the head
 *   of the session id's SHA-256 — and the same on every paste in one session. It is
 *   deliberately **not** a witness here: Claude Code's own system prompt calls it random,
 *   and a witness keyed on an undocumented derivation stops working silently the release it
 *   changes. What *is* a witness is that the open and close tags carry the same one.
 * - **Tags inside the pasted text are escaped.** `<pasted_content` and `</pasted_content`
 *   in the text itself, in any case, come back as `<\pasted_content` and
 *   `<\/pasted_content`. That is what makes "exactly one" checkable: an unescaped tag in the
 *   body can only be a *second* block's. It is also **lossy** — a `<\pasted_content` already
 *   in the text is left alone rather than doubled — so the escape is not undone here. The
 *   body is shown exactly as the session received it.
 *
 * ## The rule
 *
 * Nothing but whitespace outside one open/close pair, the ids equal, and no unescaped tag
 * between them. Anything else — a sentence typed above a paste, two pastes, a wrapper
 * somebody quoted — is `null`, and the caller keeps the text exactly as it was. Wider than
 * that would be the panel deciding which of somebody's words were "really" a paste.
 *
 * ## Why it is its own leaf
 *
 * Two readers need it — `readRoomDelivery` (`room-header.js`) and the user bubble in
 * `normalize.js` — and they must not disagree about what a wrapper is: one spelling,
 * imported (`docs/traps/one-spelling.md`). `room-header.js` is itself a leaf that
 * `normalize.js` imports, so this has to be one too; it imports nothing.
 */

/**
 * The whole record: optional whitespace, one open tag, the body, the matching close tag,
 * optional whitespace. `\1` is what makes the ids equal. The body is lazy so a record
 * holding two blocks still matches from the first open to the last close — and is then
 * refused by the tag check below, rather than read as one block with a seam inside it.
 */
const WHOLE_RE = /^\s*<pasted_content id="([0-9a-f]{4})">\n([\s\S]*?)\n<\/pasted_content id="\1">\s*$/;

/** An unescaped tag, either end, any case — only another block can have left one. */
const TAG_RE = /<\/?pasted_content\b/i;

/**
 * The pasted text inside a record that is nothing but one wrapper, or `null`.
 *
 * @param {string} text a user record's text, as it sits in the transcript
 * @returns {string|null}
 */
export function unwrapPasted(text) {
  if (typeof text !== 'string') return null;
  const m = WHOLE_RE.exec(text);
  if (!m) return null;
  const body = m[2];
  return TAG_RE.test(body) ? null : body;
}
