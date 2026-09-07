/*
 * What the one button above the composer says, and what pressing it does.
 *
 * The tenth pure module under `web/`, and here for the reason `trust-gate.js` set and the
 * eight after it kept: a rule about which of two meanings a control is carrying right now
 * is something a node test can hold, and the same three lines inlined into `web/app.js`
 * are not. No DOM, no storage, no `window` — plain arguments in, a plain object out.
 *
 * **The rule comes out of the terminal, not out of a preference about layout.** Claude
 * Code offers a suggested next prompt only while the pane is *idle* (`server/ghost.js`
 * refuses every other state), and an idle session's `interrupt` has nothing to stop. So
 * the two meanings can never both be live, which is what makes one row and one button
 * honest rather than a saving: while a suggestion is up the button is the suggestion's
 * button, and the moment it clears the button is interrupt again, in place.
 *
 * Three things it is deliberately strict about.
 *
 * **The two meanings are mutually exclusive in the answer, not merely in fact.** There is
 * no shape here in which a caller gets `send` with nothing to send or `interrupt` beside a
 * live offer, because the one failure that would actually cost something is a press that
 * fires `Escape` into a session while the word in front of it read `send`. `suggests` is
 * the caller's branch for which handler to bind, and it is derived here rather than
 * re-decided at the call site.
 *
 * **`send` is `ghostSend` and nothing else.** The word *is* the behaviour, not a
 * description of it: with the preference on, one press sends into a live session, and a
 * control that sends must not be labelled as though it fills a box. That was the rule the
 * suggestion's own button carried before it moved onto this row, and it moves with it.
 *
 * **One repaint key, spelled once.** `ghostSig` is what both halves of the row are guarded
 * on — the line's text and the button's word — so a preference flip and a new suggestion
 * are the same kind of change to the same key. Joined with a visible `|` for the reason
 * `mergeSig` learned the expensive way: three control bytes inside a pair of quotes read
 * as an empty-string join in every editor there is.
 */

/** Hovering interrupt says what it does and which key does it in the terminal. */
export const INTERRUPT_TITLE = 'Stop what this session is doing (Escape)';

/** …and with the preference on, the same button is one press away from a live session. */
export const SEND_TITLE =
  'Send this to the session now — “send a suggestion straight away” is on for this browser';

/** …or, with it off, it only fills the box under it. */
export const USE_TITLE = 'Put this in the box below, to edit or send';

/**
 * @param {string|null|undefined} text the suggestion on offer, or nothing
 * @param {boolean} sendOn the `ghostSend` preference for this browser
 * @returns {{act: 'interrupt'|'send'|'use', title: string, suggests: boolean}}
 *   `act` is the button's label as well as its name — the word on it is the word for what
 *   it does — and `suggests` says which of the two handlers belongs on it.
 */
export function ghostAction(text, sendOn) {
  if (!text) return { act: 'interrupt', title: INTERRUPT_TITLE, suggests: false };
  return sendOn
    ? { act: 'send', title: SEND_TITLE, suggests: true }
    : { act: 'use', title: USE_TITLE, suggests: true };
}

/**
 * The repaint key for the whole row: the word on the button and the line beside it.
 *
 * Nothing else may join it. The row sits directly above a textarea somebody may be about
 * to click into, and a repaint on every roster frame would drop a focused control out from
 * under a press.
 */
export function ghostSig(text, sendOn) {
  return `${ghostAction(text, sendOn).act}|${text || ''}`;
}
