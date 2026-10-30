/*
 * The two-step Clear button above the composer: what it says, and when its second press
 * is allowed.
 *
 * A pure module, for `ghost-action.js`'s reason: the rule about which word a control is
 * wearing right now is something a node test can hold. No DOM, no storage, no `window`.
 *
 * The ritual it automates is the maintainer's own: send "prepare to clear the session",
 * wait for the session to answer, then type `/clear`. Three words, in order:
 *
 *   clear       → nothing in flight. A press sends the prep message (through the queue).
 *   preparing…  → the prep message is out and the session has not finished with it.
 *   clear now   → the session answered and is idle again. A press sends `/clear`.
 *
 * Four rules, and each one is the point.
 *
 * **The second press is always a human's.** Nothing here ever sends `/clear`; `clearView`
 * only says whether the button may be pressed. There is no timer anywhere in it.
 *
 * **"Answered" needs a witness, never the roster's first `idle`.** The roster is a poll
 * behind the send, so the beat after a press still says `idle` about a session that has
 * not even read the message yet — taking that as "done" would offer `/clear` before the
 * prep turn ran. Two witnesses, either enough: the transcript shows the prep message
 * followed by a reply (`replied`), or the session was seen working with nothing of ours
 * still queued (`sawBusy`). The second exists so a transcript that spells the message in a
 * way this cannot match never leaves the button stuck — there is no cancel to get out.
 *
 * **"Idle" means nothing is holding it.** A question, a permission box or a plan approval
 * mid-prep keeps the button at `preparing…` until it is answered, and so does anything
 * queued for the session — `/clear` behind a queued message would clear the wrong thing.
 * A witness, once seen, is kept; readiness is re-asked on every beat, so a session that
 * starts working again after `clear now` goes back to `preparing…` until it settles.
 *
 * **A new session id ends it.** `/clear` mints a new id and transcript, and so does one
 * typed in the terminal; either way the conversation this prep was for is gone, and the
 * button is `clear` again. The one exception is a pane-only `pane-N` id earning its first
 * real one — measured on the bench: the prep message is what wrote that session's first
 * transcript, and the client follows the pane before the `rebound` frame arrives. The record is keyed by pane by the caller, so the pane keeps
 * following and the record notices the rotation by the id it was started under.
 */

/** What the first press sends when the settings box holds nothing. */
export const DEFAULT_CLEAR_PREP = 'prepare to clear the session';

/** What the second press sends. */
export const CLEAR_COMMAND = '/clear';

/** The words, in the button's own lower case — `.ghost-btn` uppercases them. `preparing…`
 *  is the widest, and the stylesheet keeps it in the box so the row never moves. */
export const CLEAR_WORDS = { idle: 'clear', preparing: 'preparing…', ready: 'clear now' };

/** How far before the press a transcript record may be stamped and still be the one we
 *  sent — the browser's clock and the transcript's are the same Mac's, but not the same
 *  read. */
const TS_SLACK_MS = 5000;

/** The roster's id for a pane with no transcript yet (`server/sessions.js`). */
export const isPaneOnlyId = (id) => /^pane-\d+$/.test(String(id ?? ''));

const same = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

/**
 * A fresh record for the first press.
 * @param {{id: string}} session
 * @param {string} text the prep message actually sent
 * @param {number} now ms
 */
export function startClear(session, text, now) {
  return { sessionId: session.id, text, sentAt: now, sawBusy: false, replied: false };
}

/** Nothing is holding the session and nothing is waiting for it. */
export function settled(session) {
  return Boolean(
    session?.interactive &&
      session.status === 'idle' &&
      !session.prompt &&
      !session.question &&
      !session.plan &&
      !session.queued?.length,
  );
}

/**
 * Did the transcript answer the prep message? The last user record carrying its text,
 * stamped no earlier than the press, with an assistant reply after it.
 * @param {Array<{kind: string, text?: string, ts?: string}>} messages
 */
export function repliedTo(messages, text, sentAt) {
  if (!Array.isArray(messages)) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.kind !== 'user' || !same(m.text, text)) continue;
    const ts = Date.parse(m.ts);
    if (Number.isFinite(ts) && ts < sentAt - TS_SLACK_MS) return false;
    return messages.slice(i + 1).some((r) => r?.kind === 'assistant');
  }
  return false;
}

/**
 * Fold one beat into the record. Returns the record to keep — `null` means "back to
 * `clear`" — and never mutates the one it was given.
 * @param {object|null} rec
 * @param {object|null} session the roster row this pane is showing
 * @param {Array} [messages] what the pane holds of its transcript
 */
export function stepClear(rec, session, messages) {
  if (!rec || !session) return null;
  let next = rec;
  if (session.id !== rec.sessionId) {
    // A session nobody has spoken to yet has a synthetic `pane-N` id, and the prep message
    // is often what writes its first transcript — so its real id arriving is the same
    // conversation being born, not one ending. Any other change of id is a `/clear`.
    if (!isPaneOnlyId(rec.sessionId)) return null;
    next = { ...next, sessionId: session.id };
  }
  if (!rec.sawBusy && session.status === 'working' && !session.queued?.length) next = { ...next, sawBusy: true };
  if (!next.replied && repliedTo(messages, rec.text, rec.sentAt)) next = { ...next, replied: true };
  return next;
}

/**
 * What the button shows for a record and a session.
 * @returns {{phase: 'idle'|'preparing'|'ready', word: string, disabled: boolean, title: string}}
 */
export function clearView(rec, session) {
  if (!rec) {
    return {
      phase: 'idle',
      word: CLEAR_WORDS.idle,
      disabled: !session?.interactive,
      title: 'Ask this session to get ready for /clear — a second press, once it has answered, clears it',
    };
  }
  if ((rec.replied || rec.sawBusy) && settled(session)) {
    return {
      phase: 'ready',
      word: CLEAR_WORDS.ready,
      disabled: false,
      title: 'It answered and is idle — send /clear (a new conversation in this pane)',
    };
  }
  return {
    phase: 'preparing',
    word: CLEAR_WORDS.preparing,
    disabled: true,
    title: 'Waiting for the session to answer and go idle — anything it asks has to be answered first',
  };
}
