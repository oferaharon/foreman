/**
 * What is worth interrupting somebody for, and when it became true.
 *
 * This is the decision half of the Mac notifications — pure functions over roster frames,
 * no DOM, no `Notification`, no storage — so it can be run in `node --test` the way
 * `trust-gate.js` is. The wiring (the permission prompt, the opt-in, the actual
 * `new Notification`) lives in `web/app.js`, because that is where the socket and the
 * settings modal are. Keeping the rule out here is the point: what counts as "needs you"
 * is exactly the sort of thing that drifts into two answers once it is spelled twice.
 *
 * **Everything below is derived from the roster the panel already receives.** The issue
 * allowed one socket event or endpoint if the transitions could not be derived from
 * `sessions` frames; they can. `status`, `prompt`, `plan`, `question` and `team.state` are
 * all on the row already, and `sessions.js`'s `#diff` includes every one of them — so a
 * session entering a box, and a task reaching `review`, each broadcast a frame on their
 * own. No server change, which also means nothing needs restarting to pick this up.
 *
 * The phone (`web/m/`) gets none of it and imports nothing from here. `Notification` needs
 * a secure context; a phone reaches this panel over plain `http://` on the LAN, and a
 * Home Screen web app would additionally need a push service — which is an
 * internet-reachable relay, and the LAN-only stance rules that out. Its half of the issue
 * was the Home Screen icon.
 */

import { isTrustGate } from './trust-gate.js';

/**
 * A worker whose lead is meant to be handling it.
 *
 * The rail's own rule, deliberately re-used rather than re-derived: since the quieting, a
 * worker's permission prompt is its lead's to answer and does not hoist into the inbox
 * until the stuck timer fires. A notification that ignored that would undo the quieting
 * from a different direction — the maintainer would be pulled out of whatever they were
 * doing by exactly the prompts they decided they did not want to be shown. When `stuck`
 * goes true the row enters the inbox, and this returns false, and the alert fires then.
 *
 * `quietWorker` in `web/app.js` is the same expression for the same reason; if one moves,
 * move both.
 */
const quietWorker = (s) => s?.team?.role === 'worker' && !s.team.stuck;

/**
 * What a session is stuck on, or `null` if it is not stuck on anything.
 *
 * Not `needsYou`, which is the roster's own field and is wider: it also counts "it replied
 * and you haven't looked", which is a badge in the rail and emphatically not a thing to
 * put on somebody's screen. The issue named three screens — a permission prompt, a
 * question, a plan box — and those are the first four cases here; `blocked` is the fifth
 * because `needs-decision` with nothing readable behind it is a real one (the `Switch
 * model?` confirmation has no key-hint footer and so no parsed prompt), and a session
 * sitting on it is as stuck as one sitting on a box we can read.
 *
 * Order matters. A plan box and the trust gate both report `needs-decision`, and the trust
 * gate additionally carries a full, perfectly-parsed prompt — so the most specific witness
 * has to be asked first or the gate is announced as an ordinary permission prompt and
 * whoever reads it goes to the panel, where there is deliberately no button.
 */
export function needsKind(s) {
  if (!s || quietWorker(s)) return null;
  if (s.prompt && isTrustGate(s.prompt)) return 'trust';
  if (s.plan) return 'plan';
  if (s.question) return 'question';
  if (s.prompt) return 'permission';
  if (s.status === 'needs-decision') return 'blocked';
  return null;
}

/** A worker that has reported and is waiting on a human to look at what it did. */
export function isReview(s) {
  return s?.team?.role === 'worker' && s.team.state === 'review';
}

/**
 * The whole of what a later frame is compared against: what this row was stuck on, and
 * whether its task had already reported.
 *
 * Two fields rather than the row itself, on purpose — a mark that held the session would
 * keep a whole roster alive between frames and would compare unequal on every unrelated
 * field that moved.
 */
export const markOf = (s) => ({ kind: needsKind(s), review: isReview(s) });

/**
 * One roster frame: the marks to keep, and what fired.
 *
 * Returned together rather than as two calls because the two must be computed from the
 * same frame — a caller that diffed against a map built from some *other* frame would
 * either miss transitions or replay them, silently, and the failure looks like "sometimes
 * I get a notification".
 *
 * `prev` is `null` for the first frame after the page loads, and that frame is a baseline:
 * it fires nothing. Half the sessions on this Mac are usually sitting at a prompt at any
 * given moment, and opening the panel is not the moment to be told about all of them at
 * once. After that, a row nobody has seen before *is* news — a session that appears
 * already on the trust gate is the ordinary case — so an unknown id is treated as having
 * been quiet, not as another baseline.
 *
 * @param {Map<string, {kind: string|null, review: boolean}>|null} prev
 * @param {Array<object>} sessions the roster from a `sessions` frame
 */
export function step(prev, sessions) {
  const marks = new Map();
  const alerts = [];

  for (const s of sessions || []) {
    if (!s?.id) continue;
    const mark = markOf(s);
    marks.set(s.id, mark);
    if (!prev) continue; // the baseline frame

    const was = prev.get(s.id) || { kind: null, review: false };
    // A change *of* kind counts, not just the arrival of one: a permission prompt answered
    // straight into a question is two things wanted, one after the other, and reporting
    // only the first would leave the second silent for as long as it sat there.
    if (mark.kind && mark.kind !== was.kind) alerts.push(alertOf(s, mark.kind));
    if (mark.review && !was.review) alerts.push(alertOf(s, 'review'));
  }

  return { marks, alerts };
}

/** The fields an alert needs, lifted off the row so nothing holds a roster. */
const alertOf = (s, kind) => ({
  id: s.id,
  kind,
  title: s.title || s.label || s.project || 'A session',
  branch: s.team?.branch || null,
  task: s.team?.task || null,
});

/**
 * The body text per kind. No session name in any of them: macOS draws the title above the
 * body, the title *is* the name, and a body that repeated it would spend the one line
 * these get on something already on screen.
 */
const BODIES = {
  permission: 'Waiting on a permission prompt.',
  question: 'Claude is asking you something.',
  plan: 'A plan is ready for you to approve.',
  blocked: 'Waiting on a box the panel could not read — answer it in the terminal.',
  // The one case where the panel is the wrong place to send somebody. It reads the gate
  // perfectly and refuses to offer a button on it (`web/trust-gate.js`), so a notification
  // that just said "needs a decision" would send the reader to a card whose whole content
  // is "go to the Mac". Say that here instead.
  trust: 'On the folder-trust gate — answer it in the terminal on this Mac. The panel will not.',
  // Not a state any session can be in: the settings box's test button, which exists so
  // "did I actually grant this?" has an answer that is not "wait for a session to block".
  test: 'A test. This is what it looks like when a session needs you.',
};

/**
 * The notification's words, and the tag that stops them stacking up.
 *
 * One live notification per session: the tag is the session id, so a row that moves from a
 * permission prompt to a question replaces its own notification rather than adding a
 * second. `renotify` is what makes that replacement still make a sound — without it a real
 * new transition on a session you already had a notification for would arrive silently,
 * which is the same as not arriving.
 */
export function alertText(a) {
  if (a.kind === 'review') {
    const where = a.branch ? ` · ${a.branch}` : '';
    return {
      title: `${a.title} is ready for review`,
      body: a.task ? `Task ${a.task}${where}` : `Reported for review${where}`,
      tag: `foreman:${a.id}`,
    };
  }
  return {
    title: a.title,
    body: BODIES[a.kind] || 'Needs you.',
    tag: `foreman:${a.id}`,
  };
}
