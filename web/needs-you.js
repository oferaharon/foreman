/*
 * What a row that wants the maintainer wears, now that it stays where it lives.
 *
 * The rail used to hoist every such row out of its folder into a `needs you · N` section at
 * the top, and the maintainer ruled against it on 2026-11-09: sessions moving all the time
 * is the thing he did not like. So nothing moves any more. A row that wants him keeps its
 * folder, its group, its pin or its place in `recent`, and says so on its own left edge — a
 * red stripe when it is blocked asking something, an accent one when it only has a reply he
 * has not read. A folded group counts what it is holding, and a control in the rail head
 * walks them.
 *
 * The fourteenth pure module under `web/`, here for the reason each of the ones before it
 * gives: every mistake available in this arithmetic **renders perfectly**. A worker its lead
 * is meant to be handling, striped red, pulls the maintainer onto a prompt he decided not to
 * be shown; an unread reply striped as blocked is a red row nobody can clear by answering;
 * a folded group that counts the top-level rows alone draws a calm heading over a blocked
 * worker — and with no inbox to pull that worker out first, the count is the only thing that
 * says it is there. No DOM, no storage, no `window`.
 *
 * Nothing here is a new rule. Two are imported, never re-spelled:
 *
 *  - **who wants you** is the old inbox's own test, `needsYou` less a quiet worker
 *    (`quietWorker`, exported from `notify.js` for exactly this) — so a worker gets a stripe
 *    once `stuck` fires and not before, the trade the maintainer made on 2026-08-27;
 *  - **which kind** is `needsKind`, the notification's own answer to "is this session stuck
 *    on something", which asks about the trust gate first. `needsYou` also counts "it
 *    replied and you haven't looked" (browser#the-needs-you-notification), and `needsKind`
 *    is the one function that already tells that apart — anything it names is blocked, and
 *    what is left is a reply.
 */

import { needsKind, quietWorker } from './notify.js';

/**
 * The old inbox's test, unchanged: blocked on you or holding a reply you have not read,
 * and not a worker its lead is meant to be handling. A sleeper never qualifies — by the
 * sleep rule it had nothing unread and was asking nothing, and it is not a live row.
 *
 * @param {object} s a roster row (or a sleeper item, which answers false)
 */
export function wantsYou(s) {
  return Boolean(s && !s.asleep && s.needsYou && !quietWorker(s));
}

/**
 * The stripe a row wears: `'blocked'` (red), `'unread'` (accent), or `null` for none.
 *
 * Blocked wins over unread — a session sitting on a box with a reply above it is a session
 * sitting on a box. Anything `needsKind` names (the trust gate, a plan, a question, a
 * permission prompt, a `needs-decision` it cannot read) is blocked; a row that `wantsYou`
 * and that `needsKind` has no name for is wanting you for its unread reply alone.
 *
 * @param {object} s
 * @returns {'blocked'|'unread'|null}
 */
export function stripeKind(s) {
  if (!wantsYou(s)) return null;
  return needsKind(s) ? 'blocked' : 'unread';
}

/**
 * How many of these rows want you, and how many of those are blocked.
 *
 * Counts what it is handed and knows nothing about nesting: the folded group's caller
 * expands a lead into itself plus its nested workers first, the same `expand` the fold rule
 * and the working dot already read, so a worker hidden behind a fold is counted.
 *
 * @param {object[]} rows
 * @returns {{need: number, blocked: number}}
 */
export function needTally(rows) {
  let need = 0;
  let blocked = 0;
  for (const s of Array.isArray(rows) ? rows : []) {
    const kind = stripeKind(s);
    if (!kind) continue;
    need++;
    if (kind === 'blocked') blocked++;
  }
  return { need, blocked };
}

/** `1 needs you`, `3 need you`, `''` for none. */
export function needText(n) {
  if (!(n > 0)) return '';
  return `${n} need${n === 1 ? 's' : ''} you`;
}

/** A finite, positive number, or `null` — the door every roster field goes through here. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/**
 * The rows in the order they would sit if nobody wanted anything: newest `lastActivity`
 * first, a row with no stamp at the bottom, ties left in the order they came.
 *
 * The roster itself sorts blocked rows first and unread ones second (`server/sessions.js`),
 * and with the inbox taking those out before anything else was drawn, what reached the
 * folders was recency. With the inbox gone, that ranking would be the hoist all over again
 * in miniature — a row jumping to the top of its folder, and its folder to the top of the
 * rail, the moment it asked something. The server's order is the phone's and the task
 * list's business and is left alone; the desktop rail re-sorts its own copy here.
 *
 * Never mutates its argument.
 *
 * @param {object[]} rows
 * @returns {object[]}
 */
export function byRecency(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return list
    .map((s, i) => ({ s, i, t: num(s?.lastActivity) }))
    .sort((a, b) => {
      if (a.t === b.t) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return b.t - a.t || a.i - b.i;
    })
    .map((x) => x.s);
}

/**
 * The next row the jump control should open: the first that wants you **after** the one
 * that is open, in rail order, wrapping round — or `null` when nothing wants you.
 *
 * `order` is every row the rail accounts for, top to bottom, wanting or not: the rows it
 * draws plus the ones a folded group holds, each `{id, kind}` with `kind` from
 * `stripeKind`. The non-wanting rows are in it because "after" is about where the open
 * session *sits*, and the open one often wants nothing — an unread reply stops being one
 * the moment it is opened, which is exactly the press before this one. An `id` not in the
 * order (no session open, or a room or a bot holding the pane) starts from the top.
 *
 * Pressed on the only row that wants you, it answers that row again: the honest answer, and
 * the caller scrolls it back into view.
 *
 * @template {{id: string, kind: string|null}} T
 * @param {T[]} order
 * @param {string|null|undefined} currentId
 * @returns {T|null}
 */
export function nextNeeding(order, currentId) {
  const list = Array.isArray(order) ? order : [];
  const at = currentId ? list.findIndex((e) => e?.id === currentId) : -1;
  for (let k = 1; k <= list.length; k++) {
    const e = list[(at + k + list.length) % list.length];
    if (e?.kind) return e;
  }
  return null;
}
