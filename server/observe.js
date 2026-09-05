import fsp from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { BACKFILL_BYTES, PEER_SESSIONS_DIR } from './config.js';
import { normalizeRecord } from './normalize.js';
import { readPeer, guessTmuxSession } from './peers.js';
import { readRange } from './transcript.js';

/**
 * The shared room's collector: it watches for one Claude session sending another a native
 * message, and writes one entry per message into `SharedRoomStore`.
 *
 * This module is *only* logic and file reads. It wires itself into nothing — no route, no
 * poll, no socket — so it can be driven from a test with a fixture transcript directory, a
 * fixture peer registry and a scratch store, with no panel and no clock. The wiring is a
 * separate change.
 *
 * ---
 *
 * **What it reads, and why only that.** A native `SendMessage` leaves a record on both
 * sides, and only the *recipient's* is trustworthy. The sender's `tool_result` is not
 * always a receipt — a harness refusal carries no `msg_id`, a classifier denial is a bare
 * error string and the send never happened, and a Remote-Control-pinned send returns a
 * `pin` instead. The recipient's record exists if and only if a message actually arrived,
 * and it carries `origin.msg_id` every time. So: recipient side only, always.
 *
 * **Two channels for one fact, and they overlap on purpose.** The `UserPromptSubmit` hook
 * fires on the recipient the moment a peer message lands, which is the fast path; a slow
 * sweep of the live roster's transcripts is the backstop that catches whatever the panel
 * missed while it was down, restarting, or not yet listening. Both end in the same
 * `ingest`, and `msgId` dedupe in the store makes a second sighting a no-op. That is the
 * design, not a leak: neither channel has to be reliable on its own.
 *
 * **The hook is a nudge, never a record.** Its payload carries the raw envelope but no
 * `msg_id`, so an entry written from it would have no dedupe key and the transcript read
 * of the same message would then write it a second time. The hook's whole job is to say
 * *"read this file now"*.
 *
 * **Both ends are resolved to identities at write time, because one of them is about to
 * vanish.** The sender is named on the wire by `origin.verifiedPeerPid`, which joins
 * through Claude Code's own registry (`~/.claude/sessions/<pid>.json`) to a tmux pane and
 * from there to a roster row — but those files are deleted within seconds of the sender
 * exiting. A room re-read tomorrow cannot re-resolve a pid, so the resolved identity is
 * written into the entry and never recomputed. `origin.name` is the durable half and is
 * kept beside it.
 *
 * **One shape of delivery it cannot see, MEASURED on a scratch pair.** A peer message that
 * arrives while the recipient is *mid-turn* does not land as a `type: 'user'` record at all.
 * It lands as `type: 'attachment'` with `attachment.type: 'queued_command'`, carrying the
 * same `origin` object one level deeper — and it fires **no `UserPromptSubmit` hook**, so
 * neither channel here sees it: `DROP_TYPES` discards `attachment` above `normalizeRecord`'s
 * peer branch, and there is no hook to nudge on. One of seven bench messages arrived this
 * way and produced no entry, while the recipient's own reply to it did. Deliberately not
 * worked around here: the fix belongs in the one parser that reads `origin`, and a second
 * peer reader in this file is the `imageBlocks` mistake. When `normalize.js` learns the
 * shape, both channels pick it up with no change on this side.
 *
 * **`text` is `origin.body` and nothing else.** `message.content` is the same words wrapped
 * in Claude Code's peer-safety boilerplate — several hundred characters addressed to the
 * receiving session, not to anyone reading the panel. A bubble built from it would be the
 * boilerplate. This module never touches `message`: it hands the record to
 * `normalizeRecord`, which is the one parser that reads `origin`, and takes the
 * `peer_message` it answers with. One parser, two callers — the transcript view and this.
 */

/** The boot sweep's backstop reaches back this far and no further. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How long the hook path waits before its one retry. See `onHookPrompt`. */
export const HOOK_RETRY_MS = 300;

/**
 * The witness for "this prompt is a peer message", exported so the `/hook` route and this
 * module cannot spell it differently.
 *
 * Note `onHookPrompt` deliberately does **not** re-apply it. Two gates on one fact is how
 * they come to disagree, and the read it guards is harmless anyway — a tail read that finds
 * no peer record writes nothing.
 */
export const PEER_PROMPT_RE = /^<cross-session-message\b/;
export const isPeerPrompt = (prompt) => typeof prompt === 'string' && PEER_PROMPT_RE.test(prompt);

/**
 * Who is in the room.
 *
 * An **allow-list on role**, never "not a worker" — `benchEntries`'s exact reasoning in
 * `snapshot.js`. Task kinds have already grown once in this repo, and the day a role is
 * added a negative test silently starts admitting it. An ordinary session (no team) and a
 * lead are in; everything else has to be named here to get in.
 */
export const participant = (row) => Boolean(row) && (row.team?.role == null || row.team.role === 'lead');

const roleOf = (row) => row?.team?.role ?? null;

/**
 * Join a sender to a roster row.
 *
 * Three rungs, and the entry records which one answered so a wrong guess is visible rather
 * than believed:
 *
 * 1. **`registry`** — `verifiedPeerPid` → `readPeer` → the pane id or tmux session it
 *    names → a roster row. The only rung that is a resolution rather than a guess.
 * 2. **`name`** — the registry file is already gone (or never named a pane), so
 *    `SESSION_PREFIX + origin.name` is tried as a tmux session name. That equality is a
 *    *convention of the launcher*, not a guarantee, and it breaks silently the day the
 *    configured prefix stops matching what the launcher stamps. Labelled, never trusted.
 * 3. **`unknown`** — nothing joined. A Remote Control sender has no local registry file and
 *    no pane; a session run bare outside tmux has a file but no pane. Both land here, and
 *    both are refused by `ingest`, structurally rather than by filtering a list of names.
 *
 * @returns {{row: object|null, fromSource: 'registry'|'name'|'unknown'}}
 */
export function resolveSender(peer, sessions, { peersDir = PEER_SESSIONS_DIR } = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];

  if (peer.fromPid != null) {
    const reg = readPeer(peer.fromPid, peersDir);
    if (reg) {
      const row =
        (reg.paneId && rows.find((s) => s.paneId === reg.paneId)) ||
        (reg.tmuxSession && rows.find((s) => s.tmuxSession === reg.tmuxSession)) ||
        (reg.sessionId && rows.find((s) => s.id === reg.sessionId)) ||
        null;
      if (row) return { row, fromSource: 'registry' };
    }
  }

  if (peer.from) {
    const guess = guessTmuxSession(peer.from);
    const row = rows.find((s) => s.tmuxSession === guess) || null;
    if (row) return { row, fromSource: 'name' };
  }

  return { row: null, fromSource: 'unknown' };
}

/** Find the roster row a transcript read belongs to. Session id first — it is the identity
 *  every binding rule in this repo is written against — then the pane, then the file. */
function recipientRow(sessions, { sessionId, paneId, transcriptPath }) {
  const rows = Array.isArray(sessions) ? sessions : [];
  return (
    (sessionId && rows.find((s) => s.id === sessionId)) ||
    (paneId && rows.find((s) => s.paneId === paneId)) ||
    (transcriptPath && rows.find((s) => s.transcriptPath === transcriptPath)) ||
    null
  );
}

const identity = (row, name) => ({
  name: name ?? row?.label ?? row?.title ?? null,
  tmuxSession: row?.tmuxSession ?? null,
  paneId: row?.paneId ?? null,
  cwd: row?.cwd ?? null,
  sessionId: row?.id ?? null,
});

/** A record's own timestamp in epoch ms, or `null` if it cannot be read as one. */
function stampOf(rec) {
  const ms = Date.parse(rec?.timestamp ?? '');
  return Number.isFinite(ms) ? ms : null;
}

export class Observer {
  /**
   * @param {object}   opts
   * @param {object}   opts.store    a `SharedRoomStore`
   * @param {Function} [opts.roster] answers the current roster; the sweep also takes one
   * @param {string}   [opts.peersDir]
   * @param {number}   [opts.tailBytes] the first read of a file reaches back this far
   * @param {number}   [opts.retryMs]   the hook path's one retry
   * @param {Function} [opts.now]       injected so tests need no clock
   */
  constructor({
    store,
    roster = () => [],
    peersDir = PEER_SESSIONS_DIR,
    tailBytes = BACKFILL_BYTES,
    retryMs = HOOK_RETRY_MS,
    maxAgeMs = MAX_AGE_MS,
    now = () => Date.now(),
  }) {
    this.store = store;
    this.roster = roster;
    this.peersDir = peersDir;
    this.tailBytes = tailBytes;
    this.retryMs = retryMs;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    /** transcript path -> the byte offset already read. A file we have never met is read
     *  from a `tailBytes` window back; every read after that is only the new bytes. */
    this.offsets = new Map();
  }

  /**
   * The hook path. Reads the tail of one transcript and ingests whatever peer records are
   * in it.
   *
   * **The retry is the whole subtlety.** The hook fires and the record is written in the
   * same beat, which is not the same as the record being flushed *before* the hook arrives
   * — measured at a few milliseconds on a bench pair, but a genuinely busy recipient cannot
   * be bounded. So a read that finds nothing waits `retryMs` and reads once more, and then
   * stops: the 60-second sweep is the real backstop and dedupe makes a wasted read free.
   * One retry, not a loop — a loop here would be a poll wearing a disguise.
   *
   * @returns {Promise<number>} entries written
   */
  async onHookPrompt({ transcriptPath, sessionId, paneId } = {}, { sessions, now } = {}) {
    if (!transcriptPath) return 0;
    const rows = sessions ?? this.roster();
    const row = recipientRow(rows, { sessionId, paneId, transcriptPath });
    if (!row) return 0;

    const first = await this.#drain(transcriptPath, row, rows, { now });
    if (first > 0) return first;

    await sleep(this.retryMs);
    const rows2 = sessions ?? this.roster();
    const row2 = recipientRow(rows2, { sessionId, paneId, transcriptPath }) || row;
    return this.#drain(transcriptPath, row2, rows2, { now });
  }

  /**
   * The backstop: boot, then every 60 seconds.
   *
   * Only **participant** rows are read, which is what keeps the cost arithmetic (about a
   * dozen files, ~10ms) and is also the structural half of the display rule — a worker's
   * own inbox is never swept, so a message *to* a worker never arrives this way. The hook
   * path agrees with it by refusing a non-participant recipient outright.
   *
   * @returns {Promise<number>} entries written
   */
  async sweep(sessions, { now } = {}) {
    const rows = sessions ?? this.roster();
    let written = 0;
    for (const row of rows) {
      if (!participant(row) || !row.transcriptPath) continue;
      written += await this.#drain(row.transcriptPath, row, rows, { now });
    }
    this.#forget(rows);
    return written;
  }

  /**
   * Turn one transcript record into a room entry, or `null`.
   *
   * The two ends are not tested the same way, and the asymmetry is the maintainer's ruling
   * of 2026-09-04 rather than a simplification:
   *
   * - **The recipient must be a participant.** No exception. A message to a worker is the
   *   worker's business with its lead, and the room is not a second inbox for it.
   * - **The sender may be any roster row, including a worker**, and its role is written on
   *   the entry as `fromRole`. The one real non-scratch peer message on this machine is a
   *   worker telling its lead a release was done — exactly the traffic the room exists to
   *   stop losing — and a symmetrical rule would hide it. Workers stay out of `@`
   *   addressing, which is the other half of the same ruling and not this module's job.
   * - **A sender that joins to no roster row at all is refused**, `fromSource: 'unknown'`.
   *   That is what excludes Remote Control and anything outside tmux, and it excludes them
   *   by arithmetic rather than by a list of names to keep current.
   *
   * `fromRole`, `toRole` and `fromSource` ride on every entry so that tightening the rule
   * later is a read-time filter over history already collected, not a re-collection of
   * traffic whose senders have long since exited.
   */
  ingest(rec, recipient, now = this.now(), sessions = this.roster()) {
    if (!participant(recipient)) return null;

    const [msg] = normalizeRecord(rec);
    if (!msg || msg.kind !== 'peer_message') return null;

    const { row: sender, fromSource } = resolveSender(msg, sessions, { peersDir: this.peersDir });
    if (fromSource === 'unknown') return null;

    // The message's own timestamp, not the moment the panel noticed it. The boot sweep can
    // meet a message hours after it landed, and a log that stamped it "now" would put it
    // above traffic that genuinely came later. The consequence for a reader: `seq` is write
    // order and `ts` is event order, and one sweep pass can write a reply before the message
    // it answers because it met that transcript first. A view sorts on `ts`.
    const ts = stampOf(rec) ?? now;

    return this.store.post(
      {
        kind: 'peer',
        msgId: msg.msgId,
        text: msg.text,
        from: { ...identity(sender, msg.from), pid: msg.fromPid ?? null },
        to: identity(recipient),
        fromRole: roleOf(sender),
        toRole: roleOf(recipient),
        fromSource,
        reply: msg.reply === true,
      },
      { now: ts },
    );
  }

  /** Read whatever is new in one transcript and ingest it. */
  async #drain(file, recipient, sessions, { now } = {}) {
    if (!participant(recipient)) return 0;

    let size;
    try {
      ({ size } = await fsp.stat(file));
    } catch {
      return 0; // the file went away between the roster poll and here
    }

    const seen = this.offsets.get(file);
    // A file we have never read is met at a bounded window from its end; one we have is
    // read forward from where we stopped. A size *below* the offset means a different file
    // is wearing that path, so meet it as a new one rather than reading from a stale mark.
    const backfill = seen == null || seen > size;
    const start = backfill ? Math.max(0, size - this.tailBytes) : seen;

    let records = [];
    let nextOffset = start;
    try {
      // Only a *backfill* starts mid-line — it jumps back a fixed number of bytes from the
      // end and lands wherever it lands. A resumed read starts at the offset the last read
      // stopped at, which `readRange` guarantees is a line boundary, so dropping there
      // would swallow the first record after every read. That is the whole bug this flag
      // has: it looks like "start > 0" and it is not.
      ({ records, nextOffset } = await readRange(file, start, size, { dropLeadingPartial: backfill && start > 0 }));
    } catch {
      return 0;
    }
    this.offsets.set(file, Math.max(seen ?? 0, nextOffset));

    const at = now ?? this.now();
    // The backfill window is the one read that can hand back genuinely old traffic — the
    // room is a log of what is happening, not an archive. Everything after it is new by
    // construction and is not aged. A record whose stamp cannot be read is kept: an
    // unreadable timestamp is likelier a shape nobody has met than a two-day-old message,
    // and dedupe makes the cost of being wrong nothing.
    const fresh = backfill
      ? records.filter((r) => {
          const ms = stampOf(r);
          return ms == null || at - ms <= this.maxAgeMs;
        })
      : records;

    const rows = sessions ?? this.roster();
    let written = 0;
    for (const rec of fresh) if (this.ingest(rec, recipient, at, rows)) written += 1;
    return written;
  }

  /** Drop the offsets of transcripts no longer on the roster, so the map does not grow for
   *  the life of the process the way `sessions.js` prunes its own per-pane stores. */
  #forget(rows) {
    const live = new Set(rows.map((s) => s.transcriptPath).filter(Boolean));
    for (const file of this.offsets.keys()) if (!live.has(file)) this.offsets.delete(file);
  }
}
