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
 */
export class PinStore {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    this.pins = new Map(); // paneId -> { at, paneCreatedMs }
    this.dirty = false;
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [paneId, v] of Object.entries(raw)) {
        if (!v || typeof v.at !== 'number') continue;
        this.pins.set(paneId, { at: v.at, paneCreatedMs: v.paneCreatedMs ?? null });
      }
    } catch {
      /* first run, or hand-edited into nonsense — start clean */
    }
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.pins), null, 2));
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

  /** When it was pinned, or null. Ordering the pinned group by this keeps it still. */
  at(paneId) {
    return this.pins.get(paneId)?.at ?? null;
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
      if (this.pins.has(paneId)) return false; // already pinned; don't reshuffle the order
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
