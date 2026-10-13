/*
 * bot-subs.js — the socket side of a bot pane: which slot of which socket is showing which
 * bot conversation, and the frames that keep it current.
 *
 * **Its own map, never a `kind` on the session one.** `server/index.js` keeps session
 * subscriptions in `subs` (ws → Map(slot → sub)), and two things walk that map that must
 * never meet a bot:
 *
 *   - the roster's rebind loop (`registry.on('update')`), which re-subscribes any slot whose
 *     session rotated or vanished — a bot conversation is not in the registry, so it would
 *     read as "vanished" every poll and be torn down or rebound to a pane;
 *   - the `loadEarlier` handler, which hands what it reads to `rememberAgentFiles` — and that
 *     would let a bot's transcript choose which local file `/api/agent-run` may read (a
 *     bot's `outputFile` is a path inside its container, and it names it, not this Mac).
 *
 * A list neither of them is handed has nothing to forget, which is the same argument that
 * keeps bots out of the roster's `sessions` (they ride beside it as `bots`). So this is a
 * second map, `ws → Map(slot → sub)`, and the one rule joining the two is the caller's:
 * a slot holds a session **or** a bot, so subscribing one drops the other.
 *
 * Frames, all stamped with the slot they are for:
 *
 *   bot               {botId, bot, conversations, next, cid, messages, hasEarlier, slot}
 *   bot-messages      {botId, cid, messages, slot}
 *   bot-earlier       {botId, cid, messages, hasEarlier, slot}
 *   bot-conversations {botId, bot, conversations, next, slot}
 *
 * `bot` is the row `BotStore.list()` gives the roster (or `null`: not registered), and
 * `conversations` / `next` are `BotStore.conversations()`'s first page, newest 200.
 *
 * Two things a `Tailer` cannot do on its own, and both are this file's:
 *
 *   - **A reset is a new file at the same path.** The store renames a copy whose source
 *     shrank or was replaced to `<file>.g<n>` and starts again at the old path. A `Tailer`
 *     follows the path, sees `size < offset`, rewinds to 0 and *appends* the new file to
 *     what the browser already shows. So the store's `reset` stops the old tailer before
 *     anything else can drain it and re-sends a whole `bot` frame on a fresh one.
 *   - **Nothing was selected yet.** A pane opened with `cid: null` follows the bot's newest
 *     conversation — but only while it has nothing selected. A bot with no conversations
 *     opens empty and fills in when its first one lands; a pane that is showing one is
 *     never moved off it because a newer one started.
 *
 * Nothing here keeps unread state. `read.prune(liveIds)` runs every roster poll and would
 * delete any watermark kept for an id that is not a live session.
 */

import { Tailer as TranscriptTailer } from './transcript.js';

export class BotSubs {
  /** ws → Map(slot → sub). A Map rather than a WeakMap because `change` and `reset` have to
   *  find every slot showing a bot; an entry goes when its last slot does, and the socket's
   *  `close`/`error` drop them all. */
  #subs = new Map();

  /**
   * @param {object}   opts
   * @param {object}   opts.store   a `BotStore`
   * @param {function} opts.send    `(ws, type, data)` — `server/index.js`'s own
   * @param {function} [opts.Tailer] the transcript tailer class (tests may swap it)
   */
  constructor({ store, send, Tailer = TranscriptTailer }) {
    this.store = store;
    this.send = send;
    this.Tailer = Tailer;
    store.on('change', ({ bot }) => this.#changed(bot));
    // A subagent's copy is never tailed here — the agent route reads it whole on demand — so
    // only a conversation's own reset has anything on screen to replace.
    store.on('reset', ({ bot, cid, agent }) => {
      if (!agent) this.#reset(bot, cid);
    });
  }

  /** Whether this socket's slot is showing a bot. */
  holds(ws, slot) {
    return Boolean(this.#subs.get(ws)?.has(slot));
  }

  /**
   * Show `cid` of `botId` in `slot`, or the bot's newest conversation when `cid` is null.
   * Replaces whatever bot this slot was showing; the caller drops the slot's session.
   */
  async subscribe(ws, { botId, cid = null, slot = 'a' } = {}) {
    this.unsubscribe(ws, slot);
    const want = typeof cid === 'string' && cid ? cid : null;
    const sub = { botId: typeof botId === 'string' ? botId : null, cid: null, follow: want === null, tailer: null };
    let slots = this.#subs.get(ws);
    if (!slots) {
      slots = new Map();
      this.#subs.set(ws, slots);
    }
    // Claimed before the read, for `subscribe`'s reason in `index.js`: a second subscribe
    // landing inside the read's awaits must find this one and stop it, or two tailers send
    // into one slot and every append is drawn twice.
    slots.set(slot, sub);
    await this.#open(ws, slot, sub, want);
  }

  /** Drop one slot, or every slot when the socket goes. */
  unsubscribe(ws, slot) {
    const slots = this.#subs.get(ws);
    if (!slots) return;
    for (const [key, sub] of slots) {
      if (slot !== undefined && key !== slot) continue;
      sub.tailer?.stop();
      sub.tailer = null;
      slots.delete(key);
    }
    if (!slots.size) this.#subs.delete(ws);
  }

  /** Walk this slot's conversation further back. Answers nothing for a slot showing no bot. */
  async loadEarlier(ws, slot) {
    const sub = this.#subs.get(ws)?.get(slot);
    const tailer = sub?.tailer;
    if (!tailer) return;
    let out;
    try {
      out = await tailer.loadEarlier();
    } catch {
      out = { messages: [], hasEarlier: false };
    }
    // A reset or a re-subscribe inside the read: these lines belong to a file that is no
    // longer on screen, and the frame that replaced it already carries its own history.
    if (!this.#owns(ws, slot, sub) || sub.tailer !== tailer) return;
    this.send(ws, 'bot-earlier', { botId: sub.botId, cid: sub.cid, messages: out.messages, hasEarlier: out.hasEarlier, slot });
  }

  /* ---------------------------------------------------------------- inside --- */

  #owns(ws, slot, sub) {
    return this.#subs.get(ws)?.get(slot) === sub;
  }

  #page(botId) {
    const bot = botId ? this.store.list().find((r) => r.id === botId) ?? null : null;
    const page = bot ? this.store.conversations(botId) : null;
    return { bot, conversations: page?.conversations ?? [], next: page?.next ?? null };
  }

  async #open(ws, slot, sub, want) {
    const { bot, conversations, next } = this.#page(sub.botId);
    const cid = want ?? (sub.follow ? conversations[0]?.cid ?? null : null);
    const file = bot && cid ? this.store.pathOf(sub.botId, cid) : null;
    const head = { botId: sub.botId, bot, conversations, next };
    if (!file) {
      sub.cid = null;
      this.send(ws, 'bot', { ...head, cid: null, messages: [], hasEarlier: false, slot });
      return;
    }

    const tailer = new this.Tailer(file);
    sub.cid = cid;
    sub.tailer = tailer;
    tailer.on('messages', (messages) => {
      if (!this.#owns(ws, slot, sub) || sub.tailer !== tailer) return;
      this.send(ws, 'bot-messages', { botId: sub.botId, cid, messages, slot });
    });
    tailer.on('error', () => {});

    try {
      const { messages, hasEarlier } = await tailer.start();
      // Superseded while reading — `unsubscribe` stopped this tailer once already, but
      // `start` has since attached a watcher and a poller of its own.
      if (!this.#owns(ws, slot, sub) || sub.tailer !== tailer) return tailer.stop();
      this.send(ws, 'bot', { ...head, cid, messages, hasEarlier, slot });
    } catch (err) {
      tailer.stop();
      if (!this.#owns(ws, slot, sub) || sub.tailer !== tailer) return;
      this.#subs.get(ws)?.delete(slot);
      this.send(ws, 'error', { message: `Could not read that conversation: ${err.message}`, slot });
    }
  }

  /** Every (ws, slot, sub) showing `botId`, snapshotted so a re-open can edit the maps. */
  #showing(botId) {
    const out = [];
    for (const [ws, slots] of this.#subs) {
      for (const [slot, sub] of slots) if (sub.botId === botId) out.push({ ws, slot, sub });
    }
    return out;
  }

  /** Replace a slot's sub with a fresh one and open it — the old tailer stopped first, so
   *  nothing it was in the middle of reading can reach the socket. */
  #reopen(ws, slot, sub, want) {
    sub.tailer?.stop();
    sub.tailer = null;
    const fresh = { botId: sub.botId, cid: null, follow: sub.follow, tailer: null };
    this.#subs.get(ws)?.set(slot, fresh);
    this.#open(ws, slot, fresh, want).catch(() => {});
  }

  #reset(botId, cid) {
    for (const { ws, slot, sub } of this.#showing(botId)) {
      if (sub.cid === cid) this.#reopen(ws, slot, sub, cid);
    }
  }

  #changed(botId) {
    const showing = this.#showing(botId);
    if (!showing.length) return;
    const { bot, conversations, next } = this.#page(botId);
    for (const { ws, slot, sub } of showing) {
      if (sub.cid === null && sub.follow && sub.tailer === null && conversations.length) {
        this.#reopen(ws, slot, sub, null);
      } else {
        this.send(ws, 'bot-conversations', { botId, bot, conversations, next, slot });
      }
    }
  }
}
