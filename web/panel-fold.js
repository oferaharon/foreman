/*
 * The two side panels folded shut: what a strip has room to say, and the two grid track
 * pairs a split fold animates between.
 *
 * The ninth pure module under `web/`, and here for the reason each of the eight before it
 * gives: a derivation, a formatting rule and a piece of layout arithmetic are all things a
 * node test can hold, and the same three inlined into `web/app.js` are none of them.
 * `trust-gate.js` set the precedent, `notify.js` followed it for the notification rule, and
 * `rooms-band.js` / `rooms-create.js` / `rooms-pane.js` are its siblings one band and one
 * pane over. No DOM, no storage, no `window` — everything here is called with plain objects
 * and answers plain objects.
 *
 * **Nothing in this file is wired to anything yet.** It ships the parts the fold's two
 * halves assemble: the team aside's strip, a group room pane's strip, and the split's
 * arithmetic. That is deliberate — the shared piece lands first so the two halves cannot
 * each grow their own spelling of it.
 *
 * Three rules are carried in here rather than left to the caller, and each is already paid
 * for somewhere in this repo:
 *
 * **A strip is a door, not a window.** It shows a name, counts and dots, and never message
 * text or a preview — the maintainer's own words, and CLAUDE.md's "prefer showing nothing
 * over showing something wrong" one floor down. So every function here answers a name, a
 * number or a status word, and there is no shape in which a body of text could reach a
 * strip.
 *
 * **A member's dot is resolved by `memberRow`, imported and never re-spelled.** That
 * function mirrors `resolveMember` in `server/rooms-line.js` rung for rung, and
 * `test/rooms-pane.test.js` pins the two against each other. A third spelling of "which row
 * is this member" — one that could show a live dot beside a member the fan-out will record
 * as unreachable — is the `isLeadName` lesson in a fourth costume.
 *
 * **A count is formatted by `unseenText`, imported for the same reason.** The rail band and
 * a folded room's strip are two places drawing the same number, and two spellings of the
 * `99+` cap would be two answers to one question about one room.
 */

import { memberRow } from './rooms-pane.js';
import { unseenText } from './rooms-band.js';

/** A trimmed string, or `''`. The shape every comparison and every label below wants —
 *  `rooms-pane.js` and `server/rooms-line.js` both normalise the same way at their doors. */
const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** A count as it is stored: a whole number at or above zero, and zero for anything that is
 *  not one. A roster field that arrived as `null`, `undefined` or a string must read as
 *  "nothing to draw" rather than as `NaN` in front of a reader. */
const count = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/** A length in px: finite and at or above zero. Same rule as `count` and for the same
 *  reason, minus the rounding — a track is a measured rect and fractions of a pixel are
 *  real here. */
const px = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/* ------------------------------------------------------- the team aside --- */

/**
 * What the lead aside's strip shows, off the same `s.team` object `teamLine` reads.
 *
 * `null` for a row that is not on a team, and for one whose `team` carries no role — the
 * same door `teamLine` closes, and the honest answer for a panel that would have nothing to
 * put on it. Only a **lead** has an aside today, so only a lead ever reaches a strip; the
 * role is carried through rather than hard-coded to `'lead'` so the chip on the strip and
 * the chip on the rail row cannot come to disagree about what this session is.
 *
 * **Zero draws nothing, and that is one step further than `teamLine` goes.** The rail has
 * room for the words `no tasks` and draws them; a strip has room for a number and
 * nothing else, so both counts come back as `0` and a `0` is not drawn. That is the rule an
 * empty group heading and `.room-unseen` already follow — a `· 0` is furniture.
 *
 * **The second count is `review`, and there is no `waiting`.** A `waiting` count was
 * removed on 2026-08-27 and deliberately replaced: `needsYou` includes `unread > 0`, the
 * panel viewer's own read state, so it dropped to zero the moment anybody opened a worker's
 * transcript even though nothing had been handled. The ruling is that any future "does this
 * team need me" signal comes from **task state**, and `review` is that state.
 *
 * @param {{role?: string, tasks?: number, review?: number}|null} team `s.team` off a roster row
 * @returns {{role: string, tasks: number, review: number}|null}
 */
export function asideStripFacts(team) {
  const role = str(team?.role);
  if (!role) return null;
  return { role, tasks: count(team?.tasks), review: count(team?.review) };
}

/* -------------------------------------------------------- a room's pane --- */

/**
 * What a folded group room's strip shows: its name, one dot per member, and the unseen
 * count as it is drawn.
 *
 * `dots` is `renderGroupStrip`'s own mapping — a member that resolves to a live row
 * contributes that row's `status`, and one that resolves to nothing contributes `'gone'`,
 * which is a real `.dot` class and says on hover that anything posted is recorded as not
 * reached. The one hardening: a row carrying no status at all reads as `'unknown'` rather
 * than as `undefined`, because `undefined` would reach the DOM as the class name
 * `dot undefined` and draw the default grey while claiming to be a status. No roster row
 * this panel builds is missing one; the fallback is for a frame that arrived malformed.
 *
 * `unseen` is a **string**, already through `unseenText` — `''` at zero, and capped at
 * `99+` — so the strip and the rail band cannot disagree about a long-quiet room. Which
 * number is fed in is the caller's business and is not obvious: it is the **server's**
 * per-room `unseen`, never a pane's own `N new below` counter, which only counts while the
 * reader is scrolled up and is therefore always zero behind a folded panel.
 *
 * @param {{name?: string, members?: Array, unseen?: number}|null} room a room off the roster
 * @param {Array} sessions the live roster rows
 * @returns {{name: string, dots: string[], unseen: string}}
 */
export function roomStripFacts(room, sessions = []) {
  const members = Array.isArray(room?.members) ? room.members : [];
  const dots = members.map((m) => {
    const row = memberRow(m, sessions);
    if (!row) return 'gone';
    return str(row.status) || 'unknown';
  });
  // `'room'` is `roomTitle`'s own fallback one file over, for the same reason: a strip with
  // no word on it is a column a reader cannot name, which is worse than a generic one.
  return { name: str(room?.name) || 'room', dots, unseen: unseenText(room?.unseen) };
}

/* ------------------------------------------------------ the split's px --- */

/**
 * The two grid track pairs a split fold animates between, in px.
 *
 * The split's resting layout is declarative — `grid-template-columns: var(--pane-a) 1fr` —
 * and `1fr` does not interpolate with a length, so a fold cannot simply be a class swap:
 * `50% 1fr` → `var(--strip) 1fr` animates and `50% 1fr` → `1fr var(--strip)` does not. The fold
 * therefore runs through an explicit px pair and only lands on the declarative class at the
 * end, and this is that arithmetic. Nothing here touches `--pane-a`: the split resizer owns
 * that variable and re-applies it on every `window.resize`, so a fold expressed through it
 * would be silently undone.
 *
 * **`aW` and `bW` are the *expanded* pair — the widths the two panes have, or will have,
 * when neither is folded.** Collapsing, they are measured live and the animation runs
 * `from → to`; expanding, the caller resolves them (with the fold class off) and runs
 * `to → from`. One pair of numbers describes both directions, which is what keeps a fold
 * and its undo from being two different sums.
 *
 * **What is clamped, and to what.** Every input is read as a finite length at or above
 * zero; anything else — `NaN`, a negative, a missing field — reads as `0`. The *folded*
 * pair is then made to sum to `frameW` exactly: the strip track is `min(stripW, frameW)`
 * and the other track is the remainder. So in a window narrower than one strip the strip
 * takes the whole frame and its neighbour is `0` — never a negative track, and never a pair
 * wider than the window it is in. The *expanded* pair is passed through untouched beyond
 * that zero floor, and deliberately **not** renormalised to `frameW`: it is measured, and
 * animating to a width the panes do not have would be this module inventing a layout.
 *
 * **An unknown `fold` reads as `null`, which is expanded.** `null` answers the expanded
 * pair at both ends — nothing folded, nothing to animate — and that is the direction this
 * feature fails in on purpose: a strip-width *session* pane is the worst thing a fold can
 * produce, so every uncertainty lands on open.
 *
 * @param {{frameW?: number, aW?: number, bW?: number, stripW?: number, fold?: 'a'|'b'|null}} o
 * @returns {{from: [number, number], to: [number, number]}} `from` expanded, `to` folded
 */
export function foldTracks({ frameW, aW, bW, stripW, fold } = {}) {
  const frame = px(frameW);
  const strip = Math.min(px(stripW), frame);
  const rest = frame - strip;
  const from = [px(aW), px(bW)];
  if (fold === 'a') return { from, to: [strip, rest] };
  if (fold === 'b') return { from, to: [rest, strip] };
  return { from, to: [from[0], from[1]] };
}
