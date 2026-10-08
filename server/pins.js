import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';

const FILE = path.join(STATE_DIR, 'pins.json');

/**
 * The sessions you want to keep hold of.
 *
 * The rail sorts itself: whatever is blocked or unread climbs, everything else falls by
 * recency. That is right for triage and wrong for the one session you are actually
 * working in, which slides down the moment two others so much as blink. A pin nails a
 * row to the top and leaves it there.
 *
 * Keyed by **pane**, for the same reasons as `queue.js`: a session id rotates with every
 * `/clear`, and a pane you haven't spoken to yet has none at all. Pinning follows the
 * terminal, so clearing a conversation doesn't quietly unpin it.
 *
 * On disk so two browser windows agree and a reload doesn't forget — and with the same
 * birthday guard the queue carries, because tmux hands out `%0`, `%1`, … afresh with each
 * new server, and an inherited pin would sit a stranger at the top of your rail.
 *
 * **The order is the Map's own order**, and it is the maintainer's: a new pin goes to the
 * bottom, the rail's grip rearranges them (`reorder`), and unpinning takes a pin out of the
 * order with it. On disk each pin carries its position as `order`; `at` is still written
 * beside it although nothing here sorts by it any more, because a build from before the
 * order existed drops any pin without a numeric `at` — and sorts by it. That rollback keeps
 * every pin and loses only the arrangement (`#load` copies named fields, so `order` is
 * dropped on that build's first flush): back up `pins.json` before rolling back past it.
 */
export class PinStore {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    this.pins = new Map(); // paneId -> { at, paneCreatedMs }, in the pinned group's order
    this.dirty = false;
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const kept = [];
      for (const [paneId, v] of Object.entries(raw)) {
        if (!v || typeof v.at !== 'number') continue;
        kept.push({ paneId, at: v.at, paneCreatedMs: v.paneCreatedMs ?? null, order: v.order });
      }
      // By the stored position; a file written before there was one sorts by pin time,
      // which is the order the rail used to draw it in. `NaN || …` falls through to `at`.
      const pos = (v) => (Number.isFinite(v.order) ? v.order : Infinity);
      kept.sort((a, b) => pos(a) - pos(b) || a.at - b.at);
      for (const v of kept) this.pins.set(v.paneId, { at: v.at, paneCreatedMs: v.paneCreatedMs });
    } catch {
      /* first run, or hand-edited into nonsense — start clean */
    }
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const out = {};
      let order = 0;
      for (const [paneId, v] of this.pins) out[paneId] = { ...v, order: order++ };
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  has(paneId) {
    return Boolean(paneId) && this.pins.has(paneId);
  }

  /** Every pinned pane, top of the pinned group first. */
  order() {
    return [...this.pins.keys()];
  }

  /** Where this pane sits in the pinned group (0 is the top), or null when it isn't pinned. */
  rank(paneId) {
    const i = this.order().indexOf(paneId);
    return i < 0 ? null : i;
  }

  /**
   * Put the pinned group in this order — the drag's write.
   *
   * It may only *rearrange*: the list must name every pin exactly once and nothing else, so
   * a client working from a roster a beat old can neither pin nor unpin by accident.
   *
   * @param {unknown} paneIds the whole pinned group, top first
   * @returns {{changed: boolean} | {refused: 'malformed'|'stale', error: string}}
   */
  reorder(paneIds) {
    const problem = pinOrderProblem(this.order(), paneIds);
    if (problem) return problem;
    const now = this.order();
    if (paneIds.every((id, i) => id === now[i])) return { changed: false };
    this.pins = new Map(paneIds.map((id) => [id, this.pins.get(id)]));
    this.dirty = true;
    return { changed: true };
  }

  /**
   * @param {string} paneId
   * @param {boolean} pinned
   * @param {{paneCreatedMs?: number|null, now?: number}} [ctx]
   * @returns {boolean} whether it changed anything
   */
  set(paneId, pinned, { paneCreatedMs = null, now = Date.now() } = {}) {
    if (!paneId) return false;
    if (pinned) {
      // Already pinned: don't reshuffle the order — unless the pin on file is for an earlier
      // pane that held this id. `prune` drops those, but only on the next roster poll, and a
      // relaunch that takes the tmux server down and back inside one poll gets `%0` again
      // straight away: the stale pin made this a no-op, `prune` then saw the birthday change
      // and dropped it, and the relaunched session came back unpinned. Same birthday rule as
      // `prune`, applied at the moment it matters.
      //
      // A new pin goes to the bottom of the group, and so does that replacement: the dead
      // pane's place is not this one's to inherit. Deleting first is what moves it — a Map
      // keeps an existing key where it was. The re-pin paths put it back where its *name*
      // was afterwards (`carryPinOrder`).
      const had = this.pins.get(paneId);
      const stale = had && paneCreatedMs && had.paneCreatedMs && had.paneCreatedMs !== paneCreatedMs;
      if (had && !stale) return false;
      this.pins.delete(paneId);
      this.pins.set(paneId, { at: now, paneCreatedMs });
    } else if (!this.pins.delete(paneId)) {
      return false;
    }
    this.dirty = true;
    return true;
  }

  /**
   * Forget panes that are gone, and panes that are only nominally the same.
   *
   * @param {Map<string, number|null>} livePanes paneId -> tmux session creation time
   */
  prune(livePanes) {
    let changed = false;
    for (const [paneId, pin] of this.pins) {
      const created = livePanes.get(paneId);
      const gone = !livePanes.has(paneId);
      // A pane id that came back with a different birthday belongs to a different tmux
      // server, and so to a different session.
      const replaced = !gone && pin.paneCreatedMs && created && pin.paneCreatedMs !== created;
      if (gone || replaced) {
        this.pins.delete(paneId);
        changed = true;
      }
    }
    if (changed) this.dirty = true;
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }
}

/**
 * Why `proposed` is not a rearrangement of `current`, or null when it is.
 *
 * `malformed` is a body no client of this panel would send; `stale` is one that was right a
 * moment ago — a pin made or dropped between the roster frame the drag was read off and the
 * write — and the answer to it is a fresh roster, not an error the reader can act on.
 *
 * @param {string[]} current the store's order now
 * @param {unknown} proposed
 * @returns {{refused: 'malformed'|'stale', error: string} | null}
 */
export function pinOrderProblem(current, proposed) {
  if (!Array.isArray(proposed) || proposed.some((id) => typeof id !== 'string' || !id)) {
    return { refused: 'malformed', error: 'The order has to be a list of pane ids.' };
  }
  if (new Set(proposed).size !== proposed.length) {
    return { refused: 'malformed', error: 'That order names one session twice.' };
  }
  const have = new Set(current);
  if (proposed.some((id) => !have.has(id)) || proposed.length !== current.length) {
    return {
      refused: 'stale',
      error: 'The pinned sessions changed while you were moving one — nothing was reordered.',
    };
  }
  return null;
}

/**
 * The pinned group's order after a relaunch or a restore, carried over **by session name**.
 *
 * Every re-pin path launches new panes, and a relaunch that takes the tmux server down
 * numbers them from `%0` again, so a pane id says nothing about where a pin used to be. The
 * session name is the contract that survives (launch#relaunching-the-whole-bench), so the
 * caller says which names were pinned in what order, and which panes it has just pinned
 * again (`moved`, each with the name it was *saved* under, since a relaunch can mint a new
 * one). Those go back where their name was; every other pin is an anchor and does not move.
 *
 * A moved pin lands just below the last anchor whose name came before its own, or — when no
 * anchor did — just above the first whose name came after. That reproduces `wanted` exactly
 * whenever the anchors were in that order to begin with (a relaunch: `wanted` is the group
 * as it stood a minute ago), and when they are not — a restore of an old save into a bench
 * rearranged since — it still never moves a pin this restore did not make. A moved pin whose
 * name was not in `wanted` (a lead pinned from birth that had been unpinned) stays at the
 * bottom. Pure, and it never drops or duplicates a pin.
 *
 * @param {Array<string|null>} wanted session names, top of the pinned group first
 * @param {Array<{paneId: string, name?: string|null}>} current the store's pins, in order
 * @param {Set<string>} moved pane ids this caller has just pinned again
 * @returns {string[]} every current pane id, once
 */
export function carryPinOrder(wanted, current, moved) {
  const rank = new Map();
  wanted.forEach((name, i) => {
    if (name && !rank.has(name)) rank.set(name, i);
  });
  const rankOf = (c) => (c.name && rank.has(c.name) ? rank.get(c.name) : null);

  const out = current.filter((c) => !moved.has(c.paneId));
  const placing = current.filter((c) => moved.has(c.paneId) && rankOf(c) != null);
  const unplaced = current.filter((c) => moved.has(c.paneId) && rankOf(c) == null);
  placing.sort((a, b) => rankOf(a) - rankOf(b));

  for (const c of placing) {
    const r = rankOf(c);
    let at = -1;
    out.forEach((o, i) => {
      if (rankOf(o) != null && rankOf(o) < r) at = i;
    });
    if (at >= 0) out.splice(at + 1, 0, c);
    else {
      const above = out.findIndex((o) => rankOf(o) != null && rankOf(o) > r);
      if (above >= 0) out.splice(above, 0, c);
      else out.push(c);
    }
  }
  return [...out, ...unplaced].map((c) => c.paneId);
}
