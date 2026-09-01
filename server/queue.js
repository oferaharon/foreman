import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { STATE_DIR } from './config.js';

const FILE = path.join(STATE_DIR, 'queue.json');

/** Enough to type ahead of a long tool run; small enough that a runaway is visible. */
const MAX_PER_PANE = 20;

/** Backoff after a failed delivery, so a stuck pane isn't retried every poll. */
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];

/**
 * Messages waiting for a session to be ready to hear them.
 *
 * Keyed by **pane**, not by session id. A session id is the transcript's identity and it
 * rotates — `/clear` mints a new one, and a pane you haven't spoken to yet has none at
 * all. The pane is what you are actually typing into, and it survives all of that.
 *
 * On disk so it survives a browser tab closing, which is the whole point: v1 held the
 * held message in `state.queued` and lost it with the window.
 *
 * Surviving a *restart* is the same store's problem, and it needs a guard: tmux pane ids
 * restart at `%0` with a new server, so `%19` tomorrow is a different session's pane
 * entirely. Each item remembers the tmux session's creation time, and `prune` drops
 * anything whose pane has been replaced rather than delivering to a stranger.
 */
export class MessageQueue extends EventEmitter {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    super();
    this.file = file;
    this.byPane = new Map(); // paneId -> item[]
    this.seq = 0;
    this.dirty = false;
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [paneId, items] of Object.entries(raw)) {
        if (!Array.isArray(items)) continue;
        const clean = items.filter((i) => i && typeof i.id === 'string' && typeof i.text === 'string');
        if (clean.length) this.byPane.set(paneId, clean.slice(0, MAX_PER_PANE));
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
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.byPane), null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  #touch() {
    this.dirty = true;
    this.emit('changed');
  }

  /** What's waiting for a pane, oldest first. Copies, so callers can't mutate the store. */
  list(paneId) {
    return (this.byPane.get(paneId) || []).map((i) => ({ ...i }));
  }

  size(paneId) {
    return this.byPane.get(paneId)?.length || 0;
  }

  /**
   * @param {string} paneId
   * @param {string} text
   * @param {{paneCreatedMs?: number, now?: number}} [ctx]
   */
  add(paneId, text, { paneCreatedMs = null, now = Date.now() } = {}) {
    const items = this.byPane.get(paneId) || [];
    if (items.length >= MAX_PER_PANE) {
      throw new Error(`This session already has ${MAX_PER_PANE} messages waiting.`);
    }
    this.seq += 1;
    const item = {
      id: `${now.toString(36)}-${this.seq.toString(36)}`,
      text,
      at: now,
      paneCreatedMs,
      attempts: 0,
      nextTryAt: 0,
      error: null,
    };
    items.push(item);
    this.byPane.set(paneId, items);
    this.#touch();
    return { ...item };
  }

  remove(paneId, id) {
    const items = this.byPane.get(paneId);
    if (!items) return false;
    const at = items.findIndex((i) => i.id === id);
    if (at < 0) return false;
    items.splice(at, 1);
    if (!items.length) this.byPane.delete(paneId);
    this.#touch();
    return true;
  }

  /** The next message due for delivery, or null if the queue is empty or backing off. */
  due(paneId, now = Date.now()) {
    const head = this.byPane.get(paneId)?.[0];
    if (!head) return null;
    return head.nextTryAt > now ? null : { ...head };
  }

  /** It went. Drop it. */
  settle(paneId, id) {
    return this.remove(paneId, id);
  }

  /**
   * It didn't go. Keep it — losing what someone typed is the thing this module exists to
   * prevent — but back off, so a pane that keeps refusing isn't hammered every poll.
   */
  fail(paneId, id, message, now = Date.now()) {
    const item = this.byPane.get(paneId)?.find((i) => i.id === id);
    if (!item) return;
    item.attempts += 1;
    item.error = message;
    item.nextTryAt = now + RETRY_MS[Math.min(item.attempts - 1, RETRY_MS.length - 1)];
    this.#touch();
  }

  /**
   * Forget panes that are gone, and panes that are only nominally the same.
   *
   * @param {Map<string, number|null>} livePanes paneId -> tmux session creation time
   */
  prune(livePanes) {
    let changed = false;
    for (const [paneId, items] of this.byPane) {
      const created = livePanes.get(paneId);
      const gone = !livePanes.has(paneId);
      // A pane id that came back with a different birthday belongs to a different
      // tmux server, and so to a different session.
      const replaced =
        !gone && items.some((i) => i.paneCreatedMs && created && i.paneCreatedMs !== created);
      if (gone || replaced) {
        this.byPane.delete(paneId);
        changed = true;
      }
    }
    if (changed) this.#touch();
  }

  stop() {
    clearInterval(this.timer);
    this.#flush();
  }
}
