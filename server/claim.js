/**
 * The lock that stands between a message and a pane.
 *
 * Nothing may be typed into a session without claiming it first. The roster is up to a
 * poll behind, so five messages fired in one second all saw `idle` and all landed on the
 * same prompt line — that is what this exists for, and it is why both the send endpoint
 * and the queue flusher go through it rather than typing directly.
 *
 * Lives in its own file so the ordering below can be tested against real `capture-pane`
 * output through the real `parsePane`, rather than asserted about. Only tmux is stubbed;
 * the thing under test is not.
 */

/**
 * How long a pane stays locked after a delivery.
 *
 * Enough for the TUI to redraw and for the hook to report the session as working. Without
 * it a burst of messages all read a free pane and all get typed on top of each other. One
 * at a time, then a beat; the rest of the burst queues and goes in order.
 */
export const COOLOFF_MS = 1500;

export class PaneLock {
  #busy = new Set();
  #read;
  #cooloff;

  /**
   * @param {(paneId: string) => Promise<object>} readPaneState  live read of one pane
   * @param {{cooloffMs?: number}} [opts]
   */
  constructor(readPaneState, { cooloffMs = COOLOFF_MS } = {}) {
    this.#read = readPaneState;
    this.#cooloff = cooloffMs;
  }

  /** Whether this pane is mid-delivery or still in its cooloff. */
  held(paneId) {
    return this.#busy.has(paneId);
  }

  /**
   * Claim a pane for one delivery, or say it can't take one.
   *
   * Two questions, and the order between them is the whole point. **The live pane
   * decides.** The lock goes first because it is the only thing that catches a second
   * message arriving before the first one's effects have reached the screen — but it is
   * bookkeeping about this process, not a claim about the session, so it costs nothing to
   * ask first. Then the pane is read, now, and its answer is final.
   *
   * The version this replaces asked the *roster* first — `session.status !== 'idle'` —
   * and only then read the pane. That ordering meant the live read could veto a send and
   * could never rescue one, which defeated the reason it was there: "the roster is up to a
   * poll stale" is the argument for reading the pane, not for reading it second. It
   * turned load-bearing the night an interrupt left a `working` receipt standing for ten
   * minutes — the pane was showing a composer, the roster said busy, and every message
   * queued behind a session that was plainly sitting at its prompt.
   *
   * Dropping the roster check is stricter in practice, not looser. It stops trusting a
   * two-second-old value in the *accepting* direction, and the live read refuses more
   * than the roster ever did: a permission box (`prompt`), a plan box, a question and any
   * other modal all read as something other than `idle` and are all refused here. Under
   * it, `sendText` re-reads the pane a third time through `assertNotBlocked`.
   *
   * The claim is taken *before* the read, and given back on every path that returns
   * false, so two callers can't both decide a free pane is theirs. Whoever claims must
   * then call `hold` — `deliver` is what does that.
   *
   * @param {{paneId?: string|null}} session
   * @returns {Promise<boolean>}
   */
  async claim(session) {
    const pane = session?.paneId;
    if (!pane) return false;
    if (this.#busy.has(pane)) return false;
    this.#busy.add(pane);

    try {
      const live = await this.#read(pane);
      // `idle` is the composer; everything else — `working`, `needs-decision`, `dialog`,
      // `unknown` — is a refusal. `prompt` is checked on its own because a permission box
      // is the one thing that must never be typed into, and a belt beside the braces
      // costs nothing here.
      if (live?.state === 'idle' && !live.prompt) return true;
    } catch {
      /* An unreadable pane is not a free one. */
    }

    this.#busy.delete(pane);
    return false;
  }

  /** Hold a claimed pane for a beat after delivery, then let it go. */
  hold(paneId) {
    setTimeout(() => this.#busy.delete(paneId), this.#cooloff).unref?.();
  }

  /** Give a claim back immediately — for a delivery that never happened. */
  release(paneId) {
    this.#busy.delete(paneId);
  }
}
