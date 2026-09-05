import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { STATE_DIR } from './config.js';

/**
 * The shared room's log — one append-only `shared-room.jsonl` for the whole machine.
 *
 * `room.js` is a *team's* chatroom, one file per repo, and this is its machine-wide
 * sibling: the traffic that passes between sessions on this Mac, whoever launched them
 * and whatever folder they sit in. Same two moves — append one line, read since a cursor —
 * and the same reasoning about why a log beats a table. Three things are different, and
 * each of them is here because a machine-wide file has no project boundary to bound it.
 *
 * **One file, no `teamDir`.** The room is not about a repo, so `STATE_DIR` directly. That
 * also means the file is scratch-isolated by `FOREMAN_STATE_DIR` exactly like the queue and
 * the pins, which is what keeps a second panel off the real one's history.
 *
 * **Dedupe on `msgId`.** An entry whose `msgId` is already known is a no-op returning
 * `null`, and it does **not** advance `seq`. The collector has two ways to see the same
 * message — the live hook and the boot sweep of recent transcripts — and they overlap by
 * design, so a second sighting is the normal case rather than an error. The seen-set is
 * seeded from the file so a restart does not re-post everything the sweep finds. An entry
 * with no `msgId` at all is appended unconditionally: there is nothing to dedupe on, and
 * inventing a composite key here would be the one thing this file must not do — see the
 * note on invisible characters below.
 *
 * **Rotation at boot, and it is a `rename`.** Over `MAX_BYTES` the file is renamed to
 * `.1` (one generation, overwritten) and a fresh one is started. Not a rewrite, ever:
 * `TaskStore`'s load-drops-unknown plus flush-rewrites-all is how a file gets silently
 * erased, and a compaction pass that reads records it does not understand has the same
 * shape. Rotation cannot lose a record it failed to parse, because it never parses one.
 *
 * Note this is the *opposite* call from `logs.js`, which copies aside and truncates in
 * place and says renaming rotates nothing. That is true of a launchd log, because launchd
 * opens the file once and holds the descriptor: the rename takes the inode with it and the
 * daemon keeps writing to the renamed file. Nothing holds this one — every write is an
 * `appendFileSync`, which opens, appends and closes — so the rename is clean and the next
 * append creates the new file. Boot-only for `logs.js`'s reason all the same: this process
 * is the only writer and has not written yet.
 *
 * **`seq` is monotonic across the rotation.** The last seq of the file being retired is
 * carried forward, so a browser holding a cursor from before a restart is not sent back to
 * the start of a fresh file — `read({since})` filters on `e.seq > since` and a counter
 * that restarted at zero would silently show that reader nothing, for as long as it took to
 * climb back. The *seen-set* is deliberately not carried: it exists to bound double
 * ingestion of live traffic, and every `msgId` in a retired 4 MB generation is ancient.
 *
 * **No invisible characters, here or anywhere near here.** Lines are `JSON.stringify` +
 * `\n`, which escapes every control byte inside a body, so a message containing a newline
 * cannot tear a line. Nothing in this file builds a composite key or a signature; if
 * something ever needs one, join it with ordinary punctuation — this repo has been bitten
 * three times by a character you cannot see in an editor (`normalize.js`'s ANSI regex,
 * `mergeSig`'s three control bytes, and the NUL in `rate-limits.js` that made git read the
 * whole file as binary).
 */

const FILE = path.join(STATE_DIR, 'shared-room.jsonl');

/** The rotation threshold. Traffic is a handful of messages a day; this is a floor under a
 *  file nobody is watching, not a working limit. */
export const MAX_BYTES = 4 * 1024 * 1024;

/** Split a jsonl body into entries, skipping torn lines. A crash mid-append leaves half a
 *  line, and the half is the *last* one — the rest of the file is perfectly good history
 *  and refusing to read it over one bad tail would be the worse failure. */
function parseEntries(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* torn write — skip */
    }
  }
  return entries;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export class SharedRoomStore extends EventEmitter {
  /** @param {string} [file] override the store location (tests) */
  constructor(file = FILE) {
    super();
    this.file = file;
    /** What the rotation did at construction, for the boot line to print. `null` when it
     *  did nothing, which is the ordinary case. Never the file's contents. */
    this.rotated = null;
    this.seq = 0;
    this.seen = new Set(); // msgId -> already logged

    const carried = this.#rotate();
    const entries = this.readAll();
    this.seq = entries.length ? entries[entries.length - 1].seq : carried;
    for (const e of entries) if (typeof e.msgId === 'string' && e.msgId) this.seen.add(e.msgId);
  }

  /** Retire an oversized file. Answers the seq to carry into the fresh one. */
  #rotate() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return 0; // no file yet — the ordinary first boot
    }
    if (size <= MAX_BYTES) return 0;
    const entries = parseEntries(readText(this.file));
    const carried = entries.length ? entries[entries.length - 1].seq : 0;
    const to = `${this.file}.1`;
    // `rename` replaces an existing `.1` in one step: one generation, overwritten, and no
    // window where neither file is there.
    fs.renameSync(this.file, to);
    this.rotated = { bytes: size, to: path.basename(to), carriedSeq: carried };
    return carried;
  }

  /**
   * Append one entry, or answer `null` if its `msgId` has been seen before.
   *
   * `from` is who is speaking — an object resolved at ingest time, because the sender's
   * registry file is deleted within seconds of the sender exiting and a room re-read
   * tomorrow cannot re-resolve a pid. The store does not judge how well it resolved (that
   * is `fromSource`'s job); it refuses only an entry with no sender at all, the way
   * `room.js` does.
   */
  post({ kind = 'peer', msgId, ...rest }, { now = Date.now() } = {}) {
    if (!rest.from) throw new Error('A shared-room post needs a sender.');
    const id = typeof msgId === 'string' && msgId ? msgId : null;
    if (id && this.seen.has(id)) return null;

    const entry = { seq: this.seq + 1, ts: now, kind, ...(id ? { msgId: id } : {}), ...rest };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    this.seq = entry.seq;
    if (id) this.seen.add(id);
    this.emit('post', entry);
    return entry;
  }

  /** Every entry. Torn lines skipped. */
  readAll() {
    return parseEntries(readText(this.file));
  }

  /** Entries after `since` (a seq), capped from the end — the pane opens on a tail. */
  read({ since = 0, limit = 200 } = {}) {
    const all = this.readAll();
    const after = since > 0 ? all.filter((e) => e.seq > since) : all;
    return {
      entries: after.slice(-limit),
      cursor: all.length ? all[all.length - 1].seq : 0,
      truncated: after.length > limit,
    };
  }
}
