import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.js';

const FILE = path.join(STATE_DIR, 'read.json');

/**
 * How much of each session you've already seen.
 *
 * A watermark is an ISO timestamp: everything at or before it counts as read.
 * Timestamps rather than message ids because a transcript's tail is all we read,
 * and comparing times needs no knowledge of what came before the window.
 *
 * Lives on the server, not in the tab, so closing the browser doesn't resurrect
 * a hundred unread messages and two windows agree with each other.
 */
export class ReadState {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    this.file = file;
    this.marks = new Map(); // sessionId -> ISO timestamp
    this.dirty = false;
    this.#load();

    this.timer = setInterval(() => this.#flush(), 2000);
    this.timer.unref?.();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') this.marks.set(k, v);
    } catch {
      /* first run, or the file was hand-edited into nonsense — start clean */
    }
  }

  #flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.marks), null, 2));
    } catch {
      /* best-effort */
    }
  }

  /** Write now rather than waiting for the next tick (tests, shutdown). */
  flush() {
    this.#flush();
  }

  /**
   * First time we ever see a session, treat its existing history as read.
   * Without this, day one would show every session shouting about messages you
   * already read in the terminal months ago.
   */
  ensureBaseline(sessionId, ts) {
    if (this.marks.has(sessionId)) return;
    this.marks.set(sessionId, ts || new Date().toISOString());
    this.dirty = true;
  }

  get(sessionId) {
    return this.marks.get(sessionId) || null;
  }

  /** Watermarks only move forward — a late-arriving older message can't un-read things. */
  mark(sessionId, ts) {
    if (!ts) return false;
    const prev = this.marks.get(sessionId);
    if (prev && prev >= ts) return false;
    this.marks.set(sessionId, ts);
    this.dirty = true;
    return true;
  }

  /** Drop sessions that have aged out of the roster so the file doesn't grow forever. */
  prune(liveIds) {
    let changed = false;
    for (const id of this.marks.keys()) {
      if (!liveIds.has(id)) {
        this.marks.delete(id);
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
